import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientStore, PAGE_READS } from '../public/store.js';

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
