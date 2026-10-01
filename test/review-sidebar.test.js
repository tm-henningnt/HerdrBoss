// The sections column: wrapped titles, the number element, the resize handle, the collapse rail, and the changed notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find } from './fake-dom.js';
import {
  SIDEBAR_KEY, SIDEBAR_MIN, SIDEBAR_DEFAULT, clampWidth, keyWidth, loadSidebar, saveSidebar, createSidebar, sidebarMax,
} from '../public/review-sidebar.js';
import { packPageHtml, itemChip } from '../public/review.js';

const sourceCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const css = sourceCss.replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = () => ({
  esc,
  avatar: () => '<span class="avatar"></span>',
  projectLabel: (slug) => slug,
  time: () => '08:12',
  menuButton: '',
});

const LONG = 'A very long title of an item that does not fit in the narrow column of the sections';
function pack(over = {}) {
  const items = [
    { id: 'first', section: 'one', title: LONG, type: 'markdown', ask: ['accept', 'deny'], state: 'changed', stale: true, hash: 'sha256:b',
      answer: { decision: null, viewed: false, stale: true, rev: 2, previous: { decision: 'accept', at: '2026-09-30T08:00:00.000Z' } } },
    { id: 'second', section: 'one', title: 'Short', type: 'markdown', ask: ['accept', 'deny'], state: 'accepted', stale: false, answer: { decision: 'accept', viewed: true, rev: 1 } },
    { id: 'third', section: 'two', title: 'Third item', type: 'markdown', ask: ['accept', 'deny'], state: 'open', stale: false, answer: null },
  ];
  return {
    slug: 'shop', pack: 'sample', title: 'Sample', version: 2, currentVersion: 2, state: 'open', note: '', noteRev: 0,
    manifest: { sections: [{ id: 'one', title: 'One', items: [] }, { id: 'two', title: 'Two', items: [] }] },
    items,
    removed: [],
    derived: {
      sections: [{ id: 'one', title: LONG, state: 'changed' }, { id: 'two', title: 'Two', state: 'open' }],
      pack: 'changed',
      counts: { items: 3, accepted: 1, denied: 0, live: 0, noteOnly: 0, open: 2, changed: 1 },
      proposedVerdict: 'accept-with-changes',
    },
    ...over,
  };
}

const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); }, data };
};
const brokenStorage = () => ({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });

function render(ui = {}) {
  globalThis.document = createDocument();
  return document.html(packPageHtml(pack(), ui, helpers()));
}

// ---------- Titles ----------

test('an item row keeps its number in its own element and gives the full title as a tooltip', () => {
  const root = render();
  const row = find(root, (el) => el.getAttribute('data-review-row') === 'first');
  const number = find(row, (el) => (el.getAttribute('class') || '').split(' ').includes('review-item-n'));
  const title = find(row, (el) => (el.getAttribute('class') || '').split(' ').includes('review-item-title'));
  assert.equal(number.textContent, '1');
  assert.equal(title.getAttribute('title'), LONG);
  assert.equal(title.textContent, LONG);
  assert.notEqual(number.parentNode, title, 'the number is not inside the clamped title');
});

test('a section title has the full title as a tooltip', () => {
  const root = render();
  const heading = find(root, (el) => el.tagName === 'H2' && el.textContent === LONG);
  assert.equal(heading.getAttribute('title'), LONG);
});

test('the item header carries the full title', () => {
  globalThis.document = createDocument();
  const root = document.html(packPageHtml(pack(), { item: 'first', viewer: {} }, helpers()));
  const heading = find(root, (el) => el.getAttribute('data-rv-heading') !== null && el.tagName === 'H1');
  assert.equal(heading.getAttribute('title'), LONG);
});

test('the CSS clamps a title to two lines and never shrinks the number', () => {
  const title = /\.review-item-title\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(title, /-webkit-line-clamp:\s*2/);
  assert.match(title, /line-clamp:\s*2/);
  assert.doesNotMatch(title, /white-space:\s*nowrap/);
  const number = /\.review-item-n\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(number, /flex:\s*none/);
  const section = /\.review-sec-h h2\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(section, /line-clamp:\s*2/);
});

// ---------- Handle ----------

test('the width stays between 200 px and half of the viewport', () => {
  assert.equal(clampWidth(100, 1280), SIDEBAR_MIN);
  assert.equal(clampWidth(900, 1280), 640);
  assert.equal(clampWidth(640, 1280), 640);
  assert.equal(sidebarMax(1280), 640);
  assert.equal(clampWidth(500, 900), 450);
  assert.equal(clampWidth(300, 300), SIDEBAR_MIN, 'a small window keeps the minimum');
  assert.equal(clampWidth(Number.NaN, 1280), SIDEBAR_DEFAULT);
});

test('arrow keys change the width by 16 px and Home resets it', () => {
  assert.equal(keyWidth(300, 'ArrowRight', 1280), 316);
  assert.equal(keyWidth(300, 'ArrowLeft', 1280), 284);
  assert.equal(keyWidth(204, 'ArrowLeft', 1280), SIDEBAR_MIN);
  assert.equal(keyWidth(636, 'ArrowRight', 1280), 640);
  assert.equal(keyWidth(500, 'Home', 1280), SIDEBAR_DEFAULT);
  assert.equal(keyWidth(300, 'a', 1280), null);
});

test('the handle is a focusable separator that states the width and the bounds', () => {
  const root = render({ sidebar: { width: 340, collapsed: false, viewport: 1280 } });
  const handle = find(root, (el) => el.getAttribute('data-review-resize') !== null);
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('tabindex'), '0');
  assert.equal(handle.getAttribute('aria-valuemin'), '200');
  assert.equal(handle.getAttribute('aria-valuemax'), '640');
  assert.equal(handle.getAttribute('aria-valuenow'), '340');
  const page = find(root, (el) => (el.getAttribute('class') || '').includes('review-page'));
  assert.match(page.getAttribute('style'), /--review-side: 340px/);
});

test('the controller applies and stores each change, and a key reports whether it acted', () => {
  const storage = fakeStorage();
  const seen = [];
  const side = createSidebar({ storage, viewport: () => 1280, apply: (state) => seen.push(state.width) });
  assert.equal(side.key('ArrowRight'), true);
  assert.equal(side.key('Tab'), false);
  assert.deepEqual(seen, [316]);
  assert.equal(JSON.parse(storage.data.get(SIDEBAR_KEY)).width, 316);
  side.resize(5000);
  assert.equal(side.get().width, 640);
  side.resize(50, false);
  assert.equal(JSON.parse(storage.data.get(SIDEBAR_KEY)).width, 640, 'a drag step stores nothing until it ends');
  side.key('Home');
  assert.equal(side.get().width, SIDEBAR_DEFAULT);
  // A later page load reads the stored width.
  assert.equal(loadSidebar(storage).width, SIDEBAR_DEFAULT);
});

test('a window that shrinks pulls the shown width under the new bound', () => {
  let viewport = 1600;
  const side = createSidebar({ storage: fakeStorage(), viewport: () => viewport });
  side.resize(780);
  viewport = 1000;
  assert.equal(side.get().width, 500);
});

test('a storage that throws leaves the default and does not stop a change', () => {
  assert.deepEqual(loadSidebar(brokenStorage()), { width: SIDEBAR_DEFAULT, collapsed: false });
  assert.deepEqual(loadSidebar(null), { width: SIDEBAR_DEFAULT, collapsed: false });
  assert.doesNotThrow(() => saveSidebar(brokenStorage(), { width: 300, collapsed: false }));
  const seen = [];
  const side = createSidebar({ storage: brokenStorage(), viewport: () => 1280, apply: (state) => seen.push(state) });
  assert.doesNotThrow(() => side.key('ArrowRight'));
  assert.doesNotThrow(() => side.collapse(true));
  assert.equal(seen.at(-1).collapsed, true);
});

test('a broken stored value gives the default', () => {
  assert.equal(loadSidebar(fakeStorage({ [SIDEBAR_KEY]: '{oops' })).width, SIDEBAR_DEFAULT);
  assert.equal(loadSidebar(fakeStorage({ [SIDEBAR_KEY]: JSON.stringify({ width: 'wide', collapsed: 'yes' }) })).collapsed, false);
  assert.equal(loadSidebar(fakeStorage({ [SIDEBAR_KEY]: JSON.stringify({ width: 20 }) })).width, SIDEBAR_MIN);
});

// ---------- Collapse ----------

test('a collapsed column is a thin rail with an expand button and no handle', () => {
  const root = render({ sidebar: { width: 340, collapsed: true, viewport: 1280 } });
  assert.ok(find(root, (el) => el.getAttribute('data-review-expand') !== null));
  assert.equal(find(root, (el) => el.getAttribute('data-review-resize') !== null), null);
  assert.equal(find(root, (el) => el.getAttribute('data-review-row') === 'first'), null);
  const page = find(root, (el) => (el.getAttribute('class') || '').includes('review-page'));
  assert.match(page.getAttribute('style'), /--review-side: 44px/);
});

test('an open column has a collapse button', () => {
  const root = render();
  assert.ok(find(root, (el) => el.getAttribute('data-review-collapse') !== null));
});

test('the handle, the bar, and the rail show only at 900 px and wider, and the phone block stays free of them', () => {
  const blocks = [...css.matchAll(/@media \(max-width: 760px\)\s*\{/g)];
  const last = blocks.at(-1).index;
  const phone = css.slice(last, css.indexOf('\n}\n', last));
  assert.doesNotMatch(phone, /review-resize|review-side/);
  assert.match(css, /\.review-resize(?:,[^{]*)?\{[^}]*display:\s*none/);
  const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .review-rows'));
  assert.match(wide.slice(0, wide.indexOf('\n}\n')), /\.review-resize\s*\{[^}]*display:\s*block/);
  assert.match(css, /grid-template-columns:\s*var\(--review-side, 300px\) minmax\(0, 1fr\)/);
});

test('no link under 44 px gets a min-height rule from the new review styles', () => {
  for (const rule of css.matchAll(/([^{}]*\bwidth\b[^{}]*|[^{}]*\.review-(?:item|side)[^{}]*)\{([^}]*)\}/g)) {
    if (!/(^|[\s,>])a(\.|\s|,|:|\[|$)/.test(rule[1].trim()) && !/\.review-item(\s|,|\{|:|$)/.test(rule[1].trim())) continue;
    const min = /min-height:\s*(\d+)px/.exec(rule[2]);
    if (min) assert.ok(Number(min[1]) >= 44, `${rule[1].trim()} has min-height ${min[1]}px`);
  }
});

test('app.js wires the handle with pointer and key events and reads the storage inside try/catch', () => {
  assert.match(app, /createSidebar\(/);
  assert.match(app, /data-review-resize/);
  assert.match(app, /data-review-collapse/);
  assert.match(app, /data-review-expand/);
  assert.match(app, /data-rv-keep/);
  assert.match(app, /try \{ return window\.localStorage; \} catch/);
});

// ---------- Changed ----------

test('a changed item shows a Changed chip, and its section shows Changed', () => {
  const p = pack();
  assert.equal(itemChip(p.items[0], p).label, 'Changed');
  const root = render();
  const chips = [];
  const visit = (el) => { if ((el.getAttribute?.('class') || '').includes('review-chip-changed')) chips.push(el.textContent); (el.childNodes || []).forEach(visit); };
  visit(root);
  assert.ok(chips.length >= 2, 'the item and the section show a Changed chip');
});

test('a changed item shows Was with the date and a Keep button, and no pressed Accept', () => {
  globalThis.document = createDocument();
  const root = document.html(packPageHtml(pack(), { item: 'first', viewer: {} }, helpers()));
  const notice = find(root, (el) => (el.getAttribute('class') || '') === 'rv-stale');
  assert.match(notice.textContent, /Was: Accepted on 2026-09-30/);
  const keep = find(notice, (el) => el.getAttribute('data-rv-keep') !== null);
  assert.equal(keep.textContent, 'Keep');
  const accept = find(root, (el) => el.getAttribute('data-rv-decision') === 'accept');
  assert.equal(accept.getAttribute('aria-pressed'), 'false');
});

test('a closed pack offers no Keep', () => {
  globalThis.document = createDocument();
  const root = document.html(packPageHtml(pack({ state: 'submitted' }), { item: 'first', viewer: {} }, helpers()));
  assert.equal(find(root, (el) => el.getAttribute('data-rv-keep') !== null), null);
});

test('a changed item shows no viewed tick in the list', () => {
  const p = pack();
  p.items[0].answer.viewed = true;
  globalThis.document = createDocument();
  const root = document.html(packPageHtml(p, {}, helpers()));
  const row = find(root, (el) => el.getAttribute('data-review-row') === 'first');
  assert.doesNotMatch(row.getAttribute('class'), /review-item-done/);
  assert.match(JSON.stringify(row.textContent), /Not viewed/);
});
