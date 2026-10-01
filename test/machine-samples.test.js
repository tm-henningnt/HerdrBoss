import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLockLedger } from '../src/kit/locks.js';
import {
  appendMachineSample, readMachineSamples, sampleLine, summarizeHours,
  MACHINE_SAMPLES_FILE, MACHINE_SAMPLES_ROTATED_FILE,
} from '../src/machine-samples.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-machine-samples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const machine = { load: [2.4, 3.1, 2.8], cpus: 10, cpuTotalSample: 412, memFreePercent: 18, memTotalGB: 24, swapUsedMB: 3200, swapTotalMB: 4096 };

test('sampleLine has the planned keys, the whole minute, and kinds and counts only', () => {
  const line = sampleLine({
    machine,
    holders: [{ kind: 'suite', project: 'secret-client', ownerPane: 'w:p1' }],
    waiters: [{ kind: 'push', pane: 'w:p2', cwd: '/private/path' }, { kind: 'suite' }],
    now: Date.parse('2026-09-29T14:03:27.500Z'),
  });
  assert.deepEqual(line, {
    at: '2026-09-29T14:03:00.000Z', l1: 2.4, l5: 3.1, l15: 2.8, cpus: 10, cpu: 41.2,
    memFree: 18, memGB: 24, swapMB: 3200, swapTotalMB: 4096,
    holders: ['suite'], waiters: 2, waiterKinds: ['push', 'suite'],
  });
  assert.doesNotMatch(JSON.stringify(line), /secret-client|w:p|private/);
});

test('sampleLine writes null for a field that the collector cannot read', () => {
  const line = sampleLine({ machine: { cpus: 8, load: [1, 2, 3], memFreePercent: null, swapUsedMB: null, swapTotalMB: null }, now: 0 });
  assert.equal(line.memFree, null);
  assert.equal(line.swapMB, null);
  assert.equal(line.swapTotalMB, null);
  assert.equal(line.cpu, null);
  assert.equal(line.memGB, null);
  assert.deepEqual(line.holders, []);
  assert.equal(line.waiters, 0);
});

test('appendMachineSample appends one line with mode 0600 and readMachineSamples reads it back', (t) => {
  const dataDir = tmp(t);
  assert.equal(appendMachineSample(sampleLine({ machine, now: Date.parse('2026-09-29T14:03:00Z') }), { dataDir }), true);
  assert.equal(appendMachineSample(sampleLine({ machine, now: Date.parse('2026-09-29T14:04:00Z') }), { dataDir }), true);
  const file = path.join(dataDir, MACHINE_SAMPLES_FILE);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const all = readMachineSamples({ dataDir });
  assert.deepEqual(all.map((line) => line.at), ['2026-09-29T14:03:00.000Z', '2026-09-29T14:04:00.000Z']);
  assert.equal(readMachineSamples({ dataDir, sinceMs: Date.parse('2026-09-29T14:04:00Z') }).length, 1);
});

test('appendMachineSample rotates above the size limit and replaces an older rotated file', (t) => {
  const dataDir = tmp(t);
  const rotated = path.join(dataDir, MACHINE_SAMPLES_ROTATED_FILE);
  fs.writeFileSync(rotated, '{"at":"2020-01-01T00:00:00.000Z"}\n');
  fs.writeFileSync(path.join(dataDir, MACHINE_SAMPLES_FILE), `${'x'.repeat(200)}\n`);
  appendMachineSample(sampleLine({ machine, now: Date.parse('2026-09-29T14:03:00Z') }), { dataDir, maxBytes: 100 });
  assert.match(fs.readFileSync(rotated, 'utf8'), /^x{200}\n$/);
  const current = fs.readFileSync(path.join(dataDir, MACHINE_SAMPLES_FILE), 'utf8');
  assert.equal(current.split('\n').filter(Boolean).length, 1);
  assert.match(current, /2026-09-29T14:03:00/);
});

test('appendMachineSample does not rotate below the size limit', (t) => {
  const dataDir = tmp(t);
  appendMachineSample(sampleLine({ machine, now: 0 }), { dataDir });
  appendMachineSample(sampleLine({ machine, now: 60000 }), { dataDir });
  assert.equal(fs.existsSync(path.join(dataDir, MACHINE_SAMPLES_ROTATED_FILE)), false);
});

test('appendMachineSample swallows a write error', (t) => {
  const dataDir = tmp(t);
  fs.mkdirSync(path.join(dataDir, MACHINE_SAMPLES_FILE));
  assert.doesNotThrow(() => assert.equal(appendMachineSample(sampleLine({ machine, now: 0 }), { dataDir }), false));
  const blocker = path.join(dataDir, 'file');
  fs.writeFileSync(blocker, '');
  assert.doesNotThrow(() => assert.equal(appendMachineSample(sampleLine({ machine, now: 0 }), { dataDir: path.join(blocker, 'sub') }), false));
});

test('readMachineSamples skips a broken line, a line without a valid time, and a missing file', (t) => {
  const dataDir = tmp(t);
  assert.deepEqual(readMachineSamples({ dataDir }), []);
  fs.writeFileSync(path.join(dataDir, MACHINE_SAMPLES_FILE), [
    '{"at":"2026-09-29T14:03:00.000Z","l1":1}', 'not json', '{"l1":2}', '{"at":"nope"}', 'null', '{"at":"2026-09-29T14:04:00.000Z"}', '',
  ].join('\n'));
  assert.equal(readMachineSamples({ dataDir }).length, 2);
});

// Fixture times use local-time constructors, because the summary groups by the local hour.
const local = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 29, 23, 30).getTime();
const base = { l1: 1, l5: 1, l15: 1, cpus: 10, cpu: 20, memFree: 40, memGB: 24, swapMB: 100, swapTotalMB: 4096, holders: [], waiters: 0, waiterKinds: [] };
const sample = (at, extra = {}) => ({ ...base, at, ...extra });

test('summarizeHours counts overload minutes, idle-wait minutes, coverage, and holder kinds by local hour', () => {
  const samples = [
    sample(local(28, 14, 0), { swapMB: 3900 }),
    sample(local(28, 14, 1), { swapMB: 3900, holders: ['suite'] }),
    sample(local(28, 14, 2), { l5: 31 }),
    sample(local(29, 14, 0), { waiters: 2, cpu: 10, waiterKinds: ['push', 'suite'], holders: ['push'] }),
    sample(local(29, 14, 1), { waiters: 1, cpu: 80 }),
    sample(local(29, 3, 0), { swapMB: 1000, swapTotalMB: 1024 }),
    sample(local(29, 3, 1), { swapMB: 3900, swapTotalMB: 4096, memFree: 5 }),
  ];
  const summary = summarizeHours({ samples, days: 14, now: NOW });
  assert.equal(summary.days, 14);
  assert.equal(summary.daysWithData, 2);
  assert.equal(summary.hours.length, 24);
  assert.deepEqual(summary.hours.map((h) => h.hour), [...Array(24).keys()]);
  assert.deepEqual(summary.hours[14], {
    hour: 14, samples: 5, overloadMin: 3, idleWaitMin: 1, swapPeakPct: 95, memFreeMin: 40,
    holderKinds: { suite: 1, push: 1 },
  });
  // 1000 of 1024 MB is above 90 percent, but below the 1 GB floor.
  assert.equal(summary.hours[3].overloadMin, 1);
  assert.equal(summary.hours[3].memFreeMin, 5);
  assert.equal(summary.hours[0].samples, 0);
  assert.equal(summary.hours[0].swapPeakPct, null);
  assert.equal(summary.hours[0].memFreeMin, null);
  assert.deepEqual(summary.totals, { samples: 7, overloadMin: 4, idleWaitMin: 1 });
  assert.equal(summary.coverage, +(7 / (14 * 1440)).toFixed(3));
});

test('summarizeHours does not flag a null field, a zero swap total, or a waiter at high CPU', () => {
  const samples = [
    sample(local(29, 9, 0), { swapMB: null, swapTotalMB: null, l5: null, cpu: null, waiters: 1 }),
    sample(local(29, 9, 1), { swapMB: 2000, swapTotalMB: 0 }),
    sample(local(29, 9, 2), { l5: 30, cpu: 5, waiters: 0 }),
    sample(local(29, 9, 3), { l5: 30.1 }),
  ];
  const hour = summarizeHours({ samples, now: NOW }).hours[9];
  assert.equal(hour.samples, 4);
  assert.equal(hour.overloadMin, 1);
  assert.equal(hour.idleWaitMin, 0);
});

test('summarizeHours drops lines older than the window and limits days to 1 through 14', () => {
  const samples = [sample(local(29, 10)), sample(local(27, 10)), sample(local(16, 10)), sample(local(10, 10))];
  assert.equal(summarizeHours({ samples, days: 1, now: NOW }).totals.samples, 1);
  assert.equal(summarizeHours({ samples, days: 3, now: NOW }).totals.samples, 2);
  assert.equal(summarizeHours({ samples, days: 30, now: NOW }).days, 14);
  assert.equal(summarizeHours({ samples, days: 14, now: NOW }).totals.samples, 3);
  for (const bad of [0, -2, 'abc', null, undefined, NaN]) {
    assert.equal(summarizeHours({ samples, days: bad, now: NOW }).days, 14, `days ${bad}`);
  }
  assert.equal(summarizeHours({ samples, days: '3', now: NOW }).days, 3);
  assert.equal(summarizeHours({ samples, days: 2.9, now: NOW }).days, 2);
});

test('summarizeHours on no samples returns 24 empty hours and zero coverage', () => {
  const summary = summarizeHours({ samples: [], days: 7, now: NOW });
  assert.equal(summary.daysWithData, 0);
  assert.equal(summary.coverage, 0);
  assert.deepEqual(summary.totals, { samples: 0, overloadMin: 0, idleWaitMin: 0 });
  assert.equal(summary.hours.length, 24);
  assert.ok(summary.hours.every((h) => h.samples === 0 && h.overloadMin === 0 && h.idleWaitMin === 0));
});

test('summarizeHours reads an empty file and skips broken lines through readMachineSamples', (t) => {
  const dataDir = tmp(t);
  assert.equal(summarizeHours({ dataDir, now: NOW }).totals.samples, 0);
  fs.writeFileSync(path.join(dataDir, MACHINE_SAMPLES_FILE), '');
  assert.equal(summarizeHours({ dataDir, now: NOW }).totals.samples, 0);
  fs.writeFileSync(path.join(dataDir, MACHINE_SAMPLES_FILE), `not json\n${JSON.stringify(sample(local(29, 8)))}\n{"at":"bad"}\n{"l1":1}\n`);
  const summary = summarizeHours({ dataDir, now: NOW });
  assert.equal(summary.totals.samples, 1);
  assert.equal(summary.hours[8].samples, 1);
});

test('the summary holds no project name, pane id, or path', () => {
  const line = sampleLine({ machine, holders: [{ kind: 'suite', project: 'secret-client', ownerPane: 'w:p1', cwd: '/private/path' }], now: NOW });
  const text = JSON.stringify(summarizeHours({ samples: [line], now: NOW }));
  assert.doesNotMatch(text, /secret-client|w:p|private/);
});

test('waited minutes in the lock ledger stay within the sample minutes with waiters plus 15 percent', (t) => {
  const dataDir = tmp(t);
  // Two suites wait: 3 and 2 minutes. The sample file has waiters in 6 minutes.
  const ledger = [
    { at: local(29, 14, 4), event: 'acquire', name: 'full-suite', kind: 'suite', waitMs: 3 * 60000 },
    { at: local(29, 14, 4, 30), event: 'release', name: 'full-suite', kind: 'suite', holdMs: 90000 },
    { at: local(29, 15, 2), event: 'acquire', name: 'full-suite', kind: 'push', waitMs: 2 * 60000 },
    { at: local(29, 15, 3), event: 'acquire', name: 'other', kind: 'push', waitMs: 9 * 60000 },
  ];
  fs.writeFileSync(path.join(dataDir, 'lock-ledger.jsonl'), `${ledger.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const minutes = [[14, 1], [14, 2], [14, 3], [15, 0], [15, 1], [14, 0]];
  for (const [hour, minute] of minutes) {
    appendMachineSample(sample(local(29, hour, minute), { waiters: 1, waiterKinds: ['suite'] }), { dataDir });
  }
  const summary = summarizeHours({ dataDir, now: NOW });
  const sinceMs = NOW - 14 * 86400000;
  const waitedMin = readLockLedger({ dataDir, sinceMs })
    .filter((line) => line.event === 'acquire' && line.name === 'full-suite')
    .reduce((sum, line) => sum + line.waitMs, 0) / 60000;
  const sampledWaitMin = readMachineSamples({ dataDir, sinceMs }).filter((line) => line.waiters > 0).length;
  assert.equal(sampledWaitMin, 6);
  assert.ok(waitedMin <= sampledWaitMin * 1.15, `${waitedMin} waited minutes against ${sampledWaitMin} sampled`);
  assert.equal(summary.totals.samples, 6);
});

test('summarizeHours counts a duplicate minute once', () => {
  const now = Date.parse('2026-09-29T15:00:00.000Z');
  const line = { at: '2026-09-29T14:03:00.000Z', l5: 40, cpus: 10, cpu: 10, waiters: 1, swapMB: 0, swapTotalMB: 0 };
  const other = { ...line, at: '2026-09-29T14:04:00.000Z' };
  const summary = summarizeHours({ samples: [line, { ...line }, other, { ...line }], now, days: 1 });
  assert.equal(summary.totals.samples, 2);
  assert.equal(summary.totals.overloadMin, 2);
  assert.equal(summary.totals.idleWaitMin, 2);
  assert.equal(summary.coverage, +(2 / 1440).toFixed(3));
});
