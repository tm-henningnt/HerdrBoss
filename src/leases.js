// Resource leases: a project takes one item of a shared pool, for example a local serve port, and gives it back.
// The leases are in leases.json in the data directory. Each change holds the machine mutation lock of src/kit/locks.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { hasLiveWorkerRun, withMutationLock } from './kit/locks.js';
import { verifyCallerPane } from './kit/workers.js';

const LEASES_FILE = 'leases.json';
const WORKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
// A command waits this long for a busy mutation lock. The engine does not wait; it tries again on the next tick.
const COMMAND_LOCK_WAIT_MS = 5000;
const TCP_MISSES_TO_RECLAIM = 2;

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

function changeLeases(dataDir, operation, waitMs = COMMAND_LOCK_WAIT_MS) {
  fs.mkdirSync(dataDir, { recursive: true });
  return machineMutationLock(dataDir, () => {
    const store = readLeases(dataDir);
    const result = operation(store);
    writeLeases(dataDir, store);
    return result;
  }, waitMs);
}

// A synchronous probe: a child Node process connects to 127.0.0.1:PORT and exits 0 when the connection opens.
export function tcpListening(port, { timeoutMs = 1000 } = {}) {
  const script = `const s = require('node:net').connect({ host: '127.0.0.1', port: ${Number(port)} });
s.setTimeout(${timeoutMs}); s.on('connect', () => { s.destroy(); process.exit(0); });
s.on('timeout', () => process.exit(1)); s.on('error', () => process.exit(1));`;
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: timeoutMs + 2000, env: { PATH: process.env.PATH ?? '' } });
  return result.status === 0;
}

function readRunFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Decide the reclaim reason for one lease, or null to keep it. A TCP miss changes lease.tcpMisses.
function reclaimReason(lease, { pool, panes, now, probeTcp }) {
  if (lease.pane && panes && !panes.has(lease.pane)) return `pane ${lease.pane} is gone`;
  if (lease.worker && lease.runFile) {
    const run = readRunFile(lease.runFile);
    if (run?.name === lease.worker && run.finishedAt) return `worker ${lease.worker} finished`;
  }
  if (Date.parse(lease.expiresAt) <= now) return 'lease expired';
  if (pool?.check === 'tcp' && now - Date.parse(lease.at) >= pool.graceMinutes * 60000) {
    if (probeTcp(lease.item)) delete lease.tcpMisses;
    else {
      lease.tcpMisses = (lease.tcpMisses ?? 0) + 1;
      if (lease.tcpMisses >= TCP_MISSES_TO_RECLAIM) return `nothing listens on 127.0.0.1:${lease.item}`;
    }
  }
  return null;
}

function reclaimInStore(store, { pools, panes, now, probeTcp }) {
  const reclaimed = [];
  store.leases = store.leases.filter((lease) => {
    const pool = pools.find((candidate) => candidate.name === lease.pool);
    const reason = reclaimReason(lease, { pool, panes, now, probeTcp });
    if (!reason) return true;
    reclaimed.push({ pool: lease.pool, item: lease.item, project: lease.project, worker: lease.worker ?? null, reason });
    return false;
  });
  return reclaimed;
}

// Reclaim leases whose holder is gone. `panes` is the set of pane IDs from a successful pane list, or null.
export function reclaimLeases({ pools, dataDir = DATA_DIR, panes = null, now = Date.now(), probeTcp = tcpListening, log = () => {}, waitMs = COMMAND_LOCK_WAIT_MS } = {}) {
  if (!fs.existsSync(path.join(dataDir, LEASES_FILE))) return { reclaimed: [] };
  const reclaimed = changeLeases(dataDir, (store) => reclaimInStore(store, { pools, panes, now: timeValue(now), probeTcp }), waitMs);
  for (const item of reclaimed) log(item);
  return { reclaimed };
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

function splitOwner(pool, item) {
  return Object.entries(pool.split).find(([, items]) => items.includes(item))?.[0] ?? null;
}

function holderText(lease) {
  return `${lease.project}${lease.worker ? `/${lease.worker}` : ''}`;
}

// Choose an item: the preferred item when it is free, then own split items, then unsplit items, then free split items of other projects.
function chooseItem(pool, store, project, prefer) {
  const taken = new Set(store.leases.filter((lease) => lease.pool === pool.name).map((lease) => lease.item));
  const free = pool.items.filter((item) => !taken.has(item));
  if (prefer != null && free.includes(prefer)) return prefer;
  const own = pool.split[project] ?? [];
  return free.find((item) => own.includes(item))
    ?? free.find((item) => splitOwner(pool, item) === null)
    ?? free[0]
    ?? null;
}

function emptyPoolError(pool, store) {
  const holders = store.leases.filter((lease) => lease.pool === pool.name)
    .map((lease) => `- ${lease.item}: ${holderText(lease)}${lease.borrowed ? ' (borrowed)' : ''}, since ${lease.at}, expires ${lease.expiresAt}`);
  return fail(`No free item in pool ${pool.name}. Holders:\n${holders.join('\n')}`, 3);
}

// Take one item for a known holder. worker start calls this after it has verified the orchestrator pane.
export function acquireLeaseFor(poolName, holder, { pools, dataDir = DATA_DIR, prefer = null, ttlMinutes = null, now = Date.now(), panes = null, probeTcp = tcpListening, log = () => {} } = {}) {
  const pool = poolNamed(pools, poolName);
  if (prefer != null && !pool.items.includes(prefer)) throw fail(`Item ${prefer} is not in pool ${pool.name}.`);
  if (ttlMinutes != null && (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)) throw fail('--ttl must be a positive whole number of minutes.');
  const at = timeValue(now);
  const { lease, reclaimed } = changeLeases(dataDir, (store) => {
    const reclaimedNow = reclaimInStore(store, { pools, panes, now: at, probeTcp });
    const item = chooseItem(pool, store, holder.project, prefer);
    if (item === null) throw emptyPoolError(pool, store);
    const owner = splitOwner(pool, item);
    const record = {
      pool: pool.name,
      item,
      project: holder.project,
      worker: holder.worker ?? null,
      pane: holder.pane ?? null,
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + (ttlMinutes ?? pool.ttlMinutes) * 60000).toISOString(),
      borrowed: owner !== null && owner !== holder.project,
      ...(holder.runFile ? { runFile: holder.runFile } : {}),
    };
    store.leases.push(record);
    return { lease: record, reclaimed: reclaimedNow };
  });
  for (const item of reclaimed) log(item);
  return lease;
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

export function acquireLease(poolName, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, forTarget = null, prefer = null, ttlMinutes = null,
  now = Date.now(), probeTcp = tcpListening, output = console.log, log = () => {},
} = {}) {
  poolNamed(pools, poolName);
  const caller = verifyCaller(env, herdr, config);
  const holder = holderFor(caller, config, forTarget);
  const lease = acquireLeaseFor(poolName, holder, { pools, dataDir, prefer, ttlMinutes, now, panes: paneSet(herdr), probeTcp, log });
  output(lease.item);
  return lease;
}

export function releaseLease(poolName, item, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, now = Date.now(), probeTcp = tcpListening, output = console.log, log = () => {},
} = {}) {
  poolNamed(pools, poolName);
  const caller = verifyCaller(env, herdr, config);
  const project = caller.role === 'boss' ? null : projectOf(config);
  const panes = paneSet(herdr);
  const { released, reclaimed } = changeLeases(dataDir, (store) => {
    const reclaimedNow = reclaimInStore(store, { pools, panes, now: timeValue(now), probeTcp });
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

const publicLease = ({ runFile, tcpMisses, ...lease }) => lease;

export function listLeases({ pools, dataDir = DATA_DIR, pool = null, output = console.log } = {}) {
  const selected = pool == null ? pools : [poolNamed(pools, pool)];
  const { leases } = readLeases(dataDir);
  const result = selected.map((entry) => ({
    pool: entry.name,
    env: entry.env,
    items: entry.items.map((item) => {
      const lease = leases.find((candidate) => candidate.pool === entry.name && candidate.item === item);
      return { item, split: splitOwner(entry, item), lease: lease ? publicLease(lease) : null };
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
export function leaseBulletinLines({ pools = [], leases = [], errors = [] } = {}, now = Date.now()) {
  const lines = errors.map((error) => `- Resource pool config is invalid: ${error}`);
  for (const pool of pools) {
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
