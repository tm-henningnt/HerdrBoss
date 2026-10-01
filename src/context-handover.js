// Context size of an orchestrator and task boundary detection for the context-based handover.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The transcript tail that holds the last assistant message. A second pass reads more when a long line hides it.
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];
const USAGE_CACHE_MS = 30_000;
const USAGE_CACHE_MAX_AGE_MS = 30 * 60_000;
const USAGE_CACHE_MAX_ENTRIES = 512;
const usageCache = new Map();

export function transcriptFile(sessionId, cwd, home, filesystem = fs) {
  const root = path.join(home, '.claude', 'projects');
  const name = `${sessionId}.jsonl`;
  const direct = typeof cwd === 'string' && cwd ? path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name) : null;
  if (direct && filesystem.existsSync(direct)) return direct;
  let dirs = [];
  try { dirs = filesystem.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(root, dir.name, name);
    if (filesystem.existsSync(file)) return file;
  }
  return null;
}

function readTail(file, bytes, filesystem) {
  const fd = filesystem.openSync(file, 'r');
  try {
    const { size } = filesystem.fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    filesystem.readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), whole: length === size };
  } finally { filesystem.closeSync(fd); }
}

// The last main-thread assistant message of a Claude session transcript holds the usage of the
// latest request. Its input, cache read, and cache creation tokens are the context size.
export function claudeContextUsage({ sessionId, cwd = null, home = os.homedir(), clock = Date.now, filesystem = fs, notBeforeMs = null } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { available: false, reason: 'the pane has no session ID' };
  const now = clock();
  const cacheKey = `${home}\0${sessionId}`;
  const cached = usageCache.get(cacheKey);
  const resultAfter = (result, mtimeMs) => result.available && Number.isFinite(notBeforeMs) && !(mtimeMs > notBeforeMs)
    ? { available: false, reason: 'no context usage was recorded after input was submitted' }
    : result;
  const remember = (entry) => {
    usageCache.delete(cacheKey);
    usageCache.set(cacheKey, entry);
    for (const [key, value] of usageCache) if (now - value.checkedAt > USAGE_CACHE_MAX_AGE_MS) usageCache.delete(key);
    while (usageCache.size > USAGE_CACHE_MAX_ENTRIES) usageCache.delete(usageCache.keys().next().value);
  };
  if (cached && now >= cached.checkedAt && now - cached.checkedAt < USAGE_CACHE_MS) {
    cached.lastUsedAt = now;
    return resultAfter(cached.result, cached.mtimeMs);
  }

  let file = cached?.file || null;
  let stat = null;
  if (file) {
    try {
      stat = filesystem.statSync(file);
      if (stat.isFile() && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        cached.checkedAt = now;
        cached.lastUsedAt = now;
        return resultAfter(cached.result, cached.mtimeMs);
      }
      if (!stat.isFile()) file = null;
    } catch { file = null; }
  }
  if (!file) {
    file = transcriptFile(sessionId, cwd, home, filesystem);
    if (!file) {
      const result = { available: false, reason: 'no Claude session transcript was found' };
      remember({ file: null, size: null, mtimeMs: null, checkedAt: now, lastUsedAt: now, result });
      return result;
    }
    try { stat = filesystem.statSync(file); }
    catch (e) {
      const result = { available: false, reason: `the transcript is unreadable (${e.code || 'error'})` };
      remember({ file: null, size: null, mtimeMs: null, checkedAt: now, lastUsedAt: now, result });
      return result;
    }
  }

  if (cached && file === cached.file && stat?.isFile() && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
    cached.checkedAt = now;
    cached.lastUsedAt = now;
    return resultAfter(cached.result, cached.mtimeMs);
  }

  let result = { available: false, reason: 'the transcript has no usage record' };
  try {
    for (const bytes of TAIL_BYTES) {
      const { text, whole } = readTail(file, bytes, filesystem);
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].trim()) continue;
        let row;
        try { row = JSON.parse(lines[i]); } catch { continue; }
        const usage = row?.message?.usage;
        if (row?.type !== 'assistant' || row.isSidechain === true || !usage) continue;
        const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
          .reduce((sum, key) => sum + (Number.isFinite(usage[key]) ? usage[key] : 0), 0);
        if (tokens <= 0) continue;
        result = { available: true, tokens, model: normalizeModelId(row.message.model) };
        break;
      }
      if (result.available) break;
      if (whole) break;
    }
  } catch (e) { result = { available: false, reason: `the transcript is unreadable (${e.code || 'error'})` }; }
  remember({ file, size: stat.size, mtimeMs: stat.mtimeMs, checkedAt: now, lastUsedAt: now, result });
  return resultAfter(result, stat.mtimeMs);
}

// A transcript can name a model with a date suffix or a context-window suffix. The catalog uses neither.
export function normalizeModelId(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  return model.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '') || null;
}

const doneKeys = (published) => (Array.isArray(published?.tasks) ? published.tasks : [])
  .filter((task) => task?.status === 'done').map((task) => task.id || task.title).filter(Boolean);

// A task boundary is a new done task in the published status, or a pane that went from working to
// idle or done after a new publish. The entry keeps the last seen state and an armed flag that
// holds the boundary until the engine has checked the context.
export function trackBoundary(entry, published, paneStatus) {
  const done = doneKeys(published);
  const updated = published?.updated ?? null;
  const working = paneStatus === 'working';
  if (!entry) return { done, status: paneStatus, workUpdated: working ? updated : null, armed: false };
  const next = { ...entry, done, status: paneStatus, workUpdated: working ? (entry.status === 'working' ? entry.workUpdated : updated) : null };
  const known = new Set(entry.done || []);
  if (done.some((key) => !known.has(key))) next.armed = true;
  if (entry.status === 'working' && ['idle', 'done'].includes(paneStatus) && updated !== entry.workUpdated) next.armed = true;
  return next;
}
