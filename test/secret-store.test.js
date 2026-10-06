import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// The store tests use a temporary HOME and a temporary HERDR_BOSS_DIR through test-env.js. The master key is
// invented, the values are invented, and no test reads a real login file or the Owner's keychain.
const here = path.dirname(fileURLToPath(import.meta.url));
const { PRIVATE_ACCESS_DIR } = await import('../src/config.js');
const {
  SECRET_NAME, SECRET_FORMAT_VERSION, NONCE_BYTES, TAG_BYTES, MASTER_KEY_BYTES,
  secretsDir, assertSecretName, sealValue, openSealedValue, createSecretStore,
} = await import('../src/secret-store.js');
const {
  KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, LINUX_MASTER_KEY_PATH,
  createFileKeyProvider, createKeychainKeyProvider, createMasterKeyProvider,
} = await import('../src/secret-master-key.js');
const { VOLUMES } = await import('../src/factory-store.js');

const VALUE_ONE = 'invented-value-1';
const VALUE_TWO = 'invented-value-2';
const KEY = Buffer.alloc(MASTER_KEY_BYTES, 0x11);
const OTHER_KEY = Buffer.alloc(MASTER_KEY_BYTES, 0x22);

let counter = 0;
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-secret-${counter += 1}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

const sealedPath = (dir, name) => path.join(dir, `${name}.sealed`);
const prevPath = (dir, name) => path.join(dir, `${name}.sealed.prev`);
const indexRaw = (dir) => fs.readFileSync(path.join(dir, 'index.json'), 'utf8');

test('the store directory comes from the private-directory helper and holds mode 0700', (t) => {
  assert.equal(secretsDir(), path.join(PRIVATE_ACCESS_DIR, 'secrets'));
  assert.equal(inside(process.env.HOME, secretsDir()), true);
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sealedPath(dir, 'alpha')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
});

test('the sealed file holds the version byte, a fresh nonce, and the name-bound tag', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE);
  const first = fs.readFileSync(sealedPath(dir, 'alpha'));
  assert.equal(first[0], SECRET_FORMAT_VERSION);
  assert.equal(first.length > 1 + NONCE_BYTES + TAG_BYTES, true);
  store.putSecret('alpha', VALUE_TWO);
  const second = fs.readFileSync(sealedPath(dir, 'alpha'));
  assert.notDeepEqual(first.subarray(1, 1 + NONCE_BYTES), second.subarray(1, 1 + NONCE_BYTES));
  assert.notDeepEqual(first, second);
  assert.equal(openSealedValue('alpha', second, KEY).toString('utf8'), VALUE_TWO);
  assert.equal(openSealedValue('alpha', fs.readFileSync(prevPath(dir, 'alpha')), KEY).toString('utf8'), VALUE_ONE);
});

test('a wrong key fails, and a renamed sealed file does not open under another name', (t) => {
  const dir = tempDir(t);
  const writer = createSecretStore({ dir, key: KEY });
  writer.putSecret('alpha', VALUE_ONE);
  const reader = createSecretStore({ dir, key: OTHER_KEY });
  assert.equal(reader.checkSecret('alpha'), 'failed');
  assert.throws(() => reader.getSecretValue('alpha'));
  fs.copyFileSync(sealedPath(dir, 'alpha'), sealedPath(dir, 'beta'));
  assert.equal(writer.checkSecret('beta'), 'failed');
  assert.equal(writer.checkSecret('alpha'), 'ok');
});

test('tampered ciphertext fails and never opens', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE);
  const sealed = fs.readFileSync(sealedPath(dir, 'alpha'));
  sealed[sealed.length - 1] ^= 0x01;
  fs.writeFileSync(sealedPath(dir, 'alpha'), sealed);
  assert.equal(store.checkSecret('alpha'), 'failed');
});

test('the index holds metadata only and never a value', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  const meta = { provider: 'opencode-go', label: 'invented-label', tool: 'opencode', quotaWindow: 'week', lastUsed: '2026-10-06T10:00:00.000Z', expires: '2026-11-01T00:00:00.000Z', entryHash: 'a'.repeat(64), value: VALUE_ONE };
  store.putSecret('alpha', VALUE_ONE, meta);
  const index = JSON.parse(indexRaw(dir));
  assert.equal(index.secrets.alpha.provider, 'opencode-go');
  assert.equal(index.secrets.alpha.label, 'invented-label');
  assert.equal(index.secrets.alpha.valueHash, createHash('sha256').update(fs.readFileSync(sealedPath(dir, 'alpha'))).digest('hex'));
  assert.equal(index.secrets.alpha.entryHash, 'a'.repeat(64));
  assert.equal('value' in index.secrets.alpha, false);
  assert.doesNotMatch(indexRaw(dir), new RegExp(VALUE_ONE));
  assert.doesNotMatch(JSON.stringify(store.listSecrets()), new RegExp(VALUE_ONE));
  assert.deepEqual(store.listSecrets().map((entry) => entry.name), ['alpha']);
});

test('a value hash changes with the value and the index holds no plain value field', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE, { provider: 'opencode-go' });
  const firstHash = store.listSecrets()[0].valueHash;
  store.putSecret('alpha', VALUE_TWO, { provider: 'opencode-go' });
  const secondHash = store.listSecrets()[0].valueHash;
  assert.notEqual(firstHash, secondHash);
  assert.equal(/^[a-f0-9]{64}$/.test(secondHash), true);
});

test('removeSecret overwrites both files with random bytes of the same length, then deletes them', (t) => {
  const dir = tempDir(t);
  const recorded = [];
  const filesystem = { ...fs, writeFileSync: (file, data, options) => { recorded.push({ file: String(file), data: Buffer.from(data) }); return fs.writeFileSync(file, data, options); } };
  const store = createSecretStore({ dir, key: KEY, fs: filesystem });
  store.putSecret('alpha', VALUE_ONE);
  store.putSecret('alpha', VALUE_TWO);
  const beforeSealed = fs.readFileSync(sealedPath(dir, 'alpha'));
  const beforePrev = fs.readFileSync(prevPath(dir, 'alpha'));
  recorded.length = 0;
  assert.equal(store.removeSecret('alpha'), true);
  assert.equal(fs.existsSync(sealedPath(dir, 'alpha')), false);
  assert.equal(fs.existsSync(prevPath(dir, 'alpha')), false);
  const overwrites = recorded.filter((entry) => entry.file === sealedPath(dir, 'alpha') || entry.file === prevPath(dir, 'alpha'));
  assert.equal(overwrites.length, 2);
  for (const entry of overwrites) {
    const original = entry.file === sealedPath(dir, 'alpha') ? beforeSealed : beforePrev;
    assert.equal(entry.data.length, original.length);
    assert.notDeepEqual(entry.data, original);
  }
  assert.deepEqual(store.listSecrets(), []);
  assert.equal(store.removeSecret('alpha'), false);
});

test('an atomic write leaves no temporary file behind', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE, { provider: 'opencode-go' });
  store.putSecret('alpha', VALUE_TWO, { provider: 'opencode-go' });
  const names = fs.readdirSync(dir);
  assert.equal(names.some((name) => name.endsWith('.tmp')), false);
  assert.deepEqual(names.sort(), ['alpha.sealed', 'alpha.sealed.prev', 'index.json']);
});

test('rotatePrev moves the current value to the previous slot and getSecretValue is internal only', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE);
  store.putSecret('alpha', VALUE_TWO);
  assert.equal(store.rotatePrev('alpha'), true);
  assert.equal(fs.existsSync(sealedPath(dir, 'alpha')), false);
  assert.equal(openSealedValue('alpha', fs.readFileSync(prevPath(dir, 'alpha')), KEY).toString('utf8'), VALUE_TWO);
  assert.equal(store.rotatePrev('alpha'), false);
});

test('a thrown error message never holds the value or the key material', (t) => {
  const dir = tempDir(t);
  const store = createSecretStore({ dir, key: KEY });
  store.putSecret('alpha', VALUE_ONE);
  const sealed = fs.readFileSync(sealedPath(dir, 'alpha'));
  sealed[sealed.length - 1] ^= 0x01;
  const fails = (error) => {
    const text = String(error && error.message);
    assert.doesNotMatch(text, new RegExp(VALUE_ONE));
    assert.doesNotMatch(text, new RegExp(KEY.toString('hex')));
    assert.doesNotMatch(text, new RegExp(KEY.toString('base64')));
    return true;
  };
  assert.throws(() => openSealedValue('alpha', sealed, KEY), fails);
  assert.throws(() => openSealedValue('beta', sealed, KEY), fails);
  const reader = createSecretStore({ dir, key: OTHER_KEY });
  assert.throws(() => reader.getSecretValue('alpha'), fails);
});

test('the secret name pattern accepts slugs and refuses everything else', () => {
  for (const good of ['a', 'alpha', 'alpha-1', '0abc', 'a'.repeat(64)]) assert.equal(assertSecretName(good), good);
  for (const bad of ['', '-alpha', 'Alpha', 'alpha_1', 'alpha.beta', 'a'.repeat(65), 'a/b', '../alpha']) {
    assert.throws(() => assertSecretName(bad), /secret name/i, `accepted ${bad}`);
  }
  assert.equal(SECRET_NAME.test('alpha-1'), true);
});

test('the store refuses a master key that is not 32 bytes', (t) => {
  const dir = tempDir(t);
  assert.throws(() => createSecretStore({ dir, key: Buffer.alloc(16) }), /32 bytes/i);
  assert.throws(() => createSecretStore({ dir, key: 'not-a-key' }), /32 bytes/i);
});

function secretValueReferences(root) {
  const references = [];
  for (const directory of ['src', 'public']) {
    const visit = (relative) => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && /\.(?:js|mjs|cjs|html)$/.test(entry.name)) {
          const normalized = child.split(path.sep).join('/');
          const testFile = child.split(path.sep).some((part) => part === 'test' || part === '__tests__')
            || /\.(?:test|spec)\.js$/.test(entry.name);
          if (!testFile && !['src/secret-store.js', 'src/secret-cli.js'].includes(normalized)
            && fs.readFileSync(path.join(root, child), 'utf8').includes('getSecretValue')) references.push(normalized);
        }
      }
    };
    visit(directory);
  }
  return references.sort();
}

test('server and public JavaScript do not import or use getSecretValue', (t) => {
  assert.deepEqual(secretValueReferences(path.join(here, '..')), []);

  const copy = tempDir(t);
  fs.cpSync(path.join(here, '..', 'src'), path.join(copy, 'src'), { recursive: true });
  fs.cpSync(path.join(here, '..', 'public'), path.join(copy, 'public'), { recursive: true });
  fs.appendFileSync(path.join(copy, 'src', 'server.js'), "\nimport { getSecretValue } from './secret-store.js';\n");
  assert.deepEqual(secretValueReferences(copy), ['src/server.js'], 'the scan finds a planted import in a temporary source copy');
});

test('the file key provider creates a 0600 file in a 0700 directory and reads the same key', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'keys', 'master-key');
  const provider = createFileKeyProvider({ path: file, random: () => Buffer.alloc(MASTER_KEY_BYTES, 0x33) });
  const key = provider.ensure();
  assert.deepEqual(key, Buffer.alloc(MASTER_KEY_BYTES, 0x33));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(provider.read(), key);
  assert.deepEqual(provider.ensure(), key);
  assert.equal(fs.readFileSync(file).length, MASTER_KEY_BYTES);
});

test('concurrent file key creation keeps one key and both providers use the winner', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'keys', 'master-key');
  let initialReads = 0;
  const raceFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'statSync' || property === 'readFileSync') return (name, ...args) => {
        if (name === file && initialReads < 2) {
          initialReads += 1;
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        return target[property](name, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const first = createFileKeyProvider({ path: file, fs: raceFs, random: () => Buffer.alloc(MASTER_KEY_BYTES, 0x41) });
  const second = createFileKeyProvider({ path: file, fs: raceFs, random: () => Buffer.alloc(MASTER_KEY_BYTES, 0x42) });

  const firstKey = first.ensure();
  const secondKey = second.ensure();
  assert.deepEqual(firstKey, secondKey);
  assert.equal(initialReads, 2, 'both providers observed a missing key before exclusive creation');
  const writer = createSecretStore({ dir: path.join(root, 'store'), key: firstKey });
  const reader = createSecretStore({ dir: path.join(root, 'store'), key: secondKey });
  writer.putSecret('alpha', 'invented-race-value');
  assert.equal(reader.getSecretValue('alpha').toString('utf8'), 'invented-race-value');
  assert.deepEqual(fs.readFileSync(file), firstKey);
});

test('the file key provider refuses a file that is not 32 bytes', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'master-key');
  fs.writeFileSync(file, Buffer.alloc(31), { mode: 0o600 });
  const provider = createFileKeyProvider({ path: file });
  assert.throws(() => provider.read(), /32 bytes/i);
});

test('the file key provider refuses group or other permissions with a chmod instruction', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'master-key');
  fs.writeFileSync(file, KEY, { mode: 0o600 });
  fs.chmodSync(file, 0o660);
  const provider = createFileKeyProvider({ path: file });
  assert.throws(() => provider.read(), (error) => {
    assert.equal(error.message, `The master key file ${file} has unsafe permissions; run chmod 600 ${file}.`);
    return true;
  });
});

test('the macOS keychain adapter never puts key material in a process argument', () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, input: options && options.input }); return { status: 0, stdout: '' }; };
  const provider = createKeychainKeyProvider({ run });
  const key = Buffer.alloc(MASTER_KEY_BYTES, 0x44);
  provider.write(key);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'security');
  assert.deepEqual(calls[0].args, ['-i']);
  for (const arg of calls[0].args) {
    assert.doesNotMatch(String(arg), new RegExp(key.toString('hex')));
    assert.doesNotMatch(String(arg), new RegExp(key.toString('base64')));
  }
  assert.match(calls[0].input, new RegExp(key.toString('hex')));
  assert.equal(calls[0].input.includes(KEYCHAIN_SERVICE), true);
  assert.equal(calls[0].input.includes(KEYCHAIN_ACCOUNT), true);
});

test('the macOS keychain adapter reads the key from the keychain output', () => {
  const key = Buffer.alloc(MASTER_KEY_BYTES, 0x55);
  const run = (command, args) => {
    assert.equal(command, 'security');
    assert.equal(args.includes('-w'), true);
    return { status: 0, stdout: `${key.toString('hex')}\n` };
  };
  const provider = createKeychainKeyProvider({ run });
  assert.deepEqual(provider.read(), key);
});

test('the platform picks the keychain on macOS and the file on Linux', () => {
  const keychain = { name: 'keychain' };
  const file = { name: 'file' };
  assert.equal(createMasterKeyProvider({ platform: 'darwin', keychain, file }), keychain);
  assert.equal(createMasterKeyProvider({ platform: 'linux', keychain, file }), file);
});

test('the Linux master key path stays outside the store directory and every factory volume', () => {
  assert.equal(inside(secretsDir(), LINUX_MASTER_KEY_PATH), false);
  for (const root of Object.values(VOLUMES)) assert.equal(inside(root, LINUX_MASTER_KEY_PATH), false, `key is inside ${root}`);
  assert.equal(path.isAbsolute(LINUX_MASTER_KEY_PATH), true);
});
