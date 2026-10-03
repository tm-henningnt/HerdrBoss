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
import { codexPlanGuidance, useNowLanes } from '../src/control.js';

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

  assert.equal(codexPlanGuidance(plan, 5).laneState, 'ahead of plan', 'the tolerance edge stays out of hold');
  assert.equal(codexPlanGuidance(plan, 4).laneState, 'hold');
  assert.equal(codexPlanGuidance({ ...plan, usedPercent: 49 }, 5).laneState, 'Use now');
  assert.equal(codexPlanGuidance(plan, 5).nextCredit.label, 'A');
  assert.equal(codexPlanGuidance({ ...plan, plan: { credits: [
    { id: 'credit-a', applyAt: null, usedPercent: null },
    { id: 'credit-b', applyAt: '2032-04-10T16:00:00.000Z', usedPercent: 95 },
  ] } }, 5).nextCredit.label, 'B');
  assert.equal(codexPlanGuidance({ ...plan, historyAvailable: false, credits: [] }, 5), null);
});

test('the Use now list follows Codex plan guidance when the plan is available', () => {
  assert.deepEqual(useNowLanes({ codex: {
    state: 'pace', planGuidance: { ...planGuidance, laneState: 'Use now', plannedPercent: 50, usedPercent: 40 },
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
  const ctx = {
    PROVIDERS: { codex: 'Codex' },
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  };
  vm.runInNewContext(`${code}\nthis.laneLine = laneLine;`, ctx);

  const html = ctx.laneLine('codex', {
    state: 'open', usedPercent: 40, expectedPercent: 42, planGuidance,
  });

  assert.match(html, /Use now/);
  assert.match(html, /50% planned/);
  assert.doesNotMatch(html, /42% expected/);
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
