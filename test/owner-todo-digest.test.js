import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as todo from '../src/owner-todo.js';
import { openMessageStore } from '../src/message-store.js';
import { mailboxCounts, mailboxView, chatRecords, mailboxTitle } from '../src/messages.js';
import { mailSubject } from '../public/mail-rows.js';

const MONDAY = Date.parse('2026-10-19T08:00:00Z');
const settings = { digestTime: '08:00', timeZone: 'UTC', notify: false };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-todo-digest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openMessageStore({ dir });
  store.append({ id: 'todo-alpha', kind: 'todo', to: 'owner', project: 'alpha', title: 'Choose the sample layout',
    priority: 'normal', state: 'open', createdAt: '2026-10-01T00:00:00Z' }, { now: MONDAY });
  return { dir, store };
}

test('the daily digest replaces its previous Mailbox record and cannot duplicate on the same day', (t) => {
  const deps = fixture(t);
  let now = MONDAY;
  const options = { ...deps, clock: () => now };
  const first = todo.postTodoDigest(settings, options);
  assert.equal(first.kind, 'digest');
  assert.match(first.text, /alpha: Choose the sample layout/);
  assert.equal(todo.postTodoDigest(settings, options), null);
  deps.store.update(first.id, { readAt: new Date(now).toISOString(), dismissed: true });
  assert.equal(todo.postTodoDigest({ ...settings, digestTime: '07:00' }, { ...options, store: openMessageStore({ dir: deps.dir }) }), null);
  now += 86400000;
  const next = todo.postTodoDigest(settings, options);
  assert.equal(next.id, first.id);
  assert.equal(next.digestDate, '2026-10-20');
  assert.equal(next.readAt, null);
  assert.equal(next.dismissed, false);
  assert.equal(deps.store.all().filter((item) => item.kind === 'digest').length, 1);
  now = MONDAY;
  assert.equal(todo.postTodoDigest(settings, options), null, 'a clock correction cannot post the same date again');
});

test('Monday includes only the five oldest open project and title pairs in the weekly summary', (t) => {
  const { store, dir } = fixture(t);
  for (let i = 2; i <= 7; i += 1) store.append({ id: `todo-${i}`, kind: 'todo', to: 'owner', project: 'beta', title: `Sample ${i}`,
    priority: i === 7 ? 'urgent' : 'normal', state: 'open', createdAt: `2026-10-0${i}T00:00:00Z`, text: 'Body must stay out.', blocks: 'Private block detail.' }, { now: MONDAY });
  store.append({ id: 'closed', kind: 'todo', to: 'owner', project: 'beta', title: 'Closed old item', priority: 'high', state: 'done', createdAt: '2026-01-01T00:00:00Z' }, { now: MONDAY });
  store.append({ id: 'snoozed', kind: 'todo', to: 'owner', project: 'beta', title: 'Future snooze', priority: 'urgent', state: 'snoozed', snoozedUntil: '2026-11-01T00:00:00Z' }, { now: MONDAY });
  const digest = todo.postTodoDigest(settings, { dir, store, clock: () => MONDAY });
  const weekly = digest.text.split('## Weekly: oldest open items\n')[1];
  assert.equal(weekly, '- alpha: Choose the sample layout\n- beta: Sample 2\n- beta: Sample 3\n- beta: Sample 4\n- beta: Sample 5');
  assert.doesNotMatch(digest.text, /Body must stay out|Private block detail|Closed old item|Future snooze/);
  assert.equal(digest.weeklyDate, '2026-10-19');
  const tuesday = todo.postTodoDigest(settings, { dir, store, clock: () => MONDAY + 86400000 });
  assert.doesNotMatch(tuesday.text, /Weekly/);
});

test('the injected clock follows the chosen time zone and both sides of daylight saving changes', (t) => {
  const { store, dir } = fixture(t);
  const oslo = { ...settings, timeZone: 'Europe/Oslo' };
  const run = (at, chosen = oslo) => todo.postTodoDigest(chosen, { dir, store, clock: () => Date.parse(at) });
  assert.equal(run('2026-10-20T05:59:00Z'), null);
  assert.equal(run('2026-10-20T06:00:00Z').digestDate, '2026-10-20');
  assert.equal(run('2026-10-26T06:59:00Z'), null);
  assert.equal(run('2026-10-26T07:00:00Z').digestDate, '2026-10-26');
  // UTC is still Sunday here. Monday and its weekly summary use the selected zone.
  const early = run('2026-11-01T23:30:00Z', { ...oslo, digestTime: '00:30' });
  assert.equal(early.digestDate, '2026-11-02');
  assert.equal(early.weeklyDate, '2026-11-02');
  // The local 02:30 hour occurs twice on this day. It must produce one digest.
  assert.ok(run('2026-10-25T00:30:00Z', { ...oslo, digestTime: '02:30' }));
  assert.equal(run('2026-10-25T01:30:00Z', { ...oslo, digestTime: '02:30' }), null);
});

test('local means the service time zone and an overdue first tick catches up once', (t) => {
  const deps = fixture(t);
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
  const local = { ...settings, timeZone: 'local' };
  const run = (at, chosen = local) => todo.postTodoDigest(chosen, { ...deps, clock: () => Date.parse(at) });
  assert.equal(run('2026-10-21T11:59:00Z'), null);
  assert.equal(run('2026-10-21T16:00:00Z').digestDate, '2026-10-21');
  assert.equal(run('2026-10-21T18:00:00Z'), null);
  assert.equal(run('2026-10-22T18:00:00Z', { ...local, digestTime: null }), null);
});

test('the digest is an unread Mailbox update with its title and stays out of Chat', (t) => {
  const { dir, store } = fixture(t);
  const digest = todo.postTodoDigest(settings, { dir, store, clock: () => MONDAY });
  const records = store.all();
  const view = mailboxView(records);
  assert.equal(view.updates.some((item) => item.id === digest.id), true);
  assert.equal(mailboxCounts(records).mailUnread, 1);
  assert.equal(chatRecords(records).some((item) => item.id === digest.id), false);
  assert.equal(mailboxTitle(digest), 'To do digest');
  assert.equal(mailSubject(digest), 'To do digest');
});
