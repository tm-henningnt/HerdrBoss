// The shell of the dashboard: the shared menu and the address rules. It reads the route registry of routes.js.
// Each function takes its DOM or location objects as arguments, so the Node tests call it with small stubs.
import { MENU_ROUTES, NAV_LABEL, matchRoute, resolveAlias, taskFromQuery } from './routes.js';

// Fill the one menu host with a link for each menu route. Context links and Help follow; Roamgate stays last.
export function mountMenu(nav) {
  const before = nav.querySelector('#mail-folder-menu') || nav.querySelector('#nav-help') || nav.querySelector('#roamgate-link');
  for (const route of MENU_ROUTES) {
    const link = nav.ownerDocument.createElement('a');
    link.href = route.path;
    link.dataset.nav = route.id;
    link.textContent = route.label;
    nav.insertBefore(link, before);
  }
}

// Set the menu label and the current page mark for the route that the page shows.
export function syncMenu({ nav, label, route }) {
  if (label) label.textContent = NAV_LABEL[route] || 'Menu';
  const current = route === 'add-host' ? 'fleet' : route;
  for (const a of nav.querySelectorAll('a')) {
    if (a.dataset.nav === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// Replace an old address with its new address, and read the task of a project page address.
// Gives { route, slug, pendingHash, task }. task is { slug, id } when a Board card selected a task. It drops the query of that address.
export function readLocation(loc, hist) {
  let pendingHash = null;
  const alias = resolveAlias(loc.pathname, loc.hash);
  if (alias) {
    hist.replaceState(null, '', alias.url);
    pendingHash = alias.pendingHash;
  }
  const { id, slug } = matchRoute(loc.pathname);
  const pick = slug === null ? null : taskFromQuery(loc.pathname, loc.search);
  if (pick) hist.replaceState(null, '', loc.pathname + loc.hash);
  return { route: id, slug, pendingHash, task: pick ? { slug, id: pick } : null };
}
