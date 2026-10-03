// The Docs section. The service renders each page from Markdown and sends the HTML. This module builds the page around it:
// the page tree, the previous and next links, the list of sections, and the states for loading and a missing page.
// No DOM use, so the Node tests import it.
import { esc } from './markdown.js';

export const docsUrl = (name, hash = '') => `/docs${name ? `/${name.split('/').map(encodeURIComponent).join('/')}` : ''}${hash}`;

// The page name of an address, or null when the address is not in the Docs section. The front page has the empty name.
export function docsPageName(pathname) {
  const m = /^\/docs(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  const raw = (m[1] || '').replace(/\/+$/, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// The pages of the tree in reading order.
export const docsFlat = (tree) => (tree?.sections || []).flatMap((section) => section.pages);

export function docsNeighbors(tree, name) {
  const flat = docsFlat(tree);
  const at = flat.findIndex((page) => page.name === name);
  return at < 0 ? { prev: null, next: null } : { prev: flat[at - 1] || null, next: flat[at + 1] || null };
}

const link = (page, current) => `<a href="${esc(docsUrl(page.name))}"${page.name === current ? ' aria-current="page"' : ''}>${esc(page.title)}</a>`;

export function docsNavHtml(tree, current) {
  return (tree?.sections || []).map((section) => `<section><h2>${esc(section.title)}</h2><ul>${section.pages.map((page) => `<li>${link(page, current)}</li>`).join('')}</ul></section>`).join('');
}

function pagerHtml(tree, name) {
  const { prev, next } = docsNeighbors(tree, name);
  if (!prev && !next) return '';
  const cell = (page, label, cls) => (page ? `<a class="${cls}" href="${esc(docsUrl(page.name))}"><span>${label}</span>${esc(page.title)}</a>` : '<span></span>');
  return `<nav class="docs-pager" aria-label="Previous and next page">${cell(prev, 'Previous', 'docs-prev')}${cell(next, 'Next', 'docs-next')}</nav>`;
}

function tocHtml(page) {
  const items = (page.headings || []).filter((h) => h.level === 2);
  if (items.length < 2) return '';
  return `<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${items.map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul></nav>`;
}

// A page of dashboard help also shows in the Help panel of its dashboard page. The note says so.
function helpNote(page) {
  return /^help\/[a-z0-9-]+$/.test(page.name) ? `<p class="docs-note">This text also shows in the Help panel of the ${esc(page.title.replace(/ help$/i, ''))} page.</p>` : '';
}

export const docsPageTitle = (page) => (page ? `${page.title} · Docs · Herdr Boss` : 'Docs · Herdr Boss');

// state: { tree, name, page, error }. page is the answer of the page route. error is a message for a page that did not load.
export function docsViewHtml({ tree, name, page, error }) {
  let body;
  if (page) body = `<article class="docs-page md" data-docs-page="${esc(page.name)}">${page.html}${helpNote(page)}${pagerHtml(tree, page.name)}<p class="docs-source">Source: <code>${esc(page.source)}</code></p></article>${tocHtml(page)}`;
  else if (error) body = `<article class="docs-page md"><h1>Page not found</h1><p>${esc(error)}</p><p><a href="/docs">Go to the Docs front page</a>.</p></article>`;
  else body = '<article class="docs-page md" aria-busy="true"><p class="docs-loading">Loading…</p></article>';
  return `<div class="docs"><aside class="docs-side"><button type="button" class="docs-nav-toggle quiet" data-docs-nav-toggle aria-expanded="false" aria-controls="docs-nav">Pages</button><nav id="docs-nav" class="docs-nav" aria-label="Docs pages">${docsNavHtml(tree, name)}</nav></aside><div class="docs-main">${body}</div></div>`;
}
