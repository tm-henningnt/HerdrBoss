// The Mailbox and the Chat have no menu entry. The top-bar icons lead to them.
import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { MENU_ROUTES, DRAWER_ROUTES, ROUTE_IDS } = await import('../public/routes.js');
const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const review = read('review.js');
const guide = readUserGuide();

const nav = /<nav id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] || '';
// The registry (routes.js) fills the menu host. The first nine entries are the pages of the Owner order; Settings and Docs follow.
const navKeys = MENU_ROUTES.map((r) => r.id).slice(0, 9);
const icons = [...html.matchAll(/<a class="top-icon[^"]*" data-top-icon="([^"]+)"[^>]*href="([^"]+)" aria-label="([^"]+)"/g)].map((m) => ({ name: m[1], href: m[2], label: m[3] }));

test('the desktop menu has no Mailbox and no Chat entry and keeps the other entries in order', () => {
  assert.deepEqual(navKeys, ['overview', 'fleet', 'board', 'reviews', 'agents', 'projects', 'browsers', 'allocation', 'analytics']);
  assert.doesNotMatch(nav, /href="\/mailbox"|href="\/chat"|data-chat-badge/);
});

test('the phone drawer has no Mailbox and no Chat entry and keeps the other entries in order', () => {
  const hrefs = DRAWER_ROUTES.map((r) => r.path);
  assert.deepEqual(hrefs, ['/', '/board', '/reviews', '/agents', '/projects', '/browsers', '/allocation', '/analytics']);
});

test('the top bar has a Chat icon, an Updates icon, and a Needs you icon with the right links and names', () => {
  assert.deepEqual(icons, [
    { name: 'chat', href: '/chat', label: 'Chat' },
    { name: 'mail', href: '/mailbox?folder=updates', label: 'Updates' },
    { name: 'needs-action', href: '/mailbox?folder=needs-you', label: 'Needs you' },
  ]);
});

test('the top-bar icon of the open page has the current state', () => {
  assert.match(app, /aria-current/);
  assert.match(app, /function topIconCurrent\(/);
  assert.match(app, /querySelectorAll\('\[data-top-icon\]'\)/);
  assert.doesNotMatch(app, /\[data-nav="mailbox"\]|\[data-nav="chat"\]|\[data-mailbox-badge\]|\[data-chat-badge\]/);
  assert.doesNotMatch(html, /data-mailbox-badge/);
  assert.match(css, /\.top-icon\[aria-current="page"\]/);
});

test('at phone width each top-bar icon is at least 44px wide and high, also in the last rule that sets the width', () => {
  const rules = [];
  const top = (text, media) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) rules.push({ media, selector: m[1].trim(), body: m[2] });
  };
  const outer = /@media ([^{]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  let stripped = css;
  let mm;
  const medias = [];
  while ((mm = outer.exec(css))) medias.push({ head: mm[1], body: mm[2], index: mm.index, end: outer.lastIndex });
  // Keep the source order: a top-level rule and a media rule sort by position.
  const ordered = [];
  let pos = 0;
  for (const b of medias) { ordered.push({ media: '', text: stripped.slice(pos, b.index) }); ordered.push({ media: b.head, text: b.body }); pos = b.end; }
  ordered.push({ media: '', text: stripped.slice(pos) });
  for (const o of ordered) top(o.text, o.media);
  const phone = (media) => /max-width:\s*(760|767|7\d\d)px/.test(media) && !/min-width/.test(media);
  for (const prop of ['width', 'height']) {
    const last = rules.filter((r) => phone(r.media) && r.selector.split(',').some((s) => /^(\.top-icons )?\.top-icon$/.test(s.trim())) && new RegExp(`(^|;|\\s)${prop}:`).test(r.body)).pop();
    assert.ok(last, `a phone rule sets the icon ${prop}`);
    const value = new RegExp(`(?:^|;|\\s)${prop}:\\s*(\\d+)px`).exec(last.body)?.[1];
    assert.ok(Number(value) >= 44, `the last phone rule sets the icon ${prop} to ${value}px`);
  }
});

test('every page route has at least one link', () => {
  const routes = ROUTE_IDS.filter((id) => !['docs', 'add-host'].includes(id));
  assert.ok(routes.includes('mailbox') && routes.includes('chat') && routes.includes('settings'));
  const paths = new Set();
  for (const m of html.matchAll(/<a [^>]*href="([^"?#]+)/g)) paths.add(m[1].replace(/^\/$/, 'overview').replace(/^\//, ''));
  for (const route of MENU_ROUTES) paths.add(route.id);
  for (const route of routes) assert.ok(paths.has(route), `the route ${route} has a link`);
  // The review packs open from the Mailbox.
  assert.match(app, /reviewOpenLinkHtml\(item, esc\)/);
});

test('the help text and the user guide describe the menu without Mailbox and Chat', () => {
  assert.doesNotMatch(guide, /The menu entry is after \*\*Mailbox\*\*/);
  assert.match(guide, /The menu has no Mailbox entry and no Chat entry/);
  assert.match(app, /The menu has no Mailbox entry and no Chat entry/);
});

test('the app-view bar of the Mailbox, the Chat, and the Reviews holds the three icons on a phone', () => {
  assert.match(app, /function appBarIcons\(/);
  // The three bars call the helper: the Mailbox list, the Chat list, and the Reviews list through the helper object.
  assert.match(app, /class="app-bar mail-list-bar">\$\{appMenuButton\(s, 'mailbox'\)\}<h1>[\s\S]*?<\/h1>\$\{appBarIcons\(s, 'mailbox'\)\}/);
  assert.match(app, /class="app-bar chat-list-head">\$\{appMenuButton\(s, 'chat'\)\}<h1>[\s\S]*?<\/h1>\$\{appBarIcons\(s, 'chat'\)\}/);
  assert.match(app, /barIcons: appBarIcons\(s, 'reviews'\)/);
  assert.match(review, /<h1>Reviews<\/h1>\$\{h\.barIcons \|\| ''\}/);
  // The helper builds the same three links, with the count, the faded state, the name, and the current state.
  const helper = /function appBarIcons\([\s\S]*?\n\}\n/.exec(app)?.[0] || '';
  for (const href of ['/chat', '/mailbox?folder=updates', '/mailbox?folder=needs-you']) assert.ok(helper.includes(href) || app.includes(`'${href}'`), `the link ${href}`);
  assert.match(helper, /data-top-icon=/);
  assert.match(helper, /data-empty=/);
  assert.match(helper, /aria-label=/);
  assert.match(helper, /aria-current="page"/);
  assert.match(helper, /data-top-badge=/);
});

test('from each app view the other of the Mailbox and the Chat is one tap away, and the 320px bar keeps the icons', () => {
  const helper = /function appBarIcons\([\s\S]*?\n\}\n/.exec(app)?.[0] || '';
  assert.match(helper, /TOP_ICON_LINKS|\.map\(/);
  assert.match(app, /const TOP_ICON_LINKS = \{[^}]*chat: '\/chat'[^}]*mail: '\/mailbox\?folder=updates'[^}]*'needs-action': '\/mailbox\?folder=needs-you'/);
  // Off the phone the bar icons hide, because the page header has the icons.
  assert.match(css, /\.app-bar-icons \{[^}]*display: none/);
  assert.match(css, /@media \(max-width: 760px\) \{[^@]*\.app-bar-icons \{[^}]*display: flex/);
  // The icons never shrink and the title takes the rest: 4 targets of 44px fit in 320px.
  assert.match(css, /\.app-bar-icons \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.app-bar-icons \.top-icon \{[^}]*width: 44px/);
  assert.match(css, /\.app-bar-icons \.top-icon \{[^}]*min-width: 44px/);
});
