import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMessageStore } from '../src/message-store.js';
import { mailboxCounts, mailboxFolders, chatRecords } from '../src/messages.js';

const todo = await import('../src/owner-todo.js');
const now = Date.now();
const caller = { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' };
const herdr = () => ({ id: 'wA:p1', workspace: 'wA', label: 'orch' });
const control = { projects: { alpha: { slug: 'alpha', workspace: 'wA' } } };
const fileText = (title = 'Check the preview', type = 'check') => `## Title
${title}
## Why
The preview needs an Owner check.
## Steps
- Open https://example.test/preview.
- Check the labels.
## Expected result
The labels are clear.
## How to answer
Select Done or Blocked with a reason.
## What it blocks
The next release.
## Type
${type}
`;
function fixture(t, backend = 'json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-todo-'));
  const store = openMessageStore({ dir, backend });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, env: caller, herdr, control, now };
}

test('an orchestrator posts a caller-scoped To do item in the Mailbox store', (t) => {
  const context = fixture(t);
  const item = todo.postTodo(fileText(), {}, context);
  assert.equal(item.project, 'alpha');
  assert.equal(item.thread, 'alpha');
  assert.equal(item.kind, 'todo');
  assert.equal(item.state, 'open');
  assert.equal(item.title, 'Check the preview');
  assert.equal(item.type, 'check');
  assert.equal(item.poster.pane, caller.HERDR_PANE_ID);
  assert.equal(context.store.all()[0].id, item.id);
});

for (const backend of ['json', 'sqlite']) test(`${backend}: an open duplicate updates the same item and keeps its original age`, (t) => {
  const context = fixture(t, backend);
  const original = todo.postTodo(fileText(), {}, context);
  const changed = todo.postTodo(fileText('  CHECK   the preview  '), { priority: 'high', blocks: 'The design check.' }, { ...context, now: now + 1000 });
  assert.equal(changed.id, original.id);
  assert.equal(changed.createdAt, original.createdAt);
  assert.equal(changed.priority, 'high');
  assert.equal(changed.blocks, 'The design check.');
  assert.equal(context.store.all().length, 1);
});

test('each project accepts ten posts per minute, including duplicate updates', (t) => {
  const context = fixture(t);
  for (let i = 0; i < 10; i += 1) todo.postTodo(fileText(), {}, { ...context, now: now + i });
  assert.throws(() => todo.postTodo(fileText('Another check'), {}, { ...context, now: now + 20 }), (error) => error.status === 429);
  const bossEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB' };
  const bossHerdr = () => ({ id: 'wB:p1', workspace: 'wB', label: 'boss' });
  assert.equal(todo.postTodo(fileText(), {}, { ...context, env: bossEnv, herdr: bossHerdr }).project, 'boss');
  assert.doesNotThrow(() => todo.postTodo(fileText(), {}, { ...context, now: now + 60001 }));
});

test('a file cannot choose the caller project and a worker cannot post', (t) => {
  const context = fixture(t);
  assert.throws(() => todo.postTodo(`${fileText()}\n## Project\nbeta\n`, {}, context), /heading|project/i);
  assert.throws(() => todo.postTodo(fileText(), {}, { ...context, herdr: () => ({ id: 'wA:p1', workspace: 'wA', label: 'worker' }) }), /boss.*orch/i);
  assert.throws(() => todo.postTodo(fileText(), {}, { ...context, control: { projects: {} } }), /workspace/i);
  assert.throws(() => todo.postTodo(fileText(), {}, { ...context, herdr: () => ({ id: 'wA:p2', workspace: 'wA', label: 'orch' }) }), /pane ID/i);
  assert.equal(context.store.all().length, 0);
});

test('posting refuses incomplete fields, unknown types, secrets and non-placeholder hosts without storing them', (t) => {
  const context = fixture(t);
  const refused = [
    fileText().replace('## Why', '## Reason'), fileText('Title', 'answer'),
    `${fileText()}\n## Title\nDuplicate`, `${fileText()}\n## Unused\nUnexpected`,
    fileText().replace('example.test', 'sample-host.invalid.net'),
    `${fileText()}\nhttps://private.invalid.org/check`, `${fileText()}\nprivate.invalid.org`,
    `${fileText()}\npassword=${'invented'.repeat(4)}`,
    `${fileText()}\n${'-----BEGIN ' + 'PRIVATE KEY-----'}`,
    `${fileText()}\n${'Bearer ' + 'invented'.repeat(4)}`,
    fileText().replace('example.test', '127.0.0.1'),
    fileText().replace('https://example.test', 'https://person:invented@example.test'),
    fileText().replace('https://example.test', '//sample-host.invalid.net'),
    `${fileText()}\nHost: localhost`,
  ];
  for (const text of refused) {
    assert.throws(() => todo.postTodo(text, {}, context), /incomplete|heading|Type|secret|host|credential/i);
  }
  assert.throws(() => todo.postTodo(fileText(), { blocks: 'token=' + 'invented'.repeat(4) }, context), /secret/i);
  assert.throws(() => todo.postTodo(fileText(), { priority: 'critical' }, context), /Priority/);
  assert.equal(context.store.all().length, 0);
});

test('a grant names a permission and never supplies a value', (t) => {
  const context = fixture(t);
  const item = todo.postTodo(fileText('Grant preview access', 'grant'), {}, context);
  assert.equal(item.type, 'grant');
  assert.throws(() => todo.postTodo(`${fileText('Grant preview access', 'grant')}\npassword: invented`, {}, context), /secret/);
});

test('the same title has independent keys in two projects and a closed item is never overwritten', (t) => {
  const context = fixture(t);
  const alpha = todo.postTodo(fileText(), {}, context);
  const beta = todo.postTodo(fileText(), {}, {
    ...context, env: { ...caller, HERDR_WORKSPACE_ID: 'wC', HERDR_PANE_ID: 'wC:p1' },
    herdr: () => ({ id: 'wC:p1', workspace: 'wC', label: 'orch' }), control: { projects: { beta: { workspace: 'wC' } } },
  });
  assert.notEqual(beta.key, alpha.key);
  assert.notEqual(beta.id, alpha.id);
  todo.actOnTodo({ id: alpha.id, action: 'done' }, context);
  const next = todo.postTodo(fileText(), {}, { ...context, now: now + 1000 });
  assert.notEqual(next.id, alpha.id);
  assert.equal(context.store.all().find((item) => item.id === alpha.id).state, 'done');
  assert.equal(mailboxCounts(context.store.all()).todoOpen, 2);
});

test('the To do badge and list show only open items, ordered by priority then age', (t) => {
  const context = fixture(t);
  const normal = todo.postTodo(fileText('Normal'), {}, context);
  const highOld = todo.postTodo(fileText('High old'), { priority: 'high' }, { ...context, now: now + 1000 });
  const highNew = todo.postTodo(fileText('High new'), { priority: 'high' }, { ...context, now: now + 2000 });
  const urgent = todo.postTodo(fileText('Urgent'), { priority: 'urgent' }, { ...context, now: now + 3000 });
  context.store.update(normal.id, { state: 'blocked' });
  const records = context.store.all();
  assert.equal(mailboxCounts(records).todoOpen, 3);
  assert.equal(mailboxCounts(records).chatUnread, 0);
  assert.deepEqual(context.store.chats(), []);
  assert.deepEqual(mailboxFolders(records).todo.map((item) => item.id), [urgent.id, highOld.id, highNew.id]);
  assert.equal(mailboxFolders(records).needsYou.length, 0);
  assert.deepEqual(chatRecords(records), []);
});

for (const [action, fields, state] of [
  ['done', {}, 'done'], ['blocked', { reason: 'The preview is unavailable.' }, 'blocked'],
  ['snooze', { until: new Date(now + 3600000).toISOString() }, 'snoozed'],
  ['not-now', { reason: 'The work can wait.' }, 'cancelled'],
  ['answer', { decision: 'accept', reason: 'Use this plan.' }, 'done'],
  ['answer', { decision: 'deny' }, 'done'],
]) test(`the Owner action ${action}${fields.decision ? ` ${fields.decision}` : ''} persists before the notice seam runs`, (t) => {
  const context = fixture(t);
  const item = todo.postTodo(fileText('Choose a preview', 'decide'), {}, context);
  let notice;
  const result = todo.actOnTodo({ id: item.id, action, ...fields }, { ...context, now: now + 1000, onAction: (event) => {
    assert.equal(context.store.all()[0].state, state);
    notice = event;
  } });
  assert.equal(result.item.state, state);
  assert.equal(notice.action, action);
  const saved = context.store.all()[0];
  assert.equal(saved.ownerActions[0].reason, fields.reason ?? '');
  assert.equal(saved.ownerActions[0].decision, fields.decision ?? null);
  assert.equal(saved.ownerActions[0].at, new Date(now + 1000).toISOString());
  assert.equal(mailboxCounts(context.store.all()).todoOpen, 0);
});

test('Owner actions validate reasons, decisions, future snooze time and item state', (t) => {
  const context = fixture(t);
  const item = todo.postTodo(fileText(), {}, context);
  for (const fields of [
    { action: 'blocked' }, { action: 'not-now' }, { action: 'snooze', until: 'tomorrow' },
    { action: 'snooze', until: new Date(now - 1).toISOString() }, { action: 'answer', decision: 'accept' },
    { action: 'answer', decision: 'maybe' }, { action: 'unknown' }, { action: 'done', reason: 'password=madeup' },
  ]) assert.throws(() => todo.actOnTodo({ id: item.id, ...fields }, context), (error) => error.status === 400);
  assert.throws(() => todo.actOnTodo({ id: 'missing', action: 'done' }, context), (error) => error.status === 404);
  assert.throws(() => todo.actOnTodo({ id: item.id, action: 'done', updatedAt: 'stale' }, context), (error) => error.status === 409);
  assert.equal(context.store.all()[0].ownerActions.length, 0);
  todo.actOnTodo({ id: item.id, action: 'done' }, context);
  assert.throws(() => todo.actOnTodo({ id: item.id, action: 'blocked', reason: 'Wait.' }, context), (error) => error.status === 409);
});

test('snoozed items wake at the chosen time and a blocked item can be reopened', (t) => {
  const context = fixture(t);
  const item = todo.postTodo(fileText(), {}, context);
  todo.actOnTodo({ id: item.id, action: 'snooze', until: new Date(now + 10000).toISOString() }, context);
  assert.equal(todo.todoView(context.store.all(), now + 9999).todo.length, 0);
  assert.equal(todo.todoView(context.store.all(), now + 10000).todo[0].state, 'open');
  todo.actOnTodo({ id: item.id, action: 'blocked', reason: 'Check later.' }, { ...context, now: now + 10000 });
  todo.actOnTodo({ id: item.id, action: 'reopen' }, { ...context, now: now + 11000 });
  assert.equal(context.store.all()[0].state, 'open');
});

for (const backend of ['json', 'sqlite']) test(`${backend}: unresolved To do items survive retention and terminal items use the closure time`, (t) => {
  const context = fixture(t, backend);
  const old = now - 40 * 86400000;
  const item = todo.postTodo(fileText(), {}, { ...context, now: old });
  assert.equal(context.store.all().length, 1);
  todo.actOnTodo({ id: item.id, action: 'done' }, context);
  assert.equal(context.store.all().length, 1);
});
