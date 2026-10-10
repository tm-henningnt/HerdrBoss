import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const storeSource = fs.readFileSync(new URL('../public/store.js', import.meta.url), 'utf8');

function declaration(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\nfunction ${escaped}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `the source defines ${name}`);
  return match[0];
}

function exactLine(text) {
  const line = appSource.split('\n').find((item) => item.trim() === text);
  assert.ok(line, `the app registers ${text}`);
  return line;
}

function element(tagName, attrs = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    nodeName: tagName.toUpperCase(),
    attrs: new Map(Object.entries(attrs)),
    parentNode: null,
    value: attrs.value || '',
    selectionStart: 0,
    selectionEnd: 0,
    dataset: {},
    textContent: '',
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    hasAttribute(name) { return this.attrs.has(name); },
    matches(selector) {
      return selector.split(',').some((part) => {
        const value = part.trim();
        if (value === 'input, textarea, select, [contenteditable="true"]') return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || this.getAttribute('contenteditable') === 'true';
        if (value.startsWith('[')) {
          const attr = value.slice(1, value.indexOf(']')).split('=')[0].replaceAll('"', '').replaceAll("'", '');
          return this.hasAttribute(attr);
        }
        if (value.startsWith('#')) return this.getAttribute('id') === value.slice(1);
        return this.tagName === value.toUpperCase();
      });
    },
    closest(selector) {
      for (let current = this; current; current = current.parentNode) {
        if (current.matches?.(selector)) return current;
      }
      return null;
    },
    focus() { this.ownerDocument.activeElement = this; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      node.dataset[key] = value;
    }
  }
  return node;
}

function makeHarness() {
  const handlers = new Map();
  const helpPanel = { hidden: true };
  const body = { classList: { toggle() {}, remove() {}, contains: () => false } };
  const app = {
    currentHtml: '',
    field: null,
    region: null,
    addButton: null,
    rows: [],
    get innerHTML() { return this.currentHtml; },
    set innerHTML(html) {
      if (this.field && doc.activeElement === this.field) doc.activeElement = body;
      this.currentHtml = html;
      this.rows = [];
      this.region = createElement('div', { 'data-release-repos-editor': '' });
      this.rowsNode = createElement('div', { 'data-release-repo-rows': '' });
      this.addButton = createElement('button', { 'data-release-repo-add': '' });
      this.rowsNode.parentNode = this.region;
      this.addButton.parentNode = this.region;
      this.field = createElement('input', { id: 'repo-name', value: 'stored' });
      this.field.parentNode = this.region;
      this.field.root = this;
      this.region.root = this;
      this.addButton.root = this;
      this.rowsNode.root = this;
    },
    contains(node) { return Boolean(node && node.root === this); },
    querySelector(selector) {
      if (selector === '[data-release-repo-rows]') return this.rowsNode;
      if (selector === '[data-release-repos-editor]') return this.region;
      if (selector === '[data-release-repo-add]') return this.addButton;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const doc = {
    activeElement: body,
    body,
    title: '',
    addEventListener(name, handler) {
      handlers.set(name, [...(handlers.get(name) || []), handler]);
    },
    getElementById(id) { return id === 'help-panel' ? helpPanel : id === 'repo-name' ? app.field : null; },
    querySelectorAll() { return []; },
  };
  const createElement = (tag, attrs) => Object.assign(element(tag, attrs), { ownerDocument: doc });
  app.innerHTML = '';
  const context = {
    document: doc,
    window: {},
    location: { pathname: '/settings', search: '', hash: '' },
    history: {},
    $app: app,
    $updated: { textContent: '' },
    $nav: {},
    state: null,
    policyDirty: false,
    policyDraft: null,
    allocationMeta: null,
    policyStale: false,
    priceDraft: {},
    pendingHash: null,
    lastRender: '',
    lastRoute: 'settings',
    clientStore: null,
    fleetData: null,
    fleetSettings: null,
    fleetShares: null,
    fleetLoading: false,
    projectRegisterLoading: true,
    projectRegisterLoadedAt: 0,
    APP_VIEW_ROUTES: [],
    KEYED_ROUTES: ['settings'],
    readLocation: () => ({ route: 'settings', slug: null, task: null, pendingHash: null }),
    settingsView: (state) => `<section id="settings-plane"><p data-revision>${state.revision}</p><div data-release-repos-editor><input id="repo-name" value="${state.repo}"/><div data-release-repo-rows></div><button data-release-repo-add>Add repository</button></div></section>`,
    patchHtml: (target, html) => { target.innerHTML = html; },
    captureScroll: () => ({ keys: {}, tops: {} }),
    restoreScroll() {},
    syncBrandMenuLabel() {},
    syncMenu() {},
    syncMailboxFolderMenu() {},
    updateMailboxBadge() {},
    updateWatchIcon() {},
    syncSettingPopup() {},
    syncDepGraphs() {},
    syncBoards() {},
    syncTopHeight() {},
    goalAfterRender() {},
    ago: () => 'now',
    chatViewportDebug: { setVisible() {} },
    chat: {},
    mailbox: {},
    documentTitle: 'Herdr Boss',
    clearTimeout() {},
    requestAnimationFrame() {},
    fitTextarea() {},
    scrollY: 0,
  };
  context.autoRender = () => context.render();
  context.document.documentElement = { dataset: {} };
  const formGuard = [
    "const FORM_EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=\"true\"]';",
    "const FORM_REGION_SELECTOR = 'form, [data-service-group], [data-release-repos-editor], #price-settings, [data-night-form], [data-routine-details], .watch-routines, .watch-adhoc, .routine-editor, .settings-card, .panel, #control-plane, #settings-plane';",
    'const dirtyFormRegions = new Map();',
    'let lastRenderedPath = \'\';',
    ...['formEditRegion', 'markFormDirty', 'clearFormDirtyRegion', 'hasDirtyFormRegion', 'formRefreshBlocked', 'trackFormEdit', 'trackFormBlur', 'trackFormAction', 'renderAfterSuccessfulFormSave'].map((name) => declaration(appSource, name)),
    exactLine("document.addEventListener('input', trackFormEdit, true);"),
    exactLine("document.addEventListener('change', trackFormEdit, true);"),
    exactLine("document.addEventListener('focusout', trackFormBlur, true);"),
    exactLine("document.addEventListener('click', trackFormAction, true);"),
  ].join('\n');
  const storeAndRender = `${storeSource.replace(/^export /gm, '')}\nthis.createClientStore = createClientStore;\n${formGuard}\n${declaration(appSource, 'render')}\nthis.render = render;\nthis.renderAfterSuccessfulFormSave = renderAfterSuccessfulFormSave;`;
  vm.createContext(context);
  vm.runInContext(storeAndRender, context);
  context.render = context.render.bind(context);
  app.innerHTML = '';

  const snapshots = [
    { revision: 1, repo: 'stored', updatedAt: '2026-10-10T09:00:00.000Z' },
    { revision: 2, repo: 'server update', updatedAt: '2026-10-10T09:00:01.000Z' },
  ];
  let tick;
  const store = context.createClientStore({
    fetchImpl: async () => ({ ok: true, json: async () => snapshots.shift() || { revision: 2, repo: 'server update', updatedAt: '2026-10-10T09:00:01.000Z' } }),
    resources: { snapshot: { url: '/api/state', intervalMs: 1000 } },
    pages: { settings: ['snapshot'] },
    setIntervalImpl(fn) { tick = fn; return 1; },
    clearIntervalImpl() {},
    isHidden: () => false,
    nowImpl: () => 1,
  });
  context.clientStore = store;
  store.subscribe('snapshot', (state) => { context.state = state; context.render(); });
  return {
    context, app, doc, handlers, store,
    async start() { await store.setPage('settings'); },
    async tick() { await tick(); },
    dispatch(type, target) { for (const handler of handlers.get(type) || []) handler({ type, target }); },
  };
}

test('dirty form input and an added repository row survive a state tick with focus and caret', async (t) => {
  const page = makeHarness();
  t.after(() => page.store.stop());
  await page.start();
  const field = page.app.field;
  field.value = 'typed draft';
  field.focus();
  field.setSelectionRange(4, 8);
  const row = { root: page.app, getAttribute: (name) => name === 'data-release-repo-row' ? '1' : null };
  page.app.rows.push(row);
  page.dispatch('click', page.app.addButton);
  page.dispatch('input', field);

  await page.tick();

  assert.equal(page.app.field, field, 'the edited field node stays in place');
  assert.equal(field.value, 'typed draft', 'the typed value stays in place');
  assert.equal(page.app.rows.includes(row), true, 'the client-added repository row stays in place');
  assert.equal(page.doc.activeElement, field, 'the field keeps focus');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 8], 'the caret range stays in place');
  assert.match(page.app.innerHTML, /<p data-revision>1<\/p>/, 'a dirty form keeps its current rendered state');

  page.context.renderAfterSuccessfulFormSave(page.app.region);
  assert.match(page.app.innerHTML, /<p data-revision>2<\/p>/, 'a forced render after a successful save clears the dirty mark and catches up');
});

test('a clean page applies the next state tick', async (t) => {
  const page = makeHarness();
  t.after(() => page.store.stop());
  await page.start();

  await page.tick();

  assert.match(page.app.innerHTML, /<p data-revision>2<\/p>/, 'a clean page renders the updated state');
});

test('a clean focused field catches up after blur', async (t) => {
  const page = makeHarness();
  t.after(() => page.store.stop());
  await page.start();
  const field = page.app.field;
  field.focus();

  await page.tick();
  assert.match(page.app.innerHTML, /<p data-revision>1<\/p>/, 'a focused editable control holds the current page');

  page.doc.activeElement = page.doc.body;
  page.dispatch('focusout', field);
  await Promise.resolve();
  assert.match(page.app.innerHTML, /<p data-revision>2<\/p>/, 'a clean blur runs one catch-up render');
});
