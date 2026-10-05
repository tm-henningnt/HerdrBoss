import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'docs-gate.js');

// A fake JWT, a fake private key, and a fake license blob. Each text is invented.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz\n-----END RSA PRIVATE KEY-----';
const LICENSE_BLOB = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo';
const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890abcdefghijklmnopqrstuv\n-----END PUBLIC KEY-----';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

// A fixture repository with a main branch and a feature branch. Each test writes a bundle file and a docs change.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-docs-gate-tokens-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'public/app.js', 'export const a = 1;\n');
  write(root, 'docs/guide.md', '# Guide\n');
  commit(root, 'Start');
  git(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function gate(root, args = []) {
  const result = spawnSync(process.execPath, [script, '--root', root, '--base', 'main', ...args], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// A bundle change with a docs change, so the docs check passes and only the token check can fail.
function bundle(root, name, text) {
  write(root, name, text);
  write(root, 'docs/guide.md', '# Guide\n\nMore text.\n');
  commit(root, 'Ship a bundle');
}

test('the gate fails when a bundle holds a JWT', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', `const token = '${JWT}';\n`);
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /public\/app\.js/);
  assert.match(result.out, /jwt/i);
});

test('the gate fails when a bundle holds a PEM private key block', (t) => {
  const root = fixture(t);
  bundle(root, 'fixtures/app/app.js', `const key = \`${PRIVATE_KEY}\`;\n`);
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /fixtures\/app\/app\.js/);
  assert.match(result.out, /private key/i);
});

test('the gate fails when a bundle holds a long license blob', (t) => {
  const root = fixture(t);
  bundle(root, 'demo/app.js', `const licenseKey = '${LICENSE_BLOB}';\n`);
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /license/i);
});

test('the gate passes for a public verification key in a bundle', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', `const key = \`${PUBLIC_KEY}\`;\nexport const licenseKey = key;\n`);
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes for a test string with the allow marker', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', `const token = '${JWT}'; // herdr-boss: allow-test-token\n`);
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate passes for a bundle with no token-shaped string', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', 'const license = "no key text here";\nexport const a = 2;\n');
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the gate does not scan a unit test file for tokens', (t) => {
  const root = fixture(t);
  bundle(root, 'test/engine.test.js', `const fake = '${JWT}';\n`);
  const result = gate(root);
  assert.equal(result.code, 0, result.out);
});

test('the token check runs without a docs change', (t) => {
  const root = fixture(t);
  write(root, 'public/app.js', `const token = '${JWT}';\n`);
  commit(root, 'Ship a bundle with no docs change');
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /public\/app\.js/);
});

test('the token scanner names the classes of a text', async () => {
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  assert.deepEqual(scanTokenText(`const a = 1;\n`), []);
  assert.deepEqual(scanTokenText(`const t = '${JWT}';\n`), ['jwt']);
  assert.deepEqual(scanTokenText(`${PRIVATE_KEY}\n`), ['PEM private key block']);
  assert.deepEqual(scanTokenText(`licenseKey: ${LICENSE_BLOB}\n`), ['license blob']);
  assert.deepEqual(scanTokenText(`const t = '${JWT}'; // herdr-boss: allow-test-token\n`), []);
  assert.deepEqual(scanTokenText(`${PUBLIC_KEY}\n`), []);
});

test('the token scan does not print the value it found', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', `const token = '${JWT}';\n`);
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
  assert.ok(!result.out.includes('eyJhbGciOiJIUzI1NiJ9'), 'the gate printed the token');
  assert.ok(!result.out.includes(LICENSE_BLOB), 'the gate printed the license blob');
});