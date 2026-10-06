// The master key of the sealed secret store. The key is 32 random bytes.
//
// macOS: the OS keychain holds the key through the `security` command. The adapter passes the key through
// stdin (`security -i`) and never through a process argument, because the argument list is visible in the
// process table.
//
// Linux: the key is a 0600 file. The path stays outside the volumes that `factory backup` copies
// (`data`, `work`, and the optional `home` volume; see src/factory-recovery.js and src/factory-store.js).
// The factory image must create the directory for the `factory` user, or the host must inject the key at
// this path at start. The real Linux path stays unverified until the factory image mounts it.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MASTER_KEY_BYTES = 32;
export const KEYCHAIN_SERVICE = 'no.tallmaker.herdr-boss';
export const KEYCHAIN_ACCOUNT = 'secret-store-master-key';
// A 0600 file outside the store directory and outside every factory volume that `factory backup` copies.
export const LINUX_MASTER_KEY_PATH = '/var/lib/herdr-boss/master-key';

export function assertMasterKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) throw new Error('The master key must hold 32 bytes.');
  return key;
}

function writeKeyExclusive(filesystem, file, key) {
  const directory = path.dirname(file);
  filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  filesystem.chmodSync(directory, 0o700);
  // Write a complete temporary file, then link it. A link never replaces a file, so a reader sees the whole key or no file.
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = filesystem.openSync(temporary, 'wx', 0o600);
    filesystem.writeFileSync(fd, key);
    filesystem.fchmodSync(fd, 0o600);
    filesystem.fsyncSync(fd);
    filesystem.closeSync(fd);
    fd = undefined;
    filesystem.linkSync(temporary, file);
  } finally {
    if (fd !== undefined) { try { filesystem.closeSync(fd); } catch {} }
    try { filesystem.unlinkSync(temporary); } catch {}
  }
}

// The file key provider. It creates the key only when it is absent, and it reads the same key later.
export function createFileKeyProvider({ path: file = LINUX_MASTER_KEY_PATH, fs: filesystem = fs, random = randomBytes } = {}) {
  function read() {
    let raw;
    try {
      const mode = filesystem.statSync(file).mode & 0o777;
      if (mode & 0o077) throw new Error(`The master key file ${file} has unsafe permissions; run chmod 600 ${file}.`);
      raw = filesystem.readFileSync(file);
    }
    catch (error) {
      if (error.code === 'ENOENT') {
        const missing = new Error('The master key file does not exist.');
        missing.code = 'ENOENT';
        throw missing;
      }
      throw error;
    }
    if (raw.length !== MASTER_KEY_BYTES) throw new Error('The master key file must hold 32 bytes.');
    return Buffer.from(raw);
  }
  function write(key) {
    assertMasterKey(key);
    writeKeyExclusive(filesystem, file, key);
  }
  function ensure() {
    try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const key = Buffer.from(random(MASTER_KEY_BYTES));
    try {
      write(key);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return read();
    }
  }
  return { path: file, read, write, ensure };
}

// The injected runner returns a spawnSync-like result. It never receives the key in its argument list.
function runSecurity(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', input: options.input });
}

// The macOS keychain adapter. The key goes in through stdin and comes out through stdout.
export function createKeychainKeyProvider({ service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT, run = runSecurity } = {}) {
  function read() {
    const result = run('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
    if (!result || result.status !== 0) throw new Error('The macOS keychain holds no master key.');
    const text = String(result.stdout ?? '').trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error('The macOS keychain master key is invalid.');
    return Buffer.from(text, 'hex');
  }
  function write(key) {
    assertMasterKey(key);
    // The command text holds the key. It goes through stdin, not through an argument.
    const command = `add-generic-password -U -a ${account} -s ${service} -w ${key.toString('hex')}`;
    const result = run('security', ['-i'], { input: `${command}\n` });
    if (!result || result.status !== 0) throw new Error('The macOS keychain did not accept the master key.');
  }
  function ensure() {
    try { return read(); } catch (error) { if (!/holds no master key/.test(error.message)) throw error; }
    const key = randomBytes(MASTER_KEY_BYTES);
    write(key);
    return key;
  }
  return { read, write, ensure };
}

// The platform decides the key location. The injected value keeps tests off the real keychain.
export function createMasterKeyProvider({ platform = process.platform, keychain = createKeychainKeyProvider(), file = createFileKeyProvider() } = {}) {
  return platform === 'darwin' ? keychain : file;
}
