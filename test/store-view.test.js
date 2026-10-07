import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClientStore, PAGE_READS } from '../public/store.js';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

class FakeEventSource {
  static sources = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = 0;
    FakeEventSource.sources.push(this);
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  emit(name, data = {}) {
    if (name === 'open') this.readyState = 1;
    if (name === 'error') this.readyState = 0;
    for (const listener of this.listeners.get(name) || []) listener({ data: JSON.stringify(data) });
    if (name === 'open') this.onopen?.();
    if (name === 'error') this.onerror?.();
  }
  close() { this.closed = true; }
}

function makeStore({ fetchImpl = async () => ({ ok: true, json: async () => ({ value: 1 }) }), setIntervalImpl, clearIntervalImpl } = {}) {
  FakeEventSource.sources = [];
  const resources = {
    state: { url: '/api/state', intervalMs: 30000 },
    counts: { url: '/api/counts', intervalMs: 30000 },
    optional: { url: '/api/optional', intervalMs: 30000 },
    roamgate: { url: '/api/roamgate', intervalMs: 30000 },
  };
  return createClientStore({
    fetchImpl,
    EventSourceImpl: FakeEventSource,
    resources,
    pages: { overview: ['state', 'counts'], board: ['state', 'counts'] },
    setIntervalImpl: setIntervalImpl || ((fn) => ({ fn })),
    clearIntervalImpl: clearIntervalImpl || (() => {}),
  });
}

test('an SSE state event updates the cached value and notifies its page', () => {
  const store = makeStore();
  const updates = [];
  store.subscribe('state', (value) => updates.push(value));
  store.connect();
  FakeEventSource.sources[0].emit('state', { updatedAt: 'now', projects: [] });
  assert.deepEqual(store.value('state'), { updatedAt: 'now', projects: [] });
  assert.deepEqual(updates, [{ updatedAt: 'now', projects: [] }]);
});

test('each route names its shared reads and only its page reads', () => {
  const routes = ['overview', 'fleet', 'board', 'reviews', 'agents', 'projects', 'browsers', 'allocation', 'analytics', 'settings', 'docs', 'mailbox', 'chat', 'add-host'];
  assert.deepEqual(Object.keys(PAGE_READS), routes);
  for (const route of routes) {
    for (const name of ['mailboxCounts', 'chats', 'roamgate']) assert.ok(PAGE_READS[route].includes(name), `${route} reads shared ${name}`);
  }
  assert.ok(PAGE_READS.overview.includes('handoffs'));
  assert.ok(PAGE_READS.board.includes('mailboxCounts'));
  assert.ok(PAGE_READS.mailbox.includes('mailboxList'));
  assert.ok(PAGE_READS.fleet.includes('fleetBundle'));
  assert.ok(PAGE_READS.analytics.includes('machineHours'));
  assert.ok(!PAGE_READS.board.includes('analytics'));
});

test('the same event source recovers after a connection error and delivers later events', () => {
  const store = makeStore();
  const updates = [];
  store.subscribe('state', (value) => updates.push(value));
  store.connect();
  const source = FakeEventSource.sources[0];
  source.emit('error');
  assert.equal(store.connected, false);
  source.emit('open');
  source.emit('state', { revision: 2 });
  assert.equal(FakeEventSource.sources.length, 1);
  assert.equal(store.connected, true);
  assert.deepEqual(updates, [{ revision: 2 }]);
});

test('an optional read keeps and returns its last good value after a later failure', async () => {
  let fail = false;
  const store = makeStore({ fetchImpl: async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ value: 'last good' }) };
  } });
  assert.deepEqual(await store.refresh('optional'), { value: 'last good' });
  fail = true;
  assert.deepEqual(await store.refresh('optional'), { value: 'last good' });
  assert.deepEqual(store.value('optional'), { value: 'last good' });
  assert.equal(store.error('optional')?.message, 'offline');
});

test('overlapping pages have one active refresh owner for each shared resource', async () => {
  const active = new Map();
  let nextTimer = 0;
  const store = makeStore({
    setIntervalImpl(fn, delay) { const id = ++nextTimer; active.set(id, { fn, delay }); return id; },
    clearIntervalImpl(id) { active.delete(id); },
  });
  await store.setPage('overview');
  await store.setPage('board');
  await store.setPage('board');
  assert.equal(active.size, 2);
  assert.ok([...active.values()].every((timer) => timer.delay === 30000));
  store.stop();
  assert.equal(active.size, 0);
});

test('two simultaneous reads of one resource share one fetch', async () => {
  let calls = 0;
  let resolveFetch;
  const store = makeStore({ fetchImpl: () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  } });
  const first = store.readUrl('/api/optional', { force: true });
  const second = store.readUrl('/api/optional', { force: true });
  assert.equal(calls, 1);
  resolveFetch({ ok: true, json: async () => ({ value: 'shared' }) });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'shared' }, { value: 'shared' }]);
});

test('Chat reads a fresh list when it opens', () => {
  const body = appSource.match(/async function loadChats\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'loadChats exists');
  assert.match(body, /readApiUrl\('\/api\/chats',\s*\{\s*force:\s*true\s*\}\)/);
});

test('arbitrary URL reads keep the 50 newest cache entries', async () => {
  const calls = new Map();
  const store = makeStore({ fetchImpl: async (url) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    return { ok: true, json: async () => ({ url }) };
  } });
  for (let index = 0; index < 50; index += 1) await store.readUrl(`/external/${index}`);
  await store.readUrl('/external/0');
  await store.readUrl('/external/50');

  assert.deepEqual(await store.readUrl('/external/0'), { url: '/external/0' });
  assert.deepEqual(await store.readUrl('/external/50'), { url: '/external/50' });
  assert.deepEqual(await store.readUrl('/external/1'), { url: '/external/1' });
  assert.equal(calls.get('/external/0'), 1, 'a recently used URL stays cached');
  assert.equal(calls.get('/external/50'), 1, 'the newest URL stays cached');
  assert.equal(calls.get('/external/1'), 2, 'the least recently used URL is fetched again');
});

test('two simultaneous reads of an arbitrary URL share one fetch', async () => {
  let calls = 0;
  let resolveFetch;
  const store = makeStore({ fetchImpl: () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  } });
  const first = store.readUrl('/external/shared', { force: true });
  const second = store.readUrl('/external/shared', { force: true });
  assert.equal(calls, 1);
  resolveFetch({ ok: true, json: async () => ({ value: 'shared' }) });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'shared' }, { value: 'shared' }]);
});

test('an older state fetch cannot replace a newer SSE state', async () => {
  let resolveFetch;
  const store = makeStore({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  const pending = store.refresh('state');
  store.connect();
  const newer = { updatedAt: '2026-10-07T12:00:00.000Z', revision: 2 };
  FakeEventSource.sources[0].emit('state', newer);
  resolveFetch({ ok: true, json: async () => ({ updatedAt: '2026-10-07T11:59:00.000Z', revision: 1 }) });

  assert.deepEqual(await pending, newer);
  assert.deepEqual(store.value('state'), newer);
});

test('a state fetch with an older updatedAt keeps the stored state', async () => {
  const values = [
    { updatedAt: '2026-10-07T12:00:00.000Z', revision: 2 },
    { updatedAt: '2026-10-07T11:59:00.000Z', revision: 1 },
  ];
  const store = makeStore({ fetchImpl: async () => ({ ok: true, json: async () => values.shift() }) });
  const newer = await store.refresh('state');

  assert.deepEqual(await store.refresh('state'), newer);
  assert.deepEqual(store.value('state'), newer);
});

test('a successful run clears its earlier error', async () => {
  let fail = true;
  const store = createClientStore({
    EventSourceImpl: FakeEventSource,
    resources: { action: { run: async () => {
      if (fail) throw new Error('offline');
      return 'done';
    } } },
    pages: {},
  });

  await assert.rejects(store.refresh('action'), /offline/);
  assert.equal(store.error('action')?.message, 'offline');
  fail = false;
  assert.equal(await store.refresh('action'), 'done');
  assert.equal(store.error('action'), undefined);
});

test('a failed roamgate read clears its cached value', async () => {
  let fail = false;
  const store = makeStore({ fetchImpl: async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ available: true }) };
  } });

  assert.deepEqual(await store.refresh('roamgate'), { available: true });
  fail = true;
  assert.equal(await store.refresh('roamgate'), null);
  assert.equal(store.value('roamgate'), null);
  assert.equal(store.error('roamgate')?.message, 'offline');
});
