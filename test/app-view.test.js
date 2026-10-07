import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find, byKey } from './fake-dom.js';

const { appViewport, APP_VIEW_ROUTES } = await import('../public/app-view.js');
const { patchHtml } = await import('../public/keyed.js');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the app view follows the visual viewport, so the composer sits above the keyboard', () => {
  assert.deepEqual(appViewport({ height: 844, offsetTop: 0, scale: 1, innerHeight: 844 }), { height: 844, top: 0 });
  assert.deepEqual(appViewport({ height: 553, offsetTop: 0, scale: 1, innerHeight: 844 }), { height: 553, top: 0 }, 'a keyboard of 291 px');
  assert.deepEqual(appViewport({ height: 553.4, offsetTop: 120.6, scale: 1, innerHeight: 844 }), { height: 553, top: 121 }, 'iOS scrolls the layout viewport');
  assert.deepEqual(appViewport({ height: 400, offsetTop: 90, scale: 2, innerHeight: 844 }), { height: 844, top: 0 }, 'a pinch zoom keeps the full height');
  assert.deepEqual(appViewport({ height: 0, offsetTop: 0, scale: 1, innerHeight: 700 }), { height: 700, top: 0 });
  assert.deepEqual([...APP_VIEW_ROUTES].sort(), ['chat', 'mailbox', 'reviews']);
});

test('the phone app view hides the page header and fills the visual viewport', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/);
  assert.match(app, /document\.body\.classList\.toggle\('app-view', APP_VIEW_ROUTES\.includes\(route\)\)/);
  assert.match(app, /setProperty\('--app-h', `\$\{view\.height\}px`\)/);
  const at = css.indexOf('/* Phone app view.');
  assert.ok(at >= 0, 'style.css has a Phone app view section');
  const phone = css.slice(at);
  assert.match(phone, /body\.app-view \.top \{ display: none; \}/);
  assert.match(phone, /body\.app-view main \{[^}]*height: var\(--app-h, 100dvh\);/);
  assert.match(phone, /env\(safe-area-inset-top\)/);
  assert.match(phone, /env\(safe-area-inset-bottom\)/);
});

function setup(markup) {
  globalThis.document = createDocument();
  return document.html(markup);
}
const bubble = (id, text) => `<li class="chat-bubble from-agent" data-key="msg:${id}"><div class="chat-bubble-text md"><p>${text}</p></div></li>`;
const thread = (ids, draft) => `<div class="chat-panel"><div class="chat-scroll" data-key="chat-scroll:boss"><ol class="chat-bubbles">${ids.map((id) => bubble(id, `text ${id}`)).join('')}</ol></div><form class="chat-composer" data-key="chat-composer"><textarea id="chat-draft" data-chat-draft>${draft}</textarea></form></div>`;

test('a new chat message appends a bubble and keeps the old bubbles, the log scroll, the draft, and the caret', () => {
  const root = setup(thread(['a', 'b'], ''));
  const log = byKey(root, 'chat-scroll:boss');
  log.scrollTop = 300;
  const old = byKey(root, 'msg:a');
  const field = find(root, (el) => el.tagName === 'TEXTAREA');
  field.value = 'half a senten';
  field.focus();
  field.setSelectionRange(4, 4);
  patchHtml(root, thread(['a', 'b', 'c'], 'half a sent'));
  assert.equal(byKey(root, 'chat-scroll:boss'), log);
  assert.equal(log.scrollTop, 300);
  assert.equal(byKey(root, 'msg:a'), old);
  assert.ok(byKey(root, 'msg:c'));
  assert.equal(find(root, (el) => el.tagName === 'TEXTAREA'), field);
  assert.equal(field.value, 'half a senten', 'the focused field keeps what the Owner typed');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 4]);
  assert.equal(document.activeElement, field);
});

test('another chat gets a new log node, so its scroll starts fresh', () => {
  const root = setup(thread(['a'], ''));
  const log = byKey(root, 'chat-scroll:boss');
  patchHtml(root, thread(['a'], '').replace('chat-scroll:boss', 'chat-scroll:alpha'));
  assert.notEqual(byKey(root, 'chat-scroll:alpha'), log);
  assert.equal(log.parentNode, null);
});
