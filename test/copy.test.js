import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyText, copySource, flashCopied, copyFieldHtml, messageCopyHtml, COPIED_MS } from '../public/copy.js';
import { renderMarkdown, esc } from '../public/markdown.js';
import { LONG_MESSAGES } from './fixtures/long-messages.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake document with a real focus model: focus() sets activeElement, and removing the focused node resets it to the body.
function fakeDocument({ copyResult = true, throwOnCopy = false, withPrevious = true } = {}) {
  const log = { appended: [], commands: [], removed: 0 };
  const doc = { activeElement: null };
  doc.body = { append: (node) => log.appended.push(node), focus() {} };
  const focusable = (extra = {}) => ({ focus() { doc.activeElement = this; }, ...extra });
  doc.previous = focusable({ name: 'previous' });
  doc.activeElement = withPrevious ? doc.previous : doc.body;
  doc.createElement = () => focusable({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, select() { this.selected = true; }, setSelectionRange(a, b) { this.range = [a, b]; }, remove() { log.removed += 1; if (doc.activeElement === this) doc.activeElement = doc.body; } });
  doc.execCommand = (name) => { log.commands.push(name); if (throwOnCopy) throw new Error('blocked'); return copyResult; };
  return { doc, log };
}

test('copyText uses navigator.clipboard when it works', async () => {
  const written = [];
  const env = { navigator: { clipboard: { writeText: async (t) => { written.push(t); } } }, document: fakeDocument().doc };
  assert.equal(await copyText('npm test', env), true);
  assert.deepEqual(written, ['npm test']);
});

test('copyText falls back to a textarea and execCommand when the clipboard refuses', async () => {
  const { doc, log } = fakeDocument();
  const env = { navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } }, document: doc };
  assert.equal(await copyText('a\nb', env), true);
  assert.deepEqual(log.commands, ['copy']);
  assert.equal(log.appended[0].value, 'a\nb');
  assert.deepEqual(log.appended[0].range, [0, 3]);
  assert.equal(log.appended[0].attrs.readonly, '');
  assert.equal(log.removed, 1);
  assert.equal(doc.activeElement, doc.previous);
});

test('the fallback gives the focus back to the previous element, also when the copy fails or throws', async () => {
  for (const options of [{ copyResult: false }, { throwOnCopy: true }]) {
    const { doc } = fakeDocument(options);
    assert.equal(await copyText('x', { document: doc }), false);
    assert.equal(doc.activeElement, doc.previous);
  }
  const { doc } = fakeDocument({ withPrevious: false });
  await copyText('x', { document: doc });
  assert.equal(doc.activeElement, doc.body);
});

test('copyText falls back when there is no clipboard or the page is not secure', async () => {
  const a = fakeDocument();
  assert.equal(await copyText('x', { document: a.doc }), true);
  const b = fakeDocument();
  const never = async () => { assert.fail('clipboard used on an insecure page'); };
  assert.equal(await copyText('x', { isSecureContext: false, navigator: { clipboard: { writeText: never } }, document: b.doc }), true);
  assert.deepEqual(b.log.commands, ['copy']);
});

test('copyText reports a failure when both ways fail', async () => {
  const { doc, log } = fakeDocument({ copyResult: false });
  assert.equal(await copyText('x', { document: doc }), false);
  assert.equal(log.removed, 1);
  assert.equal(await copyText('x', {}), false);
});

// A fake button: attributes, a closest() that returns the given ancestors, and a copy-text child.
function fakeButton(attrs, { closest = {}, label = 'Copy code', textChild = null } = {}) {
  const attributes = new Map(Object.entries({ 'aria-label': label, ...attrs }));
  return {
    attributes,
    hasAttribute: (k) => attributes.has(k),
    getAttribute: (k) => attributes.get(k) ?? null,
    setAttribute: (k, v) => attributes.set(k, v),
    removeAttribute: (k) => attributes.delete(k),
    closest: (selector) => closest[selector] ?? null,
    querySelector: (selector) => (selector === '.copy-text' ? textChild : null),
  };
}

test('copySource reads the exact code text of a block, the field value, and the message source', () => {
  const code = { textContent: 'line 1\n  line 2' };
  const block = { querySelector: (s) => (s === 'code' ? code : null) };
  assert.equal(copySource(fakeButton({ 'data-copy-code': '' }, { closest: { '.md-code': block } })), 'line 1\n  line 2');
  assert.equal(copySource(fakeButton({ 'data-copy-code': 'all:\n\techo ok' }, { closest: { '.md-code': block } })), 'all:\n\techo ok');
  assert.equal(copySource(fakeButton({ 'data-copy-text': 'SHA256:abc' })), 'SHA256:abc');
  const messageText = (id) => (id === 'm1' ? '# Title\n\n```sh\nls\n```' : null);
  assert.equal(copySource(fakeButton({ 'data-copy-message': 'm1' }), { messageText }), '# Title\n\n```sh\nls\n```');
  const row = (prefix, text) => ({ getAttribute: (k) => (k === 'data-copy-prefix' ? prefix : null), querySelector: () => ({ textContent: text }) });
  const rows = [row('', '@@ -1 +1 @@'), row('-', 'old'), row('+', 'new'), row(' ', 'same'), { getAttribute: () => null, querySelector: () => ({ textContent: 'plain' }) }];
  const scope = { querySelector: () => ({ querySelectorAll: () => rows }) };
  assert.equal(copySource(fakeButton({ 'data-copy-lines': '' }, { closest: { '[data-copy-scope]': scope } })), '@@ -1 +1 @@\n-old\n+new\n same\nplain');
  assert.equal(copySource(fakeButton({})), null);
});

test('flashCopied shows Copied for 1.5 seconds and then restores the label', () => {
  const timers = [];
  const options = { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} };
  const button = fakeButton({ 'data-copy-code': '' });
  flashCopied(button, options);
  assert.equal(COPIED_MS, 1500);
  assert.equal(timers[0].ms, 1500);
  assert.equal(button.getAttribute('data-state'), 'copied');
  assert.equal(button.getAttribute('aria-label'), 'Copied');
  flashCopied(button, options);
  assert.equal(button.getAttribute('aria-label'), 'Copied');
  timers[1].fn();
  assert.equal(button.getAttribute('data-state'), null);
  assert.equal(button.getAttribute('aria-label'), 'Copy code');
});

test('flashCopied swaps the visible text of a text button and restores it', () => {
  const timers = [];
  const options = { setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} };
  const textChild = { textContent: 'Copy' };
  const button = fakeButton({ 'data-copy-message': 'm1' }, { label: 'Copy message', textChild });
  flashCopied(button, options);
  assert.equal(textChild.textContent, 'Copied');
  timers[0]();
  assert.equal(textChild.textContent, 'Copy');
});

test('copyFieldHtml escapes the value and has an aria-label', () => {
  const html = copyFieldHtml('a"b<c>', esc, 'Copy the folder');
  assert.match(html, /data-copy-text="a&quot;b&lt;c&gt;"/);
  assert.match(html, /aria-label="Copy the folder"/);
  assert.match(html, /^<button type="button" class="copy-btn copy-inline copy-field"/);
});

test('every code block of the long fixtures keeps its exact text and has a labeled button', () => {
  const fenced = LONG_MESSAGES.filter((text) => text.includes('```'));
  assert.ok(fenced.length >= 3);
  for (const source of fenced) {
    const html = renderMarkdown(source);
    const blocks = html.match(/<div class="md-code">/g).length;
    assert.equal(html.match(/data-copy-code aria-label="Copy code"/g).length, blocks);
  }
});

const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8').replace(/\/\*[^]*?\*\//g, '');
const rules = (selector) => [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim() === selector).map((m) => m[2]).join(' ');
const px = (text, name) => Number(new RegExp(`(?:^|[;\\s])${name}:\\s*(-?\\d+)px`).exec(text)?.[1]);

test('the copy button has a true 44 px tap target', () => {
  const base = rules('button.copy-btn.copy-btn');
  const border = Number(/border: (\d+)px/.exec(base)?.[1]);
  const size = px(base, 'width');
  const inset = -px(rules('.copy-btn::after'), 'inset');
  assert.equal(size - 2 * border + 2 * inset, 44);
  assert.equal(px(base, 'height'), size);
  assert.match(css, /box-sizing: border-box/);
});

test('a code button sits in a strip above the code and covers no code line', () => {
  assert.match(rules('.md-code'), /display: flex; flex-direction: column/);
  const base = rules('button.copy-btn.copy-btn');
  assert.match(base, /position: relative/);
  assert.match(base, /align-self: flex-end/);
  assert.doesNotMatch(base, /position: absolute/);
  assert.doesNotMatch(rules('.md .md-code > pre'), /padding-right/);
  // The flash is out of the flow and opens over the empty strip, left of the button.
  assert.match(rules('.copy-flash'), /position: absolute[^}]*right: calc\(100% \+ 6px\)/);
});

test('a field button sits inline after its value and shows Copied to the right of the icon', () => {
  const inline = rules('button.copy-btn.copy-inline');
  assert.match(inline, /display: inline-grid/);
  assert.match(inline, /margin: 0 0 0 6px/);
  assert.doesNotMatch(inline, /position: absolute/);
  assert.match(rules('.copy-inline .copy-flash'), /left: calc\(100% \+ 6px\)/);
});

test('a message button keeps its width when the label changes from Copy to Copied', () => {
  assert.match(messageCopyHtml('m1', esc), /<span class="copy-text" data-done="Copied">Copy<\/span>/);
  const sizer = rules('.copy-text::after');
  assert.match(sizer, /content: attr\(data-done\)/);
  assert.match(sizer, /height: 0/);
  assert.match(sizer, /visibility: hidden/);
  assert.match(rules('.copy-text'), /display: inline-flex; flex-direction: column/);
});
