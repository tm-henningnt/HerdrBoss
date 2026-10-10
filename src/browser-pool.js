import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import { DATA_DIR, readRootSettings, resolveRootPath, visibleBrowsersAllowed } from './config.js';
import { collectProcesses, collectBrowserClients } from './collect.js';
import { codeSignCloneDir, listCloneNames, readProcesses, removeCodeSignClone } from './clone-sweep.js';
import { PROJECT_BROWSER_POOL_NAME, acquireLeaseFor, dropLeases, projectBrowserPool, readLeases } from './leases.js';
import { withBrowserRestart } from './browser-activity.js';
import { withMutationLock } from './kit/locks.js';

const FILE = path.join(DATA_DIR, 'browser-sessions.json');
const PROFILE_ROOT = path.join(DATA_DIR, 'browser-profiles');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_SIZE = { width: 1280, height: 800 };
const MAX_BOOKMARKS = 30;
const MAX_BOOKMARK_NAME = 60;
const CDP_TIMEOUT_MS = 2000;
const RESTORE_AUTH_PATH = /^(log-?in|log-?on|sign-?in|sign-?on|oauth\d*|auth\w*|callback|sso|saml|oidc|openid|connect|consent|token)/i;
const RESTORE_AUTH_HOSTS = new Set(['login', 'accounts', 'sso', 'auth', 'id', 'idp', 'signin', 'adfs']);

// Tests replace the network, process table, signal, launch, and code-sign clone functions through the options object.
// A cloneDir of null turns off the clone record and the clone delete.
function deps(options) {
  const o = options && typeof options === 'object' ? options : {};
  return {
    fetch: o.fetch || globalThis.fetch,
    collectProcesses: o.collectProcesses || collectProcesses,
    collectBrowserClients: o.collectBrowserClients || collectBrowserClients,
    kill: o.kill || ((pid, signal) => process.kill(pid, signal)),
    spawn: o.spawn || spawnProcess,
    closeViaCdp: o.closeViaCdp || askBrowserToClose,
    cloneDir: typeof o.cloneDir === 'function' ? o.cloneDir : Object.hasOwn(o, 'cloneDir') ? () => o.cloneDir : () => codeSignCloneDir(),
    readProcesses: o.readProcesses || readProcesses,
    portOpen: o.portOpen || portOpen,
  };
}

// A hung Chrome still accepts TCP connections on its debugging port, so only an HTTP answer proves it responds.
export async function cdpResponds(port, { fetch = globalThis.fetch } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
    if (response.status !== 200) return false;
    await response.json();
    return true;
  } catch { return false; }
}

export function validWindowSize(width, height) {
  return Number.isInteger(width) && width >= 320 && width <= 3840 && Number.isInteger(height) && height >= 240 && height <= 2160;
}

export function listBrowserSessions() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

function requireVisiblePermission(headless) {
  if (headless === false && !visibleBrowsersAllowed()) {
    throw new Error('Visible project browsers are off. Turn on browser.allowVisible in Settings before using --visible.');
  }
}

// Keep the saved launch mode headless without closing a browser that Herdr Boss did not start.
export function markBrowserHeadless(project) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const sessions = listBrowserSessions();
  if (!sessions[project]) throw new Error('No project browser is registered.');
  sessions[project].headless = true;
  sessions[project].headlessPolicyVersion = 1;
  save(sessions);
  return sessions[project];
}

function stripPathParameters(pathname) {
  return pathname.replaceAll('\\', '/').split('/').map((segment) => segment.split(';')[0]).join('/');
}

function restorePathname(pathname) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const decoded = decodeURIComponent(stripPathParameters(pathname));
    if (decoded === pathname) break;
    pathname = decoded;
  }
  pathname = stripPathParameters(pathname);
  // Do not restore a path that still has an encoded layer after the bounded decode.
  if (pathname.includes('%')) return null;
  if (pathname.split('/').some((segment) => RESTORE_AUTH_PATH.test(segment.replace(/\.[^.]*$/, '')))) return null;
  return pathname;
}

function restorableTab(tab) {
  if (typeof tab?.id !== 'string' || !tab.id || typeof tab.url !== 'string') return null;
  try {
    const url = new URL(tab.url);
    url.search = '';
    url.hash = '';
    if (url.username || url.password) return null;
    if (url.href !== 'about:blank' && !['http:', 'https:'].includes(url.protocol)) return null;
    if (RESTORE_AUTH_HOSTS.has(url.hostname.split('.')[0])) return null;
    const pathname = restorePathname(url.pathname);
    if (pathname === null) return null;
    url.pathname = pathname;
    return { id: tab.id, url: url.href };
  } catch { return null; }
}

const restorableTabs = (tabs) => Array.isArray(tabs) ? tabs.map(restorableTab).filter(Boolean) : [];

// Keep URLs in the private session file, without titles. The snapshot is also used when CDP stops answering.
function updateRememberedTabs(project, update) {
  const guard = path.join(DATA_DIR, 'browser-session-lock');
  fs.mkdirSync(guard, { recursive: true, mode: 0o700 });
  withMutationLock(guard, () => {
    const sessions = listBrowserSessions();
    if (!sessions[project]) return;
    const tabs = Array.isArray(sessions[project].restoreTabs) ? sessions[project].restoreTabs : [];
    sessions[project].restoreTabs = restorableTabs(update(tabs));
    save(sessions);
  });
}

export function rememberBrowserTabs(project, tabs) {
  updateRememberedTabs(project, () => tabs);
}

export function rememberBrowserTab(project, id, url) {
  updateRememberedTabs(project, (tabs) => [...tabs.filter((tab) => tab.id !== id), { id, url }]);
}

export function forgetBrowserTab(project, id) {
  updateRememberedTabs(project, (tabs) => tabs.filter((tab) => tab.id !== id));
}

function save(sessions) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function askBrowserToClose(session, fetch) {
  const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Could not reach Chrome’s browser control endpoint.');
  const info = await response.json();
  const endpoint = new URL(info.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== session.port) {
    throw new Error('Chrome returned an unexpected browser control endpoint.');
  }
  endpoint.hostname = '127.0.0.1';
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let sent = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Chrome did not accept the close command.')), 3000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve();
    }
    socket.addEventListener('open', () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    });
    socket.addEventListener('message', (event) => {
      try { if (JSON.parse(String(event.data)).id === 1) finish(); } catch {}
    });
    socket.addEventListener('close', () => finish(sent ? null : new Error('Chrome disconnected before accepting the close command.')));
    socket.addEventListener('error', () => finish(new Error('Could not connect to Chrome’s browser control endpoint.')));
  });
}

export function browserOwner(processes, session) {
  return [...processes.values()].find((p) => p.cmd.includes(`--remote-debugging-port=${session.port}`) && p.cmd.includes(`--user-data-dir=${session.profile}`) && !p.cmd.includes('--type='));
}

const isBrowserLease = (lease) => lease.pool === PROJECT_BROWSER_POOL_NAME;

function profileOf(project, sessions) {
  return sessions[project]?.profile ?? path.join(PROFILE_ROOT, project);
}

// Return the lease check for the cdp pool: true when a Chrome process has the lease port and the project profile.
// Return null when the process table is unknown or empty, so that a failed process collection reclaims nothing.
export function browserProcessCheck(processes, sessions = {}) {
  if (!processes?.size) return null;
  return (lease) => !!browserOwner(processes, { port: Number(lease.item), profile: profileOf(lease.project, sessions) });
}

function heldBrowserLease(project) {
  return readLeases().leases.find((lease) => isBrowserLease(lease) && lease.project === project) ?? null;
}

// Lease the recorded port of a running or reserved browser when the port is free. A port that another project leases stays as it is.
// Return true when the project holds the recorded port, or when the port is outside the pool.
function keepBrowserLease(project, port) {
  const pool = projectBrowserPool();
  const item = String(port);
  if (!pool.items.includes(item)) return true;
  const held = heldBrowserLease(project);
  if (held) return held.item === item;
  if (readLeases().leases.some((lease) => isBrowserLease(lease) && lease.item === item)) return false;
  const lease = acquireLeaseFor(pool.name, { project }, { pools: [pool], prefer: item });
  if (lease.item === item) return true;
  dropLeases((entry) => isBrowserLease(entry) && entry.project === project && entry.item === lease.item);
  return false;
}

// Lease a port for a launch: the recorded port first, then the lowest free port.
// A port that another record uses or that has a listener is skipped. The lease is given back when no port is usable.
async function leaseBrowserPort(project, existing, sessions, d) {
  const pool = projectBrowserPool();
  const exclude = new Set(Object.values(sessions).filter((s) => s.project !== project).map((s) => String(s.port)));
  const recorded = existing && pool.items.includes(String(existing.port)) ? String(existing.port) : null;
  for (let attempt = 0; attempt < pool.items.length; attempt++) {
    let lease;
    try {
      lease = acquireLeaseFor(pool.name, { project }, { pools: [pool], prefer: recorded && !exclude.has(recorded) ? recorded : null, exclude: [...exclude] });
    } catch (error) {
      if (error.exitCode === 3) break;
      throw error;
    }
    if (!(await d.portOpen(Number(lease.item)))) return Number(lease.item);
    // Another process listens on the leased port. Give the lease back and try the next port.
    dropLeases((entry) => isBrowserLease(entry) && entry.project === project && entry.item === lease.item);
    exclude.add(lease.item);
  }
  throw new Error('No free browser debugging port from 9223 to 9299.');
}

// Give back the port lease of a project. The browser record, with its profile and window size, stays.
export async function releaseBrowser(project, options = {}) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const d = deps(options);
  const held = heldBrowserLease(project);
  if (!held) throw new Error(`${project} holds no project browser lease.`);
  const port = Number(held.item);
  if (browserOwner(await d.collectProcesses(), { port, profile: profileOf(project, listBrowserSessions()) })) {
    throw new Error(`The ${project} Chrome still runs on port ${port}. Close the browser first with herdr-boss browser close ${project}.`);
  }
  dropLeases((lease) => isBrowserLease(lease) && lease.project === project && lease.item === held.item);
  return { project, port, released: true };
}

// The second argument is an options object. Array.map passes an index there, which deps() ignores.
export async function browserStatus(session, options) {
  const d = deps(options);
  const reachable = await d.portOpen(session.port);
  const owner = browserOwner(await d.collectProcesses(), session);
  const profileVerified = reachable && !!owner;
  const responsive = profileVerified && await cdpResponds(session.port, d);
  const { restoreTabs, ...publicSession } = session;
  return { ...publicSession, windowSize: session.windowSize || DEFAULT_SIZE, reachable, profileVerified, responsive, processPresent: !!owner,
    closed: !!session.closedAt && !owner && !reachable,
    headless: owner ? /--headless(?:=|\s|$)/.test(owner.cmd) : !!session.headless, pid: owner?.pid ?? session.pid };
}

export function setBrowserWindowSize(project, width, height) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  if (!validWindowSize(width, height)) throw new Error('Window size must be 320–3840 pixels wide and 240–2160 pixels high.');
  const sessions = listBrowserSessions();
  if (!sessions[project]) throw new Error('Request a project browser first.');
  sessions[project].windowSize = { width, height };
  save(sessions);
  return sessions[project];
}

function validTabViewport(viewport) {
  return viewport && Number.isInteger(viewport.width) && viewport.width >= 200 && viewport.width <= 3840
    && Number.isInteger(viewport.height) && viewport.height >= 150 && viewport.height <= 2160
    && typeof viewport.scale === 'number' && Number.isFinite(viewport.scale) && viewport.scale >= 0.5 && viewport.scale <= 4
    && typeof viewport.mobile === 'boolean'
    && (viewport.method === undefined || viewport.method === 'window' || viewport.method === 'emulation');
}

export function setBrowserTabViewport(project, tabId, viewport) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  if (typeof tabId !== 'string' || !tabId) throw new Error('A browser tab ID is required.');
  if (viewport !== null && !validTabViewport(viewport)) throw new Error('Invalid browser viewport.');
  const sessions = listBrowserSessions();
  const record = sessions[project];
  if (!record) throw new Error('Request a project browser first.');
  if (!record.viewports || typeof record.viewports !== 'object' || Array.isArray(record.viewports)) record.viewports = {};
  if (viewport === null) delete record.viewports[tabId];
  else record.viewports[tabId] = { width: viewport.width, height: viewport.height, scale: viewport.scale, mobile: viewport.mobile, method: viewport.method || 'emulation' };
  if (Object.keys(record.viewports).length) save(sessions);
  else {
    delete record.viewports;
    save(sessions);
  }
  return record.viewports || {};
}

export function listBrowserTabViewports(project, openTabIds) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  if (!Array.isArray(openTabIds)) throw new Error('Open browser tab IDs are required.');
  const sessions = listBrowserSessions();
  const record = sessions[project];
  if (!record || !record.viewports || typeof record.viewports !== 'object' || Array.isArray(record.viewports)) return {};
  const open = new Set(openTabIds);
  const viewports = {};
  let changed = false;
  for (const [tabId, viewport] of Object.entries(record.viewports)) {
    if (open.has(tabId) && validTabViewport(viewport)) viewports[tabId] = viewport;
    else changed = true;
  }
  if (changed) {
    if (Object.keys(viewports).length) record.viewports = viewports;
    else delete record.viewports;
    save(sessions);
  }
  return viewports;
}

// A bookmark URL must be http or https and must not hold a user name or a password.
export function bookmarkUrl(value) {
  let parsed;
  const text = String(value ?? '').trim();
  // A scheme, a backslash, whitespace, or a control character in the host part is a typing error. Refuse it
  // without an echo. The authority is the text after the first scheme and its slashes, up to the next slash.
  const authority = text.replace(/^[a-z][a-z\d+.-]*:/i, '').replace(/^\/*/, '').split(/[/?#]/, 1)[0];
  const hostName = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  if (/[\\\s\u0000-\u001f\u007f]/.test(authority) || /^(?:https?|wss?)$/i.test(hostName)
    || /^[a-z][a-z\d+.-]*:\/*[a-z][a-z\d+.-]*:\/\//i.test(text)) throw new Error('A bookmark URL host must not hold a scheme, a backslash, or a space. Write one scheme, then the host.');
  try { parsed = new URL(String(value ?? '').trim()); } catch { throw new Error('A bookmark URL must use http or https.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('A bookmark URL must use http or https.');
  if (parsed.username || parsed.password) throw new Error('Bookmarks must not hold credentials.');
  // The parsed host also decodes %68ttps and drops a trailing dot, so check it again here.
  const parsedHost = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!parsedHost || /^(?:https?|wss?)$/.test(parsedHost)) throw new Error('A bookmark URL host must not hold a scheme, a backslash, or a space. Write one scheme, then the host.');
  return parsed.href;
}

function bookmarkName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A bookmark name is required.');
  const name = value.trim();
  if (name.length > MAX_BOOKMARK_NAME) throw new Error(`A bookmark name has at most ${MAX_BOOKMARK_NAME} characters.`);
  return name;
}

// Bookmarks live in the project record. A change needs a record, as setBrowserWindowSize does.
function bookmarkRecord(project, sessions) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const record = sessions[project];
  if (!record) throw new Error('Request a project browser first.');
  if (!Array.isArray(record.bookmarks)) record.bookmarks = [];
  if (record.startPage === undefined) record.startPage = null;
  return record;
}

function bookmarkIndex(record, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= record.bookmarks.length) throw new Error('Bookmark index is out of range.');
  return i;
}

function bookmarkState(record) {
  return { bookmarks: record.bookmarks, startPage: record.startPage ?? null };
}

// Read the bookmarks and the start page of a project. An unknown project reads as empty.
export function listBookmarks(project) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const record = listBrowserSessions()[project];
  return { bookmarks: Array.isArray(record?.bookmarks) ? record.bookmarks : [], startPage: record?.startPage ?? null };
}

export function addBookmark(project, { name, url } = {}) {
  const sessions = listBrowserSessions();
  const record = bookmarkRecord(project, sessions);
  const bookmark = { name: bookmarkName(name), url: bookmarkUrl(url) };
  if (record.bookmarks.length >= MAX_BOOKMARKS) throw new Error(`A project keeps at most ${MAX_BOOKMARKS} bookmarks.`);
  record.bookmarks.push(bookmark);
  save(sessions);
  return bookmarkState(record);
}

export function renameBookmark(project, index, name) {
  const sessions = listBrowserSessions();
  const record = bookmarkRecord(project, sessions);
  record.bookmarks[bookmarkIndex(record, index)].name = bookmarkName(name);
  save(sessions);
  return bookmarkState(record);
}

export function moveBookmark(project, from, to) {
  const sessions = listBrowserSessions();
  const record = bookmarkRecord(project, sessions);
  const start = bookmarkIndex(record, from);
  const target = Number(to);
  if (!Number.isInteger(target) || target < 0 || target >= record.bookmarks.length) throw new Error('Bookmark index is out of range.');
  const [bookmark] = record.bookmarks.splice(start, 1);
  record.bookmarks.splice(target, 0, bookmark);
  save(sessions);
  return bookmarkState(record);
}

export function removeBookmark(project, index) {
  const sessions = listBrowserSessions();
  const record = bookmarkRecord(project, sessions);
  record.bookmarks.splice(bookmarkIndex(record, index), 1);
  save(sessions);
  return bookmarkState(record);
}

// A null or empty URL clears the start page. Otherwise the URL must pass the bookmark rules.
export function setStartPage(project, url) {
  const sessions = listBrowserSessions();
  const record = bookmarkRecord(project, sessions);
  record.startPage = url === null || url === undefined || String(url).trim() === '' ? null : bookmarkUrl(url);
  save(sessions);
  return bookmarkState(record);
}

function clearClone(project, now = Date.now()) {
  const sessions = listBrowserSessions();
  if (sessions[project]) {
    sessions[project].codeSignClone = null;
    sessions[project].closedAt = new Date(now).toISOString();
    save(sessions);
  }
  return { codeSignClone: null, ...(sessions[project]?.closedAt ? { closedAt: sessions[project].closedAt } : {}) };
}

export async function closeBrowser(project, options = {}) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const d = deps(options);
  const session = listBrowserSessions()[project];
  if (!session) throw new Error('No project browser is registered.');
  let status = await browserStatus(session, d);
  if (status.reachable && !status.profileVerified) throw new Error(`Port ${session.port} belongs to another process. It was not touched.`);
  if (!status.processPresent && !status.reachable) return { ...status, ...clearClone(project, options.now), closed: true };
  if (!status.profileVerified) throw new Error('Could not verify Chrome’s browser control endpoint. Close the browser manually; it was not touched.');
  if (typeof options.beforeClose === 'function' && !(await options.beforeClose(session))) return { ...status, closed: false, skipped: true };
  let closeFailed = !status.responsive;
  let signaled = false;
  if (!closeFailed) {
    try { await d.closeViaCdp(session, d.fetch); } catch { closeFailed = true; }
  }
  if (closeFailed) {
    // Check the owner again just before the signal. Only a process with both the port flag and the profile path gets SIGTERM.
    const owner = browserOwner(await d.collectProcesses(), session);
    if (owner) {
      try { d.kill(owner.pid, 'SIGTERM'); signaled = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await browserStatus(session, d);
    if (!status.processPresent && !status.reachable) {
      // Chrome deletes its clone at a CDP close. After a SIGTERM, Herdr Boss deletes the recorded clone.
      if (signaled && session.codeSignClone) {
        try { await removeCodeSignClone({ dir: d.cloneDir(), name: session.codeSignClone, processes: d.readProcesses }); } catch {}
      }
      return { ...status, ...clearClone(project, options.now), closed: true };
    }
  }
  throw new Error('Chrome did not exit after its close command or SIGTERM. Inspect it before relaunching; it was not force-killed.');
}

export async function restartBrowser(project, headless, options = {}) {
  if (typeof headless !== 'boolean') throw new Error('Choose visible or headless mode.');
  requireVisiblePermission(headless);
  const d = deps(options);
  const externalClients = async () => {
    const session = listBrowserSessions()[project];
    if (!session) return 0;
    return d.collectBrowserClients(session.port, { servicePid: process.pid });
  };
  return withBrowserRestart(project, (restartId) => restoreBrowser(project, headless, options, restartId, externalClients), {
    ...options.activity, externalClients, headless, allowUnknownClients: options.allowUnknownClients === true,
  });
}

async function restoreBrowser(project, headless, options, restartId, externalClients) {
  const { restorePage = true, tabId = null } = options;
  const d = deps(options);
  const session = listBrowserSessions()[project];
  let pages = restorableTabs(session?.restoreTabs);
  const preview = options.preview || await import('./browser-preview.js');
  // The snapshot stays intact until the restore finishes, including partial failures.
  const adapters = { rememberTabs: false, activity: { ...options.activity, restartId } };
  const responsive = restorePage && session ? (await browserStatus(session, d)).responsive : false;
  if (restorePage && responsive) {
    let tabs = null;
    try { tabs = await preview.listBrowserTabs(project, adapters); } catch {}
    if (tabs) {
      if (tabId && !tabs.some((tab) => tab.id === tabId)) throw new Error('The selected page is no longer open. Refresh the preview before restarting.');
      pages = restorableTabs(tabs);
    }
  }
  rememberBrowserTabs(project, pages);
  const closed = await closeBrowser(project, { ...d, beforeClose: async () => {
    const count = await externalClients();
    if (count == null && !options.allowUnknownClients) {
      const error = new Error(`Browser restart refused before the close: CDP clients could not be checked. Override this unknown check with herdr-boss browser restart ${project} ${headless ? '--headless' : '--visible'} --allow-unknown-clients.`);
      error.exitCode = 3;
      throw error;
    }
    return count === 0 || (count == null && options.allowUnknownClients === true);
  } });
  if (!closed.closed) {
    const error = new Error('Browser restart refused: a CDP client connected before the close. Disconnect it, then retry.');
    error.exitCode = 3;
    throw error;
  }
  const status = await requestBrowser(project, { ...options, headless });
  if (!restorePage || !pages.length) return { ...status, restoredPage: false, restoredTabs: 0 };
  let startupTabs = null;
  try { startupTabs = await preview.listBrowserTabs(project, adapters); } catch {}
  let restoredTabs = 0;
  const restored = [];
  for (const page of pages) {
    try {
      const tab = await preview.browserNewTab(project, page.url, adapters);
      restored.push({ id: tab.id, url: page.url });
      restoredTabs++;
    } catch {
      // Keep the failed URL for a later restart. Never put a CDP error, URL, or title into output.
      restored.push(page);
    }
  }
  if (restoredTabs) {
    if (startupTabs) for (const tab of startupTabs) {
      try { await preview.browserCloseTab(project, tab.id, adapters); } catch {}
    }
    else {
      try { await preview.browserCloseBlankTabs(project, restored.map((tab) => tab.id), adapters); } catch {}
    }
  }
  rememberBrowserTabs(project, restored);
  return { ...status, restoredPage: restoredTabs === pages.length, restoredTabs,
    ...(restoredTabs < pages.length ? { restoreError: `${pages.length - restoredTabs} tab(s) could not reopen. The saved addresses stay local.` } : {}) };
}

export async function requestBrowser(project, options = {}) {
  const { launch = true, headless = null } = options;
  // The chromePath setting names the Chrome executable. A caller can override it.
  const chromePath = options.chromePath ?? resolveRootPath(readRootSettings().chromePath);
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const d = deps(options);
  if (headless !== null && typeof headless !== 'boolean') throw new Error('headless must be boolean when supplied.');
  const sessions = listBrowserSessions();
  const existing = sessions[project];
  const legacyModePending = !!existing && existing.headlessPolicyVersion !== 1 && headless === null;
  const useHeadless = headless ?? (legacyModePending ? true : existing?.headless) ?? true;
  requireVisiblePermission(useHeadless);
  if (existing?.closedAt) {
    delete existing.closedAt;
    save(sessions);
  }
  if (existing) {
    const status = await browserStatus(existing, d);
    if (status.reachable && !status.profileVerified) throw new Error(`Port ${existing.port} belongs to a different process. Inspect it before reuse.`);
    // A verified browser that does not respond is returned as it is. Launching a second Chrome on the same profile would fail.
    if (status.profileVerified) {
      if (launch && status.headless !== useHeadless && !legacyModePending) throw new Error(`Browser for ${project} is running ${status.headless ? 'headless' : 'visibly'}. Close it before relaunching ${useHeadless ? 'headless' : 'visibly'} with the same profile.`);
      if (headless !== null) {
        existing.headless = useHeadless;
        existing.headlessPolicyVersion = 1;
        save(sessions);
      }
      keepBrowserLease(project, existing.port);
      return status;
    }
    if (status.processPresent) throw new Error(`Chrome still owns the ${project} profile. Quit that browser fully before relaunching it.`);
    // A reservation keeps its record when the project holds the recorded port. Otherwise it leases a new port below.
    if (!launch && headless === null && keepBrowserLease(project, existing.port)) return status;
  }
  const port = await leaseBrowserPort(project, existing, sessions, d);
  const profile = path.join(PROFILE_ROOT, project);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const windowSize = existing?.windowSize || DEFAULT_SIZE;
  const session = { project, port, profile, headless: useHeadless, headlessPolicyVersion: 1, windowSize, pid: null, codeSignClone: null, bookmarks: existing?.bookmarks || [], startPage: existing?.startPage ?? null, restoreTabs: existing?.restoreTabs || [], createdAt: existing?.createdAt || new Date().toISOString(), launchedAt: null };
  sessions[project] = session;
  save(sessions);
  let cloneDir = null;
  let clonesBefore = null;
  if (launch) {
    if (!fs.existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
    cloneDir = d.cloneDir();
    clonesBefore = listCloneNames(cloneDir);
    const child = d.spawn(chromePath, [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, `--window-size=${windowSize.width},${windowSize.height}`, '--no-first-run', '--no-default-browser-check',
      ...(useHeadless ? ['--headless'] : []), session.startPage || 'about:blank',
    // Start Chrome in the profile folder, not in the caller's folder, so a worker worktree never holds a project browser.
    ], { detached: true, stdio: 'ignore', cwd: profile });
    child.on('error', () => {}); // An executable error is reflected by the failed port probe below.
    child.unref();
    session.pid = child.pid;
    session.launchedAt = new Date().toISOString();
    save(sessions);
  }
  if (launch) {
    for (let attempt = 0; attempt < 12 && !(await d.portOpen(port)); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
    // Record the clone only when exactly one new clone folder appeared during this launch.
    const clonesAfter = clonesBefore ? listCloneNames(cloneDir) : null;
    const added = clonesAfter ? clonesAfter.filter((name) => !clonesBefore.includes(name)) : [];
    session.codeSignClone = added.length === 1 ? added[0] : null;
    save(sessions);
  }
  return browserStatus(session, d);
}
