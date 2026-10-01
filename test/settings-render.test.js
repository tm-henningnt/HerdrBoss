import './helpers/test-env.js';
// The Settings and Allocation views render with a fixture state. No two info buttons of one section may explain the same setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { POLICY_DEFAULTS } from '../src/control.js';
import { serviceSettingsView } from '../src/config.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// A stub that answers every property read and every call, so the page start-up code runs without a browser.
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : key === 'matches' ? false : key === 'length' ? 0 : stub()),
    set: () => true,
    apply: () => stub(),
    construct: () => stub(),
  });
}

function loadApp(code = source) {
  const stripped = code.replace(/^import [^\n]*\n/gm, '');
  const context = {
    document: stub(), window: stub(), location: { pathname: '/settings', search: '', hash: '' }, history: stub(), navigator: stub(),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => new Promise(() => {}), CSS: { escape: String },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0,
    URLSearchParams, URL, Date, JSON, Math, Promise, console, innerHeight: 800, innerWidth: 1280,
    EventSource: stub(), WebSocket: stub(), Blob, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => stub(), scrollTo() {}, MutationObserver: stub(), ResizeObserver: stub(), IntersectionObserver: stub(), AbortController, FormData: stub(), Event: stub(), CustomEvent: stub(), Intl, Set, Map, Number, String, Object, Array, Error, RegExp, parseInt, parseFloat, isFinite, Symbol, encodeURIComponent, decodeURIComponent,
  };
  return context;
}

async function views(code = source) {
  const context = loadApp(code);
  const handlers = new Map();
  const documentStub = context.document;
  context.document = new Proxy(documentStub, { get: (target, key) => key === 'addEventListener'
    ? (name, handler) => handlers.set(name, [...(handlers.get(name) || []), handler]) : target[key] });
  context.handlers = handlers;
  // The module imports of the page come from the real files of public/.
  for (const match of code.matchAll(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm)) {
    const module = await import(`../public/${match[2]}`);
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) context[name] = module[name];
  }
  const body = code.replace(/^import [^\n]*\n/gm, '');
  vm.runInNewContext(`${body}\nthis.views = { settingsView, allocationView, agentsView, boardView, setModels: (m) => { models = m; }, setState: (v) => { state = v; }, setDraft: (v) => { policyDraft = v; }, getDraft: () => policyDraft };`, context);
  return { ...context.views, context };
}

const provider = (name) => ({ provider: name, windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '2026-10-20T00:00:00.000Z' }], updatedAt: '2026-10-01T00:00:00.000Z' });
function fixture() {
  const policy = JSON.parse(JSON.stringify(POLICY_DEFAULTS));
  policy.allowedKinds = ['codex', 'claude'];
  policy.providerModes = { codex: 'managed', claude: 'managed' };
  policy.projects = { alpha: { share: 50, mode: 'auto', excludedKinds: [], excludedModels: [] }, beta: { share: 50, mode: 'auto', excludedKinds: [], excludedModels: [] } };
  const project = (slug) => ({ slug, label: slug, workspace: slug, running: 0, slots: 4, borrowed: 0, lent: 0, offered: 0, share: 50, mode: 'auto' });
  return {
    policy,
    control: { projects: { alpha: project('alpha'), beta: project('beta') }, workspaces: [{ label: 'alpha' }, { label: 'beta' }], runningWorkers: 0, handoffs: [] },
    quotas: [provider('codex'), provider('claude')],
    serviceSettings: serviceSettingsView({}),
    harness: { findings: [] },
    watchRoutines: [{ id: 'hourly', title: 'Hourly check', model: '', prompt: 'x', every: 60, source: 'kit' }, { id: 'second', title: 'Second check', model: '', prompt: 'y', every: 30, source: 'kit' }],
    herdr: { panes: [] },
    quotaThresholds: { warnPercent: 90, criticalPercent: 98 },
  };
}
const catalog = { defaultModel: 'a', defaultEffort: 'high', allowedEfforts: ['high'], allowedModels: ['a', 'b'] };

// The section of each info button: the nearest h2 or h3 before it.
function buttons(html) {
  const found = [];
  let section = '';
  for (const match of html.matchAll(/<h[23][ >][^]*?<\/h[23]>|data-setting-help="([^"]+)"/g)) {
    if (match[1]) found.push({ section, key: match[1] });
    else section = match[0].replace(/<button[^]*?<\/button>/g, '').replace(/<[^>]+>/g, '');
  }
  return found;
}

test('the rendered Settings and Allocation views hold no two buttons with the same explanation in one section', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  for (const [name, html] of [['Settings', app.settingsView(s)], ['Allocation', app.allocationView(s)]]) {
    assert.ok(html.length > 500, `${name} rendered`);
    const found = buttons(html);
    assert.ok(found.length >= 5, `${name} has info buttons`);
    const seen = new Set();
    for (const { section, key } of found) {
      const id = key.split('#')[0];
      assert.ok(!seen.has(`${section}|${id}`), `${name}: two buttons in "${section}" explain ${id}`);
      seen.add(`${section}|${id}`);
      assert.ok(!key.includes('#'), `${name}: ${key} is a per-row button`);
    }
  }
});

// cec19c0 is the commit before the header buttons. Its page has one button on each row.
test('the check fails on the version of the page that put one button on each row', async () => {
  const previous = (await import('node:child_process')).execFileSync('git', ['show', 'cec19c0:public/app.js'], { cwd: new URL('..', import.meta.url), maxBuffer: 1 << 26 }).toString();
  const app = await views(previous);
  app.setModels({ codex: catalog, claude: catalog });
  const keys = buttons(app.settingsView(fixture())).map((item) => item.key);
  assert.ok(keys.some((key) => key.includes('#')), 'the earlier page has per-row buttons');
});

test('the Board view renders its h1', async () => {
  const app = await views();
  const s = fixture();
  const html = app.boardView({ ...s, projects: [] });
  assert.match(html, /<h1>Board<\/h1>/);
});

test('the Settings view renders no link-only Watch panel and the Agents page keeps the Watch box', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  const html = app.settingsView(s);
  assert.doesNotMatch(html, /<h2>Watch<\/h2>/);
  assert.doesNotMatch(html, /href="\/agents#watch"/);
  assert.match(html, /<h2>Watch routines<\/h2>/);
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /function watchPanel\(/);
});

test('the Agents page shows both machine lock lanes, their queues, predictions, and guard state', async () => {
  const app = await views();
  const s = fixture();
  s.locks = [
    {
      name: 'full-suite', scope: 'machine', state: 'live', lane: 'long', slot: 'long', kind: 'manual',
      ownerPane: 'ws:long', project: 'alpha', ageSeconds: 60, expiresAt: '2026-10-01T13:00:00.000Z',
      slotsInUse: 2, slotLimit: 2, predictedMs: 900000,
      queue: [
        { id: 'short-ticket', position: 1, lane: 'short', project: 'beta', pane: 'ws:short', kind: 'suite', waitSeconds: 12, predictedMs: 60000, slotsInUse: 2, slotLimit: 2 },
        { id: 'long-ticket', position: 1, lane: 'long', project: 'gamma', pane: 'ws:long-wait', kind: 'suite', waitSeconds: 18, predictedMs: null, slotsInUse: 2, slotLimit: 2 },
      ],
    },
    {
      name: 'full-suite', scope: 'machine', state: 'live', lane: 'short', slot: 1, kind: 'suite',
      ownerPane: 'ws:short-holder', project: 'beta', ageSeconds: 30, slotsInUse: 2, slotLimit: 2, predictedMs: 60000,
    },
  ];
  s.lockStats = { acquires: 3, windowDays: 7, medianWaitMs: 2000, medianHoldMs: 60000, byLane: { long: { acquires: 2 }, short: { acquires: 1 } } };
  const html = app.agentsView(s);
  assert.match(html, /<h2>Locks<\/h2>/);
  assert.match(html, /Long lane/);
  assert.match(html, /Short lane/);
  assert.match(html, /ws:long/);
  assert.match(html, /ws:short-holder/);
  assert.match(html, /ws:short \(suite\)/);
  assert.match(html, /ws:long-wait/);
  assert.match(html, /predicted 15m/);
  assert.match(html, /predicted 1m/);
  assert.match(html, /guard on/i);
});

test('the Settings page renders all lock lane policy controls with setting help ids', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /<h2>Locks<\/h2>/);
  assert.match(html, /data-policy-lock="slots"/);
  assert.match(html, /data-policy-lock="shortLimitMinutes"/);
  assert.match(html, /data-policy-lock-guard="enabled"/);
  for (const key of ['maxLoadPercent', 'maxSwapPercent', 'minFreeMemPercent']) {
    assert.ok(html.includes(`data-policy-lock-guard="${key}"`), `Locks has a control for ${key}`);
  }
});


test('LK3 R8 changing a blank guard field shows its error and keeps typed zero valid', async () => {
  const app = await views();
  const state = fixture();
  app.setState(state);
  app.setDraft(state.policy);
  for (const key of ['maxLoadPercent', 'maxSwapPercent', 'minFreeMemPercent']) {
    const error = { textContent: '' };
    const attributes = {};
    const el = { dataset: { policyLockGuard: key }, value: '', checked: false,
      closest: () => ({}), setCustomValidity: (message) => { el.validityMessage = message; },
      setAttribute: (key, value) => { attributes[key] = value; }, removeAttribute: (key) => { delete attributes[key]; },
    };
    // The real change listener updates the field's accessible error element.
    const originalDocument = app.context.document;
    app.context.document = new Proxy(originalDocument, { get: (target, name) => name === 'getElementById' ? () => error : target[name] });
    app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyLockGuard'))({ target: el });
    assert.equal(app.getDraft().locks.guard[key], null, 'blank stays invalid in the request body');
    assert.match(error.textContent, /Enter a whole number/);
    assert.match(el.validityMessage, /Enter a whole number/);
    assert.equal(attributes['aria-invalid'], 'true');
    const html = app.settingsView(state);
    assert.match(html, /role="alert"[^>]*>Enter a whole number/);
    el.value = '0';
    app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyLockGuard'))({ target: el });
    assert.equal(app.getDraft().locks.guard[key], 0);
    assert.equal(error.textContent, '');
    assert.equal(el.validityMessage, '');
    assert.equal(attributes['aria-invalid'], undefined);
    app.context.document = originalDocument;
  }
});

test('LK3 R15 the lock panel labels saved and effective capacity during legacy exclusivity', async () => {
  const app = await views();
  const s = fixture();
  s.policy.locks.slots = 3;
  s.locks = [{ name: 'full-suite', scope: 'machine', state: 'live', lane: 'long', slot: 'long', kind: 'suite',
    ownerPane: 'ws:legacy', project: 'alpha', ageSeconds: 60, slotsInUse: 1, slotLimit: 1,
    configuredSlotLimit: 3, admissionMode: 'legacy-exclusive', predictedMs: null,
    queue: [{ id: 'short', position: 2, lane: 'long', project: 'beta', pane: 'ws:wait', kind: 'suite', waitSeconds: 12, predictedMs: 60000 }],
  }];
  app.setState(s);
  for (const render of [app.agentsView, app.allocationView]) {
    const html = render(s);
    assert.match(html, /Admission capacity: 1 slot/);
    assert.match(html, /Saved capacity: 3 slots/);
    assert.match(html, /global FIFO queue/);
    assert.match(html, /Short lane <span>0 \/ 0 slots/);
    assert.match(html, /2\. beta/);
  }
});
