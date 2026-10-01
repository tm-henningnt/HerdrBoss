import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, handoffPromptCalls, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

test('fresh capture bounds recent lines and falls back to visible or an unavailable marker', (t) => {
  const longText = Array.from({ length: 250 }, (_, i) => `line ${i} ${'x'.repeat(120)}`).join('\n');
  const f = handoffFixture(t);
  const first = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { ...f.env, TEST_SOURCE_TEXT: longText, TEST_RECENT_FAIL: '1' }));
  assert.match(first.sourceContext, /line 249/);
  assert.doesNotMatch(first.sourceContext, /line 0 /);
  assert.ok(first.sourceContext.length <= 20000);
  assert.ok(first.sourceContext.split('\n').length <= 200);
  assert.match(first.sourceContext, /truncated/i);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1' && args.includes('visible')));

  const g = handoffFixture(t);
  const second = JSON.parse(runHandoffCli(g.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { ...g.env, TEST_RECENT_FAIL: '1', TEST_VISIBLE_FAIL: '1' }));
  assert.match(second.sourceContext, /context unavailable/i);
  const secondCalls = fs.readFileSync(g.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(secondCalls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3], /context unavailable/i);
});

test('the snapshot truncation marker stays inside the 200-line cap', (t) => {
  const shortText = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  const f = handoffFixture(t);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { ...f.env, TEST_SOURCE_TEXT: shortText }));
  const lines = result.sourceContext.split('\n');
  assert.ok(lines.length <= 200, `marker plus context must stay within 200 lines, got ${lines.length}`);
  assert.equal(lines[0], '[Source pane context truncated]');
  assert.match(result.sourceContext, /line 249/);
  assert.doesNotMatch(result.sourceContext, /^line 50$/m);
  assert.ok(result.sourceContext.length <= 20000);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.equal(saved.sourceContext, result.sourceContext);
  assert.ok(saved.sourceContext.split('\n').length <= 200);
  const [prompt] = handoffPromptCalls(f.root);
  assert.ok(prompt.includes(result.sourceContext), 'the record snapshot must reach the prompt unchanged');
  assert.doesNotMatch(prompt, /^line 50$/m);
});

test('missing project goal stays absent and Boss never borrows a project goal', (t) => {
  const f = handoffFixture(t);
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ tasks: [{ title: 'A goal-like task' }], notes: ['goal in a note'] }));
  const noGoal = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(Object.hasOwn(noGoal, 'ownerGoal'), false);
  const g = handoffFixture(t, { sourceLabel: 'boss' });
  fs.mkdirSync(path.join(g.root, 'projects'));
  fs.writeFileSync(path.join(g.root, 'projects', 'Boss.json'), JSON.stringify({ goal: 'Not a Boss goal' }));
  const boss = JSON.parse(runHandoffCli(g.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], g.env));
  assert.equal(Object.hasOwn(boss, 'ownerGoal'), false);
});

function writeProjectGoal(root, goal) {
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', 'project.json'), JSON.stringify({ goal }));
}

test('handoff prepare omits a direct-installed Owner goal over the 1000-character bound', (t) => {
  const goal = 'G'.repeat(1001);
  const f = handoffFixture(t);
  writeProjectGoal(f.root, goal);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(Object.hasOwn(result, 'ownerGoal'), false);
  const saved = fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8');
  assert.equal(saved.includes('G'.repeat(50)), false, 'the invalid goal must not enter the saved record');
  const [prompt] = handoffPromptCalls(f.root);
  assert.equal(prompt.includes('G'.repeat(50)), false, 'the invalid goal must not enter the startup prompt');
  assert.match(prompt, /proposed successor orchestrator/);
});

test('handoff prepare keeps a valid 1000-character Owner goal', (t) => {
  const goal = 'H'.repeat(1000);
  const f = handoffFixture(t);
  writeProjectGoal(f.root, goal);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.ownerGoal, goal);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].ownerGoal, goal);
  assert.ok(handoffPromptCalls(f.root).some((prompt) => prompt.includes(goal)));
});

for (const [name, goal] of [['a non-string', 42], ['a blank', '   '], ['an empty', '']]) test(`handoff prepare omits ${name} direct-installed Owner goal`, (t) => {
  const f = handoffFixture(t);
  writeProjectGoal(f.root, goal);
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(Object.hasOwn(result, 'ownerGoal'), false);
  const saved = fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(saved)[0], 'ownerGoal'), false);
  const [prompt] = handoffPromptCalls(f.root);
  assert.match(prompt, /proposed successor orchestrator/);
  assert.match(prompt, /Discover the project state from files and issues\./);
});

test('handoff prepare applies the Owner goal bound when it resumes a record', (t) => {
  const stored = 'B'.repeat(1001);
  const f = handoffFixture(t, { existingPane: 'ws:p9' });
  writeProjectGoal(f.root, 'Valid published goal');
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-stale-goal', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false, ownerGoal: stored, sourceContext: 'Earlier safe context',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.status, 'prepared');
  assert.equal(result.ownerGoal, 'Valid published goal');
  const saved = fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8');
  assert.equal(saved.includes('B'.repeat(50)), false, 'the invalid stored goal must not stay in the record');
  const [prompt] = handoffPromptCalls(f.root);
  assert.equal(prompt.includes('B'.repeat(50)), false, 'the invalid stored goal must not enter the startup prompt');
  assert.match(prompt, /Valid published goal/);

  const g = handoffFixture(t, { existingPane: 'ws:p9' });
  fs.writeFileSync(path.join(g.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-stale-goal', sourcePane: 'ws:p1', workspace: 'ws', cwd: g.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false, ownerGoal: stored,
  }]));
  const noPublished = JSON.parse(runHandoffCli(g.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], g.env));
  assert.equal(noPublished.status, 'prepared');
  assert.equal(Object.hasOwn(noPublished, 'ownerGoal'), false);
  assert.equal(fs.readFileSync(path.join(g.root, 'handoffs.json'), 'utf8').includes('B'.repeat(50)), false);
  assert.equal(handoffPromptCalls(g.root).some((prompt) => prompt.includes('B'.repeat(50))), false);
});

test('resuming a record preserves its captured Owner goal', (t) => {
  const f = handoffFixture(t, { existingPane: 'ws:p9' });
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ goal: 'Changed later' }));
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-preserved', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false, ownerGoal: 'Original Owner goal', sourceContext: 'Earlier safe context',
  }]));
  const result = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], f.env));
  assert.equal(result.ownerGoal, 'Original Owner goal');
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /Original Owner goal/);
  assert.doesNotMatch(prompt, /Changed later/);
  assert.match(prompt, /Earlier safe context/);
  assert.equal(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1'), false);
});

test('resuming an older fresh fallback record fills missing goal and source context', (t) => {
  const f = handoffFixture(t, { existingPane: 'ws:p9' });
  fs.mkdirSync(path.join(f.root, 'projects'));
  fs.writeFileSync(path.join(f.root, 'projects', 'project.json'), JSON.stringify({ goal: 'Continue the Owner objective.' }));
  fs.writeFileSync(path.join(f.root, 'handoffs.json'), JSON.stringify([{
    id: 'handoff-legacy', sourcePane: 'ws:p1', workspace: 'ws', cwd: f.project,
    project: 'project', toKind: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: null,
    mode: 'fresh', requestedMode: 'migrate', provider: 'claude', migratedId: null, newPane: 'ws:p9',
    status: 'needs-inspection', automatic: false,
  }]));
  const record = JSON.parse(runHandoffCli(f.root, ['handoff', 'prepare', 'ws:p1', '--to', 'pi', '--mode', 'migrate'], { ...f.env, TEST_SOURCE_TEXT: 'Old pane summary' }));
  assert.equal(record.ownerGoal, 'Continue the Owner objective.');
  assert.match(record.sourceContext, /Old pane summary/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[3];
  assert.match(prompt, /Continue the Owner objective/);
  assert.match(prompt, /Old pane summary/);
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'read' && args[2] === 'ws:p1'));
});

test('dashboard offers Prepare after an unavailable migration plan', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\$\{plan\s*\?\s*`<button type="button" data-handoff-prepare=/);
  assert.match(source, /Migration unavailable:[^`]*Prepare will use fresh mode/);
});
