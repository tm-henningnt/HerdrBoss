import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { readProjectRepos, stripRemoteCredentials } from './harness.js';
import { cleanGhEnv } from './gh-labels.js';

export const ACTIONS_MINUTES_FILE = 'actions-minutes.json';
export const ACTIONS_MINUTES_REFRESH_MS = 6 * 60 * 60 * 1000;
export const ACTIONS_MINUTES_WEEKS = 12;
export const ACTIONS_MINUTES_TIMEOUT_MS = 10_000;
// Keep the timing fallback bounded. A larger repository needs one extra API call for every run.
export const ACTIONS_MINUTES_MAX_TIMING_CALLS = 25;

const execFileAsync = promisify(execFile);
const refreshes = new Map();
const EMPTY = Object.freeze({ available: false, weeks: [], repos: [], updatedAt: null });
const finite = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function apiRun(args, { timeout = ACTIONS_MINUTES_TIMEOUT_MS } = {}) {
  return execFileAsync('gh', args, {
    encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
    env: cleanGhEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }))
    .catch((error) => ({ status: typeof error.code === 'number' ? error.code : null, error }));
}

function parseRepo(remote) {
  const text = stripRemoteCredentials(String(remote || '')).trim();
  const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|[^/@]+@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(text);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function jsonFrom(result) {
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    const value = JSON.parse(result.stdout);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function mondayUtc(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay() || 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

function weekInfo(ms) {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekWindow(now) {
  const current = mondayUtc(now);
  const weeks = Array.from({ length: ACTIONS_MINUTES_WEEKS }, (_, index) => {
    const start = new Date(current);
    start.setUTCDate(current.getUTCDate() - (ACTIONS_MINUTES_WEEKS - 1 - index) * 7);
    return { key: weekInfo(start.getTime()), start };
  });
  return { weeks: weeks.map(({ key }) => key), starts: weeks.map(({ start }) => start), firstDay: weeks[0].start.toISOString().slice(0, 10) };
}

function runnerName(value) {
  const key = String(value || 'unknown').toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(key) ? key : 'UNKNOWN';
}

function runnerMilliseconds(timing) {
  if (Number.isFinite(timing?.run_duration_ms) && timing.run_duration_ms >= 0) {
    return { UNKNOWN: timing.run_duration_ms };
  }
  const billable = timing?.billable;
  if (!billable || typeof billable !== 'object' || Array.isArray(billable)) return null;
  const result = {};
  for (const [runner, value] of Object.entries(billable)) {
    const ms = finite(value?.total_ms ?? value?.run_duration_ms);
    if (ms !== null) result[runnerName(runner)] = (result[runnerName(runner)] || 0) + ms;
  }
  return Object.keys(result).length ? result : null;
}

function billingWeeks(value, repo, window) {
  if (!Array.isArray(value?.weeks)) return null;
  const row = {
    repo,
    minutes: Array(window.weeks.length).fill(0),
    runs: Array(window.weeks.length).fill(0),
    series: [],
  };
  const runners = new Map();
  const index = new Map(window.weeks.map((week, i) => [week, i]));
  for (const week of value.weeks) {
    const key = typeof week?.week === 'string' ? week.week : typeof week?.week_start === 'string' ? weekInfo(Date.parse(week.week_start)) : null;
    const i = index.get(key);
    if (i === undefined) continue;
    const minutes = finite(week.minutes ?? week.total_minutes ?? week.total_minutes_used);
    if (minutes === null) return null;
    row.minutes[i] = minutes;
    row.runs[i] = Math.max(0, Math.floor(finite(week.runs ?? week.run_count) ?? 0));
    const breakdown = week.runners || week.minutes_used_breakdown;
    if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
      for (const [type, amount] of Object.entries(breakdown)) {
        const n = finite(typeof amount === 'object' ? amount.minutes ?? amount.total_minutes : amount);
        if (n === null) continue;
        const name = runnerName(type);
        const series = runners.get(name) || Array(window.weeks.length).fill(0);
        series[i] = n;
        runners.set(name, series);
      }
    }
  }
  row.series = [...runners].map(([runnerType, values]) => ({ runnerType, minutes: values }));
  return row;
}

async function collectRepo({ repo, slug, window, run }) {
  const billingResult = await run(['api', `repos/${repo}/actions/billing/usage`], { timeout: ACTIONS_MINUTES_TIMEOUT_MS });
  const billed = jsonFrom(billingResult);
  const fromBilling = billed && billingWeeks(billed, repo, window);
  if (fromBilling) return fromBilling;

  const runResult = await run(['api', `repos/${repo}/actions/runs?per_page=100&created=>=${window.firstDay}`], { timeout: ACTIONS_MINUTES_TIMEOUT_MS });
  const list = jsonFrom(runResult);
  if (!Array.isArray(list?.workflow_runs) || list.workflow_runs.length > 100 || (Number.isFinite(list.total_count) && list.total_count > 100)) return null;
  const dates = new Map(window.weeks.map((week, i) => [week, i]));
  const row = { repo, minutes: Array(window.weeks.length).fill(0), runs: Array(window.weeks.length).fill(0), series: [] };
  const needsTiming = [];
  for (const workflowRun of list.workflow_runs) {
    const started = Date.parse(workflowRun?.run_started_at || workflowRun?.created_at);
    const i = Number.isFinite(started) ? dates.get(weekInfo(started)) : undefined;
    if (i === undefined) continue;
    row.runs[i]++;
    const duration = finite(workflowRun?.run_duration_ms);
    if (duration !== null) {
      row.minutes[i] += duration / 60000;
      const type = runnerName(workflowRun.runner_type);
      const series = row.series.find((item) => item.runnerType === type) || { runnerType: type, minutes: Array(window.weeks.length).fill(0) };
      if (!row.series.includes(series)) row.series.push(series);
      series.minutes[i] += duration / 60000;
    } else if (workflowRun?.id != null && workflowRun.status === 'completed') needsTiming.push({ workflowRun, index: i });
  }
  if (needsTiming.length > ACTIONS_MINUTES_MAX_TIMING_CALLS) return null;
  const timings = await mapLimit(needsTiming, 5, async ({ workflowRun, index }) => {
    const result = await run(['api', `repos/${repo}/actions/runs/${encodeURIComponent(workflowRun.id)}/timing`], { timeout: ACTIONS_MINUTES_TIMEOUT_MS });
    const timing = jsonFrom(result);
    const byRunner = timing && runnerMilliseconds(timing);
    return byRunner ? { index, byRunner } : null;
  });
  if (timings.some((item) => item === null)) return null;
  for (const { index, byRunner } of timings) for (const [runnerType, milliseconds] of Object.entries(byRunner)) {
    const minutes = milliseconds / 60000;
    row.minutes[index] += minutes;
    let series = row.series.find((item) => item.runnerType === runnerType);
    if (!series) {
      series = { runnerType, minutes: Array(window.weeks.length).fill(0) };
      row.series.push(series);
    }
    series.minutes[index] += minutes;
  }
  row.series.sort((a, b) => a.runnerType.localeCompare(b.runnerType));
  return row;
}

async function mapLimit(values, limit, fn) {
  const output = Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      try { output[index] = await fn(values[index]); } catch { output[index] = null; }
    }
  }));
  return output;
}

// Read GitHub Actions usage for each registered GitHub remote. A failed repository adds no row.
export async function collectActionsMinutes({ repos = [], run = apiRun, now = Date.now() } = {}) {
  const window = weekWindow(now);
  const candidates = (repos || []).map((item) => ({ repo: parseRepo(item?.remote), slug: item?.slug }))
    .filter((item) => item.repo);
  const rows = await mapLimit(candidates, 3, (item) => collectRepo({ ...item, window, run }).catch(() => null));
  const result = rows.filter(Boolean);
  if (!result.length) return { ...EMPTY };
  return { available: true, weeks: window.weeks, repos: result.sort((a, b) => a.repo.localeCompare(b.repo)), updatedAt: new Date(now).toISOString() };
}

function stateFile(dataDir) { return path.join(dataDir, ACTIONS_MINUTES_FILE); }

function readState(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'));
    if (!state || typeof state !== 'object' || typeof state.lastAttemptAt !== 'string') return null;
    return state;
  } catch { return null; }
}

function writeState(dataDir, state) {
  const file = stateFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function publicState(state, enabled) {
  if (!enabled || !state || state.available !== true || !Array.isArray(state.weeks) || !Array.isArray(state.repos)) return { ...EMPTY };
  return {
    available: true,
    weeks: state.weeks.slice(-ACTIONS_MINUTES_WEEKS),
    repos: state.repos.filter((row) => row && typeof row.repo === 'string').map((row) => ({
      repo: row.repo,
      minutes: Array.isArray(row.minutes) ? row.minutes.slice(-ACTIONS_MINUTES_WEEKS) : [],
      runs: Array.isArray(row.runs) ? row.runs.slice(-ACTIONS_MINUTES_WEEKS) : [],
      series: Array.isArray(row.series) ? row.series.map((series) => ({ runnerType: runnerName(series.runnerType), minutes: (series.minutes || []).slice(-ACTIONS_MINUTES_WEEKS) })) : [],
    })),
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
  };
}

export function readActionsMinutes(dataDir = DATA_DIR, { enabled = true } = {}) {
  return publicState(readState(dataDir), enabled);
}

// Share one background refresh per data directory. The attempt time also limits retries after a failed request.
export function refreshActionsMinutes({ dataDir = DATA_DIR, repos, run = apiRun, now = Date.now(), enabled = true } = {}) {
  const directory = path.resolve(dataDir);
  if (!enabled) return Promise.resolve(readActionsMinutes(directory, { enabled: false }));
  if (refreshes.has(directory)) return refreshes.get(directory);
  const previous = readState(directory);
  const lastAttempt = Date.parse(previous?.lastAttemptAt);
  if (Number.isFinite(lastAttempt) && now - lastAttempt < ACTIONS_MINUTES_REFRESH_MS) {
    return Promise.resolve(publicState(previous, enabled));
  }
  const pending = Promise.resolve().then(async () => {
    const attemptedAt = new Date(now).toISOString();
    const candidateRepos = repos ?? readProjectRepos(directory);
    writeState(directory, { ...publicState(previous, true), lastAttemptAt: attemptedAt });
    const result = await collectActionsMinutes({ repos: candidateRepos, run, now }).catch(() => ({ ...EMPTY }));
    const stored = { ...result, lastAttemptAt: attemptedAt };
    writeState(directory, stored);
    return publicState(stored, enabled);
  }).catch(() => ({ ...EMPTY })).finally(() => { refreshes.delete(directory); });
  refreshes.set(directory, pending);
  return pending;
}
