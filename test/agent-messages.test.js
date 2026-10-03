import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-agent-messages-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = dataDir;
fs.mkdirSync(process.env.HOME, { recursive: true });

const messages = await import('../src/messages.js');
const agent = await import('../src/agent-messages.js').catch(() => ({}));
const { appendMessage } = messages;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('agent messages stay out of Owner Chat, Mailbox, and unread counts', () => {
  const records = [
    { id: 'owner-chat', at: new Date().toISOString(), thread: 'alpha', from: 'orch', to: 'owner', kind: 'reply', text: 'Owner chat' },
    { id: 'agent', at: new Date().toISOString(), thread: null, from: { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' }, to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p2' }, kind: 'agent', text: 'Internal task', status: 'delivered' },
  ];
  assert.deepEqual(messages.chatRecords(records).map((record) => record.id), ['owner-chat']);
  assert.deepEqual(messages.chatSummaries(records).map((chat) => chat.count), [1]);
  assert.equal(messages.mailboxCounts(records).chatUnread, 1);
});

test('agent messages use stable unordered pair keys and store a text-free metadata row', () => {
  const dir = path.join(root, 'record-data');
  const from = { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' };
  const to = { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p2' };
  assert.equal(agent.pairKeyForAgents(from, to), 'orch:alpha+worker:build');
  assert.equal(agent.pairKeyForAgents(to, from), 'orch:alpha+worker:build');

  const record = agent.recordAgentMessage({ from, to, text: 'Do the work.', kind: 'task', taskId: 'AM1a' }, { dir, now: 1000 });
  assert.equal(record.kind, 'agent');
  assert.equal(record.status, 'recorded');
  assert.equal(record.pairKey, 'orch:alpha+worker:build');
  assert.equal(agent.readAgentMessages({ dir }).length, 1);
  assert.deepEqual(agent.readAgentMetadata({ dir }), [{
    id: record.id, at: new Date(1000).toISOString(), from, to, project: 'alpha', kind: 'task', chars: 12,
    taskId: 'AM1a', runId: null, respondedAt: null, responseMs: null, status: 'recorded',
  }]);
  assert.doesNotMatch(JSON.stringify(agent.readAgentMetadata({ dir })), /Do the work/);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'agent-message-meta.jsonl'), 'utf8')), 'text'), false);
});

test('agent metadata response updates append a line and fold on read', () => {
  const dir = path.join(root, 'metadata-update-data');
  const record = agent.recordAgentMessage({
    from: { role: 'boss', project: null, name: null, pane: 'wB:p1' },
    to: { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' },
    text: 'Task.', kind: 'task',
  }, { dir, now: 1000 });
  const file = path.join(dir, 'agent-message-meta.jsonl');
  const originalLine = fs.readFileSync(file, 'utf8');
  agent.updateAgentMessageRespondedAt(record.id, '2026-01-01T00:00:00.000Z', { dir });
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2, 'an update appends instead of rewriting the metadata file');
  assert.equal(lines[0], originalLine.trimEnd());
  assert.deepEqual(JSON.parse(lines[1]), { id: record.id, _update: 'respondedAt', respondedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(agent.readAgentMetadata({ dir })[0].respondedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(Object.hasOwn(JSON.parse(lines[1]), 'text'), false);
});

test('agent text and metadata have separate retention windows', () => {
  const dir = path.join(root, 'retention-data');
  const now = 100 * 86400000;
  const record = agent.recordAgentMessage({
    from: { role: 'boss', project: null, name: null, pane: 'wB:p1' },
    to: { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' },
    text: 'Old task', kind: 'task',
  }, { dir, now: now - 20 * 86400000 });

  const result = agent.sweepAgentMessages({ dir, retentionDays: 14, metaRetentionDays: 180, now });
  assert.equal(result.textDeleted, 1);
  assert.equal(agent.readAgentMessages({ dir }).some((item) => item.id === record.id), false);
  assert.equal(agent.readAgentMetadata({ dir }).some((item) => item.id === record.id), true);

  agent.sweepAgentMessages({ dir, retentionDays: 14, metaRetentionDays: 7, now: now + 8 * 86400000 });
  assert.equal(agent.readAgentMetadata({ dir }).some((item) => item.id === record.id), false);

  const longText = agent.recordAgentMessage({
    from: { role: 'boss', project: null, name: null, pane: 'wB:p1' },
    to: { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' },
    text: 'Keep this for the longer policy.', kind: 'task',
  }, { dir, now: now - 40 * 86400000 });
  assert.equal(messages.readMessages({ dir }).some((item) => item.id === longText.id), true, 'the generic 30-day store retention does not remove agent text');
  assert.equal(agent.sweepAgentMessages({ dir, retentionDays: 90, metaRetentionDays: 180, now }).textDeleted, 0, 'a 90-day policy keeps 40-day text');
});

test('agent pairs and message reads filter by project, pair, query, limit, and cursor', () => {
  const dir = path.join(root, 'pairs-data');
  const from = { role: 'boss', project: null, name: null, pane: 'wB:p1' };
  const to = { role: 'orch', project: 'beta', name: null, pane: 'wC:p1' };
  const first = agent.recordAgentMessage({ from, to, text: 'First item', kind: 'task' }, { dir, now: 2000 });
  agent.recordAgentMessage({ from, to, text: 'Second reminder', kind: 'reminder' }, { dir, now: 3000 });
  assert.deepEqual(agent.readAgentMessages({ dir, project: 'beta', pair: first.pairKey, q: 'reminder' }).map((item) => item.text), ['Second reminder']);
  assert.equal(agent.readAgentMessages({ dir, project: 'alpha' }).length, 0);
  assert.deepEqual(agent.listAgentPairs({ dir, project: 'beta' }), [{ pairKey: first.pairKey, count: 2, lastAt: new Date(3000).toISOString() }]);
});

test('worker reports are recorded once for each run and report modification time', () => {
  const dir = path.join(root, 'reports-data');
  const report = { project: 'alpha', name: 'build', pane: 'wA:p2', taskId: 'AM1a', runId: 'worker:alpha:build:run-1', mtimeMs: 42, summary: 'A completed report.' };
  const first = agent.recordWorkerReport(report, { dir, now: 4000 });
  assert.equal(first.agentKind, 'report');
  assert.equal(first.runId, report.runId);
  assert.equal(first.text, 'A completed report.');
  assert.equal(agent.recordWorkerReport(report, { dir, now: 5000 }), null);
  assert.ok(agent.recordWorkerReport({ ...report, mtimeMs: 43 }, { dir, now: 6000 }));
});

test('engine report detection records only new report file versions', async () => {
  const { inspectWorkerReports } = await import('../src/worker-failures.js');
  const pane = { id: 'wA:p2', workspace: 'wA', label: null, agent: 'codex', name: 'build', cwd: '/tmp/agent-report-fixture' };
  let mtimeMs = 1001;
  const recorded = [];
  const metadata = (file) => (file === '/tmp/agent-report-fixture/.worker/report.json' ? { isFile: true, mtimeMs } : null);
  const first = await inspectWorkerReports([pane], {}, 1000, metadata, null, (item) => recorded.push(item));
  assert.equal(recorded.length, 1);
  const same = await inspectWorkerReports([pane], first.observed, 1001, metadata, null, (item) => recorded.push(item));
  assert.equal(recorded.length, 1);
  mtimeMs = 1003;
  await inspectWorkerReports([pane], same.observed, 1003, metadata, null, (item) => recorded.push(item));
  assert.equal(recorded.length, 2);
});

test('agent tell resolves a project to its orchestrator and records delivery failures', () => {
  const dir = path.join(root, 'tell-data');
  const calls = [];
  const panes = [
    { pane_id: 'wB:p1', workspace_id: 'wB', label: 'boss' },
    { pane_id: 'wA:p1', workspace_id: 'wA', label: 'orch' },
    { pane_id: 'wA:p2', workspace_id: 'wA', label: null, name: 'build' },
  ];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: panes.find((pane) => pane.pane_id === args[2]) };
    if (args[0] === 'pane' && args[1] === 'list') return { panes };
    if (args[0] === 'agent' && args[1] === 'prompt' && process.env.TEST_TELL_FAIL === '1') throw new Error(`prompt refused: ${args[3]?.slice(0, 4)}`);
    return {};
  };
  const options = {
    dir,
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB' },
    herdr,
    control: { projects: { alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } },
    runs: [],
    now: 7000,
  };
  const delivered = agent.tellAgent('alpha', 'Raw delivery token sk-abcdefghijk', options);
  assert.equal(delivered.exitCode, 0);
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'wA:p1' && args[3] === 'Raw delivery token sk-abcdefghijk' && !args.includes('--wait')), true);
  assert.equal(messages.readMessages({ dir }).find((item) => item.id === delivered.record.id).text, 'Raw delivery token [REDACTED]');

  process.env.TEST_TELL_FAIL = '1';
  const failed = agent.tellAgent('build', 'Keep the record', { ...options, now: 8000 });
  delete process.env.TEST_TELL_FAIL;
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.reason.includes('Keep'), false);
  assert.equal(messages.readMessages({ dir }).find((item) => item.id === failed.record.id).status, 'failed');
});

test('agent tell does not resolve an inherited project lookup', () => {
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get' && args[2] === 'wB:p1') return { pane: { pane_id: 'wB:p1', workspace_id: 'wB', label: 'boss' } };
    if (args[0] === 'pane' && args[1] === 'get' && args[2] === 'wA:p1') return { pane: { pane_id: 'wA:p1', workspace_id: 'wA', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    return {};
  };
  const projects = Object.create({ alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } });
  const result = agent.tellAgent('alpha', 'Do not deliver.', {
    dir: path.join(root, 'inherited-project-data'),
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB' },
    herdr, control: { projects }, runs: [], now: 9000,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /No pane or agent named alpha/);
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'get' && args[2] === 'wA:p1'), false);
});

test('tell metadata keeps the target worker kind, model and active state', () => {
  const dir = path.join(root, 'tell-worker-data');
  const boss = { pane_id: 'wB:p1', workspace_id: 'wB', label: 'boss' };
  const worker = { pane_id: 'wA:p2', workspace_id: 'wA', agent_status: 'working' };
  const result = agent.tellAgent('wA:p2', 'Task.', {
    dir, now: 1000, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB' },
    control: { projects: { orchard: { slug: 'orchard', workspace: 'wA' } } },
    runs: [{ name: 'build', project: 'orchard', pane: 'wA:p2', kind: 'codex', model: 'sample-model', taskId: 'T1', startedAt: '2026-10-01' }],
    herdr: args => args[0] === 'pane' ? { pane: args[2] === boss.pane_id ? boss : worker } : {},
  });
  assert.equal(result.exitCode, 0);
  const row = agent.readAgentMetadata({ dir })[0];
  assert.equal(row.to.kind, 'codex');
  assert.equal(row.to.model, 'sample-model');
  assert.equal(row.taskId, 'T1');
  assert.equal(row.targetStatus, 'working');
});

test('a metadata status write failure does not relabel a delivered tell as failed', () => {
  const dir = path.join(root, 'tell-status-failure');
  const boss = { pane_id: 'wB:p1', workspace_id: 'wB', label: 'boss' };
  const orch = { pane_id: 'wA:p1', workspace_id: 'wA', label: 'orch' };
  const result = agent.tellAgent('wA:p1', 'Task.', {
    dir, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB' }, runs: [],
    herdr: args => {
      if (args[0] === 'pane') return { pane: args[2] === boss.pane_id ? boss : orch };
      const file = path.join(dir, 'agent-message-meta.jsonl');
      fs.unlinkSync(file);
      fs.mkdirSync(file);
      return {};
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.record.status, 'delivered');
  assert.equal(typeof result.metadataWarning, 'string');
  assert.equal(agent.readAgentMessages({ dir })[0].status, 'delivered');
});

test('a malformed metadata row cannot prevent a valid idle response', () => {
  const dir = path.join(root, 'response-malformed-data');
  const record = agent.recordAgentMessage({
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'orchard', name: 'build', pane: 'wA:p2' },
    text: 'Continue.', kind: 'nudge', status: 'delivered', targetStatus: 'working',
  }, { dir, now: 1000 });
  fs.appendFileSync(path.join(dir, 'agent-message-meta.jsonl'), JSON.stringify({ id: 'broken', at: new Date(2000).toISOString() }) + '\n');
  const result = agent.updateAgentResponses({ dir, now: 3000, panes: [{ id: 'wA:p2', agent: 'codex', status: 'idle' }] });
  assert.equal(result.updated, 1);
  assert.equal(agent.readAgentMetadata({ dir }).find(row => row.id === record.id).responseMs, 2000);
  assert.equal(agent.updateAgentMessageRespondedAt(record.id, new Date(4000).toISOString(), { dir }), false);
  assert.equal(agent.readAgentMetadata({ dir }).find(row => row.id === record.id).responseMs, 2000);
});

test('an initialized empty response index reads no metadata and takes no lock', (t) => {
  const dir = path.join(root, 'empty-response-index-data');
  const file = path.join(dir, 'agent-message-meta.jsonl');
  const now = Date.parse('2026-10-01T12:00:00Z');
  const rows = Array.from({ length: 20000 }, (_, i) => ({
    id: `old-${i}`, at: new Date(now - 180 * 86400000 + i).toISOString(),
    from: { role: 'service', pane: null }, to: { role: 'worker', pane: `wA:p${i}` },
    project: 'invented', kind: 'reminder', respondedAt: new Date(now - 179 * 86400000).toISOString(),
  }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  agent.initializeAgentResponseIndex({ dir, now });

  let reads = 0;
  let locks = 0;
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (String(target) === file) reads++;
    return readFileSync.call(fs, target, ...args);
  });
  t.mock.method(fs, 'openSync', function (target, ...args) {
    if (String(target) === `${file}.lock`) locks++;
    return openSync.call(fs, target, ...args);
  });

  assert.deepEqual(agent.updateAgentResponses({ dir, now }), { updated: 0, observed: {} });
  assert.equal(reads, 0);
  assert.equal(locks, 0);
});

test('same-process metadata writes update the index and external writes rebuild it', () => {
  const dir = path.join(root, 'response-index-sync-data');
  const now = Date.parse('2026-10-01T12:00:00Z');
  agent.initializeAgentResponseIndex({ dir, now });
  const local = agent.recordAgentMessage({
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' },
    text: 'Local row.', kind: 'reminder', status: 'delivered', targetStatus: 'working',
  }, { dir, now });
  let result = agent.updateAgentResponses({ dir, now: now + 1000, panes: [{ id: 'wA:p1', agent: 'codex', status: 'idle' }] });
  assert.equal(result.updated, 1);
  assert.equal(agent.readAgentMetadata({ dir }).find((row) => row.id === local.id).responseMs, 1000);

  const external = {
    id: 'external-row', at: new Date(now + 2000).toISOString(),
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' },
    project: 'alpha', kind: 'nudge', respondedAt: null, status: 'delivered', targetStatus: 'working',
  };
  fs.appendFileSync(path.join(dir, 'agent-message-meta.jsonl'), `${JSON.stringify(external)}\n`);
  result = agent.updateAgentResponses({ dir, now: now + 3000, panes: [{ id: 'wA:p1', agent: 'codex', status: 'idle' }] });
  assert.equal(result.updated, 1);
  assert.equal(agent.readAgentMetadata({ dir }).find((row) => row.id === external.id).responseMs, 1000);
});

test('an already answered delivered tell still resolves the earlier target message', () => {
  const dir = path.join(root, 'answered-tell-response-data');
  const now = Date.parse('2026-10-01T12:00:00Z');
  const target = { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' };
  const rows = [
    {
      id: 'waiting-message', at: new Date(now - 120000).toISOString(),
      from: { role: 'service', project: null, name: null, pane: null }, to: target,
      project: 'alpha', kind: 'reminder', status: 'delivered', targetStatus: 'working', respondedAt: null,
    },
    {
      id: 'answered-reply', at: new Date(now - 60000).toISOString(), from: target,
      to: { role: 'invalid' }, project: 'alpha', kind: 'reply', status: 'delivered', source: 'tell',
      respondedAt: new Date(now - 30000).toISOString(),
    },
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-message-meta.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const result = agent.updateAgentResponses({ dir, now });
  assert.equal(result.updated, 1);
  assert.equal(agent.readAgentMetadata({ dir }).find((row) => row.id === 'waiting-message').respondedAt, rows[1].at);
});

test('a clock moving before a row does not remove that future row from the response index', () => {
  const dir = path.join(root, 'response-index-clock-skew-data');
  const createdAt = Date.parse('2026-10-01T12:00:00Z');
  const record = agent.recordAgentMessage({
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' },
    text: 'Clock change.', kind: 'reminder', status: 'delivered', targetStatus: 'working',
  }, { dir, now: createdAt });
  agent.initializeAgentResponseIndex({ dir, now: createdAt + 10000 });

  assert.equal(agent.updateAgentResponses({ dir, now: createdAt - 5000 }).updated, 0);
  assert.equal(agent.updateAgentResponses({
    dir, now: createdAt + 5000, panes: [{ id: 'wA:p1', agent: 'codex', status: 'idle' }],
  }).updated, 1);
  assert.equal(agent.readAgentMetadata({ dir }).find((row) => row.id === record.id).responseMs, 5000);
});

test('Engine startup initializes the response index before its first tick', async (t) => {
  const dir = path.join(root, 'engine-start-response-index-data');
  const at = Date.parse('2026-10-01T12:00:00Z');
  const file = path.join(dir, 'agent-message-meta.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    id: 'startup-row', at: new Date(at).toISOString(),
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' },
    kind: 'reminder', status: 'delivered', targetStatus: 'working', respondedAt: null,
  })}\n`);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { Engine } from './src/engine.js';
    import { loadConfig } from './src/config.js';
    import { updateAgentResponses } from './src/agent-messages.js';
    const dir = process.env.HERDR_BOSS_DIR;
    const file = dir + '/agent-message-meta.jsonl';
    const now = Number(process.env.AM_NOW);
    new Engine(loadConfig(), { push: false, act: true, clock: () => now });
    const original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (target, ...args) {
      if (String(target) === file) reads++;
      return original.call(fs, target, ...args);
    };
    const result = updateAgentResponses({ dir, now: now + 1000 });
    process.stdout.write(JSON.stringify({ reads, updated: result.updated }));
  `], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...process.env, HOME: path.join(root, 'engine-start-home'), HERDR_BOSS_DIR: dir,
      HERDR_BOSS_ALLOW_ACTIONS: '1', AM_NOW: String(at) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { reads: 0, updated: 0 });
});

test('a restarted process rebuilds the open response index from metadata', async (t) => {
  const dir = path.join(root, 'response-index-restart-data');
  const createdAt = Date.parse('2026-10-01T10:00:00Z');
  const record = agent.recordAgentMessage({
    from: { role: 'service', project: null, name: null, pane: null },
    to: { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p1' },
    text: 'Continue.', kind: 'reminder', status: 'delivered', targetStatus: 'working',
  }, { dir, now: createdAt });
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { updateAgentResponses, readAgentMetadata } from './src/agent-messages.js';
    const dir = process.env.AM_DIR;
    const now = Number(process.env.AM_NOW);
    const response = updateAgentResponses({ dir, now, panes: [{ id: 'wA:p1', agent: 'codex', status: 'idle' }] });
    const row = readAgentMetadata({ dir }).find((item) => item.id === process.env.AM_ID);
    process.stdout.write(JSON.stringify({ response, row }));
  `], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...process.env, HOME: path.join(root, 'restart-home'), HERDR_BOSS_DIR: dir,
      AM_DIR: dir, AM_NOW: String(createdAt + 5 * 60000), AM_ID: record.id },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.response.updated, 1);
  assert.equal(value.row.respondedAt, new Date(createdAt + 5 * 60000).toISOString());
  assert.equal(value.row.responseMs, 5 * 60000);
});

test('CLI tell reads a regular file up to 64 KB and uses a fake herdr binary', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../src/cli.js', import.meta.url);
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeHerdr = path.join(fakeBin, 'herdr');
  fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let result = {};
if (args[0] === 'pane' && args[1] === 'get') {
  const id = args[2];
  result = { pane: id === 'wB:p1' ? { pane_id: id, workspace_id: 'wB', label: 'boss' } : { pane_id: id, workspace_id: 'wA', label: 'orch' } };
} else if (args[0] === 'pane' && args[1] === 'list') {
  result = { panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', label: 'orch' }] };
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  if (process.env.FAKE_HERDR_FAIL === '1') result = { error: 'prompt refused' };
  else { fs.appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify(args.slice(2)) + '\\n'); result = { ok: true }; }
}
process.stdout.write(JSON.stringify(result));
`);
  fs.chmodSync(fakeHerdr, 0o700);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ control: { projects: { alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } } }));
  const promptLog = path.join(root, 'prompts.jsonl');
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: path.join(root, 'cli-home'),
    HERDR_BOSS_DIR: dataDir,
    HERDR_ENV: '1', HERDR_PANE_ID: 'wB:p1', HERDR_WORKSPACE_ID: 'wB',
    FAKE_PROMPT_LOG: promptLog,
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const bodyFile = path.join(root, 'message.md');
  fs.writeFileSync(bodyFile, 'From a file.');
  const sent = spawnSync(process.execPath, [cli.pathname, 'tell', 'alpha', '--file', bodyFile, '--kind', 'reminder', '--reply-to', 'parent-1'], { encoding: 'utf8', env });
  assert.equal(sent.status, 0, sent.stderr);
  const delivered = JSON.parse(fs.readFileSync(promptLog, 'utf8'));
  assert.deepEqual(delivered, ['wA:p1', 'From a file.']);
  const record = messages.readMessages({ dir: dataDir }).find((item) => item.kind === 'agent');
  assert.equal(record.agentKind, 'reminder');
  assert.equal(record.replyTo, 'parent-1');

  const tooLarge = path.join(root, 'large.md');
  fs.writeFileSync(tooLarge, 'x'.repeat(65537));
  const refused = spawnSync(process.execPath, [cli.pathname, 'tell', 'alpha', '--file', tooLarge], { encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /limit is 64 KB/);
  const usage = spawnSync(process.execPath, [cli.pathname, 'tell', 'alpha', '--kind', 'report', 'body'], { encoding: 'utf8', env });
  assert.equal(usage.status, 2);
});

test('agent message metadata validates its own retention setting', async () => {
  const { POLICY_DEFAULTS, validatePolicy } = await import('../src/control.js');
  const { loadModels } = await import('../src/kit/config.js');
  const defaults = structuredClone(POLICY_DEFAULTS);
  assert.deepEqual(defaults.agentMessages, { retentionDays: 14, metaRetentionDays: 180, promptTimeoutSeconds: 25 });
  assert.equal(validatePolicy({ ...defaults, agentMessages: { ...defaults.agentMessages, metaRetentionDays: 7 } }, loadModels()).length, 0);
  for (const agentMessages of [{ retentionDays: 0, metaRetentionDays: 180 }, { retentionDays: 14, metaRetentionDays: 731 }]) {
    assert.ok(validatePolicy({ ...defaults, agentMessages }, loadModels()).some((error) => error.startsWith('agentMessages.')));
  }
});

test('agent prompt timeout has a 25-second default and an integer range from 1 to 120', async () => {
  const { POLICY_DEFAULTS, validatePolicy, loadPolicy } = await import('../src/control.js');
  const { loadModels } = await import('../src/kit/config.js');
  assert.equal(POLICY_DEFAULTS.agentMessages.promptTimeoutSeconds, 25);
  const file = path.join(root, 'legacy-policy.json');
  fs.writeFileSync(file, JSON.stringify({ agentMessages: { retentionDays: 14, metaRetentionDays: 180 } }));
  assert.equal(loadPolicy({ file, models: loadModels() }).agentMessages.promptTimeoutSeconds, 25);
  for (const value of [0, 121, 2.5, '25']) {
    const policy = structuredClone(POLICY_DEFAULTS);
    policy.agentMessages.promptTimeoutSeconds = value;
    assert.ok(validatePolicy(policy, loadModels()).includes('agentMessages.promptTimeoutSeconds must be an integer from 1 to 120.'));
  }
  for (const value of [1, 120]) {
    const policy = structuredClone(POLICY_DEFAULTS);
    policy.agentMessages.promptTimeoutSeconds = value;
    assert.equal(validatePolicy(policy, loadModels()).length, 0);
  }
});

test('the Opus policy validates its switch and its limit', async () => {
  const { POLICY_DEFAULTS, validatePolicy } = await import('../src/control.js');
  const { loadModels } = await import('../src/kit/config.js');
  const valid = structuredClone(POLICY_DEFAULTS);
  assert.equal(validatePolicy(valid, loadModels()).length, 0);
  for (const [opus, message] of [
    [{ allowWithoutForce: 'yes', maxConcurrent: 2 }, 'opus.allowWithoutForce must be boolean.'],
    [{ allowWithoutForce: true, maxConcurrent: 0 }, 'opus.maxConcurrent must be an integer from 1 to 8.'],
    [{ allowWithoutForce: true, maxConcurrent: 9 }, 'opus.maxConcurrent must be an integer from 1 to 8.'],
  ]) assert.ok(validatePolicy({ ...valid, opus }, loadModels()).includes(message), message);
});
