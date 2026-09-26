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
  // codexbar provider -> herdr agent kinds that consume it.
  providerKinds: { claude: ['claude'], codex: ['codex'], opencodego: ['opencode', 'pi'] },
  orchestratorLabel: 'orch',
  roamgate: { port: 8787, tokenFile: path.join(os.homedir(), '.config/roamgate/auth-token') },
};

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
