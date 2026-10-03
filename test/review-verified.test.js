// The summary header, the verified badges, the item anatomy, the evidence images, the Needs you filter,
// and the narrow section row of the review pages (RV3b). The modules have no DOM use, so the tests import them directly.
import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { packPageHtml, summaryHeaderHtml } = await import('../public/review.js');
const { itemViewerHtml, verifiedBadgeHtml } = await import('../public/review-viewer.js');
const { visibleItems, needsYouCount, loadFilter, saveFilter } = await import('../public/review-filter.js');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const guide = readUserGuide();
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = { esc, icon: () => '', avatar: () => '', projectLabel: (s) => s, time: () => '08:12', menuButton: '', text: () => undefined };
const EVIL = '<img src=x onerror=alert(1)>';

function item(id, section, over = {}) {
  return { id, section, title: `Title ${id}`, type: 'image', ask: ['accept', 'deny', 'note'], state: 'open', stale: false, answer: null, ...over };
}

function pack(over = {}) {
  const items = [
    item('a1', 'one', { verifiedBy: 'agent-verified', evidence: ['shots/a1.png', 'shots/a1b.png'], description: 'Line one.\nLine two.', steps: ['Open it.', 'Press it.'], expected: 'It works.', link: 'https://app.example.test/x' }),
    item('n1', 'one', { verifiedBy: 'needs-you' }),
    item('n2', 'two', { verifiedBy: 'needs-you' }),
    item('u1', 'two'),
  ];
  return {
    slug: 'shop', pack: 'demo', title: 'Demo', version: 1, state: 'open', manifest: { designPass: { reviewer: 'Design Bot', result: 'passed', note: 'Looks right.' }, sections: [
      { id: 'one', title: 'One', items: [{ id: 'a1', type: 'image', src: 'shots/main.png' }] }, { id: 'two', title: 'Two', items: [] },
    ] },
    items,
    derived: { sections: [{ id: 'one', title: 'One', state: 'open' }, { id: 'two', title: 'Two', state: 'open' }], counts: { items: 4, accepted: 0, denied: 0, live: 0, noteOnly: 0, open: 4 } },
    summary: { total: 4, agentVerified: 1, needsYou: 2, unmarked: 1, designPass: 'passed' },
    ...over,
  };
}

const page = (p, ui = {}) => packPageHtml(p, { sidebar: { viewport: 1280 }, ...ui }, h);
const nav = (html) => html.match(/<nav class="review-sections[\s\S]*?<\/nav>/)[0];
const viewer = (p, id, ui = {}) => itemViewerHtml(p, p.items.find((i) => i.id === id), ui, h);

test('the summary header shows the counts, the unmarked count above 0, and the design pass with the reviewer', () => {
  const html = summaryHeaderHtml(pack(), esc);
  assert.match(html, /class="review-summary-row"/);
  assert.match(html, /<b class="num">4<\/b> items/);
  assert.match(html, /<b class="num">1<\/b> agent-verified/);
  assert.match(html, /<b class="num">2<\/b> needs-you/);
  assert.match(html, /<b class="num">1<\/b> unmarked/);
  assert.match(html, /Design pass: <b>passed<\/b>/);
  assert.match(html, /Design Bot/);
  assert.ok(page(pack()).includes('review-summary-row'));
  const none = summaryHeaderHtml(pack({ summary: { total: 2, agentVerified: 1, needsYou: 1, unmarked: 0, designPass: 'issues' }, manifest: { designPass: { reviewer: 'R', result: 'issues' }, sections: [] } }), esc);
  assert.doesNotMatch(none, /unmarked/);
  assert.match(none, /Design pass: <b>issues<\/b>/);
});

test('the summary header escapes the reviewer name and the note', () => {
  const html = summaryHeaderHtml(pack({ manifest: { designPass: { reviewer: EVIL, result: 'issues', note: EVIL }, sections: [] } }), esc);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a badge has an icon, a word, and an accessible name, and an unmarked item has a neutral badge', () => {
  const agent = verifiedBadgeHtml({ verifiedBy: 'agent-verified' }, esc);
  assert.match(agent, /review-badge-agent/);
  assert.match(agent, /<svg[^>]*aria-hidden="true"/);
  assert.match(agent, /<span class="review-badge-word">agent-verified<\/span>/);
  assert.match(agent, /title="agent-verified"/);
  const you = verifiedBadgeHtml({ verifiedBy: 'needs-you' }, esc);
  assert.match(you, /review-badge-you/);
  assert.match(you, /needs-you<\/span>/);
  const none = verifiedBadgeHtml({}, esc);
  assert.match(none, /review-badge-none/);
  assert.match(none, /unmarked/);
});

test('each item row and the item view carry the badge', () => {
  const html = page(pack());
  assert.equal((html.match(/review-badge-agent/g) || []).length, 1);
  assert.equal((html.match(/review-badge-you/g) || []).length, 2);
  assert.equal((html.match(/review-badge-none/g) || []).length, 1);
  assert.match(viewer(pack(), 'n1'), /review-badge-you/);
});

test('the item view shows the description, the numbered steps, the expected result, and a safe link', () => {
  const html = viewer(pack(), 'a1');
  assert.match(html, /Line one\./);
  assert.match(html, /Line two\./);
  assert.match(html, /<ol class="rv-steps">\s*<li>Open it\.<\/li><li>Press it\.<\/li><\/ol>/);
  assert.match(html, /Expected/);
  assert.match(html, /It works\./);
  assert.match(html, /<a [^>]*href="https:\/\/app\.example\.test\/x"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
});

test('a hostile description, step, expected text, and link never reach the markup unescaped', () => {
  const p = pack();
  Object.assign(p.items[0], { description: `${EVIL}\n${EVIL}`, steps: [EVIL], expected: EVIL, link: 'javascript:alert(1)' });
  const html = viewer(p, 'a1');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  p.items[0].link = 'https://x.test/?a="><script>';
  assert.doesNotMatch(viewer(p, 'a1'), /<script>/);
});

test('the evidence images of an agent-verified item show under a heading, with a zoom stage', () => {
  const html = viewer(pack(), 'a1');
  assert.match(html, /<h3 class="rv-evidence-h">Agent evidence/);
  assert.match(html, /shots\/a1\.png/);
  assert.match(html, /data-rv-evopen="0"/);
  const open = viewer(pack(), 'a1', { evidence: 1 });
  assert.match(open, /rv-evidence-agent/);
  assert.match(open, /data-rv-stage="[^"]*ev/);
  assert.match(open, /shots\/a1b\.png/);
  assert.match(open, /data-rv-evgallery="grid"/);
  assert.doesNotMatch(viewer(pack(), 'n1'), /Agent evidence/);
});

test('an old item without the new fields renders as before', () => {
  const p = pack();
  p.items = [item('o1', 'one')];
  delete p.summary;
  p.manifest = { sections: [{ id: 'one', title: 'One', items: [{ id: 'o1', type: 'image', src: 'x.png' }] }] };
  const html = viewer(p, 'o1');
  assert.doesNotMatch(html, /rv-anatomy|rv-evidence-h|review-badge-agent|review-badge-you/);
  const full = page(p);
  assert.doesNotMatch(full, /review-summary-row|data-review-filter/);
  assert.match(full, /Title o1/);
});

test('the Needs you filter shows the count, keeps headings that still have items, and defaults to off', () => {
  const off = nav(page(pack()));
  assert.match(off, /data-review-filter[^>]*aria-pressed="false"[^>]*>[\s\S]*Needs you[\s\S]*<span class="num">2<\/span>/);
  assert.match(off, /Title a1/);
  const on = nav(page(pack(), { needsYouOnly: true }));
  assert.match(on, /aria-pressed="true"/);
  assert.doesNotMatch(on, /Title a1/);
  assert.doesNotMatch(on, /Title u1/);
  assert.match(on, /Title n1/);
  assert.match(on, /Title n2/);
  const one = on;
  assert.match(one, />Two</);
  const p = pack();
  p.items = p.items.filter((i) => i.id !== 'n2' && i.id !== 'u1');
  const heads = nav(page(p, { needsYouOnly: true }));
  assert.match(heads, />One</);
  assert.doesNotMatch(heads, />Two</);
});

test('the filter helpers keep the open item and skip hidden items', () => {
  const items = pack().items;
  assert.equal(needsYouCount(items), 2);
  assert.deepEqual(visibleItems(items, false).map((i) => i.id), ['a1', 'n1', 'n2', 'u1']);
  assert.deepEqual(visibleItems(items, true).map((i) => i.id), ['n1', 'n2']);
  assert.deepEqual(visibleItems(items, true, 'a1').map((i) => i.id), ['a1', 'n1', 'n2'], 'the open item stays');
});

test('the next-item link of the pager skips a hidden item', () => {
  const p = pack();
  const plain = viewer(p, 'n1');
  assert.match(plain, /href="[^"]*\/n2"[^>]*rel="next"/);
  const p2 = pack();
  p2.items.splice(2, 0, item('x9', 'two', { verifiedBy: 'agent-verified' }));
  assert.match(viewer(p2, 'n1'), /href="[^"]*\/x9"[^>]*rel="next"/);
  assert.match(viewer(p2, 'n1', { needsYouOnly: true }), /href="[^"]*\/n2"[^>]*rel="next"/);
});

test('the filter state is kept per pack in storage, and a broken storage gives off', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadFilter(storage, 'shop/demo'), false);
  saveFilter(storage, 'shop/demo', true);
  assert.equal(loadFilter(storage, 'shop/demo'), true);
  assert.equal(loadFilter(storage, 'shop/other'), false);
  saveFilter(storage, 'shop/demo', false);
  assert.equal(loadFilter(storage, 'shop/demo'), false);
  const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
  assert.equal(loadFilter(broken, 'x'), false);
  assert.doesNotThrow(() => saveFilter(broken, 'x', true));
  assert.equal(loadFilter({ getItem: () => '{bad' }, 'x'), false);
  assert.equal(loadFilter(null, 'x'), false);
});

test('the item row keeps the number and wraps the badge and the checkbox in an end group', () => {
  const html = page(pack());
  const row = html.match(/<a class="review-item[^"]*"[\s\S]*?<\/a>/)[0];
  assert.match(row, /<span class="review-item-n num">1<\/span>/);
  assert.match(row, /<span class="review-item-end">[\s\S]*review-badge[\s\S]*review-viewed[\s\S]*<\/span><\/a>/);
  assert.ok(row.indexOf('review-item-title') < row.indexOf('review-item-end'));
});

test('the narrow column CSS wraps the row, clamps the title, hides the badge word, and widens the handle hit area', () => {
  assert.match(css, /\.review-sections \{[^}]*container-type: inline-size/);
  const narrow = css.match(/@container[^{]*\(max-width: 2\d\dpx\) \{[\s\S]*?\n  \}/);
  assert.ok(narrow, 'a container query for the narrow column');
  assert.match(narrow[0], /grid-template-areas/);
  assert.match(narrow[0], /line-clamp: 2/);
  assert.match(css, /@container[^{]*\(max-width: 3\d\dpx\)[^{]*\{[^}]*\.review-item \.review-badge-word/);
  assert.match(css, /\.review-item-n \{[^}]*flex: none/);
  assert.match(css, /\.review-resize::before \{[^}]*inset: 0 -8px/);
  assert.match(css, /\.review-resize \{[^}]*width: 8px/);
});

test('no link gets a min-height under 44 px, and the phone rules stay in the last phone block', () => {
  for (const rule of css.matchAll(/(^|\n)\s*([^{}\n]*\ba\b[^{}\n]*)\{([^}]*)\}/g)) {
    const min = /min-height:\s*(\d+)px/.exec(rule[3]);
    if (min && /review|rv-/.test(rule[2])) assert.ok(Number(min[1]) >= 44, rule[2]);
  }
  assert.equal((css.match(/@media \(max-width: 760px\)/g) || []).length >= 1, true);
  const last = css.lastIndexOf('@media (max-width: 760px)');
  assert.match(css.slice(last), /review-filter/);
  assert.match(css.slice(last), /review-summary-row/);
});

test('the page wires the filter, the evidence viewer, and the hidden-item skip', () => {
  assert.match(app, /data-review-filter/);
  assert.match(app, /visibleItems\(/);
  assert.match(app, /rvEvopen/);
});

test('the Reviews help and the user guide describe the header, the badges, the evidence, and the filter', () => {
  assert.match(app, /Needs you<\/b> filter/);
  for (const text of ['summary header', 'agent-verified', 'needs-you', 'Needs you', 'design pass']) assert.ok(guide.includes(text), text);
});

test('RV3b fix 1: the phone rules outrank the base rules by selector', () => {
  const from = css.slice(css.lastIndexOf('@media (max-width: 760px) {'));
  const phone = from.slice(0, from.indexOf('\n}'));
  for (const name of ['review-item', 'review-filter-chip', 'review-summary-row']) {
    assert.match(phone, new RegExp(`\\.review-page \\.${name}[ ,{]`), name);
    assert.doesNotMatch(phone, new RegExp(`(^|\\n)\\s*\\.${name} \\{`), `${name} has no bare phone rule`);
  }
  assert.match(phone, /\.review-page \.review-filter-chip[^{]*\{[^}]*font-size: 16px/);
});

test('RV3b fix 2: no row keeps an empty fourth column', () => {
  for (const rule of css.matchAll(/\.review-item \{([^}]*)\}/g)) {
    const columns = /grid-template-columns:\s*([^;]+);/.exec(rule[1]);
    if (columns && !/grid-template-areas/.test(rule[1])) assert.doesNotMatch(columns[1], /auto 20px/, columns[1]);
  }
  assert.match(css, /\.review-item \{ grid-template-columns: 24px minmax\(0, 1fr\) auto; \}/);
});

test('RV3b fix 3: a filter with no match shows one line and a clear action', () => {
  const p = pack();
  p.items = p.items.filter((i) => i.verifiedBy !== 'needs-you');
  const html = nav(page(p, { needsYouOnly: true }));
  assert.match(html, /<p class="review-filter-empty" role="status">Nothing needs you\./);
  assert.match(html, /data-review-filter-clear/);
  assert.doesNotMatch(nav(page(pack(), { needsYouOnly: true })), /review-filter-empty/);
  assert.doesNotMatch(nav(page(p)), /review-filter-empty/);
  assert.match(app, /data-review-filter-clear/);
});

test('RV3b fix 4: a missing evidence file shows its name and no image', () => {
  const grid = viewer(pack(), 'a1', { missing: { 'shots/a1.png': true } });
  assert.match(grid, /<span class="rv-ev-missing">[^<]*shots\/a1\.png/);
  assert.equal((grid.match(/<img/g) || []).length > 0, true, 'the other image stays');
  assert.doesNotMatch(grid, /files\/1\/shots\/a1\.png"/);
  const stage = viewer(pack(), 'a1', { evidence: 0, missing: { 'shots/a1.png': true } });
  assert.match(stage, /rv-ev-missing/);
  assert.match(viewer(pack(), 'a1'), /data-rv-evfile="shots\/a1\.png"/);
  assert.match(app, /data-rv-evfile|rvEvfile/);
  assert.doesNotMatch(viewer(pack(), 'a1'), /onerror/);
});

test('RV3b fix 5: the zoom keys use the focused or the open stage', () => {
  assert.match(app, /function reviewActiveStage\(/);
  assert.doesNotMatch(app, /const stage = \$app\.querySelector\('\.rv-stage'\);/);
});

test('RV3b fix 6: a prototype key is not a verified state or a design result', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.match(verifiedBadgeHtml({ verifiedBy: key }, esc), /review-badge-none/, key);
    const html = summaryHeaderHtml(pack({ summary: { total: 1, agentVerified: 1, needsYou: 0, unmarked: 0, designPass: key } }), esc);
    assert.match(html, /Design pass: <b>not-run<\/b>/, key);
  }
});

test('the filter chip shows with a count of 0 when the pack has marked items', () => {
  const p = pack();
  p.items = p.items.filter((i) => i.verifiedBy !== 'needs-you');
  assert.match(nav(page(p)), /data-review-filter[^>]*>[\s\S]*<span class="num">0<\/span>/);
});
