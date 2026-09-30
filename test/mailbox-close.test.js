// MB2: a Mailbox item closes itself when the project publishes a status in which its task no longer waits on the Owner.
// The Owner can also close an item as answered elsewhere, and the thread suggests it after a later Owner message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mbclose-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mbclose-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const messages = await import('../src/messages.js');
const { appendMessage, readMessages, closeResolvedMailboxItems, closeResolvedOnPublish, mailboxView, mailboxCounts, dismissMailboxItems, keepMailboxItemsOpen } = messages;
const [{ serve }, { loadConfig }] = await Promise.all([import('../src/server.js'), import('../src/config.js')]);
const { mailActionBarHtml, mailSuggestionHtml, mailElsewhereButtonHtml } = await import('../public/mail-bar.js');
const { mailRowHtml } = await import('../public/mail-rows.js');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const icon = (name) => `<svg data-icon="${name}"></svg>`;
const T0 = Date.parse('2026-09-30T08:00:00.000Z');
const ask = (thread, text, extra = {}) => ({ thread, from: 'orch', to: 'owner', kind: 'reply', text, action: 'decide', replyTo: null, status: 'new', ...extra });
const owner = (thread, text, extra = {}) => ({ thread, from: 'owner', to: 'orch', kind: 'message', text, action: null, replyTo: null, status: 'queued', ...extra });
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: 'blocked', waitingOn: 'owner', ask: 'Which one?', ...extra });
const freshDir = (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const item = (dir, thread, extra = {}, now = T0) => appendMessage(ask(thread, 'Choose.', extra), { dir, now });
const stored = (dir, id) => readMessages({ dir }).find((record) => record.id === id);

test('a publish closes the item when the task no longer has waitingOn owner', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const next = { tasks: [task('1', { mailboxId: a.id, status: 'doing', waitingOn: undefined, ask: undefined })] };
  const result = closeResolvedMailboxItems('alpha', next, { dir, now: T0 + 1000 });
  assert.equal(result.closed, 1);
  const record = stored(dir, a.id);
  assert.equal(record.closedBy, 'project');
  assert.equal(record.closeNote, 'resolved by the project');
  assert.equal(record.closedAt, new Date(T0 + 1000).toISOString());
  assert.ok(record.readAt);
});

test('a publish closes the item when the task is done, has no wait, or waits on another party', (t) => {
  const dir = freshDir(t);
  const done = item(dir, 'alpha');
  const boss = item(dir, 'alpha');
  const external = item(dir, 'alpha');
  const next = { tasks: [
    task('1', { mailboxId: done.id, status: 'done', waitingOn: undefined, ask: undefined }),
    task('2', { mailboxId: boss.id, waitingOn: 'boss' }),
    task('3', { mailboxId: external.id, waitingOn: 'external' }),
  ] };
  assert.equal(closeResolvedMailboxItems('alpha', next, { dir }).closed, 3);
  for (const record of [done, boss, external]) assert.equal(stored(dir, record.id).closedBy, 'project');
});

test('a task that is absent from the status never closes its item', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const other = task('2');
  assert.equal(closeResolvedMailboxItems('alpha', { tasks: [other] }, { dir }).closed, 0, 'the task is gone');
  assert.equal(closeResolvedMailboxItems('alpha', { tasks: [] }, { dir }).closed, 0, 'no tasks');
  assert.equal(closeResolvedMailboxItems('alpha', { project: 'Alpha', metrics: [] }, { dir }).closed, 0, 'a status without a tasks key');
  assert.equal(closeResolvedMailboxItems('alpha', null, { dir }).closed, 0);
  assert.equal(stored(dir, a.id).closedAt, undefined);
});

test('a publish for another slug never closes the item', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const next = { tasks: [task('1', { mailboxId: a.id, status: 'doing', waitingOn: undefined, ask: undefined })] };
  assert.equal(closeResolvedMailboxItems('beta', next, { dir }).closed, 0);
  assert.equal(stored(dir, a.id).closedAt, undefined);
});

test('a task that still waits on the Owner with the same mailboxId keeps the item open', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const status = { tasks: [task('1', { mailboxId: a.id })] };
  assert.equal(closeResolvedMailboxItems('alpha', status, { dir }).closed, 0);
  const twin = { tasks: [task('1', { mailboxId: a.id }), task('2', { mailboxId: a.id, status: 'done', waitingOn: undefined, ask: undefined })] };
  assert.equal(closeResolvedMailboxItems('alpha', twin, { dir }).closed, 0, 'one task still waits');
  assert.equal(stored(dir, a.id).closedAt, undefined);
});

test('an item without a task reference is never closed by a publish', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const b = item(dir, 'alpha');
  const next = { tasks: [task('1', { mailboxId: b.id, status: 'doing', waitingOn: undefined, ask: undefined }), task('9', { status: 'done', waitingOn: undefined, ask: undefined })] };
  closeResolvedMailboxItems('alpha', next, { dir });
  assert.equal(stored(dir, a.id).closedAt, undefined, 'no task names this item');
  assert.equal(stored(dir, b.id).closedBy, 'project');
});

test('a review item is never closed by a publish', (t) => {
  const dir = freshDir(t);
  const review = appendMessage({ ...ask('alpha', 'Review the pack.', { action: 'approve' }), kind: 'review', title: 'Pack' }, { dir, now: T0 });
  const next = { tasks: [task('1', { mailboxId: review.id, status: 'doing', waitingOn: undefined, ask: undefined })] };
  assert.equal(closeResolvedMailboxItems('alpha', next, { dir }).closed, 0);
  assert.equal(stored(dir, review.id).closedAt, undefined);
});

test('the close is idempotent, keeps an existing closedAt, and does not rewrite the store without an open item', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const b = item(dir, 'alpha', { closedAt: new Date(T0 + 5).toISOString(), closedBy: 'owner', closeNote: 'answered elsewhere' });
  const next = { tasks: [task('1', { mailboxId: a.id, status: 'doing', waitingOn: undefined, ask: undefined }), task('2', { mailboxId: b.id, status: 'done', waitingOn: undefined, ask: undefined })] };
  assert.equal(closeResolvedMailboxItems('alpha', next, { dir, now: T0 + 1000 }).closed, 1);
  const first = stored(dir, a.id).closedAt;
  const file = messages.messagesFile(dir);
  const before = fs.statSync(file).mtimeMs;
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(closeResolvedMailboxItems('alpha', next, { dir, now: T0 + 9000 }).closed, 0);
  assert.equal(stored(dir, a.id).closedAt, first);
  assert.equal(stored(dir, b.id).closedAt, new Date(T0 + 5).toISOString());
  assert.equal(stored(dir, b.id).closedBy, 'owner');
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the store is not rewritten');
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('a failed mailbox update never fails the publish', (t) => {
  const file = path.join(freshDir(t), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const lines = [];
  const next = { tasks: [task('1', { mailboxId: 'm1', status: 'doing', waitingOn: undefined, ask: undefined })] };
  let result;
  assert.doesNotThrow(() => { result = closeResolvedOnPublish('alpha', next, { dir: file, warn: (line) => lines.push(line) }); });
  assert.equal(result.closed, 0);
  assert.ok(result.error);
  assert.match(lines[0], /Mailbox update after the publish of alpha failed/);
});

test('the publish route closes the item and still answers 200 for a status that closes nothing', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const a = appendMessage(ask('alpha', 'Choose.'));
  const { base } = await startServer(t);
  const put = (body) => fetch(`${base}/api/projects/alpha`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waiting = { project: 'Alpha', tasks: [task('1', { mailboxId: a.id })] };
  assert.equal((await put(waiting)).status, 200);
  assert.equal(readMessages().find((r) => r.id === a.id).closedAt, undefined, 'still waiting');
  const cleared = { project: 'Alpha', tasks: [task('1', { mailboxId: a.id, status: 'doing', waitingOn: undefined, ask: undefined })] };
  assert.equal((await put(cleared)).status, 200);
  const record = readMessages().find((r) => r.id === a.id);
  assert.equal(record.closedBy, 'project');
  assert.equal(record.closeNote, 'resolved by the project');
  const view = await (await fetch(`${base}/api/mailbox`)).json();
  assert.equal(view.needsYou.length, 0);
  assert.equal(view.done.find((r) => r.id === a.id).closedBy, 'project');
});

test('the close suggestion shows after a later Owner message and stops after Keep open or a close', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha', {}, T0);
  const view = () => mailboxView(readMessages({ dir })).needsYou.find((r) => r.id === a.id);
  assert.equal(view().closeSuggestion, false, 'no Owner message yet');
  appendMessage(owner('alpha', 'Earlier.'), { dir, now: T0 - 5000 });
  assert.equal(view().closeSuggestion, false, 'an earlier Owner message does not count');
  appendMessage(owner('beta', 'Other thread.'), { dir, now: T0 + 1000 });
  assert.equal(view().closeSuggestion, false, 'another thread does not count');
  appendMessage(owner('alpha', 'I decided in chat: ship it.'), { dir, now: T0 + 2000 });
  assert.equal(view().closeSuggestion, true);
  assert.equal(keepMailboxItemsOpen({ ids: [a.id] }, { dir, now: T0 + 3000 }).kept, 1);
  assert.equal(stored(dir, a.id).closeSuggestionDismissedAt, new Date(T0 + 3000).toISOString());
  assert.equal(view().closeSuggestion, false, 'Keep open hides it');
  appendMessage(owner('alpha', 'Another chat message.'), { dir, now: T0 + 4000 });
  assert.equal(view().closeSuggestion, false, 'it stays hidden for this item');
});

test('an Owner answer to the item closes it and shows no suggestion', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const b = item(dir, 'alpha', {}, T0 + 10);
  appendMessage(owner('alpha', 'Ship.', { replyTo: a.id }), { dir, now: T0 + 2000 });
  messages.closeMailboxItem(a.id, { dir, now: T0 + 2000 });
  const view = mailboxView(readMessages({ dir }));
  assert.equal(view.done.find((r) => r.id === a.id).closeSuggestion, false);
  assert.equal(view.needsYou.find((r) => r.id === b.id).closeSuggestion, true, 'a message that answers another item is a later Owner message for this one');
  const c = item(dir, 'alpha', {}, T0 + 3000);
  assert.equal(mailboxView(readMessages({ dir })).needsYou.find((r) => r.id === c.id).closeSuggestion, false, 'an item newer than the Owner message');
});

test('a read information item never gets the suggestion', (t) => {
  const dir = freshDir(t);
  const info = appendMessage({ ...ask('alpha', 'FYI.', { action: 'read' }), kind: 'report', title: 'FYI' }, { dir, now: T0 });
  appendMessage(owner('alpha', 'Later.'), { dir, now: T0 + 1000 });
  assert.equal(mailboxView(readMessages({ dir })).updates.find((r) => r.id === info.id).closeSuggestion, false);
});

test('Close as answered elsewhere closes with closedBy owner, moves to Done, and updates the counts', (t) => {
  const dir = freshDir(t);
  const a = item(dir, 'alpha');
  const b = item(dir, 'alpha', { action: 'approve' });
  assert.equal(mailboxCounts(readMessages({ dir })).needsYou, 2);
  const result = dismissMailboxItems({ ids: [a.id], answeredElsewhere: true }, { dir, now: T0 + 1000 });
  assert.deepEqual({ ok: result.ok, closed: result.closed }, { ok: true, closed: 1 });
  const record = stored(dir, a.id);
  assert.equal(record.closedBy, 'owner');
  assert.equal(record.closeNote, 'answered elsewhere');
  assert.equal(record.dismissed, undefined, 'it is not a dismissal');
  assert.ok(record.readAt);
  const counts = mailboxCounts(readMessages({ dir }));
  assert.equal(counts.needsYou, 1);
  assert.equal(counts.needsYouUnread, 1);
  const view = mailboxView(readMessages({ dir }));
  assert.deepEqual(view.done.map((r) => r.id), [a.id]);
  assert.deepEqual(view.needsYou.map((r) => r.id), [b.id]);
  assert.equal(dismissMailboxItems({ ids: [a.id], answeredElsewhere: true }, { dir }).status, 409, 'a closed item stays closed');
  assert.equal(dismissMailboxItems({ ids: [b.id], answeredElsewhere: 'yes' }, { dir }).status, 400);
});

test('Keep open and answered elsewhere refuse an item that is not an open Owner Needs-you item', (t) => {
  const dir = freshDir(t);
  const closed = item(dir, 'alpha', { closedAt: new Date(T0 + 5).toISOString() });
  const info = appendMessage({ ...ask('alpha', 'FYI.', { action: 'read' }), kind: 'report', title: 'FYI' }, { dir, now: T0 });
  const review = appendMessage({ ...ask('alpha', 'Review.', { action: 'approve' }), kind: 'review', title: 'Pack' }, { dir, now: T0 });
  const ownerMessage = appendMessage(owner('alpha', 'Hello.'), { dir, now: T0 });
  for (const id of [closed.id, info.id, review.id]) {
    assert.equal(keepMailboxItemsOpen({ ids: [id] }, { dir }).status, 409, 'keep open');
    assert.equal(stored(dir, id).closeSuggestionDismissedAt, undefined);
  }
  assert.equal(keepMailboxItemsOpen({ ids: [ownerMessage.id] }, { dir }).status, 404, 'an Owner message is not an item');
  assert.equal(dismissMailboxItems({ ids: [review.id], answeredElsewhere: true }, { dir }).status, 409, 'a review item');
  assert.equal(dismissMailboxItems({ ids: [info.id], answeredElsewhere: true }, { dir }).status, 409, 'an information item');
  assert.equal(dismissMailboxItems({ ids: [ownerMessage.id], answeredElsewhere: true }, { dir }).status, 404);
  assert.equal(stored(dir, review.id).closedAt, undefined);
  appendMessage(owner('alpha', 'Later.'), { dir, now: T0 + 1000 });
  assert.equal(mailboxView(readMessages({ dir })).needsYou.find((r) => r.id === review.id).closeSuggestion, false, 'no suggestion for a review item');
});

test('a review item has no Close as answered elsewhere button on the row or the phone bar', () => {
  const review = { id: 'r1', thread: 'alpha', from: 'orch', kind: 'review', action: 'approve', title: 'Pack', at: '2026-09-30T08:00:00Z', packUrl: '/reviews/x' };
  const row = mailRowHtml({ key: 'alpha:r1', item: review, ids: ['r1'], count: 1, unread: false }, { esc, icon, avatar: () => '', clock: () => '', sender: () => 'Alpha' });
  assert.doesNotMatch(row, /data-mail-elsewhere/);
  const bar = mailActionBarHtml(review, { esc, icon });
  assert.doesNotMatch(bar, /data-mail-elsewhere|mail-bar-elsewhere/);
  assert.equal(mailElsewhereButtonHtml(review, { esc }), '');
  assert.equal(mailSuggestionHtml({ ...review, closeSuggestion: false }, { esc }), '');
});

test('the answered-elsewhere and Keep open routes work and refuse a cross-origin request', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const a = appendMessage(ask('alpha', 'Choose.'));
  const b = appendMessage(ask('alpha', 'Approve?', { action: 'approve' }));
  const { base } = await startServer(t);
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/messages/keep-open', { ids: [a.id] }, { origin: 'http://evil.example' })).status, 403);
  const kept = await post('/api/messages/keep-open', { ids: [a.id] });
  assert.equal(kept.status, 200);
  assert.ok(readMessages().find((r) => r.id === a.id).closeSuggestionDismissedAt);
  const closed = await post('/api/messages/dismiss', { ids: [b.id], answeredElsewhere: true });
  assert.equal(closed.status, 200);
  const body = await closed.json();
  assert.equal(body.closed, 1);
  assert.equal(body.mailbox.needsYou, 1);
  assert.equal(readMessages().find((r) => r.id === b.id).closedBy, 'owner');
  assert.equal((await post('/api/messages/keep-open', { ids: ['nope'] })).status, 404);
});

test('the button renders on the phone bar, in the list row, in the thread, and escapes the ID', () => {
  const open = { id: 'a"<1', thread: 'alpha', from: 'orch', action: 'decide', choices: [] };
  for (const action of ['decide', 'approve', 'answer']) {
    const bar = mailActionBarHtml({ ...open, action, choices: action === 'decide' ? ['Ship'] : [] }, { esc, icon });
    assert.match(bar, /data-mail-elsewhere="a&quot;&lt;1"/, `the ${action} bar`);
    assert.match(bar, /Close as answered elsewhere/);
    assert.match(bar, /mail-bar-elsewhere/);
    assert.doesNotMatch(bar, /a"<1/);
  }
  const row = mailRowHtml({ key: 'alpha:a', item: { ...open, at: '2026-09-30T08:00:00Z', conversationId: 'c' }, ids: [open.id], count: 1, unread: false }, { esc, icon, avatar: () => '', clock: () => '', sender: () => 'Alpha' });
  assert.match(row, /<button type="button" class="app-icon-button mail-row-action" data-mail-elsewhere="a&quot;&lt;1" aria-label="Close as answered elsewhere"/);
  const noIcon = mailRowHtml({ key: 'alpha:a', item: { ...open, at: '2026-09-30T08:00:00Z' }, ids: [open.id], count: 1, unread: false }, { esc, avatar: () => '', clock: () => '', sender: () => 'Alpha' });
  assert.doesNotMatch(noIcon, /data-mail-elsewhere/, 'a list without row actions');
  const closedRow = mailRowHtml({ key: 'alpha:a', item: { ...open, closedAt: '2026-09-30T09:00:00Z', closedBy: 'owner', at: '2026-09-30T08:00:00Z' }, ids: [open.id], count: 1, unread: false }, { esc, icon, avatar: () => '', clock: () => '', sender: () => 'Alpha' });
  assert.doesNotMatch(closedRow, /data-mail-elsewhere/, 'a closed item has no button');
  assert.match(closedRow, /Closed as answered elsewhere/);
  const info = mailRowHtml({ key: 'alpha:a', item: { ...open, action: 'read', at: '2026-09-30T08:00:00Z' }, ids: [open.id], count: 1, unread: false }, { esc, icon, avatar: () => '', clock: () => '', sender: () => 'Alpha' });
  assert.doesNotMatch(info, /data-mail-elsewhere/, 'an information item has no button');
  assert.match(mailElsewhereButtonHtml(open, { esc }), /^<button type="button" class="" data-mail-elsewhere="a&quot;&lt;1">Close as answered elsewhere<\/button>$/);
});

test('the thread and the drawer wire the button, the suggestion, and the closed lines', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /mailElsewhereButtonHtml\(item, \{ esc, busy: mailbox\.busy \}\)/, 'the thread form');
  assert.match(app, /postJson\('\/api\/messages\/dismiss', \{ ids: \[item\.id\], answeredElsewhere: true \}\)/);
  assert.match(app, /postJson\('\/api\/messages\/keep-open'/);
  assert.match(app, /Closed as answered elsewhere · /);
  assert.match(app, /Resolved by the project · /);
  assert.match(app, /data-mail-elsewhere/);
});

test('the suggestion asks Close this item? with two buttons, only for an open suggested item', () => {
  const open = { id: 'a1', closeSuggestion: true };
  const html = mailSuggestionHtml(open, { esc });
  assert.match(html, /Close this item\?/);
  assert.match(html, /<button type="button" data-mail-elsewhere="a1">Close as answered elsewhere<\/button>/);
  assert.match(html, /<button type="button" class="mail-suggest-keep" data-mail-keep="a1">Keep open<\/button>/);
  assert.equal(mailSuggestionHtml({ id: 'a1', closeSuggestion: false }, { esc }), '');
  assert.equal(mailSuggestionHtml({ id: 'a1', closeSuggestion: true, closedAt: '2026-09-30T09:00:00Z' }, { esc }), '');
  assert.equal(mailSuggestionHtml(null, { esc }), '');
  assert.match(mailSuggestionHtml({ id: 'a"1', closeSuggestion: true }, { esc }), /data-mail-keep="a&quot;1"/);
});

test('the touch targets of the new controls are 44 px', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.mail-row-action \{[^}]*width: 44px; height: 44px/);
  assert.match(css, /\.mail-suggest-buttons button \{[^}]*min-height: 44px/);
});

async function startServer(t) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { slug: 'alpha', label: 'Alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } }, herdr: { panes: [] } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(close);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { base: `http://127.0.0.1:${server.address().port}` };
}
