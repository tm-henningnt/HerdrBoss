import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'opencode/mimo-v2.6-flash-free';
const SECRET = 'sk-secret-token-do-not-store';

const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.H27_SCENARIO);
const now = Date.parse(input.now);
Date.now = () => now;
const readArgs = [];
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: false,
  act: false,
  collectors: {
    collectHerdr: async () => input.herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async (args) => {
      readArgs.push(args);
      return (input.screens && input.screens[args[2]]) || '';
    },
  },
});
const snap = await engine.tick();
const dataDir = process.env.HERDR_BOSS_DIR;
console.log(JSON.stringify({
  readArgs,
  paneStatuses: Object.fromEntries((snap.herdr?.panes || []).map((pane) => [pane.id, { status: pane.status, failureLabel: pane.failureLabel || null }])),
  running: snap.control?.projects?.alpha?.running ?? null,
  runningWorkers: snap.control?.runningWorkers ?? null,
  exhausted: snap.lanes?.unmetered?.exhausted || [],
  exhaustedLanes: snap.lanes?.unmetered?.exhaustedLanes || [],
  available: snap.lanes?.unmetered?.byProject?.alpha?.opencode || [],
  failureNotices: (snap.alerts || []).filter((a) => a.key.startsWith('workers:failed:')).map((a) => ({ key: a.key, title: a.title, text: a.text })),
  memory: engine.memory,
  events: engine.events.map((event) => ({ type: event.type, text: event.text })),
  bulletin: fs.readFileSync(path.join(dataDir, 'bulletin.md'), 'utf8'),
  stateJson: fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'),
  errors: snap.errors,
}));
`;

function makeDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-h27-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

function runScenario(scenario, dir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      HERDR_BOSS_DIR: dir,
      HERDR_BOSS_LIVE_DIR: dir,
      H27_SCENARIO: JSON.stringify(scenario),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function makeFreeRunFixture(root) {
  const checkout = path.join(root, 'checkout');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha-fixture', runsDir: '.worker/runs' }));
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', checkout, 'add', '.herdr-boss.json', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'worker-a', worktree], { stdio: 'ignore' });
  fs.mkdirSync(path.join(checkout, '.worker/runs'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.worker/runs', 'worker-a.json'), JSON.stringify({
    name: 'worker-a', pane: 'w-alpha:p2', kind: 'opencode', model: MODEL, worktree,
  }));
  return { checkout, worktree };
}

function alphaPanes(overrides = {}) {
  return [
    { id: 'w-alpha:p1', workspace: 'w-alpha', label: 'orch', orch: true, agent: 'codex', status: 'idle', sessionId: 'orch-session', cwd: overrides.orchCwd || null },
    {
      id: 'w-alpha:p2', workspace: 'w-alpha', label: null, orch: false, agent: 'codex', name: 'worker-a',
      sessionId: 'worker-session', status: 'working', cwd: overrides.workerCwd || '/tmp/worker-a', ...overrides.worker,
    },
  ];
}

test('the engine marks a working worker failed from its pane and stops counting it as running', { timeout: 30000 }, (t) => {
  const dir = makeDataDir(t);
  const scenario = {
    now: '2026-09-27T10:00:00.000Z',
    herdr: { workspaces: [{ id: 'w-alpha', label: 'Alpha' }], panes: alphaPanes() },
    screens: { 'w-alpha:p2': `API Error: ${SECRET}` },
  };
  const failed = runScenario(scenario, dir);
  assert.deepEqual(failed.errors, []);
  assert.deepEqual(failed.paneStatuses['w-alpha:p2'], { status: 'failed', failureLabel: 'API Error' });
  assert.equal(failed.running, 0, 'a failed pane must not count as a running worker');
  assert.equal(failed.runningWorkers, 0);
  assert.deepEqual(failed.readArgs, [['pane', 'read', 'w-alpha:p2', '--source', 'visible', '--lines', '8', '--format', 'text']]);
  assert.equal(failed.failureNotices.length, 1);
  assert.equal(failed.failureNotices[0].title, 'Worker worker-a failed');
  assert.equal(failed.failureNotices[0].text.includes('API Error'), true);
  assert.equal(failed.memory.workerFailures['w-alpha:p2'].label, 'API Error');
  assert.equal(JSON.stringify(failed).includes(SECRET), false, 'raw pane text must not reach notices, events, state, or memory');

  const recovered = runScenario({
    ...scenario,
    screens: { 'w-alpha:p2': 'ordinary working output' },
  }, dir);
  assert.deepEqual(recovered.paneStatuses['w-alpha:p2'], { status: 'working', failureLabel: null });
  assert.equal(recovered.memory.workerFailures?.['w-alpha:p2'], undefined);
  assert.deepEqual(recovered.failureNotices, []);
  assert.equal(recovered.running, 1);
  assert.equal(JSON.stringify(recovered).includes(SECRET), false);

  const failedAgain = runScenario({ ...scenario, now: '2026-09-27T10:05:00.000Z' }, dir);
  assert.deepEqual(failedAgain.paneStatuses['w-alpha:p2'], { status: 'failed', failureLabel: 'API Error' });
  assert.equal(failedAgain.running, 0);
  assert.equal(failedAgain.failureNotices.length, 1, 'a later failure creates exactly one new notice');
  assert.notEqual(failedAgain.failureNotices[0].key, failed.failureNotices[0].key);
});

test('a free-usage failure from a working pane exhausts the unmetered model until its retry time', { timeout: 30000 }, (t) => {
  const dir = makeDataDir(t);
  const { checkout, worktree } = makeFreeRunFixture(dir);
  const retryAt = Date.parse('2026-09-26T15:48:00.000Z');
  const scenario = {
    now: '2026-09-26T10:00:00.000Z',
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: alphaPanes({ orchCwd: checkout, workerCwd: worktree, worker: { agent: 'opencode', name: 'W worker-a' } }),
    },
    screens: { 'w-alpha:p2': 'Free usage exceeded. retry at 2026-09-26T15:48:00Z' },
  };
  const before = runScenario(scenario, dir);
  assert.deepEqual(before.errors, []);
  assert.equal(before.paneStatuses['w-alpha:p2'].status, 'failed');
  assert.equal(before.paneStatuses['w-alpha:p2'].failureLabel, 'Free usage exceeded');
  assert.equal(before.memory.workerFailures['w-alpha:p2'].retryAt, retryAt);
  assert.equal(before.memory.exhaustedFreeModels[MODEL].retryAt, retryAt);
  assert.deepEqual(before.exhausted, [], 'the model runs only in the opencode harness, so the lane record covers it');
  assert.deepEqual(before.exhaustedLanes.map(({ kind, retryAt: until }) => [kind, until]), [['opencode', retryAt]]);
  assert.equal(before.available.includes(MODEL), false, 'the exhausted model leaves the available list');
  assert.equal(before.bulletin.includes('- Unmetered opencode: exhausted (free usage exceeded); retry after '), true);
  assert.equal(before.running, 0);
  assert.equal(JSON.stringify(before).includes('Free usage exceeded. retry at'), false, 'raw pane text must not be stored');

  const after = runScenario({ ...scenario, now: '2026-09-26T16:00:00.000Z' }, dir);
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.memory.exhaustedFreeModels, {}, 'the exhaustion expires at the retry time');
  assert.deepEqual(after.exhausted, []);
  assert.deepEqual(after.exhaustedLanes, []);
  assert.equal(after.available.includes(MODEL), true, 'the model returns to the available list');
  assert.equal(after.bulletin.includes('Exhausted models:'), false);
  assert.equal(after.failureNotices[0].key, before.failureNotices[0].key, 'the notice stays deduplicated across ticks');
});

test('a later absolute retry timestamp extends the exhausted model until that time', { timeout: 30000 }, (t) => {
  const dir = makeDataDir(t);
  const { checkout, worktree } = makeFreeRunFixture(dir);
  const base = {
    herdr: {
      workspaces: [{ id: 'w-alpha', label: 'Alpha' }],
      panes: alphaPanes({ orchCwd: checkout, workerCwd: worktree, worker: { agent: 'opencode', name: 'W worker-a' } }),
    },
  };
  const firstDeadline = Date.parse('2026-09-27T12:00:00.000Z');
  const laterDeadline = Date.parse('2026-09-27T13:00:00.000Z');
  const first = runScenario({
    ...base, now: '2026-09-27T11:00:00.000Z',
    screens: { 'w-alpha:p2': 'Free usage exceeded. retry at 2026-09-27T12:00:00Z' },
  }, dir);
  assert.deepEqual(first.errors, []);
  assert.equal(first.memory.workerFailures['w-alpha:p2'].retryAt, firstDeadline);
  assert.equal(first.memory.exhaustedFreeModels[MODEL].retryAt, firstDeadline);
  assert.equal(first.available.includes(MODEL), false);

  const extended = runScenario({
    ...base, now: '2026-09-27T11:01:00.000Z',
    screens: { 'w-alpha:p2': 'Free usage exceeded. retry at 2026-09-27T13:00:00Z' },
  }, dir);
  assert.deepEqual(extended.errors, []);
  assert.equal(extended.memory.workerFailures['w-alpha:p2'].retryAt, laterDeadline, 'the later absolute timestamp replaces the deadline');
  assert.equal(extended.memory.workerFailures['w-alpha:p2'].at, first.memory.workerFailures['w-alpha:p2'].at, 'the first observation time stays');
  assert.equal(extended.failureNotices.length, 1);
  assert.equal(extended.failureNotices[0].key, first.failureNotices[0].key, 'the notice stays deduplicated');
  assert.equal(extended.memory.exhaustedFreeModels[MODEL].retryAt, laterDeadline, 'the engine extends the exhaustion');
  assert.equal(extended.exhaustedLanes[0].retryAt, laterDeadline);
  assert.equal(extended.available.includes(MODEL), false, 'the model stays unavailable past the old deadline');
  assert.equal(JSON.stringify(extended).includes('retry at 2026'), false, 'raw pane text must not be stored');

  const pastOldDeadline = runScenario({
    ...base, now: '2026-09-27T12:30:00.000Z',
    screens: { 'w-alpha:p2': 'Free usage exceeded. retry at 2026-09-27T13:00:00Z' },
  }, dir);
  assert.deepEqual(pastOldDeadline.errors, []);
  assert.equal(pastOldDeadline.memory.exhaustedFreeModels[MODEL].retryAt, laterDeadline, 'the model is still exhausted after the old deadline');
  assert.equal(pastOldDeadline.available.includes(MODEL), false);

  const expired = runScenario({
    ...base, now: '2026-09-27T13:00:01.000Z',
    screens: { 'w-alpha:p2': 'Free usage exceeded. retry at 2026-09-27T13:00:00Z' },
  }, dir);
  assert.deepEqual(expired.errors, []);
  assert.deepEqual(expired.memory.exhaustedFreeModels, {}, 'the exhaustion expires at the new deadline');
  assert.equal(expired.available.includes(MODEL), true, 'the model returns to the available list at the new deadline');
  assert.equal(expired.bulletin.includes('Exhausted models:'), false);
});
