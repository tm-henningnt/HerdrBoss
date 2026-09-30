import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { POLICY_DEFAULTS, machineLimits } from '../src/control.js';
import { evaluate, swapWarnStep } from '../src/rules.js';

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
    assert.match(alert.text, /browser or test workers/);
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
