// The autosave queue of the review pages: coalesce, serialize, backoff, persistence, restore, retarget by item hash,
// the conflict paths, the stop on 401, the drop on 400 and 413, the note debounce, the status texts, and the submit lock.
// The tests use a fake fetch, fake timers, and a fake localStorage. The last tests run the queue against the real
// server and store in a temporary data dir: a retry with the same opId after a lost response applies once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-sync-data-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-sync-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ assertTempDataDir }, { serve }, { loadConfig }, store, { openSqliteStore }, sync] = await Promise.all([
  import('../src/data-dir-guard.js'),
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/review-store.js'),
  import('../src/sqlite-store.js'),
  import('../public/review-sync.js'),
]);
const {
  createReviewSync, createDrafts, backoffMs, coalesce, queueKey, QUEUE_LIMIT_BYTES, NOTE_DEBOUNCE_MS,
  syncStatusText, syncStatusHtml, packStatusHtml, submitLock,
} = sync;
assertTempDataDir(dataDir);

const roots = [dataDir, homeDir];
test.after(() => {
  openSqliteStore({ dir: dataDir }).close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---------- Fakes ----------

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    // Run the timers that are due within `ms`, in time order.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
    },
  };
}

function fakeStorage({ throwOnGet = false, throwOnSet = null } = {}) {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem(key) { if (throwOnGet) throw new Error('SecurityError'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (throwOnSet) throw throwOnSet;
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
  };
}

// A scripted fetch. Each call takes the next reply: a number (status with a body), an Error (network), or a function.
function fakeFetch(replies = []) {
  const calls = [];
  const queue = [...replies];
  let fallback = null;
  const fn = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    let reply = queue.length ? queue.shift() : fallback;
    if (typeof reply === 'function') reply = await reply({ url, method: options.method || 'GET', body });
    if (reply instanceof Error) throw reply;
    if (!reply) reply = { status: 200, body: okBody(url, options.method || 'GET', body) };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  fn.calls = calls;
  fn.push = (...more) => queue.push(...more);
  fn.otherwise = (reply) => { fallback = reply; };
  return fn;
}

// The server answer of a successful write: the rev moves by one.
function okBody(url, method, body) {
  if (method === 'GET') return { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [] };
  if (/\/note$/.test(url)) return { ok: true, note: body.note, rev: body.rev + 1 };
  return { ok: true, answer: { ...body, opId: undefined, rev: (body?.rev ?? 0) + 1 } };
}

const escText = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function drain(times = 8) { for (let i = 0; i < times; i += 1) await settle(); }

const ROUTE = { slug: 'shop', pack: 'checkout', version: 1 };
const KEY = 'shop/checkout';

function setup({ replies = [], storage = fakeStorage(), ids } = {}) {
  const timers = fakeTimers();
  const fetch = fakeFetch(replies);
  let n = 0;
  const events = [];
  const queue = createReviewSync({
    fetch, storage, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    makeId: ids || (() => { n += 1; return `op-${n}`; }),
    onChange: () => {},
    onSaved: (event) => events.push(event),
  });
  return { queue, fetch, timers, storage, events };
}

const itemWrite = (item, patch, extra = {}) => ({ ...ROUTE, kind: 'item', item, hash: `h-${item}`, rev: 0, patch, ...extra });

// ---------- Pure parts ----------

test('the backoff waits 2, 4, 8, and 16 seconds, then 30 seconds for each later try', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 12].map(backoffMs), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(backoffMs(0), 2000);
});

test('coalesce merges a write into the last unsent write of the same field set and keeps a sent write apart', () => {
  let ops = coalesce([], { id: 'item:a', kind: 'item', item: 'a', patch: { decision: 'accept' }, rev: 3, opId: 'op-1', sent: false });
  ops = coalesce(ops, { id: 'item:a', kind: 'item', item: 'a', patch: { note: 'Fix it.' }, rev: 3, opId: 'op-2', sent: false });
  ops = coalesce(ops, { id: 'item:b', kind: 'item', item: 'b', patch: { viewed: true }, rev: 0, opId: 'op-3', sent: false });
  ops = coalesce(ops, { id: 'item:a', kind: 'item', item: 'a', patch: { decision: 'deny' }, rev: 3, opId: 'op-4', sent: false });
  assert.equal(ops.length, 2, 'one write for each item');
  assert.deepEqual(ops[0].patch, { decision: 'deny', note: 'Fix it.' }, 'the latest value of each field');
  assert.equal(ops[0].opId, 'op-4', 'a changed patch gets the new opId');
  assert.equal(ops[0].rev, 3, 'the base rev stays');

  // A write that went out once keeps its patch and opId: its retry must match what the server may have applied.
  ops[0].sent = true;
  ops = coalesce(ops, { id: 'item:a', kind: 'item', item: 'a', patch: { decision: 'accept' }, rev: 3, opId: 'op-5', sent: false });
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0].patch, { decision: 'deny', note: 'Fix it.' });
  assert.equal(ops[0].opId, 'op-4');
  assert.equal(ops[2].rev, null, 'a write after a sent write of the same item takes the rev that the sent write gets');
});

test('the queue key names the pack and the version', () => {
  assert.equal(queueKey('shop', 'checkout', 2), 'herdr-boss.review-queue:shop/checkout:v2');
});

test('the status texts and the submit lock', () => {
  assert.equal(syncStatusText({ kind: 'saved' }), 'Saved');
  assert.equal(syncStatusText({ kind: 'saving' }), 'Saving...');
  assert.equal(syncStatusText({ kind: 'offline' }), 'Offline, will save when back');
  assert.equal(syncStatusText({ kind: 'retrying' }), 'Not saved');
  assert.equal(syncStatusText({ kind: 'auth' }), 'Sign in again');
  assert.equal(syncStatusText({ kind: 'changed' }), 'Changed in the new version. Not saved.');
  assert.equal(syncStatusText({ kind: 'dropped', text: 'The note is too long.' }), 'Not saved. The note is too long.');
  assert.equal(syncStatusText({ kind: '' }), '');

  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  assert.match(syncStatusHtml({ kind: 'retrying' }, esc), /data-rv-sync-retry/, 'Not saved has a Retry button');
  assert.doesNotMatch(syncStatusHtml({ kind: 'offline' }, esc), /data-rv-sync-retry/, 'offline retries by itself');
  assert.match(syncStatusHtml({ kind: 'auth' }, esc), /href="\/login"/, 'Sign in again links to the login');
  assert.match(syncStatusHtml({ kind: 'dropped', text: '<b>' }, esc), /&lt;b&gt;/, 'a server text is escaped');
  assert.match(syncStatusHtml({ kind: 'saving' }, esc), /role="status"/);

  const pill = packStatusHtml({ kind: 'offline', count: 3 }, esc);
  assert.match(pill, /Offline, will save when back/);
  assert.match(pill, /3 changes waiting/);
  assert.match(packStatusHtml({ kind: 'saving', count: 1 }, esc), /1 change waiting/);
  assert.match(packStatusHtml({ kind: 'saved', count: 0 }, esc), /Saved/);
  assert.equal(packStatusHtml({ kind: '', count: 0 }, esc).includes('rv-sync-pill'), true, 'an empty pill keeps its slot, so nothing moves');

  assert.deepEqual(submitLock(0), { disabled: false, label: 'Submit review' });
  assert.deepEqual(submitLock(1), { disabled: true, label: 'Waiting for 1 change to save' });
  assert.deepEqual(submitLock(4), { disabled: true, label: 'Waiting for 4 changes to save' });
});

test('the drafts wait 600 ms after the last input and flush at once on demand', async () => {
  assert.equal(NOTE_DEBOUNCE_MS, 600);
  const timers = fakeTimers();
  const sent = [];
  const drafts = createDrafts({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  drafts.set('item:a', () => sent.push('a1'));
  await timers.advance(500);
  drafts.set('item:a', () => sent.push('a2'));
  await timers.advance(500);
  assert.deepEqual(sent, [], 'a new input restarts the wait');
  assert.equal(drafts.size(), 1);
  await timers.advance(100);
  assert.deepEqual(sent, ['a2'], 'only the last draft runs');
  drafts.set('item:b', () => sent.push('b'));
  drafts.set('note', () => sent.push('note'));
  drafts.flush('item:b');
  assert.deepEqual(sent, ['a2', 'b']);
  drafts.flush();
  assert.deepEqual(sent, ['a2', 'b', 'note'], 'flush() with no key runs every draft');
  assert.equal(drafts.size(), 0);
  await timers.advance(1000);
  assert.deepEqual(sent, ['a2', 'b', 'note'], 'a flushed draft does not run again');
});

// ---------- The queue with a fake fetch ----------

test('each change saves at once, with the rev and an opId, and the status goes from Saving to Saved', async () => {
  const { queue, fetch, events } = setup();
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'saving');
  assert.equal(queue.pendingCount(KEY), 1);
  await drain();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].url, '/api/reviews/shop/checkout/items/cart');
  assert.deepEqual(fetch.calls[0].body, { decision: 'accept', rev: 0, opId: 'op-1' });
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'saved');
  assert.equal(queue.packStatus(KEY).kind, 'saved');
  assert.equal(queue.pendingCount(KEY), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].answer.rev, 1);
});

test('writes for one item coalesce while a write is out, and the next write takes the new rev', async () => {
  let release;
  const { queue, fetch } = setup({ replies: [({ body }) => new Promise((resolve) => { release = () => resolve({ status: 200, body: { ok: true, answer: { ...body, rev: 1 } } }); })] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  queue.enqueue(itemWrite('cart', { decision: 'deny' }));
  queue.enqueue(itemWrite('cart', { note: 'Too dark.' }));
  queue.enqueue(itemWrite('cart', { decision: null }));
  assert.equal(queue.pendingCount(KEY), 2, 'the write in flight and one coalesced write');
  release();
  await drain();
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body, { decision: null, note: 'Too dark.', rev: 1, opId: 'op-4' });
  assert.equal(queue.pendingCount(KEY), 0);
});

test('writes run one after another across items, in the order of the first change', async () => {
  const order = [];
  let open = 0;
  let most = 0;
  const reply = ({ url, body }) => {
    open += 1;
    most = Math.max(most, open);
    order.push(url.split('/').pop());
    return new Promise((resolve) => setImmediate(() => { open -= 1; resolve({ status: 200, body: { ok: true, answer: { ...body, rev: 1 } } }); }));
  };
  const { queue, fetch } = setup();
  fetch.otherwise(reply);
  queue.enqueue(itemWrite('a', { decision: 'accept' }));
  queue.enqueue(itemWrite('b', { decision: 'accept' }));
  queue.enqueue(itemWrite('c', { viewed: true }));
  queue.enqueue(itemWrite('b', { note: 'More contrast.' }));
  await drain(20);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(most, 1, 'one write at a time');
});

test('a network error keeps the patch, shows Offline, and retries after 2, 4, 8, 16, and 30 seconds', async () => {
  const offline = new TypeError('Failed to fetch');
  const { queue, fetch, timers } = setup({ replies: [offline, offline, offline, offline, offline, offline] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'offline');
  assert.equal(queue.packStatus(KEY).kind, 'offline');
  assert.equal(queue.pendingCount(KEY), 1);
  const waits = [];
  for (let i = 0; i < 5; i += 1) {
    waits.push(timers.pending()[0]);
    await timers.advance(timers.pending()[0]);
    await drain();
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 30000]);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'offline');
  // Back online: the retry checks the pack first, then sends the same opId.
  fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [] } });
  queue.retryNow();
  await drain();
  const writes = fetch.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.ok(writes.every((call) => call.body.opId === 'op-1'), 'every retry sends the same opId');
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'saved');
});

test('5xx and 429 retry with backoff and show Not saved; Retry sends at once', async () => {
  const { queue, fetch, timers } = setup({ replies: [{ status: 503, body: { error: 'Busy.' } }, { status: 429, body: {} }] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'retrying');
  assert.equal(timers.pending()[0], 2000);
  queue.retryNow();
  await drain();
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'retrying', 'the 429 also retries');
  assert.equal(timers.pending()[0], 4000);
  queue.retryNow();
  await drain();
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'saved');
  const writes = fetch.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 3);
  assert.equal(timers.pending().length, 0, 'no retry timer is left');
});

test('the online event and the page focus retry at once', async () => {
  const { queue, fetch } = setup({ replies: [new TypeError('offline')] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.equal(queue.packStatus(KEY).kind, 'offline');
  queue.retryNow();
  await drain();
  assert.equal(queue.packStatus(KEY).kind, 'saved');
  assert.equal(fetch.calls.filter((call) => call.method === 'PUT').length, 2);
});

test('a 401 stops the queue and shows Sign in again; the patch stays', async () => {
  const { queue, fetch, timers } = setup({ replies: [{ status: 401, body: { error: 'Sign in.' } }] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  queue.enqueue(itemWrite('logo', { decision: 'deny' }));
  await drain();
  assert.equal(queue.packStatus(KEY).kind, 'auth');
  assert.equal(queue.itemStatus(KEY, 'logo').kind, 'auth');
  assert.equal(queue.pendingCount(KEY), 2);
  assert.equal(timers.pending().length, 0, 'no timer retries a 401');
  queue.enqueue(itemWrite('logo', { note: 'Also this.' }));
  await drain();
  assert.equal(fetch.calls.length, 1, 'a new change does not restart a stopped queue');
  queue.retryNow();
  await drain();
  assert.equal(queue.pendingCount(KEY), 0);
});

test('a 413 or a validation 400 drops that patch with a plain message and the queue goes on', async () => {
  const { queue, fetch } = setup({ replies: [{ status: 413, body: { error: 'The body is larger than 65536 bytes.' } }, { status: 400, body: { error: 'A note must be text of at most 2000 characters.', code: 'invalid' } }] });
  queue.enqueue(itemWrite('a', { note: 'x' }));
  queue.enqueue(itemWrite('b', { note: 'y' }));
  queue.enqueue(itemWrite('c', { decision: 'accept' }));
  await drain(20);
  // The 400 reads the pack once (the same version), then drops the patch.
  assert.deepEqual(fetch.calls.map((call) => call.method), ['PUT', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(queue.itemStatus(KEY, 'a'), { kind: 'dropped', text: 'The body is larger than 65536 bytes.', id: 'item:a', final: false });
  assert.equal(queue.itemStatus(KEY, 'b').text, 'A note must be text of at most 2000 characters.');
  assert.equal(queue.itemStatus(KEY, 'c').kind, 'saved');
  assert.equal(queue.pendingCount(KEY), 0);
  assert.equal(queue.unsavedCount(KEY), 2, 'a dropped patch waits for the Owner');
  assert.equal(queue.packStatus(KEY).unsaved, 2);
  queue.enqueue(itemWrite('a', { note: 'shorter' }));
  assert.equal(queue.itemStatus(KEY, 'a').kind, 'saving', 'a new change clears the message');
  assert.equal(queue.unsavedCount(KEY), 1);
});

test('a live 409 gives the item conflict with mine and theirs; Keep mine sends with their rev', async () => {
  const theirs = { decision: 'deny', note: '', rev: 4 };
  const { queue, fetch } = setup({ replies: [{ status: 409, body: { conflict: true, current: theirs } }] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  const conflict = queue.conflicts(KEY);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].batch, false, 'a live conflict asks on the item');
  assert.deepEqual(conflict[0].mine, { decision: 'accept' });
  assert.deepEqual(conflict[0].theirs, theirs);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'conflict');
  assert.equal(queue.pendingCount(KEY), 1, 'an open conflict blocks the submit');
  queue.keepMine(KEY, 'cart');
  await drain();
  assert.deepEqual(fetch.calls[1].body, { decision: 'accept', rev: 4, opId: 'op-2' });
  assert.equal(queue.pendingCount(KEY), 0);
});

test('Use theirs drops my patch and hands the other answer to the page', async () => {
  const theirs = { decision: 'deny', rev: 2 };
  const { queue, events } = setup({ replies: [{ status: 409, body: { conflict: true, current: theirs } }] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  queue.useTheirs(KEY, 'cart');
  assert.equal(queue.pendingCount(KEY), 0);
  assert.deepEqual(events.at(-1), { key: KEY, kind: 'item', item: 'cart', answer: theirs, theirs: true });
});

test('queued patches that conflict after a long offline time ask once for the pack, with all items listed', async () => {
  const offline = new TypeError('offline');
  const { queue, fetch } = setup({ replies: [offline] });
  queue.enqueue(itemWrite('a', { decision: 'accept' }));
  queue.enqueue(itemWrite('b', { decision: 'deny' }));
  queue.enqueue(itemWrite('c', { decision: 'accept' }));
  await drain();
  // Back online: the pack check, then a 409 for a and c and a save for b.
  const pack = { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: ['a', 'b', 'c'].map((id) => ({ id, hash: `h-${id}` })) };
  fetch.push({ status: 200, body: pack }, { status: 409, body: { conflict: true, current: { decision: 'deny', rev: 5 } } }, { status: 200, body: { ok: true, answer: { rev: 1 } } }, { status: 409, body: { conflict: true, current: null } });
  queue.retryNow();
  await drain(20);
  const conflicts = queue.conflicts(KEY);
  assert.deepEqual(conflicts.map((entry) => [entry.item, entry.batch]), [['a', true], ['c', true]]);
  assert.equal(queue.packStatus(KEY).kind, 'conflict');
  queue.keepAllMine(KEY);
  await drain(20);
  const last = fetch.calls.slice(-2).map((call) => [call.url.split('/').pop(), call.body.rev]);
  assert.deepEqual(last, [['a', 5], ['c', 0]], 'Keep mine sends each patch with the rev of the other answer');
  assert.equal(queue.pendingCount(KEY), 0);
});

test('the pack note saves with its rev; a 409 that holds my own note counts as saved', async () => {
  const { queue, fetch } = setup({ replies: [new TypeError('offline')] });
  queue.enqueue({ ...ROUTE, kind: 'note', patch: { note: 'Ship it.' }, rev: 2 });
  await drain();
  assert.equal(queue.noteStatus(KEY).kind, 'offline');
  const pack = { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [] };
  // The first try reached the server, but the response was lost: the server has my note at rev 3.
  fetch.push({ status: 200, body: pack }, { status: 409, body: { conflict: true, current: { note: 'Ship it.', rev: 3 } } });
  queue.retryNow();
  await drain(20);
  assert.equal(fetch.calls.at(-1).url, '/api/reviews/shop/checkout/note');
  assert.deepEqual(fetch.calls.at(-1).body, { note: 'Ship it.', rev: 2 });
  assert.equal(queue.noteStatus(KEY).kind, 'saved');
  assert.equal(queue.conflicts(KEY).length, 0);
});

// ---------- Review fixes ----------

test('a dropped or changed patch shows in the pill and keeps the submit disabled until Retry, Discard, or a new answer', async () => {
  const { queue, fetch } = setup({ replies: [{ status: 413, body: { error: 'Too large.' } }, { status: 403, body: { error: 'Refused.' } }] });
  queue.enqueue(itemWrite('a', { note: 'x' }));
  queue.enqueue(itemWrite('b', { decision: 'accept' }));
  await drain(20);
  const status = queue.packStatus(KEY);
  assert.equal(status.kind, 'unsaved');
  assert.equal(status.unsaved, 2);
  assert.match(packStatusHtml(status, escText), /2 changes were not saved/);
  assert.deepEqual(submitLock(status.count, status.unsaved), { disabled: true, label: '2 changes were not saved' });
  assert.deepEqual(submitLock(0, 1), { disabled: true, label: '1 change was not saved' });
  const line = syncStatusHtml(queue.itemStatus(KEY, 'a'), escText);
  assert.match(line, /data-rv-sync-redo="item:a"/);
  assert.match(line, /data-rv-sync-discard="item:a"/);
  queue.discard(KEY, 'item:a');
  assert.equal(queue.unsavedCount(KEY), 1);
  queue.redo(KEY, 'item:b');
  await drain(20);
  assert.deepEqual(fetch.calls.at(-1).body, { decision: 'accept', rev: 0, opId: 'op-3' }, 'Retry sends the patch again with a new opId');
  assert.equal(queue.unsavedCount(KEY), 0);
  assert.deepEqual(submitLock(queue.pendingCount(KEY), queue.unsavedCount(KEY)).disabled, false);
});

test('a changed patch counts as not saved and has Discard but no Retry', async () => {
  const { queue, fetch } = setup({ replies: [new TypeError('offline')] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 2, currentVersion: 2, state: 'open', items: [{ id: 'cart', hash: 'h-new' }] } });
  queue.retryNow();
  await drain(20);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'changed');
  assert.equal(queue.unsavedCount(KEY), 1);
  const line = syncStatusHtml(queue.itemStatus(KEY, 'cart'), escText);
  assert.doesNotMatch(line, /data-rv-sync-redo/);
  assert.match(line, /data-rv-sync-discard="item:cart"/);
  queue.enqueue({ ...ROUTE, version: 2, kind: 'item', item: 'cart', hash: 'h-new', rev: 0, patch: { decision: 'deny' } });
  assert.equal(queue.unsavedCount(KEY), 0, 'a new answer clears it');
});

test('a live write that gets 400 for an older version reads the pack and re-targets it by hash once', async () => {
  const notCurrent = { status: 400, body: { error: 'The item is not in the current version of the pack.', code: 'invalid' } };
  const v2 = { status: 200, body: { slug: 'shop', pack: 'checkout', version: 2, currentVersion: 2, state: 'open', items: [{ id: 'cart', hash: 'h-cart' }, { id: 'logo', hash: 'h-other' }] } };
  const { queue, fetch } = setup({ replies: [notCurrent, v2, { status: 200, body: { ok: true, answer: { rev: 1 } } }, v2] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain(20);
  assert.deepEqual(fetch.calls.map((call) => call.method), ['PUT', 'GET', 'PUT']);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'saved', 'the same hash in v2: the retry saves');
  queue.enqueue(itemWrite('logo', { decision: 'deny' }));
  await drain(20);
  assert.equal(queue.itemStatus(KEY, 'logo').kind, 'changed', 'a write for the old version of a changed item is not sent');
  assert.equal(fetch.calls.filter((call) => call.method === 'PUT').length, 2);
});

test('without storage the pill asks to keep the page open', async () => {
  const { queue } = setup({ storage: null, replies: [new TypeError('offline')] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.match(queue.packStatus(KEY).warning, /Keep this page open/);
});

test('the op in flight is stored as sent: a reload keeps its opId and a new edit waits behind it with the saved rev', async () => {
  const storage = fakeStorage();
  // The first tab sends, and the page closes before the answer arrives.
  const first = setup({ storage, replies: [() => new Promise(() => {})] });
  first.queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  const stored = JSON.parse(storage.map.get(queueKey('shop', 'checkout', 1)));
  assert.equal(stored.ops[0].sent, true);
  // The reload: restore, then a new edit of the same item.
  const second = setup({ storage, ids: (() => { let n = 0; return () => { n += 1; return `new-${n}`; }; })() });
  second.queue.restore('shop', 'checkout');
  second.queue.enqueue(itemWrite('cart', { note: 'Also the total.' }));
  assert.equal(second.queue.pendingCount(KEY), 2, 'the new edit does not merge into the sent op');
  second.fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [{ id: 'cart', hash: 'h-cart' }] } },
    { status: 200, body: { ok: true, duplicate: true, answer: { decision: 'accept', rev: 1 } } });
  second.queue.retryNow();
  await drain(20);
  const puts = second.fetch.calls.filter((call) => call.method === 'PUT').map((call) => call.body);
  assert.deepEqual(puts[0], { decision: 'accept', rev: 0, opId: 'op-1' }, 'the retry uses the old opId first');
  assert.deepEqual(puts[1], { note: 'Also the total.', rev: 1, opId: 'new-1' }, 'the new edit follows with the saved rev');
});

test('two tabs share one key: each keeps the ops of the other, counts them as waiting, and adopts them on Retry', async () => {
  const storage = fakeStorage();
  const a = setup({ storage, replies: [new TypeError('offline')], ids: (() => { let n = 0; return () => `a-${(n += 1)}`; })() });
  const b = setup({ storage, replies: [new TypeError('offline')], ids: (() => { let n = 0; return () => `b-${(n += 1)}`; })() });
  a.queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  b.queue.enqueue(itemWrite('logo', { decision: 'deny' }));
  await drain();
  const ids = () => JSON.parse(storage.map.get(queueKey('shop', 'checkout', 1))).ops.map((op) => op.opId).sort();
  assert.deepEqual(ids(), ['a-1', 'b-1'], 'the write of tab B keeps the op of tab A');
  // a-1 went out once, so the new edit waits behind it as a-2.
  a.queue.enqueue(itemWrite('cart', { note: 'Also the total.' }));
  assert.deepEqual(ids(), ['a-1', 'a-2', 'b-1']);
  b.queue.onStorage(queueKey('shop', 'checkout', 1));
  assert.equal(b.queue.pendingCount(KEY), 3, 'tab B counts the waiting ops of tab A');

  // Tab A comes back online and saves its op. Tab B then sees that nothing of A waits.
  a.fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [] } });
  a.queue.retryNow();
  await drain(20);
  assert.equal(a.queue.pendingCount(KEY), 1, 'tab A counts the op of tab B');
  b.queue.onStorage(queueKey('shop', 'checkout', 1));
  assert.equal(b.queue.pendingCount(KEY), 1);
  assert.deepEqual(ids(), ['b-1']);

  // Tab B is closed with its op stored. The Retry button in tab A adopts it and sends it.
  a.queue.retryNow({ adopt: true });
  await drain(20);
  assert.equal(a.fetch.calls.at(-1).body.opId, 'b-1');
  assert.equal(a.queue.pendingCount(KEY), 0);
  assert.equal(storage.map.has(queueKey('shop', 'checkout', 1)), false);
});

// ---------- Persistence ----------

test('the queue persists only patches, opIds, revs, and hashes under the pack and version key, and restores them', async () => {
  const storage = fakeStorage();
  const first = setup({ storage, replies: [new TypeError('offline')] });
  first.queue.enqueue(itemWrite('cart', { decision: 'accept', note: 'Too dark.' }));
  first.queue.enqueue({ ...ROUTE, kind: 'note', patch: { note: 'Fix the dark cart.' }, rev: 0 });
  await drain();
  const raw = storage.map.get(queueKey('shop', 'checkout', 1));
  assert.ok(raw, 'the queue is in localStorage');
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['ops', 'v']);
  assert.deepEqual(Object.keys(saved.ops[0]).sort(), ['hash', 'item', 'kind', 'opId', 'patch', 'rev', 'sent']);

  // A reload: a new queue restores the waiting changes and shows them as pending.
  const second = setup({ storage });
  const restored = second.queue.restore('shop', 'checkout');
  assert.equal(restored, 2);
  assert.equal(second.queue.pendingCount(KEY), 2);
  assert.equal(second.queue.itemStatus(KEY, 'cart').kind, 'offline');
  const pack = { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'open', items: [{ id: 'cart', hash: 'h-cart' }] };
  second.fetch.push({ status: 200, body: pack });
  second.queue.retryNow();
  await drain(20);
  const calls = second.fetch.calls;
  assert.equal(calls[0].method, 'GET', 'a restored queue checks the pack before it sends');
  assert.deepEqual(calls[1].body, { decision: 'accept', note: 'Too dark.', rev: 0, opId: 'op-1' }, 'the restored write keeps its opId');
  assert.equal(second.queue.pendingCount(KEY), 0);
  assert.equal(storage.map.has(queueKey('shop', 'checkout', 1)), false, 'an empty queue removes its key');
});

test('a throwing localStorage and a quota error keep the queue in memory and say so', async () => {
  const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const full = setup({ storage: fakeStorage({ throwOnSet: quota }), replies: [new TypeError('offline')] });
  full.queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.equal(full.queue.pendingCount(KEY), 1);
  assert.match(full.queue.packStatus(KEY).warning, /Keep this page open/);

  const blocked = setup({ storage: fakeStorage({ throwOnGet: true, throwOnSet: new Error('SecurityError') }) });
  assert.equal(blocked.queue.restore('shop', 'checkout'), 0, 'a throwing read restores nothing');
  blocked.queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  assert.equal(blocked.queue.itemStatus(KEY, 'cart').kind, 'saved', 'the save works without storage');

  const none = createReviewSync({ fetch: fakeFetch(), storage: null });
  assert.equal(none.restore('shop', 'checkout'), 0);
});

test('a queue over 200 KB is not written, and the page is asked to stay open', async () => {
  assert.equal(QUEUE_LIMIT_BYTES, 200 * 1024);
  const storage = fakeStorage();
  const { queue } = setup({ storage, replies: [new TypeError('offline')] });
  for (let i = 0; i < 120; i += 1) queue.enqueue(itemWrite(`item-${i}`, { note: 'x'.repeat(1900) }));
  await drain();
  assert.equal(storage.map.has(queueKey('shop', 'checkout', 1)), false);
  assert.match(queue.packStatus(KEY).warning, /too large/);
  assert.equal(queue.pendingCount(KEY), 120, 'the memory queue keeps every change');
});

test('a stored queue that is not valid JSON or has a wrong shape restores nothing', () => {
  const storage = fakeStorage();
  storage.map.set(queueKey('shop', 'checkout', 1), '{not json');
  storage.map.set(queueKey('shop', 'checkout', 2), JSON.stringify({ v: 1, ops: [{ kind: 'item', item: 5, patch: 'x' }] }));
  const { queue } = setup({ storage });
  assert.equal(queue.restore('shop', 'checkout'), 0);
});

// ---------- Pack state before a flush ----------

test('a queue for a closed pack sends nothing and says why', async () => {
  const storage = fakeStorage();
  storage.map.set(queueKey('shop', 'checkout', 1), JSON.stringify({ v: 1, ops: [{ kind: 'item', item: 'cart', hash: 'h-cart', patch: { decision: 'accept' }, opId: 'op-9', rev: 0, sent: true }] }));
  const { queue, fetch } = setup({ storage });
  queue.restore('shop', 'checkout');
  fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 1, currentVersion: 1, state: 'submitted', items: [{ id: 'cart', hash: 'h-cart' }] } });
  queue.retryNow();
  await drain(20);
  assert.equal(fetch.calls.filter((call) => call.method === 'PUT').length, 0);
  assert.equal(queue.pendingCount(KEY), 0);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'dropped');
  assert.match(queue.itemStatus(KEY, 'cart').text, /submitted/);
});

test('a newer version re-targets a queued patch when the item hash is unchanged, else marks it changed', async () => {
  const storage = fakeStorage();
  storage.map.set(queueKey('shop', 'checkout', 1), JSON.stringify({ v: 1, ops: [
    { kind: 'item', item: 'same', hash: 'h-same', patch: { decision: 'accept' }, opId: 'op-a', rev: 1, sent: false },
    { kind: 'item', item: 'moved', hash: 'h-old', patch: { decision: 'deny' }, opId: 'op-b', rev: 1, sent: false },
    { kind: 'item', item: 'gone', hash: 'h-gone', patch: { viewed: true }, opId: 'op-c', rev: 0, sent: false },
    { kind: 'note', patch: { note: 'Ship after the fix.' }, opId: 'op-d', rev: 0, sent: false },
  ] }));
  const { queue, fetch } = setup({ storage });
  assert.equal(queue.restore('shop', 'checkout'), 4);
  fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 2, currentVersion: 2, state: 'open', items: [{ id: 'same', hash: 'h-same' }, { id: 'moved', hash: 'h-new' }] } });
  queue.retryNow();
  await drain(20);
  const writes = fetch.calls.filter((call) => call.method === 'PUT').map((call) => call.url.split('/').pop());
  assert.deepEqual(writes, ['same', 'note'], 'only the unchanged item and the pack note are sent');
  assert.equal(queue.itemStatus(KEY, 'moved').kind, 'changed');
  assert.equal(queue.itemStatus(KEY, 'gone').kind, 'changed');
  assert.equal(queue.pendingCount(KEY), 0);
  assert.equal(storage.map.has(queueKey('shop', 'checkout', 1)), false, 'the old version key is gone');
});

test('observe() checks the pack again when the page loads a newer version', async () => {
  const { queue, fetch } = setup({ replies: [new TypeError('offline')] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  await drain();
  fetch.push({ status: 200, body: { slug: 'shop', pack: 'checkout', version: 2, currentVersion: 2, state: 'open', items: [{ id: 'cart', hash: 'h-other' }] } });
  queue.observe({ slug: 'shop', pack: 'checkout', version: 2, state: 'open' });
  await drain(20);
  assert.equal(queue.itemStatus(KEY, 'cart').kind, 'changed');
  assert.equal(fetch.calls.filter((call) => call.method === 'PUT').length, 1, 'only the first try went out');
});

test('overlay() shows the waiting patches over a freshly loaded pack', async () => {
  const { queue } = setup({ replies: [new TypeError('offline')] });
  queue.enqueue(itemWrite('cart', { decision: 'accept' }));
  queue.enqueue({ ...ROUTE, kind: 'note', patch: { note: 'Draft note.' }, rev: 0 });
  await drain();
  const data = { slug: 'shop', pack: 'checkout', version: 1, note: '', items: [{ id: 'cart', answer: { decision: 'deny', note: 'Old.', rev: 3 } }, { id: 'logo', answer: null }] };
  queue.overlay(data);
  assert.equal(data.items[0].answer.decision, 'accept');
  assert.equal(data.items[0].answer.note, 'Old.');
  assert.equal(data.items[1].answer, null);
  assert.equal(data.note, 'Draft note.');
  assert.deepEqual(queue.pendingFields(KEY, 'cart'), ['decision']);
});

// ---------- The real server and store ----------

async function startServer(t) {
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  const cfg = loadConfig();
  Object.assign(cfg, { host: '127.0.0.1', port: 0, tickSeconds: 3600 });
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return `http://127.0.0.1:${server.address().port}`;
}

function publish(id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-sync-pack-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 'herdr-boss.review-pack/1', id, title: 'Invented pack',
    sections: [{ id: 'copy', title: 'Copy', items: [{ id: 'intro', title: 'Intro text', type: 'markdown', text: 'Hello.', ask: ['accept', 'deny', 'note'] }] }],
  }));
  store.publishVersion({ dir: dataDir, now: Date.now(), slug: `s-${id}`, folder: root, publishedBy: 'orch' });
  return { slug: `s-${id}`, pack: id };
}

test('a retry with the same opId after a lost response applies once in the real store', async (t) => {
  const base = await startServer(t);
  const { slug, pack } = publish('lost-response');
  const real = (url, options) => fetch(base + url, options);
  let dropped = 0;
  // The first write reaches the server, then the response is lost.
  const lossy = async (url, options) => {
    const response = await real(url, options);
    if (options?.method === 'PUT' && dropped === 0) { dropped += 1; throw new TypeError('The network connection was lost.'); }
    return response;
  };
  const timers = fakeTimers();
  const events = [];
  const queue = createReviewSync({ fetch: lossy, storage: fakeStorage(), setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: timers.now, onSaved: (event) => events.push(event) });
  const key = `${slug}/${pack}`;
  queue.enqueue({ slug, pack, version: 1, kind: 'item', item: 'intro', hash: store.getPack({ dir: dataDir, slug, pack }).items[0].hash, rev: 0, patch: { decision: 'accept' } });
  await waitFor(() => queue.itemStatus(key, 'intro').kind === 'offline');
  queue.retryNow();
  await waitFor(() => queue.itemStatus(key, 'intro').kind === 'saved');
  const answer = store.getPack({ dir: dataDir, slug, pack }).items[0].answer;
  assert.equal(answer.decision, 'accept');
  assert.equal(answer.rev, 1, 'the write applied once');
  assert.equal(events.at(-1).answer.rev, 1);
});

test('two writes with the same opId through the real route apply once', async (t) => {
  const base = await startServer(t);
  const { slug, pack } = publish('same-op');
  const put = (body) => fetch(`${base}/api/reviews/${slug}/${pack}/items/intro`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const first = await put({ rev: 0, note: 'Shorter intro.', opId: 'op-same' });
  const second = await put({ rev: 0, note: 'Shorter intro.', opId: 'op-same' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(store.getPack({ dir: dataDir, slug, pack }).items[0].answer.rev, 1);
});

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('The condition did not become true.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------- The status in the pages ----------

const { packPageHtml } = await import('../public/review.js');
const { createDocument, find, byKey } = await import('./fake-dom.js');
const { patchHtml } = await import('../public/keyed.js');

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = () => ({ esc: escHtml, avatar: () => '', projectLabel: (slug) => slug, time: () => '08:12', menuButton: '', text: () => undefined });

function page(over = {}) {
  const item = (id, title) => ({ id, section: 'cart', title, type: 'markdown', ask: ['accept', 'deny', 'note'], state: 'open', stale: false, answer: null, hash: `h-${id}` });
  return {
    slug: 'shop', pack: 'checkout', title: 'Invented checkout', version: 1, currentVersion: 1, state: 'open', note: '', noteRev: 0,
    manifest: { sections: [{ id: 'cart', title: 'Cart', items: [{ id: 'cart', text: 'Cart text.' }, { id: 'logo', text: 'Logo text.' }] }] },
    items: [item('cart', 'Cart total'), item('logo', 'Logo <b>')],
    removed: [],
    derived: { sections: [{ id: 'cart', title: 'Cart', state: 'open' }], pack: 'open', counts: { items: 2, accepted: 0, denied: 0, live: 0, noteOnly: 0, open: 2 }, proposedVerdict: 'comment' },
    ...over,
  };
}

test('the submit bar shows the pack status and waits for the queue', () => {
  const waiting = packPageHtml(page(), { packSync: { kind: 'offline', count: 2 } }, helpers());
  assert.match(waiting, /class="rv-sync-pill[^"]*"[^>]*><span>Offline, will save when back · 2 changes waiting<\/span>/);
  assert.match(waiting, /<button type="submit"[^>]*disabled[^>]*>Waiting for 2 changes to save<\/button>/);
  const clear = packPageHtml(page(), { packSync: { kind: 'saved', count: 0 } }, helpers());
  assert.match(clear, /<button type="submit"(?![^>]*disabled)[^>]*>Submit review<\/button>/);
  assert.match(clear, /<span>Saved<\/span>/);
});

test('a section row names an unsaved change of its item', () => {
  const statuses = { cart: { kind: 'offline' }, logo: { kind: 'saved' } };
  const html = packPageHtml(page(), { itemSync: (id) => statuses[id] }, helpers());
  assert.match(html, /data-review-row="cart"[\s\S]*?Waiting to save/);
  assert.doesNotMatch(html, /data-review-row="logo"[^]*?Waiting to save/);
});

test('the conflicts of queued patches ask once for the pack and list every item', () => {
  const conflicts = [{ item: 'cart', batch: true }, { item: 'logo', batch: true }, { item: 'x', batch: false }];
  const html = packPageHtml(page(), { conflicts }, helpers());
  const banner = /<div class="review-conflicts[^"]*"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] || '';
  assert.match(banner, /2 changes waited offline/);
  assert.match(banner, /Cart total/);
  assert.match(banner, /Logo &lt;b&gt;/, 'the titles are escaped');
  assert.match(banner, /data-review-conflicts="mine"/);
  assert.match(banner, /data-review-conflicts="theirs"/);
  assert.equal((html.match(/class="review-conflicts /g) || []).length, 1);
  assert.doesNotMatch(packPageHtml(page(), { conflicts: [{ item: 'x', batch: false }] }, helpers()), /review-conflicts/, 'a live conflict asks on its item');
});

test('a pack note conflict offers Keep mine and Use theirs', () => {
  const html = packPageHtml(page(), { noteConflict: { mine: { note: 'Mine.' }, theirs: { note: 'Theirs <i>', rev: 3 } } }, helpers());
  assert.match(html, /Theirs &lt;i&gt;/);
  assert.match(html, /data-review-note-conflict="mine"/);
  assert.match(html, /data-review-note-conflict="theirs"/);
});

test('the item viewer shows the item status and the pack pill above the answer bar', () => {
  const html = packPageHtml(page(), { item: 'cart', viewer: { sync: { kind: 'retrying' }, packSync: { kind: 'retrying', count: 1 } } }, helpers());
  assert.match(html, /class="rv-status rv-sync[^"]*"[^>]*role="alert">Not saved <button[^>]*data-rv-sync-retry>Retry<\/button>/);
  assert.match(html, /class="rv-answer"[\s\S]*class="rv-sync-pill/);
  const offline = packPageHtml(page(), { item: 'cart', viewer: { sync: { kind: 'offline' } } }, helpers());
  assert.match(offline, /Offline, will save when back/);
  const local = packPageHtml(page(), { item: 'cart', viewer: { status: 'No other item is open.', sync: { kind: 'saved' } } }, helpers());
  assert.match(local, /No other item is open\./, 'a local message shows before the save status');
});

test('a background save changes the status text but keeps the answer buttons and the focus', () => {
  globalThis.document = createDocument();
  const root = document.html(`<main>${packPageHtml(page(), { item: 'cart', viewer: { sync: { kind: 'saving' }, packSync: { kind: 'saving', count: 1 }, pending: { decision: 1 } } }, helpers())}</main>`);
  const main = root.firstChild;
  const accept = find(main, (el) => el.getAttribute('data-rv-decision') === 'accept');
  const bar = byKey(main, 'rv-answer:cart');
  accept.focus();
  const next = page();
  next.items[0].answer = { decision: 'accept', rev: 1 };
  patchHtml(main, packPageHtml(next, { item: 'cart', viewer: { sync: { kind: 'saved' }, packSync: { kind: 'saved', count: 0 }, pending: {} } }, helpers()));
  assert.equal(byKey(main, 'rv-answer:cart'), bar, 'the same answer bar node');
  assert.equal(find(main, (el) => el.getAttribute('data-rv-decision') === 'accept'), accept, 'the same button node');
  assert.equal(document.activeElement, accept, 'the focus stays');
  assert.equal(accept.getAttribute('aria-pressed'), 'true');
  const pill = find(main, (el) => /rv-sync-pill/.test(el.getAttribute('class') || ''));
  assert.ok(pill, 'the pill keeps its slot');
});

test('the submit bar names the changes that were not saved and stays disabled', () => {
  const html = packPageHtml(page(), { packSync: { kind: 'unsaved', count: 0, unsaved: 1 } }, helpers());
  assert.match(html, /<span>1 change was not saved<\/span>/);
  assert.match(html, /<button type="submit"[^>]*disabled[^>]*>1 change was not saved<\/button>/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /addEventListener\('storage', \(e\) => reviewSync\.onStorage\(e\.key\)\)/, 'the page listens to the other tabs');
  assert.match(app, /reviewSync\.redo\(current\.key, target\.dataset\.rvSyncRedo\)/);
  assert.match(app, /reviewSync\.discard\(current\.key, target\.dataset\.rvSyncDiscard\)/);
});
