import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearDiskDiagnosisBulletin, readDiskDiagnosis, scanDiskUsage, writeDiskDiagnosis } from '../src/disk-diagnosis.js';

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
