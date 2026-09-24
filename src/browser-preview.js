import { browserStatus, listBrowserSessions } from './browser-pool.js';

async function verifiedSession(project) {
  const session = listBrowserSessions()[project];
  if (!session) throw new Error('No project browser is registered.');
  const status = await browserStatus(session);
  if (!status.profileVerified) throw new Error('The project browser is offline or its debugging port belongs to another process.');
  return session;
}

async function targets(session) {
  const response = await fetch(`http://127.0.0.1:${session.port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Could not list browser pages.');
  const entries = await response.json();
  return entries.filter((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
}

function displayUrl(value) {
  try { const url = new URL(value); return (['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.href).slice(0, 160); }
  catch { return String(value || '').slice(0, 160); }
}

async function browserEndpoint(session) {
  const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Could not reach the browser control endpoint.');
  const endpoint = new URL((await response.json()).webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== session.port) throw new Error('Browser returned an unexpected debugging endpoint.');
  endpoint.hostname = '127.0.0.1';
  return endpoint.href;
}

// Chrome marks a page as attached while a DevTools client, such as an agent's browser driver, holds a session on it.
async function attachedTargets(session) {
  const result = await command(await browserEndpoint(session), 'Target.getTargets');
  return new Set((result?.targetInfos || []).filter((info) => info.type === 'page' && info.attached).map((info) => info.targetId));
}

export async function listBrowserTabs(project) {
  const session = await verifiedSession(project);
  const pages = await targets(session);
  let attached = null;
  try { attached = await attachedTargets(session); } catch {}
  return pages.map((entry) => ({ id: entry.id, title: entry.title || 'Untitled page', url: entry.url, attached: attached ? attached.has(entry.id) : null }));
}

export async function tabAttached(project, tabId) {
  if (!tabId) return false;
  return (await attachedTargets(await verifiedSession(project))).has(tabId);
}

// A background tab gives the Owner a page of their own without changing any agent's tab.
export async function browserNewTab(project) {
  const session = await verifiedSession(project);
  const result = await command(await browserEndpoint(session), 'Target.createTarget', { url: 'about:blank', background: true });
  if (!result?.targetId) throw new Error('Browser did not open a new tab.');
  return { id: result.targetId };
}

async function pageTarget(project, tabId) {
  const session = await verifiedSession(project);
  const pages = await targets(session);
  const target = tabId ? pages.find((entry) => entry.id === tabId) : pages.find((entry) => /^https?:/.test(entry.url)) || pages[0];
  if (!target) throw new Error(tabId ? 'The selected tab is no longer open. Reload the tab list.' : 'No inspectable page is open in this browser.');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== session.port) throw new Error('Browser returned an unexpected debugging endpoint.');
  endpoint.hostname = '127.0.0.1';
  return endpoint.href;
}

function commands(endpoint, requests, timeoutMs = 8000, timeoutMessage = null) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let settled = false;
    let index = 0;
    const results = [];
    const timer = setTimeout(() => finish(new Error(timeoutMessage || `Browser command ${requests[index]?.method || ''} timed out after ${timeoutMs / 1000} s.`)), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    }
    const sendNext = () => socket.send(JSON.stringify({ id: index + 1, method: requests[index].method, params: requests[index].params || {} }));
    socket.addEventListener('open', sendNext);
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== index + 1) return;
      if (message.error) return finish(new Error(message.error.message || 'Browser command failed.'));
      results.push(message.result);
      index++;
      if (index === requests.length) finish(null, results);
      else sendNext();
    });
    socket.addEventListener('error', () => finish(new Error('Could not connect to the browser page.')));
    socket.addEventListener('close', () => finish(new Error('Browser page disconnected.')));
  });
}

async function command(endpoint, method, params = {}, timeoutMs, timeoutMessage) {
  return (await commands(endpoint, [{ method, params }], timeoutMs, timeoutMessage))[0];
}

// Parallel screenshots of different tabs in one Chrome block each other, so capture one tab at a time per browser.
const captureQueues = new Map();
function oneAtATime(project, task) {
  const next = (captureQueues.get(project) || Promise.resolve()).then(task, task);
  captureQueues.set(project, next.catch(() => {}));
  return next;
}

export function browserScreenshot(project, tabId) {
  return oneAtATime(project, () => captureTab(project, tabId));
}

async function captureTab(project, tabId) {
  const result = await command(await pageTarget(project, tabId), 'Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false, fromSurface: true },
    15000, 'The page did not return a screenshot within 15 s. It can be loading, busy, or showing a dialog, or an agent can be taking its own screenshot of this browser. Refresh again, or choose another tab.');
  if (!result?.data) throw new Error('Browser returned no screenshot.');
  const image = Buffer.from(result.data, 'base64');
  if (image.length > 8 * 1024 * 1024) throw new Error('Browser screenshot is too large.');
  return image;
}

export async function browserNavigate(project, tabId, value) {
  let url;
  const input = String(value || '').trim();
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be opened.');
  const result = await command(await pageTarget(project, tabId), 'Page.navigate', { url: url.href });
  if (result?.errorText) throw new Error(result.errorText);
  return { url: displayUrl(url.href) };
}

export async function browserNavigationState(project, tabId) {
  const history = await command(await pageTarget(project, tabId), 'Page.getNavigationHistory');
  const entries = history?.entries || [];
  const currentIndex = history?.currentIndex ?? -1;
  return { url: entries[currentIndex]?.url || '', canGoBack: currentIndex > 0, canGoForward: currentIndex >= 0 && currentIndex < entries.length - 1 };
}

export async function browserHistoryAction(project, tabId, action) {
  const endpoint = await pageTarget(project, tabId);
  if (action === 'home') {
    const result = await command(endpoint, 'Page.navigate', { url: 'about:blank' });
    if (result?.errorText) throw new Error(result.errorText);
    return { url: 'about:blank' };
  }
  if (!['back', 'forward'].includes(action)) throw new Error('Unknown navigation action.');
  const history = await command(endpoint, 'Page.getNavigationHistory');
  const index = history.currentIndex + (action === 'back' ? -1 : 1);
  const entry = history.entries?.[index];
  if (!entry) throw new Error(`No ${action} page is available.`);
  await command(endpoint, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  return { url: entry.url };
}

export async function browserClick(project, tabId, relativeX, relativeY) {
  if (![relativeX, relativeY].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Click position must be inside the screenshot.');
  const endpoint = await pageTarget(project, tabId);
  const metrics = await command(endpoint, 'Page.getLayoutMetrics');
  const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
  if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error('Could not determine the page viewport.');
  const point = { x: Math.min(viewport.clientWidth - 1, Math.round(relativeX * viewport.clientWidth)),
    y: Math.min(viewport.clientHeight - 1, Math.round(relativeY * viewport.clientHeight)), button: 'left', clickCount: 1 };
  await commands(endpoint, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...point } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...point } },
  ]);
  return { ok: true };
}

export async function browserInsertText(project, tabId, text) {
  if (typeof text !== 'string' || !text.length || text.length > 4096) throw new Error('Text must contain 1 to 4096 characters.');
  await command(await pageTarget(project, tabId), 'Input.insertText', { text });
  return { ok: true };
}

const KEYS = { Tab: ['Tab', 9], Enter: ['Enter', 13], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], Escape: ['Escape', 27] };

export async function browserKey(project, tabId, key) {
  const selected = key === 'SelectAll' ? ['KeyA', 65] : KEYS[key];
  if (!selected) throw new Error('Unsupported browser key.');
  const params = { key: key === 'SelectAll' ? 'a' : key, code: selected[0], windowsVirtualKeyCode: selected[1],
    nativeVirtualKeyCode: selected[1], modifiers: key === 'SelectAll' ? (process.platform === 'darwin' ? 4 : 2) : 0,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) };
  await commands(await pageTarget(project, tabId), [
    { method: 'Input.dispatchKeyEvent', params: { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...params } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...params, text: undefined, unmodifiedText: undefined } },
  ]);
  return { ok: true };
}
