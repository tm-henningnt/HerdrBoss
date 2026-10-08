const FULL_SUITE_LOCK = 'full-suite';
const MIN_PREDICTED_HOLD_MS = 10 * 60_000;
const LEDGER_CACHE_MS = 60_000;

function processMap(value) {
  if (value instanceof Map) return value;
  return null;
}

function processName(command) {
  const executable = String(command ?? '').trim().split(/\s+/, 1)[0];
  return executable ? executable.split(/[\\/]/).at(-1).slice(0, 80) || 'unknown' : 'unknown';
}

function processTree(processes, rootPid, expectedStart) {
  const root = processes.get(rootPid);
  const recordedStart = String(expectedStart ?? '').trim().replace(/\s+/g, ' ');
  const sampledStart = String(root?.start ?? '').trim().replace(/\s+/g, ' ');
  if (!root || !recordedStart || sampledStart !== recordedStart) return null;
  const childrenByParent = new Map();
  for (const process of processes.values()) {
    const parent = Number(process?.ppid);
    if (!Number.isSafeInteger(parent)) continue;
    const children = childrenByParent.get(parent) || [];
    children.push(process);
    childrenByParent.set(parent, children);
  }
  const included = [];
  const members = new Map();
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const current = processes.get(pid);
    const cpuTimeMs = Number(current?.cpuTimeMs);
    const start = String(current?.start ?? '').trim().replace(/\s+/g, ' ');
    if (!Number.isFinite(cpuTimeMs) || cpuTimeMs < 0 || !start) return null;
    members.set(pid, { cpuTimeMs, start });
    if (pid !== rootPid) included.push({ name: processName(current.cmd), pid });
    for (const child of childrenByParent.get(pid) || []) {
      const childPid = Number(child.pid);
      if (!Number.isSafeInteger(childPid) || visited.has(childPid)) continue;
      visited.add(childPid);
      queue.push(childPid);
    }
  }
  return { members, children: included.sort((left, right) => left.pid - right.pid) };
}

function cpuPercentBetween(before, current, wallMs) {
  if (!before || !current || !Number.isFinite(wallMs) || wallMs <= 0
    || before.members.size !== current.members.size) return null;
  let cpuTimeDeltaMs = 0;
  for (const [pid, after] of current.members) {
    const prior = before.members.get(pid);
    if (!prior || prior.start !== after.start || after.cpuTimeMs < prior.cpuTimeMs) return null;
    cpuTimeDeltaMs += after.cpuTimeMs - prior.cpuTimeMs;
  }
  return (cpuTimeDeltaMs / wallMs) * 100;
}

function predictedHold(lines, kind, now) {
  const holds = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.event === 'release' && line.name === FULL_SUITE_LOCK && line.kind === kind
      && Number.isFinite(line.holdMs) && line.holdMs >= 0
      && !line.takeover && !line.reentrant && !line.reused
      && Number.isFinite(Date.parse(line.at)) && Date.parse(line.at) <= now)
    .map((line) => line.holdMs)
    .sort((left, right) => left - right);
  if (holds.length < 5) {
    const middle = Math.floor(holds.length / 2);
    const median = holds.length === 0 ? 0
      : holds.length % 2 ? holds[middle] : (holds[middle - 1] + holds[middle]) / 2;
    return { ms: Math.max(MIN_PREDICTED_HOLD_MS, median), samples: holds.length };
  }
  const middle = Math.floor(holds.length / 2);
  return {
    ms: holds.length % 2 ? holds[middle] : (holds[middle - 1] + holds[middle]) / 2,
    samples: holds.length,
  };
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function inspectLockWatchdog({
  holders = [], settings = {}, clock = Date.now, ledgerReader = () => [], processReader = () => null,
  previousProcesses = null, previousSampleAt = null, ledgerCache = null,
} = {}) {
  const now = typeof clock === 'function' ? clock() : clock;
  const multiplier = Number.isInteger(settings.watchdogMultiplier) && settings.watchdogMultiplier >= 1
    ? settings.watchdogMultiplier : 3;
  const cpuLimit = Number.isFinite(settings.watchdogCpuPercent) && settings.watchdogCpuPercent >= 0
    ? settings.watchdogCpuPercent : 1;
  const roughCandidates = [];
  for (const record of holders) {
    if (record?.name !== FULL_SUITE_LOCK || record.state !== 'live' || !Number.isSafeInteger(record.pid)) continue;
    const acquiredAt = Date.parse(record.acquiredAt);
    const ageMs = now - acquiredAt;
    if (!Number.isFinite(acquiredAt) || ageMs <= multiplier * MIN_PREDICTED_HOLD_MS) continue;
    roughCandidates.push({ record, ageMs });
  }
  let currentProcesses = null;
  try { currentProcesses = processMap(processReader()); } catch { /* A missing process sample stops the check. */ }
  const previous = processMap(previousProcesses);
  if (!currentProcesses) return { candidates: [], processes: null };
  if (!previous || !Number.isFinite(previousSampleAt) || now <= previousSampleAt) return { candidates: [], processes: currentProcesses };
  if (!roughCandidates.length) return { candidates: [], processes: currentProcesses };

  let ledger = [];
  const cacheIsFresh = Array.isArray(ledgerCache?.lines) && Number.isFinite(ledgerCache.at)
    && now >= ledgerCache.at && now - ledgerCache.at < LEDGER_CACHE_MS;
  if (cacheIsFresh) ledger = ledgerCache.lines;
  else {
    try {
      const read = ledgerReader();
      ledger = Array.isArray(read) ? read : [];
      if (ledgerCache && typeof ledgerCache === 'object') {
        ledgerCache.at = now;
        ledgerCache.lines = ledger;
      }
    } catch { return { candidates: [], processes: currentProcesses }; }
  }
  const candidates = [];
  for (const { record, ageMs } of roughCandidates) {
    const prediction = predictedHold(ledger, record.kind, now);
    if (ageMs <= multiplier * prediction.ms) continue;
    const before = processTree(previous, record.pid, record.pidStart);
    const current = processTree(currentProcesses, record.pid, record.pidStart);
    const cpuPercent = cpuPercentBetween(before, current, now - previousSampleAt);
    if (cpuPercent === null || cpuPercent >= cpuLimit) continue;
    candidates.push({
      record,
      ageMs,
      predictedMs: prediction.ms,
      sampleCount: prediction.samples,
      cpuPercent,
      childProcesses: current.children.slice(0, 10),
    });
  }
  return { candidates, processes: currentProcesses };
}

export { MIN_PREDICTED_HOLD_MS };
