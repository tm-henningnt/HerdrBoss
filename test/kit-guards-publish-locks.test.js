import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAgentsExclude, contextTokensFor, globMatches, loadModels, loadProjectConfig, PROJECT_DEFAULTS, workerConfigView } from '../src/kit/config.js';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, readDelegatedRuns, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from '../src/kit/orchestration.js';
import { buildGhArgs } from '../src/kit/gh.js';
import { formatKitDigest, runKitCommand } from '../src/kit/cli.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, filterCollectProcesses, listWorkers, parseWorktreeCwdProcesses, renderBrief, startWorker, waitForAgentReady, waitForWorkerPane } from '../src/kit/workers.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';
import { usageProvider, validateUsage } from '../src/usage.js';
import { validateProject } from '../src/projects.js';
import { Engine } from '../src/engine.js';
import { renderBulletin } from '../src/rules.js';
import { readWorkerFacts, gitIsMerged } from '../src/task-state.js';
import { kitRevision, parseKitImpact, projectKit, readKitChanges, kitChangesSince } from '../src/kit/agents-check.js';
import { ALL_READY_SCREENS, CLAUDE_READY_SCREEN, CODEX_READY_SCREEN, git, setupFixture, temporaryRepo, TEST_HOME, tiers, validReport, validRun } from './helpers/kit-fixture.js';

test('worker start reports off and paused machine guards and ignores their CPU/load limits', () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  for (const [name, guardState, guardEnabled, guardPausedUntil, expected] of [
    ['guard-off', 'off', false, null, /Machine guard off/],
    ['guard-paused', 'paused', true, future, /Machine guard paused until/],
  ]) {
    const f = setupFixture(null);
    fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), machine: {
      owner: 'present', cpuPercent: 99, cpuLimit: 70, fiveMinute: 99, loadLimit: 24,
      guardState, guardEnabled, guardPausedUntil, guardActive: false,
    }, lanes: { codex: { state: 'open' } } }));
    const output = [];
    assert.doesNotThrow(() => startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
    }));
    assert.match(output.join('\n'), expected);
    assert.match(output.join('\n'), /CPU 99\.0% \/ configured limit 70%; 5-minute load 99 \/ configured backstop 24/);
  }
});

test('worker start refuses machine limits before a reached night lane cap even with --force', () => {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    machine: { owner: 'present', cpuPercent: 71, cpuLimit: 70, fiveMinute: 1, loadLimit: null },
    night: { active: true, maxWorkersByLane: { codex: 1 } },
    control: { runningWorkers: 0, maxWorkers: 16, runningByLane: { codex: 1 }, projects: {} },
  }));
  const output = [];
  assert.throws(() => startWorker('machine-refused', { kind: 'codex', task: 'x', allow: ['src/'], force: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  }), /--force cannot bypass this refusal/);
  assert.match(output.join('\n'), /Owner present; CPU 71\.0% \/ limit 70%/);
  assert.ok(!f.calls.includes('agent start'));
});

test('worker start refuses a reached provider lane cap while the watch is active', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    night: { active: true, maxWorkersByLane: { codex: 1 } },
    control: { runningWorkers: 0, maxWorkers: 8, runningByLane: { codex: 1 }, projects: {} },
  }));
  assert.throws(() => startWorker('night-lane-refused', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), /Watch worker lane limit \(1\) for codex is reached/);
  assert.ok(!f.calls.includes('agent start'));
  assert.equal(fs.existsSync(f.config.worktreePath('night-lane-refused')), false);

  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    night: { active: false, maxWorkersByLane: { codex: 1 } },
    control: { runningWorkers: 0, maxWorkers: 8, runningByLane: { codex: 1 }, projects: {} },
  }));
  assert.doesNotThrow(() => startWorker('day-lane-unlimited', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), 'day worker starts do not use night lane caps');
});

test('worker start refuses the enabled load backstop even with --force', () => {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), machine: { owner: 'present', cpuPercent: 20, cpuLimit: 70, fiveMinute: 25, loadLimit: 24 } }));
  assert.throws(() => startWorker('load-refused', { kind: 'codex', task: 'x', allow: ['src/'], force: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), /--force cannot bypass this refusal/);
  assert.ok(!f.calls.includes('agent start'));
});

test('lanes prints active machine thresholds and load when the backstop is disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ machine: { owner: 'away', cpuPercent: 90, cpuLimit: 95, fiveMinute: 80, loadLimit: null }, lanes: { codex: { state: 'open' } } }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.match(output, /Owner away; CPU 90\.0% \/ limit 95%; 5-minute load 80 \/ backstop disabled/);
  assert.match(output, /Machine guard active/);
  assert.match(output, /codex open/);
});

test('lanes reports active, off, and paused machine guard states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-guard-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const rulesFile = path.join(dir, 'rules.json');
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  for (const [guardState, guardEnabled, guardPausedUntil, text] of [
    ['active', true, null, /Machine guard active/],
    ['off', false, null, /Machine guard off/],
    ['paused', true, new Date(Date.now() + 3600000).toISOString(), /Machine guard paused until/],
  ]) {
    fs.writeFileSync(rulesFile, JSON.stringify({ machine: {
      owner: 'present', cpuPercent: 90, cpuLimit: 70, fiveMinute: 30, loadLimit: 24,
      guardState, guardEnabled, guardPausedUntil,
    }, lanes: { codex: { state: 'open' } } }));
    const output = execFileSync(process.execPath, [cli, 'lanes'], { env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
    assert.match(output, text);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});


test('worker start runs the project setup in the new worktree before the agent starts', () => {
  const f = setupFixture('npm ci --prefer-offline');
  const setupCalls = [];
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    runSetup: (command, cwd, timeout) => { setupCalls.push({ command, cwd, timeout, agentStarted: f.calls.includes('agent start') }); return ''; },
  });
  assert.deepEqual(setupCalls, [{ command: 'npm ci --prefer-offline', cwd: result.worktree, timeout: 900000, agentStarted: false }]);
  assert.ok(f.calls.includes('agent start'));
});

test('worker start creates its temporary directory before it starts the agent', () => {
  const f = setupFixture(null);
  const herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'start') {
      assert.ok(fs.statSync(path.join(f.config.worktreePath('demo'), '.worker', 'tmp')).isDirectory());
    }
    return f.herdr(args);
  };
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.ok(fs.statSync(path.join(result.worktree, '.worker', 'tmp')).isDirectory());
});

test('worker start stops before any agent when project setup fails, and removes the worktree', () => {
  const f = setupFixture('npm ci');
  assert.throws(() => startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    runSetup: () => { throw Object.assign(new Error('failed'), { status: 1, stderr: 'npm ERR! missing lockfile' }); },
  }), /Project setup `npm ci` failed with exit code 1\. No agent was started\.\nnpm ERR! missing lockfile/);
  assert.ok(!f.calls.includes('agent start'));
  assert.ok(!fs.existsSync(f.config.worktreePath('demo')));
});

test('project setup must be a non-empty command', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ setup: '  ' }));
  assert.throws(() => loadProjectConfig({ cwd: root }), /setup must be null or a non-empty shell command/);
});

test('an unknown evidence tier names the allowed tiers and the project setting', async () => {
  const { validateWorkerReport } = await import('../src/kit/orchestration.js');
  const errors = validateWorkerReport({ evidenceTier: ['owner-proxy'] }, { evidenceTiers: ['local', 'owner'] });
  assert.ok(errors.some((error) => /evidenceTier\[0\] is unknown: owner-proxy\. Allowed tiers: local, owner\. Set the project's tiers in evidenceTiers in \.herdr-boss\.json/.test(error)));
});

test('worker collect --record names every missing flag at once with a hint from the report', async () => {
  const { recordFlagErrors } = await import('../src/kit/workers.js');
  const missing = recordFlagErrors({ record: true }, { stoppedEarly: true });
  assert.equal(missing.length, 2);
  assert.match(missing[0], /--outcome done\|partial\|failed \(the report says stoppedEarly: true/);
  assert.match(missing[1], /exactly one of --gate-passed or --gate-failed/);
  assert.deepEqual(recordFlagErrors({ record: true, outcome: 'done', gatePassed: true }), []);
});

test('the rendered brief lists the project evidence tiers', () => {
  assert.equal(renderBrief('Tiers: {{evidenceTiers}}', { evidenceTiers: 'local, hosted-ui, owner' }), 'Tiers: local, hosted-ui, owner');
});

test('worker brief shows the effective screenshot budget and project precedence', () => {
  const f = setupFixture(null);
  const template = path.join(f.root, 'brief-template.md');
  fs.writeFileSync(template, 'Budget {{imageBudget}}. The project setting overrides the kit default.');
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ imageBudget: 6, briefTemplate: template }));
  const config = loadProjectConfig({ cwd: f.root });
  const result = startWorker('budget', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8'), 'Budget 6. The project setting overrides the kit default.\n\n## Worker start details\n\nIn a Codex shell, run `setopt NO_BG_NICE` before a background command.\nReport a failing tool, a missing file, or missing evidence explicitly in your report. Never give a best guess in place of a result. The orchestrator verifies each claim at the source.');
});

test('worker brief names the orchestrator by pane and stable agent name', () => {
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  const brief = renderBrief(template, { orchPane: 'w1:p9', orchAgent: 'demo-orch' });
  assert.match(brief, /Your orchestrator is the agent `demo-orch`\. Its current pane is `w1:p9`\./);
  assert.ok(brief.indexOf('agent `demo-orch`') < brief.indexOf('`w1:p9`'), 'the agent name comes first');
  assert.match(brief, /If a command to `demo-orch` fails, send the same message to the pane `w1:p9`\./);
  assert.match(brief, /agent prompt demo-orch "WORKER QUESTION/);
  assert.match(brief, /agent prompt demo-orch "WORKER REPORT/);
  assert.doesNotMatch(brief, /agent prompt w1:p9/);
  assert.match(brief, /new pane ID in a prompt/);
});

test('default worker brief renders the effective screenshot budget', () => {
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  const brief = renderBrief(template, { imageBudget: 3 });
  assert.match(brief, /View at most 3 screenshots during this session\./);
  assert.doesNotMatch(brief, /View at most 10 screenshots during this session\./);
});

test('worker start puts the project thread limit flag in the brief', () => {
  const f = setupFixture(null);
  const cfgFile = path.join(f.root, '.herdr-boss.json');
  const template = path.join(f.root, 'brief-template.md');
  fs.writeFileSync(template, 'Limit: {{threadLimit}}');
  fs.writeFileSync(cfgFile, JSON.stringify({ briefTemplate: template, testThreadsFlag: '--poolOptions.forks.maxForks=2' }));
  const config = loadProjectConfig({ cwd: f.root });
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, { config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Limit: Add `--poolOptions.forks.maxForks=2` to each test runner command.\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.\n\nIn a Codex shell, run `setopt NO_BG_NICE` before a background command.\nReport a failing tool, a missing file, or missing evidence explicitly in your report. Never give a best guess in place of a result. The orchestrator verifies each claim at the source.');
});

test('workers that share a checkout each get their own brief folder', () => {
  const f = setupFixture(null);
  const prompts = [];
  const herdr = (args) => { if (args[0] === 'agent' && args[1] === 'prompt') { prompts.push(args[3]); return {}; } return f.herdr(args); };
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true }, { config: f.config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  assert.equal(result.workerDir, '.worker/demo');
  assert.ok(fs.existsSync(path.join(result.worktree, '.worker', 'demo', 'brief.md')));
  assert.equal(prompts[0], 'Read .worker/demo/brief.md in your working directory and execute it.');
});

test('worker park labels the pane parked and records the reason; unpark clears it', async () => {
  const { parkWorker } = await import('../src/kit/workers.js');
  const f = setupFixture(null);
  startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  const renames = [];
  const herdr = (args) => { renames.push(args.slice(2)); return {}; };
  const parked = parkWorker('demo', { reason: 'Owner review' }, { config: f.config, herdr, output: () => {} });
  assert.equal(parked.parked.reason, 'Owner review');
  parkWorker('demo', { unpark: true }, { config: f.config, herdr, output: () => {} });
  assert.deepEqual(renames, [['ws:p2', 'parked'], ['ws:p2', '--clear']]);
  assert.throws(() => parkWorker('demo', {}, { config: f.config, herdr, output: () => {} }), /needs --reason/);
});

test('scratch creates a durable project folder under the Herdr Boss directory and prints its path', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-scratch-')));
  const env = { ...process.env, HERDR_BOSS_DIR: dir };
  const run = (...args) => execFileSync(process.execPath, [cli, 'scratch', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const expected = path.join(dir, 'scratch', 'herdrboss');
  assert.equal(run('herdrboss'), expected);
  assert.equal(fs.statSync(expected).isDirectory(), true);
  fs.writeFileSync(path.join(expected, 'brief.md'), 'keep\n');
  assert.equal(run('herdrboss'), expected);
  assert.equal(fs.readFileSync(path.join(expected, 'brief.md'), 'utf8'), 'keep\n');
  for (const bad of [['../escape'], ['Upper'], [], ['a', 'b']]) {
    assert.throws(() => run(...bad), (error) => error.status !== 0 && /Usage: scratch <slug>/.test(error.stderr));
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'scratch')), ['herdrboss']);
});

test('worker collect ignores the worker report files in the scope check and the ledger', () => {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ policy: { allowedKinds: ['codex'], excludedModels: [] } }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('own-files', { kind: 'codex', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: ['.orchestration/runs/own-files.json', `${run.workerDir}/report.md`, `${run.workerDir}/report.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  assert.throws(() => collectWorker('own-files', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [{ pid: 99, command: 'node', cwd: f.root }],
  }), /still has processes in its worktree.*pid 99/);
  const summary = collectWorker('own-files', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, recordUsageFn: () => ({ errors: [], duplicate: false }), listWorktreeProcesses: () => [],
  });
  assert.deepEqual(summary.reportedPaths, ['.orchestration/runs/own-files.json']);
  const entry = JSON.parse(fs.readFileSync(f.config.ledgerPath, 'utf8').trim());
  assert.deepEqual(entry.changedPaths, ['.orchestration/runs/own-files.json']);
});

test('worker start gate puts unmetered alternatives before least-over guidance', async () => {
  const { providerGate } = await import('../src/kit/workers.js');
  const now = Date.parse('2026-09-25T10:00:00Z');
  const lanes = {
    codex: { state: 'pace', window: 'Weekly', usedPercent: 60, expectedPercent: 50, overPercent: 10, backOnPaceAt: '2026-09-26T02:48:00Z' },
    opencodego: { state: 'pace', window: 'Weekly', usedPercent: 69, expectedPercent: 63, overPercent: 6, backOnPaceAt: '2026-09-25T20:00:00Z' },
    unmetered: { state: 'open', unmetered: true, byProject: { herdrboss: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] } } },
  };
  const rules = { avoidProviders: ['codex', 'opencodego'], leastOverProvider: 'opencodego', lanes };
  const refused = providerGate('codex', rules, { now, project: 'herdrboss' }).error;
  assert.match(refused, /Unmetered alternatives for herdrboss: opencode \(opencode\/big-pickle, opencode\/space-bunny-free\)\./);
  assert.ok(refused.indexOf('Unmetered alternatives') < refused.indexOf('opencodego is the least over'));
  const filtered = providerGate('codex', rules, { now, project: 'herdrboss', allowedModels: ['opencode/big-pickle'] }).error;
  assert.match(filtered, /Unmetered alternatives for herdrboss: opencode \(opencode\/big-pickle\)\./);
  assert.doesNotMatch(filtered, /space-bunny-free/);
  const least = providerGate('opencodego', rules, { now, project: 'herdrboss' }).warning;
  assert.match(least, /Unmetered alternatives/);
  assert.doesNotMatch(providerGate('codex', rules, { now, project: 'other' }).error, /Unmetered alternatives/);
});

test('lanes prints the unmetered alternatives lane', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-goal-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const checkout = path.join(dir, 'checkout'); fs.mkdirSync(checkout); execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'herdrboss' }));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    lanes: {
      codex: { state: 'pace', window: 'Weekly', usedPercent: 60, expectedPercent: 50, overPercent: 10, backOnPaceAt: new Date(Date.now() + 3600000).toISOString() },
      opencodego: { state: 'exhausted', window: 'Monthly', usedPercent: 100, resetAt: '2026-10-23T09:00:00Z' },
      unmetered: { state: 'open', unmetered: true, byProject: { herdrboss: { opencode: ['opencode/space-bunny-free'] } }, exhausted: [{ model: 'opencode/big-pickle', projects: ['herdrboss'], retryAt: Date.parse('2026-09-26T15:48:00Z') }] },
    },
    leastOverProvider: null,
  }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { cwd: checkout, env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.match(output, /codex ahead of pace/);
  assert.match(output, /opencodego exhausted: 100% used in the Monthly window; exhausted until 2026-10-23T09:00:00Z/);
  assert.ok(output.split('\n').includes('unmetered open: opencode: space-bunny-free'));
  assert.ok(output.split('\n').includes('unmetered exhausted: opencode/big-pickle until 2026-09-26T15:48:00.000Z'));
});

test('lanes prints the shared use-now line before other lane details', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-use-now-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    machine: { owner: 'away', cpuPercent: 5, cpuLimit: 95, fiveMinute: 1, loadLimit: null },
    lanes: {
      codex: { state: 'open', roomPercent: 8 },
      opencodego: { state: 'trickle', allowancePercent: 5, usedTodayPercent: 1.1 },
      unmetered: { state: 'open', unmetered: true, byProject: {} },
    },
  }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], {
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8',
  });

  const lines = output.trim().split('\n');
  assert.match(lines[0], /^Machine guard active/);
  assert.equal(lines[1], 'Use now: unmetered (free models), codex (below pace), opencodego (trickle 3.9%/day left today)');
});

test('the project kit tells orchestrators to use the bulletin Use now line', () => {
  const template = fs.readFileSync(new URL('../kit/templates/project-kit.md', import.meta.url), 'utf8');
  assert.match(template, /When a lane is ahead of pace, start ready work on a lane from the bulletin \*\*Use now\*\* line\. Do not wait for the ahead lane\./);
});

test('lanes filters unmetered output to the configured checkout project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-project-'));
  const home = path.join(dir, 'home');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(checkout, '.herdr-boss.json'), JSON.stringify({ slug: 'beta' }));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ lanes: {
    codex: { state: 'open' },
    unmetered: { state: 'open', unmetered: true, byProject: { alpha: { opencode: [] }, beta: { opencode: ['opencode/c'] } }, exhausted: [{ model: 'opencode/a', projects: ['alpha'], retryAt: Date.parse('2026-09-26T15:48:00Z') }, { model: 'opencode/b', projects: ['beta'], retryAt: Date.parse('2026-09-26T16:48:00Z') }] },
  } }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { cwd: checkout, env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.ok(output.split('\n').includes('unmetered open: opencode: c'));
  assert.doesNotMatch(output, /opencode\/a|alpha/);
  assert.match(output, /unmetered exhausted: opencode\/b until/);
  assert.doesNotMatch(output, /opencode\/a until/);
});

test('lanes keeps global unmetered summary in a Git checkout without project config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-no-config-'));
  const home = path.join(dir, 'home');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ lanes: {
    codex: { state: 'open' },
    unmetered: { state: 'open', unmetered: true, byProject: { alpha: { opencode: ['opencode/a'] }, beta: { opencode: ['opencode/a'] } } },
  } }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { cwd: checkout, env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.ok(output.split('\n').includes('unmetered open: opencode: a'));
});

test('lanes prints compact model deltas in project exceptions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lanes-delta-'));
  const home = path.join(dir, 'home');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', checkout], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ lanes: { unmetered: { state: 'open', unmetered: true, byProject: {
    alpha: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
    beta: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
    gamma: { opencode: ['opencode/big-pickle'] },
    delta: { opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
  } } } }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { cwd: checkout, env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.ok(output.split('\n').includes('unmetered open: opencode: big-pickle, space-bunny-free; exceptions: gamma (opencode: -space-bunny-free)'), output);
});

test('worker allow records verified scope extensions and appends history without duplicates', () => {
  const f = setupFixture(null);
  startWorker('scope-ext', { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const recordFile = path.join(f.config.runsPath, 'scope-ext.json');
  const first = allowWorkerScope('scope-ext', { paths: ['docs/a.md', 'test/'], reason: 'docs needed' }, {
    config: f.config, herdr: f.herdr, env: f.env, now: Date.parse('2026-09-26T10:00:00Z'), output: () => {},
  });
  assert.deepEqual(first.allowedPaths, ['src/', '.worker/scope-ext/**', 'docs/a.md', 'test/']);
  assert.deepEqual(first.scopeExtensions, [{
    paths: ['docs/a.md', 'test/'], reason: 'docs needed', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch',
  }]);
  const second = allowWorkerScope('scope-ext', { paths: ['src/', 'docs/b.md'], reason: 'more docs' }, {
    config: f.config, herdr: f.herdr, env: f.env, now: Date.parse('2026-09-26T10:05:00Z'), output: () => {},
  });
  assert.deepEqual(second.allowedPaths, ['src/', '.worker/scope-ext/**', 'docs/a.md', 'test/', 'docs/b.md']);
  assert.equal(second.scopeExtensions.length, 2);
  assert.deepEqual(second.scopeExtensions[1], {
    paths: ['src/', 'docs/b.md'], reason: 'more docs', at: '2026-09-26T10:05:00.000Z', by: 'ws:orch',
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')).scopeExtensions, second.scopeExtensions);

  const bossHerdr = (args) => (args[0] === 'pane' && args[1] === 'get'
    ? { pane: { pane_id: 'ws:boss', workspace_id: 'ws', label: 'boss' } }
    : f.herdr(args));
  const boss = allowWorkerScope('scope-ext', { paths: ['docs/c.md'], reason: 'boss approval' }, {
    config: f.config, herdr: bossHerdr, env: { ...f.env, HERDR_PANE_ID: 'ws:boss' }, output: () => {},
  });
  assert.equal(boss.scopeExtensions.at(-1).by, 'ws:boss');

  // An in-repository symlink to a normal directory keeps its allowed behavior.
  fs.mkdirSync(path.join(f.root, 'real-docs'));
  fs.symlinkSync('real-docs', path.join(f.root, 'docs-link'));
  const linked = allowWorkerScope('scope-ext', { paths: ['docs-link/a.md'], reason: 'in-repo link' }, {
    config: f.config, herdr: f.herdr, env: f.env, output: () => {},
  });
  assert.ok(linked.allowedPaths.includes('docs-link/a.md'));
});

test('worker allow refuses invalid requests without changing the run record', () => {
  const f = setupFixture(null);
  startWorker('scope-refuse', { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const recordFile = path.join(f.config.runsPath, 'scope-refuse.json');
  const before = fs.readFileSync(recordFile, 'utf8');
  const base = { config: f.config, herdr: f.herdr, env: f.env, output: () => {} };
  const wrongPane = (args) => (args[0] === 'pane' && args[1] === 'get'
    ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'worker' } }
    : f.herdr(args));
  const cases = [
    [{ ...base, env: { ...f.env, HERDR_ENV: undefined } }, ['docs/a.md'], 'reason', /HERDR_ENV=1/],
    [{ ...base, env: { ...f.env, HERDR_PANE_ID: undefined } }, ['docs/a.md'], 'reason', /HERDR_PANE_ID is required/],
    [{ ...base, herdr: wrongPane }, ['docs/a.md'], 'reason', /label must be exactly orch or boss/],
    [base, ['docs/a.md'], '', /needs --reason/],
    [base, [], 'reason', /at least one path/],
    [base, ['/etc/passwd'], 'reason', /stay inside the repository/],
    [base, ['../outside'], 'reason', /stay inside the repository/],
    [base, ['.worker'], 'reason', /must not be inside \.worker/],
    [base, ['.worker/notes.md'], 'reason', /must not be inside \.worker/],
    [base, ['.WORKER/report.md'], 'reason', /must not be inside \.worker/],
    [base, ['.Worker/report.md'], 'reason', /must not be inside \.worker/],
    [base, ['.WORKER'], 'reason', /must not be inside \.worker/],
  ];
  for (const [options, paths, reason, message] of cases) {
    assert.throws(() => allowWorkerScope('scope-refuse', { paths, reason }, options), message);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  }
  fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'));
  assert.throws(() => allowWorkerScope('scope-refuse', { paths: ['escape/file.md'], reason: 'reason' }, base), /resolves outside the repository/);
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before);

  // A repository symlink alias into .worker is refused, including a missing descendant below the link.
  fs.symlinkSync('.worker', path.join(f.root, 'worker-alias'));
  for (const pathItem of ['worker-alias', 'worker-alias/notes.md', 'worker-alias/deep/missing/notes.md']) {
    assert.throws(() => allowWorkerScope('scope-refuse', { paths: [pathItem], reason: 'reason' }, base), /resolves into \.worker/);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  }

  // A case-insensitive volume makes a .WORKER alias address the protected directory too.
  fs.symlinkSync('.WORKER', path.join(f.root, 'worker-upper'));
  for (const pathItem of ['worker-upper', 'worker-upper/report.md', 'worker-upper/deep/missing/report.md']) {
    assert.throws(() => allowWorkerScope('scope-refuse', { paths: [pathItem], reason: 'reason' }, base), /resolves into \.worker/);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  }

  // A symlink to an outside path that does not exist yet is still refused.
  fs.symlinkSync(path.join(os.tmpdir(), 'herdr-missing-outside-target'), path.join(f.root, 'broken-outside'));
  assert.throws(() => allowWorkerScope('scope-refuse', { paths: ['broken-outside/file.md'], reason: 'reason' }, base), /resolves outside the repository/);
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before);

  const record = JSON.parse(before);
  record.finishedAt = '2026-09-26T11:00:00.000Z';
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.throws(() => allowWorkerScope('scope-refuse', { paths: ['docs/a.md'], reason: 'reason' }, base), /already finished/);
});

test('worker collect uses approved scope extensions and copies them to the ledger', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('scope-collect', { kind: 'codex', task: 'x', allow: ['src/', '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  fs.writeFileSync(path.join(f.root, 'docs-approved.md'), 'approved\n');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: ['.orchestration/runs/scope-collect.json', 'docs-approved.md'],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  assert.throws(() => collectWorker('scope-collect', { noRecord: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  }), /outside its allowed scope.*docs-approved\.md/);
  allowWorkerScope('scope-collect', { paths: ['docs-approved.md'], reason: 'small docs fix' }, {
    config: f.config, herdr: f.herdr, env: f.env, now: Date.parse('2026-09-26T12:00:00Z'), output: () => {},
  });
  const lines = [];
  const summary = collectWorker('scope-collect', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, now: Date.parse('2026-09-26T12:30:00Z'), output: (text) => lines.push(text),
    recordUsageFn: () => ({ errors: [], duplicate: false }), listWorktreeProcesses: () => [],
  });
  assert.deepEqual(summary.scopeExtensions, [{
    paths: ['docs-approved.md'], reason: 'small docs fix', at: '2026-09-26T12:00:00.000Z', by: 'ws:orch',
  }]);
  assert.match(lines.join('\n'), /"scopeExtensions"/);
  const entry = JSON.parse(fs.readFileSync(f.config.ledgerPath, 'utf8').trim());
  assert.deepEqual(entry.scopeExtensions, summary.scopeExtensions);
});

test('ledger validation keeps old entries valid and rejects malformed scope extensions', () => {
  assert.deepEqual(validateDelegatedRun(validRun, { evidenceTiers: tiers }), []);
  const good = { ...validRun, scopeExtensions: [{ paths: ['docs/a.md'], reason: 'needed', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }] };
  assert.deepEqual(validateDelegatedRun(good, { evidenceTiers: tiers }), []);
  const bad = (patch) => validateDelegatedRun({ ...validRun, scopeExtensions: patch }, { evidenceTiers: tiers });
  assert.ok(bad('nope').some((error) => error.includes('scopeExtensions must be an array')));
  assert.ok(bad([{ reason: 'r', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('.paths must be a non-empty array')));
  assert.ok(bad([{ paths: [], reason: 'r', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('.paths must be a non-empty array')));
  assert.ok(bad([{ paths: ['/etc/passwd'], reason: 'r', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('stay inside')));
  assert.ok(bad([{ paths: ['.worker/x'], reason: 'r', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('inside .worker')));
  assert.ok(bad([{ paths: ['.WORKER/report.md'], reason: 'r', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('inside .worker')));
  assert.ok(bad([{ paths: ['a.md'], reason: '', at: '2026-09-26T10:00:00.000Z', by: 'ws:orch' }]).some((error) => error.includes('.reason must be a non-empty')));
  assert.ok(bad([{ paths: ['a.md'], reason: 'r', at: 'nope', by: 'ws:orch' }]).some((error) => error.includes('.at must be a timestamp')));
  assert.ok(bad([{ paths: ['a.md'], reason: 'r', at: '2026-09-26T10:00:00.000Z', by: '' }]).some((error) => error.includes('.by must be a non-empty')));
});

test('worker allow CLI parses paths and reason and rejects missing or unknown options', async () => {
  const { runKitCommand } = await import('../src/kit/cli.js');
  const f = setupFixture(null);
  startWorker('scope-cli', { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const options = { config: f.config, herdr: f.herdr, env: f.env, output: () => {} };
  runKitCommand('worker', ['allow', 'scope-cli', 'docs/a.md', 'docs/b.md', '--reason', 'docs approval'], options);
  const record = JSON.parse(fs.readFileSync(path.join(f.config.runsPath, 'scope-cli.json'), 'utf8'));
  assert.deepEqual(record.allowedPaths, ['src/', '.worker/scope-cli/**', 'docs/a.md', 'docs/b.md']);
  assert.equal(record.scopeExtensions[0].reason, 'docs approval');
  assert.throws(() => runKitCommand('worker', ['allow', 'scope-cli', '--reason', 'r'], options), /Usage: worker allow/);
  assert.throws(() => runKitCommand('worker', ['allow', 'scope-cli', 'docs/a.md'], options), /needs --reason/);
  assert.throws(() => runKitCommand('worker', ['allow', 'scope-cli', 'docs/a.md', '--reason', 'r', '--bogus', 'x'], options), /Unknown option/);
});

test('worker start merges extra models into the harness allow-list and applies per-harness state', () => {
  const f = setupFixture(null);
  const extra = 'opencode-go/glm-5.2';
  const write = (policy) => fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), policy: { allowedKinds: ['codex', 'pi', 'opencode'], excludedModels: [], ...policy } }));
  const start = (name, options) => {
    const output = [];
    const result = startWorker(name, { task: 'x', allow: ['src/'], dryRun: true, ...options }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
    });
    return { result, output: output.join('\n') };
  };
  write({ extraModels: { pi: [extra] }, harnessRoutes: { pi: { [extra]: null } } });
  const { result, output } = start('extra-pi', { kind: 'pi', model: extra });
  assert.equal(result.model, extra);
  assert.deepEqual(result.launchArgs.slice(0, 4), ['--model', extra, '--models', extra]);
  assert.match(output, new RegExp(`Validate kind/model/effort: pi / ${extra.replace('.', '\\.')}`));
  assert.throws(() => start('extra-opencode', { kind: 'opencode', model: extra }), /not allowed for opencode/);
  assert.throws(() => start('extra-effort', { kind: 'pi', model: extra, effort: 'high' }), /Effort high is not allowed for pi/);

  write({ extraModels: { pi: [extra] }, preferredModels: { pi: extra } });
  assert.equal(start('extra-preferred', { kind: 'pi' }).result.model, loadModels().kinds.pi.defaultModel, 'the kit default wins over the preferred model');
  write({ extraModels: { pi: [extra] }, preferredModels: { pi: extra }, disabledModels: { pi: [loadModels().kinds.pi.defaultModel] } });
  assert.equal(start('extra-fallback', { kind: 'pi' }).result.model, extra, 'the preferred model is the fallback for a disabled default');

  const shared = 'opencode-go/deepseek-v4.1-flash';
  write({ disabledModels: { opencode: [shared] } });
  assert.throws(() => start('shared-off', { kind: 'opencode', model: shared }), /disabled for opencode/);
  assert.equal(start('shared-on', { kind: 'pi', model: shared }).result.model, shared);

  write({ extraModels: { pi: ['bad;model'] } });
  assert.throws(() => start('bad-extra', { kind: 'pi', model: 'bad;model' }), /not allowed for pi/);

  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidProviders: ['opencodego'], policy: { allowedKinds: ['pi'], excludedModels: [], extraModels: { pi: [extra] }, harnessRoutes: { pi: { [extra]: 'opencodego' } } } }));
  assert.throws(() => start('extra-routed', { kind: 'pi', model: extra }), /opencodego is ahead of quota pace/);
});

test('worker start refuses free opencode/ models in the Pi harness', () => {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), policy: { allowedKinds: ['codex', 'pi', 'opencode'], excludedModels: [] } }));
  const start = (name, options) => {
    const lines = [];
    const result = startWorker(name, { task: 'x', allow: ['src/'], dryRun: true, ...options }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => lines.push(line),
    });
    return { result, output: lines.join('\n') };
  };
  for (const model of ['opencode/big-pickle', 'opencode/mimo-v2.6-flash-free', 'opencode/nemotron-3.5-lightning-free', 'opencode/space-bunny-free']) {
    assert.throws(() => start('zen-pi', { kind: 'pi', model }), /not allowed for pi/, `${model} runs only in the opencode harness`);
  }
  const model = 'opencode-go/deepseek-v4.1-flash';
  const { result, output } = start('go-pi', { kind: 'pi', model });
  assert.equal(result.model, model);
  assert.deepEqual(result.launchArgs.slice(0, 4), ['--model', model, '--models', model]);
  assert.match(output, new RegExp(`Validate kind/model/effort: pi / ${model.replace(/[.]/g, '\\$&')}`));
  assert.equal(start('go-pi-default', { kind: 'pi' }).result.model, 'opencode-go/muse-spark-1.3-contributor', 'the Pi default is unchanged');
});

test('the models command lists extra models from the local policy', async () => {
  const { runKitCommand } = await import('../src/kit/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-models-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ policy: { extraModels: { pi: ['opencode-go/glm-5.2'] } } }));
  const result = runKitCommand('models', ['--kind', 'pi'], { output: () => {}, rulesFile });
  assert.ok(result.pi.allowedModels.includes('opencode-go/glm-5.2'));
  const missing = runKitCommand('models', [], { output: () => {}, rulesFile: path.join(dir, 'absent.json') });
  assert.deepEqual(missing.pi.allowedModels, loadModels().kinds.pi.allowedModels);
});

test('worker list reports the failed status from the Boss snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-list-'));
  const runsPath = path.join(dir, 'runs');
  fs.mkdirSync(runsPath);
  fs.writeFileSync(path.join(runsPath, 'worker-a.json'), JSON.stringify({ name: 'worker-a', pane: 'w1:p2' }));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ herdr: { panes: [{ id: 'w1:p2', status: 'failed', agent: 'codex' }] } }));
  const rows = listWorkers({ runsPath }, {
    herdr: (args) => args[0] === 'agent' && args[1] === 'list' ? { agents: [{ name: 'worker-a', agent_status: 'idle' }] } : {},
    output: () => {}, stateFile,
  });
  assert.equal(rows[0].agentStatus, 'failed');
});

test('publish stores the AGENTS.md drift counts and still publishes', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-agents-')));
  const repo = temporaryRepo('herdr-publish-repo-');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Project\nThe Boss is in pane w1:p2.\n');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo' }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home };
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^warning: AGENTS\.md error line 1: no Herdr Boss stub; run herdr-boss kit install/m);
  assert.match(result.stderr, /^warning: AGENTS\.md error line 1: docs\/orchestration\/herdr-boss\.md is missing/m);
  assert.match(result.stderr, /^warning: AGENTS\.md warn line 2: .*pane ID/m);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8'));
  assert.deepEqual({ ...stored.agentsCheck, checkedAt: undefined }, { checkedAt: undefined, errors: 2, warnings: 1, file: 'AGENTS.md' });
  assert.ok(!Number.isNaN(Date.parse(stored.agentsCheck.checkedAt)));
  assert.ok(!JSON.stringify(stored).includes('w1:p2'), 'the record holds counts only, no file text');
  assert.ok(validateProject({ project: 'x', agentsCheck: { errors: -1, warnings: 0 } }).some((error) => error.includes('agentsCheck')));
});

test('the project status accepts an optional 12-hex kitRevision', () => {
  assert.deepEqual(validateProject({ project: 'x', kitRevision: 'abcdef012345' }), []);
  assert.deepEqual(validateProject({ project: 'x' }), []);
  for (const bad of ['', 'ABCDEF012345', 'abc', 12, 'abcdef0123456', { v: 1 }]) {
    assert.ok(validateProject({ project: 'x', kitRevision: bad }).some((error) => error.includes('kitRevision')), JSON.stringify(bad));
  }
});

test('the listed projects carry the current kit revision for the project page', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-list-kit-')));
  const dataDir = path.join(home, 'boss');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'projects', 'demo.json'), JSON.stringify({ project: 'Demo', kitRevision: 'abcdef012345' }));
  const { projectKit } = await import('../src/kit/agents-check.js');
  const script = "import('./src/projects.js').then((m) => process.stdout.write(JSON.stringify(m.listProjects())))";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [row] = JSON.parse(result.stdout);
  assert.equal(row.kitRevision, 'abcdef012345');
  assert.equal(row.currentKitRevision, projectKit().revision);
});

test('check kit lists each published project with its kit revision and check counts', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-kit-')));
  const dataDir = path.join(home, 'boss');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
const result = args[0] === 'agent' ? JSON.parse(process.env.TEST_AGENT_RESULT) : JSON.parse(process.env.TEST_PANE_RESULT);
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  const { projectKit } = await import('../src/kit/agents-check.js');
  const current = projectKit().revision;
  const write = (slug, data) => fs.writeFileSync(path.join(dataDir, 'projects', `${slug}.json`), JSON.stringify({ project: slug, ...data }));
  write('alpha', { kitRevision: current, agentsCheck: { errors: 0, warnings: 2, file: 'AGENTS.md' } });
  write('beta', { kitRevision: 'abcdef012345', agentsCheck: { errors: 1, warnings: 0, file: 'AGENTS.md' } });
  write('gamma', {});
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = {
    ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    TEST_AGENT_RESULT: JSON.stringify({ agents: [] }), TEST_PANE_RESULT: JSON.stringify({ panes: [] }),
  };
  const result = spawnSync(process.execPath, [cli, 'check', 'kit'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    `alpha: kit revision ${current} (current); agents check 0 errors, 2 warnings`,
    'beta: kit revision abcdef012345 (behind (required)); agents check 1 errors, 0 warnings',
    'gamma: kit revision none (not published); agents check not published',
    `check kit: FAIL (current revision ${current}; 3 projects, 1 behind (required), 1 not published)`,
  ]);

  write('beta', { kitRevision: current });
  fs.rmSync(path.join(dataDir, 'projects', 'gamma.json'));
  const pass = spawnSync(process.execPath, [cli, 'check', 'kit'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /check kit: PASS \(current revision [0-9a-f]{12}; 2 projects\)/);
});

test('check kit flags project and Boss agents with unstable names', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-kit-names-')));
  const dataDir = path.join(home, 'boss');
  const projects = path.join(dataDir, 'projects');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const { projectKit } = await import('../src/kit/agents-check.js');
  fs.writeFileSync(path.join(projects, 'alpha.json'), JSON.stringify({ project: 'Alpha', workspace: 'wa', kitRevision: projectKit().revision }));
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
const result = args[0] === 'agent' ? JSON.parse(process.env.TEST_AGENT_RESULT) : JSON.parse(process.env.TEST_PANE_RESULT);
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = {
    ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    TEST_AGENT_RESULT: JSON.stringify({ agents: [
      { pane_id: 'wa:p1', name: 'alpha-old' }, { pane_id: 'boss:p1', name: 'boss-old' },
    ] }),
    TEST_PANE_RESULT: JSON.stringify({ panes: [
      { pane_id: 'wa:p1', workspace_id: 'wa', label: 'orch' },
      { pane_id: 'boss:p1', workspace_id: 'boss-workspace', label: 'boss' },
    ] }),
  };
  const result = spawnSync(process.execPath, [cli, 'check', 'kit'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /alpha: orchestrator agent is named alpha-old; rename it with herdr agent rename wa:p1 alpha-orch/);
  assert.match(result.stdout, /boss: Boss agent is named boss-old; rename it with herdr agent rename boss:p1 boss/);
});

test('check kit warns rather than failing when the agent list is unavailable', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-check-kit-no-agents-')));
  const dataDir = path.join(home, 'boss');
  const projects = path.join(dataDir, 'projects');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const { projectKit } = await import('../src/kit/agents-check.js');
  fs.writeFileSync(path.join(projects, 'alpha.json'), JSON.stringify({ project: 'Alpha', workspace: 'wa', kitRevision: projectKit().revision }));
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'agent' && args[1] === 'list') process.exit(1);
console.log(JSON.stringify({ result: { panes: [{ pane_id: 'wa:p1', workspace_id: 'wa', label: 'orch' }] } }));
`);
  fs.chmodSync(herdr, 0o755);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
  const result = spawnSync(process.execPath, [cli, 'check', 'kit'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: Herdr agent list is unavailable; orchestrator agent names were not checked\./);
  assert.match(result.stdout, /check kit: PASS/);
});

test('publish keeps the kitRevision of the status file', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-kit-')));
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', kitRevision: 'abcdef012345' }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home };
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status], { cwd: home, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8')).kitRevision, 'abcdef012345');
});

test('publish warns about a blocked task with no blocker and an Owner wait with no Mailbox item', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-publish-wait-')));
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({
    project: 'Demo',
    tasks: [
      { id: '12', title: 'Ship', status: 'blocked' },
      { id: 'V12', title: 'Choose the paint', status: 'blocked', waitingOn: 'owner', ask: 'Which paint?' },
    ],
  }));
  const dataDir = path.join(home, 'boss');
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: dataDir, TMPDIR: home };
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'publish', 'demo', status], { cwd: home, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^Warning: task 12 is blocked but names no blocker\. Set blockedBy or waitingOn\.$/m);
  assert.match(result.stderr, /^Warning: task V12 waits on the Owner but has no Mailbox item\. Post one with herdr-boss mail post and set mailboxId\.$/m);
  assert.match(result.stdout, /^published .*\/projects\/demo$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'demo.json'), 'utf8')).tasks.length, 2);
});

test('worker start warns about AGENTS.md drift and still starts', () => {
  const f = setupFixture(null);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), '# Project\nNo block.\n');
  const lines = [];
  const result = startWorker('drift', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => lines.push(line),
  });
  assert.equal(result.dryRun, true);
  assert.ok(lines.includes('Warning: AGENTS.md drift: 2 errors, 0 warnings. Run herdr-boss check agents.'), lines.join('\n'));
});

test('the project page shows the AGENTS.md drift line and its help', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /AGENTS\.md drift: \$\{errors\} errors, \$\{warnings\} warnings\. Run <span class="mono">herdr-boss check agents<\/span>\./);
  assert.match(app, /agentsDriftLine\(p\.agentsCheck\)/);
  assert.match(app, /<h3>AGENTS\.md drift<\/h3>/);
  assert.match(app, /Kit revision \$\{esc\(loaded\)\}, current \$\{esc\(current\)\}/);
  assert.match(app, /kitRevisionLine\(p, kit\)/);
  assert.match(app, /<h3>Kit revision<\/h3>/);
});

test('lanes describes unavailable Pi models and an exhausted free lane for the project', async () => {
  const { describeUnmetered } = await import('../src/kit/workers.js');
  const retryAt = Date.parse('2026-09-27T17:45:00Z');
  const lane = {
    state: 'open', unmetered: true, byProject: { herdrboss: { pi: ['opencode-go/space-bunny-free'] }, other: {} }, exhausted: [],
    unavailable: [{ kind: 'pi', model: 'fixturezen/free-a', provider: 'fixturezen', reason: 'no-credential', projects: ['herdrboss'] }],
    exhaustedLanes: [{ kind: 'opencode', retryAt, retryKnown: false, reason: 'free usage exceeded', projects: ['herdrboss'] }],
  };
  assert.deepEqual(describeUnmetered(lane, 'herdrboss').split('\n'), [
    'unmetered open: pi: opencode-go/space-bunny-free',
    'Unmetered pi fixturezen/ models: unavailable. Pi has no credential for the fixturezen provider.',
    'Unmetered opencode: exhausted (free usage exceeded); retry after 2026-09-27T17:45:00.000Z (reset time unknown).',
  ]);
  assert.equal(describeUnmetered(lane, 'other').split('\n').length, 1, 'closed parts of another project are not shown');
  assert.match(describeUnmetered({ ...lane, state: 'closed', byProject: { herdrboss: {} } }, 'herdrboss'), /^unmetered closed: no unmetered model can start/);
});

test('the full-suite lock is machine-wide and other lock names stay per repository', (t) => {
  const first = temporaryRepo('herdr-machine-lock-a-');
  const second = temporaryRepo('herdr-machine-lock-b-');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-machine-lock-data-'));
  t.after(() => [first, second, dataDir].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const firstConfig = loadProjectConfig({ cwd: first });
  const secondConfig = loadProjectConfig({ cwd: second });
  const pids = { 'ws:orch-a': 801, 'ws:orch-b': 802 };
  let caller = 'ws:orch-a';
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: pids[args.at(-1)] } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: Object.keys(pids).map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const lines = [];
  const options = (config) => ({
    config,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr,
    pidAlive: () => true,
    output: (line) => lines.push(line),
  });

  const machine = runKitCommand('lock', ['acquire', 'full-suite'], options(firstConfig));
  assert.equal(machine.scope, 'machine');
  assert.ok(fs.existsSync(path.join(dataDir, 'locks', 'machine', 'full-suite.json')));
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['acquire', 'full-suite'], options(secondConfig)), /held by active pane ws:orch-a/);
  assert.throws(() => runKitCommand('lock', ['release', 'full-suite'], options(secondConfig)), /active lock.*another pane/i);

  caller = 'ws:orch-a';
  const deployA = runKitCommand('lock', ['acquire', 'deploy'], options(firstConfig));
  assert.equal(deployA.scope, 'repository');
  caller = 'ws:orch-b';
  const deployB = runKitCommand('lock', ['acquire', 'deploy'], options(secondConfig));
  assert.equal(deployB.ownerPane, 'ws:orch-b', 'a deploy lock in another repository is separate');

  const queueDir = path.join(dataDir, 'locks', 'machine', 'queue', 'full-suite');
  fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  const ticketId = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(queueDir, `${ticketId}.json`), JSON.stringify({
    id: ticketId, seq: 1, pane: 'ws:orch-b', project: 'alpha', pid: 802, kind: 'suite',
    command: 'herdr-boss lock acquire full-suite', createdAt: new Date().toISOString(),
  }));

  lines.length = 0;
  const listed = runKitCommand('lock', ['list'], options(secondConfig));
  assert.deepEqual(listed.map((lock) => [lock.name, lock.scope, lock.ownerPane]), [
    ['deploy', 'repository', 'ws:orch-b'],
    ['full-suite', 'machine', 'ws:orch-a'],
  ]);
  assert.ok(lines.some((line) => /^full-suite .*machine/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^full-suite .*manual.*expires in (?:\d+h )?\d+m; PID \d+, live; lane long/.test(line)), lines.join('\n'));
  assert.equal(Number.isFinite(listed[1].expiresInMs), true);
  assert.ok(listed[1].expiresInMs > 0);
  assert.deepEqual(listed[1].queue.map((ticket) => [ticket.position, ticket.project, ticket.pane, ticket.kind]), [
    [1, 'alpha', 'ws:orch-b', 'suite'],
  ]);
  assert.ok(lines.some((line) => /^  Queue: 1\. alpha ws:orch-b \(suite\) long lane, predicted unknown, 1 of 1 slots in use, waiting \d+m$/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^deploy .*repository/.test(line)), lines.join('\n'));
  fs.unlinkSync(path.join(queueDir, `${ticketId}.json`));

  caller = 'ws:orch-a';
  runKitCommand('lock', ['release', 'full-suite'], options(secondConfig));
  assert.equal(fs.existsSync(path.join(dataDir, 'locks', 'machine', 'full-suite.json')), false);
  caller = 'ws:orch-b';
  assert.equal(runKitCommand('lock', ['acquire', 'full-suite'], options(secondConfig)).ownerPane, 'ws:orch-b');
});

test('a dead suite PID makes a full-suite lock stale while its pane remains live', (t) => {
  const root = temporaryRepo('herdr-suite-pid-stale-');
  const config = loadProjectConfig({ cwd: root });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-suite-pid-stale-data-'));
  t.after(() => [root, dataDir].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const livePanes = new Set(['ws:orch-a', 'ws:orch-b']);
  let caller = 'ws:orch-a';
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: args.at(-1) === 'ws:orch-a' ? 501 : 502 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...livePanes].map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = () => ({
    config, lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr, pidAlive: (pid) => pid === 501 || pid === 502,
    now: () => Date.parse('2026-09-28T10:00:00.000Z'), output: () => {},
  });
  runKitCommand('lock', ['acquire', 'full-suite'], options());
  const file = path.join(dataDir, 'locks', 'machine', 'full-suite.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.kind = 'suite';
  record.pid = 903;
  delete record.expiresAt;
  fs.writeFileSync(file, JSON.stringify(record));

  caller = 'ws:orch-b';
  assert.equal(livePanes.has('ws:orch-a'), true, 'the former holder pane is still live');
  assert.equal(runKitCommand('lock', ['list'], options())[0].state, 'stale');
  const takeover = runKitCommand('lock', ['acquire', 'full-suite'], options());
  assert.equal(takeover.ownerPane, 'ws:orch-b');
  assert.equal(takeover.kind, 'manual');
});
