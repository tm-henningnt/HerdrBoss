import assert from 'node:assert/strict';
import test from 'node:test';
import { predictLockDuration } from '../src/kit/lock-lanes.js';

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
