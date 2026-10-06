import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQuotas } from '../src/collect.js';
import { fleetQuotas } from '../src/fleet-quotas.js';
import { validateFile } from './factory/schema-check.js';
import { parseOpenCodeStats, readOpenCodeEstimate, readOpenCodeGoQuota, ESTIMATE_LABEL } from '../src/opencode-estimate.js';

const OUTPUT = `last 7 days · all projects

MODELS
model                                 tokens       steps        cost
opencode-go/deepseek-v4.1-flash#d…      270m        1.9k       $2.37
opencode/big-pickle#default           111.7m        1.1k       $0.00
opencode/nemotron-3-ultra-free#de…      9.4m          53       $0.00
opencode-go/qwen3.8-flash#default      18.6k           1       $0.00

+2 more models
`;
const missing = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
const historyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-estimate-')), 'history.jsonl');

test('the parser keeps only the numbers and the model names of OpenCode Go rows', () => {
  const estimate = parseOpenCodeStats(OUTPUT, 7);
  assert.deepEqual(estimate, {
    days: 7, tokens: 270_018_600, costUsd: 2.37, omittedModels: 2,
    models: [{ model: 'opencode-go/deepseek-v4.1-flash', tokens: 270_000_000, costUsd: 2.37 }, { model: 'opencode-go/qwen3.8-flash', tokens: 18_600, costUsd: 0 }],
  });
});

test('the parser returns null for output without a model table', () => {
  assert.equal(parseOpenCodeStats('', 7), null);
  assert.equal(parseOpenCodeStats('Error: something broke\n', 7), null);
});

test('output with no OpenCode Go row gives a zero estimate', () => {
  const estimate = parseOpenCodeStats('MODELS\nmodel tokens steps cost\nopencode/big-pickle#default  1.2m  3  $0.00\n', 3);
  assert.deepEqual(estimate, { days: 3, tokens: 0, costUsd: 0, omittedModels: 0, models: [] });
});

test('the estimate runs only opencode stats with the day count and no login command', async () => {
  const calls = [];
  const estimate = await readOpenCodeEstimate({ days: 14, run: async (command, args) => { calls.push([command, args]); return OUTPUT; } });
  assert.deepEqual(calls, [['opencode', ['stats', '--models', '--days', '14']]]);
  assert.equal(estimate.days, 14);
});

test('a missing opencode or a failed command gives no estimate', async () => {
  assert.equal(await readOpenCodeEstimate({ days: 7, run: async () => { throw missing; } }), null);
  assert.equal(await readOpenCodeEstimate({ days: 7, run: async () => { throw new Error('exit 1'); } }), null);
});

test('the OpenCode Go reader stays unknown with a reason, the manual reset time, and the estimate', async () => {
  const row = await readOpenCodeGoQuota({ opencode: { resetAt: '2026-10-09T10:00:00+02:00', days: 7 }, run: async () => OUTPUT });
  assert.equal(row.provider, 'opencodego');
  assert.equal(row.unavailable, true);
  assert.equal(row.reason, 'no usage reader in this factory');
  assert.equal(row.error, row.reason);
  assert.equal(row.windows, undefined);
  assert.equal(row.resetAt, '2026-10-09T08:00:00.000Z');
  assert.equal(row.estimate.tokens, 270_018_600);
  assert.equal(ESTIMATE_LABEL, 'used in this factory (local estimate)');
});

test('the OpenCode Go reader ignores a blank or invalid reset time and uses 7 days by default', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push(args); return OUTPUT; };
  for (const resetAt of ['', 'tomorrow', null, undefined]) {
    const row = await readOpenCodeGoQuota({ opencode: { resetAt }, run });
    assert.equal(row.resetAt, null);
  }
  assert.deepEqual(calls[0], ['stats', '--models', '--days', '7']);
});

test('a factory shows OpenCode Go as unknown with the estimate and passes the settings to the reader', async () => {
  let seen = null;
  const readers = { opencodego: (options) => { seen = options.opencode; return readOpenCodeGoQuota({ ...options, run: async () => OUTPUT }); } };
  const runner = async () => { throw missing; };
  const quotas = await collectQuotas({ runner, factory: true, readers, historyFile: historyFile(), providers: ['opencodego'], opencode: { resetAt: '2026-10-09T10:00:00Z', days: 5 } });
  assert.deepEqual(seen, { resetAt: '2026-10-09T10:00:00Z', days: 5 });
  assert.equal(quotas[0].unavailable, true);
  assert.equal(quotas[0].estimate.models.length, 2);
});

test('the Fleet summary quota row is unknown, keeps the reset time, and carries the estimate', async () => {
  const row = await readOpenCodeGoQuota({ opencode: { resetAt: '2026-10-09T10:00:00Z', days: 7 }, run: async () => OUTPUT });
  const account = { harness: 'opencode', accountKey: 'c'.repeat(64), scope: ['factory-zero'] };
  const [quota] = fleetQuotas([row], [account], 'factory-zero');
  assert.deepEqual(quota, { harness: 'opencode', accountKey: account.accountKey, lane: 'unknown', usedPercent: null, resetAt: '2026-10-09T10:00:00Z', status: 'unknown',
    estimate: { days: 7, tokens: 270_018_600, costUsd: 2.37, omittedModels: 2 } });
  assert.doesNotMatch(JSON.stringify(quota), /usedPercent":\d/);
});
