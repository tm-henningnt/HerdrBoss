import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, find, byKey } from './fake-dom.js';

const { groupMailRows, inboxSections, mailPreview, mailRowHtml, listTime } = await import('../public/mail-rows.js');
const { patchHtml } = await import('../public/keyed.js');

const at = (minutes) => new Date(Date.parse('2026-09-30T08:00:00.000Z') + minutes * 60000).toISOString();
const item = (id, extra = {}) => ({ id, thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: `Text of ${id}`, action: 'read', at: at(0), readAt: null, conversationId: id, ...extra });

test('groupMailRows gives one row per conversation with the newest item and the count', () => {
  const items = [
    item('m-3', { conversationId: 'c-1', at: at(3) }),
    item('m-2', { conversationId: 'c-2', at: at(2), readAt: at(2) }),
    item('m-1', { conversationId: 'c-1', at: at(1), readAt: at(1) }),
    item('m-0', { thread: 'boss', from: 'boss', conversationId: 'c-1', at: at(0), readAt: at(0) }),
  ];
  const rows = groupMailRows(items);
  assert.deepEqual(rows.map((row) => row.key), ['alpha:c-1', 'alpha:c-2', 'boss:c-1'], 'the same conversation ID in another thread is another row');
  assert.equal(rows[0].item.id, 'm-3', 'the row shows the newest item');
  assert.equal(rows[0].count, 2);
  assert.deepEqual(rows[0].ids, ['m-3', 'm-1']);
  assert.equal(rows[0].unread, true, 'one unread item makes the row unread');
  assert.equal(rows[1].unread, false);
  assert.equal(groupMailRows([item('x', { conversationId: undefined })])[0].key, 'alpha:x', 'an item without a conversation ID is its own conversation');
});

test('the Inbox shows Needs you first, then Reports and updates', () => {
  const inbox = [
    item('m-report', { kind: 'report', title: 'Morning status', at: at(5) }),
    item('m-approve', { action: 'approve', at: at(4) }),
    item('m-read', { at: at(3) }),
    item('m-answer', { action: 'answer', at: at(2), conversationId: 'c-a' }),
  ];
  const sections = inboxSections(inbox);
  assert.deepEqual(sections.map((section) => [section.key, section.label, section.rows.map((row) => row.item.id)]), [
    ['needs-you', 'Needs you', ['m-approve', 'm-answer']],
    ['updates', 'Reports and updates', ['m-report', 'm-read']],
  ]);
  assert.deepEqual(inboxSections([item('m-read')]).map((section) => section.key), ['updates'], 'an empty section does not show');
});

test('the row preview is one plain line after the subject', () => {
  assert.equal(mailPreview(item('a', { text: 'Subject line\n\nThe **first** detail\nand more.' })), 'The first detail and more.');
  assert.equal(mailPreview(item('b', { kind: 'report', title: 'Night report', text: '# Night report\n\n## Summary\n\n- Harbor: `3` tasks done' })), 'Summary Harbor: 3 tasks done');
  assert.equal(mailPreview(item('c', { text: 'Only one line' })), '');
});

const helpers = {
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  avatar: (thread) => `<span class="avatar-slot" data-avatar-slot="${thread}"></span>`,
  clock: (iso) => iso.slice(11, 16),
  sender: (row) => (row.item.thread === 'boss' ? 'Boss' : 'Orchestrator · Alpha'),
};

test('a row names the sender, the count, the action tag, the subject, the time, and the unread state', () => {
  const [row] = groupMailRows([item('m-2', { action: 'approve', text: 'Approve the plan?\nIt costs one run.', conversationId: 'c', at: at(2) }), item('m-1', { conversationId: 'c', at: at(1) })]);
  const html = mailRowHtml(row, { ...helpers, selectable: true, selected: new Set(['m-2']), current: 'alpha:c' });
  assert.match(html, /^<li class="mail-row unread current" data-key="row:alpha:c">/);
  assert.match(html, /data-mail-select="m-2,m-1"[^>]*checked/);
  assert.match(html, /<span class="mail-from">Orchestrator · Alpha<\/span><span class="mail-count num">2<\/span><span class="mail-tag tag-approve">Approve<\/span><\/span>/);
  assert.match(html, /<span class="mail-subject">Approve the plan\?<\/span><span class="mail-preview">It costs one run\.<\/span>/);
  assert.match(html, /<time class="num" datetime="[^"]+">08:02<\/time>/);
  assert.match(html, /class="mail-dot"/);
  assert.match(html, /aria-current="true"/);
  assert.doesNotMatch(mailRowHtml(row, helpers), /mail-select/, 'a folder without bulk select has no check box');
});

test('a project triage row cannot be dismissed through selection or close-as-answered-elsewhere', () => {
  const proposal = item('m-triage', {
    kind: 'report', title: 'Open project pine-api?', action: 'approve',
    triage: { type: 'project-open' },
  });
  const [row] = groupMailRows([proposal]);
  const html = mailRowHtml(row, {
    ...helpers,
    selectable: (candidate) => candidate.triage?.type !== 'project-open',
    icon: () => '<svg></svg>',
  });
  assert.doesNotMatch(html, /data-mail-select|data-mail-elsewhere/);
});

test('a completed triage row explains whether the project opened or the proposal was declined', () => {
  for (const [decision, text] of [['accept', 'Project opened'], ['deny', 'Proposal declined']]) {
    const proposal = item(`m-${decision}`, {
      kind: 'report', title: 'Open project pine-api?', action: 'approve', closedAt: at(1), closedBy: 'owner',
      triage: { type: 'project-open', decision },
    });
    const [row] = groupMailRows([proposal]);
    const html = mailRowHtml(row, helpers);
    assert.match(html, new RegExp(`<span class="mail-preview">${text}<\\/span>`));
  }
});

function setup(html) {
  globalThis.document = createDocument();
  return document.html(html);
}
const list = (items, options = {}) => `<div class="mail-list-scroll" data-key="mail-list-scroll"><ol class="mail-list">${groupMailRows(items).map((row) => mailRowHtml(row, { ...helpers, ...options })).join('')}</ol></div>`;

test('a keyed refresh keeps the row nodes, the list scroll, and a checked box', () => {
  const first = [item('m-2', { conversationId: 'c-2', at: at(2) }), item('m-1', { conversationId: 'c-1', at: at(1), action: 'answer' })];
  const root = setup(list(first, { selectable: true, selected: new Set() }));
  const scroller = byKey(root, 'mail-list-scroll');
  scroller.scrollTop = 420;
  const kept = byKey(root, 'row:alpha:c-1');
  const box = find(kept, (el) => el.tagName === 'INPUT');
  box.checked = true;
  box.focus();
  const next = [item('m-3', { conversationId: 'c-3', at: at(3) }), ...first.map((x) => ({ ...x, readAt: at(4) }))];
  patchHtml(root, list(next, { selectable: true, selected: new Set(['m-1']) }));
  assert.equal(byKey(root, 'mail-list-scroll'), scroller, 'the scroll container keeps its node');
  assert.equal(scroller.scrollTop, 420);
  assert.equal(byKey(root, 'row:alpha:c-1'), kept, 'a known row keeps its node');
  assert.equal(find(kept, (el) => el.tagName === 'INPUT'), box);
  assert.equal(box.checked, true);
  assert.equal(document.activeElement, box, 'the focused check box keeps the focus');
  assert.equal(kept.getAttribute('class'), 'mail-row', 'a row read elsewhere loses the unread style in place');
  const rows = find(root, (el) => el.tagName === 'OL').childNodes;
  assert.deepEqual(rows.map((row) => row.getAttribute('data-key')), ['row:alpha:c-3', 'row:alpha:c-2', 'row:alpha:c-1']);
});

test('the list time is short: the clock today, Yesterday, a weekday, or the day and the month', () => {
  const now = new Date(2026, 8, 30, 12, 0);
  assert.equal(listTime(new Date(2026, 8, 30, 7, 5).toISOString(), now), '07:05');
  assert.equal(listTime(new Date(2026, 8, 29, 23, 59).toISOString(), now), 'Yesterday');
  assert.equal(listTime(new Date(2026, 8, 27, 9, 0).toISOString(), now), 'Sun');
  assert.equal(listTime(new Date(2026, 8, 20, 9, 0).toISOString(), now), '20 Sep');
  assert.equal(listTime('bad', now), '');
});

test('the Inbox sections hold a read information item as Done, not as an update', () => {
  const sections = inboxSections([
    item('m-unread', { at: at(3) }),
    item('m-done', { at: at(2), readAt: at(1), closedAt: at(1) }),
  ]);
  assert.deepEqual(sections.map((section) => [section.key, section.rows.map((row) => row.item.id)]), [['updates', ['m-unread']]]);
});
