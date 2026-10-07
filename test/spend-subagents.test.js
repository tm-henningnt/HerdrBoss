import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// All logs below are invented fixtures in a temporary HOME. The real harness logs are never read.
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-spend-sub-'));
process.env.HERDR_BOSS_DIR = path.join(ROOT, 'boss');
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const { scanSpend, spendSummary, formatSpend, loadPrices } = await import('../src/spend.js');

const SECRET = 'sk-fixture-SECRET-subagent-1a2b';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86400 * 1000;
const iso = (ms) => new Date(ms).toISOString();

let homeCount = 0;
function newHome() {
  const home = path.join(ROOT, `home-${homeCount += 1}`);
  fs.mkdirSync(path.join(home, 'Projects', '.herdr-wt', 'Shop'), { recursive: true });
  return home;
}
const dirs = (home) => ({ dataDir: path.join(home, 'boss'), worktreeRoot: path.join(home, 'Projects', '.herdr-wt') });
function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function row({ id, cwd, at = NOW, model = 'claude-opus-5-5', input = 1000, output = 500, cacheRead = 0, cacheWrite = 0, sessionId = 's1' }) {
  return {
    type: 'assistant', timestamp: iso(at), cwd, sessionId, requestId: `r-${id}`,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: SECRET }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
  };
}

test('subagent transcripts add their usage to the role of the parent session and show as a subset', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const folder = path.join(home, '.claude', 'projects', '-x');
  const bossCwd = '/x/bossdir';
  writeLines(path.join(folder, 'boss-session.jsonl'), [row({ id: 'p1', cwd: bossCwd, sessionId: 'boss-session', input: 100, output: 100 })]);
  writeLines(path.join(folder, 'boss-session', 'subagents', 'agent-a1.jsonl'), [
    row({ id: 'a', cwd: bossCwd, sessionId: 'boss-session', input: 1_000_000, output: 100_000 }),
    row({ id: 'a', cwd: bossCwd, sessionId: 'boss-session', input: 1_000_000, output: 100_000 }),
  ]);
  writeLines(path.join(folder, 'boss-session', 'subagents', 'agent-a2.jsonl'), [row({ id: 'b', cwd: bossCwd, sessionId: 'boss-session', input: 1_000_000, output: 0, at: NOW - DAY })]);
  const panes = [{ label: 'boss', orch: true, agent: 'claude', sessionId: 'boss-session', cwd: bossCwd }];
  const options = { dataDir, home, now: NOW, repos: [], worktreeRoot, panes, fillUsage: false };
  await scanSpend(options);
  await scanSpend(options);
  const summary = spendSummary({ dataDir, days: 3, now: NOW, prices: loadPrices() });
  const today = summary.days[0];
  const boss = today.roles.find((r) => r.role === 'boss');
  assert.equal(boss.tokens, 200 + 1_100_000);
  assert.equal(boss.subagents.tokens, 1_100_000);
  assert.equal(today.total.subagents.tokens, 1_100_000);
  assert.ok(today.total.subagents.costUsd > 0);
  assert.ok(today.total.costUsd > today.total.subagents.costUsd);
  const yesterday = summary.days[1];
  assert.equal(yesterday.total.subagents.tokens, 1_000_000);
  assert.equal(yesterday.total.tokens, 1_000_000);
  const text = formatSpend(summary);
  assert.match(text, /of which subagents\s+1\.10M tokens\s+[\d.]+ USD API-price equivalent/);
  assert.equal(text.split('\n').filter((l) => l.includes('of which subagents')).length, 2);
});

test('a day without subagent tokens prints no subagent line and the state keeps no path or session ID', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  writeLines(path.join(home, '.claude', 'projects', '-x', 'sess-plain-77.jsonl'), [row({ id: 'p', cwd, sessionId: 'sess-plain-77' })]);
  writeLines(path.join(home, '.claude', 'projects', '-x', 'sess-plain-77', 'subagents', 'agent-z.jsonl'), [row({ id: 'z', cwd, sessionId: 'sess-plain-77', at: NOW - 3 * DAY })]);
  await scanSpend({ dataDir, home, now: NOW, repos: [], worktreeRoot, fillUsage: false });
  const summary = spendSummary({ dataDir, days: 2, now: NOW, prices: loadPrices() });
  assert.equal(summary.days.length, 1);
  assert.equal(summary.days[0].total.subagents.tokens, 0);
  assert.ok(!formatSpend(summary).includes('subagents'));
  for (const name of ['spend-state.json', 'spend-daily.json']) {
    const text = fs.readFileSync(path.join(dataDir, name), 'utf8');
    assert.ok(!text.includes(path.sep), `${name} holds a path separator`);
    for (const id of ['sess-plain-77', 'agent-z', SECRET, home]) assert.ok(!text.includes(id), `${name} holds ${id}`);
  }
});

test('a subagent transcript older than the file limit is not read and the CLI prints the subagent line', async () => {
  const home = newHome();
  const { dataDir, worktreeRoot } = dirs(home);
  const cwd = path.join(worktreeRoot, 'Shop', 'fix1');
  const old = path.join(home, '.claude', 'projects', '-x', 'old-s', 'subagents', 'agent-old.jsonl');
  writeLines(old, [row({ id: 'o', cwd, sessionId: 'old-s' })]);
  fs.utimesSync(old, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
  const fresh = path.join(home, '.claude', 'projects', '-x', 'new-s', 'subagents', 'agent-new.jsonl');
  const today = new Date().toISOString();
  writeLines(fresh, [{ ...row({ id: 'n', cwd, sessionId: 'new-s' }), timestamp: today }]);
  await scanSpend({ dataDir, home, now: Date.now(), repos: [], worktreeRoot, fillUsage: false });
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, HERDR_BOSS_LIVE_DIR: dataDir };
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const out = spawnSync(process.execPath, [cli, 'spend', '--days', '2'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /of which subagents\s+1\.5K tokens/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'spend', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(json.days[0].total.subagents.tokens, 1500);
  assert.equal(json.days[0].total.tokens, 1500);
});
