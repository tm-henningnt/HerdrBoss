import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// All logs below are invented fixtures in a temporary HOME. The real harness logs are never read.
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-spend-'));
process.env.HERDR_BOSS_DIR = path.join(ROOT, 'boss');
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const {
  parseClaudeLine, parseCodexLine, parsePiLine, pullLines, classify, learnPanes, scanSpend, spendSummary,
  formatSpend, clampSpendDays, priceFor, costOf, loadPrices,
} = await import('../src/spend.js');
const { fillMeasuredUsage, validateUsage } = await import('../src/usage.js');
const { Engine } = await import('../src/engine.js');

const SECRET = 'sk-fixture-SECRET-9f8e7d';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86400 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let homeCount = 0;
function newHome() {
  const home = path.join(ROOT, `home-${homeCount += 1}`);
  fs.mkdirSync(path.join(home, 'Projects', '.herdr-wt', 'Shop'), { recursive: true });
  return home;
}
const dirs = (home) => ({ dataDir: path.join(home, 'boss'), worktreeRoot: path.join(home, 'Projects', '.herdr-wt') });
function writeLines(file, lines, flag = 'w') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', { flag });
}

function claudeRow({ id = 'm1', req = 'r1', cwd, at = NOW, model = 'claude-sonnet-5-5', input = 10, output = 20, cacheRead = 100, cacheWrite = 5, sessionId = 's1', text = SECRET }) {
  return {
    type: 'assistant', timestamp: iso(at), cwd, sessionId, requestId: req,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
  };
}
const codexMeta = (cwd) => ({ type: 'session_meta', timestamp: iso(NOW), payload: { id: 'cx1', cwd } });
const codexTurn = (model) => ({ type: 'turn_context', timestamp: iso(NOW), payload: { model } });
const codexCount = (input, cached, output, at = NOW) => ({ type: 'event_msg', timestamp: iso(at), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } });
const piRow = (at, model = 'deepseek-v4.1-flash', total = 0.002) => ({ type: 'message', timestamp: iso(at), message: { role: 'assistant', provider: 'opencode-go', model, content: [{ type: 'text', text: SECRET }], usage: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, cost: { total } } } });

test('the Claude parser reads counts, skips other rows, and reports a broken line', () => {
  const ctx = {};
  const good = parseClaudeLine(JSON.stringify(claudeRow({ cwd: '/w/a' })), ctx);
  assert.deepEqual(good.usage, { input: 10, output: 20, cacheRead: 100, cacheWrite: 5 });
  assert.equal(good.model, 'claude-sonnet-5-5');
  assert.equal(ctx.cwd, '/w/a');
  assert.equal(parseClaudeLine('{"type":"user","message":{"content":"hello"}}').skip, true);
  assert.equal(parseClaudeLine('{broken').bad, true);
  const unknown = parseClaudeLine(JSON.stringify(claudeRow({ model: 'made up model!' })), {});
  assert.equal(unknown.model, 'unknown');
  const dated = parseClaudeLine(JSON.stringify(claudeRow({ model: 'claude-opus-5-5-20260901[1m]' })), {});
  assert.equal(dated.model, 'claude-opus-5-5');
  assert.equal(parseClaudeLine(JSON.stringify(claudeRow({ input: -5, output: 'x', cacheRead: 0, cacheWrite: 0 })), {}).skip, true);
  assert.ok(!JSON.stringify(good).includes(SECRET));
});

test('the Claude parser counts a repeated message once and adds only the growth', () => {
  const ctx = {};
  const first = parseClaudeLine(JSON.stringify(claudeRow({ output: 5 })), ctx);
  const repeat = parseClaudeLine(JSON.stringify(claudeRow({ output: 40 })), ctx);
  assert.equal(first.usage.output, 5);
  assert.deepEqual(repeat.usage, { input: 0, output: 35, cacheRead: 0, cacheWrite: 0 });
  assert.equal(repeat.messages, 0);
  const next = parseClaudeLine(JSON.stringify(claudeRow({ id: 'm2', req: 'r2', output: 7 })), ctx);
  assert.equal(next.usage.output, 7);
});

test('the Codex parser turns running totals into increases and splits cached input', () => {
  const ctx = {};
  parseCodexLine(JSON.stringify(codexMeta('/w/b')), ctx);
  parseCodexLine(JSON.stringify(codexTurn('gpt-6-luna')), ctx);
  const a = parseCodexLine(JSON.stringify(codexCount(1000, 400, 50)), ctx);
  assert.deepEqual(a.usage, { input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  assert.equal(a.model, 'gpt-6-luna');
  assert.equal(ctx.cwd, '/w/b');
  const b = parseCodexLine(JSON.stringify(codexCount(1500, 900, 80)), ctx);
  assert.deepEqual(b.usage, { input: 0, output: 30, cacheRead: 500, cacheWrite: 0 });
  assert.equal(parseCodexLine(JSON.stringify(codexCount(1500, 900, 80)), ctx).skip, true);
  const reset = parseCodexLine(JSON.stringify(codexCount(100, 0, 10)), ctx);
  assert.deepEqual(reset.usage, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  assert.equal(parseCodexLine('not json', ctx).bad, true);
  assert.equal(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }), ctx).skip, true);
});

test('the Pi parser reads counts, the logged cost, and the provider model', () => {
  const ctx = {};
  parsePiLine(JSON.stringify({ type: 'session', id: 'p1', cwd: '/w/c' }), ctx);
  const row = parsePiLine(JSON.stringify(piRow(NOW)), ctx);
  assert.deepEqual(row.usage, { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 });
  assert.equal(row.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(row.logCost, 0.002);
  assert.equal(ctx.cwd, '/w/c');
  assert.equal(parsePiLine('{oops', ctx).bad, true);
  assert.equal(parsePiLine(JSON.stringify({ type: 'message', message: { role: 'user', content: SECRET } }), ctx).skip, true);
});

test('the reader skips a huge line, waits for a partial line, and continues from the offset', () => {
  const dir = path.join(ROOT, 'reader');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'log.jsonl');
  const huge = 'x'.repeat(5000);
  fs.writeFileSync(file, `one\n${huge}\ntwo\nthr`);
  const fd = fs.openSync(file, 'r');
  const state = { offset: 0, skipping: false };
  const options = { chunkBytes: 64, maxLineBytes: 256 };
  let size = fs.statSync(file).size;
  const first = pullLines(fd, state, size, 1e6, options);
  assert.deepEqual(first.lines, ['one', 'two']);
  assert.equal(first.skipped, 1);
  assert.equal(state.offset, size - 3);
  fs.appendFileSync(file, 'ee\n');
  size = fs.statSync(file).size;
  const second = pullLines(fd, state, size, 1e6, options);
  assert.deepEqual(second.lines, ['three']);
  assert.equal(state.offset, size);
  fs.closeSync(fd);
});

test('the reader keeps skipping a huge line across scans', () => {
  const dir = path.join(ROOT, 'reader2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, `a\n${'y'.repeat(2000)}`);
  const fd = fs.openSync(file, 'r');
  const state = { offset: 0, skipping: false };
  const options = { chunkBytes: 64, maxLineBytes: 256 };
  const first = pullLines(fd, state, fs.statSync(file).size, 1e6, options);
  assert.deepEqual(first.lines, ['a']);
  assert.equal(state.skipping, true);
  fs.appendFileSync(file, `${'z'.repeat(500)}\nb\n`);
  const second = pullLines(fd, state, fs.statSync(file).size, 1e6, options);
  assert.deepEqual(second.lines, ['b']);
  assert.equal(state.skipping, false);
  fs.closeSync(fd);
});

test('the role comes from the pane, then the worktree, the folder, and the repository', () => {
  const home = newHome();
  const { worktreeRoot } = dirs(home);
  const state = { sessions: {}, cwds: {} };
  learnPanes(state, [
    { label: 'boss', orch: true, agent: 'claude', sessionId: 'boss-session', cwd: '/x/bossdir' },
    { label: 'orch', orch: true, agent: 'claude', sessionId: 'orch-session', cwd: '/x/shop' },
    { label: 'w1', orch: false, agent: 'claude', sessionId: 'worker-session', cwd: path.join(worktreeRoot, 'Shop', 'fix1') },
  ]);
  const env = { ...state, repos: [{ slug: 'shop', repo: '/x/shop' }], worktreeRoot };
  assert.equal(classify({ sessionId: 'boss-session', cwd: '/x/shop' }, env).role, 'boss');
  assert.equal(classify({ sessionId: 'old', cwd: '/x/bossdir' }, env).role, 'boss');
  assert.equal(classify({ sessionId: 'old', cwd: '/x/shop' }, env).role, 'orchestrator');
  assert.deepEqual(classify({ sessionId: 'old', cwd: path.join(worktreeRoot, 'Shop', 'fix2') }, env), { role: 'worker', project: 'shop', worker: 'fix2' });
  assert.deepEqual(classify({ sessionId: 'old', cwd: '/x/Shop-wt-fix3' }, { ...env, repos: [{ slug: 'shop', repo: '/x/Shop' }] }), { role: 'worker', project: 'shop', worker: 'fix3' });
  assert.equal(classify({ sessionId: 'old', cwd: '/elsewhere' }, env).role, 'other');
  assert.equal(classify({ sessionId: null, cwd: null }, env).role, 'other');
});

test('a folder that Boss and orchestrator panes share gives no folder role', () => {
  const state = { sessions: {}, cwds: {} };
  learnPanes(state, [{ label: 'boss', orch: true, agent: 'claude', cwd: '/x/both' }, { label: 'orch', orch: true, agent: 'claude', cwd: '/x/both' }]);
  assert.equal(classify({ sessionId: 'old', cwd: '/x/both' }, { ...state, repos: [{ slug: 'p', repo: '/x/both' }], worktreeRoot: '/wt' }).role, 'orchestrator');
});

test('a scan sums per day and role, reads incrementally, and prices only the known models', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const repos = [{ slug: 'shop', repo: path.join(home, 'Projects', 'Shop') }];
  const workerCwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const claude = path.join(home, '.claude', 'projects', '-x', 'w1.jsonl');
  writeLines(claude, [
    claudeRow({ cwd: workerCwd, id: 'a', req: 'a', input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, at: NOW - DAY }),
    { type: 'user', message: { content: SECRET } },
    'broken {line',
    claudeRow({ cwd: workerCwd, id: 'b', req: 'b', input: 10, output: 5, cacheRead: 100, cacheWrite: 0, at: NOW }),
  ]);
  const orch = path.join(home, '.claude', 'projects', '-y', 'o1.jsonl');
  writeLines(orch, [claudeRow({ cwd: repos[0].repo, sessionId: 'o1', id: 'c', req: 'c', input: 1, output: 1, cacheRead: 10, cacheWrite: 0 })]);
  const boss = path.join(home, '.claude', 'projects', '-z', 'b1.jsonl');
  writeLines(boss, [claudeRow({ cwd: '/x/bossdir', sessionId: 'b1', id: 'd', req: 'd', input: 2, output: 2, cacheRead: 20, cacheWrite: 0 })]);
  const codex = path.join(home, '.codex', 'sessions', '2026', '09', '29', 'rollout-1.jsonl');
  writeLines(codex, [codexMeta(workerCwd), codexTurn('gpt-6-luna'), codexCount(2_000_000, 1_000_000, 100_000)]);
  const pi = path.join(home, '.pi', 'agent', 'sessions', '--x--', 'a.jsonl');
  writeLines(pi, [{ type: 'session', id: 'p1', cwd: workerCwd }, piRow(NOW, 'deepseek-v4.1-flash', 0.5)]);
  const panes = [{ label: 'boss', orch: true, agent: 'claude', sessionId: 'b1', cwd: '/x/bossdir' }];
  const options = { dataDir, home, now: NOW, repos, worktreeRoot, panes, fillUsage: false };

  const first = await scanSpend(options);
  assert.ok(first.bytes > 0);
  assert.equal(first.pendingBytes, 0);
  const summary = spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() });
  const today = summary.days.find((d) => d.day === dayOf(NOW));
  const yesterday = summary.days.find((d) => d.day === dayOf(NOW - DAY));
  assert.equal(yesterday.total.tokens, 1150);
  const byRole = Object.fromEntries(today.roles.map((r) => [r.role, r]));
  assert.equal(byRole.boss.tokens, 24);
  assert.equal(byRole.orchestrator.tokens, 12);
  // Worker: Claude 115 + Codex 2.1M + Pi 4200.
  assert.equal(byRole.worker.tokens, 115 + 2_100_000 + 4200);
  assert.equal(byRole.worker.harnesses.codex.tokens, 2_100_000);
  // Codex luna: 1M fresh input at 0.10, 100K output at 0.50, 1M cached at 0.01 = 0.16 USD. Pi logs 0.5 USD.
  assert.ok(Math.abs(byRole.worker.harnesses.codex.costUsd - 0.16) < 1e-9);
  assert.equal(byRole.worker.harnesses.pi.costUsd, 0.5);
  // Claude Sonnet 5.5 at 2 input, 10 output, 0.20 cache read: worker 10, 5, 100; Boss 2, 2, 20; orchestrator 1, 1, 10.
  assert.ok(Math.abs(byRole.worker.harnesses.claude.costUsd - (10 * 2 + 5 * 10 + 100 * 0.2) / 1e6) < 1e-12);
  assert.equal(byRole.worker.harnesses.claude.unpricedTokens, 0);
  assert.ok(Math.abs(byRole.boss.costUsd - (2 * 2 + 2 * 10 + 20 * 0.2) / 1e6) < 1e-12);
  assert.equal(byRole.boss.unpricedTokens, 0);
  assert.equal(today.total.unpricedTokens, 0);
  assert.equal(summary.harnesses.claude.status, 'ok');
  assert.equal(summary.harnesses.opencode.status, 'none');

  // A second scan without new bytes adds nothing.
  const second = await scanSpend(options);
  assert.equal(second.bytes, 0);
  assert.equal(spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() }).days.find((d) => d.day === dayOf(NOW)).total.tokens, today.total.tokens);

  // New lines add only themselves. A partial last line waits.
  fs.appendFileSync(claude, `${JSON.stringify(claudeRow({ cwd: workerCwd, id: 'e', req: 'e', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }))}\n{"type":"assis`);
  const third = await scanSpend(options);
  assert.ok(third.bytes > 0 && third.pendingBytes > 0);
  const after = spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() }).days.find((d) => d.day === dayOf(NOW));
  assert.equal(after.total.tokens, today.total.tokens + 2);

  // Privacy: no stored or printed data holds message text, paths, or session IDs.
  const stored = fs.readdirSync(dataDir).map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('\n');
  assert.ok(!stored.includes(SECRET));
  const printed = formatSpend(spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() }));
  const json = JSON.stringify(spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() }));
  for (const text of [printed, json]) {
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(home));
    assert.ok(!/fix1|Shop|shop|o1|b1|w1/.test(text.replace(/boss|orchestrator|worker/g, '')));
  }
  assert.match(printed, /worker\s+2\.10M tokens/);
  assert.match(printed, new RegExp(`${dayOf(NOW)}  total`));
});

test('a byte budget caps one scan and the next scan continues', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const file = path.join(home, '.claude', 'projects', '-x', 'w1.jsonl');
  writeLines(file, Array.from({ length: 20 }, (_, i) => claudeRow({ cwd, id: `m${i}`, req: `r${i}`, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })));
  const options = { dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false, budgetBytes: 1500, chunkBytes: 512 };
  const one = await scanSpend(options);
  assert.ok(one.pendingBytes > 0);
  let tokens = spendSummary({ dataDir, now: NOW, prices: {} }).days[0].total.tokens;
  assert.ok(tokens > 0 && tokens < 40);
  for (let i = 0; i < 20 && (await scanSpend(options)).pendingBytes > 0; i += 1);
  tokens = spendSummary({ dataDir, now: NOW, prices: {} }).days[0].total.tokens;
  assert.equal(tokens, 40);
});

test('a huge line in a log is skipped and the lines after it are counted', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const file = path.join(home, '.claude', 'projects', '-x', 'w1.jsonl');
  const huge = JSON.stringify(claudeRow({ cwd, id: 'h', req: 'h', text: 'q'.repeat(4000) }));
  writeLines(file, [claudeRow({ cwd, id: 'a', req: 'a', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), huge, claudeRow({ cwd, id: 'b', req: 'b', input: 2, output: 2, cacheRead: 0, cacheWrite: 0 })]);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false, chunkBytes: 256, maxLineBytes: 1024 });
  assert.equal(spendSummary({ dataDir, now: NOW, prices: {} }).days[0].total.tokens, 6);
});

test('a log that only holds broken lines is unavailable, not guessed', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  writeLines(path.join(home, '.pi', 'agent', 'sessions', '--x--', 'a.jsonl'), ['{"message": {"usage": nope', 'still nope']);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false });
  const summary = spendSummary({ dataDir, now: NOW, prices: {} });
  assert.equal(summary.harnesses.pi.status, 'unavailable');
  assert.deepEqual(summary.days, []);
  assert.match(formatSpend(summary), /Unavailable logs: pi\./);
});

test('OpenCode tokens come from the message rows without the message text', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const dbFile = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL); CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);');
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses1', path.join(worktreeRoot, 'Shop', 'oc1'));
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const data = (role, tokens, cost) => JSON.stringify({ role, modelID: 'big-pickle', providerID: 'opencode', cost, tokens, note: SECRET });
  insert.run('m1', 'ses1', NOW - 1000, NOW - 1000, data('assistant', { input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 5 } }, 0));
  insert.run('m2', 'ses1', NOW - 900, NOW - 900, data('user', { input: 999, output: 999, cache: { read: 0, write: 0 } }, 0));
  db.close();
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false });
  const summary = spendSummary({ dataDir, now: NOW, prices: {} });
  assert.equal(summary.harnesses.opencode.status, 'ok');
  const worker = summary.days[0].roles.find((r) => r.role === 'worker');
  assert.equal(worker.harnesses.opencode.tokens, 100 + 60 + 1000 + 5);
  assert.equal(worker.harnesses.opencode.costUsd, 0);
  assert.equal(worker.harnesses.opencode.unpricedTokens, 0);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'spend-state.json'), 'utf8').includes(SECRET));
  // A repeated scan replaces the session totals and does not add them again.
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false });
  assert.equal(spendSummary({ dataDir, now: NOW, prices: {} }).days[0].total.tokens, 1165);
  // A missing table is unavailable.
  const broken = newHome();
  const brokenDb = path.join(broken, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(brokenDb), { recursive: true });
  new DatabaseSync(brokenDb).close();
  await scanSpend({ ...dirs(broken), home: broken, now: NOW, repos: [], fillUsage: false });
  assert.equal(spendSummary({ dataDir: dirs(broken).dataDir, now: NOW, prices: {} }).harnesses.opencode.status, 'unavailable');
});

test('a scan fills null token fields of a worker run and marks a run with no log unavailable', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const startedAt = NOW - 30 * 60 * 1000;
  const endedAt = NOW - 5 * 60 * 1000;
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  writeLines(path.join(home, '.codex', 'sessions', '2026', '09', '29', 'r.jsonl'), [
    codexMeta(cwd), codexTurn('gpt-6-luna'), { ...codexCount(1_000_000, 500_000, 200_000, startedAt + 60_000) },
  ]);
  const row = (id, extra) => ({ id, project: 'shop', workspace: 'w1', kind: 'codex', model: 'gpt-6-luna', startedAt: iso(startedAt), endedAt: iso(endedAt), outcome: 'done', inputTokens: null, outputTokens: null, cachedTokens: null, cost: null, ...extra });
  const usageFile = path.join(dataDir, 'usage.jsonl');
  const old = NOW - 3 * DAY;
  writeLines(usageFile, [
    row(`worker:shop:fix1:${iso(startedAt)}`),
    row(`worker:shop:other:${iso(startedAt)}`),
    row(`worker:shop:ghost:${iso(old)}`, { startedAt: iso(old), endedAt: iso(old + 600000) }),
    row(`worker:shop:fix1:${iso(NOW - 2 * DAY)}`, { startedAt: iso(NOW - 2 * DAY), endedAt: iso(NOW - 2 * DAY + 600000), inputTokens: 7, outputTokens: 8, cachedTokens: 9, cost: 1 }),
  ]);
  await scanSpend({ dataDir, home, now: NOW, repos: [{ slug: 'shop', repo: path.join(home, 'Projects', 'Shop') }], worktreeRoot, usageFile });
  const rows = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].inputTokens, 500_000);
  assert.equal(rows[0].outputTokens, 200_000);
  assert.equal(rows[0].cachedTokens, 500_000);
  assert.equal(rows[0].tokenSource, 'measured');
  assert.ok(Math.abs(rows[0].cost - (500_000 * 0.10 + 200_000 * 0.50 + 500_000 * 0.01) / 1e6) < 1e-9);
  // No log for the run: it stays null inside the grace time and turns unavailable after it.
  assert.equal(rows[1].inputTokens, null);
  assert.equal(rows[1].tokenSource, undefined);
  assert.equal(rows[2].tokenSource, 'unavailable');
  assert.equal(rows[2].inputTokens, null);
  // A measured record is never changed.
  assert.equal(rows[3].inputTokens, 7);
  assert.equal(validateUsage(rows[0]).length, 0);
  assert.equal(validateUsage(rows[2]).length, 0);
  assert.ok(validateUsage({ ...rows[0], tokenSource: 'guess' }).length > 0);
});

test('a run whose log is still unread stays null', () => {
  const dir = path.join(ROOT, 'fill');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'usage.jsonl');
  const start = NOW - 600000;
  writeLines(file, [{ id: `worker:shop:a:${iso(start)}`, project: 'shop', kind: 'claude', model: 'm', startedAt: iso(start), endedAt: iso(NOW - 1000), outcome: 'done', inputTokens: null, outputTokens: null, cachedTokens: null, cost: null }]);
  const run = { harness: 'claude', project: 'shop', worker: 'a', first: start + 1000, last: start + 2000, complete: false, models: { m: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } };
  assert.deepEqual(fillMeasuredUsage({ file, runs: [run], now: NOW }), { filled: 0, unavailable: 0 });
  const done = fillMeasuredUsage({ file, runs: [{ ...run, complete: true }], now: NOW });
  assert.equal(done.filled, 1);
  const filled = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(filled.inputTokens, 2);
  assert.equal(filled.cost, null);
});

test('the cost of a model without a price is unpriced and a logged cost is kept', () => {
  const priceOf = priceFor({ 'codex/m': { input: 1, output: 2 } });
  const entry = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 };
  assert.deepEqual(costOf(entry, 'claude', 'x', priceOf), { costUsd: 0, unpricedTokens: 3e6 });
  // The cache read price falls back to the input price.
  assert.deepEqual(costOf(entry, 'codex', 'm', priceOf), { costUsd: 4, unpricedTokens: 0 });
  assert.deepEqual(costOf({ ...entry, logCost: 0.25, costTokens: 3e6 }, 'pi', 'x', priceOf), { costUsd: 0.25, unpricedTokens: 0 });
  assert.equal(clampSpendDays('abc'), 7);
  assert.equal(clampSpendDays('0'), 7);
  assert.equal(clampSpendDays('30'), 30);
  assert.equal(clampSpendDays('9999'), 90);
});

test('the price table lists the documented Codex prices and the Claude API prices', () => {
  const prices = loadPrices();
  assert.deepEqual(prices['codex/gpt-6-luna'], { input: 0.10, output: 0.50, cacheRead: 0.01 });
  assert.deepEqual([prices['claude/claude-sonnet-5-5'].input, prices['claude/claude-sonnet-5-5'].output], [2, 10]);
  assert.equal(prices['claude/claude-unlisted-1'], undefined);
});

test('the CLI prints one line per day and role and one total line per day', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const today = new Date().toISOString();
  writeLines(path.join(home, '.claude', 'projects', '-x', 'w1.jsonl'), [{ ...claudeRow({ cwd, id: 'a', req: 'a', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, model: 'claude-unlisted-1' }), timestamp: today }]);
  await scanSpend({ dataDir, home, now: Date.now(), repos: [], worktreeRoot, fillUsage: false });
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: dataDir };
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const out = spawnSync(process.execPath, [cli, 'spend', '--days', '2'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /worker\s+1\.5K tokens\s+unpriced \(1\.5K tokens\)/);
  assert.match(lines[1], /total\s+1\.5K tokens/);
  const json = spawnSync(process.execPath, [cli, 'spend', '--json'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(json.stdout).days[0].total.tokens, 1500);
  const bad = spawnSync(process.execPath, [cli, 'spend', '--days', 'x'], { env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('the engine runs the spend scan at most every 5 minutes and passes the panes', async () => {
  const calls = [];
  const engine = new Engine({ push: false, browsers: {} }, { push: false, act: false, collectors: { runSpendScan: async (args) => { calls.push(args); } } });
  const panes = [{ id: 'w1:p1', label: 'boss' }];
  const t0 = NOW;
  await engine.scanSpend(t0, { panes });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].panes, panes);
  assert.equal(engine.scanSpend(t0 + 4 * 60 * 1000, { panes }), null);
  await engine.scanSpend(t0 + 5 * 60 * 1000, { panes });
  assert.equal(calls.length, 2);
});

test('the Claude parser dedupes a message that repeats after other messages', () => {
  const ctx = {};
  const at = (id, output) => parseClaudeLine(JSON.stringify(claudeRow({ id, req: id, output, input: 0, cacheRead: 0, cacheWrite: 0 })), ctx);
  assert.equal(at('a', 5).usage.output, 5);
  assert.equal(at('b', 7).usage.output, 7);
  const again = at('a', 9);
  assert.equal(again.usage.output, 4);
  assert.equal(again.messages, 0);
  assert.equal(at('a', 9).skip, true);
  // The set is bounded.
  for (let i = 0; i < 300; i += 1) at(`m${i}`, 1);
  assert.ok(ctx.seen.size <= 128);
});

test('the state and daily files hold no folder, session ID, or path', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const workerCwd = path.join(worktreeRoot, 'Shop', 'fix1');
  writeLines(path.join(home, '.claude', 'projects', '-x', 'session-uuid-1234.jsonl'), [claudeRow({ cwd: workerCwd, sessionId: 'session-uuid-1234' })]);
  writeLines(path.join(home, '.codex', 'sessions', '2026', '09', '29', 'r.jsonl'), [{ type: 'session_meta', timestamp: iso(NOW), payload: { id: 'codex-session-5678', cwd: workerCwd } }, codexTurn('gpt-6-luna'), codexCount(100, 0, 10)]);
  writeLines(path.join(home, '.pi', 'agent', 'sessions', '--x--', 'a.jsonl'), [{ type: 'session', id: 'pi-session-9', cwd: workerCwd }, piRow(NOW)]);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false, panes: [{ label: 'boss', orch: true, agent: 'claude', sessionId: 'pane-session-1', cwd: '/x/bossdir' }] });
  for (const name of ['spend-state.json', 'spend-daily.json']) {
    const text = fs.readFileSync(path.join(dataDir, name), 'utf8').replaceAll('opencode-go/deepseek-v4.1-flash', 'model');
    assert.ok(!text.includes('/'), `${name} holds a path separator`);
    assert.ok(!text.includes(path.sep));
    for (const id of ['session-uuid-1234', 'codex-session-5678', 'pi-session-9', 'pane-session-1', 'bossdir', home]) assert.ok(!text.includes(id), `${name} holds ${id}`);
  }
  // The role still comes from the stored hashes on a later scan.
  fs.appendFileSync(path.join(home, '.pi', 'agent', 'sessions', '--x--', 'a.jsonl'), `${JSON.stringify(piRow(NOW + 1000))}\n`);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false });
  const worker = spendSummary({ dataDir, now: NOW, prices: {} }).days[0].roles.find((r) => r.role === 'worker');
  assert.equal(worker.harnesses.pi.tokens, 8400);
});

test('a file outside the cutoff keeps its state and a resumed file continues from its offset', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const claude = path.join(home, '.claude', 'projects', '-x', 'w1.jsonl');
  const codex = path.join(home, '.codex', 'sessions', '2026', '09', '29', 'r.jsonl');
  writeLines(claude, [claudeRow({ cwd, id: 'a', req: 'a', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })]);
  writeLines(codex, [codexMeta(cwd), codexTurn('gpt-6-luna'), codexCount(100, 0, 10)]);
  const options = { dataDir, home, repos: [], worktreeRoot, fillUsage: false };
  await scanSpend({ ...options, now: NOW });
  const entries = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'spend-state.json'), 'utf8')).files).length;
  assert.equal(entries(), 2);
  const later = NOW + 40 * DAY;
  const old = new Date(NOW);
  fs.utimesSync(claude, old, old);
  fs.utimesSync(codex, old, old);
  await scanSpend({ ...options, now: later });
  assert.equal(entries(), 2, 'the state of an old file stays');
  // The files resume. The Codex file is in a date folder older than the cutoff.
  fs.appendFileSync(claude, `${JSON.stringify(claudeRow({ cwd, id: 'b', req: 'b', at: later, input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }))}\n`);
  fs.appendFileSync(codex, `${JSON.stringify(codexCount(150, 0, 20, later))}\n`);
  const resumed = new Date(later);
  fs.utimesSync(claude, resumed, resumed);
  fs.utimesSync(codex, resumed, resumed);
  await scanSpend({ ...options, now: later });
  const summary = spendSummary({ dataDir, days: 60, now: later, prices: {} });
  const total = summary.days.reduce((sum, d) => sum + d.total.tokens, 0);
  // Claude 2 + 4, Codex 110 + 60. Nothing is counted twice.
  assert.equal(total, 2 + 4 + 110 + 60);
  // A never-seen old file is not read.
  const ancient = path.join(home, '.claude', 'projects', '-x', 'old.jsonl');
  writeLines(ancient, [claudeRow({ cwd, id: 'z', req: 'z', input: 99, output: 0, cacheRead: 0, cacheWrite: 0 })]);
  fs.utimesSync(ancient, old, old);
  await scanSpend({ ...options, now: later });
  assert.equal(spendSummary({ dataDir, days: 60, now: later, prices: {} }).days.reduce((sum, d) => sum + d.total.tokens, 0), total);
});

test('a day is the local calendar day', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const local = new Date(2026, 8, 15, 0, 30).getTime();
  writeLines(path.join(home, '.claude', 'projects', '-x', 'w1.jsonl'), [claudeRow({ cwd, at: local, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })]);
  await scanSpend({ dataDir, home, now: local, repos: [], worktreeRoot, fillUsage: false });
  assert.equal(spendSummary({ dataDir, now: local, prices: {} }).days[0].day, '2026-09-15');
});

test('a usage record takes the closest unused log and two records never share a log', () => {
  const dir = path.join(ROOT, 'fill2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'usage.jsonl');
  const start = NOW - 3600000;
  const row = (at, extra = {}) => ({ id: `worker:shop:a:${iso(at)}`, project: 'shop', kind: 'claude', model: 'm', startedAt: iso(at), endedAt: iso(at + 1800000), outcome: 'done', inputTokens: null, outputTokens: null, cachedTokens: null, cost: null, ...extra });
  writeLines(file, [row(start), row(start + 900000)]);
  const log = (first, n) => ({ harness: 'claude', project: 'shop', worker: 'a', first, last: first + 1000, complete: true, models: { m: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  // The second log starts nearer to the second record. The first record must not also take it.
  fillMeasuredUsage({ file, runs: [log(start + 910000, 2), log(start + 5000, 1)], now: NOW });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].inputTokens, 1);
  assert.equal(rows[1].inputTokens, 2);
  // One log and two records: the closer record takes it and the other stays null.
  writeLines(file, [row(start), row(start + 60000)]);
  fillMeasuredUsage({ file, runs: [log(start + 65000, 5)], now: NOW });
  const one = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(one.filter((r) => r.inputTokens === 5).length, 1);
  assert.equal(one[1].inputTokens, 5);
  assert.equal(one[0].inputTokens, null);
});
