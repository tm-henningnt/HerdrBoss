import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const directory = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-actions-minutes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'project-repos.json'), JSON.stringify([{ slug: 'sample', repo: '/tmp/sample', remote: 'https://github.com/acme/sample.git' }]));
  return dir;
};

function makeEngine(dataDir, cfg, actionsMinutesRun) {
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  return new Engine(cfg, {
    push: false,
    act: false,
    lockDataDir: dataDir,
    clock: () => NOW,
    actionsMinutesRun,
    collectors: {
      collectHerdr: async () => ({ workspaces: [], panes: [] }),
      collectMachine: async () => null,
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
}

test('Engine.tick starts Actions reads without waiting and keeps one refresh in flight', { timeout: 60000 }, async (t) => {
  const dataDir = directory(t);
  let calls = 0;
  const engine = makeEngine(dataDir, { ...loadConfig(), analytics: { actionsMinutes: true } }, async (_args, options) => {
    calls++;
    assert.equal(options.timeout, 10000);
    return new Promise(() => {});
  });
  const started = process.hrtime.bigint();
  await engine.tick();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  await new Promise((resolve) => setImmediate(resolve));
  engine.refreshActionsMinutes(NOW + 1);
  assert.equal(calls, 1);
  assert.equal(engine.actionsMinutesRunning, true);
  assert.ok(elapsedMs < 2000, `tick took ${elapsedMs} ms while the fake GitHub read stayed pending`);
});

test('Engine.tick makes no GitHub read when the Analytics setting is off', { timeout: 60000 }, async (t) => {
  const dataDir = directory(t);
  let calls = 0;
  const engine = makeEngine(dataDir, { ...loadConfig(), analytics: { actionsMinutes: false } }, async () => { calls++; return { status: 0, stdout: '{}' }; });
  await engine.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'actions-minutes.json')), false);
});
