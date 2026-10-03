import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NOW = Date.now();
const at = (hours) => new Date(NOW + hours * 3600000).toISOString();

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-cli-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ quotasAt: at(0), quotas: [{
    provider: 'codex', observedAt: at(0), windows: [{ key: 'primary', label: 'Weekly', usedPercent: 1, resetsAt: at(168), windowMinutes: 10080 }],
    resetCredits: 1, codexResetCredits: [{ id: 'credit-a', status: 'available', grantedAt: at(-24), expiresAt: at(400) }],
  }] }));
  fs.writeFileSync(path.join(data, 'quota-history.jsonl'), `${JSON.stringify({ at: at(-1), provider: 'codex', window: 'primary', usedPercent: 1, resetsAt: at(168) })}\n`);
  return { home, data };
}

function run({ home, data }, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '' },
  });
}

test('quota plan CLI prints the plan and treats announce as a non-persisted what-if', (t) => {
  const env = setup(t);
  const result = run(env, ['quota', 'plan', 'codex', '--burst-pace', '1.2', '--announce', `${at(72)}:partial`, '--what-if', at(500), '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, 'codex');
  assert.equal(output.usedPercent, 1);
  assert.equal(output.plan.fast.burnRate, 1.2);
  assert.equal(output.burstTable.length, 5);
  assert.ok(output.plan.fast.totalConsumed >= 0);
  assert.equal(fs.existsSync(path.join(env.data, 'quota-plan.json')), false, 'a what-if does not create quota-plan.json');
  assert.doesNotMatch(result.stdout, /account|email|token/i);
});

test('quota plan CLI prints a plain-text summary with credit bounds and all burst rates', (t) => {
  const result = run(setup(t), ['quota', 'plan', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex quota plan at .*\nUsed: 1%.*weekly reset:/);
  assert.match(result.stdout, /earliest .*planned .*latest .*expiry/);
  assert.match(result.stdout, /By .* points; gain over no credits .* points/);
  for (const pace of ['0.8', '1.0', '1.2', '1.5', '2.0']) assert.match(result.stdout, new RegExp(`${pace.replace('.', '\\.')} \/ hour`));
  assert.match(result.stdout, /Fast: .*slow:/);
});

test('quota announce stores, lists, and removes resets; credit used records Owner confirmation', (t) => {
  const env = setup(t);
  const created = run(env, ['quota', 'announce', 'codex', '--at', at(72), '--kind', 'partial', '--refund', '12']);
  assert.equal(created.status, 0, created.stderr);
  const id = /\b(id|ID)\s*[:= ]\s*([\w-]+)/.exec(created.stdout)?.[2];
  assert.ok(id, created.stdout);
  assert.equal(run(env, ['quota', 'announce', '--list']).status, 0);
  const removed = run(env, ['quota', 'announce', '--remove', id]);
  assert.equal(removed.status, 0, removed.stderr);
  run(env, ['quota', 'credit', 'used', 'credit-a']);
  const saved = JSON.parse(fs.readFileSync(path.join(env.data, 'quota-plan.json'), 'utf8'));
  assert.equal(saved.announcements.length, 0);
  assert.ok(saved.usedCredits.some((item) => item.id === 'credit-a'));
});

test('quota plan CLI refuses an unknown provider with a clear error', (t) => {
  const result = run(setup(t), ['quota', 'plan', 'claude']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only codex is supported/i);
});
