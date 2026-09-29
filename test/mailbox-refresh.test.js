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
  assert.deepEqual(Object.keys(before).sort(), ['.mail-conversation-scroll', '.mail-list-pane', 'window'].sort());
  assert.deepEqual(keys('mailbox', { ...mail }, {}), before, 'the same view gives the same keys');
  const other = keys('mailbox', { ...mail, currentConversation: { thread: 'boss', id: 'm-2' } }, {});
  assert.equal(other['.mail-list-pane'], before['.mail-list-pane'], 'another thread keeps the list scroll');
  assert.notEqual(other['.mail-conversation-scroll'], before['.mail-conversation-scroll'], 'another thread starts at its own top');
  assert.notEqual(keys('mailbox', { ...mail, folder: 'done' }, {})['.mail-list-pane'], before['.mail-list-pane'], 'another folder starts at the top');
  assert.deepEqual(Object.keys(keys('chat', {}, { thread: 'boss' })).sort(), ['.chat-list-pane', 'window']);
  assert.deepEqual(keys('overview', mail, {}), {});

  const renderBody = body('render(force = false)');
  assert.match(renderBody, /const scroll = captureScroll\(route\);[\s\S]*\$app\.innerHTML = html;[\s\S]*restoreScroll\(route, scroll\);/);
  assert.match(renderBody, /mailRestoreDrafts\(focusId, caret\)/, 'the Mailbox keeps the caret in the reply box');
});
