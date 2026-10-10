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
  assert.equal((await post('/api/todo/post', { text, caller }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await post('/api/todo/action', { id: 'missing', action: 'done' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const preview = await start(t, { readOnlyPreview: true });
  assert.equal((await preview.post('/api/todo/post', { text, caller })).status, 403);
  assert.equal((await preview.post('/api/todo/action', { id: 'missing', action: 'done' })).status, 403);
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
