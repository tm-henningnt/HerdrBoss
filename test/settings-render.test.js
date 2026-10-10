import './helpers/test-env.js';
// The Settings and Allocation views render with a fixture state. No two info buttons of one section may explain the same setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { POLICY_DEFAULTS } from '../src/control.js';
import { serviceSettingsView, validateReleasesRepos, validateServiceSettings } from '../src/config.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const [imported, local] = name.split(/\s+as\s+/);
      context[local || imported] = imported === 'createClientStore'
        ? (options) => module[imported]({
          ...options,
          fetchImpl: context.fetch,
          EventSourceImpl: context.EventSource,
          setIntervalImpl: context.setInterval,
          clearIntervalImpl: context.clearInterval,
        })
        : module[imported];
    }
  }
  const body = code.replace(/^import [^\n]*\n/gm, '');
  vm.runInNewContext(`${body}\nthis.views = { settingsView, allocationView, agentsView, boardView, browsersView, browserBookmarkSection, chatBubble, projectsView, project, removePolicyProject, setShowParkedAllocation, setProjectPageMode: (v) => { projectPageMode = v; }, getProjectPageSelected: () => projectPageSelected, saveServiceSettings, setModels: (m) => { models = m; }, setState: (v) => { state = v; }, setDraft: (v) => { policyDraft = v; }, setProjectRegister: (v) => { projectRegisterData = v; }, setBrowserSessions: (v) => { browserSessions = v; }, getDraft: () => policyDraft };`, context);
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
    herdr: { panes: [], workspaces: [] },
    quotaThresholds: { warnPercent: 90, criticalPercent: 98 },
  };
}
const catalog = { defaultModel: 'a', defaultEffort: 'high', allowedEfforts: ['high'], allowedModels: ['a', 'b'] };

test('Allocation shows closed policy projects with editable settings and a registered state', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.projects.closed = { share: 20, mode: 'active', excludedKinds: ['codex'], excludedModels: ['a'] };
  s.policy.defaultOrchestratorGoal = '';
  s.policy.bossRules = '';
  s.projectRegisterSlugs = ['closed'];
  s.herdr = { panes: [], workspaces: [] };
  s.projects = [{ slug: 'closed', workspace: 'closed-workspace' }];
  s.control.workspaces = [];
  app.setState(s);

  const html = app.allocationView(s);
  const shareAt = html.indexOf('data-policy-share="closed"');
  const removeAt = html.indexOf('data-remove-policy-project="closed"');
  const rowStart = shareAt < 0 ? -1 : html.lastIndexOf('<div class="allocation-row', shareAt);
  const row = rowStart < 0 || removeAt < 0 ? '' : html.slice(rowStart, removeAt + 80);
  const includes = (label, pattern) => assert.ok(pattern.test(row), `The closed policy row is missing ${label}.`);
  includes('the closed state', /Closed workspace/);
  includes('the project lead state', /No project lead/);
  includes('the register state', /Registered in project register/);
  includes('the share input', /data-policy-share="closed"/);
  includes('the mode selector', /data-mode="closed"/);
  includes('the kind exclusion', /data-exclude-kind="closed:codex" checked/);
  includes('the model exclusion', /data-exclude-model="closed:a" checked/);
  includes('the remove action', /data-remove-policy-project="closed"[^>]*>Remove from policy/);
});

test('Allocation hides zero-share parked projects by default and exposes them with Show parked', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.projects['parked-zero'] = { share: 0, mode: 'auto', excludedKinds: [], excludedModels: [] };
  s.policy.projects['archived-zero'] = { share: 0, mode: 'auto', excludedKinds: [], excludedModels: [] };
  s.projectRegister = [
    { slug: 'parked-zero', title: 'Parked Zero', state: 'parked' },
    { slug: 'archived-zero', title: 'Archived Zero', state: 'archived' },
  ];
  app.setState(s);
  app.setShowParkedAllocation(false);

  const hidden = app.allocationView(s);
  assert.match(hidden, /Show parked/);
  assert.doesNotMatch(hidden, /data-stale-row="parked-zero"|data-stale-row="archived-zero"/);

  app.setShowParkedAllocation(true);
  const shown = app.allocationView(s);
  assert.match(shown, /data-stale-row="parked-zero"/);
  assert.match(shown, /data-stale-row="archived-zero"/);
});

test('Remove from policy confirms that project open restores the entry and deletes it immediately', async () => {
  const app = await views();
  const s = fixture();
  const prompts = [];
  const calls = [];
  app.context.window = { confirm: (text) => { prompts.push(text); return true; } };
  app.context.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({ ok: true, policy: { projects: { alpha: { share: 60 }, beta: { share: 40 } } } }) };
  };
  app.setState(s);
  app.setDraft(s.policy);

  await app.removePolicyProject('alpha');

  assert.match(prompts[0], /project open alpha/i);
  assert.deepEqual(calls.map(([url, options]) => [url, options.method]), [['/api/policy/projects/alpha', 'DELETE']]);
});

test('Projects restores the allocation bar, selectable open cards, project details, and a separate register view', async () => {
  const app = await views();
  const s = fixture();
  const alpha = {
    slug: 'alpha', title: 'Alpha Project', group: 'Platform', clientTag: 'Example Client', state: 'open', share: 50,
    pinned: false, priority: 'high', nextAction: 'Review work', lastActivityAt: '2026-10-09T12:00:00.000Z',
    issueSource: { repo: 'sample/alpha', label: 'ready-for-agent' }, autoOpen: 'off',
  };
  s.projectRegister = [alpha, { slug: 'parked', title: 'Parked Project', state: 'parked', share: 0 }];
  s.policy.projects.alpha = { share: 50, mode: 'active', excludedKinds: [], excludedModels: [] };
  s.locks = [
    { name: 'full-suite', scope: 'machine', state: 'live', project: 'alpha', ownerPane: 'sample:orch', kind: 'test', queue: [] },
    { name: 'network', scope: 'machine', state: 'live', project: 'beta', ownerPane: 'sample:other', kind: 'test', queue: [] },
  ];
  s.projects = [{ slug: 'alpha', project: 'Alpha Project', status: 'active', summary: 'Current sample status', updated: '2026-10-09T12:00:00.000Z', tasks: [{ id: 'PJ1-1', title: 'Sample status task', status: 'doing' }] }];
  app.setState(s);
  app.setProjectRegister({ projects: s.projectRegister, readOnly: false, openCount: 1, cap: 3 });

  const cards = app.projectsView(s, null);
  assert.match(cards, /class="allocation-summary"/);
  assert.ok(cards.indexOf('class="allocation-summary"') < cards.indexOf('aria-label="Projects view"'));
  assert.match(cards, /<button[^>]*data-project-card="alpha"/);
  assert.match(cards, /state-open/);
  assert.match(cards, /Platform/);
  assert.match(cards, /Example Client/);
  assert.match(cards, /50% share/);
  assert.match(cards, /Current sample status/);
  assert.match(cards, /Register and issue triage/);
  assert.match(cards, /Policy/);
  assert.match(cards, /<dt>Mode<\/dt><dd>active<\/dd>/);
  assert.match(cards, /Locks/);
  assert.match(cards, /full-suite/);
  assert.match(cards, /Sample status task/);
  assert.doesNotMatch(cards, /data-project-card="parked"/);
  assert.doesNotMatch(cards, /data-segment="parked"/);
  assert.match(cards, /sample\/alpha/);
  assert.match(cards, /data-projects-mode="register"/);

  app.context.location.pathname = '/projects';
  const documentStub = app.context.document;
  app.context.document = new Proxy(documentStub, { get: (target, key) => key === 'activeElement' ? { matches: () => false, closest: () => null } : target[key] });
  const card = { dataset: { projectCard: 'beta' } };
  const cardClick = app.context.handlers.get('click').find((handler) => handler.toString().includes('[data-project-card]'));
  cardClick({ target: { closest: (selector) => selector === '[data-projects-mode]' ? null : card } });
  assert.equal(app.getProjectPageSelected(), 'beta');

  app.setProjectPageMode('register');
  const register = app.projectsView(s, null);
  assert.match(register, /class="allocation-summary"/);
  assert.ok(register.indexOf('class="allocation-summary"') < register.indexOf('aria-label="Project register"'));
  assert.match(register, /aria-label="Project register"/);
  assert.match(register, /Parked Project/);
});

test('large bookmark collections are collapsed, counted, and filterable per project', async () => {
  const app = await views();
  const bookmarks = Array.from({ length: 250 }, (_, index) => ({ name: `Sample bookmark ${index + 1}`, url: `https://preview.example/${index + 1}` }));
  const details = app.browserBookmarkSection('tm-stacked-variance', { bookmarks, startPage: null });
  const contains = (label, pattern) => assert.ok(pattern.test(details), `The bookmark dropdown is missing ${label}.`);
  assert.ok(/^<details class="browser-bookmarks"[^>]*>/.test(details) && !/^<details[^>]*\bopen\b/.test(details), 'The bookmark dropdown must start closed.');
  contains('the count badge', /browser-bookmark-count/);
  contains('the total count', /<summary>Bookmarks <span[^>]*>250<\/span><\/summary>/);
  contains('the filter field', /type="search"[^>]*data-browser-bookmark-filter="tm-stacked-variance"/);
  contains('the current-tab action', /data-browser-bookmark-open="tm-stacked-variance"/);
  contains('the new-tab action', /data-browser-bookmark-open-tab="tm-stacked-variance"/);
  assert.match(source, /\$\{browserBookmarkSection\(p\.slug, b\)\}/);
  assert.match(fs.readFileSync(new URL('../docs/help/browsers.md', import.meta.url), 'utf8'), /Filter bookmarks\*\* to find a name or address/);
  assert.match(source, /data-browser-bookmark-filter/);
  assert.match(source, /browser-bookmark-result/);
});

test('Settings renders editable roots and saves paths as strings', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const html = app.settingsView(fixture());
  for (const setting of ['worktreeRoot', 'projectRoot']) assert.match(html, new RegExp(`type="text"[^>]*data-service-setting="${setting}"[^>]*data-service-group="Paths"`));
  assert.match(html, /data-save-service-settings="Paths"/);
  let sent;
  app.context.document = {
    querySelectorAll: () => [
      { type: 'text', dataset: { serviceSetting: 'worktreeRoot' }, value: '/tmp/worker trees' },
      { type: 'text', dataset: { serviceSetting: 'projectRoot' }, value: '~/projects' },
    ],
    querySelector: () => ({ textContent: '' }),
  };
  app.context.fetch = async (_url, request) => { sent = JSON.parse(request.body); return { ok: true, json: async () => ({ settings: [] }) }; };
  const button = { disabled: false };
  await app.saveServiceSettings('Paths', button);
  assert.deepEqual(sent.changes, { worktreeRoot: '/tmp/worker trees', projectRoot: '~/projects' });
  assert.equal(button.disabled, false);
});

test('Settings header shows the running commit, kit revision, and start time', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.version = { commit: 'abc1234', commitDate: '2026-10-10', kitRevision: 'd5a92aea96a1', startedAt: '2026-10-10T08:30:00.000Z' };
  const html = app.settingsView(s);
  assert.match(html, /data-service-version/);
  assert.match(html, /commit abc1234, 2026-10-10/);
  assert.match(html, /kit d5a92aea96a1/);
  assert.match(html, /started \d{2}:\d{2}/);
  assert.match(css, /\.page-intro \.settings-version \{ overflow-wrap: anywhere;/);
});

test('Settings renders and saves the collect-time worktree pruning switch', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  const setting = s.serviceSettings.find((item) => item.setting === 'worktrees.pruneAtCollect');
  assert.deepEqual(setting && { value: setting.value, source: setting.source }, { value: true, source: 'default' });
  const html = app.settingsView(s);
  assert.match(html, /type="checkbox" data-service-setting="worktrees\.pruneAtCollect" data-service-group="Workers" aria-label="worktrees\.pruneAtCollect" checked/);
  assert.equal((html.match(/data-setting-help="worktrees\.pruneAtCollect"/g) || []).length, 1);

  const toggle = { type: 'checkbox', dataset: { serviceSetting: 'worktrees.pruneAtCollect' }, checked: false };
  app.context.document = {
    querySelectorAll: () => [toggle],
    querySelector: () => ({ textContent: '' }),
  };
  let sent;
  app.context.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, json: async () => ({ settings: [] }) };
  };
  await app.saveServiceSettings('Workers', { disabled: false });
  assert.deepEqual(sent.changes, { 'worktrees.pruneAtCollect': false });
  assert.deepEqual(validateServiceSettings({ 'worktrees.pruneAtCollect': true }), { 'worktrees.pruneAtCollect': true });
  assert.throws(() => validateServiceSettings({ 'worktrees.pruneAtCollect': 'false' }), /must be true or false/);
});

test('Settings renders and saves the visible project browser switch, off by default', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  const setting = s.serviceSettings.find((item) => item.setting === 'browser.allowVisible');
  assert.deepEqual(setting && { value: setting.value, source: setting.source }, { value: false, source: 'default' });
  const html = app.settingsView(s);
  assert.match(html, /type="checkbox" data-service-setting="browser\.allowVisible" data-service-group="Browsers" aria-label="browser\.allowVisible"/);
  assert.equal((html.match(/data-setting-help="browser\.allowVisible"/g) || []).length, 1);

  const toggle = { type: 'checkbox', dataset: { serviceSetting: 'browser.allowVisible' }, checked: true };
  app.context.document = {
    querySelectorAll: () => [toggle],
    querySelector: () => ({ textContent: '' }),
  };
  let sent;
  app.context.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, json: async () => ({ settings: [] }) };
  };
  await app.saveServiceSettings('Browsers', { disabled: false });
  assert.deepEqual(sent.changes, { 'browser.allowVisible': true });
  assert.deepEqual(validateServiceSettings({ 'browser.allowVisible': true }), { 'browser.allowVisible': true });
  assert.throws(() => validateServiceSettings({ 'browser.allowVisible': 'true' }), /must be true or false/);
});

test('Settings renders and saves the tenant host display switch, off by default', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  const setting = s.serviceSettings.find((item) => item.setting === 'browser.showTenantHosts');
  assert.deepEqual(setting && { value: setting.value, source: setting.source }, { value: false, source: 'default' });
  const html = app.settingsView(s);
  assert.match(html, /type="checkbox" data-service-setting="browser\.showTenantHosts" data-service-group="Browsers" aria-label="browser\.showTenantHosts"/);
  assert.equal((html.match(/data-setting-help="browser\.showTenantHosts"/g) || []).length, 1);

  const toggle = { type: 'checkbox', dataset: { serviceSetting: 'browser.showTenantHosts' }, checked: true };
  app.context.document = {
    querySelectorAll: () => [toggle],
    querySelector: () => ({ textContent: '' }),
  };
  let sent;
  app.context.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, json: async () => ({ settings: [] }) };
  };
  await app.saveServiceSettings('Browsers', { disabled: false });
  assert.deepEqual(sent.changes, { 'browser.showTenantHosts': true });
  assert.deepEqual(validateServiceSettings({ 'browser.showTenantHosts': true }), { 'browser.showTenantHosts': true });
  assert.throws(() => validateServiceSettings({ 'browser.showTenantHosts': 'true' }), /must be true or false/);
});

test('Settings renders the project cap and triage controls in their own group', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const html = app.settingsView(fixture());
  assert.match(html, /data-service-setting="register\.cap" data-service-group="Project register"/);
  assert.match(html, /data-service-setting="register\.capCountsPinned" data-service-group="Project register"/);
  assert.match(html, /data-service-setting="register\.autoParkHours" data-service-group="Project register"/);
  assert.match(html, /data-service-setting="register\.triage\.enabled" data-service-group="Project register"/);
  assert.match(html, /data-service-setting="register\.triage\.label" data-service-group="Project register"/);
  assert.match(html, /data-service-setting="register\.triage\.pollMinutes" data-service-group="Project register"/);
  for (const setting of ['register.cap', 'register.capCountsPinned', 'register.autoParkHours', 'register.triage.enabled', 'register.triage.label', 'register.triage.pollMinutes']) {
    assert.equal(html.split(`data-setting-help="${setting}"`).length - 1, 1);
  }
  assert.match(html, /data-save-service-settings="Project register"/);

  const inputs = [
    { type: 'number', dataset: { serviceSetting: 'register.cap' }, value: '3' },
    { type: 'checkbox', dataset: { serviceSetting: 'register.capCountsPinned' }, checked: false },
    { type: 'number', dataset: { serviceSetting: 'register.autoParkHours' }, value: '24' },
    { type: 'checkbox', dataset: { serviceSetting: 'register.triage.enabled' }, checked: true },
    { type: 'text', dataset: { serviceSetting: 'register.triage.label' }, value: 'ready-for-agent' },
    { type: 'number', dataset: { serviceSetting: 'register.triage.pollMinutes' }, value: '30' },
  ];
  app.context.document = {
    querySelectorAll: () => inputs,
    querySelector: () => ({ textContent: '' }),
  };
  let sent;
  app.context.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, json: async () => ({ settings: [] }) };
  };
  await app.saveServiceSettings('Project register', { disabled: false });
  assert.deepEqual(sent.changes, {
    'register.cap': 3,
    'register.capCountsPinned': false,
    'register.autoParkHours': 24,
    'register.triage.enabled': true,
    'register.triage.label': 'ready-for-agent',
    'register.triage.pollMinutes': 30,
  });
});

test('Settings renders the Haiku pace tolerance beside the general pace tolerance', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const state = fixture();
  app.setState(state);
  app.setDraft(state.policy);
  const html = app.settingsView(state);
  const general = html.indexOf('data-policy-number="paceTolerancePoints"');
  const haiku = html.indexOf('data-policy-number="paceHaikuTolerancePoints"');
  assert.ok(general >= 0, 'the general pace tolerance is visible');
  assert.ok(haiku > general, 'the Haiku tolerance follows the general tolerance');
  assert.ok(html.includes('<input id="sf-paceHaikuTolerancePoints" type="number" min="0" max="100" step="1" value="15" data-policy-number="paceHaikuTolerancePoints">'), 'the Haiku tolerance has its default and range');
  assert.equal((html.match(/data-setting-help="paceHaikuTolerancePoints"/g) || []).length, 1);
  const change = app.context.handlers.get('input').find((handler) => handler.toString().includes('el.dataset.policyNumber'));
  assert.ok(change, 'the generic policy number input handler is registered');
  change({ target: { dataset: { policyNumber: 'paceHaikuTolerancePoints' }, value: '22', closest: () => ({}) } });
  assert.equal(state.policy.paceHaikuTolerancePoints, 22, 'the input updates the saved policy draft');
});

test('Settings shows and saves release repository rows with demo app policy', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const repos = [{ name: 'example-org/example-app', project: 'example', kind: 'qlik-extension', requireDemoApp: true }];
  const s = fixture();
  s.serviceSettings = serviceSettingsView({ releases: { repos } });
  const html = app.settingsView(s);
  assert.equal((html.match(/data-setting-help="releases\.repos"/g) || []).length, 1, 'the row has one setting help button');
  assert.doesNotMatch(html, /<p class="setting-help"><strong>Allowed release repositories<\/strong><\/p>/);
  assert.doesNotMatch(html, /Only listed repositories can use release request/);
  assert.match(html, /data-release-repo-add/);
  assert.match(html, /data-release-repo-remove/);
  for (const field of ['name', 'project', 'kind', 'requireDemoApp']) assert.match(html, new RegExp(`data-release-repo-field="${field}"`));
  assert.match(html, /Require separate demo app/);
  assert.match(html, /data-save-service-settings="Releases"/);
  const defaultQlikHtml = app.settingsView({ ...s, serviceSettings: serviceSettingsView({ releases: { repos: [{ name: 'example-org/extension', project: 'extension', kind: 'qlik-extension' }] } }) });
  assert.match(defaultQlikHtml, /<input type="checkbox" checked data-release-repo-index="0" data-release-repo-field="requireDemoApp"/);
  assert.doesNotMatch(defaultQlikHtml, /<input type="checkbox"[^>]*disabled[^>]*data-release-repo-field="requireDemoApp"/);
  const genericHtml = app.settingsView({ ...s, serviceSettings: serviceSettingsView({ releases: { repos: [{ name: 'example-org/app', project: 'app', kind: 'app' }] } }) });
  assert.match(genericHtml, /<input type="checkbox"[^>]*disabled[^>]*data-release-repo-field="requireDemoApp"/);

  const empty = app.settingsView({ ...s, serviceSettings: serviceSettingsView({ releases: { repos: [] } }) });
  assert.match(empty, /data-release-repo-empty[^>]*>No repositories are allowed\.<\/p>/);
  assert.equal((empty.match(/data-setting-help="releases\.repos"/g) || []).length, 1, 'the empty list still has one setting help button');
  assert.doesNotMatch(empty, /Only listed repositories can use release request/);

  const inputs = [
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'name' }, value: 'example-org/example-app' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'project' }, value: 'example' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'kind' }, value: 'qlik-extension' },
    { type: 'checkbox', checked: true, dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'requireDemoApp' } },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'name' }, value: 'example-org/optional' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'project' }, value: 'optional' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'kind' }, value: 'qlik-extension' },
    { type: 'checkbox', checked: false, dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'requireDemoApp' } },
  ];
  app.context.document = {
    querySelectorAll: (selector) => selector.includes('data-release-repo-field') ? inputs : [
      { type: 'hidden', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases' }, value: '' },
    ],
    querySelector: () => ({ textContent: '' }),
  };
  let sent;
  app.context.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, json: async () => ({ settings: [{ group: 'Releases', setting: 'releases.repos', value: repos, source: 'config' }] }) };
  };
  const button = { disabled: false };
  await app.saveServiceSettings('Releases', button);
  assert.deepEqual(sent.changes, { 'releases.repos': [repos[0], { name: 'example-org/optional', project: 'optional', kind: 'qlik-extension', requireDemoApp: false }] });
  assert.equal(button.disabled, false);
});

test('release repository validation defaults demo apps only for Qlik extensions', () => {
  assert.deepEqual(validateReleasesRepos([
    { name: 'example-org/extension', project: 'extension', kind: 'qlik-extension' },
    { name: 'example-org/app', project: 'app', kind: 'app' },
    { name: 'example-org/optional', project: 'optional', kind: 'qlik-extension', requireDemoApp: false },
  ]), {
    repos: [
      { name: 'example-org/extension', project: 'extension', kind: 'qlik-extension', requireDemoApp: true },
      { name: 'example-org/app', project: 'app', kind: 'app', requireDemoApp: false },
      { name: 'example-org/optional', project: 'optional', kind: 'qlik-extension', requireDemoApp: false },
    ],
    errors: [],
  });
  assert.throws(() => validateServiceSettings({ 'releases.repos': [{ name: 'example-org/extension', project: 'extension', kind: 'qlik-extension', requireDemoApp: 'yes' }] }), /requireDemoApp must be true or false/);
  assert.throws(() => validateServiceSettings({ 'releases.repos': [{ name: 'example-org/app', project: 'app', kind: 'app', requireDemoApp: true }] }), /only available for qlik-extension repositories/);
});

test('Owner Chat renders a release report as an Approve and Reject card', async () => {
  const app = await views();
  app.context.safeMarkdownHtml = (source) => `<p>${source}</p>`;
  const html = app.chatBubble({
    id: 'release-approval-1', thread: 'example', from: 'orch', to: 'owner', kind: 'report', channel: 'mail',
    action: 'approve', title: 'Release approval: example-org/example-app v1.0.0',
    text: '# Release approval request\n\nRepository: example-org/example-app\nTag: v1.0.0\n\n## Effect\nApprove makes the release public.',
    release: { repo: 'example-org/example-app', tag: 'v1.0.0' }, at: '2026-10-07T10:00:00Z',
  });
  assert.match(html, /chat-card/);
  assert.match(html, /Repository: example-org\/example-app/);
  assert.match(html, /data-chat-value="Approved\."[^>]*>Approve<\/button>/);
  assert.match(html, /data-chat-value="Rejected\."[^>]*>Reject<\/button>/);
  assert.match(html, /Open in Mailbox/);
});

test('each provider quota row names the source and the age of its reading', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const fresh = fixture();
  fresh.quotas = [{ provider: 'codex', source: 'app-server', observedAt: new Date().toISOString(), windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '2026-10-20T00:00:00.000Z' }] }];
  assert.match(app.settingsView(fresh), /source app-server · reading .* ago/);
  const unknown = fixture();
  unknown.quotas = [{ provider: 'codex', source: 'local', unavailable: true, reason: 'no login for this harness in this factory' }];
  assert.match(app.settingsView(unknown), /source local · no login for this harness in this factory/);
});

test('Quota plan settings render editable values with decimal steps and save as numbers or text', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const html = app.settingsView(fixture());
  assert.match(html, /<span>Usage limit plan<\/span>/);
  assert.match(html, /min="0\.1" max="10" step="0\.1" value="1"[^>]*data-service-setting="quotaPlan\.burstPace"[^>]*data-service-group="Quota plan"/);
  assert.match(html, /min="0" max="50" step="0\.1" value="1"[^>]*data-service-setting="quotaPlan\.holdMargin"[^>]*data-service-group="Quota plan"/);
  assert.match(html, /type="text"[^>]*value="last-expiry" placeholder="last-expiry or an ISO time"[^>]*data-service-setting="quotaPlan\.horizon"[^>]*data-service-group="Quota plan"/);
  assert.match(html, /data-save-service-settings="Quota plan"/);
  assert.match(html, /<select data-service-setting="quotaPlan\.planMode" data-service-group="Quota plan"[^>]*><option value="paced" selected>[^<]*<\/option><option value="burst">[^<]*<\/option><\/select>/);
  let sent;
  app.context.document = {
    querySelectorAll: () => [
      { type: 'number', dataset: { serviceSetting: 'quotaPlan.burstPace' }, value: '1.5' },
      { type: 'number', dataset: { serviceSetting: 'quotaPlan.applyThreshold' }, value: '95' },
      { type: 'text', dataset: { serviceSetting: 'quotaPlan.horizon' }, value: 'last-expiry' },
      { type: 'select-one', dataset: { serviceSetting: 'quotaPlan.planMode' }, value: 'burst' },
    ],
    querySelector: () => ({ textContent: '' }),
  };
  app.context.fetch = async (_url, request) => { sent = JSON.parse(request.body); return { ok: true, json: async () => ({ settings: [] }) }; };
  await app.saveServiceSettings('Quota plan', { disabled: false });
  assert.deepEqual(sent.changes, { 'quotaPlan.burstPace': 1.5, 'quotaPlan.applyThreshold': 95, 'quotaPlan.horizon': 'last-expiry', 'quotaPlan.planMode': 'burst' });
});

test('a Quota save shows the value that the server stored and notes a difference from the typed value', async () => {
  const app = await views();
  const inputs = [
    { type: 'number', dataset: { serviceSetting: 'quota.warnPercent' }, value: '90' },
    { type: 'number', dataset: { serviceSetting: 'quota.criticalPercent' }, value: '100' },
  ];
  const status = { textContent: '' };
  app.context.document = { querySelectorAll: () => inputs, querySelector: () => status };
  // The server answers with the stored values. The critical level differs from the typed value.
  app.context.fetch = async () => ({ ok: true, json: async () => ({ settings: [
    { group: 'Quota', setting: 'quota.warnPercent', value: 90, source: 'config' },
    { group: 'Quota', setting: 'quota.criticalPercent', value: 98, source: 'default' },
  ] }) });
  await app.saveServiceSettings('Quota', { disabled: false });
  assert.equal(inputs[0].value, '90');
  assert.equal(inputs[1].value, '98', 'the field shows the stored value');
  assert.match(status.textContent, /quota\.criticalPercent is stored as 98\. You typed 100\./);
  assert.doesNotMatch(status.textContent, /quota\.warnPercent/);

  // A stored value equal to the typed value gives the plain message.
  inputs[1].value = '100';
  app.context.fetch = async () => ({ ok: true, json: async () => ({ settings: [
    { group: 'Quota', setting: 'quota.warnPercent', value: 90, source: 'config' },
    { group: 'Quota', setting: 'quota.criticalPercent', value: 100, source: 'config' },
  ] }) });
  await app.saveServiceSettings('Quota', { disabled: false });
  assert.equal(inputs[1].value, '100');
  assert.equal(status.textContent, 'Saved.');
});

test('a rejected Quota save shows the server error and keeps the typed value', async () => {
  const app = await views();
  const inputs = [{ type: 'number', dataset: { serviceSetting: 'quota.criticalPercent' }, value: '101' }];
  const status = { textContent: '' };
  app.context.document = { querySelectorAll: () => inputs, querySelector: () => status };
  app.context.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'quota.criticalPercent must be a whole number from 51 to 100.' }) });
  await app.saveServiceSettings('Quota', { disabled: false });
  assert.match(status.textContent, /from 51 to 100/);
  assert.equal(inputs[0].value, '101');
});

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

function committedPage(t, code) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-settings-render-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'public'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'public', 'app.js'), code);
  git('add', 'public/app.js');
  git('commit', '-q', '-m', 'Legacy page fixture');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  return git('show', 'HEAD:public/app.js');
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
  const settings = app.settingsView(s);
  assert.match(settings, /<span>Analytics<\/span>/);
  assert.match(settings, /<code>analytics\.actionsMinutes<\/code>/);
  assert.match(settings, /type="checkbox"[^>]*data-service-setting="analytics\.actionsMinutes"/);
});

test('Allocation shows the default-off automatic Claude goal command switch', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  assert.match(html, /Automatic Claude goal command/);
  const input = html.match(/<input id="sf-goals-autoCommand"[^>]*>/)?.[0];
  assert.ok(input, 'the nested policy switch renders');
  assert.doesNotMatch(input, /\bchecked\b/, 'the default is off');
  assert.match(input, /data-policy-goal-bool="autoCommand"/);
  assert.match(html, /data-setting-help="goals\.autoCommand"/);

  const change = app.context.handlers.get('change').find((handler) => handler.toString().includes('policyGoalBool'));
  assert.ok(change, 'the policy change handler is registered');
  change({ target: { dataset: { policyGoalBool: 'autoCommand' }, checked: true, closest: () => true } });
  assert.equal(s.policy.goals.autoCommand, true, 'the switch updates the nested policy draft');
});

test('Allocation shows effort choices only for models with an effort setting', async () => {
  const app = await views();
  app.setModels({
    codex: catalog,
    claude: {
      defaultModel: 'claude-sonnet-5-5', defaultEffort: null, allowedEfforts: [],
      allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
      modelEfforts: { 'claude-haiku-5-5': { allowedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' } },
    },
  });
  const s = fixture();
  s.policy.orchestratorLadder = [
    { kind: 'claude', model: 'claude-haiku-5-5', effort: 'medium' },
    { kind: 'claude', model: 'claude-sonnet-5-5', effort: null },
  ];
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  assert.match(html, /<select data-ladder-effort="0"[^>]*>[\s\S]*<option value="medium" selected>medium<\/option>/);
  assert.doesNotMatch(html, /data-ladder-effort="1"/);
  assert.match(html, /No effort setting/);
});

test('Allocation long policy text uses growing three-row textareas without changing draft values', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.defaultOrchestratorGoal = 'Keep the approved goal text.';
  s.policy.bossRules = 'Keep the standing rules text.';
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  for (const [id, label, key, value, maxLength] of [
    ['sf-defaultOrchestratorGoal', 'Default project lead goal', 'defaultOrchestratorGoal', s.policy.defaultOrchestratorGoal, 4000],
    ['sf-bossRules', 'Boss rules', 'bossRules', s.policy.bossRules, 1200],
  ]) {
    const at = html.indexOf(`<textarea id="${id}"`);
    assert.ok(at > 0, `${label} renders its textarea`);
    const start = html.lastIndexOf('<label', at);
    const row = html.slice(start, html.indexOf('</label>', at));
    assert.ok(row.includes(`>${label}<button`), `${label} renders a setting row`);
    assert.match(row, /\bgoal-setting\b/, `${label} keeps its setting-row class`);
    assert.match(row, new RegExp(`<textarea id="${id}" rows="3" maxlength="${maxLength}" data-grow-textarea data-policy-text="${key}">${value}<\\/textarea>`), `${label} keeps its value, length limit, and policy draft key`);
  }
  assert.match(css, /\.setting-line\.goal-setting textarea\s*\{[^}]*min-height:/);
  assert.match(css, /\.setting-line\.goal-setting textarea\s*\{[^}]*width:\s*100%/);
  const goalTextareaCss = /\.setting-line\.goal-setting textarea\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(goalTextareaCss, /field-sizing:\s*content/);
  assert.match(goalTextareaCss, /min-height:\s*calc\(\s*3\s*\*\s*1\.4em\s*\+\s*12px\s*\)/);
  assert.match(goalTextareaCss, /max-height:\s*50vh/);
  assert.match(goalTextareaCss, /overflow-y:\s*auto/);
  assert.match(source, /for \(const field of \$app\.querySelectorAll\('textarea\[data-grow-textarea\]'\)\) fitTextarea\(field\);/, 'each Allocation render fits saved textarea content');
  const change = app.context.handlers.get('input').find((handler) => handler.toString().includes('el.dataset.policyText'));
  const textarea = { dataset: { growTextarea: '', policyText: 'bossRules' }, value: 'Updated standing rules.', style: {}, scrollHeight: 70, closest: () => ({}) };
  change({ target: textarea });
  assert.equal(app.getDraft().bossRules, textarea.value, 'the textarea updates the same saved draft value');
  assert.equal(textarea.style.height, '72px', 'typing grows the textarea to fit its content');
});

test('Allocation phone controls show long numbers and give goal textareas a full row', () => {
  assert.match(css, /\.setting-line input\[type="number"\]\s*\{[^}]*width:\s*10ch/);
  assert.match(css, /\.setting-line\.goal-setting\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.setting-line\.goal-setting textarea\s*\{[^}]*width:\s*100%/);
});

test('the Allocation bar includes saved shares from projects without a live lead', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.projects.alpha.share = 42;
  s.policy.projects.beta.share = 42;
  s.policy.projects.closed = { share: 16, mode: 'auto', excludedKinds: [], excludedModels: [] };
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  assert.match(html, /data-stale-segment="closed"[^>]*style="width:16%/);
});

test('each project lead succession select keeps its accessible label', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.orchestratorLadder = [{ kind: 'codex', model: 'a', effort: 'high' }];
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  const kindSelect = /<select[^>]*data-ladder-kind="0"[^>]*>/g.exec(html)?.[0] || '';
  assert.match(kindSelect, /aria-label="Choice 1 harness"/);
});

test('Settings wraps model names only at separators and keeps the usage mode choice readable', async () => {
  const app = await views();
  app.setModels({
    opencode: { ...catalog, allowedModels: ['very-long-provider-name/model-name-with-parts'] },
    claude: { ...catalog, allowedModels: ['claude-sonnet-5-5'] },
  });
  const s = fixture();
  s.policy.allowedKinds = ['opencode'];
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.settingsView(s);
  const modelLabel = /data-harness-model="opencode"[^>]*> <span>(.*?)<\/span>/.exec(html)?.[1] || '';
  assert.equal(modelLabel.replaceAll('<wbr>', ''), 'very-long-provider-name/model-name-with-parts');
  assert.equal([...modelLabel.matchAll(/<wbr>/g)].length, (modelLabel.match(/[/-]/g) || []).length);
  const versionLabel = /data-harness-model="claude"[^>]*> <span>([\s\S]*?)<\/span><\/label>/.exec(html)?.[1] || '';
  assert.match(versionLabel, /<span class="model-version">5-5<\/span>/, 'version hyphens stay in one copyable token');
  assert.equal(versionLabel.replace(/<[^>]*>/g, ''), 'claude-sonnet-5-5', 'model text keeps its original characters');
  assert.match(html, /class="setting-line preferred-model-setting"/);
  assert.match(css, /\.harness-model label > span:first-of-type\s*\{[^}]*overflow-wrap:\s*normal/);
  assert.match(css, /select\[data-provider\]\s*\{[^}]*min-width:\s*190px/);
  assert.match(css, /\.harness \.setting-line\.preferred-model-setting\s*\{[^}]*flex-direction:\s*column/);
  const harnessSelectCss = /\.harness \.setting-line select\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(harnessSelectCss, /width:\s*100%/);
  assert.match(harnessSelectCss, /max-width:\s*100%/);
  assert.match(harnessSelectCss, /min-width:\s*0/);
  assert.match(harnessSelectCss, /box-sizing:\s*border-box/);
  assert.match(harnessSelectCss, /text-overflow:\s*ellipsis/);
  assert.match(css, /\.model-version\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.advanced-settings \.settings-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Settings gives the four policy cards a full-width row and keeps provider source text readable', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.settingsView(s);
  const coreStart = html.indexOf('<div class="settings-grid settings-core-grid">');
  const extraStart = html.indexOf('<div class="settings-grid settings-extra-grid">');
  assert.ok(coreStart >= 0 && extraStart > coreStart, 'the four main settings cards share their own full-width grid');
  for (const title of ['Provider usage limits', 'Machine', 'Locks', 'Pictures and agent messages']) {
    const at = html.indexOf(`<h2>${title}</h2>`, coreStart);
    assert.ok(at > coreStart && at < extraStart, `${title} stays in the full-width card row`);
  }
  assert.match(html, /class="setting-line provider-mode-setting"/);
  assert.match(css, /\.settings-grid\.settings-core-grid\s*\{[^}]*width:\s*100%/);
  assert.match(css, /@media \(min-width: 1600px\)\s*\{\s*\.settings-grid\.settings-core-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.setting-line\.provider-mode-setting\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.setting-line\.provider-mode-setting > select\[data-provider\] \+ \.setting-help\s*\{[^}]*flex:\s*1 1 100%/);
});

// The old page gave repeated settings a per-row key.
test('the check fails when the page gives every help button a per-row key', async (t) => {
  const oldKey = 'const key = instance ? `${id}#${instance}` : id;';
  const legacy = source.replace(oldKey, 'const key = `${id}#${instance || "row"}`;');
  assert.notEqual(legacy, source, 'the legacy help-key rule is present');
  const previous = committedPage(t, legacy);
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
    {
      name: 'network', class: 'network', scope: 'machine', state: 'live', lane: 'network', slot: 1, kind: 'suite',
      ownerPane: 'ws:network-holder', project: 'delta', ageSeconds: 12, slotsInUse: 1, slotLimit: 2, configuredSlotLimit: 2,
      queue: [{ id: 'network-ticket', class: 'network', position: 1, lane: 'network', project: 'epsilon', pane: 'ws:network-waiter', kind: 'suite', waitSeconds: 9, slotsInUse: 1, slotLimit: 2 }],
    },
  ];
  s.lockStats = { acquires: 3, windowDays: 7, medianWaitMs: 2000, medianHoldMs: 60000, byLane: { long: { acquires: 2 }, short: { acquires: 1 }, network: { acquires: 1 } }, byName: { network: { medianHoldMs: 12000, medianWaitMs: 9000 } } };
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
  assert.match(html, /data-lock-class="network"/);
  assert.match(html, /Network class <span>1 \/ 2 slots/);
  assert.match(html, /ws:network-holder/);
  assert.match(html, /ws:network-waiter/);
  assert.match(html, /network: hold 12s, wait 9s/);
  assert.match(html, /guard on/i);
});

test('the network queue renders from the engine field without a network holder record', async () => {
  const app = await views();
  const s = fixture();
  s.locks = [];
  s.networkLockQueue = [{ id: 'orphaned-network-ticket', class: 'network', position: 1, lane: 'network', project: 'epsilon', pane: 'ws:network-waiter', kind: 'suite', waitSeconds: 9 }];
  const html = app.agentsView(s);
  assert.match(html, /Network class <span>0 \/ 2 slots/);
  assert.match(html, /No holder/);
  assert.match(html, /1\. epsilon · ws:network-waiter \(suite\)/);
  assert.match(html, /<ol class="machine-lock-lane-list machine-lock-queue-list">/);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.machine-lock-queue-list\s*\{\s*list-style:\s*none;/);
});

test('the Settings page renders all lock lane policy controls with setting help ids', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /<h2>Locks<\/h2>/);
  assert.match(html, /data-policy-lock-network="slots"/);
  assert.match(html, /Network lock slots/);
  assert.match(html, /max="8"/);
  assert.match(html, /data-policy-lock="slots"/);
  assert.match(html, /data-policy-lock="shortLimitMinutes"/);
  assert.match(html, /data-policy-lock="watchdogMultiplier"/);
  assert.match(html, /data-policy-lock="watchdogCpuPercent"/);
  assert.match(html, /checks each full-suite holder/);
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

test('the lock panel shows the lane guard wait reason on a queued short job', async () => {
  const app = await views();
  const s = fixture();
  const reason = 'waits: lane guard, 5-minute load 245% exceeds 231%';
  s.locks = [{ name: 'full-suite', scope: 'machine', state: 'live', lane: 'long', slot: 'long', kind: 'suite',
    ownerPane: 'ws:long', project: 'alpha', ageSeconds: 60, slotsInUse: 1, slotLimit: 2,
    configuredSlotLimit: 2, admissionMode: 'lanes', predictedMs: null,
    queue: [{ id: 'q1', position: 1, lane: 'short', project: 'beta', pane: 'ws:wait', kind: 'suite', waitSeconds: 12, predictedMs: 60000, waitReason: reason }],
  }];
  app.setState(s);
  for (const render of [app.agentsView, app.allocationView]) {
    const html = render(s);
    assert.equal(html.split(reason).length - 1, 2, 'the lane card and the lock table row show the reason');
  }
});

test('picture retention renders its saved value, help and a working policy editor', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture(); s.policy.attachments = { retentionDays: 45 }; app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /<h2>Pictures and agent messages<\/h2>/);
  assert.match(html, /data-policy-attachment="retentionDays"/);
  assert.match(html, /data-setting-help="attachments.retentionDays"/);
  assert.match(html, /min="1" max="365"[^>]*value="45"/);
  const input = { closest: () => ({}), dataset: { policyAttachment: 'retentionDays' }, value: '60', id: 'setting-attachment', setCustomValidity() {}, setAttribute() {}, removeAttribute() {} };
  const event = { target: input };
  app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyAttachment'))(event);
  assert.equal(app.getDraft().attachments.retentionDays, 60);
});

test('agent message retention renders and edits separate text and metadata periods', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  s.policy.agentMessages = { retentionDays: 30, metaRetentionDays: 365 };
  app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /data-policy-agent-message="retentionDays"/);
  assert.match(html, /data-setting-help="agentMessages\.retentionDays"/);
  assert.match(html, /min="1" max="90"[^>]*value="30"/);
  assert.match(html, /data-policy-agent-message="metaRetentionDays"/);
  assert.match(html, /data-setting-help="agentMessages\.metaRetentionDays"/);
  assert.match(html, /min="7" max="730"[^>]*value="365"/);
  const input = { closest: () => ({}), dataset: { policyAgentMessage: 'metaRetentionDays' }, value: '400', id: 'setting-agent-meta', setCustomValidity() {}, setAttribute() {}, removeAttribute() {} };
  app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyAgentMessage'))({ target: input });
  assert.equal(app.getDraft().agentMessages.metaRetentionDays, 400);
});

test('agent prompt timeout renders its default, help and range, and accepts a policy edit', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture(); app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /data-policy-agent-message="promptTimeoutSeconds"/);
  assert.match(html, /data-setting-help="agentMessages\.promptTimeoutSeconds"/);
  assert.match(html, /min="1" max="120"[^>]*value="25"/);
  const input = { closest: () => ({}), dataset: { policyAgentMessage: 'promptTimeoutSeconds' }, value: '40', id: 'setting-agent-timeout', setCustomValidity() {}, setAttribute() {}, removeAttribute() {} };
  app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyAgentMessage'))({ target: input });
  assert.equal(app.getDraft().agentMessages.promptTimeoutSeconds, 40);
  assert.match(app.settingsView(s), /min="1" max="120"[^>]*value="40"/);
});

test('a blank picture retention field remains blank and invalid after rendering', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture(); s.policy.attachments = { retentionDays: null }; app.setState(s);
  assert.match(app.settingsView(s), /value="" data-policy-attachment="retentionDays"[^>]*aria-invalid="true"/);
});

test('the Opus settings render and accept a policy edit', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture(); s.policy.opus = { allowWithoutForce: true, maxConcurrent: 3 };
  app.setState(s);
  const html = app.allocationView(s);
  assert.match(html, /data-setting-help="opus\.allowWithoutForce"/);
  assert.match(html, /data-setting-help="opus\.maxConcurrent"/);
  assert.match(html, /data-policy-opus-bool="allowWithoutForce" checked/);
  assert.match(html, /max="8" value="3" data-policy-opus="maxConcurrent"/);
  const change = (dataset, extra) => app.context.handlers.get('change').find((handler) => handler.toString().includes('el.dataset.policyOpus'))({ target: { closest: () => ({}), dataset, id: 'x', setCustomValidity() {}, setAttribute() {}, removeAttribute() {}, ...extra } });
  change({ policyOpus: 'maxConcurrent' }, { value: '4' });
  change({ policyOpusBool: 'allowWithoutForce' }, { checked: false });
  assert.deepEqual(app.getDraft().opus, { allowWithoutForce: false, maxConcurrent: 4 });
});

test('Settings shows and edits the shared Git policy per project with its schema and warning', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog });
  const s = fixture(); s.policy.projects.alpha.codexSharedGit = false;
  s.harness.findings.push({ status: 'ok', area: 'git pins', item: 'Shared Git integrity: registered' });
  app.setState(s);
  const html = app.settingsView(s);
  assert.match(html, /projects\.SLUG\.codexSharedGit/);
  assert.match(html, /data-codex-shared-git="alpha"/);
  assert.match(html, /data-codex-shared-git="registered"/);
  assert.doesNotMatch(html, /data-codex-shared-git="alpha"[^>]*checked/);
  assert.match(html, /hooks\/.*config.*refs\/.*objects\/.*HEAD.*info\/.*worktrees\//);
  const handler = app.context.handlers.get('change').find((fn) => fn.toString().includes('el.dataset.codexSharedGit'));
  handler({ target: { dataset: { codexSharedGit: 'alpha' }, checked: true, closest: () => ({}), matches: () => false } });
  assert.equal(app.getDraft().projects.alpha.codexSharedGit, true);
});

test('shared Git edits update the policy action row when an earlier price action row exists', async () => {
  const app = await views(); app.setModels({ codex: catalog, claude: catalog }); const s = fixture(); app.setState(s); app.settingsView(s);
  const status = { textContent: '' }, button = { disabled: true };
  const policyActions = { classList: { add() {} }, querySelector: (selector) => selector === '[data-policy-status]' ? status : button };
  status.closest = () => policyActions;
  const priceActions = { classList: { add() {} }, querySelector: () => null };
  app.context.document = { querySelector: (selector) => selector === '.control-actions' ? priceActions : selector === '[data-policy-status]' ? status : null };
  const handler = app.context.handlers.get('change').find((fn) => fn.toString().includes('el.dataset.codexSharedGit'));
  assert.doesNotThrow(() => handler({ target: { dataset: { codexSharedGit: 'alpha' }, checked: false, closest: () => ({}), matches: () => false } }));
  assert.match(status.textContent, /Unsaved changes/); assert.equal(button.disabled, false);
});
