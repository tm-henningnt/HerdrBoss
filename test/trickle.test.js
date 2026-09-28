import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-trickle-'));
process.env.HOME = path.join(fixture, 'home');
process.env.HERDR_BOSS_DIR = path.join(fixture, 'data');
process.env.HERDR_BOSS_LIVE_DIR = path.join(fixture, 'live');
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

const { deriveControl, laneStatus, leastOverProvider, POLICY_DEFAULTS } = await import('../src/control.js');
const { quotaUsageToday, readQuotaHistory } = await import('../src/usage.js');
const { renderBulletin } = await import('../src/rules.js');
const { describeLane, providerGate } = await import('../src/kit/workers.js');
const { loadModels } = await import('../src/kit/config.js');

const now = Date.parse('2026-09-28T12:00:00.000Z');
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });
const monthlyQuota = (patch = {}) => [{
  provider: 'opencodego',
  windows: [{ key: 'secondary', label: 'Monthly', usedPercent: 50, expectedPercent: 15,
    windowMinutes: 43200, willLast: false, resetsAt: '2026-10-23T12:00:00.000Z', ...patch }],
}];

test('monthly ahead-of-pace lane allows about 2.0 percent per day', () => {
  const quotas = monthlyQuota();
  const todayUse = quotaUsageToday(quotas, [], now);
  const lane = laneStatus(quotas, policy(), now, { todayUse }).opencodego;

  assert.equal(lane.state, 'trickle');
  assert.equal(lane.allowancePercent, 2);
  assert.equal(lane.usedTodayPercent, 0);
  assert.match(describeLane('opencodego', lane, now), /trickle \(Monthly 50% used, ahead of pace\): about 2\.0%\/day, 0\.0% used today/);

  const labelOnly = laneStatus(monthlyQuota({ windowMinutes: undefined }), policy(), now).opencodego;
  assert.equal(labelOnly.state, 'trickle', 'the Monthly label identifies the long window when its period is absent');
});

test('today usage uses the first UTC-day history row and starts again after a reset', () => {
  const historyFile = path.join(process.env.HERDR_BOSS_DIR, 'quota-history.jsonl');
  const rows = [
    { at: '2026-09-27T23:55:00.000Z', provider: 'opencodego', window: 'secondary', usedPercent: 48, resetsAt: '2026-10-23T12:00:00.000Z' },
    { at: '2026-09-28T00:05:00.000Z', provider: 'opencodego', window: 'secondary', usedPercent: 49.6, resetsAt: '2026-10-23T12:00:00.000Z' },
    { at: '2026-09-28T11:55:00.000Z', provider: 'opencodego', window: 'secondary', usedPercent: 49.8, resetsAt: '2026-10-23T12:00:00.000Z' },
  ];
  fs.writeFileSync(historyFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  assert.deepEqual(readQuotaHistory(), rows);
  assert.ok(Math.abs(quotaUsageToday(monthlyQuota({ usedPercent: 49.8 }), rows, now).opencodego.secondary - 0.2) < 1e-9);

  const resetQuota = [{ provider: 'opencodego', windows: [{ key: 'secondary', label: 'Monthly', usedPercent: 0.3,
    windowMinutes: 43200, resetsAt: '2026-10-28T12:00:00.000Z' }] }];
  const resetRows = [
    { at: '2026-09-28T00:05:00.000Z', provider: 'opencodego', window: 'secondary', usedPercent: 99.8, resetsAt: '2026-09-28T12:00:00.000Z' },
    { at: '2026-09-28T12:00:01.000Z', provider: 'opencodego', window: 'secondary', usedPercent: 0.1, resetsAt: '2026-10-28T12:00:00.000Z' },
  ];
  assert.ok(Math.abs(quotaUsageToday(resetQuota, resetRows, now + 60_000).opencodego.secondary - 0.2) < 1e-9);
  assert.equal(quotaUsageToday(resetQuota, [], now).opencodego.secondary, 0);
});

test('worker start permits trickle use under the allowance and refuses it at the allowance', () => {
  const lane = { state: 'trickle', window: 'Monthly', usedPercent: 50, expectedPercent: 15,
    allowancePercent: 2, usedTodayPercent: 1.9, backOnPaceAt: '2026-10-08T12:00:00.000Z' };
  const rules = { avoidProviders: ['opencodego'], lanes: { opencodego: lane }, leastOverProvider: null };
  assert.deepEqual(providerGate('opencodego', rules, { now }), {});
  lane.usedTodayPercent = 2;
  assert.equal(providerGate('opencodego', rules, { now }).error,
    'opencodego trickle used for today: 2.0% of about 2.0%/day; the next allowance starts at 00:00 UTC.');
  assert.match(providerGate('opencodego', rules, { now, force: true }).warning, /--force overrides the quota guard/);
});

test('a trickle lane under its allowance counts as usable for least-over selection', () => {
  assert.equal(leastOverProvider({
    opencodego: { state: 'trickle', allowancePercent: 2, usedTodayPercent: 1 },
    codex: { state: 'pace', overPercent: 3 },
  }), null);
});

test('short ahead-of-pace and exhausted weekly windows close a monthly trickle lane', () => {
  const quotas = [{ provider: 'opencodego', windows: [
    { key: 'secondary', label: 'Monthly', usedPercent: 60, expectedPercent: 10, windowMinutes: 43200,
      willLast: false, resetsAt: '2026-10-23T12:00:00.000Z' },
    { key: 'primary', label: 'Weekly', usedPercent: 30, expectedPercent: 10, windowMinutes: 10080,
      willLast: false, resetsAt: '2026-10-01T12:00:00.000Z' },
  ] }];
  const ahead = laneStatus(quotas, policy(), now, { todayUse: { opencodego: { secondary: 0 } } }).opencodego;
  assert.equal(ahead.state, 'pace');
  assert.equal(ahead.window, 'Monthly', 'the lane keeps its existing worst-window ranking while the short window closes it');

  quotas[0].windows[1].usedPercent = 100;
  const exhausted = laneStatus(quotas, policy(), now, { todayUse: { opencodego: { secondary: 0 } } }).opencodego;
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.window, 'Weekly');
});

test('bulletin and lanes show the trickle allowance and daily use', () => {
  const quotas = monthlyQuota();
  const todayUse = { opencodego: { secondary: 0.4 } };
  const lanes = laneStatus(quotas, policy(), now, { todayUse });
  const bulletin = renderBulletin({ updatedAt: new Date(now).toISOString(), quotas, lanes }, { alerts: [], advice: [] }, {});

  assert.match(bulletin, /OpenCode Go: trickle \(Monthly 50% used, ahead of pace\): about 2\.0%\/day, 0\.4% used today\./);
  assert.match(describeLane('opencodego', { ...lanes.opencodego, usedTodayPercent: 0.4 }, now),
    /trickle \(Monthly 50% used, ahead of pace\): about 2\.0%\/day, 0\.4% used today/);
});

test('bulletin and lanes use the shared short goal text', () => {
  const quotas = monthlyQuota();
  const goals = policy({ pacingGoals: { opencodego: { secondary: { percent: 100,
    end: { type: 'at', at: '2026-10-08T12:00:00.000Z' } } } } });
  const lanes = laneStatus(quotas, goals, now, { todayUse: { opencodego: { secondary: 0.4 } } });
  const bulletin = renderBulletin({ updatedAt: new Date(now).toISOString(), quotas, lanes }, { alerts: [], advice: [] }, {});
  const line = describeLane('opencodego', lanes.opencodego, now);

  assert.match(bulletin, /goal: 100% by Thu 8 Oct/);
  assert.match(line, /goal: 100% by Thu 8 Oct/);
});

test('automatic handover selects a trickle lane only while it is under its daily allowance', () => {
  const models = loadModels();
  const snap = {
    projects: [{ slug: 'sample', workspace: 'w1' }],
    herdr: {
      workspaces: [{ id: 'w1', label: 'Sample' }],
      panes: [{ id: 'w1:p1', workspace: 'w1', orch: true, agent: 'claude', status: 'working', sessionId: 's1' }],
    },
    quotas: [{ provider: 'claude', windows: [{ key: 'primary', label: 'Weekly', usedPercent: 90,
      expectedPercent: 30, windowMinutes: 10080, willLast: false, etaSeconds: 60,
      resetsAt: '2026-10-01T12:00:00.000Z' }] }],
  };
  const p = policy({ projects: { sample: { share: 100, mode: 'active', excludedKinds: ['codex'], excludedModels: [] } } });
  const trickle = { state: 'trickle', allowancePercent: 2, usedTodayPercent: 1.5 };
  const under = deriveControl(snap, p, models, {}, now, {}, { lanes: { opencodego: trickle } });
  assert.equal(under.handoffs[0].target.kind, 'pi');
  const atLimit = deriveControl(snap, p, models, {}, now, {}, {
    lanes: { opencodego: { ...trickle, usedTodayPercent: 2 } },
  });
  assert.equal(atLimit.handoffs[0].target, null);
});
