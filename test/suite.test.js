import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { acquireProjectLock, releaseProjectLock, withMutationLock } from '../src/kit/locks.js';
import { writeNight } from '../src/night.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const SECRET_VALUES = ['messaging-token-value-1', 'messaging-socket-value-2', 'fake-api-key-value-3', 'fake-deploy-key-value-4', 'fake-password-value-5'];

// Each fixture has a repository, a lock data folder, and a fake Herdr in a temporary folder.
// The suite command is a Node script. It records its environment names and whether the lock exists, then exits with the given code.
function fixture(t, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  const config = loadProjectConfig({ cwd: root });
  const livePanes = ['ws:orch'];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: args[2] === 'ws:orch' ? 'orch' : 'worker' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: livePanes.map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const lockFile = path.join(dataDir, 'locks', 'machine', 'full-suite.json');
  const seen = path.join(base, 'seen.json');
  const script = path.join(base, 'suite.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `const previous = fs.existsSync(${JSON.stringify(seen)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(seen)}, 'utf8')) : {};`,
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ names: Object.keys(process.env), runs: (previous.runs ?? 0) + 1, locked: fs.existsSync(${JSON.stringify(lockFile)}), lock: fs.existsSync(${JSON.stringify(lockFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(lockFile)}, 'utf8')) : null }));`,
    'process.exit(Number(process.argv[2] ?? 0));',
  ].join('\n'));
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    TMPDIR: base,
    HERDR_ENV: '1',
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_PANE_ID: 'ws:orch',
    PLAIN_SETTING: 'visible',
    CLAUDE_CODE_MESSAGING_TOKEN: SECRET_VALUES[0],
    CLAUDE_CODE_MESSAGING_SOCKET: SECRET_VALUES[1],
    OPENAI_API_KEY: SECRET_VALUES[2],
    deploy_key: SECRET_VALUES[3],
    DB_PASSWORD: SECRET_VALUES[4],
  };
  const lines = [];
  const options = (extra = {}) => ({
    config,
    lockDataDir: dataDir,
    env,
    herdr,
    pidAlive: (pid) => pid === 601,
    output: (line) => lines.push(line),
    suiteStdio: 'ignore',
    ...extra,
  });
  const run = (args, exitCode = 0, extra = {}) => runKitCommand('suite', [...args, '--', process.execPath, script, String(exitCode)], options(extra));
  const runCommand = (args, command, extra = {}) => runKitCommand('suite', [...args, '--', ...command], options(extra));
  const readSeen = () => JSON.parse(fs.readFileSync(seen, 'utf8'));
  return { base, root, dataDir, config, env, lines, livePanes, lockFile, script, options, run, runCommand, readSeen };
}

function readQueueFiles(dataDir) {
  const directory = path.join(dataDir, 'locks', 'machine', 'queue', 'full-suite');
  try {
    // Skip a file that is unreadable or not yet complete. The caller retries through waitFor.
    return fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try { return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]; } catch { return []; }
      })
      .sort((left, right) => left.seq - right.seq);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(condition, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function startLockWaiter(t, f, pane, panes, { waitSeconds = 30 } = {}) {
  const script = path.join(f.base, `${pane.replaceAll(':', '-')}.mjs`);
  const locksUrl = pathToFileURL(path.resolve('src/kit/locks.js')).href;
  const configUrl = pathToFileURL(path.resolve('src/kit/config.js')).href;
  fs.writeFileSync(script, `
    import { acquireProjectLock, releaseProjectLock } from ${JSON.stringify(locksUrl)};
    import { loadProjectConfig } from ${JSON.stringify(configUrl)};
    const panes = ${JSON.stringify(panes)};
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
      if (args[0] === 'pane' && args[1] === 'list') return { panes: panes.map((pane_id) => ({ pane_id })) };
      throw new Error('Unexpected Herdr call: ' + args.join(' '));
    };
    const config = loadProjectConfig({ cwd: process.argv[2] });
    const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: process.argv[4] };
    const options = { config, env, herdr, dataDir: process.argv[3], waitSeconds: Number(process.argv[5]), kind: 'suite', output: () => {} };
    try {
      const lock = acquireProjectLock('full-suite', options);
      process.stdout.write(JSON.stringify({ type: 'acquired', pane: lock.ownerPane }) + '\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      releaseProjectLock('full-suite', { ...options, output: () => {} });
      process.stdout.write(JSON.stringify({ type: 'released', pane: lock.ownerPane }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ type: 'error', message: error.message, exitCode: error.exitCode ?? null }) + '\\n');
      process.exitCode = error.exitCode ?? 1;
    }
  `);
  const child = spawn(process.execPath, [script, f.root, f.dataDir, pane, String(waitSeconds)], {
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.base, TMPDIR: f.base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  const nextMessage = (type) => {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Waiter ${pane} did not report ${type}.`)), 5000);
      waiters.push((message) => {
        clearTimeout(timeout);
        if (message.type === type) resolve(message);
        else reject(new Error(`Waiter ${pane} reported ${message.type}: ${message.message ?? ''}`));
      });
    });
  };
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  return { child, exited, nextMessage, release: () => child.stdin.write('release\n') };
}

function lockOptions(f, pane, panes, extra = {}) {
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: process.pid } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: panes.map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  return {
    config: f.config,
    dataDir: f.dataDir,
    lockDataDir: f.dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: pane },
    herdr,
    output: () => {},
    ...extra,
  };
}

test('quiet hours holds an expired live manual full-suite lock', (t) => {
  const f = fixture(t, 'herdr-suite-quiet-expiry-');
  const start = Date.parse('2026-09-28T20:00:00Z');
  const options = lockOptions(f, 'ws:orch', ['ws:orch'], { now: start });
  const original = acquireProjectLock('full-suite', { ...options, kind: 'manual' });
  const expiry = Date.parse(original.expiresAt) + 1;
  writeNight({ active: true, since: new Date(start).toISOString(), until: new Date(expiry + 3600000).toISOString(), quietHours: true }, { dataDir: f.dataDir });
  assert.throws(() => acquireProjectLock('full-suite', { ...options, now: expiry }), /held by active pane/);
  const record = JSON.parse(fs.readFileSync(f.lockFile, 'utf8'));
  assert.equal(record.acquiredAt, original.acquiredAt, 'expiry does not release a live lock during quiet hours');
  assert.ok(!fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'notices')), 'the held expiry adds no expiry notice');
  assert.ok(fs.readFileSync(path.join(f.dataDir, 'events.jsonl'), 'utf8').includes('quiet hours held manual full-suite lock expiry'));
});

test('quiet hours still takes over an expired manual lock with a dead holder', (t) => {
  const f = fixture(t, 'herdr-suite-quiet-dead-holder-');
  const start = Date.parse('2026-09-28T20:00:00Z');
  const options = lockOptions(f, 'ws:orch', ['ws:orch'], { now: start });
  const original = acquireProjectLock('full-suite', { ...options, kind: 'manual' });
  const expiry = Date.parse(original.expiresAt) + 1;
  writeNight({ active: true, since: new Date(start).toISOString(), until: new Date(expiry + 3600000).toISOString(), quietHours: true }, { dataDir: f.dataDir });
  const takeover = acquireProjectLock('full-suite', { ...options, now: expiry, pidAlive: () => false });
  assert.notEqual(takeover.acquiredAt, original.acquiredAt);
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).acquiredAt, new Date(expiry).toISOString());
});

test('suite holds the full-suite lock around the command and passes the exit code through', (t) => {
  const f = fixture(t, 'herdr-suite-pass-');
  const passed = f.run([]);
  assert.equal(passed.exitCode, 0);
  assert.equal(f.readSeen().locked, true, 'the lock exists while the command runs');
  assert.equal(f.readSeen().lock.pid, process.pid, 'the lock records the herdr-boss suite process');
  assert.equal(f.readSeen().lock.kind, 'suite');
  assert.equal(f.readSeen().lock.ownerPane, 'ws:orch');
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after the command');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', '.mutation')), false, 'the mutation guard is removed');
  const failed = f.run([], 3);
  assert.equal(failed.exitCode, 3);
  assert.equal(f.readSeen().locked, true);
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after a failed command');
  assert.ok(f.lines.some((line) => /acquired/.test(line)) && f.lines.some((line) => /released/.test(line)), f.lines.join('\n'));
});

test('a matching push token re-enters without a queue ticket and cannot release the push lock', (t) => {
  const f = fixture(t, 'herdr-suite-push-lock-reentry-');
  const token = 'push-reentry-token-0001';
  const outerEnv = { ...f.env };
  const outerOptions = { ...f.options({ pidAlive: (pid) => pid === process.pid }), dataDir: f.dataDir, env: outerEnv };
  acquireProjectLock('full-suite', { ...outerOptions, kind: 'push', reentryToken: token });

  const innerEnv = { ...f.env, HERDR_BOSS_LOCK_TOKEN: token };
  const innerOptions = { ...outerOptions, env: innerEnv, kind: 'suite', waitSeconds: 0 };
  const acquired = acquireProjectLock('full-suite', innerOptions);

  assert.equal(acquired.reentrant, true);
  assert.equal(fs.readFileSync(f.lockFile, 'utf8').includes(token), true);
  assert.deepEqual(readQueueFiles(f.dataDir), [], 're-entry does not take a queue ticket');
  releaseProjectLock('full-suite', { ...innerOptions, output: () => {} });
  assert.equal(fs.existsSync(f.lockFile), true, 'the inner caller cannot release the outer lock');

  releaseProjectLock('full-suite', { ...outerOptions, output: () => {} });
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a wrong push token waits in the full-suite queue', (t) => {
  const f = fixture(t, 'herdr-suite-push-lock-wrong-token-');
  const token = 'push-reentry-token-0002';
  const options = { ...f.options({ pidAlive: (pid) => pid === process.pid }), dataDir: f.dataDir };
  acquireProjectLock('full-suite', { ...options, kind: 'push', reentryToken: token });

  assert.throws(() => acquireProjectLock('full-suite', {
    ...options,
    env: { ...f.env, HERDR_BOSS_LOCK_TOKEN: 'wrong-reentry-token-0000' },
    kind: 'suite',
    waitSeconds: 0,
  }), (error) => error.exitCode === 75);
  assert.ok(f.lines.some((line) => line.startsWith('waiting for full-suite,')), f.lines.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).reentryToken, token);
  assert.deepEqual(readQueueFiles(f.dataDir), [], 'the timed-out caller removes its ticket');
  releaseProjectLock('full-suite', { ...options, output: () => {} });
});

test('a token from a finished push does not re-enter its former lock', (t) => {
  const f = fixture(t, 'herdr-suite-push-lock-stale-token-');
  const token = 'push-reentry-token-0003';
  let pushAlive = true;
  const options = { ...f.options({ pidAlive: (pid) => pid === process.pid && pushAlive }), dataDir: f.dataDir };
  acquireProjectLock('full-suite', { ...options, kind: 'push', reentryToken: token });
  pushAlive = false;

  const acquired = acquireProjectLock('full-suite', {
    ...options,
    env: { ...f.env, HERDR_BOSS_LOCK_TOKEN: token },
    kind: 'suite',
    waitSeconds: 0,
  });

  assert.equal(acquired.reentrant, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).kind, 'suite');
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).reentryToken, undefined);
  releaseProjectLock('full-suite', { ...options, env: { ...f.env, HERDR_BOSS_LOCK_TOKEN: token }, output: () => {} });
});

test('suite removes an old ownerless mutation guard and writes one stderr line', (t) => {
  const f = fixture(t, 'herdr-suite-stale-guard-');
  const directory = path.join(f.dataDir, 'locks', 'machine');
  const guard = path.join(directory, '.mutation');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(guard, old, old);

  const writes = [];
  const originalWrite = process.stderr.write;
  let result;
  try {
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    result = f.run([]);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(guard), false);
  assert.equal(writes.length, 1);
  assert.match(writes[0].trimEnd(), /^Removed a stale lock guard \(PID unknown, age \d+s\)\.$/);
});

test('withMutationLock records its PID and timestamp, then removes the owner file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mutation-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = withMutationLock(directory, () => {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, '.mutation', 'owner.json'), 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['at', 'pid']);
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(owner.at)));
    return 'changed';
  });

  assert.equal(result, 'changed');
  assert.equal(fs.existsSync(path.join(directory, '.mutation')), false);
});

test('suite releases the lock when the command cannot start', (t) => {
  const f = fixture(t, 'herdr-suite-missing-');
  const result = runKitCommand('suite', ['--', path.join(f.base, 'no-such-command')], f.options());
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('suite keeps a failed command code when lock release stays busy, then the next acquire takes over', (t) => {
  const f = fixture(t, 'herdr-suite-release-busy-');
  const guard = path.join(f.dataDir, 'locks', 'machine', '.mutation');
  const ownerEnded = path.join(f.base, 'owner-ended');
  const script = path.join(f.base, 'leave-mutation-guard.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `fs.mkdirSync(${JSON.stringify(guard)}, { recursive: true, mode: 0o700 });`,
    `fs.writeFileSync(${JSON.stringify(ownerEnded)}, 'yes');`,
    'process.exit(4);',
  ].join('\n'));
  const pidAlive = (pid) => fs.existsSync(ownerEnded) ? pid === 601 : true;

  const result = runKitCommand('suite', ['--', process.execPath, script], f.options({ pidAlive }));

  assert.equal(result.exitCode, 4);
  assert.equal(fs.existsSync(f.lockFile), true, 'the lock record remains after release fails');
  assert.deepEqual(f.lines.filter((line) => line.startsWith('Warning:')), [
    'Warning: could not release lock full-suite: A project lock operation is already in progress. Retry when it finishes. The lock is stale when this process ends.',
  ]);
  fs.rmSync(guard, { recursive: true, force: true });

  const takeover = runKitCommand('lock', ['acquire', 'full-suite'], f.options({ pidAlive }));
  assert.equal(takeover.ownerPane, 'ws:orch');
  assert.ok(f.lines.some((line) => /NOTICE: Taking over stale lock full-suite/.test(line)), f.lines.join('\n'));
  runKitCommand('lock', ['release', 'full-suite'], f.options({ pidAlive }));
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('suite removes token, secret, password, and key names from the command environment', (t) => {
  const f = fixture(t, 'herdr-suite-env-');
  const result = f.run([]);
  const names = f.readSeen().names;
  for (const name of ['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'OPENAI_API_KEY', 'deploy_key', 'DB_PASSWORD']) {
    assert.ok(!names.includes(name), `${name} is removed`);
  }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'HERDR_PANE_ID', 'PLAIN_SETTING']) assert.ok(names.includes(name), `${name} is kept`);
  assert.equal(result.removed, 5);
  assert.ok(f.lines.some((line) => /removed 5 environment names/i.test(line)), f.lines.join('\n'));
  assert.equal(f.env.OPENAI_API_KEY, SECRET_VALUES[2], 'the caller environment is not changed');

  const kept = f.run(['--keep', 'OPENAI_API_KEY']);
  const keptNames = f.readSeen().names;
  assert.ok(keptNames.includes('OPENAI_API_KEY'), '--keep keeps the name');
  assert.ok(!keptNames.includes('deploy_key'));
  assert.equal(kept.removed, 4);
  f.run(['--keep', 'OPENAI_API_KEY', '--keep', 'DB_PASSWORD']);
  assert.ok(f.readSeen().names.includes('DB_PASSWORD'), '--keep can repeat');
});

test('suite never prints an environment value', (t) => {
  const f = fixture(t, 'herdr-suite-quiet-');
  f.run([]);
  f.run(['--keep', 'OPENAI_API_KEY'], 1);
  const text = f.lines.join('\n');
  for (const value of SECRET_VALUES) assert.ok(!text.includes(value), 'no secret value is printed');
  assert.ok(!text.includes('OPENAI_API_KEY') && !text.includes('CLAUDE_CODE_MESSAGING_TOKEN'), 'no removed name is printed');
});

test('suite accepts --wait and refuses a missing command or a bad option', (t) => {
  const f = fixture(t, 'herdr-suite-args-');
  assert.equal(f.run(['--wait', '5']).exitCode, 0);
  assert.throws(() => runKitCommand('suite', [process.execPath], f.options()), /Usage: suite/);
  assert.throws(() => runKitCommand('suite', ['--'], f.options()), /Usage: suite/);
  assert.throws(() => runKitCommand('suite', ['--wait', 'soon', '--', process.execPath], f.options()), /--wait/);
  assert.throws(() => runKitCommand('suite', ['--fast', '1', '--', process.execPath], f.options()), /Unknown option/);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('suite refuses a pane that is not orch, boss, or a live worker', (t) => {
  const f = fixture(t, 'herdr-suite-caller-');
  f.env.HERDR_PANE_ID = 'ws:stranger';
  f.livePanes.push('ws:stranger');
  assert.throws(() => f.run([]), /live worker run/);
  assert.equal(fs.existsSync(path.join(f.base, 'seen.json')), false, 'the command does not run without the lock');
});

test('suite runs for a worker pane with a live run record', (t) => {
  const f = fixture(t, 'herdr-suite-worker-');
  const worktree = path.join(f.base, 'wt-w1');
  git(f.root, 'worktree', 'add', '-b', 'w1', worktree, 'main');
  const runsDir = path.join(f.root, '.orchestration', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'w1.json'), JSON.stringify({ name: 'w1', kind: 'claude', model: 'claude-opus-5-5', worktree, pane: 'ws:worker' }));
  f.livePanes.push('ws:worker');
  f.env.HERDR_PANE_ID = 'ws:worker';
  const result = f.run([], 0, { config: loadProjectConfig({ cwd: worktree }) });
  assert.equal(result.exitCode, 0);
  assert.equal(f.readSeen().locked, true);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('the machine suite lock serves three separate-process waiters in ticket order', async (t) => {
  const f = fixture(t, 'herdr-suite-fifo-');
  const panes = ['ws:a', 'ws:b', 'ws:c', 'ws:d'];
  const holder = lockOptions(f, 'ws:a', panes);
  acquireProjectLock('full-suite', { ...holder, kind: 'manual' });
  let holderOwnsLock = true;
  const waiters = [];
  try {
    for (const [index, pane] of ['ws:b', 'ws:c', 'ws:d'].entries()) {
      const waiter = startLockWaiter(t, f, pane, panes);
      waiters.push(waiter);
      const tickets = await waitFor(() => {
        const current = readQueueFiles(f.dataDir);
        return current.length === index + 1 ? current : false;
      }, `waiter ${pane} did not take its ticket`);
      assert.deepEqual(tickets.map((ticket) => ticket.pane), ['ws:b', 'ws:c', 'ws:d'].slice(0, index + 1));
      assert.deepEqual(tickets.map((ticket) => ticket.seq), Array.from({ length: index + 1 }, (_, item) => item + 1));
      assert.deepEqual(Object.keys(tickets[0]).sort(), ['command', 'createdAt', 'id', 'kind', 'pane', 'pid', 'project', 'seq']);
    }

    releaseProjectLock('full-suite', holder);
    holderOwnsLock = false;
    for (const [index, waiter] of waiters.entries()) {
      const pane = ['ws:b', 'ws:c', 'ws:d'][index];
      assert.equal((await waiter.nextMessage('acquired')).pane, pane);
      waiter.release();
      assert.equal((await waiter.nextMessage('released')).pane, pane);
    }
    assert.equal(fs.existsSync(f.lockFile), false);
    assert.deepEqual(readQueueFiles(f.dataDir), []);
  } finally {
    if (holderOwnsLock && fs.existsSync(f.lockFile)) releaseProjectLock('full-suite', holder);
  }
});

test('suite lock timeout returns EX_TEMPFAIL and does not run the test command', (t) => {
  const f = fixture(t, 'herdr-suite-lock-busy-');
  const panes = ['ws:a', 'ws:b'];
  acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'manual' });
  const output = [];
  let error;
  try {
    runKitCommand('suite', ['--wait', '0', '--', process.execPath, path.join(f.base, 'suite.mjs')], {
      ...lockOptions(f, 'ws:b', panes), output: (line) => output.push(line),
    });
  } catch (caught) { error = caught; }
  assert.equal(error?.exitCode, 75);
  assert.match(error?.message ?? '', /^lock busy: .*ws:a \(manual\).*queue position 1 of 1.*waited 0 seconds/i);
  assert.ok(output.some((line) => line === 'waiting for full-suite, position 1 of 1, held by ws:a (manual)'));
  assert.equal(fs.existsSync(path.join(f.base, 'seen.json')), false, 'the suite command does not run before it gets the lock');
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
});

test('a waiter reports its start and changed position no more than once a minute', (t) => {
  const f = fixture(t, 'herdr-suite-queue-progress-');
  let clock = Date.now();
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const holder = { ...lockOptions(f, 'ws:a', panes), now: () => clock };
  acquireProjectLock('full-suite', { ...holder, kind: 'manual' });
  const queueDir = path.join(f.dataDir, 'locks', 'machine', 'queue', 'full-suite');
  fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(queueDir, '.sequence'), '1\n', { mode: 0o600 });
  const olderId = '00000000-0000-4000-8000-000000000003';
  fs.writeFileSync(path.join(queueDir, `${olderId}.json`), JSON.stringify({
    id: olderId, seq: 1, pane: 'ws:c', project: 'older-project', pid: process.pid, kind: 'suite',
    command: 'herdr-boss lock acquire full-suite', createdAt: new Date(clock).toISOString(),
  }));
  const output = [];
  let firstPause = true;
  const acquired = acquireProjectLock('full-suite', {
    ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 120, now: () => clock,
    output: (line) => output.push(line),
    pause: (milliseconds) => {
      clock += milliseconds;
      if (firstPause) {
        firstPause = false;
        fs.unlinkSync(path.join(queueDir, `${olderId}.json`));
      } else if (output.length === 2) {
        releaseProjectLock('full-suite', holder);
      }
    },
  });
  assert.equal(acquired.ownerPane, 'ws:b');
  assert.deepEqual(output.filter((line) => line.startsWith('waiting for full-suite')), [
    'waiting for full-suite, position 2 of 2, held by ws:a (manual)',
    'waiting for full-suite, position 1 of 1, held by ws:a (manual)',
  ]);
  releaseProjectLock('full-suite', lockOptions(f, 'ws:b', panes));
});

test('lock acquire --wait timeout returns EX_TEMPFAIL and names its queue position', (t) => {
  const f = fixture(t, 'herdr-lock-wait-busy-');
  const panes = ['ws:a', 'ws:b'];
  acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'manual' });
  let error;
  try { runKitCommand('lock', ['acquire', 'full-suite', '--wait', '0'], lockOptions(f, 'ws:b', panes)); }
  catch (caught) { error = caught; }
  assert.equal(error?.exitCode, 75);
  assert.match(error?.message ?? '', /^lock busy: .*ws:a \(manual\).*queue position 1 of 1.*waited 0 seconds/i);
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
});

test('a killed waiter ticket is dropped before the next waiter compares the queue', async (t) => {
  const f = fixture(t, 'herdr-suite-dead-ticket-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const holder = lockOptions(f, 'ws:a', panes);
  acquireProjectLock('full-suite', { ...holder, kind: 'manual' });
  let holderOwnsLock = true;
  const dead = startLockWaiter(t, f, 'ws:b', panes);
  let next;
  try {
    await waitFor(() => readQueueFiles(f.dataDir).some((ticket) => ticket.pane === 'ws:b'), 'the first waiter did not take a ticket');
    dead.child.kill('SIGKILL');
    await dead.exited;
    next = startLockWaiter(t, f, 'ws:c', panes);
    await waitFor(() => {
      const tickets = readQueueFiles(f.dataDir);
      return tickets.length === 1 && tickets[0].pane === 'ws:c' ? tickets : false;
    }, 'the next waiter did not remove the killed waiter ticket');
    releaseProjectLock('full-suite', holder);
    holderOwnsLock = false;
    assert.equal((await next.nextMessage('acquired')).pane, 'ws:c');
    next.release();
    assert.equal((await next.nextMessage('released')).pane, 'ws:c');
    assert.deepEqual(readQueueFiles(f.dataDir), []);
  } finally {
    if (holderOwnsLock && fs.existsSync(f.lockFile)) releaseProjectLock('full-suite', holder);
  }
});

test('a wait deadline removes its ticket', (t) => {
  const f = fixture(t, 'herdr-suite-deadline-ticket-');
  const panes = ['ws:a', 'ws:b'];
  const holder = lockOptions(f, 'ws:a', panes);
  acquireProjectLock('full-suite', { ...holder, kind: 'manual' });
  let clock = Date.now();
  let error;
  try {
    acquireProjectLock('full-suite', {
      ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 1,
      now: () => clock, pause: (milliseconds) => { clock += milliseconds; },
    });
  } catch (caught) { error = caught; }
  assert.equal(error?.exitCode, 75);
  assert.deepEqual(readQueueFiles(f.dataDir), []);
  releaseProjectLock('full-suite', holder);
});

test('a no-wait acquire fails while a live ticket waits and reports the queue length', async (t) => {
  const f = fixture(t, 'herdr-suite-no-wait-queue-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const holder = lockOptions(f, 'ws:a', panes);
  acquireProjectLock('full-suite', { ...holder, kind: 'manual' });
  const waiter = startLockWaiter(t, f, 'ws:b', panes);
  try {
    await waitFor(() => readQueueFiles(f.dataDir).length === 1, 'the queued waiter did not take a ticket');
    assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], lockOptions(f, 'ws:c', panes)),
      /held by active pane ws:a .*queue length 1/i);
  } finally {
    waiter.child.kill('SIGTERM');
    await waiter.exited;
    if (fs.existsSync(f.lockFile)) releaseProjectLock('full-suite', holder);
  }
  const acquired = acquireProjectLock('full-suite', lockOptions(f, 'ws:c', panes));
  assert.equal(acquired.ownerPane, 'ws:c', 'the next acquire removes the dead ticket');
  releaseProjectLock('full-suite', lockOptions(f, 'ws:c', panes));
});

test('a broken lock queue ticket is skipped and never blocks the queue', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readLockQueue } = await import('../src/kit/locks.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-queue-broken-'));
  const queue = path.join(dataDir, 'locks', 'machine', 'queue', 'full-suite');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, '00000000-0000-4000-8000-000000000001.json'), '{"id": "00000000-0000-4000-8000-0000');
  const tickets = readLockQueue({ dataDir, livePanes: new Set(), pidAlive: () => false });
  assert.ok(Array.isArray(tickets.queue ?? tickets));
});

test('suite records a clean pass and reuses it only when requested', (t) => {
  const f = fixture(t, 'herdr-suite-cache-reuse-');
  assert.equal(f.run([]).exitCode, 0);

  const file = path.join(f.dataDir, 'suite-passes.json');
  const firstRecords = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(firstRecords.length, 1);
  assert.deepEqual(firstRecords[0], {
    repo: fs.realpathSync(path.join(f.root, '.git')),
    tree: git(f.root, 'write-tree'),
    command: [process.execPath, f.script, '0'],
    tested: firstRecords[0].tested,
    node: process.version,
    time: firstRecords[0].time,
  });
  assert.match(firstRecords[0].tested, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(firstRecords[0].time)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(f.run([]).exitCode, 0, 'a pass is not reused by default');
  assert.equal(f.readSeen().runs, 2);
  const recordsBeforeReuse = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(recordsBeforeReuse.length, 2);
  assert.equal(f.run([], 3).exitCode, 3, 'a failed command returns its status');
  assert.equal(f.readSeen().runs, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2, 'a failed command adds no pass');
  const acquiredBeforeReuse = f.lines.filter((line) => /Lock full-suite acquired/.test(line)).length;

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 3, 'the matching command does not run again');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2);
  assert.equal(f.lines.filter((line) => /Lock full-suite acquired/.test(line)).length, acquiredBeforeReuse, 'reuse does not take the lock');
  assert.ok(f.lines.includes(`suite: reused the pass of ${recordsBeforeReuse.at(-1).time} for tree ${recordsBeforeReuse.at(-1).tree.slice(0, 12)}`));
});

test('suite does not reuse a pass for a different command or Node version', (t) => {
  const commandFixture = fixture(t, 'herdr-suite-cache-command-');
  assert.equal(commandFixture.run([]).exitCode, 0);
  assert.equal(commandFixture.run(['--reuse'], 3).exitCode, 3);
  assert.equal(commandFixture.readSeen().runs, 2, 'a different command runs');

  const nodeFixture = fixture(t, 'herdr-suite-cache-node-');
  assert.equal(nodeFixture.run([]).exitCode, 0);
  const file = path.join(nodeFixture.dataDir, 'suite-passes.json');
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  records[0].node = 'v0.0.0';
  fs.writeFileSync(file, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  assert.equal(nodeFixture.run(['--reuse']).exitCode, 0);
  assert.equal(nodeFixture.readSeen().runs, 2, 'a different Node version does not match');
});

test('the pre-push environment variable implies suite pass reuse', (t) => {
  const f = fixture(t, 'herdr-suite-cache-hook-env-');
  assert.equal(f.run([]).exitCode, 0);
  f.env.HERDR_BOSS_SUITE_REUSE = '1';

  assert.equal(f.run([]).exitCode, 0);
  assert.equal(f.readSeen().runs, 1);
});

test('suite does not reuse a pass after a tracked file changes', (t) => {
  const f = fixture(t, 'herdr-suite-cache-tree-');
  assert.equal(f.run([]).exitCode, 0);
  fs.writeFileSync(path.join(f.root, 'README.md'), 'changed tree\n');
  git(f.root, 'add', 'README.md');
  git(f.root, 'commit', '-m', 'change tree');

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2);
});

test('suite neither records a dirty starting tree nor a tree changed during the command', (t) => {
  const dirty = fixture(t, 'herdr-suite-cache-dirty-');
  fs.writeFileSync(path.join(dirty.root, 'untracked.txt'), 'dirty\n');
  assert.equal(dirty.run(['--reuse']).exitCode, 0);
  assert.equal(dirty.readSeen().runs, 1);
  assert.equal(fs.existsSync(path.join(dirty.dataDir, 'suite-passes.json')), false);

  const changed = fixture(t, 'herdr-suite-cache-changed-during-');
  const mutation = path.join(changed.base, 'change-tree.mjs');
  fs.writeFileSync(mutation, [
    "import fs from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    `fs.writeFileSync(${JSON.stringify(path.join(changed.root, 'README.md'))}, 'changed during suite\\n');`,
    `execFileSync('git', ['-C', ${JSON.stringify(changed.root)}, 'add', 'README.md']);`,
    `execFileSync('git', ['-C', ${JSON.stringify(changed.root)}, 'commit', '-m', 'changed during suite'], { stdio: 'ignore' });`,
  ].join('\n'));

  assert.equal(changed.runCommand([], [process.execPath, mutation]).exitCode, 0);
  assert.equal(git(changed.root, 'status', '--porcelain'), '', 'the command leaves the new tree clean');
  assert.equal(fs.existsSync(path.join(changed.dataDir, 'suite-passes.json')), false, 'the pass is not recorded under the old tree');
});

test('suite lists the ten most recent pass records', (t) => {
  const f = fixture(t, 'herdr-suite-cache-list-');
  assert.equal(f.run([]).exitCode, 0);
  const records = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'suite-passes.json'), 'utf8'));
  f.lines.length = 0;

  const listed = runKitCommand('suite', ['--list-passes'], f.options());

  assert.equal(listed.length, 1);
  assert.ok(f.lines.some((line) => line.includes(records[0].time)));
  assert.ok(f.lines.some((line) => line.includes('repo')));
  assert.ok(f.lines.some((line) => line.includes(records[0].tree.slice(0, 12))));
  assert.ok(f.lines.some((line) => line.includes(JSON.stringify(records[0].command))));
});

test('suite keeps only the last 200 pass records', (t) => {
  const f = fixture(t, 'herdr-suite-cache-limit-');
  assert.equal(f.run([]).exitCode, 0);
  const file = path.join(f.dataDir, 'suite-passes.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  fs.writeFileSync(file, `${JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ ...record, time: new Date(index).toISOString() })))}\n`, { mode: 0o600 });

  assert.equal(f.run([]).exitCode, 0);
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(records.length, 200);
  assert.notEqual(records[0].time, record.time);
});

test('suite records the hash of each lockfile in the pass key', (t) => {
  const f = fixture(t, 'herdr-suite-cache-lock-record-');
  fs.writeFileSync(path.join(f.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(f.root, 'yarn.lock'), '# yarn\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'add lockfiles');
  assert.equal(f.run([]).exitCode, 0);
  const [record] = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'suite-passes.json'), 'utf8'));
  assert.deepEqual(Object.keys(record.locks).sort(), ['package-lock.json', 'yarn.lock']);
  for (const hash of Object.values(record.locks)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 1, 'unchanged lockfiles reuse the pass');
});

test('suite does not reuse a pass after an ignored lockfile changes', (t) => {
  const f = fixture(t, 'herdr-suite-cache-lock-ignored-');
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'pnpm-lock.yaml\n');
  git(f.root, 'add', '.gitignore');
  git(f.root, 'commit', '-m', 'ignore lockfile');
  fs.writeFileSync(path.join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.equal(f.run([]).exitCode, 0);
  assert.equal(git(f.root, 'status', '--porcelain'), '', 'the ignored lockfile leaves the tree clean');
  fs.writeFileSync(path.join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2, 'a changed lockfile runs the command');
});

test('suite does not record a pass when a lockfile changes during the command', (t) => {
  const f = fixture(t, 'herdr-suite-cache-lock-during-');
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'package-lock.json\n');
  git(f.root, 'add', '.gitignore');
  git(f.root, 'commit', '-m', 'ignore lockfile');
  const install = path.join(f.base, 'install.mjs');
  fs.writeFileSync(install, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(f.root, 'package-lock.json'))}, '{}\\n');\n`);
  assert.equal(f.runCommand([], [process.execPath, install]).exitCode, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'suite-passes.json')), false);
});

test('a queue ticket file is never visible before its content is complete', (t) => {
  const f = fixture(t, 'herdr-suite-ticket-atomic-');
  const options = lockOptions(f, 'ws:orch', ['ws:orch', 'ws:w1'], {});
  acquireProjectLock('full-suite', options);
  const queueDirectory = path.join(f.dataDir, 'locks', 'machine', 'queue', 'full-suite');
  const seen = [];
  let ticketWrites = 0;
  const original = fs.writeFileSync;
  fs.writeFileSync = function patched(target, ...rest) {
    // Record each published ticket file that cannot be parsed while the writer is still writing.
    if (typeof target === 'number' && fs.existsSync(queueDirectory)) {
      if (fs.readdirSync(queueDirectory).some((entry) => entry.endsWith('.json') || entry.endsWith('.tmp'))) ticketWrites += 1;
      for (const name of fs.readdirSync(queueDirectory).filter((entry) => entry.endsWith('.json'))) {
        try { JSON.parse(fs.readFileSync(path.join(queueDirectory, name), 'utf8')); } catch { seen.push(name); }
      }
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.throws(() => acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:w1', ['ws:orch', 'ws:w1'], {}), waitSeconds: 0 }), /lock|held|queue/i);
  } finally {
    fs.writeFileSync = original;
  }
  assert.deepEqual(seen, [], 'no ticket file is unreadable while it is written');
  assert.equal(ticketWrites, 1, 'the test observed one ticket write');
  assert.deepEqual(fs.readdirSync(queueDirectory).filter((name) => name.endsWith('.tmp')), [], 'no temporary file remains');
});

function commitFile(root, file, content, message = 'change') {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

const readPasses = (f) => JSON.parse(fs.readFileSync(path.join(f.dataDir, 'suite-passes.json'), 'utf8'));

test('a change to an untested path reuses the pass without --reuse', (t) => {
  const f = fixture(t, 'herdr-suite-untested-hit-');
  assert.equal(f.run([]).exitCode, 0);
  commitFile(f.root, '.worker/report.md', 'notes\n');
  commitFile(f.root, '.orchestration/runs/a.json', '{}\n');

  assert.equal(f.run([]).exitCode, 0);
  assert.equal(f.readSeen().runs, 1, 'the suite does not run again');
  assert.ok(f.lines.some((line) => /^suite: reused the pass of /.test(line)), f.lines.join('\n'));
  assert.equal(readPasses(f).length, 1);
});

test('a change to a tested path misses the pass', (t) => {
  const f = fixture(t, 'herdr-suite-untested-miss-');
  assert.equal(f.run([]).exitCode, 0);
  commitFile(f.root, '.worker/report.md', 'notes\n');
  commitFile(f.root, 'README.md', 'changed\n');

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2);
  commitFile(f.root, 'docs/guide.md', 'doc\n');
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 3, 'a docs file is tested');
});

test('an identical tree without --reuse still runs', (t) => {
  const f = fixture(t, 'herdr-suite-untested-fresh-');
  assert.equal(f.run([]).exitCode, 0);
  assert.equal(f.run([]).exitCode, 0);
  assert.equal(f.readSeen().runs, 2);
});

test('an untracked file in an untested path does not block the pass', (t) => {
  const f = fixture(t, 'herdr-suite-untested-untracked-');
  fs.mkdirSync(path.join(f.root, '.worker'));
  fs.writeFileSync(path.join(f.root, '.worker', 'scratch.log'), 'log\n');
  assert.equal(f.run([]).exitCode, 0);
  assert.equal(readPasses(f).length, 1);
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 1);
  fs.writeFileSync(path.join(f.root, 'scratch.txt'), 'tested path\n');
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2, 'an untracked file in a tested path runs the suite');
  assert.equal(readPasses(f).length, 1, 'and records no pass');
});

test('suiteUntested in .herdr-boss.json adds untested paths, and a changed list misses', (t) => {
  const f = fixture(t, 'herdr-suite-untested-config-');
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ suiteUntested: ['notes/**'] }));
  git(f.root, 'add', '.herdr-boss.json');
  git(f.root, 'commit', '-m', 'config');
  const config = loadProjectConfig({ cwd: f.root });
  assert.deepEqual(config.suiteUntested, ['notes/**']);
  assert.equal(f.run([], 0, { config }).exitCode, 0);
  commitFile(f.root, 'notes/a.txt', 'a\n');
  assert.equal(f.run([], 0, { config }).exitCode, 0);
  assert.equal(f.readSeen().runs, 1, 'a file under notes is untested');
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2, 'the default list does not cover notes');
});

test('suiteUntested refuses an absolute path or a parent segment', (t) => {
  const f = fixture(t, 'herdr-suite-untested-invalid-');
  for (const bad of [['/etc/**'], ['../x'], [''], 'notes', ['a/b/../c'], ['**'], ['*'], ['src/**'], ['package.json'], ['**/*.md'], ['*/x.js'],
    ['test/**'], ['public/*'], ['kit/**'], ['.github/**'], ['docs/**'], ['.herdr-boss.json'], ['package-lock.json'], ['bin/**'], ['kit/CHANGES.md'], ['docs/cli.md']]) {
    fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ suiteUntested: bad }));
    assert.throws(() => loadProjectConfig({ cwd: f.root }), /suiteUntested/);
  }
});

test('a merge commit with the tree of a passed branch reuses the pass', (t) => {
  const f = fixture(t, 'herdr-suite-merge-hit-');
  git(f.root, 'checkout', '-b', 'feature');
  commitFile(f.root, 'README.md', 'feature\n');
  assert.equal(f.run([]).exitCode, 0);
  git(f.root, 'checkout', 'main');
  git(f.root, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  assert.equal(git(f.root, 'rev-parse', 'HEAD^{tree}'), git(f.root, 'rev-parse', 'feature^{tree}'));

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 1);
});

test('a merge commit whose tree differs from the passed branch misses', (t) => {
  const f = fixture(t, 'herdr-suite-merge-miss-');
  git(f.root, 'checkout', '-b', 'feature');
  commitFile(f.root, 'feature.txt', 'feature\n');
  assert.equal(f.run([]).exitCode, 0);
  git(f.root, 'checkout', 'main');
  commitFile(f.root, 'main.txt', 'main\n');
  git(f.root, 'merge', '--no-ff', 'feature', '-m', 'merge feature');

  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2);
});

test('a changed ignored lockfile misses the pass', (t) => {
  const f = fixture(t, 'herdr-suite-lockfile-');
  commitFile(f.root, '.gitignore', 'package-lock.json\n');
  fs.writeFileSync(path.join(f.root, 'package-lock.json'), 'one\n');
  assert.equal(f.run([]).exitCode, 0);
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 1);
  fs.writeFileSync(path.join(f.root, 'package-lock.json'), 'two\n');
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2);
});

test('a pass made in another worktree of the repository is reused', (t) => {
  const f = fixture(t, 'herdr-suite-worktree-');
  assert.equal(f.run([]).exitCode, 0);
  const other = path.join(f.base, 'other');
  git(f.root, 'worktree', 'add', '--detach', other);
  const config = loadProjectConfig({ cwd: other });
  assert.equal(f.run(['--reuse'], 0, { config }).exitCode, 0);
  assert.equal(f.readSeen().runs, 1);
});

test('an invalid suiteUntested list is ignored as a whole by the key', async (t) => {
  const { cleanTreeKey, DEFAULT_SUITE_UNTESTED } = await import('../src/kit/suite-passes.js');
  const f = fixture(t, 'herdr-suite-untested-ignored-');
  const fallback = cleanTreeKey(f.root, DEFAULT_SUITE_UNTESTED);
  assert.equal(cleanTreeKey(f.root, ['**']).tested, fallback.tested);
  assert.equal(cleanTreeKey(f.root, ['notes/**', 'src/**']).tested, fallback.tested);
  assert.notEqual(cleanTreeKey(f.root, ['notes/**']).tested, fallback.tested);
});

test('dir/** matches only paths below dir, never dir itself', async (t) => {
  const { globMatches } = await import('../src/kit/config.js');
  assert.equal(globMatches('.worker/**', '.worker'), false);
  assert.equal(globMatches('.worker/**', '.worker/a'), true);
  assert.equal(globMatches('.worker/**', '.worker/a/b.md'), true);
  assert.equal(globMatches('**', 'a'), true);
  assert.equal(globMatches('a/**/b', 'a/b'), true);

  const f = fixture(t, 'herdr-suite-untested-file-named-dir-');
  assert.equal(f.run([]).exitCode, 0);
  commitFile(f.root, '.worker', 'a tracked file named like the folder\n');
  assert.equal(f.run(['--reuse']).exitCode, 0);
  assert.equal(f.readSeen().runs, 2, 'a tracked file named .worker is tested');
});
