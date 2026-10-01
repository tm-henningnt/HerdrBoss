import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handoffFixture, runHandoffCli, runHandoffModule } from './helpers/handoff-fixture.js';

const cliPath = new URL('../src/cli.js', import.meta.url).pathname;

function preferClaudeOpus(fixture) {
  const file = path.join(fixture.root, 'policy.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  policy.preferredModels = { ...(policy.preferredModels || {}), claude: 'claude-opus-5-5' };
  fs.writeFileSync(file, JSON.stringify(policy));
}

function runCli(fixture, args, env = fixture.env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.project, env, encoding: 'utf8',
  });
}

function writeRecord(fixture, overrides = {}) {
  const record = {
    id: 'handoff-cancel', sourcePane: 'ws:p1', newPane: 'ws:p2', workspace: 'ws',
    cwd: fixture.project, project: 'project', label: 'orch', toKind: 'claude',
    model: 'claude-sonnet-5-5', mode: 'fresh', automatic: false, status: 'prepared',
    ...overrides,
  };
  fs.writeFileSync(path.join(fixture.root, 'handoffs.json'), JSON.stringify([record]));
  return record;
}

function herdrCalls(fixture) {
  if (!fs.existsSync(fixture.callsFile)) return [];
  return fs.readFileSync(fixture.callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('handoff plan uses the kit default and reports its source despite a preferred Opus model', (t) => {
  const f = handoffFixture(t);
  preferClaudeOpus(f);

  const plan = JSON.parse(runHandoffCli(f.root, ['handoff', 'plan', 'ws:p1', '--to', 'claude', '--mode', 'fresh'], f.env));

  assert.equal(plan.model, 'claude-sonnet-5-5');
  assert.equal(plan.modelSource, 'default');
});

test('handoff plan and prepare refuse every Opus spelling without --force', (t) => {
  const f = handoffFixture(t);
  preferClaudeOpus(f);
  const aliases = ['claude-opus-5-5', 'opus', 'claude-opus'];

  for (const action of ['plan', 'prepare']) for (const alias of aliases) {
    const result = runCli(f, ['handoff', action, 'ws:p1', '--to', 'claude', '--mode', 'fresh', '--model', alias]);
    assert.notEqual(result.status, 0, `${action} ${alias} must be refused`);
    assert.ok(result.stderr.includes(`claude-opus-5-5 needs the Owner's approval. Ask the Owner, then ${action} with --force.`));
  }
});

test('forced Opus prepare records force and alerts the Boss using the worker alert', (t) => {
  const f = handoffFixture(t);
  preferClaudeOpus(f);
  const env = { ...f.env, TEST_BOSS_PANE: 'ws:boss' };
  const planResult = runCli(f, ['handoff', 'plan', 'ws:p1', '--to', 'claude', '--mode', 'fresh', '--model', 'opus', '--force'], env);
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.model, 'claude-opus-5-5');
  assert.equal(plan.modelSource, 'flag');
  assert.equal(plan.force, true);

  const result = runCli(f, ['handoff', 'prepare', 'ws:p1', '--to', 'claude', '--mode', 'fresh', '--model', 'opus', '--force'], env);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, 'prepared');
  assert.equal(record.model, 'claude-opus-5-5');
  assert.equal(record.modelSource, 'flag');
  assert.equal(record.force, true);
  const alert = `Opus worker: ${record.id} runs claude-opus-5-5 (forced).`;
  assert.match(result.stderr, new RegExp(alert.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(herdrCalls(f).some((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'ws:boss' && args[3] === alert));
  const event = JSON.parse(fs.readFileSync(path.join(f.root, 'events.jsonl'), 'utf8').trim());
  assert.equal(event.type, 'worker-opus');
  assert.equal(event.text, alert);
});

test('handoff prepare also uses the kit default when policy prefers Opus', (t) => {
  const f = handoffFixture(t);
  preferClaudeOpus(f);

  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'claude', '--mode', 'fresh'], f.env));

  assert.equal(record.model, 'claude-sonnet-5-5');
  assert.equal(record.modelSource, 'default');
  assert.equal(Object.hasOwn(record, 'force'), false);
});

test('handoff cancel expires a prepared record and closes its idle successor pane', (t) => {
  const f = handoffFixture(t);
  writeRecord(f);

  const result = runCli(f, ['handoff', 'cancel', 'handoff-cancel']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const [record] = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(record.status, 'expired');
  assert.equal(record.expiredReason, 'cancelled');
  assert.ok(Number.isFinite(Date.parse(record.expiredAt)));
  assert.ok(herdrCalls(f).some((args) => args[0] === 'pane' && args[1] === 'close' && args[2] === 'ws:p2'));
});

test('handoff cancel refuses a working successor unless --force is passed', (t) => {
  const f = handoffFixture(t);
  writeRecord(f);
  const env = { ...f.env, TEST_SUCCESSOR_STATUS: 'working' };

  const refused = runCli(f, ['handoff', 'cancel', 'handoff-cancel'], env);

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /successor pane ws:p2 is working.*--force/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
  assert.equal(herdrCalls(f).some((args) => args[0] === 'pane' && args[1] === 'close'), false);

  const forced = runCli(f, ['handoff', 'cancel', 'handoff-cancel', '--force'], env);

  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].expiredReason, 'cancelled');
  assert.ok(herdrCalls(f).some((args) => args[0] === 'pane' && args[1] === 'close' && args[2] === 'ws:p2'));
});

test('handoff cancel refuses active and expired records', (t) => {
  const f = handoffFixture(t);

  for (const status of ['active', 'expired']) {
    writeRecord(f, { status });
    const result = runCli(f, ['handoff', 'cancel', 'handoff-cancel']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`already ${status}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, status);
  }
  assert.equal(herdrCalls(f).some((args) => args[0] === 'pane' && args[1] === 'close'), false);
});

test('a cancelled automatic handoff does not get the 30-minute expiry Mailbox item', (t) => {
  const f = handoffFixture(t);
  writeRecord(f, {
    automatic: true, preparedAt: '2026-10-01T11:00:00.000Z',
  });
  const cancelled = runCli(f, ['handoff', 'cancel', 'handoff-cancel']);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const [record] = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(record.status, 'expired');
  assert.equal(record.expiredReason, 'cancelled');
  const source = `import { Engine } from ${JSON.stringify(new URL('../src/engine.js', import.meta.url).href)};
import { loadConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
const engine = new Engine(loadConfig());
await engine.expireUnreadyHandoffs({ panes: [] }, Date.parse('2026-10-01T12:31:00.000Z'));
console.log(JSON.stringify(engine.messageStore.all().filter((message) => message.handoffExpiryId === 'handoff-cancel')));`;

  const messages = JSON.parse(runHandoffModule(f.root, source, { ...f.env, NODE_TEST_CONTEXT: '' }));

  assert.deepEqual(messages, []);
});
