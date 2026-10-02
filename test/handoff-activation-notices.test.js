import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { activationFixture, handoffFixture, runHandoffCli, runHandoffModule, WORKER_LINE, writeRuns } from './helpers/handoff-fixture.js';

test('a failed worker prompt is logged and never fails the activation', (t) => {
  const f = activationFixture(t, { failPrompts: ['ws:p3'] });
  writeRuns(f, [{ name: 'w1', pane: 'ws:p3', startedAt: '2026-09-30T09:00:00.000Z' }]);
  const { item, warnings } = f.activateWithWarnings();
  assert.equal(item.status, 'active');
  assert.match(item.workerPrompts.w1.error, /Pane not found|pane_not_found/);
  assert.equal(Object.hasOwn(item.workerPrompts.w1, 'at'), false);
  assert.ok(warnings.some((line) => /w1/.test(line) && /ws:p3/.test(line)));
});

test('the workerPrompts record prevents a second prompt to the same worker', (t) => {
  const f = activationFixture(t);
  writeRuns(f, [{ name: 'w1', pane: 'ws:p3', startedAt: '2026-09-30T09:00:00.000Z' }]);
  f.activate();
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  runHandoffModule(f.root, `import { listHandoffs, promptRunningWorkers } from ${JSON.stringify(handoffUrl)};
const item = listHandoffs()[0];
promptRunningWorkers(item);`, f.env);
  const sent = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt' && args[3] === WORKER_LINE).map((args) => args[2]);
  assert.deepEqual(sent, ['ws:p3']);
});

test('a Boss activation prompts no worker', (t) => {
  const f = activationFixture(t, { boss: true });
  writeRuns(f, [{ name: 'w1', pane: 'wb:p3', startedAt: '2026-09-30T09:00:00.000Z' }]);
  const item = f.activate();
  assert.equal(Object.hasOwn(item, 'workerPrompts'), false);
  assert.equal(f.calls().some((args) => args[3] === WORKER_LINE), false);
});

test('migrated activation tells the successor how session-migrate built its session', (t) => {
  const f = activationFixture(t, { record: { mode: 'migrate', requestedMode: undefined, migrationFallbackReason: undefined, migratedId: 'migrated-session' } });
  f.activate();
  assert.match(f.prompts()['ws:p2'], /migrating the claude conversation \(session source-session\) to codex session migrated-session with session-migrate/);
});

test('Boss activation uses Boss and Owner wording for the previous agent', (t) => {
  const f = activationFixture(t, { boss: true });
  f.activate();
  const prompts = f.prompts();
  assert.match(prompts['wb:p2'], /You now control Herdr Boss orchestration/);
  assert.match(prompts['wb:p2'], /previous Boss is pane wb:p1/);
  assert.match(prompts['wb:p2'], /Your pane ID is wb:p2/);
  assert.match(prompts['wb:p1'], /You are no longer the Herdr Boss/);
  assert.match(prompts['wb:p1'], /Pane wb:p2 is the new Boss/);
  assert.match(prompts['wb:p1'], /final summary for the new Boss/);
  assert.match(prompts['wb:p1'], /later request from the Owner or an orchestrator only with: "The Boss is now pane wb:p2\."/);
});

test('a failed previous-agent prompt does not stop activation and stays eligible for retry', (t) => {
  const f = activationFixture(t, { failPrompts: ['ws:p1'] });
  const item = f.activate();
  assert.equal(item.status, 'active');
  assert.match(item.previousPromptError, /Pane not found/);
  assert.ok(f.prompts()['ws:p2']);
});

test('activation with a gone source pane skips the source and activates the successor', (t) => {
  const f = activationFixture(t, { paneErrors: { 'ws:p1': 'pane_not_found' } });
  const item = f.activate();
  assert.equal(item.status, 'active');
  const renames = f.calls().filter((args) => args[0] === 'pane' && args[1] === 'rename');
  assert.deepEqual(renames, [['pane', 'rename', 'ws:p2', 'orch']]);
  const promptTargets = f.calls().filter((args) => args[0] === 'agent' && args[1] === 'prompt').map((args) => args[2]);
  assert.deepEqual(promptTargets, ['ws:p2']);
  const successor = f.prompts()['ws:p2'];
  assert.match(successor, /Your pane ID is ws:p2/);
  assert.match(successor, /previous orchestrator pane ws:p1 was closed before activation/);
  assert.doesNotMatch(successor, /now labeled/);
  assert.doesNotMatch(successor, /null/);
  assert.doesNotMatch(successor, /herdr agent read ws:p1/);
  assert.doesNotMatch(successor, /final summary/);
  assert.deepEqual(item.activation, { at: item.activatedAt, sourcePane: 'ws:p1', successorPane: 'ws:p2', sourceLabel: null, successorLabel: 'orch', sourceMissing: true });
  assert.equal(item.previousPromptSkipped, 'source pane gone');
  assert.equal(Object.hasOwn(item, 'previousPromptError'), false);
  assert.equal(Object.hasOwn(item, 'previousPromptAt'), false);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0];
  assert.equal(stored.status, 'active');
  assert.deepEqual(stored.activation, item.activation);
});

test('activation with a present source pane does not record sourceMissing', (t) => {
  const item = activationFixture(t).activate();
  assert.equal(Object.hasOwn(item.activation, 'sourceMissing'), false);
  assert.equal(Object.hasOwn(item, 'previousPromptSkipped'), false);
});

test('a goal-set warning is included in the project handoff notice', (t) => {
  const f = activationFixture(t);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const item = {
    id: 'handoff-warning', project: 'alpha', workspace: 'ws', sourcePane: 'ws:p1', newPane: 'ws:p2',
    toKind: 'claude', peerPanes: ['ws:p3'],
    goalWarning: { exitCode: 3, message: 'Goal set exited with code 3; the Owner goal is not confirmed in pane ws:p2.' },
  };
  const out = runHandoffModule(f.root, `import { handoffNotices } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(handoffNotices(JSON.parse(process.env.TEST_WARNING_ITEM), [
  { id: 'ws:p3', workspace: 'ws', agent: 'pi' }, { id: 'other:p1', label: 'boss', agent: 'claude' },
])));`, { ...f.env, TEST_WARNING_ITEM: JSON.stringify(item) });
  assert.match(JSON.parse(out)[0].text, /Goal set exited with code 3/);
  assert.match(JSON.parse(out)[1].text, /Goal set exited with code 3/);
});

test('handoff notices wait for goal verification and read the saved warning', (t) => {
  const goal = 'Ship the release safely.';
  const f = activationFixture(t, {
    successorKind: 'claude', goalScreen: '',
    record: { toKind: 'claude', goal, goalSource: 'status' },
  });
  fs.writeFileSync(path.join(f.root, 'policy.json'), JSON.stringify({ goals: { autoCommand: true } }));
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const out = runHandoffModule(f.root, `import { activateHandoff, handoffNotices, listHandoffs } from ${JSON.stringify(handoffUrl)};
const panes = [{ id: 'ws:p3', workspace: 'ws', agent: 'pi' }, { id: 'other:p1', workspace: 'other', label: 'boss', agent: 'claude' }];
let release;
let started;
const waiting = new Promise((resolve) => { started = resolve; });
const activation = activateHandoff('handoff-activate', { confirmed: true, goalSetter: async () => {
  started();
  return new Promise((resolve) => { release = resolve; });
} });
await waiting;
const stale = listHandoffs()[0];
const during = handoffNotices(stale, panes);
release({ outcome: 'busy', attempts: 0 });
await activation;
const after = handoffNotices(stale, panes);
console.log(JSON.stringify({ during, after, saved: listHandoffs()[0].goalWarning }));`, f.env);
  const result = JSON.parse(out);
  assert.deepEqual(result.during, []);
  assert.equal(result.after.length, 2);
  assert.ok(result.after.every((notice) => /Goal set exited with code 2/.test(notice.text)));
  assert.equal(result.saved.exitCode, 2);
});

test('handoff notices proceed when activation goal verification has been pending for five minutes', (t) => {
  const f = activationFixture(t);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const item = {
    id: 'orphan-handoff', project: 'alpha', workspace: 'ws', sourcePane: 'ws:p1', newPane: 'ws:p2', toKind: 'claude',
    status: 'active', activatedAt: '2000-01-01T00:00:00.000Z', goalDelivery: 'command', goal: 'Ship the release safely.',
    peerPanes: ['ws:p3'],
  };
  const out = runHandoffModule(f.root, `import { handoffNotices } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(handoffNotices(JSON.parse(process.env.TEST_WARNING_ITEM), [
  { id: 'ws:p3', workspace: 'ws', agent: 'pi' }, { id: 'other:p1', label: 'boss', agent: 'claude' },
])));`, { ...f.env, TEST_WARNING_ITEM: JSON.stringify(item) });
  const notices = JSON.parse(out);
  assert.equal(notices.length, 2);
  assert.ok(notices.every((notice) => /new orchestrator/.test(notice.text)));
});

test('handoff notices omit a goal warning after the goal is verified', (t) => {
  const f = activationFixture(t);
  const handoffUrl = new URL('../src/handoff.js', import.meta.url).href;
  const item = {
    id: 'orphan-handoff', project: 'alpha', workspace: 'ws', sourcePane: 'ws:p1', newPane: 'ws:p2', toKind: 'claude',
    status: 'active', activatedAt: '2000-01-01T00:00:00.000Z', goalDelivery: 'command', goal: 'Ship the release safely.',
    goalVerifiedAt: '2000-01-01T00:01:00.000Z',
    goalWarning: { message: 'The stale goal warning should not be shown.' }, peerPanes: ['ws:p3'],
  };
  const out = runHandoffModule(f.root, `import { handoffNotices } from ${JSON.stringify(handoffUrl)};
console.log(JSON.stringify(handoffNotices(JSON.parse(process.env.TEST_WARNING_ITEM), [
  { id: 'ws:p3', workspace: 'ws', agent: 'pi' }, { id: 'other:p1', label: 'boss', agent: 'claude' },
])));`, { ...f.env, TEST_WARNING_ITEM: JSON.stringify(item) });
  const notices = JSON.parse(out);
  assert.equal(notices.length, 2);
  assert.ok(notices.every((notice) => !notice.text.includes('stale goal warning')));
});

test('a different Herdr error for the source pane stops activation', (t) => {
  const f = activationFixture(t, { paneErrors: { 'ws:p1': 'internal_error' } });
  assert.throws(() => f.activate(), /internal_error/);
  assert.equal(f.calls().some((args) => args[1] === 'rename' && args[2] === 'ws:p2'), false);
  assert.equal(f.calls().some((args) => args[1] === 'prompt'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
});

test('a failed successor rename with a gone source pane throws without a source rollback', (t) => {
  const f = activationFixture(t, { paneErrors: { 'ws:p1': 'pane_not_found' }, failRenames: ['ws:p2'] });
  assert.throws(() => f.activate(), /rename_failed/);
  const renames = f.calls().filter((args) => args[0] === 'pane' && args[1] === 'rename');
  assert.deepEqual(renames, [['pane', 'rename', 'ws:p2', 'orch']]);
  assert.equal(f.calls().some((args) => args[1] === 'prompt'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'handoffs.json'), 'utf8'))[0].status, 'prepared');
});

test('dashboard and CLI docs describe the activation labels without standby', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const cli = fs.readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
  const confirmLine = app.split('\n').find((line) => line.includes("action === 'activate' && !confirm("));
  assert.match(confirmLine, /becomes orch, and the current pane becomes orch previous/);
  assert.match(confirmLine, /becomes boss, and the current pane becomes boss previous/);
  assert.doesNotMatch(confirmLine, /standby/);
  const help = app.split('\n').find((line) => line.includes('<h3>Project continuity</h3>'));
  assert.match(help, /<b>orch previous<\/b>/);
  assert.match(help, /<b>boss previous<\/b>/);
  assert.match(help, /Boss-workspace peers and the Owner/);
  assert.match(help, /Codex, Pi, and OpenCode get the goal in the successor prompt/);
  assert.match(help, /90-second wait and two attempts/);
  assert.match(help, /handover notice waits for the check/);
  const row = cli.split('\n').find((line) => line.startsWith('| `handoff activate'));
  assert.match(row, /`orch previous`/);
  assert.match(row, /`boss previous`/);
  assert.match(row, /name its agent `<slug>-orch`/);
  assert.match(row, /failed agent rename keeps activation active/);
  assert.match(row, /Codex, Pi, and OpenCode get the goal in the successor prompt/);
  assert.match(row, /90-second wait and two attempts/);
  assert.match(row, /handover notices wait up to five minutes for this check/i);
  assert.doesNotMatch(row, /standby/);
});

test('a successive activation leaves earlier previous-role panes out of its worker peers', (t) => {
  const project = activationFixture(t, { extraPanes: [{ pane_id: 'ws:p0', workspace_id: 'ws', label: 'orch previous', agent: 'claude', agent_status: 'idle' }] });
  assert.deepEqual(project.activate().peerPanes, ['ws:p3']);
  assert.doesNotMatch(project.prompts()['ws:p2'], /ws:p0/);
  const boss = activationFixture(t, { boss: true, extraPanes: [{ pane_id: 'wb:p0', workspace_id: 'wb', label: 'boss previous', agent: 'claude', agent_status: 'idle' }] });
  assert.deepEqual(boss.activate().peerPanes, ['wb:p3']);
});

test('handoff plan prints the kit line to stderr when the project kit is behind', (t) => {
  const f = handoffFixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.project, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(f.project, 'docs', 'orchestration'), { recursive: true });
  const kitFile = path.join(f.project, 'docs', 'orchestration', 'herdr-boss.md');
  const plan = () => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'handoff', 'plan', 'ws:p1', '--to', 'pi', '--mode', 'fresh'], { cwd: f.project, env: f.env, encoding: 'utf8' });
  fs.writeFileSync(kitFile, '<!-- herdr-boss kit v=000000000000 -->\nold body\n');
  const behind = plan();
  assert.equal(behind.status, 0, behind.stderr);
  assert.match(behind.stderr, /^Kit update: this project kit is behind by .* Run herdr-boss kit update\.$/m);
  assert.doesNotThrow(() => JSON.parse(behind.stdout), 'stdout stays JSON');
  fs.rmSync(kitFile);
  const none = plan();
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(none.stderr, /Kit update:/);
});
