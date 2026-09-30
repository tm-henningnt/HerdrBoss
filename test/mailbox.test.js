import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mailbox-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mailbox-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const messages = await import('../src/messages.js');
const {
  appendMessage, readMessages, isMailboxItem, mailboxAction, messageChannel, parseChoices, mailboxCounts, mailboxFolders, mailboxView,
  markMailboxRead, validateOwnerSend, closeMailboxItem, closeMailboxItems, ownerPromptText,
} = messages;
const [{ serve }, { loadConfig }] = await Promise.all([import('../src/server.js'), import('../src/config.js')]);

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(dataDir, 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DAY = 86400000;
const now = Date.parse('2026-09-28T12:00:00.000Z');

const reply = (thread, text, extra = {}) => ({ thread, from: thread === 'boss' ? 'boss' : 'orch', to: 'owner', kind: 'reply', text, action: null, replyTo: null, status: 'new', ...extra });
const report = (title, text, extra = {}) => ({ thread: 'boss', from: 'boss', to: 'owner', kind: 'report', title, text, action: null, replyTo: null, status: 'new', ...extra });
const owner = (thread, text, extra = {}) => ({ thread, from: 'owner', to: thread === 'boss' ? 'boss' : 'orch', kind: 'message', text, action: null, replyTo: null, status: 'queued', ...extra });

test('the mailbox holds every reply and report to the Owner, and an item without an action counts as read', () => {
  assert.equal(isMailboxItem(reply('alpha', 'Done.')), true);
  assert.equal(isMailboxItem(report('Morning handback', '# Morning handback')), true);
  assert.equal(isMailboxItem(owner('alpha', 'Continue.')), false, 'an Owner send is not an item');
  assert.equal(isMailboxItem({ ...reply('alpha', 'x'), to: 'boss' }), false);
  assert.equal(isMailboxItem({ ...reply('alpha', 'x'), kind: 'message' }), false);
  assert.equal(isMailboxItem(null), false);
  assert.equal(mailboxAction(reply('alpha', 'x')), 'read');
  assert.equal(mailboxAction(reply('alpha', 'x', { action: 'bogus' })), 'read');
  for (const action of ['answer', 'approve', 'decide', 'read']) assert.equal(mailboxAction(reply('alpha', 'x', { action })), action);
});

test('the mailbox separates Needs you from Updates and counts only unopened open actions', () => {
  const noAction = reply('alpha', 'Information without an action.');
  delete noAction.action;
  const records = [
    { ...reply('alpha', 'Answer this question.', { action: 'answer' }), id: 'm-answer', at: new Date(now - 5000).toISOString() },
    { ...reply('boss', 'Approve the plan.', { action: 'approve', readAt: new Date(now - 4000).toISOString() }), id: 'm-approve', at: new Date(now - 4000).toISOString() },
    { ...reply('alpha', 'Choose a route.', { action: 'decide', readAt: new Date(now - 3000).toISOString(), closedAt: new Date(now - 2000).toISOString() }), id: 'm-done', at: new Date(now - 3000).toISOString() },
    { ...noAction, id: 'm-update', at: new Date(now - 1000).toISOString() },
    { ...reply('alpha', 'Read this note.', { action: 'read', readAt: new Date(now - 500).toISOString() }), id: 'm-read-update', at: new Date(now - 500).toISOString() },
  ];

  assert.equal(mailboxAction(noAction), 'read', 'a record without an action is information');
  assert.deepEqual(mailboxCounts(records), {
    needsYou: 2,
    needsYouUnread: 1,
    updates: 0,
    unread: 1,
    open: 2,
    chatUnread: 2,
    mailUnread: 0,
    needsAction: 2,
  });
  const view = mailboxView(records);
  assert.deepEqual(view.needsYou.map((item) => item.id), ['m-approve', 'm-answer']);
  assert.deepEqual(view.updates.map((item) => item.id), [], 'a chat reply is not an update');
  assert.deepEqual(view.done.map((item) => item.id), ['m-done']);
});

test('mailbox folders classify Owner items, sent messages, and completed items', () => {
  const opened = new Date(now - 4000).toISOString();
  const sent = { ...owner('alpha', 'Can you check this?'), id: 'm-sent', at: new Date(now - 3000).toISOString(), status: 'sent', sentAt: new Date(now - 2500).toISOString() };
  const replyToSent = { ...reply('alpha', 'I checked it.', { replyTo: sent.id }), id: 'm-reply', at: new Date(now - 2000).toISOString() };
  const relayed = { ...owner('boss', 'Please review this.'), id: 'm-relayed', at: new Date(now - 1000).toISOString(), status: 'relayed', relayedAt: new Date(now - 500).toISOString(), relayedBy: 'boss' };
  const records = [
    { ...reply('alpha', 'Please answer.', { action: 'answer' }), id: 'm-needs', at: opened },
    { ...report('Status update', 'A status update.'), id: 'm-update', at: new Date(now - 3500).toISOString() },
    sent,
    replyToSent,
    relayed,
    { ...reply('boss', 'Dismissed item.', { action: 'decide', dismissed: true, closedAt: new Date(now - 700).toISOString() }), id: 'm-dismissed', at: new Date(now - 800).toISOString() },
    { ...report('Closed report', 'Finished.', { closedAt: new Date(now - 600).toISOString() }), id: 'm-closed-report', at: new Date(now - 650).toISOString() },
  ];

  const folders = messages.mailboxFolders(records);
  assert.deepEqual(folders.needsYou.map((item) => item.id), ['m-needs']);
  assert.deepEqual(folders.updates.map((item) => item.id), ['m-update'], 'a plain chat reply is not an update');
  assert.deepEqual(folders.sent.map((item) => item.id), ['m-relayed', 'm-sent']);
  assert.deepEqual(folders.done.map((item) => item.id), ['m-closed-report', 'm-dismissed', 'm-relayed']);
  assert.equal(folders.sent.find((item) => item.id === sent.id).repliedAt, replyToSent.at);
  assert.equal(folders.sent.find((item) => item.id === sent.id).conversationId, sent.id);
});

test('mailbox conversation groups follow replyTo chains within each thread', () => {
  const records = [
    { ...owner('alpha', 'Start.'), id: 'm-root', at: new Date(now).toISOString() },
    { ...reply('alpha', 'First reply.', { replyTo: 'm-root' }), id: 'm-reply', at: new Date(now + 1000).toISOString() },
    { ...owner('alpha', 'Follow up.', { replyTo: 'm-reply' }), id: 'm-follow-up', at: new Date(now + 2000).toISOString() },
    { ...report('Separate report', 'Status.'), id: 'm-report', at: new Date(now + 3000).toISOString() },
    { ...reply('boss', 'Same ID, other thread.', { replyTo: 'm-root' }), id: 'm-other-thread', at: new Date(now + 4000).toISOString() },
  ];

  const groups = messages.groupMessagesByConversation(records);
  assert.deepEqual(groups.map(({ id, thread, records: group }) => [id, thread, group.map((record) => record.id)]), [
    ['m-other-thread', 'boss', ['m-other-thread']],
    ['m-report', 'boss', ['m-report']],
    ['m-root', 'alpha', ['m-root', 'm-reply', 'm-follow-up']],
  ]);
});

test('the mailbox defaults to Needs you when it has items and restores the last folder when empty', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const match = /function resolveMailboxFolder\(requested, remembered, needsYouCount\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(match, 'the UI defines a testable default-folder rule');
  const resolve = new Function('MAIL_FOLDERS', 'requested', 'remembered', 'needsYouCount', match[1]);

  assert.equal(resolve(['needs-you', 'updates', 'sent', 'done'], null, 'updates', 2), 'needs-you');
  assert.equal(resolve(['needs-you', 'updates', 'sent', 'done'], 'updates', 'needs-you', 2), 'updates', 'an explicit folder link wins');
  assert.equal(resolve(['needs-you', 'updates', 'sent', 'done'], null, 'sent', 0), 'sent');
  assert.equal(resolve(['needs-you', 'updates', 'sent', 'done'], null, 'unknown', 0), 'needs-you');
});

test('choices come from a Markdown list under a Choices heading', () => {
  assert.deepEqual(parseChoices('Pick one.\n\n## Choices\n\n- Ship now\n- Wait for review\n\nNot a choice.\n- Later'), ['Ship now', 'Wait for review']);
  assert.deepEqual(parseChoices('### choices:\n1. A\n2) B\n* C\n\nText after.'), ['A', 'B', 'C']);
  assert.deepEqual(parseChoices('# Choices\n- One\n\n- Two\nParagraph.\n- Three'), ['One', 'Two'], 'the list ends at the first line that is not a list item');
  assert.deepEqual(parseChoices('# Choices\n- One\n## Notes\n- Two'), ['One'], 'the list ends at the next heading');
  assert.deepEqual(parseChoices('Choices\n- One'), [], 'a plain line is not a heading');
  assert.deepEqual(parseChoices('- One\n- Two'), []);
  assert.deepEqual(parseChoices('## Choices\n-   \n- Same\n- Same'), ['Same'], 'empty and repeated items are dropped');
  assert.equal(parseChoices(`## Choices\n${Array.from({ length: 15 }, (_, i) => `- C${i}`).join('\n')}`).length, 10);
  assert.deepEqual(parseChoices(null), []);
});

test('the view lists open items newest first and closed items under done, with the Owner answer', (t) => {
  const dir = freshDir(t);
  const first = appendMessage(report('Morning handback', '# Morning handback\n\nAll green.'), { dir, now: now - 3000 });
  const second = appendMessage(reply('alpha', 'Choose a date.\n\n## Choices\n- Monday\n- Friday', { action: 'decide' }), { dir, now: now - 2000 });
  const third = appendMessage(reply('boss', 'Approve the spend?', { action: 'approve' }), { dir, now: now - 1000 });
  appendMessage(owner('alpha', 'Continue.'), { dir, now: now - 500 });
  const answer = appendMessage(owner('boss', 'Approved.', { replyTo: third.id }), { dir, now });
  closeMailboxItem(third.id, { dir, now });
  const records = readMessages({ dir });
  assert.deepEqual(mailboxCounts(records), { needsYou: 1, needsYouUnread: 1, updates: 1, unread: 1, open: 1, chatUnread: 1, mailUnread: 1, needsAction: 1 }, 'updates do not count as unread actions');
  const view = mailboxView(records);
  assert.deepEqual(view.needsYou.map((item) => item.id), [second.id]);
  assert.deepEqual(view.updates.map((item) => item.id), [first.id]);
  assert.deepEqual(view.done.map((item) => item.id), [third.id]);
  assert.equal(view.needsYou[0].action, 'decide');
  assert.deepEqual(view.needsYou[0].choices, ['Monday', 'Friday']);
  assert.equal(view.updates[0].action, 'read');
  assert.deepEqual(view.updates[0].choices, []);
  assert.equal(view.done[0].answer.id, answer.id);
  assert.equal(view.done[0].answer.text, 'Approved.');
  assert.equal(view.done[0].closedAt, new Date(now).toISOString());
  assert.equal(view.done[0].readAt, new Date(now).toISOString(), 'closing an item also marks it read');
});

test('the Boss can close open mailbox items with a safe note, without sending a message', (t) => {
  const dir = freshDir(t);
  const item = appendMessage(reply('alpha', 'Which route?', { action: 'decide' }), { dir, now });
  const reportItem = appendMessage(report('Handback', 'All clear.'), { dir, now });

  const result = closeMailboxItems([item.id, reportItem.id], 'Handled with the Owner through the Boss.', { by: 'boss', dir, now: now + 1000 });
  assert.deepEqual(result, { ok: true, closed: 2 });
  const records = readMessages({ dir });
  for (const id of [item.id, reportItem.id]) {
    const stored = records.find((record) => record.id === id);
    assert.equal(stored.closedAt, new Date(now + 1000).toISOString());
    assert.equal(stored.readAt, new Date(now + 1000).toISOString());
    assert.equal(stored.closedBy, 'boss');
    assert.equal(stored.closeNote, 'Handled with the Owner through the Boss.');
  }
  assert.equal(records.length, 2, 'closing creates no Owner message or reply');
  assert.deepEqual(mailboxView(records).done.map((done) => done.id), [reportItem.id, item.id]);
  assert.deepEqual(mailboxCounts(records), { needsYou: 0, needsYouUnread: 0, updates: 0, unread: 0, open: 0, chatUnread: 0, mailUnread: 0, needsAction: 0 });
});

test('Boss close validates its caller, note, and every open mailbox ID before changing records', (t) => {
  const dir = freshDir(t);
  const item = appendMessage(reply('alpha', 'Which route?', { action: 'decide' }), { dir, now });
  const closed = appendMessage(reply('alpha', 'Already handled.', { action: 'answer', closedAt: new Date(now).toISOString() }), { dir, now });

  for (const [ids, note, by, match] of [
    [[item.id], 'Handled.', 'orch', /Boss/],
    [[item.id], '', 'boss', /1 to 500/],
    [[item.id], 'x'.repeat(501), 'boss', /1 to 500/],
    [[item.id], 'api_key=abcdef123456', 'boss', /secret/i],
    [['m-unknown'], 'Handled.', 'boss', new RegExp('m-unknown')],
    [[closed.id], 'Handled.', 'boss', new RegExp(closed.id)],
    [[item.id, 'm-unknown'], 'Handled.', 'boss', new RegExp('m-unknown')],
  ]) assert.match(closeMailboxItems(ids, note, { by, dir, now }).error, match);

  assert.equal(readMessages({ dir }).find((record) => record.id === item.id).closedAt, undefined, 'a refused batch changes no item');
});

test('a Boss close note is visible in the collapsed Done item summary', () => {
  const rows = fs.readFileSync(new URL('../public/mail-rows.js', import.meta.url), 'utf8');
  assert.match(rows, /const preview = item\.closedBy === 'boss' \? `answered through the Boss: \$\{item\.closeNote \|\| ''\}` : mailPreview\(item\);/);
  assert.match(rows, /<span class="mail-preview">\$\{esc\(preview\)\}<\/span>/);
});

test('marking read sets readAt once, closes only read items on request, and keeps the 30-day retention', (t) => {
  const dir = freshDir(t);
  const old = appendMessage(reply('alpha', 'Old.'), { dir, now: now - 31 * DAY });
  const item = appendMessage(reply('alpha', 'Finished.'), { dir, now });
  const question = appendMessage(reply('alpha', 'Which?', { action: 'decide' }), { dir, now });
  const sent = appendMessage(owner('alpha', 'Continue.'), { dir, now });
  const later = now + 60000;

  for (const [body, status] of [
    [null, 400], [{}, 400], [{ ids: [] }, 400], [{ ids: 'x' }, 400], [{ ids: [1] }, 400],
    [{ ids: Array.from({ length: 201 }, (_, i) => `m-${i}`) }, 400], [{ ids: [item.id], close: 'yes' }, 400],
    [{ ids: ['m-missing'] }, 404], [{ ids: [sent.id] }, 404],
    [{ ids: [question.id], close: true }, 409],
  ]) assert.equal(markMailboxRead(body, { dir, now: later }).status, status, JSON.stringify(body));
  assert.equal(readMessages({ dir }).find((r) => r.id === question.id).readAt, undefined, 'a refused request changes nothing');

  const result = markMailboxRead({ ids: [item.id, question.id] }, { dir, now: later });
  assert.deepEqual(result, { ok: true, updated: 2 });
  let records = readMessages({ dir });
  assert.equal(records.some((r) => r.id === old.id), false, 'the rewrite deletes records older than 30 days');
  assert.equal(records.find((r) => r.id === item.id).readAt, new Date(later).toISOString());
  assert.equal(records.find((r) => r.id === item.id).closedAt, new Date(later).toISOString(), 'a read information item closes with readAt');
  assert.deepEqual(markMailboxRead({ ids: [item.id] }, { dir, now: later + 1000 }), { ok: true, updated: 0 }, 'a second read keeps the first readAt');
  assert.equal(readMessages({ dir }).find((r) => r.id === item.id).readAt, new Date(later).toISOString());

  assert.deepEqual(markMailboxRead({ ids: [item.id], close: true }, { dir, now: later + 2000 }), { ok: true, updated: 0 }, 'the item closed at the first read');
  records = readMessages({ dir });
  assert.equal(records.find((r) => r.id === item.id).closedAt, new Date(later).toISOString());
  assert.deepEqual(mailboxCounts(records), { needsYou: 1, needsYouUnread: 0, updates: 0, unread: 0, open: 1, chatUnread: 0, mailUnread: 0, needsAction: 1 });
});

test('an Owner answer names an open item of the same thread and closes it', (t) => {
  const dir = freshDir(t);
  const question = appendMessage(reply('alpha', 'Which date?', { action: 'decide' }), { dir, now });
  const bossItem = appendMessage(reply('boss', 'Approve?', { action: 'approve' }), { dir, now });
  const sent = appendMessage(owner('alpha', 'Continue.'), { dir, now });
  const knownThreads = new Set(['boss', 'alpha']);
  const records = readMessages({ dir });
  const check = (body) => validateOwnerSend({ thread: 'alpha', kind: 'message', text: 'Monday.', ...body }, { knownThreads, records, now });

  assert.equal(check({ replyTo: 'm-missing' }).status, 404);
  assert.equal(check({ replyTo: bossItem.id }).status, 404, 'the item must be in the send thread');
  assert.equal(check({ replyTo: sent.id }).status, 404, 'an Owner send is not an item');
  assert.equal(check({ replyTo: 7 }).status, 400);
  assert.equal(check({ kind: 'nudge', text: 'Continue.', replyTo: question.id }).status, 400, 'only a message answers an item');
  const accepted = check({ replyTo: question.id });
  assert.equal(accepted.fields.replyTo, question.id);
  assert.equal(check({}).fields.replyTo, null);

  closeMailboxItem(question.id, { dir, now });
  const closed = validateOwnerSend({ thread: 'alpha', kind: 'message', text: 'Again.', replyTo: question.id }, { knownThreads, records: readMessages({ dir }), now });
  assert.equal(closed.status, 409);
  assert.match(ownerPromptText({ id: 'm-a', text: 'Monday.', replyTo: question.id }), new RegExp(`^\\[owner\\] Answer to ${question.id}: Monday\\. \\(Reply with: herdr-boss say --reply-to m-a`));
  assert.equal(ownerPromptText({ id: 'm-b', text: 'Hi.', replyTo: null }), '[owner] Hi. (Reply with: herdr-boss say --reply-to m-b "<answer>")');
});

function rawRequest(base, method, route, { headers = {}, body } = {}) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startServer(t, options = {}) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  const { server, close } = serve(cfg, {
    ...options,
    createEngine: () => {
      engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { slug: 'alpha', label: 'Alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } }, herdr: { panes: [] } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(close);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { base: `http://127.0.0.1:${server.address().port}`, cfg, engine: () => engine };
}

test('the mailbox API lists items, marks them read behind the send gates, and answers close items', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const decide = appendMessage(reply('alpha', 'Which date?\n\n## Choices\n- Monday\n- Friday', { action: 'decide' }));
  const approve = appendMessage(reply('boss', 'Approve the spend?', { action: 'approve' }));
  const answerItem = appendMessage(reply('alpha', 'What is the tenant name?', { action: 'answer' }));
  const handback = appendMessage(report('Morning handback', '# Morning handback\n\nAll green.'));
  const { base, cfg } = await startServer(t);
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(state.mailbox, { needsYou: 3, needsYouUnread: 3, updates: 1, unread: 3, open: 3, chatUnread: 3, mailUnread: 1, needsAction: 3 });
  const list = await (await fetch(`${base}/api/mailbox`)).json();
  assert.deepEqual(list.needsYou.map((item) => item.id), [answerItem.id, approve.id, decide.id]);
  assert.deepEqual(list.updates.map((item) => item.id), [handback.id]);
  assert.deepEqual(list.needsYou.find((item) => item.id === decide.id).choices, ['Monday', 'Friday']);
  assert.deepEqual(list.done, []);

  const read = { ids: [handback.id] };
  const crossOrigin = await rawRequest(base, 'POST', '/api/messages/read', { headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify(read) });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await rawRequest(base, 'POST', '/api/messages/read', { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(read) });
  assert.equal(crossSite.status, 403);
  const remote = await rawRequest(base, 'POST', '/api/messages/read', { headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/json' }, body: JSON.stringify(read) });
  assert.equal(remote.status, 401);
  const remoteList = await rawRequest(base, 'GET', '/api/mailbox', { headers: { host: 'mac.tail0000.ts.net' } });
  assert.equal(remoteList.status, 401);
  const wrongType = await fetch(`${base}/api/messages/read`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(read) });
  assert.equal(wrongType.status, 400);
  assert.equal((await post('/api/messages/read', { ids: [] })).status, 400);
  assert.equal(readMessages().some((record) => record.readAt), false, 'no refused request reaches the store');

  const token = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await rawRequest(base, 'POST', '/login', { headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const phoneRead = await rawRequest(base, 'POST', '/api/messages/read', {
    headers: { host: 'mac.tail0000.ts.net', cookie, 'content-type': 'application/json', origin: 'http://mac.tail0000.ts.net' }, body: JSON.stringify(read),
  });
  assert.equal(phoneRead.status, 200, phoneRead.text);
  assert.deepEqual(JSON.parse(phoneRead.text), { ok: true, updated: 1, mailbox: { needsYou: 3, needsYouUnread: 3, updates: 0, unread: 3, open: 3, chatUnread: 3, mailUnread: 0, needsAction: 3 } });

  const closeRead = await post('/api/messages/read', { ids: [handback.id], close: true });
  assert.equal(closeRead.status, 200);
  assert.deepEqual((await closeRead.json()).mailbox, { needsYou: 3, needsYouUnread: 3, updates: 0, unread: 3, open: 3, chatUnread: 3, mailUnread: 0, needsAction: 3 });

  // Answer, approve, and decide use the Owner send path with replyTo.
  const sends = [
    [answerItem, 'alpha', 'The tenant is in the vault.'],
    [approve, 'boss', 'Approved. Keep it under budget.'],
    [decide, 'alpha', 'Choice: Friday'],
  ];
  for (const [item, thread, text] of sends) {
    const response = await post('/api/messages', { thread, kind: 'message', text, replyTo: item.id });
    assert.equal(response.status, 200, text);
    const body = await response.json();
    assert.equal(body.message.replyTo, item.id);
    assert.equal(body.message.status, 'queued');
    assert.equal(body.message.to, thread === 'boss' ? 'boss' : 'orch');
    const stored = readMessages().find((record) => record.id === item.id);
    assert.ok(stored.closedAt, `${item.action} closes the item`);
    assert.ok(stored.readAt, `${item.action} marks the item read`);
  }
  const again = await post('/api/messages', { thread: 'alpha', kind: 'message', text: 'Monday after all.', replyTo: decide.id });
  assert.equal(again.status, 409, 'a closed item takes no second answer');
  const wrongThread = await post('/api/messages', { thread: 'alpha', kind: 'message', text: 'Approved.', replyTo: approve.id });
  assert.equal(wrongThread.status, 404);

  const after = await (await fetch(`${base}/api/mailbox`)).json();
  assert.deepEqual(after.needsYou, []);
  assert.deepEqual(after.updates, []);
  assert.deepEqual(after.done.map((item) => item.id), [handback.id, answerItem.id, approve.id, decide.id]);
  assert.equal(after.done.find((item) => item.id === approve.id).answer.text, 'Approved. Keep it under budget.');
  assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).mailbox, { needsYou: 0, needsYouUnread: 0, updates: 0, unread: 0, open: 0, chatUnread: 0, mailUnread: 0, needsAction: 0 });
});

test('mailbox folder and thread queries return sent state and one ordered conversation', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const at = Date.parse('2026-09-28T10:00:00.000Z');
  const sent = appendMessage(owner('alpha', 'Can you review this?'), { now: at });
  const agent = appendMessage(reply('alpha', 'Yes. Which part?', { replyTo: sent.id, action: 'answer' }), { now: at + 1000 });
  const ownerReply = appendMessage(owner('alpha', 'The second section.', { replyTo: agent.id }), { now: at + 2000 });
  const relayed = appendMessage(owner('boss', 'I passed this on.' , { status: 'relayed', relayedAt: new Date(at + 2500).toISOString(), relayedBy: 'boss' }), { now: at + 2500 });
  const update = appendMessage(report('Daily update', 'Nothing to decide.'), { now: at + 3000 });
  const { base } = await startServer(t);

  const folderResponse = await fetch(`${base}/api/mailbox?folder=sent`);
  assert.equal(folderResponse.status, 200);
  const folders = await folderResponse.json();
  assert.equal(folders.folder, 'sent');
  assert.deepEqual(folders.items.map((item) => item.id), folders.sent.map((item) => item.id));
  assert.deepEqual(folders.sent.map((item) => item.id), [relayed.id, ownerReply.id, sent.id]);
  assert.ok(folders.done.some((item) => item.id === relayed.id));
  assert.equal(folders.sent.find((item) => item.id === sent.id).repliedAt, agent.at);
  assert.equal(folders.updatesUnread, 1);
  assert.deepEqual(folders.updates.map((item) => item.id), [update.id]);
  assert.equal((await fetch(`${base}/api/mailbox?folder=bad`)).status, 400);

  const listResponse = await fetch(`${base}/api/mailbox?thread=alpha`);
  assert.equal(listResponse.status, 200);
  const groups = await listResponse.json();
  assert.deepEqual(groups.map((group) => group.id), [sent.id]);
  assert.deepEqual(groups[0].messages.map((item) => item.id), [sent.id, agent.id, ownerReply.id]);

  const conversationResponse = await fetch(`${base}/api/mailbox?thread=alpha&conversation=${encodeURIComponent(sent.id)}`);
  const conversation = await conversationResponse.json();
  assert.equal(conversationResponse.status, 200);
  assert.equal(conversation.conversationId, sent.id);
  assert.ok(conversation.messages.every((item) => item.conversationId === sent.id));
  assert.deepEqual(conversation.messages.map((item) => item.id), [sent.id, agent.id, ownerReply.id]);
  assert.equal((await fetch(`${base}/api/mailbox?thread=alpha&conversation=missing`)).status, 404);
});

test('the read-only preview lists the mailbox and refuses the read API', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { readOnlyPreview: true });
  assert.equal((await fetch(`${base}/api/mailbox`)).status, 200);
  const response = await fetch(`${base}/api/messages/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['m-x'] }) });
  assert.equal(response.status, 403);
});

test('the mailbox can dismiss one or many open action items without sending an Owner message', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const one = appendMessage(reply('alpha', 'No longer needed.', { action: 'answer' }));
  const two = appendMessage(reply('alpha', 'Close this choice.', { action: 'decide' }));
  const three = appendMessage(reply('boss', 'Close this approval.', { action: 'approve' }));
  const beforeCount = readMessages().length;
  const { base } = await startServer(t);
  const post = (body, headers = {}) => fetch(`${base}/api/messages/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const crossOrigin = await post({ ids: [one.id] }, { origin: 'http://evil.example' });
  assert.equal(crossOrigin.status, 403);
  const single = await post({ ids: [one.id] });
  assert.equal(single.status, 200);
  assert.deepEqual((await single.json()).dismissed, 1);
  const bulk = await post({ ids: [two.id, three.id] });
  assert.equal(bulk.status, 200);
  assert.deepEqual((await bulk.json()).dismissed, 2);

  const records = readMessages();
  assert.equal(records.length, beforeCount, 'dismissal does not create an Owner send');
  for (const item of [one, two, three]) {
    const stored = records.find((record) => record.id === item.id);
    assert.ok(stored.closedAt);
    assert.equal(stored.readAt, stored.closedAt);
    assert.equal(stored.dismissed, true);
  }
  const list = await (await fetch(`${base}/api/mailbox`)).json();
  assert.deepEqual(list.done.map((item) => item.id).sort(), [one.id, two.id, three.id].sort());
  assert.ok(list.done.every((item) => item.dismissed));
  assert.deepEqual(list.mailbox, { needsYou: 0, needsYouUnread: 0, updates: 0, unread: 0, open: 0, chatUnread: 0, mailUnread: 0, needsAction: 0 });
});

test('message and mailbox APIs expose delivery, relay, and reply state', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const sentAt = new Date(now).toISOString();
  const repliedAt = new Date(now + 1000).toISOString();
  const incoming = appendMessage(owner('alpha', 'A status update.', { status: 'sent', sentAt, attempts: 1 }));
  const replyItem = appendMessage(reply('alpha', 'I am working on it.', { action: 'decide', replyTo: incoming.id }), { now: now + 1000 });
  const relayed = appendMessage(owner('boss', 'Already relayed.', { status: 'relayed', relayedAt: new Date(now + 2000).toISOString(), relayedBy: 'boss' }), { now: now + 2000 });
  const { base } = await startServer(t);

  const thread = await (await fetch(`${base}/api/messages?thread=alpha`)).json();
  const view = thread.find((record) => record.id === incoming.id);
  assert.equal(view.status, 'sent');
  assert.equal(view.sentAt, sentAt);
  assert.equal(view.repliedAt, repliedAt);
  const bossThread = await (await fetch(`${base}/api/messages?thread=boss`)).json();
  const relayView = bossThread.find((record) => record.id === relayed.id);
  assert.equal(relayView.status, 'relayed');
  assert.equal(relayView.relayedAt, relayed.relayedAt);
  assert.equal(relayView.relayedBy, 'boss');

  const list = await (await fetch(`${base}/api/mailbox`)).json();
  const item = list.needsYou.find((record) => record.id === replyItem.id);
  assert.deepEqual(item.ownerMessage, {
    id: incoming.id, at: incoming.at, text: incoming.text, status: 'sent', sentAt, error: null,
    relayedAt: null, relayedBy: null, repliedAt,
  });
});

test('a plain say reply is a chat message and never shows in Mailbox Updates', () => {
  const records = [
    { ...reply('alpha', 'Progress note without an action.'), id: 'm-chat', at: new Date(now - 3000).toISOString() },
    { ...reply('alpha', 'Read this note.', { action: 'read' }), id: 'm-read', at: new Date(now - 2000).toISOString() },
    { ...report('Handback', '# Handback'), id: 'm-report', at: new Date(now - 1000).toISOString() },
  ];
  assert.equal(messageChannel(records[0]), 'chat');
  const view = mailboxView(records);
  assert.deepEqual(view.updates.map((item) => item.id), ['m-report'], 'a chat reply is not an update, also with the action read');
  assert.deepEqual(view.needsYou, []);
  assert.deepEqual(view.done.map((item) => item.id), [], 'a chat reply never reaches Done through the Mailbox');
  const folders = mailboxFolders(records);
  assert.equal(folders.updatesUnread, 1, 'only the report counts as an unread update');
  const counts = mailboxCounts(records);
  assert.equal(counts.updates, 1);
  assert.equal(counts.chatUnread, 2, 'both chat replies to the Owner are chat unread');
  assert.equal(counts.mailUnread, 1, 'the report is mail unread');
  assert.equal(counts.needsAction, 0);
});

test('an approve reply is in Chat and in Needs you until it closes', () => {
  const records = [
    { ...reply('alpha', 'Information first.'), id: 'm-chat', at: new Date(now - 3000).toISOString() },
    { ...reply('boss', 'Approve the spend?', { action: 'approve' }), id: 'm-approve', at: new Date(now - 2000).toISOString() },
  ];
  assert.equal(messageChannel(records[1]), 'both');
  const view = mailboxView(records);
  assert.deepEqual(view.needsYou.map((item) => item.id), ['m-approve']);
  assert.equal(view.needsYou[0].channel, 'both');
  assert.deepEqual(view.updates.map((item) => item.id), [], 'an action reply is not an update');
  const open = mailboxCounts(records);
  assert.deepEqual({ chatUnread: open.chatUnread, mailUnread: open.mailUnread, needsAction: open.needsAction }, { chatUnread: 2, mailUnread: 0, needsAction: 1 });

  const stamp = new Date(now - 1000).toISOString();
  const closed = records.map((record) => (record.id === 'm-approve' ? { ...record, closedAt: stamp, readAt: stamp } : record));
  const after = mailboxCounts(closed);
  assert.deepEqual({ chatUnread: after.chatUnread, needsAction: after.needsAction }, { chatUnread: 1, needsAction: 0 });
  assert.deepEqual(mailboxView(closed).done.map((item) => item.id), ['m-approve']);
});

test('the three top-bar counts ignore closed and read items', () => {
  const records = [
    { ...reply('alpha', 'Chat note.'), id: 'm-1', at: new Date(now - 5000).toISOString() },
    { ...reply('alpha', 'Read note.', { action: 'read', readAt: new Date(now - 4000).toISOString() }), id: 'm-2', at: new Date(now - 4000).toISOString() },
    { ...report('Handback', '# Handback', { readAt: new Date(now - 3000).toISOString() }), id: 'm-3', at: new Date(now - 3000).toISOString() },
    { ...report('Second handback', '# Second'), id: 'm-4', at: new Date(now - 2000).toISOString() },
    { ...owner('alpha', 'Continue.'), id: 'm-5', at: new Date(now - 1000).toISOString() },
  ];
  const counts = mailboxCounts(records);
  assert.deepEqual({ chatUnread: counts.chatUnread, mailUnread: counts.mailUnread, needsAction: counts.needsAction }, { chatUnread: 1, mailUnread: 1, needsAction: 0 });
  assert.deepEqual(mailboxCounts([]), { needsYou: 0, needsYouUnread: 0, updates: 0, unread: 0, open: 0, chatUnread: 0, mailUnread: 0, needsAction: 0 });
});

test('the Inbox folder holds every open mail item, newest first', () => {
  const records = [
    { ...reply('alpha', 'Please answer.', { action: 'answer' }), id: 'm-needs-old', at: new Date(now - 5000).toISOString() },
    { ...report('Status update', 'A status update.'), id: 'm-update', at: new Date(now - 4000).toISOString() },
    { ...reply('boss', 'Approve the plan.', { action: 'approve' }), id: 'm-needs-new', at: new Date(now - 3000).toISOString() },
    { ...report('Closed report', 'Finished.', { closedAt: new Date(now - 1000).toISOString() }), id: 'm-closed', at: new Date(now - 2000).toISOString() },
  ];
  const folders = mailboxFolders(records);
  assert.deepEqual(folders.inbox.map((item) => item.id), ['m-needs-new', 'm-update', 'm-needs-old']);
  assert.ok(folders.inbox.every((item) => !item.closedAt), 'a closed item is not in the Inbox');
});

test('the Mailbox UI accepts the Inbox folder and names Updates Reports and updates', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const folders = JSON.parse(/const MAIL_FOLDERS = (\[[^\]]*\]);/.exec(app)[1].replace(/'/g, '"'));
  assert.deepEqual(folders, ['needs-you', 'inbox', 'updates', 'done', 'sent']);
  const match = /function resolveMailboxFolder\(requested, remembered, needsYouCount\) \{([\s\S]*?)\n\}/.exec(app);
  const resolve = new Function('MAIL_FOLDERS', 'requested', 'remembered', 'needsYouCount', match[1]);
  assert.equal(resolve(folders, 'inbox', 'needs-you', 3), 'inbox');
  assert.equal(resolve(folders, null, 'inbox', 0), 'inbox');
  assert.match(app, /updates: 'Reports and updates'/);
  assert.match(app, /inbox: 'Inbox'/);
});

test('GET /api/mailbox?folder=inbox answers with the open items', { timeout: 20000 }, async (t) => {
  fs.rmSync(messages.messagesFile(), { force: true });
  const at = Date.parse('2026-09-28T10:00:00.000Z');
  const needs = appendMessage(reply('alpha', 'Which option?', { action: 'answer' }), { now: at });
  const update = appendMessage(report('Daily update', 'Nothing to decide.'), { now: at + 1000 });
  const { base } = await startServer(t);
  const response = await fetch(`${base}/api/mailbox?folder=inbox`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.folder, 'inbox');
  assert.deepEqual(body.items.map((item) => item.id), [update.id, needs.id]);
  assert.deepEqual(body.inbox.map((item) => item.id), [update.id, needs.id]);
});

test('reading an information item closes it, and the item leaves the Inbox for Done', (t) => {
  const dir = freshDir(t);
  const info = appendMessage(report('Night report', 'All green.'), { dir, now });
  const unread = appendMessage(report('Unread report', 'FYI.'), { dir, now: now + 1 });
  const decide = appendMessage(reply('alpha', 'Which?', { action: 'decide' }), { dir, now: now + 2 });
  const later = now + 60000;

  let folders = mailboxFolders(readMessages({ dir }));
  assert.deepEqual(folders.inbox.map((r) => r.id), [decide.id, unread.id, info.id], 'unread items are in the Inbox');

  assert.deepEqual(markMailboxRead({ ids: [info.id, decide.id] }, { dir, now: later }), { ok: true, updated: 2 });
  let records = readMessages({ dir });
  assert.equal(records.find((r) => r.id === info.id).closedAt, new Date(later).toISOString(), 'read sets closedAt with readAt');
  assert.equal(records.find((r) => r.id === decide.id).closedAt, undefined, 'a read decide item stays open');
  folders = mailboxFolders(records);
  assert.deepEqual(folders.inbox.map((r) => r.id), [decide.id, unread.id]);
  assert.deepEqual(folders.needsYou.map((r) => r.id), [decide.id]);
  assert.deepEqual(folders.updates.map((r) => r.id), [unread.id]);
  assert.deepEqual(folders.done.map((r) => r.id), [info.id]);
  assert.equal(folders.updatesUnread, 1);
  assert.deepEqual(mailboxCounts(records), { needsYou: 1, needsYouUnread: 0, updates: 1, unread: 0, open: 1, chatUnread: 0, mailUnread: 1, needsAction: 1 });

  markMailboxRead({ ids: [info.id] }, { dir, now: later + 5000 });
  assert.equal(readMessages({ dir }).find((r) => r.id === info.id).closedAt, new Date(later).toISOString(), 'a second read keeps closedAt');
});

test('a read mark keeps an existing closedAt of an information item', (t) => {
  const dir = freshDir(t);
  const closedAt = new Date(now + 1000).toISOString();
  const info = appendMessage(report('Night report', 'Done.', { closedAt }), { dir, now });
  markMailboxRead({ ids: [info.id] }, { dir, now: now + 9000 });
  const stored = readMessages({ dir }).find((r) => r.id === info.id);
  assert.equal(stored.closedAt, closedAt);
  assert.equal(stored.readAt, new Date(now + 9000).toISOString());
});

test('an old read information item without closedAt shows as Done', () => {
  const readAt = new Date(now).toISOString();
  const records = [
    { id: 'm-old', at: readAt, ...report('Night report', 'Old.', { readAt }) },
    { id: 'm-new', at: readAt, ...report('Unread report', 'Unread.') },
    { id: 'm-ask', at: readAt, ...reply('alpha', 'Which?', { action: 'decide', readAt }) },
  ];
  const view = mailboxView(records);
  assert.deepEqual(view.done.map((r) => r.id), ['m-old']);
  assert.equal(view.done[0].closedAt, readAt, 'the view sets closedAt to readAt');
  assert.deepEqual(view.updates.map((r) => r.id), ['m-new']);
  assert.deepEqual(view.needsYou.map((r) => r.id), ['m-ask']);
  assert.deepEqual(mailboxFolders(records).inbox.map((r) => r.id).sort(), ['m-ask', 'm-new']);
  assert.equal(mailboxCounts(records).updates, 1);
});
