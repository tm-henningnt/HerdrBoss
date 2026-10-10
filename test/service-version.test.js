import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readServiceVersion } from '../src/service-version.js';

test('the service version reads one checkout head and the kit revision at startup', () => {
  const calls = [];
  const version = readServiceVersion({
    root: '/sample/checkout',
    now: () => Date.parse('2026-10-10T08:30:00.000Z'),
    runGit: (...args) => { calls.push(args); return `${'a'.repeat(40)}\n2026-10-10\n`; },
    readKit: () => 'd5a92aea96a1',
  });
  assert.deepEqual(version, {
    commit: 'aaaaaaa', commitDate: '2026-10-10', kitRevision: 'd5a92aea96a1', startedAt: '2026-10-10T08:30:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['git', ['log', '-1', '--format=%H%n%cs']]);
  assert.equal(calls[0][2].cwd, '/sample/checkout');
});

test('a checkout without Git reports null commit fields and keeps a valid start time', () => {
  const version = readServiceVersion({
    now: () => Date.parse('2026-10-10T08:30:00.000Z'),
    runGit: () => { throw new Error('git unavailable'); },
    readKit: () => null,
  });
  assert.deepEqual(version, { commit: null, commitDate: null, kitRevision: null, startedAt: '2026-10-10T08:30:00.000Z' });
});
