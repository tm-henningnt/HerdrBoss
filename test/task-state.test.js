import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

// Every file is in a temporary data directory. The tests read no real project and touch no live pane.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-state-'));
process.env.HERDR_BOSS_DIR = DATA;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { overlayTasks, readWorkerFacts, workerFactFromRun, publishConflicts, applyTaskState, gitIsMerged, taskMismatches } = await import('../src/task-state.js');
const { staleStatuses, evaluate } = await import('../src/rules.js');
const { taskIdWarning } = await import('../src/kit/workers.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: 'todo', ...extra });
const live = (name, taskId, extra = {}) => ({ name, taskId, phase: 'live', kind: 'claude', model: 'claude-sonnet-5-5', startedAt: iso(NOW - 30 * MIN), ...extra });
const byId = (result) => Object.fromEntries(result.map((t) => [t.id, t]));

test('a live worker makes its task doing and names the source', () => {
  const [a] = overlayTasks([task('A')], [live('w1', 'A')]);
  assert.equal(a.state, 'doing');
  assert.equal(a.publishedStatus, 'todo');
  assert.equal(a.status, 'todo', 'the published status field is unchanged');
  assert.equal(a.stateSource, 'live from worker w1');
  assert.deepEqual(a.worker, { name: 'w1', kind: 'claude', model: 'claude-sonnet-5-5', startedAt: iso(NOW - 30 * MIN) });
});

test('a collected worker whose branch is not merged makes the task review', () => {
  const [a] = overlayTasks([task('A', { status: 'doing' })], [live('w1', 'A', { phase: 'review' })]);
  assert.equal(a.state, 'review');
  assert.equal(a.stateSource, 'collected from worker w1');
  assert.equal(a.worker.name, 'w1');
});

test('a merged worker makes the task done, and a published done stays done', () => {
  const [a] = overlayTasks([task('A')], [live('w1', 'A', { phase: 'merged' })]);
  assert.equal(a.state, 'done');
  assert.equal(a.stateSource, 'merged from worker w1');
  const [b] = overlayTasks([task('B', { status: 'done' })], [live('w2', 'B')]);
  assert.equal(b.state, 'done', 'a live worker does not reopen a published done task');
  assert.equal(b.stateSource, 'published');
});

test('a failed or abandoned worker leaves the published state', () => {
  const tasks = [task('A'), task('B', { status: 'doing' })];
  const result = byId(overlayTasks(tasks, [live('w1', 'A', { phase: 'failed' }), live('w2', 'B', { phase: 'abandoned' })]));
  assert.equal(result.A.state, 'ready');
  assert.equal(result.A.worker, null);
  assert.equal(result.B.state, 'ready', 'a published doing task with only an abandoned worker is open again');
  assert.equal(result.B.stateSource, 'worker w2 abandoned');
  assert.equal(result.B.worker, null);
});

test('a published doing task with only a failed worker returns to ready, or to blocked when a dependency is open', () => {
  const tasks = [task('A', { status: 'doing' }), task('B', { status: 'doing', blockedBy: ['C'] }), task('C'), task('D', { status: 'doing' }), task('E', { status: 'review' })];
  const workers = [live('w1', 'A', { phase: 'failed' }), live('w2', 'B', { phase: 'failed' }), live('w4', 'E', { phase: 'abandoned' })];
  const result = byId(overlayTasks(tasks, workers));
  assert.equal(result.A.state, 'ready');
  assert.equal(result.A.stateSource, 'worker w1 failed');
  assert.equal(result.B.state, 'blocked');
  assert.deepEqual(result.B.blockers, ['C']);
  assert.equal(result.D.state, 'doing', 'a published doing task without any worker stays doing');
  assert.equal(result.E.state, 'review', 'only doing returns to ready');
});

test('an open dependency blocks todo, ready, and blocked tasks but never a done task or a live doing task', () => {
  const tasks = [
    task('X'),
    task('T', { blockedBy: ['X'] }), task('R', { status: 'ready', blockedBy: ['X'] }), task('B', { status: 'blocked', blockedBy: ['X'] }),
    task('D', { status: 'done', blockedBy: ['X'] }), task('L', { blockedBy: ['X'] }), task('V', { status: 'review', blockedBy: ['X'] }),
  ];
  const result = byId(overlayTasks(tasks, [live('w1', 'L')]));
  for (const id of ['T', 'R', 'B']) { assert.equal(result[id].state, 'blocked', id); assert.deepEqual(result[id].blockers, ['X']); }
  assert.equal(result.D.state, 'done');
  assert.equal(result.L.state, 'doing');
  assert.equal(result.V.state, 'review');
});

test('a later worker of a task wins over an earlier one, whatever the input order', () => {
  const old = live('old', 'A', { phase: 'merged', startedAt: iso(NOW - 5 * HOUR) });
  const later = (phase) => live('new', 'A', { phase, startedAt: iso(NOW - HOUR) });
  assert.equal(overlayTasks([task('A')], [later('live'), old])[0].worker.name, 'new');
  assert.equal(overlayTasks([task('A')], [later('live'), old])[0].state, 'doing');
  assert.equal(overlayTasks([task('A')], [old, later('review')])[0].state, 'review');
  const oldReview = live('old', 'A', { phase: 'review', startedAt: iso(NOW - 5 * HOUR) });
  assert.equal(overlayTasks([task('A')], [oldReview, later('merged')])[0].state, 'done');
  const reading = readWorkerFacts(runsDir({ after() {} }, [run('late', { taskId: 'A', startedAt: iso(NOW - HOUR) }), run('early', { taskId: 'A', startedAt: iso(NOW - 5 * HOUR) })]), {});
  assert.deepEqual(reading.map((f) => f.name), ['early', 'late'], 'facts sort by start time');
});

test('unmet dependencies make a task blocked with the blocking task ids and the reason', () => {
  const tasks = [task('A'), task('B', { status: 'doing' }), task('C', { blockedBy: ['A', 'B'] })];
  const result = byId(overlayTasks(tasks, []));
  assert.equal(result.C.state, 'blocked');
  assert.deepEqual(result.C.blockers, ['A', 'B']);
  assert.equal(result.C.blockedReason, 'waits on task A, task B');
  assert.equal(result.A.state, 'ready');
  assert.equal(result.A.blockers.length, 0);
});

test('a task is ready when all dependencies are done, also when a worker merged one', () => {
  const tasks = [task('A', { status: 'done' }), task('B'), task('C', { blockedBy: ['A', 'B'] }), task('D', { blockedBy: ['A'] })];
  const result = byId(overlayTasks(tasks, [live('w1', 'B', { phase: 'merged' })]));
  assert.equal(result.C.state, 'ready');
  assert.equal(result.D.state, 'ready');
  assert.equal(result.C.stateSource, 'derived from dependencies');
});

test('a published blocked task that waits on the Owner stays blocked with that reason', () => {
  const tasks = [task('A', { status: 'blocked', waitingOn: 'owner', ask: 'Pick a name' })];
  const [a] = overlayTasks(tasks, []);
  assert.equal(a.state, 'blocked');
  assert.equal(a.blockedReason, 'waits on the owner');
});

test('an unknown dependency counts as unmet', () => {
  const [a] = overlayTasks([task('A', { blockedBy: ['X'] })], []);
  assert.equal(a.state, 'blocked');
  assert.deepEqual(a.blockers, ['X']);
});

test('when two workers share a task, the live worker wins over a review worker', () => {
  const [a] = overlayTasks([task('A')], [live('old', 'A', { phase: 'review' }), live('new', 'A')]);
  assert.equal(a.state, 'doing');
  assert.equal(a.worker.name, 'new');
});

// Run records on disk.
function runsDir(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const record of records) fs.writeFileSync(path.join(dir, `${record.name}.json`), JSON.stringify(record));
  return dir;
}
const run = (name, extra = {}) => ({ name, kind: 'claude', model: 'm', branch: name, base: 'main', startedAt: iso(NOW - HOUR), pane: `w:${name}`, ...extra });

test('worker facts come from run records with the task id or the issue alias', (t) => {
  const dir = runsDir(t, [
    run('a', { taskId: 'A' }),
    run('b', { issue: 7 }),
    run('c', { taskId: 'C', collectedAt: iso(NOW - MIN) }),
    run('d', { taskId: 'D', finishedAt: iso(NOW - MIN), outcome: 'done' }),
    run('e', { taskId: 'E', finishedAt: iso(NOW - MIN), outcome: 'failed' }),
    run('f', { taskId: 'F', finishedAt: iso(NOW - MIN), outcome: 'partial' }),
    run('g', { taskId: 'G' }),
    run('h'),
  ]);
  const merged = new Set(['d']);
  const facts = readWorkerFacts(dir, { isLive: (r) => r.name !== 'g', isMerged: (r) => merged.has(r.name) });
  const phase = Object.fromEntries(facts.map((f) => [f.name, [f.taskId, f.phase]]));
  assert.deepEqual(phase, {
    a: ['A', 'live'], b: ['7', 'live'], c: ['C', 'review'], d: ['D', 'merged'], e: ['E', 'failed'], f: ['F', 'failed'], g: ['G', 'abandoned'],
  });
  assert.equal(workerFactFromRun(run('h'), {}), null, 'a record without a task has no fact');
  assert.equal(readWorkerFacts(path.join(dir, 'missing'), {}).length, 0);
});

test('a collected worker turns merged once its branch is merged', (t) => {
  const dir = runsDir(t, [run('c', { taskId: 'C', collectedAt: iso(NOW - MIN) })]);
  assert.equal(readWorkerFacts(dir, { isMerged: () => false })[0].phase, 'review');
  assert.equal(readWorkerFacts(dir, { isMerged: () => true })[0].phase, 'merged');
});

// Publish check.
test('publish conflicts name each live worker whose task is not doing', () => {
  const facts = [live('w1', 'A'), live('w2', 'B'), live('w3', 'C', { phase: 'review' })];
  const data = { tasks: [task('A', { status: 'todo' }), task('B', { status: 'doing' }), task('C', { status: 'todo' })] };
  const conflicts = publishConflicts(data, facts);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /task A/);
  assert.match(conflicts[0], /worker w1/);
  assert.match(conflicts[0], /todo/);
  assert.equal(publishConflicts({ tasks: [task('A', { status: 'doing' })] }, [live('w1', 'A')]).length, 0);
  assert.equal(publishConflicts({ tasks: [] }, [live('w1', 'Z')]).length, 1, 'a task that is missing from the status counts');
});

function projectRepo(t, records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-data-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const repo = path.join(home, 'alpha');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const runs = path.join(repo, '.orchestration', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  for (const record of records) fs.writeFileSync(path.join(runs, `${record.name}.json`), JSON.stringify(record));
  return { home, dataDir, repo };
}

// A fake herdr command prints an agent list in the shape of `herdr agent list`. A null list gives no herdr command.
function publish(env, file, ...extra) {
  const bin = path.dirname(process.execPath);
  const fake = env.agents === undefined ? null : path.join(env.dataDir, 'fakebin');
  if (fake) {
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'herdr'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(env.agents)}\nJSON\n`, { mode: 0o755 });
  }
  return spawnSync(process.execPath, [path.join(repoRoot, 'src/cli.js'), 'publish', 'alpha', file, ...extra], {
    cwd: env.repo, encoding: 'utf8',
    env: { PATH: `${fake ? `${fake}:` : ''}${bin}:/usr/bin:/bin`, HOME: env.home, HERDR_BOSS_DIR: env.dataDir, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}
// The shape of one row of `herdr agent list`.
const agentRow = (name, status) => ({ agent: 'claude', agent_status: status, name, pane_id: `w:${name}`, workspace_id: 'w', cwd: '/x' });
const statusFile = (env, status) => {
  const file = path.join(env.dataDir, 'status.json');
  fs.writeFileSync(file, JSON.stringify({ project: 'Alpha', tasks: [task('A', { status })] }));
  return file;
};

test('herdr-boss publish refuses a working worker on a task that is not doing unless --force is given', (t) => {
  const env = projectRepo(t, [run('w1', { taskId: 'A', worktree: os.tmpdir() })]);
  env.agents = { agents: [agentRow('w1', 'working')] };
  const file = statusFile(env, 'todo');
  const refused = publish(env, file);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /task A/);
  assert.match(refused.stderr, /worker w1/);
  assert.match(refused.stderr, /--force/);
  assert.equal(fs.existsSync(path.join(env.dataDir, 'projects', 'alpha.json')), false, 'nothing is published');
  const forced = publish(env, file, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.existsSync(path.join(env.dataDir, 'projects', 'alpha.json')), true);
  assert.equal(publish(env, statusFile(env, 'doing')).status, 0);
  // A blocked agent also counts.
  env.agents = { agents: [agentRow('w1', 'blocked')] };
  assert.equal(publish(env, statusFile(env, 'todo')).status, 1);
});

test('herdr-boss publish lets an idle, done, parked, or reported worker wait for the orchestrator', (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const env = projectRepo(t, [run('w1', { taskId: 'A', worktree })]);
  env.agents = { agents: [agentRow('w1', 'idle')] };
  assert.equal(publish(env, statusFile(env, 'review')).status, 0, 'an idle agent does not block');
  env.agents = { agents: [agentRow('w1', 'done')] };
  assert.equal(publish(env, statusFile(env, 'done')).status, 0, 'a done agent does not block');
  env.agents = { agents: [agentRow('w1', 'working')] };
  assert.equal(publish(env, statusFile(env, 'review')).status, 1, 'a working agent without a report blocks');
  fs.mkdirSync(path.join(worktree, '.worker'));
  fs.writeFileSync(path.join(worktree, '.worker', 'report.json'), '{}');
  assert.equal(publish(env, statusFile(env, 'review')).status, 0, 'a worker that wrote its report does not block');
  fs.rmSync(path.join(worktree, '.worker'), { recursive: true });
  const runs = path.join(env.repo, '.orchestration', 'runs');
  fs.writeFileSync(path.join(runs, 'w1.json'), JSON.stringify(run('w1', { taskId: 'A', worktree, parked: { reason: 'wait', at: iso(NOW) } })));
  assert.equal(publish(env, statusFile(env, 'todo')).status, 0, 'a parked worker does not block');
});

test('herdr-boss publish does not refuse when Herdr lists no agent or fails', (t) => {
  const env = projectRepo(t, [run('w1', { taskId: 'A', worktree: os.tmpdir() })]);
  env.agents = { agents: [] };
  assert.equal(publish(env, statusFile(env, 'todo')).status, 0, 'an empty list');
  env.agents = { unexpected: true };
  assert.equal(publish(env, statusFile(env, 'todo')).status, 0, 'a list of another shape');
  delete env.agents;
  assert.equal(publish(env, statusFile(env, 'todo')).status, 0, 'no herdr command');
});

test('an idle or reported live worker is not active and gives no stale mismatch', () => {
  const dir = runsDir({ after() {} }, [run('a', { taskId: 'A' }), run('b', { taskId: 'B' }), run('c', { taskId: 'C', parked: { reason: 'x', at: iso(NOW) } })]);
  const status = { a: 'working', b: 'idle', c: 'working' };
  const facts = readWorkerFacts(dir, { isLive: () => true, agentStatus: (r) => status[r.name], hasReport: () => false });
  assert.deepEqual(Object.fromEntries(facts.map((f) => [f.name, f.active])), { a: true, b: false, c: false });
  const reported = readWorkerFacts(dir, { isLive: () => true, agentStatus: () => 'working', hasReport: (r) => r.name === 'a' });
  assert.equal(reported.find((f) => f.name === 'a').active, false);
  assert.equal(taskMismatches({ tasks: [task('A'), task('B'), task('C')] }, facts, { now: NOW + HOUR }).length, 1);
});

// The merge check.
function mergeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-task-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return { dir, git, base: git('rev-parse', 'main') };
}
const branchRun = (repo, branch, extra = {}) => ({ name: branch, branch, base: 'main', baseCommit: repo.base, startedAt: iso(NOW), ...extra });

test('a collected branch counts as merged only with new commits that are in the base branch', (t) => {
  const repo = mergeRepo(t);
  const isMerged = () => gitIsMerged(repo.dir);
  repo.git('branch', 'empty');
  assert.equal(isMerged()(branchRun(repo, 'empty')), false, 'a branch with zero new commits is not merged');
  assert.equal(isMerged()(branchRun(repo, 'missing')), false, 'a missing branch is not merged');
  assert.equal(isMerged()(branchRun(repo, 'missing', { mergedAt: iso(NOW) })), true, 'the record can say merged');
  assert.equal(isMerged()({ name: 'main', branch: 'main', base: 'main', baseCommit: repo.base }), false, 'the base branch itself is not merged');
  repo.git('checkout', '-q', '-b', 'work');
  repo.git('commit', '-q', '--allow-empty', '-m', 'work');
  repo.git('checkout', '-q', 'main');
  assert.equal(isMerged()(branchRun(repo, 'work')), false, 'unmerged work');
  repo.git('merge', '-q', '--ff-only', 'work');
  assert.equal(isMerged()(branchRun(repo, 'work')), true, 'merged work');
  repo.git('branch', '-q', '-D', 'work');
  assert.equal(isMerged()(branchRun(repo, 'work')), false, 'a deleted branch is not merged without a record or a published done');
});

test('the merge check keeps its answers, stops after a merge, and caps the git checks', (t) => {
  const repo = mergeRepo(t);
  for (const name of ['a', 'b', 'c']) {
    repo.git('checkout', '-q', '-b', name, 'main');
    repo.git('commit', '-q', '--allow-empty', '-m', name);
  }
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--ff-only', 'a');
  const cache = new Map();
  const budget = { left: 2 };
  const check = (now) => gitIsMerged(repo.dir, { cache, budget, now });
  assert.equal(check(NOW)(branchRun(repo, 'a')), true);
  assert.equal(budget.left, 1);
  assert.equal(check(NOW)(branchRun(repo, 'b')), false);
  assert.equal(budget.left, 0);
  // The cap is spent: an unknown record is not checked and counts as not merged.
  assert.equal(check(NOW)(branchRun(repo, 'c')), false);
  assert.equal(cache.has(`${repo.dir}\0c\0${iso(NOW)}`), false);
  // A merged answer stays with no budget. A not-merged answer stays for 60 seconds.
  assert.equal(check(NOW + 120000)(branchRun(repo, 'a')), true);
  repo.git('merge', '-q', '--no-edit', 'b');
  assert.equal(check(NOW + 30000)(branchRun(repo, 'b')), false, 'inside the recheck time');
  budget.left = 5;
  assert.equal(check(NOW + 61000)(branchRun(repo, 'b')), true, 'after the recheck time');
  const before = budget.left;
  assert.equal(check(NOW + 200000)(branchRun(repo, 'b')), true);
  assert.equal(budget.left, before, 'a merged branch is never checked again');
});

test('a finished run older than 14 days is dropped, and a live run is kept', () => {
  const old = iso(NOW - 15 * 86400000);
  const recent = iso(NOW - 13 * 86400000);
  const options = { isLive: () => true, isMerged: () => true, now: NOW };
  assert.equal(workerFactFromRun(run('a', { taskId: 'A', startedAt: old, finishedAt: old, outcome: 'done' }), options), null);
  assert.equal(workerFactFromRun(run('a', { taskId: 'A', startedAt: old, collectedAt: old }), options), null);
  assert.equal(workerFactFromRun(run('a', { taskId: 'A', startedAt: recent, finishedAt: recent, outcome: 'done' }), options).phase, 'merged');
  assert.equal(workerFactFromRun(run('a', { taskId: 'A', startedAt: old }), options).phase, 'live');
  assert.equal(workerFactFromRun(run('a', { taskId: 'A', startedAt: old }), { ...options, isLive: () => false }), null);
});

// Stale rule.
const CFG = { staleStatusMinutes: 120 };
function snapshot({ updated = NOW - 30 * MIN, status = 'todo', workers = [live('w1', 'A')], activity = {} } = {}) {
  return {
    projects: [{ slug: 'alpha', project: 'Alpha', updated: iso(updated), tasks: [task('A', { status })] }],
    control: { projects: { alpha: { slug: 'alpha', workspace: 'w1', effectiveMode: 'auto', running: 1 } } },
    herdr: { workspaces: [{ id: 'w1', label: 'Alpha' }], panes: [{ id: 'w1:p1', workspace: 'w1', orch: true, label: 'orch', agent: 'claude', status: 'idle' }] },
    statusActivity: { alpha: activity },
    taskWorkers: { alpha: workers },
  };
}

test('a live worker on a task that is not doing makes the status stale with one notice', () => {
  const snap = snapshot();
  const stale = staleStatuses(snap, CFG, NOW);
  assert.equal(stale.alpha.mismatch.length, 1);
  assert.match(stale.alpha.reason, /worker w1 runs task A/);
  assert.match(stale.alpha.reason, /todo/);
  const alerts = evaluate(snap, CFG, {}, NOW).alerts.filter((a) => a.key.startsWith('status:stale:'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /worker w1 runs task A/);
  assert.match(alerts[0].text, /herdr-boss publish alpha/);
  // A doing task or a new worker inside the grace time gives no stale status.
  assert.deepEqual(staleStatuses(snapshot({ status: 'doing' }), CFG, NOW), {});
  assert.deepEqual(staleStatuses(snapshot({ workers: [live('w1', 'A', { startedAt: iso(NOW - MIN) })] }), CFG, NOW), {});
  assert.deepEqual(staleStatuses(snapshot({ workers: [live('w1', 'A', { phase: 'review' })] }), CFG, NOW), {});
});

test('an old status with workers or new commits and a worker mismatch send one notice with both reasons', () => {
  const snap = snapshot({ updated: NOW - 3 * HOUR, activity: { workedAt: NOW - 10 * MIN } });
  const stale = staleStatuses(snap, CFG, NOW);
  assert.equal(stale.alpha.workers, true);
  assert.equal(stale.alpha.mismatch.length, 1);
  const alerts = evaluate(snap, CFG, {}, NOW).alerts.filter((a) => a.key.startsWith('status:stale:'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /workers ran/);
  assert.match(alerts[0].text, /worker w1 runs task A/);
});

test('the project data carries boardStale and the reason for the GUI', () => {
  const snap = snapshot();
  const [project] = applyTaskState(snap.projects, snap.taskWorkers, { stale: staleStatuses(snap, CFG, NOW) });
  assert.equal(project.boardStale, true);
  assert.match(project.boardStaleReason, /worker w1 runs task A/);
  assert.equal(project.tasks[0].state, 'doing');
  assert.equal(project.tasks[0].publishedStatus, 'todo');
  const fresh = snapshot({ status: 'doing' });
  const [ok] = applyTaskState(fresh.projects, fresh.taskWorkers, { stale: staleStatuses(fresh, CFG, NOW) });
  assert.equal(ok.boardStale, false);
  assert.equal(ok.boardStaleReason, null);
  const old = snapshot({ status: 'doing', updated: NOW - 3 * HOUR, activity: { landedAt: NOW - HOUR } });
  const [aged] = applyTaskState(old.projects, old.taskWorkers, { stale: staleStatuses(old, CFG, NOW) });
  assert.equal(aged.boardStale, true);
  assert.match(aged.boardStaleReason, /3h 0m old/);
});

test('worker start without a task id or an issue gives one warning text', () => {
  assert.match(taskIdWarning({}), /^Warning: .*--task-id/);
  assert.equal(taskIdWarning({ taskId: 'A' }), null);
  assert.equal(taskIdWarning({ issue: '7' }), null);
});

test('the task id of a run comes from taskId, then from the issue', () => {
  const fact = (record) => workerFactFromRun(record, { isLive: () => true });
  assert.equal(fact(run('a', { taskId: 'B1a', issue: 7 })).taskId, 'B1a');
  assert.equal(fact(run('a', { issue: 7 })).taskId, '7');
});

test('the engine reads worker facts from the run records of a registered project and decorates the projects', async (t) => {
  const { Engine } = await import('../src/engine.js');
  const { loadConfig } = await import('../src/config.js');
  const env = projectRepo(t, [run('live-one', { taskId: 'A', pane: 'w1:p2', startedAt: iso(NOW - HOUR) }), run('gone', { taskId: 'B', pane: 'w1:p9' })]);
  fs.writeFileSync(path.join(DATA, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo: env.repo, remote: '' }]));
  t.after(() => fs.rmSync(path.join(DATA, 'project-repos.json'), { force: true }));
  const engine = new Engine(loadConfig(), { push: false, act: false });
  engine.log = () => {};
  engine.memory = { paneSince: {}, pushes: {}, notified: {} };
  const facts = engine.readTaskWorkers(NOW, { panes: [{ id: 'w1:p2', status: 'working' }] });
  assert.deepEqual(facts.alpha.map((f) => [f.name, f.phase]).sort(), [['gone', 'abandoned'], ['live-one', 'live']]);
  // A second read inside 15 seconds returns the cached facts.
  assert.equal(engine.readTaskWorkers(NOW + 5000, { panes: [] }), facts);
  const projects = [{ slug: 'alpha', project: 'Alpha', updated: iso(NOW - 20 * MIN), tasks: [task('A'), task('B')] }];
  const [decorated] = engine.decorateProjects(projects, NOW);
  assert.equal(decorated.tasks[0].state, 'doing');
  assert.equal(decorated.tasks[0].stateSource, 'live from worker live-one');
  assert.equal(decorated.tasks[1].state, 'ready');
  assert.equal(decorated.boardStale, true);
  assert.match(decorated.boardStaleReason, /worker live-one runs task A/);
});
