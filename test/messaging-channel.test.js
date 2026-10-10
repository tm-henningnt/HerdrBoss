import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-messaging-channel-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
fs.mkdirSync(home);
fs.mkdirSync(data);
process.env.HOME = home;
process.env.HERDR_BOSS_DIR = data;

const messages = await import('../src/messages.js');
const { openMessageStore } = await import('../src/message-store.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('needs-you items and replies inherit one conversation channel', (t) => {
  const dir = fs.mkdtempSync(path.join(data, 'records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openMessageStore({ dir, backend: 'json' });
  const report = store.append({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'report', action: 'decide', text: 'Choose a route.' });
  const answer = store.append({ thread: 'alpha', from: 'owner', to: 'orch', kind: 'message', replyTo: report.id, text: 'Use route A.' });
  const projectLeadReply = store.append({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', replyTo: report.id, text: 'The report has a decision.' });
  const chat = store.append({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Status update.' });
  const chatAnswer = store.append({ thread: 'alpha', from: 'owner', to: 'orch', kind: 'message', replyTo: chat.id, text: 'Thanks.' });
  const wrongThreadReply = store.append({ thread: 'beta', from: 'owner', to: 'orch', kind: 'message', replyTo: report.id, text: 'Wrong thread.' });
  const readReport = store.append({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'report', action: 'read', text: 'For your information.' });
  const records = store.all();
  const byId = messages.messagesById(records);

  assert.equal(messages.messageChannel(report, byId), 'both');
  assert.equal(messages.messageChannel(answer, byId), 'both');
  assert.equal(messages.messageChannel(projectLeadReply, byId), 'both');
  assert.equal(messages.isMailAnswer(answer, byId), true);
  assert.equal(messages.messageChannel(chat, byId), 'chat');
  assert.equal(messages.messageChannel(chatAnswer, byId), 'chat');
  assert.equal(messages.messageChannel(wrongThreadReply, byId), 'chat');
  assert.equal(messages.messageChannel(readReport, byId), 'mail');
});

test('To do replies and action notices stay on the mail channel and leave Chat unchanged', () => {
  const at = new Date().toISOString();
  const item = { id: 'm-todo', at, thread: 'alpha', kind: 'todo', to: 'owner', from: 'orch', state: 'open', priority: 'normal' };
  const answer = { id: 'm-answer', at, thread: 'alpha', kind: 'message', from: 'owner', to: 'orch', replyTo: item.id };
  const notice = { id: 'm-notice', at, thread: 'alpha', kind: 'todo-notice', from: 'owner', to: 'orch', replyTo: item.id };
  const records = [item, answer, notice];
  const byId = messages.messagesById(records);
  for (const record of records) assert.equal(messages.messageChannel(record, byId), 'mail');
  assert.equal(messages.isMailAnswer(answer, byId), true);
  assert.deepEqual(messages.chatRecords(records), []);
  assert.deepEqual(messages.chatSummaries(records), []);
});
