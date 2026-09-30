// The reviewer pages of hosted review packs: the pack list, the section list, the progress bar, and the Mailbox entry.
// See docs/ideas/review-packs.md, section The reviewer UI. The module has no DOM use, so the Node tests import it directly.
// Each render function takes helpers: esc, avatar(slug), projectLabel(slug), time(iso), and menuButton (HTML).
// Every value from the server goes through esc(). A URL part goes through encodeURIComponent() and then esc().
// The item route shows the item viewer of public/review-viewer.js. It takes ui.viewer (the view state of the item)
// and the helper text(url), which gives a loaded text file of the pack.
import { itemViewerHtml, answerBarHtml, viewerBarHtml } from './review-viewer.js';
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
const DEFAULT_VERDICT = 'accept-with-changes';

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
  return { answered: items.filter((item) => item.state !== 'open').length, total: items.length };
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
  if (item.stale) return { tone: 'changed', label: 'Changed', icon: 'changed' };
  const answer = item.answer || {};
  switch (item.state) {
    case 'denied': return { tone: 'crit', label: 'Denied', icon: 'close' };
    case 'accepted': return { tone: 'ok', label: 'Accepted', icon: 'check' };
    case 'live': return { tone: 'warn', label: 'Live check', icon: 'live' };
    case 'note': return { tone: 'info', label: 'Note', icon: 'note' };
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

// ---------- Section list ----------

function itemRowHtml(pack, item, ui, esc) {
  const answer = item.answer || {};
  const viewed = Boolean(answer.viewed);
  const done = viewed && item.state !== 'open';
  const sub = [TYPE_LABEL[item.type] || 'Item'];
  if (answer.note) sub.push('note');
  const sync = rowSyncText(ui.itemSync?.(item.id));
  if (sync) sub.push(sync);
  const current = ui.current === item.id || ui.item === item.id;
  return `<li><a class="review-item${done ? ' review-item-done' : ''}" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}" data-key="review-item:${esc(item.id)}" data-review-row="${esc(item.id)}"${current ? ' aria-current="true"' : ''}>`
    + `<span class="review-thumb">${icon(TYPE_ICON[item.type] || 'doc')}</span>`
    + `<span class="review-item-t"><span class="review-item-title">${esc(item.title || item.id)}</span><small>${esc(sub.join(' · '))}</small></span>`
    + chipHtml(itemChip(item, pack), esc)
    + `<span class="review-viewed${viewed ? ' on' : ''}">${viewed ? icon('check') : ''}<span class="visually-hidden">${viewed ? 'Viewed' : 'Not viewed'}</span></span></a></li>`;
}

function sectionHtml(pack, section, ui, esc) {
  const items = (pack.items || []).filter((item) => item.section === section.id);
  const { answered, total } = sectionProgress(pack, section.id);
  const folded = section.state === 'accepted' && items.every((item) => item.answer?.viewed) && !items.some((item) => item.id === ui.current || item.id === ui.item);
  return `<details class="review-section" data-key="review-sec:${esc(section.id)}" data-keep-attrs="open"${folded ? '' : ' open'}>`
    + `<summary class="review-sec-h"><h2>${esc(section.title || section.id)}</h2>${chipHtml(GROUP_CHIP[section.state] || GROUP_CHIP.open, esc)}<span class="review-sec-count num">${answered} / ${total}</span></summary>`
    + `<ul class="review-items">${items.map((item) => itemRowHtml(pack, item, ui, esc)).join('')}</ul></details>`;
}

// The summary groups in the order of the decision: denied, needs live check, notes, accepted, and open last.
const SUMMARY_GROUPS = [
  { label: 'Denied', has: (item) => item.state === 'denied' },
  { label: 'Needs live check', has: (item) => item.state === 'live' },
  { label: 'Note only', has: (item) => item.state === 'note' },
  { label: 'Accepted', has: (item) => item.state === 'accepted' || item.state === 'answered' },
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
  const missing = (pack.items || []).filter((item) => item.state === 'open').length;
  const blocks = SUMMARY_GROUPS.map((group) => {
    const items = (pack.items || []).filter(group.has);
    if (!items.length) return '';
    const rows = items.map((item) => {
      const note = item.answer?.note ? `<small class="review-sum-note">${esc(item.answer.note)}</small>` : '';
      const chosen = item.state === 'answered' ? `<small>${esc(itemChip(item, pack).label)}</small>` : '';
      const changed = item.stale ? '<small class="review-sum-stale">changed in this version</small>' : '';
      const go = group.label === 'Open' && open ? `<a class="review-sum-go" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}">Review now</a>` : '';
      return `<li><a class="review-sum-title" href="${esc(reviewUrl(pack.slug, pack.pack, item.id))}">${esc(item.title || item.id)}</a>${go}${chosen}${changed}${note}</li>`;
    }).join('');
    return `<div class="review-sum-block"><h3 class="review-sum-h">${group.label} <span class="num">${items.length}</span></h3><ul>${rows}</ul></div>`;
  }).join('');
  const warning = missing ? `<p class="review-sum-warn" role="status">${open ? (missing === 1 ? '1 item has no decision' : `${missing} items have no decision`) : (missing === 1 ? '1 item had no decision' : `${missing} items had no decision`)}</p>` : '';

  let form;
  if (open) {
    const proposed = ui.proposed ?? pack.derived?.proposedVerdict;
    const chosen = VERDICTS.some((verdict) => verdict.key === ui.verdict) ? ui.verdict : VERDICTS.some((verdict) => verdict.key === proposed) ? proposed : DEFAULT_VERDICT;
    const options = VERDICTS.map((verdict) => `<label class="review-verdict-option"><input type="radio" name="review-verdict" value="${verdict.key}"${verdict.key === chosen ? ' checked' : ''} data-review-verdict><span><b>${verdict.label}</b><small>${verdict.hint}</small></span>${verdict.key === proposed ? '<span class="review-proposed">Proposed</span>' : ''}</label>`).join('');
    const note = ui.note ?? pack.note ?? '';
    form = `<form class="review-submit-form" id="review-submit-form" data-review-submit data-key="review-form">`
      + `<label class="review-field-label" for="review-note">Note for the whole pack</label>`
      + `<textarea id="review-note" class="review-note-field" data-review-note maxlength="2000" rows="4" placeholder="What should the project do next?">${esc(note)}</textarea>`
      + syncStatusHtml(ui.noteSync || { kind: '' }, esc)
      + noteConflictHtml(ui.noteConflict, esc)
      + `<fieldset class="review-verdict"><legend class="review-field-label">Verdict</legend>${options}</fieldset></form>`;
  } else {
    const verdict = verdictInfo(ui.result?.verdict ?? pack.verdict);
    const chip = pack.state === 'expired' ? chipHtml({ tone: 'open', label: 'Expired', icon: '' }, esc) : verdict ? chipHtml({ tone: verdict.tone, label: verdict.done, icon: verdict.icon }, esc) : '';
    const note = ui.result?.note ?? pack.note;
    form = `<div class="review-result"><p>${pack.state === 'expired' ? 'Expired' : 'Submitted'}${pack.closedAt ? ` ${esc(ui.time ? ui.time(pack.closedAt) : pack.closedAt)}` : ''} ${chip}</p>${note ? `<p class="review-result-note">${esc(note)}</p>` : ''}${deliveryHtml(pack.delivery ?? ui.delivery, esc)}</div>`;
  }
  return `<section id="review-submit" class="review-summary" aria-labelledby="review-sum-title"><h2 id="review-sum-title">Summary</h2>${warning}${blocks}${form}</section>`;
}

// The pack note changed on another device while my note waited. The field keeps my text until I choose.
function noteConflictHtml(conflict, esc) {
  if (!conflict) return '';
  return `<div class="rv-conflict" role="alert"><p><b>The note changed on another device.</b> The other note: ${esc(conflict.theirs?.note || '(empty)')}</p>`
    + '<div class="rv-conflict-actions"><button type="button" class="rv-button" data-review-note-conflict="mine">Keep mine</button><button type="button" class="rv-button" data-review-note-conflict="theirs">Use theirs</button></div></div>';
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
  return itemViewerHtml(pack, item, ui.viewer || {}, h);
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

  const head = `<div class="review-head"><p class="review-head-line"><span><b class="num">${answeredOf(counts)}</b> of ${esc(plural(counts.items, 'item'))} answered · <b class="num">${viewed}</b> viewed</span>${open ? '' : doneChip(pack, esc)}</p>${progressBarHtml(counts, { esc, legend: true })}</div>`;
  const list = `<nav class="review-sections" aria-label="Sections">${sections.map((section) => sectionHtml(pack, section, ui, esc)).join('')}</nav>`;
  const main = `<div class="review-main">${ui.item ? itemPanelHtml(pack, ui, h) : summaryHtml(pack, { ...ui, time: h.time }, esc)}</div>`;
  let foot = '';
  if (openItem) foot = answerBarHtml(pack, openItem, ui.viewer || {}, h);
  else if (open && !ui.item) {
    const lock = submitLock(ui.packSync?.count || 0, ui.packSync?.unsaved || 0);
    foot = `<div class="review-foot" data-key="review-foot">${packStatusHtml(ui.packSync || { kind: '' }, esc)}<span class="review-foot-count">${counts.open ? `${plural(counts.open, 'open item')}` : 'All items answered'}</span>`
      + `<p class="review-foot-status" role="status">${esc(ui.submitStatus || '')}</p>`
      + `<button type="submit" form="review-submit-form" class="review-submit"${ui.submitting || lock.disabled ? ' disabled' : ''}>${esc(lock.label)}</button></div>`;
  }
  return `<div class="review-page${ui.item ? ' item-open' : ''}" data-key="review-page:${esc(pack.slug)}/${esc(pack.pack)}">`
    + `<div class="app-bar review-app-bar">${bar}</div>`
    + `<div class="review-body" data-key="review-body">${open ? conflictsHtml(pack, ui.conflicts, esc) : ''}${head}${list}${main}</div>${foot}</div>`;
}

// A page for a missing pack or a load error, with the same app bar.
export function reviewMessageHtml(title, text, h, { alert = false, retry = false } = {}) {
  const { esc } = h;
  return `<div class="review-page" data-key="reviews:message"><div class="app-bar review-app-bar"><a href="/reviews" class="app-icon-button" aria-label="Back to Reviews">${icon('back')}</a><h1>${esc(title)}</h1></div>`
    + `<div class="review-scroll"><div class="review-empty"${alert ? ' role="alert"' : ''}><p>${esc(text)}</p>${retry ? '<button type="button" class="review-button" data-review-retry>Try again</button>' : ''}</div></div></div>`;
}

// ---------- Submit and errors ----------

// Fix the proposed verdict at the first render of a pack version. A later answer changes the pack state, but the
// selected radio does not move without a click. A new version pins the proposal of that version.
export function pinProposedVerdict(ui, pack) {
  if (ui.proposedVersion !== pack.version) {
    ui.proposedVersion = pack.version;
    ui.proposed = pack.derived?.proposedVerdict || DEFAULT_VERDICT;
  }
  return ui;
}

// The confirm text of Submit review: the pack, the version, the verdict, and each count.
export function submitConfirmText(pack, verdict) {
  const counts = pack.derived?.counts || {};
  const label = verdictInfo(verdict)?.label || verdict;
  return `Submit the review of ${pack.title}, version ${pack.version}?\n\nVerdict: ${label}\n${progressText(counts)}.\n\nThe result goes to the project orchestrator.`;
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
