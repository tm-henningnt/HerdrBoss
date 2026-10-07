import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routes = await import('../public/routes.js');
const shell = await import('../public/shell.js');
const { ROUTES, ROUTE_IDS, NAV_LABEL, MENU_ROUTES, DRAWER_ROUTES, APP_VIEW_ROUTES, KEYED_ROUTES, HELP_FILES, HELP_INLINE, matchRoute, helpRoute, resolveAlias, taskFromQuery, HASH } = routes;
const { mountMenu, syncMenu, drawerLinksHtml, readLocation } = shell;
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const PAGES = ['overview', 'fleet', 'board', 'reviews', 'agents', 'projects', 'browsers', 'allocation', 'analytics', 'settings', 'docs', 'mailbox', 'chat', 'add-host'];

test('the registry names the 14 routes once, each with a path and a label', () => {
  assert.deepEqual(ROUTE_IDS, PAGES);
  assert.equal(new Set(ROUTES.map((r) => r.path)).size, 14);
  assert.deepEqual(NAV_LABEL, { overview: 'Overview', fleet: 'Fleet', board: 'Board', reviews: 'Reviews', agents: 'Agents', projects: 'Projects', browsers: 'Browsers', allocation: 'Allocation', analytics: 'Analytics', settings: 'Settings', docs: 'Docs', mailbox: 'Mailbox', chat: 'Chat', 'add-host': 'Add a host' });
});

test('each of the 14 routes matches its address', () => {
  const table = [
    ['/', 'overview'], ['/unknown', 'overview'], ['/fleet', 'fleet'], ['/fleet/add-host', 'add-host'], ['/board', 'board'],
    ['/reviews', 'reviews'], ['/reviews/shop/pack-1', 'reviews'], ['/reviews/shop/pack-1/summary', 'reviews'], ['/agents', 'agents'], ['/projects', 'projects'], ['/projects/shop', 'projects'],
    ['/projects/shop/', 'projects'], ['/browsers', 'browsers'], ['/allocation', 'allocation'], ['/analytics', 'analytics'], ['/settings', 'settings'],
    ['/docs', 'docs'], ['/docs/cli', 'docs'], ['/docs/help/board', 'docs'], ['/mailbox', 'mailbox'], ['/chat', 'chat'],
  ];
  for (const [path, id] of table) assert.equal(matchRoute(path).id, id, path);
  assert.deepEqual(new Set(table.map(([, id]) => id)), new Set(PAGES));
  assert.deepEqual(matchRoute('/projects/my%20app'), { id: 'projects', slug: 'my app' });
  assert.deepEqual(matchRoute('/projects'), { id: 'projects', slug: null });
});

test('the three aliases give their new address', () => {
  assert.deepEqual(resolveAlias('/p/shop'), { url: '/projects/shop', pendingHash: null });
  assert.deepEqual(resolveAlias('/p/shop/'), { url: '/projects/shop', pendingHash: null });
  assert.deepEqual(resolveAlias('/organization'), { url: '/agents?view=chart', pendingHash: null });
  assert.deepEqual(resolveAlias('/logs', ''), { url: '/analytics#activity', pendingHash: 'activity' });
  assert.deepEqual(resolveAlias('/logs', '#guidance'), { url: '/#overview-guidance', pendingHash: 'overview-guidance' });
  assert.equal(HASH.guidance, 'overview-guidance');
  for (const path of ['/', '/projects/shop', '/agents', '/p', '/p/a/b']) assert.equal(resolveAlias(path), null, path);
});

test('the task query selects a task only on a project page', () => {
  assert.equal(taskFromQuery('/projects/shop', '?task=t-4'), 't-4');
  assert.equal(taskFromQuery('/projects/shop/', '?task=t-4'), 't-4');
  assert.equal(taskFromQuery('/projects/shop', ''), null);
  assert.equal(taskFromQuery('/projects', '?task=t-4'), null);
  assert.equal(taskFromQuery('/board', '?task=t-4'), null);
});

test('readLocation applies an alias, then reads the task and drops its query', () => {
  const make = (url) => {
    const loc = {};
    const set = (u) => { const x = new URL(u, 'http://x'); Object.assign(loc, { pathname: x.pathname, search: x.search, hash: x.hash }); };
    set(url);
    const calls = [];
    return { loc, calls, hist: { replaceState: (_s, _t, u) => { calls.push(u); set(u); } } };
  };
  let w = make('/p/shop?task=t-1#x');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'projects', slug: 'shop', pendingHash: null, task: null });
  assert.deepEqual(w.calls, ['/projects/shop']);
  w = make('/projects/shop?task=t-9#card');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'projects', slug: 'shop', pendingHash: null, task: { slug: 'shop', id: 't-9' } });
  assert.deepEqual(w.calls, ['/projects/shop#card']);
  w = make('/logs#guidance');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'overview', slug: null, pendingHash: 'overview-guidance', task: null });
  w = make('/logs');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'analytics', slug: null, pendingHash: 'activity', task: null });
  w = make('/organization');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'agents', slug: null, pendingHash: null, task: null });
  assert.equal(w.loc.search, '?view=chart');
  w = make('/allocation#lease-project-browsers-9222');
  assert.deepEqual(readLocation(w.loc, w.hist), { route: 'allocation', slug: null, pendingHash: null, task: null });
  assert.deepEqual(w.calls, []);
});

test('the Help route follows the page, also for /p/<slug> and the Add a host page', () => {
  const table = [['/', 'overview'], ['/p/shop', 'projects'], ['/projects/shop', 'projects'], ['/reviews/shop/pack-1', 'reviews'], ['/docs/cli', 'docs'], ['/fleet/add-host', 'add-host'],
    ['/fleet', 'fleet'], ['/board', 'board'], ['/browsers', 'browsers'], ['/mailbox', 'mailbox'], ['/chat', 'chat'], ['/settings', 'settings'], ['/organization', 'overview'], ['/nothing', 'overview']];
  for (const [path, id] of table) assert.equal(helpRoute(path), id, path);
});

test('the Help sources split into five files and nine inline topics, as the app and docs/help hold them', () => {
  assert.deepEqual(HELP_FILES, ['fleet', 'board', 'browsers', 'docs', 'add-host']);
  assert.deepEqual([...HELP_INLINE].sort(), ['agents', 'allocation', 'analytics', 'chat', 'mailbox', 'overview', 'projects', 'reviews', 'settings']);
  const app = read('public/app.js');
  const help = app.slice(app.indexOf('const HELP = {'), app.indexOf('const helpFiles'));
  for (const id of HELP_INLINE) assert.match(help, new RegExp(`^  ${id}: \\[`, 'm'), `${id} has inline help`);
  for (const id of HELP_FILES) assert.ok(fs.existsSync(new URL(`../docs/help/${id}.md`, import.meta.url)), `${id} has docs/help/${id}.md`);
});

test('the phone shell and the keyed patch rules come from the registry', () => {
  assert.deepEqual(APP_VIEW_ROUTES, ['reviews', 'mailbox', 'chat']);
  assert.deepEqual(KEYED_ROUTES, ['fleet', 'board', 'reviews', 'projects', 'allocation', 'analytics', 'settings', 'mailbox', 'chat']);
});

test('the one menu host lists 11 routes in order and the phone drawer lists 8', () => {
  assert.deepEqual(MENU_ROUTES.map((r) => r.id), ['overview', 'fleet', 'board', 'reviews', 'agents', 'projects', 'browsers', 'allocation', 'analytics', 'settings', 'docs']);
  assert.deepEqual(DRAWER_ROUTES.map((r) => r.path), ['/', '/board', '/reviews', '/agents', '/projects', '/browsers', '/allocation', '/analytics']);
  const html = read('public/index.html');
  const nav = /<nav id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.doesNotMatch(nav, /data-nav=/, 'index.html holds no page link; the registry fills the menu');
  assert.match(nav, /id="roamgate-link"/);
  assert.equal((html.match(/id="primary-nav"/g) || []).length, 1);
});

function fakeNav() {
  const roamgate = { id: 'roamgate-link', dataset: {} };
  const children = [roamgate];
  const nav = {
    children,
    querySelector: (selector) => (selector === '#roamgate-link' ? roamgate : null),
    insertBefore: (node, before) => children.splice(children.indexOf(before), 0, node),
    querySelectorAll: () => children.filter((c) => c !== roamgate),
  };
  nav.ownerDocument = { createElement: () => { const attrs = {}; return { dataset: {}, attrs, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } }; } };
  return { nav, children, roamgate };
}

test('mountMenu fills the menu host and keeps Roamgate last', () => {
  const { nav, children, roamgate } = fakeNav();
  mountMenu(nav);
  assert.deepEqual(children.slice(0, -1).map((a) => [a.dataset.nav, a.href, a.textContent]), MENU_ROUTES.map((r) => [r.id, r.path, r.label]));
  assert.equal(children.at(-1), roamgate);
});

test('syncMenu sets the label and marks the current page; Add a host marks Fleet', () => {
  const { nav, children } = fakeNav();
  mountMenu(nav);
  const label = { textContent: '' };
  const current = () => children.filter((a) => a.attrs?.['aria-current'] === 'page').map((a) => a.dataset.nav);
  syncMenu({ nav, label, route: 'board' });
  assert.equal(label.textContent, 'Board');
  assert.deepEqual(current(), ['board']);
  syncMenu({ nav, label, route: 'add-host' });
  assert.equal(label.textContent, 'Add a host');
  assert.deepEqual(current(), ['fleet']);
  syncMenu({ nav, label, route: 'mailbox' });
  assert.equal(label.textContent, 'Mailbox');
  assert.deepEqual(current(), [], 'Mailbox has no menu entry');
});

test('the drawer links keep the eight pages and mark the current one', () => {
  const html = drawerLinksHtml('board');
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), DRAWER_ROUTES.map((r) => r.path));
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1);
  assert.match(html, /<a href="\/board" aria-current="page"><span>Board<\/span><\/a>/);
  assert.doesNotMatch(drawerLinksHtml('mailbox'), /aria-current/);
});

test('app.js reads the registry and keeps no second route table', () => {
  const app = read('public/app.js');
  assert.match(app, /from '\.\/routes\.js'/);
  assert.match(app, /from '\.\/shell\.js'/);
  assert.doesNotMatch(app, /const NAV_LABEL|const KEYED_ROUTES|const HELP_FILES|function currentRoute\(/);
  assert.doesNotMatch(app, /\['\/board', 'Board'\]/);
});
