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
  // The module imports of the page come from the real files of public/.
  for (const match of code.matchAll(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm)) {
    const module = await import(`../public/${match[2]}`);
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) context[name] = module[name];
  }
  const body = code.replace(/^import [^\n]*\n/gm, '');
  vm.runInNewContext(`${body}\nthis.views = { settingsView, allocationView, boardView, setModels: (m) => { models = m; }, setState: (v) => { state = v; } };`, context);
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
