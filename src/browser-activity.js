import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = 'browser-activity.json';
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  const store = readStore(dir);
  const entry = store[project] && typeof store[project] === 'object' ? store[project] : { tabs: {} };
  entry.tabs = entry.tabs && typeof entry.tabs === 'object' && !Array.isArray(entry.tabs) ? entry.tabs : {};
  entry.tabs[tabId] = now;
  store[project] = entry;
  writeStore(store, dir);
}

export function forgetAgentBrowserTab(project, tabId, { dir = DATA_DIR } = {}) {
  if (!PROJECT.test(project) || typeof tabId !== 'string' || !tabId) return;
  const store = readStore(dir);
  const entry = store[project];
  if (!entry?.tabs || typeof entry.tabs !== 'object' || Array.isArray(entry.tabs)) return;
  delete entry.tabs[tabId];
  if (!Object.keys(entry.tabs).length) delete store[project];
  writeStore(store, dir);
}
