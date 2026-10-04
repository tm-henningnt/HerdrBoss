import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_DATA_DIR = path.resolve(path.join(os.homedir(), '.herdr-boss'));
// The service data directory. The serve guard compares against DEFAULT_DATA_DIR. The engine and the test harness read
// HERDR_BOSS_LIVE_DIR through this constant.
export const LIVE_DATA_DIR = path.resolve(process.env.HERDR_BOSS_LIVE_DIR || DEFAULT_DATA_DIR);
export const DATA_DIR = path.resolve(process.env.HERDR_BOSS_DIR || LIVE_DATA_DIR);
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const HOME_DIR = process.env.HOME || os.homedir();
export const PRIVATE_ACCESS_DIR = path.join(HOME_DIR, '.config', 'herdr-boss');
export const DEFAULT_TOKEN_FILE = path.join(PRIVATE_ACCESS_DIR, 'access-token');
export const DEFAULT_SESSION_FILE = path.join(PRIVATE_ACCESS_DIR, 'sessions.json');

// fs.realpathSync() needs an existing path. Resolve the deepest existing ancestor, then re-attach the rest, so a path
// whose final directory does not exist still compares by its real path.
export function resolveAlias(target) {
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

// Refuse an active service before it writes credentials, state, or action records.
export function assertLiveDataDir(liveDataDir = DEFAULT_DATA_DIR) {
  if (DATA_DIR !== path.resolve(liveDataDir)) {
    throw new Error(`Herdr Boss cannot start: the data directory ${DATA_DIR} differs from the live data directory ${liveDataDir}. Use the live directory for serve. Use --read-only-preview for a separate data directory.`);
  }
  return DATA_DIR;
}

// chromePath follows the root rules: an absolute path or ~ path with no .. segment. The default is the macOS path.
export const ROOT_DEFAULTS = Object.freeze({ worktreeRoot: '~/Projects/.herdr-wt', projectRoot: '~/Projects', chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

export function resolveRootPath(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
    || !(path.isAbsolute(value) || value === '~' || value.startsWith('~/'))) {
    throw new Error('A root must be an absolute path or a path that starts with ~. Control characters are not allowed.');
  }
  if (value.split(/[\\/]/).includes('..')) throw new Error('A root must not contain a .. segment.');
  const resolved = path.resolve(value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
  if (resolved === path.parse(resolved).root) throw new Error('A root must not be the file system root.');
  return resolved;
}

// Read roots without creating the data directory. CLI consumers use the saved values on each invocation.
export function readRootSettings({ dataDir = DATA_DIR } = {}) {
  const file = path.join(dataDir, 'config.json');
  const roots = { ...ROOT_DEFAULTS };
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return roots;
    console.error(`Herdr Boss: ${file} is not valid JSON. Using the default roots.`);
    return roots;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    console.error(`Herdr Boss: ${file} is not a JSON object. Using the default roots.`);
    return roots;
  }
  for (const setting of Object.keys(roots)) {
    if (!Object.hasOwn(config, setting)) continue;
    try { resolveRootPath(config[setting]); roots[setting] = config[setting]; }
    catch { console.error(`Herdr Boss: ${file} has an invalid ${setting}. Using the default ${setting}.`); }
  }
  return roots;
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
  ...ROOT_DEFAULTS,
  store: { messages: 'json' },
  port: 4477,
  host: '0.0.0.0',
  // Host names that the control plane accepts in addition to the built-in rule. See hostAllowedByList().
  allowedHosts: [],
  // The server log file: rotate at this size and keep this number of old files.
  log: { maxMegabytes: 10, keepFiles: 2 },
  access: { tokenFile: DEFAULT_TOKEN_FILE, sessionDays: 30 },
  // Seconds between collection passes.
  tickSeconds: 30,
  quotaSeconds: 300,
  // Send prompts to orchestrator panes. Notifications to the user are always sent.
  push: true,
  // Minimum seconds before the same alert is pushed again.
  alertCooldownSeconds: 6 * 3600,
  quota: { warnPercent: 90, criticalPercent: 98 },
  quotaPlan: { burstPace: 1, applyThreshold: 95, margin: 0, horizon: 'last-expiry', tolerance: 5, holdMargin: 1, slowFactor: 0.5, planMode: 'paced' },
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
  browser: { idleCloseMinutes: 20 },
  workers: { staleIdleMinutes: 120, paneCloseDelayMinutes: 2, uncollectedNoticeMinutes: 30, leaseGraceMinutes: 30 },
  analytics: { actionsMinutes: true },
  watch: {
    quietHours: false,
    maxWorkers: null,
    maxWorkersByLane: { unmetered: null, codex: null, claude: null, opencodego: null },
  },
  // A published project status older than this is stale while workers run or new commits land.
  staleStatusMinutes: 120,
  // A published phase or summary that keeps the same text for this long is stale text. See staleTextStatuses().
  staleTextMinutes: 360,
  // Shared resources that projects lease, for example local serve ports. See validateResourcePools().
  resourcePools: [],
  // codexbar provider -> herdr agent kinds that consume it.
  providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['opencode', 'pi'] },
  orchestratorLabel: 'orch',
  roamgate: { port: 8787, tokenFile: path.join(os.homedir(), '.config/roamgate/auth-token') },
};

const CONFIG_SOURCE = Symbol('configSource');
const SERVICE_SETTINGS = [
  ['Paths', 'worktreeRoot'],
  ['Paths', 'projectRoot'],
  ['Machine', 'machine.memFreeWarnPercent'],
  ['Quota', 'quota.warnPercent'],
  ['Quota', 'quota.criticalPercent'],
  ['Quota plan', 'quotaPlan.burstPace'],
  ['Quota plan', 'quotaPlan.applyThreshold'],
  ['Quota plan', 'quotaPlan.margin'],
  ['Quota plan', 'quotaPlan.horizon'],
  ['Quota plan', 'quotaPlan.tolerance'],
  ['Quota plan', 'quotaPlan.holdMargin'],
  ['Quota plan', 'quotaPlan.slowFactor'],
  ['Quota plan', 'quotaPlan.planMode'],
  ['Status', 'staleStatusMinutes'],
  ['Status', 'staleTextMinutes'],
  ['Workers', 'workers.staleIdleMinutes'],
  ['Workers', 'workers.paneCloseDelayMinutes'],
  ['Workers', 'workers.uncollectedNoticeMinutes'],
  ['Workers', 'workers.leaseGraceMinutes'],
  ['Workers', 'watch.maxWorkers'],
  ['Workers', 'watch.maxWorkersByLane'],
  ['Watch', 'watch.quietHours'],
  ['Browsers', 'browsers.reapOrphanDaemons'],
  ['Browsers', 'browsers.orphanDaemonMinAgeSeconds'],
  ['Browsers', 'browsers.staleOwnedMinutes'],
  ['Browsers', 'browsers.sweepCodeSignClones'],
  ['Browsers', 'browser.idleCloseMinutes'],
  ['Browsers', 'chromePath'],
  ['Service', 'tickSeconds'],
  ['Service', 'quotaSeconds'],
  ['Service', 'push'],
  ['Service', 'alertCooldownSeconds'],
  ['Service', 'providerKinds'],
  ['Service', 'orchestratorLabel'],
  ['Service', 'port'],
  ['Service', 'host'],
  ['Service', 'allowedHosts'],
  ['Service', 'log.maxMegabytes'],
  ['Service', 'log.keepFiles'],
  ['Analytics', 'analytics.actionsMinutes'],
];

const POOL_KEYS = new Set(['name', 'items', 'range', 'split', 'env', 'ttlMinutes', 'check', 'graceMinutes', 'idleMinutes', 'waitSeconds', 'portEnv']);
const POOL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POOL_ITEM = /^[A-Za-z0-9._:-]{1,64}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_POOL_ITEMS = 1000;
const isPort = (item) => /^\d{1,5}$/.test(item) && Number(item) >= 1 && Number(item) <= 65535;
export const PORT_LOW = 1024;
export const PORT_HIGH = 65535;
export const MAX_POOL_PORTS = 100;
export const DEFAULT_IDLE_MINUTES = 20;
export const MAX_PORT_ENV_VALUE = 200;

// Parse "8000-8004,8010" into an array of number strings, in the order given. Return { items } or { error }.
export function parsePortSpec(spec, { maxItems = MAX_POOL_ITEMS } = {}) {
  if (typeof spec !== 'string' || !spec.trim()) return { error: 'must be "LOW-HIGH" or a comma-separated list of those and single numbers' };
  const items = [];
  const seen = new Set();
  for (const part of spec.split(',').map((entry) => entry.trim())) {
    const match = /^(\d{1,9})(?:-(\d{1,9}))?$/.exec(part);
    if (!match) return { error: 'must be "LOW-HIGH" or a comma-separated list of those and single numbers' };
    const low = Number(match[1]);
    const high = match[2] === undefined ? low : Number(match[2]);
    if (low > high) return { error: 'must be "LOW-HIGH" with LOW not above HIGH in each range' };
    if (high - low + 1 > maxItems) return { error: `must give at most ${maxItems} items` };
    for (let item = low; item <= high; item += 1) {
      if (seen.has(item)) return { error: `has a duplicate: ${item}`, duplicate: true };
      seen.add(item);
      items.push(String(item));
    }
    if (items.length > maxItems) return { error: `must give at most ${maxItems} items` };
  }
  return { items };
}

// A ports pool has only numeric items, and either the tcp check or at least one port from 1024 up.
// The idle rule, the port limits, and the client id values apply to a ports pool.
export function isPortsPool(pool) {
  const items = pool?.items ?? [];
  if (!items.length || !items.every((item) => /^\d+$/.test(item))) return false;
  return pool.check === 'tcp' || items.some((item) => Number(item) >= PORT_LOW);
}

// The extra environment variables for one item of a pool: [{ env, value }]. Only a value that is configured is returned.
export function portEnvFor(pool, item) {
  const result = [];
  for (const [env, entries] of Object.entries(pool?.portEnv ?? {})) {
    for (const [spec, value] of Object.entries(entries)) {
      if (parsePortSpec(spec).items?.includes(String(item))) { result.push({ env, value }); break; }
    }
  }
  return result;
}

// Validate the portEnv setting of one pool: { VARIABLE: { "8005-8009": "value" } }. The values are plain strings.
// An error message never holds a value. Return the map, or null when the pool has none.
function validatePortEnv(value, { label, items, env, errors }) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${label}.portEnv must be an object of variable names to port ranges.`); return null; }
  const result = {};
  for (const [name, entries] of Object.entries(value)) {
    const at = `${label}.portEnv.${name}`;
    if (!ENV_NAME.test(name)) { errors.push(`${label}.portEnv key ${name.slice(0, 64)} must be an environment variable name of uppercase letters, digits, and underscores.`); continue; }
    if (name === env) { errors.push(`${at}: ${name} is the lease variable of the pool. Choose another name.`); continue; }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) { errors.push(`${at} must be an object of port ranges to values.`); continue; }
    const owner = new Set();
    result[name] = {};
    for (const [spec, entry] of Object.entries(entries)) {
      const parsed = parsePortSpec(spec);
      if (parsed.error) { errors.push(`${at} key ${spec.slice(0, 40)} ${parsed.error}.`); continue; }
      const outside = parsed.items.find((item) => !items.includes(item));
      if (outside) { errors.push(`${at} port ${outside} is not in the pool.`); continue; }
      const twice = parsed.items.find((item) => owner.has(item));
      if (twice) { errors.push(`${at} port ${twice} is in more than one entry.`); continue; }
      parsed.items.forEach((item) => owner.add(item));
      if (typeof entry !== 'string') errors.push(`${at} value for ${spec} must be a string.`);
      else if (!entry.length) errors.push(`${at} value for ${spec} must be a string of 1 to ${MAX_PORT_ENV_VALUE} characters.`);
      else if (entry.length > MAX_PORT_ENV_VALUE) errors.push(`${at} value for ${spec} must have at most ${MAX_PORT_ENV_VALUE} characters.`);
      else if (/[\s\u0000-\u001f\u007f]/u.test(entry)) errors.push(`${at} value for ${spec} must have no whitespace and no control characters.`);
      else result[name][spec] = entry;
    }
  }
  return result;
}

// Validate the resourcePools setting. Return the normalized pools and one message for each error.
// A pool holds only names, items, and limits. An unknown key is an error, so a pool cannot carry a secret.
export function validateResourcePools(value, { dashboardPort = null } = {}) {
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
      const parsed = parsePortSpec(pool.range);
      if (parsed.error) errors.push(`${label}.range ${parsed.error}.`);
      else items = parsed.items;
    }
    if (errors.length === before && isPortsPool({ items, check: pool.check ?? null })) {
      const outside = items.filter((item) => Number(item) < PORT_LOW || Number(item) > PORT_HIGH);
      if (outside.length) errors.push(`${label} ports must be from ${PORT_LOW} to ${PORT_HIGH}: ${outside.slice(0, 5).join(', ')}.`);
      if (items.length > MAX_POOL_PORTS) errors.push(`${label} must have at most ${MAX_POOL_PORTS} ports.`);
      if (dashboardPort && items.includes(String(dashboardPort))) errors.push(`${label} includes the dashboard port ${dashboardPort}. A pool cannot lease it.`);
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
    const idleMinutes = pool.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    if (!Number.isSafeInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 240) errors.push(`${label}.idleMinutes must be a whole number from 1 to 240.`);
    const waitSeconds = pool.waitSeconds ?? 0;
    if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) errors.push(`${label}.waitSeconds must be a whole number from 0 to 3600.`);
    const portEnv = validatePortEnv(pool.portEnv, { label, items, env: pool.env, errors });
    if (errors.length === before) pools.push({ name: pool.name, items, split, env: pool.env, ttlMinutes, check, graceMinutes, idleMinutes, waitSeconds, ...(portEnv ? { portEnv } : {}) });
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
      value: Object.hasOwn(ROOT_DEFAULTS, setting) ? resolveRootPath(value) : value && typeof value === 'object' ? structuredClone(value) : value,
      source: isConfigured ? 'config' : 'default',
    };
  });
}

const SERVICE_SETTING_RANGES = new Map([
  ['machine.memFreeWarnPercent', [1, 50]],
  ['quota.warnPercent', [50, 99]],
  ['quota.criticalPercent', [51, 100]],
  ['quotaPlan.applyThreshold', [50, 100]],
  ['staleStatusMinutes', [5, 1440]],
  ['staleTextMinutes', [5, 10080]],
  ['workers.staleIdleMinutes', [5, 1440]],
  ['workers.paneCloseDelayMinutes', [0, 60]],
  ['workers.uncollectedNoticeMinutes', [1, 1440]],
  ['workers.leaseGraceMinutes', [1, 1440]],
  ['watch.maxWorkers', [1, 40]],
  ['watch.maxWorkersByLane', [1, 40]],
  ['browsers.staleOwnedMinutes', [5, 1440]],
  ['browser.idleCloseMinutes', [0, 1440]],
  ['browsers.orphanDaemonMinAgeSeconds', [60, 86400]],
  ['tickSeconds', [5, 300]],
  ['quotaSeconds', [30, 3600]],
  ['log.maxMegabytes', [1, 1000]],
  ['log.keepFiles', [1, 2]],
]);
const SERVICE_SETTING_DECIMALS = new Map([
  ['quotaPlan.burstPace', [0.1, 10]],
  ['quotaPlan.margin', [0, 50]],
  ['quotaPlan.tolerance', [0, 50]],
  ['quotaPlan.holdMargin', [0, 50]],
  ['quotaPlan.slowFactor', [0.1, 1]],
]);
const SERVICE_SETTING_TEXT = new Set(['quotaPlan.horizon', 'quotaPlan.planMode']);
const SERVICE_SETTING_BOOLEANS = new Set([
  'browsers.reapOrphanDaemons',
  'browsers.sweepCodeSignClones',
  'watch.quietHours',
  'push',
  'analytics.actionsMinutes',
]);
const MAX_ALLOWED_HOSTS = 50;
// One lower-case DNS label, or a list of labels. A pattern is a name or `*.` and a name. It has no port, user, or path.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Check an allowedHosts list. Return the lower-case list. A name matches itself. `*.name` matches each name below `name`.
export function validateAllowedHosts(value) {
  if (!Array.isArray(value)) throw new Error('allowedHosts must be a list of host names.');
  if (value.length > MAX_ALLOWED_HOSTS) throw new Error(`allowedHosts must have at most ${MAX_ALLOWED_HOSTS} entries.`);
  const seen = new Set();
  return value.map((entry, index) => {
    const pattern = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const name = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (!HOST_NAME.test(name)) throw new Error(`allowedHosts[${index}] must be a host name such as factory-two or *.localhost. A port, a path, an address, and a bare * are not allowed.`);
    if (pattern.startsWith('*.') && name !== 'localhost' && name.split('.').length < 2) throw new Error(`allowedHosts[${index}] needs at least two labels after *. A wildcard such as *.com is not allowed. *.localhost is the only exception.`);
    if (seen.has(pattern)) throw new Error(`allowedHosts has a duplicate entry: ${pattern}.`);
    seen.add(pattern);
    return pattern;
  });
}

// True when the host name matches an entry of the allowedHosts list. hostname has no port and no brackets.
export function hostAllowedByList(hostname, list) {
  const host = String(hostname || '').toLowerCase();
  if (!host || !Array.isArray(list)) return false;
  return list.some((item) => {
    const entry = typeof item === 'string' ? item.toLowerCase() : '';
    return entry.startsWith('*.') ? host.length > entry.length - 1 && host.endsWith(entry.slice(1)) : host === entry;
  });
}

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
    const decimalRange = SERVICE_SETTING_DECIMALS.get(setting);
    if (Object.hasOwn(ROOT_DEFAULTS, setting)) {
      try { normalizedChanges[setting] = resolveRootPath(value); } catch (error) { throw new Error(`${setting}: ${error.message}`); }
      continue;
    }
    if (setting === 'allowedHosts') {
      normalizedChanges[setting] = validateAllowedHosts(value);
      continue;
    }
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
    } else if (decimalRange) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < decimalRange[0] || value > decimalRange[1]) {
        throw new Error(`${setting} must be a number from ${decimalRange[0]} to ${decimalRange[1]}.`);
      }
      normalizedChanges[setting] = value;
    } else if (SERVICE_SETTING_TEXT.has(setting)) {
      if (setting === 'quotaPlan.planMode' && !['paced', 'burst'].includes(value)) throw new Error('quotaPlan.planMode must be paced or burst.');
      if (setting === 'quotaPlan.horizon' && value !== 'last-expiry'
        && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) {
        throw new Error('quotaPlan.horizon must be last-expiry or an ISO time.');
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
  if (!cfg.quotaPlan || typeof cfg.quotaPlan !== 'object' || Array.isArray(cfg.quotaPlan)) cfg.quotaPlan = { ...DEFAULTS.quotaPlan };
  for (const setting of Object.keys(DEFAULTS.quotaPlan)) {
    const value = cfg.quotaPlan?.[setting];
    try { validateServiceSettingValues({ [`quotaPlan.${setting}`]: value }); }
    catch {
      process.stderr.write(`herdr-boss: config.json quotaPlan.${setting} is invalid. Using the default.\n`);
      cfg.quotaPlan[setting] = DEFAULTS.quotaPlan[setting];
    }
  }
  // A stored legacy tokenFile names the data directory. Report the private default in memory. Only
  // migrateAccessFiles() writes the new setting.
  if (cfg.access.tokenFile === path.join(DATA_DIR, 'access-token')) cfg.access.tokenFile = DEFAULT_TOKEN_FILE;
  // An invalid pool list gives no pools. The lease commands and the bulletin name each error.
  if (process.env.HERDR_BOSS_PUSH === '0') cfg.push = false;
  if (process.env.HERDR_BOSS_PORT) cfg.port = Number(process.env.HERDR_BOSS_PORT);
  // A hand-edited allowedHosts or log value goes through the same check as the API. An invalid value gives the default.
  const fallback = (key, check, value, def, set) => {
    try { check(value); } catch {
      process.stderr.write(`herdr-boss: config.json ${key} is invalid. Using the default.\n`);
      set(def);
    }
  };
  fallback('allowedHosts', validateAllowedHosts, cfg.allowedHosts, [], (v) => { cfg.allowedHosts = v; });
  if (Array.isArray(cfg.allowedHosts) && cfg.allowedHosts.length) cfg.allowedHosts = validateAllowedHosts(cfg.allowedHosts);
  for (const key of ['maxMegabytes', 'keepFiles']) {
    const [min, max] = SERVICE_SETTING_RANGES.get(`log.${key}`);
    const value = cfg.log?.[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      process.stderr.write(`herdr-boss: config.json log.${key} is invalid. Using the default.\n`);
      cfg.log = { ...DEFAULTS.log, ...(isRecord(cfg.log) ? cfg.log : {}), [key]: DEFAULTS.log[key] };
    }
  }
  const pools = validateResourcePools(cfg.resourcePools, { dashboardPort: cfg.port });
  cfg.resourcePools = pools.errors.length ? [] : pools.pools;
  cfg.resourcePoolErrors = pools.errors;
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
