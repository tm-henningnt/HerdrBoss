import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectQuotas } from '../src/collect.js';
import { fmtTime, renderBulletin } from '../src/rules.js';
import { laneStatus, POLICY_DEFAULTS } from '../src/control.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rows = [
  { provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: '2026-10-01T00:00:00Z' } } },
  { provider: 'claude', error: { message: 'Claude usage probe timed out.' } },
];
const exitOne = (stdout) => async () => { const e = new Error('Command failed'); e.code = 1; e.stdout = stdout; e.stderr = ''; throw e; };

test('a codexbar exit 1 with provider rows keeps the good rows', async () => {
  const quotas = await collectQuotas({ runner: exitOne(JSON.stringify(rows)) });
  assert.equal(quotas.length, 2);
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
  assert.ok(quotas.find((q) => q.provider === 'codex').windows.length >= 1);
});

test('a codexbar exit 1 without JSON output still fails with the exit code', async () => {
  await assert.rejects(collectQuotas({ runner: exitOne('not json') }), { message: 'codexbar exited with code 1' });
});

const cfg = { quota: { warnPercent: 80 }, port: 4477, host: '127.0.0.1' };
const snap = (quotas) => ({ updatedAt: Date.parse('2026-09-28T01:00:00Z'), quotas, herdr: { panes: [] }, projects: [] });
const bulletin = (quotas) => renderBulletin(snap(quotas), { alerts: [], advice: [] }, cfg);

test('the bulletin says quota data unavailable without quota rows, never no restrictions', () => {
  const text = bulletin([]);
  assert.match(text, /Quota data unavailable: the quota collector failed/);
  assert.doesNotMatch(text, /No quota or active machine restrictions/);
});

test('the bulletin names a provider whose quota row failed', () => {
  const text = bulletin([{ provider: 'codex', windows: [] }, { provider: 'claude', error: 'Claude usage probe timed out.' }]);
  assert.match(text, /Quota data unavailable for Claude\./);
  assert.doesNotMatch(text, /No quota or active machine restrictions/);
});

// A runner that answers each codexbar call in turn and records the arguments.
function scripted(...answers) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, timeout: opts?.timeout });
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  return { calls, runner };
}
const exitOneError = (stdout) => { const e = new Error('Command failed'); e.code = 1; e.stdout = JSON.stringify(stdout); e.stderr = ''; return e; };
const goodClaude = { provider: 'claude', usage: { primary: { usedPercent: 33, resetsAt: '2026-10-01T00:00:00Z' } } };

test('a failed provider row is read again once with --provider and the same timeout', async () => {
  const { calls, runner } = scripted(exitOneError(rows), exitOneError([rows[1]]));
  const quotas = await collectQuotas({ runner });
  assert.deepEqual(calls, [
    { cmd: 'codexbar', args: ['usage', '--format', 'json'], timeout: 240000 },
    { cmd: 'codexbar', args: ['usage', '--format', 'json', '--provider', 'claude'], timeout: 240000 },
  ]);
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
});

test('a good row from the provider retry replaces the failed row', async () => {
  const { calls, runner } = scripted(exitOneError(rows), [goodClaude]);
  const quotas = await collectQuotas({ runner });
  assert.equal(calls.length, 2);
  const claude = quotas.find((q) => q.provider === 'claude');
  assert.equal(claude.error, undefined);
  assert.equal(claude.windows[0].usedPercent, 33);
});

test('a read without a failed row does not retry', async () => {
  const { calls, runner } = scripted([rows[0], goodClaude]);
  await collectQuotas({ runner });
  assert.equal(calls.length, 1);
});

test('a failed provider retry that throws keeps the first error', async () => {
  const timeout = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const { runner } = scripted(exitOneError(rows), timeout);
  const quotas = await collectQuotas({ runner });
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
});

const window = { key: 'primary', label: 'Session', usedPercent: 40, resetsAt: '2026-09-28T04:00:00Z', windowMinutes: 300 };
const staleClaude = { provider: 'claude', windows: [window], stale: true, staleSince: '2026-09-28T00:40:00.000Z', error: 'Claude usage probe timed out.' };

test('the bulletin shows a stale row in the quota table and names its time in the rules', () => {
  const text = bulletin([{ provider: 'codex', windows: [] }, staleClaude]);
  const time = fmtTime(staleClaude.staleSince);
  assert.ok(text.includes(`- Quota data for Claude is from ${time}; the last probe failed.`), text);
  assert.ok(text.includes(`| Claude quota from ${time} (probe failed) | Session | 40% |`), text);
  assert.doesNotMatch(text, /Quota data unavailable for Claude/);
});

test('the bulletin keeps the unavailable wording for a failed provider without a row', () => {
  const text = bulletin([{ provider: 'codex', windows: [] }, { provider: 'claude', error: 'Claude usage probe timed out.' }]);
  assert.match(text, /Quota data unavailable for Claude\. Pace work on those providers carefully\./);
  assert.doesNotMatch(text, /Claude quota from/);
});

test('lanes use a stale row as quota data', () => {
  const lanes = laneStatus([staleClaude], structuredClone(POLICY_DEFAULTS), Date.parse('2026-09-28T01:00:00Z'));
  assert.notEqual(lanes.claude.state, 'unknown');
});

// The engine probe reads quotas once and runs one tick with automatic handover on.
const handoverProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.QP_SCENARIO);
Date.now = () => input.now;
const calls = [];
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: false,
  act: true,
  collectors: {
    collectHerdr: async () => input.herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => input.quotas,
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
    collectPiModels: async () => null,
  },
  handoffRunner: async (command, args) => {
    calls.push(args.slice(1, 3));
    if (args[2] === 'plan') return JSON.stringify({ migration: { available: true } });
    if (args[2] === 'prepare') return JSON.stringify({ id: 'fake-handoff', newPane: 'fake-successor' });
    return JSON.stringify({ ok: true });
  },
});
engine.deliver = async () => {};
engine.readQuotas();
await engine.quotaRead;
const snap = await engine.tick();
console.log(JSON.stringify({ calls, quotas: snap.quotas, lanes: snap.lanes }));
`;

function runHandover(t, quotas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const now = Date.parse('2026-09-28T01:00:00.000Z');
  const policy = structuredClone(POLICY_DEFAULTS);
  policy.autoHandover = true;
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ paneSince: {}, pushes: {}, notified: {}, lastOrchestrators: {} }));
  fs.writeFileSync(path.join(dir, 'handoffs.json'), '[]');
  const hot = [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 98, expectedPercent: 60, resetsAt: '2026-10-01T12:00:00.000Z', windowMinutes: 10080 }] }];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ quotasAt: new Date(now - 5 * 60000).toISOString(), quotas: hot }));
  const herdr = {
    workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
    panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'claude', status: 'working', sessionId: 'source-session' }],
  };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', handoverProbe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', NODE_TEST_CONTEXT: '',
      QP_SCENARIO: JSON.stringify({ now, herdr, quotas: quotas(hot) }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('automatic handover acts on a fresh hot row', { timeout: 30000 }, (t) => {
  const out = runHandover(t, (hot) => hot);
  assert.deepEqual(out.calls, [['handoff', 'plan'], ['handoff', 'prepare']]);
});

test('automatic handover does not act on a stale row, but lanes use it', { timeout: 30000 }, (t) => {
  const out = runHandover(t, () => [{ provider: 'claude', error: 'Claude usage probe timed out.' }]);
  const claude = out.quotas.find((q) => q.provider === 'claude');
  assert.equal(claude.stale, true);
  assert.equal(claude.windows[0].usedPercent, 98);
  assert.deepEqual(out.calls, []);
  assert.notEqual(out.lanes.claude.state, 'unknown');
});
