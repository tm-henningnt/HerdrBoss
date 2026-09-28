// Counts of sandbox refusals, permission prompts, and classifier refusals across harnesses.
// See docs/harness-setup.md. Only counts are kept: never store or log message text, commands,
// arguments, or paths. A record is { day, harness, cause, project, count }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { readProjectRepos } from './harness.js';

export const DENIAL_SCAN_INTERVAL_MS = 15 * 60 * 1000;
export const SCAN_BUDGET_BYTES = 20 * 1024 * 1024;
export const RETAIN_DAYS = 30;
export const UNANSWERED_MS = 10 * 60 * 1000;
export const DISCUSS_NOTE = 'Discuss this trend with the Boss.';
// A cause rises when the last 24 hours exceed this factor of the 6-day mean and this many events.
export const RISE_FACTOR = 2;
export const RISE_MIN_EVENTS = 10;
// While more unread log bytes than this remain, the stored days are not complete and the trend note waits.
export const CATCH_UP_BYTES = 1024 * 1024;

const DAY_MS = 86400 * 1000;
const MAX_RUNS = 1000;
const CLASSIFIER = /^Permission for this action was denied by the Claude Code auto mode classifier\. Reason: \[([^\]\n]{1,80})\]/;
const CLASSIFIER_ANY = /denied by the Claude Code auto mode classifier\. Reason: \[([^\]\n]{1,80})\]/;
const REASON = /^[A-Za-z][A-Za-z -]{0,59}$/;
const ESCALATION = /sandbox_permissions\\?["']?\s*[:=]\s*\\?["']?require_escalated/;
const SANDBOX = [['sandbox:eperm', /EPERM/], ['sandbox:not-permitted', /Operation not permitted/], ['sandbox:permission-denied', /Permission denied/]];
const OPENCODE_TYPES = new Set(['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'task', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'doom_loop', 'todowrite', 'todoread', 'lsp', 'skill', 'patch']);
const GUARD_CLASSES = [['outside-worktree', /is outside the worktree/], ['protected-path', /is a protected path/], ['rm-rf', /^rm -rf\b/], ['denied-command', /is not allowed for a worker/]];

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const denialsFile = (dataDir) => path.join(dataDir, 'denials.json');

function parseJson(line) {
  try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; }
}
function timeOf(value, fallback) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : fallback;
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
}
const reasonCause = (reason) => `classifier:${REASON.test(reason.trim()) ? reason.trim() : 'other'}`;

// Claude: a tool result that the auto mode classifier refused.
export function parseClaudeLine(line) {
  const record = parseJson(line);
  if (record?.type !== 'user' || !Array.isArray(record.message?.content)) return [];
  const events = [];
  for (const part of record.message.content) {
    if (part?.type !== 'tool_result') continue;
    const text = contentText(part.content);
    const match = CLASSIFIER.exec(text) || (record.toolDenialKind === 'automode-blocked' ? CLASSIFIER_ANY.exec(text) : null);
    if (match) events.push({ at: timeOf(record.timestamp, null), cause: reasonCause(match[1]), cwd: record.cwd });
  }
  return events;
}

// Codex: sandbox errors in tool outputs and escalation requests in tool calls. ctx.cwd holds the session folder.
export function parseCodexLine(line, ctx = {}) {
  const record = parseJson(line);
  if (!record) return [];
  const payload = record.payload || {};
  if ((record.type === 'session_meta' || record.type === 'turn_context') && typeof payload.cwd === 'string') {
    ctx.cwd = payload.cwd;
    return [];
  }
  if (record.type !== 'response_item') return [];
  const at = timeOf(record.timestamp, null);
  const event = (cause) => ({ at, cause, cwd: ctx.cwd });
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const text = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
    return SANDBOX.filter(([, pattern]) => pattern.test(text)).map(([cause]) => event(cause));
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const args = payload.arguments ?? payload.input;
    const text = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    return ESCALATION.test(text) ? [event('escalation:request')] : [];
  }
  return [];
}

// OpenCode: one log line as key=value fields. The patterns field is never returned.
export function parseOpenCodeLine(line) {
  const fields = {};
  const token = /(?:^|\s)([A-Za-z_]+)=(\[[^\]]*\]|"(?:[^"\\]|\\.)*"|\S*)/g;
  let match;
  while ((match = token.exec(line))) fields[match[1]] = match[2];
  if (!fields.message) return null;
  const stamp = fields.timestamp || /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?/.exec(line)?.slice(1).join('');
  let at = null;
  if (/^\d+$/.test(stamp || '')) at = Number(stamp) < 1e12 ? Number(stamp) * 1000 : Number(stamp);
  else if (stamp) at = timeOf(/(Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : `${stamp}Z`, null);
  return { message: fields.message, id: fields.id, requestID: fields.requestID, type: fields.permission, run: fields.run, cwd: fields.cwd, at };
}

export function guardCause(reason) {
  const body = String(reason).replace(/^.*?Herdr guard:\s*/s, '');
  const hit = GUARD_CLASSES.find(([, pattern]) => pattern.test(body));
  return `guard:${hit ? hit[0] : 'other'}`;
}

// Pi: a tool result that the Herdr guard extension blocked.
export function parsePiLine(line) {
  const record = parseJson(line);
  const message = record?.message;
  if (message?.role !== 'toolResult') return [];
  const match = /(?:^|\n|: )Herdr guard: [^\n]*/.exec(contentText(message.content));
  return match ? [{ at: timeOf(record.timestamp ?? message.timestamp, null), cause: guardCause(match[0]) }] : [];
}

// A folder inside <repo> or inside a sibling <repo>-wt-<name> belongs to the slug. The longest repository wins.
export function projectFor(dir, repos) {
  if (typeof dir !== 'string' || !dir) return 'other';
  let best = null;
  for (const { slug, repo } of repos) {
    const root = path.resolve(repo);
    const rel = path.relative(path.dirname(root), path.resolve(dir));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const first = rel.split(path.sep)[0];
    const base = path.basename(root);
    if ((first === base || first.startsWith(`${base}-wt-`)) && (!best || root.length > best.root.length)) best = { slug, root };
  }
  return best?.slug || 'other';
}

// Pi names a session folder after its working directory, with each separator as "-" and "--" around it.
const piEncode = (dir) => path.resolve(dir).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
export function projectForPiFolder(folder, repos) {
  const name = String(folder).replace(/^-+|-+$/g, '');
  let best = null;
  for (const { slug, repo } of repos) {
    const encoded = piEncode(repo);
    if ((name === encoded || name.startsWith(`${encoded}-`)) && (!best || encoded.length > best.encoded.length)) best = { slug, encoded };
  }
  return best?.slug || 'other';
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function jsonlIn(dir) {
  return listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}

function logFiles(home, now) {
  const files = [];
  const claude = path.join(home, '.claude', 'projects');
  for (const folder of listDir(claude).filter((e) => e.isDirectory())) for (const file of jsonlIn(path.join(claude, folder.name))) files.push({ harness: 'claude', file });
  const codex = path.join(home, '.codex', 'sessions');
  const oldest = dayOf(now - (RETAIN_DAYS + 1) * DAY_MS);
  for (const y of listDir(codex).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    for (const m of listDir(path.join(codex, y.name)).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
      for (const d of listDir(path.join(codex, y.name, m.name)).filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))) {
        if (`${y.name}-${m.name}-${d.name}` < oldest) continue;
        for (const file of jsonlIn(path.join(codex, y.name, m.name, d.name))) files.push({ harness: 'codex', file });
      }
    }
  }
  files.push({ harness: 'opencode', file: path.join(home, '.local', 'share', 'opencode', 'log', 'opencode.log') });
  const pi = path.join(home, '.pi', 'agent', 'sessions');
  for (const folder of listDir(pi).filter((e) => e.isDirectory())) for (const file of jsonlIn(path.join(pi, folder.name))) files.push({ harness: 'pi', file, folder: folder.name });
  const out = [];
  for (const item of files) {
    try {
      const stat = fs.statSync(item.file);
      if (stat.isFile() && stat.mtimeMs >= now - RETAIN_DAYS * DAY_MS) out.push({ ...item, stat });
    } catch {}
  }
  // The newest files first, so a capped run reads the recent days.
  return out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

// Read the next whole lines of a file within the budget. Returns the lines, the bytes read, and the new offset.
function readLines(file, offset, size, budget, fullBudget) {
  const want = Math.min(size - offset, budget);
  if (want <= 0) return { lines: [], read: 0, offset };
  const buffer = Buffer.alloc(want);
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try { read = fs.readSync(fd, buffer, 0, want, offset); } finally { fs.closeSync(fd); }
  const end = buffer.lastIndexOf(0x0a, read - 1);
  if (end < 0) {
    // A line longer than one whole budget is skipped. A partial last line waits for its newline.
    return { lines: [], read, offset: fullBudget && read === want && want < size - offset ? offset + read : offset };
  }
  return { lines: buffer.subarray(0, end).toString('utf8').split('\n'), read, offset: offset + end + 1 };
}

// Scan the four log sources from the saved offsets. Returns new counts, the next state, and the bytes read.
export function scanDenialLogs({ home = os.homedir(), state = {}, now = Date.now(), repos = readProjectRepos(), budgetBytes = SCAN_BUDGET_BYTES } = {}) {
  const counts = new Map();
  const add = (harness, cause, project, at) => {
    const key = `${dayOf(Number.isFinite(at) ? at : now)}|${harness}|${cause}|${project}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  const previous = state.files || {};
  const files = {};
  const opencode = { pending: { ...(state.opencode?.pending || {}) }, runs: { ...(state.opencode?.runs || {}) } };
  const emitAsk = (ask, unanswered) => {
    const project = opencode.runs[ask.run] || 'other';
    add('opencode', `permission:asked:${ask.type}`, project, ask.at);
    if (unanswered) add('opencode', `permission:unanswered:${ask.type}`, project, ask.at);
  };
  let used = 0;
  let consumed = 0;
  let pendingBytes = 0;
  for (const { harness, file, folder, stat } of logFiles(home, now)) {
    let entry = previous[file];
    if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) entry = { ino: stat.ino, offset: 0 };
    else entry = { ...entry };
    files[file] = entry;
    if (stat.size === entry.offset) continue;
    if (used >= budgetBytes) { pendingBytes += stat.size - entry.offset; continue; }
    const result = readLines(file, entry.offset, stat.size, budgetBytes - used, used === 0);
    used += result.read;
    consumed += result.offset - entry.offset;
    entry.offset = result.offset;
    pendingBytes += stat.size - entry.offset;
    const ctx = {};
    for (const line of result.lines) {
      if (!line) continue;
      if (harness === 'claude') {
        for (const e of parseClaudeLine(line)) add('claude', e.cause, projectFor(e.cwd, repos), e.at);
      } else if (harness === 'codex') {
        for (const e of parseCodexLine(line, ctx)) add('codex', e.cause, e.cwd ? projectFor(e.cwd, repos) : entry.project || 'other', e.at);
        if (ctx.cwd) entry.project = projectFor(ctx.cwd, repos);
      } else if (harness === 'pi') {
        for (const e of parsePiLine(line)) add('pi', e.cause, projectForPiFolder(folder, repos), e.at);
      } else {
        const item = parseOpenCodeLine(line);
        if (!item) continue;
        if (item.run && item.cwd) {
          delete opencode.runs[item.run];
          opencode.runs[item.run] = projectFor(item.cwd, repos);
        }
        if (item.message === 'asking' && item.id) {
          opencode.pending[item.id] = { at: Number.isFinite(item.at) ? item.at : now, type: OPENCODE_TYPES.has(item.type) ? item.type : 'other', run: item.run || null };
        } else if (item.message === 'replied' && item.requestID && opencode.pending[item.requestID]) {
          const ask = opencode.pending[item.requestID];
          // A reply after 10 minutes does not answer the request in time.
          if (!Number.isFinite(item.at) || item.at - ask.at <= UNANSWERED_MS) {
            emitAsk(ask, false);
            delete opencode.pending[item.requestID];
          }
        }
      }
    }
  }
  for (const [id, ask] of Object.entries(opencode.pending)) {
    if (now - ask.at < UNANSWERED_MS) continue;
    emitAsk(ask, true);
    delete opencode.pending[id];
  }
  const runs = Object.keys(opencode.runs);
  for (const run of runs.slice(0, Math.max(0, runs.length - MAX_RUNS))) delete opencode.runs[run];
  const records = [...counts].map(([key, count]) => {
    const [day, harness, cause, project] = key.split('|');
    return { day, harness, cause, project, count };
  });
  return { records, bytes: used, consumed, state: { files, opencode, pendingBytes } };
}

// Add new counts to the stored counts and keep the last 30 days.
export function mergeDenials(existing, added, now = Date.now()) {
  const oldest = dayOf(now - (RETAIN_DAYS - 1) * DAY_MS);
  const map = new Map();
  for (const r of [...existing, ...added]) {
    if (r.day < oldest) continue;
    const key = `${r.day}|${r.harness}|${r.cause}|${r.project}`;
    const row = map.get(key) || { day: r.day, harness: r.harness, cause: r.cause, project: r.project, count: 0 };
    row.count += r.count;
    map.set(key, row);
  }
  return [...map.values()];
}

export function readDenials(dataDir = DATA_DIR) {
  try {
    const rows = JSON.parse(fs.readFileSync(denialsFile(dataDir), 'utf8'));
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.day === 'string' && typeof r.harness === 'string' && typeof r.cause === 'string' && typeof r.project === 'string' && Number.isFinite(r.count)) : [];
  } catch { return []; }
}

export function saveDenials(dataDir, records) {
  const file = denialsFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  fs.chmodSync(`${file}.tmp`, 0o600);
  fs.renameSync(`${file}.tmp`, file);
}

// One scan run: read the logs, then add the counts to denials.json unless write is false.
export function runDenialScan({ home = os.homedir(), dataDir = DATA_DIR, state = {}, now = Date.now(), repos = readProjectRepos(dataDir), budgetBytes = SCAN_BUDGET_BYTES, write = true } = {}) {
  const result = scanDenialLogs({ home, state, now, repos, budgetBytes });
  if (write) saveDenials(dataDir, mergeDenials(readDenials(dataDir), result.records, now));
  return result;
}

// The last 24 hours: today and the part of yesterday inside the window. The mean: the 6 days before that.
function trendOf(byDay, now) {
  const today = byDay.get(dayOf(now)) || 0;
  const yesterday = byDay.get(dayOf(now - DAY_MS)) || 0;
  const elapsed = (now - Date.parse(`${dayOf(now)}T00:00:00Z`)) / DAY_MS;
  const recent = Math.round((today + yesterday * (1 - elapsed)) * 10) / 10;
  let sum = 0;
  for (let n = 2; n <= 7; n += 1) sum += byDay.get(dayOf(now - n * DAY_MS)) || 0;
  const mean = Math.round((sum / 6) * 10) / 10;
  const trend = recent > mean * 1.25 && recent - mean >= 1 ? 'up' : recent < mean * 0.75 ? 'down' : 'flat';
  return { recent, mean, trend, rising: recent > RISE_FACTOR * mean && recent > RISE_MIN_EVENTS };
}

// The dashboard and bulletin view: 7 days by cause and project, harness totals, and the trend per cause.
export function denialSummary(records, now = Date.now(), { pendingBytes = 0 } = {}) {
  const days = Array.from({ length: 7 }, (_, i) => dayOf(now - (6 - i) * DAY_MS));
  const index = new Map(days.map((d, i) => [d, i]));
  const rows = new Map();
  const rowDays = new Map();
  const causeDays = new Map();
  const harnessTotals = {};
  const bump = (map, key, day, count) => {
    if (!map.has(key)) map.set(key, new Map());
    const m = map.get(key);
    m.set(day, (m.get(day) || 0) + count);
  };
  for (const r of records) {
    const key = `${r.harness}|${r.cause}|${r.project}`;
    bump(rowDays, key, r.day, r.count);
    bump(causeDays, r.cause, r.day, r.count);
    if (!index.has(r.day)) continue;
    if (!rows.has(key)) rows.set(key, { harness: r.harness, cause: r.cause, project: r.project, counts: days.map(() => 0), total: 0 });
    const row = rows.get(key);
    row.counts[index.get(r.day)] += r.count;
    row.total += r.count;
    harnessTotals[r.harness] = (harnessTotals[r.harness] || 0) + r.count;
  }
  const rowList = [...rows.entries()].map(([key, row]) => ({ ...row, ...trendOf(rowDays.get(key), now) }))
    .sort((a, b) => b.total - a.total || a.cause.localeCompare(b.cause) || a.project.localeCompare(b.project));
  const causes = [...causeDays.entries()].map(([cause, byDay]) => ({ cause, ...trendOf(byDay, now) })).sort((a, b) => b.recent - a.recent || a.cause.localeCompare(b.cause));
  const catchingUp = pendingBytes > CATCH_UP_BYTES;
  const rising = catchingUp ? [] : causes.filter((c) => c.rising);
  return { days, rows: rowList, harnessTotals, causes, rising, note: rising.length ? DISCUSS_NOTE : null, catchingUp, pendingBytes };
}

// Dry scan: node src/denials.js prints the per-cause totals of all logs in the last 30 days and writes nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const now = Date.now();
  let state = {};
  let bytes = 0;
  let all = [];
  for (;;) {
    const result = scanDenialLogs({ state, now });
    all = mergeDenials(all, result.records, now);
    state = result.state;
    bytes += result.bytes;
    if (!result.consumed) break;
  }
  const byCause = {};
  for (const r of all) byCause[`${r.harness} ${r.cause}`] = (byCause[`${r.harness} ${r.cause}`] || 0) + r.count;
  for (const [cause, count] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(8)}  ${cause}`);
  console.log(`${String(Math.round(bytes / 1024 / 1024)).padStart(8)}  MB read`);
}
