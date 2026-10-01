// PS1: the planner session registry and the `herdr-boss plan` commands. Every data dir is temporary.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import {
  PLANNER_LABEL, startSession, listSessions, getSession, activeSessionForPane, endSession, setRound, sessionsFile,
} from '../src/planner-sessions.js';
import { planCommand, EXIT } from '../src/plan-cli.js';

const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-planner-'));
  roots.push(dir);
  assertTempDataDir(dir);
  return dir;
}

const CONTROL = { projects: { shop: { slug: 'shop', workspace: 'wA', orch: { pane: 'wA:p1' } }, blog: { slug: 'blog', workspace: 'wC', orch: { pane: 'wC:p1' } } } };

// A fake Herdr runner. `label` is the label of the caller pane. It records each call.
function fixture({ label = null, workspace = 'wA', paneId = 'wA:p1' } = {}) {
  const dir = dataDir();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ control: CONTROL }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: workspace, label } };
    if (args[0] === 'pane' && args[1] === 'rename') return {};
    throw new Error(`unexpected herdr call: ${args.join(' ')}`);
  };
  const env = label ? { HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspace } : {};
  const lines = { out: [], err: [] };
  const run = (...args) => planCommand(args, { env, herdr, dir, now: T0, out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) });
  return { dir, calls, run, lines };
}

// ---------- Registry ----------

test('a session record holds the id, the project, the pane, the kind, the input path, and the start time', () => {
  const dir = dataDir();
  const session = startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'docs/plan.md' });
  assert.match(session.id, /^ps-[a-z0-9]{6,}$/);
  assert.deepEqual({ ...session, id: undefined }, {
    id: undefined, project: 'shop', pane: 'wB:p2', kind: 'claude', input: 'docs/plan.md', startedAt: '2026-10-01T08:00:00.000Z', round: 0, endedAt: null,
  });
  assert.deepEqual(getSession({ dir, id: session.id }), session);
  assert.equal(PLANNER_LABEL, 'planner');
  if (process.platform !== 'win32') assert.equal(fs.statSync(sessionsFile(dir)).mode & 0o777, 0o600);
});

test('the registry finds the active session of a pane and ignores an ended one', () => {
  const dir = dataDir();
  const one = startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  assert.equal(activeSessionForPane({ dir, pane: 'wB:p2' }).id, one.id);
  assert.equal(activeSessionForPane({ dir, pane: 'wB:p9' }), null);
  endSession({ dir, now: T0 + 1000, id: one.id });
  assert.equal(activeSessionForPane({ dir, pane: 'wB:p2' }), null);
  assert.equal(getSession({ dir, id: one.id }).endedAt, '2026-10-01T08:00:01.000Z');
  // An ended pane can start a new session. An active pane cannot start a second one.
  startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'b.md' });
  assert.throws(() => startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'c.md' }), /already has/);
});

test('the round counter moves only forward', () => {
  const dir = dataDir();
  const session = startSession({ dir, now: T0, kind: 'codex', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  assert.equal(setRound({ dir, id: session.id, round: 1 }).round, 1);
  assert.equal(setRound({ dir, id: session.id, round: 2 }).round, 2);
  assert.throws(() => setRound({ dir, id: session.id, round: 2 }), /round/);
});

test('the registry refuses a bad project, pane, kind, or input', () => {
  const dir = dataDir();
  const ok = { dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' };
  for (const bad of [{ project: 'Shop!' }, { pane: '' }, { pane: 'a b' }, { kind: 'Bad Kind' }, { input: '' }, { input: 'a\0b' }]) {
    assert.throws(() => startSession({ ...ok, ...bad }), Error, JSON.stringify(bad));
  }
  assert.deepEqual(listSessions({ dir }), []);
});

test('a damaged registry file reads as empty and the next start rewrites it', () => {
  const dir = dataDir();
  fs.writeFileSync(sessionsFile(dir), '{not json');
  assert.deepEqual(listSessions({ dir }), []);
  startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  assert.equal(listSessions({ dir }).length, 1);
});

// ---------- plan start ----------

test('plan start creates a record, labels the pane planner, and prints the session id', () => {
  const { dir, calls, run, lines } = fixture();
  const code = run('start', 'claude', 'shop', '--input', 'docs/plan.md', '--pane', 'wB:p2');
  assert.equal(code, EXIT.ok, lines.err.join('\n'));
  const [session] = listSessions({ dir });
  assert.deepEqual({ kind: session.kind, project: session.project, pane: session.pane, input: session.input }, { kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'docs/plan.md' });
  assert.deepEqual(calls.find((call) => call[1] === 'rename'), ['pane', 'rename', 'wB:p2', PLANNER_LABEL]);
  assert.ok(lines.out.join('\n').includes(session.id));
});

test('plan start needs --input and --pane, and refuses a second active session on one pane', () => {
  const { run, lines } = fixture();
  assert.equal(run('start', 'claude', 'shop', '--pane', 'wB:p2'), EXIT.refused);
  assert.match(lines.err.join('\n'), /--input/);
  assert.equal(run('start', 'claude', 'shop', '--input', 'a.md'), EXIT.refused);
  assert.equal(run('start', 'claude', 'shop', '--input', 'a.md', '--pane', 'wB:p2'), EXIT.ok);
  assert.equal(run('start', 'claude', 'shop', '--input', 'b.md', '--pane', 'wB:p2'), EXIT.refused);
  assert.match(lines.err.join('\n'), /already has/);
});

test('plan start from an orch pane works for its own project only, and a worker pane is refused', () => {
  const own = fixture({ label: 'orch' });
  assert.equal(own.run('start', 'claude', 'shop', '--input', 'a.md', '--pane', 'wB:p2'), EXIT.ok, own.lines.err.join('\n'));
  assert.equal(own.run('start', 'claude', 'blog', '--input', 'a.md', '--pane', 'wB:p3'), EXIT.refused);
  assert.match(own.lines.err.join('\n'), /belongs to project shop/);
  assert.equal(listSessions({ dir: own.dir }).length, 1);
  const worker = fixture({ label: 'worker' });
  assert.equal(worker.run('start', 'claude', 'shop', '--input', 'a.md', '--pane', 'wB:p2'), EXIT.refused);
  assert.deepEqual(listSessions({ dir: worker.dir }), []);
});

test('plan start writes no record when Herdr cannot label the pane', () => {
  const dir = dataDir();
  const herdr = () => { throw new Error('no such pane'); };
  const errors = [];
  const code = planCommand(['start', 'claude', 'shop', '--input', 'a.md', '--pane', 'wB:p2'], { env: {}, herdr, dir, now: T0, out: () => {}, err: (line) => errors.push(line) });
  assert.equal(code, EXIT.refused);
  assert.deepEqual(listSessions({ dir }), []);
  assert.match(errors.join('\n'), /no such pane/);
});

// ---------- plan list and plan end ----------

test('plan list shows the active sessions, --all adds ended ones, and --json prints the records', () => {
  const { dir, run, lines } = fixture();
  const one = startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  const two = startSession({ dir, now: T0, kind: 'codex', project: 'blog', pane: 'wB:p3', input: 'b.md' });
  endSession({ dir, now: T0, id: two.id });
  assert.equal(run('list'), EXIT.ok);
  assert.match(lines.out.join('\n'), new RegExp(one.id));
  assert.ok(!lines.out.join('\n').includes(two.id));
  lines.out.length = 0;
  assert.equal(run('list', '--all'), EXIT.ok);
  assert.ok(lines.out.join('\n').includes(two.id));
  lines.out.length = 0;
  assert.equal(run('list', '--json', 'shop'), EXIT.ok);
  assert.deepEqual(JSON.parse(lines.out.join('\n')).map((entry) => entry.id), [one.id]);
});

test('plan list from an orch pane shows its own project only', () => {
  const { dir, run, lines } = fixture({ label: 'orch' });
  startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  startSession({ dir, now: T0, kind: 'claude', project: 'blog', pane: 'wB:p3', input: 'a.md' });
  assert.equal(run('list', '--json'), EXIT.ok);
  assert.deepEqual(JSON.parse(lines.out.join('\n')).map((entry) => entry.project), ['shop']);
  assert.equal(run('list', 'blog'), EXIT.refused);
});

test('plan end closes the session and clears the pane label, and an unknown id exits 3', () => {
  const { dir, calls, run, lines } = fixture();
  const session = startSession({ dir, now: T0, kind: 'claude', project: 'shop', pane: 'wB:p2', input: 'a.md' });
  assert.equal(run('end', session.id), EXIT.ok, lines.err.join('\n'));
  assert.ok(getSession({ dir, id: session.id }).endedAt);
  assert.deepEqual(calls.find((call) => call[1] === 'rename'), ['pane', 'rename', 'wB:p2', '--clear']);
  assert.equal(run('end', session.id), EXIT.refused);
  assert.match(lines.err.join('\n'), /already ended/);
  assert.equal(run('end', 'ps-nothere'), EXIT.missing);
});

test('plan end from an orch pane works only for a session of its own project', () => {
  const { dir, run } = fixture({ label: 'orch' });
  const other = startSession({ dir, now: T0, kind: 'claude', project: 'blog', pane: 'wB:p3', input: 'a.md' });
  assert.equal(run('end', other.id), EXIT.refused);
  assert.equal(getSession({ dir, id: other.id }).endedAt, null);
});

test('plan with no or an unknown subcommand prints the usage and exits 1', () => {
  const { run, lines } = fixture();
  assert.equal(run(), EXIT.refused);
  assert.equal(run('bogus'), EXIT.refused);
  assert.match(lines.err.join('\n'), /Usage: plan start/);
});
