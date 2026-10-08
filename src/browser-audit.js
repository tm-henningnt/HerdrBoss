import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const BROWSER_LAUNCHER_KINDS = Object.freeze(['perf-harness', 'agent-browser', 'playwright', 'unknown']);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROCESS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const PANE_ID = /^[A-Za-z0-9_-]{1,24}(?::[A-Za-z0-9_-]{1,24})?$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHUNK_BYTES = 64 * 1024;
const MAX_ROW_BYTES = 4096;

export function safeBrowserStartIdentity(value) {
  return typeof value === 'string' && (PROCESS_START.test(value) || ISO_TIME.test(value)) ? value : 'unknown';
}

// Select safe fields only, including for rows written by an older service.
export function browserAuditRow(row) {
  if (row?.type !== 'browser-safety' || row.warning !== 'independent-browser-launch'
    || typeof row.at !== 'string' || !ISO_TIME.test(row.at)
    || typeof row.project !== 'string' || !PROJECT.test(row.project)) return null;
  return { at: row.at, pid: Number.isSafeInteger(row.pid) && row.pid > 1 ? row.pid : null,
    pane: typeof row.pane === 'string' && PANE_ID.test(row.pane) ? row.pane : null,
    startIdentity: safeBrowserStartIdentity(row.startIdentity),
    launcherKind: BROWSER_LAUNCHER_KINDS.includes(row.launcherKind) ? row.launcherKind : 'unknown', project: row.project };
}

// Scan a fixed file snapshot backwards. Keep one bounded chunk and at most 50 projected rows.
// Unrelated traffic cannot hide the last 50 launches of a project. Never retain a large log line.
export function readBrowserAudit({ dataDir = DATA_DIR, project = null } = {}) {
  const rows = [];
  let fd;
  try {
    fd = fs.openSync(path.join(dataDir, 'events.jsonl'), 'r');
    let position = fs.fstatSync(fd).size;
    let pending = '';
    const add = (line) => {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) return;
      try {
        const row = browserAuditRow(JSON.parse(line));
        if (row && (!project || row.project === project)) rows.push(row);
      } catch { /* Skip an incomplete or malformed row. */ }
    };
    while (position > 0 && rows.length < 50) {
      const length = Math.min(position, CHUNK_BYTES);
      position -= length;
      const buffer = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buffer, 0, length, position);
      const lines = (buffer.toString('utf8', 0, bytes) + pending).split('\n');
      pending = lines.shift();
      if (Buffer.byteLength(pending, 'utf8') > MAX_ROW_BYTES) pending = '\0';
      for (let index = lines.length - 1; index >= 0 && rows.length < 50; index--) add(lines[index]);
    }
    if (position === 0 && rows.length < 50) add(pending);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return rows;
}
