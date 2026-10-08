import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

test('Engine.tick keeps the last good Herdr reading when an injected reader fails', { timeout: 60000 }, async () => {
  let now = Date.parse('2026-10-08T10:00:00.000Z');
  let herdrReads = 0;
  const goodHerdr = { workspaces: [], panes: [] };
  const cfg = loadConfig();
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  const engine = new Engine(cfg, {
    push: false,
    act: false,
    clock: () => now,
    collectors: {
      collectHerdr: async () => {
        herdrReads++;
        if (herdrReads === 1) return goodHerdr;
        throw new Error('injected Herdr failure');
      },
      collectMachine: async () => null,
      collectProcesses: async () => new Map(),
      collectQuotas: async () => [],
      collectWorktreeCounts: async () => ({}),
      collectCwdProcesses: async () => [],
      collectMissingWorktreeProcesses: async () => [],
      collectPiModels: async () => null,
      readWorkerScreen: async () => '',
    },
  });

  await engine.tick();
  const lastGoodHerdr = engine.state.herdr;
  assert.deepEqual(lastGoodHerdr, goodHerdr);

  now += 60_000;
  await engine.tick();

  assert.equal(herdrReads, 2);
  assert.deepEqual(engine.state.herdr, lastGoodHerdr);
  assert.equal(engine.state.updatedAt, new Date(now).toISOString());
  assert.ok(engine.state.errors.includes('herdr: injected Herdr failure'));
});
