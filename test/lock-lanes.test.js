import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPolicy, POLICY_DEFAULTS, savePolicy, validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { chooseLockSlot, classifyLockLane, predictLockDuration } from '../src/kit/lock-lanes.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const line = (daysAgo, holdMs, extra = {}) => ({
  at: new Date(NOW - daysAgo * 86400000).toISOString(),
  event: 'release',
  name: 'full-suite',
  project: 'demo',
  kind: 'suite',
  holdMs,
  ...extra,
});

test('predictLockDuration uses the median of the last ten qualifying releases for the key', () => {
  const lines = Array.from({ length: 12 }, (_, i) => line(12 - i, (i + 1) * 1000));

  assert.deepEqual(predictLockDuration(lines, {
    project: 'demo', kind: 'suite', name: 'full-suite', now: NOW,
  }), { ms: 7500, samples: 10 });
});

test('predictLockDuration needs three qualifying releases', () => {
  assert.deepEqual(predictLockDuration([
    line(1, 1000), line(2, 3000),
  ], { project: 'demo', kind: 'suite', name: 'full-suite', now: NOW }), { ms: null, samples: 2 });
});

test('predictLockDuration ignores takeovers, re-entrant and reused lines', () => {
  assert.deepEqual(predictLockDuration([
    line(1, 1000, { takeover: true }),
    line(2, 1000, { reentrant: true }),
    line(3, 1000, { reused: true }),
    line(4, 4000), line(5, 6000), line(6, 8000),
  ], { project: 'demo', kind: 'suite', name: 'full-suite', now: NOW }), { ms: 6000, samples: 3 });
});

test('predictLockDuration ignores releases outside the 14 day window and other keys', () => {
  assert.deepEqual(predictLockDuration([
    line(15, 1000),
    line(1, 2000, { project: 'other' }),
    line(2, 3000, { kind: 'push' }),
    line(3, 4000, { name: 'other-lock' }),
    line(4, 5000), line(5, 7000),
  ], { project: 'demo', kind: 'suite', name: 'full-suite', now: NOW }), { ms: null, samples: 2 });
});

test('lock policy has safe defaults and validates each lane and guard range', () => {
  assert.equal(POLICY_DEFAULTS.locks.slots, 2);
  assert.equal(POLICY_DEFAULTS.locks.shortLimitMinutes, 6);
  assert.equal(POLICY_DEFAULTS.locks.guard.enabled, true);
  const models = loadModels();
  const withLocks = (locks) => ({ ...structuredClone(POLICY_DEFAULTS), locks });
  assert.deepEqual(validatePolicy(withLocks(structuredClone(POLICY_DEFAULTS.locks)), models), []);
  assert.match(validatePolicy(withLocks({ ...POLICY_DEFAULTS.locks, slots: 0 }), models).join(' '), /locks\.slots/);
  assert.match(validatePolicy(withLocks({ ...POLICY_DEFAULTS.locks, slots: 5 }), models).join(' '), /locks\.slots/);
  assert.match(validatePolicy(withLocks({ ...POLICY_DEFAULTS.locks, shortLimitMinutes: 61 }), models).join(' '), /shortLimitMinutes/);
  for (const key of ['maxLoadPercent', 'maxSwapPercent', 'minFreeMemPercent']) {
    const invalidValues = key === 'maxLoadPercent' ? [-1, 1001, 1.5, '50'] : [-1, 101, 1.5, '50'];
    for (const value of invalidValues) {
      const locks = structuredClone(POLICY_DEFAULTS.locks);
      locks.guard[key] = value;
      assert.match(validatePolicy(withLocks(locks), models).join(' '), new RegExp(`locks\\.guard\\.${key}`));
    }
  }
  const disabled = structuredClone(POLICY_DEFAULTS.locks);
  disabled.guard.enabled = 'yes';
  assert.match(validatePolicy(withLocks(disabled), models).join(' '), /locks\.guard\.enabled/);
});

test('partial and legacy lock policies load and save with nested defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ locks: { guard: { enabled: false } } }));
  const loaded = loadPolicy({ file, warn: () => {} });
  assert.deepEqual(loaded.locks, {
    slots: 2, shortLimitMinutes: 6,
    guard: { enabled: false, maxLoadPercent: 231, maxSwapPercent: 96, minFreeMemPercent: 40 },
  });
  const policy = { ...structuredClone(POLICY_DEFAULTS), locks: { guard: { enabled: false } } };
  assert.deepEqual(savePolicy(policy, loadModels(), { file }), []);
  assert.deepEqual(loadPolicy({ file, warn: () => {} }).locks, loaded.locks);
});

test('unknown predictions stay long and one slot keeps the exclusive lane', () => {
  assert.deepEqual(classifyLockLane({ ms: null }, 6), { lane: 'long', predictedMs: null });
  assert.deepEqual(chooseLockSlot({ lane: 'short', slots: 1 }), { slot: 'long' });
  assert.equal(chooseLockSlot({ lane: 'long', slots: 1, holders: [{ lane: 'long', slot: 'long' }] }), null);
});

test('short jobs can use a short slot beside a long holder and short slots run to capacity', () => {
  assert.deepEqual(chooseLockSlot({
    lane: 'short', slots: 2, holders: [{ lane: 'long', slot: 'long' }], tickets: [{ id: 's1', lane: 'short' }], ticketId: 's1',
  }), { slot: 1 });
  assert.deepEqual(chooseLockSlot({ lane: 'short', slots: 3, ticketId: 's1', tickets: [{ id: 's1', lane: 'short' }] }), { slot: 1 });
  assert.deepEqual(chooseLockSlot({
    lane: 'short', slots: 3, holders: [{ lane: 'short', slot: 1 }], tickets: [{ id: 's2', lane: 'short' }], ticketId: 's2',
  }), { slot: 2 });
});

test('long jobs serialize and a short job cannot jump a long ticket when borrowing', () => {
  assert.equal(chooseLockSlot({ lane: 'long', slots: 3, holders: [{ lane: 'long', slot: 'long' }] }), null);
  assert.equal(chooseLockSlot({
    lane: 'short', slots: 2,
    holders: [{ lane: 'short', slot: 1 }],
    tickets: [{ id: 'long-1', lane: 'long' }, { id: 'short-1', lane: 'short' }],
    ticketId: 'short-1',
  }), null);
  assert.equal(chooseLockSlot({
    lane: 'long', slots: 2,
    tickets: [{ id: 'long-1', lane: 'long' }, { id: 'long-2', lane: 'long' }],
    ticketId: 'long-2',
  }), null);
});

test('a short job uses a free long slot when its short slots are full and no long job waits', () => {
  assert.deepEqual(chooseLockSlot({
    lane: 'short', slots: 2,
    holders: [{ lane: 'short', slot: 1 }],
    tickets: [{ id: 'short-2', lane: 'short' }],
    ticketId: 'short-2',
  }), { slot: 'long' });
  assert.equal(chooseLockSlot({
    lane: 'long', slots: 2,
    holders: [{ lane: 'short', slot: 'long' }],
  }), null);
});
