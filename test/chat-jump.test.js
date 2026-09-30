// The jump-to-newest button of the Chat conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocument, find, byKey } from './fake-dom.js';

const { chatJumpBadge, chatJumpButtonHtml, chatJumpHtml, chatAtBottom, chatJumpScroll } = await import('../public/chat-jump.js');
const { patchHtml } = await import('../public/keyed.js');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const icon = (name) => `<svg data-icon="${name}"></svg>`;

test('the badge shows the unread count, caps at 99+, and is absent for zero', () => {
  assert.equal(chatJumpBadge(0), '');
  assert.equal(chatJumpBadge(undefined), '');
  assert.equal(chatJumpBadge(1), '1');
  assert.equal(chatJumpBadge(99), '99');
  assert.equal(chatJumpBadge(100), '99+');
  assert.equal(chatJumpBadge(2500), '99+');
});

test('the button is icon only and has the accessible name Jump to the newest message', () => {
  const html = chatJumpButtonHtml({ visible: true, unread: 0, icon });
  assert.match(html, /^<button type="button" class="chat-jump"[^>]*data-chat-jump[^>]*aria-label="Jump to the newest message"/);
  assert.match(html, /<svg data-icon="down"><\/svg>/);
  assert.doesNotMatch(html, /new message[s]?</i, 'no visible text label');
  assert.doesNotMatch(html, /chat-jump-badge/, 'no badge without unread messages');
  assert.doesNotMatch(html, /\shidden[\s>]/, 'visible when the list is not at the bottom');
  const text = html.replace(/<[^>]*>/g, '');
  assert.equal(text, '', 'the button holds no text');
});

test('the button shows the unread count in a badge and caps it at 99+', () => {
  assert.match(chatJumpButtonHtml({ visible: true, unread: 3, icon }), /<span class="chat-jump-badge" aria-hidden="true">3<\/span>/);
  assert.match(chatJumpButtonHtml({ visible: true, unread: 142, icon }), /<span class="chat-jump-badge" aria-hidden="true">99\+<\/span>/);
});

test('the button is hidden when the list is at the bottom', () => {
  assert.match(chatJumpButtonHtml({ visible: false, unread: 0, icon }), /\shidden[\s>]/);
  assert.match(chatJumpButtonHtml({ visible: false, unread: 5, icon }), /\shidden[\s>]/, 'an unread count does not show the button at the bottom');
});

test('the bottom test has a 48 px tolerance', () => {
  assert.equal(chatAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }), true);
  assert.equal(chatAtBottom({ scrollHeight: 1000, scrollTop: 460, clientHeight: 500 }), true);
  assert.equal(chatAtBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), false);
});

test('a click scrolls smoothly to the newest message, and without animation for reduced motion', () => {
  const calls = [];
  const scroller = { scrollHeight: 1200, scrollTo: (options) => calls.push(options) };
  chatJumpScroll(scroller, false);
  chatJumpScroll(scroller, true);
  assert.deepEqual(calls, [{ top: 1200, behavior: 'smooth' }, { top: 1200, behavior: 'auto' }]);
});

test('a keyed update keeps the button node, its focus, and updates only the badge and the visibility', () => {
  globalThis.document = createDocument();
  const root = document.html(chatJumpHtml({ visible: true, unread: 2, icon }));
  const button = find(root, (n) => n.getAttribute('data-chat-jump') !== null);
  button.focus();
  patchHtml(root, chatJumpHtml({ visible: true, unread: 3, icon }));
  const same = find(root, (n) => n.getAttribute('data-chat-jump') !== null);
  assert.equal(same, button, 'the button node stays');
  assert.equal(document.activeElement, button, 'the focus stays');
  assert.equal(find(root, (n) => n.getAttribute('class') === 'chat-jump-badge').textContent, '3');
  patchHtml(root, chatJumpHtml({ visible: false, unread: 0, icon }));
  assert.equal(find(root, (n) => n.getAttribute('data-chat-jump') !== null), button);
  assert.ok(button.hasAttribute('hidden'), 'the button hides at the bottom');
  assert.equal(find(root, (n) => n.getAttribute('class') === 'chat-jump-badge'), null, 'the badge goes with the count');
  patchHtml(root, chatJumpHtml({ visible: true, unread: 0, icon }));
  assert.equal(button.hasAttribute('hidden'), false, 'the button shows again');
});

test('the UI renders the button in place of the large new message object', () => {
  assert.doesNotMatch(app, /chat-new-pill/);
  assert.doesNotMatch(app, /new message\$\{chat\.unseen/);
  assert.match(app, /from '\.\/chat-jump\.js'/);
  assert.match(app, /chatJumpHtml\(\{ visible: chat\.scroll !== null, unread: chat\.unseen, icon: appIcon \}\)/);
  assert.match(app, /closest\?\.\('\[data-chat-jump\]'\)/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /down: '<path/);
  assert.doesNotMatch(css, /\.chat-new-pill/);
});

test('the button sits at the bottom right of the message list with a 44 px touch target on the phone', () => {
  assert.match(css, /\.chat-jump-anchor\s*\{[^}]*position:\s*relative[^}]*height:\s*0/);
  assert.match(css, /\.chat-jump\s*\{[^}]*position:\s*absolute[^}]*bottom:[^}]*right:\s*max\(/);
  assert.match(css, /\.chat-jump\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.chat-jump::before\s*\{[^}]*border-radius:\s*50%/, 'a smaller visual circle');
  assert.match(css, /@media \(max-width: 760px\)[^{]*\{[\s\S]*?\.chat-jump\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
});
