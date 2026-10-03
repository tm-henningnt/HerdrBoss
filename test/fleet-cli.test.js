import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.HERDR_BOSS_DIR;
const privateDir = path.join(process.env.HOME, '.config', 'herdr-boss');
process.env.HERDR_FACTORIES_DIR = path.join(root, 'factories');
const run = (args, input) => spawnSync(process.execPath, ['src/cli.js', 'fleet', ...args], { encoding: 'utf8', input, env: process.env });
test('private fleet provisioning works through the CLI without printing credentials or account identities', () => {
  const provision = run(['account', '--from-file', '-'], JSON.stringify({ harness: 'codex', identity: 'account@example.invalid', hmacKey: 'invented-shared-hmac-key-with-32-bytes', scope: ['factory-zero'] }));
  assert.equal(provision.status, 0, provision.stderr);
  assert.doesNotMatch(provision.stdout + provision.stderr, /account@example|invented-shared/);
  const file = path.join(privateDir, 'test-read-token.json');
  const rotated = run(['read-token', 'rotate', '--out-file', file]);
  assert.equal(rotated.status, 0, rotated.stderr);
  const token = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(token, /^hf_read_[a-f0-9]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(rotated.stdout + rotated.stderr, /hf_read_/);
  const imported = run(['read-token', 'set', 'factory-a', '--from-file', file]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(privateDir, 'fleet-remotes.json')))['factory-a'], token);
  assert.doesNotMatch(imported.stdout + imported.stderr, /hf_read_/);
});

test('invalid initialization does not create an identity and a factory ID cannot change later', () => {
  const isolated = path.join(root, 'init-fixture'); fs.mkdirSync(isolated, { recursive: true });
  const env = { ...process.env, HERDR_BOSS_DIR: isolated };
  const initialize = (body) => spawnSync(process.execPath, ['src/cli.js', 'fleet', 'init', '--from-file', '-'], { encoding: 'utf8', input: JSON.stringify(body), env });
  const bad = initialize({ factoryId: 'factory-a', name: 'factory-a', dashboardUrl: 'https://example.invalid', headOffice: 'yes', shareItemTitles: true, accounts: [] });
  assert.notEqual(bad.status, 0);
  assert.equal(fs.existsSync(path.join(isolated, 'factory-identity.json')), false);
  const good = { factoryId: 'factory-a', name: 'factory-a', dashboardUrl: 'https://example.invalid', headOffice: false, shareItemTitles: true, accounts: [] };
  assert.equal(initialize(good).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolated, 'factory-identity.json'))).factoryId, 'factory-a');
  assert.notEqual(initialize({ ...good, factoryId: 'factory-b' }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolated, 'factory-identity.json'))).factoryId, 'factory-a');
});
