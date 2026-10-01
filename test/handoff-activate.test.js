import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

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
