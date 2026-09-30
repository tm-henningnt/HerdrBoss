import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildImport, safeText } from '../src/review-import.js';

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function source(html, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-import-test-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'index.html'), html);
  for (const [rel, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const SIZE = 200 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length));

// Hostile pages of about 200 KB. Each import must finish in under one second.
const HOSTILE = {
  'open a tags': fill('<a '),
  'open img tags with a source': fill('<img src=x '),
  'open title tags': fill('<title>'),
  'open style tags': fill('<style>'),
  'less-than characters': fill('<'),
  'unterminated quotes': fill('<img alt="'),
  'unterminated url()': `<style>${fill('url("')}`,
  'unterminated url in a style attribute': fill('<a style="background:url(\''),
  'open comments': fill('<!--'),
  'open h1 tags': fill('<h1>'),
  'many links': fill('<a href="p.html">'),
  'many images': fill('<img src="i.png">'),
  'many closing tags': fill('</a>'),
  'open script tags': fill('<script>'),
  'ampersands in a title': `<title>${fill('&amp;<')}</title>`,
};

for (const [name, html] of Object.entries(HOSTILE)) {
  test(`the importer reads a 200 KB page of ${name} in under one second`, () => {
    const started = process.hrtime.bigint();
    const built = buildImport({ source: source(html), id: 'hostile' });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    built.cleanup();
    assert.ok(elapsed < 1000, `${name}: ${elapsed.toFixed(0)} ms`);
  });
}

test('the scanner still finds tags after a comment, a script, and a quoted greater-than sign', () => {
  const html = [
    '<!-- <img src="hidden.png"> -->',
    '<script>var a = "<img src=\'inside-script.png\'>";</script>',
    '<TITLE>Docs &amp; notes</TITLE>',
    '<img alt="a > b" SRC="img/one.png">',
    '<style>.x { background: url("img/two.png"); }</style>',
    '<p style="background:url(https://cdn.example.test/bg.png?k=1)">text</p>',
  ].join('\n');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const root = source(html, { 'img/one.png': png });
  const built = buildImport({ source: root, id: 'docs' });
  t_cleanup(built);
  assert.equal(built.manifest.sections[0].title, 'Docs & notes');
  assert.deepEqual(built.manifest.sections[0].items.map((item) => item.type), ['page', 'image']);
  assert.equal(built.manifest.sections[0].items[1].alt, 'a > b');
  assert.deepEqual(built.external, ['https://cdn.example.test/bg.png']);
  assert.ok(built.skipped.some((entry) => entry.file === 'img/two.png'));
  assert.ok(!built.skipped.some((entry) => /hidden|inside-script/.test(entry.file)), 'a comment and a script hide their text');
});

function t_cleanup(built) { test.after(() => built.cleanup()); }

test('the importer stops at the item limit of a pack and lists the rest as skipped', () => {
  const images = Array.from({ length: 450 }, (_, index) => `<img src="img/p${index}.png">`).join('');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const files = Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`img/p${index}.png`, Buffer.concat([png, Buffer.from([index & 255, index >> 8])])]));
  const built = buildImport({ source: source(images, files), id: 'many' });
  t_cleanup(built);
  assert.equal(built.images, 399, 'one item is the page');
  assert.ok(built.skipped.length >= 51);
});

test('safeText removes control characters and escape sequences and cuts to 200 characters', () => {
  assert.equal(safeText('a\u001b[31mred\u001b[0m\u0007b'), 'ared b');
  assert.equal(safeText('x\u001b]0;pwn\u0007y'), 'xy');
  assert.equal(safeText('line\nbreak\r\ttab\u0085 end'), 'line break tab end');
  assert.equal(safeText('é'.repeat(500)).length, 200);
  assert.equal(safeText('\u001b'.repeat(10000)).length, 0);
  assert.equal(safeText(undefined), '');
});

test('the importer output holds no control character from an external URL, a file name, or a title', () => {
  const html = '<title>Docs\u001b[2J\u001b]0;pwn\u0007 page</title><img src="img/\u001b[2Jname.png" alt="bell\u0007"><img src="https://cdn.example.test/a\u001b[31mb.png"><script src="local/' + 'x'.repeat(400) + '.js"></script>';
  const built = buildImport({ source: source(html), id: 'clean' });
  t_cleanup(built);
  const printed = JSON.stringify([built.manifest.title, built.manifest.sections.map((section) => section.title), built.external.map(safeText), built.skipped.map((entry) => [safeText(entry.file), safeText(entry.reason)])]);
  assert.ok(!/\\u001b|\\u0007|\\u0085/.test(printed), printed);
  assert.ok(built.skipped.every((entry) => safeText(entry.file).length <= 200));
});
