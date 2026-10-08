import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Every file is in temporary data and home directories. The tests read no real project and prompt no real pane.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-stale-status-'));
const HOME = path.join(DATA, 'home');
fs.mkdirSync(HOME);
process.env.HERDR_BOSS_DIR = DATA;
process.env.HOME = HOME;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { Engine } = await import('../src/engine.js');
const { evaluate, renderBulletin, staleStatuses, staleTextStatuses, staleTextAlerts, STALE_STATUS_NOTICE_AFTER_MINUTES } = await import('../src/rules.js');
const { NO_WORKER_MINUTES } = await import('../src/task-state.js');
const { loadConfig } = await import('../src/config.js');
const { listProjects } = await import('../src/projects.js');

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

test('the default configuration has staleTextMinutes 360', () => {
  assert.equal(loadConfig().staleTextMinutes, 360);
});

// A project whose published file changes while its phase and summary text stay the same. The text fields
// need only the project row and the control entry.
function textSnapshot({ phase = 'Waiting for the Owner', summary = 'Waiting for the Owner.', mode = 'auto' } = {}) {
  const project = { slug: 'alpha', project: 'Alpha', status: 'active', updated: iso(NOW), tasks: [] };
  if (phase !== null) project.phase = phase;
  if (summary !== null) project.summary = summary;
  return {
    projects: [project],
    control: { projects: { alpha: { slug: 'alpha', label: 'Alpha', workspace: 'w1', effectiveMode: mode, running: 0 } } },
  };
}

test('a phase and summary that stay the same for the stale text limit give one notice that names them', () => {
  const cfg = { ...CFG, staleTextMinutes: 360 };
  const snap = textSnapshot();
  // Before the limit no notice goes out.
  assert.deepEqual(staleTextAlerts(snap, cfg, NOW, staleTextStatuses(snap, cfg, NOW, {})), []);
  // At the limit one notice names both unchanged fields. They share one period, so they share one alert.
  const at = NOW + 6 * HOUR;
  const state = staleTextStatuses(snap, cfg, at, staleTextStatuses(snap, cfg, NOW, {}));
  const alerts = staleTextAlerts(snap, cfg, at, state);
  assert.equal(alerts.length, 1, 'one notice for one stale period');
  assert.match(alerts[0].text, /`phase` and `summary`/);
  assert.equal(alerts[0].scope, 'w1');
  assert.equal(alerts[0].once, true, 'the notice goes out once for the period');
  // The same stale period keeps its key, so the deliver gate holds it and does not send it again.
  const later = at + MIN;
  const repeated = staleTextAlerts(snap, cfg, later, staleTextStatuses(snap, cfg, later, state));
  assert.deepEqual(repeated.map((a) => a.key), alerts.map((a) => a.key), 'the same period keeps its key');
  // A changed summary starts a new period with a new key and names only the summary.
  const changed = textSnapshot({ summary: 'Build is in progress.' });
  const changedState = staleTextStatuses(changed, cfg, later, state);
  const restarted = staleTextAlerts(changed, cfg, later + 6 * HOUR, changedState);
  const summary = restarted.find((a) => a.text.includes('`summary`'));
  assert.ok(summary, 'the changed summary gets its own notice after the limit');
  assert.doesNotMatch(summary.text, /`phase`/);
  assert.notEqual(summary.key, alerts[0].key, 'a new period gets a new key');
});

test('stale text notice names only the fields whose text did not change', () => {
  const cfg = { ...CFG, staleTextMinutes: 360 };
  const phaseOnly = textSnapshot({ summary: null });
  const state = staleTextStatuses(phaseOnly, cfg, NOW, {});
  const alerts = staleTextAlerts(phaseOnly, cfg, NOW + 6 * HOUR, state);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /`phase`/);
  assert.doesNotMatch(alerts[0].text, /`summary`/);
});

test('a project without phase or summary text, or paused, gets no stale text notice', () => {
  const cfg = { ...CFG, staleTextMinutes: 360 };
  const bare = textSnapshot({ phase: null, summary: null });
  assert.deepEqual(staleTextStatuses(bare, cfg, NOW, {}), {});
  assert.deepEqual(staleTextAlerts(bare, cfg, NOW + 6 * HOUR, {}), []);
  const paused = textSnapshot({ mode: 'paused' });
  assert.deepEqual(staleTextStatuses(paused, cfg, NOW, {}), {});
  assert.deepEqual(staleTextAlerts(paused, cfg, NOW + 6 * HOUR, {}), []);
});

test('a republish with the same text keeps the stale text period', () => {
  const cfg = { ...CFG, staleTextMinutes: 360 };
  const snap = textSnapshot();
  const first = staleTextStatuses(snap, cfg, NOW, {});
  const republished = structuredClone(snap);
  republished.projects[0].updated = iso(NOW + 5 * HOUR);
  const second = staleTextStatuses(republished, cfg, NOW + 5 * HOUR, first);
  assert.equal(second.alpha.phase.since, first.alpha.phase.since, 'the text period starts at the first sight of the text');
});

test('the evaluate step sends one stale text notice to the project workspace', () => {
  const cfg = { ...CFG, staleTextMinutes: 360 };
  const base = snapshot();
  const snap = {
    ...base,
    projects: [{ slug: 'alpha', project: 'Alpha', status: 'active', updated: iso(NOW), phase: 'Waiting for the Owner', summary: 'Waiting for the Owner.', tasks: [] }],
    statusActivity: {}, taskWorkers: {},
  };
  snap.staleText = staleTextStatuses(snap, cfg, NOW, {});
  assert.deepEqual(evaluate(snap, cfg, {}, NOW).alerts.filter((a) => a.key.startsWith('status:text:')), []);
  snap.staleText = staleTextStatuses(snap, cfg, NOW + 6 * HOUR, snap.staleText);
  const alerts = evaluate(snap, cfg, {}, NOW + 6 * HOUR).alerts.filter((a) => a.key.startsWith('status:text:'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, 'w1');
  assert.match(alerts[0].text, /`phase` and `summary`/);
});

test('the stale status notice delay uses the no-worker threshold', () => {
  assert.equal(STALE_STATUS_NOTICE_AFTER_MINUTES, NO_WORKER_MINUTES);
});

test('published time uses the newer of the status record and file modification time', () => {
  const projectsDir = path.join(DATA, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const file = path.join(projectsDir, 'alpha.json');
  const older = NOW - 4 * HOUR;
  const newerFileTime = NOW - 10 * MIN;
  fs.writeFileSync(file, JSON.stringify({ project: 'Alpha', updated: iso(older), tasks: [] }));
  fs.utimesSync(file, new Date(newerFileTime), new Date(newerFileTime));
  let [project] = listProjects().filter((item) => item.slug === 'alpha');
  assert.equal(Date.parse(project.publishedAt), newerFileTime);
  assert.equal(Date.parse(project.updated), newerFileTime);
  let snap = snapshot({ updated: Date.parse(project.publishedAt), activity: { workedAt: NOW - MIN }, orchStatus: 'working' });
  snap.projects = [project];
  assert.deepEqual(staleAlerts(evaluate(snap, CFG, {}, NOW).alerts), [], 'a newer file timestamp prevents an old-record notice');

  const newerRecordTime = NOW - 5 * MIN;
  fs.writeFileSync(file, JSON.stringify({ project: 'Alpha', updated: iso(newerRecordTime), tasks: [] }));
  fs.utimesSync(file, new Date(newerFileTime), new Date(newerFileTime));
  [project] = listProjects().filter((item) => item.slug === 'alpha');
  assert.equal(Date.parse(project.publishedAt), newerRecordTime, 'a newer recorded publish time wins');
});

test('the project reader accepts an older status with only its required field', () => {
  const projectsDir = path.join(DATA, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'legacy.json'), JSON.stringify({ project: 'Legacy project' }));

  const [project] = listProjects().filter((item) => item.slug === 'legacy');
  assert.equal(project.project, 'Legacy project');
  assert.equal(project.errors, undefined);
  assert.equal(project.status, undefined);
});

test('a stale status notice joins the pane digest after 30 minutes and repeats no sooner than 2 hours', async () => {
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
  assert.equal(prompts.length, 0, 'a working orchestrator does not receive the digest');

  const idlePane = [{ ...panes[0], status: 'idle' }];
  await engine.deliver(first, { panes: idlePane }, NOW + MIN);
  assert.equal(prompts.length, 1, 'the stale item goes in the first idle pane digest');
  assert.equal(prompts[0][2], 'w1:p1');
  assert.match(prompts[0][3], /Status published 31 min ago\. Publish the current plan with herdr-boss publish alpha <file>\./);

  const inInterval = NOW + 59 * MIN;
  const stillStale = staleAlerts(evaluate(active, CFG, {}, inInterval).alerts);
  assert.equal(stillStale.length, 1);
  const movedPane = [{ id: 'w1:p2', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'idle' }];
  await engine.deliver(stillStale, { panes: movedPane }, inInterval);
  assert.equal(prompts.length, 1, 'no second digest goes out inside 2 hours, even after a pane change');

  const afterInterval = NOW + 121 * MIN;
  const repeat = staleAlerts(evaluate(active, CFG, {}, afterInterval).alerts);
  assert.equal(repeat.length, 1);
  await engine.deliver(repeat, { panes: movedPane }, afterInterval);
  assert.equal(prompts.length, 2, 'a second digest follows the two-hour interval');
  assert.equal(prompts[1][2], 'w1:p2');

  const workerOnly = snapshot({ updated: NOW - 31 * MIN, workers: [{ phase: 'live' }] });
  assert.equal(staleAlerts(evaluate(workerOnly, CFG, {}, NOW).alerts).length, 1, 'a live worker also triggers the notice');
  const quiet = snapshot({ updated: NOW - 31 * MIN });
  assert.equal(staleAlerts(evaluate(quiet, CFG, {}, NOW).alerts).length, 0, 'no notice without a working worker or orchestrator');
});

test('an overdue digest reaches a working orchestrator after 3 hours and still uses the 2-hour gate', async () => {
  let clockNow = NOW;
  const clock = () => clockNow;
  const prompts = [];
  const engine = new Engine(loadConfig(), {
    push: false, act: false, clock,
    herdrRunner: async (_cmd, args) => { prompts.push(args); return ''; },
  });
  engine.push = true;
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {}, infoPrompts: {} };
  const panes = [{ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'working' }];
  const stale = staleAlerts(evaluate(snapshot({ updated: NOW - 31 * MIN, orchStatus: 'working' }), CFG, {}, clockNow).alerts);
  const noReport = {
    key: 'workers:no-report:alpha:w1:p2:run-1:period-1', severity: 'info', once: true, scope: 'w1',
    title: 'Worker alpha is idle without a report', text: 'Worker alpha has no report.json.',
  };
  const alerts = [...stale, noReport];

  await engine.deliver(alerts, { panes }, clock());
  assert.equal(prompts.length, 0, 'a new digest does not interrupt a working orchestrator');

  clockNow += 3 * HOUR;
  await engine.deliver(alerts, { panes }, clock());
  assert.equal(prompts.length, 0, 'the overdue limit is more than 3 hours');

  clockNow += 1;
  await engine.deliver(alerts, { panes }, clock());
  assert.equal(prompts.length, 1, 'the overdue digest reaches a pane that stays working');
  assert.match(prompts[0][3], /Status published 31 min ago/);
  assert.match(prompts[0][3], /Worker alpha has no report\.json\./);

  clockNow += 2 * HOUR - 1;
  await engine.deliver(alerts, { panes }, clock());
  assert.equal(prompts.length, 1, 'the existing 2-hour pane gate still applies');

  clockNow += 1;
  await engine.deliver(alerts, { panes }, clock());
  assert.equal(prompts.length, 2, 'the overdue digest can send again when the 2-hour gate opens');
});

test('stale status notices go only to the project pane labeled orch and wait while it is blocked', async () => {
  const prompts = [];
  const engine = new Engine(loadConfig(), { push: false, act: false, herdrRunner: async (_cmd, args) => { prompts.push(args); return ''; } });
  engine.push = true;
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {}, infoPrompts: {} };
  const alerts = staleAlerts(evaluate(snapshot({ updated: NOW - 31 * MIN, orchStatus: 'working' }), CFG, {}, NOW).alerts);

  await engine.deliver(alerts, { panes: [
    { id: 'w1:p1', workspace: 'w1', orch: true, label: 'lead', agent: 'claude', status: 'working' },
    { id: 'w2:p1', workspace: 'w2', orch: true, label: 'orch', agent: 'claude', status: 'working' },
  ] }, NOW);
  assert.equal(prompts.length, 0, 'there is no fallback to another pane or another project');

  await engine.deliver(alerts, { panes: [{ id: 'w1:p2', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'blocked' }] }, NOW + 1);
  assert.equal(prompts.length, 0, 'a blocked orchestrator cannot receive a stale status notice');
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
  const statusFile = path.join(projects, 'alpha.json');
  fs.writeFileSync(statusFile, JSON.stringify({ project: 'Alpha', status: 'active', updated: iso(NOW - 3 * HOUR), tasks: [] }));
  fs.utimesSync(statusFile, new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR));
  t.after(() => fs.rmSync(statusFile, { force: true }));
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
