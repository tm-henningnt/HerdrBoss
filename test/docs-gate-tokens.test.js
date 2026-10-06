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

test('the token scanner finds a license blob under snake, kebab, camel, and upper case key names', async () => {
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  for (const key of ['license_key', 'LICENSE_KEY', 'licenseToken', 'access_token', 'accessToken', 'license-key', 'LicenseKey']) {
    assert.deepEqual(scanTokenText(`${key}: "${LICENSE_BLOB}"\n`), ['license blob'], key);
    assert.deepEqual(scanTokenText(`${key}=${LICENSE_BLOB}\n`), ['license blob'], `${key}=`);
  }
});

test('the token scanner finds a license blob on the line after the key', async () => {
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  assert.deepEqual(scanTokenText(`license:\n  ${LICENSE_BLOB}\n`), ['license blob']);
  assert.deepEqual(scanTokenText(`access_token: |\n  ${LICENSE_BLOB}\n`), ['license blob']);
  assert.deepEqual(scanTokenText(`license:\n\n  "${LICENSE_BLOB}"\n`), ['license blob']);
  assert.deepEqual(scanTokenText(`license:\n  ${LICENSE_BLOB} # herdr-boss: allow-test-token\n`), []);
  assert.deepEqual(scanTokenText(`license:\n  name: MIT\n`), []);
});

test('the token scanner keeps the false-positive checks with the wider key names', async () => {
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  assert.deepEqual(scanTokenText(`sha256: ${LICENSE_BLOB}\n`), []);
  assert.deepEqual(scanTokenText(`integrity_sha256 = "${LICENSE_BLOB}"\n`), []);
  assert.deepEqual(scanTokenText(`tokenizer = "${LICENSE_BLOB}"\n`), []);
  assert.deepEqual(scanTokenText(`const logo = 'data:image/png;base64,${LICENSE_BLOB}';\n`), []);
  assert.deepEqual(scanTokenText(`${PUBLIC_KEY}\nlicense_key = key\n`), []);
});

test('the token scanner reads every line of a long text', async () => {
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  const filler = 'x\n'.repeat(30000);
  assert.deepEqual(scanTokenText(`${filler}const t = '${JWT}';\n`), ['jwt']);
});

test('the gate reads a file larger than the default git output buffer', (t) => {
  const root = fixture(t);
  bundle(root, 'public/app.js', `${'// filler line of text for the size\n'.repeat(60000)}const t = '${JWT}';\n`);
  const result = gate(root);
  assert.equal(result.code, 1, result.out);
});

test('the gate reads an uncommitted file with --include-worktree', (t) => {
  const root = fixture(t);
  write(root, 'public/new.js', `const t = '${JWT}';\n`);
  write(root, 'docs/guide.md', '# Guide\n\nMore text.\n');
  assert.equal(gate(root).code, 0);
  const result = gate(root, ['--include-worktree']);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /public\/new\.js/);
});

test('the gate reads the working tree content of a modified file with --include-worktree', (t) => {
  const root = fixture(t);
  write(root, 'public/app.js', `const t = '${JWT}';\n`);
  write(root, 'docs/guide.md', '# Guide\n\nMore text.\n');
  const result = gate(root, ['--include-worktree']);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /public\/app\.js/);
});

test('the token globs cover the source, kit, script, example, and root files', async () => {
  const { loadRules } = await import('../scripts/docs-gate.js');
  const { tokens } = loadRules();
  for (const glob of ['src/**', 'kit/**', 'scripts/**', 'examples/**', '*']) assert.ok(tokens.includes(glob), glob);
  assert.ok(!tokens.some((glob) => glob.startsWith('test/') && !glob.startsWith('test/fixtures') && !glob.startsWith('test/apps') && !glob.startsWith('test/demos')));
});

test('the gate fails when a source file or a root file holds a JWT', (t) => {
  for (const file of ['src/auth.js', 'kit/templates/x.md', 'scripts/tool.js', 'examples/demo/a.js', 'config.json']) {
    const root = fixture(t);
    bundle(root, file, `const t = '${JWT}';\n`);
    const result = gate(root);
    assert.equal(result.code, 1, `${file}: ${result.out}`);
    git(root, ['checkout', '-q', 'main']);
    git(root, ['branch', '-q', '-D', 'feature']);
  }
});

test('the tracked tree of this repository passes the token check outside test files', async () => {
  const { scanTokenText, loadRules } = await import('../scripts/docs-gate.js');
  const rules = loadRules();
  const files = git(repo, ['ls-files']).split('\n').filter(Boolean);
  const globs = rules.tokens.map((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`));
  const found = [];
  for (const file of files.filter((name) => globs.some((re) => re.test(name)))) {
    let text;
    try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    if (scanTokenText(text).length) found.push(file);
  }
  assert.deepEqual(found, []);
});
