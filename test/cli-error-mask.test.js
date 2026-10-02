import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { maskBrowserText, maskCliError, maskUrl } from '../src/browser-url-mask.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// Invented values only. A tenant host and an app UUID must never reach a transcript.
const HOST = 'tenant1.example.test';
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const PROBE_URL = `https://${HOST}/apps/${UUID}`;

// A wrong argument for each command family. The invocation must fail before an action runs.
// install, uninstall, and tick are absent: they act on the machine or run a full collect.
const FAMILIES = [
  ['scratch', ['scratch', PROBE_URL]],
  ['project', ['project', 'paths', PROBE_URL, PROBE_URL]],
  ['goal', ['goal', 'bogus', PROBE_URL]],
  ['review', ['review', 'bogus', PROBE_URL]],
  ['plan', ['plan', 'bogus', PROBE_URL]],
  ['say', ['say', PROBE_URL, PROBE_URL]],
  ['messages', ['messages', PROBE_URL, PROBE_URL]],
  ['mail', ['mail', 'post', '--to', 'owner', PROBE_URL]],
  ['tell', ['tell', PROBE_URL, PROBE_URL]],
  ['worker', ['worker', 'start', PROBE_URL, '--kind', PROBE_URL]],
  ['wait', ['wait', '--timeout', PROBE_URL]],
  ['lock', ['lock', 'acquire', PROBE_URL]],
  ['worktree', ['worktree', 'prune', PROBE_URL]],
  ['ledger', ['ledger', 'append', PROBE_URL]],
  ['check', ['check', PROBE_URL]],
  ['models', ['models', '--kind', PROBE_URL]],
  ['kit', ['kit', PROBE_URL]],
  ['policy', ['policy', PROBE_URL]],
  ['watch', ['watch', 'start', '--routines', PROBE_URL]],
  ['spend', ['spend', '--days', PROBE_URL]],
  ['usage', ['usage', PROBE_URL]],
  ['store', ['store', PROBE_URL]],
  ['browser', ['browser', 'bookmarks', 'add', 'demo', PROBE_URL, PROBE_URL]],
  ['serve', ['serve', '--host', PROBE_URL]],
  ['publish', ['publish', PROBE_URL, PROBE_URL]],
  ['lanes', ['lanes', PROBE_URL]],
  ['logs', ['logs', PROBE_URL]],
  ['unknown', [PROBE_URL]],
];

function sandbox(t, { fakeGh = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cli-error-'));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  fs.mkdirSync(repo);
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'body.md'), 'body\n');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, TMPDIR: base };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_WORKTREE']) delete env[key];
  if (fakeGh) {
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    // A quiet failure. The argument echo under test is the "Command failed:" line of Node.
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  }
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { run: (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20000 }) };
}

function assertNoLeak(result, label) {
  assert.equal(result.error, undefined, `${label} did not finish: ${result.error?.message}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(!output.includes(HOST), `${label} printed the fake tenant host:\n${output}`);
  assert.ok(!output.includes(UUID), `${label} printed the fake app UUID:\n${output}`);
}

test('the shared filter masks an app UUID after its flag or path and keeps a bare UUID', () => {
  for (const input of [`--app ${UUID}`, `--app=${UUID}`, `--app-id ${UUID}`, `--app-id=${UUID}`, `--id ${UUID}`, `--id=${UUID}`, `see /apps/${UUID}`, `see app/${UUID}`, `https://${HOST}/apps/${UUID}`]) {
    const masked = maskBrowserText(input, { maskHosts: true });
    assert.ok(!masked.includes(UUID), `filter left the UUID in ${JSON.stringify(input)}`);
    assert.ok(masked.includes('<uuid>'), `filter did not mask the UUID in ${JSON.stringify(input)}`);
  }
  assert.ok(maskBrowserText(`bare ${UUID}`, { maskHosts: true }).includes(UUID), 'a bare UUID must stay readable');
  assert.equal(maskUrl(`https://${HOST}/apps/${UUID}`), 'https://<tenant>.example.test/apps/<uuid>');
  assert.equal(maskBrowserText(`--app ${UUID}`, { full: true }), `--app ${UUID}`, '--full keeps the UUID');
});

test('a command error keeps a file name and masks a bare host only on a Command failed line', () => {
  for (const file of ['src/cli.js', 'docs/cli.md', 'config.json']) {
    assert.equal(maskCliError(`ENOENT: no such file or directory, open '${file}'`), `ENOENT: no such file or directory, open '${file}'`);
  }
  assert.equal(maskCliError(`a bare host ${HOST} stays readable`), `a bare host ${HOST} stays readable`);
  const failed = maskCliError(`Command failed: gh issue create --title ${HOST} --app-id ${UUID}`);
  assert.match(failed, /Command failed: gh issue create/);
  assert.match(failed, /<tenant>\.example\.test/);
  assert.match(failed, /<uuid>/);
  assert.ok(!failed.includes(HOST) && !failed.includes(UUID));
  assert.equal(maskCliError(`see https://${HOST}/apps/${UUID} now`), 'see https://<tenant>.example.test/apps/<uuid> now');
});

test('no command family echoes a fake tenant host or app UUID in an error', (t) => {
  const { run } = sandbox(t);
  for (const [name, args] of FAMILIES) assertNoLeak(run(args), name);
});

test('a non-browser error keeps a plain file name intact', (t) => {
  const { run } = sandbox(t);
  for (const file of ['src/cli.js', 'docs/cli.md', 'config.json']) {
    const result = run(['usage', 'record', file]);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.ok(output.includes(file), `the error masked the file name ${file}: ${output}`);
  }
});

test('a failing child process cannot echo a host or app UUID through its command line', (t) => {
  const { run } = sandbox(t, { fakeGh: true });
  const result = run(['gh', 'issue', 'create', '--title', HOST, '--body-file', 'body.md', '--app-id', UUID]);
  assertNoLeak(result, 'gh issue create');
  assert.match(result.stderr, /Command failed: gh issue create/);
  assert.match(result.stderr, /<tenant>\.example\.test/);
  assert.match(result.stderr, /<uuid>/);
});
