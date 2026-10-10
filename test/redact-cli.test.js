import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli.js');
const TEST_HOST = 'fixture.eu.example.invalid';
let nextFixture = 0;

function fixture(t, config = { redact: { tenantHosts: [TEST_HOST] } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-redact-${nextFixture += 1}-`));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const privateDir = path.join(home, '.config', 'herdr-boss');
  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'config.json'), `${JSON.stringify(config)}\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data };
  delete env.HERDR_BOSS_LIVE_DIR;
  return { env, home, data };
}

function runRedact(fx, input) {
  return spawnSync(process.execPath, [CLI, 'redact'], {
    cwd: ROOT,
    env: fx.env,
    input,
    encoding: 'utf8',
  });
}

test('redact masks identifiers, hosts, and secrets in the required order', (t) => {
  const fx = fixture(t);
  const guid = 'A1B2C3D4-E5F6-7890-ABCD-EF0123456789';
  const adjacentHex = 'c'.repeat(32);
  const shortHex = 'd'.repeat(24);
  const mediumHex = 'e'.repeat(31);
  const bearer = ['ghp', '_', 'inventedValue123456789'].join('');
  const githubPat = ['github_pat', '_', 'inventedValue123456789'].join('');
  const secretToken = ['sk-', 'inventedValue123456789'].join('');
  const chatToken = ['xox', 'b-inventedValue123456789'].join('');
  const beginKey = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('');
  const endKey = ['-----END ', 'PRIVATE KEY', '-----'].join('');
  const genericHost = ['sample', 'region', 'qlikcloud', 'com'].join('.');
  const jwt = ['header123', 'payload456', 'signature789'].join('.');
  const input = [
    `overlap ${guid}${adjacentHex}`,
    `hex ${shortHex} ${mediumHex}`,
    `url https://${TEST_HOST}/apps/${guid}`,
    `bare-host ${TEST_HOST}`,
    `host-boundary https://${TEST_HOST}.attacker.invalid/path`,
    `generic https://${genericHost}/resource`,
    `auth Bearer ${bearer}`,
    `jwt ${jwt}`,
    `prefixes ${githubPat} ${secretToken} ${chatToken}`,
    `${beginKey}\ninvented-key-body\n${endKey}`,
    `token=made-up-value token="quoted-value" "api_key": "another-made-up-value" authorization: made-up-auth password=made-up-password apikey=made-up-key secret=made-up-secret`,
    `appId=app-fixture spaceId: space-fixture userId user-fixture`,
    '',
  ].join('\n');
  const result = runRedact(fx, input);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'overlap <uuid><hex>',
    'hex <hex> <hex>',
    'url https://<host>/apps/<uuid>',
    'bare-host <host>',
    `host-boundary https://${TEST_HOST}.attacker.invalid/path`,
    'generic https://<host>/resource',
    'auth <token>',
    'jwt <token>',
    'prefixes <token> <token> <token>',
    '<key>',
    'token=<secret> token="<secret>" "api_key": "<secret>" authorization: <secret> password=<secret> apikey=<secret> secret=<secret>',
    'appId=<id> spaceId: <id> userId <id>',
    '',
  ].join('\n'));
  assert.doesNotMatch(result.stderr, new RegExp(TEST_HOST));
  assert.deepEqual(fs.readdirSync(fx.data), [], 'redact does not read or create service data files');
});

test('redact joins only indented wrapped sensitive values', (t) => {
  const fx = fixture(t);
  const guid = '123e4567-e89b-42d3-a456-426614174000';
  const token = ['xox', 'b-inventedWrappedValue123456'].join('');
  const wrappedGuid = `GUID ${guid.slice(0, 18)}\n    ${guid.slice(18)}`;
  const wrappedToken = `Bearer ${token.slice(0, 12)}\n  ${token.slice(12)}`;
  const result = runRedact(fx, `${wrappedGuid}\n${wrappedToken}\n`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'GUID <uuid>\n<token>\n');
});

test('redact preserves clean text and unrelated indented lines', (t) => {
  const fx = fixture(t);
  const clean = 'first line\r\n  unrelated continuation\r\nversion 1.2.3\nplain text\n';
  const result = runRedact(fx, clean);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, clean);
  assert.equal(result.stderr, '');
});
