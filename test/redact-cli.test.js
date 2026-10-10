import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli.js');
const TEST_HOST = 'fixture.eu.example.invalid';
const EXTENSION_GROUPS = [
  ['Q1w2E', 'R3t4Y5u6', 'I7o8P9a0S1d2F3g4H'],
  ['Q1w2E3r4T5y6U7i8O', 'P9a0S1d2F3g4H5'],
  ['Q1w2E3r4', 'T5y6U7i8', 'O9p0A1s2D3f4G5'],
];
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
  return { env, home, data, privateDir, root };
}

function runRedact(fx, input = '', args = [], cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, 'redact', ...args], {
    cwd,
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

test('redact stores private literals from stdin and lists only class counts', (t) => {
  const fx = fixture(t, { keep: { setting: true }, redact: { tenantHosts: [TEST_HOST] } });
  const samples = {
    host: 'literal.example.invalid',
    'app-id': 'invented-application',
    'ext-id': 'invented-extension',
    'space-id': 'invented-space',
  };
  for (const [kind, value] of Object.entries(samples)) {
    const added = runRedact(fx, `${value}\n`, ['add', kind]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(added.stdout, '');
    assert.equal(added.stderr, '');
    assert.equal(runRedact(fx, `${value}\r\n`, ['add', kind]).status, 0);
  }
  const listed = runRedact(fx, '', ['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, 'host: 1\napp-id: 1\next-id: 1\nspace-id: 1\n');
  const stored = JSON.parse(fs.readFileSync(path.join(fx.privateDir, 'config.json'), 'utf8'));
  assert.deepEqual(stored.keep, { setting: true });
  assert.deepEqual(stored.redact.tenantHosts, [TEST_HOST]);
  for (const [kind, value] of Object.entries(samples)) assert.deepEqual(stored.redact.literals[kind], [value]);
  assert.equal(fs.statSync(path.join(fx.privateDir, 'config.json')).mode & 0o777, 0o600);
  const input = Object.values(samples).join(' ') + '\n';
  assert.equal(runRedact(fx, input).stdout, '<host> <app-id> <ext-id> <space-id>\n');
  const nearMisses = Object.values(samples).map((value) => `prefix-${value} ${value}-suffix ${value.toUpperCase()}`).join('\n');
  assert.equal(runRedact(fx, nearMisses).stdout, nearMisses);
  assert.deepEqual(fs.readdirSync(fx.data), []);
});

test('redact recognizes Qlik and extension shapes after earlier classes', (t) => {
  const fx = fixture(t);
  const qlikId = 'Q1w2E3r4T5y6U7i8O9p0A1s2';
  const extensionId = ['Q1w2E', 'R3t4Y5u6', 'I7o8P9a0S1d2F3g4H'].join('-');
  const guid = ['a1b2c3d4', 'e5f6', '7890', 'abcd', 'ef0123456789'].join('-');
  const literalHex = 'a'.repeat(24);
  const config = { redact: { tenantHosts: [TEST_HOST], literals: { 'app-id': [literalHex, guid] } } };
  fs.writeFileSync(path.join(fx.privateDir, 'config.json'), JSON.stringify(config));
  const input = [
    `${qlikId} ${qlikId.toUpperCase()} ${extensionId} ${extensionId.toUpperCase()}`,
    `https://${TEST_HOST}/apps/${qlikId}/extensions/${extensionId}`,
    `${guid} ${literalHex} ${'b'.repeat(24)} ${'c'.repeat(40)}`,
    `object ${qlikId.slice(0, 12)}\n    ${qlikId.slice(12)}`,
    `extension ${extensionId.slice(0, 15)}\n    ${extensionId.slice(15)}`,
    '',
  ].join('\n');
  const result = runRedact(fx, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    '<qlik-id> <qlik-id> <ext-id> <ext-id>',
    'https://<host>/apps/<qlik-id>/extensions/<ext-id>',
    '<uuid> <app-id> <hex> <hex>',
    'object <qlik-id>',
    'extension <ext-id>',
    '',
  ].join('\n'));
});

test('redact recognizes all supported extension ID splits in text, URLs and wrapped lines', (t) => {
  const fx = fixture(t);
  const extensionIds = EXTENSION_GROUPS.map((groups) => groups.join('-'));
  const input = extensionIds.flatMap((id) => [
    `${id} ${id.toUpperCase()} ${id.toLowerCase()}`,
    `https://example.test/extensions/${id}?view=summary`,
    `(${id}), _${id}_`,
    `extension ${id.slice(0, 15)}\n    ${id.slice(15)}`,
  ]).join('\n') + '\n';
  const result = runRedact(fx, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, extensionIds.flatMap(() => [
    '<ext-id> <ext-id> <ext-id>',
    'https://example.test/extensions/<ext-id>?view=summary',
    '(<ext-id>), _<ext-id>_',
    'extension <ext-id>',
  ]).join('\n') + '\n');
});

test('redact rejects extension ID near misses and keeps earlier UUID and hex classes', (t) => {
  const fx = fixture(t);
  const nearMisses = EXTENSION_GROUPS.flatMap((groups) => {
    const id = groups.join('-');
    return [
      id.slice(0, -1), `${id}X`,
      `-${id}`, `${id}-`, `X${id}`, `1${id}`, `${id}1`,
      groups.join('--'),
      ...groups.map((group, index) => groups.map((value, n) => n === index ? 'Q'.repeat(group.length) : value).join('-')),
      ...groups.map((group, index) => groups.map((value, n) => n === index ? '1'.repeat(group.length) : value).join('-')),
    ];
  });
  nearMisses.push(
    ['Q1w2E3r', 'T4y5U6i', 'O7p8A9s', 'D0f1G2h3'].join('-'),
    ['Q1w2', 'E3r4T5y6U', 'I7o8P9a0S1d2F3g4H'].join('-'),
    ['Q1w2E3r4T5y6U7i8O9', 'P0a1S2d3F4g5H'].join('-'),
    'Q1'.repeat(16),
    'ordinary-hyphenated-phrase-words',
    'abc1234', 'abc1234def56',
  );
  const guid = ['a1b2c3d4', 'e5f6', '7890', 'abcd', 'ef0123456789'].join('-');
  const commit = 'abcd1234'.repeat(5);
  const input = [...nearMisses, guid, commit, ''].join('\n');
  const result = runRedact(fx, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [...nearMisses, '<uuid>', '<hex>', ''].join('\n'));
});

test('redact leaves ordinary words, short git ids and near misses unchanged', (t) => {
  const fx = fixture(t);
  const qlikId = 'Q1w2E3r4T5y6U7i8O9p0A1s2';
  const parts = ['Q1w2E', 'R3t4Y5u6', 'I7o8P9a0S1d2F3g4H'];
  const extensionId = parts.join('-');
  const nearMisses = [
    'ordinarywordswithoutnums',
    `${qlikId}X`, qlikId.slice(1), `prefix-${qlikId}`, `${qlikId}-suffix`, `_${qlikId}_`,
    `${extensionId}X`, `prefix-${extensionId}`, `${extensionId}-suffix`,
    [parts[0].slice(1), parts[1], parts[2]].join('-'),
    [parts[0], parts[1].slice(1), parts[2]].join('-'),
    [parts[0], parts[1], parts[2].slice(1)].join('-'),
    ...parts.map((part, index) => parts.map((value, n) => n === index ? 'Q'.repeat(part.length) : value).join('-')),
    ...parts.map((part, index) => parts.map((value, n) => n === index ? '1'.repeat(part.length) : value).join('-')),
    'these-ordinary-hyphenatedwords',
    'abc1234', 'abc1234def56',
    '',
  ].join('\n');
  const result = runRedact(fx, nearMisses);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, nearMisses);
});

function trackedFixture(t, files) {
  const fx = fixture(t);
  const cwd = path.join(fx.root, 'repo');
  fs.mkdirSync(cwd);
  const git = (args, input) => execFileSync('git', args, { cwd, env: fx.env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cwd, name), content);
    const hash = git(['hash-object', '-w', '--stdin'], content).trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${hash},${name}`]);
  }
  return { ...fx, cwd };
}

test('redact check reports all extension ID splits without matching text', (t) => {
  const extensionIds = EXTENSION_GROUPS.map((groups) => groups.join('-'));
  const fx = trackedFixture(t, {
    'extensions.txt': [
      'plain',
      extensionIds.join(' '),
      extensionIds[1].toUpperCase(),
      `https://example.test/extensions/${extensionIds[2]}`,
      `extension ${extensionIds[1].slice(0, 15)}`,
      `    ${extensionIds[1].slice(15)}`,
      '',
    ].join('\n'),
  });
  const result = runRedact(fx, '', ['--check', 'extensions.txt'], fx.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'extensions.txt:2 ext-id: 3',
    'extensions.txt:3 ext-id: 1',
    'extensions.txt:4 ext-id: 1',
    'extensions.txt:5 ext-id: 1',
    'ext-id: 6',
    '',
  ].join('\n'));
  for (const id of extensionIds) {
    assert.ok(!result.stdout.includes(id));
    assert.ok(!result.stdout.includes(id.toUpperCase()));
  }
  for (const group of EXTENSION_GROUPS.flat()) assert.ok(!result.stdout.includes(group));
});

test('redact check prints only tracked file locations, classes and counts', (t) => {
  const qlikId = 'Q1w2E3r4T5y6U7i8O9p0A1s2';
  const extensionId = ['Q1w2E', 'R3t4Y5u6', 'I7o8P9a0S1d2F3g4H'].join('-');
  const guid = ['a1b2c3d4', 'e5f6', '7890', 'abcd', 'ef0123456789'].join('-');
  const fx = trackedFixture(t, {
    'sample.txt': `plain\n${qlikId} ${qlikId.toUpperCase()}\n${extensionId}\n${guid}${'a'.repeat(32)}\n`,
    'clean.txt': 'ordinary text\n',
  });
  const result = runRedact(fx, '', ['--check', 'sample.txt', 'clean.txt'], fx.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'sample.txt:2 qlik-id: 2',
    'sample.txt:3 ext-id: 1',
    'sample.txt:4 uuid: 1',
    'sample.txt:4 hex: 1',
    'qlik-id: 2', 'ext-id: 1', 'uuid: 1', 'hex: 1', '',
  ].join('\n'));
  for (const value of [qlikId, extensionId, guid, 'a'.repeat(32)]) assert.ok(!result.stdout.includes(value));
  assert.equal(runRedact(fx, '', ['--check', 'clean.txt'], fx.cwd).status, 0);
  assert.equal(runRedact(fx, '', ['--check', 'clean.txt'], fx.cwd).stdout, '');
  fs.writeFileSync(path.join(fx.cwd, 'untracked.txt'), qlikId);
  const all = runRedact(fx, '', ['--check'], fx.cwd);
  assert.equal(all.status, 1, all.stderr);
  assert.equal(all.stdout, result.stdout);
  const untracked = runRedact(fx, '', ['--check', 'untracked.txt'], fx.cwd);
  assert.equal(untracked.status, 2);
  assert.equal(untracked.stdout, '');
  assert.ok(!untracked.stderr.includes(qlikId));
});

test('redact check shares private literals, wrapped values and secret rules', (t) => {
  const qlikId = 'Q1w2E3r4T5y6U7i8O9p0A1s2';
  const extensionId = ['Q1w2E', 'R3t4Y5u6', 'I7o8P9a0S1d2F3g4H'].join('-');
  const app = 'invented-application';
  const extension = 'invented-extension';
  const space = 'invented-space';
  const beginKey = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('');
  const endKey = ['-----END ', 'PRIVATE KEY', '-----'].join('');
  const token = ['ghp', '_', 'inventedValue123456789'].join('');
  const fx = trackedFixture(t, {
    'sample.txt': [
      'plain',
      `object ${qlikId.slice(0, 12)}`, `    ${qlikId.slice(12)}`,
      `extension ${extensionId.slice(0, 15)}`, `    ${extensionId.slice(15)}`,
      `https://${TEST_HOST}/apps/${app}/extensions/${extension}?space=${space}`,
      `Bearer ${token}`, 'password=made-up-password', 'appId=unlisted-application',
      beginKey, 'invented-key-body', endKey,
      `plain ${qlikId}`, '',
    ].join('\r\n'),
  });
  for (const [kind, value] of [['app-id', app], ['ext-id', extension], ['space-id', space]]) {
    assert.equal(runRedact(fx, value, ['add', kind]).status, 0);
  }
  const result = runRedact(fx, '', ['--check', 'sample.txt'], fx.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'sample.txt:2 qlik-id: 1', 'sample.txt:4 ext-id: 1',
    'sample.txt:6 host: 1', 'sample.txt:6 app-id: 1', 'sample.txt:6 ext-id: 1', 'sample.txt:6 space-id: 1',
    'sample.txt:7 token: 1', 'sample.txt:8 secret: 1', 'sample.txt:9 id: 1',
    'sample.txt:10 key: 1', 'sample.txt:13 qlik-id: 1',
    'qlik-id: 2', 'ext-id: 2', 'host: 1', 'app-id: 1', 'space-id: 1', 'token: 1', 'secret: 1', 'id: 1', 'key: 1', '',
  ].join('\n'));
  for (const value of [qlikId, extensionId, TEST_HOST, app, extension, space, token, 'made-up-password', 'invented-key-body']) {
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stderr.includes(value));
  }
});

test('redact add rejects invalid input and preserves an unreadable private config', (t) => {
  const fx = fixture(t);
  const configFile = path.join(fx.privateDir, 'config.json');
  const original = fs.readFileSync(configFile, 'utf8');
  for (const input of ['', 'two words', 'two\nlines\n', 'Q'.repeat(4097), Buffer.from([0xff])]) {
    const result = runRedact(fx, input, ['add', 'app-id']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'herdr-boss redact: literal could not be stored safely. Use one literal from a pipe.\n');
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  }
  assert.equal(runRedact(fx, 'invented-id', ['add', 'unknown']).status, 2);
  assert.equal(runRedact(fx, '', ['list', 'extra']).status, 2);
  fs.writeFileSync(configFile, '{invalid-json');
  assert.equal(runRedact(fx, 'invented-id', ['add', 'app-id']).status, 1);
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{invalid-json');
});

test('redact creates a missing private config and matches escaped literals across wraps', (t) => {
  const fx = fixture(t);
  fs.rmSync(fx.privateDir, { recursive: true });
  const literal = 'invented+literal(1)';
  const added = runRedact(fx, `${literal}\n`, ['add', 'app-id']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(fs.statSync(fx.privateDir).mode & 0o777, 0o700);
  const result = runRedact(fx, `${literal.slice(0, 10)}\n  ${literal.slice(10)}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '<app-id>\n');
  assert.equal(runRedact(fx, '', ['list']).stdout, 'host: 0\napp-id: 1\next-id: 0\nspace-id: 0\n');
});

test('redact check refuses missing and symbolic-link files without partial findings', (t) => {
  const qlikId = 'Q1w2E3r4T5y6U7i8O9p0A1s2';
  const fx = trackedFixture(t, { 'first.txt': qlikId, 'second.txt': 'clean' });
  fs.rmSync(path.join(fx.cwd, 'second.txt'));
  for (const second of ['second.txt', '../outside.txt']) {
    const result = runRedact(fx, '', ['--check', 'first.txt', second], fx.cwd);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'herdr-boss redact: check could not scan tracked files safely.\n');
  }
  fs.symlinkSync(path.join(fx.cwd, 'first.txt'), path.join(fx.cwd, 'second.txt'));
  assert.equal(runRedact(fx, '', ['--check', 'second.txt'], fx.cwd).status, 2);
});

test('redact check masks a private literal in a file name before printing locations', (t) => {
  const app = 'invented-application';
  const name = `${app}.txt`;
  const fx = trackedFixture(t, { [name]: `${app}\n` });
  assert.equal(runRedact(fx, app, ['add', 'app-id']).status, 0);
  const result = runRedact(fx, '', ['--check', name], fx.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '<app-id>.txt:1 app-id: 1\napp-id: 1\n');
  assert.ok(!result.stdout.includes(app));
});

test('redact preserves earlier class tags inside quoted id and secret fields', (t) => {
  const app = 'invented-application';
  const extension = 'invented-extension';
  const guid = ['a1b2c3d4', 'e5f6', '7890', 'abcd', 'ef0123456789'].join('-');
  const fx = fixture(t, { redact: { literals: { 'app-id': [app], 'ext-id': [extension] } } });
  const input = `{"appId":"${app}","spaceId":"${guid}","secret":"${extension}"}\nappId='${app}' token=${extension}\n`;
  const result = runRedact(fx, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"appId":"<app-id>","spaceId":"<uuid>","secret":"<ext-id>"}\nappId=\'<app-id>\' token=<ext-id>\n');
});
