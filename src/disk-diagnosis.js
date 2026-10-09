import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDataFile, readDataFile, writeDataFile } from './data-file-safety.js';
import { appendForcedAction } from './force-audit.js';
import { redactSecrets } from './redact.js';

export const DISK_DIAGNOSIS_FILE = 'disk-guard-diagnosis.json';
export const DISK_DIAGNOSIS_MARKER = '<!-- Herdr Boss disk guard diagnosis -->';
export const DISK_SCAN_TIME_LIMIT_MS = 2500;
export const LARGE_TEMP_DIRECTORY_BYTES = 50 * 1024 ** 2;
// The engine runs at most one diagnosis per hour while a volume is below the floor.
export const LOW_DISK_SCAN_INTERVAL_MS = 60 * 60 * 1000;
// The audit kind of an engine-triggered scan. It has no worker name.
export const DISK_LOW_SCAN_AUDIT_KIND = 'disk-low-scan';
export const MAX_DISK_DIAGNOSES = 10;
const MAX_ENTRIES = 5;

function candidateRoots({ home, tempRoot, dataDir }) {
  return [...new Set([
    tempRoot,
    path.join(home, 'Library', 'Caches'),
    path.join(home, 'Library', 'Application Support'),
    path.join(home, '.local', 'share'),
    path.join(home, 'Projects'),
    dataDir,
  ].map((item) => path.resolve(item)))];
}

function directorySize(directory, { fsApi, deadline, clock, state }) {
  let bytes = 0;
  const pending = [directory];
  while (pending.length && clock() <= deadline) {
    const current = pending.pop();
    let entries;
    try { entries = fsApi.readdirSync(current, { withFileTypes: true }); }
    catch { state.scanComplete = false; continue; }
    if (clock() >= deadline) { state.scanComplete = false; break; }
    for (const entry of entries) {
      if (clock() > deadline) { state.scanComplete = false; break; }
      const file = path.join(current, entry.name);
      let stat;
      try { stat = fsApi.lstatSync(file); }
      catch { state.scanComplete = false; continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(file);
      else if (stat.isFile()) bytes += stat.size;
    }
  }
  if (pending.length) state.scanComplete = false;
  return bytes;
}

function immediateDirectories(root, { fsApi, deadline, clock, state }) {
  let rootStat;
  try { rootStat = fsApi.lstatSync(root); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') state.scanComplete = false; return []; }
  if (clock() >= deadline) { state.scanComplete = false; return []; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  let entries;
  try { entries = fsApi.readdirSync(root, { withFileTypes: true }); }
  catch { state.scanComplete = false; return []; }
  if (clock() >= deadline) { state.scanComplete = false; return []; }
  const rows = [];
  for (const entry of entries) {
    if (clock() > deadline) { state.scanComplete = false; break; }
    const directory = path.join(root, entry.name);
    let stat;
    try { stat = fsApi.lstatSync(directory); }
    catch { state.scanComplete = false; continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    rows.push({ path: directory, sizeBytes: directorySize(directory, { fsApi, deadline, clock, state }), modifiedAt: stat.mtimeMs });
  }
  return rows;
}

// Read directory entries and file metadata only. Do not follow symlinks or open file contents.
export function scanDiskUsage({ home = os.homedir(), tempRoot = os.tmpdir(), dataDir, timeLimitMs = DISK_SCAN_TIME_LIMIT_MS, fsApi = fs, clock = Date.now } = {}) {
  const state = { scanComplete: true };
  const limitMs = Number.isFinite(timeLimitMs)
    ? Math.max(1, Math.min(DISK_SCAN_TIME_LIMIT_MS, timeLimitMs))
    : DISK_SCAN_TIME_LIMIT_MS;
  const rows = [];
  let tempRows = [];
  const roots = candidateRoots({ home, tempRoot, dataDir: dataDir || path.join(home, '.herdr-boss') });
  const sliceMs = limitMs / roots.length;
  for (const root of roots) {
    const deadline = clock() + sliceMs;
    const found = immediateDirectories(root, { fsApi, deadline, clock, state });
    if (clock() >= deadline) state.scanComplete = false;
    rows.push(...found);
    if (path.resolve(root) === path.resolve(tempRoot)) tempRows = found;
  }
  const list = (items) => items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path))
    .slice(0, MAX_ENTRIES).map(({ path: itemPath, sizeBytes }) => ({ path: itemPath, sizeBytes }));
  const newestLargeTempDirectories = tempRows
    .filter((item) => item.sizeBytes >= LARGE_TEMP_DIRECTORY_BYTES)
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_ENTRIES)
    .map(({ path: itemPath, sizeBytes }) => ({ path: itemPath, sizeBytes }));
  return { largestDiskUsers: list(rows), newestLargeTempDirectories, scanComplete: state.scanComplete };
}

function displayPath(value) {
  return `\`${String(value).replace(/[\u0000-\u001f\u007f]/g, '?').replaceAll('`', '\\`')}\``;
}

function sizeText(bytes) {
  return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
}

export function formatDiskDiagnosisMarkdown(diagnosis) {
  const lines = [DISK_DIAGNOSIS_MARKER, '## Disk guard diagnosis', ''];
  if (typeof diagnosis?.recordedAt === 'string') lines.push(`Recorded at ${diagnosis.recordedAt}.`, '');
  if (diagnosis?.scanComplete === false) lines.push('The scan stopped at its time limit or skipped an unreadable directory. The results are partial.', '');
  for (const [title, key] of [['Five largest disk users', 'largestDiskUsers'], ['Five newest large temporary directories', 'newestLargeTempDirectories']]) {
    lines.push(`### ${title}`, '');
    const rows = Array.isArray(diagnosis?.[key]) ? diagnosis[key].slice(0, MAX_ENTRIES) : [];
    if (!rows.length) lines.push('- No directories found.', '');
    else {
      for (const item of rows) {
        if (typeof item?.path === 'string' && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0) {
          lines.push(`- ${displayPath(item.path)} — ${sizeText(item.sizeBytes)}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

function readDiagnosisList(dir) {
  let value;
  try { value = JSON.parse(readDataFile(path.join(dir, DISK_DIAGNOSIS_FILE), dir)); }
  catch { return []; }
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  return value && typeof value === 'object' ? [value] : [];
}

export function writeDiskDiagnosis(diagnosis, { dataDir, bulletinFile = path.join(dataDir, 'bulletin.md') } = {}) {
  const dir = path.resolve(dataDir);
  const parsedRecordedAt = Date.parse(diagnosis?.recordedAt);
  const clean = {
    largestDiskUsers: (diagnosis?.largestDiskUsers || []).slice(0, MAX_ENTRIES),
    newestLargeTempDirectories: (diagnosis?.newestLargeTempDirectories || []).slice(0, MAX_ENTRIES),
    scanComplete: diagnosis?.scanComplete === true,
    recordedAt: Number.isFinite(parsedRecordedAt) ? new Date(parsedRecordedAt).toISOString() : new Date().toISOString(),
    ...(Number.isSafeInteger(diagnosis?.minFreeGb) && diagnosis.minFreeGb >= 1 && diagnosis.minFreeGb <= 500
      ? { minFreeGb: diagnosis.minFreeGb } : {}),
    ...(Number.isSafeInteger(diagnosis?.worktreeFreeBytes) && diagnosis.worktreeFreeBytes >= 0
      ? { worktreeFreeBytes: diagnosis.worktreeFreeBytes } : {}),
    ...(Number.isSafeInteger(diagnosis?.dataDirFreeBytes) && diagnosis.dataDirFreeBytes >= 0
      ? { dataDirFreeBytes: diagnosis.dataDirFreeBytes } : {}),
    ...(diagnosis?.volumePaths && typeof diagnosis.volumePaths.worktree === 'string' && typeof diagnosis.volumePaths.dataDir === 'string'
      ? { volumePaths: {
        worktree: redactSecrets(path.resolve(diagnosis.volumePaths.worktree)).slice(0, 1000),
        dataDir: redactSecrets(path.resolve(diagnosis.volumePaths.dataDir)).slice(0, 1000),
      } } : {}),
  };
  for (const key of ['largestDiskUsers', 'newestLargeTempDirectories']) {
    clean[key] = clean[key].flatMap((item) => typeof item?.path === 'string' && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0
      ? [{ path: redactSecrets(item.path).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 1000), sizeBytes: item.sizeBytes }]
      : []);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The file keeps the newest diagnoses, newest last. An old single-object file reads as one entry.
  const entries = readDiagnosisList(dir);
  entries.push(clean);
  writeDataFile(path.join(dir, DISK_DIAGNOSIS_FILE), `${JSON.stringify(entries.slice(-MAX_DISK_DIAGNOSES))}\n`, dir);
  let current = '';
  try { current = readDataFile(bulletinFile, dir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const markerIndex = current.indexOf(DISK_DIAGNOSIS_MARKER);
  if (markerIndex >= 0) current = current.slice(0, markerIndex).trimEnd();
  const next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${formatDiskDiagnosisMarkdown(clean)}\n`;
  assertDataFile(bulletinFile, dir);
  writeDataFile(bulletinFile, next, dir);
  return clean;
}

export function clearDiskDiagnosisBulletin({ dataDir, bulletinFile = path.join(dataDir, 'bulletin.md') } = {}) {
  const dir = path.resolve(dataDir);
  let current;
  try { current = readDataFile(bulletinFile, dir); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const lines = current.split('\n');
  const start = lines.findIndex((line) => line.trim() === DISK_DIAGNOSIS_MARKER);
  if (start < 0) return false;
  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line) && line.trim() !== '## Disk guard diagnosis');
  if (end < 0) end = lines.length;
  lines.splice(start, end - start);
  const next = `${lines.join('\n').trimEnd()}\n`;
  assertDataFile(bulletinFile, dir);
  writeDataFile(bulletinFile, next, dir);
  return true;
}

export function readDiskDiagnosis(dataDir, {
  now = Date.now(),
  minFreeGb,
  freeSpaceReader = (file) => fs.statfsSync(file),
} = {}) {
  try {
    const parsed = JSON.parse(readDataFile(path.join(dataDir, DISK_DIAGNOSIS_FILE), dataDir));
    const value = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const recordedAtMs = Date.parse(value.recordedAt);
    if (!Number.isFinite(recordedAtMs) || recordedAtMs > now || now - recordedAtMs > 6 * 60 * 60 * 1000) return null;
    const floorGb = Number.isSafeInteger(minFreeGb) && minFreeGb >= 1 && minFreeGb <= 500
      ? minFreeGb
      : Number.isSafeInteger(value.minFreeGb) && value.minFreeGb >= 1 && value.minFreeGb <= 500 ? value.minFreeGb : 8;
    if (typeof value.volumePaths?.worktree === 'string' && typeof value.volumePaths?.dataDir === 'string') {
      try {
        const freeBytes = [value.volumePaths.worktree, value.volumePaths.dataDir].map((file) => {
          const stat = freeSpaceReader(file);
          const bytes = Number(stat?.bavail) * Number(stat?.bsize);
          if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid free space');
          return bytes;
        });
        if (freeBytes.every((bytes) => bytes >= floorGb * (1024 ** 3))) return null;
      } catch { /* Keep the diagnosis until a later read proves that both volumes recovered. */ }
    }
    const cleanRows = (rows) => (Array.isArray(rows) ? rows : []).slice(0, MAX_ENTRIES).flatMap((item) =>
      typeof item?.path === 'string' && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0
        ? [{ path: item.path.slice(0, 1000), sizeBytes: item.sizeBytes }] : []);
    return {
      largestDiskUsers: cleanRows(value.largestDiskUsers),
      newestLargeTempDirectories: cleanRows(value.newestLargeTempDirectories),
      scanComplete: value.scanComplete === true,
      recordedAt: new Date(recordedAtMs).toISOString(),
    };
  } catch { return null; }
}

// A volume path that does not exist yet reads the free space of its nearest existing parent folder.
export function nearestExistingPath(file, { exists = fs.existsSync } = {}) {
  let current = path.resolve(file);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function freeBytesFromStat(stat) {
  const bytes = Number(stat?.bavail) * Number(stat?.bsize);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid free space');
  return bytes;
}

// Whether the engine must run a low-disk scan now. The engine keeps the last scan time; a restart may scan again.
export function lowDiskScanDue({ now, lastScanAt, freeSpaceBytes, minFreeGb, intervalMs = LOW_DISK_SCAN_INTERVAL_MS }) {
  const floorBytes = minFreeGb * (1024 ** 3);
  if ((freeSpaceBytes || []).every((bytes) => bytes >= floorBytes)) return false;
  return !Number.isFinite(lastScanAt) || now - lastScanAt >= intervalMs;
}

// Run at most one engine-triggered diagnosis per interval while a volume is below the floor. It reads
// free space, scans directories with paths and sizes only, writes the diagnosis, and writes the audit
// row. A free-space, scan, or write failure returns an error and leaves the last scan time unchanged.
export function runLowDiskDiagnosis({
  now = Date.now(),
  lastScanAt = null,
  dataDir,
  worktreePath,
  dataDirPath,
  minFreeGb = 8,
  intervalMs = LOW_DISK_SCAN_INTERVAL_MS,
  freeSpaceReader = (file) => fs.statfsSync(nearestExistingPath(file)),
  scan = scanDiskUsage,
  write = writeDiskDiagnosis,
  audit = appendForcedAction,
  home = os.homedir(),
  tempRoot = os.tmpdir(),
} = {}) {
  const validLastScanAt = Number.isFinite(lastScanAt) ? lastScanAt : null;
  const floorGb = Number.isSafeInteger(minFreeGb) && minFreeGb >= 1 && minFreeGb <= 500 ? minFreeGb : 8;
  let worktreeFreeBytes;
  let dataDirFreeBytes;
  try {
    worktreeFreeBytes = freeBytesFromStat(freeSpaceReader(worktreePath));
    dataDirFreeBytes = freeBytesFromStat(freeSpaceReader(dataDirPath));
  } catch (error) {
    return { scanned: false, lastScanAt: validLastScanAt, error: `free space: ${error.message}` };
  }
  if (!lowDiskScanDue({ now, lastScanAt: validLastScanAt, freeSpaceBytes: [worktreeFreeBytes, dataDirFreeBytes], minFreeGb: floorGb, intervalMs })) {
    return { scanned: false, lastScanAt: validLastScanAt };
  }
  let scanResult;
  try { scanResult = scan({ home, tempRoot, dataDir }); }
  catch (error) { return { scanned: false, lastScanAt: validLastScanAt, error: `scan: ${error.message}` }; }
  const diagnosis = {
    ...scanResult,
    recordedAt: new Date(now).toISOString(),
    minFreeGb: floorGb,
    worktreeFreeBytes,
    dataDirFreeBytes,
    volumePaths: { worktree: worktreePath, dataDir: dataDirPath },
  };
  try { write(diagnosis, { dataDir }); }
  catch (error) { return { scanned: false, lastScanAt: validLastScanAt, error: `write: ${error.message}` }; }
  try {
    audit({
      dataDir,
      time: new Date(now).toISOString(),
      command: 'engine tick',
      project: null,
      workerName: null,
      refusalKind: DISK_LOW_SCAN_AUDIT_KIND,
      reason: `The engine ran a disk diagnosis because the free space on a worker volume is below the ${floorGb} GB worktrees.minFreeGb floor.`,
      diagnosis,
    });
  } catch { /* The diagnosis stays recorded when the audit write fails. */ }
  return { scanned: true, lastScanAt: now, diagnosis };
}
