// The answer saves of the review item viewer against the real server with a writable temporary data dir:
// a save, a 409 from a second writer, Keep mine, Use theirs, a 409 without the stored answer, and a failed save.
// Also the repeat-tap guard and the Viewed timer with a fake document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The data dir and HOME are temporary. The config module reads both when it loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-save-data-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-save-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ assertTempDataDir }, { serve }, { loadConfig }, store, { openSqliteStore }, save] = await Promise.all([
  import('../src/data-dir-guard.js'),
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/review-store.js'),
  import('../src/sqlite-store.js'),
  import('../public/review-save.js'),
]);
const { createItemSaver, createTapGuard, startViewedTimer, CONFLICT_UNLOADED, REPEAT_TAP_MS } = save;
assertTempDataDir(dataDir);

const roots = [dataDir, homeDir];
test.after(() => {
  openSqliteStore({ dir: dataDir }).close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// An invented pack with one image item that asks accept, deny, and note.
function publish(id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-save-pack-'));
  roots.push(root);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.from([0, 0, 1, 134, 0, 0, 3, 32, 8, 2, 0, 0, 0]), Buffer.alloc(16)]);
  fs.mkdirSync(path.join(root, 'img'));
  fs.writeFileSync(path.join(root, 'img/cart.png'), png);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 'herdr-boss.review-pack/1', id, title: 'Checkout flow redesign',
    sections: [{ id: 'cart', title: 'Cart', items: [{ id: 'cart', title: 'Cart', type: 'image', src: 'img/cart.png', ask: ['accept', 'deny', 'note'] }] }],
  }));
  store.publishVersion({ dir: dataDir, now: Date.now(), slug: `s-${id}`, folder: root, publishedBy: 'orch' });
  return { slug: `s-${id}`, pack: id };
}

async function start(t) {
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

// The page state for one item: the loaded pack and the view state.
async function pageState(base, route) {
  const data = await (await fetch(`${base}/api/reviews/${route.slug}/${route.pack}`)).json();
  return { entry: { data }, vui: { rev: 0, status: '', error: '', conflict: null, note: null, pinText: {} } };
}

// A second device writes straight to the route.
async function otherDevice(base, route, patch) {
  const current = store.getPack({ dir: dataDir, ...route }).items[0].answer;
  const response = await fetch(`${base}/api/reviews/${route.slug}/${route.pack}/items/cart`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...patch, rev: current?.rev ?? 0 }) });
  assert.equal(response.status, 200);
  return (await response.json()).answer;
}

const stored = (route) => store.getPack({ dir: dataDir, ...route }).items[0].answer;

test('a save sends the rev, shows Saved, and takes the stored answer', async (t) => {
  const base = await start(t);
  const route = publish('save-plain');
  const { entry, vui } = await pageState(base, route);
  const saver = createItemSaver({ fetch, base });
  const run = saver.save({ route, entry, vui, itemId: 'cart', patch: { decision: 'accept' } });
  assert.equal(entry.data.items[0].answer.decision, 'accept', 'the page shows the change at once');
  assert.equal(vui.status, 'Saving…');
  assert.deepEqual(vui.pending, { decision: 1 }, 'the button shows busy while the save runs');
  await run;
  assert.equal(vui.status, 'Saved');
  assert.deepEqual(vui.pending, {});
  assert.equal(stored(route).decision, 'accept');
  assert.equal(entry.data.items[0].answer.rev, 1);
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { note: 'Too faint.' } });
  assert.equal(stored(route).rev, 2, 'the second save used the rev of the first');
  assert.equal(stored(route).note, 'Too faint.');
});

test('a 409 from a second writer shows the other answer, and Keep mine sends my change with the new rev', async (t) => {
  const base = await start(t);
  const route = publish('save-keep');
  const { entry, vui } = await pageState(base, route);
  const saver = createItemSaver({ fetch, base });
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { decision: 'accept' } });
  const theirs = await otherDevice(base, route, { decision: 'deny', note: 'From the phone.' });
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { note: 'From the desk.' } });
  assert.deepEqual(vui.conflict.mine, { note: 'From the desk.' });
  assert.equal(vui.conflict.theirs.decision, 'deny');
  assert.equal(vui.conflict.theirs.rev, theirs.rev);
  assert.equal(vui.rev, theirs.rev);
  assert.equal(stored(route).note, 'From the phone.', 'the server kept the first writer');
  await saver.keepMine({ route, entry, vui, itemId: 'cart' });
  assert.equal(vui.conflict, null);
  assert.equal(vui.status, 'Saved');
  assert.equal(stored(route).note, 'From the desk.');
  assert.equal(stored(route).decision, 'deny', 'only my field changed');
  assert.equal(stored(route).rev, theirs.rev + 1);
});

test('Use theirs shows the other answer and drops my drafts', async (t) => {
  const base = await start(t);
  const route = publish('save-theirs');
  const { entry, vui } = await pageState(base, route);
  const saver = createItemSaver({ fetch, base });
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { decision: 'accept' } });
  await otherDevice(base, route, { note: 'Theirs.' });
  vui.note = 'Mine, typed.';
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { note: 'Mine, typed.' } });
  assert.ok(vui.conflict);
  saver.useTheirs({ entry, vui, itemId: 'cart' });
  assert.equal(vui.conflict, null);
  assert.equal(vui.note, null);
  assert.equal(entry.data.items[0].answer.note, 'Theirs.');
  assert.equal(stored(route).note, 'Theirs.', 'Use theirs sends nothing');
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { decision: 'deny' } });
  assert.equal(vui.status, 'Saved', 'the next save uses the rev of their answer');
});

test('a 409 without the stored answer loads the pack again and never sends rev 0 on a guess', async (t) => {
  const base = await start(t);
  const route = publish('save-refetch');
  const { entry, vui } = await pageState(base, route);
  const sent = [];
  // The server always names the stored answer. This fetch drops it from the 409, as an older server or a proxy could.
  const stripping = async (url, options = {}) => {
    if (options.method === 'PUT') sent.push(JSON.parse(options.body).rev);
    const response = await fetch(url, options);
    if (response.status !== 409) return response;
    const body = await response.json();
    delete body.current;
    return new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } });
  };
  const saver = createItemSaver({ fetch: stripping, base });
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { decision: 'accept' } });
  const theirs = await otherDevice(base, route, { decision: 'deny' });
  await saver.save({ route, entry, vui, itemId: 'cart', patch: { note: 'Mine.' } });
  assert.equal(vui.conflict.theirs.decision, 'deny', 'the other answer comes from the loaded pack');
  assert.equal(vui.rev, theirs.rev);
  await saver.keepMine({ route, entry, vui, itemId: 'cart' });
  assert.deepEqual(sent, [0, 1, theirs.rev], 'Keep mine sends the rev of the other answer, not 0');
  assert.equal(stored(route).note, 'Mine.');

  // When the pack does not load either, the page says so and offers no Keep mine.
  const failing = async (url, options = {}) => (options.method === 'PUT' ? stripping(url, options) : new Response('{}', { status: 503 }));
  const { entry: again, vui: fresh } = await pageState(base, route);
  fresh.rev = 1;
  again.data.items[0].answer.rev = 1;
  await createItemSaver({ fetch: failing, base }).save({ route, entry: again, vui: fresh, itemId: 'cart', patch: { note: 'Late.' } });
  assert.equal(fresh.conflict, null);
  assert.equal(fresh.error, CONFLICT_UNLOADED);
});

test('a failed save shows the plain reason and keeps the typed note', async (t) => {
  const base = await start(t);
  const route = publish('save-fail');
  const { entry, vui } = await pageState(base, route);
  vui.note = 'A long note that the Owner typed.';
  const offline = () => Promise.reject(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1'));
  await createItemSaver({ fetch: offline, base }).save({ route, entry, vui, itemId: 'cart', patch: { note: vui.note } });
  assert.equal(vui.error, 'The service is not reachable. It may be restarting. Try again in a moment.');
  assert.doesNotMatch(vui.error, /ECONNREFUSED/);
  assert.equal(vui.note, 'A long note that the Owner typed.');
  assert.equal(vui.status, '');
  assert.equal(stored(route), null, 'nothing reached the server');
  // The same draft saves when the service is back.
  await createItemSaver({ fetch, base }).save({ route, entry, vui, itemId: 'cart', patch: { note: vui.note } });
  assert.equal(stored(route).note, 'A long note that the Owner typed.');
});

test('a second identical tap within 400 ms is a repeat, and another action or a later tap is not', () => {
  let clock = 1000;
  const repeat = createTapGuard({ now: () => clock });
  assert.equal(REPEAT_TAP_MS, 400);
  assert.equal(repeat('cart:decision:accept'), false);
  clock += 150;
  assert.equal(repeat('cart:decision:accept'), true, 'a double tap sends one change');
  clock += 100;
  assert.equal(repeat('cart:decision:deny'), false);
  clock += 450;
  assert.equal(repeat('cart:decision:deny'), false, 'a tap after 400 ms counts');
});

test('the Viewed timer counts only while the page is visible', () => {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  };
  const listeners = new Set();
  const doc = { visibilityState: 'visible', addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) };
  const show = (state) => { doc.visibilityState = state; for (const fn of [...listeners]) fn(); };
  let viewed = 0;
  startViewedTimer({ doc, ms: 1500, onViewed: () => { viewed += 1; }, now: () => clock, setTimer, clearTimer });
  advance(1000);
  show('hidden');
  advance(5000);
  assert.equal(viewed, 0, 'a hidden page does not count');
  show('visible');
  advance(400);
  assert.equal(viewed, 0, '1.4 s visible in all');
  advance(100);
  assert.equal(viewed, 1, '1.5 s visible in all');
  assert.equal(listeners.size, 0, 'the timer removes its listener');

  // A page that opens hidden starts to count when it shows. stop() ends the count.
  doc.visibilityState = 'hidden';
  const stop = startViewedTimer({ doc, ms: 1500, onViewed: () => { viewed += 1; }, now: () => clock, setTimer, clearTimer });
  advance(3000);
  show('visible');
  advance(1000);
  stop();
  advance(1000);
  assert.equal(viewed, 1);
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});
