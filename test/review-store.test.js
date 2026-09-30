import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { validatePack } from '../src/review-pack.js';
import { openSqliteStore } from '../src/sqlite-store.js';
import {
  publishVersion, putAnswer, putPackNote, getPack, listPacks, getResult, getFile, submitPack, sweep, deletePack, setMailId,
  packDirectory, ReviewStoreError,
} from '../src/review-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T08:00:00.000Z');

const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A data dir that the guard accepts, and a closed store after the test.
function dataDir(t) {
  const dir = tmp('herdr-review-store-data-');
  assertTempDataDir(dir);
  t.after(() => openSqliteStore({ dir }).close());
  return dir;
}

// A PNG header with the given size. `tag` makes the bytes differ between images.
function png(width, height, tag = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16, tag)]);
}

function baseManifest(id) {
  return {
    schema: 'herdr-boss.review-pack/1',
    id,
    title: 'Checkout flow redesign',
    sections: [
      { id: 'cart', title: 'Cart', items: [
        { id: 'cart-themes', title: 'Cart, light and dark', type: 'image-pair', variant: 'theme',
          a: { src: 'img/cart-light.png', label: 'Light' }, b: { src: 'img/cart-dark.png', label: 'Dark' }, ask: ['accept', 'deny', 'note'] },
        { id: 'pay-button', title: 'Pay button position', type: 'image-pair', variant: 'before-after',
          a: { src: 'img/pay-before.png', label: 'Before' }, b: { src: 'img/pay-after.png', label: 'After' },
          ask: ['choice', 'note'], choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after' }] },
      ] },
      { id: 'errors', title: 'Error handling', items: [
        { id: 'error-copy', title: 'Error messages', type: 'markdown', text: 'The card was declined. Try another card.', ask: ['accept', 'deny', 'note'] },
        { id: 'release-notes', title: 'Release notes', type: 'markdown', text: 'Notes for the release.', ask: ['note'] },
        { id: 'live-form', title: 'Staging checkout', type: 'link', url: 'https://staging.example.test/checkout', label: 'Staging checkout', ask: ['accept', 'deny', 'live'] },
      ] },
    ],
  };
}

const ITEMS = ['cart-themes', 'pay-button', 'error-copy', 'release-notes', 'live-form'];

// Write a pack folder. `edit(manifest, files)` changes the manifest object and the file map before the write.
function folder({ id = 'checkout-redesign', tag = 0, edit } = {}) {
  const root = tmp('herdr-review-store-pack-');
  const manifest = baseManifest(id);
  const files = {
    'img/cart-light.png': png(390, 800, 1 + tag),
    'img/cart-dark.png': png(390, 800, 2),
    'img/pay-before.png': png(390, 800, 3),
    'img/pay-after.png': png(390, 800, 4),
  };
  if (edit) edit(manifest, files);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

const publish = (dir, source, extra = {}) => publishVersion({ dir, now: T0, slug: 'shop', folder: source, publishedBy: 'orch', ...extra });
const where = (dir, pack = 'checkout-redesign') => ({ dir, now: T0, slug: 'shop', pack });

// Answer one item with the current `rev`, as a client does.
function answer(dir, item, patch, extra = {}) {
  const pack = getPack(where(dir));
  const current = pack.items.find((entry) => entry.id === item).answer;
  return putAnswer({ ...where(dir), ...extra, item, patch: { rev: current?.rev ?? 0, ...patch } });
}

const stateOf = (dir, item) => getPack(where(dir)).items.find((entry) => entry.id === item).state;

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) visit(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out;
}

const count = (dir, table) => openSqliteStore({ dir }).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const TABLES = ['review_packs', 'review_versions', 'review_items', 'review_files', 'review_answers', 'review_results'];

// ---------- Migration ----------

test('migration 2 creates the review tables in an empty database', (t) => {
  const dir = dataDir(t);
  const { db } = openSqliteStore({ dir });
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((row) => row.version), [1, 2, 3]);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of TABLES) assert.ok(names.includes(table), `table ${table} exists`);
  assert.ok(names.includes('messages'), 'the message table stays');
});

test('migration 2 upgrades a database that has migration 1 only', (t) => {
  const dir = dataDir(t);
  const file = path.join(dir, 'herdr-boss.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages (id TEXT PRIMARY KEY, at TEXT, thread TEXT, record TEXT NOT NULL);
    CREATE TABLE message_store_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO message_store_state(id, version) VALUES (1, 0);
    INSERT INTO schema_version(version) VALUES (1);
    INSERT INTO messages(id, at, thread, record) VALUES ('m1', '2026-09-28T10:00:00.000Z', 'alpha', '{"id":"m1"}');
  `);
  old.close();
  const { db } = openSqliteStore({ dir });
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((row) => row.version), [1, 2, 3]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

// ---------- Publish ----------

test('publish stores the version, the item hashes, the file table, and the files', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const result = publish(dir, source);
  assert.equal(result.pack, 'checkout-redesign');
  assert.equal(result.version, 1);
  assert.equal(result.files, 4);

  const pack = getPack(where(dir));
  assert.equal(pack.title, 'Checkout flow redesign');
  assert.equal(pack.version, 1);
  assert.equal(pack.state, 'open');
  assert.deepEqual(pack.items.map((item) => item.id), ITEMS);
  assert.deepEqual(pack.items.map((item) => item.position), [0, 1, 2, 3, 4]);
  const expected = validation.manifest.sections.flatMap((section) => section.items).map((item) => item.hash);
  assert.deepEqual(pack.items.map((item) => item.hash), expected);
  assert.equal(pack.manifest.sections.length, 2);

  const light = pack.files.find((file) => file.path === 'img/cart-light.png');
  assert.equal(light.sha256, validation.files.find((file) => file.path === 'img/cart-light.png').sha256);
  assert.equal(light.bytes, png(390, 800, 1).length);
  assert.equal(light.stored, 'img/cart-light.png');
  for (const file of pack.files) assert.deepEqual(Object.keys(file).sort(), ['bytes', 'path', 'sha256', 'stored', 'type']);

  const root = packDirectory(dir, 'shop', 'checkout-redesign', 1);
  assert.equal(root, path.join(dir, 'review-packs', 'shop', 'checkout-redesign', 'v1'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'img/cart-light.png')), png(390, 800, 1));
});

test('publish sets mode 0700 on directories and 0600 on files', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const entries = walk(path.join(dir, 'review-packs'));
  assert.ok(entries.length > 6);
  for (const entry of entries) {
    const stat = fs.statSync(entry);
    assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, entry);
  }
  assert.equal(fs.statSync(path.join(dir, 'review-packs')).mode & 0o777, 0o700);
});

test('a publish of an existing pack id makes the next version and lists the changes', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const second = publish(dir, folder({ tag: 9, edit: (m) => { m.sections[1].items.push({ id: 'new-item', title: 'New item', type: 'markdown', text: 'New.' }); } }));
  assert.equal(second.version, 2);
  assert.deepEqual(second.changed, ['cart-themes']);
  assert.deepEqual(second.added, ['new-item']);
  assert.deepEqual(second.removed, []);
  assert.equal(getPack(where(dir)).version, 2);
  assert.equal(getPack({ ...where(dir), version: 1 }).items.length, 5);
});

// ---------- Answers ----------

test('an answer with a stale rev returns a conflict that carries the current answer', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const first = putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 0, decision: 'accept', opId: 'op-1' } });
  assert.equal(first.ok, true);
  assert.equal(first.answer.rev, 1);
  const second = putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 1, note: 'The total is hard to read.', opId: 'op-2' } });
  assert.equal(second.answer.rev, 2);
  assert.equal(second.answer.decision, 'accept', 'a change keeps the fields that it does not name');

  const stale = putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 1, decision: 'deny', opId: 'op-3' } });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.current.rev, 2);
  assert.equal(stale.current.decision, 'accept');
  assert.equal(stale.current.note, 'The total is hard to read.');
  assert.equal(getPack(where(dir)).items[0].answer.decision, 'accept', 'a conflict changes nothing');
});

test('an answer for a new item needs rev 0, and a retried opId does not apply twice', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  assert.equal(putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 3, decision: 'accept' } }).conflict, true);
  const first = putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 0, decision: 'accept', opId: 'op-1' } });
  const retry = putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: 0, decision: 'accept', opId: 'op-1' } });
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.answer.rev, first.answer.rev);
});

test('an answer is checked against the item questions', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const bad = (item, patch) => assert.throws(() => putAnswer({ ...where(dir), item, patch: { rev: 0, ...patch } }), (error) => error instanceof ReviewStoreError && error.code === 'invalid');
  bad('cart-themes', { decision: 'maybe' });
  bad('cart-themes', { choice: 'a' });
  bad('pay-button', { decision: 'accept' });
  bad('pay-button', { choice: 'z' });
  bad('release-notes', { decision: 'accept' });
  bad('cart-themes', { note: 'x'.repeat(2001) });
  bad('cart-themes', { pins: [{ n: 1, x: 2, y: 0.5 }] });
  bad('no-such-item', { note: 'x' });
  assert.throws(() => putAnswer({ ...where(dir), item: 'cart-themes', patch: { decision: 'accept' } }), (error) => error.code === 'invalid', 'rev is required');
  assert.equal(count(dir, 'review_answers'), 0);
});

test('an unchanged item hash keeps the answer across versions', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'accept', note: 'Good.' });
  answer(dir, 'error-copy', { decision: 'deny' });
  const rev = getPack(where(dir)).items[0].answer.rev;
  publish(dir, folder({ edit: (m) => { m.sections[1].items[1].text = 'Changed release notes.'; } }));

  const pack = getPack(where(dir));
  assert.equal(pack.version, 2);
  const themes = pack.items.find((item) => item.id === 'cart-themes');
  assert.equal(themes.state, 'accepted');
  assert.equal(themes.stale, false);
  assert.equal(themes.answer.decision, 'accept');
  assert.equal(themes.answer.note, 'Good.');
  assert.equal(themes.answer.rev, rev, 'the rev is the same as before the publish');
  assert.equal(stateOf(dir, 'error-copy'), 'denied');
});

test('a changed item hash marks the answer stale and keeps the earlier decision visible', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'deny', note: 'The total is hard to read.', pins: [{ n: 1, src: 'b', x: 0.72, y: 0.41 }] });
  const before = getPack(where(dir)).items[0].answer;
  const second = publish(dir, folder({ tag: 9 }));
  assert.deepEqual(second.stale, ['cart-themes']);

  const item = getPack(where(dir)).items[0];
  assert.equal(item.id, 'cart-themes');
  assert.equal(item.stale, true);
  assert.equal(item.state, 'open', 'a stale item counts as open');
  assert.equal(item.answer.decision, 'deny', 'the earlier decision stays visible');
  assert.equal(item.answer.note, 'The total is hard to read.');
  assert.equal(item.answer.previous.decision, 'deny');
  assert.equal(item.answer.previous.hash, before.hash);
  assert.equal(item.answer.rev, before.rev + 1, 'a client with the old rev gets a conflict');
  assert.equal(putAnswer({ ...where(dir), item: 'cart-themes', patch: { rev: before.rev, note: 'x' } }).conflict, true);

  const derived = getPack(where(dir)).derived;
  assert.equal(derived.sections.find((section) => section.id === 'cart').state, 'open');

  // The Owner answers again: the decision is new and the mark goes away.
  const again = answer(dir, 'cart-themes', { decision: 'accept' });
  assert.equal(again.answer.stale, false);
  assert.equal(again.answer.decision, 'accept');
  assert.equal(again.answer.hash, item.hash);
  assert.equal(stateOf(dir, 'cart-themes'), 'accepted');
});

test('the pack list counts the stale items, so the list can mark a changed pack', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  assert.equal(listPacks({ dir })[0].stale, 0);
  answer(dir, 'cart-themes', { decision: 'deny' });
  publish(dir, folder({ tag: 9 }));
  assert.equal(listPacks({ dir })[0].stale, 1);
  answer(dir, 'cart-themes', { decision: 'accept' });
  assert.equal(listPacks({ dir })[0].stale, 0);
});

test('an answer to an item that a version removed stays for the summary', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'error-copy', { decision: 'deny', note: 'Too long.' });
  const second = publish(dir, folder({ edit: (m) => { m.sections[1].items.splice(0, 1); } }));
  assert.deepEqual(second.removed, ['error-copy']);
  const pack = getPack(where(dir));
  assert.equal(pack.items.some((item) => item.id === 'error-copy'), false);
  assert.equal(pack.removed.length, 1);
  assert.equal(pack.removed[0].id, 'error-copy');
  assert.equal(pack.removed[0].answer.decision, 'deny');
  assert.equal(pack.derived.counts.items, 4);
});

// ---------- Derived states ----------

test('item, section, and pack states follow the answers', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const derived = () => getPack(where(dir)).derived;
  const sectionState = (id) => derived().sections.find((section) => section.id === id).state;

  assert.equal(derived().pack, 'open');
  assert.deepEqual(derived().counts, { items: 5, accepted: 0, denied: 0, live: 0, noteOnly: 0, open: 5 });
  assert.equal(derived().proposedVerdict, 'accept-with-changes');

  answer(dir, 'cart-themes', { decision: 'accept' });
  assert.equal(sectionState('cart'), 'open', 'one open item keeps the section open');
  answer(dir, 'pay-button', { choice: 'b' });
  assert.equal(stateOf(dir, 'pay-button'), 'answered');
  assert.equal(sectionState('cart'), 'accepted');
  assert.equal(sectionState('errors'), 'open');
  assert.equal(derived().pack, 'open');

  answer(dir, 'error-copy', { decision: 'accept' });
  answer(dir, 'release-notes', { note: 'Read it. No change.' });
  assert.equal(stateOf(dir, 'release-notes'), 'note');
  answer(dir, 'live-form', { live: 'pending' });
  assert.equal(stateOf(dir, 'live-form'), 'live');
  assert.equal(sectionState('errors'), 'live');
  assert.equal(derived().pack, 'live');
  assert.equal(derived().proposedVerdict, 'accept-with-changes');

  answer(dir, 'live-form', { live: 'done' });
  assert.equal(stateOf(dir, 'live-form'), 'open', 'a done live check alone does not answer an item that asks accept or deny');
  answer(dir, 'live-form', { decision: 'accept' });
  assert.equal(sectionState('errors'), 'accepted');
  assert.equal(derived().pack, 'accepted');
  assert.equal(derived().proposedVerdict, 'accept');
  assert.deepEqual(derived().counts, { items: 5, accepted: 4, denied: 0, live: 0, noteOnly: 1, open: 0 });

  answer(dir, 'error-copy', { decision: 'deny' });
  assert.equal(sectionState('errors'), 'denied');
  assert.equal(derived().pack, 'denied');
  assert.equal(derived().proposedVerdict, 'accept-with-changes');

  answer(dir, 'live-form', { decision: null, live: 'pending' });
  assert.equal(sectionState('errors'), 'denied', 'denied wins over needs live check');

  answer(dir, 'release-notes', { note: '' });
  assert.equal(stateOf(dir, 'release-notes'), 'open', 'an empty note leaves a note-only item open');
});

test('a live check that is the only question is answered when it is done', (t) => {
  const dir = dataDir(t);
  publish(dir, folder({ edit: (m) => { m.sections[1].items[2].ask = ['live']; } }));
  answer(dir, 'live-form', { live: 'pending' });
  assert.equal(stateOf(dir, 'live-form'), 'live');
  answer(dir, 'live-form', { live: 'done' });
  assert.equal(stateOf(dir, 'live-form'), 'answered');
});

test('the pack note uses rev too', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  assert.equal(getPack(where(dir)).note, '');
  const first = putPackNote({ ...where(dir), note: 'Fix the dark cart.', rev: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.rev, 1);
  const stale = putPackNote({ ...where(dir), note: 'Other.', rev: 0 });
  assert.equal(stale.conflict, true);
  assert.equal(stale.current.note, 'Fix the dark cart.');
  assert.equal(getPack(where(dir)).noteRev, 1);
});

// ---------- Submit ----------

test('a pack is submitted once, and a second submit after a new version is allowed', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  setMailId({ ...where(dir), mailId: 'mail-1' });
  answer(dir, 'cart-themes', { decision: 'deny', note: 'The total is hard to read.' });
  answer(dir, 'pay-button', { choice: 'b' });
  putPackNote({ ...where(dir), note: 'Good direction.', rev: 0 });

  const submitted = submitPack({ ...where(dir), verdict: 'accept-with-changes', note: 'Fix the dark cart.', messageId: 'msg-1' });
  assert.equal(submitted.ok, true);
  const result = submitted.result;
  assert.equal(result.schema, 'herdr-boss.review-result/1');
  assert.equal(result.version, 1);
  assert.equal(result.verdict, 'accept-with-changes');
  assert.equal(result.note, 'Fix the dark cart.');
  assert.equal(result.submittedAt, new Date(T0).toISOString());
  assert.deepEqual(result.counts, { items: 5, accepted: 1, denied: 1, live: 0, noteOnly: 0, open: 3 });
  assert.deepEqual(result.sections, [{ id: 'cart', state: 'denied' }, { id: 'errors', state: 'open' }]);
  assert.equal(result.items.find((item) => item.id === 'cart-themes').decision, 'deny');
  assert.equal(result.items.find((item) => item.id === 'pay-button').choice, 'b');
  assert.equal(result.items.find((item) => item.id === 'pay-button').state, 'answered');
  assert.equal(getPack(where(dir)).state, 'submitted');
  assert.equal(getPack(where(dir)).mailId, 'mail-1');
  assert.throws(() => putAnswer({ ...where(dir), item: 'error-copy', patch: { rev: 0, decision: 'accept' } }), (error) => error.code === 'closed');

  const again = submitPack({ ...where(dir), verdict: 'accept', note: 'Again.' });
  assert.equal(again.ok, false);
  assert.equal(again.conflict, 'submitted');
  assert.equal(again.result.verdict, 'accept-with-changes');
  assert.equal(count(dir, 'review_results'), 1);

  assert.throws(() => submitPack({ ...where(dir), verdict: 'ship-it' }), (error) => error.code === 'invalid');

  publish(dir, folder({ tag: 9 }));
  assert.equal(getPack(where(dir)).state, 'open', 'a new version opens the pack again');
  const second = submitPack({ ...where(dir), verdict: 'deny', note: 'Second look.' });
  assert.equal(second.ok, true);
  assert.equal(second.result.version, 2);
  assert.equal(getResult(where(dir)).version, 2);
  assert.equal(getResult({ ...where(dir), version: 1 }).verdict, 'accept-with-changes');
  assert.equal(count(dir, 'review_results'), 2);
});

// ---------- Retention ----------

test('a new version keeps the newest 3 versions of files and rows', (t) => {
  const dir = dataDir(t);
  for (let tag = 1; tag <= 4; tag += 1) publish(dir, folder({ tag }));
  const base = path.join(dir, 'review-packs', 'shop', 'checkout-redesign');
  assert.deepEqual(fs.readdirSync(base).sort(), ['v2', 'v3', 'v4']);
  const { db } = openSqliteStore({ dir });
  for (const table of ['review_versions', 'review_items', 'review_files']) {
    assert.deepEqual(db.prepare(`SELECT DISTINCT version FROM ${table} ORDER BY version`).all().map((row) => row.version), [2, 3, 4], table);
  }
  assert.equal(getPack({ ...where(dir), version: 1 }), null);
  assert.equal(getPack({ ...where(dir), version: 2 }).version, 2);
});

test('the sweep deletes a submitted pack 30 days after the submit and keeps the result for 180 days', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'accept' });
  submitPack({ ...where(dir), verdict: 'deny', note: '' });

  assert.deepEqual(sweep({ dir, now: T0 + 29 * DAY }).deleted, []);
  assert.equal(fs.existsSync(path.join(dir, 'review-packs', 'shop', 'checkout-redesign')), true);

  const swept = sweep({ dir, now: T0 + 31 * DAY });
  assert.deepEqual(swept.deleted.map((entry) => `${entry.slug}/${entry.pack}`), ['shop/checkout-redesign']);
  assert.equal(fs.existsSync(path.join(dir, 'review-packs', 'shop', 'checkout-redesign')), false);
  for (const table of ['review_packs', 'review_versions', 'review_items', 'review_files', 'review_answers']) assert.equal(count(dir, table), 0, table);
  assert.equal(count(dir, 'review_results'), 1);
  assert.equal(getResult(where(dir)).verdict, 'deny');
  assert.equal(getPack(where(dir)), null);

  sweep({ dir, now: T0 + 181 * DAY });
  assert.equal(count(dir, 'review_results'), 0);
});

test('the sweep marks an open pack expired after 60 days without a change, then deletes it 30 days later', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  setMailId({ ...where(dir), mailId: 'mail-9' });
  publish(dir, folder({ id: 'api-reference' }), { now: T0 + 50 * DAY });

  const first = sweep({ dir, now: T0 + 61 * DAY });
  assert.deepEqual(first.expired.map((entry) => ({ slug: entry.slug, pack: entry.pack, mailId: entry.mailId })), [{ slug: 'shop', pack: 'checkout-redesign', mailId: 'mail-9' }]);
  assert.equal(getPack(where(dir)).state, 'expired');
  assert.equal(getPack(where(dir, 'api-reference')).state, 'open');
  assert.equal(sweep({ dir, now: T0 + 62 * DAY }).expired.length, 0, 'an expired pack expires once');

  const later = sweep({ dir, now: T0 + 111 * DAY });
  assert.deepEqual(later.deleted.map((entry) => entry.pack), ['checkout-redesign']);
  assert.deepEqual(later.expired.map((entry) => entry.pack), ['api-reference']);
});

test('an answer resets the 60-day expiry', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  putAnswer({ ...where(dir), now: T0 + 40 * DAY, item: 'cart-themes', patch: { rev: 0, decision: 'accept' } });
  assert.equal(sweep({ dir, now: T0 + 61 * DAY }).expired.length, 0);
  assert.equal(sweep({ dir, now: T0 + 101 * DAY }).expired.length, 1);
});

test('publish refuses a version that pushes the total bytes over the quota and names the oldest submitted packs', (t) => {
  const dir = dataDir(t);
  const size = png(390, 800, 1).length * 4;
  publish(dir, folder({ id: 'api-reference' }), { quotaBytes: size * 2.5 });
  submitPack({ ...where(dir, 'api-reference'), verdict: 'accept', note: '' });
  publish(dir, folder({ id: 'landing-redesign' }), { quotaBytes: size * 2.5 });

  const before = walk(path.join(dir, 'review-packs')).length;
  assert.throws(() => publish(dir, folder({ id: 'checkout-redesign' }), { quotaBytes: size * 2.5 }), (error) => {
    assert.ok(error instanceof ReviewStoreError);
    assert.equal(error.code, 'quota');
    assert.deepEqual(error.oldest.map((entry) => entry.pack), ['api-reference']);
    return true;
  });
  assert.equal(walk(path.join(dir, 'review-packs')).length, before, 'a refusal copies nothing');
  assert.equal(getPack(where(dir)), null);

  // The sweep frees the bytes, and the publish works.
  sweep({ dir, now: T0 + 31 * DAY });
  assert.equal(publish(dir, folder({ id: 'checkout-redesign' }), { quotaBytes: size * 2.5, now: T0 + 31 * DAY }).version, 1);
});

test('a project has at most 5 open packs', (t) => {
  const dir = dataDir(t);
  for (let n = 1; n <= 5; n += 1) publish(dir, folder({ id: `pack-${n}` }));
  assert.throws(() => publish(dir, folder({ id: 'pack-6' })), (error) => error.code === 'open-packs');
  assert.equal(publish(dir, folder({ id: 'pack-5', tag: 7 })).version, 2, 'a new version of an open pack is not a new pack');
  assert.equal(publish(dir, folder({ id: 'pack-6' }), { slug: 'other-project' }).version, 1);
});

// ---------- Copy safety ----------

function assertNothingPublished(dir) {
  const root = path.join(dir, 'review-packs');
  const leftovers = walk(root).filter((entry) => fs.statSync(entry).isFile());
  assert.deepEqual(leftovers, [], 'no file stays');
  for (const entry of walk(root)) assert.doesNotMatch(path.basename(entry), /^v\d+$/, 'no version folder stays');
  for (const table of TABLES) assert.equal(count(dir, table), 0, table);
}

test('a failure in the middle of the copy leaves no half version', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  fs.rmSync(path.join(source, 'img/pay-before.png'));
  assert.throws(() => publish(dir, source, { validation }), (error) => error instanceof ReviewStoreError && error.code === 'copy');
  assertNothingPublished(dir);
});

test('a file that changed after the validation is refused', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  fs.writeFileSync(path.join(source, 'img/pay-after.png'), png(390, 800, 99));
  assert.throws(() => publish(dir, source, { validation }), (error) => error.code === 'copy');
  assertNothingPublished(dir);
});

test('a file that became a symbolic link is refused', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  const target = path.join(tmp('herdr-review-store-outside-'), 'outside.png');
  fs.writeFileSync(target, fs.readFileSync(path.join(source, 'img/pay-after.png')));
  fs.rmSync(path.join(source, 'img/pay-after.png'));
  fs.symlinkSync(target, path.join(source, 'img/pay-after.png'));
  assert.throws(() => publish(dir, source, { validation }), (error) => error.code === 'copy');
  assertNothingPublished(dir);
});

test('a failure in the database removes the copied files', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const { db } = openSqliteStore({ dir });
  db.exec("CREATE TRIGGER refuse_items BEFORE INSERT ON review_items BEGIN SELECT RAISE(ABORT, 'refused'); END");
  assert.throws(() => publish(dir, source), /refused/);
  db.exec('DROP TRIGGER refuse_items');
  assertNothingPublished(dir);
  assert.equal(publish(dir, source).version, 1, 'the publish works after the fault');
});

test('a stored name cannot leave the version folder', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  const hostile = (name) => ({ ...validation, files: [{ ...validation.files[0], path: name }] });
  for (const name of ['../escape.png', 'img/../../escape.png', '/etc/hosts', 'img\\..\\escape.png', 'a/./b.png', '.hidden.png', 'nul\0.png', '']) {
    assert.throws(() => publish(dir, source, { validation: hostile(name) }), (error) => error instanceof ReviewStoreError && error.code === 'path', JSON.stringify(name));
  }
  assertNothingPublished(dir);
  assert.equal(fs.existsSync(path.join(dir, 'escape.png')), false);
  assert.equal(fs.existsSync(path.join(dir, 'review-packs', 'escape.png')), false);

  for (const slug of ['../evil', 'a/b', '', 'Shop', '.']) {
    assert.throws(() => publish(dir, source, { slug }), (error) => error.code === 'slug', JSON.stringify(slug));
  }
  assert.throws(() => publish(dir, source, { validation: { ...validation, manifest: { ...validation.manifest, id: '../evil' } } }), (error) => error.code === 'slug');
  assert.throws(() => getPack({ dir, slug: '../evil', pack: 'x' }), (error) => error.code === 'slug');
  assert.throws(() => packDirectory(dir, 'shop', 'checkout-redesign', '../1'), (error) => error.code === 'invalid');
  for (const stored of openSqliteStore({ dir }).db.prepare('SELECT stored FROM review_files').all()) assert.doesNotMatch(stored.stored, /\.\./);
});

test('publish refuses a pack that fails the validation', (t) => {
  const dir = dataDir(t);
  const source = folder({ edit: (m) => { m.sections[0].items[0].a.src = 'img/missing.png'; } });
  assert.throws(() => publish(dir, source), (error) => error.code === 'validation' && error.errors.length > 0);
  assertNothingPublished(dir);
});

// ---------- Read and delete ----------

test('list and get return metadata and no file content', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  publish(dir, folder({ id: 'api-reference' }), { now: T0 + DAY });
  answer(dir, 'cart-themes', { decision: 'accept' });
  submitPack({ ...where(dir, 'api-reference'), verdict: 'accept', note: '' });

  const open = listPacks({ dir });
  assert.deepEqual(open.map((entry) => entry.pack).sort(), ['checkout-redesign']);
  assert.equal(open[0].title, 'Checkout flow redesign');
  assert.equal(open[0].version, 1);
  assert.equal(open[0].state, 'open');
  assert.deepEqual(open[0].counts, { items: 5, accepted: 1, denied: 0, live: 0, noteOnly: 0, open: 4 });
  const done = listPacks({ dir, state: 'done' });
  assert.deepEqual(done.map((entry) => [entry.pack, entry.verdict]), [['api-reference', 'accept']]);
  assert.equal(listPacks({ dir, state: 'all' }).length, 2);

  const png1 = png(390, 800, 1).toString('base64');
  for (const value of [open, done, getPack(where(dir))]) {
    const json = JSON.stringify(value);
    assert.equal(json.includes(png1), false);
    assert.equal(json.includes('PNG'), false);
  }
  assert.equal(getPack({ ...where(dir), pack: 'no-such-pack' }), null);
});

test('delete removes the files and the rows, and returns the mail id', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  publish(dir, folder({ id: 'api-reference' }));
  setMailId({ ...where(dir), mailId: 'mail-1' });
  answer(dir, 'cart-themes', { decision: 'accept' });
  submitPack({ ...where(dir), verdict: 'accept', note: '' });

  const removed = deletePack(where(dir));
  assert.equal(removed.deleted, true);
  assert.equal(removed.mailId, 'mail-1');
  assert.equal(fs.existsSync(path.join(dir, 'review-packs', 'shop', 'checkout-redesign')), false);
  assert.equal(getPack(where(dir)), null);
  assert.equal(getResult(where(dir)), null);
  const { db } = openSqliteStore({ dir });
  for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pack = 'checkout-redesign'`).get().n, 0, table);
  assert.equal(getPack(where(dir, 'api-reference')).version, 1, 'another pack stays');
  assert.equal(fs.existsSync(path.join(dir, 'review-packs', 'shop', 'api-reference', 'v1', 'img', 'cart-light.png')), true);
  assert.equal(deletePack(where(dir)).deleted, false);
});

// ---------- Review fixes ----------

const ABSOLUTE = /(^|[\s'"(])\/[\w.-]+\//;

test('a file system failure gives an error code and no absolute path', (t) => {
  const dir = dataDir(t);
  const source = folder();
  const validation = validatePack(source);
  const noPath = (error) => {
    assert.ok(error instanceof ReviewStoreError, String(error));
    for (const value of [dir, source, os.tmpdir(), path.basename(dir), path.basename(source)]) assert.equal(error.message.includes(value), false, `${error.message} holds ${value}`);
    assert.doesNotMatch(error.message, ABSOLUTE);
    return true;
  };

  fs.rmSync(path.join(source, 'img/pay-before.png'));
  assert.throws(() => publish(dir, source, { validation }), (error) => {
    assert.equal(error.code, 'copy');
    assert.equal(error.file, 'img/pay-before.png');
    assert.match(error.message, /img\/pay-before\.png/);
    assert.match(error.message, /ENOENT/);
    return noPath(error);
  });

  assert.throws(() => publish(dir, path.join(source, 'missing-folder'), { validation }), (error) => error.code === 'io' && /ENOENT/.test(error.message) && noPath(error));

  // A file where the pack folder belongs: the folder creation fails.
  fs.rmSync(path.join(dir, 'review-packs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'review-packs'), 'not a folder');
  assert.throws(() => publish(dir, folder(), {}), (error) => error.code === 'io' && /ENOTDIR|EEXIST/.test(error.message) && noPath(error));
});

test('the sweep removes old stage folders and version folders without a row', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const base = path.join(dir, 'review-packs', 'shop', 'checkout-redesign');
  const oldStage = path.join(base, '.stage-aaaa');
  const freshStage = path.join(base, '.stage-bbbb');
  const orphan = path.join(base, 'v7');
  for (const folderPath of [oldStage, freshStage, orphan]) {
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'file.png'), 'x');
  }
  fs.mkdirSync(path.join(dir, 'review-packs', 'shop', 'gone-pack', 'v1'), { recursive: true });
  const old = new Date(T0 - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldStage, old, old);
  fs.utimesSync(freshStage, new Date(T0 - 5 * 60 * 1000), new Date(T0 - 5 * 60 * 1000));

  const swept = sweep({ dir, now: T0 });
  assert.deepEqual(swept.cleaned.sort(), ['review-packs/shop/checkout-redesign/.stage-aaaa', 'review-packs/shop/checkout-redesign/v7', 'review-packs/shop/gone-pack/v1']);
  assert.equal(fs.existsSync(oldStage), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(freshStage), true, 'a stage folder under 1 hour old may belong to a running publish');
  assert.equal(fs.existsSync(path.join(base, 'v1', 'img', 'cart-light.png')), true, 'a version with a row stays');
  assert.equal(getPack(where(dir)).version, 1);
  assert.deepEqual(sweep({ dir, now: T0 }).cleaned, []);
});

test('the quota does not count the versions that the same publish prunes', (t) => {
  const dir = dataDir(t);
  const size = png(390, 800, 1).length * 4;
  const quotaBytes = size * 3.5;
  for (let tag = 1; tag <= 3; tag += 1) publish(dir, folder({ tag }), { quotaBytes });
  // 3 versions use 3 sizes. A fourth would make 4, but v1 goes in the same publish.
  assert.equal(publish(dir, folder({ tag: 4 }), { quotaBytes }).version, 4);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'review-packs', 'shop', 'checkout-redesign')).sort(), ['v2', 'v3', 'v4']);
  // Another pack still counts in full.
  assert.throws(() => publish(dir, folder({ id: 'api-reference' }), { quotaBytes }), (error) => error.code === 'quota');
});

// ---------- File lookup ----------

test('getFile finds a stored file by its manifest path and nothing else', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  const found = getFile({ dir, slug: 'shop', pack: 'checkout-redesign', version: 1, file: 'img/cart-light.png' });
  assert.equal(found.path, 'img/cart-light.png');
  assert.match(found.sha256, /^[0-9a-f]{64}$/);
  assert.equal(found.file, path.join(packDirectory(dir, 'shop', 'checkout-redesign', 1), 'img', 'cart-light.png'));
  assert.equal(fs.statSync(found.file).size, found.bytes);
  for (const file of ['../manifest.json', 'img/../img/cart-light.png', '/etc/passwd', 'img/missing.png', '', undefined]) {
    assert.equal(getFile({ dir, slug: 'shop', pack: 'checkout-redesign', version: 1, file }), null, String(file));
  }
  assert.equal(getFile({ dir, slug: 'shop', pack: 'checkout-redesign', version: 2, file: 'img/cart-light.png' }), null, 'a version that does not exist');
  assert.throws(() => getFile({ dir, slug: 'shop', pack: 'checkout-redesign', version: 0, file: 'img/cart-light.png' }), ReviewStoreError);
  assert.throws(() => getFile({ dir, slug: 'Bad Slug', pack: 'checkout-redesign', version: 1, file: 'x' }), ReviewStoreError);
});
