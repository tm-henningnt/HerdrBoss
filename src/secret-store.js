// The sealed secret store. Each secret is one file `NAME.sealed` under `~/.config/herdr-boss/secrets/`.
// The file holds the value with AES-256-GCM. The secret name is the additional authenticated data, so a
// renamed file does not open under another name. The store keeps a metadata index only; it never writes a
// value into the index, a log line, or a dashboard payload.
//
// `getSecretValue` is for internal use only. The server and the API route modules must not import it.
// The dashboard sets no value. The Owner sets a value only with `secret set` at a terminal (a later slice).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { PRIVATE_ACCESS_DIR } from './config.js';
import { MASTER_KEY_BYTES, assertMasterKey } from './secret-master-key.js';

export { MASTER_KEY_BYTES };

export const SECRET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SECRET_FORMAT_VERSION = 1;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const INDEX_FILE = 'index.json';

// The same private directory that holds the access token and the session file. A temporary HOME moves it.
export function secretsDir() {
  return path.join(PRIVATE_ACCESS_DIR, 'secrets');
}

export function assertSecretName(name) {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) throw new Error('Use a secret name with lower case letters, digits, and hyphens.');
  return name;
}

// The sealed layout: version byte, 96-bit nonce, 128-bit tag, ciphertext. The name binds the tag.
export function sealValue(name, value, key) {
  assertSecretName(name);
  assertMasterKey(key);
  const plain = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([SECRET_FORMAT_VERSION]), nonce, tag, ciphertext]);
}

export function openSealedValue(name, sealed, key) {
  assertSecretName(name);
  assertMasterKey(key);
  if (!Buffer.isBuffer(sealed) || sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error('The sealed secret is invalid.');
  if (sealed[0] !== SECRET_FORMAT_VERSION) throw new Error('The sealed secret has an unsupported format version.');
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(1 + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(name, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// A temporary file in the same directory, mode 0600, fsync, rename. The rename replaces the target atomically.
function writeAtomic(filesystem, file, data) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = filesystem.openSync(temporary, 'wx', 0o600);
    filesystem.writeFileSync(fd, data);
    filesystem.fchmodSync(fd, 0o600);
    filesystem.fsyncSync(fd);
    filesystem.closeSync(fd);
    fd = undefined;
    filesystem.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) { try { filesystem.closeSync(fd); } catch {} }
    try { filesystem.unlinkSync(temporary); } catch {}
    throw error;
  }
}

// Keep only a string in the index. A value or an object in the metadata never reaches the index.
const text = (value) => (typeof value === 'string' ? value : null);

export function createSecretStore({ dir = secretsDir(), key, fs: filesystem = fs, random = randomBytes, now = () => new Date().toISOString() } = {}) {
  assertMasterKey(key);
  const directory = path.resolve(dir);
  const sealedFile = (name) => path.join(directory, `${name}.sealed`);
  const prevFile = (name) => path.join(directory, `${name}.sealed.prev`);
  const indexFile = () => path.join(directory, INDEX_FILE);

  function ensureDir() {
    filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    filesystem.chmodSync(directory, 0o700);
  }

  function readIndex() {
    let raw;
    try { raw = filesystem.readFileSync(indexFile(), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, secrets: {} }; throw error; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('The secret index is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.secrets || typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets)) throw new Error('The secret index is invalid.');
    return parsed;
  }

  function writeIndex(index) {
    ensureDir();
    writeAtomic(filesystem, indexFile(), Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8'));
  }

  function rotatePrev(name) {
    assertSecretName(name);
    const current = sealedFile(name);
    if (!filesystem.existsSync(current)) return false;
    filesystem.renameSync(current, prevFile(name));
    return true;
  }

  function putSecret(name, value, meta = {}, { rotate = true } = {}) {
    assertSecretName(name);
    ensureDir();
    const plain = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
    const sealed = sealValue(name, plain, key);
    if (rotate) rotatePrev(name);
    writeAtomic(filesystem, sealedFile(name), sealed);
    const index = readIndex();
    index.secrets[name] = {
      name,
      provider: text(meta.provider),
      label: text(meta.label),
      tool: text(meta.tool),
      quotaWindow: text(meta.quotaWindow),
      lastUsed: text(meta.lastUsed),
      expires: text(meta.expires),
      valueHash: createHash('sha256').update(sealed).digest('hex'),
      entryHash: text(meta.entryHash),
      updatedAt: now(),
    };
    writeIndex(index);
    return { ...index.secrets[name] };
  }

  // Internal use only. The server and the API route modules must not call this method.
  function getSecretValue(name) {
    assertSecretName(name);
    return openSealedValue(name, filesystem.readFileSync(sealedFile(name)), key);
  }

  function listSecrets() {
    return Object.values(readIndex().secrets).map((entry) => ({ ...entry }));
  }

  function removeSecret(name) {
    assertSecretName(name);
    let removed = false;
    for (const file of [sealedFile(name), prevFile(name)]) {
      let data;
      try { data = filesystem.readFileSync(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      filesystem.writeFileSync(file, random(data.length), { mode: 0o600 });
      filesystem.unlinkSync(file);
      removed = true;
    }
    const index = readIndex();
    if (Object.prototype.hasOwnProperty.call(index.secrets, name)) {
      delete index.secrets[name];
      writeIndex(index);
      removed = true;
    }
    return removed;
  }

  function checkSecret(name) {
    try { getSecretValue(name); return 'ok'; }
    catch { return 'failed'; }
  }

  return { dir: directory, putSecret, getSecretValue, listSecrets, removeSecret, checkSecret, rotatePrev };
}
