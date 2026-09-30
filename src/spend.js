// Daily token use and spend by role, read from the session logs of the four harnesses.
// Only counts are read and kept: never store or print message text, commands, or tool output.
// The daily numbers hold a day, a role, a harness, a model, and token counts. They never hold a path or a session ID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readProjectRepos } from './harness.js';
import { sharedWorktreeRoot } from './kit/config.js';
import { assertSqliteAvailable } from './sqlite-store.js';
import { normalizeModelId } from './context-handover.js';
import { fillMeasuredUsage } from './usage.js';

export const SPEND_SCAN_INTERVAL_MS = 5 * 60 * 1000;
export const SPEND_BUDGET_BYTES = 16 * 1024 * 1024;
// A line longer than this is skipped without a parse.
export const SPEND_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const SPEND_CHUNK_BYTES = 1024 * 1024;
export const SPEND_RETAIN_DAYS = 90;
// Log files older than this are not read.
export const SPEND_FILE_DAYS = 35;
const MAX_OPENCODE_SESSIONS_PER_SCAN = 40;
const MAX_TOKENS = 1e11;
const DAY_MS = 86400 * 1000;
export const ROLES = ['boss', 'orchestrator', 'worker', 'other'];
export const HARNESSES = ['claude', 'codex', 'pi', 'opencode'];
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
// cacheWrite1h is the part of cacheWrite that the 1 hour cache holds. It is not a token total of its own.
const STORED = [...FIELDS, 'cacheWrite1h'];
// The recent Claude message IDs that one log file keeps, as hashes.
const SEEN_LIMIT = 128;

const stateFile = (dir) => path.join(dir, 'spend-state.json');
const dailyFile = (dir) => path.join(dir, 'spend-daily.json');
// A day is the local calendar day of the machine, the same day that the machine hours and the Owner use.
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hash = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function count(value) {
  return Number.isFinite(value) && value > 0 && value < MAX_TOKENS ? Math.round(value) : 0;
}
function money(value) {
  return Number.isFinite(value) && value >= 0 && value < 1e6 ? value : null;
}
function timeOf(value) {
  const at = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
function safeModel(value, provider) {
  if (typeof value !== 'string') return 'unknown';
  const model = value.trim();
  const combined = provider && typeof provider === 'string' && !model.includes('/') ? `${provider}/${model}` : model;
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/.test(combined) ? combined : 'unknown';
}
export const totalTokens = (u) => FIELDS.reduce((sum, key) => sum + (u[key] || 0), 0);
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

// ---- Line parsers. Each returns counts and identity fields only. ----

function parseJson(line) {
  try { const value = JSON.parse(line); return isObject(value) ? value : null; } catch { return null; }
}

// Claude: an assistant message with a usage object. A message that a transcript repeats for each content
// block has one message ID and one request ID. The repeat adds only what the first row lacked.
export function parseClaudeLine(line, ctx = {}) {
  const row = parseJson(line);
  if (!row) return { bad: true };
  if (typeof row.cwd === 'string' && !ctx.cwd) ctx.cwd = row.cwd;
  if (typeof row.sessionId === 'string' && !ctx.sessionId) ctx.sessionId = row.sessionId;
  const usage = row.message?.usage;
  if (row.type !== 'assistant' || !isObject(usage)) return { skip: true };
  // cache_creation splits the cache write into the 5 minute and the 1 hour part. Without it, all of it is 5 minute.
  const split = isObject(usage.cache_creation) ? usage.cache_creation : null;
  const write5m = count(split?.ephemeral_5m_input_tokens);
  const write1h = count(split?.ephemeral_1h_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens) || write5m + write1h;
  const now = {
    input: count(usage.input_tokens), output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens), cacheWrite,
  };
  if (Math.min(write1h, cacheWrite) > 0) now.cacheWrite1h = Math.min(write1h, cacheWrite);
  if (!totalTokens(now)) return { skip: true };
  // Dedupe by message ID and request ID over a bounded set of recent messages. The repeat adds only its growth.
  let delta = now;
  let repeat = false;
  const idKey = `${row.message.id ?? ''}|${row.requestId ?? ''}`;
  if (idKey !== '|') {
    const seen = ctx.seen ||= new Map();
    const key = hash(idKey);
    const before = seen.get(key);
    if (before) {
      repeat = true;
      delta = Object.fromEntries(STORED.map((f, i) => [f, Math.max(0, (now[f] || 0) - (before[i] || 0))]).filter(([f, n]) => n > 0 || FIELDS.includes(f)));
      seen.delete(key);
    }
    seen.set(key, STORED.map((f, i) => Math.max(now[f] || 0, before?.[i] || 0)));
    while (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
  }
  if (!totalTokens(delta)) return { skip: true };
  return { usage: delta, at: timeOf(row.timestamp), model: safeModel(normalizeModelId(row.message.model)), messages: repeat ? 0 : 1 };
}

// Codex: the token_count events hold the running total of a session. The parser returns the increase.
// The input total includes the cached input, so the fresh input is the difference.
export function parseCodexLine(line, ctx = {}) {
  const row = parseJson(line);
  if (!row) return { bad: true };
  const payload = isObject(row.payload) ? row.payload : {};
  if (row.type === 'session_meta' || row.type === 'turn_context') {
    if (typeof payload.cwd === 'string' && (row.type === 'session_meta' || !ctx.cwd)) ctx.cwd = payload.cwd;
    if (typeof payload.session_id === 'string' && !ctx.sessionId) ctx.sessionId = payload.session_id;
    else if (typeof payload.id === 'string' && row.type === 'session_meta' && !ctx.sessionId) ctx.sessionId = payload.id;
    if (typeof payload.model === 'string') ctx.model = safeModel(payload.model);
    return { skip: true };
  }
  if (row.type !== 'event_msg' || payload.type !== 'token_count') return { skip: true };
  const total = payload.info?.total_token_usage;
  if (!isObject(total)) return { skip: true };
  const cached = count(total.cached_input_tokens);
  const now = {
    input: Math.max(0, count(total.input_tokens) - cached), output: count(total.output_tokens),
    cacheRead: cached, cacheWrite: count(total.cache_write_input_tokens),
  };
  const prev = ctx.prev || emptyUsage();
  const reset = FIELDS.some((f) => now[f] < prev[f]);
  const delta = Object.fromEntries(FIELDS.map((f) => [f, reset ? now[f] : now[f] - prev[f]]));
  ctx.prev = now;
  if (!totalTokens(delta)) return { skip: true };
  return { usage: delta, at: timeOf(row.timestamp), model: ctx.model || 'unknown', messages: 1 };
}

// Pi: an assistant message with a usage object. Pi also records its own cost for the message.
export function parsePiLine(line, ctx = {}) {
  const row = parseJson(line);
  if (!row) return { bad: true };
  if (row.type === 'session') {
    if (typeof row.cwd === 'string') ctx.cwd = row.cwd;
    if (typeof row.id === 'string') ctx.sessionId = row.id;
    return { skip: true };
  }
  if (row.type === 'model_change') {
    const model = safeModel(row.modelId ?? row.modelID ?? row.model, row.provider ?? row.providerID);
    if (model !== 'unknown') ctx.model = model;
    return { skip: true };
  }
  const message = row.message;
  if (row.type !== 'message' || message?.role !== 'assistant' || !isObject(message.usage)) return { skip: true };
  const usage = message.usage;
  const now = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) };
  if (!totalTokens(now)) return { skip: true };
  const model = typeof message.model === 'string' ? safeModel(message.model, message.provider) : ctx.model || 'unknown';
  return { usage: now, at: timeOf(row.timestamp ?? message.timestamp), model, logCost: money(usage.cost?.total), messages: 1 };
}

const PARSERS = { claude: parseClaudeLine, codex: parseCodexLine, pi: parsePiLine };

// ---- Reading ----

// Read the next whole lines of a file from state.offset. A partial last line waits for its newline.
// A line longer than maxLineBytes is skipped: the reader drops bytes up to its newline, without a parse.
export function pullLines(fd, state, size, budget, { chunkBytes = SPEND_CHUNK_BYTES, maxLineBytes = SPEND_MAX_LINE_BYTES } = {}) {
  const lines = [];
  let used = 0;
  let skipped = 0;
  while (state.offset < size && used < budget) {
    if (state.skipping) {
      const buffer = Buffer.alloc(Math.min(chunkBytes, size - state.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      if (read <= 0) break;
      const newline = buffer.subarray(0, read).indexOf(0x0a);
      used += read;
      if (newline < 0) { state.offset += read; continue; }
      state.offset += newline + 1;
      state.skipping = false;
      skipped += 1;
      continue;
    }
    let want = Math.min(chunkBytes, size - state.offset);
    let buffer;
    let read;
    let newline;
    for (;;) {
      buffer = Buffer.alloc(want);
      read = fs.readSync(fd, buffer, 0, want, state.offset);
      newline = read > 0 ? buffer.lastIndexOf(0x0a, read - 1) : -1;
      if (newline >= 0 || state.offset + read >= size) break;
      if (want >= maxLineBytes) { newline = -2; break; }
      want = Math.min(want * 2, maxLineBytes, size - state.offset);
    }
    if (newline === -2) {
      state.offset += read;
      state.skipping = true;
      used += read;
      continue;
    }
    if (newline < 0) break;
    for (const line of buffer.subarray(0, newline).toString('utf8').split('\n')) lines.push(line);
    state.offset += newline + 1;
    used += newline + 1;
  }
  return { lines, used, skipped };
}

// ---- Roles ----

const within = (dir, parent) => {
  const rel = path.relative(parent, dir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep) : null;
};

// Learn the role of live panes. A session ID gives the role directly. A folder that only Boss panes or only
// orchestrator panes use gives the role of later sessions in that folder.
export function learnPanes(state, panes = []) {
  const roleOf = (pane) => (pane.label === 'boss' ? 'boss' : pane.orch ? 'orchestrator' : pane.agent ? 'worker' : null);
  const byCwd = {};
  for (const pane of panes) {
    const role = roleOf(pane);
    if (!role) continue;
    if (typeof pane.sessionId === 'string' && pane.sessionId) state.sessions[hash(pane.sessionId)] = role;
    if (typeof pane.cwd === 'string' && pane.cwd && role !== 'worker') (byCwd[pane.cwd] ||= new Set()).add(role);
  }
  for (const [cwd, roles] of Object.entries(byCwd)) if (roles.size === 1) state.cwds[hash(path.resolve(cwd))] = [...roles][0];
}

const BOSS_NAMES = new Set(['boss', 'boss previous']);
// A Boss record has the boss flag or the label `boss`, as handoff.js sets them. The project and display names are a second check.
const isBossRecord = (item) => Boolean(item.boss) || [item.project, item.displayLabel, item.label].some((v) => BOSS_NAMES.has(String(v || '').toLowerCase()));

// Learn the sessions of earlier Boss panes from the handover records. A Boss record names the session that
// the Boss left (sessionId) and the session that took over (migratedId). The state keeps their hashes only.
export function learnHandoffs(state, records = []) {
  for (const item of Array.isArray(records) ? records : []) {
    if (!isObject(item) || !isBossRecord(item)) continue;
    for (const id of [item.sessionId, item.migratedId]) if (typeof id === 'string' && id) state.sessions[hash(id)] = 'boss';
  }
}

// Return { role, project, worker } for a session. The project and worker names stay in the private state file.
// The raw folder and session ID are used here only. The state file keeps their hashes.
export function classify({ sessionId, cwd }, env) {
  const known = sessionId ? env.sessions[hash(sessionId)] : null;
  const target = typeof cwd === 'string' && cwd ? path.resolve(cwd) : null;
  const shared = target ? within(target, path.resolve(env.worktreeRoot)) : null;
  let worker = null;
  if (shared?.length > 1) worker = { project: shared[0].toLowerCase(), worker: shared[1] };
  else if (target) {
    for (const { repo } of env.repos) {
      const root = path.resolve(repo);
      const first = within(target, path.dirname(root))?.[0];
      const base = path.basename(root);
      if (first?.startsWith(`${base}-wt-`)) { worker = { project: base.toLowerCase(), worker: first.slice(base.length + 4) }; break; }
    }
  }
  if (known) return { role: known, ...(known === 'worker' && worker ? worker : {}) };
  if (worker) return { role: 'worker', ...worker };
  if (target && env.cwds[hash(target)]) return { role: env.cwds[hash(target)] };
  if (target && env.repos.some(({ repo }) => path.resolve(repo) === target)) return { role: 'orchestrator' };
  return { role: 'other' };
}

// ---- Daily store ----

function addUsage(target, usage, logCost = null) {
  for (const f of FIELDS) target[f] = (target[f] || 0) + (usage[f] || 0);
  if (usage.cacheWrite1h) target.cacheWrite1h = (target.cacheWrite1h || 0) + usage.cacheWrite1h;
  if (logCost != null) {
    target.logCost = (target.logCost || 0) + logCost;
    target.costTokens = (target.costTokens || 0) + totalTokens(usage);
  }
}
function addDaily(daily, day, role, harness, model, usage, logCost, messages = 0) {
  const entry = ((daily.days[day] ||= {})[`${role}|${harness}|${model}`] ||= { ...emptyUsage(), messages: 0 });
  addUsage(entry, usage, logCost);
  entry.messages += messages;
}
function pruneDaily(daily, now) {
  const oldest = dayOf(now - SPEND_RETAIN_DAYS * DAY_MS);
  for (const day of Object.keys(daily.days)) if (day < oldest) delete daily.days[day];
}

function loadState(dir) {
  const state = readJson(stateFile(dir), null);
  const ok = isObject(state) && state.version === 1;
  const files = ok && isObject(state.files) ? state.files : {};
  // A state file never keeps a raw folder, session ID, or dedupe key. Drop them if an old file has them.
  for (const st of Object.values(files)) for (const field of ['cwd', 'sessionId', 'lastKey', 'lastUsage']) delete st[field];
  return {
    version: 1,
    files,
    sessions: ok && isObject(state.sessions) ? state.sessions : {},
    cwds: ok && isObject(state.cwds) ? state.cwds : {},
    opencode: ok && isObject(state.opencode) ? state.opencode : { cursor: 0, sessions: {} },
    harnesses: ok && isObject(state.harnesses) ? state.harnesses : {},
  };
}
function loadDaily(dir) {
  const daily = readJson(dailyFile(dir), null);
  return isObject(daily) && daily.version === 1 && isObject(daily.days) ? daily : { version: 1, days: {} };
}

// ---- File listing ----

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function jsonlIn(dir) {
  return listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}
// List all log files. A file older than the cutoff is read only when the state already knows it,
// so a resumed old file continues from its saved offset.
function logFiles(home, now, known) {
  const files = [];
  const claude = path.join(home, '.claude', 'projects');
  for (const folder of listDir(claude).filter((e) => e.isDirectory())) for (const file of jsonlIn(path.join(claude, folder.name))) files.push({ harness: 'claude', file });
  const codex = path.join(home, '.codex', 'sessions');
  const oldest = dayOf(now - (SPEND_FILE_DAYS + 1) * DAY_MS);
  for (const y of listDir(codex).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    for (const m of listDir(path.join(codex, y.name)).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
      for (const d of listDir(path.join(codex, y.name, m.name)).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
        const old = `${y.name}-${m.name}-${d.name}` < oldest;
        for (const file of jsonlIn(path.join(codex, y.name, m.name, d.name))) files.push({ harness: 'codex', file, old });
      }
    }
  }
  const pi = path.join(home, '.pi', 'agent', 'sessions');
  for (const folder of listDir(pi).filter((e) => e.isDirectory())) for (const file of jsonlIn(path.join(pi, folder.name))) files.push({ harness: 'pi', file });
  const out = [];
  for (const item of files) {
    item.key = hash(item.file);
    // A Codex file in an old date folder is not opened or checked unless the state knows it.
    if (item.old && !known[item.key]) continue;
    try {
      const stat = fs.statSync(item.file);
      if (!stat.isFile()) continue;
      if (!known[item.key] && stat.mtimeMs < now - SPEND_FILE_DAYS * DAY_MS) continue;
      out.push({ ...item, stat });
    } catch { /* The file went away. */ }
  }
  // The newest files first, so a capped scan reads the recent days.
  return out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

// ---- OpenCode: read the token columns of the message rows with SQL. The message text is never selected. ----

function opencodeSessions(state, env, now, harnesses) {
  const dbFile = env.opencodeDb;
  if (!fs.existsSync(dbFile)) { harnesses.opencode = { status: 'none' }; return; }
  let handle;
  try {
    const { DatabaseSync } = assertSqliteAvailable();
    handle = new DatabaseSync(dbFile, { readOnly: true });
    const cursor = Math.max(state.opencode.cursor || 0, now - SPEND_FILE_DAYS * DAY_MS);
    const touched = handle.prepare('SELECT session_id AS id, MAX(time_updated) AS t FROM message WHERE time_updated >= ? GROUP BY session_id ORDER BY t LIMIT ?').all(cursor, MAX_OPENCODE_SESSIONS_PER_SCAN);
    const messages = handle.prepare(`SELECT time_created AS at,
      json_extract(data, '$.modelID') AS model, json_extract(data, '$.providerID') AS provider,
      json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
      json_extract(data, '$.tokens.reasoning') AS reasoning, json_extract(data, '$.tokens.cache.read') AS cacheRead,
      json_extract(data, '$.tokens.cache.write') AS cacheWrite, json_extract(data, '$.cost') AS cost
      FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'`);
    const directory = handle.prepare('SELECT directory FROM session WHERE id = ?');
    let newest = state.opencode.cursor || 0;
    for (const { id, t } of touched) {
      const cwd = directory.get(id)?.directory;
      const info = classify({ sessionId: null, cwd }, env);
      const days = {};
      let first = null;
      let last = null;
      for (const row of messages.all(id)) {
        const usage = { input: count(row.input), output: count(row.output) + count(row.reasoning), cacheRead: count(row.cacheRead), cacheWrite: count(row.cacheWrite) };
        if (!totalTokens(usage)) continue;
        const at = timeOf(row.at) ?? t;
        const model = safeModel(row.model, row.provider);
        const entry = ((days[dayOf(at)] ||= {})[model] ||= emptyUsage());
        addUsage(entry, usage, money(row.cost));
        first = first == null ? at : Math.min(first, at);
        last = last == null ? at : Math.max(last, at);
      }
      state.opencode.sessions[hash(id)] = { ...info, cwdKnown: Boolean(cwd), first, last, days };
      newest = Math.max(newest, t);
    }
    state.opencode.cursor = newest;
    const oldest = dayOf(now - SPEND_RETAIN_DAYS * DAY_MS);
    for (const [key, session] of Object.entries(state.opencode.sessions)) if (!session.last || dayOf(session.last) < oldest) delete state.opencode.sessions[key];
    harnesses.opencode = { status: 'ok' };
  } catch (error) {
    harnesses.opencode = { status: 'unavailable', reason: error.code || 'error' };
  } finally { try { handle?.close(); } catch { /* Already closed. */ } }
}

// ---- Scan ----

// A cheap test before the JSON parse. Only lines that can hold usage counts or the session identity are parsed.
// A Claude log holds its folder in any row, so every line is parsed until the folder is known.
const WANTED = {
  claude: (line, ctx) => !ctx.cwd || line.includes('"usage"'),
  codex: (line) => line.includes('"token_count"') || line.includes('"session_meta"') || line.includes('"turn_context"'),
  pi: (line) => line.includes('"usage"') || line.includes('"session"') || line.includes('"model_change"'),
};

// The role of a log file. A scan that read the folder classifies it. A later scan keeps the stored result,
// and upgrades it when a live pane now names the session or the folder.
function fileRole(st, ctx, env) {
  if (ctx.cwd || !st.role) return classify({ sessionId: ctx.sessionId, cwd: ctx.cwd }, env);
  const known = (st.sessionHash && env.sessions[st.sessionHash]) || (st.role === 'other' && st.cwdHash && env.cwds[st.cwdHash]);
  return { role: known || st.role, project: st.project, worker: st.worker };
}

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

// Read the next lines of the log files within the byte budget. Returns the bytes read and the bytes still unread.
export async function scanSpend({
  dataDir = DATA_DIR, home = os.homedir(), now = Date.now(), panes = [], repos = readProjectRepos(dataDir),
  handoffs = readJson(path.join(dataDir, 'handoffs.json'), []),
  worktreeRoot = sharedWorktreeRoot(home), budgetBytes = SPEND_BUDGET_BYTES,
  maxLineBytes = SPEND_MAX_LINE_BYTES, chunkBytes = SPEND_CHUNK_BYTES, fillUsage = true, usageFile = path.join(dataDir, 'usage.jsonl'),
} = {}) {
  const state = loadState(dataDir);
  const daily = loadDaily(dataDir);
  learnHandoffs(state, handoffs);
  learnPanes(state, panes);
  const env = {
    sessions: state.sessions, cwds: state.cwds, repos, worktreeRoot,
    opencodeDb: path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
  const files = logFiles(home, now, state.files);
  const seen = new Set();
  const harnesses = {};
  for (const h of ['claude', 'codex', 'pi']) harnesses[h] = { files: 0, usageLines: state.harnesses[h]?.usageLines || 0, badLines: state.harnesses[h]?.badLines || 0 };
  let remaining = budgetBytes;
  let bytes = 0;
  let pendingBytes = 0;
  for (const item of files) {
    const key = item.key;
    seen.add(key);
    const st = state.files[key] ||= { harness: item.harness, offset: 0, skipping: false };
    const summary = harnesses[item.harness];
    summary.files += 1;
    st.harness = item.harness;
    if (st.offset > item.stat.size) Object.assign(st, { offset: 0, skipping: false, run: undefined, seen: undefined, prev: undefined });
    if (st.offset >= item.stat.size || remaining <= 0) { pendingBytes += Math.max(0, item.stat.size - st.offset); st.pending = item.stat.size > st.offset; continue; }
    let fd;
    try { fd = fs.openSync(item.file, 'r'); } catch { continue; }
    // The raw folder and session ID live in this object only. The state keeps their hashes.
    const ctx = { model: st.model, prev: st.prev, seen: st.seen ? new Map(Object.entries(st.seen)) : undefined };
    if (item.harness === 'claude') ctx.sessionId = path.basename(item.file, '.jsonl');
    const parse = PARSERS[item.harness];
    const wanted = WANTED[item.harness];
    let info = null;
    try {
      // Read one chunk at a time and yield between chunks, so one large file cannot block the service.
      while (remaining > 0 && st.offset < item.stat.size) {
        const { lines, used } = pullLines(fd, st, item.stat.size, Math.min(remaining, chunkBytes), { chunkBytes, maxLineBytes });
        remaining -= used;
        bytes += used;
        for (const line of lines) {
          if (!wanted(line, ctx, st)) {
            if (line.trim() && line.charCodeAt(0) !== 0x7b) summary.badLines += 1;
            continue;
          }
          const result = parse(line, ctx);
          if (result.bad) { summary.badLines += 1; continue; }
          if (!result.usage) continue;
          summary.usageLines += 1;
          info ||= fileRole(st, ctx, env);
          Object.assign(st, { role: info.role, project: info.project, worker: info.worker });
          const at = result.at ?? st.lastAt ?? item.stat.mtimeMs;
          st.lastAt = Math.max(st.lastAt || 0, at);
          st.firstAt = st.firstAt == null ? at : Math.min(st.firstAt, at);
          addDaily(daily, dayOf(at), info.role, item.harness, result.model, result.usage, result.logCost ?? null, result.messages);
          if (info.role === 'worker') {
            const run = st.run ||= { models: {} };
            addUsage(run.models[result.model] ||= emptyUsage(), result.usage, result.logCost ?? null);
          }
        }
        if (!used) break;
        await yieldTurn();
      }
      st.pending = st.offset < item.stat.size;
      pendingBytes += Math.max(0, item.stat.size - st.offset);
    } finally { fs.closeSync(fd); }
    if (ctx.cwd) st.cwdHash = hash(path.resolve(ctx.cwd));
    if (ctx.sessionId) st.sessionHash = hash(ctx.sessionId);
    st.model = ctx.model;
    st.prev = ctx.prev;
    st.seen = ctx.seen && now - item.stat.mtimeMs < 2 * DAY_MS ? Object.fromEntries(ctx.seen) : undefined;
  }
  for (const key of Object.keys(state.files)) if (!seen.has(key)) delete state.files[key];
  for (const h of ['claude', 'codex', 'pi']) {
    const summary = harnesses[h];
    summary.status = !summary.files ? 'none' : summary.usageLines === 0 && summary.badLines > 0 ? 'unavailable' : 'ok';
  }
  opencodeSessions(state, env, now, harnesses);
  state.harnesses = harnesses;
  pruneDaily(daily, now);
  daily.updatedAt = new Date(now).toISOString();
  daily.pendingBytes = pendingBytes;
  writeJson(dailyFile(dataDir), daily);
  writeJson(stateFile(dataDir), state);
  if (fillUsage) {
    const aliases = {};
    for (const { slug, repo } of repos) (aliases[slug] ||= []).push(path.basename(repo).toLowerCase());
    fillMeasuredUsage({ file: usageFile, runs: measuredRuns(state), now, priceOf: priceFor(loadPrices(dataDir)), aliases });
  }
  return { bytes, pendingBytes, harnesses };
}

// ---- Runs, for the usage records ----

// One entry per worker session log. The usage record of a worker run matches by project, worker name, harness, and time.
export function measuredRuns(state) {
  const runs = [];
  for (const st of Object.values(state.files)) {
    if (st.role !== 'worker' || !st.run) continue;
    runs.push({ harness: st.harness, project: st.project, worker: st.worker, first: st.firstAt, last: st.lastAt, complete: !st.pending, models: st.run.models });
  }
  for (const session of Object.values(state.opencode.sessions)) {
    if (session.role !== 'worker') continue;
    const models = {};
    for (const day of Object.values(session.days)) for (const [model, usage] of Object.entries(day)) addUsage(models[model] ||= emptyUsage(), usage, usage.logCost ?? null);
    runs.push({ harness: 'opencode', project: session.project, worker: session.worker, first: session.first, last: session.last, complete: true, models });
  }
  return runs;
}

// ---- Prices and summary ----

// Prices are in USD per million tokens, from src/spend-prices.json. The Owner can override single figures in
// spend-prices.override.json in the data directory. The Claude figures are the API list prices, so the USD is an
// API-price equivalent: a subscription does not bill per token.
export const COST_LABEL = 'API-price equivalent';
export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
export const PRICE_MAX = 1000;
const overrideFile = (dir) => path.join(dir, 'spend-prices.override.json');
const validPrice = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= PRICE_MAX;

export function defaultPrices() {
  return readJson(new URL('./spend-prices.json', import.meta.url), {}).models || {};
}

// Check an override body: { models: { "<harness>/<model>": { <price field>: number } } }.
// A model must be in the default table, a field must be a price field, and a number must be 0 to 1000.
export function validatePriceOverrides(body, known = defaultPrices()) {
  const errors = [];
  if (!isObject(body)) return { errors: ['The prices must be an object.'], overrides: null };
  for (const key of Object.keys(body)) if (key !== 'models') errors.push(`Unknown key: ${key}.`);
  if (!isObject(body.models)) return { errors: [...errors, 'models must be an object.'], overrides: null };
  const models = {};
  for (const [name, fields] of Object.entries(body.models)) {
    if (!Object.hasOwn(known, name)) { errors.push(`Unknown model: ${name}.`); continue; }
    if (!isObject(fields)) { errors.push(`${name} must be an object.`); continue; }
    const clean = {};
    for (const [field, value] of Object.entries(fields)) {
      if (!PRICE_FIELDS.includes(field)) errors.push(`${name}: unknown price field ${field}.`);
      else if (!validPrice(value)) errors.push(`${name}: ${field} must be a number from 0 to ${PRICE_MAX}.`);
      else clean[field] = value;
    }
    if (Object.keys(clean).length) models[name] = clean;
  }
  return { errors, overrides: errors.length ? null : { models } };
}

export function readPriceOverrides(dataDir = DATA_DIR) {
  const known = defaultPrices();
  const file = readJson(overrideFile(dataDir), null);
  const models = {};
  // A hand-edited file can hold a bad entry. Each entry is checked alone, and a bad one is skipped.
  for (const [name, fields] of Object.entries(isObject(file?.models) ? file.models : {})) {
    const one = validatePriceOverrides({ models: { [name]: fields } }, known);
    if (one.overrides?.models[name]) models[name] = one.overrides.models[name];
  }
  return { models };
}

// Replace the override file. An empty models object removes it. A bad body throws and writes nothing.
export function writePriceOverrides(body, { dataDir = DATA_DIR } = {}) {
  const { errors, overrides } = validatePriceOverrides(body);
  if (errors.length) throw new Error(errors.join(' '));
  if (Object.keys(overrides.models).length) writeJson(overrideFile(dataDir), overrides);
  else fs.rmSync(overrideFile(dataDir), { force: true });
  return overrides;
}

// The default table with the override applied. An overridden figure is no longer unconfirmed.
export function loadPrices(dataDir = DATA_DIR) {
  const prices = defaultPrices();
  for (const [name, fields] of Object.entries(readPriceOverrides(dataDir).models)) {
    const unconfirmed = (prices[name].unconfirmed || []).filter((f) => !(f in fields));
    prices[name] = { ...prices[name], ...fields, ...(unconfirmed.length ? { unconfirmed } : {}) };
    if (!unconfirmed.length) delete prices[name].unconfirmed;
  }
  return prices;
}
export function priceFor(prices) {
  return (harness, model) => {
    const p = prices?.[`${harness}/${model}`];
    return isObject(p) && Number.isFinite(p.input) && Number.isFinite(p.output) ? p : null;
  };
}
// A cache write is 5 minute unless the usage names the 1 hour part. A missing cache price falls back:
// the cache read to the input price, the 1 hour write to the 5 minute write, and the 5 minute write to the input price.
export function estimateCost(usage, price) {
  if (!price) return null;
  const cacheRead = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input;
  const cacheWrite = Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.input;
  const cacheWrite1h = Number.isFinite(price.cacheWrite1h) ? price.cacheWrite1h : cacheWrite;
  const write1h = Math.min(usage.cacheWrite1h || 0, usage.cacheWrite || 0);
  const write5m = (usage.cacheWrite || 0) - write1h;
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * cacheRead + write5m * cacheWrite + write1h * cacheWrite1h) / 1e6;
}
// The cost of one usage row: the cost that the harness logged, plus the price-table estimate of the rest.
// Tokens without either are unpriced.
export function costOf(entry, harness, model, priceOf) {
  const covered = entry.costTokens || 0;
  const total = totalTokens(entry);
  let costUsd = entry.logCost || 0;
  let unpricedTokens = 0;
  if (total > covered) {
    const price = priceOf(harness, model);
    if (covered === 0) {
      const estimate = estimateCost(entry, price);
      if (estimate == null) unpricedTokens = total; else costUsd += estimate;
    } else if (price) {
      const share = (total - covered) / total;
      costUsd += estimateCost(entry, price) * share;
    } else unpricedTokens = total - covered;
  }
  return { costUsd, unpricedTokens };
}

const blank = () => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpricedTokens: 0 });
function fold(target, usage, cost) {
  for (const f of FIELDS) target[f] += usage[f] || 0;
  target.tokens += totalTokens(usage);
  target.costUsd += cost.costUsd;
  target.unpricedTokens += cost.unpricedTokens;
}

export const SPEND_DEFAULT_DAYS = 7;
export function clampSpendDays(days) {
  const n = Math.floor(Number(days));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, SPEND_RETAIN_DAYS) : SPEND_DEFAULT_DAYS;
}

// The daily summary for the last N days. No path, project, worker, or session appears in it.
export function spendSummary({ dataDir = DATA_DIR, days = SPEND_DEFAULT_DAYS, now = Date.now(), prices = loadPrices(dataDir) } = {}) {
  const daily = loadDaily(dataDir);
  const state = loadState(dataDir);
  const priceOf = priceFor(prices);
  const merged = {};
  const merge = (day, key, entry) => {
    const bucket = ((merged[day] ||= {})[key] ||= emptyUsage());
    for (const f of FIELDS) bucket[f] += entry[f] || 0;
    if (entry.cacheWrite1h) bucket.cacheWrite1h = (bucket.cacheWrite1h || 0) + entry.cacheWrite1h;
    if (entry.logCost != null) {
      bucket.logCost = (bucket.logCost || 0) + entry.logCost;
      bucket.costTokens = (bucket.costTokens || 0) + (entry.costTokens || 0);
    }
  };
  for (const [day, rows] of Object.entries(daily.days)) for (const [key, entry] of Object.entries(rows)) merge(day, key, entry);
  for (const session of Object.values(state.opencode.sessions)) {
    for (const [day, models] of Object.entries(session.days)) for (const [model, entry] of Object.entries(models)) merge(day, `${session.role}|opencode|${model}`, entry);
  }
  const oldest = dayOf(now - (Math.max(1, days) - 1) * DAY_MS);
  const result = [];
  const unconfirmed = new Set();
  for (const day of Object.keys(merged).filter((d) => d >= oldest).sort().reverse()) {
    const total = blank();
    const roles = {};
    for (const [key, entry] of Object.entries(merged[day])) {
      const [role, harness, model] = key.split('|');
      const cost = costOf(entry, harness, model, priceOf);
      if (cost.costUsd > 0 && priceOf(harness, model)?.unconfirmed?.length) unconfirmed.add(`${harness}/${model}`);
      fold(total, entry, cost);
      const row = roles[role] ||= { role, ...blank(), harnesses: {} };
      fold(row, entry, cost);
      fold(row.harnesses[harness] ||= blank(), entry, cost);
    }
    result.push({
      day,
      total,
      roles: ROLES.filter((r) => roles[r]).map((r) => roles[r]),
    });
  }
  return {
    currency: 'USD',
    costLabel: COST_LABEL,
    unconfirmedPrices: [...unconfirmed].sort(),
    updatedAt: daily.updatedAt || null,
    pendingBytes: daily.pendingBytes || 0,
    harnesses: Object.fromEntries(HARNESSES.map((h) => [h, { status: state.harnesses[h]?.status || 'none' }])),
    days: result,
  };
}

// Print the daily summary as text: one line per day and role, then one total line per day.
export function formatSpend(summary) {
  const short = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
  const cost = (row) => {
    const usd = `${row.costUsd.toFixed(2)} USD ${COST_LABEL}`;
    if (!row.unpricedTokens) return usd;
    return row.costUsd > 0 ? `${usd} + ${short(row.unpricedTokens)} tokens unpriced` : `unpriced (${short(row.unpricedTokens)} tokens)`;
  };
  const lines = [];
  for (const day of summary.days) {
    for (const row of day.roles) lines.push(`${day.day}  ${row.role.padEnd(12)} ${short(row.tokens).padStart(8)} tokens  ${cost(row)}`);
    lines.push(`${day.day}  ${'total'.padEnd(12)} ${short(day.total.tokens).padStart(8)} tokens  ${cost(day.total)}`);
  }
  if (!lines.length) lines.push('No spend recorded yet. The service reads the session logs every 5 minutes.');
  if (summary.unconfirmedPrices?.length) lines.push(`Unconfirmed prices: ${summary.unconfirmedPrices.join(', ')}.`);
  const bad = Object.entries(summary.harnesses).filter(([, h]) => h.status === 'unavailable').map(([name]) => name);
  if (bad.length) lines.push(`Unavailable logs: ${bad.join(', ')}.`);
  return lines.join('\n');
}
