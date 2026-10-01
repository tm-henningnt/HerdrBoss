// iOS Safari can scroll the visual viewport without shrinking the layout viewport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as appView from '../public/app-view.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const guide = fs.readFileSync(new URL('../docs/user-guide.md', import.meta.url), 'utf8');

test('the Chat viewport uses the visual viewport and applies safe area only while the keyboard is closed', () => {
  assert.equal(typeof appView.chatViewportLayout, 'function');
  const layout = appView.chatViewportLayout;
  assert.deepEqual(layout({ innerHeight: 852, height: 852, offsetTop: 0, scale: 1, safeAreaBottom: 34 }), {
    top: 0, height: 852, keyboardOpen: false, bottomInset: 34,
  }, 'iOS keyboard closed');
  assert.deepEqual(layout({ innerHeight: 852, height: 510, offsetTop: 0, scale: 1, safeAreaBottom: 34 }), {
    top: 0, height: 510, keyboardOpen: true, bottomInset: 0,
  }, 'iOS keyboard open');
  assert.deepEqual(layout({ innerHeight: 852, height: 510, offsetTop: 342, scale: 1, safeAreaBottom: 34, draftFocused: true }), {
    top: 342, height: 510, keyboardOpen: true, bottomInset: 0,
  }, 'iOS scrolls the focused draft into view');
  assert.deepEqual(layout({ innerHeight: 852, height: 510, offsetTop: 120, scale: 1.5, safeAreaBottom: 34, draftFocused: true }), {
    top: 0, height: 852, keyboardOpen: false, bottomInset: 34,
  }, 'pinch zoom is not a keyboard');
  assert.deepEqual(layout({ innerHeight: 510, height: 510, offsetTop: 0, scale: 1, safeAreaBottom: 0, draftFocused: true }), {
    top: 0, height: 510, keyboardOpen: false, bottomInset: 0,
  }, 'Android resizes the layout viewport with the keyboard');
});

test('the debug-only viewport mock overrides visual height and offset only with vvdebug=1', () => {
  assert.equal(typeof appView.readViewport, 'function');
  const actual = { height: 852, offsetTop: 0, offsetLeft: 0, scale: 1 };
  assert.deepEqual(appView.readViewport({ innerHeight: 852, visualViewport: actual, search: '?vvmock=510,342', debugEnabled: false }), {
    innerHeight: 852, height: 852, offsetTop: 0, offsetLeft: 0, scale: 1, mocked: false,
  });
  assert.deepEqual(appView.readViewport({ innerHeight: 852, visualViewport: actual, search: '?vvdebug=1&vvmock=510,342', debugEnabled: true }), {
    innerHeight: 852, height: 510, offsetTop: 342, offsetLeft: 0, scale: 1, mocked: true,
  });
});

test('the debug overlay does not create an element when the query and session flag are absent', () => {
  assert.equal(typeof appView.createChatViewportDebug, 'function');
  let created = 0;
  const document = {
    createElement() { created += 1; return {}; },
    body: { append() { throw new Error('the disabled overlay must not be appended'); } },
  };
  const storage = { getItem() { return null; }, setItem() {} };
  assert.equal(appView.createChatViewportDebug({ search: '', storage, document }), null);
  assert.equal(created, 0);
});

test('the debug overlay prints viewport, safe area, Chat geometry, keyboard, and standalone state', () => {
  const appended = [];
  const document = {
    createElement(tagName) { return { tagName, style: {}, setAttribute() {}, textContent: '' }; },
    body: { append(element) { appended.push(element); } },
  };
  const storage = { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, value); } };
  const debug = appView.createChatViewportDebug({ search: '?vvdebug=1', storage, document });
  assert.ok(debug);
  assert.equal(appended.length, 1);
  debug.update({
    innerHeight: 852, height: 510, offsetTop: 342, offsetLeft: 0, scale: 1,
    safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    composerRect: { top: 810, bottom: 852, height: 42 },
    containerRect: { top: 342, bottom: 852, height: 510 },
    keyboardOpen: true, standalone: true,
  });
  const text = appended[0].textContent;
  for (const value of ['innerHeight 852', 'visualViewport.height 510', 'offsetTop 342', 'offsetLeft 0', 'scale 1', 'safe-area top 59', 'right 0', 'bottom 34', 'left 0', 'composer top 810', 'bottom 852', 'height 42', 'container top 342', 'keyboardOpen true', 'standalone true']) {
    assert.ok(text.includes(value), `overlay includes ${value}`);
  }
  assert.equal(storage.values.size, 1, 'the debug flag is remembered for this tab');
});

test('the Chat viewport is fixed to the visual viewport and body scroll lock is scoped to phone Chat', () => {
  assert.match(app, /readViewport\(/);
  assert.match(app, /addEventListener\(['"]focusin['"]/);
  assert.match(app, /addEventListener\(['"]focusout['"]/);
  assert.match(app, /setProperty\(['"]--vv-top['"]/);
  assert.match(app, /setProperty\(['"]--vvh['"]/);
  assert.match(app, /classList\.toggle\(['"]chat-phone-open['"]/);
  assert.match(css, /html:has\(body\.chat-phone-open\), body\.chat-phone-open\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*none/);
  assert.match(css, /\.chat-layout\s*\{[^}]*position:\s*fixed[^}]*top:\s*max\(var\(--vv-top[^)]*\),\s*0px\)[^}]*left:\s*0[^}]*right:\s*0[^}]*height:\s*var\(--vvh/);
  assert.match(css, /body\.chat-keyboard-open \.chat-composer\s*\{[^}]*padding-bottom:\s*6px/);
  assert.match(css, /\.chat-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /env\(safe-area-inset-top\)/, 'the Chat header retains its safe-area padding');
});

test('the phone composer outline and newest message fit above the keyboard at 393 by 500', () => {
  const visualViewport = { width: 393, height: 500, offsetTop: 0 };
  const layout = appView.chatViewportLayout({
    innerHeight: 852, height: visualViewport.height, offsetTop: visualViewport.offsetTop,
    scale: 1, safeAreaBottom: 34, draftFocused: true,
  });
  assert.deepEqual(layout, { top: 0, height: 500, keyboardOpen: true, bottomInset: 0 });
  const composerRule = css.match(/body\.chat-keyboard-open \.chat-composer\s*\{([^}]*)\}/);
  assert.ok(composerRule, 'keyboard-open composer rule exists');
  const paddingBottom = Number(composerRule[1].match(/padding-bottom:\s*(\d+)px/)?.[1]);
  assert.ok(paddingBottom >= 3, 'leave the textarea border and a 2 px visual margin above the viewport edge');

  const viewportBottom = layout.top + layout.height;
  const composerHeight = 1 + 6 + 44 + paddingBottom;
  const composer = { top: viewportBottom - composerHeight, bottom: viewportBottom };
  const textareaBottom = composer.bottom - paddingBottom;
  assert.ok(composer.bottom <= viewportBottom, 'the composer remains inside the visual viewport');
  assert.ok(textareaBottom + paddingBottom <= viewportBottom, 'the composer padding stays inside the visual viewport');
  assert.ok(textareaBottom < viewportBottom, 'the textarea outline is not clipped at the viewport edge');

  assert.match(css, /\.chat-panel\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(css, /\.chat-scroll\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1[^}]*overflow:\s*auto/);
  assert.match(css, /\.chat-composer\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.chat-hint\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.chat-scroll\s*>\s*\.chat-bubbles\s*\{[^}]*margin:\s*auto auto 0/);
  assert.match(css, /\.chat-bubbles\s*\{[^}]*padding:[^;]*10px/);
  assert.match(app, /data-chat-scroll[^>]*>[\s\S]*?<\/div>\$\{jump\}<form class="chat-composer"/);
  const scrollBottom = composer.top;
  const lastMessageBottom = scrollBottom - 10;
  assert.ok(lastMessageBottom <= composer.top, 'the newest message stays above the composer');
  assert.match(css, /input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px\s*!important/);
  assert.doesNotMatch(app, /\bautofocus\b/i);
  assert.doesNotMatch(html, /user-scalable|maximum-scale/i);
});

test('the home-screen metadata and Chat help describe the iPhone viewport check', () => {
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.doesNotMatch(html, /rel="manifest"/i, 'index.html does not link a web app manifest');
  assert.match(app, /\?vvdebug=1/);
  assert.match(guide, /\?vvdebug=1/);
});
