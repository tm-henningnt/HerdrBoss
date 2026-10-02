import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { isLiveDataDir } from './data-dir-guard.js';

const require = createRequire(import.meta.url);
const DATABASE_NAME = 'herdr-boss.db';
const BUSY_TIMEOUT_MS = 5000;
const storesByFile = new Map();

export const databaseFile = (dir = DATA_DIR) => path.join(path.resolve(dir), DATABASE_NAME);

export const MIGRATION_GUARD_MESSAGE = 'This source tree cannot migrate the live database. Run it from the main checkout or use a temporary HERDR_BOSS_DIR.';

// Add a column only when the table lacks it. Use this helper for every ADD COLUMN migration: a database can hold the
// column already when an earlier run of the migration stopped before it recorded the schema version.
// Returns true when it added the column.
export function addColumnIfMissing(db, table, column, definition) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(column)) throw new Error('A table and a column name hold letters, digits, and underscores only.');
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The main checkout has a .git directory. A linked worktree has a .git file. A copy of the source has neither.
// The decision reads the file system only: no subprocess and no environment variable, so a missing git, a slow git, and
// GIT_DIR or GIT_WORK_TREE cannot change it.
export function isMainCheckout(root) {
  try { return fs.lstatSync(path.join(root, '.git')).isDirectory(); }
  catch { return false; }
}

// A pending migration on the live database needs the main checkout: the launchd service runs from it. Any other source tree
// (a worker worktree, the integration worktree, a copy) is refused. `guard` replaces the real values in a test:
// { liveDirs, sourceRoot }. The service ignores it: only a test run (NODE_TEST_CONTEXT is set) honors it.
// A temporary data dir is not live and migrates freely.
function assertMayMigrate(file, guard) {
  const override = process.env.NODE_TEST_CONTEXT && guard ? guard : {};
  const dir = path.dirname(file);
  const live = override.liveDirs
    ? override.liveDirs.some((entry) => { const relative = path.relative(path.resolve(entry), path.resolve(dir)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); })
    : isLiveDataDir(dir);
  if (!live) return;
  if (!isMainCheckout(override.sourceRoot ?? SOURCE_ROOT)) throw new Error(MIGRATION_GUARD_MESSAGE);
}

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
  {
    version: 2,
    sql: `
      CREATE TABLE review_packs (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        title TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'submitted', 'expired')),
        mail_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        note_rev INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        PRIMARY KEY (slug, pack)
      );
      CREATE TABLE review_versions (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        version INTEGER NOT NULL,
        manifest TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        files INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT,
        PRIMARY KEY (slug, pack, version),
        FOREIGN KEY (slug, pack) REFERENCES review_packs(slug, pack) ON DELETE CASCADE
      );
      CREATE TABLE review_items (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        version INTEGER NOT NULL,
        item TEXT NOT NULL,
        section TEXT NOT NULL,
        hash TEXT NOT NULL,
        position INTEGER NOT NULL,
        spec TEXT NOT NULL,
        PRIMARY KEY (slug, pack, version, item),
        FOREIGN KEY (slug, pack, version) REFERENCES review_versions(slug, pack, version) ON DELETE CASCADE
      );
      CREATE TABLE review_files (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        version INTEGER NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        type TEXT NOT NULL,
        stored TEXT NOT NULL,
        PRIMARY KEY (slug, pack, version, path),
        FOREIGN KEY (slug, pack, version) REFERENCES review_versions(slug, pack, version) ON DELETE CASCADE
      );
      CREATE TABLE review_answers (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        item TEXT NOT NULL,
        decision TEXT,
        choice TEXT,
        rating INTEGER,
        live TEXT,
        viewed INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        pins TEXT,
        checks TEXT,
        hash TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        previous TEXT,
        rev INTEGER NOT NULL,
        op_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (slug, pack, item),
        FOREIGN KEY (slug, pack) REFERENCES review_packs(slug, pack) ON DELETE CASCADE
      );
      CREATE TABLE review_results (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        version INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        message_id TEXT,
        PRIMARY KEY (slug, pack, version)
      );
      CREATE INDEX review_packs_state_idx ON review_packs(state, updated_at);
    `,
  },
  {
    version: 3,
    run: (db) => { addColumnIfMissing(db, 'review_results', 'markdown', 'TEXT'); },
  },
  {
    version: 4,
    sql: `
      CREATE TABLE review_reopened_items (
        slug TEXT NOT NULL,
        pack TEXT NOT NULL,
        version INTEGER NOT NULL,
        item TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        op_id TEXT,
        opened_at TEXT NOT NULL,
        PRIMARY KEY (slug, pack, version, item),
        FOREIGN KEY (slug, pack) REFERENCES review_packs(slug, pack) ON DELETE CASCADE
      );
    `,
  },
];

function migrate(db, file, guard) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  let current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get().version;
  if (current > MIGRATIONS.at(-1).version) throw new Error(`SQLite database ${file} has a newer schema version (${current}).`);
  if (MIGRATIONS.some((migration) => migration.version > current)) assertMayMigrate(file, guard);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get().version;
      if (migration.version <= current) {
        db.exec('COMMIT');
        continue;
      }
      if (migration.run) migration.run(db);
      else db.exec(migration.sql);
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

export function openSqliteStore({ dir = DATA_DIR, guard } = {}) {
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
    migrate(db, file, guard);
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
