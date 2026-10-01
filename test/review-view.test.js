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
  deliveryText, reviewDoneLineHtml,
} = review;
const { mailRowHtml } = await import('../public/mail-rows.js');
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
      proposedVerdict: 'accept-with-changes',
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
  const approved = packRowHtml(listPack({ state: 'submitted', verdict: 'accept' }), helpers());
  assert.match(approved, /review-chip review-chip-ok[^>]*>.*Accepted/);
  assert.doesNotMatch(approved, /role="img"/);
  assert.match(packRowHtml(listPack({ state: 'submitted', verdict: 'accept-with-changes' }), helpers()), /review-chip-warn[^>]*>.*Accepted with changes/);
  assert.match(packRowHtml(listPack({ state: 'submitted', verdict: 'deny' }), helpers()), /review-chip-crit[^>]*>.*Denied/);
  assert.match(packRowHtml(listPack({ state: 'submitted', verdict: 'request-changes' }), helpers()), /Request changes/, 'a result of an earlier build keeps its label');
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
  assert.match(page, /name="review-verdict" value="accept-with-changes" checked/, 'the proposed verdict is selected');
  assert.match(page, /Proposed/);
  assert.match(page, /value="accept"/);
  assert.match(page, /value="deny"/);
  for (const label of ['Accept pack', 'Accept with changes', 'Deny pack']) assert.match(page, new RegExp(`<b>${label}</b>`));
  assert.doesNotMatch(page, /value="comment"|value="approve"|value="request-changes"/);
  assert.match(page, /class="review-foot"[^>]*>.*1 open item.*Submit review/s);
  assert.match(page, /Too faint in dark\./, 'a note shows in the summary');
  assert.match(page, /Review now/);
});

test('the summary lists the states in the order denied, needs live check, notes, accepted, open', () => {
  const page = packPageHtml(fullPack(), {}, helpers());
  const order = ['Denied', 'Needs live check', 'Note only', 'Accepted', 'Open'].map((label) => page.indexOf(`<h3 class="review-sum-h">${label}`));
  assert.ok(order.every((at) => at > 0), 'each state has a block');
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  const flow = /<h3 class="review-sum-h">Needs live check[^]*?<\/ul>/.exec(page)[0];
  assert.match(flow, /Title flow-video/);
});

test('open items get a plain warning, and a changed item says it changed in this version', () => {
  const page = packPageHtml(fullPack(), {}, helpers());
  assert.match(page, /<p class="review-sum-warn"[^>]*>1 item has no decision<\/p>/);
  const open = /<h3 class="review-sum-h">Open[^]*?<\/ul>/.exec(page)[0];
  assert.match(open, /Title error-copy/);
  assert.match(open, /changed in this version/);
  const more = fullPack();
  more.items.push(item('extra-a', 'errors', 'open'), item('extra-b', 'errors', 'open'));
  assert.match(packPageHtml(more, {}, helpers()), /3 items have no decision/);
  const none = fullPack();
  none.items = none.items.filter((entry) => entry.state !== 'open');
  assert.doesNotMatch(packPageHtml(none, {}, helpers()), /have no decision|has no decision/);
});

test('every note in the summary is escaped, in the list, the pack note, and the read-only result', () => {
  const pack = fullPack({ note: EVIL });
  pack.items[0].answer.note = EVIL;
  pack.items[0].title = EVIL;
  pack.items[4].answer.note = EVIL;
  const open = packPageHtml(pack, {}, helpers());
  assert.ok(!open.includes('<img src=x'), 'no raw markup from a note or a title');
  assert.ok(open.includes(esc(EVIL)));
  const done = packPageHtml({ ...pack, state: 'submitted', verdict: 'deny', closedAt: '2026-09-30T09:00:00.000Z', delivery: { status: 'failed', attempts: 2, maxAttempts: 4, retry: true, error: EVIL } }, { result: { verdict: 'deny', note: EVIL } }, helpers());
  assert.ok(!done.includes('<img src=x'));
  assert.ok(done.includes(esc(EVIL)));
});

test('a chosen verdict stays chosen across a render, and a busy submit disables the button', () => {
  const page = packPageHtml(fullPack(), { verdict: 'deny', submitting: true, submitStatus: 'Sending…' }, helpers());
  assert.match(page, /value="deny" checked/);
  assert.doesNotMatch(page, /value="accept-with-changes" checked/);
  assert.match(page, /type="submit"[^>]*disabled[^>]*>Submit review/);
  assert.match(page, /role="status"[^>]*>Sending…/);
});

test('a submitted pack shows its result and no form', () => {
  const page = packPageHtml(fullPack({ state: 'submitted', closedAt: '2026-09-30T09:00:00.000Z' }), { verdict: 'accept', result: { verdict: 'accept-with-changes' } }, helpers());
  assert.doesNotMatch(page, /<textarea/);
  assert.doesNotMatch(page, /Submit review/);
  assert.match(page, /Submitted/);
  assert.match(page, /Accepted with changes/);
});

test('a submitted pack is a read-only summary: the decisions and notes, the result note, the delivery state, and no edit control', () => {
  const pack = fullPack({ state: 'submitted', verdict: 'accept-with-changes', note: 'Fix the dark cart.', closedAt: '2026-09-30T09:00:00.000Z', delivery: { status: 'sent', attempts: 1, maxAttempts: 4, retry: false, error: null } });
  const page = packPageHtml(pack, {}, helpers());
  assert.doesNotMatch(page, /<textarea|<input|<form|Submit review|Review now|review-foot/);
  assert.match(page, /Too faint in dark\./);
  assert.match(page, /<p class="review-result-note">Fix the dark cart\.<\/p>/);
  assert.match(page, /Accepted with changes/);
  assert.match(page, /1 item had no decision/);
  assert.match(page, /class="review-delivery"[^>]*data-state="sent"[^>]*>[^]*Delivered/);
  const expired = packPageHtml(fullPack({ state: 'expired' }), {}, helpers());
  assert.doesNotMatch(expired, /review-delivery|<textarea/);
});

test('the verdict chip of a result is not cut', () => {
  assert.match(css, /\.review-result \.review-chip \{[^}]*max-width: none/);
});

test('the delivery text names the state, the attempts, the retry, and the failure', () => {
  assert.equal(deliveryText(null), null);
  assert.deepEqual(deliveryText({ status: 'queued', attempts: 0 }), { state: 'queued', label: 'Queued', text: 'Waiting to send the result to the orchestrator.' });
  assert.deepEqual(deliveryText({ status: 'sent', attempts: 1 }), { state: 'sent', label: 'Delivered', text: 'The orchestrator got the result.' });
  assert.deepEqual(deliveryText({ status: 'sent', attempts: 3 }), { state: 'sent', label: 'Delivered', text: 'The orchestrator got the result after a retry. Attempts: 3.' });
  const retry = deliveryText({ status: 'failed', attempts: 2, maxAttempts: 4, retry: true, error: 'Herdr could not send the prompt.' });
  assert.equal(retry.state, 'retrying');
  assert.equal(retry.label, 'Retrying');
  assert.match(retry.text, /Attempt 2 of 4 failed: Herdr could not send the prompt\. Herdr Boss tries again\./);
  const failed = deliveryText({ status: 'failed', attempts: 4, maxAttempts: 4, retry: false, error: 'No pane.' });
  assert.equal(failed.state, 'failed');
  assert.match(failed.text, /Delivery failed after 4 attempts: No pane\. The result is stored\. The orchestrator can run herdr-boss review result\./);
  const lost = deliveryText({ status: 'error', error: 'The store is busy.' });
  assert.equal(lost.state, 'failed');
  assert.match(lost.text, /not queued/);
});

test('a closed review item in the Mailbox shows the result line and opens the submitted summary', () => {
  const closed = { kind: 'review', thread: 'shop', review: { slug: 'shop', pack: 'checkout-redesign', version: 1 }, closedAt: '2026-09-30T09:00:00.000Z', closedBy: 'owner', closeNote: 'review submitted',
    answer: { status: 'sent', sentAt: '2026-09-30T09:00:05.000Z', at: '2026-09-30T09:00:00.000Z' } };
  const line = reviewDoneLineHtml(closed, { esc, clock: () => '09:00', state: () => 'delivered 09:00' });
  assert.match(line, /Review submitted · 09:00 · delivered 09:00/);
  assert.match(line, /<a class="review-open" href="\/reviews\/shop\/checkout-redesign">Open review<\/a>/);
  assert.equal(reviewDoneLineHtml({ ...closed, closedBy: 'review', closeNote: undefined }, { esc, clock: () => '09:00', state: () => '' }), '', 'a replaced item has no result line');
  assert.match(app, /reviewDoneLineHtml\(item/, 'the Mailbox uses it for a closed review item');
  const row = mailRowHtml({ key: 'k', ids: ['m1'], unread: false, item: { ...closed, id: 'm1', from: 'orch', to: 'owner', at: '2026-09-30T08:00:00.000Z', title: 'Review: Checkout flow redesign (v1)', text: 'x', action: 'decide' } }, { esc, avatar: () => '', clock: () => '09:00', sender: () => 'Shop' });
  assert.match(row, /Review submitted/);
  assert.doesNotMatch(row, /answered elsewhere/);
});


test('the item route shows the item page with a way back to its row', () => {
  const page = packPageHtml(fullPack(), { item: 'flow-video' }, helpers());
  assert.equal((page.match(/<h1\b/g) || []).length, 1);
  assert.match(page, /<h1[^>]*>Title flow-video/);
  assert.match(page, /href="\/reviews\/shop\/checkout-redesign#item=flow-video"[^>]*aria-label="Back to the sections"/);
  assert.match(page, /Item 3 of 6<\/span> · Cart/, 'the place of the item in the pack and the section');
  assert.match(page, /class="review-page item-open"/);
  assert.match(page, /data-key="rv-item:flow-video"/, 'the item viewer fills the main pane');
  assert.match(page, /class="rv-answer"[^>]*data-key="rv-answer:flow-video"/, 'the answer bar replaces the submit bar');
  assert.doesNotMatch(page, /Submit review/);
  assert.doesNotMatch(page, /The item viewer is not ready yet/);
  assert.match(page, /<video /);
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

test('the menu has a Reviews entry after the Board, on the desktop bar and in the phone drawer', () => {
  assert.match(html, /data-nav="board">Board<\/a><a href="\/reviews" data-nav="reviews">Reviews<\/a><a href="\/agents"/);
  assert.match(app, /\['\/board', 'Board'\], \['\/reviews', 'Reviews'\], \['\/agents'/);
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
  const text = submitConfirmText(fullPack(), 'accept-with-changes');
  assert.equal(text, 'Submit the review of Checkout flow redesign, version 2?\n\nVerdict: Accept with changes\n2 accepted, 1 note only, 1 needs live check, 1 denied, 1 open.\n\nThe result goes to the project orchestrator.');
  assert.match(submitConfirmText(fullPack(), 'accept'), /Verdict: Accept pack\n/);
  assert.match(submitConfirmText(fullPack(), 'deny'), /Verdict: Deny pack\n/);
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
  assert.equal(ui.proposed, 'accept-with-changes');
  // An answer changes the pack state. The pinned proposal and the checked radio stay.
  const later = fullPack({ derived: { ...fullPack().derived, pack: 'accepted', proposedVerdict: 'accept' } });
  pinProposedVerdict(ui, later);
  assert.equal(ui.proposed, 'accept-with-changes');
  const page = packPageHtml(later, ui, helpers());
  assert.match(page, /value="accept-with-changes" checked/);
  assert.doesNotMatch(page, /value="accept" checked/);
  assert.match(page, /value="accept-with-changes" checked[^]*?Proposed/);
  // A new version pins the new proposal.
  pinProposedVerdict(ui, fullPack({ version: 3, derived: { ...later.derived } }));
  assert.equal(ui.proposed, 'accept');
  // The Owner's own choice wins over the proposal, and nothing forces the verdict.
  assert.match(packPageHtml(later, { ...ui, verdict: 'deny' }, helpers()), /value="deny" checked/);
  assert.equal(pinProposedVerdict({}, fullPack({ derived: { ...fullPack().derived, proposedVerdict: undefined } })).proposed, 'accept-with-changes');
});

// ---------- Legacy HTML page frame ----------

const { parseFrameMessage, frameOpenUrl, rawPageUrl, pinsInView, frameHeight, frameView } = review;
const frameWindow = { name: 'frame' };
const fromFrame = (data, source = frameWindow) => parseFrameMessage({ source, data }, frameWindow);
const READY = { hb: 1, type: 'ready', title: 'Invented shop', height: 1800, anchors: [{ id: 'top', kind: 'heading', text: 'Shop', top: 0 }, { id: 'hb-1', kind: 'image', text: 'One', top: 0.4 }] };

test('the frame message check accepts each known message of the frame protocol', () => {
  assert.deepEqual(fromFrame(READY), { type: 'ready', title: 'Invented shop', height: 1800, anchors: READY.anchors });
  assert.deepEqual(fromFrame({ hb: 1, type: 'pick', anchor: 'top', x: 0.25, y: 0.5, text: 'Shop' }), { type: 'pick', anchor: 'top', x: 0.25, y: 0.5, text: 'Shop' });
  assert.deepEqual(fromFrame({ hb: 1, type: 'pick', anchor: null, x: 0, y: 1, text: '' }), { type: 'pick', anchor: null, x: 0, y: 1, text: '' });
  assert.deepEqual(fromFrame({ hb: 1, type: 'scroll', top: 0.5 }), { type: 'scroll', top: 0.5 });
  assert.deepEqual(fromFrame({ hb: 1, type: 'open', url: 'https://example.test/shop' }), { type: 'open', url: 'https://example.test/shop' });
});

test('the frame message check refuses a message from another source, without hb 1, or of an unknown type', () => {
  assert.equal(fromFrame(READY, { name: 'other' }), null, 'wrong source');
  assert.equal(fromFrame(READY, null), null, 'no source');
  assert.equal(parseFrameMessage({ source: null, data: READY }, null), null, 'no frame window');
  assert.equal(parseFrameMessage(null, frameWindow), null);
  assert.equal(fromFrame({ ...READY, hb: 2 }), null, 'wrong hb');
  assert.equal(fromFrame({ ...READY, hb: '1' }), null, 'hb as text');
  const { hb, ...noHb } = READY;
  assert.equal(fromFrame(noHb), null, 'no hb');
  for (const type of ['pins', 'goto', 'place', 'PAGE', '', undefined, 5, '__proto__']) assert.equal(fromFrame({ hb: 1, type }), null, String(type));
  for (const data of [null, undefined, 'ready', 7, [READY], true]) assert.equal(fromFrame(data), null, String(data));
});

test('the frame message check refuses a string of more than 200 characters', () => {
  const long = 'x'.repeat(201);
  const ok = 'x'.repeat(200);
  assert.ok(fromFrame({ ...READY, title: ok }));
  assert.equal(fromFrame({ ...READY, title: long }), null, 'title');
  assert.equal(fromFrame({ ...READY, anchors: [{ id: long, kind: 'heading', text: 'a', top: 0 }] }), null, 'anchor id');
  assert.equal(fromFrame({ ...READY, anchors: [{ id: 'a', kind: 'heading', text: long, top: 0 }] }), null, 'anchor text');
  assert.equal(fromFrame({ hb: 1, type: 'pick', anchor: long, x: 0, y: 0, text: '' }), null, 'pick anchor');
  assert.equal(fromFrame({ hb: 1, type: 'pick', anchor: null, x: 0, y: 0, text: long }), null, 'pick text');
  assert.equal(fromFrame({ hb: 1, type: 'open', url: `https://example.test/${long}` }), null, 'open url');
});

test('the frame message check refuses more than 500 anchors and a bad shape', () => {
  const anchor = (index) => ({ id: `a${index}`, kind: 'heading', text: 'h', top: 0 });
  assert.ok(fromFrame({ ...READY, anchors: Array.from({ length: 500 }, (_, index) => anchor(index)) }), '500 anchors pass');
  assert.equal(fromFrame({ ...READY, anchors: Array.from({ length: 501 }, (_, index) => anchor(index)) }), null, '501 anchors');
  assert.equal(fromFrame({ ...READY, anchors: 'none' }), null);
  assert.equal(fromFrame({ ...READY, anchors: [null] }), null);
  assert.equal(fromFrame({ ...READY, anchors: [{ id: 'a', kind: 'link', text: 'h', top: 0 }] }), null, 'unknown kind');
  assert.equal(fromFrame({ ...READY, anchors: [{ id: '', kind: 'heading', text: 'h', top: 0 }] }), null, 'empty id');
  assert.equal(fromFrame({ ...READY, anchors: [{ id: 'a', kind: 'heading', text: 'h', top: 2 }] }), null, 'top above 1');
  assert.equal(fromFrame({ ...READY, anchors: [{ id: 'a', kind: 'heading', text: 7, top: 0 }] }), null, 'text as number');
  assert.equal(fromFrame({ ...READY, height: -1 }), null);
  assert.equal(fromFrame({ ...READY, height: NaN }), null);
  assert.equal(fromFrame({ ...READY, height: '100' }), null);
  assert.equal(fromFrame({ ...READY, title: 5 }), null);
  assert.equal(fromFrame({ hb: 1, type: 'pick', anchor: null, x: 1.5, y: 0, text: '' }), null, 'x above 1');
  assert.equal(fromFrame({ hb: 1, type: 'pick', anchor: null, x: 0, y: -0.1, text: '' }), null, 'y below 0');
  assert.equal(fromFrame({ hb: 1, type: 'pick', anchor: null, x: 0, y: 0 }), null, 'no text');
  assert.equal(fromFrame({ hb: 1, type: 'scroll', top: 'end' }), null);
  assert.equal(fromFrame({ hb: 1, type: 'open', url: '' }), null);
  assert.equal(fromFrame({ hb: 1, type: 'open', url: 5 }), null);
});

test('the frame message check returns only the known fields', () => {
  const message = fromFrame({ ...READY, evil: '<img src=x onerror=alert(1)>', anchors: [{ ...READY.anchors[0], html: '<b>' }] });
  assert.deepEqual(Object.keys(message).sort(), ['anchors', 'height', 'title', 'type']);
  assert.deepEqual(Object.keys(message.anchors[0]).sort(), ['id', 'kind', 'text', 'top']);
});

test('a link that the page asks to open shows only for an http or https URL', () => {
  assert.equal(frameOpenUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(frameOpenUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'mailto:a@example.test', '/local/path', '#hash', '//evil.test', '', 'https://', 'jav\tascript:alert(1)']) assert.equal(frameOpenUrl(url), null, url);
});

const PAGE_PACK = {
  slug: 'shop', pack: 'legacy', version: 1, state: 'open',
  manifest: { sections: [{ id: 'pages', title: 'Pages', items: [{ id: 'home', title: 'Home page', type: 'page', src: 'site/my page.html', ask: ['accept', 'deny', 'note'] }] }] },
  derived: { sections: [], counts: { items: 1, open: 1 } },
  items: [{ id: 'home', title: 'Home page', type: 'page', ask: ['accept', 'deny', 'note'], section: 'pages', state: 'open', answer: { pins: [{ n: 1, x: 0.5, y: 0.1 }, { n: 2, x: 0.5, y: 0.9 }] } }],
};

test('the page item renders a sandboxed frame with the exact attributes and no other sandbox flag', () => {
  const out = packPageHtml(PAGE_PACK, { item: 'home', viewer: { frame: { token: 'a'.repeat(64), status: 'ready', height: 3000, scrollTop: 0, title: 'Invented shop', anchors: [{ id: 'top', kind: 'heading', text: '<b>Shop</b>', top: 0 }] } } }, helpers());
  const tag = /<iframe[^>]*>/.exec(out)[0];
  assert.match(tag, / sandbox="allow-scripts"/);
  assert.match(tag, / referrerpolicy="no-referrer"/);
  assert.match(tag, / loading="lazy"/);
  assert.match(tag, / allow=""/);
  assert.ok(!/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|allow-modals|allow-downloads/.test(out));
  assert.ok(tag.includes(`data-src="/review-raw/${'a'.repeat(64)}/site/my%20page.html"`), 'the address has the token and the encoded path');
  assert.ok(!/ src="/.test(tag), 'page code sets src, so a render never reloads the page');
  assert.ok(!out.includes('no viewer for page'), 'the fallback line is gone');
  assert.ok(out.includes('Page outline'));
  assert.ok(out.includes('&lt;b&gt;Shop&lt;/b&gt;') && !out.includes('<b>Shop</b>'), 'an anchor text is escaped');
  assert.ok(out.includes('Add pin'));
  assert.ok(out.includes('In view: pin 1'), 'the pins in view');
  assert.ok(!out.includes('pin 2</'), 'a pin out of view is not listed');
});

test('the page item shows loading, an error with Try again, and a live link with its host name', () => {
  const view = (frame) => packPageHtml(PAGE_PACK, { item: 'home', viewer: { frame } }, helpers());
  const loading = view({ status: 'loading' });
  assert.ok(loading.includes('Loading the page.'));
  assert.ok(!loading.includes('<iframe class="rv-frame-el" data-key="rv-frame-el:home" data-rv-frame data-src="/'), 'no address without a token');
  const failed = view({ status: 'error', error: 'The page did not answer.' });
  assert.ok(failed.includes('The page did not answer.') && failed.includes('data-rv-frame-renew'));
  const link = view({ token: 'b'.repeat(64), status: 'ready', height: 400, openUrl: 'https://shop.example.test/cart?a=1&b=2' });
  assert.ok(link.includes('Open live link') && link.includes('<b>shop.example.test</b>'));
  assert.ok(link.includes('rel="noopener noreferrer"') && link.includes('target="_blank"'));
  assert.ok(link.includes('href="https://shop.example.test/cart?a=1&amp;b=2"'));
  const evil = view({ token: 'b'.repeat(64), status: 'ready', height: 400, openUrl: 'javascript:alert(1)' });
  assert.ok(!evil.includes('Open live link') && !evil.includes('javascript:'));
});

test('a closed pack shows the frame without the pin tool', () => {
  const out = packPageHtml({ ...PAGE_PACK, state: 'submitted' }, { item: 'home', viewer: { frame: { token: 'c'.repeat(64), status: 'ready', height: 400 } } }, helpers());
  assert.ok(out.includes('<iframe'));
  assert.ok(!out.includes('Add pin'));
});

test('the frame helpers compute the address, the height, and the pins in view', () => {
  assert.equal(rawPageUrl('t', 'a b/c#d.html'), '/review-raw/t/a%20b/c%23d.html');
  assert.equal(frameHeight({ height: 100 }), 240);
  assert.equal(frameHeight({ height: 400 }), 400);
  assert.equal(frameHeight({ height: 5000 }), 720);
  assert.equal(frameHeight({}), 480);
  assert.equal(frameView({ height: 1440 }), 0.5);
  assert.equal(frameView({ height: 300 }), 1, 'a page that fits shows whole');
  assert.equal(frameView({}), 1);
  const pins = [{ n: 1, y: 0.05 }, { n: 2, y: 0.5 }, { n: 3, y: 0.95 }];
  assert.deepEqual(pinsInView(pins, 0, 0.3), [1]);
  assert.deepEqual(pinsInView(pins, 0.4, 0.3), [2]);
  assert.deepEqual(pinsInView(pins, 0, 1), [1, 2, 3]);
  assert.deepEqual(pinsInView(undefined, 0, 1), []);
});

test('the dashboard wires the frame through the checked message path only', () => {
  assert.match(app, /window\.addEventListener\('message'/);
  assert.match(app, /parseFrameMessage\(event, el\?\.contentWindow\)/);
  assert.ok(!/allow-same-origin/.test(app + fs.readFileSync(new URL('../public/review.js', import.meta.url), 'utf8')));
});

test('a pick sets an anchor only from the last ready message and cuts or drops the text', () => {
  const { pickPinFields, looksSecret } = review;
  const anchors = [{ id: 'top' }, { id: 'hb-1' }];
  assert.deepEqual(pickPinFields({ anchor: 'top', text: 'Shop' }, anchors), { anchor: 'top', text: 'Shop' });
  assert.deepEqual(pickPinFields({ anchor: 'forged', text: '' }, anchors), {}, 'an unknown anchor');
  assert.deepEqual(pickPinFields({ anchor: 'top', text: 'x' }, undefined), { text: 'x' }, 'no ready message');
  assert.equal(pickPinFields({ anchor: null, text: 'y'.repeat(300) }, anchors).text.length, 200);
  for (const text of ['Bearer abc123', 'token: abc', 'sk-abcdef', 'password = "x"']) {
    assert.ok(looksSecret(text), text);
    assert.deepEqual(pickPinFields({ anchor: null, text }, anchors), {}, text);
  }
});
