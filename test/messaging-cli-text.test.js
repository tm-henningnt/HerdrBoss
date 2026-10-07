import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repo, 'src', 'cli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-messaging-cli-text-'));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(t, label = 'orch') {
  const folder = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const home = path.join(folder, 'home');
  const data = path.join(folder, 'data');
  const bin = path.join(folder, 'bin');
  for (const dir of [home, data, bin]) fs.mkdirSync(dir, { recursive: true });
  const pane = label === 'boss' ? 'wB:p1' : 'wA:p1';
  const workspace = label === 'boss' ? 'wB' : 'wA';
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: ${JSON.stringify(workspace)}, label: ${JSON.stringify(label)} } } }));
else { console.error('unexpected herdr call'); process.exit(3); }
`);
  fs.chmodSync(path.join(bin, 'herdr'), 0o755);
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ control: { projects: { alpha: { slug: 'alpha', workspace: 'wA' } } } }));
  const env = {
    ...process.env,
    HOME: home,
    HERDR_BOSS_DIR: data,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HERDR_ENV: '1',
    HERDR_PANE_ID: pane,
    HERDR_WORKSPACE_ID: workspace,
  };
  delete env.NODE_TEST_CONTEXT;
  return { folder, data, env, label };
}

function run(fixtureData, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: fixtureData.folder, env: fixtureData.env, encoding: 'utf8' });
}

async function records(fixtureData) {
  const { openMessageStore } = await import('../src/message-store.js');
  return openMessageStore({ dir: fixtureData.data, backend: 'json' }).all();
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}

test('say names chat, a Mailbox action, and an answer destination', async (t) => {
  const fixtureData = fixture(t);

  const chat = run(fixtureData, 'say', 'Status update.');
  const chatRecord = (await records(fixtureData)).at(-1);
  assertOutput(chat, `Message ${chatRecord.id} sent in chat.`);

  const ask = run(fixtureData, 'say', '--action', 'decide', 'Choose a route.');
  const askRecord = (await records(fixtureData)).at(-1);
  assertOutput(ask, `Message ${askRecord.id} posted as a Mailbox item (decide).`);

  const read = run(fixtureData, 'say', '--action', 'read', 'Read this in Chat.');
  const readRecord = (await records(fixtureData)).at(-1);
  assertOutput(read, `Message ${readRecord.id} sent in chat.`);

  const answer = run(fixtureData, 'say', '--reply-to', askRecord.id, 'Use route A.');
  const answerRecord = (await records(fixtureData)).at(-1);
  assertOutput(answer, `Message ${answerRecord.id} sent as an answer to ${askRecord.id}.`);
});

test('mail post and mail close name the Mailbox', async (t) => {
  const fixtureData = fixture(t, 'boss');
  const reportFile = path.join(fixtureData.folder, 'report.md');
  fs.writeFileSync(reportFile, '# Morning handback\n\nEverything is ready.\n');

  const post = run(fixtureData, 'mail', 'post', '--to', 'owner', '--action', 'read', reportFile);
  const report = (await records(fixtureData)).at(-1);
  assertOutput(post, `Report ${report.id} posted as a Mailbox item (read).`);

  const ask = run(fixtureData, 'mail', 'post', '--to', 'owner', '--action', 'decide', reportFile);
  const askRecord = (await records(fixtureData)).at(-1);
  assertOutput(ask, `Report ${askRecord.id} posted as a Mailbox item (decide).`);

  const close = run(fixtureData, 'mail', 'close', askRecord.id, '--note', 'Answered in the meeting.');
  assertOutput(close, 'Closed 1 Mailbox item as answered through the Boss.');
});

test('messages relay names chat', async (t) => {
  const fixtureData = fixture(t, 'boss');
  const { openMessageStore } = await import('../src/message-store.js');
  const store = openMessageStore({ dir: fixtureData.data, backend: 'json' });
  const queued = store.append({ thread: 'alpha', from: 'owner', to: 'orch', kind: 'message', text: 'Please review.', status: 'queued' });

  const result = run(fixtureData, 'messages', 'relay', queued.id, '--by', 'boss');
  assertOutput(result, 'Relayed 1 queued chat message.');
});
