// A CDP round trip against a project browser. /json/version can answer while the browser serves no tab,
// so the probe opens a temporary background tab and evaluates 1+1 in it. It closes only the tab that it opened.

export const PROBE_INTERVAL_MS = 60000;
const STEP_MS = 3000;
const TOTAL_MS = 8000;
const CLEANUP_MS = 2000;
const FAILURES_TO_MARK = 2;

class StepError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function timeoutAfter(ms, reason) {
  let timer;
  const promise = new Promise((_, reject) => { timer = setTimeout(() => reject(new StepError(reason)), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Run one step within limit milliseconds. A late result is dropped.
async function step(work, limit, timedOut, failed) {
  const timer = timeoutAfter(limit, timedOut);
  try { return await Promise.race([work, timer.promise]); }
  catch (error) { throw error instanceof StepError ? error : new StepError(failed); }
  finally { timer.cancel(); work.catch?.(() => {}); }
}

function openSession(endpoint, WebSocketImpl) {
  const socket = new WebSocketImpl(endpoint);
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
  ready.catch(() => {});
  const fail = (error) => { dead = error; for (const { reject } of pending.values()) reject(error); pending.clear(); };
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || 'command failed')); else entry.resolve(message.result ?? {});
  });
  socket.addEventListener('close', () => fail(new Error('socket closed')));
  socket.addEventListener('error', () => fail(new Error('socket error')));
  return {
    ready,
    isOpen: () => !dead && socket.readyState === 1,
    send(method, params = {}, sessionId) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    // Closing a socket that still connects fails it and leaves the TCP connection open. Wait for the late open, then close it with the close handshake.
    close() {
      try {
        if (socket.readyState === 0) socket.addEventListener('open', () => { try { socket.close(); } catch {} }, { once: true });
        else socket.close();
      } catch {}
    },
  };
}

async function endpointOf(port, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
  if (response.status !== 200) throw new Error('bad status');
  const endpoint = new URL((await response.json()).webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port) throw new Error('unexpected endpoint');
  endpoint.hostname = '127.0.0.1';
  return endpoint.href;
}

// Return { ok: true } or { ok: false, reason }. The reason is a plain phrase without a URL or a tab title.
// The function never throws. stepMs limits each step and totalMs limits all steps together.
export async function probeBrowser(port, { stepMs = STEP_MS, totalMs = TOTAL_MS, cleanupMs = CLEANUP_MS, fetch: fetchImpl = globalThis.fetch, WebSocket: WebSocketImpl = globalThis.WebSocket } = {}) {
  const deadline = Date.now() + totalMs;
  const limit = () => Math.max(1, Math.min(stepMs, deadline - Date.now()));
  // The holder lets the cleanup reach a socket that the getVersion step opens late. After cancel, a step that still runs opens and sends nothing.
  const holder = { session: null, cancelled: false, created: null, creating: null };
  const live = () => { if (holder.cancelled) throw new StepError('probe cancelled'); };
  try {
    await step((async () => {
      // The abort fires after the step timer, so a hung answer reads as a timeout.
      const abort = AbortSignal.timeout(limit() + 100);
      const endpoint = await endpointOf(port, (url) => fetchImpl(url, { signal: abort }));
      live();
      holder.session = openSession(endpoint, WebSocketImpl);
      await holder.session.ready;
      live();
      await holder.session.send('Browser.getVersion');
    })(), limit(), 'getVersion timed out', 'getVersion failed');
    const session = holder.session;
    const targets = await step(session.send('Target.getTargets'), limit(), 'getTargets timed out', 'getTargets failed');
    const pageTargets = Array.isArray(targets?.targetInfos) ? targets.targetInfos.filter((info) => info?.type === 'page' && typeof info.targetId === 'string') : [];
    const pageIds = pageTargets.map((info) => info.targetId);
    const attachedTabIds = pageTargets.filter((info) => info.attached === true).map((info) => info.targetId);
    holder.creating = session.send('Target.createTarget', { url: 'about:blank', background: true }).then((result) => {
      holder.created = result.targetId || null;
      if (holder.created) probeTabs.set(holder.created, Date.now());
      return result;
    });
    holder.creating.catch(() => {});
    const target = await step(holder.creating, limit(), 'createTarget timed out', 'createTarget failed');
    if (typeof target.targetId !== 'string' || !target.targetId) throw new StepError('createTarget failed');
    const value = await step((async () => {
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      return (await session.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sessionId))?.result?.value;
    })(), limit(), 'evaluate did not return', 'evaluate failed');
    if (value !== 2) throw new StepError('evaluate returned a wrong value');
    return finish({ ok: true, pageIds, attachedTabIds, attachedClientCount: attachedTabIds.length });
  } catch (error) {
    return finish({ ok: false, reason: error instanceof StepError ? error.reason : 'probe failed' });
  }

  // Close the temporary tab and the socket in every case, then return the result with a warning when the tab stayed open.
  async function finish(result) {
    holder.cancelled = true;
    const warning = await closeTemporaryTab({ port, holder, cleanupMs, fetchImpl });
    holder.session?.close();
    return warning ? { ...result, warnings: [warning] } : result;
  }
}

// Tabs that a probe opened. Each entry ends when the tab closes, or after 10 minutes. The tab list hides these tabs.
const probeTabs = new Map();
const PROBE_TAB_TTL_MS = 10 * 60000;
export function isProbeTab(id, now = Date.now()) {
  for (const [tab, at] of probeTabs) if (now - at > PROBE_TAB_TTL_MS) probeTabs.delete(tab);
  return probeTabs.has(id);
}

// Close the tab that this probe created. Wait a short time for a late createTarget answer to learn its ID.
// Return a plain warning when the tab did not close. The warning holds the target ID and no URL.
async function closeTemporaryTab({ port, holder, cleanupMs, fetchImpl }) {
  if (holder.creating && !holder.created) await Promise.race([holder.creating.catch(() => {}), new Promise((resolve) => setTimeout(resolve, cleanupMs))]);
  const id = holder.created;
  if (!id) return null;
  if (holder.session?.isOpen()) {
    try { await step(holder.session.send('Target.closeTarget', { targetId: id }), cleanupMs, 'close timed out', 'close failed'); probeTabs.delete(id); return null; } catch {}
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(cleanupMs) });
    if (response.ok) { probeTabs.delete(id); return null; }
  } catch {}
  return `The probe tab ${id} on port ${port} did not close.`;
}

const freshState = () => ({ ok: null, notResponding: false, lastProbeAt: null, reason: null, failures: 0, since: null, pageIds: null, attachedTabIds: null, attachedClientCount: null });

// Track the probe state of each managed browser. tick() returns the state at once and starts a background probe when one is due.
// A browser is due when it is active, no probe of it runs, and the last probe started at least intervalMs ago.
export function createBrowserProbes({ probe = probeBrowser, intervalMs = PROBE_INTERVAL_MS, failuresToMark = FAILURES_TO_MARK, onWarning = () => {} } = {}) {
  const records = new Map();
  const running = new Set();
  const settle = new Set();

  function start(record, browser, now) {
    record.startedAt = now;
    record.state.ok = null;
    record.state.pageIds = null;
    record.state.attachedTabIds = null;
    record.state.attachedClientCount = null;
    running.add(record);
    const work = (async () => {
      let result;
      try { result = await probe(browser.port); } catch { result = { ok: false, reason: 'probe failed' }; }
      for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) { try { onWarning(warning, browser); } catch {} }
      const state = record.state;
      state.lastProbeAt = new Date(now).toISOString();
      if (result?.ok) Object.assign(state, {
        ok: true, notResponding: false, reason: null, failures: 0, since: null,
        pageIds: Array.isArray(result.pageIds) ? result.pageIds.filter((id) => typeof id === 'string') : null,
        attachedTabIds: Array.isArray(result.attachedTabIds) ? result.attachedTabIds.filter((id) => typeof id === 'string') : null,
        attachedClientCount: Number.isSafeInteger(result.attachedClientCount) && result.attachedClientCount >= 0 ? result.attachedClientCount : null,
      });
      else {
        state.ok = false;
        state.pageIds = null;
        state.attachedTabIds = null;
        state.attachedClientCount = null;
        state.failures++;
        state.reason = typeof result?.reason === 'string' ? result.reason : 'probe failed';
        if (state.failures >= failuresToMark && !state.notResponding) { state.notResponding = true; state.since = state.lastProbeAt; }
      }
    })().finally(() => { running.delete(record); settle.delete(work); });
    settle.add(work);
  }

  return {
    tick(browser, now = Date.now()) {
      // A browser that is closed, or that Herdr Boss did not start, gets no probe and keeps no state.
      for (const [key, record] of records) if (record.project === browser.project && (key !== browser.key || !browser.active)) records.delete(key);
      if (!browser.active) return freshState();
      let record = records.get(browser.key);
      if (!record) { record = { project: browser.project, state: freshState(), startedAt: null }; records.set(browser.key, record); }
      if (!running.has(record) && (record.startedAt === null || now - record.startedAt >= intervalMs)) start(record, browser, now);
      return { ...record.state };
    },
    async idle() { while (settle.size) await Promise.all([...settle]); },
  };
}

// Add the probe state of the last engine tick to the browser records of the browsers API.
// A record without a matching tick record, or with another port, or without a verified process, is not marked.
export function withProbeState(sessions, managedBrowsers) {
  const probed = new Map((managedBrowsers || []).map((b) => [b.project, b]));
  return sessions.map((b) => {
    const probe = probed.get(b.project);
    const current = !!probe && String(probe.port) === String(b.port) && !!b.profileVerified;
    return { ...b, notResponding: current && !!probe.notResponding, probeAt: current ? probe.probeAt ?? null : null, probeReason: current ? probe.probeReason ?? null : null };
  });
}
