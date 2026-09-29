// Live task state from facts. The published status file holds the plan. Worker run records hold what happens.
// overlayTasks() derives the effective state of each task and keeps the published status beside it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A worker that started less than this long ago gets time for the orchestrator to publish.
export const MISMATCH_GRACE_MS = 5 * 60000;

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The task id of a run record: the task id first, then the numeric issue alias.
export function runTaskId(record) {
  if (typeof record?.taskId === 'string' && record.taskId) return record.taskId;
  if (record?.issue != null && String(record.issue) !== '') return String(record.issue);
  return null;
}

// The history of a finished run counts for this long. An older run that is not live is dropped.
export const HISTORY_MS = 14 * 86400000;
const ACTIVE_AGENT_STATUSES = new Set(['working', 'blocked']);

// True when the worker wrote its report file.
export function reportExists(record) {
  if (!record?.worktree) return false;
  try { return fs.existsSync(path.join(record.worktree, record.workerDir || '.worker', 'report.json')); } catch { return false; }
}

// phase: live | review | merged | failed | abandoned
// live: the run is not finished and its agent runs. abandoned: the run is not finished and its agent is gone.
// review: the worker was collected as done and its branch is not merged. merged: the branch is merged.
// failed: the run was recorded with the outcome failed or partial.
// active: a live worker that is working or blocked, is not parked, and has no report. Only an active worker
// can make the published status wrong. An idle, parked, or reported worker is waiting for the orchestrator.
export function workerFactFromRun(record, { isLive = () => true, isMerged = () => false, hasReport = () => false, agentStatus = () => null, now = Date.now() } = {}) {
  const taskId = runTaskId(record);
  if (!taskId || !record?.name) return null;
  let phase;
  if (record.finishedAt) phase = record.outcome === 'done' ? (isMerged(record) ? 'merged' : 'review') : 'failed';
  else if (record.collectedAt) phase = isMerged(record) ? 'merged' : 'review';
  else phase = isLive(record) ? 'live' : 'abandoned';
  if (phase !== 'live') {
    const newest = Math.max(...[record.startedAt, record.collectedAt, record.finishedAt].map(Date.parse).filter(Number.isFinite), -Infinity);
    if (Number.isFinite(newest) && now - newest > HISTORY_MS) return null;
  }
  const fact = { name: record.name, taskId, phase, kind: record.kind ?? null, model: record.model ?? null, startedAt: record.startedAt ?? null };
  if (phase === 'live') fact.active = !record.parked && !hasReport(record) && ACTIVE_AGENT_STATUSES.has(agentStatus(record));
  return fact;
}

// The facts sort by start time, so a later worker comes after an earlier worker of the same task.
export function readWorkerFacts(runsPath, options = {}) {
  let files = [];
  try { files = fs.readdirSync(runsPath).filter((name) => name.endsWith('.json')); } catch { return []; }
  const opts = { hasReport: reportExists, ...options };
  const facts = [];
  for (const file of files) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runsPath, file), 'utf8')); } catch { continue; }
    const fact = workerFactFromRun(record, opts);
    if (fact) facts.push(fact);
  }
  return facts.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

// A collected branch counts as merged only when it has commits beyond its base commit and its tip is in the base
// branch. A missing branch, a branch with no new commit, and the base branch itself never count as merged. A record
// with mergedAt counts as merged. The cache keeps each answer: a merged answer stays, and a not-merged answer is used
// again for recheckMs. budget.left caps the number of git checks. A caller that shares the cache and budget
// between reads never blocks for long.
export function gitIsMerged(root, { cache = new Map(), budget = { left: Infinity }, now = Date.now(), recheckMs = 60000 } = {}) {
  const git = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  return (record) => {
    if (record?.mergedAt) return true;
    if (!record?.branch || !record?.base || record.branch === record.base) return false;
    const key = `${root}\0${record.name}\0${record.startedAt}`;
    const known = cache.get(key);
    if (known?.merged) return true;
    if (known && now - known.at < recheckMs) return false;
    if (budget.left <= 0) return false;
    budget.left -= 1;
    let merged = false;
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`]);
      const tip = execFileSync('git', ['-C', root, 'rev-parse', `refs/heads/${record.branch}`], { encoding: 'utf8' }).trim();
      if (tip !== record.baseCommit) {
        git(['merge-base', '--is-ancestor', tip, record.base]);
        merged = true;
      }
    } catch { merged = false; }
    cache.set(key, { merged, at: now });
    return merged;
  };
}

// The status of each agent that Herdr lists, by name. A null list means Herdr could not answer.
export function agentStatuses(list) {
  const rows = Array.isArray(list) ? list : list?.agents;
  if (!Array.isArray(rows)) return null;
  const result = new Map();
  for (const agent of rows) {
    const name = agent?.name ?? agent?.agent_name;
    if (name) result.set(name, agent.agent_status ?? agent.status ?? null);
  }
  return result;
}

function pickWorker(workers) {
  const start = (worker) => Date.parse(worker.startedAt) || 0;
  const latest = (list) => list.reduce((best, worker) => (!best || start(worker) >= start(best) ? worker : best), null);
  return latest(workers.filter((worker) => worker.phase === 'live'))
    || latest(workers.filter((worker) => worker.phase === 'review' || worker.phase === 'merged'));
}

function workerView(worker) {
  return worker ? { name: worker.name, kind: worker.kind, model: worker.model, startedAt: worker.startedAt } : null;
}

function groupByTask(workers) {
  const map = new Map();
  for (const worker of workers) {
    if (!map.has(worker.taskId)) map.set(worker.taskId, []);
    map.get(worker.taskId).push(worker);
  }
  return map;
}

// Add state, stateSource, worker, publishedStatus, blockers, and blockedReason to each task.
// The published status field stays as it is.
export function overlayTasks(tasks, workers = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const byTask = groupByTask(workers);
  const base = list.map((t) => {
    const published = t?.status || 'todo';
    const own = t && t.id != null ? byTask.get(String(t.id)) || [] : [];
    const worker = pickWorker(own);
    if (published === 'done') return { state: 'done', stateSource: 'published', worker: null };
    if (worker?.phase === 'merged') return { state: 'done', stateSource: `merged from worker ${worker.name}`, worker };
    if (worker?.phase === 'live') return { state: 'doing', stateSource: `live from worker ${worker.name}`, worker };
    if (worker?.phase === 'review') return { state: 'review', stateSource: `collected from worker ${worker.name}`, worker };
    // Every worker of a task that is published as doing has failed or gone. The task is open again.
    if (published === 'doing' && own.length) {
      const last = own.reduce((a, b) => ((Date.parse(b.startedAt) || 0) >= (Date.parse(a.startedAt) || 0) ? b : a));
      return { state: 'todo', stateSource: `worker ${last.name} ${last.phase}`, worker: null };
    }
    return { state: published, stateSource: 'published', worker: null };
  });
  const doneIds = new Set(list.map((t, i) => (base[i].state === 'done' && t?.id != null ? String(t.id) : null)).filter(Boolean));
  return list.map((t, i) => {
    if (!t || typeof t !== 'object') return t;
    const published = t.status || 'todo';
    let { state, stateSource } = base[i];
    const blockers = (Array.isArray(t.blockedBy) ? t.blockedBy : []).filter((id) => !doneIds.has(String(id)));
    let blockedReason = null;
    if (state === 'todo' || state === 'ready' || state === 'blocked') {
      const waiting = state === 'blocked' && stateSource === 'published' && t.waitingOn != null;
      if (blockers.length || waiting) {
        const reasons = [];
        if (blockers.length) reasons.push(blockers.map((id) => `task ${id}`).join(', '));
        if (waiting) reasons.push(`the ${t.waitingOn}`);
        blockedReason = `waits on ${reasons.join(' and ')}`;
        if (state !== 'blocked') stateSource = 'derived from dependencies';
        state = 'blocked';
      } else {
        if (state === 'blocked' || (Array.isArray(t.blockedBy) && t.blockedBy.length)) stateSource = 'derived from dependencies';
        state = 'ready';
      }
    }
    return { ...t, publishedStatus: published, state, stateSource, worker: workerView(base[i].worker), blockers: state === 'blocked' ? blockers : [], blockedReason };
  });
}

// Each live worker whose task is not doing in the published data, as one line each.
export function taskMismatches(data, workers = [], { now = Date.now(), graceMs = MISMATCH_GRACE_MS } = {}) {
  const tasks = new Map((Array.isArray(data?.tasks) ? data.tasks : []).filter((t) => t && t.id != null).map((t) => [String(t.id), t]));
  const result = [];
  for (const worker of workers) {
    if (worker.phase !== 'live' || worker.active === false) continue;
    const started = Date.parse(worker.startedAt);
    if (graceMs > 0 && Number.isFinite(started) && now - started < graceMs) continue;
    const found = tasks.get(worker.taskId);
    const status = found ? found.status || 'todo' : null;
    if (status === 'doing') continue;
    result.push({ worker: worker.name, task: worker.taskId, status });
  }
  return result;
}

export function mismatchText({ worker, task, status }) {
  return `worker ${worker} runs task ${task}, which ${status ? `is ${status}` : 'is not listed'} in the published status`;
}

// Messages for the publish check. A live worker counts at once, with no grace time.
export function publishConflicts(data, workers = []) {
  return taskMismatches(data, workers, { graceMs: 0 }).map(({ worker, task, status }) => `task ${task} has a live worker ${worker}, but it ${status ? `is ${status}` : 'is not listed'} in the status`);
}

// Decorate published projects with the derived task state and the board stale flag.
// stale is the result of staleStatuses().
export function applyTaskState(projects, taskWorkers = {}, { stale = {} } = {}) {
  return (projects || []).map((project) => {
    if (!project?.slug) return project;
    const entry = stale[project.slug];
    const flags = { boardStale: Boolean(entry), boardStaleReason: entry?.reason ?? null };
    if (!Array.isArray(project.tasks)) return { ...project, ...flags };
    return { ...project, tasks: overlayTasks(project.tasks, taskWorkers[project.slug] || []), ...flags };
  });
}
