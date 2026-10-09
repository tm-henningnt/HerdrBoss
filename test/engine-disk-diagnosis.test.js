import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const LOW_FREE = { bsize: 1, bavail: 4 * 1024 ** 3 };

function engineWith(overrides) {
  const cfg = loadConfig();
  cfg.push = false;
  return new Engine(cfg, { push: false, act: false, ...overrides });
}

test('a disk scan failure is logged and does not break the engine', () => {
  const engine = engineWith({
    diskFreeSpaceReader: () => LOW_FREE,
    diskScan: () => { throw new Error('injected scan failure'); },
    diskDiagnosisWrite: () => {},
  });

  assert.doesNotThrow(() => engine.checkLowDiskDiagnosis(Date.parse('2026-10-09T10:00:00.000Z')));
  assert.equal(engine.diskScanAt, null, 'a failed scan does not advance the scan time');
  const logged = engine.events.find((event) => event.type === 'disk-diagnosis');
  assert.ok(logged, 'the engine logs the failed scan');
  assert.match(logged.text, /injected scan failure/);
});

test('the engine keeps the last scan time in memory and scans an hour later', () => {
  const start = Date.parse('2026-10-09T10:00:00.000Z');
  let scans = 0;
  const engine = engineWith({
    diskFreeSpaceReader: () => LOW_FREE,
    diskScan: () => {
      scans += 1;
      return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true };
    },
    diskDiagnosisWrite: () => {},
  });

  engine.checkLowDiskDiagnosis(start);
  assert.equal(scans, 1);
  assert.equal(engine.diskScanAt, start);
  engine.checkLowDiskDiagnosis(start + 30 * 60 * 1000);
  assert.equal(scans, 1);
  engine.checkLowDiskDiagnosis(start + 61 * 60 * 1000);
  assert.equal(scans, 2);
});

test('the engine does not scan when both volumes meet the floor', () => {
  let scans = 0;
  const engine = engineWith({
    diskFreeSpaceReader: () => ({ bsize: 1, bavail: 12 * 1024 ** 3 }),
    diskScan: () => { scans += 1; return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }; },
    diskDiagnosisWrite: () => {},
  });

  engine.checkLowDiskDiagnosis(Date.parse('2026-10-09T10:00:00.000Z'));
  assert.equal(scans, 0);
  assert.equal(engine.diskScanAt, null);
});
