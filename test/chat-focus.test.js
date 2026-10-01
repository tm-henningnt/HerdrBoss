// Chat must leave the phone keyboard closed until the Owner chooses the composer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { chatKeyboardOpen, chatShouldStickToBottom } = await import('../public/app-view.js');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function sourceBlock(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source contains ${start} before ${end}`);
  return app.slice(from, to);
}

test('the Chat draft receives focus only from the Owner, and Back still restores the chat row', () => {
  const restore = sourceBlock('function chatRestoreView(view)', '// The button follows the scroll position');
  const send = sourceBlock('async function chatSend(retry = null)', '// One write path.');
  const open = sourceBlock('function openChat(thread)', 'function closeChat()');

  assert.doesNotMatch(app, /<textarea[^>]*data-chat-draft[^>]*\bautofocus\b/i);
  assert.doesNotMatch(app, /<textarea[^>]*\bautofocus\b[^>]*data-chat-draft/i);
  assert.doesNotMatch(restore, /\bfield\.focus\s*\(/, 'a state refresh does not focus the composer');
  assert.doesNotMatch(send, /(?:querySelector\(['"]\[data-chat-draft\]['"]\)|\bfield)\??\.focus\s*\(/, 'sending does not refocus the composer');
  assert.doesNotMatch(open, /chat\.focus\s*=\s*['"]composer['"]/, 'opening a thread does not request composer focus');
  assert.match(restore, /\[data-chat-open=.*?\.focus\s*\(/s, 'Back keeps focus on the thread row');
});

test('the keyboard state changes only when the visual viewport is over 150 px shorter', () => {
  assert.equal(typeof chatKeyboardOpen, 'function');
  assert.equal(chatKeyboardOpen(852, 702), false, '150 px is not enough');
  assert.equal(chatKeyboardOpen(852, 701), true, '151 px means the keyboard is open');
  assert.equal(chatKeyboardOpen(852, 852), false, 'the keyboard is closed');
});

test('the viewport resize follows the bottom only when the message log was within 40 px', () => {
  assert.equal(typeof chatShouldStickToBottom, 'function');
  assert.equal(chatShouldStickToBottom({ scrollHeight: 1200, scrollTop: 560, clientHeight: 600 }), true);
  assert.equal(chatShouldStickToBottom({ scrollHeight: 1200, scrollTop: 559, clientHeight: 600 }), false);
  assert.equal(chatShouldStickToBottom({ scrollHeight: 1200, scrollTop: 599, clientHeight: 600 }), true);
  assert.match(app, /if \(scroller && chatShouldStickToBottom\(scroller\)\) chatStickToBottom = true/);
  assert.match(app, /if \(chatStickToBottom && chatPhoneOpen\)[\s\S]*?scroller\.scrollTop = scroller\.scrollHeight/);
});

test('the phone Chat follows the visual viewport and sets a small composer bottom padding while the keyboard is open', () => {
  const viewport = sourceBlock('const scheduleChatViewport = () => {', 'const onViewport = (event) => {');
  const phoneStart = css.indexOf('body.app-view main { position: fixed');
  assert.ok(phoneStart >= 0, 'style.css has a phone app view section');
  const phone = css.slice(phoneStart);

  assert.match(app, /addEventListener\(['"]resize['"],\s*onViewport/);
  assert.match(app, /addEventListener\(['"]scroll['"],\s*onViewport/);
  assert.match(app, /addEventListener\(['"]focusin['"]/);
  assert.match(app, /addEventListener\(['"]focusout['"]/);
  assert.match(viewport, /requestAnimationFrame\(/);
  assert.match(viewport, /setProperty\(['"]--vv-top['"]/);
  assert.match(viewport, /setProperty\(['"]--vvh['"]/);
  assert.match(phone, /\.chat-layout\s*\{[^}]*position:\s*fixed[^}]*top:\s*max\(var\(--vv-top,[^)]*\),\s*0px\)[^}]*height:\s*var\(--vvh/);
  assert.match(phone, /\.chat-composer\s*\{[^}]*var\(--chat-bottom-inset,\s*env\(safe-area-inset-bottom\)\)/);
  assert.match(phone, /body\.chat-keyboard-open \.chat-composer\s*\{[^}]*padding-bottom:\s*6px/);
  assert.match(css, /\.chat-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
});
