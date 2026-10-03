// The Docs section of the dashboard. It reads Markdown from README.md and docs/, renders it in memory with public/markdown.js,
// and answers three kinds of request: the page tree, one page, and one image. It writes no file.
// The page index is a map from page name to file. A request can reach only a file in that map, or an image inside docs/.
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown, headingSlug } from '../public/markdown.js';

export const ID_PREFIX = 'd-';
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const MAX_FILES = 2000;
const MAX_DEPTH = 6;
const MAX_PAGE = 2 * 1024 * 1024;
const MAX_NAV = 64 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_CACHED_PAGES = 200;
const SCAN_TTL_MS = 2000;
const THEME_FRAGMENT = /^only-(light|dark)$/;

const posix = path.posix;
const fail = (status, error) => ({ status, body: { error } });

// A page name is the path of its file without .md and without a trailing /index. README.md is the front page with the empty name.
export function pageName(rel) {
  if (rel === 'README.md') return '';
  const name = rel.replace(/^docs\//, '').replace(/\.md$/, '');
  return name.endsWith('/index') ? name.slice(0, -'/index'.length) : name;
}

// A name from a request: plain segments only.
function cleanName(name) {
  if (typeof name !== 'string' || name.length > 300 || /[\0\\]/.test(name)) return null;
  const parts = name.split('/').filter((part, i, all) => part !== '' || i === all.length - 1);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/').replace(/\/$/, '');
}

// Splits Markdown into fenced code and other text. A rewrite applies to other text only.
function outsideFences(source, rewrite) {
  const out = [];
  let chunk = [];
  let fence = null;
  const flush = () => { if (chunk.length) out.push(rewrite(chunk.join('\n'))); chunk = []; };
  for (const line of source.split('\n')) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(line)) fence = null;
    } else if (mark) {
      flush();
      out.push(line);
      fence = mark[1];
    } else chunk.push(line);
  }
  flush();
  return out.join('\n');
}

function attributes(tag) {
  const found = {};
  for (const m of tag.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) found[m[1].toLowerCase()] = m[2];
  return found;
}

// Plain HTML that GitHub shows and the renderer would print as text: comments, and a <picture> with a dark source.
// A picture becomes a light and a dark image. The fragment #only-light or #only-dark tells the style sheet which one to show.
function prepare(source) {
  return outsideFences(source, (text) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<picture>([\s\S]*?)<\/picture>/gi, (_all, inner) => {
      const img = /<img\b[^>]*>/i.exec(inner);
      if (!img) return '';
      const { src, alt = '' } = attributes(img[0]);
      if (!src) return '';
      const label = alt.replace(/[[\]]/g, '');
      const dark = [...inner.matchAll(/<source\b[^>]*>/gi)].map((m) => attributes(m[0])).find((a) => /prefers-color-scheme:\s*dark/i.test(a.media || ''));
      if (!dark?.srcset) return `![${label}](${src})`;
      return `![${label}](${src}#only-light)\n![${label}](${dark.srcset.trim().split(/\s+/)[0]}#only-dark)`;
    }));
}

// The dashboard has no diagram library. A Mermaid block shows as its source, in a fold that starts closed.
const MERMAID = /<div class="md-code">(?:(?!<\/div>)[\s\S])*?<code class="language-mermaid">[\s\S]*?<\/code><\/pre><\/div>/g;
const foldDiagrams = (html) => html.replace(MERMAID, (block) => `<details class="docs-diagram"><summary>Diagram source (Mermaid)</summary>${block}</details>`);

function plainTitle(text) {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').trim();
}

export function firstHeading(source) {
  let fence = false;
  for (const line of source.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    const m = !fence && /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m) return plainTitle(m[1]);
  }
  return '';
}

export function createDocsSite({ root, ttlMs = SCAN_TTL_MS, now = Date.now } = {}) {
  const docsDir = path.join(root, 'docs');
  let index = null;
  let scannedAt = 0;
  const pages = new Map();
  const titles = new Map();

  // A page or help text enters the cache. The cache keeps at most MAX_CACHED_PAGES entries and drops the oldest.
  function remember(key, value) {
    pages.delete(key);
    pages.set(key, value);
    if (pages.size > MAX_CACHED_PAGES) pages.delete(pages.keys().next().value);
  }

  // The real path of a file that README.md or nav.json names, or null when the path leaves the repository.
  function insideRoot(file) {
    try {
      const base = fs.realpathSync(root);
      const real = fs.realpathSync(file);
      return real.startsWith(base + path.sep) ? real : null;
    } catch { return null; }
  }

  function walk(dir, depth, found, images) {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1, found, images);
      else if (entry.isFile() && Object.hasOwn(IMAGE_TYPES, path.extname(entry.name).toLowerCase())) images.push(file);
      else if (entry.isFile() && entry.name.endsWith('.md') && found.length < MAX_FILES) found.push(file);
    }
  }

  // The index of pages. A rescan runs at most once in ttlMs. The page cache restarts when the set of files changes.
  function scan() {
    if (index && now() - scannedAt < ttlMs) return index;
    const files = [];
    const images = [];
    walk(docsDir, 0, files, images);
    const readme = path.join(root, 'README.md');
    const byName = new Map();
    const byRel = new Map();
    const stamp = [];
    for (const file of [readme, ...files]) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_PAGE) continue;
      if (file === readme && !insideRoot(file)) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const name = pageName(rel);
      if (byName.has(name)) continue;
      const entry = { name, rel, file, mtimeMs: st.mtimeMs, size: st.size };
      byName.set(name, entry);
      byRel.set(rel, entry);
      stamp.push(`${rel}:${st.mtimeMs}:${st.size}`);
    }
    // An image that appears, changes, or goes changes how a page renders, so the images are part of the signature.
    for (const file of images) {
      try {
        const st = fs.statSync(file);
        stamp.push(`${path.relative(root, file)}:${st.mtimeMs}:${st.size}`);
      } catch { /* A file that vanished is not in the signature. */ }
    }
    let navStamp = '';
    let nav = null;
    try {
      const navFile = path.join(docsDir, 'nav.json');
      if (!insideRoot(navFile)) throw new Error('outside');
      const st = fs.statSync(navFile);
      navStamp = `${st.mtimeMs}:${st.size}`;
      if (st.size <= MAX_NAV) nav = JSON.parse(fs.readFileSync(navFile, 'utf8'));
    } catch { nav = null; }
    const signature = `${stamp.join('|')}#${navStamp}`;
    if (!index || index.signature !== signature) { pages.clear(); titles.clear(); }
    index = { byName, byRel, nav, signature };
    scannedAt = now();
    return index;
  }

  function titleOf(entry) {
    const key = `${entry.rel}:${entry.mtimeMs}`;
    if (titles.has(key)) return titles.get(key);
    let title = '';
    try {
      const fd = fs.openSync(entry.file, 'r');
      try {
        const buffer = Buffer.alloc(8192);
        title = firstHeading(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch { title = ''; }
    title ||= entry.name.split('/').pop() || 'Herdr Boss';
    titles.set(key, title);
    return title;
  }

  // The tree comes from docs/nav.json: sections of page names. A name ending in /* adds every page of that folder, the folder page first.
  function tree() {
    const idx = scan();
    const sections = [];
    const used = new Set();
    for (const section of Array.isArray(idx.nav?.sections) ? idx.nav.sections : []) {
      if (!section || typeof section.title !== 'string' || !Array.isArray(section.pages)) continue;
      const names = [];
      for (const name of section.pages) {
        if (typeof name !== 'string') continue;
        if (name.endsWith('/*')) {
          const dir = name.slice(0, -2);
          const all = [...idx.byName.keys()].filter((n) => n === dir || n.startsWith(`${dir}/`)).sort((a, b) => (a === dir ? -1 : b === dir ? 1 : a < b ? -1 : 1));
          names.push(...all);
        } else names.push(name);
      }
      const items = [];
      for (const name of names) {
        const entry = idx.byName.get(name);
        if (!entry || used.has(name)) continue;
        used.add(name);
        items.push({ name, title: titleOf(entry) });
      }
      if (items.length) sections.push({ title: section.title.slice(0, 80), pages: items });
    }
    if (!sections.length) {
      const front = idx.byName.get('');
      if (front) sections.push({ title: 'Docs', pages: [{ name: '', title: titleOf(front) }] });
    }
    return { status: 200, body: { sections, count: idx.byName.size } };
  }

  // Resolves a link or image target of the file `from` to { rel, hash }, or null for an outside target.
  function resolve(from, target) {
    const [pathPart, ...rest] = String(target).split('#');
    const hash = rest.join('#');
    if (pathPart === '') return { rel: from, hash };
    // A target can hold percent escapes and a query. The query is dropped. The escapes are decoded once, before the path is resolved.
    const decoded = safeDecode(pathPart.split('?')[0]);
    if (/[\0\\]/.test(decoded)) return null;
    let joined = decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(from), decoded);
    joined = posix.normalize(joined);
    if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return null;
    return { rel: joined.replace(/\/$/, ''), hash };
  }

  const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');
  const anchor = (hash) => (hash ? `#${ID_PREFIX}${headingSlug(safeDecode(hash))}` : '');
  function safeDecode(text) { try { return decodeURIComponent(text); } catch { return text; } }

  function hooks(idx, from) {
    return {
      link(raw) {
        if (/^(https?:\/\/|mailto:)/i.test(raw)) return raw;
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw)) return null;
        const hit = resolve(from, raw);
        if (!hit) return null;
        if (hit.rel === from && !raw.split('#')[0]) return anchor(hit.hash) || null;
        const entry = idx.byRel.get(hit.rel) || idx.byRel.get(`${hit.rel}.md`) || idx.byRel.get(`${hit.rel}/index.md`) || idx.byName.get(hit.rel.replace(/^docs\//, ''));
        if (entry) return `/docs${entry.name ? `/${encodePath(entry.name)}` : ''}${anchor(hit.hash)}`;
        return imageUrl(hit.rel);
      },
      image(raw) {
        const [file, fragment] = String(raw).split('#');
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(file)) return null;
        const hit = resolve(from, file);
        const url = hit && imageUrl(hit.rel);
        return url && (!fragment || THEME_FRAGMENT.test(fragment)) ? url + (fragment ? `#${fragment}` : '') : null;
      },
    };
  }

  // The URL of an image file inside docs/, or null.
  function imageUrl(rel) {
    if (!rel.startsWith('docs/') || !Object.hasOwn(IMAGE_TYPES, posix.extname(rel).toLowerCase())) return null;
    const name = rel.slice('docs/'.length);
    return imageFile(name) ? `/docs/${encodePath(name)}` : null;
  }

  // The real path of an image inside docs/, or null for a name that leaves docs/, a link, or a missing file.
  function imageFile(name) {
    const clean = cleanName(name);
    if (!clean || !Object.hasOwn(IMAGE_TYPES, posix.extname(clean).toLowerCase())) return null;
    try {
      const base = fs.realpathSync(docsDir);
      const real = fs.realpathSync(path.join(base, ...clean.split('/')));
      return real.startsWith(base + path.sep) && fs.statSync(real).isFile() ? real : null;
    } catch { return null; }
  }

  function render(entry, options) {
    const headings = [];
    let source = fs.readFileSync(entry.file, 'utf8');
    if (options.dropTitle) source = source.replace(/^(?: *\n)*#[ \t]+.*\n?/, '');
    const rendered = renderMarkdown(prepare(source), {
      maxInput: MAX_PAGE,
      headingIds: options.ids ? ID_PREFIX : '',
      onHeading: (h) => headings.push(h),
      docs: hooks(scan(), entry.rel),
      ...options.heading,
    });
    return { html: foldDiagrams(rendered), headings };
  }

  function page(rawName) {
    const name = cleanName(rawName ?? '');
    if (name === null) return fail(400, 'The page name is not valid.');
    const idx = scan();
    const entry = idx.byName.get(name);
    if (!entry) return fail(404, 'Page not found.');
    const key = `page:${entry.name}`;
    const cached = pages.get(key);
    if (cached?.mtimeMs === entry.mtimeMs) return { status: 200, body: cached.body };
    const { html, headings } = render(entry, { ids: true, heading: { headingOffset: 0, minHeading: 1 } });
    const body = { name: entry.name, title: titleOf(entry), source: entry.rel, html, headings: headings.filter((h) => h.level === 2 || h.level === 3) };
    remember(key, { mtimeMs: entry.mtimeMs, body });
    return { status: 200, body };
  }

  // The help text of one dashboard page: docs/help/<topic>.md. The first heading is the title. The sections start at h3.
  function help(topic) {
    if (typeof topic !== 'string' || !/^[a-z0-9-]{1,40}$/.test(topic)) return fail(400, 'The help topic is not valid.');
    const entry = scan().byName.get(`help/${topic}`);
    if (!entry) return fail(404, 'Help topic not found.');
    const key = `help:${topic}`;
    const cached = pages.get(key);
    if (cached?.mtimeMs === entry.mtimeMs) return { status: 200, body: cached.body };
    const { html } = render(entry, { dropTitle: true, heading: { headingOffset: 1, minHeading: 3 } });
    const body = { topic, title: titleOf(entry), html };
    remember(key, { mtimeMs: entry.mtimeMs, body });
    return { status: 200, body };
  }

  // One image of the Docs section. The name is the path below docs/.
  function image(rawName) {
    const file = imageFile(rawName);
    if (!file) return fail(404, 'Image not found.');
    if (fs.statSync(file).size > MAX_IMAGE) return fail(413, 'The image is larger than 8 MB.');
    return { status: 200, type: IMAGE_TYPES[path.extname(file).toLowerCase()], bytes: fs.readFileSync(file) };
  }

  return { tree, page, help, image };
}
