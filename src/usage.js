import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { providerFor } from './control.js';

const FILE = path.join(DATA_DIR, 'usage.jsonl');
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
  return errors;
}

export function readUsage(limit = null) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return (limit == null ? lines : lines.slice(-limit)).map((line) => JSON.parse(line));
}

export function recordUsage(event) {
  const errors = validateUsage(event);
  if (errors.length) return { errors };
  const e = {
    inputTokens: null, outputTokens: null, cachedTokens: null, cost: null,
    ...event,
    provider: event.provider ?? providerFor(event.kind, event.model) ?? 'unmetered-or-unknown',
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

export function readQuotaTrend() {
  let lines = [];
  try { lines = fs.readFileSync(QUOTAS_FILE, 'utf8').trim().split('\n').filter(Boolean); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const byProvider = {};
  for (const line of lines.slice(-3000)) {
    const r = JSON.parse(line);
    if (r.window !== 'secondary') continue;
    (byProvider[r.provider] ||= []).push(r);
  }
  return Object.fromEntries(Object.entries(byProvider).map(([k, rows]) => [k, rows.slice(-288)]));
}
