import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { redactSecrets } from './redact.js';
import { openMessageStore } from './message-store.js';
import { readProjectRepos } from './harness.js';
import { loadProjectConfig } from './kit/config.js';

export const AGENT_MESSAGE_KINDS = Object.freeze(['task', 'nudge', 'report', 'reminder', 'reply', 'other']);
export const AGENT_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TELL_KINDS = new Set(['task', 'nudge', 'reminder', 'reply']);
const META_FILE = 'agent-message-meta.jsonl';
const REPORT_FILE = 'agent-report-recorded.jsonl';
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const RESPONSE_INDEXES = new Map();

const clone = (value) => JSON.parse(JSON.stringify(value));
const messageDate = (record) => Date.parse(record?.createdAt ?? record?.at);
const rowDate = (row) => Date.parse(row?.at);
const paneId = (pane) => pane?.pane_id ?? pane?.paneId ?? pane?.id ?? null;
const paneWorkspace = (pane) => pane?.workspace_id ?? pane?.workspaceId ?? pane?.workspace ?? null;
const listRows = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('The agent message metadata store is locked. Try again.');
      pause(20);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row); } catch {}
  }
  return rows;
}

function readJsonlFromEndSince(file, sinceMs) {
  let fd;
  const reverseRows = [];
  let cursor = 0;
  let pending = Buffer.alloc(0);
  let stopped = false;
  try {
    fd = fs.openSync(file, 'r');
    cursor = fs.fstatSync(fd).size;
    while (cursor > 0 && !stopped) {
      const start = Math.max(0, cursor - 65536);
      const length = cursor - start;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, start);
      const combined = pending.length ? Buffer.concat([chunk, pending]) : chunk;
      let end = combined.length;
      for (;;) {
        const newline = combined.lastIndexOf(10, end - 1);
        if (newline < 0) break;
        const line = combined.subarray(newline + 1, end);
        end = newline;
        if (!line.length) continue;
        let event;
        try { event = JSON.parse(line.toString('utf8')); } catch { continue; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        if (!['respondedAt', 'status'].includes(event._update)
          && Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) < sinceMs) {
          stopped = true;
          break;
        }
        reverseRows.push(event);
      }
      pending = stopped ? Buffer.alloc(0) : combined.subarray(0, end);
      cursor = start;
    }
    if (!stopped && cursor === 0 && pending.length) {
      try {
        const event = JSON.parse(pending.toString('utf8'));
        if (event && typeof event === 'object' && !Array.isArray(event)
          && (!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) >= sinceMs)) reverseRows.push(event);
      } catch {}
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return reverseRows.reverse();
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function metaPath(dir) { return path.join(dir, META_FILE); }
function reportPath(dir) { return path.join(dir, REPORT_FILE); }

function validAddress(address) {
  return !!address && typeof address === 'object' && !Array.isArray(address)
    && ['boss', 'orch', 'worker', 'service', 'unknown'].includes(address.role)
    && ['project', 'name', 'pane'].every((key) => address[key] == null || (typeof address[key] === 'string' && address[key].length <= 256));
}

function addressKey(address) {
  if (address.role === 'service') return 'service';
  if (address.role === 'boss') return 'boss';
  if (address.role === 'orch') return `orch:${address.project || 'unknown'}`;
  if (address.role === 'worker') return `worker:${address.name || address.pane || 'unknown'}`;
  return `unknown:${address.name || address.pane || address.project || 'unknown'}`;
}

export function pairKeyForAgents(from, to) {
  if (!validAddress(from) || !validAddress(to)) throw new Error('Agent message endpoints need role, project, name, and pane fields.');
  return [addressKey(from), addressKey(to)].sort().join('+');
}

function projectFor(from, to) { return from.project || to.project || null; }

function appendMetadata(row, { dir, now = Date.now() }) {
  const file = metaPath(dir);
  const signatures = withFileLock(file, () => {
    const before = fileSignature(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { before, after: fileSignature(file) };
  });
  noteLocalMetadataEvent(dir, row, signatures, now);
}

function foldMetadataEvents(events) {
  const rows = new Map();
  for (const event of events) {
    if (event._update === 'respondedAt') {
      const row = rows.get(event.id);
      if (row && !row.respondedAt && Number.isFinite(Date.parse(event.respondedAt))) row.respondedAt = event.respondedAt;
    } else if (event._update === 'status') {
      const row = rows.get(event.id);
      if (row && ['delivered', 'failed'].includes(event.status)) row.status = event.status;
    } else if (typeof event.id === 'string') {
      rows.set(event.id, event);
    }
  }
  for (const row of rows.values()) {
    row.responseMs = row.respondedAt ? Math.max(0, Date.parse(row.respondedAt) - rowDate(row)) : null;
  }
  return [...rows.values()];
}

function foldedMetadata(file, { since = null } = {}) {
  const sinceMs = since == null ? null : Date.parse(since);
  return foldMetadataEvents(Number.isFinite(sinceMs) ? readJsonlFromEndSince(file, sinceMs) : readJsonl(file));
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameSignature(left, right) {
  return left === null || right === null ? left === right : left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function responseIndexKey(dir) { return path.resolve(dir); }

function responseIndex(dir) {
  const key = responseIndexKey(dir);
  let state = RESPONSE_INDEXES.get(key);
  if (!state) {
    state = { rows: new Map(), signature: null, initialized: false, dirty: false };
    RESPONSE_INDEXES.set(key, state);
  }
  return state;
}

function isResponseIndexRow(row, now) {
  const at = rowDate(row);
  return typeof row?.id === 'string' && !!row.id && !row.respondedAt
    && Number.isFinite(at) && at <= now && now - at < AGENT_RESPONSE_WINDOW_MS
    && validAddress(row.to) && row.status !== 'failed';
}

function responseIndexRow(row) {
  return {
    id: row.id, at: row.at, from: row.from, to: row.to, kind: row.kind,
    status: row.status, source: row.source, targetStatus: row.targetStatus,
  };
}

function replaceResponseIndex(state, rows, signature, now) {
  state.rows = new Map(rows.filter((row) => isResponseIndexRow(row, now)).map((row) => [row.id, responseIndexRow(row)]));
  state.signature = signature;
  state.initialized = true;
  state.dirty = false;
}

function noteLocalMetadataEvent(dir, event, signatures, now = Date.now()) {
  const state = RESPONSE_INDEXES.get(responseIndexKey(dir));
  if (!state?.initialized) return;
  if (state.dirty || !sameSignature(state.signature, signatures.before)) {
    state.dirty = true;
    return;
  }
  if (event._update === 'respondedAt') {
    state.rows.delete(event.id);
  } else if (event._update === 'status') {
    const row = state.rows.get(event.id);
    if (row) {
      row.status = event.status;
      if (event.status === 'failed') state.rows.delete(event.id);
    }
  } else if (isResponseIndexRow(event, now)) {
    state.rows.set(event.id, responseIndexRow(event));
  }
  state.signature = signatures.after;
}

function rebuildResponseIndexLocked(state, file, now) {
  const rows = foldedMetadata(file);
  replaceResponseIndex(state, rows, fileSignature(file), now);
}

function pruneResponseIndex(state, now) {
  for (const [id, row] of state.rows) {
    if (!isResponseIndexRow(row, now)) state.rows.delete(id);
  }
}

// Load the small set of response candidates at service start. Later ticks check only the file signature.
export function initializeAgentResponseIndex({ dir = DATA_DIR, now = Date.now() } = {}) {
  const file = metaPath(dir);
  const state = responseIndex(dir);
  const current = fileSignature(file);
  if (state.initialized && !state.dirty && sameSignature(state.signature, current)) {
    pruneResponseIndex(state, now);
    return state.rows.size;
  }
  return withFileLock(file, () => {
    const locked = fileSignature(file);
    if (!state.initialized || state.dirty || !sameSignature(state.signature, locked)) rebuildResponseIndexLocked(state, file, now);
    pruneResponseIndex(state, now);
    return state.rows.size;
  });
}

export function updateAgentMessageRespondedAt(id, respondedAt, { dir = DATA_DIR } = {}) {
  if (typeof id !== 'string' || !id || (respondedAt !== null && (typeof respondedAt !== 'string' || !Number.isFinite(Date.parse(respondedAt))))) {
    throw new Error('Agent metadata response updates need a message ID and ISO timestamp or null.');
  }
  const file = metaPath(dir);
  return withFileLock(file, () => {
    const rows = foldedMetadata(file);
    const row = rows.find((item) => item.id === id);
    if (!row || row.respondedAt || respondedAt === null || Date.parse(respondedAt) < rowDate(row)) return false;
    const state = RESPONSE_INDEXES.get(responseIndexKey(dir));
    const before = fileSignature(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ id, _update: 'respondedAt', respondedAt })}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    if (state?.initialized) {
      if (state.dirty || !sameSignature(state.signature, before)) state.dirty = true;
      else {
        state.rows.delete(id);
        state.signature = fileSignature(file);
      }
    }
    return true;
  });
}

function sameAgent(target, sender) {
  if (target?.pane) return target.pane === sender?.pane;
  return target?.role === sender?.role && target?.project === sender?.project
    && (target?.name ? target.name === sender?.name : target?.role === 'orch' || target?.role === 'boss');
}

function updateResponsesLocked(file, state, { panes, observed, now }) {
  const current = fileSignature(file);
  if (!state.initialized || state.dirty || !sameSignature(state.signature, current)) rebuildResponseIndexLocked(state, file, now);
  pruneResponseIndex(state, now);
  if (!state.rows.size) return { updated: 0, observed: {} };

  const tells = new Map();
  for (const row of state.rows.values()) {
    if (row.source !== 'tell' || row.status !== 'delivered' || !validAddress(row.from)) continue;
    const key = row.from?.pane || addressKey(row.from);
    if (!tells.has(key)) tells.set(key, []);
    tells.get(key).push(row);
  }
  for (const outgoing of tells.values()) outgoing.sort((a, b) => rowDate(a) - rowDate(b));
  const live = new Map(panes.filter((pane) => pane.agent).map((pane) => [pane.id, pane]));
  const next = {};
  const updates = [];
  for (const row of state.rows.values()) {
    if (row.source === 'tell' && row.status !== 'delivered') continue;
    const at = rowDate(row);
    const pane = live.get(row.to?.pane);
    const active = observed[row.id]?.active || ['working', 'blocked'].includes(row.targetStatus)
      || ['working', 'blocked'].includes(pane?.status);
    next[row.id] = { active: !!active };
    const idleAt = active && ['idle', 'done'].includes(pane?.status) ? now : Infinity;
    const outgoing = tells.get(row.to?.pane || addressKey(row.to)) || [];
    const reply = outgoing.find((item) => rowDate(item) >= at && rowDate(item) <= now && item.id !== row.id && sameAgent(row.to, item.from));
    const responseAt = Math.min(idleAt, reply ? rowDate(reply) : Infinity);
    if (!Number.isFinite(responseAt)) continue;
    updates.push({ id: row.id, _update: 'respondedAt', respondedAt: new Date(responseAt).toISOString() });
    delete next[row.id];
  }
  if (updates.length) {
    fs.appendFileSync(file, updates.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    for (const row of updates) state.rows.delete(row.id);
    state.signature = fileSignature(file);
  }
  return { updated: updates.length, observed: next };
}

// Use a fresh pane snapshot and successful tell rows. A response is written once, within 24 hours.
export function updateAgentResponses({ dir = DATA_DIR, panes = [], observed = {}, now = Date.now() } = {}) {
  const file = metaPath(dir);
  const state = responseIndex(dir);
  const current = fileSignature(file);
  if (state.initialized && !state.dirty && sameSignature(state.signature, current)) {
    pruneResponseIndex(state, now);
    if (!state.rows.size) return { updated: 0, observed: {} };
  }
  return withFileLock(file, () => updateResponsesLocked(file, state, { panes, observed, now }));
}

export function recordAgentMessage(fields, { dir = DATA_DIR, now = Date.now() } = {}) {
  const { from, to } = fields || {};
  if (!validAddress(from) || !validAddress(to)) throw new Error('Agent message endpoints need role, project, name, and pane fields.');
  if (!AGENT_MESSAGE_KINDS.includes(fields.kind)) throw new Error(`Agent message kind must be one of ${AGENT_MESSAGE_KINDS.join(', ')}.`);
  if (!['delivered', 'failed', 'recorded'].includes(fields.status ?? 'recorded')) throw new Error('Agent message status must be delivered, failed, or recorded.');
  const text = typeof fields.text === 'string' ? fields.text : '';
  if (!text.trim()) throw new Error('The agent message text is empty.');
  const at = new Date(now).toISOString();
  const pairKey = pairKeyForAgents(from, to);
  const store = openMessageStore({ dir });
  const record = store.append({
    thread: null,
    from: clone(from),
    to: clone(to),
    kind: 'agent',
    agentKind: fields.kind,
    pairKey,
    text: redactSecrets(text),
    createdAt: at,
    status: fields.status ?? 'recorded',
    replyTo: fields.replyTo ?? null,
    taskId: fields.taskId == null ? null : String(fields.taskId),
    runId: fields.runId == null ? null : String(fields.runId),
    ...(fields.reportMtimeMs == null ? {} : { reportMtimeMs: fields.reportMtimeMs }),
  }, { now });
  const row = {
    id: record.id,
    at,
    from: clone(from),
    to: clone(to),
    project: projectFor(from, to),
    kind: fields.kind,
    chars: text.length,
    taskId: fields.taskId == null ? null : String(fields.taskId),
    runId: fields.runId == null ? null : String(fields.runId),
    respondedAt: null,
    status: fields.status ?? 'recorded',
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.targetStatus ? { targetStatus: fields.targetStatus } : {}),
  };
  appendMetadata(row, { dir, now });
  return record;
}

function recordsForProject(records, project) {
  return records.filter((record) => record.kind === 'agent' && (project == null || record.from?.project === project || record.to?.project === project));
}

export function readAgentMessages({ dir = DATA_DIR, project = null, pair = null, q = null, limit = 100, before = null } = {}) {
  let records = recordsForProject(openMessageStore({ dir }).all(), project);
  if (pair != null) records = records.filter((record) => record.pairKey === pair);
  if (q != null && String(q).trim()) {
    const query = String(q).toLocaleLowerCase();
    records = records.filter((record) => String(record.text ?? '').toLocaleLowerCase().includes(query));
  }
  records.sort((left, right) => messageDate(right) - messageDate(left) || right.id.localeCompare(left.id));
  if (before != null) {
    const cursor = records.findIndex((record) => record.id === before);
    if (cursor < 0) return [];
    records = records.slice(cursor + 1);
  }
  return records.slice(0, Math.max(0, Math.floor(limit))).map(clone);
}

export function listAgentPairs({ dir = DATA_DIR, project = null } = {}) {
  const pairs = new Map();
  for (const record of recordsForProject(openMessageStore({ dir }).all(), project)) {
    const current = pairs.get(record.pairKey) || { pairKey: record.pairKey, count: 0, lastAt: null };
    current.count += 1;
    const at = record.createdAt ?? record.at;
    if (!current.lastAt || Date.parse(at) > Date.parse(current.lastAt)) current.lastAt = at;
    pairs.set(record.pairKey, current);
  }
  return [...pairs.values()].sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt) || left.pairKey.localeCompare(right.pairKey));
}

export function readAgentMetadata({ dir = DATA_DIR, project = null, since = null, until = null, limit = 200 } = {}) {
  let rows = foldedMetadata(metaPath(dir), { since });
  if (project != null) rows = rows.filter((row) => row.project === project);
  if (since != null) rows = rows.filter((row) => rowDate(row) >= Date.parse(since));
  if (until != null) rows = rows.filter((row) => rowDate(row) <= Date.parse(until));
  rows.sort((left, right) => rowDate(right) - rowDate(left) || String(right.id).localeCompare(String(left.id)));
  return rows.slice(0, Math.max(0, Math.floor(limit))).map(clone);
}

export function sweepAgentMessages({ dir = DATA_DIR, retentionDays = 14, metaRetentionDays = 180, now = Date.now() } = {}) {
  const textCutoff = now - retentionDays * 86400000;
  const store = openMessageStore({ dir });
  const textDeleted = store.mutate((records) => {
    const kept = records.filter((record) => record.kind !== 'agent' || messageDate(record) >= textCutoff);
    return { records: kept, result: records.length - kept.length };
  }, { now });
  const metaCutoff = now - metaRetentionDays * 86400000;
  const file = metaPath(dir);
  const rowsDeleted = withFileLock(file, () => {
    const rows = foldedMetadata(file);
    const kept = rows.filter((row) => rowDate(row) >= metaCutoff);
    writeJsonl(file, kept);
    const state = RESPONSE_INDEXES.get(responseIndexKey(dir));
    if (state?.initialized) replaceResponseIndex(state, kept, fileSignature(file), now);
    return rows.length - kept.length;
  });
  const seenFile = reportPath(dir);
  withFileLock(seenFile, () => {
    const seen = readJsonl(seenFile).filter((row) => rowDate({ at: row.at }) >= metaCutoff);
    writeJsonl(seenFile, seen);
  });
  return { textDeleted, rowsDeleted };
}

export function workerRunId(run, project = run?.project) {
  if (!run?.name || !run?.startedAt) return null;
  return `worker:${project || 'unknown'}:${run.name}:${run.startedAt}`;
}

export function recordWorkerReport({ project, name, pane, taskId = null, runId, mtimeMs, summary, toPane = null }, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!runId || !Number.isFinite(mtimeMs)) return null;
  const file = reportPath(dir);
  return withFileLock(file, () => {
    const seen = readJsonl(file);
    if (seen.some((row) => row.runId === runId && row.mtimeMs === mtimeMs)) return null;
    const marker = { runId, mtimeMs, id: null, at: new Date(now).toISOString() };
    seen.push(marker);
    writeJsonl(file, seen);
    try {
      const record = recordAgentMessage({
        from: { role: 'worker', project, name: name || null, pane: pane || null },
        to: { role: 'orch', project, name: null, pane: toPane },
        text: String(summary ?? '').slice(0, 2000) || '(empty report summary)',
        kind: 'report', status: 'recorded', taskId, runId, reportMtimeMs: mtimeMs,
      }, { dir, now });
      marker.id = record.id;
      writeJsonl(file, seen);
      return record;
    } catch (error) {
      writeJsonl(file, seen.filter((row) => row !== marker));
      throw error;
    }
  });
}

function projectForWorkspace(control, workspace) {
  return Object.values(control?.projects || {}).find((project) => project?.workspace === workspace)?.slug ?? null;
}

function readRuns({ runs, control, dataDir }) {
  if (Array.isArray(runs)) return runs;
  const result = [];
  for (const entry of readProjectRepos(dataDir)) {
    let config;
    try { config = loadProjectConfig({ cwd: entry.repo }); } catch { continue; }
    let files;
    try { files = fs.readdirSync(config.runsPath); } catch { continue; }
    for (const filename of files) {
      if (!filename.endsWith('.json')) continue;
      const file = path.join(config.runsPath, filename);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const run = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (run && typeof run === 'object' && run.pane) result.push({ ...run, project: entry.slug });
      } catch {}
    }
  }
  return result;
}

function verifyAgentCaller(env, herdr, control, runs) {
  if (env.HERDR_ENV !== '1') throw new Error('Run herdr-boss tell from a Herdr-managed pane (HERDR_ENV=1).');
  const id = env.HERDR_PANE_ID;
  const workspace = env.HERDR_WORKSPACE_ID;
  if (!id || !workspace) throw new Error('Cannot verify the caller pane: HERDR_PANE_ID and HERDR_WORKSPACE_ID are required.');
  let pane;
  try { pane = herdr(['pane', 'get', id])?.pane; }
  catch (error) { throw new Error(`Cannot verify the caller pane: ${error.message}`); }
  if (!pane || paneId(pane) !== id) throw new Error('Cannot verify the caller pane: Herdr returned a different pane.');
  if (paneWorkspace(pane) !== workspace) throw new Error('Cannot verify the caller pane: the workspace does not match.');
  if (pane.label === 'boss') return { role: 'boss', project: null, name: null, pane: id };
  if (pane.label === 'orch') return { role: 'orch', project: projectForWorkspace(control, workspace), name: null, pane: id };
  const run = runs.find((item) => item.pane === id && !item.finishedAt);
  if (run) return { role: 'worker', project: run.project || projectForWorkspace(control, workspace), name: run.name || pane.name || null, pane: id, runId: workerRunId(run, run.project || projectForWorkspace(control, workspace)), taskId: run.taskId ?? run.issue ?? null };
  return { role: 'unknown', project: projectForWorkspace(control, workspace), name: pane.name || pane.agent_name || null, pane: id };
}

function resolveTarget(target, herdr, control, runs = []) {
  const projects = control?.projects;
  const project = projects && Object.hasOwn(projects, target) ? projects[target] : null;
  if (project) {
    const id = project.orch?.pane;
    if (!id) throw new Error(`Project ${target} has no open orchestrator pane.`);
    let pane;
    try { pane = herdr(['pane', 'get', id])?.pane; } catch (error) { throw new Error(`Cannot resolve project ${target}: ${error.message}`); }
    if (!pane || paneId(pane) !== id || pane.label !== 'orch') throw new Error(`Project ${target} does not have a live pane labeled orch.`);
    return { ...targetAddress(pane, control, runs), project: project.slug || target };
  }

  try {
    const direct = herdr(['pane', 'get', target])?.pane;
    if (direct && paneId(direct) === target) return targetAddress(direct, control, runs);
  } catch {}

  let panes;
  try { panes = listRows(herdr(['pane', 'list']), 'panes'); } catch { panes = []; }
  let pane = panes.find((item) => (item.name || item.agent_name || item.agent) === target);
  if (!pane) {
    let agents = [];
    try { agents = listRows(herdr(['agent', 'list']), 'agents'); } catch {}
    const agent = agents.find((item) => (item.name || item.agent_name) === target);
    if (agent) pane = panes.find((item) => paneId(item) === (agent.pane_id || agent.pane || agent.paneId));
  }
  if (!pane || !paneId(pane)) throw new Error(`No pane or agent named ${target} is available.`);
  return targetAddress(pane, control, runs);
}

function targetAddress(pane, control, runs = []) {
  const id = paneId(pane);
  const project = projectForWorkspace(control, paneWorkspace(pane));
  const run = runs.find((item) => item.pane === id && !item.finishedAt);
  const details = {
    ...(run?.kind || typeof pane.agent === 'string' ? { kind: run?.kind || pane.agent } : {}),
    ...(run?.model || pane.model ? { model: run?.model || pane.model } : {}),
    ...(pane.agent_status || pane.status ? { status: pane.agent_status || pane.status } : {}),
  };
  if (pane.label === 'boss') return { role: 'boss', project: null, name: null, pane: id, ...details };
  if (pane.label === 'orch') return { role: 'orch', project, name: pane.name || pane.agent_name || null, pane: id, ...details };
  if (run) return { role: 'worker', project: run.project || project, name: run.name || pane.name || null, pane: id, ...details,
    taskId: run.taskId ?? run.issue ?? null, runId: workerRunId(run, run.project || project) };
  return { role: 'unknown', project, name: pane.name || pane.agent_name || pane.agent || null, pane: id };
}

export function tellAgent(target, text, { env = process.env, herdr, control = {}, runs = null, dir = DATA_DIR, dataDir = dir, kind = 'task', replyTo = null, now = Date.now() } = {}) {
  if (!TELL_KINDS.has(kind)) return { exitCode: 2, reason: `--kind must be one of ${[...TELL_KINDS].join(', ')}.` };
  if (typeof text !== 'string' || !text.trim()) return { exitCode: 1, reason: 'The agent message text is empty.' };
  let record;
  try {
    const runRows = readRuns({ runs, control, dataDir });
    const from = verifyAgentCaller(env, herdr, control, runRows);
    const to = resolveTarget(String(target), herdr, control, runRows);
    record = recordAgentMessage({ from, to, text, kind, status: 'recorded', source: 'tell', targetStatus: to.status,
      replyTo, taskId: from.taskId ?? to.taskId, runId: from.runId ?? to.runId }, { dir, now });
  } catch (error) { return { exitCode: 1, reason: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200) }; }
  try {
    const response = herdr(['agent', 'prompt', record.to.pane, text]);
    if (response?.error || response?.ok === false) throw new Error(response.error || 'Herdr refused the prompt.');
    const updated = openMessageStore({ dir }).update(record.id, { status: 'delivered' }, { now });
    let metadataWarning;
    try { appendMetadata({ id: record.id, _update: 'status', status: 'delivered' }, { dir, now }); }
    catch { metadataWarning = 'The prompt was delivered. Its metadata status could not be saved.'; }
    return { exitCode: 0, record: updated || { ...record, status: 'delivered' }, ...(metadataWarning ? { metadataWarning } : {}) };
  } catch (error) {
    const reason = 'Herdr could not deliver the prompt.';
    const updated = openMessageStore({ dir }).update(record.id, { status: 'failed' }, { now });
    let metadataWarning;
    try { appendMetadata({ id: record.id, _update: 'status', status: 'failed' }, { dir, now }); }
    catch { metadataWarning = 'The metadata status could not be saved.'; }
    return { exitCode: 1, record: updated || { ...record, status: 'failed' }, reason, ...(metadataWarning ? { metadataWarning } : {}) };
  }
}
