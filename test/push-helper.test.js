import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { withMutationLock } from '../src/kit/locks.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function seedMutationGuard(directory, { pid = null, ageSeconds = 0 } = {}) {
  const guard = path.join(directory, '.mutation');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  if (pid !== null) {
    fs.writeFileSync(path.join(guard, 'owner.json'), JSON.stringify({ pid, at: new Date().toISOString() }), { mode: 0o600 });
  }
  if (ageSeconds > 0) {
    const old = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(guard, old, old);
  }
  return guard;
}

function installFakeGit(t, f, hook) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(f.base, 'fake-bin');
  const calls = path.join(f.base, 'fake-git-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "push" ]; then',
    `  printf 'push\\n' >> ${shellQuote(calls)}`,
    `  ${shellQuote(hook)} || exit $?`,
    '  exit 0',
    'fi',
    `exec ${shellQuote(realGit)} "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  return calls;
}

async function holdMutationGuardUntilReleased(t, directory, delayMs = 200) {
  const guard = path.join(directory, '.mutation');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  const script = `const fs = require('node:fs'); const guard = ${JSON.stringify(guard)}; process.stdout.write('ready\\n'); setTimeout(() => fs.rmdirSync(guard), ${delayMs});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(guard, { recursive: true, force: true });
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { done };
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
  const livePanes = ['ws:orch'];
  const herdr = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: args[2] === 'ws:worker' ? 'worker' : 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: livePanes.map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const lines = [];
  const options = (pane = 'ws:orch', paneConfig = config) => ({
    config: paneConfig,
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
    return hook;
  };
  const hookSaw = () => fs.readFileSync(path.join(base, 'hook-saw'), 'utf8').trim();
  return { base, root, remote, dataDir, config, calls, lines, livePanes, options, lockFile, writeHook, hookSaw };
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

test('back-to-back pushes with a pre-push hook both succeed and leave no lock', (t) => {
  const f = fixture(t, 'herdr-push-back-to-back-');
  const hook = f.writeHook(path.join(f.root, '.git', 'hooks'));
  const calls = installFakeGit(t, f, hook);

  const first = runKitCommand('push', ['origin', 'main'], f.options());
  const second = runKitCommand('push', ['origin', 'main'], f.options());

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.locked, true);
  assert.equal(second.locked, true);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'push\npush\n');
  assert.equal(f.hookSaw(), 'locked');
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after both pushes');
});

test('lock acquire waits briefly for a busy mutation guard', async (t) => {
  const f = fixture(t, 'herdr-lock-acquire-guard-');
  const { done } = await holdMutationGuardUntilReleased(t, path.join(f.dataDir, 'locks', 'machine'));
  const acquired = runKitCommand('lock', ['acquire', 'full-suite'], f.options());
  await done;
  assert.equal(acquired.ownerPane, 'ws:orch');
  assert.equal(fs.existsSync(f.lockFile), true);
  runKitCommand('lock', ['release', 'full-suite'], f.options());
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('lock acquire with --wait retries after the mutation guard wait ends', async (t) => {
  const f = fixture(t, 'herdr-lock-acquire-wait-guard-');
  const { done } = await holdMutationGuardUntilReleased(t, path.join(f.dataDir, 'locks', 'machine'), 5200);
  const acquired = runKitCommand('lock', ['acquire', 'full-suite', '--wait', '10'], f.options());
  await done;
  assert.equal(acquired.ownerPane, 'ws:orch');
  assert.equal(fs.existsSync(f.lockFile), true);
  runKitCommand('lock', ['release', 'full-suite'], f.options());
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('lock release waits briefly for a busy mutation guard', async (t) => {
  const f = fixture(t, 'herdr-lock-release-guard-');
  runKitCommand('lock', ['acquire', 'full-suite'], f.options());
  const { done } = await holdMutationGuardUntilReleased(t, path.join(f.dataDir, 'locks', 'machine'));
  runKitCommand('lock', ['release', 'full-suite'], f.options());
  await done;
  assert.equal(fs.existsSync(f.lockFile), false);
});

for (const staleGuard of [
  { name: 'dead PID', pid: 2147483647 },
  { name: 'missing owner older than ten seconds', ageSeconds: 11 },
  { name: 'live PID older than sixty seconds', pid: process.pid, ageSeconds: 61 },
]) {
  test(`lock acquire and release recover a mutation guard with ${staleGuard.name}`, (t) => {
    const f = fixture(t, 'herdr-lock-stale-guard-');
    const directory = path.join(f.dataDir, 'locks', 'machine');
    seedMutationGuard(directory, staleGuard);

    const acquired = runKitCommand('lock', ['acquire', 'full-suite'], f.options());
    assert.equal(acquired.ownerPane, 'ws:orch');
    assert.equal(fs.existsSync(path.join(directory, '.mutation')), false, 'acquire removes the stale guard');

    seedMutationGuard(directory, staleGuard);
    runKitCommand('lock', ['release', 'full-suite'], f.options());
    assert.equal(fs.existsSync(f.lockFile), false, 'release removes the lock');
    assert.equal(fs.existsSync(path.join(directory, '.mutation')), false, 'release removes the stale guard');
  });
}

test('a recent mutation guard owned by a live PID stays busy', (t) => {
  const f = fixture(t, 'herdr-lock-live-guard-');
  const directory = path.join(f.dataDir, 'locks', 'machine');
  const guard = seedMutationGuard(directory, { pid: process.pid });
  assert.throws(() => withMutationLock(directory, () => 'changed', { waitMs: 20 }), (error) => {
    assert.equal(error.code, 'ELOCKBUSY');
    return true;
  });
  assert.equal(fs.existsSync(guard), true, 'the live guard remains in place');
});

test('withMutationLock reports stale guard removal through onStale', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-stale-callback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  seedMutationGuard(directory, { pid: 2147483647 });
  const notices = [];

  const result = withMutationLock(directory, () => 'changed', {
    waitMs: 20,
    onStale: (message) => notices.push(message),
  });

  assert.equal(result, 'changed');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Removed a stale lock guard \(PID 2147483647, age \d+s\)\.$/);
});

test('push lock records the push process and kind', (t) => {
  const f = fixture(t, 'herdr-push-owner-');
  f.writeHook(path.join(f.root, '.git', 'hooks'));
  const hook = path.join(f.root, '.git', 'hooks', 'pre-push');
  const observed = path.join(f.base, 'push-lock.json');
  fs.writeFileSync(hook, `#!/bin/sh\ncat '${f.lockFile}' > '${observed}'\nexit 0\n`);
  fs.chmodSync(hook, 0o755);

  const result = runKitCommand('push', ['origin', 'main'], f.options());
  assert.equal(result.exitCode, 0);
  const lock = JSON.parse(fs.readFileSync(observed, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.kind, 'push');
  assert.equal(lock.ownerPane, 'ws:orch');
});

test('push lock timeout returns EX_TEMPFAIL before running git push', (t) => {
  const f = fixture(t, 'herdr-push-lock-busy-');
  f.writeHook(path.join(f.root, '.git', 'hooks'));
  runKitCommand('lock', ['acquire', 'full-suite'], f.options());
  f.livePanes.push('ws:boss');
  let clock = Date.now();
  let error;
  try {
    runKitCommand('push', ['origin', 'main'], {
      ...f.options('ws:boss'),
      now: () => clock,
      pause: () => { clock += 1_800_000; },
    });
  } catch (caught) { error = caught; }
  assert.equal(error?.exitCode, 75);
  assert.match(error?.message ?? '', /^lock busy: .*ws:orch \(manual\).*queue position 1 of 1.*waited 1800 seconds/i);
  assert.ok(f.lines.some((line) => line === 'waiting for full-suite, position 1 of 1, held by ws:orch (manual)'));
  assert.equal(fs.existsSync(path.join(f.base, 'hook-saw')), false, 'git push does not run before it gets the lock');
  runKitCommand('lock', ['release', 'full-suite'], f.options());
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

test('push warns when lock release stays busy and returns failure after a successful push', (t) => {
  const f = fixture(t, 'herdr-push-release-busy-');
  const hook = f.writeHook(path.join(f.root, '.git', 'hooks'));
  const guard = path.join(f.dataDir, 'locks', 'machine', '.mutation');
  fs.writeFileSync(hook, [
    '#!/bin/sh',
    `if [ -f '${f.lockFile}' ]; then echo locked > '${path.join(f.base, 'hook-saw')}'; else echo unlocked > '${path.join(f.base, 'hook-saw')}'; fi`,
    `mkdir '${guard}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(hook, 0o755);
  installFakeGit(t, f, hook);

  const result = runKitCommand('push', ['origin', 'main'], f.options());

  assert.equal(result.exitCode, 1);
  assert.equal(f.hookSaw(), 'locked');
  assert.equal(fs.existsSync(f.lockFile), true, 'the lock record remains for takeover after this process ends');
  assert.deepEqual(f.lines.filter((line) => line.startsWith('Warning:')), [
    'Warning: could not release lock full-suite: A project lock operation is already in progress. Retry when it finishes. The lock is stale when this process ends.',
  ]);
  fs.rmSync(guard, { recursive: true, force: true });
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

// A worker has a linked worktree and a run record in the orchestrator checkout.
function workerFixture(t, prefix, run = {}) {
  const f = fixture(t, prefix);
  const worktree = path.join(f.base, 'wt-w1');
  git(f.root, 'worktree', 'add', '-b', 'w1', worktree, 'main');
  const runsDir = path.join(f.root, '.orchestration', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const writeRun = (fields) => fs.writeFileSync(path.join(runsDir, 'w1.json'), JSON.stringify({
    name: 'w1', kind: 'claude', model: 'claude-opus-5-5', worktree, pane: 'ws:worker', startedAt: '2026-09-27T10:00:00.000Z', ...fields,
  }));
  if (run !== null) writeRun(run);
  f.livePanes.push('ws:worker');
  const workerConfig = loadProjectConfig({ cwd: worktree });
  return { ...f, worktree, workerConfig, writeRun, worker: () => f.options('ws:worker', workerConfig) };
}

test('a worker pane with a live run record can acquire and release the full-suite lock', (t) => {
  const f = workerFixture(t, 'herdr-worker-lock-');
  const acquired = runKitCommand('lock', ['acquire', 'full-suite', '--wait', '5'], f.worker());
  assert.equal(acquired.ownerPane, 'ws:worker');
  assert.equal(fs.existsSync(f.lockFile), true);
  assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], f.options()), /held by active pane ws:worker/);
  runKitCommand('lock', ['release', 'full-suite'], f.worker());
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a worker pane cannot take another lock name', (t) => {
  const f = workerFixture(t, 'herdr-worker-other-');
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy'], f.worker()), /orch or boss/);
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], f.worker()), /orch or boss/);
});

test('a worker pane without a run record is refused the full-suite lock', (t) => {
  const f = workerFixture(t, 'herdr-worker-norun-', null);
  assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], f.worker()), /orch or boss.*live worker run/);
  f.writeRun({ pane: 'ws:other' });
  assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], f.worker()), /live worker run/);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a worker pane with a finished run record is refused the full-suite lock', (t) => {
  const f = workerFixture(t, 'herdr-worker-finished-', { finishedAt: '2026-09-27T11:00:00.000Z' });
  assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], f.worker()), /live worker run/);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a stale worker lock is taken over after the worker pane is gone', (t) => {
  const f = workerFixture(t, 'herdr-worker-stale-');
  runKitCommand('lock', ['acquire', 'full-suite'], f.worker());
  f.livePanes.splice(f.livePanes.indexOf('ws:worker'), 1);
  const takeover = runKitCommand('lock', ['acquire', 'full-suite'], f.options());
  assert.equal(takeover.ownerPane, 'ws:orch');
  assert.ok(f.lines.some((line) => /NOTICE.*stale lock full-suite.*ws:worker/i.test(line)), f.lines.join('\n'));
  runKitCommand('lock', ['release', 'full-suite'], f.options());
});

test('a worker in a .herdr-wt worktree without its own project file takes the lock for the main project', (t) => {
  const f = fixture(t, 'herdr-worker-herdrwt-');
  // Projects that git-ignore .herdr-boss.json leave the worker worktree without a copy.
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ slug: 'tmalpha' }));
  const worktree = path.join(f.base, 'Projects', '.herdr-wt', 'Alpha', 'pm1tube');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(f.root, 'worktree', 'add', '-b', 'pm1tube', worktree, 'main');
  const runsDir = path.join(f.root, '.orchestration', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'pm1tube.json'), JSON.stringify({
    name: 'pm1tube', kind: 'codex', model: 'gpt-6-luna', worktree, pane: 'ws:worker', startedAt: '2026-09-27T10:00:00.000Z',
  }));
  f.livePanes.push('ws:worker');
  const workerConfig = loadProjectConfig({ cwd: worktree });
  assert.equal(workerConfig.slug, 'tmalpha');
  const acquired = runKitCommand('lock', ['acquire', 'full-suite', '--wait', '5'], f.options('ws:worker', workerConfig));
  assert.equal(acquired.ownerPane, 'ws:worker');
  assert.equal(acquired.project, 'tmalpha');
  runKitCommand('lock', ['release', 'full-suite'], f.options('ws:worker', workerConfig));
});
