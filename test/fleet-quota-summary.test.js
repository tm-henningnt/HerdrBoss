import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQuotas } from '../src/collect.js';
import { readCodexQuota } from '../src/quota-readers.js';
import { readOpenCodeGoQuota } from '../src/opencode-estimate.js';
import { buildFleetSummary } from '../src/fleet-summary.js';
import { validateFile } from './factory/schema-check.js';

const schemaFile = new URL('../docs/contracts/schema/fleet-summary.v1.schema.json', import.meta.url).pathname;
const missing = Object.assign(new Error('spawn codexbar ENOENT'), { code: 'ENOENT' });
const LIMITS = { rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790400000 } } };
const STATS = 'MODELS\nmodel tokens steps cost\nopencode-go/deepseek-v4.1-flash#default  270m  1.9k  $2.37\n+2 more models\n';

// A fake app server that replays one recorded answer for each request.
function spawnJsonRpc() {
  let onLine = () => {};
  return {
    onLine: (fn) => { onLine = fn; }, onClose() {}, onError() {}, closeInput() {}, kill() {},
    send(message) {
      if (message.id === undefined) return;
      const result = message.method === 'initialize' ? { userAgent: 'codex/0.160.1' } : LIMITS;
      queueMicrotask(() => onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })));
    },
  };
}

test('a factory Fleet summary has two ok Codex rows and an unknown OpenCode Go row with the estimate', async () => {
  const readers = {
    codex: (options) => readCodexQuota({ ...options, spawnJsonRpc }),
    opencodego: (options) => readOpenCodeGoQuota({ ...options, run: async () => STATS }),
  };
  const historyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-quota-')), 'history.jsonl');
  const quotas = await collectQuotas({ runner: async () => { throw missing; }, factory: true, readers, historyFile, providers: ['codex', 'opencodego'], opencode: { resetAt: '2026-10-09T10:00:00Z', days: 7 } });
  const accounts = [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['win1'] }, { harness: 'opencode', accountKey: 'b'.repeat(64), scope: ['win1'] }];
  const settings = { factoryId: 'win1', name: 'win1', dashboardUrl: 'https://win1.example', shareItemTitles: false, accounts };
  const health = { schema: 1, contractVersion: '1.0.0', version: '0.1.0', kitRevision: 'abcdef012345', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: null };
  const summary = buildFleetSummary({ settings, state: { quotas, projects: [], machine: {}, control: {} }, health, now: Date.parse('2026-10-06T10:00:00Z'), kind: 'container' });
  assert.deepEqual(validateFile(summary, schemaFile), []);
  const codex = summary.quotas.filter((row) => row.harness === 'codex');
  assert.deepEqual(codex.map((row) => [row.lane, row.usedPercent, row.status]), [['primary', 37, 'ok'], ['secondary', 12, 'ok']]);
  assert.equal(codex[0].resetAt, '2026-09-21T14:13:20Z');
  const [opencode] = summary.quotas.filter((row) => row.harness === 'opencode');
  assert.equal(summary.quotas.length, 3);
  assert.equal(opencode.status, 'unknown');
  assert.equal(opencode.usedPercent, null);
  assert.equal(opencode.resetAt, '2026-10-09T10:00:00Z');
  assert.deepEqual(opencode.estimate, { days: 7, tokens: 270_000_000, costUsd: 2.37, omittedModels: 2 });
});
