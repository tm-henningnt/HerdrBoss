import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateResourcePools } from '../src/config.js';
import { loadModels } from '../src/kit/config.js';
import { collectWorker, parkWorker, startWorker } from '../src/kit/workers.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const POOL = { name: 'serve-ports', range: '48100-48104', env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp' };
const poolsOf = () => {
  const result = validateResourcePools([POOL]);
  assert.deepEqual(result.errors, []);
  return result.pools;
};

function seedLeases(dir, leases) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify({ leases }), { mode: 0o600 });
}

function readLeases(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).leases;
}

// A lease record that names a worker of the project, as acquireLeaseFor writes it.
const lease = (item, project, extra = {}) => ({
  pool: 'serve-ports', item, project, worker: 'collect-demo', pane: null,
  at: new Date('2026-10-04T10:00:00Z').toISOString(), expiresAt: new Date('2026-10-04T14:00:00Z').toISOString(),
  borrowed: false, ...extra,
});

function startLeasedWorker(f, name) {
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  return startWorker(name, {
    kind: 'codex', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true, lease: ['serve-ports'],
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    leaseOptions: { pools: poolsOf(), dataDir: f.leaseDir },
  });
}

function writeReport(run) {
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
}

const fixture = () => {
  const f = setupFixture(null);
  f.leaseDir = tempDir('herdr-lease-release-');
  f.name = 'collect-demo';
  return f;
};

test('worker collect releases every lease that names the worker, also a later lease', () => {
  const f = fixture();
  const run = startLeasedWorker(f, f.name);
  writeReport(run);
  const otherProject = 'other-project';
  seedLeases(f.leaseDir, [
    ...readLeases(f.leaseDir),
    lease('48102', f.config.slug, { worker: f.name }),
    lease('48103', f.config.slug, { worker: null, pane: 'ws:orch' }),
    lease('48104', otherProject, { worker: f.name }),
  ]);
  assert.equal(readLeases(f.leaseDir).length, 4, 'the start lease and the three seeded leases are present');

  const output = [];
  collectWorker(f.name, { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: (line) => output.push(line), listWorktreeProcesses: () => [],
    recordUsageFn: () => ({ errors: [], duplicate: false }), leaseDataDir: f.leaseDir,
  });

  const left = readLeases(f.leaseDir).map((item) => [item.item, item.worker, item.project]);
  assert.deepEqual(left, [['48103', null, f.config.slug], ['48104', f.name, otherProject]], 'only the leases of this worker in this project are released');
  assert.equal(output.filter((line) => line === 'Released lease serve-ports 48100.').length, 1, 'the start lease release is printed once');
  assert.equal(output.filter((line) => line === 'Released lease serve-ports 48102.').length, 1, 'the later lease release is printed');
});

test('worker park releases every lease that names the worker', () => {
  const f = fixture();
  startLeasedWorker(f, f.name);
  seedLeases(f.leaseDir, [
    ...readLeases(f.leaseDir),
    lease('48102', f.config.slug, { worker: f.name }),
    lease('48103', f.config.slug, { worker: null, pane: 'ws:orch' }),
  ]);

  const output = [];
  parkWorker(f.name, { reason: 'Owner review' }, { config: f.config, herdr: () => ({}), output: (line) => output.push(line), leaseDataDir: f.leaseDir });

  assert.deepEqual(readLeases(f.leaseDir).map((item) => [item.item, item.worker]), [['48103', null]], 'the parked worker gives back its leases and keeps the project lease');
  assert.ok(output.includes('Released lease serve-ports 48100.'), 'the start lease release is printed');
  assert.ok(output.includes('Released lease serve-ports 48102.'), 'the later lease release is printed');
});
