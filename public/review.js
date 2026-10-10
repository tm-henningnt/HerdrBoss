// The reviewer pages of hosted review packs: the pack list, the section list, the progress bar, and the Mailbox entry.
// See docs/ideas/review-packs.md, section The reviewer UI. The module has no DOM use, so the Node tests import it directly.
// Each render function takes helpers: esc, avatar(slug), projectLabel(slug), time(iso), and menuButton (HTML).
// Every value from the server goes through esc(). A URL part goes through encodeURIComponent() and then esc().
// The item route shows the item viewer of public/review-viewer.js. It takes ui.viewer (the view state of the item)
// and the helper text(url), which gives a loaded text file of the pack.
import { itemViewerHtml, answerBarHtml, viewerBarHtml, itemSpec, viewerIcon, verifiedBadgeHtml } from './review-viewer.js';
import { visibleItems, needsYouCount } from './review-filter.js';
import { safeUrl } from './markdown.js';
import { sidebarHandleHtml, clampWidth, SIDEBAR_DEFAULT, SIDEBAR_RAIL } from './review-sidebar.js';
import { answerHandleHtml, clampAnswer, ANSWER_DEFAULT } from './review-answer.js';
import { syncStatusHtml, packStatusHtml, submitLock, rowSyncText } from './review-sync.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The item states in the fixed order of the progress bar. `count` names the field of the server counts.
// Accepted also counts a choice or a rating, because the Owner took an offered option.
export const REVIEW_STATES = [
  { key: 'accepted', count: 'accepted', label: 'Accepted', text: 'accepted', tone: 'ok' },
  { key: 'note', count: 'noteOnly', label: 'Note only', text: 'note only', tone: 'info' },
  { key: 'live', count: 'live', label: 'Needs live check', text: 'needs live check', tone: 'warn' },
  { key: 'denied', count: 'denied', label: 'Denied', text: 'denied', tone: 'crit' },
  { key: 'open', count: 'open', label: 'Open', text: 'open', tone: 'open' },
];

const GROUP_CHIP = {
  changed: { tone: 'changed', label: 'Changed', icon: 'changed' },
  accepted: { tone: 'ok', label: 'Accepted', icon: 'check' },
  denied: { tone: 'crit', label: 'Denied', icon: 'close' },
  live: { tone: 'warn', label: 'Live check', icon: 'live' },
  open: { tone: 'open', label: 'Open', icon: '' },
};

// The verdicts of the submit form. The Owner chooses one. The summary proposes one from the counts and never forces it.
const VERDICTS = [
  { key: 'accept', label: 'Accept pack', done: 'Accepted', tone: 'ok', icon: 'check', hint: 'Accept the pack as it is.' },
  { key: 'accept-with-changes', label: 'Accept with changes', done: 'Accepted with changes', tone: 'warn', icon: 'note', hint: 'The project makes the changes that you listed.' },
  { key: 'deny', label: 'Deny pack', done: 'Denied', tone: 'crit', icon: 'close', hint: 'The project does not ship this pack.' },
];
// A result that an earlier build stored keeps its own label. The form does not offer these.
const LEGACY_VERDICTS = [
  { key: 'approve', label: 'Approve', done: 'Approve', tone: 'ok', icon: 'check' },
  { key: 'request-changes', label: 'Request changes', done: 'Request changes', tone: 'crit', icon: 'close' },
  { key: 'comment', label: 'Comment', done: 'Comment', tone: 'info', icon: 'note' },
];
const NO_CHANGE_TEXT = 'No change text: no item and no pack note holds text.';

// The computed verdict. `accept` needs every item accepted and no note text on any item or on the pack. Note text, a denied
// item, a needs-live-check item, or an open item gives `accept-with-changes`. `deny` is never computed.
export function computeVerdict(pack, note = pack?.note) {
  const counts = pack?.derived?.counts || {};
  const text = Boolean(String(note ?? '').trim()) || (pack?.items || []).some((item) => String(item.answer?.note ?? '').trim());
  return !counts.items || text || counts.denied > 0 || counts.live > 0 || counts.open > 0 ? 'accept-with-changes' : 'accept';
}
const hasChangeText = (pack, note) => Boolean(String(note ?? '').trim()) || (pack?.items || []).some((item) => String(item.answer?.note ?? '').trim());

const TYPE_LABEL = {
  image: 'Image', 'image-pair': 'Image pair', gallery: 'Gallery', video: 'Video', markdown: 'Text', table: 'Table',
  diff: 'Diff', file: 'File', link: 'Live link', checklist: 'Checklist', page: 'Page', custom: 'Custom',
};
const TYPE_ICON = {
  image: 'image', 'image-pair': 'pair', gallery: 'image', video: 'video', markdown: 'doc', table: 'table',
  diff: 'diff', file: 'doc', link: 'link', checklist: 'list', page: 'doc', custom: 'doc',
};

const ICON = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<path d="M5 4.5h14v11H10l-5 4v-15Z"/><path d="M9 9h6M9 12h4"/>',
  live: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5H5V6h5"/>',
  changed: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  pair: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14"/><path d="M12 5h6.5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H12z" fill="currentColor" stroke="none" opacity=".35"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  doc: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 10h17M3.5 14.5h17M10 5v14"/>',
  diff: '<path d="M8 4v10M3 9h10M12 18h9"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><path d="M4 7l1 1 2-2M4 12l1 1 2-2M4 17l1 1 2-2"/>',
  filter: '<path d="M4 6h16l-6 7v5l-4 2v-7z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
};
const icon = (name, className = 'app-icon') => (ICON[name] ? `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>` : '');

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- Routes ----------

// The view of a /reviews path: list, pack, item, summary, or missing. Another path gives null.
export function parseReviewPath(pathname) {
  if (pathname !== '/reviews' && !pathname.startsWith('/reviews/')) return null;
  let parts;
  try { parts = pathname.split('/').slice(2).filter(Boolean).map((part) => decodeURIComponent(part)); } catch { return { view: 'missing' }; }
  if (parts.length === 0) return { view: 'list' };
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => SLUG.test(part))) return { view: 'missing' };
  const [slug, pack, item] = parts;
  if (parts.length === 2) return { view: 'pack', slug, pack };
  if (item === 'summary') return { view: 'summary', slug, pack };
  return { view: 'item', slug, pack, item };
}

// The pack page reads #item=<id>: it marks that row and scrolls it into view. Back from an item uses it.
export function reviewItemFromHash(hash) {
  const match = /^#item=([^&]+)$/.exec(hash || '');
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return null; }
  return SLUG.test(id) ? id : null;
}

export function reviewUrl(slug, pack, item) {
  const base = `/reviews/${encodeURIComponent(slug)}/${encodeURIComponent(pack)}`;
  return item ? `${base}/${encodeURIComponent(item)}` : base;
}

// ---------- Progress ----------

const answeredOf = (counts) => Math.max(0, (counts?.items || 0) - (counts?.open || 0));

export function progressText(counts) {
  return REVIEW_STATES.map((state) => `${counts?.[state.count] || 0} ${state.text}`).join(', ');
}

// One stacked bar of the item states. Each segment has a 2 px gap; Denied has a hatch. The legend names each state with its count.
export function progressBarHtml(counts, { esc, legend = false } = {}) {
  const total = counts?.items || 0;
  const label = `${answeredOf(counts)} of ${plural(total, 'item')} answered: ${progressText(counts)}`;
  const segments = REVIEW_STATES.filter((state) => (counts?.[state.count] || 0) > 0)
    .map((state) => `<span class="review-seg review-seg-${state.tone}" style="flex: ${counts[state.count]} 1 0" title="${esc(state.label)} ${counts[state.count]}"></span>`).join('');
  const key = legend
    ? `<ul class="review-legend">${REVIEW_STATES.map((state) => `<li><i class="review-swatch review-seg-${state.tone}" aria-hidden="true"></i>${esc(state.label)} <b class="num">${counts?.[state.count] || 0}</b></li>`).join('')}</ul>`
    : '';
  return `<div class="review-progress"><div class="review-bar${legend ? ' review-bar-lg' : ''}" role="img" aria-label="${esc(label)}">${segments}</div>${key}</div>`;
}

// The answered and total items of one section.
export function sectionProgress(pack, sectionId) {
  const items = (pack.items || []).filter((item) => item.section === sectionId);
  return { answered: items.filter((item) => item.state !== 'open' && item.state !== 'changed').length, total: items.length };
}

// ---------- Chips ----------

function chipHtml({ tone, label, icon: name }, esc, extra = '') {
  return `<span class="review-chip review-chip-${tone}${name ? ' has-icon' : ''}" title="${esc(label)}"${extra}>${icon(name, 'app-icon review-chip-icon')}<span class="review-chip-label">${esc(label)}</span></span>`;
}

function manifestItem(pack, id) {
  for (const section of pack?.manifest?.sections || []) {
    const found = (section.items || []).find((entry) => entry.id === id);
    if (found) return found;
  }
  return null;
}

// The state chip of one item: a word and an icon, never color alone.
export function itemChip(item, pack) {
  if (item.stale || item.state === 'changed') return { tone: 'changed', label: 'Changed', icon: 'changed' };
  if (item.skipped && item.state === 'open') return { tone: 'open', label: 'Ask later', icon: '' };
  const answer = item.answer || {};
  switch (item.state) {
    case 'denied': return { tone: 'crit', label: 'Denied', icon: 'close' };
    case 'accepted': return { tone: 'ok', label: 'Accepted', icon: 'check' };
    case 'live': return { tone: 'warn', label: 'Live check', icon: 'live' };
    case 'note': return { tone: 'info', label: answer.note ? 'Note' : 'Info', icon: 'note' };
    case 'answered': {
      if (answer.choice !== null && answer.choice !== undefined) {
        const choice = (manifestItem(pack, item.id)?.choices || []).find((entry) => entry.id === answer.choice);
        return { tone: 'ok', label: String(choice?.label ?? answer.choice), icon: 'check' };
      }
      if (answer.rating !== null && answer.rating !== undefined) return { tone: 'ok', label: `Rated ${answer.rating}`, icon: 'check' };
      return { tone: 'ok', label: 'Answered', icon: 'check' };
    }
    default: return { tone: 'open', label: 'Open', icon: '' };
  }
}

function verdictInfo(key) {
  return [...VERDICTS, ...LEGACY_VERDICTS].find((verdict) => verdict.key === key) || null;
}

function doneChip(pack, esc) {
  if (pack.state === 'expired') return chipHtml({ tone: 'open', label: 'Expired', icon: '' }, esc);
  const verdict = verdictInfo(pack.verdict);
  return verdict ? chipHtml({ tone: verdict.tone, label: verdict.done, icon: verdict.icon }, esc) : chipHtml({ tone: 'open', label: 'Submitted', icon: '' }, esc);
}

// ---------- Pack list ----------

export function packRowHtml(pack, h) {
  const { esc } = h;
  const id = `${pack.slug}/${pack.pack}`;
  const open = pack.state === 'open';
  const stale = open && pack.stale > 0 ? chipHtml({ tone: 'changed', label: `${pack.stale} changed`, icon: 'changed' }, esc) : '';
  const status = open
    ? `${progressBarHtml(pack.counts, { esc })}<span class="review-row-count">${answeredOf(pack.counts)} of ${esc(plural(pack.counts?.items || 0, 'item'))} answered</span>${stale}`
    : doneChip(pack, esc);
  return `<a class="review-row" href="${esc(reviewUrl(pack.slug, pack.pack))}" data-key="review-pack:${esc(id)}" data-review-row="${esc(id)}">`
    + `<span class="review-row-avatar">${h.avatar(pack.slug)}</span>`
    + `<span class="review-row-main"><span class="review-row-top"><strong class="review-row-title">${esc(pack.title)}</strong><span class="review-row-meta num">v${esc(pack.version)} · ${esc(h.time(pack.updatedAt))}</span></span>`
    + `<span class="review-row-project">${esc(h.projectLabel(pack.slug))}</span>`
    + `<span class="review-row-status">${status}</span></span></a>`;
}

// view: folder ('open' or 'done'), open and done (lists, or null while they load), error.
export function packListHtml(view, h) {
  const { esc } = h;
  const folder = view.folder === 'done' ? 'done' : 'open';
  const list = view[folder];
  const tab = (key, label) => {
    const count = Array.isArray(view[key]) ? ` <span class="num">${view[key].length}</span>` : '';
    return `<a href="/reviews?folder=${key}"${key === folder ? ' aria-current="page"' : ''}>${label}${count}</a>`;
  };
  let body;
  if (view.error) body = `<div class="review-empty" role="alert"><p>The reviews could not load. ${esc(view.error)}</p><button type="button" class="review-button" data-review-retry>Try again</button></div>`;
  else if (!list) body = '<p class="review-empty">Loading reviews…</p>';
  else if (!list.length) body = folder === 'open'
    ? '<div class="review-empty"><p>No review waits for you.</p><p>A project sends a review pack to the Mailbox when it needs your decision on evidence.</p></div>'
    : '<div class="review-empty"><p>No finished reviews.</p><p>A pack moves here after you submit it, or when it expires.</p></div>';
  else body = `<div class="review-rows">${list.map((pack) => packRowHtml(pack, h)).join('')}</div>`;
  return `<div class="review-page review-list" data-key="reviews:list">`
    + `<div class="app-bar review-app-bar">${h.menuButton || ''}<h1>Reviews</h1>${h.barIcons || ''}</div>`
    + `<nav class="review-tabs" aria-label="Review folders">${tab('open', 'Open')}${tab('done', 'Done')}</nav>`
    + `<div class="review-scroll" data-key="reviews:scroll:${folder}">${body}</div></div>`;
}

// ---------- Summary header ----------

const DESIGN_ICON = { passed: 'check', issues: 'note', 'not-run': '' };

// One compact row above the progress: the item counts and the design pass. A pack without the new fields has no row.
export function summaryHeaderHtml(pack, esc) {
  const items = pack.items || [];
  const summary = pack.summary || {
    total: items.length,
    agentVerified: items.filter((item) => item.verifiedBy === 'agent-verified').length,
    needsYou: needsYouCount(items),
    unmarked: items.filter((item) => item.verifiedBy !== 'agent-verified' && item.verifiedBy !== 'needs-you').length,
    designPass: pack.manifest?.designPass?.result ?? 'not-run',
  };
  const design = pack.manifest?.designPass;
  if (!summary.agentVerified && !summary.needsYou && !design) return '';
  const count = (n, word) => `<span><b class="num">${esc(n)}</b> ${word}</span>`;
  const cells = [count(summary.total, plural(summary.total, 'item').replace(/^\d+ /, '')), count(summary.agentVerified, 'agent-verified'), count(summary.needsYou, 'needs-you')];
  if (summary.unmarked > 0) cells.push(count(summary.unmarked, 'unmarked'));
  const result = Object.hasOwn(DESIGN_ICON, summary.designPass) ? summary.designPass : 'not-run';
  const reviewer = design?.reviewer ? ` · ${esc(design.reviewer)}` : '';
  const note = design?.note ? `<small class="review-design-note">${esc(design.note)}</small>` : '';
  cells.push(`<span class="review-design review-design-${result}">${icon(DESIGN_ICON[result])}Design pass: <b>${esc(result)}</b>${reviewer}${note}</span>`);
  return `<div class="review-summary-row" role="group" aria-label="Pack summary">${cells.join('')}</div>`;
}

// The judge-pass note of a pack: the text of the independent judge pass that ran, or a plain note when it is missing.
// The publish command stores the text on the manifest of the version.
export function judgePassNoteHtml(pack, esc) {
  const pass = pack.manifest?.judgePass;
  return pass
    ? `<small class="review-judge-note">Judge pass: ${esc(pass)}</small>`
    : '<small class="review-judge-note review-judge-none">no judge pass</small>';
}

// ---------- Section list ----------

function itemRowHtml(pack, item, ui, esc) {
  const answer = item.answer || {};
  const viewed = Boolean(answer.viewed) && !item.stale;
  const done = viewed && item.state !== 'open' && item.state !== 'changed';
  const sub = [TYPE_LABEL[item.type] || 'Item'];
  if (answer.note) sub.push('note');
  const sync = rowSyncText(ui.itemSync?.(item.id));
  if (sync) sub.push(sync);
  const current = ui.current === item.id || ui.item === item.id;
  const title = item.title || item.id;
  const number = (pack.items || []).indexOf(item) + 1;
  return `<li><a class="review-item${done ? ' review-item-done' : ''}" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}" data-key="review-item:${esc(item.id)}" data-review-row="${esc(item.id)}"${current ? ' aria-current="true"' : ''}>`
    + `<span class="review-thumb">${icon(TYPE_ICON[item.type] || 'doc')}</span>`
    + `<span class="review-item-t"><span class="review-item-line"><span class="review-item-n num">${number}</span><span class="review-item-title" title="${esc(title)}">${esc(title)}</span></span><small>${esc(sub.join(' · '))}</small></span>`
    + `<span class="review-item-end">${verifiedBadgeHtml(item, esc)}${chipHtml(itemChip(item, pack), esc)}`
    + `<span class="review-viewed${viewed ? ' on' : ''}">${viewed ? icon('check') : ''}<span class="visually-hidden">${viewed ? 'Viewed' : 'Not viewed'}</span></span></span></a></li>`;
}

function sectionHtml(pack, section, ui, esc) {
  const items = visibleItems(pack.items, ui.needsYouOnly === true, ui.current || ui.item).filter((item) => item.section === section.id);
  if (ui.needsYouOnly === true && !items.length) return '';
  const { answered, total } = sectionProgress(pack, section.id);
  const folded = section.state === 'accepted' && items.every((item) => item.answer?.viewed) && !items.some((item) => item.id === ui.current || item.id === ui.item);
  const title = section.title || section.id;
  return `<details class="review-section" data-key="review-sec:${esc(section.id)}" data-keep-attrs="open"${folded ? '' : ' open'}>`
    + `<summary class="review-sec-h"><h2 title="${esc(title)}">${esc(title)}</h2>${chipHtml(GROUP_CHIP[section.state] || GROUP_CHIP.open, esc)}<span class="review-sec-count num">${answered} / ${total}</span></summary>`
    + `<ul class="review-items">${items.map((item) => itemRowHtml(pack, item, ui, esc)).join('')}</ul></details>`;
}

// The sections column. At 900 px and wider it has a bar with the collapse button, and a collapsed column is a thin rail with an expand button.
function sectionsNavHtml(pack, sections, ui, esc, collapsed) {
  const tool = collapsed
    ? '<button type="button" class="review-side-button" data-review-expand aria-label="Show the sections column" title="Show the sections column">' + '<span class="review-side-glyph" aria-hidden="true">»</span>' + '</button>'
    : '<span class="review-side-title">Sections</span><button type="button" class="review-side-button" data-review-collapse aria-label="Hide the sections column" title="Hide the sections column">' + '<span class="review-side-glyph" aria-hidden="true">«</span>' + '</button>';
  const count = needsYouCount(pack.items);
  const on = ui.needsYouOnly === true;
  const marked = (pack.items || []).some((item) => item.verifiedBy === 'agent-verified' || item.verifiedBy === 'needs-you');
  const filter = !collapsed && (marked || on)
    ? `<div class="review-filter"><button type="button" class="review-filter-chip" data-review-filter aria-pressed="${on ? 'true' : 'false'}">${icon('filter')}<span>Needs you</span><span class="num">${count}</span></button></div>`
    : '';
  const sectionRows = collapsed ? '' : sections.map((section) => sectionHtml(pack, section, ui, esc)).join('');
  const empty = !collapsed && on && !sectionRows
    ? '<p class="review-filter-empty" role="status">Nothing needs you. <button type="button" class="review-filter-clear" data-review-filter-clear>Show all items</button></p>'
    : '';
  return `<nav class="review-sections${collapsed ? ' is-collapsed' : ''}" aria-label="Sections"><div class="review-side-bar">${tool}</div>${filter}`
    + (collapsed ? '' : sectionRows + empty) + '</nav>';
}

// The summary groups in the order of the decision: denied, needs live check, notes, accepted, and open last.
const SUMMARY_GROUPS = [
  { label: 'Denied', has: (item) => item.state === 'denied' },
  { label: 'Needs live check', has: (item) => item.state === 'live' },
  { label: 'Note only', has: (item) => item.state === 'note' },
  { label: 'Accepted', has: (item) => item.state === 'accepted' || item.state === 'answered' },
  { label: 'Changed since accepted', has: (item) => item.state === 'changed' },
  { label: 'Open', has: (item) => item.state === 'open' },
];

// The delivery of the result to the orchestrator, as a state, a label, and a sentence. The API gives the status of the Owner message:
// queued, sent, or failed, with the attempts and the retry flag. The text holds the raw error: the caller escapes it.
export function deliveryText(delivery) {
  if (!delivery) return null;
  const error = String(delivery.error || 'unknown error').replace(/\.$/, '');
  if (delivery.status === 'error') return { state: 'failed', label: 'Failed', text: `The result is stored but not queued for the orchestrator: ${error}. Select Queue again.`, again: true };
  if (delivery.status === 'sent') {
    return { state: 'sent', label: 'Delivered', text: delivery.attempts > 1 ? `The orchestrator got the result after a retry. Attempts: ${delivery.attempts}.` : 'The orchestrator got the result.' };
  }
  if (delivery.status === 'failed') {
    if (delivery.retry) return { state: 'retrying', label: 'Retrying', text: `Attempt ${delivery.attempts} of ${delivery.maxAttempts} failed: ${error}. Herdr Boss tries again.` };
    return { state: 'failed', label: 'Failed', text: `Delivery failed after ${delivery.attempts} attempts: ${error}. The result is stored. The orchestrator can run herdr-boss review result.` };
  }
  return { state: 'queued', label: 'Queued', text: 'Waiting to send the result to the orchestrator.' };
}

const DELIVERY_TONE = { queued: 'open', sent: 'ok', retrying: 'warn', failed: 'crit' };

function deliveryHtml(delivery, esc) {
  const view = deliveryText(delivery);
  if (!view) return '';
  const again = view.again ? ' <button type="button" class="review-button" data-review-redeliver>Queue again</button>' : '';
  return `<p class="review-delivery" data-state="${view.state}" role="status">${chipHtml({ tone: DELIVERY_TONE[view.state], label: view.label, icon: '' }, esc)} <span>${esc(view.text)}</span>${again}</p>`;
}

function summaryHtml(pack, ui, esc) {
  const open = pack.state === 'open';
  const missing = (pack.items || []).filter((item) => item.state === 'open' || item.state === 'changed').length;
  const blocks = SUMMARY_GROUPS.map((group) => {
    const items = (pack.items || []).filter(group.has);
    if (!items.length) return '';
    const rows = items.map((item) => {
      const note = item.answer?.note ? `<small class="review-sum-note">${esc(item.answer.note)}</small>` : '';
      const chosen = item.state === 'answered' ? `<small>${esc(itemChip(item, pack).label)}</small>` : '';
      const changed = item.stale ? '<small class="review-sum-stale">changed in this version</small>' : '';
      const canReview = open || item.reopened === true;
      const go = (group.label === 'Open' || group.label === 'Changed since accepted') && canReview ? `<a class="review-sum-go" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}">Review now</a>` : '';
      return `<li><a class="review-sum-title" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}">${esc(item.title || item.id)}</a>${go}${chosen}${changed}${note}</li>`;
    }).join('');
    return `<div class="review-sum-block"><h3 class="review-sum-h">${group.label} <span class="num">${items.length}</span></h3><ul>${rows}</ul></div>`;
  }).join('');
  const warning = missing ? `<p class="review-sum-warn" role="status">${open ? (missing === 1 ? '1 item has no decision' : `${missing} items have no decision`) : (missing === 1 ? '1 item had no decision' : `${missing} items had no decision`)}</p>` : '';

  let form;
  if (open) {
    const note = ui.note ?? pack.note ?? '';
    const proposed = computeVerdict(pack, note);
    const chosen = VERDICTS.some((verdict) => verdict.key === ui.verdict) ? ui.verdict : proposed;
    const flag = chosen === 'accept-with-changes' && !hasChangeText(pack, note) ? `<p class="review-sum-warn" role="status">${NO_CHANGE_TEXT}</p>` : '';
    const options = VERDICTS.map((verdict) => `<label class="review-verdict-option"><input type="radio" name="review-verdict" value="${verdict.key}"${verdict.key === chosen ? ' checked' : ''} data-review-verdict><span><b>${verdict.label}</b><small>${verdict.hint}</small></span>${verdict.key === proposed ? '<span class="review-proposed">Computed</span>' : ''}</label>`).join('');
    const prior = pack.priorNote && !note ? priorNoteHtml(pack.priorNote, esc) : '';
    form = `<form class="review-submit-form" id="review-submit-form" data-review-submit data-key="review-form">`
      + `<label class="review-field-label" for="review-note">Note for the whole pack</label>`
      + prior
      + `<textarea id="review-note" class="review-note-field" data-review-note maxlength="2000" rows="4" placeholder="What should the project do next?">${esc(note)}</textarea>`
      + syncStatusHtml(ui.noteSync || { kind: '' }, esc)
      + noteConflictHtml(ui.noteConflict, esc)
      + `<fieldset class="review-verdict"><legend class="review-field-label">Verdict</legend>${options}</fieldset>${flag}</form>`;
  } else {
    const verdict = verdictInfo(ui.result?.verdict ?? pack.verdict);
    const chip = pack.state === 'expired' ? chipHtml({ tone: 'open', label: 'Expired', icon: '' }, esc) : verdict ? chipHtml({ tone: verdict.tone, label: verdict.done, icon: verdict.icon }, esc) : '';
    const note = ui.result?.note ?? pack.note;
    const prior = pack.priorNote && !note ? priorNoteHtml(pack.priorNote, esc) : '';
    const stored = ui.result ?? { verdict: pack.verdict, changeText: pack.resultChangeText };
    const resultFlag = stored.verdict === 'accept-with-changes' && stored.changeText === false ? `<p class="review-sum-warn">${NO_CHANGE_TEXT}</p>` : '';
    form = `<div class="review-result"><p>${pack.state === 'expired' ? 'Expired' : 'Submitted'}${pack.closedAt ? ` ${esc(ui.time ? ui.time(pack.closedAt) : pack.closedAt)}` : ''} ${chip}</p>${resultFlag}${note ? `<p class="review-result-note">${esc(note)}</p>` : ''}${prior}${deliveryHtml(pack.delivery ?? ui.delivery, esc)}</div>`;
  }
  return `<section id="review-submit" class="review-summary" aria-labelledby="review-sum-title"><h2 id="review-sum-title">Summary</h2>${warning}${blocks}${form}</section>`;
}

function submitOpenConfirmHtml(pack, esc) {
  const items = (pack.items || []).filter((item) => item.state === 'open' || item.state === 'changed');
  if (!items.length) return '';
  const plural = items.length === 1;
  const sentence = plural
    ? '1 item is still open: submit anyway, or answer it first.'
    : `${items.length} items are still open: submit anyway, or answer them first.`;
  const rows = items.map((item) => `<li><b>${esc(item.title || item.id)}</b> <span class="review-submit-open-id">${esc(item.id)}</span></li>`).join('');
  const answer = plural ? 'Answer it first' : 'Answer them first';
  return `<div class="review-submit-confirm-backdrop"><section class="review-submit-confirm" role="dialog" aria-modal="true" aria-labelledby="review-submit-confirm-title">`
    + `<h2 id="review-submit-confirm-title">Open items</h2><p>${sentence}</p><ul>${rows}</ul>`
    + `<div class="review-submit-confirm-actions"><button type="button" class="quiet" data-review-answer-open="${esc(items[0].id)}">${answer}</button><button type="button" class="quiet" data-review-submit-cancel>Cancel</button><button type="button" data-review-submit-anyway>Submit anyway</button></div></section></div>`;
}

// The pack note changed on another device while my note waited. The field keeps my text until I choose.
function noteConflictHtml(conflict, esc) {
  if (!conflict) return '';
  return `<div class="rv-conflict" role="alert"><p><b>The note changed on another device.</b> The other note: ${esc(conflict.theirs?.note || '(empty)')}</p>`
    + '<div class="rv-conflict-actions"><button type="button" class="rv-button" data-review-note-conflict="mine">Keep mine</button><button type="button" class="rv-button" data-review-note-conflict="theirs">Use theirs</button></div></div>';
}

// The note of an older version, shown read-only. A null version names a note of an unknown older version.
function priorNoteHtml(prior, esc) {
  const from = prior.version == null ? 'an unknown older version' : `v${prior.version}`;
  return `<p class="review-prior-note" data-review-prior-note><b>Note from ${esc(from)} (read only):</b> ${esc(prior.text)}</p>`;
}

// The changes that waited offline and then met an answer from another device. The page asks once for all of them.
function conflictsHtml(pack, conflicts, esc) {
  const batch = (conflicts || []).filter((entry) => entry.batch);
  if (!batch.length) return '';
  const title = (entry) => (entry.kind === 'note' ? 'Note for the whole pack' : (pack.items || []).find((item) => item.id === entry.item)?.title || entry.item);
  return `<div class="review-conflicts rv-conflict" role="alert" data-key="review-conflicts"><p><b>${esc(plural(batch.length, 'change'))} waited offline, and another device changed the same ${batch.length === 1 ? 'answer' : 'answers'} meanwhile.</b></p>`
    + `<ul>${batch.map((entry) => `<li>${esc(title(entry))}</li>`).join('')}</ul>`
    + '<div class="rv-conflict-actions"><button type="button" class="rv-button" data-review-conflicts="mine">Keep mine</button><button type="button" class="rv-button" data-review-conflicts="theirs">Use theirs</button></div></div>';
}

function itemPanelHtml(pack, ui, h) {
  const { esc } = h;
  const item = (pack.items || []).find((entry) => entry.id === ui.item);
  if (!item) {
    const back = `${reviewUrl(pack.slug, pack.pack)}#item=${encodeURIComponent(ui.item)}`;
    return `<section class="review-item-page"><p>This item is not in the pack.</p><a class="review-button" href="${esc(back)}">Back to the sections</a></section>`;
  }
  const viewer = { ...(ui.viewer || {}), needsYouOnly: ui.needsYouOnly === true };
  const html = itemViewerHtml(pack, item, viewer, h);
  return item.type === 'page' ? withPageFrame(html, pack, item, ui.viewer || {}, h) : html;
}

// ---------- Legacy HTML pages ----------
// A `page` item shows its HTML in a sandboxed frame. The viewer of public/review-viewer.js has no page type, so it writes one
// fallback line for it. withPageFrame() puts the frame in the place of that line. The page HTML and every message that the
// page sends are untrusted: parseFrameMessage() checks each message, and every value from the page goes through esc().
// See docs/ideas/review-packs.md, sections Legacy HTML packs and The frame protocol.

export const FRAME_STRING_MAX = 200;
export const FRAME_ANCHORS_MAX = 500;
export const FRAME_HEIGHT_MAX = 10_000_000;
const FRAME_TYPES = new Set(['ready', 'pick', 'scroll', 'open']);
const PAGE_FALLBACK = '<p class="rv-fallback">Herdr Boss has no viewer for page. It shows the text.</p>';
const isString = (value) => typeof value === 'string' && value.length <= FRAME_STRING_MAX;
const isFraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

// The checked message of a frame event, or null. The message must come from the frame window, have hb 1 and a known type,
// and have the shape of its type with each string at most 200 characters. The result holds only the known fields.
export function parseFrameMessage(event, frameWindow) {
  if (!event || !frameWindow || event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.hb !== 1 || !FRAME_TYPES.has(data.type)) return null;
  switch (data.type) {
    case 'ready': {
      if (!isString(data.title) || typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 0 || data.height > FRAME_HEIGHT_MAX) return null;
      if (!Array.isArray(data.anchors) || data.anchors.length > FRAME_ANCHORS_MAX) return null;
      const anchors = [];
      for (const anchor of data.anchors) {
        if (!anchor || typeof anchor !== 'object' || !isString(anchor.id) || !anchor.id || !isString(anchor.text)
          || !['heading', 'image'].includes(anchor.kind) || !isFraction(anchor.top)) return null;
        anchors.push({ id: anchor.id, kind: anchor.kind, text: anchor.text, top: anchor.top });
      }
      return { type: 'ready', title: data.title, height: data.height, anchors };
    }
    case 'pick':
      if (!(data.anchor === null || (isString(data.anchor) && data.anchor)) || !isFraction(data.x) || !isFraction(data.y) || !isString(data.text)) return null;
      return { type: 'pick', anchor: data.anchor, x: data.x, y: data.y, text: data.text };
    case 'scroll':
      return isFraction(data.top) ? { type: 'scroll', top: data.top } : null;
    case 'open':
      return isString(data.url) && data.url ? { type: 'open', url: data.url } : null;
    default: return null;
  }
}

// The same patterns as src/redact.js. The server refuses a pin text that matches; the viewer drops such text first.
const SECRET_PATTERNS = [
  /\bBearer\s+[^\s"']+/i,
  /\b(?:sk-[a-zA-Z0-9_-]{3,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,}|AIza[a-zA-Z0-9_-]{12,}|xox[baprs]-[a-zA-Z0-9-]{8,})\b/,
  /\b(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)"?\s*[:=]\s*\S/i,
];
export const looksSecret = (text) => SECRET_PATTERNS.some((pattern) => pattern.test(String(text)));

// The pin fields that a `pick` message may set. The anchor must be one from the last `ready` message, so a page script
// cannot store an arbitrary string. The text is cut to 200 characters and dropped when it looks like a secret.
export function pickPinFields(message, anchors) {
  const fields = {};
  if (message?.anchor && (anchors || []).some((anchor) => anchor.id === message.anchor)) fields.anchor = message.anchor;
  const text = String(message?.text ?? '').slice(0, FRAME_STRING_MAX);
  if (text && !looksSecret(text)) fields.text = text;
  return fields;
}

// The URL of a link that the page asked to open, or null. Only http and https pass safeUrl() here.
export function frameOpenUrl(url) {
  const safe = safeUrl(String(url ?? ''));
  if (!safe || !/^https?:\/\//i.test(safe)) return null;
  try { return new URL(safe).host ? safe : null; } catch { return null; }
}

// The path of the page file in the raw URL. Each part is encoded.
export function rawPageUrl(token, src) {
  return `/review-raw/${encodeURIComponent(token)}/${String(src).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

// The numbers of the pins in view: the pins whose y lies in the visible part of the page.
// `top` is the scroll position and `view` the visible height, both as fractions of the page height.
export function pinsInView(pins, top, view) {
  const end = top + (view > 0 ? view : 1);
  return (pins || []).filter((pin) => pin.y >= top - 0.0005 && pin.y <= end + 0.0005).map((pin) => pin.n);
}

// The shown height of the frame in px: the page height between 240 and 720. The frame scrolls inside when the page is taller.
export function frameHeight(frame) {
  return Math.round(Math.min(720, Math.max(240, Number.isFinite(frame?.height) ? frame.height : 480)));
}

// The visible part of the page as a fraction of the page height.
export function frameView(frame) {
  return frame?.height > 0 ? Math.min(1, frameHeight(frame) / frame.height) : 1;
}

// ui.frame: token, status ('loading', 'ready', or 'error'), error, title, height, anchors, scrollTop, openUrl.
function pageFrameHtml(pack, item, ui, h) {
  const { esc } = h;
  const spec = itemSpec(pack, item.id);
  const frame = ui.frame || {};
  const canPin = (item.ask || []).includes('note') && pack.state === 'open';
  const src = frame.token && typeof spec.src === 'string' ? rawPageUrl(frame.token, spec.src) : '';
  const height = frameHeight(frame);
  const pins = item.answer?.pins || [];
  const visible = frame.status === 'ready' ? pinsInView(pins, frame.scrollTop || 0, frameView(frame)) : [];
  const anchors = frame.anchors || [];
  const pin = canPin
    ? `<button type="button" class="rv-tool rv-tool-pin" data-rv-place aria-pressed="${ui.placing ? 'true' : 'false'}">${viewerIcon('pin')}<span>${ui.placing ? 'Tap the page' : 'Add pin'}</span></button>`
    : '';
  const outline = anchors.length
    ? `<details class="rv-frame-outline" data-key="rv-frame-outline:${esc(item.id)}"><summary>Page outline <span class="num">${anchors.length}</span></summary><ul>`
      + anchors.map((anchor, index) => `<li><button type="button" class="rv-frame-goto" data-rv-frame-goto="${index}">${esc(anchor.kind === 'image' ? `Image: ${anchor.text || 'no text'}` : anchor.text || 'Heading')}</button></li>`).join('')
      + '</ul></details>'
    : '';
  let status = '';
  if (frame.status === 'error') status = `<p class="rv-frame-status" role="alert">${esc(frame.error || 'The page could not load.')} <button type="button" class="rv-tool" data-rv-frame-renew>Try again</button></p>`;
  else if (!src || frame.status !== 'ready') status = '<p class="rv-frame-status" role="status">Loading the page.</p>';
  else if (frame.title) status = `<p class="rv-frame-status">${esc(frame.title)}</p>`;
  let link = '';
  const live = frame.openUrl ? frameOpenUrl(frame.openUrl) : null;
  if (live) link = `<p class="rv-frame-link">The page links to <b>${esc(new URL(live).host)}</b>. <a class="rv-button" href="${esc(live)}" target="_blank" rel="noopener noreferrer">Open live link</a></p>`;
  const inView = visible.length ? `<p class="rv-frame-pins" aria-live="polite">In view: ${visible.map((n) => `pin ${esc(n)}`).join(', ')}</p>` : '';
  return `<div class="rv-frame" data-key="rv-frame:${esc(item.id)}">`
    + `<div class="rv-tools rv-frame-tools">${outline}<span class="rv-tools-end">${pin}</span></div>${link}`
    + `<div class="rv-frame-wrap${ui.placing ? ' rv-frame-placing' : ''}" style="--rv-frame-h: ${height}px">`
    + `<iframe class="rv-frame-el" data-key="rv-frame-el:${esc(item.id)}" data-rv-frame data-src="${esc(src)}" data-keep-attrs="src" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" allow="" title="${esc(`Page: ${item.title || item.id}`)}"></iframe></div>`
    + `${status}${inView}</div>`;
}

function withPageFrame(html, pack, item, ui, h) {
  return html.includes(PAGE_FALLBACK) ? html.replace(PAGE_FALLBACK, () => pageFrameHtml(pack, item, ui, h)) : html;
}

// ui: current (the item of #item=), item (the item route), viewer (the view state of the open item), note, noteStatus, verdict, submitting, submitStatus, result, time.
export function packPageHtml(pack, ui, h) {
  const { esc } = h;
  const items = pack.items || [];
  const counts = pack.derived?.counts || { items: items.length, accepted: 0, denied: 0, live: 0, noteOnly: 0, open: items.length };
  const stale = items.filter((item) => item.stale).length;
  const viewed = items.filter((item) => item.answer?.viewed).length;
  const sections = pack.derived?.sections || [];
  const open = pack.state === 'open';

  let bar;
  const openItem = ui.item ? items.find((entry) => entry.id === ui.item) : null;
  if (ui.item) {
    bar = openItem
      ? viewerBarHtml(pack, openItem, h)
      : `<a href="${esc(`${reviewUrl(pack.slug, pack.pack)}#item=${encodeURIComponent(ui.item)}`)}" class="app-icon-button" aria-label="Back to the sections">${icon('back')}</a><h1 class="review-title">Item not found</h1>`;
  } else {
    const facts = [`v${pack.version}`, plural(sections.length, 'section')];
    if (stale) facts.push(`${stale} changed`);
    bar = `<a href="/reviews" class="app-icon-button" aria-label="Back to Reviews">${icon('back')}</a>`
      + `<h1 class="review-title">${esc(pack.title)}<small>${esc(facts.join(' · '))} · ${esc(h.projectLabel(pack.slug))}</small></h1>`;
  }

  const tag = pack.manifest?.session ? `<p class="review-head-session">Session ${esc(pack.manifest.session)}${pack.manifest.round ? ` · round ${esc(pack.manifest.round)}` : ''}</p>` : '';
  const head = `<div class="review-head"><p class="review-head-line"><span><b class="num">${answeredOf(counts)}</b> of ${esc(plural(counts.items, 'item'))} answered · <b class="num">${viewed}</b> viewed</span>${open ? '' : doneChip(pack, esc)}</p>${tag}${summaryHeaderHtml(pack, esc)}${judgePassNoteHtml(pack, esc)}${progressBarHtml(counts, { esc, legend: true })}</div>`;
  const side = ui.sidebar || {};
  const viewport = side.viewport || 1280;
  const collapsed = side.collapsed === true;
  const sideWidth = clampWidth(side.width ?? SIDEBAR_DEFAULT, viewport);
  const list = sectionsNavHtml(pack, sections, ui, esc, collapsed) + (collapsed ? '' : sidebarHandleHtml(sideWidth, viewport));
  const main = `<div class="review-main">${ui.item ? itemPanelHtml(pack, ui, h) : summaryHtml(pack, { ...ui, time: h.time }, esc)}</div>`;
  let foot = '';
  const answerWidth = clampAnswer(ui.answerWidth ?? ANSWER_DEFAULT, viewport);
  if (openItem && (open || openItem.reopened === true)) foot = answerHandleHtml(answerWidth, viewport) + answerBarHtml(pack, openItem, ui.viewer || {}, h);
  else if (openItem && pack.state === 'submitted' && (openItem.state === 'open' || openItem.state === 'changed')) {
    const next = openItem.nextPack;
    const text = next
      ? `This pack is submitted. The open item is in <a href="${esc(reviewUrl(pack.slug, next.pack, openItem.id))}">${esc(next.title || next.pack)}</a>.`
      : 'This pack is submitted. Ask the planner to reopen the item.';
    foot = `<div class="review-foot"><p class="review-foot-status" role="status">${text}</p></div>`;
  }
  else if (open && !ui.item) {
    const lock = submitLock(ui.packSync?.count || 0, ui.packSync?.unsaved || 0);
    foot = `<div class="review-foot" data-key="review-foot">${packStatusHtml(ui.packSync || { kind: '' }, esc)}<span class="review-foot-count">${counts.open ? `${plural(counts.open, 'open item')}` : 'All items answered'}</span>`
      + `<p class="review-foot-status" role="status">${esc(ui.submitStatus || '')}</p>`
      + `<button type="submit" form="review-submit-form" class="review-submit"${ui.submitting || lock.disabled ? ' disabled' : ''}>${esc(lock.label)}</button></div>`;
  }
  const submitConfirm = ui.submitConfirm ? submitOpenConfirmHtml(pack, esc) : '';
  return `<div class="review-page${ui.item ? ' item-open' : ''}${collapsed ? ' side-collapsed' : ''}" data-key="review-page:${esc(pack.slug)}/${esc(pack.pack)}" style="--review-side: ${collapsed ? SIDEBAR_RAIL : sideWidth}px${openItem && (open || openItem.reopened === true) ? `; --review-answer: ${answerWidth}px` : ''}">`
    + `<div class="app-bar review-app-bar">${h.menuButton || ''}${bar}</div>`
    + `<div class="review-body" data-key="review-body">${open ? conflictsHtml(pack, ui.conflicts, esc) : ''}${head}${list}${main}</div>${foot}${submitConfirm}</div>`;
}

// A page for a missing pack or a load error, with the same app bar.
export function reviewMessageHtml(title, text, h, { alert = false, retry = false } = {}) {
  const { esc } = h;
  return `<div class="review-page" data-key="reviews:message"><div class="app-bar review-app-bar">${h.menuButton || ''}<a href="/reviews" class="app-icon-button" aria-label="Back to Reviews">${icon('back')}</a><h1>${esc(title)}</h1></div>`
    + `<div class="review-scroll"><div class="review-empty"${alert ? ' role="alert"' : ''}><p>${esc(text)}</p>${retry ? '<button type="button" class="review-button" data-review-retry>Try again</button>' : ''}</div></div></div>`;
}

// ---------- Submit and errors ----------

// The confirm text of Submit review: the pack, the version, the verdict, and each count.
export function submitConfirmText(pack, verdict, note = pack.note) {
  const counts = pack.derived?.counts || {};
  const label = verdictInfo(verdict)?.label || verdict;
  return `Submit the review of ${pack.title}, version ${pack.version}?\n\nVerdict: ${label}\n${verdict === 'accept-with-changes' && !hasChangeText(pack, note) ? `${NO_CHANGE_TEXT}\n` : ''}${progressText(counts)}.\n\nThe result goes to the project lead.`;
}

// A plain sentence for a failed request. The API sentence stays when the body has one. The network-layer text never shows.
export function reviewErrorText({ network = false, status = 0, body = null } = {}) {
  if (network) return 'The service is not reachable. It may be restarting. Try again in a moment.';
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
  if (status === 401) return 'Sign in again.';
  if (status === 403) return 'The service refused the request.';
  if (status === 413) return 'The text is too large.';
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  if (status >= 500) return 'The service reported an error.';
  return 'The request failed.';
}

// ---------- Keys ----------

// The list keys of the review pages, as in the Mailbox: j and k move, J and K move by section, u or Esc goes back,
// s opens the summary, and ? opens the help. In a text field only Esc works: it leaves the field.
export function reviewKeyAction({ key, ctrlKey, metaKey, altKey, inField } = {}) {
  if (ctrlKey || metaKey || altKey) return null;
  if (inField) return key === 'Escape' ? 'leave-field' : null;
  return { j: 'next', k: 'prev', J: 'next-section', K: 'prev-section', u: 'back', Escape: 'back', s: 'summary', '?': 'help' }[key] || null;
}

// ---------- Mailbox ----------

// A review item in the Mailbox opens its pack. The link replaces the answer form.
export function reviewOpenLinkHtml(item, esc) {
  const ref = item?.kind === 'review' ? item.review : null;
  if (!ref || !SLUG.test(String(ref.slug)) || !SLUG.test(String(ref.pack))) return '';
  return `<a class="review-open" href="${esc(reviewUrl(ref.slug, ref.pack))}">Open review</a>`;
}

// The result line of a closed review item in the Mailbox, after the Owner submitted the pack. The link opens the submitted summary, read-only.
// helpers: esc, clock(iso), and state(answer), the delivery state text of the result message. A replaced or deleted item has no line.
export function reviewDoneLineHtml(item, { esc, clock, state }) {
  if (item?.kind !== 'review' || item.closedBy !== 'owner' || item.closeNote !== 'review submitted') return '';
  const delivery = item.answer && state ? state(item.answer) : '';
  return `<div class="mail-answer"><p class="sub">Review submitted · ${esc(clock(item.closedAt))}${delivery ? ` · ${esc(delivery)}` : ''}</p>${reviewOpenLinkHtml(item, esc)}</div>`;
}
