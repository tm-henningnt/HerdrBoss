import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendMachineSample, readMachineSamples, sampleLine,
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
