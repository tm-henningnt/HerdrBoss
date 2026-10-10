import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncStatuses } from '../src/board-sync.js';
import { git, temporaryRepo } from './helpers/kit-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MIN = 60000;
const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const commit = (subject, at = NOW - 3 * 60 * MIN) => ({ id: `${subject}-id`.padEnd(40, '0'), short: 'abc1234', at: iso(at), parents: 1, subject });
const worker = (name, taskId, phase, extra = {}) => ({ name, taskId, phase, branch: name, kind: 'claude', model: 'm', startedAt: iso(NOW - 30 * MIN), ...extra });

test('sync keeps a GitHub issue open despite a later Closes trailer', () => {
  const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }] };
  const lines = [];
  const facts = {
    githubRepo: 'example/demo',
    commits: [{ ...commit('Sample change', NOW - MIN), authoredAt: iso(NOW - MIN), body: 'Closes #9' }],
    issues: new Map([[9, { state: 'open', stateReason: null, createdAt: iso(NOW - 60 * MIN) }]]),
  };
  assert.deepEqual(syncStatuses(data, { facts, now: NOW, log: (line) => lines.push(line) }), []);
  assert.equal(data.tasks[0].status, 'doing');
  assert.deepEqual(lines, ['sync: 9 kept open: GitHub open (abc1234)']);
});

test('GitHub completion cites only explicit commits authored after issue creation', () => {
  const createdAt = iso(NOW - 60 * MIN);
  const issue = { state: 'closed', stateReason: 'completed', createdAt, closedAt: iso(NOW) };
  const cases = [
    { subject: 'Sample change', body: 'Closes #9', evidence: true },
    { subject: 'Fixes #9', evidence: true },
    { subject: 'Sample change', body: 'Resolves example/demo#9', evidence: true },
    { subject: 'Sample change', body: 'Closes https://github.com/example/demo/issues/9', evidence: true },
    { subject: 'Sample change', body: 'Task: 9', evidence: true },
    { subject: 'Sample change (#9)', evidence: false },
    { subject: "Merge branch 'sample9' into main", parents: 2, authoredAt: iso(NOW - 120 * MIN), evidence: false },
    { subject: 'Merge pull request #9 from example/sample9', parents: 2, evidence: false },
    { subject: 'Merge changes: Closes #9', parents: 2, evidence: false },
    { subject: "Merge branch 'sample'", parents: 2, body: 'Closes #9', evidence: true },
    { subject: 'Sample change', body: 'Closes #9', authoredAt: createdAt, evidence: false },
    { subject: 'Sample change', body: 'Closes #9', authoredAt: iso(NOW - 120 * MIN), evidence: false },
    { subject: 'Sample change', body: 'Fixes example/other#9', evidence: false },
    { subject: 'Sample change', body: 'Closes #90', evidence: false },
    { subject: 'Sample change', body: 'Closes #9suffix', evidence: false },
    { subject: 'Sample change', body: 'Closes #9', authoredAt: undefined, evidence: false },
    { subject: 'Release version 9', evidence: false },
  ];
  for (const sample of cases) {
    const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }] };
    const facts = {
      githubRepo: 'example/demo', issues: new Map([[9, issue]]),
      commits: [{ ...commit(sample.subject, NOW - MIN), authoredAt: iso(NOW - MIN), ...sample }],
    };
    const changed = syncStatuses(data, { facts, workers: [worker('sample9', '9', 'merged')], now: NOW });
    assert.equal(data.tasks[0].status, 'done', sample.subject);
    assert.equal(Boolean(changed[0].commit), sample.evidence, `${sample.subject}\n${sample.body || ''}`);
  }
});

test('sync never completes a partly done card from issues, commits, or workers', () => {
  for (const github of [true, false]) {
    const data = { tasks: [{ id: github ? '9' : 'T1', title: 'Sample change', status: 'doing', partlyDone: true }] };
    const workers = [worker('sample', data.tasks[0].id, 'merged')];
    const facts = github ? {
      githubRepo: 'example/demo',
      commits: [{ ...commit('Closes #9', NOW - MIN), authoredAt: iso(NOW - MIN) }],
      issues: new Map([[9, { state: 'closed', stateReason: 'completed', createdAt: iso(NOW - 60 * MIN) }]]),
    } : { commits: [commit('T1: sample change')], issues: null };
    assert.deepEqual(syncStatuses(data, { workers, facts, now: NOW }), []);
    assert.equal(data.tasks[0].status, 'doing');
  }
});

test('publish validates the partlyDone boolean and preserves valid marks', (t) => {
  for (const partlyDone of [true, false]) {
    const { result, stored } = publish(t, [], { partlyDone });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stored.tasks[0].partlyDone, partlyDone);
  }
  for (const partlyDone of ['true', 1, null]) {
    const { result, stored } = publish(t, [], { partlyDone });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tasks\[0\]\.partlyDone must be true or false/);
    assert.equal(stored, null);
  }
});

test('sync reads GitHub completion metadata with a fake reader and git author time from the default branch', async (t) => {
  const root = temporaryRepo('herdr-sync-github-reader-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/demo.git');
  git(root, 'checkout', '-b', 'release');
  const authoredAt = iso(NOW - MIN);
  const env = { ...process.env, GIT_AUTHOR_DATE: authoredAt, GIT_COMMITTER_DATE: iso(NOW) };
  const result = spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'Sample change', '-m', 'Closes #9'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const releaseHead = git(root, 'rev-parse', '--short', 'HEAD');
  git(root, 'checkout', '-b', 'sample10');
  git(root, 'commit', '--allow-empty', '-m', 'Closes #10');
  const calls = [];
  const github = async (args) => {
    calls.push(args);
    if (args.at(-1) === 'repos/example/demo') return JSON.stringify({ default_branch: 'release' });
    assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/example/demo/issues?state=all&per_page=100']);
    return JSON.stringify([
      [{ number: 9, state: 'closed', state_reason: 'completed', created_at: iso(NOW - 60 * MIN), closed_at: iso(NOW) }],
      [{ number: 10, state: 'closed', state_reason: 'completed', created_at: iso(NOW - MIN), closed_at: iso(NOW) }],
    ]);
  };
  const { readSyncFacts } = await import('../src/board-sync.js');
  const facts = await readSyncFacts(root, { github, branch: 'main' });
  assert.equal(calls.length, 2);
  assert.equal(facts.githubRepo, 'example/demo');
  assert.equal(Date.parse(facts.commits[0].authoredAt), Date.parse(authoredAt));
  assert.equal(facts.commits[0].subject, 'Sample change');
  assert.equal(facts.issues.get(10).state, 'closed');
  const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }, { id: '10', title: 'Unmerged change', status: 'doing' }] };
  const changed = syncStatuses(data, { facts, now: NOW });
  assert.equal(data.tasks[0].status, 'done');
  assert.equal(changed[0].commit.short, releaseHead);
  assert.equal(changed[1].commit, undefined, 'a commit outside the default branch is not completion evidence');
});

test('a failed or malformed fake GitHub read keeps the published card and prints why', async (t) => {
  const root = temporaryRepo('herdr-sync-github-failure-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/demo.git');
  git(root, 'commit', '--allow-empty', '-m', 'Closes #9');
  const { readSyncFacts } = await import('../src/board-sync.js');
  for (const failureAt of ['repo', 'issues', 'malformed']) {
    const github = async (args) => {
      if (failureAt === 'repo') throw new Error('Fake reader unavailable');
      if (args.at(-1) === 'repos/example/demo') return JSON.stringify({ default_branch: 'main' });
      if (failureAt === 'issues') throw new Error('Fake reader unavailable');
      return JSON.stringify({ unexpected: true });
    };
    const facts = await readSyncFacts(root, { github });
    const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }] };
    const lines = [];
    assert.deepEqual(syncStatuses(data, { facts, workers: [worker('sample9', '9', 'merged')], now: NOW, log: (line) => lines.push(line) }), []);
    assert.equal(data.tasks[0].status, 'doing');
    assert.match(lines[0], failureAt === 'repo' ? /GitHub default branch unavailable/ : /GitHub issues unavailable/);
  }
});

test('sync ignores old merge mentions and branch digits while GitHub is open', () => {
  for (const subject of ["Merge branch 'sample9' into main", 'Merge pull request #9 from example/sample9', 'Release version 9']) {
    const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }] };
    const lines = [];
    const facts = {
      githubRepo: 'example/demo',
      commits: [{ ...commit(subject, NOW - 120 * MIN), parents: 2, authoredAt: iso(NOW - 120 * MIN) }],
      issues: new Map([[9, { state: 'open', createdAt: iso(NOW - 60 * MIN) }]]),
    };
    assert.deepEqual(syncStatuses(data, { facts, workers: [worker('sample9', '9', 'merged')], now: NOW, log: (line) => lines.push(line) }), []);
    assert.equal(data.tasks[0].status, 'doing');
    assert.deepEqual(lines, ['sync: 9 kept open: GitHub open (abc1234)']);
  }
});

test('sync keeps cards unchanged without readable GitHub completion or with another repository issue', () => {
  for (const issues of [null, new Map(), new Map([[9, { state: 'closed', stateReason: 'not_planned' }]]), new Map([[9, { state: 'closed' }]])]) {
    const data = { tasks: [{ id: '9', title: 'Sample change', status: 'doing' }] };
    const before = structuredClone(data);
    const lines = [];
    assert.deepEqual(syncStatuses(data, {
      workers: [worker('sample9', '9', 'merged')],
      facts: { githubRepo: 'example/demo', commits: [commit('Closes #9')], issues },
      log: (line) => lines.push(line), now: NOW,
    }), []);
    assert.deepEqual(data, before);
    assert.match(lines[0], issues?.get(9)?.stateReason === 'not_planned' ? /kept open: GitHub issue is not completed/ : /kept unchanged: GitHub/);
  }
  const data = { tasks: [{ id: '9', title: 'Foreign change', status: 'doing', url: 'https://github.com/example/other/issues/9' }] };
  assert.deepEqual(syncStatuses(data, { facts: { githubRepo: 'example/demo', commits: [commit('Closes #9')], issues: new Map([[9, { state: 'closed', stateReason: 'completed' }]]) }, now: NOW }), []);
  assert.equal(data.tasks[0].status, 'doing');
});

test('sync corrects a done card when GitHub is reopened or closed without completion', () => {
  for (const state of ['open', 'closed']) {
    for (const live of [false, true]) {
      const data = { tasks: [{ id: '9', title: 'Sample change', status: 'done' }] };
      const workers = live ? [worker('sample9', '9', 'live')] : [];
      const facts = { githubRepo: 'example/demo', issues: new Map([[9, { state, stateReason: state === 'closed' ? 'not_planned' : null }]]) };
      syncStatuses(data, { workers, facts, now: NOW });
      assert.equal(data.tasks[0].status, live ? 'doing' : 'todo');
    }
  }
});

test('publish --sync uses GitHub state and prints the ignored commit', (t) => {
  const { result, stored } = publish(t, ['--sync'], {
    commitSubject: 'Sample change', commitBody: 'Closes #9',
    tasks: [{ id: '9', title: 'Sample change', status: 'doing' }],
    githubRows: [{ number: 9, state: 'open', state_reason: null, created_at: iso(Date.now() - 60 * MIN), closed_at: null }],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stored.tasks[0].status, 'doing');
  assert.match(result.stderr, /^sync: 9 kept open: GitHub open \([0-9a-f]{7,}\)$/m);
  assert.match(result.stdout, /^synced 0 cards from git and workers$/m);
});

test('syncStatuses rewrites a card state that differs from the computed state and counts the changes', () => {
  const data = {
    project: 'Demo',
    tasks: [
      { id: 'T1', title: 'Parser', status: 'doing' },
      { id: 'T2', title: 'Docs', status: 'todo' },
      { id: 'T3', title: 'Waits', status: 'blocked', waitingOn: 'owner' },
      { id: 'T4', title: 'Review me', status: 'doing' },
      { id: 'T5', title: 'Already done', status: 'done' },
    ],
  };
  const workers = [worker('w4', 'T4', 'review', { collectedAt: iso(NOW - 20 * MIN) })];
  const changed = syncStatuses(data, { workers, facts: { commits: [commit('T1: add the parser')], issues: null }, now: NOW });
  assert.deepEqual(changed, [
    { id: 'T1', from: 'doing', to: 'done', commit: { short: 'abc1234', subject: 'T1: add the parser' } },
    { id: 'T4', from: 'doing', to: 'review' },
  ]);
  assert.deepEqual(data.tasks.map((task) => task.status), ['done', 'todo', 'blocked', 'review', 'done']);
});

test('syncStatuses changes nothing without a fact and keeps a stuck card as doing', () => {
  const data = { tasks: [{ id: 'T1', title: 'A', status: 'doing', updated: iso(NOW - 4 * 60 * MIN) }, { id: 'T2', title: 'B', status: 'todo' }] };
  const before = structuredClone(data);
  assert.deepEqual(syncStatuses(data, { workers: [], facts: { commits: [], issues: null }, now: NOW }), []);
  assert.deepEqual(data, before);
});

test('syncStatuses leaves a blocked card unchanged when only its worker branch was merged', () => {
  const data = { tasks: [{ id: 'G4', title: 'Samples', status: 'blocked', waitingOn: 'external' }] };
  const before = structuredClone(data);
  const mergedWorker = worker('g4d', 'G4', 'merged', { branch: 'g4d', collectedAt: iso(NOW - MIN) });
  const merge = { ...commit("Merge branch 'g4d' into main"), parents: 2 };

  assert.deepEqual(syncStatuses(data, { workers: [mergedWorker], facts: { commits: [merge], issues: null }, now: NOW }), []);
  assert.deepEqual(data, before);
});

test('syncStatuses reads a closed issue and leaves a status without tasks alone', () => {
  const data = { tasks: [{ id: 'X', title: 'A', status: 'doing', url: 'https://github.com/example/demo/issues/9' }] };
  const issues = new Map([[9, { state: 'closed', stateReason: 'completed', createdAt: iso(NOW - 60 * MIN), closedAt: iso(NOW - MIN) }]]);
  assert.deepEqual(syncStatuses(data, { workers: [], facts: { githubRepo: 'example/demo', commits: [], issues }, now: NOW }), [{ id: 'X', from: 'doing', to: 'done' }]);
  assert.deepEqual(syncStatuses({ project: 'Demo' }, { workers: [], facts: {}, now: NOW }), []);
});

function publish(t, args, { repo = true, commitSubject = 'T1: add the parser', commitBody, partlyDone, tasks, githubRows } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-sync-')));
  const root = repo
    ? temporaryRepo('herdr-publish-sync-repo-')
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-sync-plain-')));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (repo) {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-m', commitSubject, ...(commitBody ? ['-m', commitBody] : []));
  }
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', tasks: tasks || [{ id: 'T1', title: 'Parser', status: 'doing', ...(partlyDone !== undefined ? { partlyDone } : {}) }, { id: 'T2', title: 'Docs', status: 'todo' }] }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home, HERDR_SOCKET_PATH: path.join(home, 'none.sock') };
  if (githubRows !== undefined) {
    git(root, 'remote', 'add', 'origin', 'https://github.com/example/demo.git');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'api') process.exit(1);\nconsole.log(JSON.stringify(args.at(-1) === 'repos/example/demo' ? { default_branch: 'main' } : ${JSON.stringify([githubRows])}));\n`, { mode: 0o700 });
    env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  }
  // A folder without a repository must not find one above it through the test runner temp root.
  if (!repo) env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status, ...args], { cwd: root, env, encoding: 'utf8' });
  const installed = path.join(dataDir, 'projects', 'demo.json');
  const stored = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, 'utf8')) : null;
  return { result, stored };
}

test('publish --sync installs the computed card states and prints how many cards changed', (t) => {
  const { result, stored } = publish(t, ['--sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^synced 1 card from git and workers$/m);
  assert.match(result.stderr, /^sync: T1 doing -> done \([0-9a-f]{7,}: T1: add the parser\)$/m);
  assert.match(result.stdout, /^published .*\/projects\/demo$/m);
  assert.deepEqual(stored.tasks.map((task) => task.status), ['done', 'todo']);
});

test('publish --sync keeps a blocked card when only its collected worker branch was merged', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-blocked-home-')));
  const root = temporaryRepo('herdr-publish-blocked-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'g4d');
  fs.writeFileSync(path.join(root, 'samples.txt'), 'sample\n');
  git(root, 'add', 'samples.txt');
  git(root, 'commit', '-m', 'Record samples');
  git(root, 'checkout', 'main');
  git(root, 'merge', '--no-ff', '-m', "Merge branch 'g4d' into main", 'g4d');

  const runs = path.join(root, '.orchestration', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'g4d.json'), JSON.stringify({
    name: 'g4d', taskId: 'G4', branch: 'g4d', base: 'main', baseCommit,
    startedAt: iso(Date.now() - MIN), collectedAt: iso(Date.now()),
  }));
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', tasks: [{ id: 'G4', title: 'Samples', status: 'blocked', waitingOn: 'external' }] }));
  const dataDir = path.join(home, 'boss');
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status, '--sync'], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      HERDR_BOSS_DIR: dataDir, HERDR_SOCKET_PATH: path.join(home, 'none.sock'), TMPDIR: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^synced 0 cards from git and workers$/m);
  assert.doesNotMatch(result.stderr, /^sync:/m);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8'));
  assert.equal(stored.tasks[0].status, 'blocked');
});

test('publish --sync truncates the matching commit subject to 60 characters', (t) => {
  const subject = `T1: ${'a'.repeat(80)}`;
  const { result } = publish(t, ['--sync'], { commitSubject: subject });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stderr.split('\n').find((item) => item.startsWith('sync: T1 '));
  const match = /^sync: T1 doing -> done \([0-9a-f]{7,}: (.*)\)$/.exec(line);
  assert.ok(match, line);
  assert.equal(match[1], subject.slice(0, 60));
});

test('publish without --sync keeps the card states of the file', (t) => {
  const { result, stored } = publish(t, []);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /synced/);
  assert.deepEqual(stored.tasks.map((task) => task.status), ['doing', 'todo']);
});

test('publish --sync leaves every card unchanged and warns when git and worker facts are unreadable', (t) => {
  const { result, stored } = publish(t, ['--sync'], { repo: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^warning: --sync needs a Git repository and a status with tasks\. No card changed\.$/m);
  assert.doesNotMatch(result.stdout, /^synced/m, 'an unreadable fact is not reported as a sync');
  assert.deepEqual(stored.tasks.map((task) => task.status), ['doing', 'todo'], 'a card without a readable fact keeps its status');
});

test('the publish usage line names --sync', () => {
  const source = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(source, /publish <slug> <file> \[--force\] \[--sync\]/);
});
