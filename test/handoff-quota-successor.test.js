// K27: quota-based automatic successor kind selection and the capped bootstrap read.
// The selection code is pickSuccessor() in src/control.js. The quota data source is the collected
// quota windows in the state file.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { POLICY_DEFAULTS, pickSuccessor, successorQuotaRefusal, weeklyUseByProvider } from '../src/control.js';
import { handoffFixture, handoffPromptCalls, runHandoffCli } from './helpers/handoff-fixture.js';

const LADDER = [
  { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
  { kind: 'claude', model: 'claude-sonnet-5-5', effort: null },
];
const PROJECT = { excludedKinds: [], excludedModels: [] };
const POLICY = { ...POLICY_DEFAULTS, orchestratorLadder: LADDER };
const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const controlWith = (weeklyUse) => ({
  globalAllowed: { codex: ['gpt-6-luna'], claude: ['claude-sonnet-5-5'], pi: [] },
  risks: {}, exhausted: {}, lanes: {}, weeklyUse,
});

const WEEKLY_MINUTES = 10080;

function weeklyWindow(usedPercent, overrides = {}) {
  return { key: 'primary', label: 'Weekly', usedPercent, windowMinutes: WEEKLY_MINUTES, resetsAt: '2099-10-03T12:00:00.000Z', ...overrides };
}

function writeQuotas(root, quotas) {
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} }, quotas }));
}

test('weekly use counts only a live window of at least one week', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const quotas = [
    { provider: 'codex', windows: [weeklyWindow(91), { ...weeklyWindow(99), extra: true }] },
    { provider: 'claude', windows: [weeklyWindow(42), { ...weeklyWindow(50), windowMinutes: 300 }, { ...weeklyWindow(10), resetsAt: '2026-09-20T12:00:00.000Z' }] },
    { provider: 'opencodego', windows: [weeklyWindow(30)], error: 'probe failed' },
  ];
  assert.deepEqual(weeklyUseByProvider(quotas, now), { codex: 91, claude: 42 });
});

test('the successor quota refusal names the limit that refuses the target', () => {
  assert.equal(successorQuotaRefusal('codex', { codex: 85 }), null, 'exactly 85 percent is allowed');
  assert.match(successorQuotaRefusal('codex', { codex: 86 }), /codex weekly quota is at 86%/);
  assert.equal(successorQuotaRefusal('claude', { claude: 99 }), null, 'Claude stays eligible below 100 percent');
  assert.match(successorQuotaRefusal('claude', { claude: 100 }), /claude weekly quota is at 100%/);
  assert.equal(successorQuotaRefusal('codex', {}), null, 'no weekly reading leaves the choice as it was');
});

test('no Codex successor above 85 percent weekly use', () => {
  const refused = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ codex: 86, claude: 40 }), NOW);
  assert.equal(refused.kind, 'claude', 'the Codex rung is skipped above the limit');
  const allowed = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ codex: 85, claude: 90 }), NOW);
  assert.equal(allowed.kind, 'codex', 'exactly 85 percent weekly use still allows a Codex successor');
});

test('a Claude Sonnet successor is refused only at 100 percent weekly use', () => {
  const below = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ codex: 90, claude: 99 }), NOW);
  assert.equal(below.kind, 'claude');
  const at = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ codex: 90, claude: 100 }), NOW);
  assert.equal(at, null, 'no eligible successor remains when both lanes refuse');
});

test('the automatic successor prefers the lane with the lowest weekly use', () => {
  const chosen = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ codex: 40, claude: 10 }), NOW);
  assert.equal(chosen.kind, 'claude', 'the lane order in the ladder does not beat a lower weekly use');
  assert.equal(chosen.weeklyUsePercent, 10);
  const unread = pickSuccessor(PROJECT, 'pi', null, POLICY, controlWith({ claude: 10 }), NOW);
  assert.equal(unread.kind, 'codex', 'a lane with no weekly reading is treated as unused');
});

test('the plan output and the record carry the quota reason for the chosen target', (t) => {
  const f = handoffFixture(t);
  writeQuotas(f.root, [{ provider: 'codex', windows: [weeklyWindow(91)] }]);
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], f.env));
  assert.equal(plan.toKind, 'codex', 'a person asks for the kind by hand; the quota does not override it');
  assert.equal(plan.weeklyUsePercent, 91);
  assert.match(plan.successorReason, /codex weekly quota is at 91%/);
  assert.match(plan.successorReason, /above the 85% successor limit/);

  const prepared = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], f.env));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.successorReason, plan.successorReason, 'the record keeps the reason from the plan');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.match(saved.successorReason, /codex weekly quota is at 91%/);
});

test('the plan output names a lane without a weekly reading', (t) => {
  const f = handoffFixture(t);
  writeQuotas(f.root, [{ provider: 'claude', windows: [weeklyWindow(42)] }]);
  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'codex', '--mode', 'fresh'], f.env));
  assert.equal(plan.weeklyUsePercent, undefined);
  assert.match(plan.successorReason, /no weekly quota reading/);
});

test('the bootstrap prompt caps the discovery read to three sources and stays small', (t) => {
  const f = handoffFixture(t);
  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);
  const [prompt] = handoffPromptCalls(f.root);
  const read = prompt.split('Standby rule')[0];
  assert.match(read, /docs\/orchestration\/memory\.md/, 'the memory file is one of the three sources');
  assert.match(read, /published project status/i, 'the published project status is one of the three sources');
  assert.match(read, /open items/i, 'the open items are one of the three sources');
  assert.match(read, /only these three sources/i);
  assert.doesNotMatch(read, /Then read the project AGENTS\.md and the Herdr Boss bulletin\./, 'the old bulletin read is gone');
  assert.doesNotMatch(read, /Discover the project state from files and issues\./, 'the old open-ended discovery is gone');
  assert.match(read, /Do not read the Herdr Boss bulletin, the project repository, or any history/);
  const instruction = read.match(/Read only these three sources:[^]*?\./)[0];
  assert.ok(instruction.length <= 400, `the capped discovery read must stay short, got ${instruction.length} characters`);
  assert.ok(prompt.length <= 4000, `the bootstrap prompt must stay bounded, got ${prompt.length} characters`);
});

test('the Boss bootstrap prompt names the Boss memory file and the same three sources', (t) => {
  const f = handoffFixture(t, { sourceLabel: 'boss' });
  runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env);
  const [prompt] = handoffPromptCalls(f.root);
  const read = prompt.split('Standby rule')[0];
  assert.match(read, /~\/\.herdr-boss\/boss-memory\.md/);
  assert.match(read, /published project status/i);
  assert.match(read, /open items/i);
  assert.match(read, /only these three sources/i);
});