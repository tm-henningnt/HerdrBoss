import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQuotas } from '../src/collect.js';
import { renderBulletin } from '../src/rules.js';

const rows = [
  { provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: '2026-10-01T00:00:00Z' } } },
  { provider: 'claude', error: { message: 'Claude usage probe timed out.' } },
];
const exitOne = (stdout) => async () => { const e = new Error('Command failed'); e.code = 1; e.stdout = stdout; e.stderr = ''; throw e; };

test('a codexbar exit 1 with provider rows keeps the good rows', async () => {
  const quotas = await collectQuotas({ runner: exitOne(JSON.stringify(rows)) });
  assert.equal(quotas.length, 2);
  assert.equal(quotas.find((q) => q.provider === 'claude').error, 'Claude usage probe timed out.');
  assert.ok(quotas.find((q) => q.provider === 'codex').windows.length >= 1);
});

test('a codexbar exit 1 without JSON output still fails with the exit code', async () => {
  await assert.rejects(collectQuotas({ runner: exitOne('not json') }), { message: 'codexbar exited with code 1' });
});

const cfg = { quota: { warnPercent: 80 }, port: 4477, host: '127.0.0.1' };
const snap = (quotas) => ({ updatedAt: Date.parse('2026-09-28T01:00:00Z'), quotas, herdr: { panes: [] }, projects: [] });
const bulletin = (quotas) => renderBulletin(snap(quotas), { alerts: [], advice: [] }, cfg);

test('the bulletin says quota data unavailable without quota rows, never no restrictions', () => {
  const text = bulletin([]);
  assert.match(text, /Quota data unavailable: the quota collector failed/);
  assert.doesNotMatch(text, /No quota or active machine restrictions/);
});

test('the bulletin names a provider whose quota row failed', () => {
  const text = bulletin([{ provider: 'codex', windows: [] }, { provider: 'claude', error: 'Claude usage probe timed out.' }]);
  assert.match(text, /Quota data unavailable for Claude\./);
  assert.doesNotMatch(text, /No quota or active machine restrictions/);
});
