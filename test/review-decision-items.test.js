// RV1: an item that needs a decision gets accept and deny, agent-verified items included.
// An item that the Owner cannot answer (info only) never counts as open.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { validatePack } from '../src/review-pack.js';
import { openSqliteStore } from '../src/sqlite-store.js';
import { publishVersion, putAnswer, getPack, submitPack } from '../src/review-store.js';

const { answerBarHtml } = await import('../public/review-viewer.js');
const { effectiveAsk } = await import('../public/review-ask.js');

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const tmp = (prefix = 'herdr-review-rv1-') => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root); return root; };

function dataDir(t) {
  const dir = tmp('herdr-review-rv1-data-');
  assertTempDataDir(dir);
  t.after(() => openSqliteStore({ dir }).close());
  return dir;
}

const ITEMS = [
  { id: 'verified-note', title: 'Verified, note only', type: 'markdown', text: 'x', verifiedBy: 'agent-verified', ask: ['note'] },
  { id: 'verified-default', title: 'Verified, default ask', type: 'markdown', text: 'x', verifiedBy: 'agent-verified' },
  { id: 'verified-choice', title: 'Verified, choice', type: 'markdown', text: 'x', verifiedBy: 'agent-verified', ask: ['choice'], choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { id: 'result', title: 'Result text', type: 'markdown', text: 'The result.', ask: ['note'] },
  { id: 'decide', title: 'Decide', type: 'markdown', text: 'x', ask: ['accept', 'deny', 'note'] },
];

function folder(items = ITEMS) {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 'herdr-boss.review-pack/1', id: 'rv1', title: 'RV1', sections: [{ id: 's', title: 'S', items }] }));
  return root;
}

const where = (dir) => ({ dir, now: Date.parse('2026-10-01T08:00:00.000Z'), slug: 'shop', pack: 'rv1' });
const publish = (dir) => publishVersion({ ...where(dir), folder: folder(), publishedBy: 'orch' });
const find = (dir, id) => getPack(where(dir)).items.find((item) => item.id === id);

test('the validator gives an agent-verified item accept and deny', () => {
  const result = validatePack(folder(), {});
  assert.deepEqual(result.errors, []);
  const byId = Object.fromEntries(result.manifest.sections[0].items.map((item) => [item.id, item]));
  assert.deepEqual(byId['verified-note'].ask.slice(0, 2), ['accept', 'deny']);
  assert.ok(byId['verified-note'].ask.includes('note'));
  assert.deepEqual(byId['verified-default'].ask, ['accept', 'deny', 'note']);
  assert.deepEqual(byId['verified-choice'].ask, ['choice']);
  assert.deepEqual(byId.result.ask, ['note']);
  assert.ok(result.warnings.some((w) => w.rule === 'ask' && /verified-note/.test(w.message)));
});

test('effectiveAsk adds accept and deny to an agent-verified item with no decision question', () => {
  assert.deepEqual(effectiveAsk({ verifiedBy: 'agent-verified', ask: ['note'] }), ['accept', 'deny', 'note']);
  assert.deepEqual(effectiveAsk({ verifiedBy: 'agent-verified', ask: ['accept', 'note'] }), ['accept', 'deny', 'note']);
  assert.deepEqual(effectiveAsk({ verifiedBy: 'agent-verified', ask: ['rating'] }), ['rating']);
  assert.deepEqual(effectiveAsk({ verifiedBy: 'needs-you', ask: ['note'] }), ['note']);
  assert.deepEqual(effectiveAsk({ ask: undefined }), []);
});

test('a stored agent-verified item with ask note only still takes accept and deny', (t) => {
  const dir = dataDir(t);
  publish(dir);
  const { db } = openSqliteStore({ dir });
  for (const row of db.prepare('SELECT rowid AS id, spec FROM review_items').all()) {
    const spec = JSON.parse(row.spec);
    if (spec.verifiedBy === 'agent-verified' && spec.title === 'Verified, note only') {
      spec.ask = ['note'];
      db.prepare('UPDATE review_items SET spec = ? WHERE rowid = ?').run(JSON.stringify(spec), row.id);
    }
  }
  const item = find(dir, 'verified-note');
  assert.deepEqual(item.ask.slice(0, 2), ['accept', 'deny']);
  assert.equal(item.state, 'open');
  const saved = putAnswer({ ...where(dir), item: 'verified-note', patch: { rev: 0, decision: 'accept' } });
  assert.equal(saved.ok, true);
  assert.equal(find(dir, 'verified-note').state, 'accepted');
});

test('an info-only item is not open and does not count as open', (t) => {
  const dir = dataDir(t);
  publish(dir);
  const pack = getPack(where(dir));
  assert.notEqual(find(dir, 'result').state, 'open');
  assert.equal(pack.derived.counts.open, 4, 'the four decision items stay open');
  for (const id of ['verified-note', 'verified-default', 'verified-choice', 'decide']) assert.equal(find(dir, id).state, 'open');
});

test('submit lists no info-only item as open', (t) => {
  const dir = dataDir(t);
  publish(dir);
  const submitted = submitPack({ ...where(dir), verdict: 'accept' });
  const result = submitted.result;
  const entry = result.items.find((item) => item.id === 'result');
  assert.notEqual(entry.state, 'open');
  assert.equal(result.items.filter((item) => item.state === 'open').length, 4);
});

test('the answer bar of an agent-verified item with ask note only shows accept and deny', () => {
  const esc = (s) => String(s ?? '');
  const h = { esc, icon: () => '', avatar: () => '', projectLabel: (s) => s, time: () => '', menuButton: '', text: () => undefined };
  const item = { id: 'v', title: 'V', type: 'markdown', section: 's', verifiedBy: 'agent-verified', ask: ['note'], state: 'open', answer: null };
  const pack = { slug: 'shop', pack: 'rv1', state: 'open', version: 1, manifest: { sections: [{ id: 's', items: [{ id: 'v', type: 'markdown', ask: ['note'], verifiedBy: 'agent-verified' }] }] }, items: [item] };
  const html = answerBarHtml(pack, item, {}, h);
  assert.match(html, /data-rv-decision="accept"/);
  assert.match(html, /data-rv-decision="deny"/);
  const info = { ...item, verifiedBy: undefined };
  const bar = answerBarHtml({ ...pack, items: [info] }, info, {}, h);
  assert.doesNotMatch(bar, /data-rv-decision="accept"/);
});
