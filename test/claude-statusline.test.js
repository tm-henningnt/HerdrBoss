import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { recordClaudeStatusline, claudeStatuslineCommand, claudeRateLimitsDir, MAX_STATUSLINE_INPUT_BYTES } from '../src/claude-statusline.js';
import { readClaudeQuota, LINUX_READERS } from '../src/quota-readers.js';
import { collectQuotas } from '../src/collect.js';
import { fleetQuotas } from '../src/fleet-quotas.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusline-'));
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3600_000;
const input = (extra = {}) => JSON.stringify({
  session_id: 'abc-123',
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: (NOW + 2 * HOUR) / 1000 }, seven_day: { used_percentage: 41, resets_at: (NOW + 48 * HOUR) / 1000 } },
  ...extra,
});
const files = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.json'));

// Slice 4: the helper.

test('the helper writes only rate_limits and the time, with mode 0600', () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input({ transcript_path: '/x/SECRET.jsonl', workspace: { current_dir: 'SECRET' }, cost: { total: 1 } }), dir, now: NOW });
  assert.deepEqual(files(dir), ['abc-123.json']);
  const file = path.join(dir, 'abc-123.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('SECRET'), false);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['observedAt', 'rate_limits']);
  assert.equal(JSON.parse(text).observedAt, new Date(NOW).toISOString());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('the helper copies no extra field inside rate_limits', () => {
  const dir = tmp();
  const body = JSON.parse(input());
  body.rate_limits.five_hour.token = 'SECRET';
  body.rate_limits.account = 'SECRET';
  recordClaudeStatusline({ input: JSON.stringify(body), dir, now: NOW });
  const text = fs.readFileSync(path.join(dir, 'abc-123.json'), 'utf8');
  assert.equal(text.includes('SECRET'), false);
  assert.deepEqual(Object.keys(JSON.parse(text).rate_limits.five_hour).sort(), ['resets_at', 'used_percentage']);
});

test('the helper writes nothing when the input has no rate_limits, is not JSON, or is too large', () => {
  const dir = tmp();
  recordClaudeStatusline({ input: JSON.stringify({ session_id: 's1' }), dir, now: NOW });
  recordClaudeStatusline({ input: 'not json', dir, now: NOW });
  recordClaudeStatusline({ input: ' '.repeat(MAX_STATUSLINE_INPUT_BYTES + 1) + input(), dir, now: NOW });
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('the helper makes a safe file name from the session id', () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input({ session_id: '../../etc/evil' }), dir, now: NOW });
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[A-Za-z0-9_-]+\.json$/);
});

test('the helper replaces a file atomically and leaves no temporary file', () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  recordClaudeStatusline({ input: input(), dir, now: NOW + 1000 });
  assert.deepEqual(fs.readdirSync(dir), ['abc-123.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'abc-123.json'), 'utf8')).observedAt, new Date(NOW + 1000).toISOString());
});

test('the helper removes a reading file older than seven days', () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input({ session_id: 'old' }), dir, now: NOW - 8 * 24 * HOUR });
  const old = path.join(dir, 'old.json');
  fs.utimesSync(old, new Date(NOW - 8 * 24 * HOUR), new Date(NOW - 8 * 24 * HOUR));
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  assert.deepEqual(fs.readdirSync(dir), ['abc-123.json']);
});

test('the command prints an empty status line, exits clean, and never throws on bad input', async () => {
  const dir = tmp();
  let out = '';
  const code = await claudeStatuslineCommand({ stdin: Readable.from([input()]), dir, now: () => NOW, write: (text) => { out += text; } });
  assert.equal(code, 0);
  assert.equal(out, '\n');
  assert.deepEqual(files(dir), ['abc-123.json']);
  const bad = await claudeStatuslineCommand({ stdin: Readable.from(['{broken']), dir: path.join(dir, 'no', 'where'), now: () => NOW, write: () => {} });
  assert.equal(bad, 0);
});

test('the command stops reading at the size limit', async () => {
  const dir = tmp();
  const chunks = (function* () { for (let i = 0; i < 64; i += 1) yield 'x'.repeat(MAX_STATUSLINE_INPUT_BYTES / 8); })();
  const code = await claudeStatuslineCommand({ stdin: Readable.from(chunks), dir, now: () => NOW, write: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('the readings folder sits in the data folder', () => {
  assert.equal(claudeRateLimitsDir('/data'), path.join('/data', 'claude-rate-limits'));
});

// Slice 4: the reader.

test('a reading file gives primary and secondary windows that the Fleet accepts', async () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  const row = await readClaudeQuota({ dir, now: () => NOW + 60_000 });
  assert.equal(row.provider, 'claude');
  assert.equal(row.unavailable, undefined);
  assert.deepEqual(row.windows.map((w) => [w.key, w.usedPercent, w.windowMinutes]), [['primary', 23.5, 300], ['secondary', 41, 10080]]);
  assert.equal(row.windows[0].resetsAt, new Date(NOW + 2 * HOUR).toISOString());
  assert.equal(row.updatedAt, new Date(NOW).toISOString());
  const rows = fleetQuotas([row], [{ harness: 'claude', accountKey: 'a'.repeat(64), scope: ['win1'] }], 'win1');
  assert.deepEqual(rows.map((r) => [r.lane, r.usedPercent, r.status]), [['primary', 23.5, 'ok'], ['secondary', 41, 'ok']]);
  assert.equal(rows[0].resetAt, '2026-10-06T14:00:00Z');
});

test('a plan with one window gives one window', async () => {
  const dir = tmp();
  const body = JSON.parse(input());
  delete body.rate_limits.seven_day;
  recordClaudeStatusline({ input: JSON.stringify(body), dir, now: NOW });
  const row = await readClaudeQuota({ dir, now: NOW });
  assert.deepEqual(row.windows.map((w) => w.key), ['primary']);
});

test('the newest file wins', async () => {
  const dir = tmp();
  const older = JSON.parse(input({ session_id: 'a' }));
  older.rate_limits.five_hour.used_percentage = 10;
  recordClaudeStatusline({ input: JSON.stringify(older), dir, now: NOW - 5 * 60_000 });
  const newer = JSON.parse(input({ session_id: 'b' }));
  newer.rate_limits.five_hour.used_percentage = 30;
  recordClaudeStatusline({ input: JSON.stringify(newer), dir, now: NOW });
  const row = await readClaudeQuota({ dir, now: NOW + 1000 });
  assert.equal(row.windows[0].usedPercent, 30);
});

test('no file gives unknown with the reason that no session reported yet', async () => {
  for (const dir of [tmp(), path.join(tmp(), 'missing')]) {
    const row = await readClaudeQuota({ dir, now: NOW });
    assert.equal(row.unavailable, true);
    assert.equal(row.reason, 'no Claude session has reported usage yet');
  }
});

test('a file that is not valid is ignored', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), '{bad');
  fs.writeFileSync(path.join(dir, 'y.json'), JSON.stringify({ observedAt: 'yesterday', rate_limits: { five_hour: { used_percentage: 'a', resets_at: 'b' } } }));
  const row = await readClaudeQuota({ dir, now: NOW });
  assert.equal(row.unavailable, true);
  assert.equal(row.reason, 'no Claude session has reported usage yet');
});

test('a window past its reset is dropped, and the reason names the age', async () => {
  const dir = tmp();
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  const mixed = await readClaudeQuota({ dir, now: NOW + 3 * HOUR });
  assert.deepEqual(mixed.windows.map((w) => w.key), ['secondary']);
  const fresh = await readClaudeQuota({ dir, now: NOW + 2 * HOUR + 1000 });
  assert.deepEqual(fresh.windows.map((w) => w.key), ['secondary']);
  const dir2 = tmp();
  const only = JSON.parse(input());
  delete only.rate_limits.seven_day;
  recordClaudeStatusline({ input: JSON.stringify(only), dir: dir2, now: NOW });
  const soon = await readClaudeQuota({ dir: dir2, now: NOW + 2 * HOUR + 1000 });
  assert.equal(soon.unavailable, true);
  assert.equal(soon.reason, 'the last Claude usage report is past its reset');
  const late = await readClaudeQuota({ dir: dir2, now: NOW + 4 * HOUR });
  assert.equal(late.unavailable, true);
  assert.equal(late.reason, 'the last Claude usage report is older than 3 hours and past its reset');
});

test('the reader is registered for claude and collectQuotas uses it in a factory', async () => {
  assert.equal(LINUX_READERS.claude, readClaudeQuota);
  const dir = tmp();
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  const missing = Object.assign(new Error('spawn codexbar ENOENT'), { code: 'ENOENT' });
  const history = path.join(tmp(), 'history.jsonl');
  const quotas = await collectQuotas({
    runner: async () => { throw missing; }, factory: true, historyFile: history, now: () => NOW + 1000, providers: ['claude'],
    readers: { claude: (options) => readClaudeQuota({ ...options, dir }) },
  });
  assert.equal(quotas[0].windows[0].usedPercent, 23.5);
});

test('the reader never reads a login file', async () => {
  const source = fs.readFileSync(new URL('../src/claude-statusline.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/quota-readers.js', import.meta.url), 'utf8');
  assert.equal(/\.claude\/|\.credentials|\.claude\.json|\.codex\/auth/.test(source.replace(/\/\/.*$/gm, '')), false);
});

test('herdr-boss claude-statusline writes the file in HERDR_BOSS_DIR and prints an empty line', () => {
  const data = tmp();
  const result = spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'claude-statusline'], {
    input: input({ cwd: 'SECRET' }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), HERDR_BOSS_DIR: data },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '\n');
  const file = path.join(data, 'claude-rate-limits', 'abc-123.json');
  assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false);
  assert.deepEqual(fs.readdirSync(data), ['claude-rate-limits']);
});

test('a report older than 3 hours with an open window gives a failed row, so the last good reading stays as stale', async () => {
  const { keepStaleRows } = await import('../src/collect.js');
  const dir = tmp();
  recordClaudeStatusline({ input: input(), dir, now: NOW });
  const row = await readClaudeQuota({ dir, now: () => NOW + 4 * HOUR });
  assert.equal(row.unavailable, undefined);
  assert.equal(row.windows, undefined);
  assert.equal(row.error, 'the last Claude usage report is older than 3 hours');
  const good = { provider: 'claude', plan: null, windows: [{ key: 'secondary', usedPercent: 41, resetsAt: new Date(NOW + 7 * 24 * HOUR).toISOString(), windowMinutes: 10080 }], observedAt: new Date(NOW + HOUR).toISOString() };
  const [kept] = keepStaleRows([row], [good], good.observedAt ? Date.parse(good.observedAt) : NOW, NOW + 2 * HOUR);
  assert.equal(kept.stale, true);
  assert.equal(kept.windows[0].usedPercent, 41);
});
