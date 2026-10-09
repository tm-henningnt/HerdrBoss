import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runKitCommand } from '../src/kit/cli.js';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';
import { pruneWorktrees } from '../src/kit/worktrees.js';
import { git, setupFixture, temporaryRepo } from './helpers/kit-fixture.js';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeWorkerFixture(t, { mainLock = '{"lockfileVersion":3}\n', currentLock = mainLock, clone = 'success' } = {}) {
  const fixture = setupFixture('npm ci');
  write(path.join(fixture.root, 'package-lock.json'), mainLock);
  write(path.join(fixture.root, 'node_modules', 'sample', 'index.js'), 'main dependency\n');
  git(fixture.root, 'add', 'package-lock.json');
  git(fixture.root, 'commit', '-m', 'add package lock');
  if (currentLock !== mainLock) write(path.join(fixture.root, 'package-lock.json'), currentLock);
  const output = [];
  const installs = [];
  const cloneCalls = [];
  const cloneNodeModules = (source, destination) => {
    cloneCalls.push({ source, destination });
    if (clone === 'partial-failure') {
      fs.mkdirSync(destination, { recursive: true });
      write(path.join(destination, 'partial.js'), 'partial\n');
      throw new Error('copy failed');
    }
    fs.cpSync(source, destination, { recursive: true });
  };
  let run;
  try {
    run = startWorker('disk-worker', { kind: 'codex', task: 'x', allow: ['src/'] }, {
      config: fixture.config,
      models: loadModels(),
      herdr: fixture.herdr,
      env: fixture.env,
      rulesFile: fixture.rulesFile,
      output: (line) => output.push(line),
      cloneNodeModules,
      runSetup: (command, cwd) => installs.push({ command, cwd }),
    });
  } catch (error) {
    try { git(fixture.root, 'worktree', 'remove', '--force', fixture.config.worktreePath('disk-worker')); } catch {}
    try { git(fixture.root, 'branch', '-D', 'disk-worker'); } catch {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
    throw error;
  }
  t.after(() => {
    try { git(fixture.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
    try { git(fixture.root, 'branch', '-D', run.branch); } catch {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  return { ...fixture, run, output, installs, cloneCalls };
}

test('worker start clones dependencies when main and worktree lock files match', (t) => {
  const f = makeWorkerFixture(t);
  assert.equal(f.cloneCalls.length, 1);
  assert.deepEqual(f.cloneCalls[0], {
    source: path.join(f.root, 'node_modules'),
    destination: path.join(f.run.worktree, 'node_modules'),
  });
  assert.equal(fs.readFileSync(path.join(f.run.worktree, 'node_modules', 'sample', 'index.js'), 'utf8'), 'main dependency\n');
  assert.equal(f.installs.length, 0);
  assert.ok(f.output.some((line) => /clone was used/.test(line)));
  assert.equal(fs.readFileSync(path.join(f.root, 'node_modules', 'sample', 'index.js'), 'utf8'), 'main dependency\n');
});

test('worker start installs when the main lock file differs from the worktree lock file', (t) => {
  const f = makeWorkerFixture(t, { currentLock: '{"lockfileVersion":4}\n' });
  assert.equal(f.cloneCalls.length, 0);
  assert.deepEqual(f.installs, [{ command: 'npm ci', cwd: f.run.worktree }]);
  assert.ok(f.output.some((line) => /install was used/.test(line)));
  assert.equal(fs.existsSync(path.join(f.run.worktree, 'node_modules')), false);
});

test('worker start removes a partial clone and runs the setup command when cloning fails', (t) => {
  const f = makeWorkerFixture(t, { clone: 'partial-failure' });
  assert.equal(f.cloneCalls.length, 1);
  assert.deepEqual(f.installs, [{ command: 'npm ci', cwd: f.run.worktree }]);
  assert.ok(f.output.some((line) => /install was used/.test(line)));
  assert.equal(fs.existsSync(path.join(f.run.worktree, 'node_modules', 'partial.js')), false);
});

test('worker start keeps its current behavior when the main checkout has no node_modules', (t) => {
  const fixture = setupFixture(null);
  const output = [];
  const cloneCalls = [];
  const run = startWorker('no-dependencies', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: fixture.config,
    models: loadModels(),
    herdr: fixture.herdr,
    env: fixture.env,
    rulesFile: fixture.rulesFile,
    output: (line) => output.push(line),
    cloneNodeModules: (...args) => cloneCalls.push(args),
  });
  t.after(() => {
    try { git(fixture.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
    try { git(fixture.root, 'branch', '-D', run.branch); } catch {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  assert.equal(cloneCalls.length, 0);
  assert.equal(output.some((line) => /Dependencies:/.test(line)), false);
});

function makeBuildWorktree(t, name = 'build-worker') {
  const root = temporaryRepo();
  write(path.join(root, '.gitignore'), 'dist/generated.bin\n.vite/\ntest-results/\nnode_modules/\n');
  write(path.join(root, 'dist', 'tracked.txt'), 'keep tracked data\n');
  git(root, 'add', '.gitignore', 'dist/tracked.txt');
  git(root, 'commit', '-m', 'add tracked build path');
  git(root, 'switch', '-c', `${name}-change`);
  write(path.join(root, 'work.txt'), 'unmerged worker change\n');
  git(root, 'add', 'work.txt');
  git(root, 'commit', '-m', 'unmerged worker change');
  git(root, 'switch', 'main');
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-wt-${name}`);
  git(root, 'worktree', 'add', '-b', name, worktree, `${name}-change`);
  write(path.join(worktree, 'dist', 'generated.bin'), Buffer.alloc(8192, 1));
  write(path.join(worktree, '.vite', 'cache'), Buffer.alloc(4096, 1));
  write(path.join(worktree, 'test-results', 'results.xml'), Buffer.alloc(2048, 1));
  write(path.join(worktree, 'node_modules', 'sample.js'), 'keep installed dependencies\n');
  fs.symlinkSync('tracked.txt', path.join(worktree, 'dist', 'link-to-tracked.txt'));
  const oldShot = path.join(worktree, '.worker', 'tmp', 'old-shot.png');
  const recentShot = path.join(worktree, '.worker', 'tmp', 'recent-shot.png');
  write(oldShot, Buffer.alloc(1024, 1));
  write(recentShot, Buffer.alloc(512, 1));
  write(path.join(worktree, '.worker', 'tmp', 'old-notes.txt'), 'keep non-image scratch\n');
  const old = new Date(Date.now() - 2 * 86400_000);
  fs.utimesSync(oldShot, old, old);
  return { root, worktree, config: loadProjectConfig({ cwd: root }), oldShot, recentShot };
}

test('worktree prune --clean-build lists rebuildable files for kept worktrees without deleting them', (t) => {
  const f = makeBuildWorktree(t);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const output = [];
  const result = pruneWorktrees(f.config, {
    cleanBuild: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => output.push(line),
  });
  const row = result.find((item) => item.path === f.worktree);
  assert.equal(row.removable, false, 'an unmerged worktree is kept');
  assert.ok(output.some((line) => line.includes('Would delete') && line.includes('dist')));
  assert.ok(output.some((line) => line.includes('Total that would be freed:')));
  assert.equal(fs.existsSync(path.join(f.worktree, 'dist', 'generated.bin')), true);
  assert.equal(fs.existsSync(f.oldShot), true);
});

test('worktree prune --apply --clean-build removes only untracked build output and old screenshots', (t) => {
  const f = makeBuildWorktree(t, 'apply-worker');
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.worktree, 'rm', '--cached', 'dist/tracked.txt');
  const output = [];
  runKitCommand('worktree', ['prune', '--apply', '--clean-build'], {
    config: f.config,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [],
    output: (line) => output.push(line),
  });
  assert.equal(fs.existsSync(path.join(f.worktree, 'dist', 'generated.bin')), false);
  assert.equal(fs.readFileSync(path.join(f.worktree, 'dist', 'tracked.txt'), 'utf8'), 'keep tracked data\n');
  assert.equal(fs.lstatSync(path.join(f.worktree, 'dist', 'link-to-tracked.txt')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(f.worktree, '.vite', 'cache')), false);
  assert.equal(fs.existsSync(path.join(f.worktree, 'test-results', 'results.xml')), false);
  assert.equal(fs.existsSync(f.oldShot), false);
  assert.equal(fs.existsSync(f.recentShot), true);
  assert.equal(fs.readFileSync(path.join(f.worktree, 'node_modules', 'sample.js'), 'utf8'), 'keep installed dependencies\n');
  assert.equal(fs.existsSync(path.join(f.worktree, '.worker', 'tmp', 'old-notes.txt')), true);
  assert.ok(output.some((line) => /^Total freed: /.test(line)));
  assert.equal(fs.existsSync(f.worktree), true, 'the unmerged worktree remains registered');
});

test('worktree prune --clean-build skips worktrees with a live pane or process', (t) => {
  const f = makeBuildWorktree(t, 'busy-worker');
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const paneOutput = [];
  pruneWorktrees(f.config, {
    cleanBuild: true,
    herdr: () => ({ panes: [{ cwd: f.worktree, agent_status: 'working' }] }),
    listProcesses: () => [],
    output: (line) => paneOutput.push(line),
  });
  assert.ok(paneOutput.some((line) => line.includes('Skipped build cleanup') && line.includes('live pane')));
  assert.equal(fs.existsSync(path.join(f.worktree, 'dist', 'generated.bin')), true);
  const processOutput = [];
  pruneWorktrees(f.config, {
    cleanBuild: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [{ pid: 12, ppid: 1, command: 'node', cwd: path.join(f.worktree, 'src') }],
    output: (line) => processOutput.push(line),
  });
  assert.ok(processOutput.some((line) => line.includes('Skipped build cleanup') && line.includes('running process')));
  assert.equal(fs.existsSync(path.join(f.worktree, 'dist', 'generated.bin')), true);
});

test('worktree disk prints project worktrees by size with total and free space', (t) => {
  const root = temporaryRepo();
  const large = path.join(path.dirname(root), `${path.basename(root)}-wt-large`);
  git(root, 'worktree', 'add', '-b', 'large', large, 'main');
  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', large); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sizes = new Map([[root, 2000], [large, 5000]]);
  const output = [];
  const result = runKitCommand('worktree', ['disk', '--json'], {
    config: loadProjectConfig({ cwd: root }),
    du: (directory) => sizes.get(directory),
    freeSpaceReader: () => ({ bavail: 20, bsize: 1024 ** 3 }),
    output: (line) => output.push(line),
  });
  assert.deepEqual(result.worktrees.map((item) => item.path), [large, root]);
  assert.deepEqual(result.worktrees.map((item) => item.bytes), [5000, 2000]);
  assert.equal(result.totalBytes, 7000);
  assert.equal(result.freeBytes, 20 * 1024 ** 3);
  assert.deepEqual(JSON.parse(output[0]), result);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the command does not change the repository');
});

test('worktree disk rejects unknown arguments before running disk readers', (t) => {
  const root = temporaryRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  assert.throws(() => runKitCommand('worktree', ['disk', '--apply'], {
    config: loadProjectConfig({ cwd: root }),
    du: () => { calls += 1; return 0; },
    freeSpaceReader: () => { calls += 1; return { bavail: 1, bsize: 1 }; },
    output: () => {},
  }), /Usage: worktree disk \[--json\]/);
  assert.equal(calls, 0);
});
