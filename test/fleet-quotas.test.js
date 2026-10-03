import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const load = () => import('../src/fleet-quotas.js');
const account = { harness: 'codex', accountKey: 'a'.repeat(64), scope: ['factory-zero'] };

test('account provisioning writes only the HMAC and scope, never the account identity or key', async () => {
  const { provisionAccount } = await load();
  const file = path.join(process.env.HERDR_BOSS_DIR, 'fleet-accounts.json');
  const body = { harness: 'codex', identity: 'account@example.invalid', hmacKey: 'invented-shared-hmac-key-with-32-bytes', scope: ['factory-zero'] };
  const result = provisionAccount(body, { file });
  assert.deepEqual(result, { harness: 'codex', accountKey: createHmac('sha256', body.hmacKey).update('codex\0account@example.invalid').digest('hex'), scope: ['factory-zero'] });
  const disk = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(disk, /account@example|invented-shared/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(provisionAccount(body, { file }), result);
});

test('quota export preserves a partial reading and reports a missing reader as unknown', async () => {
  const { fleetQuotas } = await load();
  const rows = fleetQuotas([{ provider: 'codex', windows: [{ key: 'primary', usedPercent: 25, resetsAt: '2026-10-09T10:00:00Z' }, { key: 'secondary', usedPercent: null }] }], [account, { ...account, harness: 'pi', accountKey: 'b'.repeat(64) }], 'factory-zero');
  assert.deepEqual(rows, [
    { harness: 'codex', accountKey: account.accountKey, lane: 'primary', usedPercent: 25, resetAt: '2026-10-09T10:00:00Z', status: 'ok' },
    { harness: 'codex', accountKey: account.accountKey, lane: 'secondary', usedPercent: null, resetAt: null, status: 'unknown' },
    { harness: 'pi', accountKey: 'b'.repeat(64), lane: 'unknown', usedPercent: null, resetAt: null, status: 'unknown' },
  ]);
  assert.deepEqual(fleetQuotas([], [account], 'another-factory'), []);
});
