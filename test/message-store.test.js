import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-message-store-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-message-store-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;

const { openMessageStore, RETENTION_MS } = await import('../src/message-store.js');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(dataDir, 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function contractSuite(name, createStore) {
  test(`${name}: all returns kept records in time order`, (t) => {
    const dir = freshDir(t);
    const store = createStore({ dir });
    assert.deepEqual(Object.keys(store), ['all', 'append', 'update', 'mutate', 'thread', 'chats', 'version', 'onChange']);
    const now = Date.now();
    store.append({ thread: 'alpha', to: 'owner', text: 'Later.' }, { now: now + 20 });
    store.append({ thread: 'alpha', to: 'owner', text: 'Earlier.' }, { now: now + 10 });
    store.append({ thread: 'alpha', to: 'owner', text: 'Expired.' }, { now: now - RETENTION_MS - 1 });

    const kept = store.append({ thread: 'alpha', to: 'owner', text: 'Current.' }, { now: now + 30 });
    assert.deepEqual(store.all().map((record) => record.text), ['Earlier.', 'Later.', 'Current.']);
    assert.equal(store.all().at(-1).id, kept.id);
  });

  test(`${name}: version changes after an append and an update`, (t) => {
    const store = createStore({ dir: freshDir(t) });
    const initial = store.version();
    const record = store.append({ thread: 'alpha', text: 'First.' });
    const appended = store.version();
    assert.notEqual(appended, initial);
    store.update(record.id, { text: 'Updated.' });
    assert.notEqual(store.version(), appended);
  });

  test(`${name}: mutate keeps a concurrent process append`, async (t) => {
    const dir = freshDir(t);
    const store = createStore({ dir });
    const now = Date.now();
    const first = store.append({ thread: 'alpha', to: 'owner', text: 'Before.' }, { now });
    const marker = path.join(dir, 'writer-started');
    const entry = pathToFileURL(path.join(repo, 'src/message-store.js')).href;
    const childSource = `
      import fs from 'node:fs';
      import { openMessageStore } from ${JSON.stringify(entry)};
      const [dir, marker, timestamp] = process.argv.slice(1);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker)) {
        if (Date.now() > deadline) process.exit(2);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      fs.writeFileSync(marker + '.attempting', '');
      openMessageStore({ dir }).append({ thread: 'alpha', to: 'owner', text: 'Concurrent.' }, { now: Number(timestamp) });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, dir, marker, String(now + 2)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const childExit = once(child, 'exit');
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const result = store.mutate((records) => {
      fs.writeFileSync(marker, 'go');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(`${marker}.attempting`)) {
        if (Date.now() > deadline) throw new Error('the second writer did not start');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      let checksum = 0;
      for (let index = 0; index < 500_000; index += 1) checksum += index;
      records.find((record) => record.id === first.id).status = `changed-${checksum > 0}`;
      return { records, result: 'mutated' };
    }, { now: now + 1 });

    assert.equal(result, 'mutated');
    const [exitCode] = await childExit;
    assert.equal(exitCode, 0, stderr);
    const records = store.all();
    assert.equal(records.find((record) => record.id === first.id).status, 'changed-true');
    assert.deepEqual(records.map((record) => record.text), ['Before.', 'Concurrent.']);
  });

  test(`${name}: thread applies the limit and before cursor`, (t) => {
    const store = createStore({ dir: freshDir(t) });
    const now = Date.now();
    const records = [];
    for (let index = 0; index < 6; index += 1) {
      records.push(store.append({ thread: index === 5 ? 'beta' : 'alpha', text: `Message ${index}.` }, { now: now + index }));
    }

    assert.deepEqual(store.thread('alpha', { limit: 2 }).map((record) => record.text), ['Message 3.', 'Message 4.']);
    assert.deepEqual(store.thread('alpha', { limit: 2, before: records[4].id }).map((record) => record.text), ['Message 2.', 'Message 3.']);
    assert.deepEqual(store.thread('alpha', { before: records[0].id }), []);
  });

  test(`${name}: chats counts unread Owner records`, (t) => {
    const store = createStore({ dir: freshDir(t) });
    const now = Date.now();
    store.append({ thread: 'alpha', to: 'owner', text: 'Unread one.' }, { now });
    store.append({ thread: 'alpha', to: 'owner', text: 'Read.', readAt: new Date(now + 1).toISOString() }, { now: now + 1 });
    store.append({ thread: 'alpha', to: 'orch', text: 'Not for Owner.' }, { now: now + 2 });
    const last = store.append({ thread: 'alpha', to: 'owner', text: 'Unread two.' }, { now: now + 3 });
    store.append({ thread: 'boss', to: 'owner', text: 'Boss unread.' }, { now: now + 4 });

    const chats = store.chats();
    assert.deepEqual(chats.map(({ thread }) => thread), ['boss', 'alpha']);
    assert.deepEqual(chats.map(({ thread, count, unreadForOwner }) => ({ thread, count, unreadForOwner })), [
      { thread: 'boss', count: 1, unreadForOwner: 1 },
      { thread: 'alpha', count: 4, unreadForOwner: 2 },
    ]);
    assert.equal(chats.find((chat) => chat.thread === 'alpha').last.id, last.id);
    assert.deepEqual(Object.keys(chats[0]), ['thread', 'last', 'count', 'unreadForOwner']);
  });

  test(`${name}: onChange reports append and update events`, (t) => {
    const dir = freshDir(t);
    const store = createStore({ dir });
    const writer = createStore({ dir });
    const events = [];
    const unsubscribe = store.onChange((event) => events.push(event));
    const added = writer.append({ thread: 'alpha', text: 'First.' });
    const updated = writer.update(added.id, { text: 'Updated.' });
    assert.equal(writer.update('missing', { text: 'No record.' }), null);
    unsubscribe();
    writer.append({ thread: 'alpha', text: 'After unsubscribe.' });

    assert.deepEqual(events.map(({ type }) => type), ['append', 'update']);
    assert.equal(events[0].record.id, added.id);
    assert.equal(events[1].record.text, updated.text);
    assert.deepEqual(Object.keys(events[0]), ['type', 'record']);
  });
}

contractSuite('JSON message store', ({ dir }) => openMessageStore({ dir, backend: 'json' }));
