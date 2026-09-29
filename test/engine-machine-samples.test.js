import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.G4_SCENARIO);
let now = 0;
Date.now = () => now;
const cfg = loadConfig();
cfg.push = false;
cfg.browsers.reapOrphanDaemons = false;
let machine = input.machine;
const engine = new Engine(cfg, {
  push: false,
  act: input.act,
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
for (const at of input.ticks) {
  now = Date.parse(at);
  await engine.tick();
}
console.log(JSON.stringify({ act: engine.act }));
`;

const machine = { load: [2.4, 3.1, 2.8], cpus: 10, ownerIdleMinutes: 0, memFreePercent: 18, memTotalGB: 24, swapUsedMB: 3200, swapTotalMB: 4096 };

function run(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-samples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '', G4_SCENARIO: JSON.stringify({ act: true, machine, ...scenario }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(dir, 'machine-samples.jsonl');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('Engine.tick writes one machine sample line for each UTC minute', { timeout: 60000 }, (t) => {
  const lines = run(t, { ticks: [
    '2026-09-29T14:03:05.000Z', '2026-09-29T14:03:35.000Z', '2026-09-29T14:04:05.000Z', '2026-09-29T14:04:35.000Z', '2026-09-29T14:07:05.000Z',
  ] });
  assert.deepEqual(lines.map((line) => line.at), ['2026-09-29T14:03:00.000Z', '2026-09-29T14:04:00.000Z', '2026-09-29T14:07:00.000Z']);
  const { at, ...rest } = lines[0];
  assert.deepEqual(rest, {
    l1: 2.4, l5: 3.1, l15: 2.8, cpus: 10, cpu: 0, memFree: 18, memGB: 24, swapMB: 3200, swapTotalMB: 4096,
    holders: [], waiters: 0, waiterKinds: [],
  });
});

test('Engine.tick writes no sample when the machine is unreadable', { timeout: 60000 }, (t) => {
  assert.deepEqual(run(t, { machine: null, ticks: ['2026-09-29T14:03:05.000Z'] }), []);
});

test('Engine.tick writes no sample when actions are off', { timeout: 60000 }, (t) => {
  assert.deepEqual(run(t, { act: false, ticks: ['2026-09-29T14:03:05.000Z'] }), []);
});
