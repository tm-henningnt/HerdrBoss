import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQuotas } from '../src/collect.js';
import { spawnJsonRpc as realSpawnJsonRpc, buildWindow, readCodexQuota, readQuota, LINUX_READERS } from '../src/quota-readers.js';
import { fleetQuotas } from '../src/fleet-quotas.js';

const missingReader = Object.assign(new Error('spawn codexbar ENOENT'), { code: 'ENOENT', syscall: 'spawn codexbar', path: 'codexbar' });
const historyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quota-readers-')), 'history.jsonl');
const reading = (provider) => ({ provider, plan: 'pro', windows: [{ key: 'primary', usedPercent: 10, resetsAt: '2026-10-06T12:00:00.000Z', windowMinutes: 300 }] });

// Slice 1: the reader seam.

test('a factory process uses the Linux reader when codexbar is missing', async () => {
  const asked = [];
  const readers = { codex: async (options) => { asked.push(options.timeoutMs); return reading('codex'); } };
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; }, factory: true, readers, historyFile: historyFile(), timeouts: { codex: 1234 } });
  const codex = quotas.find((row) => row.provider === 'codex');
  assert.equal(codex.windows[0].usedPercent, 10);
  assert.equal(codex.unavailable, undefined);
  assert.deepEqual(asked, [1234]);
});

test('a provider without a Linux reader keeps the unknown reading in a factory', async () => {
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; }, factory: true, readers: { codex: async () => reading('codex') }, historyFile: historyFile() });
  for (const provider of ['claude', 'opencodego']) {
    const row = quotas.find((item) => item.provider === provider);
    assert.equal(row.unavailable, true);
    assert.match(row.reason, /no usage reader in this factory/);
  }
});

test('a Mac process keeps the unknown reading and never calls a reader', async () => {
  let called = 0;
  const readers = { codex: async () => { called += 1; return reading('codex'); } };
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; }, factory: false, readers, historyFile: historyFile() });
  assert.equal(called, 0);
  assert.equal(quotas.find((row) => row.provider === 'codex').reason, 'no usage reader in this factory');
});

test('codexbar rows win over the Linux reader', async () => {
  let called = 0;
  const runner = async () => JSON.stringify([{ provider: 'codex', usage: { primary: { usedPercent: 5, resetsAt: '2026-10-06T12:00:00Z', windowMinutes: 300 } } }]);
  const quotas = await collectQuotas({ runner, factory: true, readers: { codex: async () => { called += 1; return reading('codex'); } }, historyFile: historyFile(), providers: ['codex'] });
  assert.equal(called, 0);
  assert.equal(quotas[0].windows[0].usedPercent, 5);
});

test('readQuota returns null for a provider without a reader', async () => {
  assert.equal(await readQuota('pi', {}), null);
  assert.equal(typeof LINUX_READERS.codex, 'function');
});

// Slice 2: the row builder.

test('buildWindow converts Unix seconds to an ISO string that fleetQuotas accepts', () => {
  const window = buildWindow({ key: 'primary', usedPercent: 42, resetsAtSeconds: 1790000000, windowMinutes: 300 });
  assert.equal(window.resetsAt, '2026-09-21T14:13:20.000Z');
  assert.equal(window.windowMinutes, 300);
  const rows = fleetQuotas([{ provider: 'codex', windows: [window] }], [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['win1'] }], 'win1');
  assert.equal(rows[0].resetAt, '2026-09-21T14:13:20Z');
  assert.equal(rows[0].usedPercent, 42);
  assert.equal(rows[0].status, 'ok');
});

test('buildWindow drops a percent outside 0 to 100', () => {
  for (const usedPercent of [120, -1, NaN, null, undefined, '5']) {
    assert.equal(buildWindow({ key: 'primary', usedPercent, resetsAtSeconds: 1790000000 }).usedPercent, null, String(usedPercent));
  }
  assert.equal(buildWindow({ key: 'primary', usedPercent: 0 }).usedPercent, 0);
  assert.equal(buildWindow({ key: 'primary', usedPercent: 100 }).usedPercent, 100);
});

test('buildWindow gives a null reset time for a missing or invalid value', () => {
  for (const resetsAtSeconds of [undefined, null, 'x', NaN, Infinity]) assert.equal(buildWindow({ key: 'primary', usedPercent: 1, resetsAtSeconds }).resetsAt, null);
});

// Slice 3: the Codex reader on a fake transport.

// The fake replays recorded JSON-RPC lines. It records what the reader writes and how it ends the child.
function fakeTransport({ replies, silent = false, error = null }) {
  const state = { sent: [], signals: [], spawned: null, closed: false };
  const spawnJsonRpc = (spec) => {
    state.spawned = spec;
    let onLine = () => {}, onClose = () => {}, onError = () => {};
    queueMicrotask(() => { if (error) onError(error); });
    return {
      onLine: (fn) => { onLine = fn; }, onClose: (fn) => { onClose = fn; }, onError: (fn) => { onError = fn; },
      send(message) {
        state.sent.push(message);
        if (silent || message.id === undefined) return;
        const reply = replies[message.method];
        if (reply) queueMicrotask(() => onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })));
      },
      closeInput() { state.closed = true; },
      kill(signal) { state.signals.push(signal); },
    };
  };
  return { spawnJsonRpc, state };
}
const INITIALIZED = { result: { userAgent: 'codex/0.160.1' } };
const LIMITS = { result: { rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790500000 }, credits: null }, rateLimitsByLimitId: null } };

test('the Codex reader maps primary and secondary windows', async () => {
  const { spawnJsonRpc, state } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': LIMITS } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000, now: () => Date.parse('2026-10-06T10:00:00Z') });
  assert.equal(row.provider, 'codex');
  assert.equal(row.plan, 'pro');
  assert.deepEqual(row.windows.map((w) => w.key), ['primary', 'secondary']);
  assert.equal(row.windows[0].resetsAt, new Date(1790000000 * 1000).toISOString());
  assert.equal(row.windows[0].windowMinutes, 300);
  assert.equal(row.windows[1].usedPercent, 12);
  assert.equal(row.observedAt, '2026-10-06T10:00:00.000Z');
  assert.equal(state.spawned.command, 'codex');
  assert.deepEqual(state.spawned.args, ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(state.sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.ok(state.sent[0].params.clientInfo.name && state.sent[0].params.clientInfo.version);
  assert.equal(state.sent[1].id, undefined);
  assert.ok(state.closed);
  assert.deepEqual(state.signals, ['SIGTERM']);
});

test('the Codex reader passes no credential in argv or the child environment', async () => {
  const { spawnJsonRpc, state } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': LIMITS } });
  await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(state.spawned.env, undefined);
});

test('the Codex reader adds each named extra limit as an extra window', async () => {
  const extra = { result: { rateLimits: LIMITS.result.rateLimits, rateLimitsByLimitId: { codex: LIMITS.result.rateLimits, codex_other: { limitId: 'codex_other', limitName: 'Other model', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: null } } } };
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': extra } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.deepEqual(row.windows.map((w) => w.key), ['primary', 'secondary', 'codex_other']);
  assert.equal(row.windows[2].extra, true);
  assert.equal(row.windows[2].label, 'Other model');
});

test('a not-logged-in JSON-RPC error gives an unavailable row with the login reason', async () => {
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': { error: { code: -32600, message: 'not logged in' } } } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, true);
  assert.equal(row.reason, 'no login for this harness in this factory');
  assert.equal(row.error, row.reason);
});

test('a backend JSON-RPC error gives a failed row, not an unavailable row', async () => {
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': { error: { code: -32000, message: 'rate limit exceeded' } } } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, undefined);
  assert.equal(row.error, 'Codex usage read failed: rate limit exceeded');
});

test('a refused method names the protocol change', async () => {
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': { error: { code: -32601, message: 'Method not found' } } } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, undefined);
  assert.equal(row.error, 'codex app-server protocol changed');
});

test('a failed Codex read keeps the last good reading as stale, without the unknown marker', async () => {
  const { keepStaleRows } = await import('../src/collect.js');
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': { error: { code: -32000, message: 'backend unavailable' } } } });
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; }, factory: true, readers: { codex: (options) => readCodexQuota({ ...options, spawnJsonRpc }) }, historyFile: historyFile(), providers: ['codex'] });
  const good = { provider: 'codex', plan: 'pro', windows: [{ key: 'primary', usedPercent: 10, resetsAt: '2026-10-06T12:00:00.000Z', windowMinutes: 300 }], observedAt: '2026-10-06T09:00:00.000Z' };
  const [row] = keepStaleRows(quotas, [good], Date.parse(good.observedAt), Date.parse('2026-10-06T09:05:00Z'));
  assert.equal(row.stale, true);
  assert.equal(row.windows[0].usedPercent, 10);
  assert.equal(row.unavailable, undefined);
  assert.match(row.error, /backend unavailable/);
  assert.equal(fleetQuotas([row], [{ harness: 'codex', accountKey: 'a'.repeat(64), scope: ['f'] }], 'f')[0].status, 'unknown');
});

test('an API key login gives an unavailable row', async () => {
  const empty = { result: { rateLimits: { planType: null, primary: null, secondary: null } } };
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': empty } });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, true);
  assert.match(row.reason, /API key|no usage limit/i);
  assert.doesNotMatch(row.reason, /no usage reader/);
});

test('a missing codex binary gives an unavailable row that names codex', async () => {
  const { spawnJsonRpc } = fakeTransport({ replies: {}, error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, true);
  assert.equal(row.reason, 'codex is not installed in this factory');
});

test('a child that never answers ends at the timeout and receives SIGTERM', async () => {
  const { spawnJsonRpc, state } = fakeTransport({ replies: {}, silent: true });
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 20 });
  assert.equal(row.unavailable, undefined);
  assert.match(row.error, /^Codex usage read timed out after \d+ s$/);
  assert.ok(state.signals.includes('SIGTERM'));
});

test('a child that exits before it answers gives a failed row', async () => {
  const state = { signals: [] };
  const spawnJsonRpc = () => {
    let onClose = () => {};
    queueMicrotask(() => onClose(1));
    return { onLine() {}, onError() {}, onClose: (fn) => { onClose = fn; }, send() {}, closeInput() {}, kill(s) { state.signals.push(s); } };
  };
  const row = await readCodexQuota({ spawnJsonRpc, timeoutMs: 1000 });
  assert.equal(row.unavailable, undefined);
  assert.match(row.error, /exited before it answered/);
});

test('collectQuotas returns the Codex reader row in a factory with no codexbar', async () => {
  const { spawnJsonRpc } = fakeTransport({ replies: { initialize: INITIALIZED, 'account/rateLimits/read': LIMITS } });
  const readers = { codex: (options) => readCodexQuota({ ...options, spawnJsonRpc }) };
  const quotas = await collectQuotas({ runner: async () => { throw missingReader; }, factory: true, readers, historyFile: historyFile(), providers: ['codex'] });
  assert.deepEqual(quotas[0].windows.map((w) => w.key), ['primary', 'secondary']);
});

// The child environment: the real spawn helper gets an allow-listed environment only.
test('the real spawn helper gives the child no secret from the parent environment', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-bin-'));
  const stub = path.join(bin, 'reader-env-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'{"keys":"%s"}\\n\' "$(env | cut -d= -f1 | tr \'\\n\' \' \')"\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HERDR_BOSS_TOKEN: process.env.HERDR_BOSS_TOKEN, CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  process.env.HERDR_BOSS_TOKEN = 'not-a-real-secret';
  process.env.OPENAI_API_KEY = 'not-a-real-key';
  process.env.CODEX_HOME = '/tmp/codex-home-for-test';
  try {
    const keys = await new Promise((resolve, reject) => {
      const child = realSpawnJsonRpc({ command: 'reader-env-stub' });
      child.onLine((line) => resolve(JSON.parse(line).keys.split(/\s+/)));
      child.onError(reject);
      setTimeout(() => reject(new Error('no output from the stub')), 5000).unref();
    });
    assert.ok(!keys.includes('HERDR_BOSS_TOKEN'));
    assert.ok(!keys.includes('OPENAI_API_KEY'));
    assert.ok(keys.includes('PATH'));
    assert.ok(keys.includes('CODEX_HOME'));
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
