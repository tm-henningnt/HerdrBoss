import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Every file is in a temporary data directory. The tests read no real project and prompt no real pane.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-stale-status-'));
process.env.HERDR_BOSS_DIR = DATA;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { Engine } = await import('../src/engine.js');
const { evaluate, renderBulletin, staleStatuses } = await import('../src/rules.js');
const { loadConfig } = await import('../src/config.js');

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const CFG = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {}, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [], staleStatusMinutes: 120 };
const iso = (ms) => new Date(ms).toISOString();

function snapshot({ updated = NOW - 3 * HOUR, mode = 'auto', status = 'active', activity = {}, workers = [], orchStatus = 'idle' } = {}) {
  return {
    updatedAt: iso(NOW),
    projects: [{ slug: 'alpha', project: 'Alpha', status, updated: iso(updated), tasks: [] }],
    control: { projects: { alpha: { slug: 'alpha', label: 'Alpha', workspace: 'w1', effectiveMode: mode, running: 0 } } },
    herdr: { workspaces: [{ id: 'w1', label: 'Alpha' }], panes: [{ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: orchStatus }] },
    statusActivity: { alpha: activity },
    taskWorkers: { alpha: workers },
  };
}
const staleAlerts = (alerts) => alerts.filter((a) => a.key.startsWith('status:stale:'));

test('board staleness still records worker activity after an old publish', () => {
  const snap = snapshot({ activity: { workedAt: NOW - 20 * MIN } });
  const stale = staleStatuses(snap, CFG, NOW);
  assert.equal(stale.alpha.workers, true);
  assert.equal(stale.alpha.commits, false);
  assert.equal(staleAlerts(evaluate(snap, CFG, {}, NOW).alerts).length, 0, 'status activity alone does not trigger the worker notice');
});

test('board staleness still records new commits after an old publish', () => {
  const snap = snapshot({ activity: { landedAt: NOW - 30 * MIN } });
  const stale = staleStatuses(snap, CFG, NOW);
  assert.equal(stale.alpha.commits, true);
  assert.equal(stale.alpha.workers, false);
  assert.equal(staleAlerts(evaluate(snap, CFG, {}, NOW).alerts).length, 0, 'commits alone do not trigger the worker notice');
});

test('a status is not stale under 2 hours, when paused, or without activity after the publish', () => {
  const young = snapshot({ updated: NOW - 119 * MIN, activity: { workedAt: NOW - MIN, landedAt: NOW - MIN } });
  assert.deepEqual(staleStatuses(young, CFG, NOW), {});
  const paused = snapshot({ mode: 'paused', activity: { workedAt: NOW - MIN, landedAt: NOW - MIN } });
  assert.deepEqual(staleStatuses(paused, CFG, NOW), {});
  const pausedStatus = snapshot({ status: 'paused', activity: { workedAt: NOW - MIN } });
  pausedStatus.control.projects.alpha.effectiveMode = 'paused';
  assert.deepEqual(staleStatuses(pausedStatus, CFG, NOW), {});
  assert.deepEqual(staleStatuses(snapshot(), CFG, NOW), {});
  // Work before the publish, or work more than 2 hours ago, does not count.
  const before = snapshot({ updated: NOW - 5 * HOUR, activity: { workedAt: NOW - 5 * HOUR - MIN, landedAt: NOW - 6 * HOUR } });
  assert.deepEqual(staleStatuses(before, CFG, NOW), {});
  const oldWork = snapshot({ updated: NOW - 5 * HOUR, activity: { workedAt: NOW - 3 * HOUR } });
  assert.deepEqual(staleStatuses(oldWork, CFG, NOW), {});
  assert.equal(staleAlerts(evaluate(snapshot(), CFG, {}, NOW).alerts).length, 0);
  // staleStatusMinutes changes the age limit.
  assert.deepEqual(Object.keys(staleStatuses(young, { ...CFG, staleStatusMinutes: 60 }, NOW)), ['alpha']);
});

test('the default configuration has staleStatusMinutes 120', () => {
  assert.equal(loadConfig().staleStatusMinutes, 120);
});

test('a stale status notice starts after 30 minutes and repeats once an hour while the orchestrator works', async () => {
  const prompts = [];
  const engine = new Engine(loadConfig(), { push: false, act: false, herdrRunner: async (_cmd, args) => { prompts.push(args); return ''; } });
  engine.push = true;
  engine.log = () => {};
  const panes = [{ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'working' }];
  const under = snapshot({ updated: NOW - 29 * MIN, orchStatus: 'working' });
  assert.equal(staleAlerts(evaluate(under, CFG, {}, NOW).alerts).length, 0, 'no notice below 30 minutes');

  const active = snapshot({ updated: NOW - 31 * MIN, orchStatus: 'working' });
  const first = staleAlerts(evaluate(active, CFG, {}, NOW).alerts);
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'Status published 31 min ago. Publish the current plan with herdr-boss publish alpha <file>.');
  await engine.deliver(first, { panes }, NOW);
  assert.equal(prompts.length, 1, 'one prompt starts the interval');
  assert.equal(prompts[0][2], 'w1:p1');
  assert.match(prompts[0][3], /Status published 31 min ago\. Publish the current plan with herdr-boss publish alpha <file>\./);

  const inInterval = NOW + 59 * MIN;
  const stillStale = staleAlerts(evaluate(active, CFG, {}, inInterval).alerts);
  assert.equal(stillStale.length, 1);
  const movedPane = [{ id: 'w1:p2', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'working' }];
  await engine.deliver(stillStale, { panes: movedPane }, inInterval);
  assert.equal(prompts.length, 1, 'no second prompt inside the hour, even after a pane change');

  const afterInterval = NOW + 61 * MIN;
  const repeat = staleAlerts(evaluate(active, CFG, {}, afterInterval).alerts);
  assert.equal(repeat.length, 1);
  await engine.deliver(repeat, { panes: movedPane }, afterInterval);
  assert.equal(prompts.length, 2, 'a second prompt follows the hour');
  assert.equal(prompts[1][2], 'w1:p2');

  const workerOnly = snapshot({ updated: NOW - 31 * MIN, workers: [{ phase: 'live' }] });
  assert.equal(staleAlerts(evaluate(workerOnly, CFG, {}, NOW).alerts).length, 1, 'a live worker also triggers the notice');
  const quiet = snapshot({ updated: NOW - 31 * MIN });
  assert.equal(staleAlerts(evaluate(quiet, CFG, {}, NOW).alerts).length, 0, 'no notice without a working worker or orchestrator');
});

function gitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-stale-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one');
  return { dir, git, commit: (message, date) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', message], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }) };
}

test('the engine reads each project HEAD at most once every 10 minutes', async (t) => {
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(DATA, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo: repo.dir, remote: '' }]));
  t.after(() => fs.rmSync(path.join(DATA, 'project-repos.json'), { force: true }));
  const calls = [];
  const engine = new Engine(loadConfig(), { push: false, act: false, gitRunner: (args) => { calls.push(args); return new Promise((resolve, reject) => {
    try { resolve(execFileSync('git', args, { encoding: 'utf8' })); } catch (error) { reject(error); }
  }); } });
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {} };
  const t0 = NOW;
  await engine.readProjectHeads(t0);
  const reads = () => calls.filter((args) => args.includes('rev-parse')).length;
  assert.equal(reads(), 1);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['-C', repo.dir], ['-C', repo.dir]]);
  assert.ok(calls.some((args) => args.join(' ') === `-C ${repo.dir} log -1 --format=%cI`));
  const firstHead = engine.memory.statusHeads.alpha.head;
  assert.match(firstHead, /^[0-9a-f]{40}$/);

  repo.commit('two', iso(t0 + 5 * MIN));
  await engine.readProjectHeads(t0 + 9 * MIN);
  assert.equal(reads(), 1, 'no read inside 10 minutes');
  await engine.readProjectHeads(t0 + 10 * MIN);
  assert.equal(reads(), 2);
  const record = engine.memory.statusHeads.alpha;
  assert.notEqual(record.head, firstHead);
  assert.equal(record.changedAt, t0 + 10 * MIN);
  assert.equal(Date.parse(record.committedAt), t0 + 5 * MIN);
  assert.equal(engine.statusActivity().alpha.landedAt, t0 + 10 * MIN);
});

test('a project without a repository record uses only the worker rule', async () => {
  const engine = new Engine(loadConfig(), { push: false, act: false, gitRunner: () => { throw new Error('git must not run'); } });
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {} };
  await engine.readProjectHeads(NOW);
  assert.equal(engine.statusActivity().alpha?.landedAt ?? null, null);
});

test('an engine tick records worker activity, marks the status stale, and writes the bulletin line', async (t) => {
  const projects = path.join(DATA, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'alpha.json'), JSON.stringify({ project: 'Alpha', status: 'active', updated: iso(NOW - 3 * HOUR), tasks: [] }));
  t.after(() => fs.rmSync(path.join(projects, 'alpha.json'), { force: true }));
  const realNow = Date.now;
  Date.now = () => NOW;
  t.after(() => { Date.now = realNow; });
  const panes = [
    { id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'working', cwd: '/nonexistent/alpha' },
    { id: 'w1:p2', workspace: 'w1', label: 'worker', name: 'beta', agent: 'claude', status: 'working', cwd: '/nonexistent/alpha-wt-beta' },
  ];
  const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
    collectHerdr: async () => ({ panes, workspaces: [{ id: 'w1', label: 'Alpha' }] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
  } });
  engine.log = () => {};
  const snap = await engine.tick();
  assert.equal(snap.control.projects.alpha?.running, 1);
  assert.equal(engine.memory.statusActivity.alpha.workedAt, NOW);
  assert.equal(snap.staleStatus.alpha.workers, true);
  assert.equal(snap.staleStatus.alpha.since, NOW);
  assert.ok(snap.alerts.some((a) => a.key.startsWith('status:stale:alpha:')));
  const bulletin = fs.readFileSync(path.join(DATA, 'bulletin.md'), 'utf8');
  const section = bulletin.split('### Alpha')[1] || '';
  assert.match(section, /^\s*\n- Status stale since [^\n]+\.$/m);

  // A later tick in the same episode keeps the first stale time.
  Date.now = () => NOW + 5 * MIN;
  const next = await engine.tick();
  assert.equal(next.staleStatus.alpha.since, NOW);
});

test('the bulletin names the stale time in the project section', () => {
  const snap = snapshot({ activity: { workedAt: NOW - MIN } });
  snap.staleStatus = { alpha: { ...staleStatuses(snap, CFG, NOW).alpha, since: NOW - 30 * MIN } };
  const evaluation = evaluate(snap, CFG, {}, NOW);
  // The fixture has no allocation data, so the bulletin omits the worker allocation section.
  const text = renderBulletin({ ...snap, control: undefined }, evaluation, { host: '127.0.0.1', port: 4477 });
  const section = text.split('## Project rules')[1] || '';
  assert.match(section, /### Alpha\n\n- Status stale since [^\n]+\./);
});
