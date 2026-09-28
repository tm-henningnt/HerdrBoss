import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.js';

const require = createRequire(import.meta.url);
const DATABASE_NAME = 'herdr-boss.db';
const BUSY_TIMEOUT_MS = 5000;
const storesByFile = new Map();

export const databaseFile = (dir = DATA_DIR) => path.join(path.resolve(dir), DATABASE_NAME);

export function assertSqliteAvailable() {
  try { return require('node:sqlite'); }
  catch {
    throw new Error('Herdr Boss needs Node.js 26.10 or later because it cannot load node:sqlite.');
  }
}

function chmodIfPresent(file) {
  try { fs.chmodSync(file, 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function secureFiles(file) {
  chmodIfPresent(file);
  chmodIfPresent(`${file}-wal`);
  chmodIfPresent(`${file}-shm`);
}

function quickCheck(db, file) {
  try {
    const result = db.prepare('PRAGMA quick_check').all();
    if (result.length === 1 && result[0].quick_check === 'ok') return;
    const detail = result.map((row) => Object.values(row).join(', ')).join('; ') || 'no result';
    throw new Error(detail);
  } catch (error) {
    throw new Error(`SQLite database check failed for ${file}: ${error.message}. Restore a backup or import the JSON again.`);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        at TEXT,
        thread TEXT,
        record TEXT NOT NULL
      );
      CREATE INDEX messages_at_idx ON messages(at);
      CREATE INDEX messages_thread_idx ON messages(thread);
      CREATE TABLE message_store_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO message_store_state(id, version) VALUES (1, 0);
    `,
  },
];

function migrate(db, file) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  let current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get().version;
  if (current > MIGRATIONS.at(-1).version) throw new Error(`SQLite database ${file} has a newer schema version (${current}).`);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get().version;
      if (migration.version <= current) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(migration.version);
      db.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function openSqliteStore({ dir = DATA_DIR } = {}) {
  const file = databaseFile(dir);
  const cached = storesByFile.get(file);
  if (cached) return cached;

  const { DatabaseSync } = assertSqliteAvailable();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.closeSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    quickCheck(db, file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    migrate(db, file);
    secureFiles(file);
  } catch (error) {
    try { db.close(); } catch {}
    if (error.message.includes('Restore a backup or import the JSON again.')) throw error;
    throw error;
  }

  let closed = false;
  const store = {
    db,
    file,
    secureFiles: () => secureFiles(file),
    backup(destination) {
      const target = path.resolve(destination);
      if (target === file) throw new Error('The backup file must differ from the live SQLite database.');
      if (fs.existsSync(target)) throw new Error(`The backup file already exists: ${target}`);
      db.exec(`VACUUM INTO ${sqlString(target)}`);
      chmodIfPresent(target);
      secureFiles(file);
      return target;
    },
    close() {
      if (closed) return;
      closed = true;
      try { db.close(); }
      finally { storesByFile.delete(file); }
    },
  };
  storesByFile.set(file, store);
  return store;
}
