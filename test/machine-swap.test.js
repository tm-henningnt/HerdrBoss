import './helpers/test-env.js';
import { pinProject } from '../src/git-pins.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS, machineLimits } from '../src/control.js';
import { evaluate, swapWarnStep } from '../src/rules.js';
import { highSwapHoursLine } from '../src/machine-samples.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = (machine = {}) => ({ ...structuredClone(POLICY_DEFAULTS), machine: { ...POLICY_DEFAULTS.machine, ...machine } });
const sample = (usedMB, totalMB = 4096) => ({ swapUsedMB: usedMB, swapTotalMB: totalMB });
const limitsOf = (usedMB, totalMB, machine) => machineLimits({ cpus: 8, load: [1, 1, 1], cpuTotalSample: 0, ...sample(usedMB, totalMB) }, policy(machine));

test('machineLimits reports swap percent, swap GB, and the three settings', () => {
  const limits = limitsOf(3200, 4000);
  assert.equal(limits.swapPercent, 80);
  assert.equal(limits.swapUsedGB, 3200 / 1024);
  assert.deepEqual([limits.swapWarnPercent, limits.swapRefusePercent, limits.swapMinUsedGB], [80, 95, 2]);
  assert.equal(machineLimits({ cpus: 8, load: [1, 1, 1], cpuTotalSample: 0 }, policy()).swapPercent, null);
  assert.equal(limitsOf(100, 0).swapPercent, null, 'a zero swap total has no percent');
});

test('swapWarnStep needs 3 confirming samples', () => {
  const step = (state, usedMB, machine) => swapWarnStep(state, limitsOf(usedMB, 4096, machine));
  let state = { samples: [], active: false };
  state = step(state, 3500);
  state = step(state, 3500);
  assert.equal(state.active, false, 'no alert on 2 samples');
  state = step(state, 3500);
  assert.equal(state.active, true, 'alert on 3');
  assert.equal(state.samples.length, 3);
  state = step(state, 3500);
  assert.equal(state.samples.length, 3, 'only the last 3 values stay');
});

test('a dip below the threshold restarts the confirmation', () => {
  const step = (state, usedMB) => swapWarnStep(state, limitsOf(usedMB, 4096));
  let state = { samples: [], active: false };
  for (const used of [3500, 3500, 2000, 3500, 3500]) state = step(state, used);
  assert.equal(state.active, false);
  state = step(state, 3500);
  assert.equal(state.active, true);
});

test('the alert clears when swap is 5 points below the threshold', () => {
  const step = (state, usedMB) => swapWarnStep(state, limitsOf(usedMB, 4096));
  let state = { samples: [], active: false };
  for (let i = 0; i < 3; i += 1) state = step(state, 3500);
  assert.equal(state.active, true);
  state = step(state, 3200);
  assert.equal(state.active, true, '78% is inside the hysteresis band');
  state = step(state, 3072);
  assert.equal(state.active, true, '75.0% is not below 75');
  state = step(state, 3071);
  assert.equal(state.active, false, '74.98% is below 75');
});

test('swap use below the GB floor does not alert', () => {
  const step = (state, usedMB, machine) => swapWarnStep(state, limitsOf(usedMB, 2048, machine));
  let state = { samples: [], active: false };
  for (let i = 0; i < 5; i += 1) state = step(state, 1900);
  assert.equal(state.active, false, '93% of 2 GB but only 1.9 GB used');
  for (let i = 0; i < 3; i += 1) state = step(state, 1900, { swapMinUsedGB: 1 });
  assert.equal(state.active, true, 'a lower floor lets it alert');
});

test('a null warn percent switches the warning off', () => {
  let state = { samples: [], active: false };
  for (let i = 0; i < 5; i += 1) state = swapWarnStep(state, limitsOf(4000, 4096, { swapWarnPercent: null }));
  assert.equal(state.active, false);
});

test('an unreadable swap resets the samples', () => {
  let state = { samples: [], active: false };
  state = swapWarnStep(state, limitsOf(3500, 4096));
  state = swapWarnStep(state, limitsOf(3500, 4096));
  state = swapWarnStep(state, machineLimits({ cpus: 8, load: [1, 1, 1], cpuTotalSample: 0 }, policy()));
  assert.equal(state.samples.length, 0);
  assert.equal(state.active, false);
});

test('evaluate raises machine:swap from the limits, also when the guard is off', () => {
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {} };
  const now = Date.parse('2026-09-30T12:00:00Z');
  const machine = { cpus: 8, load: [1, 1, 1], memFreePercent: 50, memTotalGB: 24, cpuTotalSample: 0, ownerIdleMinutes: 0, ...sample(3500) };
  for (const pol of [policy(), policy({ guardEnabled: false })]) {
    const limits = { ...machineLimits(machine, pol, now), swapWarning: true };
    const alerts = evaluate({ projects: [], herdr: { workspaces: [], panes: [] }, machine: { ...machine, limits } }, cfg, {}, now, pol).alerts;
    const alert = alerts.find((a) => a.key === 'machine:swap');
    assert.ok(alert, `guardEnabled ${pol.machine.guardEnabled}`);
    assert.equal(alert.severity, 'warn');
    assert.equal(alert.title, 'Swap high: 85% used');
    assert.match(alert.text, /at most 1 browser worker/);
    const quiet = evaluate({ projects: [], herdr: { workspaces: [], panes: [] }, machine: { ...machine, limits: { ...limits, swapWarning: false } } }, cfg, {}, now, pol).alerts;
    assert.ok(!quiet.some((a) => a.key === 'machine:swap'));
  }
});

const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.SWAP_SCENARIO);
let now = 0;
Date.now = () => now;
const cfg = loadConfig();
cfg.push = false;
cfg.browsers.reapOrphanDaemons = false;
let machine;
const engine = new Engine(cfg, {
  push: false, act: true,
  collectors: {
    collectHerdr: async () => ({ workspaces: [], panes: [] }),
    collectMachine: async () => machine,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
    collectPiModels: async () => null,
  },
  herdrRunner: async () => '{}',
});
engine.deliver = async () => {};
const seen = [];
for (const [i, used] of input.used.entries()) {
  now = Date.parse('2026-09-30T14:00:00.000Z') + i * 30000;
  machine = { load: [1, 1, 1], cpus: 10, ownerIdleMinutes: 0, memFreePercent: 50, memTotalGB: 24, swapUsedMB: used, swapTotalMB: input.total };
  await engine.tick();
  seen.push((engine.state.alerts || []).some((a) => a.key === 'machine:swap'));
}
console.log(JSON.stringify(seen));
`;

function run(t, scenario, policyPatch = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (policyPatch) fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ machine: policyPatch }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', NODE_TEST_CONTEXT: '', SWAP_SCENARIO: JSON.stringify(scenario) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('Engine.tick raises machine:swap on the third sample and clears below the band', { timeout: 60000 }, (t) => {
  const seen = run(t, { total: 4096, used: [3500, 3500, 3500, 3500, 3071] });
  assert.deepEqual(seen, [false, false, true, true, false]);
});

test('Engine.tick raises machine:swap with the guard off', { timeout: 60000 }, (t) => {
  const seen = run(t, { total: 4096, used: [3500, 3500, 3500] }, { guardEnabled: false });
  assert.deepEqual(seen, [false, false, true]);
});

test('Engine.tick does not raise machine:swap below the GB floor', { timeout: 60000 }, (t) => {
  const seen = run(t, { total: 2048, used: [1900, 1900, 1900, 1900] });
  assert.deepEqual(seen, [false, false, false, false]);
});

// Swap refusal in worker start, suite, and push.
const { swapRefusal, swapExempt } = await import('../src/kit/swap-guard.js');
const { runKitCommand } = await import('../src/kit/cli.js');
const { loadProjectConfig } = await import('../src/kit/config.js');
const { execFileSync } = await import('node:child_process');

const NOW = Date.parse('2026-09-30T12:00:00Z');
const swapRules = (patch = {}, updatedAt = new Date(NOW - 60000).toISOString()) => ({
  updatedAt,
  machine: { swapPercent: 97, swapUsedGB: 3.9, swapRefusePercent: 95, swapMinUsedGB: 2, swapRefuseEnabled: true, ...patch },
});

test('swapRefusal names the swap figure, the setting, and the override', () => {
  const text = swapRefusal(swapRules(), { now: NOW, override: 'Pass --force-swap to override.' });
  assert.match(text, /97%/);
  assert.match(text, /3\.9 GB/);
  assert.match(text, /95%/);
  assert.match(text, /swapRefuseEnabled|Refuse new work at high swap/);
  assert.match(text, /Pass --force-swap to override\./);
});

test('swapRefusal is off by default, with a null percent, below the floor, and with stale rules', () => {
  assert.equal(swapRefusal(swapRules({ swapRefuseEnabled: false }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({ swapRefuseEnabled: undefined }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({ swapRefusePercent: null }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({ swapPercent: 94, swapUsedGB: 3.8 }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({ swapPercent: 99, swapUsedGB: 1.9 }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({ swapPercent: null, swapUsedGB: null }), { now: NOW }), null);
  assert.equal(swapRefusal(swapRules({}, new Date(NOW - 181000).toISOString()), { now: NOW }), null, 'older than 3 minutes');
  assert.equal(swapRefusal({ machine: swapRules().machine }, { now: NOW }), null, 'no timestamp');
  assert.equal(swapRefusal(null, { now: NOW }), null);
  assert.ok(swapRefusal(swapRules({ swapPercent: 95, swapUsedGB: 2 }), { now: NOW }), 'the thresholds are inclusive');
});

test('swapExempt covers a shell outside Herdr and the boss pane', () => {
  const herdr = (label) => () => ({ pane: { pane_id: 'ws:p', label } });
  assert.equal(swapExempt({}, herdr('orch')), true, 'no pane: Owner shell');
  assert.equal(swapExempt({ HERDR_PANE_ID: 'ws:p' }, herdr('boss')), true);
  assert.equal(swapExempt({ HERDR_PANE_ID: 'ws:p' }, herdr('orch')), false);
  assert.equal(swapExempt({ HERDR_PANE_ID: 'ws:p' }, () => { throw new Error('no herdr'); }), true, 'an unreadable pane does not refuse');
  assert.equal(swapExempt({ HERDR_PANE_ID: 'ws:p', HERDR_BOSS_FORCE_SWAP: '1' }, herdr('orch')), true);
});

function swapFixture(t, { rules = swapRules(), label = 'orch', hook = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-swap-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-m', 'seed');
  if (hook) {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nherdr-boss suite -- npm test\nexit 0\n', { mode: 0o755 });
  }
  const dataDir = path.join(base, 'data');
  const rulesFile = path.join(base, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ ...rules, avoidKinds: [], preferredKinds: [], notes: [] }));
  const lines = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p' }] };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, HERDR_ENV: '1', HERDR_BOSS_DIR: dataDir, HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:p' };
  pinProject({ slug: loadProjectConfig({ cwd: root }).slug, repo: root }, { env });
  const marker = path.join(base, 'ran');
  const script = path.join(base, 'suite.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const options = (extra = {}) => ({
    config: loadProjectConfig({ cwd: root }), serviceConfig: { worktrees: { minFreeGb: 8 } }, freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }), lockDataDir: dataDir, rulesFile, env, herdr, now: () => NOW, pidAlive: (pid) => pid === 601,
    output: (line) => lines.push(line), suiteStdio: 'ignore', pushStdio: 'ignore', ...extra,
  });
  return { base, root, git, dataDir, rulesFile, lines, env, options, marker, script, ran: () => fs.existsSync(marker) };
}

test('worker start refuses at high swap, and --force does not bypass it', (t) => {
  const f = swapFixture(t);
  const start = (...extra) => runKitCommand('worker', ['start', 'w1', '--kind', 'claude', '--task', 'x', '--read-only', ...extra], f.options({ now: NOW }));
  assert.throws(() => start(), /97%.*3\.9 GB[\s\S]*--force-swap/);
  assert.throws(() => start('--force', '--reason', 'test authorized override'), /--force-swap/, '--force is not enough');
});

test('worker start does not refuse the boss pane, --force-swap, or a policy with the option off', (t) => {
  const refused = /Swap|swap is at/;
  const boss = swapFixture(t, { label: 'boss' });
  assert.throws(() => runKitCommand('worker', ['start', 'w1', '--kind', 'claude', '--task', 'x', '--read-only'], boss.options({ now: NOW })), (error) => !refused.test(error.message));
  const forced = swapFixture(t);
  assert.throws(() => runKitCommand('worker', ['start', 'w1', '--kind', 'claude', '--task', 'x', '--read-only', '--force-swap'], forced.options({ now: NOW })), /--force-swap needs --reason TEXT/);
  const forcedWithReason = swapFixture(t);
  let forcedFailure = '';
  assert.throws(() => runKitCommand('worker', ['start', 'w1', '--kind', 'claude', '--task', 'x', '--read-only', '--force-swap', '--reason', 'Owner approved swap override'], forcedWithReason.options({ now: NOW })), (error) => { forcedFailure = error.message; return !refused.test(error.message); });
  assert.ok(fs.existsSync(path.join(forcedWithReason.dataDir, 'action-audit.jsonl')), forcedFailure);
  const forcedAction = JSON.parse(fs.readFileSync(path.join(forcedWithReason.dataDir, 'action-audit.jsonl'), 'utf8').trim());
  assert.equal(forcedAction.refusalKind, 'swap');
  assert.equal(forcedAction.reason, 'Owner approved swap override');
  const off = swapFixture(t, { rules: swapRules({ swapRefuseEnabled: false }) });
  assert.throws(() => runKitCommand('worker', ['start', 'w1', '--kind', 'claude', '--task', 'x', '--read-only'], off.options({ now: NOW })), (error) => !refused.test(error.message));
});

test('suite refuses at high swap before it runs the command or takes the lock', (t) => {
  const f = swapFixture(t);
  assert.throws(() => runKitCommand('suite', ['--', process.execPath, f.script], f.options()), /97%[\s\S]*HERDR_BOSS_FORCE_SWAP=1/);
  assert.equal(f.ran(), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'full-suite.json')), false);
});

test('suite runs with HERDR_BOSS_FORCE_SWAP=1, for a boss pane, and with stale rules', (t) => {
  const forced = swapFixture(t);
  const result = runKitCommand('suite', ['--', process.execPath, forced.script], forced.options({ env: { ...forced.env, HERDR_BOSS_FORCE_SWAP: '1' } }));
  assert.equal(result.exitCode, 0);
  assert.equal(forced.ran(), true);
  const boss = swapFixture(t, { label: 'boss' });
  assert.equal(runKitCommand('suite', ['--', process.execPath, boss.script], boss.options()).exitCode, 0);
  const stale = swapFixture(t, { rules: swapRules({}, new Date(NOW - 4 * 60000).toISOString()) });
  assert.equal(runKitCommand('suite', ['--', process.execPath, stale.script], stale.options()).exitCode, 0);
});

test('suite --reuse with a passing reused tree returns 0 at high swap', (t) => {
  const f = swapFixture(t);
  const env = { ...f.env, HERDR_BOSS_FORCE_SWAP: '1' };
  assert.equal(runKitCommand('suite', ['--', process.execPath, f.script], f.options({ env })).exitCode, 0);
  fs.rmSync(f.marker);
  const result = runKitCommand('suite', ['--reuse', '--', process.execPath, f.script], f.options());
  assert.equal(result.exitCode, 0);
  assert.equal(result.reused, true);
  assert.equal(f.ran(), false);
  assert.throws(() => runKitCommand('suite', ['--', process.execPath, f.script], f.options()), /97%/, 'without --reuse it still refuses');
});

test('suite --reuse refuses at high swap when no pass matches', (t) => {
  const f = swapFixture(t);
  assert.throws(() => runKitCommand('suite', ['--reuse', '--', process.execPath, f.script], f.options()), /97%/);
});

test('push refuses at high swap only when a pre-push hook exists', (t) => {
  const hooked = swapFixture(t, { hook: true });
  assert.throws(() => runKitCommand('push', ['--dry-run'], hooked.options()), /97%[\s\S]*HERDR_BOSS_FORCE_SWAP=1/);
  assert.equal(fs.existsSync(path.join(hooked.dataDir, 'locks', 'machine', 'queue')), false, 'nothing queued');
  const plain = swapFixture(t);
  const result = runKitCommand('push', ['--dry-run'], plain.options());
  assert.equal(typeof result.exitCode, 'number');
  assert.ok(plain.lines.some((line) => /no pre-push hook/.test(line)));
});

const swapText = (machineOverrides, limitsOverrides = {}) => {
  const cfg = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {} };
  const now = Date.parse('2026-09-30T12:00:00Z');
  const pol = policy(machineOverrides);
  const machine = { cpus: 8, load: [1, 1, 1], memFreePercent: 50, memTotalGB: 24, cpuTotalSample: 0, ownerIdleMinutes: 0, ...sample(3500) };
  const limits = { ...machineLimits(machine, pol, now), swapWarning: true, ...limitsOverrides };
  const alerts = evaluate({ projects: [], herdr: { workspaces: [], panes: [] }, machine: { ...machine, limits } }, cfg, {}, now, pol).alerts;
  return alerts.find((a) => a.key === 'machine:swap').text;
};

test('the swap alert text is advice, with the refusal off', () => {
  const text = swapText({});
  assert.match(text, /^Swap is 85% used \(3\.4 GB\)\./);
  assert.match(text, /swap grows on demand/);
  assert.match(text, /does not mean the machine is short of memory/);
  assert.match(text, /The swap refusal is off\./);
  assert.match(text, /at most 1 browser worker at a time/);
  assert.match(text, /up to 3 browser workers/);
  assert.match(text, /One worker at a time is fine\./);
  assert.match(text, /Close finished workers and their browsers\./);
  assert.doesNotMatch(text, /start no|block/i);
});

test('the swap alert text names the refusal when it is on', () => {
  const text = swapText({ swapRefuseEnabled: true });
  assert.match(text, /The swap refusal is on\. It refuses new work at 95% swap with at least 2 GB in use\./);
  assert.doesNotMatch(text, /refusal is off/);
  assert.doesNotMatch(text, /start no|block/i);
});

test('the swap alert text ends with the swap hours line when the limits hold one', () => {
  const line = 'Swap was above the warning level in hours 14 to 17 on 3 of the last 7 days.';
  assert.ok(swapText({}, { swapHoursLine: line }).endsWith(line));
  assert.doesNotMatch(swapText({}), /Swap was above/);
});

test('highSwapHoursLine reports the hours with high swap by day, in aggregate', () => {
  const now = Date.parse('2026-09-30T20:00:00');
  const at = (day, hour) => new Date(2026, 8, day, hour, 30).toISOString();
  const high = (day, hour) => ({ at: at(day, hour), swapMB: 3500, swapTotalMB: 4096 });
  const low = (day, hour) => ({ at: at(day, hour), swapMB: 500, swapTotalMB: 4096 });
  const samples = [];
  for (const day of [28, 29, 30]) for (const hour of [14, 15, 16, 17]) samples.push(high(day, hour));
  samples.push(high(29, 9), low(28, 9), low(30, 9));
  assert.equal(highSwapHoursLine({ warnPercent: 80, minUsedGB: 2, samples, now }), 'Swap was above the warning level in hours 14 to 17 on 3 of the last 7 days.');
  assert.equal(highSwapHoursLine({ warnPercent: 80, minUsedGB: 2, samples: [low(30, 9)], now }), null);
  assert.equal(highSwapHoursLine({ warnPercent: 99, minUsedGB: 2, samples, now }), null);
  assert.equal(highSwapHoursLine({ warnPercent: null, samples, now }), null);
});
