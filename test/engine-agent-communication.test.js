import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const probe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { readAgentMetadata, readAgentMessages } from './src/agent-messages.js';
const now = Number(process.env.AM_NOW);
const cfg = loadConfig();
const engine = new Engine(cfg, { push: true, act: true, clock: () => now });
const pane = { id: 'wA:p1', workspace: 'wA', orch: true, label: 'orch', agent: 'codex', project: 'orchard', status: 'idle' };
const alerts = [{ key: 'nudge:idle:orchard:T1', severity: 'info', scope: 'wA', project: 'orchard', taskId: 'T1', title: 'Ready work', text: 'Continue task T1.' }];
await engine.deliver(alerts, { panes: [pane] }, now);
await engine.deliver(alerts, { panes: [pane] }, now + 30000);
console.log(JSON.stringify({ rows: readAgentMetadata(), messages: readAgentMessages(), events: engine.events, push: engine.push }));
`;

function run(t, source = probe, input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-communication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nprintf "{}"\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: root, HERDR_BOSS_DIR: path.join(root, 'data'), HERDR_BOSS_LIVE_DIR: path.join(root, 'data'), HERDR_BOSS_ALLOW_ACTIONS: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, AM_NOW: String(NOW), AM_INPUT: JSON.stringify(input) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('service delivery records one nudge with its target and task across repeated ticks', (t) => {
  const { rows, messages, events, push } = run(t);
  assert.equal(rows.length, 1, JSON.stringify({ events, push }));
  assert.equal(rows[0].from.role, 'service');
  assert.equal(rows[0].kind, 'nudge');
  assert.equal(rows[0].project, 'orchard');
  assert.equal(rows[0].to.pane, 'wA:p1');
  assert.equal(rows[0].taskId, 'T1');
  assert.equal(messages[0].status, 'delivered');
  assert.equal(messages[0].text, 'Continue task T1.');
});

test('stale status, kit and idle notices are masked service reminders', (t) => {
  const source = probe.replace("await engine.deliver(alerts, { panes: [pane] }, now);", `
      alerts.splice(0, 1,
        { key: 'status:stale:orchard', severity: 'info', scope: 'wA', text: 'Publish status.' },
        { key: 'kit:update:revision', severity: 'info', scope: 'wA', text: 'Run kit update.' },
        { key: 'workers:stale:wA', severity: 'info', scope: 'wA', text: 'Idle notice. token=abcdefghijk0123456789' });
      await engine.deliver(alerts, { panes: [pane] }, now);`);
  const { rows, messages } = run(t, source);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.kind === 'reminder' && r.from.role === 'service'));
  assert.doesNotMatch(JSON.stringify(messages), /abcdefghijk0123456789/);
});

test('a lease owner notice uses the same service message store', (t) => {
  const source = probe.replace(/await engine\.deliver\(alerts, \{ panes: \[pane\] \}, now\);[\s\S]*?now \+ 30000\);/, `
    await engine.notifyUnleasedOwners([{ owner: 'orchard', pool: 'serve-ports', item: '4567', pid: 1234 }],
      { control: { projects: { orchard: { orch: { pane: pane.id } } } }, panes: [pane] });`);
  const { rows } = run(t, source);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'reminder');
  assert.equal(rows[0].project, 'orchard');
});

test('an error envelope from a service prompt records no delivered row', (t) => {
  const source = probe.replace('const pane =', `engine.herdrRunner = async () => JSON.stringify({ error: { message: 'fixture refused' } });\nconst pane =`);
  const { rows, messages } = run(t, source);
  assert.deepEqual(rows, []);
  assert.deepEqual(messages, []);
});

const responseProbe = `
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
import { readAgentMetadata, tellAgent } from './src/agent-messages.js';
import fs from 'node:fs';
import path from 'node:path';
const input = JSON.parse(process.env.AM_INPUT);
let now = Number(process.env.AM_NOW);
let status = input.initial || 'working';
let unavailable = false;
const pane = () => ({ id: 'wA:p1', workspace: 'wA', orch: true, label: 'orch', agent: 'codex', project: 'orchard', status });
const engine = new Engine(loadConfig(), { push: false, act: true, clock: () => now,
  psRunner: async () => '', gitRunner: async () => '',
  collectors: {
    collectHerdr: async () => { if (unavailable) throw new Error('fixture unavailable'); return { workspaces: [], panes: [pane()] }; },
    collectMachine: async () => null, collectProcesses: async () => new Map(), collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}), collectCwdProcesses: async () => [], collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '', checkHarness: () => [], collectPiModels: async () => null,
  },
});
await engine.promptService('wA:p1', 'A reminder.', { herdr: { panes: [pane()] }, now });
if (input.cacheIdle) engine.state = { herdr: { panes: [{ ...pane(), status: 'idle' }] } };
engine.deliver = async () => {};
engine.attachmentRetentionAt = now;
for (const step of input.steps) {
  now = Number(process.env.AM_NOW) + step.after;
  status = step.status || status;
  unavailable = !!step.unavailable;
  if (step.tell) {
    const p = { pane_id: 'wA:p1', workspace_id: 'wA', label: 'orch' };
    const b = { pane_id: 'wB:p1', workspace_id: 'wB', label: 'boss' };
    const tell = tellAgent('wB:p1', 'I am active.', {
      now, kind: step.tell, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA' }, runs: [],
      control: { projects: { orchard: { slug: 'orchard', workspace: 'wA' } } },
      herdr: (args) => { if (input.tellFails && args[0] === 'agent') throw new Error('fixture failed'); return args[0] === 'pane' ? { pane: args[2] === 'wA:p1' ? p : b } : {}; },
    });
    if (tell.exitCode && !input.tellFails) throw new Error(tell.reason);
  }
  if (step.restart) {
    engine.memory.paneSince = {};
    engine.memory.agentResponseObserved = {};
  }
  if (!step.noTick) await engine.tick();
}
const updates = fs.readFileSync(path.join(process.env.HERDR_BOSS_DIR, 'agent-message-meta.jsonl'), 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(row => row._update === 'respondedAt').length;
console.log(JSON.stringify({ row: readAgentMetadata().find(r => r.from.role === 'service'), events: engine.events, updates }));
`;

test('the engine clock fills response time once when a working target goes idle', (t) => {
  const { row, updates } = run(t, responseProbe, { steps: [{ after: 60000, status: 'idle' }, { after: 120000, status: 'done' }] });
  assert.equal(row.respondedAt, new Date(NOW + 60000).toISOString());
  assert.equal(row.responseMs, 60000);
  assert.equal(updates, 1);
});

test('an initially idle target must become active before idle counts as a response', (t) => {
  const { row } = run(t, responseProbe, { initial: 'idle', steps: [{ after: 30000, status: 'idle' }, { after: 60000, status: 'working' }, { after: 90000, status: 'idle' }] });
  assert.equal(row.responseMs, 90000);
});

test('any delivered tell from the target wins over a later idle observation', (t) => {
  const { row } = run(t, responseProbe, { steps: [{ after: 30000, tell: 'task', noTick: true }, { after: 60000, status: 'idle' }] });
  assert.equal(row.respondedAt, new Date(NOW + 30000).toISOString());
  assert.equal(row.responseMs, 30000);
});

test('the engine leaves rows unanswered after the 24 hour cap', (t) => {
  const { row } = run(t, responseProbe, { steps: [{ after: 86400000, status: 'idle', tell: 'reply' }, { after: 86460000, status: 'idle' }] });
  assert.equal(row.respondedAt, null);
  assert.equal(row.responseMs, null);
});

test('a stale pane snapshot cannot fill an idle response', (t) => {
  const { row } = run(t, responseProbe, { cacheIdle: true, steps: [{ after: 60000, unavailable: true }] });
  assert.equal(row.respondedAt, null);
});

test('a failed tell cannot count as a response from the target', (t) => {
  const { row } = run(t, responseProbe, { tellFails: true, steps: [{ after: 30000, tell: 'reply' }, { after: 60000 }] });
  assert.equal(row.respondedAt, null);
});
