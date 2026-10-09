// A CDP round trip against a project browser. /json/version can answer while the browser serves no tab,
// so the probe opens a temporary background tab and evaluates 1+1 in it. It closes only the tab that it opened.
import { BROWSER_QUIET_MS, withBrowserCommand } from './browser-activity.js';

export const PROBE_INTERVAL_MS = 60000;
const STEP_MS = 3000;
const TOTAL_MS = 8000;
const CLEANUP_MS = 2000;
const FAILURES_TO_MARK = 2;

class StepError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// A reserved browser restart refuses a probe command (exitCode 3). The probe never read the browser, so it is not
// a failed probe. The detector ignores a skipped result: it keeps the previous state and counts no failure.
class SkippedError extends Error {
  constructor() { super('browser restart in progress'); this.skipped = true; }
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
  catch (error) { if (error?.skipped) throw error; throw error instanceof StepError ? error : new StepError(failed); }
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
// With a project, the tab open, the stale-tab sweep and the tab close run in the browser command queue
// (the same queue as every other tab open), so a restart waits for them and a probe never counts as user activity.
export async function probeBrowser(port, { stepMs = STEP_MS, totalMs = TOTAL_MS, cleanupMs = CLEANUP_MS, fetch: fetchImpl = globalThis.fetch, WebSocket: WebSocketImpl = globalThis.WebSocket, onTabs = () => {}, project = null, queue = null } = {}) {
  const deadline = Date.now() + totalMs;
  const limit = () => Math.max(1, Math.min(stepMs, deadline - Date.now()));
  // The holder lets the cleanup reach a socket that the getVersion step opens late. After cancel, a step that still runs opens and sends nothing.
  const holder = { session: null, cancelled: false, created: null, creating: null };
  const live = () => { if (holder.cancelled) throw new StepError('probe cancelled'); };
  const useQueue = typeof queue === 'function' ? queue : (project ? withBrowserCommand : null);
  const queued = (work) => {
    if (!useQueue) return work();
    // A restart in progress refuses the command with exitCode 3. That is a skip, not a failed probe.
    return useQueue(project, work, { markActivity: false }).catch((error) => {
      if (error?.exitCode === 3) throw new SkippedError();
      throw error;
    });
  };
  let result;
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
    onTabs(pageTargets.filter((info) => !isProbeTab(info.targetId)).map((info) => ({ id: info.targetId, url: info.url })));
    const pageIds = pageTargets.map((info) => info.targetId);
    const attachedTabIds = pageTargets.filter((info) => info.attached === true).map((info) => info.targetId);
    // Close a tagged probe tab that a previous probe left behind, before this probe opens its own tab.
    try { await queued(() => sweepProbeTabs({ targets: pageIds, closeTarget: (id) => session.send('Target.closeTarget', { targetId: id }), now: Date.now() })); } catch {}
    holder.creating = queued(() => session.send('Target.createTarget', { url: 'about:blank', background: true })).then((created) => {
      holder.created = created.targetId || null;
      if (holder.created) tagProbeTab(holder.created, project, Date.now());
      return created;
    });
    holder.creating.catch(() => {});
    const target = await step(holder.creating, limit(), 'createTarget timed out', 'createTarget failed');
    if (typeof target.targetId !== 'string' || !target.targetId) throw new StepError('createTarget failed');
    const value = await step((async () => {
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      return (await session.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sessionId))?.result?.value;
    })(), limit(), 'evaluate did not return', 'evaluate failed');
    if (value !== 2) throw new StepError('evaluate returned a wrong value');
    result = { ok: true, pageIds, attachedTabIds, attachedClientCount: attachedTabIds.length };
  } catch (error) {
    result = error?.skipped
      ? { ok: false, skipped: true, reason: 'browser restart in progress' }
      : { ok: false, reason: error instanceof StepError ? error.reason : 'probe failed' };
  } finally {
    // Close the temporary tab and the socket in every case, also on a timeout, an error and a hung request.
    holder.cancelled = true;
    try {
      const warning = await closeTemporaryTab({ port, holder, cleanupMs, fetchImpl, queued });
      if (warning) result.warnings = [warning];
    } catch {}
    holder.session?.close();
  }
  return result;
}

// Tabs that a probe opened. Each entry ends when the tab closes, or after 10 minutes. The tab list hides these tabs.
// A tag holds the project and the time, so the sweep below can close a tab that a failed cleanup left behind.
const probeTabs = new Map();
const PROBE_TAB_TTL_MS = 10 * 60000;
// A leaked probe tab is swept on a later engine tick after this age. The registry keeps a tag for 10 minutes, so
// the next tick reaches it. Only a tagged tab is swept; a tab of the Owner or of a worker carries no tag.
export const PROBE_TAB_STALE_MS = 2 * 60000;
// The most probe tabs that one tick closes. The sweep stays bounded, also when many tabs leaked at once.
export const PROBE_TAB_SWEEP_MAX = 20;

function pruneProbeTabs(now) {
  for (const [tab, tag] of probeTabs) if (now - tag.at > PROBE_TAB_TTL_MS) probeTabs.delete(tab);
}

export function isProbeTab(id, now = Date.now()) {
  pruneProbeTabs(now);
  return probeTabs.has(id);
}

// Tag a tab that a probe opened, so the tab list hides it and the sweep can close it on a later tick.
export function tagProbeTab(id, project = null, at = Date.now()) {
  if (typeof id === 'string' && id) probeTabs.set(id, { project, at });
}

export function untagProbeTab(id) {
  probeTabs.delete(id);
}

// Close tagged probe tabs older than minAgeMs in one bounded tick. `targets` holds page target IDs, or target
// objects with an `id`. Return the IDs that closed. A close that fails keeps its tag for the next tick.
export async function sweepProbeTabs({ targets = [], closeTarget, now = Date.now(), minAgeMs = PROBE_TAB_STALE_MS, max = PROBE_TAB_SWEEP_MAX } = {}) {
  const closed = [];
  if (typeof closeTarget !== 'function') return closed;
  for (const target of targets) {
    if (closed.length >= max) break;
    const id = typeof target === 'string' ? target : target?.id;
    const tag = typeof id === 'string' ? probeTabs.get(id) : null;
    if (!tag || now - tag.at < minAgeMs) continue;
    try { await closeTarget(id); untagProbeTab(id); closed.push(id); } catch {}
  }
  return closed;
}

// Close the tab that this probe created. Wait a short time for a late createTarget answer to learn its ID.
// Return a plain warning when the tab did not close. The warning holds the target ID and no URL.
async function closeTemporaryTab({ port, holder, cleanupMs, fetchImpl, queued = (work) => work() }) {
  if (holder.creating && !holder.created) await Promise.race([holder.creating.catch(() => {}), new Promise((resolve) => setTimeout(resolve, cleanupMs))]);
  const id = holder.created;
  if (!id) return null;
  if (holder.session?.isOpen()) {
    // Chrome reports a refused close with success: false on an answering socket, so fall through to the HTTP close.
    try {
      const closed = await step(queued(() => holder.session.send('Target.closeTarget', { targetId: id })), cleanupMs, 'close timed out', 'close failed');
      if (closed?.success === false) throw new Error('close refused');
      untagProbeTab(id);
      return null;
    } catch {}
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(cleanupMs) });
    if (response.ok) { untagProbeTab(id); return null; }
  } catch {}
  return `The probe tab ${id} on port ${port} did not close.`;
}

const freshState = () => ({ ok: null, notResponding: false, lastProbeAt: null, reason: null, failures: 0, since: null, pageIds: null, attachedTabIds: null, attachedClientCount: null });

// Track the probe state of each managed browser. tick() returns the state at once and starts a background probe when one is due.
// A browser is due when it is active, no probe of it runs, and the last probe started at least intervalMs ago.
export function createBrowserProbes({ probe = probeBrowser, intervalMs = PROBE_INTERVAL_MS, failuresToMark = FAILURES_TO_MARK, onWarning = () => {}, onTabs = () => {}, activity = () => ({ inFlight: 0, lastCommandAt: null }), clock = Date.now } = {}) {
  const records = new Map();
  const running = new Set();
  const settle = new Set();

  function start(record, browser, now) {
    const busy = (at) => {
      try {
        const command = activity(browser.project);
        return command.restarting || command.inFlight > 0 || (Number.isFinite(command.lastCommandAt) && at - command.lastCommandAt < BROWSER_QUIET_MS);
      } catch { return true; } // Unknown activity must not count as a quiet failure.
    };
    const startedBusy = busy(now);
    record.startedAt = now;
    record.state.ok = null;
    record.state.pageIds = null;
    record.state.attachedTabIds = null;
    record.state.attachedClientCount = null;
    running.add(record);
    const work = (async () => {
      let result;
      try { result = await probe(browser.port, { onTabs: (tabs) => onTabs(tabs, browser), project: browser.project,
        ...(browser.externalClients > 0 ? { stepMs: STEP_MS * 2, totalMs: TOTAL_MS * 2 } : {}) }); } catch { result = { ok: false, reason: 'probe failed' }; }
      for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) { try { onWarning(warning, browser); } catch {} }
      const state = record.state;
      // A restart refused the probe: this is not a reading. Keep the previous verdict and count no failure.
      if (result?.skipped) return;
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
        const counted = !startedBusy && !busy(clock());
        state.failures = counted ? state.failures + 1 : 0;
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
