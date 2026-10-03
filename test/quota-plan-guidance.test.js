import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createQuotaPlanService } from '../src/quota-plan-service.js';
import { renderBulletin } from '../src/rules.js';
import { describeLane, providerGate } from '../src/kit/workers.js';
import { codexPlanGuidance, quotaPlanLaneText, useNowLanes } from '../src/control.js';
import { codexPlanLine } from '../src/rules.js';

const NOW = Date.parse('2032-04-01T00:00:00.000Z');
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const nextCredit = { label: 'A', applyAt: '2032-04-05T16:00:00.000Z', usedPercent: 95 };
const planGuidance = {
  laneState: 'Use now',
  usageGuidance: 'spend',
  usedPercent: 40,
  plannedPercent: 50,
  tolerancePoints: 5,
  nextCredit,
};

test('Codex lane guidance compares actual use with the planned curve and tolerance', () => {
  const plan = {
    historyAvailable: true,
    usedPercent: 55,
    plannedUsageNow: 50,
    guidance: { state: 'normal' },
    credits: [{ id: 'credit-a' }, { id: 'credit-b' }],
    plan: { credits: [
      { id: 'credit-a', applyAt: '2032-04-05T16:00:00.000Z', usedPercent: 95 },
      { id: 'credit-b', applyAt: '2032-04-10T16:00:00.000Z', usedPercent: 95 },
    ] },
  };

  assert.equal(codexPlanGuidance(plan, 5).laneState, 'on pace', 'the tolerance edge stays out of hold');
  assert.equal(codexPlanGuidance(plan, 4).laneState, 'hold');
  assert.equal(codexPlanGuidance({ ...plan, usedPercent: 49 }, 5).laneState, 'Use now', 'behind at any distance is Use now');
  assert.equal(codexPlanGuidance({ ...plan, usedPercent: 50 }, 5).laneState, 'Use now', 'on the curve is Use now');
  assert.equal(codexPlanGuidance({ ...plan, usedPercent: 51 }, 5).laneState, 'on pace', 'ahead within the tolerance is on pace');
  assert.equal(codexPlanGuidance(plan, 5).nextCredit.label, 'A');
  assert.equal(codexPlanGuidance({ ...plan, plan: { credits: [
    { id: 'credit-a', applyAt: null, usedPercent: null },
    { id: 'credit-b', applyAt: '2032-04-10T16:00:00.000Z', usedPercent: 95 },
  ] } }, 5).nextCredit.label, 'B');
  assert.equal(codexPlanGuidance({ ...plan, historyAvailable: false, credits: [] }, 5), null);
});

test('the Use now list follows Codex plan guidance when the plan is available', () => {
  assert.deepEqual(useNowLanes({ codex: {
    state: 'open', planGuidance: { ...planGuidance, laneState: 'Use now', plannedPercent: 50, usedPercent: 40 },
  } }), [{ provider: 'codex', kind: 'codex', reason: 'below plan' }]);
  assert.deepEqual(useNowLanes({ codex: {
    state: 'open', roomPercent: 60, planGuidance: { ...planGuidance, laneState: 'hold' },
  } }), []);
  assert.deepEqual(useNowLanes({ codex: { state: 'open', roomPercent: 60 } }), [
    { provider: 'codex', kind: 'codex', reason: 'below pace' },
  ]);
});

test('Codex lane text uses the planned curve state and values', () => {
  const text = describeLane('codex', {
    state: 'open',
    usedPercent: 40,
    expectedPercent: 42,
    planGuidance,
  }, NOW);

  assert.match(text, /codex Use now/);
  assert.match(text, /40% used, 50% planned/);
  assert.doesNotMatch(text, /42% expected/);
});

test('the bulletin and lanes guidance include the next planned reset credit', () => {
  const lane = { state: 'open', usedPercent: 40, roomPercent: 60, planGuidance };
  const bulletin = renderBulletin({
    updatedAt: new Date(NOW).toISOString(),
    quotas: [],
    lanes: { codex: lane },
  }, { alerts: [], advice: [] }, {});

  assert.match(bulletin, /Codex plan: spend, credit A due about .* when usage reaches 95 percent/);
  assert.match(bulletin, /Codex: Use now \(40% used, 50% planned/);
});

test('herdr-boss lanes prints the Codex plan line from the saved lane data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-lanes-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, 'rules.json'), JSON.stringify({
    lanes: { codex: { state: 'open', roomPercent: 60, usedPercent: 40, planGuidance } },
  }));

  const result = spawnSync(process.execPath, [CLI, 'lanes'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex plan: spend, credit A due about .* when usage reaches 95 percent/);
  assert.match(result.stdout, /codex Use now \(40% used, 50% planned/);
});

test('planned hold guidance does not refuse a worker start by itself', () => {
  const result = providerGate('codex', {
    avoidProviders: [],
    lanes: { codex: { state: 'open', planGuidance: { ...planGuidance, laneState: 'hold' } } },
  }, { now: NOW });

  assert.deepEqual(result, {});
});

test('the Overview lane text shows the planned Codex state and planned percent', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function laneLine(');
  assert.ok(start >= 0, 'laneLine exists in public/app.js');
  const code = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const validStart = source.indexOf('function validPlan(');
  assert.ok(validStart >= 0, 'validPlan exists in public/app.js');
  const validCode = source.slice(validStart, source.indexOf('\n}\n', validStart) + 2);
  const ctx = {
    PROVIDERS: { codex: 'Codex' },
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  };
  vm.runInNewContext(`${validCode}\n${code}\nthis.laneLine = laneLine;`, ctx);

  const html = ctx.laneLine('codex', {
    state: 'open', usedPercent: 40, expectedPercent: 42, planGuidance,
  });

  assert.match(html, /Use now/);
  assert.match(html, /50% planned/);
  assert.doesNotMatch(html, /42% expected/);
  assert.match(ctx.laneLine('codex', { state: 'open', usedPercent: 40, planGuidance: { ...planGuidance, laneState: 'hold', deviationText: 'ahead of plan by 8 points' } }), /50% planned · ahead of plan by 8 points/);
});

test('the lane guidance falls back when there are no credits or usage history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createQuotaPlanService({ dataDir: dir, now: () => NOW });
  const quotas = [{
    provider: 'codex',
    windows: [{ key: 'primary', label: 'Weekly', usedPercent: 40, resetsAt: '2032-04-08T00:00:00.000Z', windowMinutes: 10080 }],
    codexResetCredits: [],
  }];
  service.replan({ provider: 'codex', quotas, now: NOW });

  assert.deepEqual(service.summary({ now: NOW }), {
    nextCreditAt: null,
    state: 'unavailable',
    plannedUsageNow: null,
  });
});

test('history with a zero burn rate still activates plan guidance, including after a saved plan upgrade', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quota-plan-zero-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'quota-history.jsonl'), `${JSON.stringify({
    at: new Date(NOW - 3600000).toISOString(), provider: 'codex', window: 'primary', usedPercent: 40,
    resetsAt: '2032-04-08T00:00:00.000Z',
  })}\n`);
  const quotas = [{
    provider: 'codex',
    windows: [{ key: 'primary', label: 'Weekly', usedPercent: 40, resetsAt: '2032-04-08T00:00:00.000Z', windowMinutes: 10080 }],
    codexResetCredits: [],
  }];
  const service = createQuotaPlanService({ dataDir: dir, now: () => NOW });
  const first = service.replan({ provider: 'codex', quotas, now: NOW });
  assert.equal(first.historicalP90, 0);
  assert.equal(first.historyAvailable, true);
  assert.equal(service.summary({ now: NOW }).state, 'normal');

  const file = path.join(dir, 'quota-plan.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.current.historyAvailable;
  fs.writeFileSync(file, JSON.stringify(saved));
  const upgraded = createQuotaPlanService({ dataDir: dir, now: () => NOW });
  const current = upgraded.replan({ provider: 'codex', quotas, now: NOW });
  assert.equal(current.historyAvailable, true);
  assert.equal(upgraded.summary({ now: NOW }).state, 'normal');
});

const paceLane = {
  state: 'pace',
  usedPercent: 60,
  expectedPercent: 40,
  window: 'weekly',
  tolerancePoints: 5,
  backOnPaceAt: new Date(NOW + 3 * 3600000).toISOString(),
  planGuidance: { laneState: 'Use now', usedPercent: 20, plannedPercent: 40, tolerancePoints: 5 },
};

test('a lane ahead of pace is not in Use now, and its text keeps the pace wording', () => {
  assert.deepEqual(useNowLanes({ codex: paceLane }), []);

  const gate = providerGate('codex', { lanes: { codex: paceLane }, avoidProviders: ['codex'] }, { now: NOW });
  assert.ok(Object.keys(gate).length, 'worker start refuses the lane');
  assert.doesNotMatch(JSON.stringify(gate), /codex Use now/);
  assert.match(JSON.stringify(gate), /ahead of pace/);

  const text = describeLane('codex', paceLane, NOW);
  assert.match(text, /^codex ahead of pace/);
  assert.match(text, /plan guidance: Use now \(20% used, 40% planned/);

  const bulletin = renderBulletin({ updatedAt: new Date(NOW).toISOString(), quotas: [], lanes: { codex: paceLane } }, { alerts: [], advice: [] }, {});
  assert.match(bulletin, /ahead of pace: 60% used/);
  assert.match(bulletin, /Plan guidance: Use now/);
});

test('the idle nudge does not start work on a lane ahead of pace', () => {
  assert.equal(useNowLanes({ codex: paceLane })[0], undefined);
});

test('plan helpers tolerate missing, null and NaN fields', () => {
  assert.equal(quotaPlanLaneText({ laneState: 'hold' }), 'hold');
  assert.equal(quotaPlanLaneText({ laneState: 'hold', usedPercent: NaN, plannedPercent: null, tolerancePoints: 5 }), 'hold (tolerance 5 points)');
  assert.doesNotMatch(quotaPlanLaneText({ laneState: 'hold', usedPercent: NaN, plannedPercent: 50 }), /NaN|undefined|null/);
  assert.equal(quotaPlanLaneText({ usedPercent: 10 }), '');
  assert.equal(quotaPlanLaneText(null), '');

  assert.equal(codexPlanLine(null), null);
  const line = codexPlanLine({ usageGuidance: 'spend', nextCredit: { label: 'A', applyAt: '2032-04-05T16:00:00.000Z' } });
  assert.match(line, /^Codex plan: spend, credit A due about/);
  assert.doesNotMatch(line, /percent|NaN/);
  assert.doesNotMatch(codexPlanLine({ usageGuidance: 'spend', nextCredit: { label: 'A', usedPercent: NaN } }), /NaN|\?/);
});

test('a guidance object without a laneState is no plan in Use now', () => {
  assert.deepEqual(useNowLanes({ codex: { state: 'open', roomPercent: 30, planGuidance: { usedPercent: 10, plannedPercent: 50 } } }),
    [{ provider: 'codex', kind: 'codex', reason: 'below pace' }]);
  assert.deepEqual(useNowLanes({ codex: { state: 'open', planGuidance: { laneState: 'Use now', usedPercent: NaN } } }),
    [{ provider: 'codex', kind: 'codex', reason: 'below plan' }]);
});

test('the Overview lane line keeps the pace text for a lane ahead of pace and tolerates a partial plan', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const grab = (name) => { const i = source.indexOf(`function ${name}(`); return source.slice(i, source.indexOf('\n}\n', i) + 2); };
  const ctx = { PROVIDERS: { codex: 'Codex' }, esc: (v) => String(v ?? '') };
  vm.runInNewContext(`${grab('validPlan')}\n${grab('useNowList')}\n${grab('laneLine')}\nthis.laneLine = laneLine; this.useNowList = useNowList;`, ctx);

  assert.deepEqual([...ctx.useNowList({ codex: paceLane })], []);
  const html = ctx.laneLine('codex', paceLane);
  assert.match(html, /ahead of pace/);
  assert.match(html, /plan Use now/);
  const partial = ctx.laneLine('codex', { state: 'open', usedPercent: 40, planGuidance: { laneState: 'hold' } });
  assert.doesNotMatch(partial, /NaN|undefined/);
  assert.deepEqual([...ctx.useNowList({ codex: { state: 'open', planGuidance: { usedPercent: 1 } } })], ['codex']);
});
