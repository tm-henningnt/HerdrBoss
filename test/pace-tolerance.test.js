import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveControl, laneStatus, POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { describeLane, providerGate } from '../src/kit/workers.js';
import { loadModels } from '../src/kit/config.js';

const models = loadModels();
const now = Date.parse('2026-09-25T16:00:00Z');
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });
const weekly = (usedPercent, expectedPercent, extra = {}) => ({
  provider: 'claude',
  windows: [{ key: 'secondary', label: 'Weekly', usedPercent, expectedPercent, willLast: true, windowMinutes: 10080, resetsAt: '2026-10-01T18:59:00Z', ...extra }],
});
const lane = (used, expected, p = policy(), extra = {}) => laneStatus([weekly(used, expected, extra)], p, now).claude;

test('the policy defaults hold the pace tolerance and the minimum use', () => {
  assert.equal(POLICY_DEFAULTS.paceTolerancePoints, 5);
  assert.equal(POLICY_DEFAULTS.paceMinUsePercent, 30);
  assert.ok(!('paceTolerancePoints' in POLICY_DEFAULTS.machine), 'the keys are machine-independent');
});

test('validatePolicy checks the pace ranges', () => {
  assert.deepEqual(validatePolicy(policy(), models), []);
  for (const [key, ok, bad] of [['paceTolerancePoints', [0, 50], [-1, 51]], ['paceMinUsePercent', [0, 100], [-1, 101]]]) {
    for (const value of ok) assert.deepEqual(validatePolicy(policy({ [key]: value }), models), [], `${key} ${value}`);
    for (const value of [...bad, 1.5, '5', null]) assert.match(validatePolicy(policy({ [key]: value }), models).join(' '), new RegExp(`${key} must be an integer`), `${key} ${value}`);
  }
});

test('a lane 1 point above the expected use is on pace', () => {
  const l = lane(17, 16);
  assert.equal(l.state, 'open');
});

test('a lane 6 points above the expected use and above the minimum use is ahead of pace', () => {
  const l = lane(36, 30);
  assert.equal(l.state, 'pace');
  assert.equal(l.overPercent, 6);
});

test('a lane below the minimum use is never ahead of pace', () => {
  assert.equal(lane(29, 20).state, 'open');
  assert.equal(lane(29, 20, policy(), { willLast: false }).state, 'open');
  assert.equal(lane(30, 20).state, 'pace');
});

test('exactly the tolerance above the expected use is on pace', () => {
  assert.equal(lane(35, 30).state, 'open');
  assert.equal(lane(36, 30).state, 'pace');
});

test('a forecast that will not last is ahead above the minimum use, and never below it', () => {
  assert.equal(lane(25, 24, policy(), { willLast: false }).state, 'open');
  assert.equal(lane(17, 16, policy(), { willLast: false }).state, 'open');
  assert.equal(lane(40, 39, policy(), { willLast: false }).state, 'pace');
  assert.equal(lane(42, 12, policy(), { willLast: false }).state, 'pace');
});

test('zero tolerance and zero minimum use keep the old rule', () => {
  const old = policy({ paceTolerancePoints: 0, paceMinUsePercent: 0 });
  assert.equal(lane(17, 16, old).state, 'pace');
  assert.equal(lane(16, 16, old).state, 'open');
  assert.equal(lane(3, 2, old).state, 'pace');
});

test('a policy without the keys uses the defaults', () => {
  const p = policy();
  delete p.paceTolerancePoints;
  delete p.paceMinUsePercent;
  assert.equal(lane(17, 16, p).state, 'open');
  assert.equal(lane(36, 30, p).state, 'pace');
});

test('the lanes line shows the tolerance for a lane on pace and for a lane ahead of pace', () => {
  assert.equal(describeLane('claude', lane(17, 16), now), 'claude on pace (17% used, expected 16%, tolerance 5 points)');
  assert.equal(describeLane('claude', lane(10, 16), now), 'claude open');
  assert.match(describeLane('claude', lane(36, 30), now), /^claude ahead of pace: 36% used against 30% expected in the Weekly window; .*tolerance 5 points/);
});

test('worker start accepts a 1 point gap and refuses a lane clearly ahead', () => {
  const rulesFor = (used, expected) => {
    const q = { provider: 'claude', windows: [{ key: 'secondary', label: 'Weekly', usedPercent: used, expectedPercent: expected, willLast: false, etaSeconds: 90000, windowMinutes: 10080, resetsAt: '2026-10-01T18:59:00Z' }] };
    const p = policy();
    const snap = { projects: [], herdr: { workspaces: [], panes: [] }, quotas: [q] };
    const control = deriveControl(snap, p, models, {}, now);
    const lanes = laneStatus([q], p, now);
    return { avoidProviders: Object.keys(lanes).filter((k) => control.pressures[k] || control.risks[k]), lanes };
  };
  assert.deepEqual(providerGate('claude', rulesFor(17, 16), { now }), {});
  const refused = providerGate('claude', rulesFor(36, 30), { now }).error;
  assert.match(refused, /claude ahead of pace: 36% used against 30% expected/);
  assert.match(refused, /tolerance 5 points/);
});
