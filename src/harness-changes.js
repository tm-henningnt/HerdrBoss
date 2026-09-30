// Harness change markers for the denial chart on the Analytics page. One JSON object for each line of
// harness-changes.jsonl in the data dir: { date: YYYY-MM-DD, harness, label }. The reader skips every line
// that does not validate and never throws.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { verifyMessageCaller } from './messages.js';

export const HARNESS_CHANGES_FILE = 'harness-changes.jsonl';
export const CHANGE_HARNESSES = ['claude', 'codex', 'opencode', 'pi'];
export const MAX_CHANGE_LINES = 200;
export const MAX_CHANGE_BYTES = 64 * 1024;
export const MAX_LABEL_LENGTH = 80;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0 and C1 control characters, the line and paragraph separators, and the bidi and zero-width format characters.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]');

export function validDate(value) {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A validated entry or null. The result holds the three known fields only.
export function parseHarnessChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { date, harness, label } = value;
  if (!validDate(date) || !CHANGE_HARNESSES.includes(harness) || typeof label !== 'string') return null;
  const text = label.trim();
  if (!text || text.length > MAX_LABEL_LENGTH || CONTROL.test(label)) return null;
  return { date, harness, label: text };
}

// Reads the last 64 KB and keeps the last 200 valid lines. The first line of the tail can be cut; it fails to parse and is skipped.
export function readHarnessChanges(dataDir = DATA_DIR) {
  let fd;
  try {
    fd = fs.openSync(path.join(dataDir, HARNESS_CHANGES_FILE), 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, MAX_CHANGE_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const rows = [];
    for (const raw of buffer.toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const entry = parseHarnessChange(parsed);
      if (entry) rows.push(entry);
    }
    // Array.prototype.sort is stable, so entries of one date keep the file order.
    return rows.slice(-MAX_CHANGE_LINES).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Appends one validated line. Throws an Error that names the bad field.
export function appendHarnessChange(dataDir, { harness, label, date } = {}) {
  const day = date === undefined ? localToday() : date;
  if (!CHANGE_HARNESSES.includes(harness)) throw new Error(`The harness must be one of: ${CHANGE_HARNESSES.join(', ')}.`);
  if (!validDate(day)) throw new Error('The date must be a real day in the form YYYY-MM-DD.');
  const entry = parseHarnessChange({ date: day, harness, label });
  if (!entry) throw new Error(`The label must be 1 to ${MAX_LABEL_LENGTH} characters, without control characters.`);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, HARNESS_CHANGES_FILE);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return entry;
}

// Who may add a marker: a plain terminal (the Owner), the pane labeled boss, and a pane labeled orch. A worker pane is refused.
// Returns null for a plain terminal, or { paneId, workspaceId, role }.
export function assertHarnessChangeCaller(env, herdr) {
  if (env.HERDR_ENV !== '1') return null;
  try { return verifyMessageCaller(env, herdr, 'harness change'); } catch (error) {
    if (/^Only the pane labeled boss/.test(error.message)) throw new Error('Only the pane labeled boss, a pane labeled orch, or a plain terminal can run herdr-boss harness change. A worker asks its orchestrator with a WORKER QUESTION.');
    throw error;
  }
}
