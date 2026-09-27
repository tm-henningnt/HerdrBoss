import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Each fixture has a clone with a bare remote in a temporary folder. The push never leaves that folder.
function fixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'clone');
  const dataDir = path.join(base, 'data');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  const config = loadProjectConfig({ cwd: root });
  const calls = [];
  const herdr = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: args[2] === 'ws:worker' ? 'worker' : 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:orch' }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const lines = [];
  const options = (pane = 'ws:orch') => ({
    config,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: pane },
    herdr,
    pidAlive: (pid) => pid === 601,
    output: (line) => lines.push(line),
    pushStdio: 'ignore',
  });
  const lockFile = path.join(dataDir, 'locks', 'machine', 'full-suite.json');
  // The hook records if the machine lock exists while it runs, then exits with the given code.
  const writeHook = (dir, exitCode = 0) => {
    fs.mkdirSync(dir, { recursive: true });
    const hook = path.join(dir, 'pre-push');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -f '${lockFile}' ]; then echo locked > '${base}/hook-saw'; else echo unlocked > '${base}/hook-saw'; fi\nexit ${exitCode}\n`);
    fs.chmodSync(hook, 0o755);
  };
  const hookSaw = () => fs.readFileSync(path.join(base, 'hook-saw'), 'utf8').trim();
  return { base, root, remote, dataDir, config, calls, lines, options, lockFile, writeHook, hookSaw };
}

test('herdr-boss push takes and releases the full-suite lock around a push with a pre-push hook', (t) => {
  const f = fixture(t, 'herdr-push-hook-');
  f.writeHook(path.join(f.root, '.git', 'hooks'));
  const result = runKitCommand('push', ['origin', 'main'], f.options());
  assert.equal(result.exitCode, 0);
  assert.equal(result.locked, true);
  assert.equal(f.hookSaw(), 'locked');
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after the push');
  assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.root, 'rev-parse', 'main'));
  assert.ok(f.lines.some((line) => /pre-push hook.*full-suite/i.test(line)), f.lines.join('\n'));
});

test('herdr-boss push releases the lock and passes the exit code through when the push fails', (t) => {
  const f = fixture(t, 'herdr-push-fail-');
  f.writeHook(path.join(f.root, '.git', 'hooks'), 1);
  const result = runKitCommand('push', ['origin', 'main'], f.options());
  assert.equal(result.exitCode, 1);
  assert.equal(f.hookSaw(), 'locked');
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after a failed push');
  assert.throws(() => git(f.remote, 'rev-parse', '--verify', 'main'));
});

test('herdr-boss push without a hook takes no lock and passes the exit code through', (t) => {
  const f = fixture(t, 'herdr-push-nohook-');
  const pushed = runKitCommand('push', ['origin', 'main'], f.options());
  assert.equal(pushed.exitCode, 0);
  assert.equal(pushed.locked, false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine')), false, 'no machine lock directory is created');
  assert.ok(!f.calls.some((call) => call.startsWith('pane process-info')), 'no lock owner PID is looked up');
  assert.ok(f.lines.some((line) => /no pre-push hook/i.test(line)), f.lines.join('\n'));
  const missing = runKitCommand('push', ['missing-remote', 'main'], f.options());
  assert.notEqual(missing.exitCode, 0);
  assert.equal(missing.locked, false);
});

test('herdr-boss push respects core.hooksPath and husky or lefthook configs', (t) => {
  const f = fixture(t, 'herdr-push-hookspath-');
  f.writeHook(path.join(f.base, 'custom-hooks'));
  git(f.root, 'config', 'core.hooksPath', path.join(f.base, 'custom-hooks'));
  const result = runKitCommand('push', ['origin', 'main'], f.options());
  assert.equal(result.locked, true);
  assert.equal(f.hookSaw(), 'locked');

  const g = fixture(t, 'herdr-push-lefthook-');
  fs.writeFileSync(path.join(g.root, 'lefthook.yml'), 'pre-push:\n  commands:\n    test:\n      run: npm test\n');
  const lefthook = runKitCommand('push', ['origin', 'main'], g.options());
  assert.equal(lefthook.locked, true);
  assert.equal(fs.existsSync(g.lockFile), false);

  const h = fixture(t, 'herdr-push-husky-');
  fs.writeFileSync(path.join(h.root, 'package.json'), JSON.stringify({ husky: { hooks: { 'pre-push': 'npm test' } } }));
  assert.equal(runKitCommand('push', ['origin', 'main'], h.options()).locked, true);
});

test('herdr-boss push requires an orch or boss caller pane', (t) => {
  const f = fixture(t, 'herdr-push-caller-');
  assert.throws(() => runKitCommand('push', ['origin', 'main'], f.options('ws:worker')), /orch or boss/);
  f.writeHook(path.join(f.root, '.git', 'hooks'));
  assert.throws(() => runKitCommand('push', ['origin', 'main'], f.options('ws:worker')), /orch or boss/);
  assert.throws(() => git(f.remote, 'rev-parse', '--verify', 'main'));
});
