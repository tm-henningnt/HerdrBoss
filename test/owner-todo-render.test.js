import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, { get: (_t, key) => key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : key === 'matches' ? () => false : key === 'length' ? 0 : stub(), set: () => true, apply: () => stub(), construct: () => stub() });
}
async function app(width = 1280) {
  const handlers = new Map();
  const doc = stub();
  const context = {
    document: new Proxy(doc, { get: (target, key) => key === 'addEventListener' ? (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]) : target[key] }),
    window: stub(), location: { pathname: '/mailbox', search: '?folder=todo', hash: '' }, history: stub(), navigator: stub(),
    localStorage: { getItem: () => null, setItem() {} }, fetch: () => new Promise(() => {}), CSS: { escape: String },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0,
    URLSearchParams, URL, Date, JSON, Math, Promise, console, innerHeight: 852, innerWidth: width,
    EventSource: stub(), Blob, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => stub(), scrollTo() {}, MutationObserver: stub(), ResizeObserver: stub(), IntersectionObserver: stub(), AbortController, FormData: stub(), Event: stub(), CustomEvent: stub(), Intl,
  };
  for (const match of source.matchAll(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm)) {
    const module = await import(`../public/${match[2]}`);
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const [imported, local] = name.split(/\s+as\s+/);
      context[local || imported] = imported === 'createClientStore' ? (options) => module[imported]({ ...options, fetchImpl: context.fetch, EventSourceImpl: context.EventSource, setIntervalImpl: context.setInterval, clearIntervalImpl: context.clearInterval }) : module[imported];
    }
  }
  vm.runInNewContext(`${source.replace(/^import [^\n]*\n/gm, '')}\nthis.views = { mailboxView, appBarIcons, todoSubmit, todoChoose, setMail: (data) => Object.assign(mailbox, data), setState: (s) => { state = s; }, setDraft: (id, draft) => { todoDrafts[id] = draft; }, drafts: todoDrafts, setPost: (fn) => { postJson = fn; }, setLoad: (fn) => { loadMailbox = fn; }, setRender: (fn) => { render = fn; } };`, context);
  return { ...context.views, handlers, context };
}
const item = (extra = {}) => ({ id: 'm-todo', project: 'alpha', thread: 'alpha', from: 'orch', title: 'Check <the> preview', type: 'check', priority: 'high', state: 'open', createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: '2026-10-10T10:00:00Z', why: 'Check it before release.', steps: '- Check the labels.', expectedResult: 'Clear labels.', howToAnswer: 'Select Done.', blocks: 'The next release.', poster: { role: 'orch', pane: 'wA:p1' }, ownerActions: [], ...extra });
const state = { mailbox: { todoOpen: 1 }, control: { projects: { alpha: { label: 'Alpha' } } } };

for (const width of [1280, 393]) test(`the To do view renders the row, details, actions and header badge at ${width}px in a VM`, async () => {
  const ui = await app(width);
  ui.setMail({ todo: [item()], todoHistory: [], loaded: true }); ui.setState(state);
  const html = ui.mailboxView(state);
  assert.match(html, /<h1>To do/);
  assert.match(html, /data-top-badge="todo"[^>]*>1<\/span>/);
  for (const text of ['Alpha', 'Check &lt;the&gt; preview', 'check', 'high', 'The next release.', 'orch', 'Why', 'Steps', 'Expected result', 'How to answer']) assert.ok(html.includes(text), text);
  for (const action of ['done', 'blocked', 'snooze', 'not-now']) assert.match(html, new RegExp(`data-todo-action="${action}"`));
  assert.doesNotMatch(html, /data-mail-dismiss|data-mail-form/);
});

test('a decide row offers Answer with Accept or Deny and preserves the reason draft', async () => {
  const ui = await app();
  ui.setMail({ todo: [item({ type: 'decide' })], todoHistory: [], loaded: true });
  ui.setDraft('m-todo', { action: 'answer', reason: 'Use the preview.' });
  const html = ui.mailboxView(state);
  assert.match(html, /data-todo-action="answer"/);
  assert.match(html, /data-todo-decision="accept"[^>]*>Accept<\/button>/);
  assert.match(html, /data-todo-decision="deny"[^>]*>Deny<\/button>/);
  assert.match(html, /Use the preview\./);
  assert.match(html, /data-todo-reason/);
});

test('blocked and snoozed items remain available with their reason and Reopen', async () => {
  const ui = await app();
  ui.setMail({ todo: [], todoHistory: [item({ state: 'blocked', ownerActions: [{ action: 'blocked', reason: 'Preview is down.', at: '2026-10-10T12:00:00Z' }] })], loaded: true });
  const html = ui.mailboxView({ ...state, mailbox: { todoOpen: 0 } });
  assert.match(html, /No open To do items/);
  assert.match(html, /Preview is down\./);
  assert.match(html, /data-todo-action="reopen"/);
});

test('submitting an Owner action sends the typed reason, time and item version, then refreshes the list', async () => {
  const ui = await app();
  ui.setMail({ todo: [item()], todoHistory: [], loaded: true });
  ui.setDraft('m-todo', { action: 'blocked', reason: 'Preview is down.' });
  let sent; let refreshed = false;
  ui.setPost(async (url, body) => { sent = { url, body }; return { mailbox: { todoOpen: 0 } }; });
  ui.setLoad(async () => { refreshed = true; }); ui.setRender(() => {});
  await ui.todoSubmit('m-todo');
  assert.equal(sent.url, '/api/todo/action');
  assert.equal(sent.body.reason, 'Preview is down.');
  assert.equal(sent.body.updatedAt, item().updatedAt);
  assert.equal(refreshed, true);
  assert.equal(ui.drafts['m-todo'], undefined);
});

test('phone To do rows wrap content and actions, use cool tokens, and keep accessible fields', () => {
  assert.match(css, /\.todo-row\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.todo-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.todo-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)\s*\{[^]*?\.todo-action-form[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.todo-type\s*\{[^}]*color:\s*var\(--accent\)/);
  assert.match(css, /\.todo-status\s*\{[^}]*color:\s*var\(--muted\)/, 'Saving status uses a cool neutral token.');
});
