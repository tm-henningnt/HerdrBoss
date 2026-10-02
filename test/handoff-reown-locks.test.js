import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activationFixture } from './helpers/handoff-fixture.js';
import { loadProjectConfig } from '../src/kit/config.js';
import { acquireProjectLock, releaseProjectLock } from '../src/kit/locks.js';

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
