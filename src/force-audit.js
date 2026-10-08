import fs from 'node:fs';
import path from 'node:path';
import { assertDataFile, readDataFile, writeDataFile } from './data-file-safety.js';
import { redactSecrets } from './redact.js';
import { withMutationLock } from './kit/locks.js';

export const ACTION_AUDIT_FILE = 'action-audit.jsonl';
const MAX_LINES = 500;
const MAX_BYTES = 256 * 1024;

export function normalizeForceReason(reason) {
  if (typeof reason !== 'string') throw new Error('--force needs --reason TEXT (1 to 300 characters).');
  const value = reason.trim();
  if (value.length < 1 || value.length > 300) throw new Error('--reason must contain 1 to 300 characters.');
  return redactSecrets(value);
}

export function forceReason(force, reason, flag = '--force') {
  if (!force) {
    if (reason !== undefined && reason !== null) throw new Error(`--reason needs ${flag}.`);
    return null;
  }
  if (typeof reason !== 'string' || !reason.trim()) throw new Error(`${flag} needs --reason TEXT (1 to 300 characters).`);
  return normalizeForceReason(reason);
}

function trim(file, dir) {
  const lines = readDataFile(file, dir).split('\n').filter(Boolean);
  const size = () => lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  if (lines.length <= MAX_LINES && size() <= MAX_BYTES) return;
  lines.splice(0, Math.max(0, lines.length - MAX_LINES));
  let bytes = size();
  while (lines.length > 1 && bytes > MAX_BYTES) bytes -= Buffer.byteLength(lines.shift()) + 1;
  writeDataFile(file, `${lines.join('\n')}\n`, dir);
}

function safeDiagnosis(value) {
  if (!value || typeof value !== 'object') return undefined;
  const rows = (items) => (Array.isArray(items) ? items : []).slice(0, 5).flatMap((item) => {
    if (!item || typeof item.path !== 'string' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return [];
    return [{ path: redactSecrets(item.path).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 1000), sizeBytes: item.sizeBytes }];
  });
  return {
    largestDiskUsers: rows(value.largestDiskUsers),
    newestLargeTempDirectories: rows(value.newestLargeTempDirectories),
    scanComplete: value.scanComplete === true,
    ...(typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))
      ? { recordedAt: new Date(Date.parse(value.recordedAt)).toISOString() } : {}),
  };
}

export function appendForcedAction({ dataDir, time = new Date().toISOString(), command, project = null, workerName = null, refusalKind, reason, diagnosis, paths }) {
  const safeReason = normalizeForceReason(reason);
  const safeDiagnostic = safeDiagnosis(diagnosis);
  const row = {
    time: new Date(time).toISOString(),
    command: redactSecrets(String(command || '').trim()).slice(0, 80),
    project: project == null ? null : redactSecrets(String(project)).slice(0, 120),
    workerName: workerName == null ? null : redactSecrets(String(workerName)).slice(0, 32),
    refusalKind: redactSecrets(String(refusalKind || 'none')).slice(0, 160),
    reason: safeReason,
    ...(safeDiagnostic ? { diagnosis: safeDiagnostic } : {}),
    ...(paths ? { paths: paths.slice(0, 20).map((item) => redactSecrets(String(item)).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 1000)) } : {}),
  };
  if (!row.command || !row.refusalKind) throw new Error('A forced action needs a command and refusal kind.');
  const dir = path.resolve(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ACTION_AUDIT_FILE);
  return withMutationLock(dir, () => {
    assertDataFile(file, dir);
    const line = `${JSON.stringify(row)}\n`;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('The forced action log must be a regular file with no links.');
      fs.writeSync(fd, line);
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    trim(file, dir);
    return row;
  }, { waitMs: 2000, busyMessage: 'The forced action log is busy. Retry the command when it finishes.' });
}
