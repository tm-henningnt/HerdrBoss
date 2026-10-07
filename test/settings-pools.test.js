import './helpers/test-env.js';
// The Settings page shows the resource pools with the same editor as the Allocation page. A client value never reaches the page.
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

async function views() {
  const context = {
    document: stub(), window: stub(), location: { pathname: '/settings', search: '', hash: '' }, history: stub(), navigator: stub(),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => new Promise(() => {}), CSS: { escape: String },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0,
    URLSearchParams, URL, Date, JSON, Math, Promise, console, innerHeight: 800, innerWidth: 1280,
    EventSource: stub(), WebSocket: stub(), Blob, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => stub(), scrollTo() {}, MutationObserver: stub(), ResizeObserver: stub(), IntersectionObserver: stub(), AbortController, FormData: stub(), Event: stub(), CustomEvent: stub(), Intl, Set, Map, Number, String, Object, Array, Error, RegExp, parseInt, parseFloat, isFinite, Symbol, encodeURIComponent, decodeURIComponent,
  };
  for (const match of source.matchAll(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm)) {
    const module = await import(`../public/${match[2]}`);
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      context[name] = name === 'createClientStore'
        ? (options) => module[name]({
          ...options,
          fetchImpl: context.fetch,
          EventSourceImpl: context.EventSource,
          setIntervalImpl: context.setInterval,
          clearIntervalImpl: context.clearInterval,
        })
        : module[name];
    }
  }
  const body = source.replace(/^import [^\n]*\n/gm, '');
  vm.runInNewContext(`${body}\nthis.views = { settingsView, allocationView, poolSettingsPanel, poolEditorState, setPoolEditor: (patch) => Object.assign(poolEditor, patch), setModels: (m) => { models = m; }, setState: (v) => { state = v; } };`, context);
  return context.views;
}

// One pool with a client value, and the built-in browser pool that the page only reports.
const POOL = {
  name: 'serve-ports', items: ['8000', '8001', '8002', '8003', '8004'], range: '8000-8004',
  split: { alpha: ['8000', '8001'] }, env: 'HERDR_SERVE_PORT', ttlMinutes: 120, check: 'tcp',
  graceMinutes: 10, idleMinutes: 30, waitSeconds: 5,
  portEnv: { TM_PREVIEW_CLIENT_ID: { '8000-8004': 'test-value-1' } },
};
const BUILT_IN = { name: 'project-browsers', items: ['9222'], builtIn: true, env: 'HERDR_BROWSER_PORT', ttlMinutes: 240, check: 'cdp', graceMinutes: 5 };
const SECRET = 'test-value-1';

function fixture() {
  const policy = JSON.parse(JSON.stringify(POLICY_DEFAULTS));
  policy.allowedKinds = ['codex', 'claude'];
  policy.providerModes = { codex: 'managed', claude: 'managed' };
  const project = (slug) => ({ slug, label: slug, workspace: slug, running: 0, slots: 4, borrowed: 0, lent: 0, offered: 0, share: 50, mode: 'auto' });
  return {
    policy,
    control: { projects: { alpha: project('alpha') }, workspaces: [{ label: 'alpha' }], runningWorkers: 0, handoffs: [] },
    quotas: [], serviceSettings: serviceSettingsView({}), harness: { findings: [] }, watchRoutines: [],
    herdr: { panes: [] }, quotaThresholds: { warnPercent: 90, criticalPercent: 98 },
    resourceLeases: { pools: [POOL, BUILT_IN], leases: [], errors: [] },
  };
}

async function page() {
  const app = await views();
  app.setModels({ codex: { defaultModel: 'a', defaultEffort: 'high', allowedEfforts: ['high'], allowedModels: ['a'] } });
  const s = fixture();
  app.setState(s);
  return { app, s };
}

test('the Settings page lists each pool with its ports, split, idle time, wait, and values by port', async () => {
  const { app, s } = await page();
  const html = app.settingsView(s);
  assert.match(html, /<h2>Resource pools<\/h2>/);
  assert.match(html, /data-pool-edit="serve-ports"/);
  assert.match(html, /data-pool-remove="serve-ports"/);
  assert.match(html, /data-pool-add/);
  // The ports text, the split, the idle time, the wait, the TTL, and the variable.
  assert.match(html, /8000-8004/);
  assert.match(html, /1 project</);
  assert.match(html, /Idle 30 min/);
  assert.match(html, /Wait 5 s/);
  assert.match(html, /120 min TTL/);
  assert.match(html, /HERDR_SERVE_PORT/);
  // The built-in pool has no edit or remove action.
  assert.match(html, /project-browsers/);
  assert.doesNotMatch(html, /data-pool-edit="project-browsers"/);
});

test('a client value never reaches the Settings page: the row shows set', async () => {
  const { app, s } = await page();
  for (const html of [app.settingsView(s), app.allocationView(s)]) {
    assert.ok(!html.includes(SECRET), 'the value is in the page');
    assert.ok(!/test-value/.test(html), 'part of the value is in the page');
  }
  assert.match(app.settingsView(s), /TM_PREVIEW_CLIENT_ID/);
  assert.match(app.settingsView(s), /class="pool-env-set">set</);
});

test('the Settings page shows the pool editor of the Allocation page for a pool that has a value', async () => {
  const { app, s } = await page();
  app.setPoolEditor(app.poolEditorState('update', POOL));
  const settings = app.settingsView(s);
  assert.match(settings, /data-resource-pool-form/);
  // Ports, split, idle minutes, wait seconds, and the client value row with its change action.
  assert.match(settings, /<textarea name="items"[^>]*>8000-8004<\/textarea>/);
  assert.match(settings, /<textarea name="split"/);
  assert.match(settings, /name="idleMinutes"[^>]*value="30"/);
  assert.match(settings, /name="waitSeconds"[^>]*value="5"/);
  assert.match(settings, /data-pool-env-change="0"/);
  assert.match(settings, /class="pool-env-set">set</);
  assert.doesNotMatch(settings, /type="password"[^>]*value="[^"]*test/);
  // The same editor function renders on the Allocation page.
  const form = (html) => /<form class="resource-pool-form"[\s\S]*?<\/form>/.exec(html)?.[0] || '';
  assert.equal(form(settings), form(app.allocationView(s)));
});

test('an empty value field clears a stored value and keeps it otherwise', async () => {
  const { app } = await page();
  const editor = app.poolEditorState('update', POOL);
  assert.equal(JSON.stringify(editor.portEnv), JSON.stringify([{ env: 'TM_PREVIEW_CLIENT_ID', ports: '8000-8004', set: true, changing: false, value: '' }]));
  assert.equal(editor.values.idleMinutes, 30);
  assert.equal(editor.values.waitSeconds, 5);
  assert.equal(editor.values.items, '8000-8004');
  // The value of a row is never copied from the pool into the editor.
  assert.ok(!JSON.stringify(editor).includes(SECRET), 'the value is in the editor state');
});

test('one pool row function serves both pages', () => {
  assert.equal([...source.matchAll(/function poolSettingsRow\(/g)].length, 1);
  assert.equal([...source.matchAll(/function poolSettingsPanel\(/g)].length, 1);
  assert.match(source, /function resourcePoolForm\(\)/);
});
