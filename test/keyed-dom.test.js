import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, find, byKey } from './fake-dom.js';

// keyed.js reads the global document. Each test gets a fresh fake document.
const { patchHtml } = await import('../public/keyed.js');
function setup(html) {
  globalThis.document = createDocument();
  return document.html(html);
}

const card = (id, title) => `<li data-key="task:${id}"><button type="button" class="card-title">${title}</button></li>`;
const column = (k, cards) => `<section data-key="col:${k}"><h3>${k}</h3><ol>${cards.join('')}</ol></section>`;

test('a patch keeps the DOM node of a keyed element when the order changes', () => {
  const root = setup(`<ol>${card('A', 'one')}${card('B', 'two')}${card('C', 'three')}</ol>`);
  const [a, b, c] = ['A', 'B', 'C'].map((id) => byKey(root, `task:${id}`));
  patchHtml(root, `<ol>${card('C', 'three')}${card('A', 'one, changed')}${card('B', 'two')}</ol>`);
  const list = root.childNodes[0].childNodes;
  assert.deepEqual(list.map((n) => n.getAttribute('data-key')), ['task:C', 'task:A', 'task:B']);
  assert.equal(list[0], c);
  assert.equal(list[1], a);
  assert.equal(list[2], b);
  assert.equal(a.textContent, 'one, changed', 'a kept node gets the new content');
});

test('a patch removes an element that the new HTML does not hold and adds a new one', () => {
  const root = setup(`<ol>${card('A', 'one')}${card('B', 'two')}</ol><p>tail</p>`);
  const a = byKey(root, 'task:A');
  const b = byKey(root, 'task:B');
  patchHtml(root, `<ol>${card('A', 'one')}${card('N', 'new')}</ol>`);
  assert.equal(byKey(root, 'task:A'), a);
  assert.equal(byKey(root, 'task:B'), null);
  assert.equal(b.parentNode, null, 'the removed node is detached');
  assert.ok(byKey(root, 'task:N'));
  assert.equal(root.childNodes.length, 1, 'the unkeyed tail paragraph is removed');
});

test('a patch changes and removes attributes but keeps the attributes that data-keep-attrs names', () => {
  const root = setup('<div data-key="x" class="a" title="t" style="height: 10px" data-keep-attrs="style"></div>');
  const el = byKey(root, 'x');
  el.setAttribute('style', 'height: 99px');
  patchHtml(root, '<div data-key="x" class="b" data-keep-attrs="style"></div>');
  assert.equal(byKey(root, 'x'), el);
  assert.equal(el.getAttribute('class'), 'b');
  assert.equal(el.hasAttribute('title'), false);
  assert.equal(el.getAttribute('style'), 'height: 99px');
});

test('a focused button keeps its focus when a patch keeps its card', () => {
  const root = setup(`<ol>${card('A', 'one')}${card('B', 'two')}</ol>`);
  const button = find(byKey(root, 'task:B'), (el) => el.tagName === 'BUTTON');
  button.focus();
  patchHtml(root, `<ol>${card('B', 'two')}${card('A', 'one')}</ol>`);
  assert.equal(document.activeElement, button);
});

test('a focused field keeps its value and caret across a patch', () => {
  const root = setup('<form data-key="f"><input id="q" type="search" value="old"><textarea id="t">draft</textarea></form>');
  const input = find(root, (el) => el.tagName === 'INPUT');
  input.value = 'typed text';
  input.focus();
  input.setSelectionRange(3, 5);
  patchHtml(root, '<form data-key="f"><input id="q" type="search" value="server"><textarea id="t">server</textarea></form>');
  assert.equal(find(root, (el) => el.tagName === 'INPUT'), input);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'typed text');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 5]);
  const area = find(root, (el) => el.tagName === 'TEXTAREA');
  assert.equal(area.value, 'server', 'a field without focus takes the new value');
});

test('a card button keeps the focus when a refresh moves its card to another column', () => {
  const root = setup(`<div>${column('ready', [card('A', 'one'), card('B', 'two')])}${column('doing', [])}</div>`);
  find(byKey(root, 'task:A'), (el) => el.tagName === 'BUTTON').focus();
  patchHtml(root, `<div>${column('ready', [card('B', 'two')])}${column('doing', [card('A', 'one')])}</div>`);
  const moved = byKey(root, 'task:A');
  assert.equal(moved.parentNode.parentNode.getAttribute('data-key'), 'col:doing');
  assert.equal(document.activeElement, find(moved, (el) => el.tagName === 'BUTTON'), 'the focus follows the card');
});

test('a removed card does not move the focus to another element', () => {
  const root = setup(`<ol>${card('A', 'one')}${card('B', 'two')}</ol>`);
  find(byKey(root, 'task:A'), (el) => el.tagName === 'BUTTON').focus();
  patchHtml(root, `<ol>${card('B', 'two')}</ol>`);
  assert.equal(document.activeElement, document.body);
});
