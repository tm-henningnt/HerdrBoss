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
const { openSqliteStore } = await import('../src/sqlite-store.js');
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
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((row) => row.version), [1, 2]);
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
