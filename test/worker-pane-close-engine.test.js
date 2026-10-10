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
  act: engine.act,
  queue: JSON.parse(fs.readFileSync(queuePath, 'utf8')),
  events: engine.events.map((event) => ({ type: event.type, text: event.text })),
}));
`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-pane-engine-'));
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
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'fixture-worker', worktree], { stdio: 'ignore' });
  const runs = path.join(checkout, '.worker', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const run = {
    project: 'fixture-project',
    name: 'fixture-worker',
    kind: 'codex',
    startedAt: '2026-10-01T11:00:00.000Z',
    finishedAt: '2026-10-01T11:30:00.000Z',
    pane: 'ws-fixture:p2',
    worktree,
    startCommit: execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  };
  fs.writeFileSync(path.join(runs, 'fixture-worker.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(data, 'project-repos.json'), JSON.stringify([{ slug: run.project, repo: checkout }]));
  const job = {
    project: run.project,
    name: run.name,
    runId: workerRunId(run, run.project),
    dueAt: FIXED_NOW - 1,
    attempts: 0,
  };
  fs.writeFileSync(path.join(data, 'worker-pane-closes.json'), JSON.stringify([job]));

  const calls = path.join(root, 'herdr-calls.jsonl');
  const fakeHerdr = path.join(bin, 'herdr');
  fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pane' && args[1] === 'close' && process.env.FAIL_CLOSE === '1') {
  process.stderr.write('fixture close failure');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`);
  fs.chmodSync(fakeHerdr, 0o700);

  return {
    data, home, bin, root, checkout, calls, run,
    pane: { id: run.pane, name: run.name, agent: run.kind, status: 'done', workspace: 'ws-fixture' },
    collect() {
      fs.unlinkSync(path.join(data, 'worker-pane-closes.json'));
      delete run.finishedAt;
      Object.assign(run, { issue: null, model: 'gpt-6-luna', branch: 'fixture-worker', base: 'main', allowedPaths: [] });
      fs.writeFileSync(path.join(runs, 'fixture-worker.json'), JSON.stringify(run));
      fs.appendFileSync(path.join(checkout, '.git', 'info', 'exclude'), '\n.worker/\n');
      fs.mkdirSync(path.join(worktree, '.worker'));
      fs.writeFileSync(path.join(worktree, '.worker', 'report.md'), 'Fixture report.\n');
      fs.writeFileSync(path.join(worktree, '.worker', 'report.json'), JSON.stringify({
        issue: null, branch: run.branch, worktree, changedPaths: [], commands: ['fixture check'],
        evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
      }));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { collectWorker } from './src/kit/workers.js';
        import { loadProjectConfig } from './src/kit/config.js';
        collectWorker('fixture-worker', { outcome: 'done', gatePassed: true, paneCloseDelayMinutes: 2 }, {
          config: loadProjectConfig({ cwd: process.env.TEST_CHECKOUT }),
          now: Number(process.env.FIXED_NOW) - 120001,
          leaseDataDir: process.env.HERDR_BOSS_DIR,
          listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }), output: () => {},
        });
      `], { cwd: repo, encoding: 'utf8', env: {
        ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data,
        TEST_CHECKOUT: checkout, FIXED_NOW: String(FIXED_NOW),
      } });
      assert.equal(result.status, 0, result.stderr);
      const scheduled = JSON.parse(fs.readFileSync(path.join(data, 'worker-pane-closes.json'), 'utf8'));
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].dueAt, FIXED_NOW - 1, 'collection preserves its two-minute delay');
    },
    runTick(act, failClose = false) {
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
          HERDR_CALLS: calls,
          FIXED_NOW: String(FIXED_NOW),
          TEST_ACT: act ? '1' : '0',
          FAIL_CLOSE: failClose ? '1' : '0',
          PANE: JSON.stringify({ id: run.pane, name: run.name, agent: run.kind, status: 'done', workspace: 'ws-fixture' }),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    },
  };
}

test('Engine gates, retries, and resumes pane closes from the queue after a service restart', { timeout: 60000 }, (t) => {
  const fixture = setup(t);
  fixture.collect();

  const passive = fixture.runTick(false);
  assert.equal(passive.act, false);
  assert.equal(passive.queue.length, 1, 'the acting gate leaves the durable job queued');
  assert.equal(fs.existsSync(fixture.calls), false, 'the passive service does not call Herdr');

  const failed = fixture.runTick(true, true);
  assert.equal(failed.queue.length, 1, 'a failed service action keeps the durable job');
  assert.equal(failed.queue[0].attempts, 1, 'the next service process sees the incremented attempt count');
  assert.deepEqual(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').map(JSON.parse), [['pane', 'close', fixture.run.pane]], JSON.stringify(failed));

  const restarted = fixture.runTick(true);
  assert.deepEqual(restarted.queue, [], 'a new service process closes and removes the queued job');
  assert.deepEqual(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').map(JSON.parse), [
    ['pane', 'close', fixture.run.pane],
    ['pane', 'close', fixture.run.pane],
  ]);
});
