import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQuotas } from '../src/collect.js';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { POLICY_DEFAULTS } from '../src/control.js';

const okRow = (provider) => ({ provider, usage: { primary: { usedPercent: 10 } } });
const history = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

function historyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-backoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'quota-probe-history.jsonl');
}

test('the Claude probe records endedStep, and does not retry', async (t) => {
  const file = historyFile(t);
  const calls = [];
  const runner = async (_cmd, args, options) => {
    calls.push({ args, timeout: options.timeout });
    const provider = args.at(-1);
    if (provider === 'claude') return JSON.stringify([{ provider, error: { message: 'Claude usage probe timed out.' } }]);
    return JSON.stringify([okRow(provider)]);
  };
  const quotas = await collectQuotas({ runner, historyFile: file, timeouts: { codex: 20000, claude: 60000, opencodego: 20000 } });
  const claudeCalls = calls.filter((call) => call.args.at(-1) === 'claude');
  assert.equal(claudeCalls.length, 1, 'a timeout is not retried at once');
  assert.deepEqual(claudeCalls[0].args, ['usage', '--format', 'json', '--provider', 'claude']);
  assert.match(quotas.find((q) => q.provider === 'claude').error, /timed out/);
  const rows = history(file);
  assert.deepEqual(rows.map((row) => [row.provider, row.endedStep]), [
    ['codex', 'completed'], ['claude', 'codexbar-timeout'], ['opencodego', 'completed'],
  ]);
  assert.ok(rows.every((row) => !('retry' in row)));
});

test('endedStep names our own timer, a codexbar exit, and a missing row', async (t) => {
  const file = historyFile(t);
  const runner = async (_cmd, args) => {
    const provider = args.at(-1);
    if (provider === 'codex') throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    if (provider === 'claude') throw Object.assign(new Error('Command failed'), { code: 2, stdout: '', stderr: '' });
    return JSON.stringify([]);
  };
  await collectQuotas({ runner, historyFile: file });
  assert.deepEqual(history(file).map((row) => [row.provider, row.endedStep]), [
    ['codex', 'our-timer'], ['claude', 'codexbar-exit'], ['opencodego', 'row-missing'],
  ]);
});

test('collectQuotas probes only the requested providers', async (t) => {
  const calls = [];
  const runner = async (_cmd, args) => { calls.push(args.at(-1)); return JSON.stringify([okRow(args.at(-1))]); };
  const quotas = await collectQuotas({ runner, historyFile: historyFile(t), providers: ['codex', 'opencodego'] });
  assert.deepEqual(calls, ['codex', 'opencodego']);
  assert.deepEqual(quotas.map((q) => q.provider), ['codex', 'opencodego']);
});

test('the quota probe policy has defaults', () => {
  assert.deepEqual(POLICY_DEFAULTS.quotaProbe, { backoffAfterTimeouts: 2, backoffMinutes: 20 });
});

function fixture() {
  const state = { now: Date.parse('2026-10-02T12:00:00.000Z'), claude: 'timeout', requests: [] };
  const cfg = loadConfig();
  cfg.quotaSeconds = 300;
  const engine = new Engine(cfg, {
    push: false, act: false, clock: () => state.now,
    collectors: {
      collectQuotas: async ({ providers }) => {
        state.requests.push(providers ? [...providers] : null);
        return ['codex', 'claude', 'opencodego'].filter((p) => !providers || providers.includes(p)).map((provider) => provider === 'claude' && state.claude === 'timeout'
          ? { provider, error: 'Claude usage probe timed out after 60 s' }
          : { provider, windows: [{ key: 'primary', usedPercent: 10 }], updatedAt: new Date(state.now).toISOString() });
      },
    },
  });
  const read = async (advanceMs) => {
    state.now += advanceMs;
    engine.readQuotas();
    await engine.quotaRead;
    engine.applyQuotaResult();
    return state.requests.at(-1);
  };
  return { state, engine, read };
}
const MIN = 60_000;
const has = (providers, name) => providers === null || providers.includes(name);

test('two Claude timeouts back off to 20 minutes, and one success returns to the normal interval', async () => {
  const { state, engine, read } = fixture();
  assert.ok(has(await read(0), 'claude'), 'first probe');
  assert.ok(has(await read(5 * MIN), 'claude'), 'one timeout keeps the normal interval');
  assert.ok(!has(await read(5 * MIN), 'claude'), 'two timeouts: no probe after 5 minutes');
  assert.ok(!has(await read(10 * MIN), 'claude'), 'no probe after 15 minutes');
  state.claude = 'ok';
  assert.ok(has(await read(5 * MIN), 'claude'), 'probe after 20 minutes');
  assert.ok(has(await read(5 * MIN), 'claude'), 'a success probes after 5 minutes again');
  assert.equal(engine.quotas.find((q) => q.provider === 'claude').error, undefined);
});

test('a backed-off Claude row stays on screen with its last good reading and age', async () => {
  const { state, engine, read } = fixture();
  state.claude = 'ok';
  await read(0);
  const goodAt = state.now;
  state.claude = 'timeout';
  await read(5 * MIN);
  await read(5 * MIN);
  const skipped = await read(5 * MIN);
  assert.ok(!has(skipped, 'claude'));
  const claude = engine.quotas.find((q) => q.provider === 'claude');
  assert.equal(claude.stale, true);
  assert.equal(claude.staleSince, new Date(goodAt).toISOString());
  assert.equal(claude.windows[0].usedPercent, 10);
  assert.match(claude.error, /timed out/);
});
