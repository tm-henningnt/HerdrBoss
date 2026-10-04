import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const MIN = 60 * 1000;
const QUOTAS = [{ provider: 'codex', plan: 'pro', windows: [{ key: 'primary', label: 'Session', usedPercent: 40, resetsAt: '2026-09-27T14:00:00.000Z', windowMinutes: 300 }] }];
const NEWER = [{ provider: 'codex', plan: 'pro', windows: [{ key: 'primary', label: 'Session', usedPercent: 55, resetsAt: '2026-09-27T14:00:00.000Z', windowMinutes: 300 }] }];

// The probe drives the engine with an injected quota collector. Each read waits until the probe settles it.
// A tick that waits for the read never finishes, so Node exits with status 13 and no output.
const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.QR_SCENARIO);
let clock = input.now;
Date.now = () => clock;
const reads = [];
const probeTimeouts = [];
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: false,
  act: false,
  collectors: {
    collectHerdr: async () => ({ workspaces: [], panes: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: (options = {}) => {
      probeTimeouts.push(options.timeouts || null);
      return new Promise((resolve, reject) => reads.push({ at: clock, resolve, reject }));
    },
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
  },
});
const out = { atStart: { quotas: engine.quotas, quotasAt: engine.quotasAt, cached: engine.quotasCached }, steps: [] };
for (const step of input.steps) {
  if (step.advance) clock += step.advance;
  if (step.tick) {
    const snap = await engine.tick();
    out.steps.push({ reads: reads.length, quotas: snap.quotas, quotasAt: snap.quotasAt, cached: snap.quotasCached, errors: snap.errors, lanes: snap.lanes,
      probeTimeouts: [...probeTimeouts], claudeQuotaProbeFailure: engine.memory.claudeQuotaProbeFailure || null,
      probeAlerts: (snap.alerts || []).filter((a) => a.key.startsWith('quota:probe-failed:claude:')) });
  }
  if (step.resolve || step.reject) {
    const read = reads.at(-1);
    if (step.resolve) read.resolve(step.resolve); else read.reject(new Error(step.reject));
    await engine.quotaRead;
  }
}
console.log(JSON.stringify(out));
`;

function runScenario(t, scenario, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, QR_SCENARIO: JSON.stringify({ now: T0, ...scenario }) },
  });
  assert.equal(result.status, 0, `probe exited with status ${result.status}; a tick that waits for the quota read never finishes.\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

const codexbarErrors = (step) => step.errors.filter((error) => error.startsWith('codexbar'));

test('a slow quota read does not block the tick, and no second read starts while it runs', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [{ tick: true }, { advance: 30000, tick: true }, { advance: 30000, tick: true }] });
  assert.equal(out.steps.length, 3);
  assert.deepEqual(out.steps.map((step) => step.reads), [1, 1, 1]);
  assert.deepEqual(out.steps[2].quotas, []);
  assert.deepEqual(codexbarErrors(out.steps[2]), []);
});

test('the read result applies on a later tick', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [{ tick: true }, { advance: 20000, resolve: QUOTAS }, { advance: 10000, tick: true }] });
  assert.deepEqual(out.steps[0].quotas, []);
  assert.equal(out.steps[0].quotasAt, null);
  assert.deepEqual(out.steps[1].quotas, QUOTAS);
  assert.equal(out.steps[1].quotasAt, new Date(T0 + 20000).toISOString());
  assert.equal(out.steps[1].cached, false);
  assert.equal(out.steps[1].reads, 1, 'a fresh result must not start another read');
});

test('a failed read keeps the last good quotas and waits for the next quota tick before retrying', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [
    { tick: true }, { resolve: QUOTAS }, { tick: true },
    { advance: 301000, tick: true }, { reject: 'codexbar timed out after 20 s' }, { tick: true },
    { advance: 30000, tick: true }, { advance: 270001, tick: true },
  ] });
  const [, fresh, retry, failedApplied, keptQuiet, retryTick] = out.steps;
  assert.deepEqual(fresh.quotas, QUOTAS);
  assert.equal(retry.reads, 2);
  assert.equal(failedApplied.reads, 2);
  assert.equal(failedApplied.quotas[0].windows[0].usedPercent, 40, 'keep the last good used percent after failure');
  assert.match(failedApplied.quotas[0].error, /timed out/);
  assert.equal(keptQuiet.reads, 2, 'a failed read does not retry on an engine tick');
  assert.match(keptQuiet.quotas[0].error, /timed out/);
  assert.equal(retryTick.reads, 3, 'the next quota tick starts one new read');
  assert.equal(retryTick.quotas[0].windows[0].usedPercent, 40);
  assert.equal(retryTick.quotasAt, new Date(T0).toISOString());
});

test('provider probe timeouts back off and reset after a successful read', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [
    { tick: true }, { advance: 10000, resolve: CLAUDE_FAILED },
    { advance: 290001, tick: true }, { advance: 1000, resolve: CLAUDE_FAILED },
    { advance: 1200001, tick: true }, { advance: 1000, resolve: BOTH },
    { advance: 300001, tick: true },
  ] });
  assert.deepEqual(out.steps.map((step) => step.probeTimeouts.at(-1)?.claude), [60000, 90000, 90000, 60000]);
  assert.deepEqual(out.steps.map((step) => step.probeTimeouts.at(-1)?.opencodego), [20000, 45000, 90000, 90000]);
  assert.deepEqual(out.steps.map((step) => step.probeTimeouts.at(-1)?.codex), [20000, 20000, 20000, 20000]);
  assert.equal(out.steps.at(-1).reads, 4);
});

test('a Claude probe failure warns the Boss once after an hour and clears on success', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [
    { tick: true }, { resolve: CLAUDE_FAILED }, { tick: true },
    { advance: 60 * MIN - 1, tick: true }, { advance: 1, tick: true }, { advance: 30000, tick: true },
    { resolve: BOTH }, { tick: true },
  ] });
  const before = out.steps[2].probeAlerts;
  const first = out.steps[3].probeAlerts;
  const repeated = out.steps[4].probeAlerts;
  assert.deepEqual(out.steps[1].claudeQuotaProbeFailure, { startedAt: new Date(T0).toISOString() });
  assert.deepEqual(before, [], 'do not alert before 60 minutes');
  assert.equal(first.length, 1);
  assert.equal(first[0].severity, 'warn');
  assert.equal(first[0].scope, 'boss');
  assert.equal(first[0].prompt, false);
  assert.equal(first[0].once, true);
  assert.equal(repeated[0].key, first[0].key);
  assert.equal(out.steps[5].claudeQuotaProbeFailure, null, 'a good reading clears the failure state');
  assert.deepEqual(out.steps[5].probeAlerts, [], 'a good reading clears the failure notice');
});

test('the engine loads young saved quotas at start and marks them cached until a new read succeeds', { timeout: 30000 }, (t) => {
  const savedAt = new Date(T0 - 6 * MIN).toISOString();
  const out = runScenario(t, { steps: [
    { tick: true }, { reject: 'codexbar exited with code 1' }, { advance: 30000, tick: true },
    { advance: 271000, tick: true }, { resolve: NEWER }, { advance: 30000, tick: true },
  ] }, { quotasAt: savedAt, quotas: QUOTAS });
  assert.deepEqual(out.atStart.quotas, QUOTAS);
  assert.equal(out.atStart.quotasAt, T0 - 6 * MIN);
  assert.equal(out.atStart.cached, true);
  const [first, afterFailure, retry, afterSuccess] = out.steps;
  assert.equal(first.reads, 1, 'saved quotas older than quotaSeconds are refreshed at once');
  assert.deepEqual(first.quotas, QUOTAS);
  assert.equal(first.quotasAt, savedAt);
  assert.equal(first.cached, true);
  assert.equal(afterFailure.reads, 1, 'the failed read does not start again before the quota interval');
  assert.equal(afterFailure.quotas[0].windows[0].usedPercent, 40);
  assert.equal(afterFailure.cached, true);
  assert.equal(retry.reads, 2);
  assert.deepEqual(afterSuccess.quotas, NEWER);
  assert.equal(afterSuccess.cached, false);
});

test('the engine ignores saved quotas older than 15 minutes', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [{ tick: true }] }, { quotasAt: new Date(T0 - 16 * MIN).toISOString(), quotas: QUOTAS });
  assert.equal(out.atStart.quotas, null);
  assert.equal(out.atStart.quotasAt, 0);
  assert.notEqual(out.atStart.cached, true);
  assert.deepEqual(out.steps[0].quotas, []);
  assert.equal(out.steps[0].cached, false);
});

const BOTH = [...QUOTAS, { provider: 'claude', plan: 'max', windows: [{ key: 'primary', label: 'Session', usedPercent: 20, resetsAt: '2026-09-27T14:00:00.000Z', windowMinutes: 300 }] }];
const CLAUDE_FAILED = [...NEWER, { provider: 'claude', error: 'Claude usage probe timed out.' }];
const CLAUDE_UNKNOWN = [...NEWER, { provider: 'claude', error: 'no usage reader in this factory', reason: 'no usage reader in this factory', unavailable: true }];

test('an unavailable Claude reader stays unknown and never warns the Boss', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [
    { tick: true }, { resolve: CLAUDE_UNKNOWN }, { tick: true },
    { advance: 2 * 60 * MIN, tick: true }, { advance: 30000, tick: true },
  ] });
  assert.equal(out.steps[1].claudeQuotaProbeFailure, null, 'an unknown reading is not a probe failure');
  assert.deepEqual(out.steps[2].probeAlerts, [], 'no Boss warning after an hour for an unknown reader');
  assert.deepEqual(out.steps[3].probeAlerts, [], 'the unknown reader still raises no warning');
  assert.deepEqual(out.steps[1].quotas.find((q) => q.provider === 'claude').unavailable, true);
});

test('a failed provider keeps its last good row beyond three hours and marks its age', { timeout: 30000 }, (t) => {
  const out = runScenario(t, { steps: [
    { tick: true }, { resolve: BOTH }, { tick: true },
    { advance: 301000, tick: true }, { resolve: CLAUDE_FAILED }, { tick: true },
    { advance: 3 * 60 * MIN, tick: true }, { resolve: CLAUDE_FAILED }, { tick: true },
  ] });
  const claude = (step) => step.quotas.find((q) => q.provider === 'claude');
  const [, fresh, , kept, , keptOld] = out.steps;
  assert.equal(claude(fresh).stale, undefined);
  assert.deepEqual(claude(kept), { ...BOTH[1], stale: true, staleSince: new Date(T0).toISOString(), error: 'Claude usage probe timed out.' });
  assert.deepEqual(kept.quotas.find((q) => q.provider === 'codex'), NEWER[0]);
  assert.equal(claude(keptOld).staleSince, new Date(T0).toISOString(), 'a stale row keeps the time of the good read');
  assert.equal(claude(keptOld).stale, true);
  assert.equal(claude(keptOld).windows[0].usedPercent, 20);
  assert.equal(out.steps.at(-1).lanes.claude.reading.stale, true);
  assert.equal(out.steps.at(-1).lanes.claude.reading.ageMinutes >= 180, true);
});
