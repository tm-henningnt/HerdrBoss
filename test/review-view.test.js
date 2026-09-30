// The reviewer pages: the pack list, the section list, the progress bar, and the Mailbox entry.
// public/review.js has no DOM use, so the tests import it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find, byKey } from './fake-dom.js';

const review = await import('../public/review.js');
const {
  REVIEW_STATES, parseReviewPath, reviewItemFromHash, reviewUrl, progressText, progressBarHtml, packRowHtml, packListHtml,
  packPageHtml, itemChip, reviewKeyAction, reviewOpenLinkHtml, sectionProgress, reviewErrorText, submitConfirmText, pinProposedVerdict,
} = review;
const { mailActionBarHtml } = await import('../public/mail-bar.js');
const { patchHtml } = await import('../public/keyed.js');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = (extra = {}) => ({
  esc,
  icon: (name) => `<svg data-icon="${name}"></svg>`,
  avatar: (slug) => `<span class="avatar" data-slug="${esc(slug)}"></span>`,
  projectLabel: (slug) => (slug === 'shop' ? 'Shop' : slug),
  time: () => '08:12',
  menuButton: '<button data-app-drawer>Menu</button>',
  ...extra,
});

const EVIL = '<img src=x onerror=alert(1)>"\'&';
const counts = (over = {}) => ({ items: 31, accepted: 14, denied: 1, live: 1, noteOnly: 2, open: 13, ...over });

function listPack(over = {}) {
  return { slug: 'shop', pack: 'checkout-redesign', title: 'Checkout flow redesign', version: 2, state: 'open', updatedAt: '2026-09-30T08:12:00.000Z', verdict: null, counts: counts(), packState: 'denied', stale: 0, ...over };
}

function item(id, section, state, over = {}) {
  return { id, section, title: `Title ${id}`, type: 'image', ask: ['accept', 'deny', 'note'], state, stale: false, answer: null, ...over };
}

function fullPack(over = {}) {
  const items = [
    item('cart-themes', 'cart', 'denied', { type: 'image-pair', answer: { decision: 'deny', note: 'Too faint in dark.', viewed: true, rev: 2 } }),
    item('pay-button', 'cart', 'answered', { ask: ['choice', 'note'], answer: { choice: 'b', note: '', viewed: true, rev: 1 } }),
    item('flow-video', 'cart', 'live', { type: 'video', ask: ['accept', 'deny', 'live'], answer: { live: 'pending', note: '', viewed: false, rev: 1 } }),
    item('error-copy', 'errors', 'open', { type: 'table', stale: true, answer: { decision: 'accept', note: '', viewed: true, stale: true, rev: 3 } }),
    item('release-notes', 'errors', 'note', { type: 'markdown', ask: ['note'], answer: { note: 'Fine.', viewed: true, rev: 1 } }),
    item('a11y', 'errors', 'accepted', { type: 'checklist', answer: { decision: 'accept', note: '', viewed: true, rev: 1 } }),
  ];
  return {
    slug: 'shop', pack: 'checkout-redesign', title: 'Checkout flow redesign', version: 2, currentVersion: 2, state: 'open', note: 'Fix the dark cart.', noteRev: 4,
    updatedAt: '2026-09-30T08:12:00.000Z', closedAt: null,
    manifest: { sections: [
      { id: 'cart', title: 'Cart', items: [{ id: 'pay-button', choices: [{ id: 'a', label: 'Keep before' }, { id: 'b', label: 'Use after' }] }] },
      { id: 'errors', title: 'Error handling', items: [] },
    ] },
    items,
    removed: [],
    derived: {
      sections: [{ id: 'cart', title: 'Cart', state: 'denied' }, { id: 'errors', title: 'Error handling', state: 'open' }],
      pack: 'denied',
      counts: { items: 6, accepted: 2, denied: 1, live: 1, noteOnly: 1, open: 1 },
      proposedVerdict: 'request-changes',
    },
    ...over,
  };
}

function setup(markup) {
  globalThis.document = createDocument();
  return document.html(markup);
}

// ---------- Routes ----------

test('the review routes parse into a view, and a bad part gives no pack', () => {
  assert.deepEqual(parseReviewPath('/reviews'), { view: 'list' });
  assert.deepEqual(parseReviewPath('/reviews/'), { view: 'list' });
  assert.deepEqual(parseReviewPath('/reviews/shop/checkout-redesign'), { view: 'pack', slug: 'shop', pack: 'checkout-redesign' });
  assert.deepEqual(parseReviewPath('/reviews/shop/checkout-redesign/cart-themes'), { view: 'item', slug: 'shop', pack: 'checkout-redesign', item: 'cart-themes' });
  assert.deepEqual(parseReviewPath('/reviews/shop/checkout-redesign/summary'), { view: 'summary', slug: 'shop', pack: 'checkout-redesign' });
  assert.deepEqual(parseReviewPath('/reviews/Shop/x'), { view: 'missing' });
  assert.deepEqual(parseReviewPath('/reviews/shop'), { view: 'missing' });
  assert.deepEqual(parseReviewPath('/reviews/a/b/c/d'), { view: 'missing' });
  assert.deepEqual(parseReviewPath('/reviews/shop/%3Cx%3E'), { view: 'missing' });
  assert.equal(parseReviewPath('/mailbox'), null);
  assert.equal(parseReviewPath('/reviewsx'), null);
});

test('the item hash contract is #item=<id>, and the item route is the pack route plus the item id', () => {
  assert.equal(reviewItemFromHash('#item=cart-themes'), 'cart-themes');
  assert.equal(reviewItemFromHash('#item=Bad%20Id'), null);
  assert.equal(reviewItemFromHash('#other'), null);
  assert.equal(reviewItemFromHash(''), null);
  assert.equal(reviewUrl('shop', 'checkout-redesign'), '/reviews/shop/checkout-redesign');
  assert.equal(reviewUrl('shop', 'checkout-redesign', 'cart-themes'), '/reviews/shop/checkout-redesign/cart-themes');
  assert.equal(reviewUrl('a b', 'c/d'), '/reviews/a%20b/c%2Fd');
});

// ---------- Progress ----------

test('the progress bar has the fixed state order, 5 tones, and a text alternative', () => {
  assert.deepEqual(REVIEW_STATES.map((s) => s.key), ['accepted', 'note', 'live', 'denied', 'open']);
  assert.deepEqual(REVIEW_STATES.map((s) => s.tone), ['ok', 'info', 'warn', 'crit', 'open']);
  assert.equal(progressText(counts()), '14 accepted, 2 note only, 1 needs live check, 1 denied, 13 open');
  const bar = progressBarHtml(counts(), { esc, legend: true });
  const root = setup(bar);
  const img = find(root, (el) => el.getAttribute('role') === 'img');
  assert.equal(img.getAttribute('aria-label'), '18 of 31 items answered: 14 accepted, 2 note only, 1 needs live check, 1 denied, 13 open');
  const tones = [...bar.matchAll(/review-seg review-seg-(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tones, ['ok', 'info', 'warn', 'crit', 'open'], 'the segments follow the fixed order');
  assert.match(bar, /style="flex: 14 1 0"/);
  assert.match(bar, /Needs live check <b class="num">1<\/b>/, 'the legend names each state with its count');
});

test('the progress bar leaves out an empty segment but keeps it in the legend', () => {
  const bar = progressBarHtml(counts({ accepted: 0, noteOnly: 0, live: 0, denied: 0, open: 31 }), { esc, legend: true });
  assert.deepEqual([...bar.matchAll(/review-seg review-seg-(\w+)/g)].map((m) => m[1]), ['open']);
  assert.match(bar, /Accepted <b class="num">0<\/b>/);
  const small = progressBarHtml(counts(), { esc });
  assert.doesNotMatch(small, /review-legend/, 'a list row has no legend');
});

test('the Denied segment has a hatch, so it differs from Needs live check without color', () => {
  assert.match(css, /\.review-seg-crit \{[^}]*repeating-linear-gradient/);
  assert.match(css, /\.review-bar \{[^}]*gap: 2px/);
  for (const tone of ['ok', 'info', 'warn']) assert.match(css, new RegExp(`\\.review-seg-${tone} \\{ background: var\\(--${tone}\\)`));
  assert.match(css, /\.review-seg-open \{ background: var\(--line\)/);
});

test('the section progress counts the items that are not open', () => {
  const pack = fullPack();
  assert.deepEqual(sectionProgress(pack, 'cart'), { answered: 3, total: 3 });
  assert.deepEqual(sectionProgress(pack, 'errors'), { answered: 2, total: 3 });
});

// ---------- Pack list ----------

test('a pack row shows the project, the version, the count, the bar, and the time', () => {
  const row = packRowHtml(listPack({ stale: 3 }), helpers());
  assert.match(row, /href="\/reviews\/shop\/checkout-redesign"/);
  assert.match(row, /data-key="review-pack:shop\/checkout-redesign"/);
  assert.match(row, /Checkout flow redesign/);
  assert.match(row, />Shop</, 'the project chip names the project');
  assert.match(row, /v2/);
  assert.match(row, /18 of 31 items answered/);
  assert.match(row, /08:12/);
  assert.match(row, /3 changed/, 'the stale marker');
  assert.doesNotMatch(packRowHtml(listPack(), helpers()), /changed/);
});

test('a done pack row shows its verdict chip and no progress bar', () => {
  const approved = packRowHtml(listPack({ state: 'submitted', verdict: 'approve' }), helpers());
  assert.match(approved, /review-chip review-chip-ok[^>]*>.*Approved/);
  assert.doesNotMatch(approved, /role="img"/);
  assert.match(packRowHtml(listPack({ state: 'submitted', verdict: 'request-changes' }), helpers()), /review-chip-crit[^>]*>.*Changes requested/);
  assert.match(packRowHtml(listPack({ state: 'submitted', verdict: 'comment' }), helpers()), /review-chip-info[^>]*>.*Commented/);
  assert.match(packRowHtml(listPack({ state: 'expired' }), helpers()), /Expired/);
});

test('the pack list has one h1, the Open and Done folders, and plain empty and error states', () => {
  const view = packListHtml({ folder: 'open', open: [listPack()], done: [], error: '' }, helpers());
  assert.equal((view.match(/<h1\b/g) || []).length, 1);
  assert.match(view, /<h1[^>]*>Reviews/);
  assert.match(view, /href="\/reviews\?folder=open"[^>]*aria-current="page"/);
  assert.match(view, /href="\/reviews\?folder=done"/);
  assert.match(view, /data-app-drawer/, 'the phone menu button');
  assert.match(packListHtml({ folder: 'open', open: [], done: [], error: '' }, helpers()), /No review waits for you\./);
  assert.match(packListHtml({ folder: 'done', open: [], done: [], error: '' }, helpers()), /No finished reviews\./);
  assert.match(packListHtml({ folder: 'open', open: null, done: null, error: '' }, helpers()), /Loading reviews/);
  const failed = packListHtml({ folder: 'open', open: null, done: null, error: 'The server stopped.' }, helpers());
  assert.match(failed, /role="alert"/);
  assert.match(failed, /The reviews could not load\. The server stopped\./);
  assert.match(failed, /data-review-retry/);
});

test('every interpolated value in the pack list is escaped', () => {
  const view = packListHtml({ folder: 'open', open: [listPack({ title: EVIL, slug: 'shop', pack: 'p' })], done: [], error: EVIL }, helpers({ projectLabel: () => EVIL, time: () => EVIL }));
  assert.doesNotMatch(view, /<img src=x/);
  assert.doesNotMatch(view, /"'&[^a#]/);
  assert.match(view, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
});

// ---------- Section list ----------

test('the pack page lists each section with its state and progress, and each item row links to its route', () => {
  const page = packPageHtml(fullPack(), {}, helpers());
  assert.equal((page.match(/<h1\b/g) || []).length, 1);
  assert.match(page, /<h1[^>]*>.*Checkout flow redesign/s);
  assert.match(page, /href="\/reviews" [^>]*aria-label="Back to Reviews"/);
  assert.match(page, /data-key="review-sec:cart"/);
  assert.match(page, /data-key="review-sec:errors"/);
  const root = setup(page);
  const cart = byKey(root, 'review-sec:cart');
  assert.ok(cart);
  assert.match(page, /data-key="review-sec:cart"[^>]*>.*?review-chip-crit[^>]*>.*?Denied.*?3 \/ 3/s);
  assert.match(page, /data-key="review-sec:errors"[^>]*>.*?review-chip-open[^>]*>.*?Open.*?2 \/ 3/s);
  const row = byKey(root, 'review-item:cart-themes');
  assert.equal(row.getAttribute('href'), '/reviews/shop/checkout-redesign/cart-themes');
  assert.equal(row.getAttribute('data-review-row'), 'cart-themes');
});

test('each item shows its derived state as a chip with a word', () => {
  const pack = fullPack();
  const chip = (id) => itemChip(pack.items.find((entry) => entry.id === id), pack);
  assert.deepEqual(chip('cart-themes'), { tone: 'crit', label: 'Denied', icon: 'close' });
  assert.deepEqual(chip('pay-button'), { tone: 'ok', label: 'Use after', icon: 'check' }, 'a choice shows the chosen label');
  assert.deepEqual(chip('flow-video'), { tone: 'warn', label: 'Live check', icon: 'live' });
  assert.deepEqual(chip('error-copy'), { tone: 'changed', label: 'Changed', icon: 'changed' }, 'a stale item shows Changed');
  assert.deepEqual(chip('release-notes'), { tone: 'info', label: 'Note', icon: 'note' });
  assert.deepEqual(chip('a11y'), { tone: 'ok', label: 'Accepted', icon: 'check' });
  assert.deepEqual(itemChip(item('x', 'cart', 'answered', { answer: { rating: 4 } }), pack), { tone: 'ok', label: 'Rated 4', icon: 'check' });
  assert.deepEqual(itemChip(item('x', 'cart', 'open'), pack), { tone: 'open', label: 'Open', icon: '' });
});

test('an item row tells viewed in words, and a viewed and answered row is short', () => {
  const page = packPageHtml(fullPack(), {}, helpers());
  const root = setup(page);
  const done = byKey(root, 'review-item:a11y');
  assert.match(done.getAttribute('class'), /review-item-done/);
  const live = byKey(root, 'review-item:flow-video');
  assert.doesNotMatch(live.getAttribute('class'), /review-item-done/);
  assert.match(page, /data-key="review-item:a11y".*?Viewed/s);
  assert.match(page, /data-key="review-item:flow-video".*?Not viewed/s);
});

test('the current item of the hash is marked, so Back from an item keeps the place', () => {
  const page = packPageHtml(fullPack(), { current: 'error-copy' }, helpers());
  const root = setup(page);
  assert.equal(byKey(root, 'review-item:error-copy').getAttribute('aria-current'), 'true');
  assert.equal(byKey(root, 'review-item:cart-themes').getAttribute('aria-current'), null);
});

test('the pack page ends with the summary of decisions, the pack note, the verdict, and the Submit bar', () => {
  const page = packPageHtml(fullPack(), { note: 'Fix the dark cart.' }, helpers());
  assert.match(page, /id="review-submit"/);
  assert.match(page, /<textarea id="review-note"[^>]*maxlength="2000"[^>]*>Fix the dark cart\.<\/textarea>/);
  assert.match(page, /name="review-verdict" value="request-changes" checked/, 'the proposed verdict is selected');
  assert.match(page, /Proposed/);
  assert.match(page, /value="approve"/);
  assert.match(page, /value="comment"/);
  assert.match(page, /class="review-foot"[^>]*>.*1 open item.*Submit review/s);
  // The summary lists the open items first, then the other states with their notes.
  const order = ['Open', 'Denied', 'Needs live check', 'Note only', 'Accepted'].map((label) => page.indexOf(`<h3 class="review-sum-h">${label}`));
  assert.ok(order.every((at) => at > 0), 'each state has a block');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(page, /Too faint in dark\./, 'a note shows in the summary');
  assert.match(page, /Review now/);
});

test('a chosen verdict stays chosen across a render, and a busy submit disables the button', () => {
  const page = packPageHtml(fullPack(), { verdict: 'comment', submitting: true, submitStatus: 'Sending…' }, helpers());
  assert.match(page, /value="comment" checked/);
  assert.doesNotMatch(page, /value="request-changes" checked/);
  assert.match(page, /type="submit"[^>]*disabled[^>]*>Submit review/);
  assert.match(page, /role="status"[^>]*>Sending…/);
});

test('a submitted pack shows its result and no form', () => {
  const page = packPageHtml(fullPack({ state: 'submitted', closedAt: '2026-09-30T09:00:00.000Z' }), { verdict: 'approve', result: { verdict: 'request-changes' } }, helpers());
  assert.doesNotMatch(page, /<textarea/);
  assert.doesNotMatch(page, /Submit review/);
  assert.match(page, /Submitted/);
  assert.match(page, /Changes requested/);
});

test('the item route shows the item page with a way back to its row', () => {
  const page = packPageHtml(fullPack(), { item: 'flow-video' }, helpers());
  assert.equal((page.match(/<h1\b/g) || []).length, 1);
  assert.match(page, /<h1[^>]*>Title flow-video/);
  assert.match(page, /href="\/reviews\/shop\/checkout-redesign#item=flow-video"[^>]*aria-label="Back to the sections"/);
  assert.match(page, /3 \/ 6/, 'the place of the item in the pack');
  assert.match(page, /class="review-page item-open"/);
  assert.match(packPageHtml(fullPack(), { item: 'no-such-item' }, helpers()), /This item is not in the pack\./);
});

test('every interpolated value in the pack page is escaped', () => {
  const pack = fullPack({ title: EVIL, note: EVIL });
  pack.items[0].title = EVIL;
  pack.items[0].answer.note = EVIL;
  pack.derived.sections[0].title = EVIL;
  pack.manifest.sections[0].items[0].choices[1].label = EVIL;
  for (const ui of [{ note: EVIL, submitStatus: EVIL, noteStatus: EVIL }, { item: 'cart-themes' }]) {
    const page = packPageHtml(pack, ui, helpers());
    assert.doesNotMatch(page, /<img src=x/);
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
});

test('a keyed update keeps the note field, its text, and an open section fold', () => {
  const pack = fullPack();
  const root = setup(`<main>${packPageHtml(pack, { note: 'Fix' }, helpers())}</main>`);
  const main = root.firstChild;
  const note = find(main, (el) => el.getAttribute('id') === 'review-note');
  note.focus();
  note.value = 'Fix the dark cart, then ship.';
  const section = byKey(main, 'review-sec:errors');
  section.removeAttribute('open');
  const next = fullPack();
  next.items[5].state = 'accepted';
  patchHtml(main, packPageHtml(next, { note: 'Fix' }, helpers()));
  assert.equal(find(main, (el) => el.getAttribute('id') === 'review-note'), note, 'the same field node');
  assert.equal(note.value, 'Fix the dark cart, then ship.', 'the typed text stays');
  assert.equal(document.activeElement, note, 'the focus stays');
  assert.equal(byKey(main, 'review-sec:errors'), section);
  assert.equal(section.getAttribute('open'), null, 'the Owner closed the fold, and it stays closed');
});

// ---------- Keys ----------

test('the list keys follow the Gmail set, and a text field takes every key except Esc', () => {
  assert.equal(reviewKeyAction({ key: 'j' }), 'next');
  assert.equal(reviewKeyAction({ key: 'k' }), 'prev');
  assert.equal(reviewKeyAction({ key: 'J', shiftKey: true }), 'next-section');
  assert.equal(reviewKeyAction({ key: 'K', shiftKey: true }), 'prev-section');
  assert.equal(reviewKeyAction({ key: 'u' }), 'back');
  assert.equal(reviewKeyAction({ key: 'Escape' }), 'back');
  assert.equal(reviewKeyAction({ key: 's' }), 'summary');
  assert.equal(reviewKeyAction({ key: '?', shiftKey: true }), 'help');
  assert.equal(reviewKeyAction({ key: 'x' }), null);
  assert.equal(reviewKeyAction({ key: 'j', ctrlKey: true }), null);
  assert.equal(reviewKeyAction({ key: 'j', metaKey: true }), null);
  assert.equal(reviewKeyAction({ key: 'j', altKey: true }), null);
  assert.equal(reviewKeyAction({ key: 'j', inField: true }), null);
  assert.equal(reviewKeyAction({ key: 's', inField: true }), null);
  assert.equal(reviewKeyAction({ key: 'Escape', inField: true }), 'leave-field');
});

// ---------- Menu entry and Mailbox button ----------

test('the menu has a Reviews entry after the Mailbox, on the desktop bar and in the phone drawer', () => {
  assert.match(html, /data-nav="mailbox">Mailbox.*?<\/a><a href="\/reviews" data-nav="reviews">Reviews<\/a><a href="\/chat"/);
  assert.match(app, /\['\/mailbox', 'Mailbox', counts\['needs-action'\]\], \['\/reviews', 'Reviews'\]/);
  assert.match(app, /NAV_LABEL = \{[^}]*reviews: 'Reviews'/);
  assert.match(app, /reviews: \['Reviews', `/, 'the page help');
  assert.match(fs.readFileSync(new URL('../public/app-view.js', import.meta.url), 'utf8'), /'reviews'/, 'the reviews page is a phone app view');
});

test('a review item in the Mailbox opens the pack with Open review instead of the answer form', () => {
  const item = { id: 'm1', kind: 'review', action: 'decide', review: { slug: 'shop', pack: 'checkout-redesign', version: 2 } };
  const link = reviewOpenLinkHtml(item, esc);
  assert.match(link, /<a class="review-open" href="\/reviews\/shop\/checkout-redesign">Open review<\/a>/);
  assert.equal(reviewOpenLinkHtml({ id: 'm2', kind: 'reply', action: 'decide' }, esc), '');
  assert.equal(reviewOpenLinkHtml({ id: 'm3', kind: 'review', review: { slug: '../x', pack: 'p' } }, esc), '', 'a bad slug gives no link');
  const bar = mailActionBarHtml(item, { esc, icon: (name) => `<svg data-icon="${name}"></svg>` });
  assert.match(bar, /Open review/);
  assert.doesNotMatch(bar, /<textarea/, 'the phone bar has no answer field');
  assert.match(app, /item\.kind === 'review' \? reviewOpenLinkHtml\(item, esc\)/, 'the desktop thread shows the link in the message');
});

// ---------- Layout rules ----------

test('the review page has 44 px targets, 16 px fields, a split view on the desktop, and no motion when reduced', () => {
  assert.match(css, /\.review-row \{[^}]*min-height: 44px/);
  assert.match(css, /\.review-item \{[^}]*min-height: 44px/);
  assert.match(css, /\.review-note-field \{[^}]*font-size: 16px/);
  assert.match(css, /@media \(min-width: 900px\) \{[^@]*\.review-body \{[^}]*grid-template-columns: 300px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.review-/);
});

// ---------- Review fixes: confirm, error text, fixed proposed verdict ----------

test('the submit confirm names the pack, the version, the verdict, and each count', () => {
  const text = submitConfirmText(fullPack(), 'request-changes');
  assert.equal(text, 'Submit the review of Checkout flow redesign, version 2?\n\nVerdict: Request changes\n2 accepted, 1 note only, 1 needs live check, 1 denied, 1 open.\n\nThe result goes to the project orchestrator.');
  assert.match(submitConfirmText(fullPack(), 'approve'), /Verdict: Approve\n/);
  assert.match(submitConfirmText(fullPack(), 'comment'), /Verdict: Comment\n/);
});

test('the app asks for the confirm before the submit request and keeps the button disabled while it runs', () => {
  const body = /\nasync function submitReview\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(body, 'the UI defines submitReview');
  const ask = body.indexOf('confirm(submitConfirmText(');
  assert.ok(ask > 0, 'the submit asks for a confirm');
  assert.ok(ask < body.indexOf('ui.submitting = true'), 'the confirm comes before the busy state');
  assert.ok(body.indexOf('ui.submitting = true') < body.indexOf("method: 'POST'"), 'the button is disabled before the request');
  assert.match(body, /error\.status === 409 && error\.body\?\.result/, 'a repeat submit shows the stored result');
});

test('a failed request gets a plain sentence, and the API sentence stays when the body has one', () => {
  assert.equal(reviewErrorText({ network: true }), 'The service is not reachable. It may be restarting. Try again in a moment.');
  assert.equal(reviewErrorText({ status: 401, body: {} }), 'Sign in again.');
  assert.equal(reviewErrorText({ status: 403, body: {} }), 'The service refused the request.');
  assert.equal(reviewErrorText({ status: 413, body: {} }), 'The text is too large.');
  assert.equal(reviewErrorText({ status: 429, body: {} }), 'Too many requests. Wait a minute and try again.');
  assert.equal(reviewErrorText({ status: 500, body: {} }), 'The service reported an error.');
  assert.equal(reviewErrorText({ status: 503, body: null }), 'The service reported an error.');
  assert.equal(reviewErrorText({ status: 404, body: {} }), 'The request failed.');
  assert.equal(reviewErrorText({ status: 403, body: { error: 'This read-only preview does not allow changes.' } }), 'This read-only preview does not allow changes.');
  assert.equal(reviewErrorText({ status: 413, body: { error: 'The body is larger than 16384 bytes.' } }), 'The body is larger than 16384 bytes.');
  assert.equal(reviewErrorText({ status: 500, body: { error: 42 } }), 'The service reported an error.', 'an error that is not text is not shown');
});

test('reviewFetch never shows the network-layer text', () => {
  const body = /\nasync function reviewFetch\(url, options\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(body, 'the UI defines reviewFetch');
  assert.match(body, /catch \{[^}]*reviewErrorText\(\{ network: true \}\)/);
  assert.match(body, /reviewErrorText\(\{ status: response\.status, body \}\)/);
  assert.doesNotMatch(body, /The server answered/);
});

test('the proposed verdict is fixed at the first render of a version, so the selection never moves without a click', () => {
  const ui = {};
  const pack = fullPack();
  pinProposedVerdict(ui, pack);
  assert.equal(ui.proposed, 'request-changes');
  // An answer changes the pack state. The pinned proposal and the checked radio stay.
  const later = fullPack({ derived: { ...fullPack().derived, pack: 'accepted', proposedVerdict: 'approve' } });
  pinProposedVerdict(ui, later);
  assert.equal(ui.proposed, 'request-changes');
  const page = packPageHtml(later, ui, helpers());
  assert.match(page, /value="request-changes" checked/);
  assert.doesNotMatch(page, /value="approve" checked/);
  assert.match(page, /value="request-changes" checked[^]*?Proposed/);
  // A new version pins the new proposal.
  pinProposedVerdict(ui, fullPack({ version: 3, derived: { ...later.derived } }));
  assert.equal(ui.proposed, 'approve');
  // The Owner's own choice wins over the proposal.
  assert.match(packPageHtml(later, { ...ui, verdict: 'comment' }, helpers()), /value="comment" checked/);
});
