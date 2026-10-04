import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('fleet login checks use only verifier exit status and HOME-relative state-file metadata', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '');
  const calls = [];
  const results = await readFleetLogins({ home, now: () => Date.parse('2026-10-02T10:00:00Z'),
    run: async (command, args, options) => {
      calls.push({ command, args, home: options.env.HOME });
      return { code: command === 'codex' ? 0 : 1, stdout: 'hf_read_fixture_must_not_escape' };
    } });
  assert.deepEqual(results.map(({ harness, login, checkedAt }) => ({ harness, login, checkedAt })), [
    { harness: 'claude', login: 'expired', checkedAt: '2026-10-02T10:00:00Z' },
    { harness: 'codex', login: 'logged-in', checkedAt: '2026-10-02T10:00:00Z' },
    { harness: 'opencode', login: 'unknown', checkedAt: null },
  ]);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'claude', args: ['auth', 'status'] }, { command: 'codex', args: ['login', 'status'] },
  ]);
  assert.ok(calls.every((call) => call.home === home));
  assert.equal(results[2].reason, 'no recorded login state file');
  assert.doesNotMatch(JSON.stringify(results), /hf_read_fixture_must_not_escape/);
});

test('a missing login state file is none and an escaping symlink stays unknown', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside'), '');
  fs.symlinkSync(path.join(root, 'outside'), path.join(home, '.claude', '.credentials.json'));
  const results = await readFleetLogins({ home, run: async () => ({ code: 1 }), now: () => 0 });
  assert.equal(results.find((row) => row.harness === 'claude').login, 'unknown');
  assert.match(results.find((row) => row.harness === 'claude').reason, /symlink|inside HOME/);
  assert.equal(results.find((row) => row.harness === 'codex').login, 'none');
  assert.equal(results.find((row) => row.harness === 'opencode').login, 'unknown');

  const outsideDir = path.join(root, 'outside-dir');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'config.toml'), '');
  fs.symlinkSync(outsideDir, path.join(home, '.codex'));
  const throughDirectoryLink = await readFleetLogins({ home, run: async () => ({ code: 1 }), now: () => 0 });
  assert.equal(throughDirectoryLink.find((row) => row.harness === 'codex').login, 'unknown');
  assert.match(throughDirectoryLink.find((row) => row.harness === 'codex').reason, /symlink/);
});

test('first-run settings do not count as evidence of a prior login', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-trust-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '');
  const results = await readFleetLogins({ home, run: async () => ({ code: 1 }), now: () => 0 });
  assert.equal(results.find((row) => row.harness === 'claude').login, 'none');
  assert.equal(results.find((row) => row.harness === 'codex').login, 'none');
});

test('a linked login state path blocks even a passing verifier', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-linked-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside'), '');
  fs.symlinkSync(path.join(root, 'outside'), path.join(home, '.claude', '.credentials.json'));
  const calls = [];
  const results = await readFleetLogins({ home, run: async (command) => { calls.push(command); return { code: 0 }; }, now: () => 0 });
  assert.equal(results.find((row) => row.harness === 'claude').login, 'unknown');
  assert.match(results.find((row) => row.harness === 'claude').reason, /symlink/);
  assert.equal(calls.includes('claude'), false);
  assert.equal(results.find((row) => row.harness === 'codex').login, 'logged-in');
});

test('a linked HOME blocks all login verifiers', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-linked-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const home = path.join(root, 'home');
  fs.mkdirSync(target);
  fs.symlinkSync(target, home);
  const calls = [];
  const results = await readFleetLogins({ home, run: async (command) => { calls.push(command); return { code: 0 }; }, now: () => 0 });
  assert.deepEqual(calls, []);
  assert.equal(results.find((row) => row.harness === 'claude').login, 'unknown');
  assert.equal(results.find((row) => row.harness === 'codex').login, 'unknown');
  assert.ok(results.filter((row) => row.harness !== 'opencode').every((row) => /HOME|symlink/.test(row.reason)));
});

test('the default runner invokes each temporary harness executable with only its check arguments', async (t) => {
  const { readFleetLogins } = await import('../src/fleet-login.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-login-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const executable of ['claude', 'codex']) {
    const file = path.join(bin, executable);
    fs.writeFileSync(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FLEET_LOGIN_LOG, JSON.stringify({ executable: path.basename(process.argv[1]), args }) + '\\n');\nconst expected = path.basename(process.argv[1]) === 'claude' ? ['auth', 'status'] : ['login', 'status'];\nprocess.exitCode = JSON.stringify(args) === JSON.stringify(expected) ? 0 : 1;\n`);
    fs.chmodSync(file, 0o755);
  }
  const previousPath = process.env.PATH;
  const previousLog = process.env.FLEET_LOGIN_LOG;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  process.env.FLEET_LOGIN_LOG = log;
  try {
    const results = await readFleetLogins({ home, now: () => 0 });
    assert.deepEqual(results.filter((row) => row.harness !== 'opencode').map((row) => row.login), ['logged-in', 'logged-in']);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      { executable: 'claude', args: ['auth', 'status'] },
      { executable: 'codex', args: ['login', 'status'] },
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FLEET_LOGIN_LOG;
    else process.env.FLEET_LOGIN_LOG = previousLog;
  }
});
