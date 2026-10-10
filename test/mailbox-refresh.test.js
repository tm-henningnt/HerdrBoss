import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { KEYED_ROUTES } from '../public/routes.js';
import { PAGE_READS } from '../public/store.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function body(signature) {
  const name = signature.slice(0, signature.indexOf('(')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(app);
  assert.ok(match, `the UI defines ${signature}`);
  return match[1];
}

test('the automatic refresh does not force a full re-render of the Mailbox and the Chat', () => {
  const keeps = new Function('pathname', body('refreshForcesRender(pathname)'));
  assert.equal(keeps('/mailbox'), false);
  assert.equal(keeps('/chat'), false);
  assert.equal(keeps('/'), true);
  assert.equal(keeps('/browsers'), true);

  const refresh = body('refreshExtras()');
  assert.match(refresh, /clientStore\.refreshPage\(currentRoute\(\)\)/, 'the store refreshes the active page reads');
  assert.doesNotMatch(refresh, /lastRender = '';/, 'store subscribers decide whether to force a full render');
  assert.match(app, /if \(force \|\| refreshForcesRender\(location\.pathname\)\) lastRender = '';/);
});

test('an automatic render waits 3 seconds after the last Owner input or scroll', () => {
  const OWNER_QUIET_MS = Number(/const OWNER_QUIET_MS = (\d+);/.exec(app)?.[1]);
  assert.equal(OWNER_QUIET_MS, 3000);
  const wait = new Function('OWNER_QUIET_MS', 'lastActiveAt', 'now', body('ownerQuietWait(lastActiveAt, now)'));
  assert.equal(wait(OWNER_QUIET_MS, 0, 100000), 0, 'no recent input');
  assert.equal(wait(OWNER_QUIET_MS, 100000, 100500), 2500);
  assert.equal(wait(OWNER_QUIET_MS, 100000, 103000), 0);

  // The store sends state events and 10-second ticks through the waiting render.
  assert.match(app, /clientStore\.subscribe\('state', \(value\) => \{\n\s*state = value;\n\s*autoRender\(\);/);
  assert.match(app, /setInterval\(autoRender, 10000\);/);
  assert.match(app, /const renderStoreData = \(force = false\) => \{[\s\S]*?autoRender\(\);/);
  const auto = body('autoRender()');
  assert.match(auto, /ownerQuietWait\(ownerActiveAt, Date\.now\(\)\)/);
  assert.match(auto, /setTimeout\(/);
});

test('a re-render keeps the scroll of the Mailbox list, the Mailbox conversation, and the Chat list in the same view', () => {
  const keys = new Function('route', 'mailbox', 'chat', body('keptScrollKeys(route, mailbox, chat)'));
  const mail = { folder: 'needs-you', currentConversation: { thread: 'boss', id: 'm-1' }, composing: false };
  const before = keys('mailbox', mail, {});
  assert.deepEqual(Object.keys(before).sort(), ['.mail-conversation-scroll', '.mail-list-scroll', 'window'].sort());
  assert.deepEqual(keys('mailbox', { ...mail }, {}), before, 'the same view gives the same keys');
  const other = keys('mailbox', { ...mail, currentConversation: { thread: 'boss', id: 'm-2' } }, {});
  assert.equal(other['.mail-list-scroll'], before['.mail-list-scroll'], 'another thread keeps the list scroll');
  assert.notEqual(other['.mail-conversation-scroll'], before['.mail-conversation-scroll'], 'another thread starts at its own top');
  assert.notEqual(keys('mailbox', { ...mail, folder: 'done' }, {})['.mail-list-scroll'], before['.mail-list-scroll'], 'another folder starts at the top');
  assert.deepEqual(Object.keys(keys('chat', {}, { thread: 'boss' })).sort(), ['.chat-list-scroll', 'window']);
  assert.deepEqual(keys('overview', mail, {}), {});

  const renderBody = body('render(force = false)');
  assert.match(renderBody, /const scroll = captureScroll\(route\);[\s\S]*\$app\.innerHTML = html;[\s\S]*restoreScroll\(route, scroll\);/);
  assert.match(renderBody, /mailRestoreDrafts\(focusId, caret\)/, 'the Mailbox keeps the caret in the reply box');
});

test('render patches the Mailbox and the Chat in place after the first mount', () => {
  const renderBody = body('render(force = false)');
  for (const id of ['projects', 'board', 'mailbox', 'chat', 'analytics']) assert.ok(KEYED_ROUTES.includes(id), `the registry keys ${id}`);
  assert.match(renderBody, /if \(KEYED_ROUTES\.includes\(route\) && lastRoute === route\) patchHtml\(\$app, html\);\n\s*else \$app\.innerHTML = html;/);
});

test('Mailbox rows, Chat rows, bubbles, and the scroll regions carry a data-key', () => {
  assert.match(body('chatRow(item)'), /<li class="chat-item[^"]*"[^>]*data-key="chat:\$\{esc\(item\.thread\)\}"/);
  assert.match(body('chatBubble(record, startOfRun = false)'), /data-key="msg:\$\{esc\(record\.id\)\}"/);
  assert.match(body('chatConversationView()'), /class="chat-scroll" data-key="chat-scroll:\$\{esc\(chat\.thread\)\}"/);
  assert.match(body('chatView(s)'), /class="chat-list-scroll" data-key="chat-list-scroll"/);
  assert.match(body('mailboxView(s)'), /class="mail-list-scroll" data-key="mail-list-scroll"/);
  assert.match(body('mailConversationView(s)'), /class="mail-conversation-scroll" data-key="mail-thread:\$\{esc\(selected\.thread\)\}:\$\{esc\(selected\.id\)\}"/);
});

test('the typed text is part of the rendered HTML, so a patch never empties a field', () => {
  assert.match(body('chatConversationView()'), /<textarea id="chat-draft"[^`]*>\$\{esc\(chat\.draft\)\}<\/textarea>/);
  assert.match(body('mailField(item, label, max, required)'), />\$\{esc\(mailDrafts\[item\.id\] \|\| ''\)\}<\/textarea>/);
});

test('a patched scroll region with a new key starts at the top', () => {
  const restore = body('restoreScroll(route, scroll)');
  assert.match(restore, /scroll\.keys\[selector\] !== key/);
  assert.match(restore, /element\.scrollTop = 0/);
});

test('short polls refresh the open Mailbox and Chat conversations with their lists', () => {
  const refreshMail = body('refreshMailboxConversation()');
  assert.match(refreshMail, /mailbox\.currentConversation/);
  assert.match(refreshMail, /loadMailboxConversation\(/);
  assert.match(refreshMail, /auto:\s*true/);
  const refreshChat = body('refreshChatThread()');
  assert.match(refreshChat, /chat\.thread/);
  assert.match(refreshChat, /loadChatThread\(/);
  assert.match(refreshChat, /auto:\s*true/);

  const resources = /const clientResources = \{([\s\S]*?)\n\};/.exec(app)?.[1] || '';
  assert.ok(!PAGE_READS.mailbox.includes('mailboxCounts'), 'the Mailbox page does not poll the same endpoint twice');
  assert.match(resources, /chats: \{ url: '\/api\/chats', intervalMs: 1000 \}/);
  assert.match(resources, /mailboxList: \{ intervalMs: 1000, run: refreshMailboxList \}/);
  assert.match(resources, /mailboxReads: \{ intervalMs: 1000, run: refreshMailboxConversation \}/);
  assert.match(resources, /chatReads: \{ intervalMs: 1000, run: refreshChatThread \}/);
  assert.match(resources, /agentChatRefresh: \{ intervalMs: 1000, run: \(\) => agentsRefresh\(\) \}/);
  assert.match(body('agentsRefresh()'), /agentsLoadList\(\{ auto: true \}\)/, 'the Agents list refreshes while its tab is open');
  assert.match(body('agentsRefresh()'), /agentsLoadPair\(\{ refresh: true \}\)/, 'the open agent pair refreshes too');
  assert.doesNotMatch(app, /clientStore\.subscribeEvent\('message'/, 'messaging data uses the short poll only');
  assert.match(app, /clientStore\.subscribe\('mailboxCounts',[\s\S]*?state\.mailbox = value\.mailbox/);
  assert.match(body('loadMailbox(auto = false)'), /state\.mailbox = result\.mailbox/);
});

test('returning to a visible page refreshes all current reads and its open message view', () => {
  const handler = body('refreshOnResume()');
  assert.match(handler, /document\.hidden/);
  assert.match(handler, /clientStore\.refreshPage\(currentRoute\(\)\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', refreshOnResume\)/);
  assert.match(app, /window\.addEventListener\('online', refreshOnResume\)/);
});

test('Owner sends show a sending state, a sent state, delivery, and failure', () => {
  const delivery = body('mailDeliveryState(m)');
  assert.match(delivery, /m\.status === 'sending'/);
  assert.match(delivery, /Sent\. Waiting for delivery\./);
  assert.match(delivery, /m\.status === 'sent'/);
  assert.match(delivery, /m\.status === 'failed'/);
  assert.match(body('mailPendingMessage(thread, text, attached)'), /status: 'sending'/);
  assert.match(body('mailSendReply(form)'), /mailPendingMessage\(/);
  assert.match(body('mailSendNewMessage(form)'), /mailPendingMessage\(/);
  assert.match(body('chatSend(retry = null)'), /status: 'sending'/);
});

test('failed Mailbox messages survive polls and have Retry and Clear controls', () => {
  assert.match(app, /const mailbox = \{[^}]*failed: \[\]/);
  assert.match(body('loadMailbox(auto = false)'), /sent: mailboxMergeFailures\(result\.sent \|\| \[\]\)/);
  assert.match(body('loadMailboxConversation(thread, conversation, { auto = false } = {})'), /mailboxMergeFailures\(result\.messages, \{ thread, conversation \}\)/);
  assert.match(body('mailConversationMessage(s, record, barItem)'), /data-mail-retry=/);
  assert.match(body('mailConversationMessage(s, record, barItem)'), /data-mail-failed-clear=/);
  assert.match(body('mailSendReply(form)'), /mailRememberFailure\(pending\)/);
  assert.match(body('mailSendNewMessage(form)'), /mailRememberFailure\(pending\)/);
  const retry = body('mailRetryMessage(id)');
  assert.match(retry, /mailbox\.failed/);
  assert.match(retry, /clientId: pending\.clientId/);
  assert.match(retry, /mailbox\.failed = mailbox\.failed\.filter/);
  assert.match(app, /\[data-mail-retry\]/);
  assert.match(app, /\[data-mail-failed-clear\]/);
});

test('all Owner message POSTs carry one client id for idempotent retry', () => {
  for (const signature of ['sendMessage(body, question, clear = false)', 'mailSendReply(form)', 'mailSendNewMessage(form)', 'mailSend(item, text, question)', 'chatSend(retry = null)', 'chatSendAction(record, text)']) {
    assert.match(body(signature), /clientId:/, signature);
  }
  assert.match(body('mailPendingMessage(thread, text, attached)'), /clientId/);
});

test('Chat pending messages stay with their thread and stale responses cannot replace the open thread', () => {
  assert.match(app, /pending: \{\}/, 'pending messages are keyed by thread');
  assert.match(body('chatConversationView()'), /chatPendingFor\(chat\.thread\)/);
  assert.doesNotMatch(body('chatSyncLocation()'), /chat\.pending\s*=\s*\{\s*\}/);
  assert.match(body('chatUpsertRecord(record)'), /if \(chat\.thread !== record\.thread\) return/);
  assert.match(body('loadChatThread(thread, { older = false, auto = false } = {})'), /chat\[requestKey\] === request/);
  const send = body('chatSend(retry = null)');
  assert.match(send, /retry\?\.thread \|\| chat\.thread/);
  assert.match(send, /chat\.pending\[thread\]/);
  assert.match(send, /if \(chat\.thread === thread\) \{[\s\S]*?chatUpsertRecord\(result\.message\)/);
});

test('the Agent chart Messages button still opens the live dialog', () => {
  assert.match(app, /data-messages-thread="\$\{esc\(thread\)\}"/);
  assert.match(app, /function openMessages\(thread, name\)/);
  assert.match(app, /e\.target\.closest\?\.\('\[data-messages-thread\]'\)/);
});

test('Needs you uses one count source for the menu folder, page heading, and badge', () => {
  const count = body('mailboxActionCount(s)');
  assert.match(count, /needsAction \?\? s\?\.mailbox\?\.open \?\? mailbox\.needsYou\.length/);
  assert.match(body('syncMailboxFolderMenu(route, s)'), /'needs-you': mailboxActionCount\(s\)/);
  assert.match(body('mailboxView(s)'), /headerCount = folder === 'needs-you' \? mailboxActionCount\(s\)/);
  assert.match(app, /'needs-action': mailboxActionCount\(s\)/);
});

test('automatic Agent list and pair refreshes respect the same quiet window', () => {
  assert.match(body('agentsLoadList({ auto = false } = {})'), /if \(auto\) autoRender\(\); else render\(\)/);
  assert.match(body('agentsLoadPair({ older = false, refresh = false } = {})'), /if \(refresh\) autoRender\(\); else render\(\)/);
});

test('opening another Mailbox thread is not blocked by an older in-flight read', () => {
  const load = body('loadMailboxConversation(thread, conversation, { auto = false } = {})');
  assert.match(load, /if \(mailbox\.conversationLoading && mailbox\.conversationRequest\?\.key === key\) return/);
  assert.match(load, /const request = \{ key \}/);
  assert.match(load, /mailbox\.conversationRequest !== request/);
  assert.match(load, /mailbox\.conversationRequest === request/);
});
