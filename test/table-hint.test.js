import test from 'node:test';
import assert from 'node:assert/strict';
import { hintState, installTableHints } from '../public/table-hint.js';

test('hintState names the edges that have hidden columns', () => {
  assert.equal(hintState(0, 300, 300), '');
  assert.equal(hintState(0, 300, 301), '');
  assert.equal(hintState(0, 300, 600), 'end');
  assert.equal(hintState(150, 300, 600), 'both');
  assert.equal(hintState(300, 300, 600), 'start');
  assert.equal(hintState(299.5, 300, 600), 'start');
});

// A fake page: one table wrapper, a scroll box, and the hooks that the installer needs.
function fakePage({ clientWidth, scrollWidth }) {
  const attrs = new Map();
  const box = { scrollLeft: 0, clientWidth, scrollWidth, classList: { contains: (c) => c === 'md-table' } };
  const wrap = { firstElementChild: box, getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
  box.parentElement = wrap;
  const listeners = {};
  const frames = [];
  const doc = { body: {}, addEventListener: (type, fn) => { listeners[type] = fn; }, querySelectorAll: () => [wrap] };
  const win = { requestAnimationFrame: (fn) => frames.push(fn), addEventListener: () => {}, MutationObserver: class { observe() {} } };
  return { doc, win, box, wrap, listeners, frames, flush: () => { while (frames.length) frames.shift()(); } };
}

test('the hint state follows the scroll position', () => {
  const page = fakePage({ clientWidth: 300, scrollWidth: 700 });
  installTableHints(page.doc, page.win);
  page.flush();
  assert.equal(page.wrap.getAttribute('data-more'), 'end');
  page.box.scrollLeft = 200;
  page.listeners.scroll({ target: page.box });
  assert.equal(page.wrap.getAttribute('data-more'), 'both');
  page.box.scrollLeft = 400;
  page.listeners.scroll({ target: page.box });
  assert.equal(page.wrap.getAttribute('data-more'), 'start');
});

test('a table that fits has no hint, and a scroll of another element is ignored', () => {
  const page = fakePage({ clientWidth: 300, scrollWidth: 300 });
  installTableHints(page.doc, page.win);
  page.flush();
  assert.equal(page.wrap.getAttribute('data-more'), null);
  page.listeners.scroll({ target: { classList: { contains: () => false } } });
  assert.equal(page.wrap.getAttribute('data-more'), null);
});
