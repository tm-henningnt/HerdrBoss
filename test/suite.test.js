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
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ names: Object.keys(process.env), locked: fs.existsSync(${JSON.stringify(lockFile)}), lock: fs.existsSync(${JSON.stringify(lockFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(lockFile)}, 'utf8')) : null }));`,
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
  const readSeen = () => JSON.parse(fs.readFileSync(seen, 'utf8'));
  return { base, root, dataDir, config, env, lines, livePanes, lockFile, options, run, readSeen };
}

test('suite holds the full-suite lock around the command and passes the exit code through', (t) => {
  const f = fixture(t, 'herdr-suite-pass-');
  const passed = f.run([]);
  assert.equal(passed.exitCode, 0);
  assert.equal(f.readSeen().locked, true, 'the lock exists while the command runs');
  assert.equal(f.readSeen().lock.pid, process.pid, 'the lock records the herdr-boss suite process');
  assert.equal(f.readSeen().lock.kind, 'suite');
  assert.equal(f.readSeen().lock.ownerPane, 'ws:orch');
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after the command');
  const failed = f.run([], 3);
  assert.equal(failed.exitCode, 3);
  assert.equal(f.readSeen().locked, true);
  assert.equal(fs.existsSync(f.lockFile), false, 'the lock is released after a failed command');
  assert.ok(f.lines.some((line) => /acquired/.test(line)) && f.lines.some((line) => /released/.test(line)), f.lines.join('\n'));
});

test('suite releases the lock when the command cannot start', (t) => {
  const f = fixture(t, 'herdr-suite-missing-');
  const result = runKitCommand('suite', ['--', path.join(f.base, 'no-such-command')], f.options());
  assert.notEqual(result.exitCode, 0);
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
