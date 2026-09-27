import fs from 'node:fs';
import path from 'node:path';
import { findGitRoot, loadProjectConfig } from './kit/config.js';

export const WORKER_FAILURE_LABELS = Object.freeze([
  'API Error', '401', '429', 'Connection lost', 'usage limit', 'rate limit', 'overloaded', 'Free usage exceeded',
]);

export function parseFreeUsageRetryTime(text, now = Date.now()) {
  const value = String(text ?? '');
  if (!/free usage exceeded/i.test(value)) return null;
  const absolute = value.match(/\bretry\s+(?:at\s+)?(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))\b/i);
  let retryAt = absolute ? Date.parse(absolute[1]) : NaN;
  if (absolute) {
    const [, year, month, day, hour, minute, second = '0'] = absolute[1].match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
    const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  }
  if (!absolute) {
    const relative = value.match(/\bretry\s+in\s+((?:\d+\s*(?:d|h|m|s)(?![a-z])\s*)+)(?=$|[.,;!?\s])/i);
    if (!relative) return null;
    const parts = [...relative[1].matchAll(/(\d+)\s*(d|h|m|s)/gi)];
    if (!parts.length || parts.map((part) => part[0]).join('').replace(/\s/g, '').toLowerCase() !== relative[1].replace(/\s/g, '').toLowerCase()) return null;
    const units = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
    retryAt = now + parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2].toLowerCase()], 0);
  }
  return Number.isFinite(retryAt) && Number.isFinite(new Date(retryAt).getTime()) && retryAt > now ? retryAt : null;
}

export function resolveFreeUsageRun(pane, { providerFor, policy, runsCwd = pane?.cwd } = {}) {
  if (!pane?.cwd || !runsCwd || !pane?.name || !pane?.id) return null;
  try {
    // Worker run records live beside the orchestrator checkout, while pane.cwd points at the worker worktree.
    const config = loadProjectConfig({ cwd: runsCwd });
    const name = pane.name.replace(/^W\s+/, '');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return null;
    const file = path.resolve(config.runsPath, `${name}.json`);
    const runsPath = fs.realpathSync(config.runsPath);
    const actual = fs.realpathSync(file);
    if (!actual.startsWith(`${runsPath}${path.sep}`)) return null;
    const run = JSON.parse(fs.readFileSync(actual, 'utf8'));
    const paneRoot = fs.realpathSync(findGitRoot(pane.cwd));
    if (!run.worktree || fs.realpathSync(run.worktree) !== paneRoot || run.name !== name || run.pane !== pane.id || run.finishedAt || !run.kind || !run.model
      || typeof providerFor !== 'function' || providerFor(run.kind, run.model, policy) !== null) return null;
    return { project: config.slug, kind: run.kind, model: run.model };
  } catch { return null; }
}

export function activeFreeModelExhaustions(existing, now = Date.now()) {
  const active = {};
  for (const item of Object.values(existing || {})) {
    if (!Number.isSafeInteger(item?.retryAt) || !Number.isFinite(new Date(item.retryAt).getTime()) || item.retryAt <= now
      || typeof item.model !== 'string') continue;
    const prior = active[item.model];
    active[item.model] = { model: item.model, retryAt: Math.max(prior?.retryAt || 0, item.retryAt) };
  }
  return active;
}

export function extendFreeModelExhaustion(existing, association, retryAt, now = Date.now()) {
  if (!association?.project || !association?.kind || !association?.model || !Number.isSafeInteger(retryAt)
    || !Number.isFinite(new Date(retryAt).getTime()) || retryAt <= now) return existing || {};
  const prior = existing?.[association.model];
  return { ...(existing || {}), [association.model]: { model: association.model, retryAt: Math.max(prior?.retryAt || 0, retryAt) } };
}

// A repeat keeps the first observation as the anchor, so unchanged relative retry text does not
// slide forward on every tick. A newly reported absolute timestamp is taken when it extends the deadline.
function nextFreeUsageRetryAt(text, existing, now = Date.now()) {
  const anchor = Number.isFinite(existing?.at) ? existing.at : now;
  const parsed = parseFreeUsageRetryTime(text, anchor);
  const prior = Number.isFinite(existing?.retryAt) ? existing.retryAt : null;
  if (parsed === null) return prior;
  return prior === null ? parsed : Math.max(prior, parsed);
}

export function matchWorkerFailure(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
  const content = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => !/^tip:/i.test(line)).join('\n');
  const lower = content.toLowerCase();
  return WORKER_FAILURE_LABELS.find((label) => {
    if (label === '401') return /\b(?:http\s+401|status\s+401|401\s+unauthorized)\b/i.test(content);
    if (label === 'usage limit') return /\b(?:usage\s+limit\s+(?:reached|exceeded)|hit\s+your\s+usage\s+limit)\b/i.test(content);
    return lower.includes(label.toLowerCase());
  }) || null;
}

// Orchestrator and Boss panes, current or previous, are not workers.
const NON_WORKER_LABELS = new Set(['orch', 'boss', 'orch previous', 'boss previous']);
export function isWorkerPane(pane) {
  return Boolean(pane?.agent) && !pane.orch && !NON_WORKER_LABELS.has(pane.label);
}

export function shouldReadWorkerScreen(previous, pane) {
  if (!isWorkerPane(pane)) return false;
  // A working pane is read on every tick, so a provider failure that appears during work is caught.
  if (pane.status === 'working') return true;
  if (!['idle', 'done'].includes(pane.status)) return false;
  if (!previous) return true;
  const sameWorker = previous.id === pane.id && previous.agent === pane.agent && (previous.name || null) === (pane.name || null)
    && (previous.sessionId || null) === (pane.sessionId || null);
  return !sameWorker || previous.status !== pane.status;
}

export function workerPaneReadArgs(paneId) {
  return ['pane', 'read', paneId, '--source', 'visible', '--lines', '8', '--format', 'text'];
}

// Report files are treated as metadata only. Never open or parse their contents.
export function inspectWorkerReports(panes, observed, now = Date.now(), getMetadata = (file) => {
  try {
    const stat = fs.lstatSync(file);
    return { isFile: stat.isFile(), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}) {
  const nextObserved = {};
  const notices = [];
  for (const pane of panes || []) {
    if (!isWorkerPane(pane)) continue;
    const prior = observed?.[pane.id];
    const firstSeen = Number.isFinite(prior?.firstSeen) ? prior.firstSeen : now;
    nextObserved[pane.id] = {
      agent: pane.agent, name: pane.name || null, sessionId: pane.sessionId || null, firstSeen,
    };
    if (!Number.isFinite(firstSeen) || !pane.cwd) continue;
    const workerName = pane.name || pane.agent;
    const candidates = [
      '.worker/report.json',
      ...(workerName && path.basename(workerName) === workerName && workerName !== '.' && workerName !== '..'
        ? [`.worker/${workerName}/report.json`] : []),
    ];
    for (const reportPath of candidates) {
      const absoluteReportPath = path.resolve(pane.cwd, reportPath);
      let metadata;
      try { metadata = getMetadata(absoluteReportPath); } catch { continue; }
      if (!metadata?.isFile || !Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs <= firstSeen) continue;
      const key = `workers:report:${absoluteReportPath}:${metadata.mtimeMs}`;
      notices.push({
        key, severity: 'info', scope: pane.workspace, immediate: true,
        title: `Worker ${workerName} wrote its report`,
        text: `Worker ${workerName} in pane ${pane.id} wrote its report: ${absoluteReportPath}`,
      });
    }
  }
  return { observed: nextObserved, notices };
}

export async function inspectWorkerTransitions(panes, observed, existingFailures, readScreen, now = Date.now()) {
  const nextObserved = {};
  const failures = { ...(existingFailures || {}) };
  const notices = [];
  const live = new Map((panes || []).map((pane) => [pane.id, pane]));
  for (const [id, failure] of Object.entries(failures)) {
    const pane = live.get(id);
    if (!pane || !isWorkerPane(pane) || pane.agent !== failure.agent || (pane.name || null) !== (failure.name || null)
      || (pane.sessionId || null) !== (failure.sessionId || null)) delete failures[id];
  }
  for (const pane of panes || []) {
    const prior = observed?.[pane.id];
    if (shouldReadWorkerScreen(prior, pane)) {
      try {
        const screen = await readScreen(workerPaneReadArgs(pane.id));
        const label = matchWorkerFailure(screen);
        const existing = failures[pane.id];
        if (label) {
          // A repeated match keeps its first notice time, so one failure yields one notice.
          const repeat = existing?.label === label;
          const retryAt = label === 'Free usage exceeded'
            ? nextFreeUsageRetryAt(screen, repeat ? existing : null, now)
            : null;
          const inWorkingPane = pane.status === 'working' || existing?.inWorkingPane === true;
          failures[pane.id] = {
            agent: pane.agent, name: pane.name || null, sessionId: pane.sessionId || null, label, at: repeat ? existing.at : now,
            ...(retryAt ? { retryAt } : {}), ...(inWorkingPane ? { inWorkingPane: true } : {}),
          };
        } else if (pane.status === 'working' || existing?.inWorkingPane === true) {
          // A failure found in a working pane clears on a clean read. An idle/done failure keeps its prior behavior.
          delete failures[pane.id];
        }
      } catch {
        // Pane output is sensitive. Read failures are intentionally not logged.
      }
    }
    nextObserved[pane.id] = { id: pane.id, agent: pane.agent || null, name: pane.name || null, sessionId: pane.sessionId || null, status: pane.status };
  }
  for (const [id, failure] of Object.entries(failures)) {
    const pane = live.get(id);
    if (!pane) continue;
    const name = pane.name || pane.agent;
    notices.push({
      key: `workers:failed:${id}:${failure.at}`,
      severity: 'warn', scope: pane.workspace, immediate: true,
      title: `Worker ${name} failed`,
      text: `Worker ${name} (${id}) failed: ${failure.label}. Inspect the worker and decide whether to retry or change its provider.`,
    });
  }
  return { observed: nextObserved, failures, notices };
}

export function applyWorkerFailureStatuses(panes, failures) {
  return (panes || []).map((pane) => {
    const failure = failures?.[pane.id];
    if (!failure || !isWorkerPane(pane) || pane.agent !== failure.agent || (pane.name || null) !== (failure.name || null)
      || (pane.sessionId || null) !== (failure.sessionId || null)) return pane;
    return { ...pane, status: 'failed', failureLabel: failure.label };
  });
}

export function blockedWorkerAlerts(snap, paneSince, now = Date.now()) {
  return (snap.herdr?.panes || []).flatMap((pane) => {
    if (!isWorkerPane(pane) || pane.status !== 'blocked') return [];
    const since = paneSince?.[pane.id]?.since;
    if (!Number.isFinite(since) || now - since <= 5 * 60 * 1000) return [];
    const name = pane.name || pane.agent;
    return [{
      key: `workers:blocked:${pane.id}`, severity: 'warn', scope: pane.workspace,
      title: `Worker ${name} is blocked`,
      text: `Worker ${name} (${pane.id}) has been blocked for more than 5 minutes. Review its blocker and help it continue.`,
    }];
  });
}

export function workerStatusFromState(paneId, state, worker = null) {
  const pane = state?.herdr?.panes?.find((item) => item.id === paneId);
  // A stale run record can match an orchestrator or Boss pane, current or previous. Those panes are not workers.
  if (!isWorkerPane(pane)) return null;
  if (worker?.name && pane?.name && worker.name !== pane.name) return null;
  if (worker?.kind && pane?.agent && worker.kind !== pane.agent) return null;
  const status = pane?.status;
  return status === 'failed' ? status : null;
}
