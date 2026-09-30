// Mailbox list rows. One row for each conversation, in the order of its newest item.
// The module has no DOM use, so the Node tests import it directly.

const NEEDS_YOU = new Set(['answer', 'approve', 'decide']);
const TAG = { answer: 'Answer', approve: 'Approve', decide: 'Decide' };

export const mailRowKey = (item) => `${item.thread}:${item.conversationId || item.id}`;

// The items come newest first. The first item of a conversation is the newest one, so it is the row item.
export function groupMailRows(items) {
  const rows = new Map();
  for (const item of items || []) {
    const key = mailRowKey(item);
    const row = rows.get(key);
    if (row) {
      row.items.push(item);
      row.ids.push(item.id);
      row.count += 1;
      row.unread ||= !item.readAt;
    } else rows.set(key, { key, item, items: [item], ids: [item.id], count: 1, unread: !item.readAt });
  }
  return [...rows.values()];
}

// The Inbox shows the items that need the Owner first, then the reports and updates.
export function inboxSections(inbox) {
  const items = inbox || [];
  return [
    { key: 'needs-you', label: 'Needs you', rows: groupMailRows(items.filter((item) => NEEDS_YOU.has(item.action) && !item.closedAt)) },
    { key: 'updates', label: 'Reports and updates', rows: groupMailRows(items.filter((item) => !NEEDS_YOU.has(item.action) && !item.closedAt)) },
  ].filter((section) => section.rows.length);
}

// Markdown marks removed, so the preview reads as one plain line.
const plain = (line) => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/[*_~`]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

export function mailSubject(item) {
  if (item.kind === 'report') return item.title || 'Report';
  return String(item.text || '').split('\n').find((line) => line.trim())?.trim() || 'Reply';
}

// The text after the subject line. A report drops a first heading that repeats its title.
export function mailPreview(item) {
  const lines = String(item.text || '').split('\n').map(plain).filter(Boolean);
  if (item.kind === 'report') {
    if (lines[0] === item.title) lines.shift();
  } else lines.shift();
  return lines.join(' ').replace(/\s+/g, ' ').slice(0, 200);
}

// The list time: the clock for today, else the weekday for the last 6 days, else the day and the month.
export function listTime(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((new Date(now.toDateString()) - new Date(date.toDateString())) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${date.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]}`;
}

export function mailTag(item) {
  if (item.closedAt) return { key: 'done', label: item.dismissed ? 'Dismissed' : 'Done' };
  if (item.from === 'owner') return null;
  if (TAG[item.action]) return { key: item.action, label: TAG[item.action] };
  if (item.kind === 'report') return { key: 'report', label: 'Report' };
  return null;
}

// One row. helpers: esc, avatar(thread), clock(iso), sender(row), and the optional selectable, selected, current, and state(item).
export function mailRowHtml(row, helpers) {
  const { esc, avatar, clock, sender, selectable = false, selected = new Set(), current = '', state = null, icon = null } = helpers;
  const item = row.item;
  const subject = mailSubject(item);
  // A Done row closed by the Boss shows the close note in place of the preview.
  const preview = item.closedBy === 'boss' ? `answered through the Boss: ${item.closeNote || ''}` : mailPreview(item);
  const closedLine = item.closedBy === 'owner' ? (item.closeNote === 'review submitted' ? 'Review submitted' : 'Closed as answered elsewhere') : item.closedBy === 'project' ? 'Resolved by the project' : '';
  const tag = mailTag(item);
  const unread = row.unread && item.from !== 'owner';
  const checked = row.ids.some((id) => selected.has(id));
  const open = current === row.key;
  const select = selectable ? `<label class="mail-select"><input type="checkbox" data-mail-select="${esc(row.ids.join(','))}" aria-label="Select ${esc(subject)}"${checked ? ' checked' : ''}></label>` : '';
  const extra = state ? `<span class="mail-state">${esc(state(item))}</span>` : '';
  // An open Needs-you item has the row action that closes it as answered elsewhere.
  const elsewhere = icon && item.from !== 'owner' && item.kind !== 'review' && !item.closedAt && NEEDS_YOU.has(item.action)
    ? `<button type="button" class="app-icon-button mail-row-action" data-mail-elsewhere="${esc(item.id)}" aria-label="Close as answered elsewhere" title="Close as answered elsewhere">${icon('check')}</button>`
    : '';
  return `<li class="mail-row${unread ? ' unread' : ''}${open ? ' current' : ''}" data-key="row:${esc(row.key)}">${select}<button class="mail-entry" type="button" data-mail-open data-mail-thread="${esc(item.thread)}" data-mail-conversation="${esc(item.conversationId || item.id)}" data-mail-item-id="${esc(item.id)}"${open ? ' aria-current="true"' : ''}>`
    + `${avatar(item.thread)}`
    + `<span class="mail-line-one"><span class="mail-from">${esc(sender(row))}</span>${row.count > 1 ? `<span class="mail-count num">${row.count}</span>` : ''}${tag ? `<span class="mail-tag tag-${tag.key}">${esc(tag.label)}</span>` : ''}</span>`
    + `<span class="mail-line-two"><span class="mail-subject">${esc(subject)}</span>${closedLine ? `<span class="mail-preview">${esc(closedLine)}</span>` : preview ? `<span class="mail-preview">${esc(preview)}</span>` : ''}${extra}</span>`
    + `<span class="mail-side"><time class="num" datetime="${esc(item.at)}">${esc(clock(item.at))}</time>${unread ? '<span class="mail-dot" aria-hidden="true"></span><span class="visually-hidden">Unread</span>' : ''}</span>`
    + `</button>${elsewhere}</li>`;
}
