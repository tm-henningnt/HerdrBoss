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

test('read-token set removes the matching export file inside the private folder and keeps other files', () => {
  const token = 'hf_read_' + 'c'.repeat(64);
  fs.mkdirSync(privateDir, { recursive: true });
  const inside = path.join(privateDir, 'test-export-remove.json');
  fs.writeFileSync(inside, JSON.stringify(token), { mode: 0o600 });
  assert.equal(run(['read-token', 'set', 'factory-c', '--from-file', inside]).status, 0);
  assert.equal(fs.existsSync(inside), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(privateDir, 'fleet-remotes.json')))['factory-c'], token);
  const outside = path.join(root, 'outside-export.json');
  fs.writeFileSync(outside, JSON.stringify(token));
  assert.equal(run(['read-token', 'set', 'factory-c', '--from-file', outside]).status, 0);
  assert.equal(fs.existsSync(outside), true);
});

test('guide-token provisioning stays private and separate from fleetRead', () => {
  const file = path.join(privateDir, 'test-guide-export.json');
  const rotated = run(['guide-token', 'rotate', '--out-file', file]);
  assert.equal(rotated.status, 0, rotated.stderr);
  const token = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(token, /^hf_guide_[a-f0-9]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const imported = run(['guide-token', 'set', 'factory-b', '--from-file', file]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(privateDir, 'fleet-guide-remotes.json')))['factory-b'], token);
  assert.doesNotMatch(rotated.stdout + rotated.stderr + imported.stdout + imported.stderr, /hf_guide_/);
  assert.notEqual(run(['read-token', 'set', 'factory-b', '--from-file', '-'], JSON.stringify(token)).status, 0);
});


test('guide-token rotation resets a poisoned epoch and holder while retaining the last share', async () => {
  const dir = path.join(root, 'epoch-recovery');
  fs.mkdirSync(dir, { recursive: true });
  const accepted = { senderEpoch: Number.MAX_SAFE_INTEGER, headOfficeFactoryId: 'factory-b', shares: [{ accountKey: 'a'.repeat(64), share: 40 }], nudges: [{ nudgeId: 'old-nudge' }] };
  fs.writeFileSync(path.join(dir, 'fleet-guidance.json'), JSON.stringify(accepted));
  fs.writeFileSync(path.join(dir, 'head-office-role.json'), JSON.stringify({ epoch: Number.MAX_SAFE_INTEGER, headOfficeFactoryId: 'factory-b' }));
  const file = path.join(privateDir, 'recovered-guide.json');
  const rotated = spawnSync(process.execPath, ['src/cli.js', 'fleet', 'guide-token', 'rotate', '--out-file', file], { encoding: 'utf8', env: { ...process.env, HERDR_BOSS_DIR: dir } });
  assert.equal(rotated.status, 0, rotated.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'fleet-guidance.json')));
  assert.equal(saved.senderEpoch, 0);
  assert.equal(saved.headOfficeFactoryId, null);
  assert.deepEqual(saved.shares, accepted.shares);
  assert.deepEqual(saved.nudges, []);
  assert.equal(fs.existsSync(path.join(dir, 'head-office-role.json')), false);
  const { createFleetGuidance } = await import('../src/fleet-guidance.js');
  const receiver = createFleetGuidance({ dir, settings: () => ({ factoryId: 'factory-a', accounts: [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-a'] }] }) });
  const fresh = await receiver.accept({ schema: 1, contractVersion: '1.0.0', headOfficeFactoryId: 'factory-a', senderEpoch: 1, sentAt: '2026-10-03T12:00:00Z', shares: [], nudges: [] });
  assert.equal(fresh.senderEpoch, 1, 'the real head office can submit again after rotation');
  assert.doesNotMatch(rotated.stdout + rotated.stderr, /hf_guide_/);
});


test('guide-token set refuses a bad token without changing the credential store or printing input', () => {
  fs.mkdirSync(privateDir, { recursive: true });
  const file = path.join(privateDir, 'fleet-guide-remotes.json');
  fs.writeFileSync(file, JSON.stringify({ 'factory-a': 'hf_guide_' + 'b'.repeat(64) }));
  const before = fs.readFileSync(file, 'utf8');
  const invalid = 'hf_guide_invented-invalid-value';
  const result = run(['guide-token', 'set', 'factory-a', '--from-file', '-'], JSON.stringify(invalid));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /guide credential is invalid/);
  assert.doesNotMatch(result.stdout + result.stderr, /invented-invalid-value/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('guide-token rotate refuses an export outside the private folder before rotation', () => {
  fs.mkdirSync(privateDir, { recursive: true });
  const credentialFile = path.join(privateDir, 'fleet-guide.json');
  fs.writeFileSync(credentialFile, JSON.stringify({ current: 'a'.repeat(64) }));
  const before = fs.readFileSync(credentialFile, 'utf8');
  const file = path.join(root, 'outside-guide-export.json');
  const result = run(['guide-token', 'rotate', '--out-file', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the private Herdr Boss configuration folder/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), before);
  assert.doesNotMatch(result.stdout + result.stderr, /hf_guide_/);
});
