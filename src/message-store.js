/**
 * Open the message store for a data directory.
 * Use all() to read kept records in time order.
 * Use append() or update() to change one record.
 * Use mutate() for every read-modify-write operation.
 * Use thread() to read an older page and chats() to list threads.
 * Use version() to detect changes made by other processes.
 * Use onChange() to receive changes made by this process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { openSqliteStore } from './sqlite-store.js';
import { claimAttachments, removeDeletedAttachments } from './attachments.js';

export const RETENTION_MS = 30 * 86400 * 1000;
export const messagesFile = (dir = DATA_DIR) => path.join(dir, 'messages.jsonl');

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const listenersByStore = new Map();
const messageOrder = (left, right) => Date.parse(left.at) - Date.parse(right.at);
const clone = (value) => JSON.parse(JSON.stringify(value));

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = `${messagesFile(dir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`The message store is locked (${lock}). Try again.`);
      pause(20);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

function readStoredRecords(dir) {
  let text;
  try { text = fs.readFileSync(messagesFile(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const record = JSON.parse(line); if (record && typeof record.id === 'string') records.push(record); } catch {}
  }
  return records;
}

const isOpenReviewItem = (record) => record?.kind === 'review' && !record.closedAt;
// Keep an open review item until review retention closes it. Closed review items use the normal 30-day limit.
const fresh = (records, now) => records.filter((record) => isOpenReviewItem(record) || !(Date.parse(record.at) < now - RETENTION_MS));

function rewrite(dir, records) {
  const before = readStoredRecords(dir);
  const file = messagesFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  removeDeletedAttachments(before, records, { dir });
}

export function newId(now) {
  return `m-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

function listenersFor(dir, backend) {
  const key = `${backend}:${path.resolve(dir)}`;
  if (!listenersByStore.has(key)) listenersByStore.set(key, new Set());
  return { key, listeners: listenersByStore.get(key) };
}

function emitChange(listeners, type, record) {
  const event = { type, record: clone(record) };
  for (const listener of [...listeners]) {
    try { listener(event); }
    catch (error) { process.emitWarning(`Message store change listener failed: ${error?.message || error}`); }
  }
}

function configuredBackend(dir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return config?.store?.messages ?? 'json';
  } catch { return 'json'; }
}

function jsonVersion(dir) {
  try { return createHash('sha256').update(fs.readFileSync(messagesFile(dir))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return 'empty'; throw error; }
}

function sqliteRecords(db) {
  return db.prepare('SELECT record FROM messages ORDER BY rowid').all().map((row) => JSON.parse(row.record));
}

function withSqliteTransaction(sqlite, fn, dir = null) {
  const { db } = sqlite;
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = dir ? sqliteRecords(db) : [];
    const result = fn(db);
    db.exec('COMMIT');
    if (dir) removeDeletedAttachments(before, sqliteRecords(db), { dir });
    sqlite.secureFiles();
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    sqlite.secureFiles();
    throw error;
  }
}

function replaceSqliteRecords(db, records) {
  db.exec('DELETE FROM messages');
  const insert = db.prepare('INSERT INTO messages(id, at, thread, record) VALUES (?, ?, ?, ?)');
  for (const record of records) {
    if (!record || typeof record.id !== 'string') throw new TypeError('SQLite message records need a string id.');
    insert.run(record.id, record.at ?? null, record.thread ?? null, JSON.stringify(record));
  }
  db.prepare('UPDATE message_store_state SET version = version + 1 WHERE id = 1').run();
}

function readJsonl(dir) {
  let text;
  try { text = fs.readFileSync(messagesFile(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const record = JSON.parse(line); if (record && typeof record.id === 'string') records.push(record); } catch {}
  }
  return records;
}

function importJsonlIfEmpty(sqlite, dir) {
  if (sqlite.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count) return 0;
  return withSqliteTransaction(sqlite, (db) => {
    if (db.prepare('SELECT COUNT(*) AS count FROM messages').get().count) return 0;
    const records = readJsonl(dir);
    const insert = db.prepare('INSERT OR IGNORE INTO messages(id, at, thread, record) VALUES (?, ?, ?, ?)');
    let count = 0;
    for (const record of records) {
      count += Number(insert.run(record.id, record.at ?? null, record.thread ?? null, JSON.stringify(record)).changes);
    }
    if (count) db.prepare('UPDATE message_store_state SET version = version + 1 WHERE id = 1').run();
    return count;
  });
}

export function importMessages({ dir = DATA_DIR } = {}) {
  const sqlite = openSqliteStore({ dir });
  return importJsonlIfEmpty(sqlite, dir);
}

export function exportMessages({ dir = DATA_DIR } = {}) {
  const sqlite = openSqliteStore({ dir });
  importJsonlIfEmpty(sqlite, dir);
  const records = sqliteRecords(sqlite.db).sort(messageOrder);
  fs.mkdirSync(dir, { recursive: true });
  const file = messagesFile(dir);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  return records.length;
}

function openSqliteMessageStore(dir, key, listeners, guard) {
  const sqlite = openSqliteStore({ dir, guard });
  importJsonlIfEmpty(sqlite, dir);
  const { db } = sqlite;
  const all = () => fresh(sqliteRecords(db), Date.now()).sort(messageOrder);
  const store = {
    all,

    append(fields, { now = Date.now() } = {}) {
      const record = {
        id: newId(now), at: new Date(now).toISOString(), thread: null, from: null, to: null, kind: null, text: '',
        action: null, replyTo: null, status: null, sentAt: null, error: null, relayedAt: null, relayedBy: null, ...fields,
      };
      const claim = claimAttachments(fields.attachments ?? [], record.id, { dir, now });
      if (fields.attachments !== undefined) record.attachments = claim.attachments;
      let shouldNotify;
      try {
        shouldNotify = withSqliteTransaction(sqlite, (connection) => {
          const records = fresh(sqliteRecords(connection), now);
          const kept = fresh([...records, record], now).sort(messageOrder);
          replaceSqliteRecords(connection, kept);
          return kept.some((item) => item.id === record.id);
        }, dir);
      } catch (error) { claim.rollback(); throw error; }
      if (shouldNotify) emitChange(listeners, 'append', record);
      return record;
    },

    update(id, patch, { now = Date.now() } = {}) {
      const outcome = withSqliteTransaction(sqlite, (connection) => {
        const records = sqliteRecords(connection);
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) return { record: null, notify: false };
        records[index] = { ...records[index], ...patch, id };
        const updated = records[index];
        const kept = fresh(records, now).sort(messageOrder);
        replaceSqliteRecords(connection, kept);
        return { record: updated, notify: kept.some((record) => record.id === id) };
      }, dir);
      if (outcome.notify) emitChange(listeners, 'update', outcome.record);
      return outcome.record;
    },

    mutate(fn, { now = Date.now() } = {}) {
      if (typeof fn !== 'function') throw new TypeError('Message store mutate needs a function.');
      const outcome = withSqliteTransaction(sqlite, (connection) => {
        const stored = sqliteRecords(connection);
        const records = fresh(stored, now).sort(messageOrder);
        const before = records.map(clone);
        const changed = fn(records);
        if (changed && typeof changed.then === 'function') throw new TypeError('Message store mutate needs a synchronous function.');
        if (!changed || !Array.isArray(changed.records)) throw new TypeError('Message store mutate must return { records, result }.');
        const after = fresh(changed.records, now).sort(messageOrder);
        const needsWrite = stored.length !== after.length || JSON.stringify(before) !== JSON.stringify(after);
        if (needsWrite) replaceSqliteRecords(connection, after);

        const oldById = new Map(before.map((record) => [record.id, record]));
        const events = [];
        for (const record of after) {
          const previous = oldById.get(record.id);
          if (!previous) events.push({ type: 'append', record });
          else if (JSON.stringify(previous) !== JSON.stringify(record)) events.push({ type: 'update', record });
        }
        return { result: changed.result, events };
      }, dir);
      for (const event of outcome.events) emitChange(listeners, event.type, event.record);
      return outcome.result;
    },

    thread(thread, { limit = 200, before = null } = {}) {
      const records = all().filter((record) => record.thread === thread);
      let end = records.length;
      if (before !== null) {
        const cursor = records.findIndex((record) => record.id === before);
        if (cursor < 0) return [];
        end = cursor;
      }
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      return count ? records.slice(Math.max(0, end - count), end) : [];
    },

    chats() {
      const chats = new Map();
      for (const record of all()) {
        if (!chats.has(record.thread)) chats.set(record.thread, { thread: record.thread, last: record, count: 0, unreadForOwner: 0 });
        const chat = chats.get(record.thread);
        chat.last = record;
        chat.count += 1;
        if (record.to === 'owner' && !record.readAt) chat.unreadForOwner += 1;
      }
      return [...chats.values()].sort((left, right) => messageOrder(right.last, left.last));
    },

    onChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('Message store onChange needs a function.');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) listenersByStore.delete(key);
      };
    },

    version() {
      return db.prepare('SELECT version FROM message_store_state WHERE id = 1').get().version;
    },
  };
  Object.defineProperty(store, 'close', { value: () => sqlite.close() });
  return store;
}

export function openMessageStore(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`openMessageStore takes an options object such as { dir }, not ${options === null ? 'null' : Array.isArray(options) ? 'an array' : typeof options}. A string is not a directory argument.`);
  }
  const { dir = DATA_DIR } = options;
  let { backend } = options;
  backend ??= configuredBackend(dir);
  if (!['json', 'sqlite'].includes(backend)) throw new Error(`Unsupported message store backend: ${backend}`);
  const { key, listeners } = listenersFor(dir, backend);
  if (backend === 'sqlite') return openSqliteMessageStore(dir, key, listeners, options.guard);
  const all = () => fresh(readStoredRecords(dir), Date.now()).sort(messageOrder);

  const store = {
    all,

    append(fields, { now = Date.now() } = {}) {
      const record = {
        id: newId(now), at: new Date(now).toISOString(), thread: null, from: null, to: null, kind: null, text: '',
        action: null, replyTo: null, status: null, sentAt: null, error: null, relayedAt: null, relayedBy: null, ...fields,
      };
      const claim = claimAttachments(fields.attachments ?? [], record.id, { dir, now });
      if (fields.attachments !== undefined) record.attachments = claim.attachments;
      let shouldNotify;
      try {
        shouldNotify = withLock(dir, () => {
          const records = readStoredRecords(dir);
          const kept = fresh(records, now);
          if (kept.length !== records.length) rewrite(dir, [...kept, record].sort(messageOrder));
          else {
            fs.appendFileSync(messagesFile(dir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
            fs.chmodSync(messagesFile(dir), 0o600);
          }
          return fresh([...kept, record], now).some((item) => item.id === record.id);
        });
      } catch (error) { claim.rollback(); throw error; }
      if (shouldNotify) emitChange(listeners, 'append', record);
      return record;
    },

    update(id, patch, { now = Date.now() } = {}) {
      const outcome = withLock(dir, () => {
        const records = readStoredRecords(dir);
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) return { record: null, notify: false };
        records[index] = { ...records[index], ...patch, id };
        const updated = records[index];
        rewrite(dir, fresh(records, now).sort(messageOrder));
        return { record: updated, notify: fresh(records, now).some((record) => record.id === id) };
      });
      if (outcome.notify) emitChange(listeners, 'update', outcome.record);
      return outcome.record;
    },

    mutate(fn, { now = Date.now() } = {}) {
      if (typeof fn !== 'function') throw new TypeError('Message store mutate needs a function.');
      const outcome = withLock(dir, () => {
        const stored = readStoredRecords(dir);
        const records = fresh(stored, now).sort(messageOrder);
        const before = records.map(clone);
        const changed = fn(records);
        if (changed && typeof changed.then === 'function') throw new TypeError('Message store mutate needs a synchronous function.');
        if (!changed || !Array.isArray(changed.records)) throw new TypeError('Message store mutate must return { records, result }.');
        const after = fresh(changed.records, now).sort(messageOrder);
        const needsWrite = stored.length !== after.length || JSON.stringify(before) !== JSON.stringify(after);
        if (needsWrite) rewrite(dir, after);

        const oldById = new Map(before.map((record) => [record.id, record]));
        const events = [];
        for (const record of after) {
          const previous = oldById.get(record.id);
          if (!previous) events.push({ type: 'append', record });
          else if (JSON.stringify(previous) !== JSON.stringify(record)) events.push({ type: 'update', record });
        }
        return { result: changed.result, events };
      });
      for (const event of outcome.events) emitChange(listeners, event.type, event.record);
      return outcome.result;
    },

    thread(thread, { limit = 200, before = null } = {}) {
      const records = all().filter((record) => record.thread === thread);
      let end = records.length;
      if (before !== null) {
        const cursor = records.findIndex((record) => record.id === before);
        if (cursor < 0) return [];
        end = cursor;
      }
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      return count ? records.slice(Math.max(0, end - count), end) : [];
    },

    chats() {
      const chats = new Map();
      for (const record of all()) {
        if (!chats.has(record.thread)) chats.set(record.thread, { thread: record.thread, last: record, count: 0, unreadForOwner: 0 });
        const chat = chats.get(record.thread);
        chat.last = record;
        chat.count += 1;
        if (record.to === 'owner' && !record.readAt) chat.unreadForOwner += 1;
      }
      return [...chats.values()].sort((left, right) => messageOrder(right.last, left.last));
    },

    onChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('Message store onChange needs a function.');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) listenersByStore.delete(key);
      };
    },

    version() { return jsonVersion(dir); },
  };
  Object.defineProperty(store, 'close', { value: () => {} });
  return store;
}
