// Resource leases: a project takes one item of a shared pool, for example a local serve port, and gives it back.
// The leases are in leases.json in the data directory. Each change holds the machine mutation lock of src/kit/locks.js.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, DEFAULT_IDLE_MINUTES, isPortsPool, portEnvFor } from './config.js';
import { quietHoursActive, readNight } from './night.js';
import { hasLiveWorkerRun, MUTATION_GUARD_WAIT_MS, withMutationLock } from './kit/locks.js';
import { sharedWorktreeRoot } from './kit/config.js';
import { processInfo } from './kit/process-info.js';
import { verifyCallerPane } from './kit/workers.js';

export { processInfo } from './kit/process-info.js';

const LEASES_FILE = 'leases.json';
const WORKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CDP_MISSES_TO_RECLAIM = 2;
// Port 9222 is the protected legacy browser. No pool ever leases it.
export const PROTECTED_PORT = '9222';
export const PROJECT_BROWSER_POOL_NAME = 'project-browsers';
const PROJECT_BROWSER_LOW = 9223;
const PROJECT_BROWSER_HIGH = 9299;

// The built-in pool of project browser ports. A project holds its port across sessions: the lease has no pane, no worker, and no TTL.
// Only an explicit release or the cdp check reclaims it.
export function projectBrowserPool() {
  const items = [];
  for (let port = PROJECT_BROWSER_LOW; port <= PROJECT_BROWSER_HIGH; port += 1) items.push(String(port));
  return { name: PROJECT_BROWSER_POOL_NAME, items, split: {}, env: null, ttlMinutes: null, check: 'cdp', graceMinutes: 0, holder: 'project', builtIn: true };
}

// Merge the config pools with the built-in pools. A config pool with a built-in name is an error, and then no config pool is used,
// as for every other pool config error. The built-in pool stays.
export function leasePools(cfg = {}) {
  const errors = [...(cfg.resourcePoolErrors ?? [])];
  let configPools = cfg.resourcePools ?? [];
  if (configPools.some((pool) => pool.name === PROJECT_BROWSER_POOL_NAME)) {
    errors.push(`resourcePools has a pool named ${PROJECT_BROWSER_POOL_NAME}. ${PROJECT_BROWSER_POOL_NAME} is a built-in pool. Rename or remove the config pool.`);
  }
  if (errors.length) configPools = [];
  return { pools: [...configPools, projectBrowserPool()], errors };
}

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function timeValue(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

// The same guard directory as the machine-scope locks in src/kit/locks.js, so a lease change and a lock change never overlap.
function machineMutationLock(dataDir, operation, waitMs) {
  const directory = privateDirectory(path.join(privateDirectory(path.join(dataDir, 'locks')), 'machine'));
  return withMutationLock(directory, operation, { waitMs, busyMessage: 'A lock or lease operation is already in progress. Retry when it finishes.' });
}

export function readLeases(dataDir = DATA_DIR) {
  const file = path.join(dataDir, LEASES_FILE);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { leases: [] };
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  if (!value || !Array.isArray(value.leases)) throw new Error(`${file} must hold a leases array. Refusing to change it.`);
  return value;
}

function writeLeases(dataDir, store) {
  const file = path.join(dataDir, LEASES_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function changeLeases(dataDir, operation, waitMs = MUTATION_GUARD_WAIT_MS) {
  fs.mkdirSync(dataDir, { recursive: true });
  return machineMutationLock(dataDir, () => {
    const store = readLeases(dataDir);
    const result = operation(store);
    writeLeases(dataDir, store);
    return result;
  }, waitMs);
}

// Serialize a pool config change with lease changes. The caller can inspect the current leases
// and write config.json while no acquire, release, or reclaim operation is in progress.
export function withResourcePoolMutation(operation, { dataDir = DATA_DIR } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  return machineMutationLock(dataDir, () => {
    const store = readLeases(dataDir);
    // dropLeases(filter) removes the matching leases and writes leases.json inside the same lock.
    const dropLeasesLocked = (filter) => {
      const dropped = store.leases.filter(filter);
      store.leases = store.leases.filter((lease) => !filter(lease));
      writeLeases(dataDir, store);
      return dropped;
    };
    return operation(store.leases, { dropLeases: dropLeasesLocked });
  });
}

// A synchronous probe: a child Node process connects to 127.0.0.1:PORT. Return true when the connection opens, false on ECONNREFUSED,
// and null (unknown) on a timeout or any other error. Only a refused connection means that nothing listens.
export function tcpListening(port, { timeoutMs = 1000 } = {}) {
  const script = `const s = require('node:net').connect({ host: '127.0.0.1', port: ${Number(port)} });
s.setTimeout(${timeoutMs}); s.on('connect', () => { s.destroy(); process.exit(0); });
s.on('timeout', () => process.exit(2)); s.on('error', (e) => process.exit(e.code === 'ECONNREFUSED' ? 1 : 2));`;
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: timeoutMs + 2000, env: { PATH: process.env.PATH ?? '' } });
  if (result.status === 0) return true;
  return result.status === 1 ? false : null;
}

// The same check without a child process. Resolve true when 127.0.0.1:PORT accepts a connection, false on ECONNREFUSED,
// and null (unknown) on a timeout or any other error.
export function tcpListeningAsync(port, { timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    let done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(null));
    socket.on('error', (error) => finish(error.code === 'ECONNREFUSED' ? false : null));
  });
}

// A pool with an idle rule: a ports pool that is not the built-in browser pool.
export const hasIdleRule = (pool) => !!pool && !pool.builtIn && pool.check !== 'cdp' && isPortsPool(pool);

function readRunFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Decide the reclaim reason for one lease, or null to keep it. A missing browser process changes lease.cdpMisses.
// browserProcess(lease) returns true or false when the process table is known, and null when it is not.
function idleReason(lease, pool, now) {
  const idleMinutes = pool.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  lease.idleSince ??= new Date(now).toISOString();
  if (now - Date.parse(lease.idleSince) < idleMinutes * 60000) return null;
  return { text: `no listener on port ${lease.item} for ${idleMinutes} minutes${lease.pid == null ? ' and no server process bound' : ''}`, idleMinutes };
}

// A lease of a ports pool also ends when its bound server process is gone, and when its port has had no listener for idleMinutes.
// lease.idleSince records when the first tick saw no listener. A listener clears it.
function reclaimReason(lease, { pool, panes, now, probeTcp, browserProcess, pidInfo, quietHours = false }) {
  if (pool?.check === 'cdp') {
    // A hung Chrome still has its process. Only a missing process counts, so a browser that does not respond keeps its lease.
    const present = typeof browserProcess === 'function' ? browserProcess(lease) : null;
    if (present === true) delete lease.cdpMisses;
    else if (present === false) {
      lease.cdpMisses = (lease.cdpMisses ?? 0) + 1;
      if (lease.cdpMisses >= CDP_MISSES_TO_RECLAIM) return `no Chrome process has port ${lease.item} and the ${lease.project} profile`;
    }
    return null;
  }
  // A bound server: a gone process ends the lease at once. A process that lives and has a listener keeps the lease,
  // whatever happens to the pane, the worker, or the TTL: a dev server outlives its worker pane.
  // A listener that is unknown (no probe, a timeout) also keeps the lease from these reasons. The idle rule decides later.
  let serverLives = false;
  if (lease.pid != null && typeof pidInfo === 'function') {
    const info = pidInfo(lease.pid, { wantStart: !!lease.pidStart });
    if (info && !info.alive) return `server process ${lease.pid} is gone`;
    if (info?.alive && lease.pidStart && info.start && info.start !== lease.pidStart) return `process ${lease.pid} started at a different time than the bound server`;
    if (info?.alive && hasIdleRule(pool)) {
      const listening = typeof probeTcp === 'function' ? probeTcp(lease.item, lease.pool) : null;
      if (listening !== false) serverLives = true;
      if (listening === true) delete lease.idleSince;
      if (listening === false) { const idle = idleReason(lease, pool, now); if (idle) return idle; }
    }
  }
  if (!serverLives) {
    if (lease.pane && panes && !panes.has(lease.pane)) return `pane ${lease.pane} is gone`;
    if (lease.worker && lease.runFile) {
      const run = readRunFile(lease.runFile);
      if (run?.name === lease.worker && run.finishedAt) return `worker ${lease.worker} finished`;
    }
    if (lease.expiresAt != null && Date.parse(lease.expiresAt) <= now) {
      return quietHours ? { held: 'lease TTL expiry' } : 'lease expired';
    }
  }
  // The idle rule. A timeout or an error is unknown: it leaves idleSince as it was and keeps the lease.
  if (lease.pid == null && hasIdleRule(pool) && typeof probeTcp === 'function') {
    const listening = probeTcp(lease.item, lease.pool);
    if (listening === true) delete lease.idleSince;
    else if (listening === false) return idleReason(lease, pool, now);
  }
  return null;
}

function reclaimInStore(store, { pools, panes, now, probeTcp, browserProcess, pidInfo = processInfo, quietHours = false }) {
  const reclaimed = [];
  const held = [];
  store.leases = store.leases.filter((lease) => {
    const pool = pools.find((candidate) => candidate.name === lease.pool);
    const reason = reclaimReason(lease, { pool, panes, now, probeTcp, browserProcess, pidInfo, quietHours });
    if (reason?.held) {
      held.push({ pool: lease.pool, item: lease.item, project: lease.project, worker: lease.worker ?? null, pane: lease.pane ?? null, held: reason.held });
      return true;
    }
    if (!reason) return true;
    const entry = { pool: lease.pool, item: lease.item, project: lease.project, worker: lease.worker ?? null, pane: lease.pane ?? null, reason: typeof reason === 'string' ? reason : reason.text };
    if (reason.idleMinutes != null) entry.idleMinutes = reason.idleMinutes;
    reclaimed.push(entry);
    return false;
  });
  return { reclaimed, held };
}

// The text that the engine sends to the pane of a holder whose lease was reclaimed.
export function reclaimNoticeText(item) {
  if (item.idleMinutes != null) {
    return `Your lease of port ${item.item} in pool ${item.pool} was reclaimed after ${item.idleMinutes} minutes without a listener. Start serve-live again to take a port.`;
  }
  return `Your lease ${item.pool} ${item.item} was reclaimed: ${item.reason}. Stop using it, and take a new one with herdr-boss lease acquire ${item.pool}.`;
}

// Reclaim leases whose holder is gone. `panes` is the set of pane IDs from a successful pane list, or null.
// `browserProcess` checks the leases of a cdp pool. Without it, a cdp lease is not checked.
export function reclaimLeases({ pools, dataDir = DATA_DIR, panes = null, now = Date.now(), night = null, probeTcp = null, browserProcess = null, pidInfo = processInfo, log = () => {}, waitMs = MUTATION_GUARD_WAIT_MS } = {}) {
  if (!fs.existsSync(path.join(dataDir, LEASES_FILE))) return { reclaimed: [], held: [] };
  const at = timeValue(now);
  const quietHours = quietHoursActive(night ?? readNight({ dataDir, now: at }));
  const { reclaimed, held } = changeLeases(dataDir, (store) => reclaimInStore(store, { pools, panes, now: at, probeTcp, browserProcess, pidInfo, quietHours }), waitMs);
  for (const item of reclaimed) log(item);
  for (const item of held) log(item);
  return { reclaimed, held };
}

// The key of a pool item in the records of a listener without a lease, and in the unleased list of the state.
export const unleasedKey = (pool, item) => `${pool}\n${item}`;

// The age of a listener without a lease before Herdr Boss tells the orchestrator of the owner of the process.
export const UNLEASED_NOTICE_MINUTES = 10;
// The most probes of one tick that run at the same time.
const UNLEASED_PROBE_PARALLEL = 8;

// A pool that Herdr Boss reconciles for unleased listeners: a pool with an idle rule. The built-in browser pool has none.
export const reconcilesUnleased = (pool) => hasIdleRule(pool);

let lsofFound = null;

// Whether lsof is on the PATH. The check runs once. Herdr Boss names a listener process with lsof and never with a shell.
export function lsofInstalled() {
  if (lsofFound === null) {
    const result = spawnSync('lsof', ['-v'], { stdio: 'ignore', timeout: 2000, env: { PATH: process.env.PATH ?? '' } });
    lsofFound = !result.error;
  }
  return lsofFound;
}

// The output of lsof, or null when lsof is absent, times out, or fails.
function lsofOutput(args) {
  const result = spawnSync('lsof', args, { encoding: 'utf8', timeout: 2000, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } });
  return result.status === 0 ? result.stdout : null;
}

// The PID of the process that listens on a port, or null when lsof is absent or names no PID.
// lsof prints a PID, a file descriptor and an address. It prints no argument and no environment of the process.
export function listenerPid(port, { hasLsof = lsofInstalled() } = {}) {
  if (!hasLsof) return null;
  const pid = Number(/^p(\d+)$/m.exec(lsofOutput(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']) || '')?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// The working directory of a process, or null when lsof is absent, the process is gone, or it has no cwd.
// lsof prints the path of the working directory. It prints no argument and no environment of the process.
export function processCwd(pid, { hasLsof = lsofInstalled() } = {}) {
  if (!hasLsof || pid == null) return null;
  const directory = /^n(.+)$/m.exec(lsofOutput(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']) || '')?.[1];
  return directory ? path.resolve(directory) : null;
}

// The name of a process, for example "node". ps prints the name only. It prints no argument and no environment.
export function processLabel(pid) {
  if (pid == null) return null;
  const result = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// Whether a directory is a path or a child of a path. A sibling with the same start is not inside it.
const holds = (root, directory) => {
  const relative = path.relative(path.resolve(root), directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// The folder that holds the worker worktrees of a project: the shared worktree root plus the folder name of its repo.
// The kit lays a worktree out as <worktree root>/<repo folder>/<worktree name>, so this folder holds every worktree of
// that project. The root comes from the kit setting, not from a path in this file.
export function projectWorktreeRoot(repo, { worktreeRoot = sharedWorktreeRoot() } = {}) {
  return repo ? path.join(path.resolve(worktreeRoot), path.basename(path.resolve(repo))) : null;
}

// The project that owns a working directory: the project with the longest registry path or worktree path that holds
// it. Both count, so a server that runs in a worker worktree has an owner. A path outside every project gives null.
export function projectOfCwd(directory, projectPaths = []) {
  if (!directory) return null;
  let owner = null;
  let length = -1;
  for (const entry of projectPaths) {
    if (!entry?.slug) continue;
    for (const root of [entry.path, entry.worktreePath]) {
      if (!root || !holds(root, directory)) continue;
      // The longest match wins when a worktree sits inside another project path.
      const size = path.resolve(root).length;
      if (size <= length) continue;
      length = size;
      owner = entry.slug;
    }
  }
  return owner;
}

const safely = (read, fallback = null) => {
  try { return read(); } catch { return fallback; }
};

// The text that the engine sends to the orchestrator of the owner of a listener that no lease holds.
export function unleasedNoticeText(item) {
  const subject = item.pid == null ? 'A process' : `Process ${item.pid}${item.name ? ` (${item.name})` : ''}`;
  return [
    `${subject} has listened on port ${item.item} of pool ${item.pool} for ${item.ageMinutes} minutes. No lease holds this port, so the dashboard does not show this server and the pool counts the port as free.`,
    `Take the port for ${item.owner} and bind the lease to the process: herdr-boss lease acquire ${item.pool} --for ${item.owner} --prefer ${item.item} --pid ${item.pid}`,
    `herdr-boss lease bind ${item.pool} ${item.item} --pid ${item.pid}`,
    'Run lease acquire first, then lease bind. Report the port and the PID to the Boss.',
  ].join('\n');
}

// Find the pool items that a server listens on while no lease holds them. `state` is a Map of "pool\nitem" to
// { firstSeen, notified }; the caller keeps it beside the answers of the lease probe. One tick probes each item once.
// `probePort` is the TCP probe of the tick. `pidOf`, `cwdOf` and `labelOf` name the process that listens.
// `projectPaths` is the [{ slug, path, worktreePath }] of the project registry. The check starts no loop and changes no lease.
// It returns the listeners for the state API and the listeners that reached the notice age.
export async function reconcileUnleasedListeners({
  pools = [], leases = [], state = new Map(), now = Date.now(), probePort = tcpListeningAsync,
  pidOf = listenerPid, cwdOf = processCwd, labelOf = processLabel, projectPaths = [],
  noticeMinutes = UNLEASED_NOTICE_MINUTES, parallel = UNLEASED_PROBE_PARALLEL,
} = {}) {
  const at = timeValue(now);
  const held = new Set(leases.map((lease) => `${lease.pool}\n${lease.item}`));
  // Every free item of every pool with an idle rule gets one probe per tick. The sort gives a stable order.
  const due = pools.filter(reconcilesUnleased)
    .flatMap((pool) => pool.items.filter((item) => !held.has(`${pool.name}\n${item}`)).map((item) => ({ pool: pool.name, item })))
    .sort((a, b) => `${a.pool}\n${a.item}`.localeCompare(`${b.pool}\n${b.item}`, 'en', { numeric: true }));
  const answers = new Map();
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const entry = due[next++];
      let value = null;
      try { value = await probePort(entry.item); } catch { value = null; }
      answers.set(unleasedKey(entry.pool, entry.item), value === true ? true : value === false ? false : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, due.length) }, worker));
  // A lease that takes an item, or a pool that leaves the config, clears the record of that item.
  const dueKeys = new Set(due.map((entry) => unleasedKey(entry.pool, entry.item)));
  for (const key of [...state.keys()]) if (!dueKeys.has(key)) state.delete(key);

  const unleased = [];
  const notices = [];
  for (const entry of due) {
    const key = unleasedKey(entry.pool, entry.item);
    const answer = answers.get(key);
    // An unknown answer keeps the record and shows nothing. A refused connection ends the age of the listener.
    if (answer !== true) {
      if (answer === false) state.delete(key);
      continue;
    }
    const record = state.get(key) || { firstSeen: at, notified: false };
    const pid = safely(() => pidOf(entry.item));
    const owner = pid == null ? null : projectOfCwd(safely(() => cwdOf(pid)), projectPaths);
    const item = {
      pool: entry.pool, item: entry.item, pid, name: pid == null ? null : safely(() => labelOf(pid)),
      firstSeen: new Date(record.firstSeen).toISOString(),
      ageMinutes: Math.max(0, Math.floor((at - record.firstSeen) / 60000)),
      owner,
    };
    unleased.push(item);
    // A notice needs an owner, so a listener of an unknown owner stays a warning in the dashboard. The record keeps
    // that the notice went, so the next tick sends no second notice. markUnleasedNotified sets that flag.
    if (owner && !record.notified && at - record.firstSeen >= noticeMinutes * 60000) notices.push(item);
    state.set(key, record);
  }
  return { unleased, notices };
}

// Record that the notice for a listener went out. The caller marks the record after it sent the notice, so a tick that
// had no orchestrator pane for the owner tries again.
export function markUnleasedNotified(state, item) {
  const record = state.get(unleasedKey(item.pool, item.item));
  if (record) record.notified = true;
}

// The keys of the items that the last tick of the engine found listening with no lease. `lease acquire` reads them to
// hand out a port that nothing listens on. The list comes from the last state snapshot, so it can be a tick old. A
// snapshot that is missing, unreadable, or holds no list gives an empty set.
export function readUnleasedKeys(dataDir = DATA_DIR) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))?.resourceLeases?.unleased;
    return new Set((Array.isArray(rows) ? rows : []).map((row) => unleasedKey(row.pool, row.item)));
  } catch { return new Set(); }
}

function paneSet(herdr) {
  try {
    const response = herdr(['pane', 'list']);
    const panes = Array.isArray(response) ? response : response?.panes;
    if (!Array.isArray(panes)) return null;
    return new Set(panes.map((pane) => pane?.pane_id ?? pane?.paneId ?? pane?.id).filter((id) => typeof id === 'string'));
  } catch { return null; }
}

// Return { role: 'boss' | 'orch' | 'worker', paneId, workspaceId, worker?, runFile? }.
function verifyCaller(env, herdr, config) {
  let caller;
  try { caller = verifyCallerPane(env, herdr, null); }
  catch (error) {
    const paneId = env.HERDR_PANE_ID;
    const workspaceId = env.HERDR_WORKSPACE_ID;
    let pane = null;
    if (paneId && workspaceId && config) {
      try { const response = herdr(['pane', 'get', paneId]); pane = response?.pane ?? response; } catch {}
    }
    const paneWorkspace = pane?.workspace_id ?? pane?.workspaceId ?? pane?.workspace;
    const run = pane && (pane.pane_id ?? pane.paneId ?? pane.id) === paneId && paneWorkspace === workspaceId ? hasLiveWorkerRun(paneId, config.root) : null;
    if (run) return { role: 'worker', paneId, workspaceId, worker: run.name, runFile: run.file };
    throw new Error(`${error.message} A worker pane can take a lease only with a live worker run record for this pane and worktree.`);
  }
  const response = herdr(['pane', 'get', caller.paneId]);
  const label = (response?.pane ?? response)?.label;
  return { role: label === 'boss' ? 'boss' : 'orch', ...caller };
}

function projectOf(config) {
  if (config?.slug) return config.slug;
  throw new Error('Run this command in a project checkout with a Herdr Boss project config.');
}

// Resolve who holds a new lease: the project, the worker, the pane, and the run record file.
function holderFor(caller, config, forTarget) {
  if (forTarget == null) {
    if (caller.role === 'worker') return { project: projectOf(config), worker: caller.worker, pane: caller.paneId, runFile: caller.runFile };
    return { project: projectOf(config), worker: null, pane: caller.paneId, runFile: null };
  }
  if (caller.role === 'worker') throw new Error('A worker pane cannot use --for. It leases for itself.');
  if (caller.role === 'boss') {
    if (!PROJECT_SLUG.test(forTarget)) throw new Error(`--for ${forTarget} must be a project slug.`);
    return { project: forTarget, worker: null, pane: null, runFile: null };
  }
  const project = projectOf(config);
  const file = WORKER_NAME.test(forTarget) ? path.join(config.runsPath, `${forTarget}.json`) : null;
  const run = file ? readRunFile(file) : null;
  if (!run || run.name !== forTarget || run.finishedAt) {
    throw new Error(`No live worker run named ${forTarget} in project ${project}. --for SLUG is allowed only for the Boss pane.`);
  }
  return { project, worker: forTarget, pane: typeof run.pane === 'string' ? run.pane : null, runFile: file };
}

function poolNamed(pools, name) {
  const pool = pools.find((candidate) => candidate.name === name);
  if (!pool) throw fail(`Unknown resource pool ${name}. Pools: ${pools.map((candidate) => candidate.name).join(', ') || '(none)'}.`);
  return pool;
}

// The generic lease commands do not change a built-in pool. The browser commands own it.
function commandPool(pools, name, action) {
  const pool = poolNamed(pools, name);
  if (pool.builtIn) throw fail(`${name} is a built-in pool. Use herdr-boss browser ${action} SLUG.`);
  return pool;
}

function splitOwner(pool, item) {
  return Object.entries(pool.split).find(([, items]) => items.includes(item))?.[0] ?? null;
}

function holderText(lease) {
  return `${lease.project}${lease.worker ? `/${lease.worker}` : ''}`;
}

// Choose an item: the preferred item when it is free, then own split items, then unsplit items, then free split items of other projects.
// An item in `exclude` is not chosen, except as the preferred item. Port 9222 is never chosen.
// `--prefer` wins before the list, so a named port is given out even when a process listens on it. Otherwise the tiers
// keep their order and an item that no process listens on comes before an item in `unleased`.
function chooseItem(pool, store, project, prefer, exclude, unleased = new Set()) {
  const taken = new Set(store.leases.filter((lease) => lease.pool === pool.name).map((lease) => lease.item));
  const free = pool.items.filter((item) => !taken.has(item) && item !== PROTECTED_PORT);
  if (prefer != null && free.includes(prefer)) return prefer;
  const usable = free.filter((item) => !exclude.has(item));
  const own = pool.split[project] ?? [];
  const pick = (list) => list.find((item) => !unleased.has(unleasedKey(pool.name, item))) ?? list[0];
  return pick(usable.filter((item) => own.includes(item)))
    ?? pick(usable.filter((item) => splitOwner(pool, item) === null))
    ?? pick(usable)
    ?? null;
}

function holderLines(pool, store) {
  return store.leases.filter((lease) => lease.pool === pool.name)
    .map((lease) => `- ${lease.item}: ${holderText(lease)}${lease.borrowed ? ' (borrowed)' : ''}, since ${lease.at}, expires ${lease.expiresAt ?? 'never'}`);
}

function emptyPoolError(pool, store, waiters = 0) {
  const queue = waiters ? ` ${waiters} holder${waiters === 1 ? ' is' : 's are'} waiting for a free item and go${waiters === 1 ? 'es' : ''} first. Use --wait SECONDS to queue.` : '';
  return fail(`No free item in pool ${pool.name}.${queue} Holders:\n${holderLines(pool, store).join('\n')}`, 3);
}

const waitingNoun = (pool) => (isPortsPool(pool) ? 'port' : 'item');

// Waiters of a pool in FIFO order. Entries of a process that has gone are removed. The queue lives in leases.json.
function pruneQueue(store, pidInfo) {
  store.queue = (store.queue ?? []).filter((entry) => {
    const info = pidInfo(entry.pid, { wantStart: false });
    return !info || info.alive;
  });
  if (!store.queue.length) delete store.queue;
  return store.queue ?? [];
}

function requireRunning(pid, pidInfo) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw fail('--pid must be a positive whole number.');
  const info = pidInfo(pid, { wantStart: true });
  if (info && !info.alive) throw fail(`Process ${pid} is not running.`);
  return info;
}

function leaseRecord(pool, item, holder, at, ttlMinutes, bound = null) {
  const owner = splitOwner(pool, item);
  const minutes = ttlMinutes ?? pool.ttlMinutes;
  return {
    pool: pool.name,
    item,
    project: holder.project,
    worker: holder.worker ?? null,
    pane: holder.pane ?? null,
    ...(pool.holder === 'project' ? { holder: 'project' } : {}),
    at: new Date(at).toISOString(),
    expiresAt: minutes == null ? null : new Date(at + minutes * 60000).toISOString(),
    borrowed: owner !== null && owner !== holder.project,
    ...(holder.runFile ? { runFile: holder.runFile } : {}),
    ...(bound ? { pid: bound.pid, ...(bound.start ? { pidStart: bound.start } : {}) } : {}),
  };
}

// Take one item for a known holder. worker start calls this after it has verified the orchestrator pane.
// In a pool with project holders, a project holds at most one item. A second call returns the lease that the project holds.
// `unleased` holds the keys of the items that a process listens on with no lease; the function reads the last state
// snapshot when the caller passes none.
// Return { lease, reclaimed }. With a ticket ({ id, project, pid }) the call joins the FIFO queue of the pool when no item is free
// or a waiter is ahead, and returns { lease: null, position, reclaimed } instead of throwing.
export function acquireLeaseFor(poolName, holder, { pools, dataDir = DATA_DIR, prefer = null, exclude = [], ttlMinutes = null, now = Date.now(), panes = null, probeTcp = null, browserProcess = null, pidInfo = processInfo, pid = null, ticket = null, log = () => {}, detail = false, unleased = null } = {}) {
  const pool = poolNamed(pools, poolName);
  if (prefer === PROTECTED_PORT) throw fail(`Port ${PROTECTED_PORT} is protected. No pool leases it.`);
  if (prefer != null && !pool.items.includes(prefer)) throw fail(`Item ${prefer} is not in pool ${pool.name}.`);
  if (pool.holder === 'project' && (holder.worker || holder.pane || ttlMinutes != null)) throw fail(`Pool ${pool.name} leases to a project only, with no worker, pane, or TTL.`);
  if (ttlMinutes != null && (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)) throw fail('--ttl must be a positive whole number of minutes.');
  const bound = pid == null ? null : { pid, start: requireRunning(pid, pidInfo)?.start ?? null };
  const at = timeValue(now);
  const skip = new Set(exclude);
  // The items that a process listens on with no lease, read from the last tick of the engine when the caller gives none.
  const listening = unleased ?? readUnleasedKeys(dataDir);
  const result = changeLeases(dataDir, (store) => {
    const { reclaimed: reclaimedNow } = reclaimInStore(store, { pools, panes, now: at, probeTcp, browserProcess, pidInfo: (processId) => pidInfo(processId, { wantStart: false }) });
    if (pool.holder === 'project') {
      const held = store.leases.find((entry) => entry.pool === pool.name && entry.project === holder.project);
      if (held) return { lease: held, reclaimed: reclaimedNow };
    }
    const queue = pruneQueue(store, pidInfo).filter((entry) => entry.pool === pool.name);
    const taken = new Set(store.leases.filter((lease) => lease.pool === pool.name).map((lease) => lease.item));
    const freeCount = pool.items.filter((item) => !taken.has(item) && item !== PROTECTED_PORT).length;
    let ahead;
    if (ticket) {
      if (!queue.some((entry) => entry.id === ticket.id)) {
        const entry = { pool: pool.name, id: ticket.id, pid: ticket.pid, project: holder.project, at: new Date(at).toISOString() };
        store.queue = [...(store.queue ?? []), entry];
        queue.push(entry);
      }
      ahead = queue.findIndex((entry) => entry.id === ticket.id);
    } else ahead = queue.length;
    const item = ahead < freeCount ? chooseItem(pool, store, holder.project, prefer, skip, listening) : null;
    if (item === null) {
      if (ticket) return { lease: null, position: ahead + 1, reclaimed: reclaimedNow };
      throw emptyPoolError(pool, store, queue.length);
    }
    const record = leaseRecord(pool, item, holder, at, ttlMinutes, bound);
    store.leases.push(record);
    if (ticket) {
      store.queue = store.queue.filter((entry) => entry.id !== ticket.id);
      if (!store.queue.length) delete store.queue;
    }
    return { lease: record, reclaimed: reclaimedNow };
  });
  for (const item of result.reclaimed) log(item);
  return detail ? result : result.lease;
}

function dropTicket(dataDir, id) {
  if (!fs.existsSync(path.join(dataDir, LEASES_FILE))) return;
  changeLeases(dataDir, (store) => {
    if (!store.queue) return;
    store.queue = store.queue.filter((entry) => entry.id !== id);
    if (!store.queue.length) delete store.queue;
  });
}

// Bind an existing lease to the server process that uses its port. A Boss pane or the project of the lease may bind it.
export function bindLease(poolName, item, pid, { pools, dataDir = DATA_DIR, config = null, env = process.env, herdr = null, pidInfo = processInfo } = {}) {
  commandPool(pools, poolName, 'bind');
  const info = requireRunning(pid, pidInfo);
  let project = null;
  if (herdr) {
    const caller = verifyCaller(env, herdr, config);
    project = caller.role === 'boss' ? null : projectOf(config);
  }
  return changeLeases(dataDir, (store) => {
    const lease = store.leases.find((entry) => entry.pool === poolName && entry.item === item);
    if (!lease) throw fail(`No lease of ${poolName} item ${item}.`);
    if (project !== null && lease.project !== project) throw fail(`${poolName} item ${item} is held by project ${lease.project}. Only that project or the Boss can bind it.`);
    lease.pid = pid;
    if (info?.start) lease.pidStart = info.start; else delete lease.pidStart;
    delete lease.idleSince;
    return publicLease(lease);
  });
}

// Write one project browser lease for each browser record, with its recorded port. This runs once: leases.json then records the migration.
// It does not run when a project-browsers lease exists. It changes no port. A record whose port is outside the pool or already leased is skipped.
export function migrateProjectBrowserLeases(sessions, { dataDir = DATA_DIR, now = Date.now(), log = () => {} } = {}) {
  const pool = projectBrowserPool();
  const at = timeValue(now);
  const events = [];
  const migrated = changeLeases(dataDir, (store) => {
    if (store.projectBrowsersMigratedAt || store.leases.some((lease) => lease.pool === pool.name)) return [];
    const written = [];
    for (const [project, session] of Object.entries(sessions ?? {})) {
      const item = String(session?.port);
      const holder = store.leases.find((lease) => lease.pool === pool.name && lease.item === item);
      if (!pool.items.includes(item) || holder || !PROJECT_SLUG.test(project)) {
        events.push({ pool: pool.name, item, project, skipped: true, reason: !pool.items.includes(item) ? `port ${item} is not in pool ${pool.name}` : holder ? `port ${item} is already leased to ${holder.project}` : 'the project name is not a slug' });
        continue;
      }
      const record = leaseRecord(pool, item, { project }, at, null);
      store.leases.push(record);
      written.push(record);
      events.push({ pool: pool.name, item, project, skipped: false });
    }
    store.projectBrowsersMigratedAt = new Date(at).toISOString();
    return written;
  }, 0);
  for (const event of events) log(event);
  return migrated;
}

// Change the pane of a lease, for example after worker start has placed the worker pane.
export function setLeasePane(poolName, item, pane, { dataDir = DATA_DIR } = {}) {
  return changeLeases(dataDir, (store) => {
    const lease = store.leases.find((entry) => entry.pool === poolName && entry.item === item);
    if (lease) lease.pane = pane;
    return lease ?? null;
  });
}

// Remove leases that match the filter without a caller check. worker start and worker collect use it for their own worker.
export function dropLeases(filter, { dataDir = DATA_DIR } = {}) {
  if (!fs.existsSync(path.join(dataDir, LEASES_FILE))) return [];
  return changeLeases(dataDir, (store) => {
    const dropped = store.leases.filter(filter);
    store.leases = store.leases.filter((lease) => !filter(lease));
    return dropped;
  });
}

function pauseSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// One line for each variable of the pool that the port can have: set or not set. It never holds a value.
export function portEnvStatus(pool, item) {
  const present = new Set(portEnvFor(pool, item).map((entry) => entry.env));
  return Object.keys(pool.portEnv ?? {}).map((env) => ({ env, set: present.has(env) }));
}

// Write the variables of a lease to a file that a shell can source: the pool variable and each port value that is configured.
// The file has mode 0600. The command prints no value.
function writeEnvFile(file, pool, item) {
  const lines = [`export ${pool.env}=${shellQuote(item)}`, ...portEnvFor(pool, item).map((entry) => `export ${entry.env}=${shellQuote(entry.value)}`)];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function acquireLease(poolName, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, forTarget = null, prefer = null, ttlMinutes = null,
  now = Date.now(), probeTcp = null, pidInfo = processInfo, pid = null, waitSeconds = null, sleep = pauseSync, clock = Date.now,
  envFile = null, notify = (line) => console.error(line), output = console.log, log = () => {},
} = {}) {
  const pool = commandPool(pools, poolName, 'request');
  const caller = verifyCaller(env, herdr, config);
  const holder = holderFor(caller, config, forTarget);
  const wait = waitSeconds ?? pool.waitSeconds ?? 0;
  if (!Number.isSafeInteger(wait) || wait < 0) throw fail('--wait must be a whole number of seconds.');
  const options = { pools, dataDir, prefer, ttlMinutes, probeTcp, pidInfo, pid, log };
  let lease;
  if (!wait) lease = acquireLeaseFor(poolName, holder, { ...options, now, panes: paneSet(herdr) });
  else {
    const ticket = { id: randomBytes(6).toString('hex'), pid: process.pid };
    const deadline = clock() + wait * 1000;
    let shown = null;
    try {
      for (;;) {
        const at = clock();
        const result = acquireLeaseFor(poolName, holder, { ...options, now: at, panes: paneSet(herdr), ticket, detail: true });
        if (result.lease) { lease = result.lease; break; }
        if (result.position !== shown) {
          shown = result.position;
          notify(`waiting for a free ${waitingNoun(pool)} in pool ${pool.name}, position ${shown}`);
        }
        if (at >= deadline) {
          const holders = holderLines(pool, readLeases(dataDir));
          throw fail(`No free item in pool ${pool.name} after waiting ${wait} seconds. Holders:\n${holders.join('\n')}`, 3);
        }
        sleep(Math.min(1000, Math.max(1, deadline - at)));
      }
    } finally { dropTicket(dataDir, ticket.id); }
  }
  if (envFile) {
    writeEnvFile(envFile, pool, lease.item);
    for (const status of portEnvStatus(pool, lease.item)) notify(`${status.env} for port ${lease.item}: ${status.set ? 'set' : 'not set'}`);
  }
  output(lease.item);
  return lease;
}

export function releaseLease(poolName, item, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, now = Date.now(), probeTcp = null, pidInfo = processInfo, output = console.log, log = () => {},
} = {}) {
  commandPool(pools, poolName, 'release');
  const caller = verifyCaller(env, herdr, config);
  const project = caller.role === 'boss' ? null : projectOf(config);
  const panes = paneSet(herdr);
  const { released, reclaimed } = changeLeases(dataDir, (store) => {
    const { reclaimed: reclaimedNow } = reclaimInStore(store, { pools, panes, now: timeValue(now), probeTcp, pidInfo: (processId) => pidInfo(processId, { wantStart: false }) });
    const index = store.leases.findIndex((lease) => lease.pool === poolName && lease.item === item);
    if (index < 0) {
      const gone = reclaimedNow.find((entry) => entry.pool === poolName && entry.item === item);
      if (gone) return { released: gone, reclaimed: reclaimedNow };
      throw fail(`No lease of ${poolName} item ${item}.`);
    }
    const lease = store.leases[index];
    if (project !== null && lease.project !== project) throw fail(`${poolName} item ${item} is held by project ${lease.project}. Only that project or the Boss can release it.`);
    store.leases.splice(index, 1);
    return { released: lease, reclaimed: reclaimedNow };
  });
  for (const entry of reclaimed) log(entry);
  output(`Released lease ${poolName} ${item}.`);
  return released;
}

// Remove one lease for the dashboard. The dashboard sends the project that it saw, so a stale page cannot
// release a lease that changed hands. A missing lease and a lease of another project both return a conflict.
export function ownerReleaseLease(pool, item, { expectedProject, dataDir = DATA_DIR } = {}) {
  const conflict = () => {
    const error = new Error('The lease changed. Reload the page.');
    error.statusCode = 409;
    return error;
  };
  return changeLeases(dataDir, (store) => {
    const index = store.leases.findIndex((lease) => lease.pool === pool && lease.item === item);
    const lease = index < 0 ? null : store.leases[index];
    if (!lease || lease.project !== expectedProject) throw conflict();
    store.leases.splice(index, 1);
    return publicLease(lease);
  });
}

const publicLease = ({ runFile, tcpMisses, cdpMisses, ...lease }) => lease;


// Mask the client id values of a pool: each entry becomes the word set. The pool object of the state and of every API answer goes through this.
export function publicPool(pool) {
  if (!pool?.portEnv) return pool;
  const portEnv = Object.fromEntries(Object.entries(pool.portEnv).map(([env, entries]) => [env, Object.fromEntries(Object.keys(entries).map((spec) => [spec, 'set']))]));
  return { ...pool, portEnv };
}

// Print the pool items and their leases. Nothing changes. A lease of a ports pool also shows bound, listener, and pidAlive, read now.
export function listLeases({ pools, dataDir = DATA_DIR, pool = null, now = Date.now(), probeTcp = tcpListening, pidInfo = processInfo, output = console.log } = {}) {
  const selected = pool == null ? pools : [poolNamed(pools, pool)];
  const { leases } = readLeases(dataDir);
  const result = selected.map((entry) => ({
    pool: entry.name,
    env: entry.env,
    ...(hasIdleRule(entry) ? { idleMinutes: entry.idleMinutes ?? DEFAULT_IDLE_MINUTES } : {}),
    items: entry.items.map((item) => {
      const lease = leases.find((candidate) => candidate.pool === entry.name && candidate.item === item);
      let shown = null;
      if (lease) {
        shown = publicLease(lease);
        if (hasIdleRule(entry)) {
          shown.bound = lease.pid != null;
          shown.listener = probeTcp(item, entry.name);
          if (lease.pid != null) shown.pidAlive = pidInfo(lease.pid, { wantStart: false })?.alive ?? null;
        }
      }
      const statuses = portEnvStatus(entry, item);
      return { item, split: splitOwner(entry, item), lease: shown, ...(statuses.length ? { portEnv: Object.fromEntries(statuses.map((status) => [status.env, status.set ? 'set' : 'not set'])) } : {}) };
    }),
  }));
  output(JSON.stringify(result, null, 2));
  return result;
}

function age(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// One bulletin line per pool: each item with its holder, age, and borrowed mark, or free.
// A built-in pool lists only the leased items and the count of free items.
export function leaseBulletinLines({ pools = [], leases = [], errors = [] } = {}, now = Date.now()) {
  const lines = errors.map((error) => `- Resource pool config is invalid: ${error}`);
  for (const pool of pools) {
    if (pool.builtIn) {
      const held = pool.items.map((item) => leases.find((candidate) => candidate.pool === pool.name && candidate.item === item)).filter(Boolean);
      const parts = held.map((lease) => `${lease.item} ${holderText(lease)} ${age(timeValue(now) - Date.parse(lease.at))}`);
      parts.push(`${pool.items.length - held.length} free`);
      lines.push(`- ${pool.name} (built-in, ports ${pool.items[0]}-${pool.items.at(-1)}; use herdr-boss browser request): ${parts.join('; ')}`);
      continue;
    }
    const parts = pool.items.map((item) => {
      const lease = leases.find((candidate) => candidate.pool === pool.name && candidate.item === item);
      if (!lease) return `${item} free`;
      return `${item} ${holderText(lease)} ${age(timeValue(now) - Date.parse(lease.at))}${lease.borrowed ? ' borrowed' : ''}`;
    });
    lines.push(`- ${pool.name} (${pool.env}): ${parts.join('; ')}`);
  }
  return lines;
}

export { publicLease };
