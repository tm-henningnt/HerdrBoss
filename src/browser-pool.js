import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { collectProcesses } from './collect.js';

const FILE = path.join(DATA_DIR, 'browser-sessions.json');
const PROFILE_ROOT = path.join(DATA_DIR, 'browser-profiles');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_SIZE = { width: 1280, height: 800 };

export function validWindowSize(width, height) {
  return Number.isInteger(width) && width >= 320 && width <= 3840 && Number.isInteger(height) && height >= 240 && height <= 2160;
}

export function listBrowserSessions() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
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

async function askBrowserToClose(session) {
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

export async function browserStatus(session) {
  const reachable = await portOpen(session.port);
  const processes = await collectProcesses();
  const owner = [...processes.values()].find((p) => p.cmd.includes(`--remote-debugging-port=${session.port}`) && p.cmd.includes(`--user-data-dir=${session.profile}`) && !p.cmd.includes('--type='));
  return { ...session, windowSize: session.windowSize || DEFAULT_SIZE, reachable, profileVerified: reachable && !!owner, processPresent: !!owner,
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

export async function closeBrowser(project) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  const session = listBrowserSessions()[project];
  if (!session) throw new Error('No project browser is registered.');
  let status = await browserStatus(session);
  if (status.reachable && !status.profileVerified) throw new Error(`Port ${session.port} belongs to another process. It was not touched.`);
  if (!status.processPresent && !status.reachable) return { ...status, closed: true };
  if (!status.profileVerified) throw new Error('Could not verify Chrome’s browser control endpoint. Close the browser manually; it was not touched.');
  await askBrowserToClose(session);
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await browserStatus(session);
    if (!status.processPresent && !status.reachable) return { ...status, closed: true };
  }
  throw new Error('Chrome did not exit after its close command. Inspect it before relaunching; it was not force-killed.');
}

export async function restartBrowser(project, headless, { restorePage = true, tabId = null } = {}) {
  if (typeof headless !== 'boolean') throw new Error('Choose visible or headless mode.');
  let pageUrl = null;
  if (restorePage) {
    const { listBrowserTabs } = await import('./browser-preview.js');
    const tabs = await listBrowserTabs(project);
    const selected = tabId ? tabs.find((tab) => tab.id === tabId) : tabs.find((tab) => /^https?:\/\//i.test(tab.url));
    if (tabId && !selected) throw new Error('The selected page is no longer open. Refresh the preview before restarting.');
    if (selected && /^https?:\/\//i.test(selected.url)) pageUrl = selected.url;
  }
  await closeBrowser(project);
  const status = await requestBrowser(project, { headless });
  if (!pageUrl) return { ...status, restoredPage: false };
  try {
    const { listBrowserTabs, browserNavigate } = await import('./browser-preview.js');
    const tabs = await listBrowserTabs(project);
    await browserNavigate(project, tabs[0]?.id, pageUrl);
    return { ...status, restoredPage: true };
  } catch (error) {
    return { ...status, restoredPage: false, restoreError: error.message };
  }
}

export async function requestBrowser(project, { launch = true, headless = null, chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } = {}) {
  if (!SLUG.test(project)) throw new Error('project must be a slug.');
  if (headless !== null && typeof headless !== 'boolean') throw new Error('headless must be boolean when supplied.');
  const sessions = listBrowserSessions();
  const existing = sessions[project];
  const useHeadless = headless ?? !!existing?.headless;
  if (existing) {
    const status = await browserStatus(existing);
    if (status.reachable && !status.profileVerified) throw new Error(`Port ${existing.port} belongs to a different process. Inspect it before reuse.`);
    if (status.profileVerified) {
      if (launch && status.headless !== useHeadless) throw new Error(`Browser for ${project} is running ${status.headless ? 'headless' : 'visibly'}. Close it before relaunching ${useHeadless ? 'headless' : 'visibly'} with the same profile.`);
      return status;
    }
    if (status.processPresent) throw new Error(`Chrome still owns the ${project} profile. Quit that browser fully before relaunching it.`);
    if (!launch && headless === null) return status;
  }
  const claimed = new Set(Object.values(sessions).map((s) => s.port));
  let port;
  if (existing && !(await portOpen(existing.port))) port = existing.port;
  else for (let candidate = 9223; candidate <= 9299; candidate++) {
    if (!claimed.has(candidate) && !(await portOpen(candidate))) { port = candidate; break; }
  }
  if (!port) throw new Error('No free browser debugging port from 9223 to 9299.');
  const profile = path.join(PROFILE_ROOT, project);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const windowSize = existing?.windowSize || DEFAULT_SIZE;
  const session = { project, port, profile, headless: useHeadless, windowSize, pid: null, createdAt: existing?.createdAt || new Date().toISOString(), launchedAt: null };
  sessions[project] = session;
  save(sessions);
  if (launch) {
    if (!fs.existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, `--window-size=${windowSize.width},${windowSize.height}`, '--no-first-run', '--no-default-browser-check',
      ...(useHeadless ? ['--headless'] : []), 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // An executable error is reflected by the failed port probe below.
    child.unref();
    session.pid = child.pid;
    session.launchedAt = new Date().toISOString();
    save(sessions);
  }
  for (let attempt = 0; attempt < 12 && !(await portOpen(port)); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
  return browserStatus(session);
}
