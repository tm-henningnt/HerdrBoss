// The watch routines. A routine is a prompt that the service sends to the Boss pane on a schedule while a watch runs.
// The kit holds the default routines as kit/watch/*.md. The Owner edits them in Settings. An edit writes the
// machine-level file watch-routines.json in the data directory and never changes the kit file. The same file holds the
// last choice of the Watch box, which is the default of the next watch.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { KIT_ROOT } from './kit/config.js';

export const ROUTINES_FILE = 'watch-routines.json';
export const ADHOC_MAX = 2000;
export const NOTICE_ADHOC_MAX = 500;
export const MIN_BEFORE_END_MINUTES = 5;

const MIN = 60 * 1000;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_EVERY = 1440;
const MAX_PROMPT = 8000;
const MAX_TITLE = 60;
const MAX_MODEL = 40;
const SCHEDULE_KEYS = ['every', 'beforeEnd'];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function beforeEndMinutes(value) {
  const match = HHMM.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function checkEvery(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EVERY) {
    throw new Error(`${label}: every must be a whole number of minutes from 1 to ${MAX_EVERY}.`);
  }
  return value;
}

function checkBeforeEnd(value, label) {
  const minutes = beforeEndMinutes(value);
  if (minutes === null || minutes < MIN_BEFORE_END_MINUTES) {
    throw new Error(`${label}: beforeEnd must be HH:MM, at least 00:0${MIN_BEFORE_END_MINUTES}, for example 01:00.`);
  }
  return value;
}

// Read the schedule fields of an object. Zero fields give null. Two fields are an error.
function readSchedule(source, label) {
  const given = SCHEDULE_KEYS.filter((key) => source[key] !== undefined && source[key] !== null && source[key] !== '');
  if (given.length > 1) throw new Error(`${label}: use one schedule, every or beforeEnd, not both.`);
  if (!given.length) return null;
  return given[0] === 'every'
    ? { every: checkEvery(typeof source.every === 'string' && /^\d+$/.test(source.every) ? Number(source.every) : source.every, label) }
    : { beforeEnd: checkBeforeEnd(source.beforeEnd, label) };
}

function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('A routine id must be lowercase letters, digits, and hyphens, and start with a letter (id).');
  return id;
}

// Control characters other than tab and line feed are removed from text that reaches a pane.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function checkText(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} needs text.`);
  const text = value.replace(CONTROL, '').trim();
  if (!text) throw new Error(`${label} needs text.`);
  if (text.length > max) throw new Error(`${label} may hold at most ${max} characters.`);
  return text;
}

// A routine file: a front matter block of "key: value" lines, then the prompt text.
export function parseRoutineText(text, id) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!match) throw new Error(`Routine ${id} needs front matter between --- lines.`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const split = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!split) throw new Error(`Routine ${id} has an unreadable front matter line: ${line}`);
    meta[split[1]] = split[2].trim();
  }
  const label = `Routine ${id}`;
  if (!meta.title) throw new Error(`${label} needs a title.`);
  if (SCHEDULE_KEYS.filter((key) => meta[key]).length > 1) throw new Error(`${label} needs one schedule, every or beforeEnd, not both.`);
  const schedule = readSchedule(meta, label);
  if (!schedule) throw new Error(`${label} needs a schedule: every or beforeEnd.`);
  return {
    id: checkId(id),
    title: checkText(meta.title, `${label} title`, MAX_TITLE),
    model: meta.model ? checkText(meta.model, `${label} model`, MAX_MODEL) : 'default',
    ...schedule,
    prompt: checkText(match[2], `${label} prompt`, MAX_PROMPT),
  };
}

// The default routines of the kit, sorted by file name. A file that does not parse is left out.
export function loadKitRoutines(kitRoot = KIT_ROOT) {
  const directory = path.join(kitRoot, 'kit', 'watch');
  let names = [];
  try { names = fs.readdirSync(directory).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
  const routines = [];
  for (const name of names) {
    try { routines.push(parseRoutineText(fs.readFileSync(path.join(directory, name), 'utf8'), name.slice(0, -3))); }
    catch { /* A kit file with an error is left out. The kit tests catch it. */ }
  }
  return routines;
}

function routinesFile(dataDir) {
  return path.join(dataDir, ROUTINES_FILE);
}

// The machine-level file: { routines: { id: override }, last: { id: { enabled, every|beforeEnd } } }.
export function readOverrides({ dataDir = DATA_DIR } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(routinesFile(dataDir), 'utf8'));
    return {
      routines: isRecord(value?.routines) ? value.routines : {},
      last: isRecord(value?.last) ? value.last : {},
    };
  } catch {
    return { routines: {}, last: {} };
  }
}

function writeOverrides(value, dataDir) {
  const file = routinesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function merged(kit, override, last) {
  const base = kit || {};
  const own = isRecord(override) ? override : {};
  const remembered = isRecord(last) ? last : {};
  const routine = {
    id: base.id ?? own.id,
    title: own.title ?? base.title,
    model: own.model ?? base.model ?? 'default',
    prompt: own.prompt ?? base.prompt,
  };
  const ownSchedule = SCHEDULE_KEYS.some((key) => own[key] !== undefined) ? readSchedule(own, `Routine ${routine.id}`) : null;
  const lastSchedule = SCHEDULE_KEYS.some((key) => remembered[key] !== undefined) ? readSchedule(remembered, `Routine ${routine.id}`) : null;
  const schedule = lastSchedule || ownSchedule || (base.every !== undefined ? { every: base.every } : { beforeEnd: base.beforeEnd });
  return {
    ...routine,
    ...schedule,
    enabled: remembered.enabled !== false,
    source: !kit ? 'custom' : isRecord(override) && Object.keys(override).length ? 'override' : 'kit',
  };
}

// The routines that the Watch box offers: the kit files, the Owner overrides, and the Owner's own routines.
export function effectiveRoutines({ dataDir = DATA_DIR, kitRoot = KIT_ROOT } = {}) {
  const kit = new Map(loadKitRoutines(kitRoot).map((routine) => [routine.id, routine]));
  const { routines: overrides, last } = readOverrides({ dataDir });
  const ids = [...kit.keys(), ...Object.keys(overrides).filter((id) => !kit.has(id) && ID.test(id)).sort()];
  const result = [];
  for (const id of ids) {
    try {
      const routine = merged(kit.get(id), overrides[id] ? { ...overrides[id], id } : undefined, last[id]);
      if (routine.title && routine.prompt && (routine.every !== undefined || routine.beforeEnd !== undefined)) result.push(routine);
    } catch { /* A stored routine with an error is left out. */ }
  }
  return result;
}

// Save the Owner edit of one routine. A field that is not in the patch keeps its stored value. A new schedule replaces
// the old one, and it also replaces the schedule that the last watch choice remembered.
export function saveRoutine(id, patch, { dataDir = DATA_DIR, kitRoot = KIT_ROOT } = {}) {
  checkId(id);
  if (!isRecord(patch)) throw new Error('The routine edit must be an object.');
  const kit = loadKitRoutines(kitRoot).find((routine) => routine.id === id);
  const stored = readOverrides({ dataDir });
  const next = { ...(stored.routines[id] || {}) };
  if (patch.title !== undefined) next.title = checkText(patch.title, `Routine ${id} title`, MAX_TITLE);
  if (patch.model !== undefined) next.model = checkText(patch.model, `Routine ${id} model`, MAX_MODEL);
  if (patch.prompt !== undefined) next.prompt = checkText(patch.prompt, `Routine ${id} prompt`, MAX_PROMPT);
  const schedule = readSchedule(patch, `Routine ${id}`);
  const last = { ...stored.last };
  if (schedule) {
    delete next.every;
    delete next.beforeEnd;
    Object.assign(next, schedule);
    if (last[id]) {
      const { every, beforeEnd, ...rest } = last[id];
      last[id] = rest;
    }
  }
  const full = merged(kit, next, undefined);
  if (!full.title) throw new Error(`Routine ${id} needs a title.`);
  if (!full.prompt) throw new Error(`Routine ${id} needs a prompt.`);
  if (full.every === undefined && full.beforeEnd === undefined) throw new Error(`Routine ${id} needs a schedule: every or beforeEnd.`);
  writeOverrides({ routines: { ...stored.routines, [id]: next }, last }, dataDir);
  return effectiveRoutines({ dataDir, kitRoot }).find((routine) => routine.id === id);
}

// Remove the Owner edit of a routine. A kit routine returns to the kit text. An Owner routine is deleted.
export function resetRoutine(id, { dataDir = DATA_DIR } = {}) {
  checkId(id);
  const stored = readOverrides({ dataDir });
  const { [id]: removed, ...routines } = stored.routines;
  const { [id]: removedLast, ...last } = stored.last;
  if (removed === undefined && removedLast === undefined) return false;
  writeOverrides({ routines, last }, dataDir);
  return true;
}

// Check a choice, an object of { id: { enabled, every|beforeEnd } }. Return it in a clean form.
function cleanChoice(choice, routines) {
  if (choice === undefined || choice === null) return {};
  if (!isRecord(choice)) throw new Error('The routine choice must be an object of routine ids.');
  const known = new Set(routines.map((routine) => routine.id));
  const clean = {};
  for (const [id, entry] of Object.entries(choice)) {
    if (!known.has(id)) throw new Error(`Unknown routine ${id}.`);
    if (!isRecord(entry)) throw new Error(`The choice for routine ${id} must be an object.`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`Routine ${id}: enabled must be true or false.`);
    clean[id] = { ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }), ...(readSchedule(entry, `Routine ${id}`) || {}) };
  }
  return clean;
}

// Store the choice of a watch as the default of the next watch.
export function rememberChoice(choice, { dataDir = DATA_DIR, kitRoot = KIT_ROOT } = {}) {
  const clean = cleanChoice(choice, effectiveRoutines({ dataDir, kitRoot }));
  const stored = readOverrides({ dataDir });
  const last = { ...stored.last };
  for (const [id, entry] of Object.entries(clean)) {
    const previous = last[id] || {};
    const scheduled = SCHEDULE_KEYS.some((key) => entry[key] !== undefined);
    const { every, beforeEnd, ...rest } = previous;
    last[id] = { ...(scheduled ? rest : previous), ...entry };
  }
  writeOverrides({ routines: stored.routines, last }, dataDir);
  return last;
}

// The ad-hoc text of a watch: trimmed, with unix line ends. An empty text is an empty string.
export function cleanAdhoc(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('The ad-hoc text must be a string.');
  const text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (text.length > ADHOC_MAX) throw new Error(`The ad-hoc text may hold at most ${ADHOC_MAX} characters.`);
  return text;
}

// The ad-hoc text on one line for the start notice.
export function adhocOneLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > NOTICE_ADHOC_MAX ? `${text.slice(0, NOTICE_ADHOC_MAX - 3)}...` : text;
}

// The first and next run time of a routine that starts now. A schedule relative to the end has no run in a watch
// without an end, and none when the run time is already past.
function firstRun(routine, { now, until }) {
  if (routine.every !== undefined) {
    const at = now.getTime() + routine.every * MIN;
    return until && at >= until.getTime() ? null : new Date(at).toISOString();
  }
  if (!until) return null;
  const at = until.getTime() - beforeEndMinutes(routine.beforeEnd) * MIN;
  return at > now.getTime() ? new Date(at).toISOString() : null;
}

// Arm the enabled routines of a new watch. The result goes into the watch record. It holds no prompt text: the
// service reads the text of the routine when the routine runs.
export function armRoutines({ choice, until = null, now = new Date(), dataDir = DATA_DIR, kitRoot = KIT_ROOT } = {}) {
  const routines = effectiveRoutines({ dataDir, kitRoot });
  const clean = cleanChoice(choice, routines);
  const armed = [];
  for (const routine of routines) {
    const pick = clean[routine.id] || {};
    if (!(pick.enabled ?? routine.enabled)) continue;
    const schedule = SCHEDULE_KEYS.some((key) => pick[key] !== undefined)
      ? pick
      : routine.every !== undefined ? { every: routine.every } : { beforeEnd: routine.beforeEnd };
    armed.push({
      id: routine.id,
      title: routine.title,
      model: routine.model,
      ...schedule,
      nextAt: firstRun({ ...schedule }, { now, until }),
      lastAt: null,
    });
  }
  return armed;
}

// The end of the slot that starts at nextAt. Inside the slot the service keeps trying. After it the run is skipped.
export function slotEnd(routine, record) {
  if (routine.every !== undefined) return Date.parse(routine.nextAt) + routine.every * MIN;
  const until = Date.parse(record?.until);
  return Number.isFinite(until) ? until : Infinity;
}

// The first slot after the given time. Null when the routine has no later slot.
export function slotAfter(routine, record, now) {
  if (routine.every === undefined) return null;
  const from = Date.parse(routine.nextAt);
  const next = from + (Math.floor((now - from) / (routine.every * MIN)) + 1) * routine.every * MIN;
  const until = Date.parse(record?.until);
  return Number.isFinite(until) && next >= until ? null : new Date(next).toISOString();
}

// The prompt that goes to the Boss pane: the routine text, then the ad-hoc text of the watch.
export function routinePromptText(routine, adhoc = '') {
  const lines = [
    `[herdr-boss] Watch routine: ${routine.title} (model hint: ${routine.model || 'default'}). The service sends this prompt once for this slot. You do not need to reply to the service.`,
    routine.prompt,
  ];
  const extra = String(adhoc || '').trim();
  if (extra) lines.push(`Instructions for this watch: ${extra}`);
  return lines.join('\n\n');
}
