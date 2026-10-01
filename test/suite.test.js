import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { acquireProjectLock, listProjectLocks, readLockQueue, readMachineLocks, recordLockRelease, releaseProjectLock, withMutationLock } from '../src/kit/locks.js';
import { POLICY_DEFAULTS } from '../src/control.js';
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
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ locks: POLICY_DEFAULTS.locks }));
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

function startLockWaiter(t, f, pane, panes, { waitSeconds = 30, noticesFile = null, clockFile = null } = {}) {
  const script = path.join(f.base, `${pane.replaceAll(':', '-')}.mjs`);
  const locksUrl = pathToFileURL(path.resolve('src/kit/locks.js')).href;
  const configUrl = pathToFileURL(path.resolve('src/kit/config.js')).href;
  fs.writeFileSync(script, `
    import { acquireProjectLock, releaseProjectLock } from ${JSON.stringify(locksUrl)};
    import { loadProjectConfig } from ${JSON.stringify(configUrl)};
    const panes = ${JSON.stringify(panes)};
    const fs = await import('node:fs');
    const noticesFile = ${JSON.stringify(noticesFile)};
    const clockFile = ${JSON.stringify(clockFile)};
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
      if (args[0] === 'pane' && args[1] === 'list') return { panes: panes.map((pane_id) => ({ pane_id })) };
      throw new Error('Unexpected Herdr call: ' + args.join(' '));
    };
    const config = loadProjectConfig({ cwd: process.argv[2] });
    const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: process.argv[4] };
    const options = { config, env, herdr, dataDir: process.argv[3], waitSeconds: Number(process.argv[5]), kind: 'suite',
      now: () => clockFile ? Number(fs.readFileSync(clockFile, 'utf8')) : Date.now(),
      output: (line) => { if (noticesFile) fs.appendFileSync(noticesFile, line + '\\n'); } };
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

function configureLockSettings(f, locks) {
  fs.mkdirSync(f.dataDir, { recursive: true });
  // Saved policies include the defaults, as savePolicy does at the real boundary.
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({ locks: {
    ...POLICY_DEFAULTS.locks, ...locks, guard: { ...POLICY_DEFAULTS.locks.guard, ...locks.guard },
  } }));
}

function seedLockHistory(f, kind = 'suite', holdMs = 60_000, count = 3) {
  const now = Date.now();
  for (let index = 0; index < count; index++) recordLockRelease({
    name: 'full-suite', project: f.config.slug, kind,
  }, { dataDir: f.dataDir, now: now - index * 60_000, holdMs });
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

test('a claim publishes the guard with its owner record, and a release removes the whole guard', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mutation-atomic-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guard = path.join(directory, '.mutation');
  const summaryFile = path.join(directory, 'samples.json');
  const sampler = path.join(directory, 'sampler.mjs');
  // The sampler reads the guard folder while another process claims and releases it. It records the contents of the folder
  // and checks that the same folder was there before and after the read. A claim or a release that works in two steps
  // leaves a folder without owner.json.
  fs.writeFileSync(sampler, [
    "import fs from 'node:fs';",
    `const guard = ${JSON.stringify(guard)};`,
    `const summaryFile = ${JSON.stringify(summaryFile)};`,
    'const wanted = 400;',
    'const deadline = Date.now() + 20000;',
    'const seen = [];',
    'const statOf = () => { try { return fs.statSync(guard); } catch { return null; } };',
    'for (;;) {',
    '  const before = statOf();',
    '  if (before) {',
    '    let names = null;',
    '    try { names = fs.readdirSync(guard); } catch { names = null; }',
    '    const after = statOf();',
    '    // A folder that was removed while the read ran keeps its name for the reader. Skip that sample.',
    '    if (names && after && after.dev === before.dev && after.ino === before.ino) {',
    '      seen.push(names.sort().join(\',\'));',
    '    }',
    '  } else {',
    '    await new Promise((resolve) => setTimeout(resolve, 1));',
    '  }',
    '  if (seen.length >= wanted || Date.now() >= deadline) break;',
    '}',
    "fs.writeFileSync(summaryFile, JSON.stringify({ seen }));",
  ].join('\n'));

  const child = spawn(process.execPath, [sampler], { stdio: ['ignore', 'ignore', 'inherit'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const deadline = Date.now() + 30_000;
  let claims = 0;
  while (!fs.existsSync(summaryFile) && Date.now() < deadline) {
    withMutationLock(directory, () => { claims += 1; });
  }

  assert.ok(fs.existsSync(summaryFile), 'the sampler did not finish inside its deadline');
  const { seen } = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.ok(seen.length >= 100, `the sampler saw the guard ${seen.length} times, which is too few`);
  assert.ok(claims >= 100, `this process made ${claims} claims, which is too few`);
  assert.deepEqual([...new Set(seen)], ['owner.json'], 'every observation of the guard folder also found its owner record');
});

test('suite releases the lock when the command cannot start', (t) => {
  const f = fixture(t, 'herdr-suite-missing-');
  const result = runKitCommand('suite', ['--', path.join(f.base, 'no-such-command')], f.options());
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a killed test child releases the suite slot while the wrapper PID remains alive', (t) => {
  const f = fixture(t, 'herdr-suite-killed-child-');
  const result = f.runCommand([], [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(result.exitCode, 1);
  assert.equal(fs.existsSync(f.lockFile), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'the calling wrapper remains alive');
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
      assert.deepEqual(Object.keys(tickets[0]).sort(), ['command', 'createdAt', 'id', 'kind', 'lane', 'pane', 'pid', 'pidStart', 'predictedMs', 'project', 'seq']);
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
  assert.ok(output.some((line) => /waiting for full-suite, lane long, position 1 of 1, held by .* ws:a \(manual\).*queue length 1/.test(line)));
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
  const waits = output.filter((line) => line.startsWith('waiting for full-suite'));
  assert.deepEqual(waits.map((line) => /position (\d+ of \d+)/.exec(line)?.[1]), ['2 of 2', '1 of 1']);
  for (const line of waits) assert.match(line, /lane long.*held by .* ws:a \(manual\).*started .*age .*predicted end .*queue length/);
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

test('a predicted short suite acquires a short slot beside a long holder', (t) => {
  const f = fixture(t, 'herdr-suite-short-lane-');
  const panes = ['ws:a', 'ws:b'];
  fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({ locks: { slots: 2, shortLimitMinutes: 6 } }));
  const now = Date.now();
  for (let index = 0; index < 3; index++) recordLockRelease({
    name: 'full-suite', project: f.config.slug, kind: 'suite',
  }, { dataDir: f.dataDir, now: now - index * 60000, holdMs: 60000 });
  const long = lockOptions(f, 'ws:a', panes);
  const short = lockOptions(f, 'ws:b', panes);
  const holder = acquireProjectLock('full-suite', { ...long, kind: 'manual' });

  const acquired = acquireProjectLock('full-suite', { ...short, kind: 'suite', waitSeconds: 0 });
  const shortFile = path.join(f.dataDir, 'locks', 'machine', 'full-suite.short.1.json');
  assert.equal(fs.existsSync(shortFile), true);
  const record = JSON.parse(fs.readFileSync(shortFile, 'utf8'));
  assert.equal(record.lane, 'short');
  assert.equal(record.slot, 1);
  assert.equal(record.predictedMs, 60000);
  assert.equal(acquired.ownerPane, 'ws:b');
  releaseProjectLock('full-suite', { ...short, kind: 'suite' });
  releaseProjectLock('full-suite', long);
});

test('the machine guard keeps a short ticket queued until the latest sample passes', (t) => {
  const f = fixture(t, 'herdr-suite-short-guard-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, {
    slots: 2, shortLimitMinutes: 6,
    guard: { enabled: true, maxLoadPercent: 100, maxSwapPercent: 90, minFreeMemPercent: 40 },
  });
  seedLockHistory(f);
  let nowMs = Date.now();
  const clock = () => nowMs;
  const long = lockOptions(f, 'ws:a', panes, { now: clock });
  acquireProjectLock('full-suite', { ...long, kind: 'manual' });
  const samples = [
    { at: new Date(nowMs).toISOString(), l5: 2, cpus: 1, swapMB: 10, swapTotalMB: 100, memFree: 70 },
    { at: new Date(nowMs).toISOString(), l5: 0.5, cpus: 1, swapMB: 10, swapTotalMB: 100, memFree: 70 },
  ];
  let sampleIndex = 0;
  const lines = [];
  const short = lockOptions(f, 'ws:b', panes, {
    now: clock,
    pause: (ms) => { nowMs += ms; },
    readMachineSample: () => samples[Math.min(sampleIndex++, samples.length - 1)],
    output: (line) => lines.push(line),
  });

  const acquired = acquireProjectLock('full-suite', { ...short, kind: 'suite', waitSeconds: 1 });

  assert.equal(acquired.lane, 'short');
  assert.ok(lines.some((line) => /^waiting for full-suite.*lane short.*short lane paused: load 200% exceeds 100%$/.test(line)));
  assert.ok(sampleIndex >= 2, 'the guard reads again after the sample fails');
  assert.deepEqual(readQueueFiles(f.dataDir), []);
  releaseProjectLock('full-suite', short);
  releaseProjectLock('full-suite', long);
});

test('the machine guard does not read a sample without a long holder or for a long job', (t) => {
  const f = fixture(t, 'herdr-suite-short-guard-bypass-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2, shortLimitMinutes: 6, guard: { enabled: true } });
  seedLockHistory(f);
  let sampleReads = 0;
  const readMachineSample = () => { sampleReads++; throw new Error('sample reader should not run'); };
  const options = (pane) => lockOptions(f, pane, panes, { readMachineSample });

  const short = acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'suite', waitSeconds: 0 });
  const long = acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'manual', waitSeconds: 0 });

  assert.equal(short.lane, 'short');
  assert.equal(long.lane, 'long');
  assert.equal(sampleReads, 0);
  releaseProjectLock('full-suite', options('ws:a'));
  releaseProjectLock('full-suite', options('ws:b'));
});

test('lock list text and returned data show holder and ticket lanes, slots, and predictions', (t) => {
  const f = fixture(t, 'herdr-suite-lock-list-lanes-');
  configureLockSettings(f, { slots: 2, shortLimitMinutes: 6 });
  seedLockHistory(f);
  const options = lockOptions(f, 'ws:orch', ['ws:orch']);
  acquireProjectLock('full-suite', { ...options, kind: 'suite', waitSeconds: 0 });
  const queue = path.join(f.dataDir, 'locks', 'machine', 'queue', 'full-suite');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const ticket = {
    id: '00000000-0000-4000-8000-000000000042', seq: 1, pane: 'ws:orch', project: f.config.slug, pid: process.pid,
    kind: 'suite', lane: 'long', predictedMs: 300000, command: 'herdr-boss lock acquire full-suite',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(queue, `${ticket.id}.json`), JSON.stringify(ticket), { mode: 0o600 });
  const lines = [];
  const locks = listProjectLocks({ ...options, output: (line) => lines.push(line), pidAlive: () => true });
  const lock = locks.find((entry) => entry.name === 'full-suite');

  assert.equal(lock.lane, 'short');
  assert.equal(lock.predictedMs, 60000);
  assert.equal(lock.queue[0].lane, 'long');
  assert.equal(lock.queue[0].predictedMs, 300000);
  assert.match(lines.join('\n'), /lane short, short slot 1, 1 of 2 slots in use, predicted 1m/);
  assert.match(lines.join('\n'), new RegExp(`1\\. ${f.config.slug} ws:orch \\(suite\\) long lane, predicted 5m, 1 of 2 slots in use`));
  assert.equal(JSON.parse(JSON.stringify(locks))[0].queue[0].slotsInUse, 1);
  releaseProjectLock('full-suite', options);
});

test('slots 3 lets two predicted short suites hold separate short slots', (t) => {
  const f = fixture(t, 'herdr-suite-two-short-slots-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 3, shortLimitMinutes: 6 });
  seedLockHistory(f);
  const first = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'suite', waitSeconds: 0 });
  const second = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 });
  assert.equal(first.lane, 'short');
  assert.equal(second.lane, 'short');
  assert.deepEqual([first.slot, second.slot].sort(), [1, 2]);
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
  releaseProjectLock('full-suite', lockOptions(f, 'ws:b', panes));
});

test('one configured slot keeps short predictions in the exclusive long queue', (t) => {
  const f = fixture(t, 'herdr-suite-one-lock-slot-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 1, shortLimitMinutes: 6 });
  seedLockHistory(f);
  const holder = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'manual' });
  assert.throws(() => acquireProjectLock('full-suite', {
    ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0,
  }), (error) => error.exitCode === 75);
  assert.deepEqual(readQueueFiles(f.dataDir), []);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'full-suite.short.1.json')), false);
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
});

test('a short job borrows the free long slot only after short slots fill and no long ticket waits', (t) => {
  const f = fixture(t, 'herdr-suite-work-conserving-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  configureLockSettings(f, { slots: 2, shortLimitMinutes: 6 });
  seedLockHistory(f);
  const first = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'suite', waitSeconds: 0 });
  const second = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 });
  assert.equal(first.slot, 1);
  assert.equal(second.slot, 'long');
  assert.throws(() => acquireProjectLock('full-suite', {
    ...lockOptions(f, 'ws:c', panes), kind: 'manual', waitSeconds: 0,
  }), (error) => error.exitCode === 75, 'a long job waits for the borrowed long slot');
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
  releaseProjectLock('full-suite', lockOptions(f, 'ws:b', panes));
});

test('a stale short record is removed without blocking a long job', (t) => {
  const f = fixture(t, 'herdr-suite-stale-short-lane-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2, shortLimitMinutes: 6 });
  seedLockHistory(f);
  const stale = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'suite', waitSeconds: 0 });
  assert.equal(stale.slot, 1);
  const long = acquireProjectLock('full-suite', {
    ...lockOptions(f, 'ws:b', panes), kind: 'manual', waitSeconds: 0, pidAlive: () => false,
  });
  assert.equal(long.lane, 'long');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'full-suite.short.1.json')), false);
  releaseProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), pidAlive: () => false });
});

test('a re-entrant suite keeps a predicted short push lane', (t) => {
  const f = fixture(t, 'herdr-suite-short-reentry-');
  const panes = ['ws:a'];
  configureLockSettings(f, { slots: 2, shortLimitMinutes: 6 });
  seedLockHistory(f, 'push', 45_000);
  const token = 'push-reentry-short-token-0001';
  const options = { ...lockOptions(f, 'ws:a', panes), pidAlive: (pid) => pid === process.pid };
  const push = acquireProjectLock('full-suite', { ...options, kind: 'push', reentryToken: token });
  assert.equal(push.lane, 'short');
  assert.equal(push.slot, 1);
  const hook = acquireProjectLock('full-suite', {
    ...options, env: { ...options.env, HERDR_BOSS_LOCK_TOKEN: token }, kind: 'suite', waitSeconds: 0,
  });
  assert.equal(hook.reentrant, true);
  assert.equal(hook.lane, 'short');
  assert.equal(hook.slot, 1);
  releaseProjectLock('full-suite', { ...options, env: { ...options.env, HERDR_BOSS_LOCK_TOKEN: token } });
  const retained = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'locks', 'machine', 'full-suite.short.1.json'), 'utf8'));
  assert.equal(retained.kind, 'push');
  releaseProjectLock('full-suite', options);
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


// LK3 review regressions use the file-backed admission boundary and a fake clock.
test('LK3 R1 a saved capacity reduction blocks admission beside an existing short holder', (t) => {
  const f = fixture(t, 'herdr-lk3-reduced-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const holder = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'suite' });
  assert.equal(holder.slot, 1);
  configureLockSettings(f, { slots: 1 });
  assert.throws(() => acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 }),
    (error) => error.exitCode === 75);
});

for (const change of ['capacity', 'enable guard', 'disable guard', 'short limit']) {
  test(`LK3 R2 queued admission reloads policy: ${change}`, (t) => {
    const f = fixture(t, 'herdr-lk3-policy-');
    const panes = ['ws:a', 'ws:b', 'ws:c'];
    const locks = { slots: 2, shortLimitMinutes: 6, guard: { enabled: change === 'disable guard', maxLoadPercent: 100 } };
    configureLockSettings(f, locks);
    seedLockHistory(f, 'suite', 120000);
    let nowMs = Date.now();
    const options = (pane) => lockOptions(f, pane, panes, { now: () => nowMs });
    acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'manual' });
    if (change !== 'disable guard') acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite' });
    const sample = { at: new Date(nowMs).toISOString(), l5: 2, cpus: 1 };
    let pauses = 0;
    let sequence;
    const waiter = { ...options('ws:b'), kind: 'suite', waitSeconds: 1,
      readMachineSample: () => sample,
      pause: (ms) => {
        nowMs += ms;
        const [ticket] = readQueueFiles(f.dataDir);
        assert.ok(ticket, 'the job keeps its queue ticket while waiting');
        sequence ??= ticket.seq;
        assert.equal(ticket.seq, sequence, 'a retry keeps the ticket sequence');
        if (pauses++ !== 0) return;
        if (change === 'capacity') locks.slots = 1;
        if (change === 'enable guard') locks.guard.enabled = true;
        if (change === 'disable guard') locks.guard.enabled = false;
        if (change === 'short limit') locks.shortLimitMinutes = 1;
        configureLockSettings(f, locks);
        if (change !== 'disable guard') releaseProjectLock('full-suite', options('ws:c'));
      },
    };
    if (change === 'capacity' || change === 'enable guard') {
      assert.throws(() => acquireProjectLock('full-suite', waiter), (error) => error.exitCode === 75);
    } else {
      const lock = acquireProjectLock('full-suite', waiter);
      assert.equal(lock.lane, 'short', 'the ticket keeps its classification when the short limit changes');
      assert.equal(lock.slot, 1);
    }
    assert.ok(pauses >= 1);
    assert.deepEqual(readQueueFiles(f.dataDir), []);
  });
}

function writeLegacyTicket(f, pane, seq = 41) {
  // Exact fields of the queue protocol at 0403d52, without lane or predictedMs.
  const ticket = { id: '00000000-0000-4000-8000-000000000041', seq, pane, project: f.config.slug,
    pid: process.pid, kind: 'suite', command: 'herdr-boss lock acquire full-suite', createdAt: new Date().toISOString() };
  const queue = path.join(f.dataDir, 'locks', 'machine', 'queue', 'full-suite');
  fs.mkdirSync(queue, { recursive: true });
  const file = path.join(queue, `${ticket.id}.json`);
  fs.writeFileSync(file, JSON.stringify(ticket));
  return { ticket, file, queue };
}

function writeLegacyHolder(f, pane, kind = 'suite') {
  // Exact holder fields of 0403d52, including the push token when needed.
  const record = { name: 'full-suite', scope: 'machine', project: f.config.slug,
    gitCommonDir: git(f.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ownerPane: pane, pid: process.pid, kind, command: 'herdr-boss lock acquire full-suite',
    acquiredAt: new Date().toISOString(), ...(kind === 'push' ? { reentryToken: 'legacy-push-reentry-fixture-0001' } : {}) };
  fs.mkdirSync(path.dirname(f.lockFile), { recursive: true });
  fs.writeFileSync(f.lockFile, JSON.stringify(record));
  return record;
}

test('LK3 R3 legacy holders block a short second job and a legacy push re-enters', (t) => {
  const f = fixture(t, 'herdr-lk3-legacy-holder-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  for (const kind of ['suite', 'push']) {
    const holder = writeLegacyHolder(f, 'ws:a', kind);
    const options = { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 };
    assert.throws(() => acquireProjectLock('full-suite', options), (error) => error.exitCode === 75);
    if (kind === 'push') {
      const hookOptions = { ...options, env: { ...options.env, HERDR_BOSS_LOCK_TOKEN: holder.reentryToken } };
      const hook = acquireProjectLock('full-suite', hookOptions);
      assert.equal(hook.reentrant, true);
      assert.equal(hook.slot, 'long');
      assert.deepEqual(readQueueFiles(f.dataDir), []);
      releaseProjectLock('full-suite', hookOptions);
      assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).reentryToken, holder.reentryToken);
    }
    releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
  }
});

test('LK3 R3 a legacy ticket keeps global FIFO and exclusive admission until it drains', (t) => {
  const f = fixture(t, 'herdr-lk3-legacy-ticket-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const legacy = writeLegacyTicket(f, 'ws:a');
  const options = { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 };
  assert.throws(() => acquireProjectLock('full-suite', options), (error) => error.exitCode === 75);
  fs.unlinkSync(legacy.file);
  assert.equal(acquireProjectLock('full-suite', options).slot, 1);
});

test('LK3 R4 a future sample does not mask a current stressed sample', (t) => {
  const f = fixture(t, 'herdr-lk3-future-sample-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2, guard: { enabled: true, maxLoadPercent: 100 } });
  seedLockHistory(f);
  const now = Date.now();
  acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', panes), kind: 'manual', now });
  const file = path.join(f.dataDir, 'machine-samples.jsonl');
  const stressed = { at: new Date(now).toISOString(), l5: 2, cpus: 1 };
  const future = { at: new Date(now + 86400000).toISOString(), l5: 0, cpus: 1 };
  fs.writeFileSync(file, [stressed, future].map(JSON.stringify).join('\n') + '\n');
  const options = { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0, now };
  assert.throws(() => acquireProjectLock('full-suite', options), (error) => error.exitCode === 75);
  fs.writeFileSync(file, JSON.stringify(future) + '\n');
  assert.equal(acquireProjectLock('full-suite', options).slot, 1, 'future-only data has no usable fresh sample and passes');
});

test('LK3 R5 a separate owner-pane release process releases a live command holder', async (t) => {
  const f = fixture(t, 'herdr-lk3-owner-release-');
  configureLockSettings(f, { slots: 1 });
  const panes = ['ws:a'];
  const holder = startLockWaiter(t, f, 'ws:a', panes);
  await holder.nextMessage('acquired');
  assert.notEqual(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).pid, process.pid);
  releaseProjectLock('full-suite', lockOptions(f, 'ws:a', panes));
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('LK3 R5 several live records from one pane require an explicit slot selector', (t) => {
  const f = fixture(t, 'herdr-lk3-release-slot-');
  const options = lockOptions(f, 'ws:a', ['ws:a']);
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  acquireProjectLock('full-suite', { ...options, kind: 'suite' });
  acquireProjectLock('full-suite', { ...options, kind: 'suite' });
  assert.throws(() => runKitCommand('lock', ['release', 'full-suite'], options), /--slot/);
  const selected = runKitCommand('lock', ['release', 'full-suite', '--slot', '1'], options);
  assert.equal(selected.slot, 1);
  assert.equal(fs.existsSync(f.lockFile), true);
  assert.equal(runKitCommand('lock', ['release', 'full-suite', '--slot', 'long'], options).slot, 'long');
});

test('LK3 R7 a short job borrowing the long slot does not activate the long-job guard', (t) => {
  const f = fixture(t, 'herdr-lk3-borrowed-guard-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const options = (pane) => lockOptions(f, pane, panes);
  acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'suite' });
  assert.equal(acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'suite' }).slot, 'long');
  releaseProjectLock('full-suite', options('ws:a'));
  const replacement = acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite', waitSeconds: 0,
    readMachineSample: () => { assert.fail('no long job holds, so the guard must not read a sample'); } });
  assert.equal(replacement.slot, 1);
});

for (const corrupt of ['', '{cut']) test(`LK3 R10 recovers a crashed queue sequence ${JSON.stringify(corrupt)}`, (t) => {
  const f = fixture(t, 'herdr-lk3-sequence-crash-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const { queue } = writeLegacyTicket(f, 'ws:a', 41);
  fs.writeFileSync(path.join(queue, '.sequence'), corrupt);
  let nowMs = Date.now();
  let observed = false;
  assert.throws(() => acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 1,
    now: () => nowMs, pause: (ms) => {
      nowMs += ms;
      const tickets = readQueueFiles(f.dataDir);
      assert.deepEqual(tickets.map((ticket) => ticket.seq), [41, 42]);
      observed = true;
    } }), (error) => error.exitCode === 75);
  assert.equal(observed, true);
  assert.equal(fs.readFileSync(path.join(queue, '.sequence'), 'utf8').trim(), '42');
});

test('LK3 R10 publishes a queue sequence atomically without truncating its old value', (t) => {
  const f = fixture(t, 'herdr-lk3-sequence-atomic-');
  const panes = ['ws:a', 'ws:b'];
  const { queue } = writeLegacyTicket(f, 'ws:a', 41);
  const sequenceFile = path.join(queue, '.sequence');
  fs.writeFileSync(sequenceFile, '41\n', { mode: 0o600 });
  const original = fs.writeFileSync;
  let sawSequenceWrite = false;
  fs.writeFileSync = function(target, content, ...rest) {
    if (content === '42\n') {
      sawSequenceWrite = true;
      assert.notEqual(target, sequenceFile, 'the published file must not be opened for truncation');
      assert.equal(fs.readFileSync(sequenceFile, 'utf8'), '41\n');
    }
    return original.call(this, target, content, ...rest);
  };
  try {
    assert.throws(() => acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes), kind: 'suite', waitSeconds: 0 }),
      (error) => error.exitCode === 75);
  } finally { fs.writeFileSync = original; }
  assert.equal(sawSequenceWrite, true);
  assert.equal(fs.readFileSync(sequenceFile, 'utf8'), '42\n');
  assert.equal(fs.statSync(sequenceFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(queue).filter((file) => file.endsWith('.tmp')), []);
});


test('LK3 R2 a real waiting process observes guard enable and disable without replacing its ticket', async (t) => {
  const f = fixture(t, 'herdr-lk3-process-policy-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const locks = { slots: 2, guard: { enabled: false, maxLoadPercent: 100 } };
  configureLockSettings(f, locks);
  seedLockHistory(f);
  const options = (pane) => lockOptions(f, pane, panes);
  acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'manual' });
  acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite' });
  fs.writeFileSync(path.join(f.dataDir, 'machine-samples.jsonl'), JSON.stringify({ at: new Date().toISOString(), l5: 2, cpus: 1 }));
  const noticesFile = path.join(f.base, 'waiter-notices.log');
  const clockFile = path.join(f.base, 'waiter-clock');
  const clock = Date.now();
  fs.writeFileSync(clockFile, String(clock));
  const waiter = startLockWaiter(t, f, 'ws:b', panes, { noticesFile, clockFile, waitSeconds: 180 });
  const queued = await waitFor(() => readQueueFiles(f.dataDir).find((ticket) => ticket.pane === 'ws:b'), 'the subprocess did not queue');
  locks.guard.enabled = true;
  configureLockSettings(f, locks);
  releaseProjectLock('full-suite', options('ws:c'));
  // Advance the notice clock to its next permitted line. Do not wait one real minute.
  const advancedClockFile = `${clockFile}.next`;
  fs.writeFileSync(advancedClockFile, String(clock + 60_000));
  fs.renameSync(advancedClockFile, clockFile);
  await waitFor(() => fs.existsSync(noticesFile) && fs.readFileSync(noticesFile, 'utf8').includes('short lane paused: load'), 'the subprocess ignored the newly enabled guard');
  assert.equal(readQueueFiles(f.dataDir).find((ticket) => ticket.pane === 'ws:b').seq, queued.seq);
  locks.guard.enabled = false;
  configureLockSettings(f, locks);
  await waiter.nextMessage('acquired');
  assert.deepEqual(readQueueFiles(f.dataDir), []);
  waiter.release();
  await waiter.nextMessage('released');
  waiter.child.stdin.end();
  assert.equal(await waiter.exited, 0);
  releaseProjectLock('full-suite', options('ws:a'));
});

test('LK3 R1 reducing four slots to two counts live short slots two and three', (t) => {
  const f = fixture(t, 'herdr-lk3-four-to-two-');
  const panes = ['ws:a', 'ws:b', 'ws:c', 'ws:d'];
  const options = (pane) => lockOptions(f, pane, panes);
  configureLockSettings(f, { slots: 4 });
  seedLockHistory(f);
  for (const pane of panes.slice(0, 3)) acquireProjectLock('full-suite', { ...options(pane), kind: 'suite' });
  releaseProjectLock('full-suite', options('ws:a'));
  configureLockSettings(f, { slots: 2 });
  for (const kind of ['suite', 'manual']) assert.throws(() => acquireProjectLock('full-suite', {
    ...options('ws:d'), kind, waitSeconds: 0,
  }), (error) => error.exitCode === 75);
});

test('LK3 R3 a later legacy ticket forces an earlier new ticket to start exclusively in the long slot', (t) => {
  const f = fixture(t, 'herdr-lk3-exclusive-queue-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const options = (pane) => lockOptions(f, pane, panes);
  acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'manual' });
  acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite' });
  let now = Date.now();
  let legacy;
  const acquired = acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'suite', waitSeconds: 1,
    now: () => now, pause: (ms) => {
      now += ms;
      legacy = writeLegacyTicket(f, 'ws:a', 41);
      releaseProjectLock('full-suite', options('ws:a'));
      releaseProjectLock('full-suite', options('ws:c'));
    } });
  assert.equal(acquired.slot, 'long');
  assert.equal(acquired.lane, 'long');
  assert.equal(readQueueFiles(f.dataDir)[0].id, legacy.ticket.id);
  assert.throws(() => acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite', waitSeconds: 0 }), (error) => error.exitCode === 75);
});

test('LK3 R5 automatic cleanup selects its exact record and refuses a replacement', (t) => {
  const f = fixture(t, 'herdr-lk3-cleanup-identity-');
  const options = lockOptions(f, 'ws:a', ['ws:a']);
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const first = acquireProjectLock('full-suite', { ...options, kind: 'suite' });
  const second = acquireProjectLock('full-suite', { ...options, kind: 'suite' });
  releaseProjectLock('full-suite', { ...options, expectedRecord: first });
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).slot, second.slot);
  const replacement = JSON.parse(fs.readFileSync(f.lockFile, 'utf8'));
  replacement.acquiredAt = new Date(Date.parse(second.acquiredAt) + 1).toISOString();
  fs.writeFileSync(f.lockFile, JSON.stringify(replacement));
  assert.throws(() => releaseProjectLock('full-suite', { ...options, expectedRecord: second }), /Refusing to release another record/);
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).acquiredAt, replacement.acquiredAt);
});

for (const constraint of ['capacity', 'guard']) for (const damage of ['missing', 'invalid JSON', 'invalid setting', 'partial locks', 'partial guard']) {
  test(`LK3 R12 ${damage} reload keeps the last ${constraint} policy and waits for a complete policy`, (t) => {
    const f = fixture(t, 'herdr-lk3-degraded-policy-');
    const panes = ['ws:a', 'ws:b'];
    const locks = { slots: constraint === 'capacity' ? 1 : 2, guard: { enabled: true, maxLoadPercent: 100 } };
    configureLockSettings(f, locks);
    seedLockHistory(f);
    let clock = Date.now();
    const options = (pane) => lockOptions(f, pane, panes, { now: () => clock });
    acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'push' });
    const policyFile = path.join(f.dataDir, 'policy.json');
    let pauses = 0;
    let ticketId;
    const acquired = acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'suite', waitSeconds: 2,
      readMachineSample: () => ({ at: new Date(clock).toISOString(), l5: 2, cpus: 1 }),
      pause: (ms) => {
        clock += ms;
        pauses++;
        const [ticket] = readQueueFiles(f.dataDir);
        assert.ok(ticket, 'the queued process must keep waiting during a degraded reload');
        ticketId ??= ticket.id;
        assert.equal(ticket.id, ticketId, 'the queued process must keep its original ticket');
        assert.equal(fs.existsSync(path.join(f.dataDir, 'locks', 'machine', 'full-suite.short.1.json')), false);
        if (pauses === 1) {
          const valid = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
          if (damage === 'missing') fs.unlinkSync(policyFile);
          else if (damage === 'invalid JSON') fs.writeFileSync(policyFile, '{cut');
          else {
            if (damage === 'invalid setting') {
              if (constraint === 'capacity') valid.locks.slots = 0;
              else valid.locks.guard.maxLoadPercent = '100';
            }
            if (damage === 'partial locks') delete valid.locks.slots;
            if (damage === 'partial guard') delete valid.locks.guard.maxLoadPercent;
            fs.writeFileSync(policyFile, JSON.stringify(valid));
          }
          releaseProjectLock('full-suite', options('ws:a'));
        }
        if (pauses === 3) configureLockSettings(f, { slots: 2, guard: { enabled: false } });
      },
    });
    assert.equal(pauses, 3, 'admission must resume only after a complete valid policy returns');
    assert.equal(acquired.slot, 1);
    assert.deepEqual(readQueueFiles(f.dataDir), []);
  });
}

test('LK3 R12 startup without a policy still uses legacy defaults', (t) => {
  const f = fixture(t, 'herdr-lk3-startup-policy-');
  fs.unlinkSync(path.join(f.dataDir, 'policy.json'));
  const acquired = acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:a', ['ws:a']), kind: 'suite' });
  assert.equal(acquired.slot, 'long');
});

for (const policyCase of [
  { name: 'unreadable policy file', reason: /policy file is unreadable/, damage: (file) => fs.unlinkSync(file) },
  { name: 'unknown lane', reason: /lock lane is unknown/, damage: (file) => fs.writeFileSync(file, JSON.stringify({ locks: { guard: POLICY_DEFAULTS.locks.guard } })) },
]) {
  test(`LK5 R16 a wait reports ${policyCase.name} without naming its own ticket`, (t) => {
    const f = fixture(t, `herdr-lk5-policy-${policyCase.name.replaceAll(' ', '-')}-`);
    const panes = ['ws:a', 'ws:b'];
    configureLockSettings(f, { slots: 1 });
    seedLockHistory(f);
    let clock = Date.now();
    const processInfo = () => ({ alive: true, start: 'invented-process-start' });
    const options = (pane) => lockOptions(f, pane, panes, {
      now: () => clock, pidAlive: () => true, processInfo,
    });
    acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'suite' });

    const notices = [];
    const noticeTimes = [];
    let pauses = 0;
    const policyFile = path.join(f.dataDir, 'policy.json');
    assert.throws(() => acquireProjectLock('full-suite', {
      ...options('ws:b'),
      kind: 'suite',
      waitSeconds: 120,
      output: (line) => {
        if (line.includes('policy file is unreadable') || line.includes('lock lane is unknown')) {
          notices.push(line);
          noticeTimes.push(clock);
        }
      },
      pause: (ms) => {
        pauses += 1;
        clock += 60_000;
        if (pauses === 1) {
          policyCase.damage(policyFile);
          releaseProjectLock('full-suite', { ...options('ws:a'), output: () => {} });
        }
      },
    }), (error) => {
      assert.equal(error.exitCode, 75);
      assert.match(error.message, /no active holder/);
      assert.doesNotMatch(error.message, /ws:b/);
      return true;
    });

    assert.equal(notices.length, 2, notices.join('\n'));
    assert.match(notices[0], policyCase.reason);
    assert.doesNotMatch(notices.join('\n'), /ws:b|policy\.json|herdr-suite-policy/);
    assert.deepEqual(noticeTimes.map((time) => time - noticeTimes[0]), [0, 60_000]);
    assert.deepEqual(readQueueFiles(f.dataDir), []);
  });
}

test('LK3 R13 a legacy shell-PID ticket expires at 30 minutes and is reclaimed after a two-hour clock advance', (t) => {
  const f = fixture(t, 'herdr-lk3-legacy-ticket-age-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  configureLockSettings(f, { slots: 2, guard: { enabled: false } });
  seedLockHistory(f);
  const start = Date.now();
  const options = (pane, now) => lockOptions(f, pane, panes, { now, pidAlive: () => true });
  acquireProjectLock('full-suite', { ...options('ws:a', start), kind: 'push' });
  const legacy = writeLegacyTicket(f, 'ws:b');
  Object.assign(legacy.ticket, { kind: 'manual', pid: 601, createdAt: new Date(start).toISOString() });
  fs.writeFileSync(legacy.file, JSON.stringify(legacy.ticket));
  const queueAt = (now) => readLockQueue({ dataDir: f.dataDir, livePanes: new Set(panes), pidAlive: () => true, now });
  assert.equal(queueAt(start + 30 * 60_000 - 1).length, 1, 'a younger live legacy ticket still constrains admission');
  assert.equal(queueAt(start + 30 * 60_000).length, 0, 'the legacy ticket lifetime is strictly younger than 30 minutes');
  const acquired = acquireProjectLock('full-suite', { ...options('ws:c', start + 2 * 60 * 60_000), kind: 'suite', waitSeconds: 0 });
  assert.equal(acquired.slot, 1);
  assert.equal(fs.existsSync(legacy.file), false);
});

test('LK3 R13 a two-hour-old live legacy holder still requires exclusive admission', (t) => {
  const f = fixture(t, 'herdr-lk3-legacy-holder-age-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);
  const holder = writeLegacyHolder(f, 'ws:a');
  const now = Date.parse(holder.acquiredAt) + 2 * 60 * 60_000;
  assert.throws(() => acquireProjectLock('full-suite', { ...lockOptions(f, 'ws:b', panes, { now }), kind: 'suite', waitSeconds: 0 }), (error) => error.exitCode === 75);
});

test('LK3 R13 new manual wait tickets use the CLI PID and acquired manual holders use the shell PID', (t) => {
  const f = fixture(t, 'herdr-lk3-manual-ticket-pid-');
  const panes = ['ws:a', 'ws:b'];
  configureLockSettings(f, { slots: 1 });
  const original = lockOptions(f, 'ws:a', panes);
  const herdr = (args) => args[0] === 'pane' && args[1] === 'process-info'
    ? { process_info: { shell_pid: 601 } } : original.herdr(args);
  let clock = Date.now();
  const options = (pane) => ({ ...lockOptions(f, pane, panes), herdr, now: () => clock, pidAlive: () => true });
  acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'suite' });
  let sawTicket = false;
  const acquired = acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'manual', waitSeconds: 1,
    pause: (ms) => {
      clock += ms;
      const [ticket] = readQueueFiles(f.dataDir);
      assert.equal(ticket.pid, process.pid, 'canceling the waiting CLI must make its ticket stale');
      sawTicket = true;
      releaseProjectLock('full-suite', options('ws:a'));
    },
  });
  assert.equal(sawTicket, true);
  assert.equal(acquired.pid, 601);
});

test('LK5 R9 lock holders store process start identity and PID reuse makes them stale while legacy holders stay live', (t) => {
  const f = fixture(t, 'herdr-lk5-holder-pid-start-');
  const panes = ['ws:a', 'ws:b'];
  const starts = new Map([[501, 'Mon Sep 28 10:00:00 2026'], [502, 'Mon Sep 28 10:01:00 2026']]);
  const options = (name) => {
    const base = lockOptions(f, name, panes, {
      pidAlive: () => true,
      processInfo: (pid) => ({ alive: true, start: starts.get(pid) ?? null }),
    });
    return {
      ...base,
      herdr: (args) => args[0] === 'pane' && args[1] === 'process-info'
        ? { process_info: { shell_pid: name === 'ws:a' ? 501 : 502 } }
        : base.herdr(args),
    };
  };
  configureLockSettings(f, { slots: 2 });
  seedLockHistory(f);

  const first = acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'manual' });
  assert.equal(first.pidStart, 'Mon Sep 28 10:00:00 2026');
  starts.set(501, 'Mon Sep 28 11:00:00 2026');
  const listed = listProjectLocks({ ...options('ws:b'), output: () => {} });
  assert.equal(listed.find((record) => record.name === 'full-suite').state, 'stale');

  const notices = [];
  const replacement = acquireProjectLock('full-suite', { ...options('ws:b'), kind: 'manual', output: (line) => notices.push(line) });
  assert.equal(replacement.pid, 502);
  assert.equal(replacement.pidStart, 'Mon Sep 28 10:01:00 2026');
  assert.ok(notices.some((line) => line.includes('Taking over stale lock')));

  const legacy = JSON.parse(fs.readFileSync(f.lockFile, 'utf8'));
  delete legacy.pidStart;
  fs.writeFileSync(f.lockFile, JSON.stringify(legacy));
  starts.set(502, 'Mon Sep 28 12:00:00 2026');
  assert.equal(listProjectLocks({ ...options('ws:a'), output: () => {} }).find((record) => record.name === 'full-suite').state, 'live');
});

test('LK5 R9 queue tickets store process start identity, prune reused PIDs, and keep legacy tickets valid', (t) => {
  const f = fixture(t, 'herdr-lk5-ticket-pid-start-');
  const panes = ['ws:a', 'ws:b', 'ws:c'];
  const starts = new Map([[601, 'Mon Sep 28 10:00:00 2026'], [process.pid, 'Mon Sep 28 10:01:00 2026']]);
  const processInfo = (pid) => ({ alive: true, start: starts.get(pid) ?? null });
  const options = (pane) => lockOptions(f, pane, panes, { pidAlive: () => true, processInfo });
  configureLockSettings(f, { slots: 1 });
  acquireProjectLock('full-suite', { ...options('ws:a'), kind: 'suite' });

  let clock = Date.now();
  let savedTicket;
  const waiting = acquireProjectLock('full-suite', {
    ...options('ws:b'), kind: 'suite', waitSeconds: 1, now: () => clock,
    pause: (ms) => {
      const [ticket] = readQueueFiles(f.dataDir);
      assert.ok(ticket);
      savedTicket = ticket;
      releaseProjectLock('full-suite', { ...options('ws:a'), now: () => clock, output: () => {} });
      clock += ms;
    },
  });
  assert.equal(savedTicket.pidStart, 'Mon Sep 28 10:01:00 2026');
  releaseProjectLock('full-suite', { ...options('ws:b'), now: () => clock, output: () => {} });

  const reused = writeLegacyTicket(f, 'ws:b');
  Object.assign(reused.ticket, { pid: 601, lane: 'long', pidStart: 'Mon Sep 28 10:00:00 2026' });
  fs.writeFileSync(reused.file, JSON.stringify(reused.ticket));
  starts.set(601, 'Mon Sep 28 11:00:00 2026');
  assert.deepEqual(readLockQueue({ dataDir: f.dataDir, livePanes: new Set(panes), pidAlive: () => true, processInfo }), []);

  const acquired = acquireProjectLock('full-suite', { ...options('ws:c'), kind: 'suite' });
  assert.equal(acquired.ownerPane, 'ws:c');
  assert.equal(fs.existsSync(reused.file), false, 'the next admission removes the reused-PID ticket');
  releaseProjectLock('full-suite', { ...options('ws:c'), output: () => {} });

  const legacy = writeLegacyTicket(f, 'ws:b', 42);
  Object.assign(legacy.ticket, { pid: 601, lane: undefined });
  delete legacy.ticket.lane;
  fs.writeFileSync(legacy.file, JSON.stringify(legacy.ticket));
  assert.equal(readLockQueue({ dataDir: f.dataDir, livePanes: new Set(panes), pidAlive: () => true,
    processInfo: () => ({ alive: true, start: 'Mon Sep 28 12:00:00 2026' }) }).length, 1,
  'a legacy ticket without a saved start identity keeps its old liveness rule');
  assert.equal(fs.existsSync(legacy.file), true);
});

for (const slot of ['long', 1]) for (const pane of ['ws:a', 'ws:b']) {
  test(`LK3 R14 a token re-entry release selecting ${slot} from ${pane} preserves the outer push`, (t) => {
    const f = fixture(t, 'herdr-lk3-selected-reentry-');
    const panes = ['ws:a', 'ws:b'];
    configureLockSettings(f, { slots: 2 });
    if (slot === 1) seedLockHistory(f, 'push');
    const token = 'selected-push-reentry-fixture-0001';
    const owner = lockOptions(f, 'ws:a', panes);
    const outer = acquireProjectLock('full-suite', { ...owner, kind: 'push', reentryToken: token });
    assert.equal(outer.slot, slot);
    const file = slot === 'long' ? f.lockFile : path.join(path.dirname(f.lockFile), `full-suite.short.${slot}.json`);
    const before = fs.readFileSync(file, 'utf8');
    const inner = { ...lockOptions(f, pane, panes), env: { ...lockOptions(f, pane, panes).env, HERDR_BOSS_LOCK_TOKEN: token } };
    assert.equal(acquireProjectLock('full-suite', { ...inner, kind: 'suite' }).reentrant, true);
    const released = releaseProjectLock('full-suite', { ...inner, slot });
    assert.equal(released.reentrant, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    releaseProjectLock('full-suite', { ...owner, env: { ...owner.env, HERDR_BOSS_LOCK_TOKEN: token }, expectedRecord: outer });
    assert.equal(fs.existsSync(file), false, 'the real owner still performs exact automatic cleanup');
  });
}

test('LK3 R14 a selector for another owned record releases that record while preserving the token push', (t) => {
  const f = fixture(t, 'herdr-lk3-other-selected-release-');
  configureLockSettings(f, { slots: 2, guard: { enabled: false } });
  seedLockHistory(f);
  const owner = lockOptions(f, 'ws:a', ['ws:a']);
  const token = 'other-selected-reentry-fixture-0001';
  acquireProjectLock('full-suite', { ...owner, kind: 'push', reentryToken: token });
  acquireProjectLock('full-suite', { ...owner, kind: 'suite' });
  releaseProjectLock('full-suite', { ...owner, env: { ...owner.env, HERDR_BOSS_LOCK_TOKEN: token }, slot: 1 });
  assert.equal(fs.existsSync(f.lockFile), true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.lockFile), 'full-suite.short.1.json')), false);
});

test('LK3 R15 legacy exclusivity displays effective capacity and global FIFO apart from saved capacity', (t) => {
  const f = fixture(t, 'herdr-lk3-legacy-display-');
  const panes = ['ws:a', 'ws:b', 'ws:c', 'ws:d'];
  configureLockSettings(f, { slots: 3 });
  writeLegacyHolder(f, 'ws:a');
  const legacy = writeLegacyTicket(f, 'ws:b', 1);
  for (const [seq, lane, pane] of [[2, 'short', 'ws:c'], [3, 'long', 'ws:d']]) {
    const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    fs.writeFileSync(path.join(legacy.queue, `${id}.json`), JSON.stringify({ ...legacy.ticket, id, seq, pane, lane }));
  }
  const options = { dataDir: f.dataDir, livePanes: new Set(panes), pidAlive: () => true };
  const queue = readLockQueue(options);
  assert.deepEqual(queue.map((ticket) => ticket.position), [1, 2, 3]);
  for (const entry of [...queue, ...readMachineLocks(options)]) {
    assert.equal(entry.slotLimit, 1);
    assert.equal(entry.configuredSlotLimit, 3);
    assert.equal(entry.admissionMode, 'legacy-exclusive');
  }
  assert.deepEqual(queue.map((ticket) => ticket.lane), ['long', 'long', 'long']);
});

for (const kind of ['manual', 'suite', 'push']) {
  test(`LK3 integration lock list carries finite expiry only for a ${kind} machine holder`, (t) => {
    const f = fixture(t, 'herdr-lk3-list-expiry-');
    let clock = Date.parse('2026-10-01T12:00:00.000Z');
    const options = lockOptions(f, 'ws:orch-a', ['ws:orch-a'], { now: () => clock });
    acquireProjectLock('full-suite', { ...options, kind });
    clock += 3 * 60_000;
    const lines = [];
    const [listed] = listProjectLocks({ ...options, output: (line) => lines.push(line) });
    assert.equal(listed.expiresInMs, kind === 'manual' ? 57 * 60_000 : null);
    assert.doesNotMatch(lines.join('\n'), /NaN/);
    if (kind === 'manual') {
      assert.match(lines[0], /full-suite .*ws:orch-a.*manual.*3m.*57m/);
      assert.match(lines[0], /expires in 57m; PID \d+, live; lane long, long slot/);
      clock += 58 * 60_000;
      const [expired] = listProjectLocks({ ...options, output: (line) => lines.push(line) });
      assert.equal(expired.expiresInMs, 0);
      assert.match(lines.at(-1), /expires in 0m; PID \d+, stale; lane long/);
    } else {
      assert.doesNotMatch(lines[0], /expires in/);
      assert.match(lines[0], /; lane long, long slot/);
    }
  });
}
