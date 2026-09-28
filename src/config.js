import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(path.join(os.homedir(), '.herdr-boss'));
export const LIVE_DATA_DIR = path.resolve(process.env.HERDR_BOSS_LIVE_DIR || DEFAULT_DATA_DIR);
export const DATA_DIR = path.resolve(process.env.HERDR_BOSS_DIR || LIVE_DATA_DIR);
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const HOME_DIR = process.env.HOME || os.homedir();
export const PRIVATE_ACCESS_DIR = path.join(HOME_DIR, '.config', 'herdr-boss');
export const DEFAULT_TOKEN_FILE = path.join(PRIVATE_ACCESS_DIR, 'access-token');
export const DEFAULT_SESSION_FILE = path.join(PRIVATE_ACCESS_DIR, 'sessions.json');

// fs.realpathSync() needs an existing path. Resolve the deepest existing ancestor, then re-attach the rest, so a path
// whose final directory does not exist still compares by its real path.
function resolveAlias(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...[...missing].reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// A preview tick writes state.json, rules.json, bulletin.md, and quota history. Refuse a preview that would write them
// into the service data directory. Compare real paths, so a symlink cannot point the preview at that directory. A data
// directory that holds files from an earlier preview is allowed. Call this before loadConfig() and before serve() write
// any file.
export function assertPreviewDataDir() {
  const separate = 'Set HERDR_BOSS_DIR to a separate directory that the service does not use.';
  const cost = `A read-only preview writes state.json, rules.json, bulletin.md, and quota history. ${separate}`;
  if (!process.env.HERDR_BOSS_DIR) throw new Error(cost);
  const data = resolveAlias(DATA_DIR);
  if (data === resolveAlias(LIVE_DATA_DIR)) throw new Error(`${cost} HERDR_BOSS_DIR is the live service data directory ${data}.`);
  if (data === resolveAlias(DEFAULT_DATA_DIR)) throw new Error(`${cost} HERDR_BOSS_DIR is the default service data directory ${data}.`);
  return DATA_DIR;
}

const SANDBOX_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EROFS']);

// A sandbox refuses writes to the data directory. Explain the refusal instead of printing the raw error.
export function dataNotWritableError(dir, code) {
  const error = new Error(`Herdr Boss cannot write to ${dir} (${code}). A sandbox blocks this write. Run the same command again outside the sandbox (an escalated run).`);
  error.code = 'DATA_NOT_WRITABLE';
  error.exitCode = 77;
  return error;
}

// Map a sandbox write refusal on a path inside the data directory to the sandbox error. Return other errors unchanged.
export function sandboxWriteError(error, dir = DATA_DIR) {
  if (!SANDBOX_WRITE_CODES.has(error?.code) || typeof error.path !== 'string') return error;
  const relative = path.relative(path.resolve(dir), path.resolve(error.path));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return error;
  return dataNotWritableError(dir, error.code);
}

// Create and delete a probe file, so a command that writes Herdr Boss data fails before its first side effect.
export function assertDataWritable(dir = DATA_DIR) {
  const probe = path.join(dir, `.write-probe.${process.pid}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
  } catch (error) {
    if (SANDBOX_WRITE_CODES.has(error.code)) throw dataNotWritableError(dir, error.code);
    throw error;
  }
}

const DEFAULTS = {
  port: 4477,
  host: '0.0.0.0',
  access: { tokenFile: DEFAULT_TOKEN_FILE, sessionDays: 30 },
  // Seconds between collection passes.
  tickSeconds: 30,
  quotaSeconds: 300,
  // Send prompts to orchestrator panes. Notifications to the user are always sent.
  push: true,
  // Minimum seconds before the same alert is pushed again.
  alertCooldownSeconds: 6 * 3600,
  quota: { warnPercent: 90, criticalPercent: 98 },
  machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 },
  // Optional legacy shared browsers. Only alert about explicitly configured entries.
  sharedBrowsers: [],
  browsers: {
    // Terminate agent-browser daemons with no parent, no children and this minimum age.
    reapOrphanDaemons: true,
    orphanDaemonMinAgeSeconds: 2 * 3600,
    // Report an owned automation browser when its agent is idle for this long.
    staleOwnedMinutes: 30,
  },
  workers: { staleIdleMinutes: 120 },
  // A published project status older than this is stale while workers run or new commits land.
  staleStatusMinutes: 120,
  // Shared resources that projects lease, for example local serve ports. See validateResourcePools().
  resourcePools: [],
  // codexbar provider -> herdr agent kinds that consume it.
  providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['opencode', 'pi'] },
  orchestratorLabel: 'orch',
  roamgate: { port: 8787, tokenFile: path.join(os.homedir(), '.config/roamgate/auth-token') },
};

const POOL_KEYS = new Set(['name', 'items', 'range', 'split', 'env', 'ttlMinutes', 'check', 'graceMinutes']);
const POOL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POOL_ITEM = /^[A-Za-z0-9._:-]{1,64}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_POOL_ITEMS = 1000;
const isPort = (item) => /^\d{1,5}$/.test(item) && Number(item) >= 1 && Number(item) <= 65535;

// Validate the resourcePools setting. Return the normalized pools and one message for each error.
// A pool holds only names, items, and limits. An unknown key is an error, so a pool cannot carry a secret.
export function validateResourcePools(value) {
  if (!Array.isArray(value)) return { pools: [], errors: ['resourcePools must be an array.'] };
  const errors = [];
  const pools = [];
  const names = new Set();
  value.forEach((pool, index) => {
    const label = `resourcePools[${index}]`;
    if (!pool || typeof pool !== 'object' || Array.isArray(pool)) { errors.push(`${label} must be an object.`); return; }
    const before = errors.length;
    for (const key of Object.keys(pool)) if (!POOL_KEYS.has(key)) errors.push(`${label} has an unknown key ${key}.`);
    if (typeof pool.name !== 'string' || !POOL_NAME.test(pool.name)) errors.push(`${label}.name must be a slug of lowercase letters, digits, and hyphens.`);
    else if (names.has(pool.name)) errors.push(`${label}.name ${pool.name} is a duplicate.`);
    else names.add(pool.name);
    let items = [];
    if ((pool.items === undefined) === (pool.range === undefined)) errors.push(`${label} must have exactly one of items or range.`);
    else if (pool.items !== undefined) {
      if (!Array.isArray(pool.items) || !pool.items.length) errors.push(`${label}.items must be a non-empty array of strings.`);
      else {
        pool.items.forEach((item, itemIndex) => {
          if (typeof item !== 'string') errors.push(`${label}.items[${itemIndex}] must be a string.`);
          else if (!POOL_ITEM.test(item)) errors.push(`${label}.items[${itemIndex}] must be one token of 1 to 64 letters, digits, dots, colons, underscores, or hyphens.`);
          else if (items.includes(item)) errors.push(`${label}.items has a duplicate: ${item}.`);
          else items.push(item);
        });
      }
    } else {
      const match = typeof pool.range === 'string' ? /^(\d{1,9})-(\d{1,9})$/.exec(pool.range) : null;
      const low = match ? Number(match[1]) : NaN;
      const high = match ? Number(match[2]) : NaN;
      if (!match || low > high) errors.push(`${label}.range must be "LOW-HIGH" with integers and LOW not above HIGH.`);
      else if (high - low + 1 > MAX_POOL_ITEMS) errors.push(`${label}.range must give at most ${MAX_POOL_ITEMS} items.`);
      else for (let item = low; item <= high; item += 1) items.push(String(item));
    }
    const split = {};
    if (pool.split !== undefined) {
      if (!pool.split || typeof pool.split !== 'object' || Array.isArray(pool.split)) errors.push(`${label}.split must be an object of project slugs to item arrays.`);
      else {
        const owner = new Map();
        for (const [slug, list] of Object.entries(pool.split)) {
          if (!PROJECT_SLUG.test(slug)) { errors.push(`${label}.split key ${slug} must be a project slug.`); continue; }
          if (!Array.isArray(list)) { errors.push(`${label}.split.${slug} must be an array of pool items.`); continue; }
          split[slug] = [];
          for (const item of list) {
            if (typeof item !== 'string' || !items.includes(item)) errors.push(`${label}.split.${slug} item ${item} is not in the pool.`);
            else if (owner.has(item)) errors.push(`${label}.split item ${item} is in more than one split.`);
            else { owner.set(item, slug); split[slug].push(item); }
          }
        }
      }
    }
    if (typeof pool.env !== 'string' || !ENV_NAME.test(pool.env)) errors.push(`${label}.env must be an environment variable name of uppercase letters, digits, and underscores.`);
    const ttlMinutes = pool.ttlMinutes ?? 240;
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1) errors.push(`${label}.ttlMinutes must be a positive integer.`);
    const graceMinutes = pool.graceMinutes ?? 10;
    if (!Number.isSafeInteger(graceMinutes) || graceMinutes < 0) errors.push(`${label}.graceMinutes must be a non-negative integer.`);
    const check = pool.check ?? null;
    if (check !== null && check !== 'tcp') errors.push(`${label}.check must be "tcp" or null.`);
    if (check === 'tcp') for (const item of items.filter((entry) => !isPort(entry))) errors.push(`${label}.check "tcp" needs port items; ${item} is not a port.`);
    if (errors.length === before) pools.push({ name: pool.name, items, split, env: pool.env, ttlMinutes, check, graceMinutes });
  });
  return { pools, errors };
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  }
  return out;
}

// A server that listens on all interfaces is not reachable at 0.0.0.0, so links use the loopback address.
export function dashboardUrl(cfg) {
  return `http://${['0.0.0.0', '::', ''].includes(cfg.host) ? '127.0.0.1' : cfg.host}:${cfg.port}`;
}

export function loadConfig() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cfg = merge(DEFAULTS, user);
  // A stored legacy tokenFile names the data directory. Report the private default in memory. Only
  // migrateAccessFiles() writes the new setting.
  if (cfg.access.tokenFile === path.join(DATA_DIR, 'access-token')) cfg.access.tokenFile = DEFAULT_TOKEN_FILE;
  // An invalid pool list gives no pools. The lease commands and the bulletin name each error.
  const pools = validateResourcePools(cfg.resourcePools);
  cfg.resourcePools = pools.errors.length ? [] : pools.pools;
  cfg.resourcePoolErrors = pools.errors;
  if (process.env.HERDR_BOSS_PUSH === '0') cfg.push = false;
  if (process.env.HERDR_BOSS_PORT) cfg.port = Number(process.env.HERDR_BOSS_PORT);
  return cfg;
}

// A legacy install kept the token and the session file in the shared data directory. Move both to the private
// directory, keep the default tokenFile, and apply the private modes. This changes files on disk, so it runs only
// from the paths that serve the dashboard and install the service. Call it after loadConfig().
export function migrateAccessFiles(cfg) {
  if (cfg.access.tokenFile !== DEFAULT_TOKEN_FILE) return;
  const file = path.join(DATA_DIR, 'config.json');
  const legacyToken = path.join(DATA_DIR, 'access-token');
  const legacySessions = path.join(DATA_DIR, 'sessions.json');
  if (fs.existsSync(legacyToken) || fs.existsSync(legacySessions)) {
    fs.mkdirSync(PRIVATE_ACCESS_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(PRIVATE_ACCESS_DIR, 0o700);
  }
  for (const [legacy, target] of [[legacyToken, DEFAULT_TOKEN_FILE], [legacySessions, DEFAULT_SESSION_FILE]]) {
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      try { fs.renameSync(legacy, target); } catch (error) { if (error.code !== 'EXDEV') throw error; }
    }
    if (fs.existsSync(target)) {
      fs.chmodSync(target, 0o600);
      if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    }
  }
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (user.access?.tokenFile === legacyToken) {
    user.access.tokenFile = DEFAULT_TOKEN_FILE;
    fs.writeFileSync(file, `${JSON.stringify(user, null, 2)}\n`, { mode: 0o600 });
  }
}
