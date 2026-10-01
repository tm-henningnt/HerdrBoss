// The watch state. The file watch.json in the data directory says that the Owner is away and that the Boss acts for
// the Owner until a stored end time, or until the Owner cancels. The file also holds the marks of the notices and
// reports that went out. The old file name night.json is still read.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { armRoutines, cleanAdhoc } from './watch-routines.js';

export const WATCH_FILE = 'watch.json';
export const LEGACY_NIGHT_FILE = 'night.json';
export const NIGHT_FILE = WATCH_FILE;

// The keys that the stored record must hold. Later night-watch fields pass through this module unchanged.
const REQUIRED = ['active', 'until'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The stored keys of one-time notices and reports.
const NOTICE_KEY = { start: 'noticeStartAt', end: 'noticeStopAt' };
const REPORT_MARK = { report: 'reportSentAt', retro: 'retroSentAt' };

function noticeKey(phase) {
  if (!Object.hasOwn(NOTICE_KEY, phase)) throw new TypeError('notice phase must be start or end.');
  return NOTICE_KEY[phase];
}

export function nightFile(dataDir = DATA_DIR) {
  return path.join(dataDir, WATCH_FILE);
}

function legacyNightFile(dataDir = DATA_DIR) {
  return path.join(dataDir, LEGACY_NIGHT_FILE);
}

// The stored text of the record: watch.json, or the old night.json when watch.json is missing.
function readStoredText(dataDir) {
  try { return fs.readFileSync(nightFile(dataDir), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return fs.readFileSync(legacyNightFile(dataDir), 'utf8');
}

function isoOrNull(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The stored record holds a state. A record that is not active, or that passed its end time, reads as not active.
function normalize(value, now) {
  // The stand-down mark is independent of a watch. It shows on the dashboard whether a watch runs or not.
  const standDown = standDownView(value?.standDown);
  const mark = standDown ? { standDown } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.active !== true) return { active: false, ...mark };
  const until = isoOrNull(value.until);
  // A record without an end time stays active until it is cleared.
  if (until && Date.parse(until) <= now) return { active: false, ...mark };
  return {
    ...mark,
    active: true,
    since: isoOrNull(value.since ?? value.startedAt),
    until,
    untilCancelled: until === null,
    reportAt: isoOrNull(value.reportAt),
    reportDaily: HHMM.test(String(value.reportDaily ?? '')) ? value.reportDaily : null,
    by: typeof value.by === 'string' && value.by.trim() ? value.by.trim() : null,
    quietHours: value.quietHours === true,
    adhoc: typeof value.adhoc === 'string' ? value.adhoc : '',
    routines: Array.isArray(value.routines) ? value.routines.filter((item) => item && typeof item.id === 'string').map(routineView) : [],
    // A stored stand-down mark shows on the dashboard. The record of an ended watch keeps no mark.
    ...mark,
  };
}

// The mark of a stand-down: { at, projects: { slug: previousMode } }. A mark without a time or without a project
// reads as null, so the dashboard shows no undo button.
export function standDownView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const at = isoOrNull(value.at);
  const projects = value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects)
    ? Object.fromEntries(Object.entries(value.projects).filter(([slug, mode]) => typeof slug === 'string' && typeof mode === 'string'))
    : {};
  if (!at || !Object.keys(projects).length) return null;
  return { at, projects };
}

// The fields of one armed routine that the dashboard and the CLI show.
function routineView(item) {
  return {
    id: item.id,
    title: typeof item.title === 'string' ? item.title : item.id,
    model: typeof item.model === 'string' ? item.model : 'default',
    ...(item.every !== undefined ? { every: item.every } : {}),
    ...(item.beforeEnd !== undefined ? { beforeEnd: item.beforeEnd } : {}),
    nextAt: isoOrNull(item.nextAt),
    lastAt: isoOrNull(item.lastAt),
    missedAt: isoOrNull(item.missedAt),
    waitingSince: isoOrNull(item.waitingSince),
  };
}

// Quiet hours apply only while an active night watch has them enabled.
export function quietHoursActive(night) {
  return night?.active === true && night?.quietHours === true;
}

export function readNight({ dataDir = DATA_DIR, now = Date.now() } = {}) {
  try {
    return normalize(JSON.parse(readStoredText(dataDir)), now);
  } catch {
    // A missing or unreadable file means that no night runs.
    return { active: false };
  }
}

// Write the state atomically, with a mode that only the Owner can read. Unknown keys are kept, because a later
// task stores its own marks in the same file. A record without its own standDown keeps the stored stand-down mark,
// so starting a watch never drops a stand-down of the Owner. Pass keepStandDown false to clear the mark.
export function writeNight(state, { dataDir = DATA_DIR, keepStandDown = true } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('night state must be an object.');
  for (const key of REQUIRED) if (state[key] === undefined) throw new TypeError(`night state needs ${key}.`);
  const stored = keepStandDown && state.standDown === undefined ? standDownView(readNightRecord({ dataDir })?.standDown) : null;
  const next = stored ? { ...state, standDown: stored } : state;
  const file = nightFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  // The new file replaces the old one, so a cleared watch cannot come back from an old night.json.
  try { fs.unlinkSync(legacyNightFile(dataDir)); } catch { /* No old file. */ }
  return file;
}

// The watch ends and the files go. A stored stand-down mark stays, because it is not part of the watch.
export function clearNight({ dataDir = DATA_DIR } = {}) {
  const standDown = standDownView(readNightRecord({ dataDir })?.standDown);
  let cleared = false;
  for (const file of [nightFile(dataDir), legacyNightFile(dataDir)]) {
    try {
      fs.unlinkSync(file);
      cleared = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (cleared && standDown) writeStandDown(standDown, { dataDir });
  return cleared;
}

// The time helpers of the watch command. The command and the dashboard parse the end time and write the state.

// The default end time of a watch, as local HH:MM.
export const NIGHT_DEFAULT_UNTIL = '07:30';
export const WATCH_DEFAULT_UNTIL = NIGHT_DEFAULT_UNTIL;

// A watch of more than this many hours gets a warning.
export const WATCH_WARN_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)$/;
const FORMAT_HELP = 'The time must be HH:MM, YYYY-MM-DD HH:MM, or an ISO time, for example 07:30 or 2026-09-29 07:30.';

// Parse a time value into a Date. HH:MM means the next such local time. YYYY-MM-DD HH:MM (or with a T) is a local
// time. An ISO string with an offset keeps its own instant.
export function parseNightUntil(value, { now = new Date() } = {}) {
  const text = String(value).trim();
  const match = HHMM.exec(text);
  if (match) {
    const date = new Date(now);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
    return date;
  }
  const local = LOCAL_DATETIME.exec(text);
  if (local) {
    const [year, month, day, hour, minute] = local.slice(1).map(Number);
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    // A date such as 2026-02-31 rolls over. Refuse it.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`${text} is not a valid date. ${FORMAT_HELP}`);
    return date;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(FORMAT_HELP);
  return new Date(ms);
}

// The end time must be in the future. A watch has no maximum length.
export function assertNightUntil(date, { now = new Date() } = {}) {
  if (date.getTime() <= now.getTime()) throw new Error('The watch end time is in the past.');
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

// The length of a watch in hours, rounded to one decimal place.
export function watchHours(until, { now = new Date() } = {}) {
  return Math.round(((until.getTime() - now.getTime()) / HOUR_MS) * 10) / 10;
}

// The warning for a long watch, or null.
export function watchLengthWarning(until, { now = new Date() } = {}) {
  const hours = watchHours(until, { now });
  return hours > WATCH_WARN_HOURS ? `This watch lasts ${hours} hours. The Boss acts for the Owner for the whole time.` : null;
}

// The next local time of a daily HH:MM after the given instant.
export function nextDailyTime(hhmm, after = new Date()) {
  if (!HHMM.test(hhmm)) throw new Error('A daily report time must be HH:MM, for example 07:30.');
  return parseNightUntil(hhmm, { now: after });
}

// The label of a watch end time: the local weekday and time, for example "Wed 08:00". A time more than 6 days ahead
// also shows the date, so the label stays unambiguous.
export function watchLabel(iso, now = Date.now()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  if (Math.abs(date.getTime() - now) > 6 * 24 * HOUR_MS) {
    return `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(date)} ${time}`;
  }
  return `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date)} ${time}`;
}

// The phrase of the banner, the notice, and the bulletin: "until Wed 08:00" or "until cancelled".
export function watchUntilPhrase(state, now = Date.now()) {
  if (state?.untilCancelled === true || !state?.until) return 'until cancelled';
  return `until ${watchLabel(state.until, now)}`;
}

// Build the record of a new watch. Both the command and the dashboard call this function, so both apply the same
// rules. Times are Date objects or strings. untilCancelled is a flag. report and retro are optional. A watch until
// cancelled takes only an HH:MM report, which repeats every day.
export function buildWatchRecord({ until, untilCancelled = false, report, retro, quietHours = false, by = null, now = new Date(), routines, adhoc, dataDir = DATA_DIR, kitRoot } = {}) {
  const has = (value) => value !== undefined && value !== null && value !== '';
  if (untilCancelled && has(until)) throw new Error('Use either an end time or until cancelled, not both.');
  const end = untilCancelled ? null : has(until) ? nightUntil(until, { now }) : defaultNightUntil({ now });
  const record = { active: true, since: now.toISOString(), until: end ? end.toISOString() : null };
  if (untilCancelled) {
    record.untilCancelled = true;
    if (has(report)) {
      const text = String(report).trim();
      if (!HHMM.test(text)) throw new Error('A watch until cancelled takes a daily report time as HH:MM, for example 07:30.');
      record.reportDaily = text;
      record.reportAt = nextDailyTime(text, now).toISOString();
    }
  } else {
    record.reportAt = (has(report) ? nightUntil(report, { now }) : end).toISOString();
  }
  if (has(retro)) record.retroAt = nightUntil(retro, { now }).toISOString();
  record.by = by;
  record.quietHours = quietHours === true;
  // The choice is checked here, so a bad routine or a long text starts no watch.
  record.adhoc = cleanAdhoc(adhoc);
  record.routines = armRoutines({ choice: routines, until: end, now, dataDir, ...(kitRoot ? { kitRoot } : {}) });
  return { record, until: end, choice: routines, warning: end ? watchLengthWarning(end, { now }) : null };
}

// Read the stored record as it is on the file, with the notice marks. A missing or unreadable file reads as null.
export function readNightRecord({ dataDir = DATA_DIR } = {}) {
  try {
    const value = JSON.parse(readStoredText(dataDir));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Read the stored stand-down mark, or null when no stand-down waits to be undone.
export function readStandDown({ dataDir = DATA_DIR } = {}) {
  return standDownView(readNightRecord({ dataDir })?.standDown);
}

// Store a stand-down mark in the watch file. The record of a running watch stays as it is. A mark needs a time and at
// least one project, so a call without them clears the mark.
export function writeStandDown(standDown, { dataDir = DATA_DIR } = {}) {
  const clean = standDownView(standDown);
  const { standDown: _old, ...record } = { active: false, until: null, ...readNightRecord({ dataDir }) };
  writeNight(clean ? { ...record, standDown: clean } : record, { dataDir, keepStandDown: false });
  return clean;
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

// A report mark is stored only after its message is in the message store.
export function withNightReportMark(record, kind, at) {
  if (!Object.hasOwn(REPORT_MARK, kind)) throw new TypeError('night report kind must be report or retro.');
  return { ...(record || {}), [REPORT_MARK[kind]]: at };
}
