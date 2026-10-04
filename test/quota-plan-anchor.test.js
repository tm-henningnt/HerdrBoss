import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMessageStore } from '../src/message-store.js';
import { createQuotaPlanService } from '../src/quota-plan-service.js';
import { formatLocalTime, planDeviationText, projectedReach, projectionText, recentBurn } from '../src/quota-plan.js';
import { codexPlanGuidance, quotaPlanLaneText } from '../src/control.js';
import { codexPlanLine } from '../src/rules.js';
import { validateServiceSettings } from '../src/config.js';

const HOUR = 3600000;
const T = Date.parse('2032-04-01T00:00:00.000Z');
const at = (hours) => new Date(T + hours * HOUR).toISOString();
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function quotas(used, { resets = 168, credits = [{ id: 'credit-a', status: 'available', expiresAt: at(400) }] } = {}) {
  return [{
    provider: 'codex', observedAt: at(0),
    windows: [{ key: 'primary', label: 'Weekly', usedPercent: used, resetsAt: at(resets), windowMinutes: 10080 }],
    resetCredits: credits.length, codexResetCredits: credits,
  }];
}

function writeHistory(dir, rows) {
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${rows.map(([hours, usedPercent, resets = 168]) => JSON.stringify({
    at: at(hours), provider: 'codex', window: 'primary', usedPercent, resetsAt: at(resets),
  })).join('\n')}\n`);
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-anchor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messageStore = options.withMailbox ? openMessageStore({ dir, backend: 'json' }) : null;
  const service = createQuotaPlanService({ dataDir: dir, now: () => T, messageStore });
  return { dir, service, messageStore };
}

// The Owner case: a plan of 1 point per hour, a real burn of 3.5 points per hour.
function burnAhead(t, options) {
  const env = setup(t, options);
  writeHistory(env.dir, [[0, 20]]);
  env.service.replan({ provider: 'codex', quotas: quotas(20), now: T });
  writeHistory(env.dir, [[0, 20], [5, 37.5], [10, 55]]);
  return env;
}

test('recentBurn needs two readings in the window and a positive rate', () => {
  const row = (hours, usedPercent, extra = {}) => ({ at: at(hours), provider: 'codex', window: 'primary', usedPercent, resetsAt: at(168), ...extra });
  assert.equal(recentBurn([row(-1, 10)], { now: T }), null);
  assert.equal(recentBurn([row(-30, 10), row(-26, 20)], { now: T }), null, 'readings older than 24 hours do not count');
  assert.equal(recentBurn([row(-4, 10), row(-1, 10)], { now: T }), null, 'a flat burn gives no rate');
  const burn = recentBurn([row(-30, 1), row(-4, 10), row(-2, 17), row(0, 24)], { now: T });
  assert.equal(burn.ratePerHour, 3.5);
  assert.equal(burn.readings, 3);
  assert.equal(burn.to, at(0));
  assert.equal(recentBurn([row(-4, 60), row(-3, 5), row(-2, 8), row(0, 14)], { now: T }).ratePerHour, 3, 'a reset starts a new run');
  assert.equal(recentBurn([row(-4, 10), row(-2, 20, { resetsAt: at(336) }), row(0, 26, { resetsAt: at(336) })], { now: T }).ratePerHour, 3, 'a new reset time starts a new run');
});

test('projectedReach gives the time at which the target percent is reached', () => {
  const projection = projectedReach({ ratePerHour: 4, to: at(0), usedPercent: 55, readings: 3 }, 95, at(100));
  assert.equal(projection.at, at(10));
  assert.equal(projection.targetPercent, 95);
  assert.equal(projectedReach(null, 95), null);
});

test('projectedReach says reached at or above the target and never gives a past time', () => {
  const reached = projectedReach({ ratePerHour: 4, to: at(-3), usedPercent: 96, readings: 2 }, 95, at(100));
  assert.equal(reached.status, 'reached');
  assert.equal(reached.at, undefined);
  assert.equal(projectionText(reached), 'already at or above 95 percent');
  assert.equal(projectionText(projectedReach({ ratePerHour: 4, to: at(0), usedPercent: 90, readings: 2 }, 90, at(100))), 'already at or above 90 percent');
});

test('projectedReach says not before the window reset when the time follows the reset', () => {
  const late = projectedReach({ ratePerHour: 1, to: at(0), usedPercent: 20, readings: 2 }, 95, at(50));
  assert.equal(late.status, 'after-reset');
  assert.equal(projectionText(late), 'at this rate: 95 percent not before the window reset');
  const early = projectedReach({ ratePerHour: 4, to: at(0), usedPercent: 55, readings: 2 }, 95, at(50));
  assert.equal(early.status, 'projected');
  assert.match(projectionText(early), /^at this rate: 95 percent about /);
});

test('projectionText prints nothing for a garbage projection', () => {
  for (const bad of [null, {}, { targetPercent: 95, at: 'garbage', ratePerHour: 1, status: 'projected' }, { targetPercent: 95, at: at(1), ratePerHour: NaN, status: 'projected' },
    { targetPercent: 95, at: at(1), ratePerHour: Infinity }, { targetPercent: NaN, at: at(1), ratePerHour: 1 }, { targetPercent: 95, status: 'reached', ratePerHour: NaN }]) {
    assert.equal(projectionText(bad), '', JSON.stringify(bad));
  }
});

test('a drop of more than one point below the anchor moves the anchor', (t) => {
  const { dir, service } = burnAhead(t);
  const anchorAt = () => JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8')).anchor.at;
  service.replan({ provider: 'codex', quotas: quotas(19.5), now: T + 10 * HOUR });
  assert.equal(anchorAt(), at(0), 'a drop of 0.5 point keeps the anchor');
  service.replan({ provider: 'codex', quotas: quotas(18.5), now: T + 12 * HOUR });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8'));
  assert.equal(saved.anchor.at, at(12));
  assert.equal(saved.anchor.usedPercent, 18.5);
});

test('the view holds the recent burn projection and prints none without a positive burn', (t) => {
  const { dir, service } = burnAhead(t);
  const view = service.replan({ provider: 'codex', quotas: quotas(55), now: T + 10 * HOUR });
  assert.equal(view.projection.ratePerHour, 3.5);
  assert.equal(view.projection.targetPercent, 95);
  assert.ok(Math.abs(Date.parse(view.projection.at) - (T + (10 + 40 / 3.5) * HOUR)) < 60000);
  writeHistory(dir, [[0, 55], [10, 55]]);
  assert.equal(service.replan({ provider: 'codex', quotas: quotas(55), now: T + 10 * HOUR, force: true }).projection, null);
  writeHistory(dir, [[10, 55]]);
  assert.equal(service.get({ provider: 'codex', now: T + 10 * HOUR }).projection, null);
});

test('paced mode holds when ahead by more than the tolerance and spends when behind', () => {
  const plan = (used, planned, extra = {}) => ({
    historyAvailable: true, usedPercent: used, plannedUsageNow: planned, guidance: { state: 'normal' }, credits: [{ id: 'a' }], plan: { credits: [] }, ...extra,
  });
  assert.equal(codexPlanGuidance(plan(55, 50), 5).laneState, 'on pace', 'the tolerance edge is on pace');
  assert.equal(codexPlanGuidance(plan(55.1, 50), 5).laneState, 'hold');
  assert.equal(codexPlanGuidance(plan(47, 50), 5).laneState, 'Use now', 'behind at any distance is Use now');
  assert.equal(codexPlanGuidance(plan(53, 50), 5).laneState, 'on pace');
  assert.equal(codexPlanGuidance(plan(40, 50), 5).laneState, 'Use now');
  const guidance = codexPlanGuidance(plan(27.02, 27), 5);
  assert.equal(guidance.planMode, 'paced');
  assert.equal(guidance.laneState, 'on pace');
  assert.equal(guidance.deviationText, 'on plan');
});

test('the saved plan state holds until the lead leaves the tolerance band', (t) => {
  const { dir, service } = setup(t);
  writeHistory(dir, [[0, 20]]);
  service.replan({ provider: 'codex', quotas: quotas(20), now: T });
  writeHistory(dir, [[0, 20], [5, 37.5], [10, 55]]);
  const now = T + 10 * HOUR;
  const planned = service.replan({ provider: 'codex', quotas: quotas(55), now }).plannedUsageNow;
  const stateAt = (difference) => service.replan({ provider: 'codex', quotas: quotas(planned + difference), now }).guidance.state;
  assert.equal(stateAt(-7), 'spend', 'start the sequence outside the hold');
  assert.equal(stateAt(5.0), 'normal');
  assert.equal(stateAt(5.2), 'normal', '5.0 then 5.2 does not flip the state');
  assert.equal(stateAt(4.9), 'normal');
  assert.equal(stateAt(6.1), 'hold', '6.1 enters the hold');
  assert.equal(stateAt(4.1), 'hold', 'the hold stays inside the band');
  assert.equal(stateAt(3.9), 'normal', '3.9 leaves the hold');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'quota-plan.json'), 'utf8'));
  assert.equal(saved.current.guidance.state, 'normal');
});

test('the Codex lane keeps the hold from the saved state and the hold margin', () => {
  const plan = (state, used, planned) => ({
    historyAvailable: true, usedPercent: used, plannedUsageNow: planned, guidance: { state }, credits: [{ id: 'a' }], plan: { credits: [] },
  });
  assert.equal(codexPlanGuidance(plan('normal', 55.2, 50), 5, 'paced', 1).laneState, 'on pace', 'a small lead does not enter the hold');
  assert.equal(codexPlanGuidance(plan('normal', 56.1, 50), 5, 'paced', 1).laneState, 'hold', 'a lead past the margin enters the hold');
  assert.equal(codexPlanGuidance(plan('hold', 54.1, 50), 5, 'paced', 1).laneState, 'hold', 'a saved hold stays inside the band');
  assert.equal(codexPlanGuidance(plan('hold', 53.9, 50), 5, 'paced', 1).laneState, 'on pace', 'a saved hold leaves below the band');
});

test('quotaPlan.holdMargin is a settable number with a bounded range', () => {
  assert.deepEqual(validateServiceSettings({ 'quotaPlan.holdMargin': 1 }), { 'quotaPlan.holdMargin': 1 });
  assert.deepEqual(validateServiceSettings({ 'quotaPlan.holdMargin': 0.5 }), { 'quotaPlan.holdMargin': 0.5 });
  assert.throws(() => validateServiceSettings({ 'quotaPlan.holdMargin': -0.1 }), /0 to 50/);
  assert.throws(() => validateServiceSettings({ 'quotaPlan.holdMargin': 50.1 }), /0 to 50/);
});

test('the Owner case: 27 percent used, 3.5 points per hour burn, 1 planned', () => {
  const guidance = codexPlanGuidance({
    historyAvailable: true, usedPercent: 38, plannedUsageNow: 30, guidance: { state: 'hold' }, credits: [{ id: 'a' }], plan: { credits: [] },
    projection: { ratePerHour: 3.5, targetPercent: 95, at: '2032-04-04T03:00:00.000Z', readings: 4 },
  }, 5);
  assert.equal(guidance.laneState, 'hold');
  assert.equal(guidance.deviationText, 'ahead of plan by 8 points');
  assert.match(quotaPlanLaneText(guidance), /^hold \(38% used, 30% planned, ahead of plan by 8 points, tolerance 5 points\)$/);
  const line = codexPlanLine(guidance);
  assert.match(line, /^Codex plan: ahead of plan by 8 points, hold/);
  assert.ok(line.endsWith(`at this rate: 95 percent about ${formatLocalTime('2032-04-04T03:00:00.000Z')}`), line);
});

test('burst mode keeps the lane at Use now and shows the curve as advice', () => {
  const guidance = codexPlanGuidance({
    historyAvailable: true, usedPercent: 60, plannedUsageNow: 30, guidance: { state: 'hold' }, credits: [{ id: 'a' }], plan: { credits: [] },
  }, 5, 'burst');
  assert.equal(guidance.planMode, 'burst');
  assert.equal(guidance.laneState, 'Use now');
  assert.equal(guidance.deviationText, 'ahead of plan by 30 points');
  assert.match(quotaPlanLaneText(guidance), /^Use now \(60% used, 30% planned, ahead of plan by 30 points, tolerance 5 points\)/);
  assert.match(codexPlanLine(guidance), /burst/);
});

test('the Mailbox prompt gives the projected time and its distance from the plan', (t) => {
  const { messageStore, service } = burnAhead(t, { withMailbox: true });
  const soon = quotas(55, { credits: [{ id: 'credit-soon', status: 'available', expiresAt: at(40) }] });
  const view = service.replan({ provider: 'codex', quotas: soon, now: T + 10 * HOUR });
  const item = messageStore.all().find((entry) => entry.quotaCreditId === 'credit-soon');
  assert.ok(item, 'a prompt exists');
  assert.ok(item.text.includes(`at this rate: 95 percent about ${formatLocalTime(view.projection.at)}`), item.text);
  assert.match(item.text, /ahead of plan by 25 points/);
  assert.match(item.text, /\d+(\.\d)? hours (earlier|later) than the planned apply time/);
});

test('quotaPlan.planMode accepts paced and burst only', () => {
  assert.deepEqual(validateServiceSettings({ 'quotaPlan.planMode': 'burst' }), { 'quotaPlan.planMode': 'burst' });
  assert.deepEqual(validateServiceSettings({ 'quotaPlan.planMode': 'paced' }), { 'quotaPlan.planMode': 'paced' });
  assert.throws(() => validateServiceSettings({ 'quotaPlan.planMode': 'fast' }), /paced or burst/);
  assert.throws(() => createQuotaPlanService({ dataDir: os.tmpdir(), settings: { planMode: 'fast' } }), /paced or burst/);
});

test('quota plan CLI prints the deviation and the projection, and nothing without a burn', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-anchor-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const now = Date.now();
  const stamp = (hours) => new Date(now + hours * HOUR).toISOString();
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ quotasAt: stamp(0), quotas: [{
    provider: 'codex', observedAt: stamp(0), windows: [{ key: 'primary', label: 'Weekly', usedPercent: 55, resetsAt: stamp(150), windowMinutes: 10080 }],
    resetCredits: 1, codexResetCredits: [{ id: 'credit-a', status: 'available', expiresAt: stamp(400) }],
  }] }));
  const history = (rows) => fs.writeFileSync(path.join(data, 'quota-history.jsonl'), `${rows.map(([h, u]) => JSON.stringify({ at: stamp(h), provider: 'codex', window: 'primary', usedPercent: u, resetsAt: stamp(150) })).join('\n')}\n`);
  const run = () => spawnSync(process.execPath, [CLI, 'quota', 'plan', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '' },
  });
  history([[-10, 20], [-5, 37.5], [-0.01, 55]]);
  const withBurn = run();
  assert.equal(withBurn.status, 0, withBurn.stderr);
  assert.match(withBurn.stdout, /Plan mode: paced/);
  assert.match(withBurn.stdout, /(ahead of|behind) plan by [\d.]+ points|on plan/);
  assert.match(withBurn.stdout, /at this rate: 95 percent about [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d\d:\d\d/);
  history([[-1, 55]]);
  assert.doesNotMatch(run().stdout, /at this rate/);
});

test('the Mailbox prompt makes no earlier or later claim when the projection is not a time', (t) => {
  const { messageStore, service } = burnAhead(t, { withMailbox: true });
  writeHistory(path.dirname(service.file), [[0, 90], [5, 93], [10, 96]]);
  service.replan({ provider: 'codex', quotas: quotas(96, { credits: [{ id: 'credit-hot', status: 'available', expiresAt: at(40) }] }), now: T + 10 * HOUR });
  const item = messageStore.all().find((entry) => entry.quotaCreditId === 'credit-hot');
  assert.match(item.text, /already at or above 95 percent/);
  assert.doesNotMatch(item.text, /hours (earlier|later)/);
});
