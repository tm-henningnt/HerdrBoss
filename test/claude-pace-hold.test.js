import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { laneStatus, POLICY_DEFAULTS, useNowLanes } from '../src/control.js';
import { formatLocalTime } from '../src/quota-plan.js';
import { describeLane } from '../src/kit/workers.js';
import { renderBulletin } from '../src/rules.js';

const HOUR = 3600000;
const now = Date.parse('2026-09-28T12:00:00Z');
const policy = () => structuredClone(POLICY_DEFAULTS);
const weekly = (usedPercent, resetsInHours, extra = {}) => ({
  provider: 'claude',
  windows: [{ key: 'secondary', label: 'Weekly', usedPercent, expectedPercent: usedPercent, willLast: true, windowMinutes: 10080, resetsAt: new Date(now + resetsInHours * HOUR).toISOString(), ...extra }],
});
const reading = (hoursAgo, usedPercent, resetsInHours = 40) => ({
  at: new Date(now - hoursAgo * HOUR).toISOString(), provider: 'claude', window: 'secondary', usedPercent, resetsAt: new Date(now + resetsInHours * HOUR).toISOString(),
});
const lanes = (used, hours, readings = []) => laneStatus([weekly(used, hours)], policy(), now, { readings });

test('80 percent weekly with more than 12 hours to the reset holds new Claude work', () => {
  const lane = lanes(80, 40).claude;
  assert.equal(lane.state, 'open', 'worker admission stays unchanged');
  assert.equal(lane.paceHold.usedPercent, 80);
  assert.equal(useNowLanes({ claude: lane }).length, 0, 'the lanes line drops Claude');
});

test('79 percent weekly and 12 hours or less to the reset do not hold', () => {
  assert.equal(lanes(79, 40).claude.paceHold, undefined);
  assert.equal(lanes(85, 12).claude.paceHold, undefined);
  assert.equal(lanes(85, 11).claude.paceHold, undefined);
  assert.equal(useNowLanes({ claude: lanes(79, 40).claude })[0]?.provider, 'claude');
});

test('the hold carries the projection to 100 percent from the recent burn', () => {
  const lane = lanes(80, 40, [reading(10, 70), reading(0, 80)]).claude;
  assert.equal(lane.paceHold.projectedAt, new Date(now + 20 * HOUR).toISOString());
});

test('the hold has no projection with fewer than two readings or without a positive burn', () => {
  assert.equal(lanes(80, 40, [reading(0, 80)]).claude.paceHold.projectedAt, null);
  assert.equal(lanes(80, 40, [reading(10, 80), reading(0, 80)]).claude.paceHold.projectedAt, null);
  assert.equal(lanes(80, 40, []).claude.paceHold.projectedAt, null);
});

test('the hold has no projection when the burn reaches 100 percent after the reset', () => {
  assert.equal(lanes(80, 10.5, [reading(10, 79.9, 10.5), reading(0, 80, 10.5)]).claude.paceHold, undefined);
  assert.equal(lanes(80, 13, [reading(10, 79.9, 13), reading(0, 80, 13)]).claude.paceHold.projectedAt, null);
});

test('describeLane and the bulletin print the hold text and the projection', () => {
  const state = lanes(80, 40, [reading(10, 70), reading(0, 80)]);
  const text = `Claude: hold new Claude work (80% weekly used; 100 percent at ${formatLocalTime(now + 20 * HOUR)})`;
  assert.match(describeLane('claude', state.claude, now), /hold new Claude work/);
  assert.ok(describeLane('claude', state.claude, now).includes(`100 percent at ${formatLocalTime(now + 20 * HOUR)}`));
  const bulletin = renderBulletin({ updatedAt: new Date(now).toISOString(), lanes: state }, { alerts: [], advice: [] }, { dashboardUrl: 'http://127.0.0.1:4477/' });
  assert.ok(bulletin.includes(`- ${text}`), bulletin);
  assert.match(bulletin, /Use now: no metered lane/);
});

test('the bulletin prints no projection without a positive burn', () => {
  const state = lanes(80, 40);
  const bulletin = renderBulletin({ updatedAt: new Date(now).toISOString(), lanes: state }, { alerts: [], advice: [] }, { dashboardUrl: 'http://127.0.0.1:4477/' });
  assert.match(bulletin, /- Claude: hold new Claude work \(80% weekly used\)/);
  assert.doesNotMatch(bulletin, /100 percent at/);
});
