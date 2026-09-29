// Resource leases: a project takes one item of a shared pool, for example a local serve port, and gives it back.
// The leases are in leases.json in the data directory. Each change holds the machine mutation lock of src/kit/locks.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { quietHoursActive, readNight } from './night.js';
import { hasLiveWorkerRun, MUTATION_GUARD_WAIT_MS, withMutationLock } from './kit/locks.js';
import { verifyCallerPane } from './kit/workers.js';

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
  return machineMutationLock(dataDir, () => operation(readLeases(dataDir).leases));
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

// Decide the reclaim reason for one lease, or null to keep it. A missing browser process changes lease.cdpMisses.
// browserProcess(lease) returns true or false when the process table is known, and null when it is not.
function reclaimReason(lease, { pool, panes, now, probeTcp, browserProcess, quietHours = false }) {
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
  if (lease.pane && panes && !panes.has(lease.pane)) return `pane ${lease.pane} is gone`;
  if (lease.worker && lease.runFile) {
    const run = readRunFile(lease.runFile);
    if (run?.name === lease.worker && run.finishedAt) return `worker ${lease.worker} finished`;
  }
  if (lease.expiresAt != null && Date.parse(lease.expiresAt) <= now) {
    return quietHours ? { held: 'lease TTL expiry' } : 'lease expired';
  }
  // A holder that is alive keeps its lease until its TTL, also when nothing listens yet: a worker can lease a port
  // long before it serves on it. A port without a listener is never a reason to reclaim.
  return null;
}

function reclaimInStore(store, { pools, panes, now, probeTcp, browserProcess, quietHours = false }) {
  const reclaimed = [];
  const held = [];
  store.leases = store.leases.filter((lease) => {
    const pool = pools.find((candidate) => candidate.name === lease.pool);
    const reason = reclaimReason(lease, { pool, panes, now, probeTcp, browserProcess, quietHours });
    if (reason?.held) {
      held.push({ pool: lease.pool, item: lease.item, project: lease.project, worker: lease.worker ?? null, pane: lease.pane ?? null, held: reason.held });
      return true;
    }
    if (!reason) return true;
    reclaimed.push({ pool: lease.pool, item: lease.item, project: lease.project, worker: lease.worker ?? null, pane: lease.pane ?? null, reason });
    return false;
  });
  return { reclaimed, held };
}

// Reclaim leases whose holder is gone. `panes` is the set of pane IDs from a successful pane list, or null.
// `browserProcess` checks the leases of a cdp pool. Without it, a cdp lease is not checked.
export function reclaimLeases({ pools, dataDir = DATA_DIR, panes = null, now = Date.now(), night = null, probeTcp = tcpListening, browserProcess = null, log = () => {}, waitMs = MUTATION_GUARD_WAIT_MS } = {}) {
  if (!fs.existsSync(path.join(dataDir, LEASES_FILE))) return { reclaimed: [], held: [] };
  const at = timeValue(now);
  const quietHours = quietHoursActive(night ?? readNight({ dataDir, now: at }));
  const { reclaimed, held } = changeLeases(dataDir, (store) => reclaimInStore(store, { pools, panes, now: at, probeTcp, browserProcess, quietHours }), waitMs);
  for (const item of reclaimed) log(item);
  for (const item of held) log(item);
  return { reclaimed, held };
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
function chooseItem(pool, store, project, prefer, exclude) {
  const taken = new Set(store.leases.filter((lease) => lease.pool === pool.name).map((lease) => lease.item));
  const free = pool.items.filter((item) => !taken.has(item) && item !== PROTECTED_PORT);
  if (prefer != null && free.includes(prefer)) return prefer;
  const usable = free.filter((item) => !exclude.has(item));
  const own = pool.split[project] ?? [];
  return usable.find((item) => own.includes(item))
    ?? usable.find((item) => splitOwner(pool, item) === null)
    ?? usable[0]
    ?? null;
}

function emptyPoolError(pool, store) {
  const holders = store.leases.filter((lease) => lease.pool === pool.name)
    .map((lease) => `- ${lease.item}: ${holderText(lease)}${lease.borrowed ? ' (borrowed)' : ''}, since ${lease.at}, expires ${lease.expiresAt ?? 'never'}`);
  return fail(`No free item in pool ${pool.name}. Holders:\n${holders.join('\n')}`, 3);
}

function leaseRecord(pool, item, holder, at, ttlMinutes) {
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
  };
}

// Take one item for a known holder. worker start calls this after it has verified the orchestrator pane.
// In a pool with project holders, a project holds at most one item. A second call returns the lease that the project holds.
export function acquireLeaseFor(poolName, holder, { pools, dataDir = DATA_DIR, prefer = null, exclude = [], ttlMinutes = null, now = Date.now(), panes = null, probeTcp = tcpListening, browserProcess = null, log = () => {} } = {}) {
  const pool = poolNamed(pools, poolName);
  if (prefer === PROTECTED_PORT) throw fail(`Port ${PROTECTED_PORT} is protected. No pool leases it.`);
  if (prefer != null && !pool.items.includes(prefer)) throw fail(`Item ${prefer} is not in pool ${pool.name}.`);
  if (pool.holder === 'project' && (holder.worker || holder.pane || ttlMinutes != null)) throw fail(`Pool ${pool.name} leases to a project only, with no worker, pane, or TTL.`);
  if (ttlMinutes != null && (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)) throw fail('--ttl must be a positive whole number of minutes.');
  const at = timeValue(now);
  const skip = new Set(exclude);
  const { lease, reclaimed } = changeLeases(dataDir, (store) => {
    const { reclaimed: reclaimedNow } = reclaimInStore(store, { pools, panes, now: at, probeTcp, browserProcess });
    if (pool.holder === 'project') {
      const held = store.leases.find((entry) => entry.pool === pool.name && entry.project === holder.project);
      if (held) return { lease: held, reclaimed: reclaimedNow };
    }
    const item = chooseItem(pool, store, holder.project, prefer, skip);
    if (item === null) throw emptyPoolError(pool, store);
    const record = leaseRecord(pool, item, holder, at, ttlMinutes);
    store.leases.push(record);
    return { lease: record, reclaimed: reclaimedNow };
  });
  for (const item of reclaimed) log(item);
  return lease;
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

export function acquireLease(poolName, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, forTarget = null, prefer = null, ttlMinutes = null,
  now = Date.now(), probeTcp = tcpListening, output = console.log, log = () => {},
} = {}) {
  commandPool(pools, poolName, 'request');
  const caller = verifyCaller(env, herdr, config);
  const holder = holderFor(caller, config, forTarget);
  const lease = acquireLeaseFor(poolName, holder, { pools, dataDir, prefer, ttlMinutes, now, panes: paneSet(herdr), probeTcp, log });
  output(lease.item);
  return lease;
}

export function releaseLease(poolName, item, {
  pools, dataDir = DATA_DIR, config = null, env = process.env, herdr, now = Date.now(), probeTcp = tcpListening, output = console.log, log = () => {},
} = {}) {
  commandPool(pools, poolName, 'release');
  const caller = verifyCaller(env, herdr, config);
  const project = caller.role === 'boss' ? null : projectOf(config);
  const panes = paneSet(herdr);
  const { released, reclaimed } = changeLeases(dataDir, (store) => {
    const { reclaimed: reclaimedNow } = reclaimInStore(store, { pools, panes, now: timeValue(now), probeTcp });
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
