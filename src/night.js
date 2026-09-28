// The night watch state. The file night.json in the data directory says that the Owner is away and that the
// Boss acts for the Owner until a stored end time. A later task adds the commands, the notices, and the reports.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const NIGHT_FILE = 'night.json';

// The keys that the stored record must hold. The other keys, such as reportAt and noticeStopAt, are written by
// later tasks and pass through this module unchanged.
const REQUIRED = ['active', 'until'];

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
