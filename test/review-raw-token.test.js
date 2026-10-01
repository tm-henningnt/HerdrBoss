import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRawTokens, TOKEN_TTL_MS, TOKEN_MAX } from '../src/review-raw.js';

const pack = { slug: 'shop', pack: 'checkout', version: 1 };

test('a token is 32 random bytes in hex, names one pack version, and lives 30 minutes', () => {
  let now = 1_000_000;
  const tokens = createRawTokens({ now: () => now });
  const issued = tokens.issue(pack);
  assert.match(issued.token, /^[0-9a-f]{64}$/);
  assert.equal(issued.expiresAt, now + TOKEN_TTL_MS);
  assert.equal(TOKEN_TTL_MS, 30 * 60 * 1000);
  assert.notEqual(tokens.issue(pack).token, issued.token, 'each token is new');
  assert.deepEqual(tokens.lookup(issued.token), pack);
  now += TOKEN_TTL_MS - 1;
  assert.deepEqual(tokens.lookup(issued.token), pack, 'the token is valid until its expiry');
  now += 1;
  assert.equal(tokens.lookup(issued.token), null, 'the token is refused at its expiry');
});

test('an unknown value and a value of the wrong shape give no entry', () => {
  const tokens = createRawTokens();
  for (const value of ['', 'abc', 'f'.repeat(64), undefined, null, 5, '__proto__', 'constructor']) assert.equal(tokens.lookup(value), null, String(value));
});

test('the store drops expired tokens and keeps at most the cap of live tokens', () => {
  let now = 0;
  const tokens = createRawTokens({ now: () => now, max: 3 });
  const first = tokens.issue(pack);
  const second = tokens.issue(pack);
  const third = tokens.issue(pack);
  assert.equal(tokens.size(), 3);
  const fourth = tokens.issue(pack);
  assert.equal(tokens.size(), 3, 'the cap holds');
  assert.equal(tokens.lookup(first.token), null, 'the oldest token gives way');
  for (const entry of [second, third, fourth]) assert.deepEqual(tokens.lookup(entry.token), pack);
  now += TOKEN_TTL_MS;
  tokens.issue(pack);
  assert.equal(tokens.size(), 1, 'an issue drops the expired tokens');
});

test('the default cap is 200', () => {
  assert.equal(TOKEN_MAX, 200);
  const tokens = createRawTokens();
  for (let index = 0; index < TOKEN_MAX + 25; index += 1) tokens.issue(pack);
  assert.equal(tokens.size(), TOKEN_MAX);
});
