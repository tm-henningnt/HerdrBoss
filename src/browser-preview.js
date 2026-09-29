import { browserStatus, listBrowserSessions, listBrowserTabViewports, setBrowserTabViewport } from './browser-pool.js';

async function verifiedSession(project) {
  const session = listBrowserSessions()[project];
  if (!session) throw new Error('No project browser is registered.');
  let status;
  try { status = await browserStatus(session); }
  catch (error) {
    // A sandboxed tool shell cannot read the process list, so the port owner cannot be verified.
    if (error?.code === 'EPERM' || /\bEPERM\b/.test(String(error?.message))) {
      throw new Error('This shell cannot read the process list (spawn EPERM), so the project browser cannot be verified. Run herdr-boss browser as a plain command, with no environment prefix, wrapper, or full path, so that the Codex rule runs it outside the sandbox.');
    }
    throw error;
  }
  if (!status.profileVerified) throw new Error('The project browser is offline or its debugging port belongs to another process.');
  if (!status.responsive) throw new Error('The project browser is not responding. Restart or close it on the Browsers page.');
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

// A page in a shared headless window becomes hidden when another tab opens there, and some web apps then stop drawing.
async function pageVisibility(entry, port, viewport = null) {
  try {
    const endpoint = new URL(entry.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || Number(endpoint.port) !== port) return null;
    endpoint.hostname = '127.0.0.1';
    const requests = [...viewportRequests(viewport), { method: 'Runtime.evaluate', params: { expression: 'document.visibilityState', returnByValue: true } }];
    const result = (await commands(endpoint.href, requests, 2000)).at(-1);
    return typeof result?.result?.value === 'string' ? result.result.value : null;
  } catch { return null; }
}

export async function listBrowserTabs(project) {
  const session = await verifiedSession(project);
  const pages = await targets(session);
  const viewports = listBrowserTabViewports(project, pages.map((page) => page.id));
  let attached = null;
  try { attached = await attachedTargets(session); } catch {}
  const visibility = await Promise.all(pages.map((entry) => pageVisibility(entry, session.port, viewports[entry.id])));
  return pages.map((entry, index) => ({ id: entry.id, title: entry.title || 'Untitled page', url: entry.url, attached: attached ? attached.has(entry.id) : null, visibility: visibility[index] }));
}

export async function tabAttached(project, tabId) {
  if (!tabId) return false;
  return (await attachedTargets(await verifiedSession(project))).has(tabId);
}

function tabUrl(value) {
  const input = String(value || '').trim();
  if (!input || input === 'about:blank') return 'about:blank';
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be opened.');
  return url.href;
}

// A tab in its own window stays visible in a headless browser, so each worker can have one without hiding another.
// It opens in the background, so the Owner's focus and every agent tab stay unchanged.
export async function browserNewTab(project, url = 'about:blank') {
  const session = await verifiedSession(project);
  const result = await command(await browserEndpoint(session), 'Target.createTarget', { url: tabUrl(url), newWindow: true, background: true });
  if (!result?.targetId) throw new Error('Browser did not open a new tab.');
  return { id: result.targetId };
}

export async function browserCloseTab(project, tabId, { force = false } = {}) {
  const session = await verifiedSession(project);
  if (!(await targets(session)).some((entry) => entry.id === tabId)) throw new Error('That tab is no longer open. Run browser tabs again.');
  if (!force && (await attachedTargets(session)).has(tabId)) throw new Error('An agent is attached to this tab. Close it when that agent is done, or pass --force.');
  const result = await command(await browserEndpoint(session), 'Target.closeTarget', { targetId: tabId });
  if (result?.success === false) throw new Error('Browser did not close the tab.');
  setBrowserTabViewport(project, tabId, null);
  return { closed: tabId };
}

async function pageContext(project, tabId, adapters = {}) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  const pages = await (adapters.listTargets || targets)(session);
  const target = tabId ? pages.find((entry) => entry.id === tabId) : pages.find((entry) => /^https?:/.test(entry.url)) || pages[0];
  if (!target) throw new Error(tabId ? 'The selected tab is no longer open. Reload the tab list.' : 'No inspectable page is open in this browser.');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== session.port) throw new Error('Browser returned an unexpected debugging endpoint.');
  endpoint.hostname = '127.0.0.1';
  const viewports = (adapters.listViewports || listBrowserTabViewports)(project, pages.map((entry) => entry.id));
  return { session, pages, target, endpoint: endpoint.href, viewport: viewports[target.id] || null };
}

function viewportRequests(viewport) {
  if (!viewport || viewport.method !== 'emulation') return [];
  return [{ method: 'Emulation.setDeviceMetricsOverride', params: {
    width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile,
  } }];
}

function pageCommands(endpoint, viewport, requests, timeoutMs, timeoutMessage, adapters = {}) {
  return (adapters.commands || commands)(endpoint, [...viewportRequests(viewport), ...requests], timeoutMs, timeoutMessage);
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
    const sendNext = () => {
      try {
        const entry = requests[index];
        const request = typeof entry === 'function' ? entry(results.at(-1), results) : entry;
        socket.send(JSON.stringify({ id: index + 1, method: request.method, params: request.params || {} }));
      } catch (error) { finish(error); }
    };
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

export function browserScreenshot(project, tabId, adapters = {}) {
  return oneAtATime(project, () => captureTab(project, tabId, adapters));
}

async function captureTab(project, tabId, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  const results = await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 72, captureBeyondViewport: false, fromSurface: true } },
  ], 15000, 'The page did not return a screenshot within 15 s. It can be loading, busy, or showing a dialog, or an agent can be taking its own screenshot of this browser.', adapters);
  const result = results.at(-1);
  if (!result?.data) throw new Error('Browser returned no screenshot.');
  const image = Buffer.from(result.data, 'base64');
  if (image.length > 8 * 1024 * 1024) throw new Error('Browser screenshot is too large.');
  return image;
}

export async function browserNavigate(project, tabId, value, adapters = {}) {
  let url;
  const input = String(value || '').trim();
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be opened.');
  const context = await pageContext(project, tabId, adapters);
  const result = (await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.navigate', params: { url: url.href } },
  ], undefined, undefined, adapters)).at(-1);
  if (result?.errorText) throw new Error(result.errorText);
  return { url: displayUrl(url.href) };
}

export async function browserNavigationState(project, tabId, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  const history = (await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.getNavigationHistory' },
  ], undefined, undefined, adapters)).at(-1);
  const entries = history?.entries || [];
  const currentIndex = history?.currentIndex ?? -1;
  return { url: entries[currentIndex]?.url || '', canGoBack: currentIndex > 0, canGoForward: currentIndex >= 0 && currentIndex < entries.length - 1 };
}

export async function browserHistoryAction(project, tabId, action, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  if (action === 'home') {
    const result = (await pageCommands(context.endpoint, context.viewport, [
      { method: 'Page.navigate', params: { url: 'about:blank' } },
    ], undefined, undefined, adapters)).at(-1);
    if (result?.errorText) throw new Error(result.errorText);
    return { url: 'about:blank' };
  }
  if (!['back', 'forward'].includes(action)) throw new Error('Unknown navigation action.');
  const history = (await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.getNavigationHistory' },
  ], undefined, undefined, adapters)).at(-1);
  const index = history.currentIndex + (action === 'back' ? -1 : 1);
  const entry = history.entries?.[index];
  if (!entry) throw new Error(`No ${action} page is available.`);
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.navigateToHistoryEntry', params: { entryId: entry.id } },
  ], undefined, undefined, adapters);
  return { url: entry.url };
}

export async function browserClick(project, tabId, relativeX, relativeY, adapters = {}) {
  if (![relativeX, relativeY].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Click position must be inside the screenshot.');
  const context = await pageContext(project, tabId, adapters);
  let point;
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.getLayoutMetrics' },
    (metrics) => {
      const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
      if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error('Could not determine the page viewport.');
      point = { x: Math.min(viewport.clientWidth - 1, Math.round(relativeX * viewport.clientWidth)),
        y: Math.min(viewport.clientHeight - 1, Math.round(relativeY * viewport.clientHeight)), button: 'left', clickCount: 1 };
      return { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...point } };
    },
    () => ({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...point } }),
  ], undefined, undefined, adapters);
  return { ok: true };
}

// A drag presses at one position, moves along a straight line, and releases. It moves the page, for example a map pan.
function dragPosition(value) {
  const { x, y } = value || {};
  if (![x, y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Drag position must be inside the screenshot.');
  return { x, y };
}

export async function browserDrag(project, tabId, from, to, { steps = 10, adapters = {} } = {}) {
  const start = dragPosition(from);
  const end = dragPosition(to);
  if (!Number.isInteger(steps) || steps < 1 || steps > 60) throw new Error('Drag steps must be from 1 to 60.');
  const context = await pageContext(project, tabId, adapters);
  // The page size arrives with the first result, so it builds every mouse event. The other requests send them in order.
  const events = [];
  const requests = [{ method: 'Page.getLayoutMetrics' }];
  for (let index = 0; index < steps + 3; index += 1) requests.push(() => events[index]);
  requests[1] = (metrics) => {
    const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
    if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error('Could not determine the page viewport.');
    const first = { x: Math.min(viewport.clientWidth - 1, Math.round(start.x * viewport.clientWidth)),
      y: Math.min(viewport.clientHeight - 1, Math.round(start.y * viewport.clientHeight)) };
    const last = { x: Math.min(viewport.clientWidth - 1, Math.round(end.x * viewport.clientWidth)),
      y: Math.min(viewport.clientHeight - 1, Math.round(end.y * viewport.clientHeight)) };
    events.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', ...first } });
    events.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...first, button: 'left', clickCount: 1 } });
    for (let index = 1; index <= steps; index += 1) {
      events.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', button: 'left', buttons: 1,
        x: Math.round(first.x + ((last.x - first.x) * index) / steps),
        y: Math.round(first.y + ((last.y - first.y) * index) / steps) } });
    }
    events.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...last, button: 'left', clickCount: 1 } });
    return events[0];
  };
  await pageCommands(context.endpoint, context.viewport, requests, undefined, undefined, adapters);
  return { ok: true };
}

// Try to resize the tab's own window. Return { ok: true, innerWidth, innerHeight } on success,
// or { ok: false, reason } when the window path cannot reach the size.
async function tryWindowResize(context, tabId, width, height, runCommand) {
  try {
    const window = await runCommand(context.endpoint, 'Browser.getWindowForTarget', { targetId: tabId });
    if (!window?.windowId) throw new Error('Browser did not return a window ID.');
    let currentWidth = width;
    let currentHeight = height;
    let innerWidth = 0;
    let innerHeight = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await runCommand(context.endpoint, 'Browser.setWindowBounds', {
        windowId: window.windowId,
        bounds: { width: currentWidth, height: currentHeight, windowState: 'normal' },
      });
      const result = await runCommand(context.endpoint, 'Runtime.evaluate', {
        expression: 'JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })',
        returnByValue: true,
      });
      const size = JSON.parse(result?.result?.value || '{}');
      innerWidth = size.innerWidth || 0;
      innerHeight = size.innerHeight || 0;
      if (Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1) break;
      // The inner size is smaller than the window by the browser frame. Add the difference and try again.
      currentWidth = currentWidth + (width - innerWidth);
      currentHeight = currentHeight + (height - innerHeight);
    }
    if (Math.abs(innerWidth - width) > 1 || Math.abs(innerHeight - height) > 1) {
      throw new Error(`window resize could not reach ${width}x${height} (got ${innerWidth}x${innerHeight})`);
    }
    // Second-session check: open a new session and verify the inner size.
    const checkResult = await runCommand(context.endpoint, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })',
      returnByValue: true,
    });
    const checkSize = JSON.parse(checkResult?.result?.value || '{}');
    if (Math.abs(checkSize.innerWidth - width) > 1 || Math.abs(checkSize.innerHeight - height) > 1) {
      throw new Error(`second session read ${checkSize.innerWidth}x${checkSize.innerHeight}, expected ${width}x${height}`);
    }
    return { ok: true, innerWidth: checkSize.innerWidth, innerHeight: checkSize.innerHeight };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Restore the window to the launch size and clear any emulation.
async function resetWindow(context, tabId, runCommand) {
  try {
    const window = await runCommand(context.endpoint, 'Browser.getWindowForTarget', { targetId: tabId });
    if (window?.windowId) {
      const launchSize = context.session?.windowSize || { width: 1280, height: 800 };
      await runCommand(context.endpoint, 'Browser.setWindowBounds', {
        windowId: window.windowId,
        bounds: { width: launchSize.width, height: launchSize.height, windowState: 'normal' },
      });
    }
  } catch {}
  await runCommand(context.endpoint, 'Emulation.clearDeviceMetricsOverride', {});
}

export async function browserViewport(project, tabId, viewport, adapters = {}) {
  if (!tabId) throw new Error('Select a browser tab.');
  const reset = viewport?.reset === true;
  if (reset) {
    if (Object.keys(viewport).length !== 1) throw new Error('Use --reset by itself.');
  } else {
    const { width, height, scale = 1, mobile = false } = viewport || {};
    if (!Number.isInteger(width) || width < 200 || width > 3840
      || !Number.isInteger(height) || height < 150 || height > 2160
      || typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 4
      || typeof mobile !== 'boolean') {
      throw new Error('Viewport width must be 200–3840, height 150–2160, and scale 0.5–4.');
    }
  }
  const context = await pageContext(project, tabId, adapters);
  const runCommand = adapters.command || command;
  if (reset) {
    await resetWindow(context, tabId, runCommand);
    setBrowserTabViewport(project, tabId, null);
    return { reset: true };
  }
  const { width, height, scale = 1, mobile = false } = viewport;
  const saved = { width, height, scale, mobile };
  // Try the window path first: resize the tab's own window so every CDP client sees the size.
  const windowResult = await tryWindowResize(context, tabId, width, height, runCommand);
  if (windowResult.ok) {
    saved.method = 'window';
    saved.innerWidth = windowResult.innerWidth;
    saved.innerHeight = windowResult.innerHeight;
    setBrowserTabViewport(project, tabId, saved);
    return saved;
  }
  // Fallback: use device metrics emulation when the window path cannot reach the size.
  await runCommand(context.endpoint, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  saved.method = 'emulation';
  saved.reason = windowResult.reason;
  setBrowserTabViewport(project, tabId, saved);
  return saved;
}

export async function browserInsertText(project, tabId, text, adapters = {}) {
  if (typeof text !== 'string' || !text.length || text.length > 4096) throw new Error('Text must contain 1 to 4096 characters.');
  const context = await pageContext(project, tabId, adapters);
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Input.insertText', params: { text } },
  ], undefined, undefined, adapters);
  return { ok: true };
}

const KEYS = { Tab: ['Tab', 9], Enter: ['Enter', 13], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], Escape: ['Escape', 27] };

export async function browserKey(project, tabId, key, adapters = {}) {
  const selected = key === 'SelectAll' ? ['KeyA', 65] : KEYS[key];
  if (!selected) throw new Error('Unsupported browser key.');
  const params = { key: key === 'SelectAll' ? 'a' : key, code: selected[0], windowsVirtualKeyCode: selected[1],
    nativeVirtualKeyCode: selected[1], modifiers: key === 'SelectAll' ? (process.platform === 'darwin' ? 4 : 2) : 0,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) };
  const context = await pageContext(project, tabId, adapters);
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Input.dispatchKeyEvent', params: { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...params } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...params, text: undefined, unmodifiedText: undefined } },
  ], undefined, undefined, adapters);
  return { ok: true };
}
