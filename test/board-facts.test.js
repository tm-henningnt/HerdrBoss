import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Every repository, file, and fake gh command is in a temporary directory. No real project is read.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-board-facts-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
// The live directory differs from the data directory, so serve() accepts a read-only preview in the route test.
for (const [name, dir] of [['HOME', 'home'], ['HERDR_BOSS_DIR', 'data'], ['HERDR_BOSS_LIVE_DIR', 'live']]) {
  process.env[name] = path.join(ROOT, dir);
  fs.mkdirSync(process.env[name], { recursive: true });
}
await import('./helpers/test-env.js');
const { explicitPattern, validBranch, idPattern, mergedBranchName, readCommits, readIssues, issueNumber, commitIndex, applyBoardFacts, boardCounts, BoardFactsCache, STUCK_MS } = await import('../src/board-facts.js');
const { applyTaskState, overlayTasks } = await import('../src/task-state.js');

const MIN = 60000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: 'todo', ...extra });
const worker = (name, taskId, phase, extra = {}) => ({ name, taskId, phase, branch: name, kind: 'claude', model: 'm', startedAt: iso(Date.now() - 30 * MIN), ...extra });

// A repository with a main branch, merge commits, and commit subjects that name task ids.
function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const commit = (subject, file) => { fs.writeFileSync(path.join(repo, file), subject); git('add', '.'); git('commit', '-q', '-m', subject); };
  git('init', '-q', '-b', 'main');
  commit('Start the project', 'a.txt');
  commit('Add the parser (#68)', 'b.txt');
  commit('Release notes for version 12', 'c.txt');
  for (const branch of ['w222-fix', 'wa1']) {
    git('checkout', '-q', '-b', branch);
    commit(`work on ${branch}`, `${branch}.txt`);
    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '-q', '-m', `Merge branch '${branch}' into main`, branch);
  }
  git('checkout', '-q', '-b', 'qq');
  commit('integration work', 'i.txt');
  git('checkout', '-q', 'main');
  git('merge', '--no-ff', '-q', '-m', "Merge branch 'qq' into integrate-b2", 'qq');
  return { repo, git, commit };
}

function fixedDateFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(ROOT, 'fixed-repo-'));
  const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const gitAt = (date, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    env: { ...baseEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  const commit = (subject, file, date, body = '') => {
    fs.writeFileSync(path.join(repo, file), `${subject}\n${body}`);
    gitAt(date, 'add', '.');
    gitAt(date, 'commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  };
  commit('docs: record G4 build approval and order', 'a.txt', '2026-10-01T10:00:00Z');
  commit('docs: plan G4 machine samples', 'b.txt', '2026-10-01T11:00:00Z');
  commit('G4a: record machine samples', 'c.txt', '2026-10-01T12:00:00Z');
  commit('G4g: swap warning', 'd.txt', '2026-10-01T13:00:00Z');
  return { repo, git, gitAt, commit };
}

test('idPattern matches an id as a whole token and needs a hash for digits', () => {
  assert.ok(idPattern('68').test('Add the parser (#68)'));
  assert.ok(idPattern('12').test('Closes #12'));
  assert.ok(!idPattern('12').test('Release notes for version 12'));
  assert.ok(!idPattern('12').test('Fix #123'));
  assert.ok(idPattern('b68').test('Merge branch sv-b68'));
  assert.ok(idPattern('BD2a').test('bd2a: card state'));
  assert.ok(!idPattern('BD2').test('BD2a: card state'));
  assert.ok(idPattern('W222').test('w222-fix'));
  assert.equal(idPattern(''), null);
});

test('mergedBranchName reads the merged branch, not the target', () => {
  assert.equal(mergedBranchName("Merge branch 'ling1' into integrate-b8"), 'ling1');
  assert.equal(mergedBranchName("Merge remote-tracking branch 'origin/w9'"), 'origin/w9');
  assert.equal(mergedBranchName('Merge pull request #7 from owner/w222-fix'), 'owner/w222-fix');
  assert.equal(mergedBranchName('Add the parser'), null);
});

test('readCommits reads the base branch read-only and returns null without a repository', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  assert.equal(commits[0].subject, "Merge branch 'qq' into integrate-b2");
  assert.equal(commits[0].parents, 2);
  assert.match(commits[0].short, /^[0-9a-f]{7,}$/);
  assert.equal(await readCommits(null), null);
  assert.equal(await readCommits(path.join(ROOT, 'missing')), null);
  assert.equal(await readCommits(repo, { branch: 'no-such-branch' }), null);
});

test('commitIndex finds ids in subjects, merged branch names, and through worker names', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const tasks = [task('68'), task('12'), task('W222'), task('A1'), task('B2'), task('Z9')];
  const index = commitIndex(commits, tasks, [worker('wa1', 'A1', 'merged')]);
  assert.equal(index.get('68').subject, 'Add the parser (#68)');
  assert.equal(index.get('W222').subject, "Merge branch 'w222-fix' into main");
  assert.equal(index.get('A1').via, 'wa1');
  assert.equal(index.has('12'), false, 'digits without a hash do not match');
  assert.equal(index.has('B2'), false, 'the target branch of a merge does not count');
  assert.equal(index.has('Z9'), false);
});

test('a merged commit makes a card done and shows the short commit id', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const tasks = overlayTasks([task('68', { status: 'doing' }), task('W222', { status: 'review' })], []);
  const [a, b] = applyBoardFacts(tasks, [], { commits });
  assert.equal(a.computedState, 'done');
  assert.equal(a.publishedState, 'doing');
  assert.equal(a.state, 'done');
  assert.equal(a.source.kind, 'commit');
  assert.equal(a.source.ref, commits.find((c) => c.subject.includes('(#68)')).short);
  assert.equal(a.diverges, true);
  assert.equal(b.source.kind, 'commit');
  assert.deepEqual(boardCounts([a, b]), { boardDiverged: 2, boardDivergedIds: ['68', 'W222'], boardStuck: 0 });
});

test('a card that agrees with its fact does not diverge', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const [a] = applyBoardFacts(overlayTasks([task('68', { status: 'done' })], []), [], { commits });
  assert.equal(a.computedState, 'done');
  assert.equal(a.diverges, false);
});

test('a live worker that started after the commit reopens the card as doing', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const later = [worker('w68', '68', 'live', { startedAt: iso(Date.now() + 5 * MIN) })];
  const [a] = applyBoardFacts(overlayTasks([task('68', { status: 'doing' })], later), later, { commits }, { now: Date.now() + 10 * MIN });
  assert.equal(a.computedState, 'doing');
  assert.equal(a.source.kind, 'worker');
  assert.equal(a.source.ref, 'w68');
});

test('a collected worker gives review and a collected worker whose branch is merged gives done', () => {
  const workers = [worker('wc3', 'C3', 'review'), worker('wm4', 'D4', 'merged')];
  const [c, d] = applyBoardFacts(overlayTasks([task('C3', { status: 'doing' }), task('D4', { status: 'review' })], workers), workers, {});
  assert.equal(c.computedState, 'review');
  assert.equal(c.source.kind, 'worker');
  assert.equal(c.source.ref, 'wc3');
  assert.equal(c.diverges, true);
  assert.equal(d.computedState, 'done');
  assert.equal(d.source.ref, 'wm4');
});

test('a merged worker keeps a published blocked card blocked, while commit and issue facts still complete it', () => {
  const workers = [worker('wmG4', 'G4', 'merged', { collectedAt: iso(Date.now() - MIN) })];
  const [blocked] = applyBoardFacts(
    overlayTasks([task('G4', { status: 'blocked', waitingOn: 'external' })], workers), workers, {},
  );
  const [doing] = applyBoardFacts(overlayTasks([task('G4', { status: 'doing' })], workers), workers, {});
  assert.equal(blocked.computedState, 'blocked');
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blockedReason, 'waits on the external');
  assert.deepEqual(blocked.source, { kind: 'worker', ref: 'wmG4', at: workers[0].startedAt });
  assert.equal(doing.computedState, 'done');
  assert.deepEqual(doing.source, { kind: 'worker', ref: 'wmG4', at: workers[0].startedAt });

  const commit = { id: 'commit-id', short: 'abc1234', at: iso(Date.now()), parents: 1, subject: 'G4: record task', body: '' };
  const [committed] = applyBoardFacts(overlayTasks([task('G4', { status: 'blocked' })], workers), workers, { commits: [commit] });
  assert.equal(committed.computedState, 'done');
  assert.equal(committed.source.kind, 'commit');

  const issues = new Map([[7, { state: 'closed', closedAt: iso(Date.now()) }]]);
  const issueWorker = worker('wm7', '7', 'merged', { collectedAt: iso(Date.now() - MIN) });
  const [closedIssue] = applyBoardFacts(
    overlayTasks([task('7', { status: 'blocked', waitingOn: 'external', url: 'https://github.com/example/demo/issues/7' })], [issueWorker]), [issueWorker], { issues },
  );
  assert.equal(closedIssue.computedState, 'done');
  assert.equal(closedIssue.source.kind, 'issue');
});

test('a doing card with no live worker and no commit for three hours is stuck', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const old = task('S1', { status: 'doing', updated: iso(now - STUCK_MS - 30 * MIN) });
  const fresh = task('S2', { status: 'doing', updated: iso(now - 2 * HOUR) });
  const withWorker = task('S3', { status: 'doing', updated: iso(now - 5 * HOUR) });
  const workers = [worker('ws3', 'S3', 'live', { startedAt: iso(now - 5 * HOUR) })];
  const result = applyBoardFacts(overlayTasks([old, fresh, withWorker], workers), workers, {}, { now });
  assert.equal(result[0].computedState, 'stuck');
  assert.equal(result[0].state, 'doing', 'the board column stays doing');
  assert.equal(result[0].stuck.ageMin, 210);
  assert.equal(result[0].stuck.reason, 'no live worker and no commit for 3 hours');
  assert.equal(result[0].diverges, false, 'a stuck card is not a divergence');
  assert.equal(result[1].computedState, 'doing');
  assert.equal(result[2].computedState, 'doing', 'a live worker prevents stuck');
  assert.equal(boardCounts(result).boardStuck, 1);
});

test('a stuck card uses the publish time when it has no other time', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const [a] = applyBoardFacts(overlayTasks([task('S1', { status: 'doing' })], []), [], {}, { now, publishedAt: iso(now - 4 * HOUR) });
  assert.equal(a.computedState, 'stuck');
  assert.equal(a.stuck.ageMin, 240);
});

test('without a repository the cards keep the published state', () => {
  const tasks = overlayTasks([task('A', { status: 'doing', updated: iso(Date.now()) }), task('B'), task('C', { status: 'done' })], []);
  const result = applyBoardFacts(tasks, [], { commits: null, issues: null });
  assert.deepEqual(result.map((t) => [t.computedState, t.publishedState, t.source, t.diverges]), [['doing', 'doing', null, false], ['todo', 'todo', null, false], ['done', 'done', null, false]]);
});

test('a closed issue gives done and an open issue on a done card reopens it', () => {
  const issues = new Map([[5, { state: 'closed', closedAt: '2026-10-01T10:00:00Z' }], [6, { state: 'open', closedAt: null }]]);
  const tasks = overlayTasks([task('5', { status: 'doing' }), task('X', { status: 'doing', url: 'https://github.com/o/r/issues/5' }), task('6', { status: 'done' })], []);
  const [a, b, c] = applyBoardFacts(tasks, [], { issues });
  assert.deepEqual([a.computedState, a.source], ['done', { kind: 'issue', ref: '5', at: '2026-10-01T10:00:00Z' }]);
  assert.equal(b.computedState, 'done');
  assert.deepEqual([c.computedState, c.source.kind, c.diverges], ['todo', 'issue', true]);
  assert.equal(issueNumber({ id: 'ab' }), null);
});

// A fake gh executable on PATH. It logs its arguments and prints a fixed issue list.
function fakeGh(issues) {
  const bin = fs.mkdtempSync(path.join(ROOT, 'bin-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'JSON'\n${JSON.stringify(issues)}\nJSON\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('readIssues runs one read-only gh issue list with an explicit repository', async () => {
  const { repo, git } = fixtureRepo();
  git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
  const gh = fakeGh([{ number: 5, state: 'CLOSED', closedAt: '2026-10-01T10:00:00Z' }, { number: 6, state: 'OPEN', closedAt: null }]);
  const saved = process.env.PATH;
  process.env.PATH = `${gh.bin}${path.delimiter}${saved}`;
  try {
    const issues = await readIssues(repo);
    assert.equal(issues.get(5).state, 'closed');
    assert.equal(issues.get(6).state, 'open');
    assert.deepEqual(gh.calls(), ['issue list --repo=example/demo --state all --limit 500 --json number,state,closedAt']);
  } finally { process.env.PATH = saved; }
});

test('readIssues gives null without a github origin', async () => {
  const { repo } = fixtureRepo();
  assert.equal(await readIssues(repo), null);
  assert.equal(await readIssues(null), null);
});

test('the cache reads git once a minute and the issue tracker once every ten minutes', async () => {
  const { repo, git } = fixtureRepo();
  git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
  let gitRuns = 0;
  let ghRuns = 0;
  const cache = new BoardFactsCache({
    git: async (...args) => { gitRuns += 1; return (await promisify(execFile)('git', ['-C', args[0], ...args[1]], { encoding: 'utf8' })).stdout; },
    issueRun: async () => { ghRuns += 1; return JSON.stringify([{ number: 5, state: 'CLOSED', closedAt: null }]); },
  });
  const t0 = 1_000_000;
  cache.refresh('alpha', repo, { now: t0 });
  assert.equal(cache.get('alpha').commits, null, 'refresh does not wait for git');
  await cache.idle();
  cache.refresh('alpha', repo, { now: t0 + 30_000 });
  assert.equal(gitRuns, 1);
  assert.equal(ghRuns, 1);
  cache.refresh('alpha', repo, { now: t0 + 61_000 });
  await cache.idle();
  assert.equal(gitRuns, 2);
  assert.equal(ghRuns, 1);
  cache.refresh('alpha', repo, { now: t0 + 601_000 });
  await cache.idle();
  assert.equal(ghRuns, 2);
  assert.equal(cache.get('alpha').issues.get(5).state, 'closed');
  assert.ok(cache.get('alpha').commits.length > 0);
  cache.refresh('beta', null, { now: t0 });
  assert.deepEqual(cache.get('beta'), { commits: null, issues: null });
});

test('applyTaskState adds the computed fields and the divergence counts to the project', async () => {
  const { repo } = fixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const now = Date.now();
  const projects = [{ slug: 'alpha', project: 'Alpha', updated: iso(now), tasks: [task('68', { status: 'doing' }), task('Q', { status: 'todo' })] }];
  const [out] = applyTaskState(projects, {}, { boardFacts: { alpha: { commits, issues: null } }, now });
  assert.equal(out.boardDiverged, 1);
  assert.deepEqual(out.boardDivergedIds, ['68']);
  assert.equal(out.boardStuck, 0);
  assert.equal(out.tasks[0].state, 'done');
  assert.equal(out.sync.doingCards, 0);
  assert.equal(out.tasks[1].computedState, 'todo');
  const [bare] = applyTaskState(projects, {}, { now });
  assert.equal(bare.boardDiverged, 0);
  assert.equal(bare.tasks[0].state, 'doing');
});

test('GET /api/projects/<slug> returns computedState, publishedState, and source for each card', async (t) => {
  const { repo, git } = fixtureRepo();
  void git;
  fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'project-repos.json'), JSON.stringify([{ slug: 'alpha', repo, remote: '' }]));
  const [{ serve }, { loadConfig }, { Engine }, { writeProject }] = await Promise.all([
    import('../src/server.js'), import('../src/config.js'), import('../src/engine.js'), import('../src/projects.js'),
  ]);
  assert.deepEqual(writeProject('alpha', { project: 'Alpha', tasks: [task('68', { status: 'doing' }), task('Q')] }), []);
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const engine = new Engine(cfg, { push: false, act: false });
  engine.log = () => {};
  engine.tick = async () => engine.state;
  engine.memory = { paneSince: {}, pushes: {}, notified: {} };
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  t.after(() => close());
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // The reads run in the background. Wait for them, then let the engine take a new snapshot.
  engine.readBoardFacts(Date.now());
  await engine.boardFactsCache.idle();
  engine.boardFactsAt = 0;
  const one = await (await fetch(`${base}/api/projects/alpha`)).json();
  assert.deepEqual(one.tasks.map((c) => [c.id, c.computedState, c.publishedState]), [['68', 'done', 'doing'], ['Q', 'todo', 'todo']]);
  assert.equal(one.tasks[0].source.kind, 'commit');
  assert.equal(one.tasks[1].source, null);
  assert.equal(one.boardDiverged, 1);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.find((p) => p.slug === 'alpha').boardDiverged, 1);
  assert.equal((await fetch(`${base}/api/projects/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/projects/%E0%A4%A`)).status, 400);
  assert.equal((await (await fetch(`${base}/api/projects/%61lpha`)).json()).slug, 'alpha');
});

test('explicitPattern accepts the explicit forms and rejects a bare id', () => {
  const yes = (id, text) => assert.ok(explicitPattern(id).test(text), `${id} in "${text}"`);
  const no = (id, text) => assert.ok(!explicitPattern(id).test(text), `${id} in "${text}"`);
  yes('68', 'Add the parser (#68)');
  yes('12', 'Closes #12');
  yes('12', 'fixes #12: retry');
  yes('12', 'Resolved #12');
  yes('BD2a', 'BD2a: computed card state');
  yes('G4', 'G4: card state');
  yes('b68', 'Add cache (b68)');
  yes('B68', 'closes b68');
  no('12', 'refs #12');
  no('12', 'WIP for #12');
  no('12', 'see (12)');
  no('12', 'Closes #123');
  no('BD2a', 'work on BD2a later');
  no('G4', 'docs: record (G4) in a plan');
  no('G4', 'G4a: record machine samples');
  no('G4h', 'G4: machine samples');
  no('G4', 'test: record G4 machine samples');
  no('G4', 'chore: record G4 machine samples');
  no('G4', 'Record G4 machine samples');
});

test('G4 plan and child-task commits do not close G4, while exact child prefixes do', async () => {
  const { repo } = fixedDateFixtureRepo();
  const commits = await readCommits(repo, { branch: 'main' });
  const index = commitIndex(commits, [task('G4'), task('G4a'), task('G4g'), task('G4h')]);
  assert.equal(index.has('G4'), false);
  assert.equal(index.has('G4h'), false);
  assert.equal(index.get('G4a').subject, 'G4a: record machine samples');
  assert.equal(index.get('G4g').subject, 'G4g: swap warning');
  for (const subject of ['docs: record G4 build approval and order', 'docs: plan G4 machine samples']) {
    assert.equal(explicitPattern('G4').test(subject), false);
    assert.equal(explicitPattern('G4a').test(subject), false);
    assert.equal(explicitPattern('G4g').test(subject), false);
  }
});

test('Closes G4 and a merge of branch g4 mark G4 done', async () => {
  const closed = fixedDateFixtureRepo();
  closed.commit('Closes G4', 'close.txt', '2026-10-02T10:00:00Z');
  const closedIndex = commitIndex(await readCommits(closed.repo, { branch: 'main' }), [task('G4')]);
  assert.equal(closedIndex.get('G4').subject, 'Closes G4');

  const merged = fixedDateFixtureRepo();
  merged.git('checkout', '-q', '-b', 'g4');
  merged.commit('record samples', 'branch.txt', '2026-10-02T10:00:00Z');
  merged.git('checkout', '-q', 'main');
  merged.gitAt('2026-10-02T11:00:00Z', 'merge', '--no-ff', '-q', '-m', "Merge branch 'g4' into main", 'g4');
  const mergedIndex = commitIndex(await readCommits(merged.repo, { branch: 'main' }), [task('G4')]);
  assert.equal(mergedIndex.get('G4').subject, "Merge branch 'g4' into main");
});

test('a commit that only refs or works toward an id does not make the card done', async () => {
  const { repo, commit } = fixtureRepo();
  commit('refs #12', 'r1.txt');
  commit('WIP for #13', 'r2.txt');
  commit('Closes #14', 'r3.txt');
  const commits = await readCommits(repo, { branch: 'main' });
  const index = commitIndex(commits, [task('12'), task('13'), task('14')]);
  assert.equal(index.has('12'), false);
  assert.equal(index.has('13'), false);
  assert.equal(index.get('14').subject, 'Closes #14');
  const [a] = applyBoardFacts(overlayTasks([task('12', { status: 'doing' })], []), [], { commits });
  assert.equal(a.computedState, 'doing');
  assert.equal(a.source, null);
});

test('a closing keyword in a commit body names the task', async () => {
  const { repo, commit } = fixedDateFixtureRepo();
  commit('docs: record machine sampling', 'body.txt', '2026-10-02T10:00:00Z', 'Closes G4');
  const commits = await readCommits(repo, { branch: 'main' });
  const index = commitIndex(commits, [task('G4')]);
  assert.match(commits[0].body, /Closes G4/);
  assert.equal(index.get('G4').subject, 'docs: record machine sampling');
});

test('a branch value that starts with a dash never reaches git', async () => {
  const { repo } = fixtureRepo();
  assert.equal(validBranch('--output=/tmp/x'), false);
  assert.equal(validBranch('-n1'), false);
  assert.equal(validBranch('release/1.0'), true);
  let calls = 0;
  const git = async () => { calls += 1; return ''; };
  assert.equal(await readCommits(repo, { branch: '--output=/tmp/x', git }), null);
  assert.equal(calls, 0);
  const seen = [];
  await readCommits(repo, { branch: 'main', git: async (_repo, args) => { seen.push(args); return ''; } });
  const args = seen[0];
  assert.ok(args.indexOf('--end-of-options') < args.indexOf('main'), 'the branch follows --end-of-options');
  assert.equal(args.at(-1), '--');
});

test('a git read that exceeds its timeout gives no commits and does not hang', async () => {
  const { repo } = fixtureRepo();
  const bin = fs.mkdtempSync(path.join(ROOT, 'slowbin-'));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  const started = Date.now();
  try { assert.equal(await readCommits(repo, { branch: 'main', timeout: 200 }), null); } finally { process.env.PATH = saved; }
  assert.ok(Date.now() - started < 4000, 'the read ended at the timeout');
});

test('a worker that was collected for a card published as done keeps the card done without a divergence', () => {
  const workers = [worker('wc9', 'C9', 'review')];
  const [a] = applyBoardFacts(overlayTasks([task('C9', { status: 'done' })], workers), workers, {});
  assert.equal(a.computedState, 'done');
  assert.equal(a.publishedState, 'done');
  assert.equal(a.diverges, false);
  assert.equal(a.source, null);
});
