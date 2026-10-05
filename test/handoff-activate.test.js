import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

function enableAutoCommand(f) {
  fs.writeFileSync(path.join(f.root, 'policy.json'), JSON.stringify({ goals: { autoCommand: true } }));
}

test('project activation labels the successor orch and the previous pane orch previous', (t) => {
  const f = activationFixture(t);
  const item = f.activate();
  const renames = f.calls().filter((args) => args[0] === 'pane' && args[1] === 'rename');
  assert.deepEqual(renames, [['pane', 'rename', 'ws:p1', 'orch previous'], ['pane', 'rename', 'ws:p2', 'orch']]);
  assert.equal(f.calls().some((args) => args.includes('standby')), false);
  assert.equal(item.status, 'active');
  assert.ok(Number.isFinite(Date.parse(item.activatedAt)));
  assert.deepEqual(item.activation, { at: item.activatedAt, sourcePane: 'ws:p1', successorPane: 'ws:p2', sourceLabel: 'orch previous', successorLabel: 'orch' });
  assert.equal(item.sourcePane, 'ws:p1');
  assert.equal(item.newPane, 'ws:p2');
  assert.deepEqual(item.peerPanes, ['ws:p3']);
  // The H26 B2 goal and source context stay in the active record.
  assert.equal(item.ownerGoal, 'Ship the release safely.');
  assert.equal(item.sourceContext, 'Earlier safe context');
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.deepEqual(stored.activation, item.activation);
  assert.equal(stored.ownerGoal, 'Ship the release safely.');
});

test('default policy puts a Claude handover goal in the activation prompt and skips goal set', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude', goalScreen: '',
    record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
let goalSetCalls = 0;
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => {
  goalSetCalls += 1;
  return { outcome: 'active' };
} });
console.log(JSON.stringify({ item, goalSetCalls }));`, f.env));
  const successorPrompt = f.prompts()['ws:p2'];
  assert.match(successorPrompt, new RegExp(`The current Owner goal is: ${goal}`));
  assert.doesNotMatch(successorPrompt, /^\/goal/m);
  assert.equal(result.item.goalDelivery, 'prompt');
  assert.ok(result.item.goalSentAt);
  assert.equal(result.item.goalSendingAt, undefined);
  assert.equal(result.goalSetCalls, 0);
  assert.equal(f.calls().some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2'), false);
});

test('activation checks a missing Claude goal with the bounded goal-set wait', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude',
    goalScreen: '',
    record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  enableAutoCommand(f);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
import { readFileSync } from 'node:fs';
let seen;
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async (options) => {
  seen = { ...options, goalSendingAt: JSON.parse(readFileSync(process.env.HERDR_BOSS_DIR + '/handoffs.json', 'utf8'))[0].goalSendingAt };
  return { outcome: 'active', attempts: 1 };
} });
console.log(JSON.stringify({ item, waitMs: seen.waitMs, attempts: seen.attempts, goalSendingAt: seen.goalSendingAt }));`, f.env));
  const calls = f.calls();
  const goalRead = calls.findIndex((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2');
  const goalPrompt = calls.findIndex((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'ws:p2' && args[3] === `/goal ${goal}`);
  assert.ok(goalRead >= 0, 'activation reads the new orchestrator pane');
  assert.equal(result.waitMs, 90_000);
  assert.equal(result.attempts, 2);
  assert.equal(result.item.status, 'active');
  assert.equal(result.item.goalWarning, undefined);
  assert.ok(result.item.goalSentAt);
  assert.ok(result.item.goalVerifiedAt);
  assert.ok(Number.isFinite(Date.parse(result.goalSendingAt)), 'activation saves the send marker before calling goal set');
  assert.equal(goalPrompt, -1, 'the injected goal setter owns the send');
});

test('activation keeps a goal that already shows on the successor pane', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude',
    goalScreen: `Goal: ${goal}`,
    record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  enableAutoCommand(f);
  const item = f.activate();
  assert.equal(f.calls().some((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'ws:p2' && args[3] === `/goal ${goal}`), false);
  assert.ok(item.goalVerifiedAt);
  assert.equal(item.goalWarning, undefined);
});

test('goal-set exit codes 2 and 3 warn without blocking the engine fallback', (t) => {
  const goal = 'Ship the release safely.';
  for (const { outcome, exitCode } of [{ outcome: 'busy', exitCode: 2 }, { outcome: 'unverified', exitCode: 3 }]) {
    const f = activationFixture(t, {
      successorKind: 'claude',
      goalScreen: '',
      record: { toKind: 'claude', goal, goalSource: 'status' },
    });
    enableAutoCommand(f);
    const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
    const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
const warnings = [];
const calls = [];
console.warn = (...args) => warnings.push(args.join(' '));
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async (options) => {
  calls.push({ pane: options.pane, kind: options.kind, goal: options.goal, attempts: options.attempts, waitMs: options.waitMs });
  return JSON.parse(process.env.TEST_GOAL_SET_RESULT);
} });
console.log(JSON.stringify({ item, warnings, calls }));`, {
      ...f.env, TEST_GOAL_SET_RESULT: JSON.stringify({ outcome, attempts: outcome === 'busy' ? 0 : 2 }),
    }));
    assert.equal(result.item.status, 'active');
    assert.deepEqual(result.calls, [{ pane: 'ws:p2', kind: 'claude', goal, attempts: 2, waitMs: 90_000 }]);
    assert.equal(result.item.goalWarning.exitCode, exitCode);
    assert.equal(result.item.goalSentAt, undefined);
    assert.equal(result.item.goalVerifyFailedAt, undefined);
    assert.match(result.warnings.join('\n'), new RegExp(`goal set exited with code ${exitCode}`, 'i'));
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
    assert.equal(stored.goalWarning.exitCode, exitCode);
    assert.equal(stored.goalSentAt, undefined);
    assert.equal(stored.goalVerifyFailedAt, undefined);
  }
});

test('a thrown goal-set check leaves the engine free to send the goal', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude', goalScreen: '', record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  enableAutoCommand(f);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => { throw new Error('fixture setter failure'); } });
console.log(JSON.stringify(item));`, f.env));
  assert.equal(result.status, 'active');
  assert.match(result.goalWarning.message, /did not complete/);
  assert.equal(result.goalSentAt, undefined);
  assert.equal(result.goalVerifyFailedAt, undefined);
});

test('an engine send marker prevents activation from sending a second Claude goal', (t) => {
  const goal = 'Ship the release safely.';
  const sentAt = '2026-10-01T12:00:00.000Z';
  const f = activationFixture(t, {
    successorKind: 'claude', goalScreen: '',
    record: { toKind: 'claude', goal, goalSource: 'status', goalSentAt: sentAt },
  });
  enableAutoCommand(f);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
let setterCalls = 0;
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => { setterCalls += 1; return { outcome: 'active' }; } });
console.log(JSON.stringify({ item, setterCalls }));`, f.env));
  assert.equal(result.setterCalls, 0);
  assert.equal(result.item.goalSentAt, sentAt);
  assert.match(result.item.goalWarning.message, /already sent|engine/i);
  assert.equal(result.item.goalVerifiedAt, undefined);
  assert.equal(f.calls().some((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'ws:p2' && args[3] === `/goal ${goal}`), false);
  assert.equal(f.calls().filter((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2').length, 1);
});

test('prompt-delivery harnesses use the successor prompt without checking or sending /goal', (t) => {
  const goal = 'Ship the release safely.';
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  for (const kind of ['codex', 'pi', 'opencode']) {
    const f = activationFixture(t, { successorKind: kind, goalScreen: '', record: { toKind: kind, goal, goalSource: 'status' } });
    const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
let setterCalls = 0;
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => { setterCalls += 1; return { outcome: 'active' }; } });
console.log(JSON.stringify({ item, setterCalls }));`, f.env));
    assert.equal(result.setterCalls, 0, `${kind} does not call goal set`);
    assert.match(f.prompts()['ws:p2'], new RegExp(goal), `${kind} carries the goal in its successor prompt`);
    assert.equal(f.calls().filter((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2').length, 0, `${kind} does not check the screen`);
    assert.equal(f.calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'ws:p2').length, 1, `${kind} sends only the successor prompt`);
    assert.ok(result.item.goalSentAt);
    assert.equal(result.item.goalVerifiedAt, undefined);
  }
});

test('activation does not restore an intentionally absent goal from ownerGoal', (t) => {
  const f = activationFixture(t, { record: { goal: undefined } });
  const item = f.activate();
  assert.equal(item.ownerGoal, 'Ship the release safely.');
  assert.equal(item.goal, undefined);
  assert.equal(item.goalSentAt, undefined);
  assert.doesNotMatch(f.prompts()['ws:p2'], /The current Owner goal is: Ship the release safely\./);
  assert.equal(f.calls().filter((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p2').length, 0);
});

test('goal verification patches the latest handoff and preserves engine and peer writes', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude', goalScreen: '', record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  enableAutoCommand(f);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  runHandoffModule(f.root, `import fs from 'node:fs';
import path from 'node:path';
import { activateHandoff } from ${JSON.stringify(handoffUrl)};
const file = path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json');
const item = await activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => {
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  records[0].goalSentAt = 'engine-send-at';
  records[0].goalVerifyAttempts = 2;
  records[0].goalVerifyFailedAt = 'engine-failed-at';
  records[0].finish.confirmedAt = 'engine-confirmed-at';
  records.push({ id: 'concurrent-other', status: 'active' });
  fs.writeFileSync(file, JSON.stringify(records));
  return { outcome: 'active', attempts: 1 };
} });
console.log(JSON.stringify(item));`, f.env);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(stored[0].goalSentAt, 'engine-send-at');
  assert.equal(stored[0].goalVerifyAttempts, 2);
  assert.equal(stored[0].goalVerifyFailedAt, 'engine-failed-at');
  assert.equal(stored[0].finish.confirmedAt, 'engine-confirmed-at');
  assert.equal(stored[1].id, 'concurrent-other');
  assert.ok(stored[0].goalVerifiedAt);
});

test('activation plans the early close and expires a second successor for the same source', (t) => {
  const sibling = { id: 'handoff-sibling', sourcePane: 'ws:p1', newPane: 'ws:p5', workspace: 'ws', status: 'prepared', automatic: true };
  const f = activationFixture(t, { priorRecords: [sibling] });
  const item = f.activate();
  assert.equal(item.finish.plannedAt, new Date(Date.parse(item.activatedAt) + 15 * 60 * 1000).toISOString());
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  const other = stored.find((x) => x.id === 'handoff-sibling');
  assert.equal(other.status, 'expired');
  assert.match(other.expiredReason, /handoff-activate/);
});

test('project activation clears the stable orchestrator name before it names the successor', (t) => {
  const f = activationFixture(t, { agentNames: [{ pane_id: 'ws:p1', name: 'alpha-orch' }] });
  f.activate();
  const renames = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'rename');
  assert.deepEqual(renames, [
    ['agent', 'rename', 'ws:p1', '--clear'],
    ['agent', 'rename', 'ws:p2', 'alpha-orch'],
  ]);
});

test('Boss activation names its successor boss and clears that name from the source first', (t) => {
  const f = activationFixture(t, { boss: true, agentNames: [{ pane_id: 'wb:p1', name: 'boss' }] });
  f.activate();
  const renames = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'rename');
  assert.deepEqual(renames, [
    ['agent', 'rename', 'wb:p1', '--clear'],
    ['agent', 'rename', 'wb:p2', 'boss'],
  ]);
});

test('a failed stable agent rename warns with the manual command and keeps activation active', (t) => {
  const f = activationFixture(t, { failAgentRenames: ['ws:p2'] });
  const { item, warnings } = f.activateWithWarnings();
  assert.equal(item.status, 'active');
  assert.match(warnings.join('\n'), /Warning:.*herdr agent rename ws:p2 alpha-orch/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'active');
});

test('activation supersedes the earlier handoff from the successor source pane in the same save', (t) => {
  const previous = {
    id: 'handoff-previous', project: 'alpha', workspace: 'ws', label: 'orch', boss: false,
    sourcePane: 'ws:p0', newPane: 'ws:p1', status: 'active', activatedAt: '2026-09-27T09:00:00.000Z',
  };
  const f = activationFixture(t, { priorRecords: [previous] });
  const activated = f.activate();
  const records = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(records[0].status, 'superseded');
  assert.equal(records[0].supersededBy, activated.id);
  assert.equal(records[0].supersededAt, activated.activatedAt);
  assert.equal(records[1].status, 'active');
});

test('Boss activation labels the successor boss and the previous pane boss previous', (t) => {
  const f = activationFixture(t, { boss: true });
  const item = f.activate();
  const renames = f.calls().filter((args) => args[0] === 'pane' && args[1] === 'rename');
  assert.deepEqual(renames, [['pane', 'rename', 'wb:p1', 'boss previous'], ['pane', 'rename', 'wb:p2', 'boss']]);
  assert.deepEqual(item.activation, { at: item.activatedAt, sourcePane: 'wb:p1', successorPane: 'wb:p2', sourceLabel: 'boss previous', successorLabel: 'boss' });
  assert.equal(Object.hasOwn(item, 'ownerGoal'), false);
});

test('activation keeps its confirmation and readiness checks', (t) => {
  const f = activationFixture(t, { record: { newPane: 'ws:p3' , toKind: 'pi' } });
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  assert.throws(() => runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)}; activateHandoff('handoff-activate');`, { ...process.env, HOME: f.root, HERDR_BOSS_DIR: f.root }), /--confirmed/);
  assert.throws(() => f.activate(), /not settled and ready/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
});

test('activation promotes a preparing record when its successor pane is idle and matches the kind', (t) => {
  const f = activationFixture(t, { record: { status: 'preparing' } });
  const item = f.activate();
  assert.equal(item.status, 'active');
  assert.equal(item.activation.successorLabel, 'orch');
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
  assert.equal(stored.find((x) => x.id === 'handoff-activate').status, 'active');
});

test('activation refuses a preparing record whose successor works, is absent, or runs another kind', (t) => {
  const cases = [
    { status: 'preparing', newPane: 'ws:p3', toKind: 'pi' },
    { status: 'preparing', newPane: 'ws:p9' },
    { status: 'preparing', newPane: 'ws:p3', toKind: 'codex' },
  ];
  for (const record of cases) {
    const f = activationFixture(t, { record });
    assert.throws(() => f.activate(), /not settled and ready/);
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'));
    assert.equal(stored[0].status, 'preparing', 'a refused activation leaves the record preparing');
    assert.equal(f.calls().some((args) => args[0] === 'pane' && args[1] === 'rename'), false);
  }
});

// K27: the preparing guard accepts a settled pane, so a done successor activates like an idle one.
test('activation accepts a done successor for a preparing record and keeps the prepared settled rule', (t) => {
  const extraPanes = [{ pane_id: 'ws:p8', workspace_id: 'ws', label: null, agent: 'codex', agent_status: 'done' }];
  const preparing = activationFixture(t, { extraPanes, record: { status: 'preparing', newPane: 'ws:p8' } });
  assert.equal(preparing.activate().status, 'active');
  assert.equal(JSON.parse(fs.readFileSync(path.join(preparing.root, 'handoffs.json'), 'utf8'))[0].status, 'active');
  // The prepared path still treats idle and done as settled.
  const prepared = activationFixture(t, { extraPanes, record: { status: 'prepared', newPane: 'ws:p8' } });
  assert.equal(prepared.activate().status, 'active');
});

test('forced context activation refuses a handoff whose memory update timed out', (t) => {
  const f = activationFixture(t, { record: { memoryUpdateStatus: 'not-updated' } });
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const result = JSON.parse(runHandoffModule(f.root, `import { activateHandoff } from ${JSON.stringify(handoffUrl)};
let error = null;
try { await activateHandoff('handoff-activate', { confirmed: true }); }
catch (failure) { error = failure.message; }
console.log(JSON.stringify({ error, record: JSON.parse((await import('node:fs')).readFileSync(process.env.HERDR_BOSS_DIR + '/handoffs.json', 'utf8'))[0] }));`, f.env));
  assert.match(result.error, /memory\.md.*commit/i);
  assert.equal(result.record.status, 'prepared');
  assert.equal(result.record.memoryUpdateStatus, 'not-updated');
  assert.equal(fs.existsSync(path.join(f.root, 'herdr-calls.jsonl')), false, 'activation stops before any Herdr command');
});

test('forced context activation waits while the source orchestrator works', (t) => {
  const f = activationFixture(t, { record: { memoryUpdateStatus: 'committed' }, sourceStatus: 'working' });
  assert.throws(() => f.activate(), /source orchestrator is working/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
  assert.equal(f.calls().some((args) => args[0] === 'pane' && args[1] === 'rename'), false);
});

test('handoff activate CLI waits for the activation result', (t) => {
  const f = activationFixture(t);
  const item = JSON.parse(runHandoffCli(f.root, ['handoff', 'activate', 'handoff-activate', '--confirmed'], f.env));
  assert.equal(item.status, 'active');
  assert.equal(item.id, 'handoff-activate');
});

test('project activation prompts the successor and the previous agent with both pane IDs', (t) => {
  const f = activationFixture(t);
  const item = f.activate();
  const prompts = f.prompts();
  const successor = prompts['ws:p2'];
  assert.match(successor, /Your pane ID is ws:p2/);
  assert.match(successor, /previous orchestrator is pane ws:p1/);
  assert.match(successor, /orch previous/);
  assert.match(successor, /started your session fresh as codex \(gpt-6-luna, xhigh\) because session migration was unavailable/);
  assert.match(successor, /redacted, bounded snapshot of the source pane and the current Owner goal/);
  assert.match(successor, /final summary/);
  assert.match(successor, /herdr agent read ws:p1/);
  assert.match(successor, /Take over the current work/);
  assert.match(successor, /obey the holds and freezes in docs\/orchestration\/memory\.md/i);
  assert.match(successor, /Use your pane ID ws:p2 in worker briefs, worker reports, and messages/);
  assert.match(successor, /ws:p3/);
  const previous = prompts['ws:p1'];
  assert.match(previous, /no longer own orchestration of alpha/);
  assert.match(previous, /Pane ws:p2 is the new orchestrator/);
  assert.match(previous, /concise final summary for the successor/);
  assert.match(previous, /reply to every later request only with: "The alpha orchestrator is now pane ws:p2\."/);
  assert.doesNotMatch(previous, /standby/i);
  assert.ok(item.previousPromptAt);
  assert.equal(Object.hasOwn(item, 'previousPromptError'), false);
  const order = f.calls().filter((args) => args[1] === 'prompt').map((args) => args[2]);
  assert.deepEqual(order, ['ws:p1', 'ws:p2']);
});

test('activation prompts each running worker once with the new orchestrator line', (t) => {
  const f = activationFixture(t);
  writeRuns(f, [
    { name: 'w1', pane: 'ws:p3', startedAt: '2026-09-30T09:00:00.000Z' },
    { name: 'w-gone', pane: 'ws:p8', startedAt: '2026-09-30T09:00:00.000Z' },
    { name: 'w-done', pane: 'ws:p4', startedAt: '2026-09-30T09:00:00.000Z', finishedAt: '2026-09-30T09:30:00.000Z' },
  ]);
  const item = f.activate();
  const workerPrompts = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt' && args[3] === WORKER_LINE);
  assert.deepEqual(workerPrompts.map((args) => args[2]), ['ws:p3']);
  assert.deepEqual(Object.keys(item.workerPrompts), ['w1']);
  assert.equal(item.workerPrompts.w1.pane, 'ws:p3');
  assert.ok(item.workerPrompts.w1.at);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.deepEqual(stored.workerPrompts, item.workerPrompts);
});
