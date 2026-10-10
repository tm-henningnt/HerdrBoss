import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { openMessageStore } from '../src/message-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-10-19T08:00:00Z');
function fixture(t, act = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-todo-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const previous = process.env.HERDR_BOSS_ALLOW_ACTIONS;
  process.env.HERDR_BOSS_ALLOW_ACTIONS = '1';
  const engine = new Engine(loadConfig(), { act, push: false, clock: () => NOW,
    notificationRunner: async (command, args) => { calls.push({ command, args }); return '{}'; } });
  if (previous === undefined) delete process.env.HERDR_BOSS_ALLOW_ACTIONS; else process.env.HERDR_BOSS_ALLOW_ACTIONS = previous;
  engine.messageStore = openMessageStore({ dir });
  return { engine, calls };
}
const policy = { ownerTodo: { digestTime: '08:00', timeZone: 'UTC', notify: true } };

test('the service saves one digest and sends its optional desktop notice through alert delivery', async (t) => {
  const { engine, calls } = fixture(t);
  const alerts = engine.ownerTodoDigestAlerts(policy, NOW);
  assert.equal(engine.messageStore.all().filter((item) => item.kind === 'digest').length, 1);
  await engine.deliver(alerts, { panes: [] }, NOW);
  await engine.deliver(engine.ownerTodoDigestAlerts(policy, NOW), { panes: [] }, NOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'herdr');
  assert.deepEqual(calls[0].args.slice(0, 2), ['notification', 'show']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--body') + 1], '0 open To do items. Open the Mailbox To do view.');
});

test('a preview creates no digest and quiet hours hold the optional notification', async (t) => {
  const preview = fixture(t, false);
  assert.deepEqual(preview.engine.ownerTodoDigestAlerts(policy, NOW), []);
  assert.equal(preview.engine.messageStore.all().length, 0);
  const live = fixture(t);
  const alerts = live.engine.ownerTodoDigestAlerts(policy, NOW);
  await live.engine.deliver(alerts, { panes: [] }, NOW, { active: true, quietHours: true });
  assert.equal(live.calls.length, 0);
  await live.engine.deliver([], { panes: [] }, NOW + 60000, { active: false });
  assert.equal(live.calls.length, 1);
});

test('notification off still delivers a digest to the Mailbox', (t) => {
  const { engine, calls } = fixture(t);
  assert.deepEqual(engine.ownerTodoDigestAlerts({ ownerTodo: { ...policy.ownerTodo, notify: false } }, NOW), []);
  assert.equal(engine.messageStore.all().filter((item) => item.kind === 'digest').length, 1);
  assert.equal(calls.length, 0);
});
