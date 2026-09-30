import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const { openSqliteStore, addColumnIfMissing, isMainCheckout } = await import('../src/sqlite-store.js');
const { openMessageStore } = await import('../src/message-store.js');

function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sqlite-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function closeAfter(t, store) {
  t.after(() => store.close());
  return store;
}

function sampleMessages() {
  return [
    { id: 'm-first', at: '2026-09-28T10:00:00.000Z', thread: 'alpha', from: 'owner', to: 'orch', text: 'First.' },
    { id: 'm-second', at: '2026-09-28T10:01:00.000Z', thread: 'alpha', from: 'orch', to: 'owner', text: 'Second.' },
  ];
}

function runCli(dir, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sqlite-cli-home-'));
  try {
    return spawnSync(process.execPath, [path.join(repo, 'src/cli.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('SQLite store uses WAL, a 5-second busy timeout, ordered migrations, and backup', (t) => {
  const dir = freshDir(t);
  const store = closeAfter(t, openSqliteStore({ dir }));
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((row) => row.version), [1, 2, 3]);
  store.db.prepare('INSERT INTO messages(id, at, thread, record) VALUES (?, ?, ?, ?)')
    .run('backup-row', '2026-09-28T10:00:00.000Z', 'alpha', JSON.stringify({ id: 'backup-row', text: 'Backup.' }));

  const backup = path.join(dir, 'messages-backup.db');
  store.backup(backup);
  const backupDb = new DatabaseSync(backup);
  t.after(() => backupDb.close());
  assert.equal(backupDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
});

test('SQLite store refuses a corrupt file with a recovery instruction', (t) => {
  const dir = freshDir(t);
  const file = path.join(dir, 'herdr-boss.db');
  fs.writeFileSync(file, 'not a SQLite database');
  assert.throws(() => openSqliteStore({ dir }), (error) => {
    assert.match(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(error.message, /restore a backup or import the JSON again/i);
    return true;
  });
});

test('SQLite database, WAL, shared memory, and backup files use mode 0600', (t) => {
  const dir = freshDir(t);
  const store = closeAfter(t, openSqliteStore({ dir }));
  const messageStore = openMessageStore({ dir, backend: 'sqlite' });
  messageStore.append({ thread: 'alpha', text: 'Private.' });
  const backup = path.join(dir, 'backup.db');
  store.backup(backup);

  for (const file of ['herdr-boss.db', 'herdr-boss.db-wal', 'herdr-boss.db-shm', 'backup.db']) {
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  }
});

test('store import then export preserves the records and reports counts', (t) => {
  const dir = freshDir(t);
  const records = sampleMessages();
  const source = path.join(dir, 'messages.jsonl');
  fs.writeFileSync(source, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });

  const imported = runCli(dir, 'store', 'import', 'messages');
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Imported 2 messages\./);
  assert.equal(runCli(dir, 'store', 'import', 'messages').stdout, 'Imported 0 messages.\n');

  const store = openMessageStore({ dir, backend: 'sqlite' });
  assert.deepEqual(store.all(), records);
  const exported = runCli(dir, 'store', 'export', 'messages');
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /Exported 2 messages\./);
  assert.deepEqual(fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse), records);
});

test('SQLite backend imports the JSONL file automatically when its table is empty', (t) => {
  const dir = freshDir(t);
  const records = sampleMessages();
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const store = openMessageStore({ dir, backend: 'sqlite' });
  assert.deepEqual(store.all(), records);
  assert.equal(fs.existsSync(path.join(dir, 'messages.jsonl')), true);
});

test('store.messages in config selects the SQLite backend', (t) => {
  const dir = freshDir(t);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"store":{"messages":"sqlite"}}\n');
  const store = openMessageStore({ dir });
  t.after(() => store.close());
  assert.equal(typeof store.version(), 'number');
  assert.equal(fs.existsSync(path.join(dir, 'herdr-boss.db')), true);
});

// ---------- Migration 3 and the migration guard ----------

const GUARD_MESSAGE = 'This source tree cannot migrate the live database. Run it from the main checkout or use a temporary HERDR_BOSS_DIR.';
const versionsOf = (db) => db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((row) => row.version);
const hasMarkdown = (db) => db.prepare('PRAGMA table_info(review_results)').all().some((column) => column.name === 'markdown');

// A database at version 2. `withColumn` keeps the markdown column, the state of the live database after a failed migration 3.
function databaseAtVersion2(dir, { withColumn }) {
  const store = openSqliteStore({ dir });
  store.db.exec('DELETE FROM schema_version WHERE version = 3');
  if (!withColumn) store.db.exec('ALTER TABLE review_results DROP COLUMN markdown');
  store.close();
}

test('migration 3 on a fresh database gives version 3 and the markdown column', (t) => {
  const store = closeAfter(t, openSqliteStore({ dir: freshDir(t) }));
  assert.deepEqual(versionsOf(store.db), [1, 2, 3]);
  assert.ok(hasMarkdown(store.db));
});

test('migration 3 on a database at version 2 without the column adds it', (t) => {
  const dir = freshDir(t);
  databaseAtVersion2(dir, { withColumn: false });
  const store = closeAfter(t, openSqliteStore({ dir }));
  assert.deepEqual(versionsOf(store.db), [1, 2, 3]);
  assert.ok(hasMarkdown(store.db));
});

test('migration 3 on a database at version 2 with the column reaches version 3 without an error', (t) => {
  const dir = freshDir(t);
  databaseAtVersion2(dir, { withColumn: true });
  const check = new DatabaseSync(path.join(dir, 'herdr-boss.db'));
  assert.deepEqual(versionsOf(check), [1, 2]);
  assert.ok(hasMarkdown(check));
  check.close();
  const store = closeAfter(t, openSqliteStore({ dir }));
  assert.deepEqual(versionsOf(store.db), [1, 2, 3]);
  assert.equal(store.db.prepare('PRAGMA table_info(review_results)').all().filter((column) => column.name === 'markdown').length, 1);
});

test('addColumnIfMissing adds a column once and leaves an existing column alone', (t) => {
  const store = closeAfter(t, openSqliteStore({ dir: freshDir(t) }));
  store.db.exec('CREATE TABLE sample(id TEXT)');
  assert.equal(addColumnIfMissing(store.db, 'sample', 'extra', 'TEXT'), true);
  assert.equal(addColumnIfMissing(store.db, 'sample', 'extra', 'TEXT'), false);
  assert.deepEqual(store.db.prepare('PRAGMA table_info(sample)').all().map((column) => column.name), ['id', 'extra']);
});

// A source tree in a temporary folder: 'main' has a .git directory, 'linked' a .git file, 'copy' no .git.
function trees(t) {
  const root = freshDir(t);
  const make = (name, git) => {
    const tree = path.join(root, name);
    fs.mkdirSync(tree);
    if (git === 'dir') fs.mkdirSync(path.join(tree, '.git'));
    if (git === 'file') fs.writeFileSync(path.join(tree, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
    return tree;
  };
  return { main: make('main', 'dir'), linked: make('linked', 'file'), copy: make('copy', null) };
}

test('only a root with a .git directory is the main checkout', (t) => {
  const { main, linked, copy } = trees(t);
  assert.equal(isMainCheckout(main), true);
  assert.equal(isMainCheckout(linked), false, 'a linked worktree has a .git file');
  assert.equal(isMainCheckout(copy), false, 'a copy has no .git');
  assert.equal(isMainCheckout(path.join(copy, 'missing')), false);
  const source = fs.readFileSync(path.join(repo, 'src/sqlite-store.js'), 'utf8');
  assert.ok(!/child_process|spawn|execSync|process\.env\.GIT/.test(source.replace(/\/\/.*$/gm, '')), 'the decision uses no subprocess and no git variable');
});

test('a pending migration on the live database is refused unless the root has a .git directory', (t) => {
  const dir = freshDir(t);
  databaseAtVersion2(dir, { withColumn: true });
  const { main, linked, copy } = trees(t);
  for (const sourceRoot of [linked, copy]) {
    assert.throws(() => openSqliteStore({ dir, guard: { liveDirs: [dir], sourceRoot } }), (error) => error.message === GUARD_MESSAGE);
  }
  const check = new DatabaseSync(path.join(dir, 'herdr-boss.db'));
  assert.deepEqual(versionsOf(check), [1, 2], 'the refusal changes nothing');
  check.close();
  const allowed = closeAfter(t, openSqliteStore({ dir, guard: { liveDirs: [dir], sourceRoot: main } }));
  assert.deepEqual(versionsOf(allowed.db), [1, 2, 3]);
  allowed.close();
  // A root that is not the main checkout reads a database that is at the version of the code.
  const read = closeAfter(t, openSqliteStore({ dir, guard: { liveDirs: [dir], sourceRoot: linked } }));
  assert.deepEqual(versionsOf(read.db), [1, 2, 3]);
});

test('a temporary data dir migrates from any root', (t) => {
  const live = freshDir(t);
  const temp = freshDir(t);
  databaseAtVersion2(temp, { withColumn: false });
  const { copy } = trees(t);
  const store = closeAfter(t, openSqliteStore({ dir: temp, guard: { liveDirs: [live], sourceRoot: copy } }));
  assert.deepEqual(versionsOf(store.db), [1, 2, 3]);
});

test('a fresh live database is refused from a root that is not the main checkout, also through the message store', (t) => {
  const dir = freshDir(t);
  const { linked } = trees(t);
  const guard = { liveDirs: [dir], sourceRoot: linked };
  assert.throws(() => openSqliteStore({ dir, guard }), (error) => error.message === GUARD_MESSAGE);
  assert.throws(() => openMessageStore({ dir, backend: 'sqlite', guard }), (error) => error.message === GUARD_MESSAGE);
});

test('the service ignores the guard option: only a test run honors it', (t) => {
  const dir = freshDir(t);
  const { copy } = trees(t);
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { process.env.NODE_TEST_CONTEXT = context; });
  // Without the test context the guard option has no effect: the dir is not live for the real guard, so it migrates.
  const store = closeAfter(t, openSqliteStore({ dir, guard: { liveDirs: [dir], sourceRoot: copy } }));
  assert.deepEqual(versionsOf(store.db), [1, 2, 3]);
});

// The service start path in a child process: a copy of the source tree, the live dir is the temporary dir, and the PATH is empty.
function copyTree(t, { git }) {
  const root = freshDir(t);
  const tree = path.join(root, 'tree');
  fs.cpSync(path.join(repo, 'src'), path.join(tree, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(tree, 'package.json'));
  if (git === 'dir') fs.mkdirSync(path.join(tree, '.git'));
  if (git === 'file') fs.writeFileSync(path.join(tree, '.git'), 'gitdir: /elsewhere\n');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  databaseAtVersion2(data, { withColumn: true });
  return { tree, data, root };
}

function startPath(tree, data, root) {
  const script = "const { openMessageStore } = await import('./src/message-store.js'); const { openSqliteStore } = await import('./src/sqlite-store.js'); "
    + "openMessageStore({ dir: process.env.HERDR_BOSS_DIR, backend: 'sqlite' }).all(); "
    + "console.log(openSqliteStore({ dir: process.env.HERDR_BOSS_DIR }).db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v);";
  const env = { PATH: '', HOME: path.join(root, 'home'), HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data };
  fs.mkdirSync(env.HOME, { recursive: true });
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tree, env, encoding: 'utf8' });
}

test('the service start path migrates the live database from a main-like root with no git on the PATH', (t) => {
  const { tree, data, root } = copyTree(t, { git: 'dir' });
  const run = startPath(tree, data, root);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '3');
});

test('the same start path from a root with a .git file or with no .git refuses the pending migration', (t) => {
  for (const git of ['file', null]) {
    const { tree, data, root } = copyTree(t, { git });
    const run = startPath(tree, data, root);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /This source tree cannot migrate the live database/);
  }
});
