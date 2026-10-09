import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerRunId } from '../src/agent-messages.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = Date.parse('2026-10-01T12:00:00.000Z');
const REPORT_AGE_MS = 60_000;
const REVIEW_CLOSE_MS = 10 * 60_000;
const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
Date.now = () => Number(process.env.FIXED_NOW);
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
if (process.env.AUTOCLOSE === '0') cfg.workers.autoCloseReview = false;
const pane = JSON.parse(process.env.PANE);
const engine = new Engine(cfg, {
  push: false,
  act: process.env.TEST_ACT === '1',
  herdrRunner: async (_command, args) => execFileSync('herdr', args, { encoding: 'utf8' }),
  collectors: {
    collectHerdr: async () => ({ workspaces: [{ id: 'ws-fixture', label: 'Fixture' }], panes: [pane] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectPiModels: async () => null,
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
    runSpendScan: async () => null,
    runDenialScan: async () => ({ notices: [], errors: [] }),
    checkHarness: () => [],
    probeTcp: async () => false,
    probePort: async () => false,
    collectBrowserClients: async () => 0,
    probeBrowser: async () => ({ ok: true, pageIds: [], attachedTabIds: [] }),
    cdpResponds: async () => true,
    sweepReviewPacks: async () => ({ expired: [], deleted: [] }),
    sweepAttachments: () => ({ deleted: 0 }),
  },
});
await engine.tick();
const dataDir = process.env.HERDR_BOSS_DIR;
const queuePath = path.join(dataDir, 'worker-pane-closes.json');
console.log(JSON.stringify({
  queue: fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [],
  uncollected: engine.memory.uncollectedWorkers || {},
}));
`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-autoclose-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const bin = path.join(home, '.local', 'bin');
  const checkout = path.join(root, 'checkout');
  const worktree = path.join(root, 'worker');
  for (const dir of [data, home, bin, checkout]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'fixture-project', runsDir: '.worker/runs' }));
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'fixture');
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'review-worker', worktree], { stdio: 'ignore' });
  const runs = path.join(checkout, '.worker', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const run = {
    project: 'fixture-project',
    name: 'review-worker',
    kind: 'codex',
    startedAt: '2026-10-01T11:00:00.000Z',
    pane: 'ws-fixture:p2',
    worktree,
    readOnly: true,
  };
  fs.writeFileSync(path.join(runs, 'review-worker.json'), JSON.stringify(run));
  fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
  const reportFile = path.join(worktree, '.worker', 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify({ issue: null, branch: 'review-worker', worktree, changedPaths: [], commands: [], evidenceTier: ['unit'], unverified: [], stoppedEarly: false }));
  const reportAt = FIXED_NOW - REPORT_AGE_MS;
  fs.utimesSync(reportFile, new Date(reportAt), new Date(reportAt));
  fs.writeFileSync(path.join(data, 'project-repos.json'), JSON.stringify([{ slug: run.project, repo: checkout }]));

  const fakeHerdr = path.join(bin, 'herdr');
  fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`);
  fs.chmodSync(fakeHerdr, 0o700);

  return {
    data, home, bin, root, run, reportAt,
    pane: { id: run.pane, name: run.name, agent: run.kind, status: 'done', workspace: 'ws-fixture', cwd: worktree },
    runTick(act, autoClose = true) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          HERDR_BOSS_DIR: data,
          HERDR_BOSS_LIVE_DIR: data,
          NODE_TEST_CONTEXT: '',
          PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
          FIXED_NOW: String(FIXED_NOW),
          TEST_ACT: act ? '1' : '0',
          AUTOCLOSE: autoClose ? '1' : '0',
          PANE: JSON.stringify({ id: run.pane, name: run.name, agent: run.kind, status: 'done', workspace: 'ws-fixture', cwd: worktree }),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    },
  };
}

test('Engine schedules a review pane close ten minutes after the report and sends no uncollected notice', { timeout: 60000 }, (t) => {
  const fixture = setup(t);
  const tick = fixture.runTick(true);

  assert.equal(tick.queue.length, 1, 'the acting tick queues one review pane close');
  assert.deepEqual(tick.queue[0], {
    project: fixture.run.project,
    name: fixture.run.name,
    runId: workerRunId(fixture.run, fixture.run.project),
    dueAt: fixture.reportAt + REVIEW_CLOSE_MS,
    attempts: 0,
  });
  const keys = Object.keys(tick.uncollected);
  assert.deepEqual(keys, [], 'a review worker never enters the uncollected notice tracker');
});

test('Engine schedules no review close when workers.autoCloseReview is false', { timeout: 60000 }, (t) => {
  const fixture = setup(t);
  const tick = fixture.runTick(true, false);
  assert.deepEqual(tick.queue, []);
});

test('a passive service plans no review close', { timeout: 60000 }, (t) => {
  const fixture = setup(t);
  const tick = fixture.runTick(false);
  assert.deepEqual(tick.queue, []);
});
