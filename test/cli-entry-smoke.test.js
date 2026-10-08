import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'src', 'cli.js');

// These forms can change the machine or open a browser. The test runs only the root command
// without its action for browser, so no browser form below is invoked.
const SKIPPED_COMMANDS = [
  { command: 'serve', reason: 'starts the collector and dashboard service' },
  { command: 'install', reason: 'installs and starts the service' },
  { command: 'uninstall', reason: 'stops and removes the service' },
  { command: 'service start|stop|restart', reason: 'changes the service state' },
  { command: 'browser request', reason: 'may launch a project browser' },
  { command: 'browser restart', reason: 'restarts a project browser' },
  { command: 'browser tab new', reason: 'opens a browser tab' },
  { command: 'browser navigate', reason: 'opens a browser page' },
  { command: 'browser bookmarks open', reason: 'opens a saved page' },
];

const SKIPPED_ROOTS = new Map([
  ['serve', 'starts the collector and dashboard service'],
  ['install', 'installs and starts the service'],
  ['uninstall', 'stops and removes the service'],
  ['service', 'can start, stop, or restart the service'],
]);

function temporaryCliEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cli-entry-smoke-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  // A fake herdr first on PATH keeps a bare root command away from a live herdr socket.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\necho "fake herdr" >&2\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of ['HERDR_BOSS_LIVE_DIR', 'HERDR_SOCKET_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete env[key];
  return { root, env };
}

function runCli(args) {
  const fixture = temporaryCliEnv();
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], {
      cwd: REPO,
      env: fixture.env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
    child.stdin?.end();
  });
}

function topLevelCommands(help) {
  return [...new Set([...help.matchAll(/^ {2}([a-z][a-z0-9-]*)(?:\s|$)/gm)].map((match) => match[1]))];
}

function assertNoInitializationCrash(result, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!result.error || typeof result.error.code === 'number', `${label}: CLI could not start: ${result.error?.message}`);
  assert.equal(result.error?.signal ?? null, null, `${label}: process ended on a signal`);
  assert.doesNotMatch(output, /before initialization|is not defined|Cannot read properties of undefined|^\s*at\s+/im, `${label}: output contains an initialization error or stack trace`);
}

test('worker help forms print complete usage and exit successfully', async () => {
  for (const [action, variants] of [
    ['start', [['--help'], ['-h'], [], ['--kind', 'codex', '--task', 'missing-name']]],
    ['collect', [['--help'], ['-h']]],
    ['commit', [['--help'], ['-h']]],
  ]) {
    for (const variant of variants) {
      const result = await runCli(['worker', action, ...variant]);
      assertNoInitializationCrash(result, `worker ${action} ${variant.join(' ') || '(no name)'}`);
      assert.equal(result.error?.code ?? 0, 0, `worker ${action} ${variant.join(' ')} must exit 0: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Usage: worker ${action}\\b`));
      if (action === 'start') {
        for (const option of ['--kind', '--task', '--task-file', '--task-id', '--issue', '--model', '--effort', '--allow', '--copy', '--lease', '--base', '--review-worktree', '--orch', '--no-worktree', '--dry-run', '--force', '--force-swap', '--read-only', '--planner']) {
          assert.ok(result.stdout.includes(option), `worker start usage omits ${option}`);
        }
      } else if (action === 'collect') {
        for (const option of ['--record', '--no-record', '--allow', '--outcome', '--gate-passed', '--gate-failed', '--keep-pane', '--defects', '--rework', '--model-result', '--model-reason', '--accept-scope', '--reason']) {
          assert.ok(result.stdout.includes(option), `worker collect usage omits ${option}`);
        }
      } else {
        assert.ok(result.stdout.includes('-m MESSAGE'));
        assert.ok(result.stdout.includes('--message MESSAGE'));
      }
    }
  }
});

test('check --help prints its usage and exits successfully', async () => {
  const result = await runCli(['check', '--help']);
  assertNoInitializationCrash(result, 'check --help');
  assert.equal(result.error?.code ?? 0, 0, `check --help must exit 0: ${result.stderr}`);
  assert.match(result.stdout, /Usage: check --report FILE \| --run FILE \| --worktree DIR --allow PATH/);
  assert.match(result.stdout, /check agents \[FILE\]/);
  assert.match(result.stdout, /check kit/);
});

test('every listed top-level CLI command has a safe entry smoke check', async () => {
  const startedAt = Date.now();
  const help = await runCli(['help']);
  assertNoInitializationCrash(help, 'herdr-boss help');
  assert.equal(help.error?.code ?? 0, 0, `herdr-boss help must exit 0: ${help.stderr}`);
  const commands = topLevelCommands(help.stdout);
  assert.ok(commands.length > 0, 'herdr-boss help did not list top-level commands');

  const queue = commands.filter((command) => !SKIPPED_ROOTS.has(command));
  const results = new Array(queue.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (next < queue.length) {
      const index = next++;
      const command = queue[index];
      const args = command === 'push' ? [command, '-h'] : command === 'setup' ? [command, '--dry-run'] : [command];
      results[index] = { command, result: await runCli(args) };
    }
  }));

  for (const { command, result } of results) {
    assertNoInitializationCrash(result, `herdr-boss ${command}`);
    assert.ok(result.error === null || result.error === undefined || Number.isInteger(result.error.code), `herdr-boss ${command}: no exit code`);
  }
  assert.ok(Date.now() - startedAt < 60000, 'CLI entry smoke checks took 60 seconds or more');
  assert.ok(SKIPPED_COMMANDS.some((item) => item.command === 'browser request'), 'the skipped browser start forms must stay documented');
});
