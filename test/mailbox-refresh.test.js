import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function body(signature) {
  const match = new RegExp(`function ${signature.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(app);
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
  assert.doesNotMatch(refresh, /^\s*lastRender = '';/m, 'refreshExtras clears lastRender only through refreshForcesRender');
  assert.match(refresh, /if \(refreshForcesRender\(location\.pathname\)\) lastRender = '';/);
});

test('an automatic render waits 3 seconds after the last Owner input or scroll', () => {
  const OWNER_QUIET_MS = Number(/const OWNER_QUIET_MS = (\d+);/.exec(app)?.[1]);
  assert.equal(OWNER_QUIET_MS, 3000);
  const wait = new Function('OWNER_QUIET_MS', 'lastActiveAt', 'now', body('ownerQuietWait(lastActiveAt, now)'));
  assert.equal(wait(OWNER_QUIET_MS, 0, 100000), 0, 'no recent input');
  assert.equal(wait(OWNER_QUIET_MS, 100000, 100500), 2500);
  assert.equal(wait(OWNER_QUIET_MS, 100000, 103000), 0);

  // The state stream, the 10-second tick, and the 30-second refresh use the waiting render.
  assert.match(app, /es\.addEventListener\('state', \(e\) => \{\n\s*state = JSON\.parse\(e\.data\);\n\s*autoRender\(\);/);
  assert.match(app, /setInterval\(autoRender, 10000\);/);
  assert.match(body('refreshExtras()'), /\n\s*autoRender\(\);/);
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
  assert.match(renderBody, /const KEYED_ROUTES = \['projects', 'board', 'mailbox', 'chat', 'analytics'\];|KEYED_ROUTES\.includes\(route\) && lastRoute === route\) patchHtml\(\$app, html\)/);
  assert.match(app, /const KEYED_ROUTES = \['projects', 'board', 'mailbox', 'chat', 'analytics'\];/);
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
