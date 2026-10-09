import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { withMutationLock } from './kit/locks.js';

const FILE = 'browser-activity.json';
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BROWSER_QUIET_MS = 20_000;
export const BROWSER_RESTART_WAIT_MS = 30_000;

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const time = (now) => typeof now === 'function' ? now() : now ?? Date.now();

function mutate(project, options, fn) {
  if (!PROJECT.test(project)) throw new Error('A browser command needs a project slug.');
  const dir = options.dir ?? DATA_DIR;
  const guard = path.join(dir, 'browser-activity-lock');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  return withMutationLock(guard, () => {
    const store = readStore(dir);
    const entry = store[project] ||= { tabs: {} };
    entry.commands ||= {};
    for (const [id, command] of Object.entries(entry.commands)) {
      if (!(options.isAlive || alive)(command.pid)) delete entry.commands[id];
    }
    if (entry.restart && !(options.isAlive || alive)(entry.restart.pid)) delete entry.restart;
    const result = fn(entry, store);
    writeStore(store, dir);
    return result;
  });
}

// Each command has its own ID. A command from another CLI process cannot remove it.
export function beginBrowserCommand(project, options = {}) {
  return mutate(project, options, (entry) => {
    if (entry.restart && entry.restart.id !== options.restartId) {
      const error = new Error(`The ${project} browser restart is in progress. Retry when it finishes.`);
      error.exitCode = 3;
      throw error;
    }
    const id = randomUUID();
    const at = time(options.now);
    entry.commands[id] = { pid: process.pid, at };
    // A probe holds a command slot so a restart waits for it, but it is not Owner or agent activity.
    if (options.markActivity !== false) entry.lastCommandAt = Math.max(entry.lastCommandAt ?? 0, at);
    return id;
  });
}

export function endBrowserCommand(project, id, options = {}) {
  mutate(project, options, (entry) => {
    delete entry.commands[id];
    if (options.markActivity !== false) entry.lastCommandAt = Math.max(entry.lastCommandAt ?? 0, time(options.now));
  });
}

export function browserCommandActivity(project, options = {}) {
  if (!PROJECT.test(project)) throw new Error('A browser command needs a project slug.');
  const entry = readStore(options.dir ?? DATA_DIR)[project] || {};
  const isAlive = options.isAlive || alive;
  return {
    inFlight: Object.values(entry.commands || {}).filter((command) => isAlive(command.pid)).length,
    lastCommandAt: Number.isFinite(entry.lastCommandAt) ? entry.lastCommandAt : null,
    restarting: !!entry.restart && isAlive(entry.restart.pid),
  };
}

export async function withBrowserCommand(project, work, options = {}) {
  const id = beginBrowserCommand(project, options);
  try { return await work(); }
  finally { endBrowserCommand(project, id, options); }
}

// Reserve the restart before waiting. New commands cannot enter between the idle check and the close.
export async function withBrowserRestart(project, work, options = {}) {
  const id = randomUUID();
  mutate(project, options, (entry) => {
    if (entry.restart) {
      const error = new Error(`The ${project} browser restart is already in progress.`);
      error.exitCode = 3;
      throw error;
    }
    entry.restart = { id, pid: process.pid };
  });
  const deadline = time(options.now) + BROWSER_RESTART_WAIT_MS;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    for (;;) {
      const left = deadline - time(options.now);
      if (left <= 0) {
        const error = new Error(`Browser restart refused after 30 seconds: a command is still in flight on ${project}, or a CDP client is connected or cannot be checked. Retry when commands finish and CDP clients disconnect.`);
        error.exitCode = 3;
        throw error;
      }
      let busy = browserCommandActivity(project, options).inFlight > 0;
      if (!busy && options.externalClients) {
        let timer;
        try {
          const count = await Promise.race([
            Promise.resolve().then(options.externalClients).catch(() => null),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); }),
          ]);
          busy = count !== 0;
        } finally { clearTimeout(timer); }
      }
      if (!busy && time(options.now) < deadline) break;
      await wait(Math.min(100, left));
    }
    return await work(id);
  } finally {
    mutate(project, options, (entry) => { if (entry.restart?.id === id) delete entry.restart; });
  }
}

function readStore(dir = DATA_DIR) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function writeStore(store, dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function agentBrowserTabIds(project, { dir = DATA_DIR } = {}) {
  if (!PROJECT.test(project)) return [];
  const tabs = readStore(dir)[project]?.tabs;
  return tabs && typeof tabs === 'object' && !Array.isArray(tabs) ? Object.keys(tabs) : [];
}

export function recordAgentBrowserTab(project, tabId, { now = Date.now(), dir = DATA_DIR } = {}) {
  if (!PROJECT.test(project) || typeof tabId !== 'string' || !tabId) throw new Error('An agent browser tab needs a project and tab ID.');
  mutate(project, { dir }, (entry) => {
    entry.tabs = entry.tabs && typeof entry.tabs === 'object' && !Array.isArray(entry.tabs) ? entry.tabs : {};
    entry.tabs[tabId] = now;
  });
}

export function forgetAgentBrowserTab(project, tabId, { dir = DATA_DIR } = {}) {
  if (!PROJECT.test(project) || typeof tabId !== 'string' || !tabId) return;
  mutate(project, { dir }, (entry, store) => {
    if (entry.tabs) delete entry.tabs[tabId];
    if (!Object.keys(entry.tabs || {}).length && !Object.keys(entry.commands).length && !entry.restart) delete store[project];
  });
}
