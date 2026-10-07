import { isProbeTab } from './browser-probe.js';
import { maskUrl, maskBrowserText } from './browser-url-mask.js';
import { capMeasurement, measureScript } from './browser-measure.js';
import { CONSOLE_LIMITS, CONSOLE_LEVELS, formatConsoleEvent } from './browser-console.js';
import { forgetAgentBrowserTab, recordAgentBrowserTab, withBrowserCommand } from './browser-activity.js';
import { browserStatus, forgetBrowserTab, rememberBrowserTab, rememberBrowserTabs, listBrowserSessions, listBrowserTabViewports, setBrowserTabViewport } from './browser-pool.js';

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
  return maskUrl(String(value || ''), { full: true }).slice(0, 160);
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

async function listBrowserTabsImpl(project, adapters = {}) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  // The tab of a running or failed CDP probe is not a page of an agent or the Owner.
  const pages = (await (adapters.listTargets || targets)(session)).filter((page) => !isProbeTab(page.id));
  if (adapters.rememberTabs !== false) rememberBrowserTabs(project, pages);
  const viewports = listBrowserTabViewports(project, pages.map((page) => page.id));
  let attached = null;
  try { attached = await (adapters.attachedTargets || attachedTargets)(session); } catch {}
  const visibility = await Promise.all(pages.map((entry) => (adapters.pageVisibility || pageVisibility)(entry, session.port, viewports[entry.id])));
  return pages.map((entry, index) => ({ id: entry.id, title: entry.title || 'Untitled page', url: entry.url, attached: attached ? attached.has(entry.id) : null, visibility: visibility[index] }));
}

async function tabAttachedImpl(project, tabId) {
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
async function browserNewTabImpl(project, url = 'about:blank', adapters = {}) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  const result = await (adapters.command || command)(await (adapters.browserEndpoint || browserEndpoint)(session), 'Target.createTarget', { url: tabUrl(url), newWindow: true, background: true });
  if (!result?.targetId) throw new Error('Browser did not open a new tab.');
  recordAgentBrowserTab(project, result.targetId);
  if (adapters.rememberTabs !== false) rememberBrowserTab(project, result.targetId, tabUrl(url));
  return { id: result.targetId };
}

async function browserCloseTabImpl(project, tabId, adapters = {}) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  if (!(await (adapters.listTargets || targets)(session)).some((entry) => entry.id === tabId)) throw new Error('That tab is no longer open. Run browser tabs again.');
  if (!adapters.force && (await (adapters.attachedTargets || attachedTargets)(session)).has(tabId)) throw new Error('An agent is attached to this tab. Close it when that agent is done, or pass --force.');
  const result = await (adapters.command || command)(await (adapters.browserEndpoint || browserEndpoint)(session), 'Target.closeTarget', { targetId: tabId });
  if (result?.success === false) throw new Error('Browser did not close the tab.');
  forgetClosedTab(project, tabId, adapters);
  return { closed: tabId };
}

function forgetClosedTab(project, tabId, adapters) {
  try { forgetAgentBrowserTab(project, tabId); } catch {}
  setBrowserTabViewport(project, tabId, null);
  if (adapters.rememberTabs !== false) forgetBrowserTab(project, tabId);
}

// If the HTTP tab listing fails after a relaunch, use browser CDP to remove its unused blank tab.
async function browserCloseBlankTabsImpl(project, excludedIds, adapters) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  const endpoint = await (adapters.browserEndpoint || browserEndpoint)(session);
  const runCommand = adapters.command || command;
  const result = await runCommand(endpoint, 'Target.getTargets');
  const excluded = new Set(excludedIds);
  for (const tab of result?.targetInfos || []) {
    if (tab.type !== 'page' || tab.url !== 'about:blank' || tab.attached !== false || excluded.has(tab.targetId)) continue;
    const closed = await runCommand(endpoint, 'Target.closeTarget', { targetId: tab.targetId });
    if (closed?.success !== false) forgetClosedTab(project, tab.targetId, adapters);
  }
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

async function consolePageContext(project, tabId, adapters = {}) {
  const session = await (adapters.verifySession || verifiedSession)(project);
  let targetPages;
  try { targetPages = await (adapters.listTargets || targets)(session); }
  catch { throw new Error('Could not connect to the browser page.'); }
  const pages = targetPages.filter((page) => !isProbeTab(page.id));
  if (!pages.length) throw new Error('No browser page is open.');
  if (!tabId && pages.length > 1) throw new Error('Several pages are open. Run browser tabs and specify --tab ID.');
  const target = tabId ? pages.find((page) => page.id === tabId) : pages[0];
  if (!target) throw new Error('The selected tab is no longer open. Reload the tab list.');
  let endpoint;
  try { endpoint = new URL(target.webSocketDebuggerUrl); }
  catch { throw new Error('Browser returned an unexpected debugging endpoint.'); }
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== session.port) throw new Error('Browser returned an unexpected debugging endpoint.');
  endpoint.hostname = '127.0.0.1';
  const viewports = (adapters.listViewports || listBrowserTabViewports)(project, pages.map((page) => page.id));
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
      if (error) reject(new Error(maskBrowserText(error.message, { full: true }))); else resolve(result);
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

function browserScreenshotImpl(project, tabId, adapters = {}) {
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

async function browserNavigateImpl(project, tabId, value, adapters = {}) {
  let url;
  const input = String(value || '').trim();
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be opened.');
  const context = await pageContext(project, tabId, adapters);
  const result = (await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.navigate', params: { url: url.href } },
  ], undefined, undefined, adapters)).at(-1);
  if (result?.errorText) throw new Error(maskBrowserText(result.errorText, { full: true }));
  rememberBrowserTab(project, context.target.id, url.href);
  return { url: displayUrl(url.href) };
}

async function browserNavigationStateImpl(project, tabId, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  const history = (await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.getNavigationHistory' },
  ], undefined, undefined, adapters)).at(-1);
  const entries = history?.entries || [];
  const currentIndex = history?.currentIndex ?? -1;
  if (entries[currentIndex]?.url) rememberBrowserTab(project, context.target.id, entries[currentIndex].url);
  return { url: maskUrl(entries[currentIndex]?.url || '', { full: true }), canGoBack: currentIndex > 0, canGoForward: currentIndex >= 0 && currentIndex < entries.length - 1 };
}

async function browserHistoryActionImpl(project, tabId, action, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  if (action === 'home') {
    const result = (await pageCommands(context.endpoint, context.viewport, [
      { method: 'Page.navigate', params: { url: 'about:blank' } },
    ], undefined, undefined, adapters)).at(-1);
    if (result?.errorText) throw new Error(maskBrowserText(result.errorText, { full: true }));
    rememberBrowserTab(project, context.target.id, 'about:blank');
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
  rememberBrowserTab(project, context.target.id, entry.url);
  return { url: maskUrl(entry.url, { full: true }) };
}

// Move the mouse to a position relative to the screenshot, with no press, so a hover state or a tooltip shows.
async function browserHoverImpl(project, tabId, relativeX, relativeY, adapters = {}) {
  if (![relativeX, relativeY].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Hover position must be inside the screenshot.');
  const context = await pageContext(project, tabId, adapters);
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Page.getLayoutMetrics' },
    (metrics) => {
      const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
      if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error('Could not determine the page viewport.');
      return { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', button: 'none', buttons: 0,
        x: Math.min(viewport.clientWidth - 1, Math.round(relativeX * viewport.clientWidth)),
        y: Math.min(viewport.clientHeight - 1, Math.round(relativeY * viewport.clientHeight)) } };
    },
  ], undefined, undefined, adapters);
  return { ok: true };
}

async function browserClickImpl(project, tabId, relativeX, relativeY, adapters = {}) {
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

async function browserDragImpl(project, tabId, from, to, { steps = 10, adapters = {} } = {}) {
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

async function browserViewportImpl(project, tabId, viewport, adapters = {}) {
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

async function browserInsertTextImpl(project, tabId, text, adapters = {}) {
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

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function modifierMask(modifiers) {
  if (!Array.isArray(modifiers) || modifiers.length > 4) throw new Error('Unsupported browser key modifier.');
  let mask = 0;
  for (const name of modifiers) {
    if (!Object.hasOwn(MODIFIER_BITS, name)) throw new Error('Unsupported browser key modifier.');
    mask |= MODIFIER_BITS[name];
  }
  return mask;
}

async function browserKeyImpl(project, tabId, key, adapters = {}, modifiers = []) {
  const mask = modifierMask(modifiers);
  const single = typeof key === 'string' && /^[a-zA-Z0-9]$/.test(key);
  const selected = key === 'SelectAll' ? ['KeyA', 65] : single ? [/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)] : KEYS[key];
  if (!selected) throw new Error('Unsupported browser key.');
  const selectAll = key === 'SelectAll' ? (process.platform === 'darwin' ? 4 : 2) : 0;
  const params = { key: key === 'SelectAll' ? 'a' : key, code: selected[0], windowsVirtualKeyCode: selected[1],
    nativeVirtualKeyCode: selected[1], modifiers: mask | selectAll,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) };
  const context = await pageContext(project, tabId, adapters);
  await pageCommands(context.endpoint, context.viewport, [
    { method: 'Input.dispatchKeyEvent', params: { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...params } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...params, text: undefined, unmodifiedText: undefined } },
  ], undefined, undefined, adapters);
  return { ok: true };
}

// A page measurement runs one fixed Runtime.evaluate. The selectors travel as JSON data in the expression, so a
// selector can never inject code, and the script returns geometry and styles only: no page text, cookies, storage,
// or attributes. The printed result is capped at 20 KB with truncated: true when a cut happened.
async function browserMeasureImpl(project, tabId, selectors, adapters = {}) {
  const context = await pageContext(project, tabId, adapters);
  const results = await pageCommands(context.endpoint, context.viewport, [
    { method: 'Runtime.evaluate', params: { expression: measureScript(selectors), returnByValue: true } },
  ], 15000, 'The page did not return measurements within 15 s. It can be loading, busy, or showing a dialog, or an agent can be taking its own screenshot of this browser.', adapters);
  const raw = results.at(-1);
  if (raw?.exceptionDetails) throw new Error('The page could not be measured.');
  if (!raw?.result?.value || typeof raw.result.value !== 'object' || Array.isArray(raw.result.value)) throw new Error('Browser returned no measurements.');
  return capMeasurement(raw.result.value);
}

const CONSOLE_CONNECTION_ERROR = 'Could not connect to the browser page.';

function collectConsoleMessages(endpoint, { levels, last, waitMs, knownHosts = [] }, adapters = {}) {
  return new Promise((resolve, reject) => {
    const WebSocketImpl = adapters.WebSocket || globalThis.WebSocket;
    let socket;
    try { socket = new WebSocketImpl(endpoint); }
    catch { reject(new Error(CONSOLE_CONNECTION_ERROR)); return; }

    let settled = false;
    const pending = new Set([1, 2]);
    const messages = [];
    const seen = new Map();
    const setupTimer = setTimeout(() => finish(new Error(CONSOLE_CONNECTION_ERROR)), CONSOLE_LIMITS.setupMs);
    let waitTimer = null;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(setupTimer);
      clearTimeout(waitTimer);
      try { socket.close(); } catch {}
      if (error) reject(new Error(CONSOLE_CONNECTION_ERROR));
      else resolve(result);
    }

    function receiveEvent(event) {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id === 1 || message.id === 2) {
        if (!pending.has(message.id)) return;
        if (message.error) return finish(new Error(CONSOLE_CONNECTION_ERROR));
        pending.delete(message.id);
        if (!pending.size) {
          clearTimeout(setupTimer);
          waitTimer = setTimeout(() => finish(null, messages.map(({ record }) => record)), waitMs);
        }
        return;
      }
      if (settled || typeof message.method !== 'string') return;
      const record = formatConsoleEvent(message, { levels, knownHosts });
      if (!record) return;
      const kind = message.method === 'Runtime.consoleAPICalled' ? 'runtime' : 'log';
      const otherKind = kind === 'runtime' ? 'log' : 'runtime';
      const key = `${record.level}\u0000${record.timestamp}\u0000${record.source}\u0000${record.text}`;
      const counts = seen.get(key) || { runtime: 0, log: 0 };
      if (counts[otherKind] > 0) {
        counts[otherKind] -= 1;
        if (!counts.runtime && !counts.log) seen.delete(key);
        else seen.set(key, counts);
        return;
      }
      counts[kind] += 1;
      seen.set(key, counts);
      messages.push({ record, key, kind });
      if (messages.length > last) {
        const removed = messages.shift();
        const prior = seen.get(removed.key);
        if (prior) {
          prior[removed.kind] -= 1;
          if (!prior.runtime && !prior.log) seen.delete(removed.key);
        }
      }
    }

    socket.addEventListener('open', () => {
      try {
        // Enable both domains before waiting so Log can send entries that Chrome buffered before attach.
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
        socket.send(JSON.stringify({ id: 2, method: 'Log.enable', params: {} }));
      } catch { finish(new Error(CONSOLE_CONNECTION_ERROR)); }
    });
    socket.addEventListener('message', receiveEvent);
    socket.addEventListener('error', () => finish(new Error(CONSOLE_CONNECTION_ERROR)));
    socket.addEventListener('close', () => finish(new Error(CONSOLE_CONNECTION_ERROR)));
  });
}

async function browserConsoleImpl(project, tabId, options, adapters = {}) {
  const context = await consolePageContext(project, tabId, adapters);
  return collectConsoleMessages(context.endpoint, options, adapters);
}

// Keep the activity record for the entire operation, including verification and a queued screenshot.
export function listBrowserTabs(project, adapters = {}) {
  return withBrowserCommand(project, () => listBrowserTabsImpl(project, adapters), adapters.activity);
}
export function tabAttached(project, tabId) {
  return withBrowserCommand(project, () => tabAttachedImpl(project, tabId));
}
export function browserNewTab(project, url = 'about:blank', adapters = {}) {
  return withBrowserCommand(project, () => browserNewTabImpl(project, url, adapters), adapters.activity);
}
export function browserCloseTab(project, tabId, options = {}) {
  return withBrowserCommand(project, () => browserCloseTabImpl(project, tabId, options), options.activity);
}
export function browserCloseBlankTabs(project, excludedIds = [], adapters = {}) {
  return withBrowserCommand(project, () => browserCloseBlankTabsImpl(project, excludedIds, adapters), adapters.activity);
}
export function browserDrag(project, tabId, from, to, options = {}) {
  return withBrowserCommand(project, () => browserDragImpl(project, tabId, from, to, options), options.adapters?.activity);
}
export function browserScreenshot(project, tabId, adapters = {}) {
  return withBrowserCommand(project, () => browserScreenshotImpl(project, tabId, adapters), adapters.activity);
}
export function browserNavigate(project, tabId, value, adapters = {}) {
  return withBrowserCommand(project, () => browserNavigateImpl(project, tabId, value, adapters), adapters.activity);
}
export function browserNavigationState(project, tabId, adapters = {}) {
  return withBrowserCommand(project, () => browserNavigationStateImpl(project, tabId, adapters), adapters.activity);
}
export function browserHistoryAction(project, tabId, action, adapters = {}) {
  return withBrowserCommand(project, () => browserHistoryActionImpl(project, tabId, action, adapters), adapters.activity);
}
export function browserHover(project, tabId, relativeX, relativeY, adapters = {}) {
  return withBrowserCommand(project, () => browserHoverImpl(project, tabId, relativeX, relativeY, adapters), adapters.activity);
}
export function browserClick(project, tabId, relativeX, relativeY, adapters = {}) {
  return withBrowserCommand(project, () => browserClickImpl(project, tabId, relativeX, relativeY, adapters), adapters.activity);
}
export function browserViewport(project, tabId, viewport, adapters = {}) {
  return withBrowserCommand(project, () => browserViewportImpl(project, tabId, viewport, adapters), adapters.activity);
}
export function browserInsertText(project, tabId, text, adapters = {}) {
  return withBrowserCommand(project, () => browserInsertTextImpl(project, tabId, text, adapters), adapters.activity);
}
export function browserKey(project, tabId, key, adapters = {}, modifiers = []) {
  return withBrowserCommand(project, () => browserKeyImpl(project, tabId, key, adapters, modifiers), adapters.activity);
}
export function browserMeasure(project, tabId, selectors, adapters = {}) {
  return withBrowserCommand(project, () => browserMeasureImpl(project, tabId, selectors, adapters), adapters.activity);
}
export function browserConsole(project, tabId, options, adapters = {}) {
  return withBrowserCommand(project, () => browserConsoleImpl(project, tabId, options, adapters), adapters.activity);
}
