import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { groupMailRows } from '../public/mail-rows.js';
import { patchHtml } from '../public/keyed.js';
import { createDocument, find, byKey } from './fake-dom.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../public/store.js', import.meta.url), 'utf8');

function body(signature) {
  const name = signature.slice(0, signature.indexOf('(')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\nfunction ${name}\\([^\\n]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

function declaration(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\nfunction ${escaped}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${name}`);
  return match[0];
}

function loadRenderContext({ mailbox, document, patch }) {
  const context = {
    mailbox,
    document,
    window: {},
    location: { pathname: '/mailbox', search: '' },
    history: {},
    state: { updatedAt: '2026-10-10T09:00:30.000Z', control: { projects: {} }, mailbox: {} },
    $app: null,
    $nav: {},
    $updated: { textContent: '' },
    chat: {},
    fleetData: null,
    fleetLoading: false,
    fleetSettings: null,
    fleetShares: null,
    projectRegisterLoading: true,
    projectRegisterLoadedAt: 0,
    policyDirty: false,
    priceDraft: {},
    pendingHash: null,
    lastRender: '',
    lastRenderedPath: '',
    lastRoute: 'mailbox',
    dirtyFormRegions: new Map(),
    FORM_EDITABLE_SELECTOR: 'input, textarea, select, [contenteditable="true"]',
    APP_VIEW_ROUTES: ['mailbox', 'chat'],
    KEYED_ROUTES: ['mailbox'],
    MAIL_FOLDER_KEYS: { 'needs-you': 'needsYou', inbox: 'inbox', updates: 'updates', sent: 'sent', done: 'done' },
    MAIL_FOLDER_LABEL: { 'needs-you': 'Needs you', inbox: 'Inbox', updates: 'Updates', sent: 'Sent', done: 'Done' },
    MESSAGE_SENDER: { owner: 'You', boss: 'Boss', orch: 'Orchestrator' },
    mailSelected: new Set(),
    appPhone: () => false,
    readLocation: () => ({ route: 'mailbox', slug: null, task: null, pendingHash: null }),
    mailboxFolderFromLocation: () => 'sent',
    mailboxActionCount: () => 0,
    mailFolderLinks: () => '',
    messageLimitsLine: () => '',
    appBarIcons: () => '',
    appMenuButton: () => '',
    appIcon: () => '',
    avatarSlot: () => '',
    avatarTitle: () => 'Boss',
    threadTitleTag: () => 'h2',
    mailFolderUrl: (folder) => `/mailbox?folder=${folder}`,
    mailEmpty: () => '<p>Empty</p>',
    mailSelectionBarHtml: () => '',
    mailSuggestionHtml: () => '',
    mailActions: () => '',
    mailDoneLine: () => '',
    reviewOpenLinkHtml: () => '',
    mailBarItem: () => null,
    mailBar: () => '',
    attachmentStrip: () => '',
    attachmentPickerHtml: () => '',
    mailProject: (_s, item) => item.thread === 'boss' ? '' : item.thread,
    mailItemLabel: (_s, item) => ({ owner: 'You', boss: 'Boss', orch: 'Orchestrator' }[item.from] || item.from),
    clock: (value) => value,
    mailDeliveryState: (record) => record.status === 'sent' ? `delivered ${record.sentAt}` : record.status,
    messageCopyHtml: (id) => `<button data-message-id="${id}"></button>`,
    messageBody: (record) => `<p>${record.text}</p>`,
    mailFind: null,
    groupMailRows,
    mailRowsHtml: (_s, rows) => rows.map((row) => `<li data-key="row:${row.key}" data-row-count="${row.count}">${row.item.id}</li>`).join(''),
    mailReplyFormShown: () => true,
    fleetMailbox: () => '',
    documentTitle: 'Herdr Boss',
    chatViewportDebug: { setVisible() {} },
    syncBrandMenuLabel() {},
    syncMenu() {},
    syncMailboxFolderMenu() {},
    updateMailboxBadge() {},
    updateWatchIcon() {},
    mailRestoreDrafts() {},
    captureScroll: () => ({ keys: {}, tops: {} }),
    restoreScroll() {},
    syncSettingPopup() {},
    syncDepGraphs() {},
    syncBoards() {},
    syncTopHeight() {},
    goalAfterRender() {},
    ago: () => 'now',
    refreshFleet() {},
    refreshProjectRegister() {},
    fitTextarea() {},
    clearTimeout() {},
    requestAnimationFrame() {},
    patchHtml: patch,
  };
  context.$app = document.createElement('div');
  context.$app.querySelector = () => null;
  context.$app.querySelectorAll = () => [];
  context.$app.innerHTML = '';
  context.$app.id = 'app';
  context.document.body.classList = { toggle() {}, remove() {}, contains: () => false };
  context.document.getElementById = (id) => id === 'help-panel' ? { hidden: true } : null;
  context.document.querySelectorAll = () => [];

  vm.createContext(context);
  vm.runInContext(store.replace(/^export /gm, '') + '\nthis.createClientStore = createClientStore;', context);
  const names = [
    'mailFind', 'mailboxView', 'mailConversationView', 'mailConversationKey',
    'mailConversationMessage', 'mailReplyFormShown', 'mailDeliveryState', 'render',
  ];
  const helpers = ['mailDeduplicateClientRecords', 'hasDirtyFormRegion', 'formRefreshBlocked'].filter((name) => {
    try { declaration(name); return true; } catch { return false; }
  });
  const escSource = /\nconst esc = .*\n/.exec(app)?.[0];
  assert.ok(escSource, 'the UI defines its HTML escaper');
  const addOn = `\nfunction mailProject(s, item) { return item.thread === 'boss' ? '' : item.thread; }\nfunction mailItemLabel(s, item) { return ({ owner: 'You', boss: 'Boss', orch: 'Orchestrator' })[item.from] || item.from; }\nfunction mailRowsHtml(s, rows) { return rows.map((row) => '<li data-key="row:' + row.key + '" data-row-count="' + row.count + '">' + row.item.id + '</li>').join(''); }`;
  vm.runInContext(`${escSource}${[...names, ...helpers].map(declaration).join('\n')}${addOn}\nthis.appApi = { mailboxView, mailConversationView, mailConversationKey, mailConversationMessage, mailReplyFormShown, render };`, context);
  return { context, api: context.appApi };
}

function recordNode(root, id) {
  return find(root, (node) => node.tagName === 'LI' && find(node, (child) => child.getAttribute('data-message-id') === id));
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fixtures() {
  const owner = {
    id: 'sample-owner-server', thread: 'boss', from: 'owner', to: 'boss', kind: 'message',
    text: 'Synthetic note\nhttps://example.invalid/check', at: '2026-10-10T09:00:00.000Z',
    status: 'sent', sentAt: '2026-10-10T09:00:01.000Z', repliedAt: '2026-10-10T09:00:20.000Z',
    clientId: 'synthetic-client-1', conversationId: 'sample-owner-server',
  };
  const reply = {
    id: 'sample-boss-reply', thread: 'boss', from: 'boss', to: 'owner', kind: 'reply',
    text: 'Synthetic reply', at: '2026-10-10T09:00:20.000Z', status: 'new',
    replyTo: owner.id, conversationId: owner.id,
  };
  const pending = {
    ...owner, id: 'local-sample-owner', status: 'sending', sentAt: null, repliedAt: null,
    conversationId: 'local-sample-owner', local: true,
  };
  const doneAnswer = {
    id: 'sample-owner-answer', thread: 'boss', from: 'owner', to: 'boss', kind: 'message',
    text: 'Synthetic answer in the Done payload', at: '2026-10-10T08:00:00.000Z',
    status: 'sent', sentAt: '2026-10-10T08:00:01.000Z', clientId: 'synthetic-client-2',
  };
  const list = (sent) => ({ needsYou: [], inbox: [], updates: [], sent, done: [{ id: 'sample-done', thread: 'boss', answer: doneAnswer }], loaded: true, folder: 'sent' });
  const thread = (records, selectedId) => ({ records, selected: { thread: 'boss', id: selectedId } });
  return { owner, reply, pending, list, thread };
}

function setupMailbox(context, doc) {
  context.mailbox = {
    needsYou: [], inbox: [], updates: [], sent: [], done: [], failed: [],
    folder: 'sent', loaded: true, loading: false, error: '', notice: '', counts: '',
    busy: false, status: {}, currentConversation: null, conversationRecords: [],
    conversationLoading: false, conversationError: '', composing: false, composeDraft: '',
    composeThread: 'boss', replyDraft: 'saved draft', updatesUnread: 0,
  };
  context.clientStore = null;
  context.state.mailbox = {};
  context.document = doc;
}

function makePageHarness() {
  const doc = createDocument();
  const patchCalls = [];
  const { context, api } = loadRenderContext({
    mailbox: {}, document: doc,
    patch: (target, html) => { patchCalls.push(html); patchHtml(target, html); },
  });
  setupMailbox(context, doc);
  return { context, api, doc, patchCalls };
}

// A closed answer, approve, or decide item has its own form. A second Reply form would send to the same item.
test('the Reply form hides while the last agent message is an open item with its own form', () => {
  const { context, api } = makePageHarness();
  const ask = { id: 'a1', from: 'orch', to: 'owner', action: 'decide' };
  const items = { a1: { id: 'a1', action: 'decide' } };
  context.mailFind = (id) => items[id];
  assert.equal(api.mailReplyFormShown([ask], context.mailFind), false);
  assert.equal(api.mailReplyFormShown([ask], () => ({ ...items.a1, action: 'approve' })), false);
  assert.equal(api.mailReplyFormShown([ask], () => ({ ...items.a1, action: 'answer' })), false);
  assert.equal(api.mailReplyFormShown([ask], () => ({ ...items.a1, closedAt: '2026-09-30T10:00:00Z' })), true);
  assert.equal(api.mailReplyFormShown([ask], () => ({ ...items.a1, action: 'read' })), true);
  assert.equal(api.mailReplyFormShown([ask], () => undefined), true);
  assert.equal(api.mailReplyFormShown([ask, { id: 'o1', from: 'owner', to: 'orch' }], context.mailFind), false);
  assert.equal(api.mailReplyFormShown([], () => undefined), true);
  assert.match(body('mailConversationView(s)'), /mailReplyFormShown\(records, mailFind\) \? `<form class="mail-reply"/);
});

// The first line of a reply is its headline. The body shows the same line, so the header shows only the sender and the time.
test('a conversation message does not repeat its first line above the body', () => {
  const fn = body('mailConversationMessage(s, record, barItem)');
  assert.doesNotMatch(fn, /mailHeadline\(record\)/);
  assert.doesNotMatch(fn, /<span>\$\{esc\(headline\)\}<\/span>/);
});

test('real store polls preserve the Mailbox signature and skip DOM patches for stable data and client twins', async () => {
  const { context, api, doc, patchCalls } = makePageHarness();
  const { owner, reply, pending, list, thread } = fixtures();
  const stableList = list([owner]);
  const twinList = list([pending, owner]);
  const stableThread = thread([owner, reply], owner.id);
  const twinThread = thread([pending, owner, reply], owner.id);
  const values = {
    mailboxList: [stableList, clone(stableList), twinList, clone(twinList)],
    mailboxReads: [stableThread, clone(stableThread), twinThread, clone(twinThread)],
  };
  const calls = { mailboxList: 0, mailboxReads: 0 };
  const intervals = [];
  const store = context.createClientStore({
    fetchImpl: async (url) => {
      const name = url.includes('/api/mailbox?') ? 'mailboxList' : 'mailboxReads';
      const snapshots = values[name];
      const index = Math.min(calls[name]++, snapshots.length - 1);
      return { ok: true, json: async () => clone(snapshots[index]) };
    },
    resources: {
      mailboxList: { url: '/api/mailbox?folder=sent', intervalMs: 1000 },
      mailboxReads: { url: '/api/mailbox/conversation?thread=boss', intervalMs: 1000 },
    },
    pages: { mailbox: ['mailboxList', 'mailboxReads'] },
    setIntervalImpl(fn) { intervals.push(fn); return intervals.length; },
    clearIntervalImpl() {},
    isHidden: () => false,
    nowImpl: () => 1,
  });
  context.clientStore = store;
  context.mailFind = (id) => [
    ...context.mailbox.inbox, ...context.mailbox.needsYou, ...context.mailbox.updates,
    ...context.mailbox.done, ...context.mailbox.sent,
  ].find((record) => record.id === id);
  store.subscribe('mailboxList', (value) => {
    Object.assign(context.mailbox, value);
    api.render();
  });
  store.subscribe('mailboxReads', (value) => {
    context.mailbox.conversationRecords = value.records;
    context.mailbox.currentConversation = value.selected;
    api.render();
  });

  globalThis.document = doc;
  await store.setPage('mailbox');
  const stableSignature = context.lastRender;
  const stablePatchCount = patchCalls.length;
  const ownerNode = recordNode(context.$app, owner.id);
  assert.ok(ownerNode, 'the canonical Owner message renders');
  assert.equal((stableSignature.match(/data-message-id=/g) || []).length, 2, 'the Owner message and Boss reply each have one copy control');

  await Promise.all(intervals.map((tick) => tick()));
  assert.equal(context.lastRender, stableSignature, 'fresh JSON with the same data has the same HTML signature');
  assert.equal(patchCalls.length, stablePatchCount, 'the production signature guard skips the DOM patch');
  assert.equal(recordNode(context.$app, owner.id), ownerNode, 'the rendered message node stays in place');

  await Promise.all(intervals.map((tick) => tick()));
  assert.equal(context.lastRender, stableSignature, 'an optimistic record plus its server twin is rendered as the canonical record');
  assert.equal(patchCalls.length, stablePatchCount, 'the twin poll does not replace the page DOM');
  assert.equal((context.lastRender.match(/data-key="mail-message:/g) || []).length, 2, 'the conversation renders the Owner message and its Boss reply once each');
  assert.match(context.lastRender, /data-row-count="1"/, 'the Sent row does not count the optimistic twin as a second item');
  assert.equal(recordNode(context.$app, owner.id), ownerNode, 'the original Owner message node survives each tick');
  store.stop();
});

test('optimistic and canonical records with one client id keep the conversation subtree and message node', () => {
  const { context, api, doc, patchCalls } = makePageHarness();
  const { owner, pending, reply } = fixtures();
  context.mailbox.sent = [pending];
  context.mailbox.currentConversation = { thread: 'boss', id: pending.id };
  context.mailbox.conversationRecords = [pending];
  context.mailboxFolderFromLocation = () => 'sent';
  context.state = { updatedAt: '2026-10-10T09:00:30.000Z', control: { projects: {} }, mailbox: {} };
  globalThis.document = doc;

  api.render();
  const scroll = byKey(context.$app, `mail-thread:client:boss:${owner.clientId}`);
  const pendingNode = recordNode(context.$app, pending.id);
  const draft = find(context.$app, (node) => node.tagName === 'TEXTAREA');
  const patchesBeforeServerRecord = patchCalls.length;
  scroll.scrollTop = 318;
  draft.value = 'unfinished reply';
  draft.focus();
  draft.setSelectionRange(4, 11);

  context.mailbox.sent = [owner];
  context.mailbox.currentConversation = { thread: 'boss', id: owner.id };
  context.mailbox.conversationRecords = [owner, reply];
  api.render();

  assert.equal(patchCalls.length, patchesBeforeServerRecord + 1, 'the changed server signature causes one page patch');
  assert.equal(byKey(context.$app, `mail-thread:client:boss:${owner.clientId}`), scroll, 'the scroll region keeps its client id key');
  assert.equal(scroll.scrollTop, 318, 'the scroll position remains in the same node');
  assert.equal(recordNode(context.$app, owner.id), pendingNode, 'the server record updates the existing message node');
  assert.equal(pendingNode.getAttribute('data-key'), `mail-message:client:boss:${owner.clientId}`);
  assert.equal((context.lastRender.match(/data-key="mail-message:/g) || []).length, 2, 'the canonical Owner message and reply each have one keyed node');
  assert.equal(find(context.$app, (node) => node.tagName === 'TEXTAREA'), draft, 'the open reply draft stays in the same field');
  assert.equal(draft.value, 'unfinished reply');
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [4, 11]);
  assert.equal(doc.activeElement, draft, 'the open reply draft keeps focus');
});

test('conversation messages without a client id use a stable thread and message id key', () => {
  const { context, api } = makePageHarness();
  const boss = { id: 'sample-boss-message', thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text: 'Synthetic Boss reply', at: '2026-10-10T09:00:20.000Z', status: 'new' };
  context.mailbox.conversationRecords = [boss];
  assert.match(api.mailConversationMessage({}, boss, null), /data-key="mail-message:id:boss:sample-boss-message"/);
});

test('a legacy Owner message keeps its id key as reply state arrives', () => {
  const { context, api } = makePageHarness();
  const owner = {
    id: 'sample-legacy-owner', thread: 'boss', from: 'owner', to: 'boss', kind: 'message',
    text: 'Synthetic unanswered message', at: '2026-10-10T09:00:00.000Z', status: 'sent',
    conversationId: 'sample-legacy-owner', repliedAt: null,
  };
  context.mailbox.sent = [owner];
  context.mailbox.currentConversation = { thread: 'boss', id: owner.id };
  context.mailbox.conversationRecords = [owner];
  globalThis.document = context.document;
  api.render();
  const message = recordNode(context.$app, owner.id);
  const before = context.lastRender;

  const replied = { ...owner, repliedAt: '2026-10-10T09:00:20.000Z' };
  context.mailbox.sent = [replied];
  context.mailbox.conversationRecords = [replied];
  api.render();

  assert.notEqual(context.lastRender, before, 'the reply state changes the rendered signature');
  assert.equal(recordNode(context.$app, owner.id), message, 'the message node stays in place');
  assert.equal(message.getAttribute('data-key'), `mail-message:id:boss:${owner.id}`);
});

// The Mailbox and the Chat card answer an approval with the same two verdicts, so the agent reads one word for one decision.
test('the Mailbox and the Chat card use the same approval verdicts', () => {
  const mail = body('mailActions(item)');
  assert.match(mail, /data-mail-verdict="Approved\."[^>]*>Approve<\/button>/);
  assert.match(mail, /data-mail-verdict="Rejected\."[^>]*>Reject<\/button>/);
  assert.match(app, /startsWith\('Declined\.'\)/);
  assert.doesNotMatch(app.replace(/body\.startsWith\('Declined\.'\)/, ''), /Declined\.|>Decline</);
  assert.match(app, /\{ value: 'Rejected\.', label: 'Reject', deny: true \}/);
});
