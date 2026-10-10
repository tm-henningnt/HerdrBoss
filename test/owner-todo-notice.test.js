import './helpers/test-env.js';
import { sharedDataDir } from './helpers/isolated-test-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMessageStore } from '../src/message-store.js';
import { deliverQueued } from '../src/messages.js';
import { postTodo, actOnTodo, todoOwnerActionRecorded } from '../src/owner-todo.js';

const now = Date.now();
const pane = { id: 'wA:p1', workspace: 'wA', label: 'orch', agent: 'codex', status: 'idle' };
const env = { HERDR_ENV: '1', HERDR_PANE_ID: pane.id, HERDR_WORKSPACE_ID: pane.workspace };
const text = `## Title
Check the preview
## Why
This body must stay out of the notice.
## Steps
Open https://example.test/preview.
## Expected result
Clear labels.
## How to answer
Select Done.
## What it blocks
Release.
## Type
decide
`;

test('engine notices use an isolated message store instead of the runner shared store', async () => {
  const { DATA_DIR } = await import('../src/config.js');
  assert.notEqual(DATA_DIR, sharedDataDir);
});

function fixture(t, backend = 'json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-notice-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: { messages: backend } }));
  const store = openMessageStore({ dir, backend });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const context = { dir, store, now, env, herdr: () => pane, control: { projects: { alpha: { workspace: 'wA' } } } };
  return { ...context, item: postTodo(text, {}, context) };
}

for (const [action, fields, expected] of [
  ['done', {}, 'done'], ['blocked', { reason: 'Preview is down.' }, 'Preview is down.'],
  ['snooze', { until: new Date(now + 3600000).toISOString() }, new Date(now + 3600000).toISOString()],
  ['not-now', { reason: 'The work can wait.' }, 'The work can wait.'],
  ['answer', { decision: 'accept', reason: 'Use this plan.' }, 'accept'],
  ['answer', { decision: 'deny' }, 'deny'],
]) test(`Owner ${action} queues a brief notice to the poster through message delivery`, async (t) => {
  const context = fixture(t);
  actOnTodo({ id: context.item.id, action, ...fields }, context);
  assert.deepEqual(context.store.chats(), []);
  const sent = [];
  await deliverQueued({ dir: context.dir, panes: [pane], projects: {}, now, prompt: async (...args) => sent.push(args) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], pane.id);
  assert.ok(sent[0][1].includes('Check the preview'));
  assert.ok(sent[0][1].includes(action));
  assert.ok(sent[0][1].includes(expected));
  if (fields.reason) assert.ok(sent[0][1].includes(fields.reason));
  assert.ok(!sent[0][1].includes('This body must stay out'));
  assert.ok(!sent[0][1].includes('example.test'));
});

for (const backend of ['json', 'sqlite']) test(`${backend}: replay of a saved action never queues or sends a second notice`, async (t) => {
  const context = fixture(t, backend);
  let event;
  actOnTodo({ id: context.item.id, action: 'blocked', reason: 'Wait for access.' }, { ...context, onAction: (saved) => { event = saved; } });
  todoOwnerActionRecorded(event, context);
  todoOwnerActionRecorded(event, context);
  assert.equal(context.store.all().filter((record) => record.kind === 'todo-notice').length, 1);
  let sent = 0;
  const delivery = { dir: context.dir, panes: [pane], prompt: async () => { sent += 1; }, now };
  await deliverQueued(delivery);
  todoOwnerActionRecorded(event, context);
  await deliverQueued(delivery);
  assert.equal(sent, 1);
});

test('a missing poster stays pending, uses its own pane when it returns, and retries a failed prompt once', async (t) => {
  const context = fixture(t);
  actOnTodo({ id: context.item.id, action: 'done' }, context);
  let calls = 0;
  const delivery = { dir: context.dir, now, projects: { alpha: { orch: { pane: 'wA:p2' } } }, prompt: async () => { calls += 1; throw new Error('unavailable'); } };
  await deliverQueued({ ...delivery, panes: [{ ...pane, id: 'wA:p2' }] });
  assert.equal(calls, 0);
  const pending = context.store.all().find((record) => record.kind === 'todo-notice');
  assert.equal(pending.status, 'queued');
  await deliverQueued({ ...delivery, panes: [pane] });
  await deliverQueued({ ...delivery, panes: [] });
  await deliverQueued({ ...delivery, panes: [pane] });
  await deliverQueued({ ...delivery, panes: [pane] });
  assert.equal(calls, 2);
  assert.equal(context.store.all().find((record) => record.id === pending.id).attempts, 2);
});

test('a saved notice never sends a secret from a legacy title or Owner reason', async (t) => {
  const context = fixture(t);
  const privateText = 'password=' + 'invented'.repeat(4);
  const privateMarker = '-----BEGIN ' + 'PRIVATE KEY-----';
  context.store.update(context.item.id, { title: privateText + '\n' + privateMarker });
  let event;
  actOnTodo({ id: context.item.id, action: 'done' }, { ...context, onAction: (saved) => { event = saved; } });
  todoOwnerActionRecorded({ ...event, reason: privateText }, context);
  const sent = [];
  await deliverQueued({ dir: context.dir, panes: [pane], now, prompt: async (_pane, message) => sent.push(message) });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes(privateText));
  assert.ok(!sent[0].includes(privateMarker));
});

for (const backend of ['json', 'sqlite']) test(`${backend}: a pending notice survives retention and a pruned delivered notice is never replayed`, async (t) => {
  const context = fixture(t, backend);
  let event;
  const old = now - 40 * 86400000;
  actOnTodo({ id: context.item.id, action: 'blocked', reason: 'Wait for access.' }, { ...context, now: old, onAction: (saved) => { event = saved; } });
  todoOwnerActionRecorded(event, { ...context, now: old });
  assert.equal(context.store.all().filter((record) => record.kind === 'todo-notice').length, 1);
  let sent = 0;
  await deliverQueued({ dir: context.dir, panes: [pane], now, prompt: async () => { sent += 1; } });
  assert.equal(sent, 1);
  context.store.mutate((records) => ({ records: records.filter((record) => record.kind !== 'todo-notice'), result: null }), { now });
  todoOwnerActionRecorded(event, context);
  await deliverQueued({ dir: context.dir, panes: [pane], now, prompt: async () => { sent += 1; } });
  assert.equal(sent, 1);
});

test('notice delivery waits through a wrong workspace or busy pane and succeeds on the next tick', async (t) => {
  const context = fixture(t);
  actOnTodo({ id: context.item.id, action: 'done' }, context);
  let sent = 0;
  const delivery = { dir: context.dir, now, prompt: async () => { sent += 1; } };
  await deliverQueued({ ...delivery, panes: [{ ...pane, workspace: 'wC' }] });
  await deliverQueued({ ...delivery, panes: [{ ...pane, status: 'blocked' }] });
  await deliverQueued({ ...delivery, panes: [pane], busy: new Set([pane.id]) });
  assert.equal(sent, 0);
  await deliverQueued({ ...delivery, panes: [pane] });
  await deliverQueued({ ...delivery, panes: [pane] });
  assert.equal(sent, 1);
});

test('the engine Owner-message tick delivers a To do notice through its existing Herdr prompt path', async () => {
  const { DATA_DIR } = await import('../src/config.js');
  const { Engine } = await import('../src/engine.js');
  const store = openMessageStore({ dir: DATA_DIR });
  const context = { dir: DATA_DIR, store, env, now, herdr: () => pane, control: { projects: { alpha: { workspace: 'wA' } } } };
  const item = postTodo(text, {}, context);
  actOnTodo({ id: item.id, action: 'done' }, context);
  const calls = [];
  const engine = { memory: {}, log() {}, herdrRunner: async (...args) => { calls.push(args); return '{}'; } };
  await Engine.prototype.deliverOwnerMessages.call(engine, { panes: [pane] }, {}, now);
  await Engine.prototype.deliverOwnerMessages.call(engine, { panes: [pane] }, {}, now + 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'herdr');
  assert.deepEqual(calls[0][1].slice(0, 3), ['agent', 'prompt', pane.id]);
  assert.ok(calls[0][1][3].includes('Check the preview'));
  assert.ok(!calls[0][1][3].includes('This body must stay out'));
});

test('replaying a versioned blocked action in the same millisecond adds no second notice', (t) => {
  const context = fixture(t);
  const body = { id: context.item.id, action: 'blocked', reason: 'Wait for access.', updatedAt: context.item.updatedAt };
  actOnTodo(body, context);
  assert.throws(() => actOnTodo(body, context), (error) => error.status === 409);
  assert.equal(context.store.all().filter((record) => record.kind === 'todo-notice').length, 1);
});
