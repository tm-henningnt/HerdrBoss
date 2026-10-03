// The item viewer of hosted review packs: the evidence of each item type, the answer bar, the top bar, the key map,
// the item order, and the pin list. See docs/ideas/review-packs.md, sections Item types, Questions, and Item viewer.
// The module has no DOM use, so the Node tests import it directly. public/review.js places the viewer in the pack page,
// public/review-gestures.js runs the zoom and the swipe, and public/app.js saves the answers.
// Each render function takes helpers: esc, and text(url), which gives { text } or { error } for a loaded text file, or nothing.
// Every value from the pack goes through esc(). A file path goes through encodeURIComponent() for each part, and then esc().
// Markdown goes through h.markdown(): the page passes a renderer that escapes all source text and then removes each tag and
// attribute outside the allowlist, before the string reaches the DOM. Without it, markdownOrPlain() renders the text.
import { markdownOrPlain, safeUrl } from './markdown.js';
import { COPY_ICON_HTML } from './copy.js';
import { syncStatusHtml, packStatusHtml } from './review-sync.js';
import { visibleItems } from './review-filter.js';
import { effectiveAsk } from './review-ask.js';

export const PIN_MAX = 20;
export const PIN_TEXT_MAX = 200;
export const NOTE_MAX = 2000;
const TABLE_ROWS_MAX = 2000;
const CODE_LINES_MAX = 5000;

const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<path d="M5 4.5h14v11H10l-5 4v-15Z"/><path d="M9 9h6M9 12h4"/>',
  live: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5H5V6h5"/>',
  later: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.5"/>',
  star: '<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  pin: '<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  split: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 3v18"/>',
  agent: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-4 3.5-6 7-6s6.2 2 7 6"/>',
  unmarked: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
  pair: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5h6.5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H12z" fill="currentColor" stroke="none" opacity=".35"/>',
};
const ICON_NEW_TAB = `<svg class="app-icon rv-open-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON.live}</svg>`;
export const viewerIcon = (name, className = 'app-icon') => (ICON[name] ? `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>` : '');

const DECISION_WORD = { accept: 'Accepted', deny: 'Denied' };
// The icon and the visible words of a link that opens a new tab.
const newTab = `${ICON_NEW_TAB}<span class="rv-open-note">(opens in a new tab)</span>`;

// ---------- Keys ----------

const VIEWER_KEYS = {
  j: 'next', ArrowRight: 'next', k: 'prev', ArrowLeft: 'prev', J: 'next-section', K: 'prev-section', n: 'next-open',
  a: 'accept', d: 'deny', b: 'skip', l: 'live', c: 'note', p: 'pin', v: 'viewed', e: 'viewed-next', t: 'pair', z: 'fit',
  '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', s: 'summary', u: 'back', Escape: 'back', '?': 'help',
};

// The keys of the item viewer. In a text field only Esc works: it leaves the field.
export function viewerKeyAction({ key, ctrlKey, metaKey, altKey, inField } = {}) {
  if (ctrlKey || metaKey || altKey) return null;
  if (inField) return key === 'Escape' ? 'leave-field' : null;
  if (/^[1-6]$/.test(String(key))) return `pick-${key}`;
  return VIEWER_KEYS[key] || null;
}

// ---------- Item order ----------

// The first open item after the current one, in pack order. The search wraps to the start. The current item never counts.
export function nextOpenItem(items, currentId) {
  const list = items || [];
  const start = list.findIndex((item) => item.id === currentId);
  for (let step = 1; step <= list.length; step += 1) {
    const item = list[(start + step + list.length) % list.length];
    if (item && item.id !== currentId && item.state === 'open') return item;
  }
  return null;
}

// The index (from 0), the count, and the previous and the next item.
export function itemNeighbors(items, id) {
  const list = items || [];
  const index = list.findIndex((item) => item.id === id);
  return { index, total: list.length, prev: index > 0 ? list[index - 1] : null, next: index >= 0 && index < list.length - 1 ? list[index + 1] : null };
}

// The first item of the next (direction 1) or the previous (direction -1) section.
export function sectionStep(items, id, direction) {
  const list = items || [];
  const sections = [];
  for (const item of list) if (!sections.includes(item.section)) sections.push(item.section);
  const current = list.find((item) => item.id === id);
  const target = sections[sections.indexOf(current?.section) + Math.sign(direction)];
  return target === undefined || !current ? null : list.find((item) => item.section === target) || null;
}

// ---------- Pins ----------

const unit = (value) => Math.min(1, Math.max(0, value));

// A new pin with the next free number, or null at PIN_MAX pins. A number is never used twice in a list.
export function addPin(pins, { x, y, src } = {}) {
  const list = pins || [];
  if (list.length >= PIN_MAX || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const pin = { n: list.reduce((max, entry) => Math.max(max, entry.n || 0), 0) + 1, x: unit(x), y: unit(y), text: '' };
  if (typeof src === 'string' && src) pin.src = src;
  return [...list, pin];
}

export function removePin(pins, n) {
  return (pins || []).filter((pin) => pin.n !== n);
}

export function setPinText(pins, n, text) {
  const list = pins || [];
  if (!list.some((pin) => pin.n === n)) return list;
  return list.map((pin) => (pin.n === n ? { ...pin, text: String(text ?? '').slice(0, PIN_TEXT_MAX) } : pin));
}

// ---------- Files and parsers ----------

const encodePath = (path) => String(path).split('/').map((part) => encodeURIComponent(part)).join('/');

export function fileUrl(pack, path) {
  return `/api/reviews/${encodeURIComponent(pack.slug)}/${encodeURIComponent(pack.pack)}/files/${encodeURIComponent(pack.version)}/${encodePath(path)}`;
}

// The normalized manifest entry of an item: the fields that the viewer needs (src, a, b, images, columns, and more).
export function itemSpec(pack, id) {
  for (const section of pack?.manifest?.sections || []) {
    const found = (section.items || []).find((entry) => entry.id === id);
    if (found) return found;
  }
  return {};
}

// RFC 4180 CSV: commas, double quotes, and CRLF or LF line ends. It gives a list of rows.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const splitLines = (text) => {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

export const fileLines = splitLines;

// The lines of a unified diff with a kind (meta, hunk, same, add, del) and the old and the new line number.
export function diffLines(text) {
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  return splitLines(text).map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { kind: 'hunk', text: line, old: null, new: null }; }
    if (/^diff /.test(line)) inHunk = false;
    if (!inHunk || line.startsWith('\\')) return { kind: 'meta', text: line, old: null, new: null };
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), old: null, new: newLine++ };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), old: oldLine++, new: null };
    return { kind: 'same', text: line.slice(1), old: oldLine++, new: newLine++ };
  });
}

// The live links of an item: its own liveUrl or link URL, else the live links of the pack. Each URL passes safeUrl().
export function liveLinks(pack, spec) {
  const own = [];
  if (spec.liveUrl) own.push({ label: 'Open live', url: spec.liveUrl });
  const list = own.length ? own : (pack?.manifest?.live || []).filter(Boolean);
  return list.map((link) => ({ label: link.label, url: safeHttp(link.url) })).filter((link) => link.url);
}

function safeHttp(url) {
  const safe = safeUrl(String(url ?? ''));
  return safe && /^https?:\/\//i.test(safe) ? safe : null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// ---------- Answer text ----------

function choiceLabel(spec, id) {
  return (spec.choices || []).find((choice) => choice.id === id)?.label ?? id;
}

// A short plain text of an answer, for the conflict choice and the changed notice.
export function answerSummary(answer, spec) {
  if (!answer) return 'no answer';
  const parts = [];
  if (DECISION_WORD[answer.decision]) parts.push(DECISION_WORD[answer.decision]);
  if (answer.choice !== null && answer.choice !== undefined) parts.push(`Chose ${choiceLabel(spec, answer.choice)}`);
  if (answer.rating !== null && answer.rating !== undefined) parts.push(`Rated ${answer.rating}`);
  if (answer.live === 'pending') parts.push('Needs live check');
  if (answer.live === 'done') parts.push('Live check done');
  if (answer.note) parts.push(`Note: ${answer.note}`);
  return parts.length ? parts.join(' · ') : 'no answer';
}

// ---------- Evidence ----------

const markdown = (text, h, extra = '') => `<div class="md rv-md${extra}">${(h.markdown || markdownOrPlain)(text)}</div>`;

// A text file of the pack. The loading line names the URL, so the page can load it.
function textFile(pack, src, h, render) {
  const { esc } = h;
  const url = fileUrl(pack, src);
  const entry = h.text?.(url);
  if (!entry) return `<p class="rv-loading" data-rv-text="${esc(url)}">Loading the text…</p>`;
  if (entry.error !== undefined) return `<p class="rv-error" role="alert" data-rv-text="${esc(url)}">The text could not load. ${esc(entry.error)}</p>`;
  return render(entry.text);
}

function bodyHtml(pack, body, h, extra = ' rv-body') {
  if (!body) return '';
  if (typeof body.text === 'string') return markdown(body.text, h, extra);
  if (typeof body.src === 'string') return textFile(pack, body.src, h, (text) => markdown(text, h, extra));
  return '';
}

function pinsHtml(pins, h, src) {
  const { esc } = h;
  return (pins || []).map((pin) => {
    const left = Math.round(unit(pin.x) * 10000) / 100;
    const top = Math.round(unit(pin.y) * 10000) / 100;
    const text = pin.text ? `: ${pin.text}` : '';
    return `<button type="button" class="rv-pin" data-rv-pin="${esc(pin.n)}"${pin.src !== undefined ? ` data-src="${esc(pin.src)}"` : ''} style="left: ${left}%; top: ${top}%" aria-label="${esc(`Pin ${pin.n}${text}`)}"${src !== undefined && pin.src !== src ? ' hidden' : ''}>${esc(pin.n)}</button>`;
  }).join('');
}

function hintHtml(ui) {
  if (!ui.hint) return '';
  return `<p class="rv-hint" aria-hidden="true">${viewerIcon('fit')}<span class="rv-hint-touch">Pinch to zoom · double tap for 2×</span><span class="rv-hint-mouse">Press + or − to zoom · z for 100 %</span></p>`;
}

// The zoom stage. The canvas keeps its transform across a keyed render (data-keep-attrs="style").
function stageHtml(key, { canvasClass = '', canvas, style = '', overlay = '', label, ui }) {
  return `<div class="rv-stage" data-rv-stage="${key}" data-key="rv-stage:${key}" data-keep-attrs="class"${style ? ` style="${style}"` : ''} tabindex="0" role="group" aria-label="${label}">`
    + `<div class="rv-canvas${canvasClass}" data-keep-attrs="style">${canvas}</div>`
    + `<span class="rv-zoom" aria-hidden="true" data-keep-attrs="data-zoom" data-zoom="Fit"></span>${overlay}${hintHtml(ui)}</div>`;
}

function toolsHtml(item, ui, { left = '' } = {}) {
  const pin = (item.ask || []).includes('note')
    ? `<button type="button" class="rv-tool rv-tool-pin" data-rv-place aria-pressed="${ui.placing ? 'true' : 'false'}">${viewerIcon('pin')}<span>${ui.placing ? 'Tap the image' : 'Add pin'}</span></button>`
    : '';
  return `<div class="rv-tools">${left}<span class="rv-tools-end">${pin}`
    + `<button type="button" class="rv-tool" data-rv-zoom="out" aria-label="Zoom out">${viewerIcon('minus')}</button>`
    + `<button type="button" class="rv-tool" data-rv-zoom="fit" aria-label="Fit or 100 percent">${viewerIcon('fit')}</button>`
    + `<button type="button" class="rv-tool" data-rv-zoom="in" aria-label="Zoom in">${viewerIcon('plus')}</button></span></div>`;
}

const stageLabel = 'Image. Pinch or use + and − to zoom.';

function imageEvidence(pack, item, spec, ui, h) {
  const { esc } = h;
  const pins = item.answer?.pins || [];
  const canvas = `<img class="rv-img" src="${esc(fileUrl(pack, spec.src || ''))}" alt="${esc(spec.alt || item.title || '')}" decoding="async" draggable="false"><div class="rv-pins">${pinsHtml(pins, h)}</div>`;
  return stageHtml(esc(item.id), { canvas, label: stageLabel, ui }) + toolsHtml(item, ui);
}

function pairEvidence(pack, item, spec, ui, h) {
  const { esc } = h;
  const a = spec.a || {};
  const b = spec.b || {};
  const labelA = a.label || 'A';
  const labelB = b.label || 'B';
  const side = ui.pair === 'b' ? 'b' : 'a';
  const split = ui.pairMode === 'split';
  const at = Math.min(100, Math.max(0, Number.isFinite(ui.split) ? Math.round(ui.split) : 50));
  const pins = item.answer?.pins || [];
  const img = (ref, key, label) => `<img class="rv-img rv-img-${key}" src="${esc(fileUrl(pack, ref.src || ''))}" alt="${esc(ref.alt || label)}" decoding="async" draggable="false" data-src="${key}">`;
  const canvas = `${img(a, 'a', labelA)}${img(b, 'b', labelB)}${split ? '<span class="rv-split-line" aria-hidden="true"></span>' : ''}<div class="rv-pins">${pinsHtml(pins, h, split ? undefined : side)}</div>`;
  const toggle = `<div class="rv-seg rv-pairbar" role="group" aria-label="Pair">`
    + `<button type="button" data-rv-pair="a" aria-pressed="${!split && side === 'a' ? 'true' : 'false'}">${esc(labelA)}</button>`
    + `<button type="button" data-rv-pair="b" aria-pressed="${!split && side === 'b' ? 'true' : 'false'}">${esc(labelB)}</button></div>`;
  const modes = `<div class="rv-seg" role="group" aria-label="Pair view">`
    + `<button type="button" data-rv-mode="toggle" aria-pressed="${split ? 'false' : 'true'}">${viewerIcon('pair')}<span>Toggle</span></button>`
    + `<button type="button" data-rv-mode="split" aria-pressed="${split ? 'true' : 'false'}">${viewerIcon('split')}<span>Slider</span></button></div>`;
  const range = split ? `<input type="range" class="rv-split-range" data-rv-split min="0" max="100" value="${at}" aria-label="${esc(`Split between ${labelA} and ${labelB}`)}">` : '';
  const legend = split ? `<p class="rv-split-legend"><span>${esc(labelA)}</span><span>${esc(labelB)}</span></p>` : '';
  return stageHtml(esc(item.id), { canvasClass: split ? ' rv-split' : ` rv-show-${side}`, canvas, style: split ? `--rv-split: ${at}%` : '', overlay: split ? '' : toggle, label: stageLabel, ui })
    + range + legend + toolsHtml(item, ui, { left: modes });
}

function galleryEvidence(pack, item, spec, ui, h) {
  const { esc } = h;
  const images = spec.images || [];
  const index = Number.isInteger(ui.gallery) && ui.gallery >= 0 && ui.gallery < images.length ? ui.gallery : null;
  if (index === null) {
    const tiles = images.map((image, i) => `<li><button type="button" class="rv-tile" data-rv-open="${i}" aria-label="${esc(`Open image ${i + 1} of ${images.length}${image.alt ? `: ${image.alt}` : ''}`)}">`
      + `<img src="${esc(fileUrl(pack, image.src || ''))}" alt="" loading="lazy" decoding="async" draggable="false"></button>${image.caption ? `<small>${esc(image.caption)}</small>` : ''}</li>`).join('');
    return `<ul class="rv-grid" aria-label="${esc(`${images.length} images`)}">${tiles}</ul>`;
  }
  const image = images[index];
  const pins = item.answer?.pins || [];
  const alt = `Image ${index + 1} of ${images.length}${image.alt ? `: ${image.alt}` : ''}`;
  const canvas = `<img class="rv-img" src="${esc(fileUrl(pack, image.src || ''))}" alt="${esc(alt)}" decoding="async" draggable="false" data-src="${esc(image.src || '')}"><div class="rv-pins">${pinsHtml(pins, h, image.src || '')}</div>`;
  const step = (to, label, name) => (to >= 0 && to < images.length
    ? `<button type="button" class="rv-tool" data-rv-gallery="${to}" aria-label="${label}">${viewerIcon(name)}</button>`
    : `<button type="button" class="rv-tool" disabled aria-label="${label}">${viewerIcon(name)}</button>`);
  const nav = `<span class="rv-gallery-nav"><button type="button" class="rv-tool rv-tool-text" data-rv-gallery="grid" aria-label="All images">${viewerIcon('grid')}<span class="rv-tool-label" aria-hidden="true">All images</span></button>`
    + `${step(index - 1, 'Previous image', 'prev')}<span class="rv-gallery-count num">${index + 1} of ${images.length}</span>${step(index + 1, 'Next image', 'next')}</span>`;
  return stageHtml(`${esc(item.id)}:${index}`, { canvas, label: stageLabel, ui })
    + (image.caption ? `<p class="rv-caption">${esc(image.caption)}</p>` : '')
    + toolsHtml(item, ui, { left: nav });
}

function videoEvidence(pack, item, spec, h) {
  const { esc } = h;
  const src = esc(fileUrl(pack, spec.src || ''));
  const poster = spec.poster ? ` poster="${esc(fileUrl(pack, spec.poster))}"` : '';
  return `<div class="rv-video-box"><video class="rv-video" controls preload="metadata" playsinline src="${src}"${poster} aria-label="${esc(item.title || 'Video')}">`
    + `<p>This browser cannot play the video.</p></video></div>`;
}

function tableHtml(columns, rows, title, h) {
  const { esc } = h;
  const shown = rows.slice(0, TABLE_ROWS_MAX);
  const cut = rows.length > shown.length ? `<p class="rv-cut">The table shows ${shown.length} of ${rows.length} rows.</p>` : '';
  return `<div class="rv-table" role="region" aria-label="${esc(`Table: ${title}`)}" tabindex="0"><table><thead><tr>${columns.map((column) => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead>`
    + `<tbody>${shown.map((row) => `<tr>${columns.map((_, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${cut}`;
}

function tableEvidence(pack, item, spec, h) {
  const title = item.title || item.id;
  if (Array.isArray(spec.columns)) return tableHtml(spec.columns, spec.rows || [], title, h);
  return textFile(pack, spec.src || '', h, (text) => {
    const [head = [], ...rows] = parseCsv(text);
    return tableHtml(head, rows, title, h);
  });
}

function cutNote(total) {
  return total > CODE_LINES_MAX ? `<p class="rv-cut">The file shows ${CODE_LINES_MAX} of ${total} lines.</p>` : '';
}

// Copies the text of the lines in the code box below it, without the line numbers.
const copyLinesButton = `<button type="button" class="copy-btn copy-inline" data-copy-lines aria-label="Copy the text">${COPY_ICON_HTML}</button>`;

// The first character of each diff line in the source. A copy of the diff keeps it and drops the line numbers.
const DIFF_PREFIX = { add: '+', del: '-', same: ' ', hunk: '', meta: '' };

function diffEvidence(pack, item, spec, h) {
  const { esc } = h;
  return textFile(pack, spec.src || '', h, (text) => {
    const lines = diffLines(text);
    const mark = { add: '+', del: '−', same: '', hunk: '', meta: '' };
    const rows = lines.slice(0, CODE_LINES_MAX).map((line) => `<div class="rv-line rv-${line.kind}" data-copy-prefix="${DIFF_PREFIX[line.kind]}"><span class="rv-ln">${line.old ?? ''}</span><span class="rv-ln">${line.new ?? ''}</span><span class="rv-mark">${mark[line.kind]}</span><code>${esc(line.text)}</code></div>`).join('');
    return `<div data-copy-scope><p class="rv-file-name"><span class="mono">${esc(spec.src || '')}</span>${copyLinesButton}</p><div class="rv-code rv-diff" role="region" aria-label="${esc(`Diff: ${item.title || item.id}`)}" tabindex="0">${rows}</div></div>${cutNote(lines.length)}`;
  });
}

function fileEvidence(pack, item, spec, h) {
  const { esc } = h;
  return textFile(pack, spec.src || '', h, (text) => {
    const lines = fileLines(text);
    const rows = lines.slice(0, CODE_LINES_MAX).map((line, i) => `<div class="rv-line"><span class="rv-ln">${i + 1}</span><code>${esc(line)}</code></div>`).join('');
    const name = [spec.src, spec.language].filter(Boolean).join(' · ');
    return `<div data-copy-scope><p class="rv-file-name"><span class="mono">${esc(name)}</span>${copyLinesButton}</p><div class="rv-code rv-file" role="region" aria-label="${esc(`File: ${item.title || item.id}`)}" tabindex="0">${rows}</div></div>${cutNote(lines.length)}`;
  });
}

// The live check control next to a live link: set it, mark it checked, or clear it.
function liveActionHtml(item, disabled) {
  if (!(item.ask || []).includes('live')) return '';
  const live = item.answer?.live ?? null;
  const off = disabled ? ' disabled' : '';
  if (live === 'pending') return `<span class="rv-live-state"><span class="review-chip review-chip-warn">Needs live check</span><button type="button" class="rv-button" data-rv-live="done"${off}>${viewerIcon('check')}Checked</button></span>`;
  if (live === 'done') return `<span class="rv-live-state"><span class="review-chip review-chip-ok">Live check done</span><button type="button" class="rv-button rv-button-quiet" data-rv-live="none"${off}>Clear</button></span>`;
  return `<span class="rv-live-state"><button type="button" class="rv-button" data-rv-live="pending"${off}>${viewerIcon('live')}Needs live check</button></span>`;
}

function linkEvidence(item, spec, h, disabled) {
  const { esc } = h;
  const url = safeHttp(spec.url);
  const open = url
    ? `<a class="rv-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open${newTab}</a>`
    : '<p class="rv-error">The link is not valid.</p>';
  return `<div class="rv-link-card"><span class="rv-link-icon">${viewerIcon('link')}</span><span class="rv-link-t"><b>${esc(spec.label || item.title || '')}</b><small class="mono">${esc(url ? hostOf(url) : '')}</small></span>`
    + `<span class="rv-link-actions">${open}${liveActionHtml(item, disabled)}</span></div>`
    + '<p class="rv-help-line">Open the live product in a new tab, try it, and come back to answer.</p>';
}

function liveRowHtml(pack, item, spec, h, disabled) {
  const { esc } = h;
  if (!(item.ask || []).includes('live') || item.type === 'link') return '';
  const links = liveLinks(pack, spec).map((link) => `<a class="rv-open" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label || 'Open live')}${newTab}</a>`).join('');
  return `<div class="rv-live-row">${links}${liveActionHtml(item, disabled)}</div>`;
}

function checklistEvidence(item, spec, h, disabled) {
  const { esc } = h;
  const checks = item.answer?.checks || {};
  const rows = (spec.entries || []).filter(Boolean).map((entry) => `<li><label class="rv-check"><input type="checkbox" data-rv-check="${esc(entry.id)}"${checks[entry.id] ? ' checked' : ''}${disabled ? ' disabled' : ''}><span>${esc(entry.text)}</span></label></li>`).join('');
  const done = (spec.entries || []).filter((entry) => entry && checks[entry.id]).length;
  return `<p class="rv-help-line"><span class="num">${done}</span> of <span class="num">${(spec.entries || []).length}</span> checked</p><ul class="rv-checklist">${rows}</ul>`;
}

function fallbackEvidence(pack, spec, name, h) {
  const { esc } = h;
  return `<p class="rv-fallback">Herdr Boss has no viewer for ${esc(name)}. It shows the text.</p>${bodyHtml(pack, spec.body ?? (typeof spec.text === 'string' ? { text: spec.text } : null), h, '')}`;
}

const KNOWN = new Set(['image', 'image-pair', 'gallery', 'video', 'markdown', 'table', 'diff', 'file', 'link', 'checklist']);

function evidenceHtml(pack, item, spec, ui, h, disabled) {
  const type = spec.type || item.type;
  if (spec.fallbackFrom) return fallbackEvidence(pack, spec, spec.fallbackFrom, h);
  if (!KNOWN.has(type)) return fallbackEvidence(pack, spec, type || 'this item', h);
  switch (type) {
    case 'image': return imageEvidence(pack, item, spec, ui, h);
    case 'image-pair': return pairEvidence(pack, item, spec, ui, h);
    case 'gallery': return galleryEvidence(pack, item, spec, ui, h);
    case 'video': return videoEvidence(pack, item, spec, h);
    case 'markdown': return typeof spec.text === 'string' ? markdown(spec.text, h) : bodyHtml(pack, spec.body, h, '');
    case 'table': return tableEvidence(pack, item, spec, h);
    case 'diff': return diffEvidence(pack, item, spec, h);
    case 'file': return fileEvidence(pack, item, spec, h);
    case 'link': return linkEvidence(item, spec, h, disabled);
    case 'checklist': return checklistEvidence(item, spec, h, disabled);
    default: return '';
  }
}

// ---------- Notes, state, and pager ----------

function pinNotesHtml(item, ui, h, disabled) {
  const { esc } = h;
  const pins = item.answer?.pins || [];
  if (!pins.length || !(item.ask || []).includes('note')) return '';
  const rows = pins.map((pin) => {
    const text = ui.pinText?.[pin.n] ?? pin.text ?? '';
    return `<li data-key="rv-pin-note:${esc(pin.n)}"><span class="rv-pin rv-pin-static" aria-hidden="true">${esc(pin.n)}</span>`
      + `<input type="text" class="rv-pin-field" data-rv-pin-text="${esc(pin.n)}" maxlength="${PIN_TEXT_MAX}" value="${esc(text)}" aria-label="${esc(`Note for pin ${pin.n}`)}" placeholder="What is at this point?"${disabled ? ' disabled' : ''}>`
      + `<button type="button" class="rv-tool" data-rv-pin-remove="${esc(pin.n)}" aria-label="${esc(`Remove pin ${pin.n}`)}"${disabled ? ' disabled' : ''}>${viewerIcon('close')}</button></li>`;
  }).join('');
  return `<ol class="rv-pin-notes" aria-label="Pins">${rows}</ol>`;
}

function noteHtml(item, ui, h, disabled) {
  const { esc } = h;
  if (!(item.ask || []).includes('note')) return '';
  const stored = item.answer?.note || '';
  const note = ui.note ?? stored;
  if (!ui.noteOpen && !note) return '';
  const id = `rv-note-${esc(item.id)}`;
  return `<div class="rv-note" data-key="rv-note:${esc(item.id)}"><label class="rv-label" for="${id}">Note</label>`
    + `<textarea id="${id}" class="rv-note-field" data-rv-note maxlength="${NOTE_MAX}" rows="2" data-keep-attrs="style" placeholder="What should the project change or keep?"${disabled ? ' disabled' : ''}>${esc(note)}</textarea></div>`;
}

// A local message of the viewer (for example "No other item is open.") shows first. Otherwise the line shows the save
// status of the item from public/review-sync.js.
function statusHtml(ui, h) {
  const { esc } = h;
  if (ui.error) return `<p class="rv-status rv-status-error" role="alert">Not saved. ${esc(ui.error)}</p>`;
  if (ui.status) return `<p class="rv-status" role="status">${esc(ui.status)}</p>`;
  return syncStatusHtml(ui.sync || { kind: '' }, esc);
}

function conflictHtml(spec, ui, h) {
  const { esc } = h;
  if (!ui.conflict) return '';
  return `<div class="rv-conflict" role="alert"><p><b>Changed on another device.</b> The other answer: ${esc(answerSummary(ui.conflict.theirs, spec))}.</p>`
    + `<p>Your change: ${esc(answerSummary({ ...(ui.conflict.theirs || {}), ...ui.conflict.mine }, spec))}.</p>`
    + '<div class="rv-conflict-actions"><button type="button" class="rv-button" data-rv-conflict="mine">Keep mine</button><button type="button" class="rv-button" data-rv-conflict="theirs">Use theirs</button></div></div>';
}

// The notice of a changed item: what the earlier verdict was, when, and the Keep action that restores it.
function staleHtml(item, spec, h, disabled) {
  const { esc } = h;
  if (!item.stale) return '';
  const previous = item.answer?.previous;
  const day = typeof previous?.at === 'string' ? previous.at.slice(0, 10) : '';
  const was = previous ? ` Was: ${esc(answerSummary(previous, spec))}${day ? ` on ${esc(day)}` : ''}.` : '';
  const keep = previous && !disabled ? '<button type="button" class="rv-button rv-keep" data-rv-keep>Keep</button>' : '';
  return `<div class="rv-stale">${viewerIcon('note', 'app-icon rv-stale-icon')}<p><b>Changed since accepted.</b>${was} Answer again${keep ? ' or keep the earlier answer' : ''}.</p>${keep}</div>`;
}

function pagerHtml(pack, item, h, itemUrl, needsYouOnly = false) {
  const { esc } = h;
  const items = visibleItems(pack.items, needsYouOnly, item.id);
  const { prev, next } = itemNeighbors(items, item.id);
  const open = nextOpenItem(items, item.id);
  const link = (target, label, icon, rel) => (target
    ? `<a class="rv-page-link" href="${esc(itemUrl(target.id))}"${rel ? ` rel="${rel}"` : ''}>${icon === 'prev' ? viewerIcon(icon) : ''}<span>${label}</span>${icon === 'next' ? viewerIcon(icon) : ''}</a>`
    : `<span class="rv-page-link" aria-disabled="true">${icon === 'prev' ? viewerIcon(icon) : ''}<span>${label}</span>${icon === 'next' ? viewerIcon(icon) : ''}</span>`);
  return `<nav class="rv-pager" aria-label="Items">${link(prev, 'Previous', 'prev', 'prev')}${open ? `<a class="rv-page-link rv-page-open" href="${esc(itemUrl(open.id))}">Next open</a>` : '<span class="rv-page-link" aria-disabled="true">No open item</span>'}${link(next, 'Next', 'next', 'next')}</nav>`;
}

const itemUrlOf = (pack) => (id) => `/reviews/${encodeURIComponent(pack.slug)}/${encodeURIComponent(pack.pack)}/${encodeURIComponent(id)}`;

// ---------- Verified badge, item anatomy, and agent evidence ----------

const BADGE = {
  'agent-verified': { cls: 'agent', icon: 'agent', word: 'agent-verified' },
  'needs-you': { cls: 'you', icon: 'person', word: 'needs-you' },
};

// The badge of one item: an icon and a word, never color alone. An unmarked item has a neutral badge.
export function verifiedBadgeHtml(item, esc) {
  const kind = (Object.hasOwn(BADGE, item?.verifiedBy ?? '') && BADGE[item.verifiedBy]) || { cls: 'none', icon: 'unmarked', word: 'unmarked' };
  return `<span class="review-badge review-badge-${kind.cls}" title="${esc(kind.word)}">${viewerIcon(kind.icon, 'app-icon review-badge-icon')}<span class="review-badge-word">${esc(kind.word)}</span></span>`;
}

// The description (two lines), the numbered steps, the expected result, and the link to the app. Every field goes through esc().
function anatomyHtml(item, spec, h) {
  const { esc } = h;
  const field = (name) => item[name] ?? spec[name];
  const description = typeof field('description') === 'string' ? field('description').split(/\r?\n/).filter((line) => line.trim()) : [];
  const steps = Array.isArray(field('steps')) ? field('steps').filter((step) => typeof step === 'string') : [];
  const expected = typeof field('expected') === 'string' ? field('expected') : '';
  const url = safeHttp(field('link'));
  const parts = [];
  if (description.length) parts.push(`<p class="rv-description">${description.map((line) => esc(line)).join('<br>')}</p>`);
  if (steps.length) parts.push(`<h3 class="rv-anatomy-h">Steps</h3><ol class="rv-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>`);
  if (expected) parts.push(`<h3 class="rv-anatomy-h">Expected</h3><p class="rv-expected">${esc(expected)}</p>`);
  if (url) parts.push(`<p class="rv-app-link"><a class="rv-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open the app${newTab}</a></p>`);
  return parts.length ? `<div class="rv-anatomy">${parts.join('')}</div>` : '';
}

// A file that did not load shows its name as text. public/app.js records the failure in ui.missing.
const missingHtml = (ref, esc) => `<span class="rv-ev-missing">File not found: ${esc(ref)}</span>`;

// The evidence images of an agent-verified item: a grid, then one image in the zoom stage, as in a gallery.
// ui.evidence is the open image index, or null for the grid.
function agentEvidenceHtml(pack, item, spec, ui, h) {
  const { esc } = h;
  const refs = (Array.isArray(item.evidence) ? item.evidence : spec.evidence || []).filter((ref) => typeof ref === 'string');
  if (item.verifiedBy !== 'agent-verified' || !refs.length) return '';
  const index = Number.isInteger(ui.evidence) && ui.evidence >= 0 && ui.evidence < refs.length ? ui.evidence : null;
  const missing = (ref) => Boolean(ui.missing && Object.hasOwn(ui.missing, ref));
  const heading = `<h3 class="rv-evidence-h">Agent evidence <span class="num">${refs.length}</span></h3>`;
  if (index === null) {
    const tiles = refs.map((ref, i) => (missing(ref)
      ? `<li>${missingHtml(ref, esc)}</li>`
      : `<li><button type="button" class="rv-tile" data-rv-evopen="${i}" aria-label="${esc(`Open evidence image ${i + 1} of ${refs.length}`)}"><img src="${esc(fileUrl(pack, ref))}" alt="" loading="lazy" decoding="async" draggable="false" data-rv-evfile="${esc(ref)}"></button></li>`)).join('');
    return `<section class="rv-evidence-agent-box" aria-label="Agent evidence">${heading}<ul class="rv-grid" aria-label="${esc(`${refs.length} evidence images`)}">${tiles}</ul></section>`;
  }
  const step = (to, label, name) => `<button type="button" class="rv-tool" data-rv-evgallery="${to}" aria-label="${label}"${to >= 0 && to < refs.length ? '' : ' disabled'}>${viewerIcon(name)}</button>`;
  const canvas = missing(refs[index])
    ? missingHtml(refs[index], esc)
    : `<img class="rv-img" src="${esc(fileUrl(pack, refs[index]))}" alt="${esc(`Evidence image ${index + 1} of ${refs.length}`)}" decoding="async" draggable="false" data-rv-evfile="${esc(refs[index])}">`;
  const tools = `<div class="rv-tools"><span class="rv-gallery-nav"><button type="button" class="rv-tool rv-tool-text" data-rv-evgallery="grid" aria-label="All evidence images">${viewerIcon('grid')}<span class="rv-tool-label" aria-hidden="true">All images</span></button>`
    + `${step(index - 1, 'Previous image', 'prev')}<span class="rv-gallery-count num">${index + 1} of ${refs.length}</span>${step(index + 1, 'Next image', 'next')}</span>`
    + `<span class="rv-tools-end"><button type="button" class="rv-tool" data-rv-zoom="out" aria-label="Zoom out">${viewerIcon('minus')}</button>`
    + `<button type="button" class="rv-tool" data-rv-zoom="fit" aria-label="Fit or 100 percent">${viewerIcon('fit')}</button>`
    + `<button type="button" class="rv-tool" data-rv-zoom="in" aria-label="Zoom in">${viewerIcon('plus')}</button></span></div>`;
  return `<section class="rv-evidence rv-evidence-agent" aria-label="Agent evidence">${heading}${stageHtml(`${esc(item.id)}:ev${index}`, { canvas, label: stageLabel, ui })}${tools}</section>`;
}

// ui: pair ('a' or 'b'), pairMode ('toggle' or 'split'), split (0 to 100), gallery (an image index, or null for the grid),
// placing (the next tap drops a pin), hint, noteOpen, note (the draft), pinText (drafts by pin number), status, error, conflict.
export function itemViewerHtml(pack, item, ui, h) {
  const { esc } = h;
  const spec = { ...itemSpec(pack, item.id), type: itemSpec(pack, item.id).type || item.type };
  const disabled = pack.state !== 'open';
  const type = spec.fallbackFrom ? 'fallback' : spec.type;
  const body = spec.fallbackFrom || spec.type === 'markdown' || !KNOWN.has(spec.type) ? '' : bodyHtml(pack, spec.body, h);
  const closed = disabled ? `<p class="rv-help-line">This pack is ${esc(pack.state)}. The answers cannot change.</p>` : '';
  return `<section class="rv-item rv-type-${esc(type)}" data-key="rv-item:${esc(item.id)}" aria-label="${esc(item.title || item.id)}">`
    + staleHtml(item, spec, h, disabled)
    + (item.verifiedBy ? `<div class="rv-item-head">${verifiedBadgeHtml(item, esc)}</div>` : '')
    + anatomyHtml(item, spec, h)
    + `<div class="rv-evidence">${evidenceHtml(pack, item, spec, ui, h, disabled)}</div>`
    + liveRowHtml(pack, item, spec, h, disabled)
    + agentEvidenceHtml(pack, item, spec, ui, h)
    + body
    + pinNotesHtml(item, ui, h, disabled)
    + statusHtml(ui, h)
    + conflictHtml(spec, ui, h)
    + closed
    + pagerHtml(pack, item, h, itemUrlOf(pack), ui.needsYouOnly === true)
    + '</section>';
}

// The answer bar: only the questions in `ask`. A pressed button shows the stored answer. A key hint shows on a desktop.
export function answerBarHtml(pack, item, ui, h) {
  const { esc } = h;
  const spec = itemSpec(pack, item.id);
  const ask = effectiveAsk(item);
  const answer = item.answer || {};
  const off = pack.state !== 'open' ? ' disabled' : '';
  const kbd = (key) => `<kbd class="rv-kbd">${key}</kbd>`;
  // A field with a running save shows busy. The button stays enabled, so it keeps the focus.
  const busy = (field) => (ui.pending?.[field] ? ' aria-busy="true"' : '');
  const button = (attrs, field, pressed, tone, icon, label, key) => `<button type="button" class="rv-act${tone ? ` rv-act-${tone}` : ''}" ${attrs} aria-pressed="${pressed ? 'true' : 'false'}"${busy(field)}${off}>${viewerIcon(icon)}<span>${label}</span>${key ? kbd(key) : ''}</button>`;

  const rows = [];
  if (ask.includes('choice')) {
    const choices = (spec.choices || []).filter(Boolean).map((choice, i) => `<button type="button" class="rv-choice" data-rv-choice="${esc(choice.id)}" aria-pressed="${answer.choice === choice.id ? 'true' : 'false'}"${busy('choice')}${off}>`
      + `<span class="rv-radio" aria-hidden="true"></span><span class="rv-choice-body"><span class="rv-choice-label">${esc(choice.label)}</span>`
      + `${typeof choice.consequence === 'string' && choice.consequence ? `<span class="rv-choice-text">${esc(choice.consequence)}</span>` : ''}</span>`
      + `${choice.recommended === true ? '<span class="rv-recommended">Recommended</span>' : ''}${kbd(i + 1)}</button>`).join('');
    rows.push(`<div class="rv-choices" role="group" aria-label="Choice">${choices}</div>`);
  }
  if (ask.includes('rating')) {
    const max = spec.rating?.max || 5;
    const stars = Array.from({ length: max }, (_, i) => i + 1).map((n) => `<button type="button" class="rv-star${answer.rating >= n ? ' on' : ''}" data-rv-rating="${n}" aria-pressed="${answer.rating === n ? 'true' : 'false'}" aria-label="Rate ${n} of ${max}"${busy('rating')}${off}>${viewerIcon('star')}</button>`).join('');
    rows.push(`<div class="rv-rating" role="group" aria-label="Rating">${stars}<span class="rv-rating-text">${answer.rating ? `Rated ${esc(answer.rating)} of ${max}` : 'Not rated'}</span></div>`);
  }
  const main = [];
  if (ask.includes('deny')) main.push(button('data-rv-decision="deny"', 'decision', answer.decision === 'deny', 'crit', 'close', 'Deny', 'd'));
  if (ask.includes('note')) {
    const pins = (answer.pins || []).length;
    main.push(`<button type="button" class="rv-act${answer.note || pins ? ' rv-act-info' : ''}" data-rv-note-open aria-expanded="${ui.noteOpen || answer.note ? 'true' : 'false'}"${ui.pending?.note || ui.pending?.pins ? ' aria-busy="true"' : ''}${off}>${viewerIcon('note')}<span>Note${pins ? ` <span class="num">${pins}</span>` : ''}</span>${kbd('c')}</button>`);
  }
  if (ask.includes('live')) {
    const live = answer.live ?? null;
    main.push(button(`data-rv-live="${live ? 'none' : 'pending'}"`, 'live', Boolean(live), live === 'done' ? 'ok' : 'warn', 'live', live === 'done' ? 'Live done' : 'Live', 'l'));
  }
  if (ask.includes('accept')) main.push(button('data-rv-decision="accept"', 'decision', answer.decision === 'accept', 'ok', 'check', 'Accept', 'a'));
  if (main.length) rows.push(`<div class="rv-acts" style="--rv-acts: ${main.length}">${main.join('')}</div>`);
  // Ask later is built in. It needs no `ask` entry. The item stays open and moves to the end of the pack.
  rows.push(`<div class="rv-later">${button('data-rv-decision="skip"', 'decision', answer.decision === 'skip', '', 'later', 'Ask later', 'b')}</div>`);
  rows.push(noteHtml(item, ui, h, pack.state !== 'open'));
  const readOnly = off ? '<p class="rv-help-line">Read only.</p>' : '';
  // The pill sits above the bar in its own slot, so a status change never moves a button under the finger.
  return `<div class="rv-answer" data-key="rv-answer:${esc(item.id)}" role="group" aria-label="Answer">${packStatusHtml(ui.packSync || { kind: '' }, esc)}${readOnly}${rows.join('')}</div>`;
}

// The slim top bar of the item viewer: Back, one h1 with the title, the place and the section, and the Viewed toggle.
export function viewerBarHtml(pack, item, h) {
  const { esc } = h;
  const { index, total } = itemNeighbors(pack.items, item.id);
  const section = (pack.derived?.sections || []).find((entry) => entry.id === item.section);
  const back = `/reviews/${encodeURIComponent(pack.slug)}/${encodeURIComponent(pack.pack)}#item=${encodeURIComponent(item.id)}`;
  const viewed = Boolean(item.answer?.viewed);
  return `<a href="${esc(back)}" class="app-icon-button" aria-label="Back to the sections">${viewerIcon('back')}</a>`
    + `<h1 class="review-title" tabindex="-1" data-rv-heading title="${esc(item.title || item.id)}">${esc(item.title || item.id)}<small><span class="num review-item-count">Item ${index + 1} of ${total}</span> · ${esc(section?.title || item.section)}</small></h1>`
    + `<button type="button" class="app-icon-button rv-viewed-toggle" data-rv-viewed aria-label="Viewed" aria-pressed="${viewed ? 'true' : 'false'}"${pack.state !== 'open' ? ' disabled' : ''}><span class="review-viewed${viewed ? ' on' : ''}">${viewed ? viewerIcon('check') : ''}</span></button>`;
}
