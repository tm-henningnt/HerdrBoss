import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { collectWorker, commitWorker, listCwdProcesses, startWorker, stopOwnWorker } from '../src/kit/workers.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

function startKind(f, name, { kind = 'codex', allow = ['src/'] } = {}) {
  return startWorker(name, { kind, task: 'x', allow }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
}

function writeReport(run, changedPaths) {
  const dir = path.join(run.worktree, run.workerDir || '.worker');
  fs.writeFileSync(path.join(dir, 'report.md'), 'Report.\n');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths,
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
}

function cleanup(t, f, run) {
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
    try { git(f.root, 'branch', '-D', run.branch); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
}

function writeChange(run, relative, body = 'changed\n') {
  const file = path.join(run.worktree, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test('worker stop-own refuses a pid outside the worker process tree and worktree', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-refuse');
  cleanup(t, f, run);
  const killed = [];
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd: run.worktree },
    { pid: process.pid, ppid: 10, command: 'node', cwd: run.worktree },
    { pid: 22, ppid: 1, command: 'node', cwd: f.root },
  ];
  assert.throws(() => stopOwnWorker('stop-refuse', { pid: 22 }, {
    config: f.config, output: () => {}, listProcesses: () => processes,
    kill: (pid, signal) => killed.push([pid, signal]), callerPid: process.pid, callerPpid: 10,
  }), /refuses pid 22/);
  assert.deepEqual(killed, [], 'a foreign pid is never signalled');
});

test('worker stop-own refuses the caller and its parents', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-parent');
  cleanup(t, f, run);
  const killed = [];
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd: run.worktree },
    { pid: process.pid, ppid: 10, command: 'node', cwd: run.worktree },
  ];
  assert.throws(() => stopOwnWorker('stop-parent', { pid: 10 }, {
    config: f.config, output: () => {}, listProcesses: () => processes,
    kill: (pid, signal) => killed.push([pid, signal]), callerPid: process.pid, callerPpid: 10,
  }), /is the caller or one of its parents/);
  assert.deepEqual(killed, []);
});

test('worker stop-own stops an own child and prints only the pid and command', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-child');
  cleanup(t, f, run);
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd: run.worktree },
    { pid: process.pid, ppid: 10, command: 'node', cwd: run.worktree },
    { pid: 44, ppid: 10, command: 'node', cwd: '/tmp' },
  ];
  const killed = [];
  const output = [];
  const result = stopOwnWorker('stop-child', { pid: 44 }, {
    config: f.config, output: (line) => output.push(line), listProcesses: () => processes,
    kill: (pid, signal) => killed.push([pid, signal]), callerPid: process.pid, callerPpid: 10,
  });
  assert.deepEqual(killed, [[44, 'SIGTERM']]);
  assert.deepEqual(output, ['44 node']);
  assert.deepEqual(result, { pid: 44, command: 'node' });
});

test('worker stop-own stops a process whose cwd is inside the worker worktree', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-cwd');
  cleanup(t, f, run);
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd: run.worktree },
    { pid: process.pid, ppid: 10, command: 'node', cwd: run.worktree },
    { pid: 55, ppid: 1, command: 'node', cwd: path.join(run.worktree, '.worker') },
  ];
  const killed = [];
  stopOwnWorker('stop-cwd', { pid: 55 }, {
    config: f.config, output: () => {}, listProcesses: () => processes,
    kill: (pid, signal) => killed.push([pid, signal]), callerPid: process.pid, callerPpid: 10,
  });
  assert.deepEqual(killed, [[55, 'SIGTERM']]);
});

test('worker stop-own stops a real child process in the worker worktree', { timeout: 30000 }, async (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-real');
  cleanup(t, f, run);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: run.worktree, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const deadline = Date.now() + 10_000;
  let listed = false;
  while (!listed && Date.now() < deadline) {
    listed = listCwdProcesses().some((item) => Number(item.pid) === child.pid);
    if (!listed) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(listed, 'the child process appears in the process list with the worktree cwd');
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  stopOwnWorker('stop-real', { pid: child.pid }, { config: f.config, output: () => {} });
  const result = await exited;
  assert.ok(result.code !== null || result.signal === 'SIGTERM', `the child stopped: ${JSON.stringify(result)}`);
});

test('worker commit refuses a changed path outside the worker scope', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'commit-refuse');
  cleanup(t, f, run);
  writeChange(run, 'docs/outside.md');
  const before = git(run.worktree, 'rev-parse', 'HEAD');
  assert.throws(() => commitWorker('commit-refuse', { message: 'test change' }, { config: f.config, output: () => {} }),
    /changed paths outside its allowed scope: docs\/outside\.md/);
  assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), before, 'a refused commit changes no history');
  assert.equal(git(run.worktree, 'status', '--porcelain', '--untracked-files=all').trim(), '?? docs/outside.md');
});

test('worker commit stages the worker change and commits on the worker branch', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'commit-ok');
  cleanup(t, f, run);
  writeChange(run, 'src/change.js', 'export const changed = true;\n');
  const output = [];
  const result = commitWorker('commit-ok', { message: 'Codex worker change' }, { config: f.config, output: (line) => output.push(line) });
  assert.equal(result.committed, true);
  assert.deepEqual(result.paths, ['src/change.js']);
  assert.equal(git(run.worktree, 'rev-list', '--count', `${run.baseCommit}..HEAD`), '1');
  assert.equal(git(run.worktree, 'log', '-1', '--pretty=%s').trim(), 'Codex worker change');
  assert.equal(git(run.worktree, 'branch', '--show-current').trim(), run.branch);
  assert.equal(git(run.worktree, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.ok(output.some((line) => /Committed .* on commit-ok/.test(line)));
});

test('worker commit needs a message', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'commit-message');
  cleanup(t, f, run);
  writeChange(run, 'src/change.js');
  assert.throws(() => commitWorker('commit-message', {}, { config: f.config, output: () => {} }), /needs -m MESSAGE/);
});

test('worker commit accepts -m on the command line', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'commit-cli');
  cleanup(t, f, run);
  writeChange(run, 'src/change.js');
  runKitCommand('worker', ['commit', 'commit-cli', '-m', 'CLI message'], { config: f.config, output: () => {} });
  assert.equal(git(run.worktree, 'log', '-1', '--pretty=%s').trim(), 'CLI message');
});

test('worker stop-own needs a pid on the command line', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'stop-usage');
  cleanup(t, f, run);
  assert.throws(() => runKitCommand('worker', ['stop-own', 'stop-usage'], { config: f.config, output: () => {} }), /needs --pid/);
});

test('worker collect accepts an uncommitted codex worker and reports the uncommitted state', (t) => {
  const f = setupFixture(null);
  const run = startKind(f, 'collect-uncommitted');
  cleanup(t, f, run);
  writeChange(run, 'src/change.js', 'export const changed = true;\n');
  writeReport(run, ['src/change.js']);
  const output = [];
  const summary = collectWorker('collect-uncommitted', { noRecord: true }, {
    config: f.config, output: (line) => output.push(line), listWorktreeProcesses: () => [],
  });
  assert.deepEqual(summary.actualPaths, ['src/change.js']);
  assert.deepEqual(summary.commits, []);
  assert.equal(summary.uncommitted, true);
  assert.ok(output.some((line) => /uncommitted/.test(line)), 'collect names the uncommitted state');
});

test('the codex worker brief carries the stop-own and no-commit rules', (t) => {
  const template = path.resolve('kit/templates/worker-brief.md');
  const f = setupFixture(null);
  f.config.briefTemplatePath = template;
  const run = startKind(f, 'brief-codex');
  cleanup(t, f, run);
  const brief = fs.readFileSync(path.join(run.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /herdr-boss worker stop-own brief-codex --pid/);
  assert.match(brief, /Never run `kill`, `pkill`, `killall`/);
  assert.match(brief, /do not run `git add` or `git commit`/i);
  assert.match(brief, /herdr-boss worker commit brief-codex -m MESSAGE/);
  assert.match(brief, /uncommitted/i);
});

test('a non-codex worker brief keeps the generic stop rule and names no worker commit', (t) => {
  const template = path.resolve('kit/templates/worker-brief.md');
  const f = setupFixture(null);
  f.config.briefTemplatePath = template;
  const run = startKind(f, 'brief-claude', { kind: 'claude' });
  cleanup(t, f, run);
  const brief = fs.readFileSync(path.join(run.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /Stop it with `kill <pid>`/);
  assert.doesNotMatch(brief, /worker stop-own/);
  assert.doesNotMatch(brief, /worker commit/);
});
