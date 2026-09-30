// The importer of existing HTML packs. See docs/ideas/review-packs.md, section Import of existing HTML packs.
// It reads a folder of HTML files or one HTML file and writes a pack folder into a temporary directory:
// a manifest with one section for each page, one `page` item with the whole page, and one `image` item for each local image.
// It never fetches a URL. It lists the external URLs that the pages use, without query string or fragment.
// The pack folder then goes through validatePack() and publishVersion() like any other pack.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLUG } from './projects.js';
import { SCHEMA } from './review-pack.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const SKIP_FOLDERS = new Set(['node_modules']);
const MAX_DEPTH = 8;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;
const TEXT_MAX = 200;
const MAX_TAGS = 20000;
const MAX_ATTRS = 50;
const MAX_CSS = 200 * 1024;
const VALUE_MAX = 2000;
const MAX_ITEMS = 400;
const INTERESTING = new Set(['a', 'img', 'link', 'iframe', 'source', 'video', 'audio', 'embed', 'object', 'track']);
const ASK = ['accept', 'deny', 'note'];
const RESOURCE_TAGS = new Set(['img', 'script', 'link', 'iframe', 'source', 'video', 'audio', 'embed', 'object', 'track']);
const LINK_RELS = /(stylesheet|icon|preload|prefetch|modulepreload|manifest)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Text for the terminal or a manifest title: no control character, no escape sequence, one line, at most `max` characters.
// The input is cut first, so the cost stays bounded for any input.
export function safeText(text, max = TEXT_MAX) {
  const head = Array.from(String(text ?? '').slice(0, max * 4)).join('');
  return Array.from(head
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, max).join('').trim();
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);

// The text of a title or a heading: tags removed, entities decoded. The input is cut to 2000 characters first.
const plain = (text) => safeText(decode(String(text ?? '').slice(0, 2000).replace(/<[^>]*>/g, ' ')));

const cut = (text, max) => Array.from(text).slice(0, max).join('').trim();

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function slugify(text, max = 40) {
  return String(text).slice(0, 200).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
}

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
const isLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

// One linear pass over an HTML text. The cursor only moves forward and each character is read a bounded number of times:
// indexOf finds the end of a tag, a quote, a comment, and a closing tag, and a search that finds nothing ends the pass.
// It returns { tags: [{ name, attrs }], title, heading, css: [text] }. Only the tags that the importer uses are kept.
// The pass stops after MAX_TAGS tags and keeps at most MAX_CSS characters of CSS. It does not build a DOM.
export function scanHtml(html) {
  const text = String(html);
  const length = text.length;
  const tags = [];
  const css = [];
  let cssChars = 0;
  let title = '';
  let heading = '';
  let headingDone = false;
  let seen = 0;
  let cursor = 0;
  const addCss = (value) => {
    if (cssChars >= MAX_CSS || !value) return;
    const part = value.slice(0, MAX_CSS - cssChars);
    cssChars += part.length;
    css.push(part);
  };
  // The position after the closing tag `</name` and its `>`, or -1 when the text has none. `from` is the start of the content.
  const closeOf = (name, from) => {
    let at = text.indexOf('</', from);
    while (at !== -1) {
      if (text.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
      at = text.indexOf('</', at + 2);
    }
    return -1;
  };
  while (cursor < length && seen < MAX_TAGS) {
    const open = text.indexOf('<', cursor);
    if (open === -1) break;
    const next = text.charCodeAt(open + 1);
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) break;
      cursor = end + 3;
      continue;
    }
    if (next === 33 || next === 63 || next === 47) { // <! <? </
      const end = text.indexOf('>', open + 2);
      if (end === -1) break;
      cursor = end + 1;
      continue;
    }
    if (!isLetter(next)) { cursor = open + 1; continue; }
    // A start tag: the name, then the attributes up to the closing >. A quote ends only at its own quote character.
    let at = open + 1;
    while (at < length && !isSpace(text.charCodeAt(at)) && text[at] !== '>' && text[at] !== '/') at += 1;
    const name = text.slice(open + 1, at).toLowerCase();
    const attrs = {};
    let count = 0;
    let closed = false;
    while (at < length) {
      const code = text.charCodeAt(at);
      if (isSpace(code) || text[at] === '/') { at += 1; continue; }
      if (text[at] === '>') { closed = true; at += 1; break; }
      const nameStart = at;
      while (at < length && !isSpace(text.charCodeAt(at)) && text[at] !== '=' && text[at] !== '>' && text[at] !== '/') at += 1;
      if (at === nameStart) { at += 1; continue; }
      const attr = text.slice(nameStart, at).toLowerCase();
      while (at < length && isSpace(text.charCodeAt(at))) at += 1;
      let value = '';
      if (text[at] === '=') {
        at += 1;
        while (at < length && isSpace(text.charCodeAt(at))) at += 1;
        if (text[at] === '"' || text[at] === "'") {
          const end = text.indexOf(text[at], at + 1);
          if (end === -1) { at = length; break; }
          value = text.slice(at + 1, end);
          at = end + 1;
        } else {
          const valueStart = at;
          while (at < length && !isSpace(text.charCodeAt(at)) && text[at] !== '>') at += 1;
          value = text.slice(valueStart, at);
        }
      }
      if (count < MAX_ATTRS && !(attr in attrs)) { attrs[attr] = value.slice(0, VALUE_MAX); count += 1; }
    }
    if (!closed) break;
    seen += 1;
    cursor = at;
    if (attrs.style !== undefined) addCss(attrs.style);
    if (name === 'script' || name === 'style' || name === 'title' || name === 'textarea') {
      const end = closeOf(name, cursor);
      const content = text.slice(cursor, end === -1 ? Math.min(length, cursor + MAX_CSS) : end);
      if (name === 'style') addCss(content);
      else if (name === 'title' && !title) title = plain(content);
      cursor = end === -1 ? length : end;
      if (name === 'script') tags.push({ name, attrs });
      continue;
    }
    if (name === 'h1' && !headingDone) {
      headingDone = true;
      const end = closeOf('h1', cursor);
      heading = plain(text.slice(cursor, end === -1 ? cursor + 2000 : Math.min(end, cursor + 2000)));
    }
    if (INTERESTING.has(name)) tags.push({ name, attrs });
  }
  return { tags, title, heading, css };
}

// The URLs in a CSS text: url(...) and @import. Linear: each search moves forward, and a missing end stops the scan.
function cssUrls(sources) {
  const urls = [];
  for (const css of sources) {
    let cursor = 0;
    while (cursor < css.length && urls.length < MAX_TAGS) {
      const paren = css.indexOf('(', cursor);
      const atRule = css.indexOf('@', cursor);
      if (paren === -1 && atRule === -1) break;
      if (paren !== -1 && (atRule === -1 || paren < atRule)) {
        cursor = paren + 1;
        if (css.slice(Math.max(0, paren - 3), paren).toLowerCase() !== 'url') continue;
        let at = cursor;
        while (at < css.length && isSpace(css.charCodeAt(at))) at += 1;
        const quote = css[at] === '"' || css[at] === "'" ? css[at] : '';
        const end = quote ? css.indexOf(quote, at + 1) : css.indexOf(')', at);
        if (end === -1) break;
        urls.push(css.slice(quote ? at + 1 : at, end).trim().slice(0, VALUE_MAX));
        cursor = end + 1;
      } else {
        cursor = atRule + 1;
        if (css.slice(atRule, atRule + 7).toLowerCase() !== '@import') continue;
        let at = atRule + 7;
        while (at < css.length && isSpace(css.charCodeAt(at))) at += 1;
        if (css[at] !== '"' && css[at] !== "'") continue;
        const end = css.indexOf(css[at], at + 1);
        if (end === -1) break;
        urls.push(css.slice(at + 1, end).slice(0, VALUE_MAX));
        cursor = end + 1;
      }
    }
  }
  return urls;
}

// Classify one reference: { kind: 'skip' | 'external' | 'local', ... }.
function classify(value, pageDir, root) {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('#')) return { kind: 'skip' };
  if (/^(https?:)?\/\//i.test(text)) {
    try {
      const url = new URL(text.startsWith('//') ? `https:${text}` : text);
      return { kind: 'external', url: `${url.protocol}//${url.host}${url.pathname}` };
    } catch { return { kind: 'skip' }; }
  }
  if (SCHEME.test(text)) return { kind: 'skip' };
  let rel = text.split('#')[0].split('?')[0];
  try { rel = decodeURIComponent(rel); } catch { /* keep the raw text */ }
  if (!rel || rel.includes('\0')) return { kind: 'skip' };
  const target = rel.startsWith('/') ? path.join(root, rel) : path.resolve(pageDir, rel);
  if (!inside(root, target)) return { kind: 'local', file: rel, problem: 'it is outside the folder' };
  return { kind: 'local', file: path.relative(root, target).split(path.sep).join('/'), abs: target };
}

function findHtml(root) {
  const found = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_FOLDERS.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root, 0);
  return found;
}

function readPage(root, rel) {
  const full = path.join(root, ...rel.split('/'));
  try {
    if (fs.statSync(full).size > MAX_HTML_BYTES) return '';
    return fs.readFileSync(full, 'utf8');
  } catch { return ''; }
}

// Read the source and write the pack folder. Options: { source, id, title }.
// Returns { folder, manifest, pages, images, external, skipped, cleanup }. `cleanup()` removes the temporary folder.
// It throws an Error with a message for the caller when the source is not usable.
export function buildImport({ source, id, title } = {}) {
  let real;
  try { real = fs.realpathSync(source); } catch { throw new Error('The import source does not exist or cannot be read.'); }
  const stat = fs.statSync(real);
  let root;
  let pageFiles;
  if (stat.isFile()) {
    if (!/\.html?$/i.test(real)) throw new Error('A file to import must end in .html or .htm.');
    root = path.dirname(real);
    pageFiles = [path.basename(real)];
  } else if (stat.isDirectory()) {
    root = real;
    pageFiles = findHtml(root);
  } else throw new Error('The import source must be a folder or an HTML file.');
  if (!pageFiles.length) throw new Error('The folder has no HTML file to import.');

  const packId = id ?? slugify(path.basename(real).replace(/\.html?$/i, ''), 64);
  if (typeof packId !== 'string' || !SLUG.test(packId)) throw new Error('The pack ID must match [a-z0-9][a-z0-9-]* and have at most 64 characters. Use --id.');

  // The order: index.html, the pages that index.html links to (in link order), then the other pages by name.
  const pageSet = new Set(pageFiles);
  const scans = new Map();
  const scanOf = (rel) => {
    if (!scans.has(rel)) scans.set(rel, scanHtml(readPage(root, rel)));
    return scans.get(rel);
  };
  const indexRel = pageFiles.find((rel) => /^index\.html?$/i.test(rel));
  const ordered = [];
  const placed = new Set();
  const push = (rel) => { if (rel && pageSet.has(rel) && !placed.has(rel)) { placed.add(rel); ordered.push(rel); } };
  if (indexRel) {
    push(indexRel);
    for (const tag of scanOf(indexRel).tags) {
      if (tag.name !== 'a') continue;
      const ref = classify(tag.attrs.href, path.dirname(path.join(root, indexRel)), root);
      if (ref.kind === 'local' && !ref.problem) push(ref.file);
    }
  }
  for (const rel of pageFiles) push(rel);

  const external = new Set();
  const skipped = new Map();
  const skip = (file, reason) => { if (!skipped.has(file)) skipped.set(file, reason); };
  const imageSeen = new Set();
  const sectionIds = new Set();
  const sections = [];
  const copies = [];
  let images = 0;
  let itemTotal = 0;

  for (const rel of ordered) {
    const scan = scanOf(rel);
    scans.delete(rel);
    const pageDir = path.dirname(path.join(root, rel));
    const pageTitle = cut(scan.title || scan.heading, TITLE_MAX) || cut(safeText(path.basename(rel)), TITLE_MAX);
    let sectionId = slugify(rel.replace(/\.html?$/i, '')) || 'page';
    for (let n = 2; sectionIds.has(sectionId); n += 1) sectionId = `${slugify(rel.replace(/\.html?$/i, ''), 36) || 'page'}-${n}`;
    sectionIds.add(sectionId);
    const items = [{ id: `${sectionId}-page`, title: cut(`Page ${rel}`, TITLE_MAX), type: 'page', src: rel, ask: ASK }];
    copies.push(rel);
    itemTotal += 1;
    let count = 0;

    for (const value of cssUrls(scan.css)) {
      const ref = classify(value, pageDir, root);
      if (ref.kind === 'external') external.add(ref.url);
      else if (ref.kind === 'local') skip(ref.file, ref.problem ?? 'not copied: a page item holds one HTML file');
    }
    for (const tag of scan.tags) {
      if (!RESOURCE_TAGS.has(tag.name)) continue;
      const value = tag.name === 'object' ? tag.attrs.data : tag.attrs.src ?? (tag.name === 'link' && LINK_RELS.test(tag.attrs.rel ?? '') ? tag.attrs.href : undefined);
      if (value === undefined) continue;
      const ref = classify(value, pageDir, root);
      if (ref.kind === 'external') { external.add(ref.url); continue; }
      if (ref.kind !== 'local') continue;
      if (tag.name !== 'img') { skip(ref.file, ref.problem ?? 'not copied: a page item holds one HTML file'); continue; }
      if (ref.problem) { skip(ref.file, ref.problem); continue; }
      if (imageSeen.has(ref.file) || skipped.has(ref.file)) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(ref.file).toLowerCase())) { skip(ref.file, 'not an accepted image type (PNG, JPEG, WebP, or GIF)'); continue; }
      let target;
      try { target = fs.realpathSync(ref.abs); } catch { skip(ref.file, 'the file does not exist'); continue; }
      if (!inside(root, target)) { skip(ref.file, 'it is outside the folder'); continue; }
      if (!fs.statSync(target).isFile()) { skip(ref.file, 'the path is not a file'); continue; }
      if (itemTotal >= MAX_ITEMS) { skip(ref.file, `a pack holds at most ${MAX_ITEMS} items`); continue; }
      imageSeen.add(ref.file);
      count += 1;
      images += 1;
      itemTotal += 1;
      const alt = cut(plain(tag.attrs.alt), TITLE_MAX);
      const item = { id: `${sectionId}-image-${count}`, title: alt || cut(path.basename(ref.file), TITLE_MAX), type: 'image', src: ref.file, ask: ASK };
      if (alt) item.alt = alt;
      items.push(item);
      copies.push(ref.file);
    }
    sections.push({ id: sectionId, title: pageTitle, items });
  }

  const packTitle = cut(plain(title), TITLE_MAX) || sections[0].title || packId;
  const manifest = { schema: SCHEMA, id: packId, title: packTitle, sections };

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-review-import-'));
  const cleanup = () => fs.rmSync(folder, { recursive: true, force: true });
  try {
    fs.chmodSync(folder, 0o700);
    for (const rel of copies) {
      const target = path.join(folder, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(fs.realpathSync(path.join(root, ...rel.split('/'))), target);
    }
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } catch (error) {
    cleanup();
    throw new Error(`Herdr Boss cannot prepare the import: ${error.code || 'error'}.`);
  }
  return {
    folder,
    manifest,
    pages: sections.length,
    images,
    external: [...external].sort(),
    skipped: [...skipped].map(([file, reason]) => ({ file, reason })),
    cleanup,
  };
}
