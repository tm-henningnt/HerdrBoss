import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
process.env.HERDR_BOSS_LIVE_DIR = path.join(process.env.HERDR_BOSS_DIR, 'separate-live');
const { serve } = await import('../src/server.js');
const { loadConfig, DATA_DIR } = await import('../src/config.js');
const { readMessages } = await import('../src/messages.js');

const text = `## Title
Check the preview
## Why
Check the page before release.
## Steps
Open https://example.test/preview.
## Expected result
The page is clear.
## How to answer
Select Done.
## What it blocks
Release.
## Type
check
`;
const caller = { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' };
async function start(t, options = {}) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1'; cfg.port = 0; cfg.tickSeconds = 3600;
  const paneCalls = [];
  const { server, close } = serve(cfg, {
    liveDataDir: DATA_DIR,
    todoHerdr: (args) => { paneCalls.push(args); return { id: 'wA:p1', workspace: 'wA', label: 'orch' }; },
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { workspace: 'wA', slug: 'alpha' } } }, herdr: { panes: [] } };
      engine.tick = async () => engine.state; engine.log = () => {};
      return engine;
    }, ...options,
  });
  t.after(close);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, paneCalls, port: server.address().port };
}

test('the service verifies the posting pane, scopes the project, lists To do and saves an Owner action', async (t) => {
  const { base, post, paneCalls } = await start(t);
  const response = await post('/api/todo/post', { text, caller, priority: 'high' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.item.project, 'alpha');
  assert.deepEqual(paneCalls[0], ['pane', 'get', 'wA:p1']);
  assert.equal((await post('/api/todo/post', { text, caller, project: 'beta' })).status, 400);
  const list = await (await fetch(`${base}/api/mailbox?folder=todo`)).json();
  assert.equal(list.items[0].id, result.item.id);
  assert.equal(list.mailbox.todoOpen, 1);
  const answer = await post('/api/todo/action', { id: result.item.id, action: 'blocked', reason: 'Preview is unavailable.' });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).mailbox.todoOpen, 0);
  assert.equal(readMessages().find((item) => item.id === result.item.id).state, 'blocked');
  const after = await (await fetch(`${base}/api/mailbox?folder=todo`)).json();
  assert.equal(after.todoHistory[0].state, 'blocked');
});

test('To do routes keep the existing access and read-only-preview guards', async (t) => {
  const { post } = await start(t);
  assert.equal((await post('/api/todo/post', { text })).status, 403);
  assert.equal((await post('/api/todo/cancel', { key: 'alpha:missing' })).status, 403);
  assert.equal((await post('/api/todo/migrate', {})).status, 403);
  assert.equal((await post('/api/todo/post', { text, caller }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await post('/api/todo/action', { id: 'missing', action: 'done' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const preview = await start(t, { readOnlyPreview: true });
  assert.equal((await preview.post('/api/todo/post', { text, caller })).status, 403);
  assert.equal((await preview.post('/api/todo/action', { id: 'missing', action: 'done' })).status, 403);
  assert.equal((await preview.post('/api/todo/cancel', { key: 'alpha:missing', caller })).status, 403);
  assert.equal((await preview.post('/api/todo/migrate', { caller })).status, 403);
});

test('the real todo post CLI reads a file and sends it to the service with caller metadata', async (t) => {
  const { port } = await start(t);
  const file = path.join(DATA_DIR, 'ask.md');
  fs.writeFileSync(file, text.replace('Check the preview', 'Check the CLI preview'));
  const run = promisify(execFile);
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const result = await run(process.execPath, [cli, 'todo', 'post', file, '--priority', 'urgent', '--blocks', 'CLI release.'], {
    env: { ...process.env, ...caller, HERDR_BOSS_PORT: String(port) }, timeout: 15000,
  });
  assert.match(result.stdout, /To do item.*posted/);
  const item = readMessages().find((record) => record.title === 'Check the CLI preview');
  assert.ok(result.stdout.includes(item.key), 'posting prints the key needed for cancellation');
  assert.equal(item.priority, 'urgent');
  assert.equal(item.blocks, 'CLI release.');
  await assert.rejects(run(process.execPath, [cli, 'todo', 'post', file, '--project', 'beta'], { env: process.env, timeout: 15000 }), /Unknown option/);
});

test('the service applies secret refusal and the project rate limit to duplicate HTTP posts', async (t) => {
  const { post } = await start(t);
  const refused = await post('/api/todo/post', { text: `${text}\npassword=${'invented'.repeat(4)}`, caller });
  assert.equal(refused.status, 400);
  assert.doesNotMatch((await refused.json()).error, /invented/);
  // Use a separate project to give this test its own rate window.
  const other = await start(t, {
    todoHerdr: () => ({ id: 'wA:p1', workspace: 'wA', label: 'boss' }),
  });
  let id;
  for (let index = 0; index < 10; index += 1) {
    const response = await other.post('/api/todo/post', { text, caller });
    assert.equal(response.status, 200);
    const current = (await response.json()).item.id;
    if (id) assert.equal(current, id);
    id = current;
  }
  assert.equal((await other.post('/api/todo/post', { text, caller })).status, 429);
});

test('todo cancel uses the service caller check and the real CLI, and refuses a foreign project', async (t) => {
  const { post, port, paneCalls } = await start(t);
  const posted = await post('/api/todo/post', { text: text.replace('Check the preview', 'Cancel the preview'), caller });
  const { item } = await posted.json();
  const foreign = await start(t, { todoHerdr: () => ({ id: 'wC:p1', workspace: 'wC', label: 'orch' }),
    createEngine: () => { const engine = new EventEmitter(); engine.state = { control: { projects: { beta: { workspace: 'wC' } } }, herdr: { panes: [] } }; engine.tick = async () => engine.state; engine.log = () => {}; return engine; } });
  assert.equal((await foreign.post('/api/todo/cancel', { key: item.key, note: 'No longer needed.', caller: { ...caller, HERDR_PANE_ID: 'wC:p1', HERDR_WORKSPACE_ID: 'wC' } })).status, 403);
  const run = promisify(execFile);
  const result = await run(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'todo', 'cancel', item.key, '--note', 'The preview was replaced.'], {
    env: { ...process.env, ...caller, HERDR_BOSS_PORT: String(port) }, timeout: 15000,
  });
  assert.match(result.stdout, /cancelled/);
  assert.deepEqual(paneCalls.at(-1), ['pane', 'get', 'wA:p1']);
  const saved = readMessages().find((record) => record.id === item.id);
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.cancelNote, 'The preview was replaced.');
});

test('an Owner reply to a To do item saves an answer and one notice on client replay', async (t) => {
  const { post } = await start(t);
  const { item } = await (await post('/api/todo/post', { text: text.replace('Check the preview', 'Answer the preview'), caller })).json();
  const body = { thread: 'alpha', kind: 'message', replyTo: item.id, text: 'The labels are clear.', clientId: 'todo-answer-preview' };
  assert.equal((await post('/api/messages', { ...body, thread: 'boss' })).status, 404);
  const refused = await post('/api/messages', { ...body, text: 'password=' + 'invented'.repeat(4) });
  assert.equal(refused.status, 400);
  assert.ok(!(await refused.json()).error.includes('invented'));
  assert.equal(readMessages().find((record) => record.id === item.id).state, 'open');
  const response = await post('/api/messages', body);
  assert.equal(response.status, 200);
  const first = await response.json();
  const replay = await post('/api/messages', body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).message.id, first.message.id);
  const saved = readMessages().find((record) => record.id === item.id);
  assert.equal(saved.state, 'done');
  assert.equal(saved.ownerActions.at(-1).answer, 'The labels are clear.');
  const notices = readMessages().filter((record) => record.kind === 'todo-notice' && record.replyTo === item.id);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes('The labels are clear.'));
  assert.equal((await post('/api/messages', { ...body, clientId: 'second-todo-answer' })).status, 409);
});

test('the Owner say --reply-to CLI answers a To do item through the same service reply path', async (t) => {
  const { post, port } = await start(t);
  const { item } = await (await post('/api/todo/post', { text: text.replace('Check the preview', 'Answer the CLI preview'), caller })).json();
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'say', '--reply-to', item.id, 'An agent must not answer for the Owner.'], {
    env: { ...process.env, ...caller, HERDR_BOSS_PORT: String(port) }, timeout: 15000,
  }), /Only the Owner/);
  const result = await promisify(execFile)(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'say', '--reply-to', item.id, 'The phone labels are clear.'], {
    env: { ...process.env, HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_BOSS_PORT: String(port) }, timeout: 15000,
  });
  assert.match(result.stdout, /answer/);
  assert.equal(readMessages().find((record) => record.id === item.id).ownerActions.at(-1).answer, 'The phone labels are clear.');
});

test('the Boss todo migrate CLI imports a waiting Mailbox item once and prints the count', async (t) => {
  const { appendMessage } = await import('../src/messages.js');
  appendMessage({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', action: 'answer', text: 'Check the imported preview\nPlease check the labels.' });
  const { port } = await start(t, { todoHerdr: () => ({ id: 'wA:p1', workspace: 'wA', label: 'boss' }) });
  const run = promisify(execFile);
  const args = [new URL('../src/cli.js', import.meta.url).pathname, 'todo', 'migrate'];
  const options = { env: { ...process.env, ...caller, HERDR_BOSS_PORT: String(port) }, timeout: 15000 };
  assert.match((await run(process.execPath, args, options)).stdout, /Imported 1/);
  assert.match((await run(process.execPath, args, options)).stdout, /Imported 0/);
});
