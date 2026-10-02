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
  assert.deepEqual(changed, [{ id: 'T1', from: 'doing', to: 'done' }, { id: 'T4', from: 'doing', to: 'review' }]);
  assert.deepEqual(data.tasks.map((task) => task.status), ['done', 'todo', 'blocked', 'review', 'done']);
});

test('syncStatuses changes nothing without a fact and keeps a stuck card as doing', () => {
  const data = { tasks: [{ id: 'T1', title: 'A', status: 'doing', updated: iso(NOW - 4 * 60 * MIN) }, { id: 'T2', title: 'B', status: 'todo' }] };
  const before = structuredClone(data);
  assert.deepEqual(syncStatuses(data, { workers: [], facts: { commits: [], issues: null }, now: NOW }), []);
  assert.deepEqual(data, before);
});

test('syncStatuses reads a closed issue and leaves a status without tasks alone', () => {
  const data = { tasks: [{ id: 'X', title: 'A', status: 'doing', url: 'https://github.com/o/r/issues/9' }] };
  const issues = new Map([[9, { state: 'closed', closedAt: iso(NOW - MIN) }]]);
  assert.deepEqual(syncStatuses(data, { workers: [], facts: { commits: [], issues }, now: NOW }), [{ id: 'X', from: 'doing', to: 'done' }]);
  assert.deepEqual(syncStatuses({ project: 'Demo' }, { workers: [], facts: {}, now: NOW }), []);
});

function publish(t, args, { repo = true } = {}) {
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
    git(root, 'commit', '-m', 'T1: add the parser');
  }
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', tasks: [{ id: 'T1', title: 'Parser', status: 'doing' }, { id: 'T2', title: 'Docs', status: 'todo' }] }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home, HERDR_SOCKET_PATH: path.join(home, 'none.sock') };
  // A folder without a repository must not find one above it through the test runner temp root.
  if (!repo) env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status, ...args], { cwd: root, env, encoding: 'utf8' });
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8'));
  return { result, stored };
}

test('publish --sync installs the computed card states and prints how many cards changed', (t) => {
  const { result, stored } = publish(t, ['--sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^synced 1 card from git and workers$/m);
  assert.match(result.stdout, /^published .*\/projects\/demo$/m);
  assert.deepEqual(stored.tasks.map((task) => task.status), ['done', 'todo']);
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
