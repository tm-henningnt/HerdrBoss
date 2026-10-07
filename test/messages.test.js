import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-messages-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-messages-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;

const messages = await import('../src/messages.js');
const {
  appendMessage, updateMessage, readMessages, listThread, messagesFile, deliverQueued,
  sayMessage, postReport, ownerPromptText, messageChannel, MAX_DELIVERY_ATTEMPTS,
  chatSummaries, chatThreadPage, markMailboxRead, postReview, closeReviewItems, isMailboxItem, isMailRecord, isMailAnswer, messagesById, chatRecords, mailboxView, mailboxCounts,
  postToolPromotionFailure,
} = messages;

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
const now = Date.now();

test('tool promotion notices use a stage key and keep the read state of an open item', (t) => {
  const dir = freshDir(t);
  const item = postToolPromotionFailure('codex', '0.160.1', 'win1', {
    dir, now, stage: 'waiting-owner', waiting: true,
  });
  assert.equal(item.title, 'Update waits: codex 0.160.1');
  assert.equal(item.action, 'read');
  assert.equal(item.key, 'tools:promote:codex:0.160.1:waiting-owner');

  const readAt = new Date(now + 1000).toISOString();
  updateMessage(item.id, { readAt }, { dir, now: now + 1000 });
  const repeated = postToolPromotionFailure('codex', '0.160.1', 'win1', {
    dir, now: now + 2000, stage: 'waiting-owner', waiting: true,
  });
  const records = readMessages({ dir });
  assert.equal(repeated.id, item.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].readAt, readAt);
});

function owner(thread, text, extra = {}) {
  return { thread, from: 'owner', to: thread === 'boss' ? 'boss' : 'orch', kind: 'message', text, action: null, replyTo: null, status: 'queued', ...extra };
}

test('the store appends one line per record with mode 0600 and updates a record through a rename', (t) => {
  const dir = freshDir(t);
  const first = appendMessage(owner('boss', 'Hello Boss.'), { dir, now });
  const second = appendMessage(owner('alpha', 'Hello alpha.'), { dir, now: now + 1000 });
  const file = messagesFile(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, first.id);
  assert.notEqual(first.id, second.id);
  for (const key of ['id', 'at', 'thread', 'from', 'to', 'kind', 'text', 'action', 'replyTo', 'status', 'sentAt', 'error']) {
    assert.ok(key in first, `record has ${key}`);
  }
  assert.equal(first.at, new Date(now).toISOString());
  assert.equal(first.sentAt, null);

  const updated = updateMessage(first.id, { status: 'sent', sentAt: new Date(now + 5000).toISOString() }, { dir });
  assert.equal(updated.status, 'sent');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the rewrite keeps mode 0600');
  const records = readMessages({ dir });
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.id === first.id).status, 'sent');
  assert.equal(records.find((r) => r.id === second.id).status, 'queued');
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp')).length, 0, 'no temporary file stays');
  assert.equal(updateMessage('missing', { status: 'sent' }, { dir }), null);
});

test('a write deletes records older than 30 days', (t) => {
  const dir = freshDir(t);
  appendMessage(owner('boss', 'Old message.'), { dir, now: now - 31 * DAY });
  appendMessage(owner('boss', 'Recent message.'), { dir, now: now - 29 * DAY });
  const kept = appendMessage(owner('boss', 'New message.'), { dir, now });
  const records = readMessages({ dir });
  assert.deepEqual(records.map((r) => r.text), ['Recent message.', 'New message.']);
  assert.equal(records.at(-1).id, kept.id);
  appendMessage(owner('boss', 'Another.'), { dir, now: now + 40 * DAY });
  const later = readMessages({ dir });
  assert.deepEqual(later.map((r) => r.text), ['Another.'], 'an append also prunes');
  updateMessage(later[0].id, { status: 'sent' }, { dir, now: now + 80 * DAY });
  assert.deepEqual(readMessages({ dir }), [], 'an update also prunes');
});

test('a thread lists its records oldest first and keeps the newest 200', (t) => {
  const dir = freshDir(t);
  for (let i = 0; i < 205; i += 1) appendMessage(owner(i % 2 ? 'alpha' : 'boss', `Message ${i}.`), { dir, now: now + i });
  const boss = listThread('boss', { dir });
  assert.equal(boss.length, 103);
  assert.equal(boss.at(-1).text, 'Message 204.', 'the newest record is last');
  for (let i = 205; i < 420; i += 1) appendMessage(owner('boss', `Message ${i}.`), { dir, now: now + i });
  const limited = listThread('boss', { dir });
  assert.equal(limited.length, 200);
  assert.equal(limited.at(-1).text, 'Message 419.');
});

function panesFor(statuses) {
  return [
    { id: 'wB:p1', workspace: 'wB', label: 'boss', agent: 'claude', status: statuses.boss },
    { id: 'wA:p1', workspace: 'wA', label: 'orch', agent: 'codex', status: statuses.alpha },
    { id: 'wC:p1', workspace: 'wC', label: 'orch', agent: 'codex', status: statuses.beta },
    { id: 'wC:p2', workspace: 'wC', label: null, agent: 'claude', status: 'idle', name: 'worker-one' },
  ];
}
const projects = {
  alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } },
  beta: { slug: 'beta', workspace: 'wC', orch: { pane: 'wC:p1' } },
};

test('delivery sends to idle, done, and working boss and orch panes, one message per pane per tick', async (t) => {
  const dir = freshDir(t);
  const b1 = appendMessage(owner('boss', 'First for Boss.'), { dir, now });
  const b2 = appendMessage(owner('boss', 'Second for Boss.'), { dir, now: now + 1 });
  const a1 = appendMessage(owner('alpha', 'For alpha.'), { dir, now: now + 2 });
  const c1 = appendMessage(owner('beta', 'For beta.'), { dir, now: now + 3 });
  const prompts = [];
  const events = [];
  const prompt = async (pane, text) => { prompts.push({ pane, text }); };
  const log = (type, text, extra) => events.push({ type, text, ...extra });

  await deliverQueued({ panes: panesFor({ boss: 'idle', alpha: 'working', beta: 'blocked' }), projects, prompt, log, dir, now: now + 10 });
  assert.deepEqual(prompts, [
    { pane: 'wB:p1', text: ownerPromptText(b1) },
    { pane: 'wA:p1', text: ownerPromptText(a1) },
  ], 'the idle Boss and working orchestrator each get one message');
  assert.equal(ownerPromptText(b1), `[owner] First for Boss. (Reply with: herdr-boss say --reply-to ${b1.id} "<answer>")`);
  let records = readMessages({ dir });
  const status = (id) => records.find((r) => r.id === id);
  assert.equal(status(b1.id).status, 'sent');
  assert.equal(status(b1.id).sentAt, new Date(now + 10).toISOString());
  assert.equal(status(b2.id).status, 'queued', 'the second Boss message waits for a later tick');
  assert.equal(status(a1.id).status, 'sent', 'a working orchestrator gets a message');
  assert.equal(status(c1.id).status, 'queued', 'a blocked orchestrator gets no message');
  assert.equal(events.length, 2);
  assert.equal(events[0].id, b1.id);
  assert.equal(events[0].thread, 'boss');
  assert.equal(events[0].kind, 'message');
  assert.equal(events[1].id, a1.id);
  assert.equal(events[1].thread, 'alpha');
  assert.ok(!JSON.stringify(events).includes('First for Boss'), 'the event has no message text');

  prompts.length = 0;
  await deliverQueued({ panes: panesFor({ boss: 'done', alpha: 'done', beta: 'idle' }), projects, prompt, log, dir, now: now + 20 });
  assert.deepEqual(prompts.map((p) => p.pane).sort(), ['wB:p1', 'wC:p1']);
  assert.equal(prompts.find((p) => p.pane === 'wB:p1').text, ownerPromptText(b2));
  records = readMessages({ dir });
  assert.ok(records.every((r) => r.status === 'sent'));
});

test('delivery holds Owner messages for blocked, unknown, or missing target panes', async (t) => {
  const dir = freshDir(t);
  const boss = appendMessage(owner('boss', 'Boss is unknown.'), { dir, now });
  const alpha = appendMessage(owner('alpha', 'Alpha is blocked.'), { dir, now: now + 1 });
  const beta = appendMessage(owner('beta', 'Beta pane is missing.'), { dir, now: now + 2 });
  const panes = panesFor({ boss: 'unknown', alpha: 'blocked', beta: 'idle' }).filter((pane) => pane.id !== 'wC:p1');
  const prompts = [];
  await deliverQueued({ panes, projects, prompt: async (pane) => { prompts.push(pane); }, dir, now });
  assert.deepEqual(prompts, []);
  assert.deepEqual(readMessages({ dir }).map((record) => record.status), ['queued', 'queued', 'queued']);
  assert.deepEqual(readMessages({ dir }).map((record) => record.id), [boss.id, alpha.id, beta.id]);
});

test('delivery skips a pane without the exact label and a pane that got a notice in this tick', async (t) => {
  const dir = freshDir(t);
  appendMessage(owner('alpha', 'For alpha.'), { dir, now });
  appendMessage(owner('boss', 'For Boss.'), { dir, now });
  const prompts = [];
  const panes = panesFor({ boss: 'idle', alpha: 'idle', beta: 'idle' });
  panes[1].label = 'orch previous';
  await deliverQueued({ panes, projects, prompt: async (pane) => { prompts.push(pane); }, log: () => {}, dir, now, busy: new Set(['wB:p1']) });
  assert.deepEqual(prompts, []);
  assert.ok(readMessages({ dir }).every((r) => r.status === 'queued'));
});

test('a failed delivery retries up to 3 times, then stops, and the event and error carry no text', async (t) => {
  const dir = freshDir(t);
  const secretText = 'Private plan for alpha.';
  const record = appendMessage(owner('alpha', secretText), { dir, now });
  const events = [];
  let calls = 0;
  const prompt = async (pane, text) => {
    calls += 1;
    const error = new Error(`Command failed: herdr agent prompt ${pane} ${text}`);
    error.stderr = `error: pane ${pane} rejected input ${text}\nmore detail`;
    throw error;
  };
  const panes = panesFor({ boss: 'idle', alpha: 'idle', beta: 'idle' });
  for (let tick = 0; tick < MAX_DELIVERY_ATTEMPTS + 3; tick += 1) {
    await deliverQueued({ panes, projects, prompt, log: (type, text, extra) => events.push({ type, text, ...extra }), dir, now: now + tick * 30000 });
  }
  assert.equal(MAX_DELIVERY_ATTEMPTS, 4, 'one first attempt and 3 retries');
  assert.equal(calls, MAX_DELIVERY_ATTEMPTS);
  const stored = readMessages({ dir }).find((r) => r.id === record.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.ok(stored.error && stored.error.length <= 200);
  assert.ok(!stored.error.includes(secretText), 'the stored error omits the message text');
  assert.equal(events.length, MAX_DELIVERY_ATTEMPTS);
  assert.ok(events.every((e) => e.id === record.id && e.thread === 'alpha' && e.kind === 'message'));
  assert.ok(!JSON.stringify(events).includes(secretText), 'the events omit the message text');
});

function fakeHerdr(label, workspace = 'wA', paneId = 'wA:p1') {
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2] === paneId ? paneId : args[2], workspace_id: workspace, label } };
    throw new Error(`unexpected herdr call ${args.join(' ')}`);
  };
  return { herdr, calls };
}
const envFor = (paneId, workspace) => ({ HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspace });
const control = { projects: { alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } };

test('say from an orch pane writes a reply to the project thread', (t) => {
  const dir = freshDir(t);
  const question = appendMessage(owner('alpha', 'Status?'), { dir, now });
  const { herdr } = fakeHerdr('orch');
  const record = sayMessage('All good.', { replyTo: question.id, action: 'read' }, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now: now + 1000 });
  assert.equal(record.thread, 'alpha');
  assert.equal(record.from, 'orch');
  assert.equal(record.to, 'owner');
  assert.equal(record.kind, 'reply');
  assert.equal(record.status, 'new');
  assert.equal(record.replyTo, question.id);
  assert.equal(record.action, 'read');
  assert.deepEqual(listThread('alpha', { dir }).map((r) => r.kind), ['message', 'reply']);
});

test('say from the boss pane writes to the boss thread without a reply target', (t) => {
  const dir = freshDir(t);
  const { herdr } = fakeHerdr('boss', 'wB', 'wB:p1');
  const record = sayMessage('Morning summary.', {}, { env: envFor('wB:p1', 'wB'), herdr, control, dir, now });
  assert.equal(record.thread, 'boss');
  assert.equal(record.from, 'boss');
  assert.equal(record.replyTo, null);
  assert.equal(record.action, null);
});

test('say refuses a worker pane, a bad caller, bad input, and text with a secret', (t) => {
  const dir = freshDir(t);
  const worker = fakeHerdr(null, 'wA', 'wA:p2');
  assert.throws(() => sayMessage('Hi.', {}, { env: envFor('wA:p2', 'wA'), herdr: worker.herdr, control, dir, now }), /ask your orchestrator/i);
  const named = fakeHerdr('worker', 'wA', 'wA:p2');
  assert.throws(() => sayMessage('Hi.', {}, { env: envFor('wA:p2', 'wA'), herdr: named.herdr, control, dir, now }), /ask your orchestrator/i);
  const { herdr } = fakeHerdr('orch');
  assert.throws(() => sayMessage('Hi.', {}, { env: { HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' }, herdr, control, dir, now }), /HERDR_ENV/);
  assert.throws(() => sayMessage('Hi.', {}, { env: envFor('wA:p1', 'wZ'), herdr, control, dir, now }), /workspace/i);
  assert.throws(() => sayMessage('', {}, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now }), /1 to 4000/);
  assert.throws(() => sayMessage('x'.repeat(4001), {}, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now }), /1 to 4000/);
  assert.throws(() => sayMessage('Hi.', { action: 'shout' }, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now }), /--action/);
  assert.throws(() => sayMessage('Hi.', { replyTo: 'm-unknown' }, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now }), /--reply-to/);
  const orphan = fakeHerdr('orch', 'wX', 'wX:p1');
  assert.throws(() => sayMessage('Hi.', {}, { env: envFor('wX:p1', 'wX'), herdr: orphan.herdr, control, dir, now }), /No project/);
  for (const secret of ['The token=abc123def456 works.', 'Use ghp_abcdefghijklmnop now.', 'Authorization: Bearer abc.def.ghi']) {
    assert.throws(() => sayMessage(secret, {}, { env: envFor('wA:p1', 'wA'), herdr, control, dir, now }), /secret/i);
  }
  assert.deepEqual(readMessages({ dir }), [], 'no refused text reaches the store');
});

test('mail post writes a report to the boss thread only from the boss pane', (t) => {
  const dir = freshDir(t);
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, '# Morning handback\n\n- Item one\n- Item two\n');
  const boss = fakeHerdr('boss', 'wB', 'wB:p1');
  const record = postReport(file, { to: 'owner', title: 'Morning', action: 'decide' }, { env: envFor('wB:p1', 'wB'), herdr: boss.herdr, dir, now });
  assert.equal(record.kind, 'report');
  assert.equal(record.thread, 'boss');
  assert.equal(record.from, 'boss');
  assert.equal(record.to, 'owner');
  assert.equal(record.title, 'Morning');
  assert.equal(record.action, 'decide');
  assert.equal(record.status, 'new');
  assert.equal(record.text, fs.readFileSync(file, 'utf8'));
  const orch = fakeHerdr('orch');
  assert.throws(() => postReport(file, { to: 'owner' }, { env: envFor('wA:p1', 'wA'), herdr: orch.herdr, dir, now }), /boss/);
  assert.throws(() => postReport(file, { to: 'boss' }, { env: envFor('wB:p1', 'wB'), herdr: boss.herdr, dir, now }), /--to owner/);
  fs.writeFileSync(file, 'x'.repeat(64 * 1024 + 1));
  assert.throws(() => postReport(file, { to: 'owner' }, { env: envFor('wB:p1', 'wB'), herdr: boss.herdr, dir, now }), /64 KB/);
  fs.writeFileSync(file, '# Report\n\npassword: hunter2\n');
  assert.throws(() => postReport(file, { to: 'owner' }, { env: envFor('wB:p1', 'wB'), herdr: boss.herdr, dir, now }), /secret/i);
  assert.equal(listThread('boss', { dir }).length, 1);
});

function cliFixture(t, label, workspace, paneId) {
  const root = fs.mkdtempSync(path.join(dataDir, 'cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [data, home, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: ${JSON.stringify(workspace)}, label: ${JSON.stringify(label)} } } }));
else { console.error('unexpected herdr call'); process.exit(3); }
`);
  fs.chmodSync(path.join(bin, 'herdr'), 0o755);
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ control }));
  const env = {
    ...process.env, HOME: home, HERDR_BOSS_DIR: data, PATH: `${bin}:${process.env.PATH}`,
    HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspace,
  };
  delete env.NODE_TEST_CONTEXT;
  const cli = (...args) => spawnSync(process.execPath, [path.join(repo, 'src', 'cli.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  return { cli, data, root };
}

test('the say and messages commands write and print a thread as JSON', (t) => {
  const { cli, data } = cliFixture(t, 'orch', 'wA', 'wA:p1');
  const question = appendMessage(owner('alpha', 'Status?'), { dir: data, now: Date.now() });
  const said = cli('say', '--reply-to', question.id, '--action', 'answer', 'Two tasks left.');
  assert.equal(said.status, 0, said.stderr);
  const printed = cli('messages', 'alpha');
  assert.equal(printed.status, 0, printed.stderr);
  const records = JSON.parse(printed.stdout);
  assert.deepEqual(records.map((r) => [r.kind, r.from]), [['message', 'owner'], ['reply', 'orch']]);
  assert.equal(records[1].replyTo, question.id);
  assert.equal(records[1].text, 'Two tasks left.');
  const all = JSON.parse(cli('messages').stdout);
  assert.equal(all.length, 2);
  assert.deepEqual(JSON.parse(cli('messages', 'boss').stdout), []);
  const bad = cli('messages', 'Not A Slug');
  assert.notEqual(bad.status, 0);
  const secret = cli('say', 'api_key=abcdef123456');
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /secret/i);
  assert.ok(!secret.stderr.includes('abcdef123456'), 'the refusal does not print the secret');
});

test('the say command refuses a worker pane', (t) => {
  const { cli } = cliFixture(t, 'worker', 'wA', 'wA:p2');
  const result = cli('say', 'Hello Owner.');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ask your orchestrator/i);
});

test('mail post from the boss pane stores a report', (t) => {
  const { cli, data, root } = cliFixture(t, 'boss', 'wB', 'wB:p1');
  const file = path.join(root, 'handback.md');
  fs.writeFileSync(file, '# Handback\n\nAll projects are green.\n');
  const result = cli('mail', 'post', '--to', 'owner', '--title', 'Handback', '--action', 'read', file);
  assert.equal(result.status, 0, result.stderr);
  const [record] = listThread('boss', { dir: data });
  assert.equal(record.kind, 'report');
  assert.equal(record.title, 'Handback');
});

test('mail close is boss-only and records an answered-through-Boss note', (t) => {
  const boss = cliFixture(t, 'boss', 'wB', 'wB:p1');
  const item = appendMessage({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Which route?', action: 'decide', status: 'new' }, { dir: boss.data, now });
  const result = boss.cli('mail', 'close', item.id, '--note', 'Handled with the Owner through the Boss.');
  assert.equal(result.status, 0, result.stderr);
  const stored = readMessages({ dir: boss.data }).find((record) => record.id === item.id);
  assert.equal(stored.closedBy, 'boss');
  assert.equal(stored.closeNote, 'Handled with the Owner through the Boss.');
  assert.equal(stored.closedAt, stored.readAt);
  assert.equal(readMessages({ dir: boss.data }).length, 1, 'closing sends nothing');

  const secretItem = appendMessage({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Review this?', action: 'answer', status: 'new' }, { dir: boss.data, now });
  const secret = boss.cli('mail', 'close', secretItem.id, '--note', 'api_key=abcdef123456');
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /secret/i);
  assert.ok(!secret.stderr.includes('abcdef123456'), 'the refusal does not print the secret');
  assert.equal(readMessages({ dir: boss.data }).find((record) => record.id === secretItem.id).closedAt, undefined);

  const orch = cliFixture(t, 'orch', 'wA', 'wA:p1');
  const orchItem = appendMessage({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Choose.', action: 'decide', status: 'new' }, { dir: orch.data, now });
  const denied = orch.cli('mail', 'close', orchItem.id, '--note', 'Handled.');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /boss/i);
  assert.equal(readMessages({ dir: orch.data }).find((record) => record.id === orchItem.id).closedAt, undefined);

  const unknown = boss.cli('mail', 'close', 'm-not-found', '--note', 'Handled.');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /m-not-found/);
  const repeated = boss.cli('mail', 'close', item.id, '--note', 'Again.');
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, new RegExp(item.id));
});

test('messages relay is boss-only and relayed messages are never delivered', (t) => {
  const boss = cliFixture(t, 'boss', 'wB', 'wB:p1');
  const queued = appendMessage(owner('alpha', 'Relay this.'), { dir: boss.data, now });
  const relayed = boss.cli('messages', 'relay', queued.id, '--by', 'boss');
  assert.equal(relayed.status, 0, relayed.stderr);
  assert.match(relayed.stdout, /relayed/i);
  const stored = readMessages({ dir: boss.data }).find((record) => record.id === queued.id);
  assert.equal(stored.status, 'relayed');
  assert.ok(Number.isFinite(Date.parse(stored.relayedAt)), 'the relay records its time');
  assert.equal(stored.relayedBy, 'boss');

  const prompts = [];
  return deliverQueued({ panes: panesFor({ boss: 'idle', alpha: 'idle', beta: 'idle' }), projects, prompt: async (pane) => { prompts.push(pane); }, dir: boss.data, now: Date.now() })
    .then(() => assert.deepEqual(prompts, [], 'the delivery tick skips a relayed message'));
});

test('messages relay refuses an orchestrator pane and leaves Owner messages queued', (t) => {
  const { cli, data } = cliFixture(t, 'orch', 'wA', 'wA:p1');
  const queued = appendMessage(owner('alpha', 'Keep queued.'), { dir: data, now });
  const result = cli('messages', 'relay', queued.id, '--by', 'boss');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only.*boss/i);
  assert.equal(readMessages({ dir: data }).find((record) => record.id === queued.id).status, 'queued');
});

const engineProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { readMessages } from './src/messages.js';
const input = JSON.parse(process.env.O2_SCENARIO);
const calls = [];
const cfg = loadConfig();
cfg.push = true;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: true,
  act: true,
  collectors: {
    collectHerdr: async () => input.herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    collectPiModels: async () => null,
    codeSignCloneDir: () => null,
    runDenialScan: async () => null,
  },
  herdrRunner: async (command, args) => { calls.push(args); return JSON.stringify({ result: {} }); },
  handoffRunner: async () => { throw new Error('no handoff in this test'); },
  gitRunner: async () => '',
});
for (const name of ['deliver', 'reap', 'sweepClones', 'scanDenials', 'notifyHandoffPeers', 'autoHandover', 'retirePreviousOrchestrators']) engine[name] = async () => {};
await engine.tick();
console.log(JSON.stringify({ calls, records: readMessages(), events: engine.events.filter((e) => e.type === 'message'), mailbox: engine.state.mailbox }));
`;

test('an acting engine tick delivers queued Owner messages to idle and working orch panes', (t) => {
  const root = fs.mkdtempSync(path.join(dataDir, 'engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects', 'alpha.json'), JSON.stringify({ project: 'Alpha', workspace: 'wA', updated: new Date().toISOString() }));
  fs.writeFileSync(path.join(data, 'projects', 'beta.json'), JSON.stringify({ project: 'Beta', workspace: 'wC', updated: new Date().toISOString() }));
  const toAlpha = appendMessage(owner('alpha', 'Alpha, continue.'), { dir: data });
  const toBeta = appendMessage(owner('beta', 'Beta, wait.'), { dir: data });
  appendMessage({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Which date?', action: 'decide', status: 'new' }, { dir: data });
  appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'report', title: 'Handback', text: '# Handback', status: 'new', readAt: new Date().toISOString() }, { dir: data });
  const herdr = {
    workspaces: [{ id: 'wA', label: 'Alpha', status: 'idle' }, { id: 'wC', label: 'Beta', status: 'working' }],
    panes: [
      { id: 'wA:p1', workspace: 'wA', label: 'orch', orch: true, agent: 'codex', status: 'idle' },
      { id: 'wC:p1', workspace: 'wC', label: 'orch', orch: true, agent: 'codex', status: 'working' },
    ],
  };
  const env = { ...process.env, HOME: path.join(root, 'home'), HERDR_BOSS_DIR: data, HERDR_BOSS_ALLOW_ACTIONS: '1', O2_SCENARIO: JSON.stringify({ herdr }) };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', engineProbe], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const prompts = output.calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.deepEqual(prompts, [
    ['agent', 'prompt', 'wA:p1', ownerPromptText(toAlpha)],
    ['agent', 'prompt', 'wC:p1', ownerPromptText(toBeta)],
  ]);
  assert.equal(output.records.find((r) => r.id === toAlpha.id).status, 'sent');
  assert.equal(output.records.find((r) => r.id === toBeta.id).status, 'sent');
  assert.equal(output.events.length, 2);
  assert.equal(output.events[0].id, toAlpha.id);
  assert.equal(output.events[1].id, toBeta.id);
  assert.ok(!JSON.stringify(output.events).includes('Alpha, continue.'));
  assert.deepEqual(output.mailbox, { needsYou: 1, needsYouUnread: 1, updates: 0, unread: 1, open: 1, chatUnread: 1, mailUnread: 0, needsAction: 1 }, 'the state holds the counts of the top bar, the update count (a read report is Done), and one-release aliases');
});

test('messageChannel gives every kind and action one channel', () => {
  const reply = (extra) => ({ thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'x', action: null, ...extra });
  const report = (extra) => ({ thread: 'boss', from: 'boss', to: 'owner', kind: 'report', title: 'Handback', text: 'x', action: null, ...extra });
  // A report is mail.
  assert.equal(messageChannel(report()), 'mail');
  assert.equal(messageChannel(report({ action: 'approve' })), 'both', 'a needs-you report is in Mailbox and Chat');
  // A reply with an action for the Owner is in both channels.
  for (const action of ['answer', 'approve', 'decide']) assert.equal(messageChannel(reply({ action })), 'both', `${action} shows in Chat and in Needs you`);
  // Every other reply is a chat message.
  assert.equal(messageChannel(reply()), 'chat');
  assert.equal(messageChannel(reply({ action: 'read' })), 'chat');
  assert.equal(messageChannel(reply({ action: 'bogus' })), 'chat');
  // An Owner message, a nudge, and a status request are chat messages.
  for (const kind of ['message', 'nudge', 'status-request']) {
    assert.equal(messageChannel({ thread: 'alpha', from: 'owner', to: 'orch', kind, text: 'Continue.' }), 'chat');
  }
  assert.equal(messageChannel(null), 'chat');
  assert.equal(messageChannel({ to: 'orch', from: 'owner', kind: 'message', text: 'x' }), 'chat');
});

// ---------- Review records ----------

const reviewFields = (extra = {}) => ({ slug: 'alpha', pack: 'checkout-redesign', title: 'Checkout flow redesign', version: 1, text: '31 items in 4 sections.', role: 'orch', ...extra });

test('postReview appends a decide item on both channels that links to the pack', (t) => {
  const dir = freshDir(t);
  const record = postReview(reviewFields(), { dir, now });
  assert.equal(record.kind, 'review');
  assert.equal(record.thread, 'alpha');
  assert.equal(record.from, 'orch');
  assert.equal(record.to, 'owner');
  assert.equal(record.action, 'decide');
  assert.equal(record.status, 'new');
  assert.equal(record.title, 'Review: Checkout flow redesign (v1)');
  assert.match(record.text, /^31 items in 4 sections\.\n\n\[Open review\]\(\/reviews\/alpha\/checkout-redesign\)$/);
  assert.deepEqual(record.review, { slug: 'alpha', pack: 'checkout-redesign', version: 1 });
  assert.equal(isMailboxItem(record), true);
  assert.equal(messageChannel(record), 'both');
  assert.equal(isMailRecord(record), true);
  const stored = readMessages({ dir });
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].review, record.review);
});

test('an open review item is in Needs you and counts as an action item', (t) => {
  const dir = freshDir(t);
  const record = postReview(reviewFields(), { dir, now });
  const view = mailboxView(readMessages({ dir }));
  assert.deepEqual(view.needsYou.map((item) => item.id), [record.id]);
  assert.equal(view.needsYou[0].action, 'decide');
  assert.equal(mailboxCounts(readMessages({ dir })).needsYou, 1);
  closeReviewItems({ slug: 'alpha', pack: 'checkout-redesign' }, { dir, now: now + 1000 });
  const after = mailboxView(readMessages({ dir }));
  assert.equal(after.needsYou.length, 0);
  assert.deepEqual(after.done.map((item) => item.id), [record.id]);
});

test('a new version closes the older review item of the same pack only', (t) => {
  const dir = freshDir(t);
  const other = postReview(reviewFields({ pack: 'api-reference', title: 'Orders API reference' }), { dir, now });
  const otherProject = postReview(reviewFields({ slug: 'beta' }), { dir, now });
  const first = postReview(reviewFields(), { dir, now: now + 1000 });
  const second = postReview(reviewFields({ version: 2 }), { dir, now: now + 2000 });
  const records = readMessages({ dir });
  const byId = new Map(records.map((record) => [record.id, record]));
  assert.ok(byId.get(first.id).closedAt, 'the older item is closed');
  assert.equal(byId.get(first.id).closedBy, 'review');
  assert.ok(byId.get(first.id).readAt);
  assert.ok(!byId.get(second.id).closedAt, 'the new item is open');
  assert.ok(!byId.get(other.id).closedAt, 'another pack keeps its item');
  assert.ok(!byId.get(otherProject.id).closedAt, 'another project keeps its item');
  assert.equal(byId.get(second.id).title, 'Review: Checkout flow redesign (v2)');
});

test('closeReviewItems closes every open item of a pack and reports how many', (t) => {
  const dir = freshDir(t);
  const item = postReview(reviewFields(), { dir, now });
  const done = closeReviewItems({ slug: 'alpha', pack: 'checkout-redesign' }, { dir, now: now + 1000 });
  assert.equal(done.closed, 1);
  assert.equal(readMessages({ dir }).find((record) => record.id === item.id).closedBy, 'review');
  assert.equal(closeReviewItems({ slug: 'alpha', pack: 'checkout-redesign' }, { dir, now: now + 2000 }).closed, 0, 'a closed item stays as it is');
  assert.equal(closeReviewItems({ slug: 'alpha', pack: 'unknown' }, { dir, now }).closed, 0);
});

test('postReview refuses a bad thread, a role, and a secret in the title, the text, or the note', (t) => {
  const dir = freshDir(t);
  assert.throws(() => postReview(reviewFields({ slug: 'Not A Slug' }), { dir, now }), /slug/i);
  assert.throws(() => postReview(reviewFields({ role: 'worker' }), { dir, now }), /role/i);
  assert.throws(() => postReview(reviewFields({ title: 'Deploy with token=abc123def456' }), { dir, now }), /secret/i);
  assert.throws(() => postReview(reviewFields({ text: 'Use ghp_abcdefghijklmnop now.' }), { dir, now }), /secret/i);
  assert.deepEqual(readMessages({ dir }), [], 'no refused text reaches the store');
});

test('a long pack title is cut so the item title stays within the title limit', (t) => {
  const dir = freshDir(t);
  const record = postReview(reviewFields({ title: 'T'.repeat(200) }), { dir, now });
  assert.ok(record.title.length <= 200, `title has ${record.title.length} characters`);
  assert.match(record.title, /^Review: T+.* \(v1\)$/);
});

test('an Owner answer to a review item stays in the Mailbox thread and names the item in the prompt', (t) => {
  const dir = freshDir(t);
  const item = postReview(reviewFields(), { dir, now });
  const answer = appendMessage({ ...owner('alpha', 'Start with the dark cart.'), replyTo: item.id }, { dir, now: now + 1000 });
  const records = readMessages({ dir });
  assert.equal(isMailAnswer(answer, messagesById(records)), true);
  assert.ok(!chatRecords(records).some((record) => record.id === answer.id), 'the answer is not in the Chat');
  const view = mailboxView(records);
  assert.equal(view.needsYou[0].answer.id, answer.id);
  const prompt = ownerPromptText(answer, item);
  assert.match(prompt, /^\[owner\] Answer to m-[^ ]+ \(Review: Checkout flow redesign \(v1\)\): Start with the dark cart\./);
  assert.match(prompt, /> 31 items in 4 sections\./);
});

test('a new review item closes the older one in the same store write', async (t) => {
  const { openMessageStore } = await import('../src/message-store.js');
  const dir = freshDir(t);
  postReview(reviewFields(), { dir, now });
  const store = openMessageStore({ dir });
  const openAt = [];
  const stop = store.onChange((event) => {
    if (event.type === 'append' && event.record.kind === 'review') openAt.push(readMessages({ dir }).filter((record) => record.kind === 'review' && !record.closedAt).length);
  });
  t.after(stop);
  postReview(reviewFields({ version: 2 }), { dir, now: now + 1000 });
  assert.deepEqual(openAt, [1], 'when the new item appears, the older item is already closed');
});

test('an Owner answer to a review item never shows in the Chat, and reading the item does not close it', (t) => {
  const dir = freshDir(t);
  const item = postReview(reviewFields(), { dir, now });
  const answer = appendMessage({ ...owner('alpha', 'Start with the dark cart.'), replyTo: item.id }, { dir, now: now + 1000 });
  const records = readMessages({ dir });
  assert.ok(!chatThreadPage(records, 'alpha').some((record) => record.id === answer.id), 'the thread page omits the answer');
  const summary = chatSummaries(records).find((chat) => chat.thread === 'alpha');
  assert.ok(summary.last.id !== answer.id, 'the Chat list does not use the answer as its last message');
  assert.equal(summary.count, 1);
  assert.equal(mailboxView(records).needsYou[0].answer.id, answer.id, 'the answer belongs to the Mailbox item');

  assert.deepEqual(markMailboxRead({ ids: [item.id] }, { dir, now: now + 2000 }), { ok: true, updated: 1 });
  const read = readMessages({ dir }).find((record) => record.id === item.id);
  assert.ok(read.readAt, 'reading marks the item read');
  assert.ok(!read.closedAt, 'reading does not close a decide item');
  assert.equal(mailboxView(readMessages({ dir })).needsYou.length, 1);
  assert.equal(markMailboxRead({ ids: [item.id], close: true }, { dir, now: now + 3000 }).status, 409, 'Mark read cannot close a review item');
});
