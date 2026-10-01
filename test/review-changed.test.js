// The version reset of review answers: an item whose content changed after the Owner answered shows `changed`, not the old verdict.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { openSqliteStore } from '../src/sqlite-store.js';
import { publishVersion, putAnswer, getPack, listPacks, submitPack } from '../src/review-store.js';
import { reviewCommand } from '../src/review-cli.js';

const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const T1 = T0 + 60 * 60 * 1000;
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function dataDir(t) {
  const dir = tmp('herdr-review-changed-data-');
  assertTempDataDir(dir);
  t.after(() => openSqliteStore({ dir }).close());
  return dir;
}

function png(tag = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(390, 8);
  ihdr.writeUInt32BE(800, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16, tag)]);
}

// An invented pack: section "cart" with an image item, a choice item, and a text item; section "copy" with one text item.
// `image` changes the bytes of the image of cart-themes. `text` changes the text of error-copy. `choices` replaces the choices of pay-button.
function folder({ image = 1, text = 'The card was declined.', choices } = {}) {
  const root = tmp('herdr-review-changed-pack-');
  const manifest = {
    schema: 'herdr-boss.review-pack/1',
    id: 'sample-pack',
    title: 'Sample pack',
    sections: [
      { id: 'cart', title: 'Cart', items: [
        { id: 'cart-themes', title: 'Cart in two themes', type: 'image', src: 'img/cart.png', ask: ['accept', 'deny', 'note'] },
        { id: 'pay-button', title: 'Pay button', type: 'markdown', text: 'Pick one.', ask: ['choice', 'note'], choices: choices ?? [{ id: 'a', label: 'Before' }, { id: 'b', label: 'After' }] },
        { id: 'release-notes', title: 'Release notes', type: 'markdown', text: 'Notes.', ask: ['note'] },
      ] },
      { id: 'copy', title: 'Copy', items: [
        { id: 'error-copy', title: 'Error messages', type: 'markdown', text, ask: ['accept', 'deny', 'note'] },
      ] },
    ],
  };
  fs.mkdirSync(path.join(root, 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img', 'cart.png'), png(image));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

const where = (dir, now = T0) => ({ dir, now, slug: 'shop', pack: 'sample-pack' });
const publish = (dir, source, now = T0) => publishVersion({ dir, now, slug: 'shop', folder: source, publishedBy: 'orch' });
const find = (dir, id) => getPack(where(dir)).items.find((item) => item.id === id);
const sectionState = (dir, id) => getPack(where(dir)).derived.sections.find((section) => section.id === id).state;

function answer(dir, item, patch, now = T0) {
  const rev = find(dir, item).answer?.rev ?? 0;
  return putAnswer({ ...where(dir, now), item, patch: { rev, ...patch } });
}

// Accept the two items that the tests change, choose on the item that stays, and open v2 with both changes.
function twoVersions(dir) {
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'accept', viewed: true });
  answer(dir, 'error-copy', { decision: 'accept' });
  answer(dir, 'pay-button', { choice: 'b' });
  return publish(dir, folder({ image: 9, text: 'The card was declined. Try another card.' }), T1);
}

test('a changed item loses its verdict and shows changed, with the earlier verdict and its time kept', (t) => {
  const dir = dataDir(t);
  const second = twoVersions(dir);
  assert.deepEqual(second.changed.sort(), ['cart-themes', 'error-copy']);

  for (const id of ['cart-themes', 'error-copy']) {
    const item = find(dir, id);
    assert.equal(item.state, 'changed', `${id} is changed`);
    assert.equal(item.stale, true);
    assert.equal(item.answer.decision, null, `${id} shows no verdict`);
    assert.equal(item.answer.viewed, false, `${id} is not viewed any more`);
    assert.equal(item.answer.previous.decision, 'accept');
    assert.equal(item.answer.previous.at, new Date(T0).toISOString());
  }
});

test('a re-uploaded image with the same item id counts as a content change', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'accept' });
  publish(dir, folder({ image: 5 }), T1);
  assert.equal(find(dir, 'cart-themes').state, 'changed');
  assert.equal(find(dir, 'error-copy').state, 'open', 'an item that never had a verdict stays open');
});

test('an unchanged item keeps its verdict and its viewed mark', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const item = find(dir, 'pay-button');
  assert.equal(item.state, 'answered');
  assert.equal(item.stale, false);
  assert.equal(item.answer.choice, 'b');
  assert.equal(item.answer.previous, null);
});

test('a changed item with a note only stays open and keeps the note', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'error-copy', { note: 'Shorter, please.' });
  publish(dir, folder({ text: 'Another text.' }), T1);
  const item = find(dir, 'error-copy');
  assert.equal(item.state, 'open');
  assert.equal(item.answer.note, 'Shorter, please.');
});

test('a section state is computed from its items: changed beats accepted, and all accepted gives accepted', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'accept' });
  answer(dir, 'pay-button', { choice: 'a' });
  answer(dir, 'release-notes', { note: 'Fine.' });
  assert.equal(sectionState(dir, 'cart'), 'accepted');
  publish(dir, folder({ image: 7 }), T1);
  assert.equal(sectionState(dir, 'cart'), 'changed', 'one changed item makes the section changed');
  assert.equal(sectionState(dir, 'copy'), 'open');
  answer(dir, 'cart-themes', { decision: 'accept' }, T1);
  assert.equal(sectionState(dir, 'cart'), 'accepted');
});

test('the counts treat changed as open work and report the changed items', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const { counts } = getPack(where(dir)).derived;
  assert.equal(counts.items, 4);
  assert.equal(counts.changed, 2);
  assert.equal(counts.open, 3, 'two changed items and the release notes without an answer');
  assert.equal(counts.accepted, 1);
  const [entry] = listPacks({ dir });
  assert.equal(entry.counts.changed, 2);
  assert.equal(entry.stale, 2);
});

test('Keep restores the earlier verdict, clears the mark, and makes the section accepted again', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const kept = answer(dir, 'cart-themes', { keep: true }, T1);
  assert.equal(kept.ok, true);
  assert.equal(kept.answer.decision, 'accept');
  assert.equal(kept.answer.stale, false);
  assert.equal(kept.answer.previous, null);
  assert.equal(kept.answer.hash, find(dir, 'cart-themes').hash);
  assert.equal(find(dir, 'cart-themes').state, 'accepted');
  assert.equal(find(dir, 'cart-themes').answer.viewed, true, 'Keep brings the viewed mark back');
  assert.equal(getPack(where(dir)).derived.counts.changed, 1);
});

test('Keep refuses an item that did not change, and a choice that the new version dropped', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  assert.throws(() => answer(dir, 'pay-button', { keep: true }), /no changed answer/i);

  const other = dataDir(t);
  publish(other, folder());
  answer(other, 'pay-button', { choice: 'b' });
  publish(other, folder({ choices: [{ id: 'a', label: 'Before' }, { id: 'c', label: 'Other' }] }), T1);
  assert.equal(find(other, 'pay-button').state, 'changed');
  assert.throws(() => answer(other, 'pay-button', { keep: true }), /choice/i);
});

test('a new answer to a changed item replaces the mark', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const saved = answer(dir, 'error-copy', { decision: 'deny' }, T1);
  assert.equal(saved.answer.decision, 'deny');
  assert.equal(saved.answer.previous, null);
  assert.equal(find(dir, 'error-copy').state, 'denied');
});

test('an old stored answer without the previous record shows changed with its own verdict and time', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const { db } = openSqliteStore({ dir });
  db.prepare("UPDATE review_answers SET previous = NULL WHERE item = 'cart-themes'").run();
  const item = find(dir, 'cart-themes');
  assert.equal(item.state, 'changed');
  assert.equal(item.answer.previous.decision, 'accept');
  assert.equal(item.answer.previous.at, new Date(T0).toISOString());
  assert.equal(answer(dir, 'cart-themes', { keep: true }, T1).answer.decision, 'accept');
});

test('an old stored answer of an unchanged item stays valid', (t) => {
  const dir = dataDir(t);
  publish(dir, folder());
  answer(dir, 'cart-themes', { decision: 'deny' });
  const { db } = openSqliteStore({ dir });
  db.prepare("UPDATE review_answers SET previous = NULL, stale = 0 WHERE item = 'cart-themes'").run();
  const item = find(dir, 'cart-themes');
  assert.equal(item.state, 'denied');
  assert.equal(item.answer.previous, null);
});

test('the result and the list count a changed item as open work', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const submitted = submitPack({ ...where(dir, T1), verdict: 'accept-with-changes' });
  const states = Object.fromEntries(submitted.result.items.map((item) => [item.id, item.state]));
  assert.equal(states['cart-themes'], 'changed');
  assert.equal(submitted.result.counts.open, 3);
  assert.equal(submitted.result.counts.changed, 2);
});

test('herdr-boss review list counts the changed items as open and names them', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  const lines = [];
  const code = reviewCommand(['list'], { env: {}, dir, now: T1, out: (line) => lines.push(line), err: (line) => lines.push(line) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /1 of 4 answered, 2 changed/);
});

test('a viewed, note, or pins change keeps the mark and the earlier verdict of a changed item', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  for (const patch of [{ viewed: true }, { note: 'Looks different.' }, { pins: [{ n: 1, x: 0.5, y: 0.5 }] }]) {
    const saved = answer(dir, 'cart-themes', patch, T1);
    assert.equal(saved.answer.stale, true, `${Object.keys(patch)[0]} keeps the mark`);
    assert.equal(saved.answer.decision, null);
    assert.equal(saved.answer.previous.decision, 'accept');
    assert.equal(saved.answer.previous.at, new Date(T0).toISOString());
    assert.equal(find(dir, 'cart-themes').state, 'changed');
  }
  assert.equal(find(dir, 'cart-themes').answer.note, 'Looks different.');
  // Keep still works after those writes.
  const kept = answer(dir, 'cart-themes', { keep: true }, T1);
  assert.equal(kept.answer.decision, 'accept');
  assert.equal(kept.answer.stale, false);
  assert.equal(kept.answer.note, 'Looks different.');
});

test('a verdict change takes the mark off, and a note on an item with no earlier verdict does too', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  answer(dir, 'cart-themes', { note: 'x' }, T1);
  assert.equal(answer(dir, 'cart-themes', { decision: 'deny' }, T1).answer.stale, false);

  const other = dataDir(t);
  publish(other, folder());
  answer(other, 'error-copy', { note: 'Shorter, please.' });
  publish(other, folder({ text: 'Another text.' }), T1);
  assert.equal(answer(other, 'error-copy', { note: 'Shorter.' }, T1).answer.stale, false);
});

test('a changed item whose row has no stale flag keeps its earlier verdict through a viewed write', (t) => {
  const dir = dataDir(t);
  twoVersions(dir);
  openSqliteStore({ dir }).db.prepare("UPDATE review_answers SET stale = 0, previous = NULL WHERE item = 'cart-themes'").run();
  const saved = answer(dir, 'cart-themes', { viewed: true }, T1);
  assert.equal(saved.answer.stale, true);
  assert.equal(saved.answer.previous.decision, 'accept');
});
