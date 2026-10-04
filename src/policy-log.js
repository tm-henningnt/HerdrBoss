// The change log of policy writes: one JSON line in policy-changes.jsonl in the data dir for each write that changes a value.
// A line is { at, caller, changes: [{ key, old, new }] }. The caller kind is a label: a client sets it, so it proves no identity.
// The reader skips every line that does not validate and never throws.
// A trim reads the file and renames a new one over it. An append and a trim take one lock file, so they do not race.
// When the lock is not free within the wait, the append goes without the lock and skips the trim. A line can be lost then: the log is for diagnosis, not for audit.
import fs from 'node:fs';
import path from 'node:path';
import { assertDataFile, readDataFile, writeDataFile } from './data-file-safety.js';

export const POLICY_CHANGES_FILE = 'policy-changes.jsonl';
export const MAX_LINES = 500;
export const MAX_BYTES = 256 * 1024;
export const MAX_STRING = 80;
export const MAX_CHANGES = 200;
export const READ_LIMIT = 100;
export const CALLERS = ['page', 'cli', 'project-new', 'unknown'];

const CHANGED = 'changed';
const SECRET_KEY = /token|secret|password|credential|api[-_ ]?key|authorization/i;
export const MAX_KEY = 120;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Map a marker to one of the four caller kinds. `project new` is the spoken form of `project-new`.
export function callerKind(value) {
  if (value === 'project new') return 'project-new';
  return CALLERS.includes(value) ? value : 'unknown';
}

// A scalar as it goes into the log: a string is cut, an absent value is null, and a value that is not a scalar reads `changed`.
function scalar(value, key) {
  if (value === undefined || value === null) return null;
  // The whole dotted path counts: a key under a secret-named parent is masked too.
  if (SECRET_KEY.test(key)) return CHANGED;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return CHANGED;
}

// The changed leaves of a policy as [{ key, old, new }]. key is a dotted path. An array is one leaf.
// The derived ignoredRoutes field never counts.
export function diffPolicy(before, after) {
  const changes = [];
  const walk = (a, b, key) => {
    const aObject = isObject(a), bObject = isObject(b);
    if ((aObject || bObject) && (aObject || a == null) && (bObject || b == null)) {
      const left = aObject ? a : {};
      const right = bObject ? b : {};
      for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (!key && name === 'ignoredRoutes') continue;
        walk(left[name], right[name], key ? `${key}.${name}` : name);
      }
    } else if (aObject || bObject) changes.push({ key, old: aObject ? CHANGED : scalar(a, key), new: bObject ? CHANGED : scalar(b, key) });
    else if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return;
    else if (Array.isArray(a) || Array.isArray(b)) changes.push({ key, old: CHANGED, new: CHANGED });
    else changes.push({ key, old: scalar(a, key), new: scalar(b, key) });
  };
  walk(before, after, '');
  return changes.slice(0, MAX_CHANGES).map((c) => ({ ...c, key: c.key.slice(0, MAX_KEY) }));
}

// Keep the last MAX_LINES lines and at most MAX_BYTES. The newest line always stays.
function trim(file) {
  const lines = readDataFile(file, path.dirname(file)).split('\n').filter(Boolean);
  const size = () => lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  if (lines.length <= MAX_LINES && size() <= MAX_BYTES) return;
  lines.splice(0, Math.max(0, lines.length - MAX_LINES));
  let bytes = size();
  while (lines.length > 1 && bytes > MAX_BYTES) bytes -= Buffer.byteLength(lines.shift()) + 1;
  writeDataFile(file, `${lines.join('\n')}\n`, path.dirname(file));
}

// Take the lock file. Return the release function, or null when the lock is not free within the wait.
function takeLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); return () => { try { fs.unlinkSync(lock); } catch {} }; }
    catch (error) {
      if (error.code !== 'EEXIST') return null;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

// Append one line with a single write call. Strict setup callers refuse a log failure.
// Other callers keep the diagnostic log best effort. No changes means no line.
export function appendPolicyChange(dir, { at = new Date().toISOString(), caller, changes, strict = false }) {
  if (!Array.isArray(changes) || !changes.length) return false;
  const file = path.join(dir, POLICY_CHANGES_FILE);
  try {
    assertDataFile(file, dir);
    assertDataFile(`${file}.lock`, dir);
    const cut = changes.map((c) => ({ ...c, key: String(c.key).slice(0, MAX_KEY) }));
    const line = `${JSON.stringify({ at, caller: callerKind(caller), changes: cut })}\n`;
    const release = takeLock(`${file}.lock`);
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('The policy log must be a regular file with no links.');
        fs.writeSync(fd, line); fs.fchmodSync(fd, 0o600);
      } finally { fs.closeSync(fd); }
      if (release) trim(file);
    } finally { release?.(); }
    return true;
  } catch (error) { if (strict) throw error; return false; }
}

function parseChange(value) {
  if (!isObject(value) || typeof value.key !== 'string' || !value.key) return null;
  const one = (x) => (x === null || typeof x === 'number' || typeof x === 'boolean' ? x : typeof x === 'string' ? x.slice(0, MAX_STRING) : CHANGED);
  return { key: value.key.slice(0, 200), old: one(value.old), new: one(value.new) };
}

// The last `limit` valid entries, newest first. Reads the last MAX_BYTES of the file.
export function readPolicyChanges(dir, { limit = READ_LIMIT } = {}) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, POLICY_CHANGES_FILE), 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, MAX_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const rows = [];
    for (const raw of buffer.toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      let row;
      try { row = JSON.parse(raw); } catch { continue; }
      if (!isObject(row) || !Number.isFinite(Date.parse(row.at)) || !Array.isArray(row.changes)) continue;
      const changes = row.changes.map(parseChange).filter(Boolean);
      if (!changes.length) continue;
      rows.push({ at: row.at, caller: callerKind(row.caller), changes });
    }
    return rows.slice(-limit).reverse();
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
