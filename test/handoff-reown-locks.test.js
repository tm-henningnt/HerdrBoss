import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activationFixture } from './helpers/handoff-fixture.js';
import { loadProjectConfig } from '../src/kit/config.js';
import { acquireProjectLock, releaseProjectLock, withMutationLock } from '../src/kit/locks.js';

// The fixture gives every pane a temporary data dir. This gives the fixture project a Git root and the project
// slug alpha, so the handoff finds the locks of its own project.
function projectWithGitRoot(f) {
  const project = path.join(f.root, 'project');
  execFileSync('git', ['init', '-b', 'main', project], { stdio: 'ignore' });
  fs.writeFileSync(path.join(project, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha' }));
  return loadProjectConfig({ cwd: project });
}

// Herdr answers for any pane in the workspace. The shell PID is this test process, so the lock stays live.
function fakeHerdr(paneId) {
  return (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: process.pid } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1' }, { pane_id: 'ws:p2' }, { pane_id: 'ws:p3' }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
}

function acquire(config, dataDir, name, pane) {
  const options = {
    config,
    dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: pane },
    herdr: fakeHerdr(pane),
    output: () => {},
    pidAlive: (pid) => pid === process.pid,
  };
  const record = acquireProjectLock(name, options);
  return { record, options };
}

// The lock file of a repository lock sits in a folder named after the Git common directory of the project.
function lockFiles(dataDir) {
  const root = path.join(dataDir, 'locks');
  const files = [];
  for (const entry of fs.readdirSync(root)) {
    const directory = path.join(root, entry);
    if (!fs.statSync(directory).isDirectory() || entry === 'machine') continue;
    for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) files.push(path.join(directory, name));
  }
  return files;
}

const owners = (dataDir) => Object.fromEntries(lockFiles(dataDir).map((file) => [path.basename(file), JSON.parse(fs.readFileSync(file, 'utf8')).ownerPane]));

test('lock acquisition recreates a parent removed just before the mutation claim', (t) => {
  const f = activationFixture(t);
  const config = projectWithGitRoot(f);
  const mkdir = fs.mkdirSync;
  let removed = false;
  let claims = 0;
  t.mock.method(fs, 'mkdirSync', (directory, options) => {
    if (path.basename(directory).startsWith('.mutation.staging-')) {
      claims++;
      if (!removed) {
        fs.rmdirSync(path.dirname(directory));
        removed = true;
      }
    }
    return mkdir(directory, options);
  });
  const source = acquire(config, f.root, 'deploy', 'ws:p1');
  assert.equal(removed, true, 'simulate handover rmdir after lockContext creates the directory');
  assert.equal(claims, 2, 'retry the claim once');
  assert.deepEqual(owners(f.root), { 'deploy.json': 'ws:p1' });
  releaseProjectLock('deploy', { ...source.options, expectedRecord: source.record });
});

test('mutation claims retry a missing parent only once', (t) => {
  const f = activationFixture(t);
  const directory = path.join(f.root, 'locks', 'removed');
  fs.mkdirSync(directory, { recursive: true });
  const mkdir = fs.mkdirSync;
  let claims = 0;
  t.mock.method(fs, 'mkdirSync', (file, options) => {
    if (path.basename(file).startsWith('.mutation.staging-')) {
      claims++;
      fs.rmdirSync(path.dirname(file));
    }
    return mkdir(file, options);
  });
  assert.throws(() => withMutationLock(directory, () => assert.fail('the claim never succeeds')), { code: 'ENOENT' });
  assert.equal(claims, 2);
});

test('activation removes empty lock directories it touched and keeps the locks root', (t) => {
  const f = activationFixture(t);
  projectWithGitRoot(f);
  // Lease transfer also touches the machine guard when a lease store exists.
  fs.writeFileSync(path.join(f.root, 'leases.json'), JSON.stringify({ leases: [] }));
  const unrelated = path.join(f.root, 'locks', 'unrelated');
  fs.mkdirSync(unrelated, { recursive: true });
  f.activate();
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), ['unrelated']);
  assert.equal(fs.existsSync(unrelated), true, 'an untouched empty directory stays');
});

test('activation keeps a touched lock directory with an unrelated file', (t) => {
  const f = activationFixture(t);
  const config = projectWithGitRoot(f);
  const source = acquire(config, f.root, 'deploy', 'ws:p1');
  const directory = path.dirname(lockFiles(f.root)[0]);
  releaseProjectLock('deploy', { ...source.options, expectedRecord: source.record });
  const marker = path.join(directory, 'keep.txt');
  fs.writeFileSync(marker, 'keep');
  f.activate();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});

test('activation re-owns the locks of the source pane and leaves the locks of other panes', (t) => {
  const f = activationFixture(t);
  const config = projectWithGitRoot(f);
  const source = acquire(config, f.root, 'deploy', 'ws:p1');
  acquire(config, f.root, 'other-project-lock', 'ws:p3');

  assert.deepEqual(owners(f.root), { 'deploy.json': 'ws:p1', 'other-project-lock.json': 'ws:p3' });

  const item = f.activate();

  assert.equal(item.status, 'active');
  assert.deepEqual(owners(f.root), { 'deploy.json': 'ws:p2', 'other-project-lock.json': 'ws:p3' });
  releaseProjectLock('deploy', { ...source.options, expectedRecord: source.record });
});

test('activation re-owns a machine lock of the source pane', (t) => {
  const f = activationFixture(t);
  const config = projectWithGitRoot(f);
  const source = acquire(config, f.root, 'full-suite', 'ws:p1');
  const other = acquire(config, f.root, 'deploy', 'ws:p3');
  const machine = (name) => JSON.parse(fs.readFileSync(path.join(f.root, 'locks', 'machine', `${name}.json`), 'utf8'));

  f.activate();

  assert.equal(machine('full-suite').ownerPane, 'ws:p2', 'the machine lock of the source pane moves');
  releaseProjectLock('full-suite', { ...source.options, expectedRecord: source.record });
  releaseProjectLock('deploy', { ...other.options, expectedRecord: other.record });
});
