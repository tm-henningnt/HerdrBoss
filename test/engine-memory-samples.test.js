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
const calls = [];
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
  psRunner: async (args, options) => {
    calls.push({ args, options });
    if (input.psFails) { const error = new Error('ps failed'); error.code = 'ETIMEDOUT'; throw error; }
    return input.ps;
  },
});
engine.deliver = async () => {};
for (const at of input.ticks) {
  now = Date.parse(at);
  await engine.tick();
}
console.log(JSON.stringify({ act: engine.act, calls }));
`;

const machine = { load: [2.4, 3.1, 2.8], cpus: 10, ownerIdleMinutes: 0, memFreePercent: 18, memTotalGB: 24, swapUsedMB: 3200, swapTotalMB: 4096 };
const ps = [
  '  1024 /tmp/herdr-fake/bin/claude --print',
  ' 2048 /tmp/herdr-fake/@anthropic-ai/claude-code/cli.js',
  ' 4096 /tmp/herdr-fake/chrome-devtools-mcp/build/src/index.js',
  ' 8192 /usr/libexec/sshd -i',
].join('\n');

function run(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '', G4_SCENARIO: JSON.stringify({ act: true, machine, ps, ...scenario }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(dir, 'memory-samples.jsonl');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { lines: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)), calls: JSON.parse(result.stdout).calls };
}

test('Engine.tick runs ps once per 5 minutes and writes one sample line per window', { timeout: 60000 }, (t) => {
  const { lines, calls } = run(t, { ticks: [
    '2026-09-29T14:03:05.000Z', '2026-09-29T14:04:05.000Z', '2026-09-29T14:06:05.000Z', '2026-09-29T14:08:05.000Z', '2026-09-29T14:09:05.000Z',
  ] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['LC_ALL=C', 'ps', '-Ao', 'rss=,command=']);
  assert.equal(calls[0].options.timeout, 10000);
  assert.deepEqual(lines.map((line) => line.at), ['2026-09-29T14:00:00.000Z', '2026-09-29T14:05:00.000Z']);
  assert.deepEqual(lines[0].mb, { claude: 3, codex: 0, browsers: 0, mcp: 4, vitest: 0, other: 8 });
  assert.doesNotMatch(JSON.stringify(lines), /herdr-fake|cli\.js|sshd|--print/);
});

test('Engine.tick writes a memory sample when the machine collector is unreadable', { timeout: 60000 }, (t) => {
  const { lines, calls } = run(t, { machine: null, ticks: ['2026-09-29T14:03:05.000Z'] });
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].mb.mcp, 4);
});

test('Engine.tick writes no memory sample and runs no ps when actions are off', { timeout: 60000 }, (t) => {
  const { lines, calls } = run(t, { act: false, ticks: ['2026-09-29T14:03:05.000Z', '2026-09-29T14:08:05.000Z'] });
  assert.deepEqual(lines, []);
  assert.deepEqual(calls, []);
});

test('Engine.tick swallows a ps failure and does not retry before the next window', { timeout: 60000 }, (t) => {
  const { lines, calls } = run(t, { psFails: true, ticks: ['2026-09-29T14:03:05.000Z', '2026-09-29T14:04:05.000Z', '2026-09-29T14:08:05.000Z'] });
  assert.equal(calls.length, 2);
  assert.deepEqual(lines, []);
});