import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DISK_DIAGNOSIS_FILE, clearDiskDiagnosisBulletin, readDiskDiagnosis, runLowDiskDiagnosis, scanDiskUsage, writeDiskDiagnosis } from '../src/disk-diagnosis.js';

test('disk diagnosis reports the five largest listed directories and newest large temp directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const tempRoot = path.join(root, 'temp');
  const dataDir = path.join(root, 'data');
  const cacheRoot = path.join(home, 'Library', 'Caches');
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(path.join(home, 'unlisted'), { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  for (let size = 1; size <= 6; size += 1) {
    const dir = path.join(cacheRoot, `cache-${size}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'payload.dat'), Buffer.alloc(size * 1024 * 1024));
  }
  const tempDirs = [];
  for (let index = 1; index <= 3; index += 1) {
    const dir = path.join(tempRoot, `temp-${index}`);
    fs.mkdirSync(dir);
    const payload = path.join(dir, 'payload.dat');
    fs.writeFileSync(payload, '');
    fs.truncateSync(payload, 50 * 1024 * 1024 + index * 1024 * 1024);
    const mtime = new Date(1_700_000_000_000 + index * 60_000);
    fs.utimesSync(dir, mtime, mtime);
    tempDirs.push(dir);
  }
  fs.mkdirSync(path.join(home, 'unlisted', 'hidden-large'));
  const hiddenPayload = path.join(home, 'unlisted', 'hidden-large', 'payload.dat');
  fs.writeFileSync(hiddenPayload, '');
  fs.truncateSync(hiddenPayload, 100 * 1024 * 1024);

  const result = scanDiskUsage({ home, tempRoot, dataDir, timeLimitMs: 2500 });

  assert.equal(result.largestDiskUsers.length, 5);
  assert.ok(result.largestDiskUsers.some((item) => item.path === path.join(cacheRoot, 'cache-6')));
  assert.ok(result.largestDiskUsers.every((item) => !item.path.includes('unlisted')));
  assert.deepEqual(result.newestLargeTempDirectories.map((item) => item.path), tempDirs.toReversed());
  for (const item of [...result.largestDiskUsers, ...result.newestLargeTempDirectories]) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sizeBytes']);
    assert.equal(path.isAbsolute(item.path), true);
  }
});

test('disk diagnosis writes only directory paths and sizes to the data file and bulletin', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-record-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const diagnosis = {
    largestDiskUsers: [{ path: '/fixture/Projects/sample-project', sizeBytes: 2 * 1024 ** 2 }],
    newestLargeTempDirectories: [{ path: '/fixture/tmp/new-temp', sizeBytes: 60 * 1024 ** 2 }],
    scanComplete: true,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dataDir, 'bulletin.md'), '# Bulletin\n');
  fs.writeFileSync(path.join(dataDir, 'private-file-name.txt'), 'private contents');

  writeDiskDiagnosis(diagnosis, { dataDir });

  const bulletin = fs.readFileSync(path.join(dataDir, 'bulletin.md'), 'utf8');
  assert.match(bulletin, /Five largest disk users/);
  assert.match(bulletin, /sample-project/);
  assert.match(bulletin, /2\.0 MiB/);
  assert.doesNotMatch(bulletin, /private-file-name|private contents/);
  assert.deepEqual(readDiskDiagnosis(dataDir), diagnosis);
});

test('disk diagnosis keeps the five newest large temporary directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-newest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const tempRoot = path.join(root, 'temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDirs = [];
  for (let index = 1; index <= 6; index += 1) {
    const dir = path.join(tempRoot, `temp-${index}`);
    fs.mkdirSync(dir);
    const payload = path.join(dir, 'payload.dat');
    fs.writeFileSync(payload, '');
    fs.truncateSync(payload, 51 * 1024 * 1024);
    const mtime = new Date(1_700_000_000_000 + index * 60_000);
    fs.utimesSync(dir, mtime, mtime);
    tempDirs.push(dir);
  }

  const result = scanDiskUsage({ home, tempRoot, dataDir: path.join(root, 'data') });

  assert.deepEqual(result.newestLargeTempDirectories.map((item) => item.path), tempDirs.slice(1).toReversed());
  assert.equal(result.newestLargeTempDirectories.length, 5);
});

test('disk diagnosis gives each root a time slice and scans later roots after one root runs out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const tempRoot = path.join(root, 'temp');
  const dataDir = path.join(root, 'data');
  const cacheRoot = path.join(home, 'Library', 'Caches');
  const laterRoot = path.join(home, 'Library', 'Application Support');
  const cacheChild = path.join(cacheRoot, 'slow-cache');
  for (const directory of [tempRoot, cacheChild, laterRoot, path.join(home, '.local', 'share'), path.join(home, 'Projects'), dataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [path.join(tempRoot, 'tmp-child'), path.join(cacheChild, 'nested'), path.join(laterRoot, 'support-child')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const rootsRead = [];
  const pathsStatted = [];
  let clockMs = Date.parse('2026-10-08T10:00:00.000Z');
  const fsApi = {
    lstatSync: (file) => { pathsStatted.push(path.resolve(file)); return fs.lstatSync(file); },
    readdirSync: (directory, options) => {
      rootsRead.push(path.resolve(directory));
      if (path.resolve(directory) === path.resolve(cacheRoot)) clockMs += 11;
      return fs.readdirSync(directory, options);
    },
  };

  const result = scanDiskUsage({
    home, tempRoot, dataDir, timeLimitMs: 60, fsApi, clock: () => clockMs,
  });

  assert.equal(rootsRead[0], path.resolve(tempRoot));
  assert.equal(result.scanComplete, false);
  assert.ok(rootsRead.includes(path.resolve(laterRoot)), 'a slow cache root must not starve the next root');
  assert.ok(!pathsStatted.includes(path.resolve(cacheChild)), 'the cache root stops when its own slice ends');
});

test('disk diagnosis has a timestamp and hides when both volumes recover or the record expires', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-expiry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const recordedAt = '2026-10-08T10:00:00.000Z';
  const diagnosis = {
    largestDiskUsers: [{ path: '/fixture/cache', sizeBytes: 10 }],
    newestLargeTempDirectories: [],
    scanComplete: true,
    recordedAt,
    minFreeGb: 8,
    volumePaths: { worktree: '/fixture/worktrees', dataDir: '/fixture/data' },
  };
  writeDiskDiagnosis(diagnosis, { dataDir });
  const now = Date.parse(recordedAt) + 60 * 60 * 1000;
  const low = (file) => ({ bsize: 1, bavail: file === '/fixture/data' ? 4 * 1024 ** 3 : 12 * 1024 ** 3 });
  const recovered = () => ({ bsize: 1, bavail: 12 * 1024 ** 3 });

  assert.equal(readDiskDiagnosis(dataDir, { now, minFreeGb: 8, freeSpaceReader: low }).recordedAt, recordedAt);
  assert.equal(readDiskDiagnosis(dataDir, { now, minFreeGb: 8, freeSpaceReader: recovered }), null);
  assert.equal(readDiskDiagnosis(dataDir, { now: now + 7 * 60 * 60 * 1000, minFreeGb: 8, freeSpaceReader: low }), null);
});

test('clearing a recovered diagnosis removes only its bulletin section', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-disk-diagnosis-clear-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'bulletin.md'), '# Bulletin\n\n## Quotas\n\nCurrent quotas.\n');
  writeDiskDiagnosis({
    largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true,
    recordedAt: new Date().toISOString(),
  }, { dataDir });

  assert.equal(clearDiskDiagnosisBulletin({ dataDir }), true);
  const bulletin = fs.readFileSync(path.join(dataDir, 'bulletin.md'), 'utf8');
  assert.doesNotMatch(bulletin, /disk guard diagnosis/i);
  assert.match(bulletin, /## Quotas/);
  assert.match(bulletin, /Current quotas/);
});

const LOW_DATA = { bsize: 1, bavail: 4 * 1024 ** 3 };
const HIGH_WORKTREE = { bsize: 1, bavail: 12 * 1024 ** 3 };
const scanBelowDataFloor = (file) => (file === '/fixture/data' ? LOW_DATA : HIGH_WORKTREE);

function lowDiskFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-low-disk-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('the engine scan runs once when a volume first falls under the floor', (t) => {
  const dataDir = lowDiskFixture(t);
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const audits = [];
  let scans = 0;
  const result = runLowDiskDiagnosis({
    now,
    lastScanAt: null,
    dataDir,
    worktreePath: '/fixture/worktrees',
    dataDirPath: '/fixture/data',
    minFreeGb: 8,
    freeSpaceReader: scanBelowDataFloor,
    scan: () => {
      scans += 1;
      return { largestDiskUsers: [{ path: '/fixture/cache', sizeBytes: 2048 }], newestLargeTempDirectories: [], scanComplete: true };
    },
    audit: (row) => audits.push(row),
  });

  assert.equal(result.scanned, true);
  assert.equal(result.lastScanAt, now);
  assert.equal(scans, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].refusalKind, 'disk-low-scan');
  assert.equal(audits[0].workerName, null);
  assert.equal(audits[0].project, null);
  const list = JSON.parse(fs.readFileSync(path.join(dataDir, DISK_DIAGNOSIS_FILE), 'utf8'));
  assert.equal(list.length, 1);
  assert.equal(list[0].worktreeFreeBytes, 12 * 1024 ** 3);
  assert.equal(list[0].dataDirFreeBytes, 4 * 1024 ** 3);
  assert.equal(list[0].minFreeGb, 8);
  assert.equal(list[0].recordedAt, new Date(now).toISOString());
});

test('the engine does not scan a second time within one hour', (t) => {
  const dataDir = lowDiskFixture(t);
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  let scans = 0;
  const lastScanAt = now - 30 * 60 * 1000;
  const result = runLowDiskDiagnosis({
    now,
    lastScanAt,
    dataDir,
    worktreePath: '/fixture/worktrees',
    dataDirPath: '/fixture/data',
    freeSpaceReader: scanBelowDataFloor,
    scan: () => { scans += 1; return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }; },
    write: () => {},
  });

  assert.equal(result.scanned, false);
  assert.equal(result.lastScanAt, lastScanAt);
  assert.equal(scans, 0);
});

test('the engine scans again after one hour', (t) => {
  const dataDir = lowDiskFixture(t);
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  let scans = 0;
  const result = runLowDiskDiagnosis({
    now,
    lastScanAt: now - 61 * 60 * 1000,
    dataDir,
    worktreePath: '/fixture/worktrees',
    dataDirPath: '/fixture/data',
    freeSpaceReader: scanBelowDataFloor,
    scan: () => { scans += 1; return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }; },
    write: () => {},
  });

  assert.equal(result.scanned, true);
  assert.equal(scans, 1);
});

test('the engine does not scan when both volumes meet the floor', (t) => {
  const dataDir = lowDiskFixture(t);
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  let scans = 0;
  const result = runLowDiskDiagnosis({
    now,
    lastScanAt: null,
    dataDir,
    worktreePath: '/fixture/worktrees',
    dataDirPath: '/fixture/data',
    freeSpaceReader: () => HIGH_WORKTREE,
    scan: () => { scans += 1; return { largestDiskUsers: [], newestLargeTempDirectories: [], scanComplete: true }; },
    write: () => {},
  });

  assert.equal(result.scanned, false);
  assert.equal(result.lastScanAt, null);
  assert.equal(scans, 0);
});

test('the diagnosis file keeps the last ten entries with the newest last', (t) => {
  const dataDir = lowDiskFixture(t);
  const base = Date.parse('2026-10-09T10:00:00.000Z');
  for (let index = 0; index < 12; index += 1) {
    writeDiskDiagnosis({
      largestDiskUsers: [{ path: `/fixture/dir-${index}`, sizeBytes: index }],
      newestLargeTempDirectories: [],
      scanComplete: true,
      recordedAt: new Date(base + index * 1000).toISOString(),
    }, { dataDir });
  }

  const list = JSON.parse(fs.readFileSync(path.join(dataDir, DISK_DIAGNOSIS_FILE), 'utf8'));
  assert.equal(list.length, 10);
  assert.equal(list[0].largestDiskUsers[0].path, '/fixture/dir-2');
  assert.equal(list[9].largestDiskUsers[0].path, '/fixture/dir-11');
  const newest = readDiskDiagnosis(dataDir, { now: base + 20_000 });
  assert.equal(newest.largestDiskUsers[0].path, '/fixture/dir-11');
  assert.equal(newest.recordedAt, new Date(base + 11_000).toISOString());
});

test('an old single-object diagnosis file reads as one entry and takes the next write', (t) => {
  const dataDir = lowDiskFixture(t);
  const base = Date.parse('2026-10-09T10:00:00.000Z');
  const legacy = {
    largestDiskUsers: [{ path: '/fixture/legacy', sizeBytes: 5 }],
    newestLargeTempDirectories: [],
    scanComplete: true,
    recordedAt: new Date(base).toISOString(),
  };
  fs.writeFileSync(path.join(dataDir, DISK_DIAGNOSIS_FILE), `${JSON.stringify(legacy)}\n`);

  assert.deepEqual(readDiskDiagnosis(dataDir, { now: base + 1000 }), {
    largestDiskUsers: legacy.largestDiskUsers,
    newestLargeTempDirectories: [],
    scanComplete: true,
    recordedAt: legacy.recordedAt,
  });

  writeDiskDiagnosis({
    largestDiskUsers: [{ path: '/fixture/new', sizeBytes: 9 }],
    newestLargeTempDirectories: [],
    scanComplete: true,
    recordedAt: new Date(base + 2000).toISOString(),
  }, { dataDir });

  const list = JSON.parse(fs.readFileSync(path.join(dataDir, DISK_DIAGNOSIS_FILE), 'utf8'));
  assert.equal(list.length, 2);
  assert.equal(list[0].largestDiskUsers[0].path, '/fixture/legacy');
});

test('an engine scan writes a disk-low-scan row to the action audit', (t) => {
  const dataDir = lowDiskFixture(t);
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  runLowDiskDiagnosis({
    now,
    lastScanAt: null,
    dataDir,
    worktreePath: '/fixture/worktrees',
    dataDirPath: '/fixture/data',
    freeSpaceReader: scanBelowDataFloor,
    scan: () => ({ largestDiskUsers: [{ path: '/fixture/cache', sizeBytes: 2048 }], newestLargeTempDirectories: [], scanComplete: true }),
  });

  const rows = fs.readFileSync(path.join(dataDir, 'action-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, 'engine tick');
  assert.equal(rows[0].workerName, null);
  assert.equal(rows[0].refusalKind, 'disk-low-scan');
  assert.ok(Number.isFinite(Date.parse(rows[0].time)));
  assert.equal(rows[0].diagnosis.largestDiskUsers[0].path, '/fixture/cache');
});
