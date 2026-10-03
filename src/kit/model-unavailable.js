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

// The end of a record in words: an ISO time, or `re-enabled` for a record without an end.
export const untilText = (retryAt) => (retryAt >= UNTIL_REENABLED_AT ? 're-enabled' : new Date(retryAt).toISOString());

// The shell prints this text when the TUI process exits at startup. A busy machine causes it as often as a bad model.
export const PANE_STARTUP_PHRASE = 'Did you mean this?';
export const isPaneStartupBlock = (block) => block?.phrase === PANE_STARTUP_PHRASE;

const LAUNCH_BLOCKS = [
  { pattern: /did you mean this\?/i, phrase: PANE_STARTUP_PHRASE, untilReenabled: true },
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

function writeAll(dir, records) {
  const file = unavailableFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The records that still apply, as an array in the shape of rules.json unavailableModels.
export function activeLaunchRecords(dir, now = Date.now()) {
  let records;
  try { records = readAll(dir); } catch { return []; }
  return Object.values(records).filter((item) => typeof item?.model === 'string' && typeof item?.kind === 'string'
    && Number.isSafeInteger(item.retryAt) && item.retryAt > now);
}

export function markModelUnavailable(dir, {
  kind, model, provider = null, label, reason, untilReenabled = false, now = Date.now(),
}) {
  return withRecordLock(dir, () => markLocked(dir, { kind, model, provider, label, reason, untilReenabled, now }));
}

function markLocked(dir, {
  kind, model, provider, label, reason, untilReenabled, now,
}) {
  const records = readAll(dir);
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
  writeAll(dir, records);
  return record;
}

export function enableModel(dir, kind, model) {
  return withRecordLock(dir, () => {
    const records = readAll(dir);
    const key = recordKey(kind, model);
    if (!records[key]) return false;
    delete records[key];
    writeAll(dir, records);
    return true;
  });
}
