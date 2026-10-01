import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { POLICY_DEFAULTS } from '../src/control.js';
import { Engine } from '../src/engine.js';
import { loadProjectConfig } from '../src/kit/config.js';
import { acquireProjectLock, readLockTakeoverNotices, releaseProjectLock } from '../src/kit/locks.js';
import { temporaryRepo } from './helpers/kit-fixture.js';

const START = Date.parse('2026-10-01T10:00:00.000Z');
const MINUTE = 60_000;

function fixture(t) {
  const root = temporaryRepo('herdr-lock-wait-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const settings = structuredClone(POLICY_DEFAULTS.locks);
  settings.guard.enabled = false;
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ locks: settings }));
  const config = loadProjectConfig({ cwd: root });
  let clock = START;
  const lines = [];
  const herdr = (args) => {
    if (args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[1] === 'list') return { panes: ['ws:holder', 'ws:waiter', 'ws:older'].map((pane_id) => ({ pane_id })) };
    if (args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = (pane = 'ws:waiter', extra = {}) => ({
    config, dataDir, herdr, now: () => clock, pidAlive: () => true,
    processInfo: () => ({ alive: true, start: 'invented-start' }),
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: pane },
    output: (line) => lines.push({ at: clock, line }), ...extra,
  });
  const holder = (extra = {}) => acquireProjectLock('full-suite', options('ws:holder', { kind: 'suite', ...extra }));
  const wait = (extra = {}) => assert.throws(() => acquireProjectLock('full-suite', options('ws:waiter', {
    kind: 'suite', waitSeconds: 0, ...extra,
  })), (error) => error.exitCode === 75);
  const history = (lane = 'long', durations = [13 * MINUTE, 16 * MINUTE, 19 * MINUTE]) => {
    fs.writeFileSync(path.join(dataDir, 'lock-ledger.1.jsonl'), durations.map((holdMs, index) => JSON.stringify({
      event: 'release', at: new Date(START - (index + 1) * MINUTE).toISOString(),
      name: 'full-suite', lane, project: 'invented-history', kind: 'push', holdMs,
    })).join('\n') + '\n');
  };
  return { root, dataDir, options, holder, wait, history, lines,
    advance: (ms) => { clock += ms; }, setClock: (at) => { clock = at; },
    file: path.join(dataDir, 'locks', 'machine', 'full-suite.json') };
}

test('an unchanged position refreshes holder start, age, lane prediction and queue length once a minute', (t) => {
  const f = fixture(t);
  f.history();
  f.holder();
  f.advance(45 * MINUTE);
  f.wait({ waitSeconds: 120, pause: () => f.advance(30_000) });
  const waits = f.lines.filter(({ line }) => line.startsWith('waiting for full-suite'));
  assert.equal(waits.length, 3);
  assert.deepEqual(waits.map(({ at }) => at), [START + 45 * MINUTE, START + 46 * MINUTE, START + 47 * MINUTE]);
  for (const [index, { line }] of waits.entries()) {
    assert.match(line, /lane long/);
    assert.match(line, /position 1 of 1/);
    assert.match(line, /queue length 1/);
    assert.match(line, new RegExp(`held by ${f.options().config.slug} ws:holder \\(suite\\)`));
    assert.match(line, /started 2026-10-01T10:00:00.000Z/);
    assert.match(line, new RegExp(`age ${45 + index}m`));
    assert.match(line, /predicted end 2026-10-01T10:16:00.000Z/);
    assert.match(line, /holder is slow/);
    assert.equal(line.includes('\n'), false);
  }
});

test('the end prediction uses the last ten completed holds of this lock and lane', (t) => {
  const f = fixture(t);
  f.history('long', Array.from({ length: 12 }, (_, i) => (12 - i) * MINUTE));
  // The oldest two are excluded. The median of 3 through 12 is 7.5 minutes.
  fs.writeFileSync(path.join(f.dataDir, 'lock-ledger.jsonl'), [
    { lane: 'short' }, { name: 'other-lock' }, { takeover: true }, { reused: true }, { reentrant: true },
  ].map((extra) => JSON.stringify({ event: 'release', name: 'full-suite', lane: 'long',
    at: new Date(START).toISOString(), holdMs: 999 * MINUTE, ...extra })).join('\n'));
  f.holder();
  f.wait();
  assert.match(f.lines.at(-1).line, /predicted end 2026-10-01T10:07:30.000Z/);
});

test('unknown history has an unknown end and does not report a slow holder', (t) => {
  const f = fixture(t);
  f.holder();
  f.advance(45 * MINUTE);
  f.wait();
  assert.match(f.lines.at(-1).line, /age 45m.*predicted end unknown/);
  assert.doesNotMatch(f.lines.at(-1).line, /holder is slow/);
  assert.deepEqual(readLockTakeoverNotices({ dataDir: f.dataDir }), []);
});

test('slow notices go to the Boss once per holder across waiters and service reads', async (t) => {
  const f = fixture(t);
  f.history();
  f.holder();
  f.advance(32 * MINUTE);
  f.wait();
  assert.deepEqual(readLockTakeoverNotices({ dataDir: f.dataDir }), [], 'twice the prediction is not yet slow');
  f.advance(1);
  f.wait();
  f.wait();
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).length, 1);
  const calls = [];
  const engine = Object.create(Engine.prototype);
  engine.lockDataDir = f.dataDir;
  engine.push = true;
  engine.log = () => {};
  engine.herdrRunner = async (...args) => { calls.push(args); return '{}'; };
  const panes = { panes: [{ id: 'ws:boss', label: 'boss', agent: { name: 'boss' } }, { id: 'ws:holder' }] };
  await engine.deliverLockTakeoverNotices({ panes: [{ id: 'ws:holder' }] });
  assert.equal(calls.length, 0, 'a missing Boss retains the notice');
  engine.herdrRunner = async () => { throw new Error('invented delivery failure'); };
  await engine.deliverLockTakeoverNotices(panes);
  assert.equal(readLockTakeoverNotices({ dataDir: f.dataDir }).length, 1);
  engine.herdrRunner = async (...args) => { calls.push(args); return '{}'; };
  await engine.deliverLockTakeoverNotices(panes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][2], 'ws:boss');
  assert.match(calls[0][1][3], /holder is slow.*ws:holder/);
  f.wait();
  await engine.deliverLockTakeoverNotices(panes);
  assert.equal(calls.length, 1, 'a delivered notice remains deduplicated');
  assert.deepEqual(readLockTakeoverNotices({ dataDir: f.dataDir }), []);
  assert.equal(fs.existsSync(f.file), true, 'a slow holder keeps its slot');
  releaseProjectLock('full-suite', f.options('ws:holder'));
  f.holder();
  f.advance(40 * MINUTE);
  f.wait();
  await engine.deliverLockTakeoverNotices(panes);
  assert.equal(calls.length, 2, 'a new acquisition in the same pane gets a new notice');
});

test('a guard pause still prints holder details and the queue on one wait line', (t) => {
  const f = fixture(t);
  f.history();
  f.holder();
  for (let i = 0; i < 3; i++) fs.appendFileSync(path.join(f.dataDir, 'lock-ledger.jsonl'), JSON.stringify({
    event: 'release', at: new Date(START - i * MINUTE).toISOString(), name: 'full-suite',
    project: f.options().config.slug, kind: 'suite', lane: 'short', holdMs: MINUTE,
  }) + '\n');
  f.wait({ lockSettings: { ...POLICY_DEFAULTS.locks, guard: { ...POLICY_DEFAULTS.locks.guard, enabled: true, maxLoadPercent: 100 } },
    readMachineSample: () => ({ at: new Date(START).toISOString(), l5: 4, cpus: 2 }) });
  const line = f.lines.at(-1).line;
  assert.match(line, /^waiting for full-suite.*lane short.*ws:holder.*started .*age 0s.*predicted end .*queue length 1/);
  assert.match(line, /short lane paused: load 200% exceeds 100%/);
});

test('a policy pause names no holder after its slot is released', (t) => {
  const f = fixture(t);
  f.holder();
  f.wait({ waitSeconds: 60, pause: () => {
    releaseProjectLock('full-suite', f.options('ws:holder'));
    fs.unlinkSync(path.join(f.dataDir, 'policy.json'));
    f.advance(MINUTE);
  } });
  const lines = f.lines.filter(({ line }) => line.includes('policy file is unreadable'));
  assert.equal(lines.length, 1);
  assert.ok(lines.every(({ line }) => /no active holder/.test(line)));
});

test('a process reported dead is stale even when kill(pid, 0) succeeds and its start matches', (t) => {
  const f = fixture(t);
  f.holder();
  const replacement = acquireProjectLock('full-suite', f.options('ws:waiter', { kind: 'suite', waitSeconds: 0,
    processInfo: () => ({ alive: false, start: 'invented-start' }) }));
  assert.equal(replacement.ownerPane, 'ws:waiter');
  assert.ok(f.lines.some(({ line }) => line.includes('Taking over stale lock')));
});

test('removing an old mutation guard does not release a live suite holder', (t) => {
  const f = fixture(t);
  f.holder();
  const guard = path.join(path.dirname(f.file), '.mutation');
  fs.mkdirSync(guard);
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(guard, old, old);
  f.wait();
  assert.equal(JSON.parse(fs.readFileSync(f.file)).ownerPane, 'ws:holder');
  assert.equal(fs.existsSync(guard), false);
});
