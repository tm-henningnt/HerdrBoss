import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { calculateExhaustionPlan, planQuota, plannedUsageAt, usageGuidance, burstTable, hourlyBurnP90, detectedReset } from '../src/quota-plan.js';

const HOUR = 3600000;
const NOW = Date.parse('2032-04-01T00:00:00Z');
const at = (hours) => new Date(NOW + hours * HOUR).toISOString();
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const exactInput = (overrides = {}) => ({
  now: at(0), usedPercent: 1, resetsAt: at(168), maxBurnRate: 1.5,
  credits: [{ id: 'A', expires_at: at(400) }, { id: 'B', expires_at: at(600) }],
  horizon: at(500), ...overrides,
});

// The fixture has hourly bursts, idle hours, and two weekly resets.
const syntheticHistory = Array.from({ length: 337 }, (_, hour) => {
  const start = hour - hour % 168;
  let usedPercent = 0;
  for (let h = start; h < hour; h++) {
    const withinDay = h % 24;
    usedPercent += withinDay < 8 ? 0 : withinDay < 12 ? 1.5 : 0.5;
  }
  return { at: at(hour - 336), provider: 'codex', window: 'secondary', usedPercent,
    expectedPercent: (hour % 168) / 168 * 100, resetsAt: at(start - 336 + 168), willLast: true };
});

test('planned curve uses bursts to 95 then lands on 100 at each regular reset', () => {
  const plan = planQuota(exactInput({ burstPace: 1, maxBurnRate: undefined, horizon: at(600) }));
  assert.equal(plan.credits[0].applyAt, at(94));
  assert.equal(plan.credits[1].applyAt, at(189));
  assert.ok(plan.curve.length > 4);
  close(plannedUsageAt(plan, at(40)), 41);
  close(plannedUsageAt(plan, at(94)), 0);
  close(plannedUsageAt(plan, at(140)), 46);
  close(plannedUsageAt(plan, at(189 + 84)), 50);
  close(plannedUsageAt(plan, at(357)), 0);
  assert.ok(plan.curve.some((point) => point.at === at(357) && point.usedPercent === 100));
  assert.equal(plan.curve.at(-1).phase, 'natural');
});

test('curve guidance compares below, on, and above with a five-point tolerance', () => {
  const plan = planQuota(exactInput({ burstPace: 1 }));
  assert.equal(usageGuidance(plan, at(40), 30).state, 'spend');
  assert.equal(usageGuidance(plan, at(40), 41).state, 'normal');
  assert.equal(usageGuidance(plan, at(40), 46).state, 'normal');
  assert.equal(usageGuidance(plan, at(40), 47).state, 'hold');
  assert.equal(usageGuidance(plan, at(40), 44, 2).state, 'hold');
});

test('burst table gives totals by the last expiry and earlier credits at faster paces', () => {
  const rows = burstTable(exactInput({ horizon: at(500) }));
  assert.deepEqual(rows.map((row) => row.burstPace), [0.8, 1, 1.2, 1.5, 2]);
  let previous = Infinity;
  for (const row of rows) {
    const first = Date.parse(row.creditTimes[0]);
    assert.ok(first <= previous); previous = first;
    assert.ok(row.totalConsumedByLastExpiry > 0);
    assert.ok(Number.isFinite(row.gainAgainstNoCredits));
  }
  close(rows[3].totalConsumedByLastExpiry, 471.14285714285717);
  const publishedTotals = [405.51785714285717, 433.64285714285717, 452.3928571428571, 471.14285714285717, 489.89285714285717];
  rows.forEach((row, index) => close(row.totalConsumedByLastExpiry, publishedTotals[index]));
  // Baseline: 99 + 100 * (600 - 168) / 168 = 356.14285714285717.
  close(rows[3].gainAgainstNoCredits, 115);
});

test('p90 uses the synthetic hourly history including idle hours, excluding resets', () => {
  assert.equal(hourlyBurnP90(syntheticHistory, { now: at(0) }), 1.5);
  assert.equal(hourlyBurnP90([], { now: at(0) }), 0);
});

test('detected reset requires a drop greater than 30 points in the same series', () => {
  const before = { at: at(0), provider: 'codex', window: 'secondary', usedPercent: 80 };
  assert.equal(detectedReset(before, { ...before, at: at(1), usedPercent: 49 }), true);
  assert.equal(detectedReset(before, { ...before, at: at(1), usedPercent: 50 }), false);
  assert.equal(detectedReset(before, { ...before, at: at(1), usedPercent: 90 }), false);
  assert.equal(detectedReset(before, { ...before, at: at(1), provider: 'claude', usedPercent: 0 }), false);
  assert.equal(detectedReset(before, { ...before, at: at(-1), usedPercent: 0 }), false);
});

// This is the hourly simulator from the brief with invented inputs.
function hourlySimulator(input) {
  let time = Date.parse(input.now), used = input.usedPercent;
  let next = Date.parse(input.resetsAt), consumed = 0, idle = 0;
  const credits = input.credits.map((credit) => Date.parse(credit.expires_at));
  const applied = [];
  const end = Date.parse(input.horizon), rate = input.maxBurnRate;
  while (time < end) {
    if (time >= next) { used = 0; next += 168 * HOUR; }
    while (credits.length && credits[0] <= time) credits.shift();
    if (credits.length && (used >= 100 || time + HOUR > credits[0])) {
      used = 0; next = time + 168 * HOUR; credits.shift(); applied.push(time);
    }
    const duration = Math.min(1, (end - time) / HOUR);
    const burn = Math.min(rate * duration, 100 - used);
    used += burn; consumed += burn; idle += duration - burn / rate;
    time += duration * HOUR;
  }
  return { totalConsumed: consumed, idleHours: idle, applied };
}

test('exact exhaustion formula places two credits and the next regular resets', () => {
  const plan = calculateExhaustionPlan(exactInput());
  assert.equal(plan.method, 'exact');
  assert.equal(plan.credits[0].applyAt, at(66));
  assert.equal(plan.credits[1].applyAt, at(66 + 100 / 1.5));
  assert.deepEqual(plan.resets.filter((reset) => reset.kind === 'natural').map((reset) => reset.at), [at(66 + 100 / 1.5 + 168), at(66 + 100 / 1.5 + 336)]);
  close(plan.totalConsumed, 446);
  close(plan.idleHours, 500 - 446 / 1.5);
});

test('exact formula agrees with hourly simulation on aligned events', () => {
  const input = exactInput({ usedPercent: 4, maxBurnRate: 2, horizon: at(504) });
  const exact = calculateExhaustionPlan(input);
  const hourly = hourlySimulator(input);
  close(exact.totalConsumed, hourly.totalConsumed);
  close(exact.idleHours, hourly.idleHours);
  assert.deepEqual(exact.credits.map((credit) => Date.parse(credit.applyAt)), hourly.applied);
});

test('exact formula resolves fractional hours that the hourly simulator rounds', () => {
  const input = exactInput();
  const exact = calculateExhaustionPlan(input);
  const hourly = hourlySimulator(input);
  close(hourly.totalConsumed, 445.5);
  assert.ok(Math.abs(exact.totalConsumed - hourly.totalConsumed) <= input.credits.length * input.maxBurnRate);
  assert.ok(Date.parse(exact.credits[1].applyAt) < hourly.applied[1]);
});

test('no credits gives the natural plan and a zero gain', () => {
  const plan = planQuota(exactInput({ credits: [], horizon: at(500) }));
  close(plan.fast.totalConsumed, 296.6190476190476);
  close(plan.fast.gain, 0);
  assert.deepEqual(plan.fast.windows, plan.fast.baseline.windows);
  assert.deepEqual(plan.fast.credits, []);
});

test('one credit uses the exact threshold time then the natural pace', () => {
  const plan = planQuota(exactInput({ credits: [{ id: 'A', expires_at: at(400) }], horizon: at(300) }));
  assert.equal(plan.fast.credits[0].applyAt, at(94 / 1.5));
  assert.equal(plan.fast.credits[0].bestAt, at(94 / 1.5));
  assert.equal(plan.fast.credits[0].earliestAt, at(94 / 1.5));
  assert.equal(plan.fast.credits[0].latestAt, at(300));
  close(plan.fast.totalConsumed, 235.26984126984127);
});

test('an announced full reset moves the regular reset and restarts the burst', () => {
  const plan = planQuota(exactInput({ burstPace: 1, announcedResets: [{ at: at(20), kind: 'full' }], horizon: at(150), credits: [{ id: 'A', expires_at: at(140) }] }));
  const reset = plan.resets.find((event) => event.kind === 'full');
  assert.equal(reset.nextResetAt, at(188));
  assert.equal(plan.credits[0].applyAt, at(115));
  close(plan.credits[0].usedPercent, 95);
});

test('expiry within 48 hours forces application even below the threshold', () => {
  const input = exactInput({ usedPercent: 10, maxBurnRate: 1, horizon: at(200), credits: [{ id: 'A', expires_at: at(24.5) }] });
  const plan = planQuota(input);
  assert.equal(plan.fast.credits[0].applyAt, at(24.5));
  assert.equal(plan.fast.credits[0].reason, 'expiry');
  close(plan.fast.credits[0].usedPercent, 34.5);
  assert.equal(plan.slow.credits[0].applyAt, at(24.5));
});

test('two credits obey the threshold and give a lower gain with slow bursts', () => {
  const plan = planQuota(exactInput({ horizon: at(600) }));
  assert.equal(plan.credits.length, 2);
  for (const credit of plan.credits) {
    close(credit.usedPercent, 95);
    assert.ok(Date.parse(credit.applyAt) <= Date.parse(credit.expiresAt));
    assert.ok(Date.parse(credit.earliestAt) <= Date.parse(credit.bestAt));
    assert.ok(Date.parse(credit.bestAt) <= Date.parse(credit.latestAt));
  }
  assert.ok(plan.slow.gain < plan.fast.gain);
  const custom = planQuota(exactInput({ burstPace: 1, applyThreshold: 90, margin: 0 }));
  assert.equal(custom.credits[0].applyAt, at(89));
  const margin = planQuota(exactInput({ burstPace: 1, margin: 10 }));
  assert.equal(margin.applyThreshold, 90);
  assert.equal(margin.credits[0].applyAt, at(89));
});

test('partial refund changes usage without moving the regular reset', () => {
  const plan = planQuota(exactInput({ usedPercent: 50, burstPace: 1, horizon: at(250), credits: [{ id: 'A', expires_at: at(200) }],
    announcedResets: [{ at: at(10), kind: 'partial', refundPercent: 20 }] }));
  assert.equal(plan.credits[0].applyAt, at(65));
  assert.equal(plan.resets.find((reset) => reset.kind === 'partial').nextResetAt, at(168));
  close(plannedUsageAt(plan, at(10)), 40);
  close(plannedUsageAt(plan, at(30)), 60);
});

test('whatIf adds the hypothetical reset without changing the inputs', () => {
  const reset = { at: at(20), kind: 'full' };
  const input = exactInput({ burstPace: 1, horizon: at(150), credits: [{ id: 'A', expires_at: at(140) }], whatIf: reset });
  const saved = structuredClone(input);
  const plan = planQuota(input);
  const announced = planQuota({ ...input, whatIf: undefined, announcedResets: [reset] });
  assert.deepEqual(plan, announced);
  assert.deepEqual(input, saved);
  assert.notEqual(plan.credits[0].applyAt, planQuota({ ...input, whatIf: undefined }).credits[0].applyAt);
});

test('hold time uses the search and waits on the threshold plateau', () => {
  const plan = planQuota(exactInput({ burstPace: 1, horizon: at(150), credits: [{ id: 'A', expires_at: at(140), notBefore: at(120) }] }));
  assert.equal(plan.method, 'search');
  assert.equal(plan.credits[0].applyAt, at(120));
  close(plannedUsageAt(plan, at(110)), 95);
  close(plan.idleHours, 26);
});

test('two-credit search over 30 days is deterministic and takes less than 500 ms', (t) => {
  const input = exactInput({ burstPace: 1.2, horizon: at(720), announcedResets: [{ at: at(20), kind: 'full' }],
    credits: [{ id: 'A', expires_at: at(400) }, { id: 'B', expires_at: at(720) }] });
  const saved = structuredClone(input);
  const started = performance.now();
  const plan = planQuota(input);
  const duration = performance.now() - started;
  t.diagnostic(`two-credit 30-day search: ${duration.toFixed(3)} ms`);
  assert.ok(duration < 500, `search took ${duration.toFixed(1)} ms`);
  assert.deepEqual(plan, planQuota(input));
  assert.deepEqual(input, saved);
  assert.equal(plan.method, 'search');
  assert.equal(plan.credits.filter((credit) => credit.applyAt).length, 2);
});

test('p90 weights subhour readings by hour and rejects a mixed series', () => {
  const rows = Array.from({ length: 11 }, (_, hour) => ({ at: at(hour - 10), provider: 'codex', window: 'secondary', usedPercent: hour <= 9 ? hour : 19 }));
  for (let minute = 1; minute < 60; minute++) rows.push({ ...rows[0], at: at(-10 + minute / 60), usedPercent: minute / 60 });
  rows.push({ ...rows[0], at: at(-400), usedPercent: 0 }, { ...rows[0], at: at(-399), usedPercent: 100 }, { ...rows[0], at: at(1), usedPercent: 100 });
  assert.equal(hourlyBurnP90(rows, { now: at(0) }), 1);
  assert.throws(() => hourlyBurnP90([...rows, { ...rows[0], provider: 'claude' }], { now: at(0) }), /Select one provider/);
  assert.equal(hourlyBurnP90([...rows, { ...rows[0], provider: 'claude' }], { now: at(0), provider: 'codex', window: 'secondary' }), 1);
});

test('target pace caps the final natural phase and defaults the horizon to last expiry', () => {
  const plan = planQuota(exactInput({ horizon: at(200), targetPace: 0.3, credits: [{ id: 'A', expires_at: at(80) }] }));
  assert.equal(planQuota(exactInput({ horizon: undefined })).horizon, at(600));
  assert.equal(plan.method, 'search');
  const applied = plan.credits[0].applyAt;
  close(plannedUsageAt(plan, Date.parse(applied) + 10 * HOUR), 3, 0.000001);
});

test('expiry at the horizon still applies a credit below the threshold', () => {
  const plan = planQuota(exactInput({ usedPercent: 0, burstPace: 0.1, horizon: at(10), credits: [{ id: 'A', expires_at: at(10) }] }));
  assert.equal(plan.credits[0].applyAt, at(10));
  assert.equal(plan.credits[0].reason, 'expiry');
  close(plan.credits[0].usedPercent, 1);
});

test('all resets at the same time precede a credit at its expiry', () => {
  const plan = planQuota(exactInput({ usedPercent: 80, burstPace: 1, horizon: at(30), credits: [{ id: 'A', expires_at: at(10) }],
    announcedResets: [{ at: at(10), kind: 'partial', refundPercent: 20 }, { at: at(10), kind: 'partial', refundPercent: 30 }] }));
  close(plan.credits[0].usedPercent, 40);
  assert.deepEqual(plan.resets.slice(0, 3).map((event) => event.kind), ['partial', 'partial', 'credit']);
  close(plannedUsageAt(plan, at(10)), 0);
});

test('planner rejects invalid values and filters unavailable and expired credits', () => {
  assert.throws(() => planQuota(exactInput({ usedPercent: 101 })), /usedPercent/);
  assert.throws(() => planQuota(exactInput({ burstPace: NaN })), /burstPace/);
  assert.throws(() => planQuota(exactInput({ resetsAt: at(-1) })), /resetsAt/);
  assert.throws(() => planQuota(exactInput({ announcedResets: [{ at: at(1), kind: 'other' }] })), /Reset kind/);
  const plan = planQuota(exactInput({ credits: [{ id: 'past', expires_at: at(-1) }, { id: 'used', status: 'used', expires_at: at(100) }] }));
  assert.deepEqual(plan.credits, []);
  assert.equal(plan.burstPace, 1.5);
  assert.equal(planQuota({ ...exactInput(), maxBurnRate: undefined }).burstPace, 1);
});

test('refined two-credit plan meets an independent exhaustive hourly oracle', () => {
  // A short window keeps the independent exhaustive check small.
  const input = exactInput({ usedPercent: 10, burstPace: 3, windowHours: 24, resetsAt: at(24),
    applyThreshold: 50, margin: 50, horizon: at(48), announcedResets: [{ at: at(6), kind: 'full' }],
    credits: [{ id: 'A', expires_at: at(18) }, { id: 'B', expires_at: at(36) }] });
  let best = -Infinity;
  for (let first = 0; first <= 18; first++) {
    for (let second = first; second <= 36; second++) {
      let used = 10, nextReset = 24, consumed = 0, applied = 0, valid = true;
      for (let hour = 0; hour < 48; hour++) {
        if (hour === nextReset) { used = 0; nextReset += 24; }
        if (hour === 6) { used = 0; nextReset = hour + 24; }
        for (const [index, application, expiry] of [[0, first, 18], [1, second, 36]]) {
          if (hour !== application) continue;
          if (used < 50 && hour !== expiry) { valid = false; break; }
          used = 0; nextReset = hour + 24; applied = index + 1;
        }
        if (!valid) break;
        const burn = Math.min((applied === 2 ? 100 : 50) - used, applied === 2 ? 100 / 24 : 3);
        used += burn; consumed += burn;
      }
      if (valid) best = Math.max(best, consumed);
    }
  }
  const plan = planQuota(input);
  assert.ok(plan.totalConsumed >= best - 1e-7);
  // 18 before the gift, 36 before A, 50 before B, then 55 5/9.
  close(plan.totalConsumed, 159.55555555555554);
  assert.equal(plan.credits[0].applyAt, at(18));
  assert.equal(plan.credits[1].applyAt, at(34 + 2 / 3));
});

test('latest credit bound includes the instant before an announced reset', () => {
  const plan = planQuota(exactInput({ usedPercent: 90, burstPace: 1, horizon: at(30), credits: [{ id: 'A', expires_at: at(100) }],
    announcedResets: [{ at: at(20), kind: 'full' }] }));
  assert.equal(plan.credits[0].earliestAt, at(5));
  assert.equal(plan.credits[0].latestAt, new Date(NOW + 20 * HOUR - 1).toISOString());
});

test('optional shortcut keeps the better natural baseline near a regular reset', () => {
  const input = exactInput({ usedPercent: 95, resetsAt: at(1), horizon: at(1), credits: [{ id: 'A', expires_at: at(200) }] });
  const plan = planQuota(input);
  close(plan.totalConsumed, 5);
  close(plan.gain, 0);
  assert.equal(plan.credits[0].applyAt, null);
  assert.deepEqual(plan.curve, plan.baseline.curve);
});

test('equal-consumption schedules prefer the later credit application', () => {
  const plan = planQuota(exactInput({ burstPace: 1, horizon: at(150), targetPace: 0,
    credits: [{ id: 'A', expires_at: at(120) }] }));
  close(plan.totalConsumed, 94);
  assert.equal(plan.credits[0].applyAt, at(120));
});

test('generated credit ids keep their input positions after a status change', () => {
  const credits = [{ expires_at: at(400) }, { expires_at: at(600) }, { id: 'caller-credit', expires_at: at(650) }];
  const input = exactInput({ credits, horizon: at(100) });
  const before = planQuota(input);
  const after = planQuota({ ...input, credits: [{ ...credits[0], status: 'used' }, credits[1], credits[2]] });
  assert.deepEqual(before.credits.map((credit) => credit.id), ['credit-1', 'credit-2', 'caller-credit']);
  assert.deepEqual(after.credits.map((credit) => credit.id), ['credit-2', 'caller-credit']);
  assert.equal(after.credits[0].id, before.credits[1].id);
  const inactive = planQuota({ ...input, credits: [{ status: 'used' }, { expires_at: at(600) }] });
  assert.equal(inactive.credits[0].id, 'credit-2');
});

test('search includes a brief threshold interval before a fractional regular reset', () => {
  const plan = planQuota(exactInput({ usedPercent: 94.98, burstPace: 0.1, resetsAt: at(0.75), horizon: at(100), targetPace: 1,
    credits: [{ id: 'A', expires_at: at(3.5) }] }));
  assert.ok(plan.totalConsumed >= 59.42, `only consumed ${plan.totalConsumed}`);
  close(plan.totalConsumed, 59.4247619047619);
  assert.equal(plan.credits[0].applyAt, at(0.2));
});

for (const count of [3, 4]) {
  test(`${count}-credit 60-day search remains deterministic and takes less than 1000 ms`, (t) => {
    const input = exactInput({ burstPace: 1.2, horizon: at(1440), announcedResets: [{ at: at(20), kind: 'full' }],
      credits: Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index + 1}`, expires_at: at(1440) })) });
    const saved = structuredClone(input);
    const started = performance.now();
    const plan = planQuota(input);
    const duration = performance.now() - started;
    t.diagnostic(`${count}-credit 60-day search: ${duration.toFixed(3)} ms`);
    assert.ok(duration < 1000, `search took ${duration.toFixed(1)} ms`);
    assert.deepEqual(plan, planQuota(input));
    assert.deepEqual(input, saved);
    assert.equal(plan.credits.filter((credit) => credit.applyAt).length, count);
  });
}

test('reset-adjacent pace scenarios compare searched totals with their shortcuts', () => {
  const plan = planQuota(exactInput({ usedPercent: 94, burstPace: 2, slowBurnRate: 1, resetsAt: at(1), horizon: at(200),
    credits: [{ id: 'sample-credit', expires_at: at(200) }] }));
  close(plan.slow.totalConsumed, 157.90476190476193);
  close(plan.fast.totalConsumed, 186.17857142857144);
  assert.equal(plan.slow.credits[0].applyAt, at(96));
  assert.equal(plan.fast.credits[0].applyAt, at(48.5));
  // The first-threshold candidate at pace 2 consumes only 119.75 points.
  assert.ok(plan.fast.totalConsumed > 119.75);
});
