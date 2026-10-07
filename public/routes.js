// The route registry of the dashboard. It is the one place that names the pages.
// Each record holds the id, the canonical path, the menu label, the menu place, the Help source, and the phone-shell rule.
// To add a route, add one record here and a render branch in app.js. No DOM use, so the Node tests import it.
import { docsPageName } from './docs-view.js';
import { parseReviewPath } from './review.js';
import { HOST_GUIDE_PATH } from './host-guide-view.js';

// menu: the place in the main menu (1 is first), or null for no entry. drawer: the entry in the phone drawer of the Mailbox,
// the Reviews, and the Chat. help: 'inline' (HELP in app.js), 'file' (docs/help/<id>.md), or null (the Overview text).
// phone: the route fills the phone viewport. keyed: a render of the route patches the DOM in place.
export const ROUTES = [
  { id: 'overview', path: '/', label: 'Overview', menu: 1, drawer: true, help: 'inline' },
  { id: 'fleet', path: '/fleet', label: 'Fleet', menu: 2, help: 'file', keyed: true },
  { id: 'board', path: '/board', label: 'Board', menu: 3, drawer: true, help: 'file', keyed: true },
  { id: 'reviews', path: '/reviews', label: 'Reviews', menu: 4, drawer: true, help: 'inline', phone: true, keyed: true },
  { id: 'agents', path: '/agents', label: 'Agents', menu: 5, drawer: true, help: 'inline' },
  { id: 'projects', path: '/projects', label: 'Projects', menu: 6, drawer: true, help: 'inline', keyed: true },
  { id: 'browsers', path: '/browsers', label: 'Browsers', menu: 7, drawer: true, help: 'file' },
  { id: 'allocation', path: '/allocation', label: 'Allocation', menu: 8, drawer: true, help: 'inline', keyed: true },
  { id: 'analytics', path: '/analytics', label: 'Analytics', menu: 9, drawer: true, help: 'inline', keyed: true },
  { id: 'settings', path: '/settings', label: 'Settings', menu: 10, help: 'inline', keyed: true },
  { id: 'docs', path: '/docs', label: 'Docs', menu: 11, help: 'file' },
  { id: 'mailbox', path: '/mailbox', label: 'Mailbox', help: 'inline', phone: true, keyed: true },
  { id: 'chat', path: '/chat', label: 'Chat', help: 'inline', phone: true, keyed: true },
  { id: 'add-host', path: HOST_GUIDE_PATH, label: 'Add a host', help: 'file' },
];

export const ROUTE_IDS = ROUTES.map((route) => route.id);
export const routeById = (id) => ROUTES.find((route) => route.id === id) || null;
export const NAV_LABEL = Object.fromEntries(ROUTES.map((route) => [route.id, route.label]));
export const MENU_ROUTES = ROUTES.filter((route) => route.menu).sort((a, b) => a.menu - b.menu);
export const DRAWER_ROUTES = ROUTES.filter((route) => route.drawer);
export const APP_VIEW_ROUTES = ROUTES.filter((route) => route.phone).map((route) => route.id);
export const KEYED_ROUTES = ROUTES.filter((route) => route.keyed).map((route) => route.id);
export const HELP_FILES = ROUTES.filter((route) => route.help === 'file').map((route) => route.id);
export const HELP_INLINE = ROUTES.filter((route) => route.help === 'inline').map((route) => route.id);

// Pages that a plain /<id> path opens.
const PLAIN = ['board', 'mailbox', 'chat', 'allocation', 'settings', 'agents', 'browsers', 'analytics', 'fleet'];

// The fragments that a route reads.
export const HASH = {
  guidance: 'overview-guidance',
  activity: 'activity',
};

const PROJECT_PATH = /^\/projects\/([^/]+)\/?$/;

// The three aliases of old addresses: /p/<slug>, /organization, and /logs. An alias gives the address to show instead, or null.
// The old /p/<slug> link drops its query and fragment. pendingHash is the fragment that the page scrolls to after the render.
export function resolveAlias(pathname, hash = '') {
  const legacy = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (legacy) return { url: `/projects/${legacy[1]}`, pendingHash: null };
  if (pathname === '/organization') return { url: '/agents?view=chart', pendingHash: null };
  if (pathname === '/logs') {
    const pendingHash = hash === '#guidance' ? HASH.guidance : HASH.activity;
    return { url: hash === '#guidance' ? `/#${pendingHash}` : `/analytics#${pendingHash}`, pendingHash };
  }
  return null;
}

// The route of an address after the aliases: { id, slug }. slug is set on a project page.
export function matchRoute(pathname) {
  if (docsPageName(pathname) !== null) return { id: 'docs', slug: null };
  if (pathname === HOST_GUIDE_PATH) return { id: 'add-host', slug: null };
  const project = PROJECT_PATH.exec(pathname);
  if (project) return { id: 'projects', slug: decodeURIComponent(project[1]) };
  if (pathname === '/projects') return { id: 'projects', slug: null };
  if (parseReviewPath(pathname)) return { id: 'reviews', slug: null };
  const name = pathname.slice(1);
  return { id: PLAIN.includes(name) ? name : 'overview', slug: null };
}

// The route that the Help panel and the page checks use. It also takes /p/<slug> and any inline Help topic name.
export function helpRoute(pathname) {
  if (docsPageName(pathname) !== null) return 'docs';
  if (pathname === HOST_GUIDE_PATH) return 'add-host';
  if (/^\/(projects|p)(\/|$)/.test(pathname)) return 'projects';
  if (parseReviewPath(pathname)) return 'reviews';
  const name = pathname.slice(1);
  return HELP_INLINE.includes(name) || HELP_FILES.includes(name) ? name : 'overview';
}

// A Board card links to /projects/<slug>?task=<id>. The task id of a project page address, or null.
export function taskFromQuery(pathname, search) {
  return PROJECT_PATH.test(pathname) ? new URLSearchParams(search).get('task') : null;
}
