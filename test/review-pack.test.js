import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePack, itemHash } from '../src/review-pack.js';

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function tmp(prefix = 'herdr-review-pack-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A PNG header with the given size. The tests never need the image data.
function png(width, height, extra = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra)]);
}

function jpeg(width, height) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof]);
}

function gif(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6); buffer.writeUInt16LE(height, 8);
  return buffer;
}

function webp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1'); buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'latin1'); buffer.write('VP8X', 12, 'latin1'); buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3); buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function mp4(extra = 0) {
  const buffer = Buffer.alloc(32 + extra);
  buffer.writeUInt32BE(24, 0); buffer.write('ftypisom', 4, 'latin1');
  return buffer;
}

function webm() {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(16)]);
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makePack(files, manifest, options = {}) {
  const root = tmp();
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  const body = typeof manifest === 'string' ? manifest : JSON.stringify({ schema: 'herdr-boss.review-pack/1', id: 'checkout-redesign', title: 'Checkout flow redesign', ...manifest });
  if (manifest !== null) fs.writeFileSync(path.join(root, 'manifest.json'), body);
  return { root, result: () => validatePack(root, options) };
}

const oneItem = (item, files = {}, options = {}) => makePack(files, { sections: [{ id: 'cart', title: 'Cart', items: [{ id: 'one', title: 'One', ...item }] }] }, options);
const rules = (result) => result.errors.map((e) => e.rule);
const item = (result) => result.manifest.sections[0].items[0];

test('a valid pack returns a normalized manifest, file hashes, and totals', () => {
  const light = png(390, 800);
  const dark = png(390, 801);
  const { result } = makePack({ 'img/cart-light.png': light, 'img/cart-dark.png': dark, 'intro.md': '# Intro\n\nThe cart page.\n', 'data/errors.csv': 'code,text\n1,Card declined\n' }, {
    summary: 'intro.md',
    live: [{ label: 'Staging checkout', url: 'https://staging.example.test/checkout' }],
    sections: [{ id: 'cart', title: 'Cart', summary: 'The cart page in both themes.', items: [
      { id: 'cart-themes', title: 'Cart, light and dark', type: 'image-pair', variant: 'theme', a: { src: 'img/cart-light.png', label: 'Light' }, b: { src: 'img/cart-dark.png', label: 'Dark' } },
      { id: 'error-copy', title: 'Error messages', type: 'table', src: 'data/errors.csv', ask: ['accept', 'deny', 'note'] },
    ] }],
  });
  const out = result();
  assert.deepEqual(out.errors, []);
  assert.equal(out.ok, true);
  assert.equal(out.manifest.id, 'checkout-redesign');
  assert.deepEqual(out.manifest.sections[0].items[0].ask, ['accept', 'deny', 'note']);
  const file = out.files.find((f) => f.path === 'img/cart-light.png');
  assert.equal(file.sha256, crypto.createHash('sha256').update(light).digest('hex'));
  assert.equal(file.type, 'png');
  assert.equal(file.width, 390);
  assert.equal(file.height, 800);
  assert.equal(out.files.find((f) => f.path === 'data/errors.csv').type, 'text');
  assert.equal(out.totals.items, 2);
  assert.equal(out.totals.sections, 1);
  assert.equal(out.totals.files, 5);
  assert.ok(out.totals.bytes > out.files.reduce((sum, f) => sum + f.bytes, 0));
  assert.match(out.manifest.sections[0].items[0].hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(out.manifest.summary, { src: 'intro.md' });
});

test('review guidance fields validate, normalize, and enter the item content hash', () => {
  const build = ({ why = 'Why the result matters.', imageTag = 1 } = {}) => makePack({ 'img/proof.png': png(24, 36, imageTag) }, {
    designPass: { reviewer: 'gpt-6.1-sol', result: 'passed', note: 'The flow is clear.' },
    sections: [{ id: 'checkout', title: 'Checkout', items: [
      { id: 'scenario', title: 'Card flow', type: 'markdown', text: 'Review the card flow.',
        description: 'The card flow.\n' + why, steps: ['Open the test app.', 'Submit a valid card.'],
        expected: 'The receipt appears.', link: 'https://app.example.test/checkout',
        verifiedBy: 'agent-verified', evidence: ['img/proof.png'] },
      { id: 'proof', title: 'Receipt screenshot', type: 'image', src: 'img/proof.png',
        description: 'The receipt view.\nIt shows the saved result.', steps: ['Open the receipt.'],
        expected: 'The total is visible.', link: 'https://app.example.test/receipt', verifiedBy: 'needs-you' },
    ] }],
  });
  const first = build().result();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.warnings, []);
  assert.equal(item(first).description, 'The card flow.\nWhy the result matters.');
  assert.deepEqual(item(first).steps, ['Open the test app.', 'Submit a valid card.']);
  assert.equal(item(first).expected, 'The receipt appears.');
  assert.equal(item(first).link, 'https://app.example.test/checkout');
  assert.equal(item(first).verifiedBy, 'agent-verified');
  assert.deepEqual(item(first).evidence, ['img/proof.png']);
  assert.deepEqual(first.manifest.designPass, { reviewer: 'gpt-6.1-sol', result: 'passed', note: 'The flow is clear.' });

  const changedDescription = build({ why: 'Why the total matters.' }).result();
  const changedEvidenceBytes = build({ imageTag: 2 }).result();
  assert.notEqual(item(first).hash, item(changedDescription).hash);
  assert.notEqual(item(first).hash, item(changedEvidenceBytes).hash);
});

test('review guidance fields reject invalid values and evidence outside image items', () => {
  const result = makePack({ 'notes/readme.md': 'A text file.\n' }, {
    designPass: { reviewer: '', result: 'unknown', note: 3 },
    sections: [{ id: 'checkout', title: 'Checkout', items: [{
      id: 'scenario', title: 'Card flow', type: 'markdown', text: 'Review the card flow.',
      description: 'One line only.', steps: 'Open the app.', expected: 7, link: 'javascript:alert(1)',
      verifiedBy: 'human', evidence: ['notes/readme.md'],
    }] }],
  }).result();
  const messages = result.errors.map((entry) => entry.message).join('\n');
  for (const field of ['description', 'steps', 'expected', 'link', 'verifiedBy', 'evidence', 'designPass']) assert.ok(messages.includes(field), field + ' is reported');
});

test('descriptions trim one trailing newline and require exactly two lines', () => {
  const description = oneItem({
    type: 'markdown', text: 'Review the flow.', description: 'The checkout flow.\nIt shows the payment result.\n',
    steps: ['Open the test app.'], expected: 'The receipt appears.', link: 'https://app.example.test/checkout', verifiedBy: 'needs-you',
  }).result();
  assert.deepEqual(description.errors, []);
  assert.equal(item(description).description, 'The checkout flow.\nIt shows the payment result.');

  const badDescription = oneItem({ type: 'markdown', text: 'Review the flow.', description: 'One line.' }).result();
  assert.match(badDescription.errors.find((entry) => entry.rule === 'description').message, /description needs exactly two lines/i);
});

test('invalid steps are not normalized as undefined array entries', () => {
  const badSteps = oneItem({ type: 'markdown', text: 'Review the flow.', steps: ['Open the test app.', 3] }).result();
  assert.ok(badSteps.errors.some((entry) => entry.rule === 'field'));
  assert.equal(Object.hasOwn(item(badSteps), 'steps'), false);
});

test('the manifest must exist, parse, be an object, and use the schema', () => {
  assert.deepEqual(rules(makePack({}, null).result()), ['manifest-missing']);
  assert.deepEqual(rules(makePack({}, '{ nope').result()), ['manifest-json']);
  assert.deepEqual(rules(makePack({}, '[1]').result()), ['manifest-json']);
  assert.ok(rules(makePack({}, { schema: 'other/1', sections: [] }).result()).includes('schema'));
  const big = makePack({}, { sections: [{ id: 'a', title: 'A', items: [{ id: 'b', title: 'B', type: 'markdown', text: 'x' }] }] }, { limits: { manifestBytes: 50 } });
  assert.ok(rules(big.result()).includes('manifest-size'));
});

test('ids must be slugs and unique, and no item is named summary', () => {
  const bad = makePack({}, { id: 'Checkout Redesign', sections: [{ id: 'Cart!', title: 'Cart', items: [{ id: 'a b', title: 'A', type: 'markdown', text: 'x' }] }] }).result();
  assert.equal(rules(bad).filter((r) => r === 'id').length, 3);
  const duplicate = makePack({}, { sections: [
    { id: 'cart', title: 'Cart', items: [{ id: 'same', title: 'A', type: 'markdown', text: 'x' }] },
    { id: 'cart', title: 'Cart 2', items: [{ id: 'same', title: 'B', type: 'markdown', text: 'y' }] },
  ] }).result();
  assert.equal(rules(duplicate).filter((r) => r === 'duplicate-id').length, 2);
  assert.ok(rules(oneItem({ id: 'summary', type: 'markdown', text: 'x' }).result()).includes('id'));
  const long = oneItem({ id: 'a'.repeat(65), type: 'markdown', text: 'x' }).result();
  assert.ok(rules(long).includes('id'));
});

test('titles must have 1 to 200 characters', () => {
  assert.ok(rules(makePack({}, { title: '', sections: [] }).result()).includes('title'));
  assert.ok(rules(oneItem({ title: 'x'.repeat(201), type: 'markdown', text: 'x' }).result()).includes('title'));
  assert.deepEqual(rules(oneItem({ title: 'x'.repeat(200), type: 'markdown', text: 'x' }).result()), []);
});

test('the pack needs sections and items inside the count limits', () => {
  assert.ok(rules(makePack({}, { sections: [] }).result()).includes('count'));
  assert.ok(rules(makePack({}, { sections: [{ id: 'a', title: 'A', items: [] }] }).result()).includes('count'));
  const many = makePack({}, { sections: [{ id: 'a', title: 'A', items: [1, 2, 3].map((n) => ({ id: `i${n}`, title: `I${n}`, type: 'markdown', text: 'x' })) }] }, { limits: { itemsPerSection: 2 } });
  assert.ok(rules(many.result()).includes('count'));
  const total = makePack({}, { sections: [{ id: 'a', title: 'A', items: [1, 2, 3].map((n) => ({ id: `i${n}`, title: `I${n}`, type: 'markdown', text: 'x' })) }] }, { limits: { items: 2 } });
  assert.ok(rules(total.result()).includes('count'));
  const sections = makePack({}, { sections: [1, 2, 3].map((n) => ({ id: `s${n}`, title: `S${n}`, items: [{ id: `i${n}`, title: 'I', type: 'markdown', text: 'x' }] })) }, { limits: { sections: 2 } });
  assert.ok(rules(sections.result()).includes('count'));
});

test('each item type needs its fields', () => {
  const img = { 'a.png': png(10, 10), 'b.png': png(10, 10) };
  assert.ok(rules(oneItem({ type: 'image' }).result()).includes('field'));
  assert.deepEqual(rules(oneItem({ type: 'image', src: 'a.png', alt: 'Cart' }, img).result()), []);
  assert.ok(rules(oneItem({ type: 'image-pair', a: { src: 'a.png' } }, img).result()).includes('field'));
  assert.deepEqual(rules(oneItem({ type: 'image-pair', variant: 'before-after', a: { src: 'a.png', label: 'Before' }, b: { src: 'b.png', label: 'After' } }, img).result()), []);
  assert.ok(rules(oneItem({ type: 'image-pair', variant: 'sideways', a: { src: 'a.png' }, b: { src: 'b.png' } }, img).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'gallery', images: [{ src: 'a.png' }] }, img).result()).includes('field'));
  assert.deepEqual(rules(oneItem({ type: 'gallery', images: [{ src: 'a.png', caption: 'One' }, { src: 'b.png' }] }, img).result()), []);
  assert.ok(rules(oneItem({ type: 'video' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'markdown' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'table' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'diff' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'file' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'link' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'checklist', entries: [] }).result()).includes('field'));
  assert.deepEqual(rules(oneItem({ type: 'checklist', entries: [{ id: 'focus', text: 'Focus order follows the form' }] }).result()), []);
  assert.ok(rules(oneItem({ type: 'checklist', entries: [{ id: 'focus', text: 'A' }, { id: 'focus', text: 'B' }] }).result()).includes('duplicate-id'));
  assert.deepEqual(rules(oneItem({ type: 'table', columns: ['Code', 'Text'], rows: [['1', 'Card declined']] }).result()), []);
  assert.ok(rules(oneItem({ type: 'table', columns: ['Code'], rows: [['1', '2']] }).result()).includes('field'));
});

test('an unknown type falls back to markdown with a warning', () => {
  const out = oneItem({ type: 'heatmap', body: 'The **heat** map is in the tool.' }).result();
  assert.equal(out.ok, true);
  assert.equal(item(out).type, 'markdown');
  assert.equal(item(out).fallbackFrom, 'heatmap');
  assert.deepEqual(item(out).body, { text: 'The **heat** map is in the tool.' });
  assert.ok(out.warnings.some((w) => w.rule === 'unknown-type'));
});

test('a custom type needs a renderer slug and falls back to markdown', () => {
  const out = oneItem({ type: 'custom', renderer: 'flame-graph', body: 'Fallback text.' }).result();
  assert.equal(out.ok, true);
  assert.equal(item(out).type, 'markdown');
  assert.equal(item(out).fallbackFrom, 'custom:flame-graph');
  assert.ok(rules(oneItem({ type: 'custom', body: 'x' }).result()).includes('field'));
  assert.ok(rules(oneItem({ type: 'custom', renderer: 'Not A Slug', body: 'x' }).result()).includes('field'));
});

test('ask defaults to accept, deny, and note', () => {
  assert.deepEqual(item(oneItem({ type: 'markdown', text: 'x' }).result()).ask, ['accept', 'deny', 'note']);
  assert.deepEqual(item(oneItem({ type: 'markdown', text: 'x', ask: ['note', 'live'] }).result()).ask, ['note', 'live']);
});

test('ask accepts only the six values, each once, and not an empty list', () => {
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['accept', 'maybe'] }).result()).includes('ask'));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['accept', 'accept'] }).result()).includes('ask'));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: [] }).result()).includes('ask'));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: 'accept' }).result()).includes('ask'));
});

test('choice needs 2 to 6 choices and rating defaults to a maximum of 5', () => {
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['choice'] }).result()).includes('choices'));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['choice'], choices: [{ id: 'a', label: 'A' }] }).result()).includes('choices'));
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `c${n}`, label: `C${n}` }));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['choice'], choices: seven }).result()).includes('choices'));
  const dup = oneItem({ type: 'markdown', text: 'x', ask: ['choice'], choices: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).result();
  assert.ok(rules(dup).includes('duplicate-id'));
  const ok = oneItem({ type: 'markdown', text: 'x', ask: ['choice', 'note'], choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after' }] }).result();
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(item(ok).choices, [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after' }]);
  assert.deepEqual(item(oneItem({ type: 'markdown', text: 'x', ask: ['rating'] }).result()).rating, { max: 5 });
  assert.deepEqual(item(oneItem({ type: 'markdown', text: 'x', ask: ['rating'], rating: { max: 10 } }).result()).rating, { max: 10 });
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['rating'], rating: { max: 2 } }).result()).includes('rating'));
  assert.ok(rules(oneItem({ type: 'markdown', text: 'x', ask: ['rating'], rating: { max: 11 } }).result()).includes('rating'));
});

test('paths with .., an absolute path, a backslash, a NUL, or a hidden part are refused', () => {
  for (const src of ['../outside.png', 'img/../../outside.png', '/etc/passwd', 'img\\a.png', 'img/a\0.png', '.secret/a.png', 'img/.hidden.png', '']) {
    const out = oneItem({ type: 'image', src }, { 'img/a.png': png(10, 10) }).result();
    assert.equal(out.ok, false, `path ${JSON.stringify(src)} passed`);
    assert.ok(rules(out).includes('path'), `path ${JSON.stringify(src)} gave ${rules(out)}`);
  }
});

test('a symbolic link that leaves the folder is refused, one that stays is allowed', () => {
  const outside = tmp('herdr-review-outside-');
  fs.writeFileSync(path.join(outside, 'leak.png'), png(10, 10));
  const pack = oneItem({ type: 'image', src: 'img/leak.png' }, { 'img/real.png': png(10, 10) });
  fs.symlinkSync(path.join(outside, 'leak.png'), path.join(pack.root, 'img/leak.png'));
  const out = pack.result();
  assert.equal(out.ok, false);
  assert.ok(rules(out).includes('path'));
  const inside = oneItem({ type: 'image', src: 'img/alias.png' }, { 'img/real.png': png(10, 10) });
  fs.symlinkSync(path.join(inside.root, 'img/real.png'), path.join(inside.root, 'img/alias.png'));
  assert.equal(inside.result().ok, true);
  const dirLink = oneItem({ type: 'image', src: 'linked/leak.png' });
  fs.symlinkSync(outside, path.join(dirLink.root, 'linked'));
  assert.ok(rules(dirLink.result()).includes('path'));
});

test('a missing file, a folder, and an unreadable file are errors', () => {
  assert.ok(rules(oneItem({ type: 'image', src: 'nope.png' }).result()).includes('file-missing'));
  const dir = oneItem({ type: 'image', src: 'img' }, { 'img/a.png': png(10, 10) });
  assert.ok(rules(dir.result()).includes('file-missing'));
  if (process.getuid?.() === 0) return;
  const locked = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': png(10, 10) });
  fs.chmodSync(path.join(locked.root, 'a.png'), 0o000);
  try { assert.ok(rules(locked.result()).includes('file-unreadable')); } finally { fs.chmodSync(path.join(locked.root, 'a.png'), 0o600); }
});

test('an SVG is refused, also under a png name', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>';
  assert.ok(rules(oneItem({ type: 'image', src: 'a.svg' }, { 'a.svg': svg }).result()).includes('svg'));
  const disguised = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': `<?xml version="1.0"?>\n${svg}` }).result();
  assert.ok(rules(disguised).includes('svg'));
});

test('HTML is refused outside a page item', () => {
  const html = '<!doctype html><html><body>Hi</body></html>';
  assert.ok(rules(oneItem({ type: 'file', src: 'a.html' }, { 'a.html': html }).result()).includes('html'));
  assert.ok(rules(oneItem({ type: 'page', src: 'a.html' }, { 'a.html': html }).result()).includes('type'));
  const page = oneItem({ type: 'page', src: 'a.html' }, { 'a.html': html }, { allowPage: true }).result();
  assert.deepEqual(page.errors, []);
  assert.equal(item(page).type, 'page');
});

test('the type comes from the magic bytes, not the extension', () => {
  const text = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': 'this is not a png\n' }).result();
  assert.ok(rules(text).includes('content-type'));
  const swapped = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': jpeg(10, 10) }).result();
  assert.ok(rules(swapped).includes('content-type'));
  const binary = oneItem({ type: 'file', src: 'a.txt' }, { 'a.txt': png(10, 10) }).result();
  assert.ok(rules(binary).includes('content-type'));
  const exe = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]) }).result();
  assert.ok(rules(exe).includes('content-type'));
  const jpg = oneItem({ type: 'image', src: 'photo.bin' }, { 'photo.bin': jpeg(20, 30) }).result();
  assert.deepEqual(jpg.errors, []);
  assert.equal(jpg.files[0].type, 'jpeg');
  assert.deepEqual([jpg.files[0].width, jpg.files[0].height], [20, 30]);
});

test('the image formats read their size from the header', () => {
  const cases = { 'a.gif': gif(12, 34), 'a.webp': webp(56, 78), 'a.jpg': jpeg(90, 12) };
  const expected = { 'a.gif': [12, 34], 'a.webp': [56, 78], 'a.jpg': [90, 12] };
  for (const [name, bytes] of Object.entries(cases)) {
    const out = oneItem({ type: 'image', src: name }, { [name]: bytes }).result();
    assert.deepEqual(out.errors, [], name);
    assert.deepEqual([out.files[0].width, out.files[0].height], expected[name], name);
  }
});

test('an image over 40 megapixels or 16,384 px on a side is refused from the header', () => {
  const fifty = oneItem({ type: 'image', src: 'big.png' }, { 'big.png': png(8000, 6250) }).result();
  assert.equal(fifty.ok, false);
  assert.ok(rules(fifty).includes('image-size'));
  assert.ok(rules(oneItem({ type: 'image', src: 'wide.png' }, { 'wide.png': png(20000, 10) }).result()).includes('image-size'));
  assert.deepEqual(rules(oneItem({ type: 'image', src: 'ok.png' }, { 'ok.png': png(8000, 5000) }).result()), []);
  assert.ok(rules(oneItem({ type: 'image', src: 'trunc.png' }, { 'trunc.png': png(10, 10).subarray(0, 12) }).result()).includes('image-size'));
});

test('video accepts MP4 and WebM, refuses other content, and has a size limit', () => {
  assert.deepEqual(oneItem({ type: 'video', src: 'media/checkout.mp4', poster: 'poster.png' }, { 'media/checkout.mp4': mp4(), 'poster.png': png(10, 10) }).result().errors, []);
  const webmOut = oneItem({ type: 'video', src: 'media/checkout.webm' }, { 'media/checkout.webm': webm() }).result();
  assert.deepEqual(webmOut.errors, []);
  assert.equal(webmOut.files[0].type, 'webm');
  assert.ok(rules(oneItem({ type: 'video', src: 'media/a.mp4' }, { 'media/a.mp4': 'plain text' }).result()).includes('content-type'));
  assert.ok(rules(oneItem({ type: 'video', src: 'a.mp4' }, { 'a.mp4': png(10, 10) }).result()).includes('content-type'));
  const big = oneItem({ type: 'video', src: 'a.mp4' }, { 'a.mp4': mp4(4000) }, { limits: { fileBytes: 1000 } }).result();
  assert.ok(rules(big).includes('file-size'));
});

test('the size, count, and depth limits hold', () => {
  const two = { 'a.png': png(10, 10, 500), 'b.png': png(10, 10, 500) };
  const pair = { type: 'image-pair', a: { src: 'a.png' }, b: { src: 'b.png' } };
  assert.ok(rules(oneItem(pair, two, { limits: { totalBytes: 1000 } }).result()).includes('total-size'));
  assert.ok(rules(oneItem(pair, two, { limits: { fileBytes: 300 } }).result()).includes('file-size'));
  assert.ok(rules(oneItem(pair, two, { limits: { files: 2 } }).result()).includes('file-count'));
  const deep = oneItem({ type: 'image', src: 'a/b/c/d.png' }, { 'a/b/c/d.png': png(10, 10) }, { limits: { depth: 2 } }).result();
  assert.ok(rules(deep).includes('depth'));
  assert.deepEqual(rules(oneItem({ type: 'image', src: 'a/b/c/d.png' }, { 'a/b/c/d.png': png(10, 10) }, { limits: { depth: 3 } }).result()), []);
  const text = oneItem({ type: 'file', src: 'a.txt' }, { 'a.txt': 'x'.repeat(200) }, { limits: { textBytes: 100 } }).result();
  assert.ok(rules(text).includes('text-size'));
  const md = oneItem({ type: 'markdown', text: 'x'.repeat(300) }, {}, { limits: { markdownBytes: 100 } }).result();
  assert.ok(rules(md).includes('text-size'));
});

test('the default limits are the documented values', () => {
  const out = oneItem({ type: 'markdown', text: 'x' }).result();
  assert.deepEqual(out.limits, {
    totalBytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, files: 1000, textBytes: 2 * 1024 * 1024, markdownBytes: 200 * 1024,
    manifestBytes: 1024 * 1024, sections: 40, items: 400, itemsPerSection: 100, depth: 8, megapixels: 40, side: 16384,
  });
});

test('a secret in a markdown file is refused with the file and the class, not the value', () => {
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('');
  const out = oneItem({ type: 'markdown', body: 'notes.md' }, { 'notes.md': `# Notes\n\nUse ${token} to log in.\n` }).result();
  assert.equal(out.ok, false);
  const finding = out.errors.find((e) => e.rule === 'secret');
  assert.equal(finding.file, 'notes.md');
  assert.match(finding.message, /GitHub token/);
  assert.ok(!JSON.stringify(out).includes(token));
});

test('a secret in a manifest string or in a table file is refused', () => {
  const key = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
  const inManifest = oneItem({ type: 'markdown', text: `Key ${key}` }).result();
  const finding = inManifest.errors.find((e) => e.rule === 'secret');
  assert.equal(finding.file, 'manifest.json');
  assert.match(finding.message, /AWS access key/);
  assert.ok(!JSON.stringify(inManifest).includes(key));
  assert.equal(inManifest.manifest, null);
  const inCsv = oneItem({ type: 'table', src: 'a.csv' }, { 'a.csv': `name,value\napi_key=${'x'.repeat(24)}\n` }).result();
  assert.ok(inCsv.errors.some((e) => e.rule === 'secret' && e.file === 'a.csv'));
});

test('a file with an .env name is refused even when the manifest names it', () => {
  const out = oneItem({ type: 'file', src: 'config/.env' }, { 'config/.env': 'A=1\n' }).result();
  assert.ok(rules(out).includes('path'));
  const loose = oneItem({ type: 'markdown', text: 'x' }, { '.env.local': 'A=1\n' }).result();
  assert.ok(loose.errors.some((e) => e.rule === 'secret' && e.file === '.env.local'));
});

test('markdown refuses script constructs and unsafe links, and warns about raw HTML and images', () => {
  assert.ok(rules(oneItem({ type: 'markdown', text: 'Hi <script>alert(1)</script>' }).result()).includes('markdown'));
  assert.ok(rules(oneItem({ type: 'markdown', text: '<iframe src="https://example.test"></iframe>' }).result()).includes('markdown'));
  assert.ok(rules(oneItem({ type: 'markdown', text: '[go](javascript:alert(1))' }).result()).includes('markdown'));
  assert.ok(rules(oneItem({ type: 'markdown', text: '<a href="x" onclick="y()">z</a>' }).result()).includes('markdown'));
  const warned = oneItem({ type: 'markdown', text: 'A <b>bold</b> word and ![shot](img/a.png).' }).result();
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings.filter((w) => w.rule === 'markdown').length, 2);
  const code = oneItem({ type: 'markdown', text: 'Use `<script>` like this:\n\n```html\n<script>x()</script>\n```\n\n[docs](https://example.test/api)' }).result();
  assert.deepEqual(code.errors, []);
  assert.deepEqual(code.warnings.filter((w) => w.rule === 'markdown'), []);
});

test('URLs must pass safeUrl and use https, or http for loopback and .test hosts', () => {
  assert.deepEqual(rules(oneItem({ type: 'link', url: 'https://staging.example.test/checkout', label: 'Staging' }).result()), []);
  assert.deepEqual(rules(oneItem({ type: 'link', url: 'http://localhost:3000/', label: 'Local' }).result()), []);
  assert.deepEqual(rules(oneItem({ type: 'link', url: 'http://127.0.0.1:3000/', label: 'Local' }).result()), []);
  assert.deepEqual(rules(oneItem({ type: 'link', url: 'http://shop.test/', label: 'Test' }).result()), []);
  for (const url of ['http://example.com/', 'javascript:alert(1)', 'mailto:a@example.test', '/local/path', 'ftp://example.test/']) {
    assert.ok(rules(oneItem({ type: 'link', url, label: 'X' }).result()).includes('url'), url);
  }
  const live = makePack({}, { live: [{ label: 'Bad', url: 'http://example.com' }], sections: [{ id: 'a', title: 'A', items: [{ id: 'b', title: 'B', type: 'markdown', text: 'x', ask: ['live'], liveUrl: 'javascript:1' }] }] }).result();
  assert.equal(rules(live).filter((r) => r === 'url').length, 2);
});

test('a file that the manifest does not name is a warning', () => {
  const out = oneItem({ type: 'markdown', text: 'x' }, { 'extra/notes.md': 'unused', '.DS_Store': 'junk' }).result();
  assert.equal(out.ok, true);
  assert.deepEqual(out.warnings.filter((w) => w.rule === 'unreferenced').map((w) => w.file).sort(), ['.DS_Store', 'extra/notes.md']);
  assert.ok(!out.files.some((f) => f.path === 'extra/notes.md'));
});

test('a markdown body can be a .md file or inline text', () => {
  const file = oneItem({ type: 'image', src: 'a.png', body: 'notes/a.md' }, { 'a.png': png(10, 10), 'notes/a.md': 'The **header** moved.' }).result();
  assert.deepEqual(file.errors, []);
  assert.deepEqual(item(file).body, { src: 'notes/a.md' });
  const inline = oneItem({ type: 'image', src: 'a.png', body: 'The header moved.\n\nSee below.' }, { 'a.png': png(10, 10) }).result();
  assert.deepEqual(item(inline).body, { text: 'The header moved.\n\nSee below.' });
  const missing = oneItem({ type: 'image', src: 'a.png', body: 'notes/none.md' }, { 'a.png': png(10, 10) }).result();
  assert.ok(rules(missing).includes('file-missing'));
});

test('the item hash is stable across key order and ignores the id', () => {
  const a = { id: 'one', title: 'Cart', type: 'image', src: 'a.png', alt: 'Cart', ask: ['accept', 'deny', 'note'] };
  const b = { ask: ['accept', 'deny', 'note'], alt: 'Cart', src: 'a.png', type: 'image', title: 'Cart', id: 'two' };
  const hashes = new Map([['a.png', 'aa']]);
  assert.equal(itemHash(a, hashes), itemHash(b, hashes));
  assert.notEqual(itemHash(a, hashes), itemHash({ ...a, title: 'Cart page' }, hashes));
  assert.notEqual(itemHash(a, hashes), itemHash(a, new Map([['a.png', 'bb']])));
});

test('the item hash in the result follows key order, file bytes, and fields', () => {
  const files = { 'a.png': png(10, 10) };
  const one = oneItem({ type: 'image', src: 'a.png', alt: 'Cart' }, files).result();
  const reordered = makePack(files, { sections: [{ items: [{ alt: 'Cart', src: 'a.png', type: 'image', title: 'One', id: 'one' }], title: 'Cart', id: 'cart' }], title: 'Checkout flow redesign', id: 'checkout-redesign', schema: 'herdr-boss.review-pack/1' }).result();
  assert.equal(item(one).hash, item(reordered).hash);
  const changedBytes = oneItem({ type: 'image', src: 'a.png', alt: 'Cart' }, { 'a.png': png(10, 11) }).result();
  assert.notEqual(item(one).hash, item(changedBytes).hash);
  const changedField = oneItem({ type: 'image', src: 'a.png', alt: 'Cart page' }, files).result();
  assert.notEqual(item(one).hash, item(changedField).hash);
  const other = makePack(files, { sections: [{ id: 'cart', title: 'Cart', items: [{ id: 'renamed', title: 'One', type: 'image', src: 'a.png', alt: 'Cart' }] }] }).result();
  assert.equal(item(one).hash, other.manifest.sections[0].items[0].hash);
  const again = oneItem({ type: 'image', src: 'a.png', alt: 'Cart' }, files).result();
  assert.equal(item(one).hash, item(again).hash);
});

test('the result lists all errors at once and reports which items use a file', () => {
  const out = makePack({ 'a.png': png(10, 10) }, { sections: [{ id: 'cart', title: 'Cart', items: [
    { id: 'one', title: 'One', type: 'image', src: 'a.png' },
    { id: 'two', title: 'Two', type: 'image', src: '../x.png' },
    { id: 'three', title: 'Three', type: 'image' },
    { id: 'four', title: 'Four', type: 'video', src: 'none.mp4' },
  ] }] }).result();
  assert.equal(out.ok, false);
  assert.ok(out.errors.length >= 3);
  assert.deepEqual(out.files.find((f) => f.path === 'a.png').items, ['one']);
});

test('the validator writes nothing in the folder and reads nothing outside it', () => {
  const pack = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': png(10, 10) });
  const before = fs.readdirSync(pack.root).sort();
  pack.result();
  assert.deepEqual(fs.readdirSync(pack.root).sort(), before);
});

// ---------- Review fixes ----------

function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

test('hostile Markdown of 200 KB is scanned in under one second', () => {
  const size = 200 * 1024;
  const inputs = {
    'open tags': '<a '.repeat(Math.floor(size / 3)),
    'open brackets': '['.repeat(size),
    'image openers': '!['.repeat(size / 2),
    'link openers': '](' .repeat(size / 2),
    'bracket pairs': '[a](b'.repeat(size / 5),
    'backticks': '`'.repeat(size),
    'single backtick lines': '`a\n'.repeat(size / 3),
    'fences': '```a '.repeat(size / 5),
    'tildes': '~'.repeat(size),
    'angle brackets': '<'.repeat(size),
    'closed tags': '<b>'.repeat(size / 3),
    'event attributes': '<a onx'.repeat(size / 6),
    'entities': '](&#x41;&amp;'.repeat(size / 13),
    'long url': `[a](${'x'.repeat(size)})`,
    'comments': '<!--'.repeat(size / 4),
  };
  for (const [name, text] of Object.entries(inputs)) {
    const { value, ms } = timed(() => oneItem({ type: 'markdown', text: text.slice(0, size) }).result());
    assert.ok(ms < 1000, `${name} took ${ms} ms`);
    assert.ok(value.errors.every((e) => e.rule !== 'crash'), name);
  }
});

test('hostile text files are checked in under one second', () => {
  const files = {
    'a.md': '<a '.repeat(600_000),
    'b.txt': '<!--'.repeat(500_000),
    'c.csv': 'password' + '-'.repeat(1_000_000),
  };
  const pack = makePack(files, { sections: [{ id: 'cart', title: 'Cart', items: [
    { id: 'one', title: 'One', type: 'markdown', body: 'a.md' },
    { id: 'two', title: 'Two', type: 'file', src: 'b.txt' },
    { id: 'three', title: 'Three', type: 'table', src: 'c.csv' },
  ] }] });
  const { ms } = timed(() => pack.result());
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('an SVG behind many comments is found without a slow scan', () => {
  const svg = `${'<!-- a -->'.repeat(30)}<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
  const { value, ms } = timed(() => oneItem({ type: 'image', src: 'a.png' }, { 'a.png': svg }).result());
  assert.ok(rules(value).includes('svg'));
  assert.ok(ms < 1000);
});

// Count the content reads of the validator. It reads a file with readSync on a descriptor.
function countReads(fn) {
  const original = fs.readSync;
  let calls = 0;
  fs.readSync = (...args) => { calls += 1; return original(...args); };
  try { return { value: fn(), calls }; } finally { fs.readSync = original; }
}

test('a manifest that names too many files fails on the count before any file is read', () => {
  const images = Array.from({ length: 60 }, (_, n) => ({ src: `img/missing-${n}.png` }));
  const items = Array.from({ length: 30 }, (_, n) => ({ id: `g${n}`, title: `Gallery ${n}`, type: 'gallery', images: images.map((image) => ({ src: image.src.replace('missing-', `missing-${n}-`) })) }));
  const pack = makePack({}, { sections: [{ id: 'cart', title: 'Cart', items }] });
  const { value, calls } = countReads(() => pack.result());
  assert.equal(value.ok, false);
  assert.ok(rules(value).includes('file-count') || rules(value).includes('too-many-errors'));
  assert.equal(calls, 1, 'only the manifest is read');
  assert.equal(value.manifest, null);
  assert.ok(value.errors.length <= 201);
  assert.ok(value.errors.filter((e) => e.rule === 'file-missing').length <= 1000);
});

test('the count limit stops the validation at the first breach, with the file limit lowered', () => {
  const images = [1, 2, 3, 4, 5].map((n) => ({ src: `missing-${n}.png` }));
  const pack = oneItem({ type: 'gallery', images }, {}, { limits: { files: 3 } });
  const { value } = countReads(() => pack.result());
  assert.equal(rules(value).filter((r) => r === 'file-count').length, 1);
  assert.equal(value.errors.filter((e) => e.rule === 'file-missing').length, 2);
});

test('a file above the size limit is refused from its size, without a read', () => {
  const pack = oneItem({ type: 'video', src: 'huge.mp4' }, { 'huge.mp4': mp4() });
  const file = path.join(pack.root, 'huge.mp4');
  fs.truncateSync(file, 100 * 1024 * 1024 * 1024);
  const { value, calls } = countReads(() => pack.result());
  assert.ok(rules(value).includes('file-size'));
  assert.equal(calls, 1, 'only the manifest is read');
});

test('a text file above the text limit is refused without a read', () => {
  const pack = oneItem({ type: 'file', src: 'big.txt' }, { 'big.txt': 'x'.repeat(500) }, { limits: { textBytes: 100 } });
  const { value, calls } = countReads(() => pack.result());
  assert.ok(rules(value).includes('text-size'));
  assert.equal(calls, 1);
});

test('the total size limit stops the validation before the next file is read', () => {
  const files = { 'a.png': png(10, 10, 700), 'b.png': png(10, 10, 700), 'c.png': png(10, 10, 700) };
  const pack = oneItem({ type: 'gallery', images: [{ src: 'a.png' }, { src: 'b.png' }, { src: 'c.png' }] }, files, { limits: { totalBytes: 1600 } });
  const { value, calls } = countReads(() => pack.result());
  assert.equal(rules(value).filter((r) => r === 'total-size').length, 1);
  assert.equal(calls, 2, 'the manifest and the first file only');
});

test('the item counts are checked before an item is visited', () => {
  const items = Array.from({ length: 3 }, (_, n) => ({ id: `i${n}`, title: 'I', type: 'image', src: `missing-${n}.png` }));
  const pack = makePack({}, { sections: [{ id: 'cart', title: 'Cart', items }] }, { limits: { itemsPerSection: 2 } });
  const { value } = countReads(() => pack.result());
  assert.deepEqual(rules(value), ['count']);
});

test('the error list stops at 200 errors and the validation halts', () => {
  const items = Array.from({ length: 300 }, (_, n) => ({ id: `i${n}`, title: 'I', type: 'image', src: `missing-${n}.png` }));
  const out = makePack({}, { sections: [{ id: 'a', title: 'A', items: items.slice(0, 100) }, { id: 'b', title: 'B', items: items.slice(100, 200) }, { id: 'c', title: 'C', items: items.slice(200) }] }).result();
  assert.equal(out.errors.length, 201);
  assert.equal(out.errors.at(-1).rule, 'too-many-errors');
  assert.equal(out.manifest, null);
});

test('a file that vanishes or fails to open gives a validation error, not a throw', () => {
  const pack = oneItem({ type: 'image', src: 'a.png' }, { 'a.png': png(10, 10) });
  const original = fs.fstatSync;
  fs.fstatSync = (fd, ...rest) => { if (fs.fstatSync.calls++ >= 1) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return original(fd, ...rest); };
  fs.fstatSync.calls = 0;
  try {
    const out = pack.result();
    assert.ok(rules(out).includes('file-unreadable'));
  } finally { fs.fstatSync = original; }
});

test('a file named twice counts once and is read and hashed once', () => {
  const bytes = png(10, 10, 100);
  const pack = makePack({ 'a.png': bytes }, { sections: [{ id: 'cart', title: 'Cart', items: [
    { id: 'one', title: 'One', type: 'image', src: 'a.png' },
    { id: 'two', title: 'One', type: 'image', src: 'a.png' },
  ] }] });
  const { value, calls } = countReads(() => pack.result());
  assert.deepEqual(value.errors, []);
  assert.equal(value.files.length, 1);
  assert.deepEqual(value.files[0].items, ['one', 'two']);
  assert.equal(value.totals.files, 2);
  assert.equal(value.totals.bytes, bytes.length + fs.statSync(path.join(pack.root, 'manifest.json')).size);
  assert.equal(calls, 2, 'the manifest and the image, once each');
  const [one, two] = value.manifest.sections[0].items;
  assert.equal(one.hash, two.hash);
});

test('link items and items with a live URL are marked external', () => {
  const link = oneItem({ type: 'link', url: 'https://staging.example.test/checkout', label: 'Staging' }).result();
  assert.equal(item(link).external, true);
  const live = oneItem({ type: 'markdown', text: 'x', ask: ['live'], liveUrl: 'https://staging.example.test/' }).result();
  assert.equal(item(live).external, true);
  assert.equal(item(oneItem({ type: 'markdown', text: 'x' }).result()).external, undefined);
});

test('live URLs refuse data:, javascript:, and a user name or password', () => {
  for (const url of ['data:text/html,<b>x</b>', 'javascript:alert(1)', 'https://user:pw@staging.example.test/', 'https://user@staging.example.test/', 'http://[::2]/', 'https://']) {
    assert.ok(rules(oneItem({ type: 'link', url, label: 'X' }).result()).includes('url'), url);
  }
  assert.deepEqual(rules(oneItem({ type: 'link', url: 'http://[::1]:3000/', label: 'X' }).result()), []);
});
