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
export const ACTIONS_MINUTES_MAX_PAGES = 5;

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
  if (!match || /^\.+$/.test(match[1]) || /^\.+$/.test(match[2])) return null;
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
  const starts = weeks.map(({ start }) => start);
  return { weeks: weeks.map(({ key }) => key), starts, firstStart: starts[0].getTime() };
}

function runnerName(value) {
  const key = String(value || 'unknown').toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(key) ? key : 'UNKNOWN';
}

function runStart(workflowRun) {
  const started = Date.parse(workflowRun?.run_started_at || '');
  if (Number.isFinite(started)) return started;
  const created = Date.parse(workflowRun?.created_at || '');
  return Number.isFinite(created) ? created : null;
}

async function collectRepo({ repo, window, run }) {
  const dates = new Map(window.weeks.map((week, i) => [week, i]));
  const row = { repo, minutes: Array(window.weeks.length).fill(0), runs: Array(window.weeks.length).fill(0), series: [], truncated: false };
  for (let page = 1; page <= ACTIONS_MINUTES_MAX_PAGES; page++) {
    const result = await run(['api', `repos/${repo}/actions/runs?per_page=100&page=${page}`], { timeout: ACTIONS_MINUTES_TIMEOUT_MS });
    const list = jsonFrom(result);
    if (!Array.isArray(list?.workflow_runs) || list.workflow_runs.length > 100) return null;
    for (const workflowRun of list.workflow_runs) {
      const started = runStart(workflowRun);
      const index = Number.isFinite(started) ? dates.get(weekInfo(started)) : undefined;
      if (index === undefined) continue;
      row.runs[index]++;
      if (workflowRun.status !== 'completed') continue;
      const ended = Date.parse(workflowRun.updated_at || '');
      if (!Number.isFinite(ended) || ended < started) continue;
      const minutes = Math.ceil((ended - started) / 60_000);
      row.minutes[index] += minutes;
      const type = runnerName(workflowRun.runner_type);
      let series = row.series.find((item) => item.runnerType === type);
      if (!series) {
        series = { runnerType: type, minutes: Array(window.weeks.length).fill(0) };
        row.series.push(series);
      }
      series.minutes[index] += minutes;
    }
    if (!list.workflow_runs.length) break;
    const oldest = runStart(list.workflow_runs.at(-1));
    if (Number.isFinite(oldest) && oldest < window.firstStart) break;
    if (list.workflow_runs.length < 100) break;
    if (page === ACTIONS_MINUTES_MAX_PAGES) row.truncated = true;
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

async function collectActionsMinutesResult({ repos = [], run = apiRun, now = Date.now() } = {}) {
  const window = weekWindow(now);
  const unique = new Map();
  for (const item of repos || []) {
    const repo = parseRepo(item?.remote);
    if (repo && !unique.has(repo)) unique.set(repo, { repo });
  }
  const candidates = [...unique.values()];
  const outcomes = await mapLimit(candidates, 3, async (item) => ({ repo: item.repo, row: await collectRepo({ ...item, window, run }).catch(() => null) }));
  const successful = outcomes.filter((outcome) => outcome?.row);
  const failedRepos = outcomes.filter((outcome) => !outcome?.row).map((outcome) => outcome.repo);
  const data = successful.length
    ? { available: true, estimated: true, truncated: successful.some((outcome) => outcome.row.truncated), weeks: window.weeks, repos: successful.map((outcome) => outcome.row).sort((a, b) => a.repo.localeCompare(b.repo)), updatedAt: new Date(now).toISOString() }
    : { ...EMPTY };
  return { data, attemptedRepos: candidates.map((item) => item.repo), failedRepos };
}

// Read Actions run times from registered GitHub repositories. A failed repository adds no new row.
export async function collectActionsMinutes(options = {}) {
  return (await collectActionsMinutesResult(options)).data;
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
    estimated: true,
    truncated: state.truncated === true,
    weeks: state.weeks.slice(-ACTIONS_MINUTES_WEEKS),
    repos: state.repos.filter((row) => row && typeof row.repo === 'string').map((row) => ({
      repo: row.repo,
      minutes: Array.isArray(row.minutes) ? row.minutes.slice(-ACTIONS_MINUTES_WEEKS) : [],
      runs: Array.isArray(row.runs) ? row.runs.slice(-ACTIONS_MINUTES_WEEKS) : [],
      truncated: row.truncated === true,
      series: Array.isArray(row.series) ? row.series.map((series) => ({ runnerType: runnerName(series.runnerType), minutes: (series.minutes || []).slice(-ACTIONS_MINUTES_WEEKS) })) : [],
    })),
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
  };
}

export function readActionsMinutes(dataDir = DATA_DIR, { enabled = true } = {}) {
  return publicState(readState(dataDir), enabled);
}

function fitRowToWeeks(row, fromWeeks, toWeeks) {
  const fromIndex = new Map((fromWeeks || []).map((week, index) => [week, index]));
  const fit = (values) => toWeeks.map((week) => {
    const index = fromIndex.get(week);
    return index === undefined ? 0 : finite(values?.[index]) ?? 0;
  });
  return {
    repo: row.repo,
    minutes: fit(row.minutes),
    runs: fit(row.runs),
    truncated: row.truncated === true,
    series: (Array.isArray(row.series) ? row.series : []).map((series) => ({ runnerType: runnerName(series.runnerType), minutes: fit(series.minutes) })),
  };
}

function mergeRefresh(previous, result, attemptedAt) {
  if (!result.attemptedRepos.length) return { ...(previous || EMPTY), lastAttemptAt: attemptedAt };
  if (!result.failedRepos.length) return { ...result.data, lastAttemptAt: attemptedAt };
  if (!result.data.available) return { ...(previous || EMPTY), lastAttemptAt: attemptedAt };
  const failed = new Set(result.failedRepos);
  const oldRows = (Array.isArray(previous?.repos) ? previous.repos : [])
    .filter((row) => failed.has(row.repo))
    .map((row) => fitRowToWeeks(row, previous.weeks, result.data.weeks));
  const repos = [...result.data.repos, ...oldRows].sort((a, b) => a.repo.localeCompare(b.repo));
  return { ...result.data, truncated: result.data.truncated || oldRows.some((row) => row.truncated), repos, lastAttemptAt: attemptedAt };
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
    writeState(directory, previous ? { ...previous, lastAttemptAt: attemptedAt } : { ...EMPTY, lastAttemptAt: attemptedAt });
    const result = await collectActionsMinutesResult({ repos: candidateRepos, run, now }).catch(() => ({ data: { ...EMPTY }, attemptedRepos: [], failedRepos: [] }));
    const stored = mergeRefresh(previous, result, attemptedAt);
    writeState(directory, stored);
    return publicState(stored, enabled);
  }).catch(() => ({ ...EMPTY })).finally(() => { refreshes.delete(directory); });
  refreshes.set(directory, pending);
  return pending;
}
