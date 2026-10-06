import './helpers/test-env.js';
// RV4: the migration of the old per-pack note into review_notes, one note for each pack version.
// Each case uses a temporary database with the review tables of schema version 4, before review_notes existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { migratePackNotes } from '../src/sqlite-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A temporary database with the review tables of schema version 4, before review_notes existed.
function oldNoteSchema(t) {
  const dir = tmp('herdr-note-migrate-');
  const db = new DatabaseSync(path.join(dir, 'herdr-boss.db'));
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.exec(`
    CREATE TABLE review_packs (
      slug TEXT NOT NULL, pack TEXT NOT NULL, title TEXT NOT NULL, current_version INTEGER NOT NULL,
      state TEXT NOT NULL, mail_id TEXT, note TEXT NOT NULL DEFAULT '', note_rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
      PRIMARY KEY (slug, pack)
    );
    CREATE TABLE review_versions (
      slug TEXT NOT NULL, pack TEXT NOT NULL, version INTEGER NOT NULL, manifest TEXT NOT NULL,
      bytes INTEGER NOT NULL, files INTEGER NOT NULL, published_at TEXT NOT NULL, published_by TEXT,
      PRIMARY KEY (slug, pack, version)
    );
    CREATE TABLE review_results (
      slug TEXT NOT NULL, pack TEXT NOT NULL, version INTEGER NOT NULL, verdict TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', result TEXT NOT NULL, submitted_at TEXT NOT NULL, message_id TEXT,
      PRIMARY KEY (slug, pack, version)
    );
  `);
  return { dir, db };
}

const oldPack = (db, { current, state, note, noteRev }) => db.prepare(`INSERT INTO review_packs(slug, pack, title, current_version, state, note, note_rev, created_at, updated_at)
  VALUES ('shop', 'checkout-redesign', 'Checkout flow redesign', ?, ?, ?, ?, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z')`).run(current, state, note, noteRev);
const oldVersion = (db, version) => db.prepare("INSERT INTO review_versions(slug, pack, version, manifest, bytes, files, published_at) VALUES ('shop', 'checkout-redesign', ?, '{}', 0, 0, '2026-10-01T08:00:00.000Z')").run(version);
const oldResult = (db, version, note) => db.prepare("INSERT INTO review_results(slug, pack, version, verdict, note, result, submitted_at) VALUES ('shop', 'checkout-redesign', ?, 'accept', ?, '{}', '2026-10-01T09:00:00.000Z')").run(version, note);

const noteRows = (db) => db.prepare('SELECT version, note, note_rev, legacy FROM review_notes ORDER BY version').all().map((row) => ({ ...row }));

test('the note migration attaches a note to the current version', (t) => {
  const { db } = oldNoteSchema(t);
  oldPack(db, { current: 1, state: 'open', note: 'Current note.', noteRev: 2 });
  oldVersion(db, 1);
  migratePackNotes(db);
  assert.deepEqual(noteRows(db), [{ version: 1, note: 'Current note.', note_rev: 2, legacy: 0 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_pack_note_backup').get().n, 1, 'the migration keeps a backup of the old note');
});

test('the note migration attaches a submitted current version note to that version', (t) => {
  const { db } = oldNoteSchema(t);
  oldPack(db, { current: 1, state: 'submitted', note: 'Submitted note.', noteRev: 1 });
  oldVersion(db, 1);
  oldResult(db, 1, 'Submitted note.');
  migratePackNotes(db);
  assert.deepEqual(noteRows(db), [{ version: 1, note: 'Submitted note.', note_rev: 1, legacy: 0 }]);
});

test('the note migration attaches a carried note to the version of the last submit', (t) => {
  const { db } = oldNoteSchema(t);
  oldPack(db, { current: 2, state: 'open', note: 'Carried note.', noteRev: 1 });
  oldVersion(db, 1);
  oldVersion(db, 2);
  oldResult(db, 1, 'Carried note.');
  migratePackNotes(db);
  assert.deepEqual(noteRows(db), [{ version: 1, note: 'Carried note.', note_rev: 1, legacy: 0 }]);
});

test('the note migration marks a note of an unknown older version as legacy', (t) => {
  const { db } = oldNoteSchema(t);
  oldPack(db, { current: 2, state: 'open', note: 'Unknown note.', noteRev: 1 });
  oldVersion(db, 1);
  oldVersion(db, 2);
  migratePackNotes(db);
  assert.deepEqual(noteRows(db), [{ version: 2, note: 'Unknown note.', note_rev: 1, legacy: 1 }]);
});

test('the note migration is idempotent', (t) => {
  const { db } = oldNoteSchema(t);
  oldPack(db, { current: 1, state: 'open', note: 'Current note.', noteRev: 2 });
  oldVersion(db, 1);
  migratePackNotes(db);
  migratePackNotes(db);
  assert.deepEqual(noteRows(db), [{ version: 1, note: 'Current note.', note_rev: 2, legacy: 0 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_pack_note_backup').get().n, 1);
});
