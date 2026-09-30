import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const MACHINE_SAMPLES_FILE = 'machine-samples.jsonl';
export const MACHINE_SAMPLES_ROTATED_FILE = 'machine-samples.1.jsonl';
export const MACHINE_SAMPLES_MAX_BYTES = 3 * 1024 * 1024;

const num = (value, digits = null) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  return digits === null ? Number(value) : +Number(value).toFixed(digits);
};
const kinds = (entries) => (entries || []).map((entry) => (typeof entry?.kind === 'string' && entry.kind ? entry.kind : 'unknown'));

// One line for one minute. The line holds numbers, kinds, and counts only: no project name, pane id, path, or command.
export function sampleLine({ machine, holders = [], waiters = [], now = Date.now() } = {}) {
  const load = machine?.load || [];
  const cpus = num(machine?.cpus);
  const cpuTotal = num(machine?.cpuTotalSample);
  return {
    at: new Date(Math.floor(now / 60000) * 60000).toISOString(),
    l1: num(load[0]), l5: num(load[1]), l15: num(load[2]),
    cpus,
    cpu: cpuTotal !== null && cpus ? num(cpuTotal / cpus, 1) : null,
    memFree: num(machine?.memFreePercent),
    memGB: num(machine?.memTotalGB),
    swapMB: num(machine?.swapUsedMB),
    swapTotalMB: num(machine?.swapTotalMB),
    holders: kinds(holders),
    waiters: (waiters || []).length,
    waiterKinds: kinds(waiters),
  };
}

// Append only. A failure is swallowed, so a write never stops or slows a tick.
export function appendMachineSample(line, { dataDir = DATA_DIR, maxBytes = MACHINE_SAMPLES_MAX_BYTES } = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, MACHINE_SAMPLES_FILE);
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, path.join(dataDir, MACHINE_SAMPLES_ROTATED_FILE));
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

// Reads the rotated file and the current file, oldest first. A line that does not parse is skipped.
export function readMachineSamples({ dataDir = DATA_DIR, sinceMs = null } = {}) {
  const lines = [];
  for (const name of [MACHINE_SAMPLES_ROTATED_FILE, MACHINE_SAMPLES_FILE]) {
    let text;
    try { text = fs.readFileSync(path.join(dataDir, name), 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      const at = Date.parse(line?.at);
      if (!Number.isFinite(at) || (sinceMs !== null && at < sinceMs)) continue;
      lines.push(line);
    }
  }
  return lines;
}

export const MACHINE_HOURS_MAX_DAYS = 14;
const DAY_MS = 86400000;

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const swapPercent = (line) => {
  const used = finite(line.swapMB);
  const total = finite(line.swapTotalMB);
  return used !== null && total !== null && total > 0 ? (used / total) * 100 : null;
};

// Overload: swap above 90 percent with at least 1 GB in use, or a 5-minute load above 3 times the cores.
export function isOverloadSample(line) {
  const pct = swapPercent(line);
  if (pct !== null && pct > 90 && line.swapMB >= 1024) return true;
  const l5 = finite(line.l5);
  const cpus = finite(line.cpus);
  return l5 !== null && cpus !== null && cpus > 0 && l5 > 3 * cpus;
}

// Idle wait: the full-suite queue had waiters and the CPU was not the reason.
export function isIdleWaitSample(line) {
  const cpu = finite(line.cpu);
  return finite(line.waiters) > 0 && cpu !== null && cpu < 50;
}

export function clampSummaryDays(days) {
  const n = Math.floor(Number(days));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MACHINE_HOURS_MAX_DAYS) : MACHINE_HOURS_MAX_DAYS;
}

// One pass over the samples of the last `days` days. The hour is the local hour of the day, 0 to 23.
// A minute without a sample is missing data. `coverage` is the share of the window minutes that hold a sample.
export function summarizeHours({ samples = null, dataDir = DATA_DIR, days = MACHINE_HOURS_MAX_DAYS, now = Date.now() } = {}) {
  const window = clampSummaryDays(days);
  const sinceMs = now - window * DAY_MS;
  const minutes = new Set();
  const lines = (samples || readMachineSamples({ dataDir, sinceMs })).filter((line) => {
    const at = Date.parse(line?.at);
    if (!Number.isFinite(at) || at < sinceMs || at > now) return false;
    const minute = Math.floor(at / 60000);
    if (minutes.has(minute)) return false;
    minutes.add(minute);
    return true;
  });
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour, samples: 0, overloadMin: 0, idleWaitMin: 0, swapPeakPct: null, memFreeMin: null, holderKinds: {},
  }));
  const dates = new Set();
  const totals = { samples: 0, overloadMin: 0, idleWaitMin: 0 };
  for (const line of lines) {
    const date = new Date(line.at);
    const row = hours[date.getHours()];
    dates.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
    row.samples += 1;
    totals.samples += 1;
    if (isOverloadSample(line)) { row.overloadMin += 1; totals.overloadMin += 1; }
    if (isIdleWaitSample(line)) { row.idleWaitMin += 1; totals.idleWaitMin += 1; }
    const pct = swapPercent(line);
    if (pct !== null) row.swapPeakPct = Math.max(row.swapPeakPct ?? 0, Math.round(pct));
    const memFree = finite(line.memFree);
    if (memFree !== null) row.memFreeMin = Math.min(row.memFreeMin ?? memFree, memFree);
    for (const kind of Array.isArray(line.holders) ? line.holders : []) {
      if (typeof kind === 'string' && kind) row.holderKinds[kind] = (row.holderKinds[kind] ?? 0) + 1;
    }
  }
  return {
    days: window,
    daysWithData: dates.size,
    hours,
    totals,
    coverage: +Math.min(1, totals.samples / (window * 1440)).toFixed(3),
  };
}

// One line about the hours of the day with high swap in the last `days` days, or null. Aggregate figures only.
// An hour counts for a day when a sample of that local hour is at or above `warnPercent` with at least `minUsedGB` in use.
// The line names the hours that were high on at least 2 days, or on 1 day when only 1 day has data.
export function highSwapHoursLine({ warnPercent, minUsedGB = 0, days = 7, samples = null, dataDir = DATA_DIR, now = Date.now() } = {}) {
  if (!Number.isFinite(warnPercent)) return null;
  const window = clampSummaryDays(days);
  const sinceMs = now - window * DAY_MS;
  const lines = (samples || readMachineSamples({ dataDir, sinceMs })).filter((line) => {
    const at = Date.parse(line?.at);
    return Number.isFinite(at) && at >= sinceMs && at <= now;
  });
  const byHour = Array.from({ length: 24 }, () => new Set());
  const dates = new Set();
  const highDates = new Set();
  for (const line of lines) {
    const date = new Date(line.at);
    const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    dates.add(day);
    const pct = swapPercent(line);
    if (pct === null || pct < warnPercent || line.swapMB < minUsedGB * 1024) continue;
    byHour[date.getHours()].add(day);
    highDates.add(day);
  }
  if (!highDates.size) return null;
  const need = dates.size > 1 ? 2 : 1;
  const hours = byHour.map((set, hour) => (set.size >= need ? hour : -1)).filter((hour) => hour >= 0);
  if (!hours.length) return null;
  const ranges = [];
  for (const hour of hours) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === hour - 1) last[1] = hour; else ranges.push([hour, hour]);
  }
  const text = ranges.map(([a, b]) => (a === b ? `hour ${a}` : `hours ${a} to ${b}`)).join(', ');
  return `Swap was above the warning level in ${text} on ${highDates.size} of the last ${window} days.`;
}
