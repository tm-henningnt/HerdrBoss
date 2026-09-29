import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

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
  store: { messages: 'json' },
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
    // Sweep old code-sign clones that no running Chrome process owns.
    sweepCodeSignClones: true,
  },
  workers: { staleIdleMinutes: 120 },
  watch: {
    quietHours: false,
    maxWorkers: null,
    maxWorkersByLane: { unmetered: null, codex: null, claude: null, opencodego: null },
  },
  // A published project status older than this is stale while workers run or new commits land.
  staleStatusMinutes: 120,
  // Shared resources that projects lease, for example local serve ports. See validateResourcePools().
  resourcePools: [],
  // codexbar provider -> herdr agent kinds that consume it.
  providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['opencode', 'pi'] },
  orchestratorLabel: 'orch',
  roamgate: { port: 8787, tokenFile: path.join(os.homedir(), '.config/roamgate/auth-token') },
};

const CONFIG_SOURCE = Symbol('configSource');
const SERVICE_SETTINGS = [
  ['Machine', 'machine.memFreeWarnPercent'],
  ['Quota', 'quota.warnPercent'],
  ['Quota', 'quota.criticalPercent'],
  ['Status', 'staleStatusMinutes'],
  ['Workers', 'workers.staleIdleMinutes'],
  ['Workers', 'watch.maxWorkers'],
  ['Workers', 'watch.maxWorkersByLane'],
  ['Watch', 'watch.quietHours'],
  ['Browsers', 'browsers.reapOrphanDaemons'],
  ['Browsers', 'browsers.orphanDaemonMinAgeSeconds'],
  ['Browsers', 'browsers.staleOwnedMinutes'],
  ['Browsers', 'browsers.sweepCodeSignClones'],
  ['Service', 'tickSeconds'],
  ['Service', 'quotaSeconds'],
  ['Service', 'push'],
  ['Service', 'alertCooldownSeconds'],
  ['Service', 'providerKinds'],
  ['Service', 'orchestratorLabel'],
  ['Service', 'port'],
  ['Service', 'host'],
];

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


// Old config files hold the watch settings under "night". Read them as "watch". A key under "watch" wins.
export function migrateLegacyWatchKeys(config) {
  if (!isRecord(config) || !Object.hasOwn(config, 'night')) return config;
  const { night, ...rest } = config;
  if (!isRecord(night)) return rest;
  return { ...rest, watch: merge(night, isRecord(rest.watch) ? rest.watch : {}) };
}

// A setting name from an old caller starts with "night.". It means the same setting under "watch".
function watchSettingName(setting) {
  return typeof setting === 'string' && setting.startsWith('night.') ? `watch.${setting.slice(6)}` : setting;
}

export function serviceSettingsView(cfg) {
  const effective = merge(DEFAULTS, migrateLegacyWatchKeys(cfg));
  const configured = migrateLegacyWatchKeys(cfg?.[CONFIG_SOURCE] || {});
  return SERVICE_SETTINGS.map(([group, setting]) => {
    const parts = setting.split('.');
    let value = effective;
    let source = configured;
    let isConfigured = true;
    for (const part of parts) {
      value = value?.[part];
      if (!source || typeof source !== 'object' || !Object.hasOwn(source, part)) isConfigured = false;
      source = source?.[part];
    }
    return {
      group,
      setting,
      value: value && typeof value === 'object' ? structuredClone(value) : value,
      source: isConfigured ? 'config' : 'default',
    };
  });
}

const SERVICE_SETTING_RANGES = new Map([
  ['machine.memFreeWarnPercent', [1, 50]],
  ['quota.warnPercent', [50, 99]],
  ['quota.criticalPercent', [51, 100]],
  ['staleStatusMinutes', [5, 1440]],
  ['workers.staleIdleMinutes', [5, 1440]],
  ['watch.maxWorkers', [1, 40]],
  ['watch.maxWorkersByLane', [1, 40]],
  ['browsers.staleOwnedMinutes', [5, 1440]],
  ['browsers.orphanDaemonMinAgeSeconds', [60, 86400]],
]);
const SERVICE_SETTING_BOOLEANS = new Set([
  'browsers.reapOrphanDaemons',
  'browsers.sweepCodeSignClones',
  'watch.quietHours',
]);
const NULLABLE_SERVICE_SETTINGS = new Set(['watch.maxWorkers']);
const WATCH_WORKER_LANES = new Set(['unmetered', 'codex', 'claude', 'opencodego']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function setServiceSetting(target, setting, value) {
  const parts = setting.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function validateServiceSettingValues(changes) {
  if (!isRecord(changes)) throw new Error('changes must be an object of setting names and values.');
  const entries = Object.entries(changes).map(([setting, value]) => [watchSettingName(setting), value]);
  if (!entries.length) throw new Error('At least one service setting is required.');
  const normalizedChanges = {};
  for (const [setting, value] of entries) {
    const range = SERVICE_SETTING_RANGES.get(setting);
    if (setting === 'watch.maxWorkersByLane') {
      if (!isRecord(value)) throw new Error('watch.maxWorkersByLane must be an object of optional lane caps.');
      const normalized = { ...DEFAULTS.watch.maxWorkersByLane };
      for (const [lane, cap] of Object.entries(value)) {
        if (!WATCH_WORKER_LANES.has(lane)) throw new Error(`watch.maxWorkersByLane has an unknown lane ${lane}.`);
        if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1 || cap > 40)) {
          throw new Error(`watch.maxWorkersByLane.${lane} must be null or a whole number from 1 to 40.`);
        }
        normalized[lane] = cap;
      }
      normalizedChanges[setting] = normalized;
      continue;
    }
    if (range) {
      if (value === null && NULLABLE_SERVICE_SETTINGS.has(setting)) {
        normalizedChanges[setting] = null;
        continue;
      }
      if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
        throw new Error(`${setting} must be a whole number from ${range[0]} to ${range[1]}.`);
      }
      normalizedChanges[setting] = value;
    } else if (SERVICE_SETTING_BOOLEANS.has(setting)) {
      if (typeof value !== 'boolean') throw new Error(`${setting} must be true or false.`);
      normalizedChanges[setting] = value;
    } else {
      throw new Error(`Service setting ${setting} cannot be changed.`);
    }
  }
  return normalizedChanges;
}

export function validateServiceSettings(changes, currentConfig = {}) {
  const normalized = validateServiceSettingValues(changes);
  const effective = merge(DEFAULTS, currentConfig);
  const warnPercent = Object.hasOwn(normalized, 'quota.warnPercent') ? normalized['quota.warnPercent'] : effective.quota?.warnPercent ?? DEFAULTS.quota.warnPercent;
  const criticalPercent = Object.hasOwn(normalized, 'quota.criticalPercent') ? normalized['quota.criticalPercent'] : effective.quota?.criticalPercent ?? DEFAULTS.quota.criticalPercent;
  if (warnPercent >= criticalPercent) throw new Error('quota.warnPercent must be below quota.criticalPercent.');
  return normalized;
}

// Apply validated values to the live config and its source map so the state view changes at once.
export function applyServiceSettings(cfg, changes) {
  const normalized = validateServiceSettingValues(changes);
  for (const [setting, value] of Object.entries(normalized)) {
    setServiceSetting(cfg, setting, value);
    const source = cfg[CONFIG_SOURCE];
    if (isRecord(source)) setServiceSetting(source, setting, value);
  }
  return normalized;
}

// Write only the selected values. Rename a temporary file in the same directory to replace config.json atomically.
export function writeServiceSettings(changes, { dataDir = DATA_DIR } = {}) {
  const directory = path.resolve(dataDir);
  const file = path.join(directory, 'config.json');
  let current = {};
  let mode = 0o600;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o7777;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('config.json must contain valid JSON before settings can be saved.'); }
    if (!isRecord(current)) throw new Error('config.json must contain a JSON object before settings can be saved.');
    current = migrateLegacyWatchKeys(current);
  }
  const normalized = validateServiceSettings(changes, current);
  const updated = structuredClone(current);
  for (const [setting, value] of Object.entries(normalized)) setServiceSetting(updated, setting, value);

  const temporary = path.join(directory, `.config.json.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(updated, null, 2)}\n`);
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw sandboxWriteError(error, directory);
  }
  return normalized;
}

// A server that listens on all interfaces is not reachable at 0.0.0.0, so links use the loopback address.
export function dashboardUrl(cfg) {
  return `http://${['0.0.0.0', '::', ''].includes(cfg.host) ? '127.0.0.1' : cfg.host}:${cfg.port}`;
}

export function loadConfig() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'config.json');
  let user = {};
  try { user = migrateLegacyWatchKeys(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  const cfg = merge(DEFAULTS, user);
  Object.defineProperty(cfg, CONFIG_SOURCE, { value: user });
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

// Replace only resourcePools in config.json. Keep the other settings and the file mode.
export function writeResourcePools(resourcePools, { dataDir = DATA_DIR } = {}) {
  const file = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let config = {};
  let mode = 0o600;
  try {
    const stat = fs.statSync(file);
    mode = stat.mode & 0o7777;
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} must hold a JSON object.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  config.resourcePools = resourcePools;
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return config;
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
