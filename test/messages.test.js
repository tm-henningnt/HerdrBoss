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
  sayMessage, postReport, ownerPromptText, MAX_DELIVERY_ATTEMPTS,
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
const now = Date.parse('2026-09-28T12:00:00.000Z');

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

test('delivery sends only to idle or done boss and orch panes, one message per pane per tick', async (t) => {
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
  assert.deepEqual(prompts, [{ pane: 'wB:p1', text: ownerPromptText(b1) }], 'only the idle Boss gets one message');
  assert.equal(ownerPromptText(b1), `[owner] First for Boss. (Reply with: herdr-boss say --reply-to ${b1.id} "<answer>")`);
  let records = readMessages({ dir });
  const status = (id) => records.find((r) => r.id === id);
  assert.equal(status(b1.id).status, 'sent');
  assert.equal(status(b1.id).sentAt, new Date(now + 10).toISOString());
  assert.equal(status(b2.id).status, 'queued', 'the second Boss message waits for a later tick');
  assert.equal(status(a1.id).status, 'queued', 'a working orchestrator gets no message');
  assert.equal(status(c1.id).status, 'queued', 'a blocked orchestrator gets no message');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, b1.id);
  assert.equal(events[0].thread, 'boss');
  assert.equal(events[0].kind, 'message');
  assert.ok(!JSON.stringify(events).includes('First for Boss'), 'the event has no message text');

  prompts.length = 0;
  await deliverQueued({ panes: panesFor({ boss: 'done', alpha: 'done', beta: 'idle' }), projects, prompt, log, dir, now: now + 20 });
  assert.deepEqual(prompts.map((p) => p.pane).sort(), ['wA:p1', 'wB:p1', 'wC:p1']);
  assert.equal(prompts.find((p) => p.pane === 'wB:p1').text, ownerPromptText(b2));
  records = readMessages({ dir });
  assert.ok(records.every((r) => r.status === 'sent'));
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
console.log(JSON.stringify({ calls, records: readMessages(), events: engine.events.filter((e) => e.type === 'message') }));
`;

test('an acting engine tick delivers a queued Owner message to an idle orch pane and not to a working one', (t) => {
  const root = fs.mkdtempSync(path.join(dataDir, 'engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects', 'alpha.json'), JSON.stringify({ project: 'Alpha', workspace: 'wA', updated: new Date().toISOString() }));
  fs.writeFileSync(path.join(data, 'projects', 'beta.json'), JSON.stringify({ project: 'Beta', workspace: 'wC', updated: new Date().toISOString() }));
  const toAlpha = appendMessage(owner('alpha', 'Alpha, continue.'), { dir: data });
  const toBeta = appendMessage(owner('beta', 'Beta, wait.'), { dir: data });
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
  assert.deepEqual(prompts, [['agent', 'prompt', 'wA:p1', ownerPromptText(toAlpha)]]);
  assert.equal(output.records.find((r) => r.id === toAlpha.id).status, 'sent');
  assert.equal(output.records.find((r) => r.id === toBeta.id).status, 'queued');
  assert.equal(output.events.length, 1);
  assert.equal(output.events[0].id, toAlpha.id);
  assert.ok(!JSON.stringify(output.events).includes('Alpha, continue.'));
});
