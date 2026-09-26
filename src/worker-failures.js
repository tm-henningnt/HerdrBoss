export const WORKER_FAILURE_LABELS = Object.freeze([
  'API Error', '401', '429', 'Connection lost', 'usage limit', 'rate limit', 'overloaded',
]);

export function matchWorkerFailure(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
  const lower = text.toLowerCase();
  return WORKER_FAILURE_LABELS.find((label) => lower.includes(label.toLowerCase())) || null;
}

export function shouldReadWorkerScreen(previous, pane) {
  if (!pane?.agent || pane.orch || !['idle', 'done'].includes(pane.status)) return false;
  if (!previous) return true;
  const sameWorker = previous.id === pane.id && previous.agent === pane.agent && (previous.name || null) === (pane.name || null)
    && (previous.sessionId || null) === (pane.sessionId || null);
  return !sameWorker || previous.status !== pane.status;
}

export function workerPaneReadArgs(paneId) {
  return ['pane', 'read', paneId, '--source', 'visible', '--lines', '8', '--format', 'text'];
}

export async function inspectWorkerTransitions(panes, observed, existingFailures, readScreen, now = Date.now()) {
  const nextObserved = {};
  const failures = { ...(existingFailures || {}) };
  const notices = [];
  const live = new Map((panes || []).map((pane) => [pane.id, pane]));
  for (const [id, failure] of Object.entries(failures)) {
    const pane = live.get(id);
    if (!pane || pane.agent !== failure.agent || (pane.name || null) !== (failure.name || null)
      || (pane.sessionId || null) !== (failure.sessionId || null) || pane.status === 'working') delete failures[id];
  }
  for (const pane of panes || []) {
    const prior = observed?.[pane.id];
    if (shouldReadWorkerScreen(prior, pane)) {
      try {
        const label = matchWorkerFailure(await readScreen(workerPaneReadArgs(pane.id)));
        if (label) {
          const failure = { agent: pane.agent, name: pane.name || null, sessionId: pane.sessionId || null, label, at: now };
          failures[pane.id] = failure;
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
    if (!failure || !pane.agent || pane.agent !== failure.agent || (pane.name || null) !== (failure.name || null)
      || (pane.sessionId || null) !== (failure.sessionId || null) || pane.status === 'working') return pane;
    return { ...pane, status: 'failed', failureLabel: failure.label };
  });
}

export function blockedWorkerAlerts(snap, paneSince, now = Date.now()) {
  return (snap.herdr?.panes || []).flatMap((pane) => {
    if (!pane.agent || pane.orch || pane.label === 'boss' || pane.status !== 'blocked') return [];
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
  if (worker?.name && pane?.name && worker.name !== pane.name) return null;
  if (worker?.kind && pane?.agent && worker.kind !== pane.agent) return null;
  const status = pane?.status;
  return status === 'failed' ? status : null;
}
