import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { loadPolicy, providerFor } from './control.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

const FILE = path.join(DATA_DIR, 'usage.jsonl');
export const USAGE_FILE = FILE;
const QUOTAS_FILE = path.join(DATA_DIR, 'quota-history.jsonl');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateUsage(e) {
  const errors = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['usage event must be an object.'];
  if (!SLUG.test(e.project || '')) errors.push('project must be a slug.');
  for (const k of ['kind', 'model', 'startedAt', 'endedAt', 'outcome']) if (typeof e[k] !== 'string' || !e[k]) errors.push(`${k} must be a non-empty string.`);
  for (const k of ['inputTokens', 'outputTokens', 'cachedTokens', 'cost']) if (e[k] != null && (!Number.isFinite(e[k]) || e[k] < 0)) errors.push(`${k} must be null or a non-negative number.`);
  if (Number.isNaN(Date.parse(e.startedAt)) || Number.isNaN(Date.parse(e.endedAt))) errors.push('startedAt and endedAt must be ISO times.');
  if (e.id != null && (typeof e.id !== 'string' || e.id.length > 240)) errors.push('id must be a short string.');
  if (e.tokenSource != null && !['measured', 'unavailable'].includes(e.tokenSource)) errors.push('tokenSource must be null, measured, or unavailable.');
  if (Object.hasOwn(e, 'defects') && (!Number.isInteger(e.defects) || e.defects < 0 || e.defects > 99)) errors.push('defects must be an integer from 0 to 99.');
  if (e.modelOutcome != null) {
    const outcome = e.modelOutcome;
    if (!isObject(outcome)) errors.push('modelOutcome must be null or an object.');
    else {
      for (const field of ['kind', 'model']) if (!isText(outcome[field])) errors.push(`modelOutcome.${field} must be a non-empty string.`);
      if (!['first-time', 'rework', 'failed'].includes(outcome.result)) errors.push('modelOutcome.result must be first-time, rework, or failed.');
      if (typeof outcome.reason !== 'string') errors.push('modelOutcome.reason must be a string.');
      else if (outcome.reason.length > 200) errors.push('modelOutcome.reason must be at most 200 characters.');
    }
  }
  return errors;
}

export function readUsage(limit = null) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return (limit == null ? lines : lines.slice(-limit)).map((line) => JSON.parse(line));
}

export function usageProvider(event, policy = loadPolicy()) {
  if (Object.hasOwn(event, 'provider')) return event.provider ?? 'unmetered-or-unknown';
  return providerFor(event.kind, event.model, policy) ?? 'unmetered-or-unknown';
}

export function recordUsage(event) {
  const errors = validateUsage(event);
  if (errors.length) return { errors };
  const e = {
    inputTokens: null, outputTokens: null, cachedTokens: null, cost: null,
    ...event,
    provider: usageProvider(event),
    recordedAt: new Date().toISOString(),
  };
  if (e.id && readUsage().some((old) => old.id === e.id)) return { errors: [], duplicate: true };
  fs.appendFileSync(FILE, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  return { errors: [], duplicate: false, event: e };
}

export function usageSummary(events = readUsage()) {
  const byProject = {};
  const byProvider = {};
  for (const e of events) {
    for (const [bucket, key] of [[byProject, e.project], [byProvider, e.provider]]) {
      const row = bucket[key] ||= { runs: 0, measuredRuns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, workMinutes: 0, outcomes: {} };
      row.runs++;
      if (e.inputTokens != null || e.outputTokens != null) row.measuredRuns++;
      for (const k of ['inputTokens', 'outputTokens', 'cachedTokens', 'cost']) row[k] += e[k] || 0;
      row.workMinutes += Math.max(0, (Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60000);
      row.outcomes[e.outcome] = (row.outcomes[e.outcome] || 0) + 1;
    }
  }
  return { byProject, byProvider, recent: events.slice(-100).reverse(), quotaTrend: readQuotaTrend() };
}

export function recordQuotaSnapshot(quotas, at = new Date().toISOString()) {
  const rows = quotas.filter((q) => !q.error).flatMap((q) => (q.windows || []).filter((w) => !w.extra).map((w) => ({
    at, provider: q.provider, window: w.key, usedPercent: w.usedPercent,
    expectedPercent: w.expectedPercent, resetsAt: w.resetsAt, willLast: w.willLast,
  })));
  if (rows.length) fs.appendFileSync(QUOTAS_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
}

export function readQuotaHistory({ file = QUOTAS_FILE, since = null } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const rows = (since ? lines : lines.slice(-3000)).map((line) => JSON.parse(line));
  return since ? rows.filter((row) => Date.parse(row.at) >= Date.parse(since)) : rows;
}

// Measure quota use since the first matching sample of the UTC day or the current window reset.
export function quotaUsageToday(quotas, history, now = Date.now()) {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  history ??= readQuotaHistory({ since: new Date(dayStart).toISOString() });
  const result = {};
  for (const quota of quotas || []) {
    const windows = {};
    for (const window of quota.windows || []) {
      if (window.extra || !window.key || !Number.isFinite(window.usedPercent)) continue;
      const resetAt = Date.parse(window.resetsAt);
      const rows = (history || []).filter((row) => {
        const at = Date.parse(row.at);
        if (row.provider !== quota.provider || row.window !== window.key || !Number.isFinite(at) || at < dayStart || at > now) return false;
        const rowResetAt = Date.parse(row.resetsAt);
        return !Number.isFinite(resetAt) || !Number.isFinite(rowResetAt) || rowResetAt === resetAt;
      }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const base = rows.find((row) => Number.isFinite(row.usedPercent));
      windows[window.key] = base ? Math.max(0, window.usedPercent - base.usedPercent) : 0;
    }
    result[quota.provider] = windows;
  }
  return result;
}

export function readQuotaTrend() {
  const byProvider = {};
  for (const r of readQuotaHistory()) {
    if (r.window !== 'secondary') continue;
    (byProvider[r.provider] ||= []).push(r);
  }
  return Object.fromEntries(Object.entries(byProvider).map(([k, rows]) => [k, rows.slice(-288)]));
}

// A worker run record has null token fields until a harness log gives the counts. Match each such record to the
// worker logs by harness, project, worker name, and time. Fill the counts from the matching logs.
// A record with no log after the grace time gets tokenSource "unavailable". Nothing else in the record changes.
const RUN_ID = /^worker:([a-z0-9][a-z0-9-]{0,63}):([^:]+):/;
const START_SLACK_MS = 2 * 60 * 1000;
const END_SLACK_MS = 5 * 60 * 1000;
const UNAVAILABLE_AFTER_MS = 24 * 60 * 60 * 1000;

export function fillMeasuredUsage({ file = FILE, runs = [], now = Date.now(), priceOf = () => null, aliases = {} } = {}) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { if (e.code === 'ENOENT') return { filled: 0, unavailable: 0 }; throw e; }
  let filled = 0;
  let unavailable = 0;
  // Each log goes to one run at most, and each run takes one log. The pairs go in order of the gap between
  // the run start and the first message of the log. The closest pair goes first.
  const rows = [];
  lines.forEach((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (!row || row.inputTokens != null || row.outputTokens != null || row.tokenSource) return;
    const id = RUN_ID.exec(row.id || '');
    const start = Date.parse(row.startedAt);
    const end = Date.parse(row.endedAt);
    if (!id || !Number.isFinite(start) || !Number.isFinite(end)) return;
    rows.push({ index, row, id, start, end });
  });
  const pairs = [];
  for (const item of rows) {
    const names = new Set([item.id[1], ...(aliases[item.id[1]] || [])]);
    for (const run of runs) {
      if (run.harness === item.row.kind && run.worker === item.id[2] && names.has(run.project)
        && run.first != null && run.first >= item.start - START_SLACK_MS && run.first <= item.end + END_SLACK_MS) {
        pairs.push({ item, run, gap: Math.abs(run.first - item.start) });
      }
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.item.index - b.item.index);
  const takenRuns = new Set();
  const matched = new Map();
  for (const { item, run } of pairs) {
    if (takenRuns.has(run) || matched.has(item.index)) continue;
    takenRuns.add(run);
    matched.set(item.index, run);
  }
  const replaced = new Map();
  for (const { index, row, end } of rows) {
    const run = matched.get(index);
    if (!run) {
      if (now - end < UNAVAILABLE_AFTER_MS) continue;
      unavailable += 1;
      replaced.set(index, JSON.stringify({ ...row, tokenSource: 'unavailable' }));
      continue;
    }
    if (!run.complete) continue;
    let input = 0; let output = 0; let cached = 0; let cost = 0; let priced = true;
    for (const [model, u] of Object.entries(run.models)) {
      input += u.input + u.cacheWrite;
      output += u.output;
      cached += u.cacheRead;
      const price = priceOf(run.harness, model);
      const total = u.input + u.output + u.cacheRead + u.cacheWrite;
      if ((u.costTokens || 0) >= total && total > 0) cost += u.logCost || 0;
      else if (price) cost += (u.input * price.input + u.output * price.output + u.cacheRead * (price.cacheRead ?? price.input) + u.cacheWrite * (price.cacheWrite ?? price.input)) / 1e6;
      else priced = false;
    }
    filled += 1;
    replaced.set(index, JSON.stringify({ ...row, inputTokens: input, outputTokens: output, cachedTokens: cached, cost: priced ? cost : null, tokenSource: 'measured' }));
  }
  const out = lines.map((line, index) => replaced.get(index) ?? line);
  if (filled || unavailable) {
    fs.writeFileSync(`${file}.tmp`, out.join('\n'), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  return { filled, unavailable };
}
