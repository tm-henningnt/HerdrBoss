import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { workerRunId } from './agent-messages.js';

const WORKER_CLOSE_FILE = 'worker-pane-closes.json';
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const WORKER_CLOSE_MAX_ATTEMPTS = 5;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('The worker pane close queue is locked. Try again.');
      pause(20);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

function validCloseJob(job) {
  return job && PROJECT_SLUG.test(job.project) && WORKER_NAME.test(job.name)
    && typeof job.runId === 'string' && job.runId.length <= 256
    && Number.isSafeInteger(job.dueAt) && job.dueAt >= 0
    && (job.attempts === undefined || (Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts < WORKER_CLOSE_MAX_ATTEMPTS));
}

function firstTimestamp(...values) {
  for (const value of values) {
    const timestamp = Number.isFinite(value) ? value : Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export function readWorkerPaneCloses({ dir = DATA_DIR } = {}) {
  const value = readJson(path.join(dir, WORKER_CLOSE_FILE), []);
  if (!Array.isArray(value)) throw new Error('worker-pane-closes.json must contain an array.');
  return value.filter(validCloseJob);
}

export function scheduleWorkerPaneClose({ project, name, runId, dueAt, dir = DATA_DIR } = {}) {
  const job = { project, name, runId, dueAt, attempts: 0 };
  if (!validCloseJob(job)) throw new Error('Worker pane close needs a project, worker name, run ID, and due time.');
  const file = path.join(dir, WORKER_CLOSE_FILE);
  withFileLock(file, () => {
    const jobs = readWorkerPaneCloses({ dir }).filter((item) => item.runId !== runId);
    jobs.push(job);
    writeJsonAtomic(file, jobs);
  });
  return job;
}

// Keep the pane ID out of the queue. Resolve the finished run and the live pane again when the service acts.
export async function processDueWorkerPaneCloses({ panes, now = Date.now(), dir = DATA_DIR, readRun, closePane, onError = () => {} } = {}) {
  const jobs = readWorkerPaneCloses({ dir });
  if (!Array.isArray(panes) || typeof readRun !== 'function' || typeof closePane !== 'function') {
    return { closed: 0, skipped: 0, failed: 0, dropped: 0, pending: jobs.length };
  }
  const outcomes = new Map();
  const jobKey = (job) => JSON.stringify([job.project, job.name, job.runId, job.dueAt, job.attempts ?? 0]);
  let closed = 0, skipped = 0, failed = 0;
  for (const job of jobs) {
    if (job.dueAt > now) continue;
    const key = jobKey(job);
    let run;
    try { run = await readRun(job); }
    catch (error) { failed++; outcomes.set(key, { type: 'failed', job, error }); continue; }
    if (!run || run.name !== job.name || workerRunId(run, job.project) !== job.runId || !run.finishedAt || !run.pane) {
      skipped++;
      outcomes.set(key, { type: 'remove' });
      continue;
    }
    const pane = panes.find((item) => item.id === run.pane && item.name === job.name);
    if (!pane || pane.agent !== run.kind) {
      skipped++;
      outcomes.set(key, { type: 'remove' });
      continue;
    }
    if (!['done', 'idle'].includes(pane.agent_status ?? pane.status)) continue;
    try {
      await closePane(pane.id);
      closed++;
      outcomes.set(key, { type: 'remove' });
    } catch (error) {
      failed++;
      outcomes.set(key, { type: 'failed', job, error });
    }
  }
  const file = path.join(dir, WORKER_CLOSE_FILE);
  let dropped = 0;
  const terminalErrors = [];
  const keep = withFileLock(file, () => {
    const latest = readWorkerPaneCloses({ dir });
    const next = [];
    for (const current of latest) {
      const outcome = outcomes.get(jobKey(current));
      if (!outcome) { next.push(current); continue; }
      if (outcome.type === 'remove') continue;
      if (outcome.type === 'failed') {
        const attempts = (current.attempts ?? 0) + 1;
        if (attempts >= WORKER_CLOSE_MAX_ATTEMPTS) {
          dropped++;
          terminalErrors.push(outcome);
        } else next.push({ ...current, attempts });
        continue;
      }
      next.push(current);
    }
    if (JSON.stringify(next) !== JSON.stringify(latest)) writeJsonAtomic(file, next);
    return next;
  });
  for (const outcome of terminalErrors) onError(outcome.job, outcome.error);
  return { closed, skipped, failed, dropped, pending: keep.length };
}

export function inspectUncollectedWorkers({ panes, runs, observed = {}, now = Date.now(), minutes = 30 } = {}) {
  const live = new Map((panes || []).map((pane) => [pane.id, pane]));
  const nextObserved = {};
  const notices = [];
  for (const run of runs || []) {
    if (run.collectedAt || !run.name || !run.pane || !run.startedAt || !run.project) continue;
    const pane = live.get(run.pane);
    if (!pane || pane.name !== run.name || pane.agent !== run.kind || pane.status !== 'done' || !pane.workspace) continue;
    const runId = workerRunId(run, run.project);
    if (!runId) continue;
    const previous = observed[runId];
    const sameRun = previous?.project === run.project && previous?.name === run.name && previous?.runId === runId;
    const parsedTimestamp = firstTimestamp(run.reportAt, run.reportedAt, run.reportMtimeMs, run.finishedAt);
    const since = Number.isFinite(parsedTimestamp) ? parsedTimestamp : sameRun && Number.isFinite(previous.since) ? previous.since : now;
    nextObserved[runId] = { project: run.project, name: run.name, runId, since };
    if (!Number.isFinite(now) || !Number.isSafeInteger(minutes) || minutes < 1 || now - since < minutes * 60_000) continue;
    notices.push({
      key: `workers:uncollected:${runId}`,
      severity: 'warn',
      scope: pane.workspace,
      immediate: true,
      once: true,
      noDesktop: true,
      title: `Worker ${run.name} is done and not collected`,
      text: `Worker ${run.name} has been done for ${minutes} minutes. Run herdr-boss worker collect ${run.name}.`,
    });
  }
  return { observed: nextObserved, notices };
}

export function trackBrowserIdle(state = {}, session, { probe, clientCount, agentTabIds = [] } = {}, { now = Date.now(), idleCloseMinutes = 20 } = {}) {
  const project = session?.project;
  if (!project) return { state, closeDue: false };
  const current = state[project];
  const sameLaunch = current?.launchedAt === session.launchedAt && current?.port === session.port;
  const next = sameLaunch ? { ...current, knownPageIds: [...(current.knownPageIds || [])], agentTabIds: [...(current.agentTabIds || [])] }
    : { launchedAt: session.launchedAt || null, port: session.port, knownPageIds: [], agentTabIds: [], idleSince: null, initialized: false };
  const updated = { ...state, [project]: next };
  if (!session.launchedAt || idleCloseMinutes === 0) {
    next.idleSince = null;
    return { state: updated, closeDue: false };
  }
  const pageIds = Array.isArray(probe?.pageIds) ? [...new Set(probe.pageIds.filter((id) => typeof id === 'string' && id))] : null;
  if (probe?.ok !== true || !pageIds || !Number.isSafeInteger(clientCount) || clientCount < 0) {
    next.idleSince = null;
    return { state: updated, closeDue: false };
  }
  const open = new Set(pageIds);
  const known = new Set(next.knownPageIds);
  if (next.initialized) for (const id of pageIds) if (!known.has(id)) next.agentTabIds.push(id);
  next.knownPageIds = pageIds;
  next.initialized = true;
  next.agentTabIds = [...new Set([
    ...next.agentTabIds.filter((id) => open.has(id)),
    ...agentTabIds.filter((id) => typeof id === 'string' && open.has(id)),
  ])];
  const attached = Array.isArray(probe.attachedTabIds) && probe.attachedTabIds.length > 0;
  if (clientCount > 0 || attached || next.agentTabIds.length > 0) {
    next.idleSince = null;
    return { state: updated, closeDue: false };
  }
  if (!Number.isFinite(next.idleSince)) next.idleSince = now;
  return { state: updated, closeDue: now - next.idleSince >= idleCloseMinutes * 60_000 };
}

export function shouldCloseManagedBrowser({ session, matched, closeDue } = {}) {
  return !!session?.launchedAt && matched === true && closeDue === true;
}
