import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// All logs and ids below are invented fixtures in a temporary HOME. The real logs are never read.
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-prices-'));
process.env.HERDR_BOSS_DIR = path.join(ROOT, 'boss');
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const {
  parseClaudeLine, scanSpend, spendSummary, formatSpend, priceFor, costOf, loadPrices,
  validatePriceOverrides, writePriceOverrides, readPriceOverrides, learnHandoffs,
} = await import('../src/spend.js');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const M = 1e6;

let homeCount = 0;
function newHome() {
  const home = path.join(ROOT, `home-${homeCount += 1}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}
function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
function claudeRow({ id = 'm1', cwd, model = 'claude-sonnet-5-5', usage = {}, sessionId = 's1' }) {
  return {
    type: 'assistant', timestamp: iso(NOW), cwd, sessionId, requestId: id,
    message: { id, model, role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
  };
}
const only = (fields) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields });
const cost = (model, entry) => costOf(entry, 'claude', model, priceFor(loadPrices())).costUsd;

test('each Claude price column multiplies its own token count', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  close(cost('claude-opus-5-5', only({ input: M })), 4);
  close(cost('claude-opus-5-5', only({ output: M })), 20);
  close(cost('claude-opus-5-5', only({ cacheRead: M })), 0.20);
  close(cost('claude-opus-5-5', only({ cacheWrite: M })), 5);
  close(cost('claude-opus-5-5', only({ cacheWrite: M, cacheWrite1h: M })), 8);
  close(cost('claude-sonnet-5-5', only({ input: M, output: M, cacheRead: M, cacheWrite: M })), 2 + 10 + 0.20 + 2.5);
  close(cost('claude-haiku-4-5', only({ input: M, output: M, cacheRead: M, cacheWrite: M, cacheWrite1h: M })), 1 + 5 + 0.10 + 2);
  close(cost('claude-fable-5-1', only({ cacheRead: M })), 0.25);
  close(cost('claude-fable-5-1', only({ cacheWrite: M, cacheWrite1h: M })), 20);
  close(cost('claude-opus-5', only({ input: M, output: M, cacheRead: M, cacheWrite: M })), 5 + 25 + 0.50 + 6.25);
  close(cost('claude-sonnet-5', only({ input: M, cacheWrite: M, cacheWrite1h: M })), 2 + 4);
});

test('the price table keeps a source and a date, and marks the Opus 5.5 cache figures unconfirmed', () => {
  const prices = loadPrices();
  const opus = prices['claude/claude-opus-5-5'];
  assert.deepEqual([...opus.unconfirmed].sort(), ['cacheRead', 'cacheWrite', 'cacheWrite1h']);
  assert.equal(prices['claude/claude-sonnet-5-5'].unconfirmed, undefined);
  assert.match(opus.source, /Anthropic API pricing/);
  assert.match(opus.date, /^\d{4}-\d{2}-\d{2}$/);
  // The Fable 5.1 cache read of 0.25 is 0.025 times the input price, so it is unconfirmed too.
  assert.deepEqual(prices['claude/claude-fable-5-1'].unconfirmed, ['cacheRead']);
  assert.equal(prices['claude/claude-opus-5'].removed, true);
  assert.equal(prices['claude/claude-sonnet-5'].removed, true);
});

test('the Claude parser reads the 5 minute and 1 hour cache write split', () => {
  const split = parseClaudeLine(JSON.stringify(claudeRow({
    usage: { output_tokens: 1, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } },
  })), {});
  assert.equal(split.usage.cacheWrite, 1000);
  assert.equal(split.usage.cacheWrite1h, 400);
  const plain = parseClaudeLine(JSON.stringify(claudeRow({ usage: { output_tokens: 1, cache_creation_input_tokens: 1000 } })), {});
  assert.equal(plain.usage.cacheWrite, 1000);
  assert.equal(plain.usage.cacheWrite1h, undefined);
});

test('a scan prices the split at the 5 minute and the 1 hour cache write price', async () => {
  const home = newHome();
  const dataDir = path.join(home, 'boss');
  writeLines(path.join(home, '.claude', 'projects', '-x', 'a.jsonl'), [
    claudeRow({ id: 'a', cwd: '/x/repo', usage: { cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 600000, ephemeral_1h_input_tokens: 400000 } } }),
    claudeRow({ id: 'b', cwd: '/x/repo', usage: { cache_creation_input_tokens: M } }),
  ]);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot: path.join(home, 'wt'), fillUsage: false });
  const summary = spendSummary({ dataDir, days: 1, now: NOW });
  // Message a: 0.6M at 2.50 plus 0.4M at 4.00 = 3.10. Message b has no split, so 1M at 2.50.
  assert.ok(Math.abs(summary.days[0].total.costUsd - (3.1 + 2.5)) < 1e-9);
  assert.equal(summary.days[0].total.tokens, 2 * M);
  assert.equal(summary.days[0].total.unpricedTokens, 0);
});

test('a model that the table does not list stays unpriced', () => {
  const priceOf = priceFor(loadPrices());
  assert.equal(priceOf('claude', 'claude-made-up-1'), null);
  assert.deepEqual(costOf(only({ input: M }), 'claude', 'claude-made-up-1', priceOf), { costUsd: 0, unpricedTokens: M });
});

test('the summary and the CLI label the cost as an API-price equivalent and list unconfirmed prices', async () => {
  const home = newHome();
  const dataDir = path.join(home, 'boss');
  const now = Date.now();
  const row = { ...claudeRow({ cwd: '/x/repo', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 } }), timestamp: iso(now) };
  writeLines(path.join(home, '.claude', 'projects', '-x', 'a.jsonl'), [row]);
  await scanSpend({ dataDir, home, now, repos: [], worktreeRoot: path.join(home, 'wt'), fillUsage: false });
  const summary = spendSummary({ dataDir, days: 1, now });
  assert.equal(summary.costLabel, 'API-price equivalent');
  assert.deepEqual(summary.unconfirmedPrices, ['claude/claude-opus-5-5']);
  const text = formatSpend(summary);
  assert.match(text, /USD API-price equivalent/);
  assert.match(text, /Unconfirmed prices: claude\/claude-opus-5-5/);
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: dataDir };
  const out = spawnSync(process.execPath, [cli, 'spend', '--days', '1'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /USD API-price equivalent/);
});

test('a price override is validated, stored, and applied', () => {
  const home = newHome();
  const dataDir = path.join(home, 'boss');
  const good = validatePriceOverrides({ models: { 'claude/claude-opus-5-5': { cacheRead: 0.4, input: 4.5 } } });
  assert.deepEqual(good.errors, []);
  const bad = [
    null, [], { models: [] }, { extra: 1 },
    { models: { 'claude/claude-made-up-1': { input: 1 } } },
    { models: { 'claude/claude-opus-5-5': { colour: 1 } } },
    { models: { 'claude/claude-opus-5-5': { input: -1 } } },
    { models: { 'claude/claude-opus-5-5': { input: 1001 } } },
    { models: { 'claude/claude-opus-5-5': { input: '4' } } },
    { models: { 'claude/claude-opus-5-5': { input: NaN } } },
    { models: { 'claude/claude-opus-5-5': { unconfirmed: [] } } },
  ];
  for (const body of bad) assert.ok(validatePriceOverrides(body).errors.length > 0, JSON.stringify(body));
  assert.deepEqual(validatePriceOverrides({ models: { 'claude/claude-opus-5-5': { input: 0 } } }).errors, []);
  assert.deepEqual(validatePriceOverrides({ models: { 'claude/claude-opus-5-5': { input: 1000 } } }).errors, []);

  assert.throws(() => writePriceOverrides({ models: { 'claude/claude-opus-5-5': { input: -1 } } }, { dataDir }), /input/);
  assert.equal(fs.existsSync(path.join(dataDir, 'spend-prices.override.json')), false);
  writePriceOverrides({ models: { 'claude/claude-opus-5-5': { cacheRead: 0.4 } } }, { dataDir });
  assert.deepEqual(readPriceOverrides(dataDir), { models: { 'claude/claude-opus-5-5': { cacheRead: 0.4 } } });
  const merged = loadPrices(dataDir)['claude/claude-opus-5-5'];
  assert.equal(merged.cacheRead, 0.4);
  assert.equal(merged.input, 4);
  // The Owner set the changed figure, so it is no longer unconfirmed. The other cache figures stay so.
  assert.deepEqual([...merged.unconfirmed].sort(), ['cacheWrite', 'cacheWrite1h']);
  // The default table is unchanged for other data directories.
  assert.equal(loadPrices(path.join(home, 'other'))['claude/claude-opus-5-5'].cacheRead, 0.20);
  // An empty body clears the override.
  writePriceOverrides({ models: {} }, { dataDir });
  assert.equal(loadPrices(dataDir)['claude/claude-opus-5-5'].cacheRead, 0.20);
  // A damaged file is ignored, and a bad entry in a hand-edited file is skipped.
  fs.writeFileSync(path.join(dataDir, 'spend-prices.override.json'), '{broken');
  assert.equal(loadPrices(dataDir)['claude/claude-opus-5-5'].cacheRead, 0.20);
  fs.writeFileSync(path.join(dataDir, 'spend-prices.override.json'), JSON.stringify({ models: { 'claude/claude-opus-5-5': { input: 99999 }, 'claude/claude-haiku-4-5': { input: 1.5 } } }));
  assert.equal(loadPrices(dataDir)['claude/claude-opus-5-5'].input, 4);
  assert.equal(loadPrices(dataDir)['claude/claude-haiku-4-5'].input, 1.5);
});

test('the Boss role covers the live Boss session and earlier Boss sessions from the handoff records', async () => {
  const home = newHome();
  const dataDir = path.join(home, 'boss');
  const repo = path.join(home, 'Projects', 'HerdrBoss');
  const shop = path.join(home, 'Projects', 'Shop');
  const repos = [{ slug: 'herdrboss', repo }, { slug: 'shop', repo: shop }];
  const folder = path.join(home, '.claude', 'projects', '-boss');
  const log = (session, cwd, id) => writeLines(path.join(folder, `${session}.jsonl`), [claudeRow({ id, cwd, sessionId: session, usage: { output_tokens: 10 } })]);
  log('boss-old-1', repo, 'a');
  log('boss-old-2', repo, 'b');
  log('boss-live-9', repo, 'c');
  log('orch-live-7', repo, 'd');
  log('orch-old-3', repo, 'e');
  log('shop-orch-1', shop, 'f');
  // The Boss handover: old-1 handed over to old-2, and old-2 to the live session, which is in a pane.
  const handoffs = [
    { id: 'h1', status: 'activated', boss: true, project: 'boss', label: 'boss', sessionId: 'boss-old-1', migratedId: 'boss-old-2' },
    { id: 'h2', status: 'activated', boss: true, project: 'boss', label: 'boss', sessionId: 'boss-old-2', migratedId: null },
    { id: 'h3', status: 'activated', project: 'shop', label: 'orch', sessionId: 'shop-orch-1', migratedId: 'orch-old-3' },
  ];
  const panes = [
    { label: 'boss', orch: true, agent: 'claude', sessionId: 'boss-live-9', cwd: repo },
    { label: 'orch', orch: true, agent: 'claude', sessionId: 'orch-live-7', cwd: repo },
  ];
  await scanSpend({ dataDir, home, now: NOW, repos, worktreeRoot: path.join(home, 'wt'), panes, handoffs, fillUsage: false });
  const day = spendSummary({ dataDir, days: 1, now: NOW }).days[0];
  const byRole = Object.fromEntries(day.roles.map((r) => [r.role, r.tokens]));
  // Three Boss sessions: two from the records and one live. The others in the same folder are orchestrators.
  assert.equal(byRole.boss, 30);
  assert.equal(byRole.orchestrator, 30);
  assert.equal(byRole.worker, undefined);
  const stored = fs.readdirSync(dataDir).map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('\n');
  for (const id of ['boss-old-1', 'boss-old-2', 'boss-live-9', 'orch-live-7']) assert.ok(!stored.includes(id), `state holds ${id}`);
});

test('learnHandoffs hashes the source and successor ids of Boss records only', () => {
  const state = { sessions: {}, cwds: {} };
  learnHandoffs(state, [
    { boss: true, sessionId: 's-a', migratedId: 's-b' },
    { project: 'boss', sessionId: 's-c' },
    { displayLabel: 'Boss', migratedId: 's-d' },
    { project: 'shop', sessionId: 's-e', migratedId: 's-f' },
    { boss: true },
    null,
  ]);
  assert.equal(Object.keys(state.sessions).length, 4);
  assert.ok(Object.values(state.sessions).every((role) => role === 'boss'));
  assert.ok(!JSON.stringify(state).includes('s-a'));
});

test('a Boss record from handoff.js matches by its boss flag or its label', () => {
  // handoff.js plans a Boss record with boss: true, project "Boss", displayLabel "Boss", and label "boss".
  // Its handoffRole test is: item.boss truthy, or label equal to "boss".
  const real = { boss: true, project: 'Boss', displayLabel: 'Boss', label: 'boss', sessionId: 'r-1', migratedId: 'r-2' };
  const flagOnly = { boss: 1, project: 'x', label: 'renamed', sessionId: 'r-3' };
  const labelOnly = { label: 'boss', project: 'x', migratedId: 'r-4' };
  const previous = { label: 'Boss previous', sessionId: 'r-5' };
  const orchestrator = { boss: false, project: 'herdrboss', displayLabel: 'HerdrBoss', label: 'orch', sessionId: 'r-6', migratedId: 'r-7' };
  const state = { sessions: {}, cwds: {} };
  learnHandoffs(state, [real, flagOnly, labelOnly, previous, orchestrator]);
  assert.equal(Object.keys(state.sessions).length, 5);
  assert.ok(Object.values(state.sessions).every((role) => role === 'boss'));
});
