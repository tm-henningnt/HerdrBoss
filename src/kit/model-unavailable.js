import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Launch-time records of models that cannot start. The file is separate from rules.json because the
// service rewrites rules.json on every tick. The CLI and the service both read this file.
export const UNAVAILABLE_FILE = 'unavailable-models.json';
export const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
// A record with `untilReenabled` keeps this retryAt. The Owner removes it with `models enable`.
export const UNTIL_REENABLED_AT = Date.parse('9999-12-31T00:00:00Z');

// A trial model keeps its `trial` tag until its scorecard has this many results.
export const TRIAL_RESULT_TARGET = 5;

// A run that ends with "Model is unavailable" counts for its model. Three failures within 24 hours
// mark the model unavailable for 6 hours. A successful run clears the count.
export const MODEL_UNAVAILABLE_LABEL = 'Model is unavailable';
export const MODEL_FAILURE_THRESHOLD = 3;
export const MODEL_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MODEL_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// The file keeps at most this many model counters. The oldest counter is dropped first.
export const MAX_MODEL_FAILURE_RECORDS = 50;

// The failure counters live beside the launch records in the same file. This key cannot collide with
// a record key, which is `kind\nmodel`.
const FAILURES_KEY = 'modelFailures';

// The end of a record in words: an ISO time, or `re-enabled` for a record without an end.
export const untilText = (retryAt) => (retryAt >= UNTIL_REENABLED_AT ? 're-enabled' : new Date(retryAt).toISOString());

const LAUNCH_BLOCKS = [
  { pattern: /not available in your country/i, phrase: 'not available in your country', untilReenabled: true },
  { pattern: /rate limit exceeded/i, phrase: 'Rate limit exceeded', untilReenabled: false },
];

export function detectLaunchBlock(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const found = LAUNCH_BLOCKS.find((block) => block.pattern.test(clean));
  return found ? { phrase: found.phrase, untilReenabled: found.untilReenabled } : null;
}

// The non-empty lines of `text` that are not in `baseline`. A line counts once per time it occurs in the baseline.
export function newPaneLines(text, baseline = '') {
  const strip = (value) => String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trimEnd());
  const seen = new Map();
  for (const line of strip(baseline)) seen.set(line, (seen.get(line) ?? 0) + 1);
  return strip(text).filter((line) => {
    if (!line.trim()) return false;
    const count = seen.get(line) ?? 0;
    if (count > 0) { seen.set(line, count - 1); return false; }
    return true;
  });
}

export function launchBlockedError(model, block, { fallback = true } = {}) {
  const until = block.untilReenabled ? 'until the Owner re-enables it' : 'for 30 minutes';
  const error = new Error(`Model ${model} cannot start: the pane shows "${block.phrase}". Herdr Boss marks it unavailable ${until}.${fallback ? '' : ' Pass another --model.'}`);
  error.code = 'model_launch_blocked';
  error.launchBlock = block;
  return error;
}

export function unavailableFile(dir = process.env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss')) {
  return path.join(dir, UNAVAILABLE_FILE);
}

const recordKey = (kind, model) => `${kind}\n${model}`;

// Split the file into launch records and failure counters. The failure counters are a nested map.
function splitState(raw) {
  const records = {};
  for (const [key, item] of Object.entries(raw || {})) if (key !== FAILURES_KEY) records[key] = item;
  const stored = raw?.[FAILURES_KEY];
  const failures = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return { records, failures };
}

const warnedFiles = new Set();

// A corrupt or unreadable file counts as empty, so a launch block still reaches the caller. The warning prints once per file.
function readAll(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(unavailableFile(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    const file = unavailableFile(dir);
    if (!warnedFiles.has(file)) {
      warnedFiles.add(file);
      process.stderr.write(`Warning: could not read ${file}: ${error.message}. Herdr Boss treats it as empty.\n`);
    }
    return {};
  }
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;

// One writer at a time: the lock file is created exclusively, and a lock older than LOCK_STALE_MS is taken over.
function withRecordLock(dir, operation) {
  const lock = `${unavailableFile(dir)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(`Could not lock ${unavailableFile(dir)} within ${LOCK_WAIT_MS / 1000} s.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return operation(); }
  finally { fs.rmSync(lock, { force: true }); }
}

// Write the launch records and, when present, the failure counters in one atomic replace.
function writeState(dir, records, failures = {}) {
  const file = unavailableFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = Object.keys(failures).length ? { ...records, [FAILURES_KEY]: failures } : { ...records };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The records that still apply, as an array in the shape of rules.json unavailableModels.
export function activeLaunchRecords(dir, now = Date.now()) {
  let raw;
  try { raw = readAll(dir); } catch { return []; }
  return Object.values(splitState(raw).records).filter((item) => typeof item?.model === 'string' && typeof item?.kind === 'string'
    && Number.isSafeInteger(item.retryAt) && item.retryAt > now);
}

// The active record that a repeated "Model is unavailable" failure wrote, or null.
export function modelFailureMark(records, kind, model, now = Date.now()) {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  return list.find((item) => item?.kind === kind && item?.model === model
    && item?.label === MODEL_UNAVAILABLE_LABEL && Number.isSafeInteger(item.retryAt) && item.retryAt > now) || null;
}

// Count one "Model is unavailable" failure for a model. The third failure within the window marks the
// model unavailable for the cooldown and clears its counter. A repeated call at the same instant counts once.
export function recordModelFailure(dir, { kind, model, provider = null, now = Date.now() }) {
  return withRecordLock(dir, () => {
    const { records, failures } = splitState(readAll(dir));
    for (const [key, item] of Object.entries(records)) {
      if (!Number.isSafeInteger(item?.retryAt) || item.retryAt <= now) delete records[key];
    }
    const key = recordKey(kind, model);
    // An active mark already covers this model. Do not count the same outage again.
    const existing = records[key];
    if (existing?.label === MODEL_UNAVAILABLE_LABEL && Number.isSafeInteger(existing.retryAt) && existing.retryAt > now) {
      return { count: existing.count ?? MODEL_FAILURE_THRESHOLD, marked: true, retryAt: existing.retryAt };
    }
    const prior = Array.isArray(failures[key]?.times) ? failures[key].times : [];
    // A repeated tick for the same failure keeps the counter, with no file write.
    if (prior.includes(now)) return { count: prior.filter((time) => now - time < MODEL_FAILURE_WINDOW_MS).length, marked: false, retryAt: null };
    const times = [...new Set([...prior, now])]
      .filter((time) => Number.isFinite(time) && now - time < MODEL_FAILURE_WINDOW_MS)
      .sort((a, b) => a - b);
    if (times.length >= MODEL_FAILURE_THRESHOLD) {
      const retryAt = now + MODEL_FAILURE_COOLDOWN_MS;
      records[key] = {
        model, kind, provider, lane: provider || 'unmetered', retryAt, at: now,
        label: MODEL_UNAVAILABLE_LABEL, reason: MODEL_UNAVAILABLE_LABEL, count: times.length,
      };
      delete failures[key];
      writeState(dir, records, failures);
      return { count: times.length, marked: true, retryAt };
    }
    failures[key] = { kind, model, provider: provider ?? null, times, at: now };
    // Bound the file. Keep the counters that changed most recently.
    const ordered = Object.entries(failures).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    for (const [staleKey] of ordered.slice(MAX_MODEL_FAILURE_RECORDS)) delete failures[staleKey];
    writeState(dir, records, failures);
    return { count: times.length, marked: false, retryAt: null };
  });
}

// A successful run of the model clears its counter and its "Model is unavailable" mark.
export function clearModelFailure(dir, { kind, model }) {
  return withRecordLock(dir, () => {
    const { records, failures } = splitState(readAll(dir));
    const key = recordKey(kind, model);
    let changed = false;
    if (failures[key]) { delete failures[key]; changed = true; }
    if (records[key]?.label === MODEL_UNAVAILABLE_LABEL) { delete records[key]; changed = true; }
    if (changed) writeState(dir, records, failures);
    return changed;
  });
}

export function markModelUnavailable(dir, {
  kind, model, provider = null, label, reason, untilReenabled = false, now = Date.now(),
}) {
  return withRecordLock(dir, () => markLocked(dir, { kind, model, provider, label, reason, untilReenabled, now }));
}

function markLocked(dir, {
  kind, model, provider, label, reason, untilReenabled, now,
}) {
  const { records, failures } = splitState(readAll(dir));
  for (const [key, item] of Object.entries(records)) {
    if (!Number.isSafeInteger(item?.retryAt) || item.retryAt <= now) delete records[key];
  }
  const retryAt = untilReenabled ? UNTIL_REENABLED_AT : now + RATE_LIMIT_COOLDOWN_MS;
  const prior = records[recordKey(kind, model)];
  const record = {
    model, kind, provider, lane: provider || 'unmetered', retryAt, at: now,
    label: label || reason || 'launch blocked', reason: reason || label || 'launch blocked',
    ...(untilReenabled ? { untilReenabled: true } : {}),
  };
  // A rate limit never shortens a record that lasts until the Owner re-enables the model.
  if (prior?.untilReenabled && !untilReenabled) return prior;
  records[recordKey(kind, model)] = record;
  delete failures[recordKey(kind, model)];
  writeState(dir, records, failures);
  return record;
}

export function enableModel(dir, kind, model) {
  return withRecordLock(dir, () => {
    const { records, failures } = splitState(readAll(dir));
    const key = recordKey(kind, model);
    if (!records[key] && !failures[key]) return false;
    delete records[key];
    delete failures[key];
    writeState(dir, records, failures);
    return true;
  });
}
