import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

test('the engine passes the OpenCode Go settings to the quota collector', { timeout: 60000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-opencode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'project-repos.json'), '[]');
  const cfg = { ...loadConfig(), push: false, quota: { warnPercent: 90, criticalPercent: 98, opencodeGoResetAt: '2026-10-09T10:00:00Z', opencodeStatsDays: 3 } };
  cfg.browsers.reapOrphanDaemons = false;
  const seen = [];
  const engine = new Engine(cfg, {
    push: false, act: false, lockDataDir: dataDir, clock: () => Date.parse('2026-10-01T12:00:00.000Z'),
    collectors: {
      collectHerdr: async () => ({ workspaces: [], panes: [] }), collectMachine: async () => null, collectProcesses: async () => new Map(),
      collectQuotas: async (options) => { seen.push(options.opencode); return []; },
      collectWorktreeCounts: async () => ({}), collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [],
      readWorkerScreen: async () => '', collectPiModels: async () => null,
    },
    herdrRunner: async () => '{}',
  });
  await engine.tick();
  await engine.quotaRead;
  assert.deepEqual(seen[0], { resetAt: '2026-10-09T10:00:00Z', days: 3 });
});
