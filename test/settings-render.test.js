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
import { serviceSettingsView, validateServiceSettings } from '../src/config.js';

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
  vm.runInNewContext(`${body}\nthis.views = { settingsView, allocationView, agentsView, boardView, chatBubble, saveServiceSettings, setModels: (m) => { models = m; }, setState: (v) => { state = v; }, setDraft: (v) => { policyDraft = v; }, getDraft: () => policyDraft };`, context);
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

test('Settings shows and saves release repository rows with all three fields', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const repos = [{ name: 'example-org/example-app', project: 'example', kind: 'app' }];
  const s = fixture();
  s.serviceSettings = serviceSettingsView({ releases: { repos } });
  const html = app.settingsView(s);
  assert.equal((html.match(/data-setting-help="releases\.repos"/g) || []).length, 1, 'the row has one setting help button');
  assert.doesNotMatch(html, /<p class="setting-help"><strong>Allowed release repositories<\/strong><\/p>/);
  assert.doesNotMatch(html, /Only listed repositories can use release request/);
  assert.match(html, /data-release-repo-add/);
  assert.match(html, /data-release-repo-remove/);
  for (const field of ['name', 'project', 'kind']) assert.match(html, new RegExp(`data-release-repo-field="${field}"`));
  assert.match(html, /data-save-service-settings="Releases"/);

  const empty = app.settingsView({ ...s, serviceSettings: serviceSettingsView({ releases: { repos: [] } }) });
  assert.match(empty, /data-release-repo-empty[^>]*>No repositories are allowed\.<\/p>/);
  assert.equal((empty.match(/data-setting-help="releases\.repos"/g) || []).length, 1, 'the empty list still has one setting help button');
  assert.doesNotMatch(empty, /Only listed repositories can use release request/);

  const inputs = [
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'name' }, value: 'example-org/example-app' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'project' }, value: 'example' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '0', releaseRepoField: 'kind' }, value: 'app' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'name' }, value: ' ' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'project' }, value: '' },
    { type: 'text', dataset: { serviceSetting: 'releases.repos', serviceGroup: 'Releases', releaseRepoIndex: '1', releaseRepoField: 'kind' }, value: '' },
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
  assert.deepEqual(sent.changes, { 'releases.repos': repos });
  assert.equal(button.disabled, false);
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

test('the Boss rules row keeps its input inside the card at a phone width', async () => {
  const app = await views();
  app.setModels({ codex: catalog, claude: catalog });
  const s = fixture();
  app.setState(s);
  app.setDraft(s.policy);
  const html = app.allocationView(s);
  for (const [id, label] of [['sf-defaultOrchestratorGoal', 'Default project lead goal'], ['sf-bossRules', 'Boss rules']]) {
    const at = html.indexOf(`<input id="${id}"`);
    assert.ok(at > 0, `${label} renders its text input`);
    const start = html.lastIndexOf('<label', at);
    const row = html.slice(start, html.indexOf('</label>', at));
    assert.ok(row.includes(`>${label}<button`), `${label} renders a setting row`);
    assert.match(row, /\bgoal-setting\b/, `${label} carries the class that shrinks the input`);
  }
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
