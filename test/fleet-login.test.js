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
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '');
  const calls = [];
  const results = await readFleetLogins({ home, now: () => Date.parse('2026-10-02T10:00:00Z'),
    run: async (command, args, options) => {
      calls.push({ command, args, home: options.env.HOME });
      return { code: args[0] === 'codex' ? 0 : 1, stdout: 'hf_read_fixture_must_not_escape' };
    } });
  assert.deepEqual(results.map(({ harness, login, checkedAt }) => ({ harness, login, checkedAt })), [
    { harness: 'claude', login: 'expired', checkedAt: '2026-10-02T10:00:00Z' },
    { harness: 'codex', login: 'logged-in', checkedAt: '2026-10-02T10:00:00Z' },
    { harness: 'opencode', login: 'unknown', checkedAt: null },
  ]);
  assert.deepEqual(calls.map(({ args }) => args), [['claude', 'auth', 'status'], ['codex', 'login', 'status']]);
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
  fs.symlinkSync(path.join(root, 'outside'), path.join(home, '.claude.json'));
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
