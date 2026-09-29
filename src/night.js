// The night watch state. The file night.json in the data directory says that the Owner is away and that the
// Boss acts for the Owner until a stored end time. The file also holds the marks of the notices that went out.
// A later task adds the commands and the reports.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const NIGHT_FILE = 'night.json';

// The keys that the stored record must hold. The other keys, such as reportAt, are written by later tasks and
// pass through this module unchanged.
const REQUIRED = ['active', 'until'];

// The stored key of the send marks of each notice phase.
const NOTICE_KEY = { start: 'noticeStartAt', end: 'noticeStopAt' };

function noticeKey(phase) {
  if (!Object.hasOwn(NOTICE_KEY, phase)) throw new TypeError('notice phase must be start or end.');
  return NOTICE_KEY[phase];
}

export function nightFile(dataDir = DATA_DIR) {
  return path.join(dataDir, NIGHT_FILE);
}

function isoOrNull(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The stored record holds a state. A record that is not active, or that passed its end time, reads as not active.
function normalize(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.active !== true) return { active: false };
  const until = isoOrNull(value.until);
  // A record without an end time stays active until it is cleared.
  if (until && Date.parse(until) <= now) return { active: false };
  return {
    active: true,
    since: isoOrNull(value.since ?? value.startedAt),
    until,
    by: typeof value.by === 'string' && value.by.trim() ? value.by.trim() : null,
    quietHours: value.quietHours === true,
  };
}

export function readNight({ dataDir = DATA_DIR, now = Date.now() } = {}) {
  try {
    return normalize(JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8')), now);
  } catch {
    // A missing or unreadable file means that no night runs.
    return { active: false };
  }
}

// Write the state atomically, with a mode that only the Owner can read. Unknown keys are kept, because a later
// task stores its own marks in the same file.
export function writeNight(state, { dataDir = DATA_DIR } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('night state must be an object.');
  for (const key of REQUIRED) if (state[key] === undefined) throw new TypeError(`night state needs ${key}.`);
  const file = nightFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearNight({ dataDir = DATA_DIR } = {}) {
  try {
    fs.unlinkSync(nightFile(dataDir));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// The time helpers of the night command. The command parses --until and writes the state.

// The default end time of a night watch, as local HH:MM.
export const NIGHT_DEFAULT_UNTIL = '07:30';

const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Parse a --until value into a Date. HH:MM means the next such local time. An ISO string
// keeps its own date and offset. The result is always after now.
export function parseNightUntil(value, { now = new Date() } = {}) {
  const text = String(value).trim();
  const match = HHMM.exec(text);
  if (match) {
    const date = new Date(now);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
    return date;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error('The --until value must be HH:MM or an ISO time, for example 07:30 or 2026-09-29T07:30:00.');
  return new Date(ms);
}

// The end time must be in the future and within 24 hours.
export function assertNightUntil(date, { now = new Date() } = {}) {
  const ms = date.getTime();
  if (ms <= now.getTime()) throw new Error('The night end time is in the past.');
  if (ms > now.getTime() + DAY_MS) throw new Error('The night end time is more than 24 hours ahead.');
  return date;
}

// Parse and check a --until value in one call.
export function nightUntil(value, { now = new Date() } = {}) {
  return assertNightUntil(parseNightUntil(value, { now }), { now });
}

// The default end time: the next 07:30 local time.
export function defaultNightUntil({ now = new Date() } = {}) {
  return parseNightUntil(NIGHT_DEFAULT_UNTIL, { now });
}

// Read the stored record as it is on the file, with the notice marks. A missing or unreadable file reads as null.
export function readNightRecord({ dataDir = DATA_DIR } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(nightFile(dataDir), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The panes that already got a notice of this phase in this night. A mark from before the night started belongs to
// an earlier night, so it does not count.
export function nightNoticeSent(record, phase) {
  const marks = record?.[noticeKey(phase)];
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return new Set();
  const since = isoOrNull(record?.since ?? record?.startedAt);
  const from = since === null ? null : Date.parse(since);
  return new Set(Object.entries(marks)
    .filter(([, at]) => from === null || !(Date.parse(at) < from))
    .map(([pane]) => pane));
}

// Add the send time of one notice for one pane to a stored record. The other keys stay as they are, and the given
// record is not changed.
export function withNoticeMark(record, phase, pane, at) {
  const key = noticeKey(phase);
  const marks = record?.[key];
  return { ...(record || {}), [key]: { ...(marks && typeof marks === 'object' && !Array.isArray(marks) ? marks : {}), [pane]: at } };
}
