import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAgentsExclude, contextTokensFor, globMatches, loadModels, loadProjectConfig, PROJECT_DEFAULTS, workerConfigView } from '../src/kit/config.js';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, readDelegatedRuns, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from '../src/kit/orchestration.js';
import { buildGhArgs } from '../src/kit/gh.js';
import { formatKitDigest, runKitCommand } from '../src/kit/cli.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, filterCollectProcesses, listWorkers, parseWorktreeCwdProcesses, renderBrief, startWorker, waitForAgentReady, waitForWorkerPane } from '../src/kit/workers.js';
import { enableModel, markModelUnavailable } from '../src/kit/model-unavailable.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';
import { withMutationLock } from '../src/kit/locks.js';
import { withOpenCodeStartLock } from '../src/kit/opencode-start.js';
import { usageProvider, validateUsage } from '../src/usage.js';
import { DATA_DIR } from '../src/config.js';
import { readAgentMessages, workerRunId } from '../src/agent-messages.js';
import { validateProject } from '../src/projects.js';
import { Engine } from '../src/engine.js';
import { renderBulletin } from '../src/rules.js';
import { readWorkerFacts, gitIsMerged } from '../src/task-state.js';
import { kitRevision, parseKitImpact, projectKit, readKitChanges, kitChangesSince } from '../src/kit/agents-check.js';
import { ALL_READY_SCREENS, CLAUDE_READY_SCREEN, CODEX_READY_SCREEN, git, setupFixture, temporaryRepo, TEST_HOME, tiers, validReport, validRun } from './helpers/kit-fixture.js';

test('worker collect --record uses the provider recorded at start, including null routes', () => {
  for (const [name, route, expected, failUsage, modelResult] of [['collect-routed', 'claude', 'claude', false, 'rework'], ['collect-free', null, null, false, null], ['collect-failure', 'claude', 'claude', true, null]]) {
    const f = setupFixture(null);
    const model = 'gpt-6-luna';
    fs.writeFileSync(f.rulesFile, JSON.stringify({ policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { [model]: route } } }));
    git(f.root, 'add', '-A');
    git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
    const run = startWorker(name, { kind: 'codex', model, task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    });
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${name}.json`], commands: ['focused check'],
      evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
    }));
    const changedPolicy = { modelProviders: { [model]: 'opencodego' } };
    const usage = [];
    const output = [];
    const collect = () => collectWorker(name, { record: true, outcome: 'done', gatePassed: true, ...(modelResult ? { modelResult } : {}) }, {
      config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: (line) => output.push(line),
      listWorktreeProcesses: () => [],
      recordUsageFn: (event) => {
        usage.push({ ...event, recordedProvider: usageProvider(event, changedPolicy) });
        if (failUsage) throw new Error('usage write failed');
        return { errors: [], duplicate: false };
      },
    });
    if (failUsage) {
      assert.throws(collect, /usage write failed/);
      assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).finishedAt, undefined);
      assert.equal(fs.existsSync(f.config.ledgerPath), false);
      continue;
    }
    collect();
    // npm test shares one data directory between test files. Other files add newer messages, and the default limit of 100 hides this older report.
    const agentReport = readAgentMessages({ dir: DATA_DIR, limit: Infinity }).find((item) => item.runId === workerRunId(run, f.config.slug));
    assert.equal(agentReport?.agentKind, 'report', 'worker collect records one agent report');
    assert.equal(agentReport?.status, 'recorded');
    assert.equal(agentReport?.text, 'Done.\n');
    const savedRun = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
    assert.equal(savedRun.provider, expected);
    assert.equal(savedRun.finishedAt, '2026-09-25T17:00:00.000Z');
    assert.equal(usage[0].provider, expected);
    assert.equal(usage[0].recordedProvider, expected ?? 'unmetered-or-unknown');
    assert.equal(usage[0].modelOutcome.result, modelResult || 'first-time');
    const modelOutcomeWarnings = output.filter((line) => line.startsWith('Warning: report.json has no modelOutcome;'));
    assert.deepEqual(modelOutcomeWarnings, modelResult ? [] : ['Warning: report.json has no modelOutcome; recorded first-time from the outcome. Add --model-result next time.']);
    assert.equal(fs.readFileSync(f.config.ledgerPath, 'utf8').trim().split('\n').length, 1);
    assert.ok(output.includes('After you review this collection, remove the worktree with herdr-boss worktree prune --apply'));
    assert.throws(() => collect(), /already marked finished/);
  }
});

test('worker collection, ledger append, and ledger check preserve unknown tool calls as null', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('collect-unknown-tools', {
    kind: 'codex', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true,
  }, { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Tool-call count is unknown.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null,
    branch: run.branch,
    worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'],
    evidenceTier: ['unit'],
    unverified: [],
    stoppedEarly: false,
    usage: { toolCalls: null },
  }));
  collectWorker('collect-unknown-tools', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config,
    now: Date.parse('2026-09-25T17:00:00Z'),
    output: () => {},
    listWorktreeProcesses: () => [],
    recordUsageFn: () => ({ errors: [], duplicate: false }),
  });
  const collected = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
  assert.equal(collected[0].toolCalls, null);

  const manual = { ...validRun, issue: null, worktree: path.join(f.root, 'manual-run'), toolCalls: null };
  const entryFile = path.join(f.root, 'manual-run.json');
  fs.writeFileSync(entryFile, JSON.stringify(manual));
  runKitCommand('ledger', ['append', '--entry', entryFile], { config: f.config, output: () => {} });
  const output = [];
  const checked = runKitCommand('ledger', ['check'], { config: f.config, output: (line) => output.push(line) });
  assert.equal(checked.length, 2);
  assert.ok(checked.every((entry) => entry.toolCalls === null));
  assert.deepEqual(output, [`ledger: PASS (${checked.length} entries)`]);
});

test('worker start records a real dispatch before prompting and verifies activity', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'read') return { text: CODEX_READY_SCREEN };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'prompt') {
      assert.ok(fs.existsSync(path.join(config.runsPath, 'demo.json')));
      assert.deepEqual(args.slice(-3), ['--wait', '--timeout', '20000']);
      return {};
    }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(result.pane, 'ws:p2');
  assert.ok(calls.some((args) => args[0] === 'agent' && args[1] === 'prompt'));
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Worker demo: x\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.\n\nIn a Codex shell, run `setopt NO_BG_NICE` before a background command.\nReport a failing tool, a missing file, or missing evidence explicitly in your report. Never give a best guess in place of a result. The orchestrator verifies each claim at the source.\n\nStop it with `herdr-boss worker stop-own demo --pid <pid>`. Never run `kill`, `pkill`, `killall`, or `kill` with a name pattern such as `kill $(pgrep …)`.\n\nCodex worker commit rule: do not run `git add` or `git commit`. Leave the change in the working tree. Say in your report that the change is uncommitted. The orchestrator commits the change with `herdr-boss worker commit demo -m MESSAGE`.');
});

test('worker start warns about unplanned work and suggests the best matching published task, including in dry-run', () => {
  const f = setupFixture(null);
  const projectStatus = { tasks: [
    { id: 'BD1c', title: 'Worker warning from task text' },
    { id: 'BD1e', title: 'Status notice' },
    { id: 'BD1d', title: 'Update status notice timing' },
  ] };
  const lines = [];
  const start = (name, options) => startWorker(name, {
    kind: 'codex', allow: ['src/'], ...options,
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile,
    projectStatus, output: (line) => lines.push(line),
  });

  start('unplanned-live', { task: 'Update the status notice timing.' });
  assert.ok(lines.includes('No --task-id: the project board shows this worker as Unplanned work.'));
  assert.ok(lines.includes('Suggested: --task-id BD1d (Update status notice timing)'));
  assert.ok(fs.existsSync(path.join(f.config.runsPath, 'unplanned-live.json')), 'the warning does not stop the start');

  lines.length = 0;
  start('unplanned-dry', { task: 'Update the status notice timing.', dryRun: true });
  assert.ok(lines.includes('No --task-id: the project board shows this worker as Unplanned work.'));
  assert.ok(lines.includes('Suggested: --task-id BD1d (Update status notice timing)'));

  lines.length = 0;
  start('one-token-match', { task: 'Fix timing.', dryRun: true });
  assert.ok(lines.includes('No --task-id: the project board shows this worker as Unplanned work.'));
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'one shared token is not enough');

  lines.length = 0;
  start('exact-id-match', { task: 'Please check BD1c in the status.', dryRun: true });
  assert.ok(lines.includes('Suggested: --task-id BD1c (Worker warning from task text)'), 'an exact task ID is enough');

  const taskFile = path.join(f.root, 'worker-warning.md');
  fs.writeFileSync(taskFile, 'Unrelated file contents do not set the suggestion.');
  lines.length = 0;
  start('task-file-name-match', { taskFile, dryRun: true });
  assert.ok(lines.includes('Suggested: --task-id BD1c (Worker warning from task text)'), 'the task-file base name is matched');
});

test('worker task suggestions ignore stopwords and tokens shorter than three characters', () => {
  const f = setupFixture(null);
  const lines = [];
  const start = (name, task, tasks) => startWorker(name, {
    kind: 'codex', allow: ['src/'], task, dryRun: true,
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile,
    projectStatus: { tasks }, output: (line) => lines.push(line),
  });

  start('stopword-only', 'Add the fix test tests docs and for with task from into', [
    { id: 'S-1', title: 'Add the fix test tests docs and for with task from into' },
  ]);
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'stopwords cannot create a match');

  lines.length = 0;
  start('short-token-only', 'UI QA UX', [{ id: 'AB-2', title: 'UI QA UX' }]);
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'tokens shorter than three characters cannot create a match');
});

test('worker task suggestions skip done tasks and do not suggest tied best matches', () => {
  const f = setupFixture(null);
  const lines = [];
  const start = (name, task, tasks) => startWorker(name, {
    kind: 'codex', allow: ['src/'], task, dryRun: true,
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile,
    projectStatus: { tasks }, output: (line) => lines.push(line),
  });

  start('done-task', 'Refresh the status panel', [
    { id: 'DONE-1', title: 'Refresh status panel', status: 'done' },
  ]);
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'done tasks are ineligible');

  lines.length = 0;
  start('tied-tasks', 'Refresh status panel store', [
    { id: 'ID-11', title: 'Refresh status panel' },
    { id: 'ID-22', title: 'Refresh status store' },
  ]);
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'a tie for the best score has no suggestion');
});

test('worker task ID suggestions need a whole-word ID of at least two characters', () => {
  const f = setupFixture(null);
  const tasks = [
    { id: 'BD1c', title: 'Unrelated published work' },
    { id: 'A', title: 'Another unrelated task' },
    { id: 'A1', title: 'Short explicit identifier' },
  ];
  const lines = [];
  const start = (name, task) => startWorker(name, {
    kind: 'codex', allow: ['src/'], task, dryRun: true,
  }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile,
    projectStatus: { tasks }, output: (line) => lines.push(line),
  });

  start('embedded-id', 'Please inspect XBD1cY before continuing');
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'an ID inside a longer word is not an exact match');

  lines.length = 0;
  start('one-character-id', 'A');
  assert.equal(lines.some((line) => line.startsWith('Suggested:')), false, 'one-character IDs cannot be exact matches');

  lines.length = 0;
  start('two-character-id', 'Please inspect A1 before continuing');
  assert.ok(lines.includes('Suggested: --task-id A1 (Short explicit identifier)'), 'a whole-word ID with two characters can match exactly');
});

test('worker collect keeps changed paths stable after the base branch merges the worker', () => {
  const f = setupFixture(null);
  const baseCommit = git(f.root, 'rev-parse', 'main');
  const run = startWorker('stable-base', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const runRecord = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.equal(runRecord.base, 'main');
  assert.equal(runRecord.baseCommit, baseCommit);
  fs.mkdirSync(path.join(run.worktree, 'src'));
  fs.writeFileSync(path.join(run.worktree, 'src', 'change.js'), 'export const changed = true;\n');
  git(run.worktree, 'add', 'src/change.js');
  git(run.worktree, 'commit', '-m', 'worker change');
  const reportDir = path.join(run.worktree, '.worker');
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: ['src/change.js'],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const collect = () => collectWorker('stable-base', { noRecord: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  });
  const beforeMerge = collect();
  git(f.root, 'merge', '--ff-only', run.branch);
  const afterMerge = collect();
  assert.deepEqual(beforeMerge.actualPaths, ['src/change.js']);
  assert.deepEqual(afterMerge.actualPaths, beforeMerge.actualPaths);
});

test('worker collect ignores paths that arrived only because the worker merged main', () => {
  const f = setupFixture(null);
  const run = startWorker('merged-main', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  fs.mkdirSync(path.join(run.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(run.worktree, 'src', 'change.js'), 'export const changed = true;\n');
  git(run.worktree, 'add', 'src/change.js');
  git(run.worktree, 'commit', '-m', 'worker change');
  // The base branch advances with a file outside the worker scope. The worker merges it, so the diff against the base commit lists it.
  fs.mkdirSync(path.join(f.root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'docs', 'main-only.md'), 'main only\n');
  git(f.root, 'add', 'docs/main-only.md');
  git(f.root, 'commit', '-m', 'main change');
  git(run.worktree, 'merge', 'main', '-m', 'merge main');
  const reportDir = path.join(run.worktree, '.worker');
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: ['src/change.js'],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const summary = collectWorker('merged-main', { noRecord: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  });
  assert.deepEqual(summary.actualPaths, ['src/change.js']);
  assert.deepEqual(summary.reportedPaths, ['src/change.js']);
  assert.deepEqual(summary.outOfScope, []);
});

test('worker collect names every accepted evidence tier when evidence is empty', () => {
  const f = setupFixture(null);
  f.config.evidenceTiers = ['unit', 'local-browser', 'live-service', 'owner'];
  const run = startWorker('collect-empty-evidence', {
    kind: 'codex', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true,
  }, { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'No evidence was reported.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [],
    commands: ['focused check'], evidenceTier: [], unverified: [], stoppedEarly: false,
  }));

  assert.throws(() => collectWorker('collect-empty-evidence', { noRecord: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  }), /Invalid worker report:\n- evidenceTier must not be empty\.\n- Accepted evidence tiers:\n- The "unit" tier is accepted\.\n- The "local-browser" tier is accepted\.\n- The "live-service" tier is accepted\.\n- The "owner" tier is accepted\./);
});

// The kit rewrites its own files in a worker worktree. The collect scope check must ignore them.
const KIT_FIXTURE_FILES = ['docs/orchestration/herdr-boss.md', 'docs/orchestration/memory.md', 'AGENTS.md', '.claude/settings.json'];

function setupKitPathFixture(name) {
  const f = setupFixture(null);
  const worktreeRoot = path.join(f.root, '.wt');
  for (const relative of KIT_FIXTURE_FILES) {
    const file = path.join(f.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'seed\n');
  }
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({
    briefTemplate: f.config.briefTemplatePath, setup: null, worktreeRoot,
  }));
  const config = loadProjectConfig({ cwd: f.root });
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-m', 'fixture files');
  const run = startWorker(name, { kind: 'codex', task: 'x', readOnly: true }, {
    config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.deepEqual(run.allowedPaths, ['.worker/**'], `${name} must use an empty allow list`);
  const writeReport = (changedPaths) => {
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Status: done\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: null, branch: run.branch, worktree: run.worktree, changedPaths,
      commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
    }));
  };
  const writeChange = (relative, allow) => {
    const file = path.join(run.worktree, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'changed\n');
    if (allow) { git(run.worktree, 'add', relative); git(run.worktree, 'commit', '-m', 'worker change'); }
  };
  const clean = () => {
    git(f.root, 'worktree', 'remove', '--force', run.worktree);
    fs.rmSync(f.root, { recursive: true, force: true });
  };
  return { f, config, run, writeReport, writeChange, clean };
}

test('worker collect ignores a kit-managed change with an empty allow list', (t) => {
  const kitPaths = ['docs/orchestration/herdr-boss.md', 'AGENTS.md', '.claude/settings.json'];
  for (const [index, relative] of kitPaths.entries()) {
    const name = `kit-path-${index}`;
    const kit = setupKitPathFixture(name);
    t.after(kit.clean);
    kit.writeChange(relative, true);
    kit.writeReport([relative]);
    const summary = collectWorker(name, { noRecord: true }, { config: kit.config, output: () => {}, listWorktreeProcesses: () => [] });
    assert.deepEqual(summary.actualPaths, [], `${relative} must not count as a changed path`);
    assert.deepEqual(summary.reportedPaths, [], `${relative} must not count as a reported path`);
  }
});

test('worker collect still refuses a change to a path next to a kit-managed path', (t) => {
  const kit = setupKitPathFixture('kit-path-refusal');
  t.after(kit.clean);
  kit.writeChange('docs/orchestration/memory.md', true);
  kit.writeReport(['docs/orchestration/memory.md']);
  assert.throws(() => collectWorker('kit-path-refusal', { noRecord: true }, {
    config: kit.config, output: () => {}, listWorktreeProcesses: () => [],
  }), /outside its allowed scope: docs\/orchestration\/memory\.md/);
});

test('worker collect checks the product paths next to an ignored kit path', (t) => {
  const kit = setupKitPathFixture('kit-path-mixed');
  t.after(kit.clean);
  kit.run.allowedPaths.push('src/');
  fs.writeFileSync(kit.run.recordFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(kit.run.recordFile, 'utf8')), allowedPaths: kit.run.allowedPaths }));
  kit.writeChange('AGENTS.md', true);
  kit.writeChange('src/change.js', true);
  kit.writeReport(['AGENTS.md', 'src/change.js']);
  const summary = collectWorker('kit-path-mixed', { noRecord: true }, { config: kit.config, output: () => {}, listWorktreeProcesses: () => [] });
  assert.deepEqual(summary.reportedPaths, ['src/change.js']);
  assert.deepEqual(summary.actualPaths, ['src/change.js']);
  assert.deepEqual(summary.outOfScope, []);
});

test('worker collect --record refuses invalid reports and scopes without printing a success summary', () => {
  const cases = [
    { name: 'collect-scope-refusal', changedPath: 'docs/outside.md', allowedPaths: ['src/', '.orchestration/runs/'], reportPaths: ['docs/outside.md'], error: /outside its allowed scope/ },
    { name: 'collect-report-branch-refusal', changedPath: null, reportPatch: { branch: 'other' }, error: /Report branch other does not match/ },
    { name: 'collect-report-worktree-refusal', changedPath: null, reportPatch: { worktree: '/missing/worktree' }, error: /does not match run worktree/ },
    { name: 'collect-report-issue-refusal', issue: 74, reportPatch: { issue: 75 }, error: /Report issue 75 does not match run issue 74/ },
    { name: 'collect-branch-refusal', changedPath: null, branchMismatch: true, error: /Worktree branch other does not match run branch main/ },
    { name: 'collect-process-refusal', changedPath: null, leftover: true, error: /still has processes in its worktree/ },
  ];

  for (const scenario of cases) {
    const f = setupFixture(null);
    git(f.root, 'add', '-A');
    git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
    const run = startWorker(scenario.name, {
      kind: 'codex', task: 'x', allow: scenario.allowedPaths ?? ['src/', '.orchestration/runs/'], noWorktree: true,
      ...(scenario.issue == null ? {} : { issue: scenario.issue }),
    }, { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
    if (scenario.changedPath) {
      const changedFile = path.join(run.worktree, scenario.changedPath);
      fs.mkdirSync(path.dirname(changedFile), { recursive: true });
      fs.writeFileSync(changedFile, 'changed\n');
      git(run.worktree, 'add', scenario.changedPath);
      git(run.worktree, 'commit', '-m', 'worker change');
    }
    if (scenario.branchMismatch) git(run.worktree, 'checkout', '-b', 'other');
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Partial result.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: scenario.issue ?? null,
      branch: run.branch,
      worktree: run.worktree,
      changedPaths: scenario.reportPaths ?? (scenario.changedPath ? [scenario.changedPath] : []),
      commands: ['focused check'],
      evidenceTier: ['unit'],
      unverified: [],
      stoppedEarly: true,
      ...scenario.reportPatch,
    }));
    const output = [];
    assert.throws(() => collectWorker(scenario.name, { record: true, outcome: 'partial', gatePassed: true }, {
      config: f.config,
      output: (line) => output.push(line),
      listWorktreeProcesses: scenario.leftover
        ? () => [{ pid: 100, ppid: 1, command: 'node', cwd: run.worktree }]
        : () => [],
      recordUsageFn: () => ({ errors: [], duplicate: false }),
    }), (error) => {
      assert.match(error.message, /^worker collect: no ledger entry written: /);
      assert.match(error.message, scenario.error);
      return true;
    }, scenario.name);
    assert.deepEqual(output, [], `${scenario.name} must not print a success summary or warning`);
    assert.equal(fs.existsSync(f.config.ledgerPath), false, `${scenario.name} must not write a ledger entry`);
    if (run.worktree !== f.root) git(f.root, 'worktree', 'remove', '--force', run.worktree);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('worker collect records the branch diff when report.json omits an allowed changed path', (t) => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('collect-omitted-path', { kind: 'codex', task: 'x', allow: ['src/', '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  t.after(() => {
    if (run.worktree !== f.root) git(f.root, 'worktree', 'remove', '--force', run.worktree);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(run.worktree, 'src'));
  fs.writeFileSync(path.join(run.worktree, 'src', 'change.js'), 'export const changed = true;\n');
  git(run.worktree, 'add', 'src/change.js');
  git(run.worktree, 'commit', '-m', 'worker change');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'The final round report omits an earlier round path.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const output = [];
  const summary = collectWorker('collect-omitted-path', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: (line) => output.push(line), listWorktreeProcesses: () => [],
    recordUsageFn: () => ({ errors: [], duplicate: false }),
  });
  const ledgerEntry = JSON.parse(fs.readFileSync(f.config.ledgerPath, 'utf8').trim());
  assert.deepEqual(summary.reportedPaths, [`.orchestration/runs/${run.name}.json`]);
  assert.ok(summary.actualPaths.includes('src/change.js'));
  assert.deepEqual(ledgerEntry.changedPaths, summary.actualPaths);
  assert.ok(output.includes('report.json omits 1 changed path(s); recorded the diff paths'));
});

test('worker collect normalizes issue none to null and warns', (t) => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('collect-issue-none', { kind: 'codex', task: 'x', allow: ['src/', '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  t.after(() => {
    if (run.worktree !== f.root) git(f.root, 'worktree', 'remove', '--force', run.worktree);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Report uses the accepted null issue marker.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: 'none', branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const output = [];
  const summary = collectWorker('collect-issue-none', { noRecord: true }, {
    config: f.config, output: (line) => output.push(line), listWorktreeProcesses: () => [],
  });
  assert.equal(summary.issue, null);
  assert.ok(output.some((line) => /issue is the string "none"; it is read as null/.test(line)));
});

test('worker collect advises its caller shell to leave the worktree and ignores that process tree', (t) => {
  const fixture = setupKitPathFixture('collect-caller-shell');
  t.after(fixture.clean);
  fixture.writeReport([]);
  const output = [];
  const summary = collectWorker('collect-caller-shell', { noRecord: true }, {
    config: fixture.config, output: (line) => output.push(line), callerPid: 500, callerPpid: 400,
    listWorktreeProcesses: () => [
      { pid: 500, ppid: 400, command: 'node', cwd: fixture.run.worktree },
      { pid: 400, ppid: 1, command: 'zsh', cwd: fixture.run.worktree },
    ],
  });
  assert.equal(summary.name, 'collect-caller-shell');
  assert.ok(output.includes(`cd ${fixture.config.mainRoot}`));
});

test('worker collect names a separate background shell that keeps the worktree cwd', (t) => {
  const fixture = setupKitPathFixture('collect-background-shell');
  t.after(fixture.clean);
  fixture.writeReport([]);
  assert.throws(() => collectWorker('collect-background-shell', { noRecord: true }, {
    config: fixture.config, output: () => {}, callerPid: 500, callerPpid: 400,
    listWorktreeProcesses: () => [
      { pid: 600, ppid: 1, command: 'zsh', cwd: fixture.run.worktree },
    ],
  }), new RegExp(`your own background shell \\(pid 600, command zsh\\) has its cwd in the worktree\\. Change directory or stop it\\.`));
});

test('worker collect names a leftover process by pid and command name only', (t) => {
  const fixture = setupKitPathFixture('collect-leftover-name');
  t.after(fixture.clean);
  fixture.writeReport([]);
  assert.throws(() => collectWorker('collect-leftover-name', { noRecord: true }, {
    config: fixture.config, output: () => {}, callerPid: 500, callerPpid: 400,
    listWorktreeProcesses: () => [
      { pid: 700, ppid: 42, command: 'node', cwd: fixture.run.worktree },
    ],
  }), (error) => {
    assert.match(error.message, /still has processes in its worktree: node \(pid 700\)\. Stop them before collection\./);
    assert.ok(!/ppid/.test(error.message), 'the refusal must not print the parent pid');
    assert.ok(!/cwd/.test(error.message), 'the refusal must not print the working directory');
    return true;
  });
});

test('worker collect prints one stop-own command for each stoppable worktree process', (t) => {
  const fixture = setupKitPathFixture('collect-leftover-guidance');
  t.after(fixture.clean);
  fixture.writeReport([]);
  assert.throws(() => collectWorker('collect-leftover-guidance', { noRecord: true }, {
    config: fixture.config, output: () => {}, callerPid: 500, callerPpid: 400,
    listWorktreeProcesses: () => [
      { pid: 700, ppid: 42, command: 'node', args: 'node --private-arg hidden', cwd: fixture.run.worktree },
      { pid: 701, ppid: 1, command: 'python', args: 'python --private-arg hidden', cwd: fixture.run.worktree },
    ],
  }), (error) => {
    assert.match(error.message, /herdr-boss worker stop-own 'collect-leftover-guidance' --pid 700/);
    assert.match(error.message, /herdr-boss worker stop-own 'collect-leftover-guidance' --pid 701/);
    assert.doesNotMatch(error.message, /--private-arg|hidden/);
    return true;
  });
});

test('worker collect tells the caller to close a pane whose shell PID changed', (t) => {
  const fixture = setupKitPathFixture('collect-changed-pane-shell');
  t.after(fixture.clean);
  fixture.writeReport([]);
  const currentShellPid = 777;
  assert.throws(() => collectWorker('collect-changed-pane-shell', { noRecord: true }, {
    config: fixture.config, output: () => {}, callerPid: 500, callerPpid: 400,
    herdr: (args) => args[0] === 'pane' && args[1] === 'process-info'
      ? { process_info: { shell_pid: currentShellPid } }
      : {},
    listWorktreeProcesses: () => [
      { pid: currentShellPid, ppid: 1, command: 'zsh', cwd: fixture.run.worktree },
      { pid: currentShellPid + 1, ppid: 1, command: 'node', cwd: fixture.run.worktree },
    ],
  }), (error) => {
    assert.match(error.message, new RegExp(`close the finished pane with herdr pane close '${fixture.run.pane}'`));
    assert.match(error.message, /then collect again/);
    assert.match(error.message, new RegExp(`herdr-boss worker stop-own 'collect-changed-pane-shell' --pid ${currentShellPid + 1}`));
    assert.doesNotMatch(error.message, new RegExp(`worker stop-own 'collect-changed-pane-shell' --pid ${currentShellPid}(?:\\D|$)`));
    return true;
  });
});

test('worker collect --record after merge and pane close writes one main-checkout ledger entry', (t) => {
  const root = temporaryRepo('herdr-kit-v94-');
  const name = 'merged-worker';
  const worktreeRoot = path.join(path.dirname(root), '.herdr-wt');
  const repoWorktrees = path.join(worktreeRoot, path.basename(root));
  const worktree = path.join(repoWorktrees, name);
  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch {}
    fs.rmSync(repoWorktrees, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({
    slug: 'sample',
    worktreeRoot,
    worktreeName: '{repo}/{name}',
    ledger: '.orchestration/delegated-runs.jsonl',
    runsDir: '.orchestration/runs',
  }));
  const mainConfig = loadProjectConfig({ cwd: root });
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '-b', name, worktree);
  const changedFile = path.join(worktree, 'src', 'change.js');
  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  fs.writeFileSync(changedFile, 'export const changed = true;\n');
  git(worktree, 'add', 'src/change.js');
  git(worktree, 'commit', '-m', 'worker change');
  git(root, 'merge', '--ff-only', name);

  const run = {
    name,
    issue: null,
    kind: 'codex',
    model: 'gpt-6-luna',
    branch: name,
    worktree,
    workerDir: '.worker',
    base: 'main',
    baseCommit,
    startedAt: '2026-09-29T09:00:00.000Z',
    allowedPaths: ['src/'],
    pane: 'w1:p99',
  };
  fs.mkdirSync(mainConfig.runsPath, { recursive: true });
  fs.writeFileSync(path.join(mainConfig.runsPath, `${name}.json`), JSON.stringify(run));
  const reportDir = path.join(worktree, '.worker');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Partial result.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null,
    branch: name,
    worktree,
    changedPaths: ['src/change.js'],
    commands: ['focused check'],
    evidenceTier: ['unit'],
    unverified: [],
    stoppedEarly: true,
  }));

  const config = loadProjectConfig({ cwd: worktree });
  assert.equal(config.root, worktree);
  assert.equal(config.mainRoot, root);
  assert.equal(config.runsPath, mainConfig.runsPath);
  assert.equal(config.ledgerPath, mainConfig.ledgerPath);
  const paneIsClosed = true;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return { agents: paneIsClosed ? [] : [{ name }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  collectWorker(name, { record: true, outcome: 'partial', gatePassed: true }, {
    config,
    output: (line) => output.push(line),
    recordUsageFn: () => ({ errors: [], duplicate: false }),
  });
  assert.equal(fs.readFileSync(mainConfig.ledgerPath, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.existsSync(path.join(worktree, '.orchestration/delegated-runs.jsonl')), false);
  const ledgerOutput = [];
  runKitCommand('ledger', ['check', '--runs'], { config, herdr, output: (line) => ledgerOutput.push(line) });
  assert.deepEqual(ledgerOutput, ['ledger: PASS (1 entries; 1 run records, 0 still running)']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mainConfig.runsPath, `${name}.json`), 'utf8')).outcome, 'partial');
  assert.ok(output.some((line) => line.includes('"name": "merged-worker"')));
});

test('worker collection warns only for stale or missing artifacts in explicitly done reports', () => {
  const cases = [
    { name: 'fresh-artifacts', status: 'done', sourceTime: 20_000_000, artifactTime: 30_000_000, warning: false },
    { name: 'stale-artifacts', status: 'done', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: true },
    { name: 'missing-artifacts', status: 'done', sourceTime: 30_000_000, artifactTime: null, warning: true },
    { name: 'described-done-artifacts', status: 'done', statusLine: 'Status: done. Artifact generation finished.', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: true },
    { name: 'doneish-artifacts', status: 'doneish', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: false },
    { name: 'done-partial-artifacts', status: 'done', statusLine: 'Status: done-partial', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: false },
    { name: 'partial-artifacts', status: 'partial', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: false },
    { name: 'failed-artifacts', status: 'failed', sourceTime: 30_000_000, artifactTime: 20_000_000, warning: false },
  ];
  for (const scenario of cases) {
    const f = setupFixture(null);
    let run;
    try {
      fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({
        briefTemplate: path.join(f.root, 'brief-template.md'),
        artifactChecks: [{ artifacts: 'docs/gallery/**/*.png', sources: 'extensions/**/src/**' }],
      }));
      f.config = loadProjectConfig({ cwd: f.root });
      git(f.root, 'add', '.herdr-boss.json');
      git(f.root, 'commit', '-m', 'configure artifact checks');
      run = startWorker(scenario.name, {
        kind: 'codex', task: 'x', allow: ['extensions/', 'docs/gallery/'],
      }, { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });

      const sourcePath = path.join(run.worktree, 'extensions', 'team', 'src', 'entry.js');
      const artifactPath = path.join(run.worktree, 'docs', 'gallery', 'card.png');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, 'export const source = true;\n');
      const changedPaths = ['extensions/team/src/entry.js'];
      if (scenario.artifactTime !== null) {
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, 'image');
        changedPaths.push('docs/gallery/card.png');
      }
      git(run.worktree, 'add', ...changedPaths);
      git(run.worktree, 'commit', '-m', 'worker artifacts');
      const setMtime = (file, time) => fs.utimesSync(file, time / 1000, time / 1000);
      setMtime(sourcePath, scenario.sourceTime);
      if (scenario.artifactTime !== null) setMtime(artifactPath, scenario.artifactTime);

      const reportDir = path.join(run.worktree, '.worker');
      const reportMd = `${scenario.statusLine ?? `Status: ${scenario.status}`}\n`;
      const reportJson = JSON.stringify({
        issue: null,
        branch: run.branch,
        worktree: run.worktree,
        changedPaths,
        commands: ['focused check'],
        evidenceTier: ['unit'],
        unverified: [],
        stoppedEarly: scenario.status !== 'done',
      });
      fs.writeFileSync(path.join(reportDir, 'report.md'), reportMd);
      fs.writeFileSync(path.join(reportDir, 'report.json'), reportJson);
      const output = [];
      const recordOptions = scenario.name === 'stale-artifacts'
        ? { record: true, outcome: 'done', gatePassed: true }
        : { noRecord: true };
      const summary = collectWorker(scenario.name, recordOptions, {
        config: f.config,
        output: (line) => output.push(line),
        listWorktreeProcesses: () => [],
        recordUsageFn: () => ({ errors: [], duplicate: false }),
      });
      assert.equal(fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8'), reportMd);
      assert.equal(fs.readFileSync(path.join(reportDir, 'report.json'), 'utf8'), reportJson);
      assert.equal(summary.artifactWarnings.length > 0, scenario.warning, scenario.name);
      if (scenario.warning) {
        assert.match(summary.artifactWarnings[0], /docs\/gallery\/\*\*\/\*\.png/);
        assert.match(summary.artifactWarnings[0], /extensions\/\*\*\/src\/\*\*/);
        assert.ok(output.some((line) => line.includes(summary.artifactWarnings[0])), 'collection output must show every warning');
      } else {
        assert.deepEqual(summary.artifactWarnings, []);
      }
      if (scenario.name === 'stale-artifacts') {
        const ledger = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
        assert.equal(ledger[0].independentGate.passed, true, 'artifact warnings must not change the independent gate result');
      }
    } finally {
      if (run) {
        try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
      }
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

// A stateful fake Herdr for the shared Workers tab. It never touches the real Herdr.
// workerTabs lists extra tabs as { label, panes }, where panes is the number of live panes in the tab.
function sharedTabHerdr({ workersTab = false, failStart = false, workerTabs = [] } = {}) {
  const state = { calls: [], tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Main' }, { tab_id: 'ws:t2', workspace_id: 'ws', label: 'W old' }], panes: [
    { pane_id: 'ws:orch', workspace_id: 'ws', tab_id: 'ws:t1', label: 'orch' },
    { pane_id: 'ws:p3', workspace_id: 'ws', tab_id: 'ws:t2' },
  ], cwd: {}, nextTab: 50, nextPane: 100 };
  if (workersTab) {
    state.tabs.push({ tab_id: 'ws:t4', workspace_id: 'ws', label: 'Workers' });
    state.panes.push({ pane_id: 'ws:p8', workspace_id: 'ws', tab_id: 'ws:t4', width: 160, height: 45 });
  }
  workerTabs.forEach(({ label, panes }, index) => {
    const tabId = `ws:t${10 + index}`;
    state.tabs.push({ tab_id: tabId, workspace_id: 'ws', label });
    for (let pane = 0; pane < panes; pane++) state.panes.push({ pane_id: `ws:p${20 + index * 10 + pane}`, workspace_id: 'ws', tab_id: tabId, width: 80, height: 45 });
  });
  state.herdr = (args) => {
    state.calls.push(args);
    const [group, action] = args;
    if (group === 'pane' && action === 'get') {
      if (args[2] === 'ws:orch') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
      return { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: state.cwd[args[2]] } };
    }
    if (group === 'pane' && action === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (group === 'pane' && action === 'read') return { text: '% ' };
    if (group === 'agent' && action === 'list') return { agents: [] };
    if (group === 'tab' && action === 'list') return { tabs: state.tabs.map((tab) => ({ ...tab })) };
    if (group === 'pane' && action === 'list') return { panes: state.panes.map((pane) => ({ ...pane })) };
    if (group === 'tab' && action === 'create') {
      const tabId = `ws:t${state.nextTab++}`;
      const paneId = `ws:p${state.nextPane++}`;
      state.tabs.push({ tab_id: tabId, workspace_id: 'ws', label: args[args.indexOf('--label') + 1] });
      state.panes.push({ pane_id: paneId, workspace_id: 'ws', tab_id: tabId, width: 160, height: 45 });
      state.cwd[paneId] = args[args.indexOf('--cwd') + 1];
      return { tab: { tab_id: tabId } };
    }
    if (group === 'pane' && action === 'split') {
      const source = state.panes.find((pane) => pane.pane_id === args[2]);
      assert.ok(source, `split source ${args[2]} must be a live pane`);
      const paneId = `ws:p${state.nextPane++}`;
      state.panes.push({ pane_id: paneId, workspace_id: 'ws', tab_id: source.tab_id, width: 80, height: 45 });
      state.cwd[paneId] = args[args.indexOf('--cwd') + 1];
      return { pane: { pane_id: paneId } };
    }
    if (group === 'pane' && action === 'close') { state.panes = state.panes.filter((pane) => pane.pane_id !== args[2]); return {}; }
    if (group === 'tab' && action === 'close') {
      state.tabs = state.tabs.filter((tab) => tab.tab_id !== args[2]);
      state.panes = state.panes.filter((pane) => pane.tab_id !== args[2]);
      return {};
    }
    if (group === 'agent' && action === 'start') { if (failStart) throw new Error('agent_not_ready'); return {}; }
    if (group === 'agent' && action === 'get') return { agent: { agent_status: 'idle' } };
    if (group === 'agent' && action === 'read') return { text: ALL_READY_SCREENS };
    if (group === 'agent' && action === 'prompt') return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  return state;
}

function sharedTabProject() {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  return { root, config, rulesFile, env };
}

test('worker start creates the shared Workers tab once, then splits from its newest worker pane', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr();
  const start = (name, kind = 'claude') => startWorker(name, { kind, task: 'x', allow: ['src/'] }, {
    config: p.config, models: loadModels(), herdr: fake.herdr, env: p.env, rulesFile: p.rulesFile, wait: () => {}, output: () => {},
  });

  const first = start('first');
  const creates = fake.calls.filter((args) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].slice(0, 8), ['tab', 'create', '--workspace', 'ws', '--label', 'Workers', '--cwd', p.config.worktreePath('first')]);
  assert.ok(creates[0].includes('DISABLE_UPDATE_PROMPT=true'));
  assert.ok(creates[0].includes('DISABLE_AUTO_UPDATE=true'));
  assert.ok(creates[0].includes('--no-focus'));
  const workersTab = fake.tabs.find((tab) => tab.label === 'Workers');
  const rootPane = fake.panes.find((pane) => pane.tab_id === workersTab.tab_id);
  assert.equal(first.pane, rootPane.pane_id, 'the first worker uses the root pane of the new tab');
  assert.ok(!fake.calls.some((args) => args[0] === 'pane' && args[1] === 'split'));

  const second = start('second', 'codex');
  let splits = fake.calls.filter((args) => args[0] === 'pane' && args[1] === 'split');
  assert.equal(splits.length, 1);
  assert.equal(splits[0][2], first.pane, 'the second worker splits from the first worker pane');
  assert.deepEqual(splits[0].slice(3, 7), ['--direction', 'right', '--cwd', p.config.worktreePath('second')]);
  assert.ok(splits[0].includes('HERDR_ENV=1'));
  assert.ok(splits[0].includes('DISABLE_UPDATE_PROMPT=true'));
  assert.ok(splits[0].includes('DISABLE_AUTO_UPDATE=true'));
  assert.ok(splits[0].includes('--no-focus'));
  assert.equal(fake.panes.find((pane) => pane.pane_id === second.pane).tab_id, workersTab.tab_id);

  const third = start('third');
  splits = fake.calls.filter((args) => args[0] === 'pane' && args[1] === 'split');
  assert.equal(splits.length, 2);
  assert.equal(splits[1][2], second.pane, 'the split source is the most recently created pane in the Workers tab');
  assert.ok(!splits[1].includes('HERDR_ENV=1'));
  assert.equal(fake.panes.find((pane) => pane.pane_id === third.pane).tab_id, workersTab.tab_id);
  assert.equal(fake.calls.filter((args) => args[0] === 'tab' && args[1] === 'create').length, 1);
  assert.equal(fake.tabs.filter((tab) => tab.label === 'Workers').length, 1);
  assert.ok(!fake.calls.some((args) => args[1] === 'close'));
});

test('Claude worker start passes the selection dialog denial to Herdr', () => {
  const project = sharedTabProject();
  const fake = sharedTabHerdr();
  sharedTabStart(project, fake)('claude-no-dialog');
  const start = fake.calls.find((args) => args[0] === 'agent' && args[1] === 'start');
  const launchArgs = start.slice(start.indexOf('--') + 1);
  assert.equal(launchArgs[launchArgs.indexOf('--disallowedTools') + 1], 'AskUserQuestion');
});

test('a failed worker start closes only what it created in the Workers tab', () => {
  const p = sharedTabProject();
  const start = (fake, name) => assert.throws(() => startWorker(name, { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config: p.config, models: loadModels(), herdr: fake.herdr, env: p.env, rulesFile: p.rulesFile, wait: () => {}, output: () => {},
  }), /agent_not_ready/);

  const created = sharedTabHerdr({ failStart: true });
  start(created, 'newtab');
  const tabCloses = created.calls.filter((args) => args[0] === 'tab' && args[1] === 'close');
  assert.equal(tabCloses.length, 1, 'the start that created the Workers tab closes it');
  assert.ok(!created.tabs.some((tab) => tab.label === 'Workers'));
  assert.ok(!created.calls.some((args) => args[0] === 'pane' && args[1] === 'close'));
  assert.equal(fs.existsSync(p.config.worktreePath('newtab')), false);

  const existing = sharedTabHerdr({ workersTab: true, failStart: true });
  start(existing, 'newpane');
  const split = existing.calls.find((args) => args[0] === 'pane' && args[1] === 'split');
  assert.equal(split[2], 'ws:p8');
  const paneCloses = existing.calls.filter((args) => args[0] === 'pane' && args[1] === 'close');
  assert.equal(paneCloses.length, 1);
  assert.notEqual(paneCloses[0][2], 'ws:p8', 'cleanup never closes the pane of another worker');
  assert.ok(!existing.panes.some((pane) => pane.pane_id === paneCloses[0][2]));
  assert.ok(existing.panes.some((pane) => pane.pane_id === 'ws:p8'));
  assert.ok(!existing.calls.some((args) => args[0] === 'tab' && args[1] === 'close'), 'a start that did not create the Workers tab keeps it');
  assert.equal(fs.existsSync(p.config.worktreePath('newpane')), false);
});

test('worker start dry-run shows the split from the Workers tab, or the tab create when the tab is missing', () => {
  const p = sharedTabProject();
  const plan = (fake, name) => {
    const output = [];
    startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
      config: p.config, models: loadModels(), herdr: fake.herdr, env: p.env, rulesFile: p.rulesFile, output: (line) => output.push(line),
    });
    assert.ok(!fake.calls.some((args) => ['create', 'split', 'close'].includes(args[1])), 'the dry run changes no tab or pane');
    return output.join('\n');
  };
  const split = plan(sharedTabHerdr({ workersTab: true }), 'drysplit');
  assert.match(split, /Place worker in tab "Workers" \(ws:t4, 1 of 3 panes\) of workspace ws/);
  assert.match(split, /herdr pane split ws:p8 --direction right --cwd \S+drysplit --env HERDR_ENV=1 --env DISABLE_UPDATE_PROMPT=true --env DISABLE_AUTO_UPDATE=true --no-focus/);
  assert.match(split, /New pane: <new-pane-id>/);
  assert.match(split, /herdr agent start drysplit --kind codex --pane '<new-pane-id>'/);
  assert.ok(!split.includes('tab create'));

  const create = plan(sharedTabHerdr(), 'drycreate');
  assert.match(create, /herdr tab create --workspace ws --label Workers --cwd \S+drycreate --env HERDR_ENV=1/);
  assert.match(create, /Root pane: <new-root-pane-id>/);
  assert.ok(!create.includes('pane split'));
});

function sharedTabStart(p, fake) {
  return (name, extra = {}) => startWorker(name, { kind: 'claude', task: 'x', allow: ['src/'], ...extra }, {
    config: p.config, models: loadModels(), herdr: fake.herdr, env: p.env, rulesFile: p.rulesFile, wait: () => {}, output: () => {},
  });
}

const tabOf = (fake, paneId) => fake.tabs.find((tab) => tab.tab_id === fake.panes.find((pane) => pane.pane_id === paneId)?.tab_id)?.label;

test('the fourth worker opens a Workers 2 tab', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr();
  const start = sharedTabStart(p, fake);
  const runs = ['one', 'two', 'three', 'four'].map((name) => start(name));
  assert.deepEqual(runs.map((run) => tabOf(fake, run.pane)), ['Workers', 'Workers', 'Workers', 'Workers 2']);
  const creates = fake.calls.filter((args) => args[0] === 'tab' && args[1] === 'create');
  assert.deepEqual(creates.map((args) => args[args.indexOf('--label') + 1]), ['Workers', 'Workers 2']);
  const fifth = start('five');
  assert.equal(tabOf(fake, fifth.pane), 'Workers 2');
  const lastSplit = fake.calls.filter((args) => args[0] === 'pane' && args[1] === 'split').at(-1);
  assert.equal(lastSplit[2], runs[3].pane, 'the split source is the newest pane of Workers 2');
});

test('a free slot in Workers is used before Workers 2', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr({ workerTabs: [{ label: 'Workers 2', panes: 1 }, { label: 'Workers', panes: 2 }] });
  const run = sharedTabStart(p, fake)('slot');
  assert.equal(tabOf(fake, run.pane), 'Workers');
  const split = fake.calls.find((args) => args[0] === 'pane' && args[1] === 'split');
  assert.equal(split[2], 'ws:p31', 'the split source is the newest pane of Workers');
  assert.ok(!fake.calls.some((args) => args[0] === 'tab' && args[1] === 'create'));
});

test('worker start creates the lowest free Workers label when every tab is full', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr({ workerTabs: [{ label: 'Workers', panes: 3 }, { label: 'Workers 3', panes: 3 }] });
  const run = sharedTabStart(p, fake)('gap');
  assert.equal(tabOf(fake, run.pane), 'Workers 2');
  const creates = fake.calls.filter((args) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--label') + 1], 'Workers 2');
});

test('a listed Workers tab with no live panes counts as free and gets a new root pane', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr({ workerTabs: [{ label: 'Workers', panes: 0 }, { label: 'Workers 2', panes: 1 }] });
  const run = sharedTabStart(p, fake)('empty');
  const creates = fake.calls.filter((args) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--label') + 1], 'Workers');
  assert.equal(tabOf(fake, run.pane), 'Workers');
  assert.ok(!fake.calls.some((args) => args[0] === 'pane' && args[1] === 'split'));
});

test('workerPanesPerTab sets the pane cap for each Workers tab', () => {
  const p = sharedTabProject();
  fs.writeFileSync(path.join(p.root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: path.join(p.root, 'brief-template.md'), workerPanesPerTab: 2 }));
  p.config = loadProjectConfig({ cwd: p.root });
  const fake = sharedTabHerdr({ workerTabs: [{ label: 'Workers', panes: 2 }] });
  const run = sharedTabStart(p, fake)('cap');
  assert.equal(tabOf(fake, run.pane), 'Workers 2');
});

test('a failed start in a full Workers tab set closes only the Workers 2 tab that it created', () => {
  const p = sharedTabProject();
  const fake = sharedTabHerdr({ failStart: true, workerTabs: [{ label: 'Workers', panes: 3 }] });
  assert.throws(() => sharedTabStart(p, fake)('failnew'), /agent_not_ready/);
  const create = fake.calls.find((args) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(create[create.indexOf('--label') + 1], 'Workers 2');
  const closes = fake.calls.filter((args) => args[1] === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0][0], 'tab');
  assert.notEqual(closes[0][2], 'ws:t10', 'cleanup never closes the full Workers tab');
  assert.equal(fake.panes.filter((pane) => pane.tab_id === 'ws:t10').length, 3);
  assert.ok(!fake.tabs.some((tab) => tab.label === 'Workers 2'));

  const split = sharedTabHerdr({ failStart: true, workerTabs: [{ label: 'Workers', panes: 3 }, { label: 'Workers 2', panes: 1 }] });
  assert.throws(() => sharedTabStart(p, split)('failpane'), /agent_not_ready/);
  const splitCloses = split.calls.filter((args) => args[1] === 'close');
  assert.equal(splitCloses.length, 1);
  assert.equal(splitCloses[0][0], 'pane');
  assert.notEqual(splitCloses[0][2], 'ws:p30');
  assert.ok(split.tabs.some((tab) => tab.label === 'Workers 2'), 'a start that did not create Workers 2 keeps it');
});

test('worker start dry-run names the chosen Workers tab', () => {
  const p = sharedTabProject();
  const plan = (fake, name) => {
    const output = [];
    startWorker(name, { kind: 'claude', task: 'x', allow: ['src/'], dryRun: true }, {
      config: p.config, models: loadModels(), herdr: fake.herdr, env: p.env, rulesFile: p.rulesFile, output: (line) => output.push(line),
    });
    assert.ok(!fake.calls.some((args) => ['create', 'split', 'close'].includes(args[1])), 'the dry run changes no tab or pane');
    return output.join('\n');
  };
  const split = plan(sharedTabHerdr({ workerTabs: [{ label: 'Workers', panes: 3 }, { label: 'Workers 2', panes: 2 }] }), 'drytwo');
  assert.match(split, /Place worker in tab "Workers 2" \(ws:t11, 2 of 3 panes\) of workspace ws/);
  assert.match(split, /herdr pane split ws:p31 /);
  const create = plan(sharedTabHerdr({ workerTabs: [{ label: 'Workers', panes: 3 }] }), 'drynew');
  assert.match(create, /Place worker in tab "Workers 2" \(new tab\) of workspace ws/);
  assert.match(create, /herdr tab create --workspace ws --label 'Workers 2' --cwd /);
});

test('project workerPanesPerTab defaults to three and accepts integers from one to six', () => {
  const root = temporaryRepo();
  assert.equal(loadProjectConfig({ cwd: root }).workerPanesPerTab, 3);
  for (const workerPanesPerTab of [1, 6]) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ workerPanesPerTab }));
    assert.equal(loadProjectConfig({ cwd: root }).workerPanesPerTab, workerPanesPerTab);
  }
  for (const workerPanesPerTab of [0, 7, -1, 2.5, '3', null]) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ workerPanesPerTab }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /workerPanesPerTab must be an integer from 1 to 6/);
  }
});

test('the worker config view holds allow-listed fields only and never a secret', () => {
  const config = {
    ...PROJECT_DEFAULTS,
    slug: 'demo',
    setup: 'npm ci',
    accessToken: 'must-not-enter-the-view',
    roamgate: { tokenFile: '/private/roamgate-token' },
  };
  const view = workerConfigView(config);
  assert.deepEqual(view.fields.map((field) => field.key), [
    'slug', 'baseBranch', 'worktreeRoot', 'worktreeName',
    'evidenceTiers', 'allowedModels', 'workerPanesPerTab', 'imageBudget',
    'setup', 'setupTimeoutSeconds', 'agentStartTimeoutMs', 'testThreadsFlag',
  ]);
  const text = JSON.stringify(view);
  assert.equal(text.includes('must-not-enter-the-view'), false, 'a value outside the allow-list never enters the view');
  assert.equal(text.includes('/private/roamgate-token'), false, 'a token path never enters the view');
});

test('the worker config view masks setup and shows the home folder as ~', () => {
  const home = '/home/tester';
  const set = workerConfigView({ ...PROJECT_DEFAULTS, worktreeRoot: `${home}/trees`, setup: 'npm ci', testThreadsFlag: '--maxWorkers=2' }, { home });
  const field = (view, key) => view.fields.find((item) => item.key === key);
  assert.deepEqual(field(set, 'setup'), { key: 'setup', value: 'set', source: 'config' });
  assert.deepEqual(field(set, 'worktreeRoot'), { key: 'worktreeRoot', value: '~/trees', source: 'config' });
  assert.deepEqual(field(set, 'testThreadsFlag'), { key: 'testThreadsFlag', value: '--maxWorkers=2', source: 'config' });
  const plain = workerConfigView({ ...PROJECT_DEFAULTS }, { home });
  assert.deepEqual(field(plain, 'setup'), { key: 'setup', value: 'not set', source: 'default' });
  assert.deepEqual(field(plain, 'worktreeRoot'), { key: 'worktreeRoot', value: '~/Projects/.herdr-wt', source: 'default' });
  assert.deepEqual(field(plain, 'allowedModels'), { key: 'allowedModels', value: 'not set', source: 'default' });
  const machine = workerConfigView({ ...PROJECT_DEFAULTS, worktreeRoot: `${home}/Projects/.herdr-wt` }, { home });
  assert.deepEqual(field(machine, 'worktreeRoot'), { key: 'worktreeRoot', value: '~/Projects/.herdr-wt', source: 'default' });
});

test('worker dialog and screen reads use the recent-unwrapped source', async () => {
  const { readAgentText } = await import('../src/kit/workers.js');
  assert.equal(typeof readAgentText, 'function', 'workers.js exports readAgentText');
  const reads = [];
  const text = readAgentText('demo', (command, args) => { reads.push([command, ...args]); return 'dialog'; });
  assert.equal(text, 'dialog');
  assert.deepEqual(reads, [['herdr', 'agent', 'read', 'demo', '--source', 'recent-unwrapped', '--lines', '60']]);

  const paneReads = [];
  const herdr = (args) => {
    if (args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/work' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[1] === 'read') { paneReads.push(args); return { text: '% ' }; }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  waitForWorkerPane('ws:p2', 'ws', '/work', herdr, () => {});
  assert.ok(paneReads.length > 0);
  for (const args of paneReads) assert.equal(args[args.indexOf('--source') + 1], 'recent-unwrapped');
});

test('worker start sets HERDR_ENV=1 in Codex worker panes and the dry-run plan, and only there', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const creates = [];
  let paneCwd = root;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'split') {
      creates.push(args);
      paneCwd = args[args.indexOf('--cwd') + 1];
      return { pane: { pane_id: 'ws:p2' } };
    }
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  const start = (name, options) => startWorker(name, { task: 'x', allow: ['src/'], ...options }, { config, models: loadModels(), herdr, env, rulesFile, wait: () => {}, output: () => {} });

  start('codexenv', { kind: 'codex' });
  const codexCreate = creates.at(-1);
  assert.ok(codexCreate.includes('HERDR_ENV=1'), `expected HERDR_ENV=1 in ${codexCreate.join(' ')}`);
  assert.ok(codexCreate.includes('DISABLE_UPDATE_PROMPT=true'));
  assert.ok(codexCreate.includes('DISABLE_AUTO_UPDATE=true'));
  assert.ok(codexCreate.includes('--no-focus'));

  const dryRun = [];
  startWorker('codexenvdry', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models: loadModels(), herdr, env, rulesFile, output: (line) => dryRun.push(line),
  });
  assert.match(dryRun.join('\n'), /herdr pane split .*--env HERDR_ENV=1 --env DISABLE_UPDATE_PROMPT=true --env DISABLE_AUTO_UPDATE=true --no-focus/);
  assert.equal(creates.length, 1, 'the dry run creates no pane');

  start('claudeenv', { kind: 'claude' });
  const claudeCreate = creates.at(-1);
  assert.ok(!claudeCreate.includes('HERDR_ENV'), `expected no HERDR_ENV in ${claudeCreate.join(' ')}`);
  assert.ok(claudeCreate.includes('DISABLE_UPDATE_PROMPT=true'));
  assert.ok(claudeCreate.includes('DISABLE_AUTO_UPDATE=true'));
  assert.ok(claudeCreate.includes('--no-focus'));
});

test('worker start waits for a stable shell in a new tab and rechecks before a timed busy retry', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template, agentStartTimeoutMs: 120000 }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let tabCreated = false;
  let shellReady = false;
  let starts = 0;
  let waits = 0;
  let paneReads = 0;
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') {
      if (args[2] === 'ws:orch') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
      return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    }
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: tabCreated ? [{ tab_id: 'ws:t2', workspace_id: 'ws', label: 'Workers' }] : [] };
    if (args[0] === 'tab' && args[1] === 'create') {
      assert.ok(args.includes('DISABLE_UPDATE_PROMPT=true'));
      assert.ok(args.includes('DISABLE_AUTO_UPDATE=true'));
      tabCreated = true;
      return { tab: { tab_id: 'ws:t2' } };
    }
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p2', workspace_id: 'ws', tab_id: 'ws:t2' }] };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: {
      shell_pid: 10,
      foreground_process_group_id: 10,
      foreground_processes: [{ pid: shellReady ? 10 : 11, name: shellReady ? 'zsh' : 'login' }],
    } };
    if (args[0] === 'pane' && args[1] === 'read') { paneReads++; return { text: 'Starting interactive shell...' }; }
    if (args[0] === 'agent' && args[1] === 'start') {
      starts++;
      assert.deepEqual(args.slice(3, 9), ['--kind', 'codex', '--pane', 'ws:p2', '--timeout', '120000']);
      if (starts === 1) {
        shellReady = false;
        throw Object.assign(new Error('agent_pane_busy'), { code: 'agent_pane_busy' });
      }
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'prompt') return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, wait: () => { waits++; shellReady = true; },
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(result.pane, 'ws:p2');
  assert.equal(starts, 2);
  assert.ok(waits >= 8, `expected separate one-second readiness waits, got ${waits}`);
  assert.ok(paneReads >= 10, `expected stable screen reads before both starts, got ${paneReads}`);
  const startCalls = calls.map((args, index) => [args, index]).filter(([args]) => args[0] === 'agent' && args[1] === 'start');
  const firstStart = startCalls[0][1];
  const secondStart = startCalls[1][1];
  assert.ok(calls.findIndex((args) => args[0] === 'tab' && args[1] === 'create') < firstStart);
  assert.ok(calls.slice(firstStart + 1, secondStart).some((args) => args[0] === 'pane' && args[1] === 'get' && args[2] === 'ws:p2'));
  assert.ok(calls.slice(firstStart + 1, secondStart).some((args) => args[0] === 'pane' && args[1] === 'read'));
});

test('worker start stops at an interactive shell question before typing the launch command', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  let starts = 0;
  let paneClosed = false;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('question') } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: {
      shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: 'zsh' }],
    } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: 'Would you like to update? [Y/n]\n' };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'pane' && args[1] === 'close') { paneClosed = args[2] === 'ws:p2'; return {}; }
    if (args[0] === 'agent' && args[1] === 'start') { starts++; return {}; }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.throws(() => startWorker('question', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, wait: () => assert.fail('must stop without waiting'), rulesFile,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' },
  }), (error) => error.code === 'worker_pane_interactive_question'
    && /Would you like to update\? \[Y\/n\]/.test(error.message)
    && /Answer it in a shell once/.test(error.message));
  assert.equal(starts, 0);
  assert.equal(paneClosed, true);
  assert.equal(fs.existsSync(config.worktreePath('question')), false);
  assert.equal(git(root, 'branch', '--list', 'question'), '');
});

test('worker start cleans up the pane and worktree when the busy retry fails', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  let starts = 0;
  const closedPanes = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'pane' && args[1] === 'close') { closedPanes.push(args[2]); return {}; }
    if (args[0] === 'agent' && args[1] === 'start') { starts++; throw new Error('agent_pane_busy'); }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.throws(() => startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  }), /agent_pane_busy/);
  assert.equal(starts, 2);
  assert.deepEqual(closedPanes, ['ws:p2']);
  assert.equal(fs.existsSync(config.worktreePath('demo')), false);
});

test('worker start final output line reports failure after cleanup', () => {
  const f = setupFixture(null);
  const output = [];
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'start') throw new Error('agent_pane_busy');
    if (args[0] === 'pane' && args[1] === 'close') throw new Error('pane close refused');
    return f.herdr(args);
  };
  assert.throws(() => startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, wait: () => {}, output: (line) => output.push(line),
  }), (error) => /START FAILED: agent_pane_busy$/.test(error.message) && /cleanup/.test(error.message));
});

test('worker start copies nested repository inputs before sending the prompt', () => {
  const f = setupFixture(null);
  fs.mkdirSync(path.join(f.root, 'fixtures', 'one'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'docs', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'fixtures', 'one', 'a.txt'), 'a');
  fs.writeFileSync(path.join(f.root, 'docs', 'nested', 'b.txt'), 'b');
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const workerRoot = f.config.worktreePath('demo');
      assert.equal(fs.readFileSync(path.join(workerRoot, '.worker/inputs/fixtures/one/a.txt'), 'utf8'), 'a');
      assert.equal(fs.readFileSync(path.join(workerRoot, '.worker/inputs/docs/nested/b.txt'), 'utf8'), 'b');
    }
    return f.herdr(args);
  };
  const result = runKitCommand('worker', ['start', 'demo', '--kind', 'codex', '--task', 'x', '--allow', 'src/', '--copy', 'fixtures/one/a.txt', '--copy', path.join(f.root, 'docs/nested/b.txt')], {
    config: f.config, herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(result.worktree, path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(f.root), 'demo'));
  const brief = fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /\.worker\/inputs\/fixtures\/one\/a\.txt/);
  assert.equal(brief.match(/\.worker\/inputs\/fixtures\/one\/a\.txt/g)?.length, 1);
});

test('worker start copies the worker named orchestration inputs into its worktree', () => {
  const f = setupFixture(null);
  const inputDir = path.join(f.root, '.orchestration', 'state', 'inputs', 'demo');
  fs.mkdirSync(path.join(inputDir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'context', 'plan.md'), 'Use the current plan.\n');
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker/inputs/context/plan.md'), 'utf8'), 'Use the current plan.\n');
  const brief = fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /\.worker\/inputs\/context\/plan\.md/);
});

test('worker start refuses more than 200 MB across automatic and explicit copied inputs', () => {
  const f = setupFixture(null);
  const inputDir = path.join(f.root, '.orchestration', 'state', 'inputs', 'oversize');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputFd = fs.openSync(path.join(inputDir, 'input.bin'), 'w');
  fs.ftruncateSync(inputFd, 120 * 1024 * 1024);
  fs.closeSync(inputFd);
  const copyFd = fs.openSync(path.join(f.root, 'extra.bin'), 'w');
  fs.ftruncateSync(copyFd, 80 * 1024 * 1024 + 1);
  fs.closeSync(copyFd);
  assert.throws(() => startWorker('oversize', { kind: 'codex', task: 'x', allow: ['src/'], copy: ['extra.bin'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), /copied inputs exceed the 200 MB total limit/i);
  assert.equal(fs.existsSync(f.config.worktreePath('oversize')), false);
});

test('worker start automatically leases serve:live and writes the port file', () => {
  const f = setupFixture(null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-auto-lease-'));
  const pools = [{ name: 'serve-ports', items: ['47100'], split: {}, env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: null, graceMinutes: 10 }];
  const calls = [];
  const output = [];
  const herdr = (args) => { calls.push(args); return f.herdr(args); };
  const result = startWorker('demo', { kind: 'codex', task: 'Run npm run serve:live to check the page.', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
    leaseOptions: { dataDir, pools },
  });
  assert.deepEqual(result.leases, [{ pool: 'serve-ports', item: '47100', env: 'HERDR_SERVE_PORT' }]);
  assert.ok(output.includes('Automatically leased serve-ports for the serve:live task.'));
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker/port'), 'utf8'), '47100\n');
  assert.ok(calls.some((args) => args[0] === 'pane' && args[1] === 'split' && args.includes('HERDR_SERVE_PORT=47100')));
  const brief = fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /Use only the port in `\.worker\/port`\. Take no other serve port\./);
});

test('a gpt-6-luna brief tells the worker to report failures and never to guess', () => {
  const template = path.resolve('kit/templates/worker-brief.md');
  const luna = setupFixture(null);
  luna.config.briefTemplatePath = template;
  const lunaRun = startWorker('luna-notes', { kind: 'codex', model: 'gpt-6-luna', task: 'x', allow: ['src/'] }, {
    config: luna.config, models: loadModels(), herdr: luna.herdr, env: luna.env, rulesFile: luna.rulesFile, output: () => {},
  });
  assert.match(fs.readFileSync(path.join(lunaRun.worktree, '.worker/brief.md'), 'utf8'), /Never give a best guess in place of a result/);
  const sol = setupFixture(null);
  sol.config.briefTemplatePath = template;
  const solRun = startWorker('sol-notes', { kind: 'codex', model: 'gpt-6.1-sol', task: 'x', allow: ['src/'] }, {
    config: sol.config, models: loadModels(), herdr: sol.herdr, env: sol.env, rulesFile: sol.rulesFile, output: () => {},
  });
  assert.doesNotMatch(fs.readFileSync(path.join(solRun.worktree, '.worker/brief.md'), 'utf8'), /best guess/);
});

test('worker briefs add harness notes, the Git rule, and a long TMPDIR warning', () => {
  const template = path.resolve('kit/templates/worker-brief.md');
  const codex = setupFixture(null);
  codex.config.briefTemplatePath = template;
  const codexRun = startWorker('codex-notes', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: codex.config, models: loadModels(), herdr: codex.herdr, env: codex.env, rulesFile: codex.rulesFile, output: () => {},
  });
  const codexBrief = fs.readFileSync(path.join(codexRun.worktree, '.worker/brief.md'), 'utf8');
  assert.match(codexBrief, /setopt NO_BG_NICE/);
  assert.doesNotMatch(codexBrief, /To wait, use a background command/);
  assert.match(codexBrief, /Do not run cherry-pick, rebase, or merge\. The orchestrator does them\. Commit only when the brief asks\./);

  const claude = setupFixture(null);
  claude.config.briefTemplatePath = template;
  const claudeRun = startWorker('claude-notes', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config: claude.config, models: loadModels(), herdr: claude.herdr, env: claude.env, rulesFile: claude.rulesFile, output: () => {},
  });
  const claudeBrief = fs.readFileSync(path.join(claudeRun.worktree, '.worker/brief.md'), 'utf8');
  assert.match(claudeBrief, /To wait, use a background command and wait for its exit\. Do not run sleep and then poll\. Do not run herdr-boss wait: it waits on other workers\./);
  assert.doesNotMatch(claudeBrief, /In a Codex shell, run `setopt NO_BG_NICE` before a background command\./);

  const long = setupFixture(null);
  long.config.worktreePath = (name) => path.join(os.tmpdir(), 'x'.repeat(100), name);
  const output = [];
  startWorker('long-tmpdir', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config: long.config, models: loadModels(), herdr: long.herdr, env: long.env, rulesFile: long.rulesFile, output: (line) => output.push(line),
  });
  assert.equal(output.filter((line) => /TMPDIR is longer than 90 characters/.test(line)).length, 1);
});

test('custom worker brief gets missing budget and copied input details', () => {
  const f = setupFixture(null);
  const template = path.join(f.root, 'custom-brief.md');
  fs.writeFileSync(template, 'Custom task: {{task}}');
  fs.mkdirSync(path.join(f.root, 'materials', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'materials', 'nested', 'source.txt'), 'input');
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template, imageBudget: 5 }));
  const config = loadProjectConfig({ cwd: f.root });
  const result = startWorker('custom', { kind: 'codex', task: 'x', allow: ['src/'], copy: ['materials/nested/source.txt'] }, {
    config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const brief = fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /Screenshot budget: 5 screenshots/);
  assert.match(brief, /The project setting overrides the kit default\./);
  assert.match(brief, /\.worker\/inputs\/materials\/nested\/source\.txt/);
});

test('worker start rejects unsafe copied inputs without sending a prompt', () => {
  const f = setupFixture(null);
  let prompted = false;
  const herdr = (args) => { if (args[0] === 'agent' && args[1] === 'prompt') prompted = true; return f.herdr(args); };
  assert.throws(() => runKitCommand('worker', ['start', 'demo', '--kind', 'codex', '--task', 'x', '--allow', 'src/', '--copy', '../outside'], {
    config: f.config, herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), (error) => /inside the repository/.test(error.message) && /START FAILED:/.test(error.message));
  assert.equal(prompted, false);
});

test('failed worker start deletes only its empty branch from a non-main base', () => {
  const root = temporaryRepo();
  git(root, 'switch', '-c', 'integrate/wave-18');
  fs.writeFileSync(path.join(root, 'integration.txt'), 'integration base\n');
  git(root, 'add', 'integration.txt');
  git(root, 'commit', '-m', 'integration base');
  git(root, 'switch', 'main');
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  const configFile = path.join(root, '.herdr-boss.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'integrate/wave-18', briefTemplate: template }));
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: '/not-ready' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1' }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'pane' && args[1] === 'close') return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const startUntilReadinessFails = (name, config, runSetup) => assert.throws(() => startWorker(name, {
    kind: 'codex', task: 'x', allow: ['src/'],
  }, {
    config, models: loadModels(), herdr, wait: () => {}, runSetup, rulesFile,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' },
  }), /did not become an available shell/);

  let config = loadProjectConfig({ cwd: root });
  startUntilReadinessFails('empty-branch', config);
  assert.equal(git(root, 'branch', '--list', 'empty-branch'), '');
  assert.equal(fs.existsSync(config.worktreePath('empty-branch')), false);

  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'integrate/wave-18', briefTemplate: template, setup: 'commit fixture change' }));
  config = loadProjectConfig({ cwd: root });
  let failure;
  try {
    startWorker('branch-with-work', { kind: 'codex', task: 'x', allow: ['src/'] }, {
      config, models: loadModels(), herdr, wait: () => {}, rulesFile,
      env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' },
      runSetup: (_command, worktree) => {
        fs.writeFileSync(path.join(worktree, 'worker-change.txt'), 'keep branch\n');
        git(worktree, 'add', 'worker-change.txt');
        git(worktree, 'commit', '-m', 'worker change');
      },
    });
  } catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /Failed-start branch branch-with-work was kept because it has commits beyond base integrate\/wave-18/);
  assert.match(git(root, 'branch', '--list', 'branch-with-work'), /branch-with-work/);
  assert.equal(fs.existsSync(config.worktreePath('branch-with-work')), true);
});

test('worker start submits a brief that was typed but not sent', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let status = 'idle';
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'prompt') throw new Error('prompt_transport_error');
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: status } };
    if (args[0] === 'agent' && args[1] === 'send-keys') { assert.deepEqual(args.slice(2), ['demo', 'enter']); status = 'working'; return {}; }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('demo', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: (line) => output.push(line),
    readText: () => `${CLAUDE_READY_SCREEN}\n❯ Read .worker/brief.md in your working directory and execute it.`, wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(calls.filter((call) => call === 'agent prompt').length, 1);
  assert.ok(calls.includes('agent send-keys'));
  assert.ok(output.some((line) => line.startsWith('Sent Enter to demo')));
});

test('worker readiness waits for the harness input marker', () => {
  const waits = [];
  let reads = 0;
  const herdrCalls = [];
  const ready = waitForAgentReady('demo', 'codex', {
    herdr: (args) => { herdrCalls.push(args); return { agent: { agent_status: 'idle' } }; },
    readText: () => ++reads < 3
      ? reads === 1 ? 'Loading session...' : '› Ask Codex to do anything'
      : CODEX_READY_SCREEN,
    wait: (ms) => waits.push(ms),
  });
  assert.equal(ready, true);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [500, 500]);
  assert.equal(herdrCalls.length, 3);
});

test('worker readiness requires Claude input line, box rules, and footer', () => {
  const waits = [];
  let reads = 0;
  const ready = waitForAgentReady('demo', 'claude', {
    herdr: () => ({ agent: { agent_status: 'idle' } }),
    readText: () => {
      reads++;
      if (reads === 1) return '❯\n────\nauto mode';
      if (reads === 2) return '────\n❯\n────';
      if (reads === 3) return '────\n❯ prompt\n────\nauto mode';
      return '────\n❯\n────\n? for shortcuts';
    },
    wait: (ms) => waits.push(ms),
  });
  assert.equal(ready, true);
  assert.equal(reads, 4);
  assert.deepEqual(waits, [500, 500, 500]);
  assert.equal(waitForAgentReady('demo', 'claude', {
    herdr: () => ({ agent: { agent_status: 'idle' } }),
    readText: () => CLAUDE_READY_SCREEN,
    wait: () => assert.fail('auto mode is a valid Claude footer'),
  }), true);
});

test('worker readiness uses a known status when a kind has no ready marker', () => {
  for (const kind of ['pi', 'future-harness']) {
    let reads = 0;
    const ready = waitForAgentReady('demo', kind, {
      herdr: () => ({ agent: { agent_status: 'blocked' } }),
      readText: () => { reads++; return ''; },
      wait: () => assert.fail(`${kind} should not wait after a known status`),
    });
    assert.equal(ready, true);
    assert.equal(reads, 0);
  }
});

test('OpenCode readiness waits for an idle interactive TUI before the brief', () => {
  const states = [
    { agent_status: 'working', interactive_ready: true },
    { agent_status: 'blocked', interactive_ready: true },
    { agent_status: 'idle', interactive_ready: false },
    { agent_status: 'idle', interactive_ready: true },
  ];
  const waits = [];
  assert.equal(waitForAgentReady('demo', 'opencode', {
    herdr: () => ({ agent: states.shift() }),
    wait: (ms) => waits.push(ms),
  }), true);
  assert.equal(states.length, 0);
  assert.deepEqual(waits, [500, 500, 500]);
});

function openCodeFixture(t, name) {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  const commands = [];
  let registered = false;
  let starts = 0;
  const missing = () => Object.assign(new Error('agent_not_found: fake TUI exited'), { code: 'agent_not_found' });
  const herdr = (args) => {
    commands.push(args);
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!registered) throw missing();
      return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: true } };
    }
    if (args[0] === 'agent' && args[1] === 'start') { starts++; registered = true; return {}; }
    if (args[0] === 'agent' && args[1] === 'close') { registered = false; return {}; }
    if (args[0] === 'pane' && args[1] === 'close') { registered = false; return f.herdr(args); }
    return f.herdr(args);
  };
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  return {
    f, commands, missing,
    get starts() { return starts; },
    exit: () => { registered = false; },
    start: (override = herdr, options = {}) => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], ...options }, {
      config: f.config, models: loadModels(), herdr: override, env: f.env, rulesFile: f.rulesFile,
      wait: () => {}, output: () => {}, tuiSupportsModelFlags: () => true,
    }),
    herdr,
  };
}

test('OpenCode start relaunches a fake TUI that exits at launch', (t) => {
  const f = openCodeFixture(t, 'opencode-launch-race');
  let failed = false;
  const run = f.start((args) => {
    const result = f.herdr(args);
    if (args[0] === 'agent' && args[1] === 'start' && !failed) {
      failed = true;
      f.exit();
      throw f.missing();
    }
    return result;
  });
  assert.equal(f.starts, 2);
  assert.equal(run.pane, 'ws:p2');
  assert.equal(f.commands.filter((args) => args[0] === 'agent' && args[1] === 'prompt').length, 1);
});

test('OpenCode start relaunches a fake TUI that exits after its first prompt', (t) => {
  const f = openCodeFixture(t, 'opencode-prompt-race');
  let failed = false;
  const run = f.start((args) => {
    if (args[0] === 'agent' && args[1] === 'prompt' && !failed) {
      failed = true;
      f.exit();
      throw f.missing();
    }
    return f.herdr(args);
  });
  assert.equal(f.starts, 2);
  assert.equal(run.name, 'opencode-prompt-race');
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).pane, 'ws:p2');
});

test('OpenCode startup retries a stalled idle TUI twice and gives a clear final error', (t) => {
  const f = openCodeFixture(t, 'opencode-stalled');
  assert.throws(() => f.start((args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') {
      throw Object.assign(new Error('agent_prompt_stalled: fake input failed'), { code: 'agent_prompt_stalled' });
    }
    return f.herdr(args);
  }), /OpenCode worker opencode-stalled failed after 3 launch attempts.*Brief prompt failed/s);
  assert.equal(f.starts, 3);
  assert.equal(f.commands.filter((args) => args[0] === 'agent' && args[1] === 'close').length, 2);
  assert.equal(f.commands.filter((args) => args[0] === 'pane' && args[1] === 'close').length, 1, 'final failure closes the failed pane');
});

test('OpenCode start lock release retries a busy mutation guard', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-opencode-release-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'opencode-start', 'owner.json');
  let calls = 0;
  // Call 1 acquires the lock. The guard is busy for the next two calls, as when a waiting process claims it again and again.
  const mutationLock = (directory, operation, options) => {
    if (++calls === 2 || calls === 3) {
      const busy = new Error('A project lock operation is already in progress.');
      busy.code = 'ELOCKBUSY';
      throw busy;
    }
    return withMutationLock(directory, operation, options);
  };
  assert.equal(withOpenCodeStartLock(dataDir, () => 'started', { timeoutMs: 5000, output: () => {}, wait: () => {}, mutationLock }), 'started');
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(file), false, 'the release removes the owner record');
});

test('OpenCode starts in separate processes share a lock through brief delivery', { timeout: 20000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-opencode-starts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const script = `
    import fs from 'node:fs';
    import { startWorker } from './src/kit/workers.js';
    import { loadModels } from './src/kit/config.js';
    import { setupFixture, git } from './test/helpers/kit-fixture.js';
    const f = setupFixture(null);
    const name = process.env.TEST_START_NAME;
    f.env.HERDR_BOSS_DIR = process.env.TEST_START_DIR;
    const event = (text) => {
      fs.appendFileSync(process.env.TEST_START_DIR + '/events', name + ':' + text + '\\n');
      process.send(text);
    };
    let registered = false;
    try {
      startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'] }, {
        config: f.config, models: loadModels(), env: f.env, rulesFile: f.rulesFile, wait: () => {},
        tuiSupportsModelFlags: () => true,
        output: (line) => { if (line.includes('Waiting for OpenCode start lock')) event('waiting'); },
        herdr: (args) => {
          if (args[0] === 'agent' && args[1] === 'start') {
            registered = true;
            event('launch');
          }
          if (args[0] === 'agent' && args[1] === 'get') {
            return { agent: { name, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', interactive_ready: registered } };
          }
          if (args[0] === 'agent' && args[1] === 'prompt') {
            if (name === 'first') fs.readSync(0, Buffer.alloc(1), 0, 1);
            event('brief');
            return {};
          }
          return f.herdr(args);
        },
      });
    } finally {
      try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
      fs.rmSync(f.root, { recursive: true, force: true });
      process.disconnect();
    }
  `;
  const start = (name) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...process.env, TEST_START_NAME: name, TEST_START_DIR: dataDir },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (text) => { stderr += text; });
    const messages = [];
    let consume;
    child.on('message', (event) => { messages.push(event); consume?.(); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => {
      consume = () => { consume = null; resolve(messages.shift()); };
    });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${name}: exit ${code}: ${stderr}`)));
    });
    exited.catch(() => {});
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, next, exited };
  };
  const first = start('first');
  assert.equal(await first.next(), 'launch');
  const second = start('second');
  try {
    assert.equal(await second.next(), 'waiting', 'another process must wait before it launches');
  } finally { first.child.stdin.end('x'); }
  await Promise.all([first.exited, second.exited]);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'events'), 'utf8').trim().split('\n'),
    ['first:launch', 'second:waiting', 'first:brief', 'second:launch', 'second:brief']);
});

test('OpenCode startup never relaunches a working, blocked, unknown, or reassigned agent', (t) => {
  for (const [name, state] of [
    ['working', { agent_status: 'working' }],
    ['blocked', { agent_status: 'blocked' }],
    ['unknown', { agent_status: 'unknown' }],
    ['reassigned', { pane_id: 'ws:other' }],
  ]) {
    const f = openCodeFixture(t, `opencode-${name}`);
    let launched = false;
    assert.throws(() => f.start((args) => {
      if (args[0] === 'agent' && args[1] === 'start') {
        f.herdr(args);
        launched = true;
        throw new Error('fake startup error');
      }
      if (launched && args[0] === 'agent' && args[1] === 'get') {
        return { agent: { name: `opencode-${name}`, pane_id: 'ws:p2', agent: 'opencode', agent_status: 'idle', ...state } };
      }
      return f.herdr(args);
    }), /Relaunch stopped/);
    assert.equal(f.starts, 1);
    assert.equal(f.commands.some((args) => args[0] === 'agent' && args[1] === 'close'), false);
    assert.equal(f.commands.some((args) => args[0] === 'pane' && args[1] === 'close'), false);
  }
});

test('OpenCode planner relaunch preserves its one planner session', (t) => {
  const f = openCodeFixture(t, 'opencode-planner');
  let failed = false;
  const run = f.start((args) => {
    if (args[0] === 'pane' && args[1] === 'rename') return {};
    if (args[0] === 'agent' && args[1] === 'prompt' && !failed) {
      failed = true;
      f.exit();
      throw f.missing();
    }
    return f.herdr(args);
  }, { planner: true });
  assert.equal(run.startAttempts, 2);
  const sessions = JSON.parse(fs.readFileSync(path.join(f.f.env.HERDR_BOSS_DIR, 'planner-sessions.json'), 'utf8'));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].pane, run.pane);
});

test('OpenCode relaunch budget also bounds agent_pane_busy launch errors', (t) => {
  const f = openCodeFixture(t, 'opencode-busy-start');
  assert.throws(() => f.start((args) => {
    const result = f.herdr(args);
    if (args[0] === 'agent' && args[1] === 'start') {
      f.exit();
      throw Object.assign(new Error('agent_pane_busy: fake launch race'), { code: 'agent_pane_busy' });
    }
    return result;
  }), /OpenCode worker opencode-busy-start failed after 3 launch attempts/);
  assert.equal(f.starts, 3, 'all launch attempts use the same three-attempt budget');
});

test('OpenCode final failure archives its run and permits clean reuse of the worker name', (t) => {
  const f = openCodeFixture(t, 'opencode-keep-evidence');
  assert.throws(() => f.start((args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') {
      f.exit();
      throw f.missing();
    }
    const result = f.herdr(args);
    if (args[0] === 'agent' && args[1] === 'start' && f.starts > 1) {
      f.exit();
      throw f.missing();
    }
    return result;
  }), /OpenCode worker opencode-keep-evidence failed after 3 launch attempts/);
  assert.equal(f.starts, 3);
  assert.equal(fs.existsSync(f.f.config.worktreePath('opencode-keep-evidence')), false);
  assert.equal(fs.existsSync(path.join(f.f.config.runsPath, 'opencode-keep-evidence.json')), false);
  assert.equal(git(f.f.root, 'branch', '--list', 'opencode-keep-evidence'), '');
  const archive = path.join(f.f.root, '.orchestration', 'reports', 'opencode-keep-evidence');
  const archivedRun = JSON.parse(fs.readFileSync(path.join(archive, 'run.json'), 'utf8'));
  assert.equal(archivedRun.name, 'opencode-keep-evidence');
  assert.equal(archivedRun.outcome, 'failed');
  assert.equal(archivedRun.startAttempts, 3);
  assert.ok(fs.existsSync(path.join(archive, 'brief.md')));
  assert.equal(f.commands.filter((args) => args[0] === 'pane' && args[1] === 'close').length, 1);
  const reused = f.start();
  assert.equal(reused.name, 'opencode-keep-evidence');
});

test('OpenCode final failure keeps dirty or committed worktrees and archives their runs', (t) => {
  for (const mode of ['dirty', 'committed']) {
    const name = `opencode-keep-${mode}`;
    const f = openCodeFixture(t, name);
    let madeChange = false;
    assert.throws(() => f.start((args) => {
      if (args[0] === 'agent' && args[1] === 'prompt') {
        if (!madeChange) {
          const worktree = f.f.config.worktreePath(name);
          fs.writeFileSync(path.join(worktree, 'worker-change.txt'), 'keep this work\n');
          if (mode === 'committed') { git(worktree, 'add', 'worker-change.txt'); git(worktree, 'commit', '-m', 'worker change'); }
          madeChange = true;
        }
        f.exit();
        throw f.missing();
      }
      return f.herdr(args);
    }), /kept because.*(?:changes|commits beyond base)/);
    assert.equal(fs.existsSync(f.f.config.worktreePath(name)), true);
    assert.equal(fs.readFileSync(path.join(f.f.config.worktreePath(name), 'worker-change.txt'), 'utf8'), 'keep this work\n');
    assert.match(git(f.f.root, 'branch', '--list', name), new RegExp(name));
    assert.equal(fs.existsSync(path.join(f.f.config.runsPath, `${name}.json`)), false);
    assert.ok(fs.existsSync(path.join(f.f.root, '.orchestration', 'reports', name, 'run.json')));
  }
});

test('worker start adds its own worker folder to allowed paths', () => {
  const f = setupFixture(null);
  const separate = startWorker('separate', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.deepEqual(separate.allowedPaths, ['src/', '.worker/**']);
  const shared = startWorker('shared', { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.deepEqual(shared.allowedPaths, ['src/', '.worker/shared/**']);
  assert.deepEqual(JSON.parse(fs.readFileSync(shared.recordFile, 'utf8')).allowedPaths, ['src/', '.worker/shared/**']);
});

test('worker start read-only mode needs no allow path and rejects one', () => {
  const f = setupFixture(null);
  const options = { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} };
  assert.throws(() => runKitCommand('worker', ['start', 'read-only-conflict', '--kind', 'codex', '--task', 'x', '--read-only', '--allow', 'src/'], options), /--read-only cannot be used with --allow/);
  const run = runKitCommand('worker', ['start', 'read-only', '--kind', 'codex', '--task', 'x', '--read-only'], options);
  assert.equal(run.readOnly, true);
  assert.deepEqual(run.allowedPaths, ['.worker/**']);
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).readOnly, true);
  fs.writeFileSync(path.join(run.worktree, 'README.md'), 'changed outside the worker folder\n');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Status: done\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: ['README.md'],
    commands: ['check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  assert.throws(() => collectWorker('read-only', { noRecord: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  }), /changed paths outside its allowed scope: README\.md/);
});

test('worker start sends after the ready wait and reports its timeout', () => {
  const f = setupFixture(null);
  let reads = 0;
  const output = [];
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    return f.herdr(args);
  };
  startWorker('ready-timeout', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile,
    readText: () => { reads++; return 'Starting Claude...'; }, wait: () => {}, output: (line) => output.push(line),
  });
  assert.equal(reads, 91);
  assert.ok(output.includes('Notice: ready-timeout did not show a ready prompt in 45 s; sent the brief anyway.'));
  assert.ok(f.calls.includes('agent prompt'));
});

test('worker start resends a brief that never reached the agent', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  let prompts = 0;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'prompt') { prompts++; if (prompts === 1) throw Object.assign(new Error('first agent_prompt_stalled'), { code: 'agent_prompt_stalled' }); return {}; }
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('demo', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: (line) => output.push(line), readText: () => CLAUDE_READY_SCREEN, wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(prompts, 2);
  assert.ok(output.includes('Resent the brief prompt to demo after agent_prompt_stalled.'));
});

test('worker start waits for readiness before retrying a stalled brief prompt', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  let promptCount = 0;
  let reads = 0;
  const waits = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('retry-ready') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'prompt') {
      promptCount++;
      if (promptCount === 1) throw Object.assign(new Error('first agent_prompt_stalled'), { code: 'agent_prompt_stalled' });
      return {};
    }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('retry-ready', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: (line) => output.push(line),
    readText: () => ++reads === 1 || reads >= 4 ? CLAUDE_READY_SCREEN : 'Loading Claude...',
    wait: (ms) => waits.push(ms),
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(promptCount, 2);
  assert.equal(reads, 4);
  assert.deepEqual(waits, [500, 500]);
  assert.ok(output.includes('Resent the brief prompt to retry-ready after agent_prompt_stalled.'));
});

test('worker start reports both attempts when a stalled prompt retry fails', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  let prompts = 0;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('double-stall') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'prompt') {
      prompts++;
      throw Object.assign(new Error(`try-${prompts}-agent_prompt_stalled`), { code: 'agent_prompt_stalled' });
    }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.throws(() => startWorker('double-stall', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: () => {}, readText: () => CLAUDE_READY_SCREEN, wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  }), (error) => /try-1-agent_prompt_stalled/.test(error.message)
    && /try-2-agent_prompt_stalled/.test(error.message));
  assert.equal(prompts, 2);
});

test('worker start load warning names the load, the limit, and the actions', async () => {
  const { describeMachine, loadWarning } = await import('../src/kit/workers.js');
  assert.equal(loadWarning({ machine: { owner: 'present', cpuPercent: 12, cpuLimit: 70, fiveMinute: 12, loadLimit: 20 } }), null);
  assert.equal(loadWarning({}), null);
  const text = loadWarning({ machine: { owner: 'away', cpuPercent: 98, cpuLimit: 95, fiveMinute: 84.2, loadLimit: null } });
  assert.match(describeMachine({ machine: { owner: 'away', cpuPercent: 98, cpuLimit: 95, fiveMinute: 84.2, loadLimit: null } }), /^Machine guard active\. Owner away; CPU 98\.0% \/ limit 95%; 5-minute load 84\.2 \/ backstop disabled/);
  assert.match(text, /CPU 98\.0% \/ limit 95%/);
  assert.match(text, /5-minute load 84\.2 \/ backstop disabled/);
  assert.match(text, /--force cannot bypass/);
  assert.match(loadWarning({ machine: { owner: 'present', cpuLimit: 70, fiveMinute: 25, loadLimit: 24 } }), /CPU unknown/);
  assert.match(loadWarning({ machine: { owner: 'present', cpuPercent: 80, cpuLimit: 70, fiveMinute: 1, loadLimit: null, guardState: 'paused', guardEnabled: true, guardPausedUntil: new Date(Date.now() - 1000).toISOString() } }), /Machine limit exceeded/, 'an expired pause activates the guard again');
});

function writeWorkerReport(run, extra = {}) {
  const reportDir = path.join(run.worktree, run.workerDir || '.worker');
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Report.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null,
    branch: run.branch,
    worktree: run.worktree,
    changedPaths: [],
    commands: ['focused check'],
    evidenceTier: ['unit'],
    unverified: [],
    stoppedEarly: false,
    ...extra,
  }));
}

function cleanWorkerRun(t, fixture, run) {
  t.after(() => {
    try { git(fixture.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
    if (run.branch && run.branch !== 'main') {
      try { git(fixture.root, 'branch', '-D', run.branch); } catch {}
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
}

function prepareCollectPruneFixture(t, name, { merge = true } = {}) {
  const f = setupFixture(null);
  const run = startWorker(name, { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  fs.mkdirSync(path.join(run.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(run.worktree, 'src', 'change.js'), 'export const changed = true;\n');
  git(run.worktree, 'add', 'src/change.js');
  git(run.worktree, 'commit', '-m', 'worker change');
  if (merge) git(f.root, 'merge', '--ff-only', run.branch);
  writeWorkerReport(run, { changedPaths: ['src/change.js'] });
  return { f, run };
}

function collectWithPruning(f, run, { pruneAtCollect = true, panes = [], processes = [], outputFn = null } = {}) {
  const output = [];
  const herdr = (args) => args[0] === 'pane' && args[1] === 'list' ? { panes } : f.herdr(args);
  const summary = runKitCommand('worker', ['collect', run.name, '--outcome', 'done', '--gate-passed'], {
    config: f.config,
    env: f.env,
    herdr,
    serviceConfig: { workers: { paneCloseDelayMinutes: 2 }, worktrees: { pruneAtCollect } },
    listProcesses: () => processes,
    listWorktreeProcesses: () => [],
    schedulePaneCloseFn: () => {},
    output: outputFn ?? ((line) => output.push(line)),
  });
  return { summary, output };
}

test('worker collect removes a merged worktree after it archives the reports', (t) => {
  const { f, run } = prepareCollectPruneFixture(t, 'collect-prune-merged');
  const { summary, output } = collectWithPruning(f, run);

  assert.equal(summary.name, run.name);
  assert.equal(fs.existsSync(run.worktree), false);
  assert.equal(git(f.root, 'branch', '--list', run.branch), '');
  const archive = path.join(f.root, '.orchestration', 'reports', run.name);
  assert.equal(fs.readFileSync(path.join(archive, 'report.md'), 'utf8'), 'Report.\n');
  assert.ok(output.includes(`Worker ${run.name}: removed merged worktree and branch ${run.branch}.`));
});

test('worker collect keeps worktrees that are unmerged, disabled, live, or in use', (t) => {
  const cases = [
    { name: 'collect-prune-unmerged', merge: false, expected: /branch collect-prune-unmerged is not merged into the base branch/ },
    { name: 'collect-prune-disabled', merge: true, pruneAtCollect: false, expected: /worktrees\.pruneAtCollect is off/ },
    { name: 'collect-prune-live', merge: true, panes: (run) => [{ cwd: run.worktree, status: 'working' }], expected: /a live pane uses the worktree/ },
    { name: 'collect-prune-busy', merge: true, processes: (run) => [{ pid: 1234, ppid: 42, command: 'node', cwd: run.worktree }], expected: /a process uses the worktree/ },
  ];
  for (const item of cases) {
    const { f, run } = prepareCollectPruneFixture(t, item.name, { merge: item.merge });
    const { output } = collectWithPruning(f, run, {
      pruneAtCollect: item.pruneAtCollect ?? true,
      panes: typeof item.panes === 'function' ? item.panes(run) : [],
      processes: typeof item.processes === 'function' ? item.processes(run) : [],
    });
    assert.equal(fs.existsSync(run.worktree), true, item.name);
    assert.ok(output.some((line) => line.startsWith(`Worker ${item.name}: kept worktree because `) && item.expected.test(line)), item.name);
  }
});

test('worker collect will not prune a different registered worktree from its run record', (t) => {
  const { f, run } = prepareCollectPruneFixture(t, 'collect-prune-misdirected');
  const otherName = 'collect-prune-other';
  const otherBranch = otherName;
  const otherWorktree = f.config.worktreePath(otherName);
  fs.mkdirSync(path.dirname(otherWorktree), { recursive: true });
  git(f.root, 'worktree', 'add', '-b', otherBranch, otherWorktree, 'main');
  t.after(() => fs.rmSync(otherWorktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(otherWorktree, '.worker'), { recursive: true });
  const otherRun = { ...run, branch: otherBranch, worktree: otherWorktree };
  writeWorkerReport(otherRun, { changedPaths: [] });
  const record = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  record.branch = otherBranch;
  record.worktree = otherWorktree;
  record.baseCommit = git(f.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(run.recordFile, JSON.stringify(record));
  const output = [];

  const summary = runKitCommand('worker', ['collect', run.name, '--outcome', 'done', '--gate-passed'], {
    config: f.config,
    env: f.env,
    herdr: (args) => args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : f.herdr(args),
    serviceConfig: { workers: { paneCloseDelayMinutes: 2 }, worktrees: { pruneAtCollect: true } },
    listProcesses: () => [],
    listWorktreeProcesses: () => [],
    schedulePaneCloseFn: () => {},
    output: (line) => output.push(line),
  });

  assert.equal(summary.name, run.name);
  assert.equal(fs.existsSync(otherWorktree), true);
  assert.equal(fs.existsSync(run.worktree), true);
  assert.ok(output.includes(`Worker ${run.name}: kept worktree because it is outside the worktree folder.`));
});

test('worker collect survives a failure while reporting the prune result after recording', (t) => {
  const { f, run } = prepareCollectPruneFixture(t, 'collect-prune-output-error');
  const summaryLine = `Worker ${run.name}: removed merged worktree and branch ${run.branch}.`;
  const { summary } = collectWithPruning(f, run, {
    outputFn: (line) => {
      if (line === summaryLine) throw new Error('summary output failed');
    },
  });

  assert.equal(summary.name, run.name);
  assert.equal(fs.existsSync(run.worktree), false);
  assert.equal(fs.existsSync(f.config.ledgerPath), true);
});

test('worker collect records by default when the orchestrator gives the review result', (t) => {
  const f = setupFixture(null);
  const run = startWorker('collect-default', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  writeWorkerReport(run);

  assert.throws(() => collectWorker('collect-default', {}, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }),
  }), /Use --no-record to read the report without a ledger entry\./);
  const scheduled = [];
  const collectionNow = Date.parse('2026-10-01T12:00:00Z');
  const summary = collectWorker('collect-default', { outcome: 'done', gatePassed: true, paneCloseDelayMinutes: 2 }, {
    config: f.config, now: collectionNow, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }),
    schedulePaneCloseFn: (entry) => scheduled.push(entry),
  });

  assert.equal(summary.name, 'collect-default');
  const record = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.equal(record.outcome, 'done');
  assert.equal(record.finishedAt, '2026-10-01T12:00:00.000Z');
  assert.equal(record.collectedAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(scheduled, [{
    project: f.config.slug,
    name: 'collect-default',
    runId: workerRunId(record, f.config.slug),
    dueAt: collectionNow + 2 * 60_000,
  }]);
  assert.equal(readWorkerFacts(f.config.runsPath, { isLive: () => false, isMerged: () => false })[0].phase, 'review');
  assert.equal(fs.readFileSync(f.config.ledgerPath, 'utf8').trim().split('\n').length, 1);
});

test('worker collect --keep-pane does not schedule a pane close', (t) => {
  const f = setupFixture(null);
  const run = startWorker('collect-keep-pane', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  writeWorkerReport(run);
  const scheduled = [];

  const summary = runKitCommand('worker', ['collect', 'collect-keep-pane', '--outcome', 'done', '--gate-passed', '--keep-pane'], {
    config: f.config,
    env: f.env,
    herdr: f.herdr,
    output: () => {},
    serviceConfig: { workers: { paneCloseDelayMinutes: 2 } },
    schedulePaneCloseFn: (entry) => scheduled.push(entry),
  });

  assert.equal(summary.name, 'collect-keep-pane');
  assert.deepEqual(scheduled, []);
});

test('worker collect --no-record reads the report and changes no run or ledger record', (t) => {
  const f = setupFixture(null);
  const run = startWorker('collect-dry-read', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  writeWorkerReport(run);
  const before = fs.readFileSync(run.recordFile, 'utf8');
  const output = [];

  const summary = runKitCommand('worker', ['collect', 'collect-dry-read', '--no-record'], {
    config: f.config, env: { ...f.env, HERDR_BOSS_DIR: path.join(f.root, 'temporary-boss') }, herdr: f.herdr, output: (line) => output.push(line),
  });

  assert.equal(summary.name, 'collect-dry-read');
  assert.ok(output.some((line) => line.includes('collect-dry-read')));
  assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.throws(() => runKitCommand('worker', ['collect', 'collect-dry-read', '--record'], {
    config: f.config, env: f.env, herdr: f.herdr, output: () => {},
  }), /--record needs:[\s\S]*Use --no-record to read the report without a ledger entry/);
  assert.throws(() => runKitCommand('worker', ['collect', 'collect-dry-read', '--record', '--no-record'], {
    config: f.config, env: f.env, herdr: f.herdr, output: () => {},
  }), /Use either --record or --no-record/);
  assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before);
});

test('a refused worker collect closes nothing and writes no ledger entry', (t) => {
  const f = setupFixture(null);
  const run = startWorker('collect-refused', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  writeWorkerReport(run, { changedPaths: ['outside.js'] });
  const before = fs.readFileSync(run.recordFile, 'utf8');
  const scheduled = [];

  assert.throws(() => collectWorker('collect-refused', { outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }),
    schedulePaneCloseFn: (job) => scheduled.push(job),
  }), /changed paths outside its allowed scope/);

  assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.deepEqual(scheduled, [], 'a refused collect schedules no pane close');
});

test('worker collect refuses a symlink report.md', (t) => {
  const f = setupFixture(null);
  const run = startWorker('collect-report-link', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  cleanWorkerRun(t, f, run);
  writeWorkerReport(run);
  const reportDir = path.join(run.worktree, run.workerDir || '.worker');
  const reportPath = path.join(reportDir, 'report.md');
  const targetPath = path.join(run.worktree, 'report-target.md');
  const recordBefore = fs.readFileSync(run.recordFile, 'utf8');
  fs.writeFileSync(targetPath, 'Outside report.');
  fs.unlinkSync(reportPath);
  fs.symlinkSync(targetPath, reportPath);

  assert.throws(() => collectWorker('collect-report-link', { outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }),
  }), /Worker report must be a regular file/);
  assert.equal(fs.readFileSync(run.recordFile, 'utf8'), recordBefore);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
});

test('worker start copies local orchestration files from the main checkout safely', (t) => {
  const f = setupFixture(null);
  const local = path.join(f.root, '.orchestration', 'local');
  const nested = path.join(local, 'nested');
  const existing = path.join(nested, 'pre-existing.txt');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(existing, 'base version\n');
  git(f.root, 'add', '.orchestration/local/nested/pre-existing.txt');
  git(f.root, 'commit', '-m', 'track existing local input');
  fs.writeFileSync(existing, 'source version\n');
  const newDirectory = path.join(nested, 'private-dir');
  fs.mkdirSync(newDirectory, { mode: 0o700 });
  fs.chmodSync(newDirectory, 0o700);
  fs.writeFileSync(path.join(newDirectory, 'private-token-name.txt'), 'copied\n', { mode: 0o600 });
  fs.chmodSync(path.join(newDirectory, 'private-token-name.txt'), 0o600);
  fs.writeFileSync(path.join(nested, 'oversize-private-name.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(nested, 'link-target.txt'), 'target\n');
  const readOnlySource = path.join(nested, 'read-only-source');
  fs.mkdirSync(readOnlySource, { mode: 0o700 });
  fs.writeFileSync(path.join(readOnlySource, 'allowed.txt'), 'nested readonly\n');
  fs.chmodSync(readOnlySource, 0o500);
  fs.symlinkSync('link-target.txt', path.join(nested, 'private-link-name.txt'));
  for (const hidden of ['.worker', '.git']) {
    fs.mkdirSync(path.join(local, hidden));
    fs.writeFileSync(path.join(local, hidden, 'private-name.txt'), 'do not copy\n');
  }

  const alternate = path.join(os.tmpdir(), `herdr-kit-caller-${process.pid}-${Date.now()}`);
  git(f.root, 'worktree', 'add', '-b', 'caller-checkout', alternate, 'main');
  const config = loadProjectConfig({ cwd: alternate });
  const output = [];
  const run = startWorker('copy-local', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  });
  t.after(() => {
    try { fs.chmodSync(readOnlySource, 0o700); } catch {}
    try { fs.chmodSync(path.join(run.worktree, '.orchestration', 'local', 'nested', 'read-only-source'), 0o700); } catch {}
    try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
    try { git(f.root, 'branch', '-D', run.branch); } catch {}
    try { git(f.root, 'worktree', 'remove', '--force', alternate); } catch {}
    try { git(f.root, 'branch', '-D', 'caller-checkout'); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  const target = path.join(run.worktree, '.orchestration', 'local', 'nested');
  assert.equal(fs.readFileSync(path.join(target, 'pre-existing.txt'), 'utf8'), 'base version\n', 'the worker checkout keeps an existing file');
  assert.equal(fs.readFileSync(path.join(target, 'private-dir', 'private-token-name.txt'), 'utf8'), 'copied\n');
  assert.equal(fs.statSync(path.join(target, 'private-dir')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(target, 'private-dir', 'private-token-name.txt')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(target, 'oversize-private-name.bin')), false);
  assert.equal(fs.existsSync(path.join(target, 'private-link-name.txt')), false);
  assert.equal(fs.existsSync(path.join(run.worktree, '.orchestration', 'local', '.worker')), false);
  assert.equal(fs.existsSync(path.join(run.worktree, '.orchestration', 'local', '.git')), false);
  assert.equal(fs.readFileSync(path.join(target, 'link-target.txt'), 'utf8'), 'target\n', 'the regular link target is copied');
  assert.equal(fs.readFileSync(path.join(target, 'read-only-source', 'allowed.txt'), 'utf8'), 'nested readonly\n');
  assert.equal(fs.statSync(path.join(target, 'read-only-source')).mode & 0o777, 0o500);
  assert.equal(git(run.worktree, 'status', '--porcelain', '--untracked-files=all'), '', 'the local copy is not a product change');
  assert.match(output.join('\n'), /Copied 3 files from \.orchestration\/local\./);
  assert.match(output.join('\n'), /Warning: skipped 1 file over 5 MB from \.orchestration\/local\./);
  assert.doesNotMatch(output.join('\n'), /private-token-name|oversize-private-name|private-link-name/);
});

test('worker start skips unreadable local orchestration files and warns', { skip: process.getuid?.() === 0 }, (t) => {
  const f = setupFixture(null);
  const local = path.join(f.root, '.orchestration', 'local');
  fs.mkdirSync(local, { recursive: true });
  const copied = path.join(local, 'readable.txt');
  const unreadable = path.join(local, 'unreadable.txt');
  fs.writeFileSync(copied, 'copy me\n');
  fs.writeFileSync(unreadable, 'skip me\n');
  fs.chmodSync(unreadable, 0o000);

  const alternate = path.join(os.tmpdir(), `herdr-kit-caller-unreadable-${process.pid}-${Date.now()}`);
  git(f.root, 'worktree', 'add', '-b', 'caller-unreadable', alternate, 'main');
  const config = loadProjectConfig({ cwd: alternate });
  const output = [];
  let run = null;
  t.after(() => {
    try { fs.chmodSync(unreadable, 0o600); } catch {}
    const worktree = run?.worktree ?? config.worktreePath('copy-unreadable');
    try { fs.chmodSync(path.join(worktree, '.orchestration', 'local', 'unreadable.txt'), 0o600); } catch {}
    try { git(f.root, 'worktree', 'remove', '--force', worktree); } catch {}
    try { git(f.root, 'worktree', 'prune'); } catch {}
    try { git(f.root, 'branch', '-D', run?.branch ?? 'copy-unreadable'); } catch {}
    try { git(f.root, 'worktree', 'remove', '--force', alternate); } catch {}
    try { git(f.root, 'branch', '-D', 'caller-unreadable'); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  run = startWorker('copy-unreadable', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  });

  const target = path.join(run.worktree, '.orchestration', 'local');
  assert.equal(fs.readFileSync(path.join(target, 'readable.txt'), 'utf8'), 'copy me\n');
  assert.equal(fs.existsSync(path.join(target, 'unreadable.txt')), false);
  assert.ok(output.includes('Warning: skipped 1 unreadable file(s) from .orchestration/local.'));
});

test('worker start rejects a local orchestration destination symlink', (t) => {
  const f = setupFixture(null);
  const local = path.join(f.root, '.orchestration', 'local');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'readable.txt'), 'copy me\n');

  const alternate = path.join(os.tmpdir(), `herdr-kit-caller-local-link-${process.pid}-${Date.now()}`);
  git(f.root, 'worktree', 'add', '-b', 'caller-local-link', alternate, 'main');
  const destinationParent = path.join(alternate, '.orchestration');
  fs.mkdirSync(destinationParent, { recursive: true });
  fs.symlinkSync('missing-local-target', path.join(destinationParent, 'local'));
  git(alternate, 'add', '.orchestration/local');
  git(alternate, 'commit', '-m', 'add local orchestration destination link');

  const config = loadProjectConfig({ cwd: alternate });
  let run = null;
  t.after(() => {
    const worktree = run?.worktree ?? config.worktreePath('copy-local-link');
    try { git(f.root, 'worktree', 'remove', '--force', worktree); } catch {}
    try { git(f.root, 'worktree', 'prune'); } catch {}
    try { git(f.root, 'branch', '-D', run?.branch ?? 'copy-local-link'); } catch {}
    try { git(f.root, 'worktree', 'remove', '--force', alternate); } catch {}
    try { git(f.root, 'branch', '-D', 'caller-local-link'); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  assert.throws(() => {
    run = startWorker('copy-local-link', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'], base: 'caller-local-link' }, {
      config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    });
  }, /Could not copy local orchestration files/);
});

test('worker start prints nothing about local orchestration when the folder is absent', (t) => {
  const f = setupFixture(null);
  const output = [];
  const run = startWorker('no-local', { kind: 'codex', task: 'x', taskId: 'T1', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  });
  cleanWorkerRun(t, f, run);
  assert.doesNotMatch(output.join('\n'), /Copied .*\.orchestration\/local|skipped .*\.orchestration\/local/);
});

test('a forced Claude Opus start logs an event and sends one line to the Boss pane', (t) => {
  const f = setupFixture(null);
  const dataDir = path.join(f.root, 'temporary-boss-data');
  const env = { ...f.env, HERDR_BOSS_DIR: dataDir };
  const bossPrompts = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'list') {
      const result = f.herdr(args);
      return { ...result, panes: [...result.panes, { pane_id: 'boss:p1', workspace_id: 'boss', label: 'boss' }] };
    }
    if (args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'boss:p1') {
      bossPrompts.push(args);
      return {};
    }
    return f.herdr(args);
  };
  const output = [];

  const run = startWorker('opus-worker', { kind: 'claude', model: 'claude-opus-5-5', task: 'x', taskId: 'OP1', allow: ['src/'], noWorktree: true, force: true }, {
    config: f.config, models: loadModels(), herdr, env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const line = 'Opus worker: opus-worker runs claude-opus-5-5 (forced).';
  assert.ok(output.includes(line));
  assert.deepEqual(bossPrompts, [['agent', 'prompt', 'boss:p1', line]]);
  const [event] = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(event.type, 'worker-opus');
  assert.equal(event.worker, 'opus-worker');
  assert.equal(event.taskId, 'OP1');
  assert.equal(event.project, f.config.slug);
  assert.equal(run.model, 'claude-opus-5-5');

  const missingBossOutput = [];
  startWorker('opus-no-boss', { kind: 'claude', model: 'claude-opus-5-5', task: 'x', taskId: 'OP3', allow: ['src/'], noWorktree: true, force: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env, rulesFile: f.rulesFile, output: (line) => missingBossOutput.push(line),
  });
  assert.ok(missingBossOutput.includes('Opus worker: opus-no-boss runs claude-opus-5-5 (forced).'));
  assert.ok(missingBossOutput.includes('Warning: no Boss pane was found; the Opus start alert was not sent.'));
  assert.equal(bossPrompts.length, 1);
});

test('an Opus refusal logs silently, and other worker models do not alert the Boss', (t) => {
  const refused = setupFixture(null);
  const refusedDir = path.join(refused.root, 'refused-data');
  const refusedOutput = [];
  assert.throws(() => startWorker('opus-refused', {
    kind: 'claude', model: 'claude-opus-5-5', task: 'x', taskId: 'OP2', allow: ['src/'], noWorktree: true,
  }, {
    config: refused.config, models: loadModels(), herdr: refused.herdr,
    env: { ...refused.env, HERDR_BOSS_DIR: refusedDir }, rulesFile: refused.rulesFile, output: (line) => refusedOutput.push(line),
  }), /needs the Owner's approval/);
  t.after(() => fs.rmSync(refused.root, { recursive: true, force: true }));
  const [refusedEvent] = fs.readFileSync(path.join(refusedDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(refusedEvent.type, 'worker-opus-refused');
  assert.equal(refusedEvent.worker, 'opus-refused');
  assert.equal(refusedEvent.taskId, 'OP2');
  assert.equal(refusedEvent.project, refused.config.slug);
  assert.equal(refusedOutput.some((line) => line.startsWith('Opus worker:')), false);

  const dryRun = setupFixture(null);
  const dryRunDir = path.join(dryRun.root, 'dry-run-data');
  assert.throws(() => startWorker('opus-dry-run', {
    kind: 'claude', model: 'claude-opus-5-5', task: 'x', taskId: 'OP4', allow: ['src/'], dryRun: true,
  }, {
    config: dryRun.config, models: loadModels(), herdr: dryRun.herdr,
    env: { ...dryRun.env, HERDR_BOSS_DIR: dryRunDir }, rulesFile: dryRun.rulesFile, output: () => {},
  }), /needs the Owner's approval/);
  assert.equal(fs.existsSync(path.join(dryRunDir, 'events.jsonl')), false, 'dry-run changes no event data');
  t.after(() => fs.rmSync(dryRun.root, { recursive: true, force: true }));

  for (const [name, kind, model] of [
    ['codex-worker', 'codex', undefined],
    ['claude-sonnet', 'claude', 'claude-sonnet-5-5'],
  ]) {
    const f = setupFixture(null);
    const dataDir = path.join(f.root, 'temporary-boss-data');
    const prompts = [];
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'list') {
        const result = f.herdr(args);
        return { ...result, panes: [...result.panes, { pane_id: 'boss:p1', workspace_id: 'boss', label: 'boss' }] };
      }
      if (args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'boss:p1') { prompts.push(args); return {}; }
      return f.herdr(args);
    };
    const output = [];
    const run = startWorker(name, { kind, ...(model ? { model } : {}), task: 'x', taskId: 'T3', allow: ['src/'], noWorktree: true, force: true }, {
      config: f.config, models: loadModels(), herdr, env: { ...f.env, HERDR_BOSS_DIR: dataDir }, rulesFile: f.rulesFile, output: (line) => output.push(line),
    });
    assert.equal(run.model, model ?? 'gpt-6-luna');
    assert.equal(fs.existsSync(path.join(dataDir, 'events.jsonl')), false);
    assert.deepEqual(prompts, []);
    assert.equal(output.some((line) => line.startsWith('Opus worker:')), false);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  }
});

// A fake pane whose TUI shows `phrase` after a launch of `blockedModel`. Other models launch normally.
function blockedLaunchFixture(t, name, blockedModel, phrase) {
  const fixture = openCodeFixture(t, name);
  const launched = [];
  const closedPanes = [];
  let showing = false;
  let blockedLaunches = 0;
  const modelOfStart = (args) => args[args.indexOf('-m') + 1];
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'start') {
      const model = modelOfStart(args);
      launched.push(model);
      showing = model === blockedModel;
      if (showing) blockedLaunches++;
    }
    // Each blocked launch prints the phrase again.
    if (args[0] === 'pane' && args[1] === 'read' && showing) return { text: `opencode\n${`${phrase}\n`.repeat(blockedLaunches)}` };
    if (args[0] === 'pane' && args[1] === 'close') { closedPanes.push(args[2]); showing = false; }
    return fixture.herdr(args);
  };
  const dataDir = fixture.f.env.HERDR_BOSS_DIR;
  const records = () => {
    try { return Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'unavailable-models.json'), 'utf8'))); }
    catch { return []; }
  };
  return { ...fixture, herdr, launched, closedPanes, records, startWith: (options = {}) => fixture.start(herdr, options) };
}

// The last value is the number of launches of the blocked model. A country block and a rate limit fail once.
const LAUNCH_BLOCK_CASES = [
  ['not available in your country', 'This model is not available in your country', true, 1],
  ['Rate limit exceeded', 'Error: rate limit exceeded', false, 1],
];

for (const [phrase, paneText, untilReenabled, launches] of LAUNCH_BLOCK_CASES) {
  test(`OpenCode start with --model fails once on "${phrase}", closes the pane, and marks the model`, (t) => {
    const model = 'opencode/mimo-v2.6-flash-free';
    const f = blockedLaunchFixture(t, `opencode-block-${untilReenabled ? 'hold' : 'rate'}-${phrase.length}`, model, paneText);
    assert.throws(() => f.startWith({ model }), (error) => {
      assert.match(error.message, new RegExp(phrase.replace('?', '\\?'), 'i'));
      assert.doesNotMatch(error.message, /failed after 3 launch attempts/);
      return true;
    });
    assert.deepEqual(f.launched, Array(launches).fill(model), 'the same model is launched only as often as the phrase allows');
    assert.equal(f.closedPanes.length, 1);
    const [record] = f.records();
    assert.equal(record.model, model);
    assert.equal(record.kind, 'opencode');
    assert.equal(record.provider, null);
    if (untilReenabled) assert.equal(record.untilReenabled, true);
    else {
      assert.equal(record.untilReenabled, undefined);
      assert.ok(record.retryAt - Date.now() > 29 * 60 * 1000 && record.retryAt - Date.now() <= 30 * 60 * 1000);
    }
  });

  test(`OpenCode start without --model falls back after "${phrase}" and does not launch the default again`, (t) => {
    const blocked = loadModels().kinds.opencode.defaultModel;
    const f = blockedLaunchFixture(t, `opencode-fallback-${untilReenabled ? 'hold' : 'rate'}-${phrase.length}`, blocked, paneText);
    const run = f.startWith();
    assert.equal(f.launched.length, launches + 1);
    assert.deepEqual(f.launched.slice(0, launches), Array(launches).fill(blocked));
    assert.notEqual(f.launched.at(-1), blocked);
    assert.equal(run.model, f.launched.at(-1));
    assert.equal(run.modelSource, 'fallback');
    assert.equal(f.closedPanes.length, 1, 'the blocked pane is closed');
    assert.equal(f.records().length, 1);
    assert.equal(f.records()[0].model, blocked);
  });
}

test('A model marked until re-enabled is refused with --model and skipped without it', (t) => {
  const f = blockedLaunchFixture(t, 'opencode-marked-before', 'none', '');
  const blocked = loadModels().kinds.opencode.defaultModel;
  markModelUnavailable(f.f.env.HERDR_BOSS_DIR, { kind: 'opencode', model: blocked, untilReenabled: true, label: 'test', reason: 'test' });
  assert.throws(() => f.startWith({ model: blocked, dryRun: true }), /unavailable until the Owner re-enables it.*models enable opencode\/opencode\/big-pickle/s);
  const plan = f.startWith({ dryRun: true });
  assert.equal(plan.modelSource, 'fallback');
  assert.notEqual(plan.model, blocked);
  assert.deepEqual(f.launched, []);
  enableModel(f.f.env.HERDR_BOSS_DIR, 'opencode', blocked);
  assert.equal(f.startWith({ dryRun: true }).model, blocked);
});

test('waitForWorkerPane raises model_launch_blocked for each launch phrase before the interactive question check', () => {
  for (const text of ['This model is not available in your country', 'Rate limit exceeded']) {
    const herdr = (args) => {
      if (args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/work' } };
      if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
      if (args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
      if (args[1] === 'read') return { text: `% opencode\n${text}\n` };
      throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
    };
    assert.throws(() => waitForWorkerPane('ws:p2', 'ws', '/work', herdr, () => {}, { launchBlock: { baseline: '' } }), (error) => {
      assert.equal(error.code, 'model_launch_blocked');
      assert.doesNotMatch(error.message, /interactive question/);
      return true;
    });
  }
});

test('waitForWorkerPane without the launchBlock option ignores a launch phrase on the screen', () => {
  const herdr = (args) => {
    if (args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/work' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[1] === 'read') return { text: '% claude\nThis model is not available in your country\n% ' };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.doesNotThrow(() => waitForWorkerPane('ws:p2', 'ws', '/work', herdr, () => {}));
});

test('waitForWorkerPane ignores a launch phrase that is in the baseline', () => {
  const herdr = (args) => {
    if (args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/work' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[1] === 'read') return { text: 'Rate limit exceeded\n% ' };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.doesNotThrow(() => waitForWorkerPane('ws:p2', 'ws', '/work', herdr, () => {}, { launchBlock: { baseline: 'Rate limit exceeded\n% ' } }));
});

test('a claude start with a launch phrase on the pane is not affected', (t) => {
  const f = setupFixture(null);
  f.env.HERDR_BOSS_DIR = path.join(f.root, 'boss-data');
  const name = 'claude-phrase-ignored';
  t.after(() => {
    try { git(f.root, 'worktree', 'remove', '--force', f.config.worktreePath(name)); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'read') return { text: 'This model is not available in your country\nRate limit exceeded\n% ' };
    return f.herdr(args);
  };
  const run = startWorker(name, { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, wait: () => {}, output: () => {},
  });
  assert.equal(run.kind, 'claude');
  const dataDir = f.env.HERDR_BOSS_DIR;
  assert.equal(fs.existsSync(path.join(dataDir, 'unavailable-models.json')), false);
});

test('OpenCode start does not mark a model for a phrase inside the typed brief', (t) => {
  const fixture = openCodeFixture(t, 'opencode-brief-phrase');
  const model = 'opencode/mimo-v2.6-flash-free';
  let typed = false;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') {
      typed = true;
      throw Object.assign(new Error('prompt failed: socket closed'), { code: 'prompt_failed' });
    }
    if (args[0] === 'pane' && args[1] === 'read' && typed) {
      return { text: 'opencode\nRead .worker/brief.md in your working directory and execute it.\nThe brief says: Rate limit exceeded\n' };
    }
    return fixture.herdr(args);
  };
  assert.throws(() => fixture.start(herdr, { model }), /prompt failed/);
  const file = path.join(fixture.f.env.HERDR_BOSS_DIR, 'unavailable-models.json');
  assert.equal(fs.existsSync(file), false, 'no model is marked');
});

test('OpenCode start does not mark a model for a leftover phrase in a reused pane', (t) => {
  const fixture = openCodeFixture(t, 'opencode-leftover-phrase');
  const model = 'opencode/mimo-v2.6-flash-free';
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'read') return { text: 'previous run\nRate limit exceeded\n% ' };
    return fixture.herdr(args);
  };
  const run = fixture.start(herdr, { model });
  assert.equal(run.model, model);
  const file = path.join(fixture.f.env.HERDR_BOSS_DIR, 'unavailable-models.json');
  assert.equal(fs.existsSync(file), false, 'no model is marked');
});

test('startWorker stops once with a clear error when a launch block names no model', (t) => {
  const fixture = openCodeFixture(t, 'opencode-block-no-model');
  let launches = 0;
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'start') {
      launches++;
      throw Object.assign(new Error('blocked'), { code: 'model_launch_blocked', launchBlock: { phrase: 'Rate limit exceeded', untilReenabled: false } });
    }
    return fixture.herdr(args);
  };
  assert.throws(() => fixture.start(herdr), (error) => {
    assert.doesNotMatch(error.message, /undefined/);
    assert.match(error.message, /without a model/);
    return true;
  });
  assert.equal(launches, 1);
});
