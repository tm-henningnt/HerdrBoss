import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as quotaCollector from '../src/collect.js';
import { fmtTime, renderBulletin } from '../src/rules.js';
import { laneStatus, POLICY_DEFAULTS } from '../src/control.js';
import { describeLane } from '../src/kit/workers.js';

const { collectQuotas, keepStaleRows } = quotaCollector;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rows = [
  { provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: '2026-10-01T00:00:00Z' } } },
  { provider: 'claude', error: { message: 'Claude usage probe timed out.' } },
];
const exitOne = (stdout) => async () => { const e = new Error('Command failed'); e.code = 1; e.stdout = stdout; e.stderr = ''; throw e; };

test('a codexbar exit 1 with provider rows keeps the good rows', async () => {
  const calls = [];
  const runner = async (_cmd, args) => { calls.push(args.at(-1)); return exitOne(JSON.stringify(rows))(); };
  const quotas = await collectQuotas({ runner });
  assert.deepEqual(calls, ['codex', 'claude', 'opencodego']);
  assert.equal(quotas.length, 3);
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
  assert.ok(quotas.find((q) => q.provider === 'codex').windows.length >= 1);
  assert.match(quotas.find((q) => q.provider === 'opencodego').error, /row is missing/);
});

test('a codexbar exit 1 without JSON output returns one failed row for each provider', async () => {
  const quotas = await collectQuotas({ runner: exitOne('not json') });
  assert.deepEqual(quotas.map((row) => row.provider), ['codex', 'claude', 'opencodego']);
  assert.ok(quotas.every((row) => row.error));
  assert.match(quotas.find((row) => row.provider === 'claude').error, /Claude usage probe exited with code 1/);
});

const missingReader = Object.assign(new Error('spawn codexbar ENOENT'), { code: 'ENOENT', syscall: 'spawn codexbar', path: 'codexbar' });

test('a missing usage reader is an unknown reading with a reason, never a probe failure', async () => {
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; } });
  for (const row of quotas) {
    assert.equal(row.unavailable, true, `${row.provider} must be marked unavailable`);
    assert.match(row.reason, /no usage reader in this factory/);
    assert.doesNotMatch(row.error, /failed|ENOENT/i);
  }
  const text = bulletin(quotas);
  assert.match(text, /Usage limits are unknown for Codex \(no usage reader in this factory\), Claude \(no usage reader in this factory\), OpenCode Go \(no usage reader in this factory\)\. Not a probe failure\./);
  assert.doesNotMatch(text, /Quota data unavailable/);
  assert.doesNotMatch(text, /No quota or active machine restrictions/);
  const lane = laneStatus(quotas, structuredClone(POLICY_DEFAULTS), Date.parse('2026-09-28T01:00:00Z')).claude;
  assert.equal(lane.state, 'unknown');
  assert.match(lane.reason, /no usage reader in this factory/);
});

test('a missing harness login is an unknown reading with its reason', async () => {
  const row = { provider: 'claude', error: { message: 'Claude CLI is not logged in on this machine.' } };
  const quotas = await collectQuotas({ runner: async () => JSON.stringify([row]) });
  const claude = quotas.find((q) => q.provider === 'claude');
  assert.equal(claude.unavailable, true);
  assert.match(claude.reason, /no login for this harness in this factory/);
  const text = bulletin(quotas);
  assert.match(text, /Usage limits are unknown for Claude \(no login for this harness in this factory\)\. Not a probe failure\./);
});

test('an unavailable reader after a good reading keeps the old windows as stale, never a failed probe', () => {
  const good = [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 37, expectedPercent: 20, resetsAt: '2026-10-02T00:00:00.000Z', windowMinutes: 10080 }] }];
  const readAt = Date.parse('2026-09-28T00:00:00.000Z');
  const unavailable = [{ provider: 'claude', unavailable: true, reason: 'no usage reader in this factory', error: 'no usage reader in this factory' }];
  const rows = keepStaleRows(unavailable, good, readAt, readAt + 60 * 60 * 1000);
  const claude = rows[0];
  assert.equal(claude.stale, true, 'the old windows stay, marked stale');
  assert.equal(claude.unavailable, true, 'the row carries the unavailable marker');
  assert.equal(claude.reason, 'no usage reader in this factory');
  assert.equal(claude.windows[0].usedPercent, 37, 'the old reading stays as stale pacing data');
  const lane = laneStatus(rows, structuredClone(POLICY_DEFAULTS), readAt + 60 * 60 * 1000).claude;
  assert.notEqual(lane.state, 'unknown', 'the old windows still guide pacing');
  assert.equal(lane.reading.usedPercent, 37);
  assert.equal(lane.reading.ageMinutes, 60, 'the pacing data carries its age, never a fresh reading');
  const text = bulletin(rows);
  assert.match(text, /Usage limits are unknown for Claude \(no usage reader in this factory\)\. Not a probe failure\./);
  assert.doesNotMatch(text, /the last probe failed/);
  assert.doesNotMatch(text, /\(probe failed\)/);
});

test('quotaUnavailableReason returns null for a timeout, an exit code, and a missing row', () => {
  const timeout = Object.assign(new Error('codexbar timed out after 60 s'), { killed: true, signal: 'SIGTERM' });
  const exited = Object.assign(new Error('Command failed'), { code: 1, stderr: 'codexbar: no such option' });
  assert.equal(quotaCollector.quotaUnavailableReason(timeout), null);
  assert.equal(quotaCollector.quotaUnavailableReason(exited), null);
  assert.equal(quotaCollector.quotaUnavailableReason('claude quota row is missing from the latest probe'), null);
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

test('quota reads use provider back-off timeouts and do not retry a Claude timeout', async () => {
  const calls = [];
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args, timeout: options.timeout });
    const provider = args.at(-1);
    if (provider === 'claude') return JSON.stringify([{ provider, error: { message: 'Claude usage probe timed out.' } }]);
    const row = provider === 'codex' ? rows[0] : { provider, usage: { primary: { usedPercent: 4 } } };
    return JSON.stringify([row]);
  };
  const quotas = await collectQuotas({ runner, timeouts: { codex: 20000, claude: 45000, opencodego: 90000 } });
  assert.deepEqual(calls, [
    { cmd: 'codexbar', args: ['usage', '--format', 'json', '--provider', 'codex'], timeout: 20000 },
    { cmd: 'codexbar', args: ['usage', '--format', 'json', '--provider', 'claude'], timeout: 45000 },
    { cmd: 'codexbar', args: ['usage', '--format', 'json', '--provider', 'opencodego'], timeout: 90000 },
  ]);
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
  assert.equal(quotas.find((q) => q.provider === 'claude').windows?.length || 0, 0);
});

test('quota history records fake slow probe durations and safe outcomes, and stays bounded', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-quota-probes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const historyFile = path.join(dir, 'quota-probe-history.jsonl');
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  const runner = async (_cmd, args) => {
    const provider = args.at(-1);
    clock += provider === 'claude' ? 45000 : 125;
    if (provider === 'claude') throw Object.assign(new Error('private raw probe output'), { killed: true, signal: 'SIGKILL' });
    return JSON.stringify([{ provider, usage: { primary: { usedPercent: 11 } } }]);
  };
  const timeouts = { codex: 20000, claude: 45000, opencodego: 90000 };
  await collectQuotas({ runner, timeouts, now: () => clock, historyFile });
  const first = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(first.map(({ provider, outcome, durationMs, timeoutMs }) => ({ provider, outcome, durationMs, timeoutMs })), [
    { provider: 'codex', outcome: 'success', durationMs: 125, timeoutMs: 20000 },
    { provider: 'claude', outcome: 'timeout', durationMs: 45000, timeoutMs: 45000 },
    { provider: 'opencodego', outcome: 'success', durationMs: 125, timeoutMs: 90000 },
  ]);
  assert.doesNotMatch(fs.readFileSync(historyFile, 'utf8'), /private raw probe output/);

  for (let i = 0; i < 40; i++) await collectQuotas({ runner, timeouts, now: () => clock, historyFile });
  const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  assert.ok(lines.length <= quotaCollector.QUOTA_PROBE_HISTORY_LIMIT, `${lines.length} rows`);
});

test('quota collection skips malformed history lines and keeps valid entries', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-quota-history-lines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const historyFile = path.join(dir, 'quota-probe-history.jsonl');
  fs.writeFileSync(historyFile, '{"provider":"before"}\nnot-json\n{"provider":"after"}\n');
  const runner = async (_cmd, args) => JSON.stringify([{ provider: args.at(-1), usage: { primary: { usedPercent: 11 } } }]);

  const quotas = await collectQuotas({ runner, historyFile });

  assert.equal(quotas.length, 3);
  const history = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history.length, 5);
  assert.deepEqual(history.slice(0, 2).map((row) => row.provider), ['before', 'after']);
});

test('quota collection succeeds when the history file cannot be written', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-quota-history-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const historyFile = path.join(dir, 'is-a-directory');
  fs.mkdirSync(historyFile);
  const runner = async (_cmd, args) => JSON.stringify([{ provider: args.at(-1), usage: { primary: { usedPercent: 11 } } }]);

  const quotas = await collectQuotas({ runner, historyFile });

  assert.deepEqual(quotas.map((row) => row.provider), ['codex', 'claude', 'opencodego']);
  assert.ok(quotas.every((row) => !row.error));
});

test('a timed-out quota command kills its process group', { timeout: 10000 }, async (t) => {
  assert.equal(typeof quotaCollector.runQuotaCommand, 'function', 'the quota command runner is exported for a process-tree fixture');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-quota-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'child.pid');
  await assert.rejects(quotaCollector.runQuotaCommand('/bin/sh', ['-c', 'sleep 30 & echo $! > "$QUOTA_CHILD_PID_FILE"; wait'], {
    timeout: 5000, env: { ...process.env, QUOTA_CHILD_PID_FILE: pidFile },
  }), /timed out/);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'the descendant must not survive the timed-out probe');
});

test('a timed-out quota command settles when a detached grandchild holds its pipes', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-quota-held-pipes-'));
  const parentPidFile = path.join(dir, 'parent.pid');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  // The fixture holds its pipes with a heartbeat. A heartbeat alone never ends, so both fixture children also set a
  // deadline. Every fixture child then leaves the run at the latest at that deadline, also when the test file dies
  // before its cleanup runs. The deadline must stay above the timeout of the probe plus the kill settle time.
  const fixtureHoldMs = 15000;
  const grandchildSource = `setTimeout(() => process.exit(0), ${fixtureHoldMs}); setInterval(() => {}, 1000)`;
  const fixture = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    fs.writeFileSync(process.argv[1], String(process.pid));
    fs.writeFileSync(process.argv[2], String(grandchild.pid));
    setTimeout(() => process.exit(0), ${fixtureHoldMs});
    setInterval(() => {}, 1000);
  `;
  let settled = false;
  let failure = null;
  const command = quotaCollector.runQuotaCommand(process.execPath, ['-e', fixture, parentPidFile, grandchildPidFile], { timeout: 3000 })
    .then(() => { settled = true; }, (error) => { failure = error; settled = true; });
  // The pid files hold the pids of both fixture children. The cleanup reads the files instead of variables, so it
  // also kills the children of a failed or aborted run. The cleanup and the folder removal share one hook, because a
  // separate removal hook runs first and takes the pid files away.
  const readPid = (file) => {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  };
  const stop = (pid) => {
    if (!pid) return;
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const gone = async (pid, maxMs) => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  t.after(async () => {
    const parent = readPid(parentPidFile);
    const grandchild = readPid(grandchildPidFile);
    stop(grandchild);
    stop(parent);
    if (grandchild) {
      assert.equal(await gone(grandchild, 5000), true, 'the detached grandchild must not outlive the test');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const waitFor = async (condition, maxMs) => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (condition()) return true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };

  assert.equal(await waitFor(() => fs.existsSync(parentPidFile) && fs.existsSync(grandchildPidFile), 5000), true, 'the fixture must start');
  const parentPid = readPid(parentPidFile);
  assert.ok(parentPid, 'the fixture must write its own pid');
  const parentExited = await waitFor(() => {
    try { process.kill(parentPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 7000);
  assert.equal(parentExited, true, 'the timed-out parent must exit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'the quota promise must settle when its parent exits, even while a grandchild holds stdio');
  assert.match(failure?.message || '', /timed out/);
  await command;
});

test('a stale lane shows the last used value and age, then extrapolates expected use only', () => {
  const now = Date.parse('2026-09-28T02:00:00.000Z');
  const observedAt = '2026-09-28T00:40:00.000Z';
  const lastGood = [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 37, expectedPercent: 20, resetsAt: '2026-10-02T00:00:00.000Z', windowMinutes: 10080 }] }];
  const stale = keepStaleRows([{ provider: 'claude', error: 'Claude usage probe timed out.' }], lastGood, Date.parse(observedAt), now)[0];
  const lane = laneStatus([stale], structuredClone(POLICY_DEFAULTS), now).claude;
  assert.equal(lane.reading.usedPercent, 37);
  assert.equal(lane.reading.window, 'Weekly');
  assert.equal(lane.reading.ageMinutes, 80);
  assert.equal(lane.reading.stale, false);
  assert.ok(lane.expectedPercent > 20, `expected ${lane.expectedPercent}`);
  assert.match(describeLane('claude', lane, now), /37% weekly, 80 min old/);
});

test('a stale reading older than three hours is marked stale without changing its use', () => {
  const readAt = Date.parse('2026-09-28T00:00:00.000Z');
  const lastGood = [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 37, expectedPercent: 20, resetsAt: '2026-10-02T00:00:00.000Z', windowMinutes: 10080 }] }];
  const stale = keepStaleRows([{ provider: 'claude', error: 'Claude usage probe timed out.' }], lastGood, readAt, readAt + 3 * 60 * 60 * 1000 + 1)[0];
  const lane = laneStatus([stale], structuredClone(POLICY_DEFAULTS), readAt + 3 * 60 * 60 * 1000 + 1).claude;
  assert.equal(stale.windows[0].usedPercent, 37);
  assert.equal(lane.reading.stale, true);
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
  // A stronger successor than the Claude source, so the tier rule leaves the choice open.
  policy.orchestratorLadder = [{ kind: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }];
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
