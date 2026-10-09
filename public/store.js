// The client data store owns shared reads, their last good values, event delivery, and refresh timers.
const SHARED = ['mailboxCounts', 'chats', 'roamgate'];
const URL_CACHE_LIMIT = 50;
const pageReads = (reads = []) => [...SHARED, ...reads];

function olderUpdatedAt(value, current) {
  const incoming = value?.updatedAt;
  const stored = current?.updatedAt;
  if (incoming == null || stored == null) return false;
  const incomingTime = typeof incoming === 'number' ? incoming : Date.parse(incoming);
  const storedTime = typeof stored === 'number' ? stored : Date.parse(stored);
  if (Number.isFinite(incomingTime) && Number.isFinite(storedTime)) return incomingTime < storedTime;
  return String(incoming) < String(stored);
}

// Each route names the shared API records that its view reads. Dynamic page reads use the store's readUrl method.
export const PAGE_READS = Object.freeze({
  overview: pageReads(['models', 'usage', 'handoffs']),
  fleet: pageReads(['fleetBundle']),
  board: pageReads([]),
  reviews: pageReads(['reviewReads']),
  agents: pageReads(['agentReads', 'agentRefresh']),
  projects: pageReads(['models', 'handoffs', 'projectReads', 'agentRefresh']),
  browsers: pageReads(['browserSessions', 'browserReads']),
  allocation: pageReads(['allocationReads']),
  analytics: pageReads(['models', 'usage', 'browserSessions', 'handoffs', 'denials', 'prices', 'spend', 'analytics', 'machineHours', 'quotaPlan']),
  settings: pageReads(['models', 'prices', 'settingsReads']),
  docs: pageReads(['docsReads']),
  mailbox: pageReads(['fleetBundle', 'mailboxList', 'mailboxReads']),
  chat: pageReads(['chatReads', 'agentRefresh']),
  'add-host': pageReads(['hostGuideReads']),
});

const EVENT_TYPES = ['state', 'message', 'review'];

export function createClientStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
  resources = {},
  pages = PAGE_READS,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  const values = new Map();
  const errors = new Map();
  const inFlight = new Map();
  const urlKeys = new Map();
  const valueListeners = new Map();
  const eventListeners = new Map();
  const connectionListeners = new Set();
  const timers = new Map();
  let page = null;
  let source = null;
  let connected = false;
  let stateEventVersion = 0;
  const resourceNameForUrl = (url) => Object.entries(resources).find(([, definition]) => !definition.dynamic && definition.url === url)?.[0] || null;

  const touchUrlKey = (key) => {
    if (!key.startsWith('url:')) return;
    urlKeys.delete(key);
    urlKeys.set(key, true);
    while (urlKeys.size > URL_CACHE_LIMIT) {
      const oldest = urlKeys.keys().next().value;
      urlKeys.delete(oldest);
      values.delete(oldest);
      errors.delete(oldest);
    }
  };
  const keepsUrlKey = (key) => !key.startsWith('url:') || urlKeys.has(key);

  const listenersFor = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
  };
  const notify = (key, value) => {
    values.set(key, value);
    for (const listener of valueListeners.get(key) || []) listener(value);
  };
  const setConnected = (next) => {
    if (connected === next) return;
    connected = next;
    for (const listener of connectionListeners) listener(connected);
  };
  const emit = (type, value) => {
    if (type === 'state') {
      stateEventVersion += 1;
      errors.delete('state');
      notify('state', value);
    }
    for (const listener of eventListeners.get(type) || []) listener(value);
  };
  const parseEvent = (event) => {
    try { return JSON.parse(event.data); } catch { return null; }
  };

  async function fetchValue(key, url, options) {
    if (inFlight.has(key)) return inFlight.get(key);
    const requestStateEventVersion = key === 'state' ? stateEventVersion : null;
    const request = (async () => {
      try {
        const response = await fetchImpl(url, options);
        const body = await response.json().catch(() => null);
        if (response.ok === false) {
          throw Object.assign(new Error(body?.error || `The API read failed (${response.status}).`), { status: response.status, body });
        }
        if (!keepsUrlKey(key)) return body;
        errors.delete(key);
        const current = values.get(key);
        if (key === 'state' && (requestStateEventVersion !== stateEventVersion || olderUpdatedAt(body, current))) {
          return current;
        }
        notify(key, body);
        return body;
      } catch (error) {
        if (keepsUrlKey(key)) errors.set(key, error);
        if (key === 'roamgate') {
          notify(key, null);
          return null;
        }
        if (keepsUrlKey(key) && values.has(key)) return values.get(key);
        throw error;
      }
    })();
    inFlight.set(key, request);
    try { return await request; }
    finally { if (inFlight.get(key) === request) inFlight.delete(key); }
  }

  async function refresh(name) {
    if (inFlight.has(name)) return inFlight.get(name);
    const definition = resources[name];
    if (!definition || definition.dynamic) return undefined;
    if (typeof definition.run === 'function') {
      const request = Promise.resolve().then(definition.run);
      inFlight.set(name, request);
      try {
        const value = await request;
        errors.delete(name);
        return value;
      }
      catch (error) { errors.set(name, error); throw error; }
      finally { if (inFlight.get(name) === request) inFlight.delete(name); }
    }
    if (typeof definition.load === 'function') {
      if (inFlight.has(name)) return inFlight.get(name);
      const request = (async () => {
        try {
          const value = await definition.load({ fetchImpl });
          errors.delete(name);
          notify(name, value);
          return value;
        } catch (error) {
          errors.set(name, error);
          if (values.has(name)) return values.get(name);
          throw error;
        }
      })();
      inFlight.set(name, request);
      try { return await request; }
      finally { if (inFlight.get(name) === request) inFlight.delete(name); }
    }
    const url = typeof definition.url === 'function' ? definition.url() : definition.url;
    if (!url) return undefined;
    return fetchValue(name, url, definition.options);
  }

  function readUrl(url, { force = false, options } = {}) {
    const name = resourceNameForUrl(url);
    const key = name || `url:${url}`;
    touchUrlKey(key);
    if (!force && values.has(key)) return Promise.resolve(values.get(key));
    return fetchValue(key, url, options || (name ? resources[name].options : undefined));
  }

  async function refreshPage(route = page) {
    const names = pages[route] || [];
    return Promise.allSettled(names.map((name) => refresh(name)));
  }

  function setPage(route) {
    if (page === route) return Promise.resolve([]);
    page = route;
    const active = new Set(pages[route] || []);
    for (const [name, timer] of timers) {
      if (active.has(name)) continue;
      clearIntervalImpl(timer);
      timers.delete(name);
    }
    for (const name of active) {
      const intervalMs = resources[name]?.intervalMs;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || timers.has(name)) continue;
      timers.set(name, setIntervalImpl(() => { void refresh(name).catch(() => {}); }, intervalMs));
    }
    return refreshPage(route);
  }

  function connect() {
    if (source || typeof EventSourceImpl !== 'function') return source;
    source = new EventSourceImpl('/api/events?caller=page');
    source.addEventListener('state', (event) => { const value = parseEvent(event); if (value !== null) emit('state', value); });
    for (const type of EVENT_TYPES.filter((name) => name !== 'state')) {
      source.addEventListener(type, (event) => { const value = parseEvent(event); if (value !== null) emit(type, value); });
    }
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return source;
  }

  function stop() {
    for (const timer of timers.values()) clearIntervalImpl(timer);
    timers.clear();
    source?.close?.();
    source = null;
    setConnected(false);
    page = null;
  }

  return {
    connect,
    stop,
    setPage,
    refreshPage,
    refresh,
    readUrl,
    value: (name) => values.get(name),
    error: (name) => errors.get(name),
    errorForUrl: (url) => errors.get(resourceNameForUrl(url) || `url:${url}`),
    get connected() { return connected; },
    subscribe(name, listener) {
      listenersFor(valueListeners, name).add(listener);
      if (values.has(name)) listener(values.get(name));
      return () => valueListeners.get(name)?.delete(listener);
    },
    subscribeEvent(type, listener) {
      listenersFor(eventListeners, type).add(listener);
      return () => eventListeners.get(type)?.delete(listener);
    },
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      listener(connected);
      return () => connectionListeners.delete(listener);
    },
  };
}
