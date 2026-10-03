// RV1d: a file name used as a title or as inline text, and an accept question with no deny.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePack } from '../src/review-pack.js';

const { effectiveAsk, isInfoOnly } = await import('../public/review-ask.js');
const { answerBarHtml } = await import('../public/review-viewer.js');

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function validate(items, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-rv1d-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 'herdr-boss.review-pack/1', id: 'rv1d', title: 'RV1d', sections: [{ id: 's', title: 'S', items }] }));
  return validatePack(root, {});
}
const md = (id, over = {}) => ({ id, title: `Title ${id}`, type: 'markdown', text: 'Some text.', ...over });
const warned = (result, rule, id) => result.warnings.some((w) => w.rule === rule && w.message.includes(id));

test('a title that is a file name or a path gets a warning, not an error', () => {
  for (const [id, title] of [['t-md', 'limits.md'], ['t-html', 'report.html'], ['t-json', 'data.json'], ['t-png', 'shot.png'], ['t-path', 'docs/limits/list']]) {
    const result = validate([md(id, { title })]);
    assert.deepEqual(result.errors, [], title);
    assert.ok(warned(result, 'title', id), `warn for ${title}`);
  }
});

test('a title that equals the file field gets a warning, and a plain title gets none', () => {
  const same = validate([{ id: 'f1', title: 'src/limits.txt', type: 'file', src: 'src/limits.txt' }], {});
  assert.ok(warned(same, 'title', 'f1'));
  const plain = validate([md('p1', { title: 'Dropped items, 3 of 40' }), md('p2', { title: 'Version 2.1 notes' })]);
  assert.equal(plain.warnings.some((w) => w.rule === 'title'), false);
});

test('a markdown item whose text is a .md path reads the file', () => {
  const result = validate([{ id: 'm1', title: 'Limits', type: 'markdown', text: 'limits.md' }], { 'limits.md': '# Limits\n\nThe limits.\n' });
  assert.deepEqual(result.errors, []);
  const spec = result.manifest.sections[0].items[0];
  assert.equal(spec.text, undefined);
  assert.deepEqual(spec.body, { src: 'limits.md' });
  assert.ok(result.files.some((f) => f.path === 'limits.md'));
});

test('a markdown text .md path with no file is an error', () => {
  const result = validate([{ id: 'm2', title: 'Limits', type: 'markdown', text: 'missing.md' }]);
  assert.ok(result.errors.some((e) => e.rule === 'file-missing'));
});

test('description, expected, and a step that are only a file name get a warning', () => {
  const result = validate([md('d1', { description: 'limits.md\nwhy.md', expected: 'expected.md', steps: ['steps.txt'] })]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.filter((w) => w.rule === 'file-name-text' && w.message.includes('d1')).length, 3);
});

test('a body that is a file name with another extension gets a warning', () => {
  const result = validate([{ id: 'b1', title: 'Limits', type: 'image', src: 'x.png', body: 'limits.txt' }], {});
  assert.ok(result.warnings.some((w) => w.rule === 'file-name-text' && w.message.includes('b1')));
});

test('effectiveAsk adds deny to an accept question for every item', () => {
  assert.deepEqual(effectiveAsk({ verifiedBy: 'needs-you', ask: ['accept', 'note'] }), ['accept', 'deny', 'note']);
  assert.deepEqual(effectiveAsk({ ask: ['accept'] }), ['accept', 'deny']);
  assert.deepEqual(effectiveAsk({ ask: ['note', 'deny'] }), ['accept', 'deny', 'note']);
  assert.deepEqual(effectiveAsk({ verifiedBy: 'needs-you', ask: ['choice', 'note'] }), ['choice', 'note']);
  assert.deepEqual(effectiveAsk({ ask: ['accept', 'deny', 'note'] }), ['accept', 'deny', 'note']);
  assert.equal(isInfoOnly({ ask: ['accept'] }), false);
});

test('the validator adds deny to a needs-you item with accept only and warns', () => {
  const result = validate([md('a1', { verifiedBy: 'needs-you', ask: ['accept', 'note'] })]);
  assert.deepEqual(result.manifest.sections[0].items[0].ask, ['accept', 'deny', 'note']);
  assert.ok(warned(result, 'ask', 'a1'));
});

test('the viewer shows Deny for a stored item with accept and no deny', () => {
  const item = { id: 'a1', title: 'A', type: 'markdown', ask: ['accept', 'note'], state: 'open', answer: null };
  const pack = { slug: 's', pack: 'p', version: 1, state: 'open', manifest: { sections: [{ id: 's', items: [{ id: 'a1', type: 'markdown', text: 'x' }] }] }, items: [item], derived: { sections: [], counts: {} } };
  const esc = (s) => String(s ?? '');
  const html = answerBarHtml(pack, item, {}, { esc, icon: () => '', text: () => undefined });
  assert.match(html, /Deny/);
});
