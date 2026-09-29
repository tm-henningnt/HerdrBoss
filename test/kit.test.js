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
import { runKitCommand } from '../src/kit/cli.js';
import { allowWorkerScope, collectWorker, createHerdrRunner, filterCollectProcesses, listWorkers, parseWorktreeCwdProcesses, renderBrief, startWorker, waitForAgentReady, waitForWorkerPane } from '../src/kit/workers.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';
import { usageProvider, validateUsage } from '../src/usage.js';
import { validateProject } from '../src/projects.js';
import { Engine } from '../src/engine.js';
import { renderBulletin } from '../src/rules.js';

const CLAUDE_READY_SCREEN = '────\n❯\n────\nauto mode';
const CODEX_READY_SCREEN = '› Ask Codex to do anything\n? for shortcuts';
const ALL_READY_SCREENS = `${CLAUDE_READY_SCREEN}\n${CODEX_READY_SCREEN}`;

// Worker worktrees default to ~/Projects/.herdr-wt. Keep them out of the real home folder.
const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-home-')));
process.env.HOME = TEST_HOME;
process.on('exit', () => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function temporaryRepo(prefix = 'herdr-kit-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'seed');
  return root;
}

test('project status accepts a durable goal and rejects invalid goal values', () => {
  const valid = { project: 'Example', goal: 'Preserve the Owner direction.' };
  assert.deepEqual(validateProject(valid), []);
  assert.deepEqual(validateProject({ project: 'Example' }), []);
  for (const goal of [null, 42, {}, [], '', '   ', '\n\t']) {
    assert.ok(validateProject({ project: 'Example', goal }).some((error) => error.includes('goal')),
      `expected ${JSON.stringify(goal)} to be rejected`);
  }
  assert.ok(validateProject({ project: 'Example', goal: 'x'.repeat(1001) }).some((error) => error.includes('goal')));
  assert.deepEqual(validateProject({ project: 'Example', goal: 'x'.repeat(1000) }), []);
});

const tiers = ['unit', 'integration', 'local-browser', 'hosted', 'owner'];
const validReport = {
  issue: 7,
  branch: 'kit-worker',
  worktree: '/tmp/kit-worker',
  changedPaths: ['src/a.js'],
  commands: [{ command: 'node --test test/', result: 'PASS' }],
  evidenceTier: ['unit'],
  unverified: [],
  stoppedEarly: false,
};
const validRun = {
  issue: 7,
  model: 'gpt-6-luna',
  surface: 'herdr',
  worktree: '/tmp/kit-worker',
  startedAt: '2026-09-24T10:00:00.000Z',
  endedAt: '2026-09-24T10:10:00.000Z',
  outcome: 'done',
  timedOut: false,
  toolCalls: 0,
  changedPaths: ['src/a.js'],
  independentGate: { passed: true, command: 'node --test test/' },
  defectsFound: [],
  rework: [],
  evidenceTier: ['unit'],
};

test('worker process check finds only cwd paths inside the exact worktree', () => {
  const worktree = path.resolve('/tmp/worker-tree');
  const output = [
    'p101', 'R10', 'cnode', `n${worktree}/test/server.test.js`,
    'p102', 'R1', 'cnpm', `n${worktree}-other`,
    'p103', 'R1', 'czsh', `n${worktree}`,
  ].join('\n');
  assert.deepEqual(parseWorktreeCwdProcesses(output, worktree), [
    { pid: 101, ppid: 10, command: 'node', cwd: `${worktree}/test/server.test.js` },
    { pid: 103, ppid: 1, command: 'zsh', cwd: worktree },
  ]);
});

test('worker process collection excludes worker runtime and shared daemon but flags workloads and unknown ancestry', () => {
  const cwd = path.resolve('/tmp/worker-tree');
  const processes = [
    { pid: 10, ppid: 1, command: 'zsh', cwd },
    { pid: 11, ppid: 10, command: 'node', args: 'codex worker runtime', cwd },
    { pid: 12, ppid: 9, command: 'app-server-daemon', executable: 'n/Applications/Codex.app/Contents/Resources/app-server-daemon', cwd },
    { pid: 13, ppid: 12, command: 'node', args: 'shared tool runtime', cwd },
    { pid: 20, ppid: 11, command: 'node', args: 'node --test test/a.test.js', cwd },
    { pid: 21, ppid: 11, command: 'node', args: 'node server.js', cwd },
    { pid: 22, ppid: 11, command: 'node', args: 'watcher --watch src', cwd },
    { pid: 23, ppid: 1, command: 'node', args: 'unknown process', cwd },
  ];
  assert.deepEqual(filterCollectProcesses(processes, { worktree: cwd, shellPid: 10 }).map(({ pid }) => pid), [10, 20, 21, 22, 23]);
  assert.deepEqual(filterCollectProcesses(processes, { worktree: cwd }).map(({ pid }) => pid), [10, 11, 20, 21, 22, 23]);
});

function writeModelsFile(t, kinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, kinds }));
  return file;
}

const MODEL_KIND = { defaultModel: 'm1', allowedModels: ['m1', 'm2'], allowedEfforts: [], defaultEffort: null, launchArgs: ['--model', '{{model}}'] };

test('the kit catalog sets a 200000-token window for claude and codex only', () => {
  const models = loadModels();
  assert.equal(models.kinds.claude.contextTokens, 200000);
  assert.equal(models.kinds.codex.contextTokens, 200000);
  for (const kind of ['pi', 'opencode']) assert.equal(Object.hasOwn(models.kinds[kind], 'contextTokens'), false);
  assert.equal(contextTokensFor(models, 'codex', models.kinds.codex.defaultModel), 200000);
  assert.equal(contextTokensFor(models, 'pi', models.kinds.pi.defaultModel), null);
});

test('contextTokensByModel overrides the kind window for one model', (t) => {
  const file = writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokens: 200000, contextTokensByModel: { m2: 1000000 } } });
  const models = loadModels(file);
  assert.equal(contextTokensFor(models, 'claude', 'm2'), 1000000);
  assert.equal(contextTokensFor(models, 'claude', 'm1'), 200000);
  assert.equal(contextTokensFor(models, 'missing', 'm1'), null);
});

test('a models file without contextTokens stays valid', (t) => {
  const models = loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND } }));
  assert.equal(contextTokensFor(models, 'claude', 'm1'), null);
});

test('loadModels refuses an invalid contextTokens or contextTokensByModel', (t) => {
  for (const value of [0, -1, 1.5, '200000', null, true]) {
    assert.throws(() => loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokens: value } })), /claude\.contextTokens must be a positive integer/);
  }
  for (const value of [[], 'x', null, { m1: 0 }, { m1: '5' }]) {
    assert.throws(() => loadModels(writeModelsFile(t, { claude: { ...MODEL_KIND, contextTokensByModel: value } })), /claude\.contextTokensByModel/);
  }
});

test('project config finds the git root and applies contract defaults', () => {
  const root = temporaryRepo();
  fs.mkdirSync(path.join(root, 'nested'));
  const config = loadProjectConfig({ cwd: path.join(root, 'nested') });
  assert.equal(config.root, root);
  assert.equal(config.slug, path.basename(root).toLowerCase());
  assert.equal(config.imageBudget, 10);
  assert.deepEqual(config.artifactChecks, []);
  for (const [key, value] of Object.entries(PROJECT_DEFAULTS)) assert.deepEqual(config[key], value);
  assert.equal(config.worktreeParent, path.join(TEST_HOME, 'Projects', '.herdr-wt'));
  assert.equal(config.worktreePath('worker'), path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(root), 'worker'));
});

test('project config expands a leading ~ in worktreeRoot with the given home', () => {
  const root = temporaryRepo();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-otherhome-')));
  const config = loadProjectConfig({ cwd: root, home });
  assert.equal(config.worktreePath('w1'), path.join(home, 'Projects', '.herdr-wt', path.basename(root), 'w1'));
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ worktreeRoot: '~/trees' }));
  assert.equal(loadProjectConfig({ cwd: root, home }).worktreePath('w1'), path.join(home, 'trees', path.basename(root), 'w1'));
});

test('a project setting keeps the sibling worktree layout', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ worktreeRoot: '..', worktreeName: '{repo}-wt-{name}' }));
  const config = loadProjectConfig({ cwd: root });
  assert.equal(config.worktreePath('worker'), path.join(path.dirname(root), `${path.basename(root)}-wt-worker`));
});

test('project config validates artifact check patterns', () => {
  const root = temporaryRepo();
  const configFile = path.join(root, '.herdr-boss.json');
  const artifactChecks = [{ artifacts: 'docs/gallery/**/*.png', sources: 'extensions/**/src/**' }];
  fs.writeFileSync(configFile, JSON.stringify({ artifactChecks }));
  assert.deepEqual(loadProjectConfig({ cwd: root }).artifactChecks, artifactChecks);

  for (const invalid of [
    null,
    'docs/gallery/**/*.png',
    [{}],
    [{ artifacts: 'out/*.png' }],
    [{ artifacts: 'out/*.png', sources: '' }],
    [{ artifacts: '../out/*.png', sources: 'src/**' }],
    [{ artifacts: '/tmp/out/*.png', sources: 'src/**' }],
    [{ artifacts: 'C:/out/*.png', sources: 'src/**' }],
    [{ artifacts: 'out\\*.png', sources: 'src/**' }],
    [{ artifacts: 'out//*.png', sources: 'src/**' }],
    [{ artifacts: 'out/***/x.png', sources: 'src/**' }],
    [{ artifacts: 'out/**suffix.png', sources: 'src/**' }],
    [{ artifacts: 'out/?.png', sources: 'src/**' }],
    [{ artifacts: 'out/*.png', sources: 'src/**', unexpected: true }],
  ]) {
    fs.writeFileSync(configFile, JSON.stringify({ artifactChecks: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /artifactChecks/);
  }
});

test('project config validates checkAgents.exclude globs', () => {
  const root = temporaryRepo();
  const configFile = path.join(root, '.herdr-boss.json');
  const checkAgents = { exclude: ['.orchestration/tenant-*.md', 'docs/agents/**/generated/*.md'] };
  fs.writeFileSync(configFile, JSON.stringify({ checkAgents }));
  assert.deepEqual(loadProjectConfig({ cwd: root }).checkAgents, checkAgents);
  assert.deepEqual(checkAgentsExclude(root), checkAgents.exclude);
  fs.writeFileSync(configFile, JSON.stringify({}));
  assert.deepEqual(checkAgentsExclude(root), []);

  for (const invalid of [
    null,
    [],
    { exclude: 'docs/*.md' },
    { exclude: [''] },
    { exclude: ['../out/*.md'] },
    { exclude: ['/tmp/*.md'] },
    { exclude: ['docs\\*.md'] },
    { exclude: ['docs/**x.md'] },
    { exclude: ['docs/?.md'] },
    { exclude: [], unexpected: true },
  ]) {
    fs.writeFileSync(configFile, JSON.stringify({ checkAgents: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /checkAgents/, JSON.stringify(invalid));
    assert.throws(() => checkAgentsExclude(root), /checkAgents/, JSON.stringify(invalid));
  }
});

test('glob matching uses * inside a segment and ** for whole segments', () => {
  assert.ok(globMatches('.orchestration/tenant-*.md', '.orchestration/tenant-resources.md'));
  assert.ok(!globMatches('.orchestration/tenant-*.md', '.orchestration/deep/tenant-resources.md'));
  assert.ok(globMatches('docs/**/*.md', 'docs/a.md'));
  assert.ok(globMatches('docs/**/*.md', 'docs/a/b/c.md'));
  assert.ok(globMatches('docs/**', 'docs/a/b.md'));
  assert.ok(!globMatches('docs/*.md', 'docs/a/b.md'));
  assert.ok(!globMatches('docs/a.md', 'docs/a.mdx'));
});

test('project config reads overrides and rejects malformed allowedModels', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'example', baseBranch: 'trunk', allowedModels: ['gpt-6-luna'], agentStartTimeoutMs: 120000 }));
  const config = loadProjectConfig({ cwd: root });
  assert.equal(config.slug, 'example');
  assert.equal(config.baseBranch, 'trunk');
  assert.deepEqual(config.allowedModels, ['gpt-6-luna']);
  assert.equal(config.agentStartTimeoutMs, 120000);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ allowedModels: 'gpt-6-luna' }));
  assert.throws(() => loadProjectConfig({ cwd: root }), /allowedModels must be null or an array/);
  for (const invalid of [0, 300001, 1.5, '90000']) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ agentStartTimeoutMs: invalid }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /agentStartTimeoutMs must be an integer from 1 to 300000/);
  }
});

test('project imageBudget defaults to ten and accepts only positive integers', () => {
  const root = temporaryRepo();
  assert.equal(loadProjectConfig({ cwd: root }).imageBudget, 10);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ imageBudget: 4 }));
  assert.equal(loadProjectConfig({ cwd: root }).imageBudget, 4);
  for (const imageBudget of [0, -1, 1.5, '10', null]) {
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ imageBudget }));
    assert.throws(() => loadProjectConfig({ cwd: root }), /imageBudget must be a positive integer/);
  }
});

test('Herdr runner returns plain pane-read text without JSON parsing', () => {
  const runner = createHerdrRunner((args) => {
    assert.deepEqual(args, ['pane', 'read', 'ws:p2', '--source', 'visible', '--lines', '40', '--format', 'text']);
    return '% ';
  });
  assert.deepEqual(runner(['pane', 'read', 'ws:p2', '--source', 'visible', '--lines', '40', '--format', 'text']), { text: '% ' });
});

test('worker pane readiness recognizes Oh My Zsh git prompt marks', () => {
  for (const prompt of ['➜  project git:(main) ✗', '➜  project git:(main) ✔']) {
    let reads = 0;
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: '/worktree' } };
      if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
      if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 42, foreground_processes: [{ pid: 42 }] } };
      if (args[0] === 'pane' && args[1] === 'read') { reads++; return { text: `${prompt}\n` }; }
      throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
    };
    waitForWorkerPane('ws:p2', 'ws', '/worktree', herdr, () => assert.fail('a recognized prompt must return immediately'));
    assert.equal(reads, 1, `${prompt} must be recognized as a prompt`);
  }
});

test('worker pane readiness uses its configured timeout', () => {
  let waits = 0;
  const herdr = () => { throw new Error('pane is not ready'); };
  assert.throws(() => waitForWorkerPane('ws:p2', 'ws', '/worktree', herdr, () => { waits++; }, { timeoutMs: 90_000 }), /within 90 seconds/);
  assert.equal(waits, 360);
});

test('brief rendering fills known slots and rejects an unknown slot', () => {
  assert.equal(renderBrief('Worker {{name}} in {{project}}: {{task}} / {{allowedPaths}}', {
    name: 'demo', project: 'sample', task: 'do the work', allowedPaths: ['src/', 'test/'],
  }), 'Worker demo in sample: do the work / - src/\n- test/');
  assert.equal(renderBrief('Issue {{issue}}', {}), 'Issue (none)');
  assert.throws(() => renderBrief('Bad {{notAContractSlot}}', {}), /Unknown brief template slot/);
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.match(template, /WORKER REPORT.*WORKER QUESTION.*fails, record the failed command and reason in the worker report, then stop/s);
  assert.match(template, /Boss monitors report metadata and will notify the orchestrator/);
  assert.match(template, /These report and question commands are an exception to the rule against Herdr commands outside Herdr/);
  assert.match(template, /{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchPane}} "WORKER QUESTION/);
  assert.match(template, /{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchPane}} "WORKER REPORT/);
});

test('worker report and delegated run validation enforce their handoff schemas', () => {
  assert.deepEqual(validateWorkerReport(validReport, { evidenceTiers: tiers }), []);
  assert.deepEqual(validateWorkerReport({ ...validReport, issue: null }, { evidenceTiers: tiers }), []);
  assert.ok(validateWorkerReport({ ...validReport, stoppedEarly: 'no', evidenceTier: ['reload'] }, { evidenceTiers: tiers }).some((error) => error.includes('unknown')));
  assert.ok(validateWorkerReport({ ...validReport, changedPaths: 'src/a.js' }, { evidenceTiers: tiers }).some((error) => error.includes('changedPaths must be an array')));
  assert.deepEqual(validateDelegatedRun(validRun, { evidenceTiers: tiers }), []);
  assert.deepEqual(validateDelegatedRun({ ...validRun, issue: null, toolCalls: null }, { evidenceTiers: tiers }), []);
  assert.ok(validateDelegatedRun({ ...validRun, issue: 0 }, { evidenceTiers: tiers }).some((error) => error.includes('issue')));
});

test('ledger append and read validate JSONL entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-ledger-'));
  const file = path.join(directory, 'runs.jsonl');
  appendDelegatedRun(file, validRun, { evidenceTiers: tiers });
  assert.deepEqual(readDelegatedRuns(file, { evidenceTiers: tiers }), [validRun]);
  fs.appendFileSync(file, '{bad json}\n');
  assert.throws(() => readDelegatedRuns(file, { evidenceTiers: tiers }), /Invalid JSONL entry 2/);
});

test('scope comparison accepts allowed directories and reports paths outside them', () => {
  assert.deepEqual(compareChangedPaths(['src/a.js', 'test/a.test.js', 'docs/new.md'], ['src/', 'test/*.test.js']), ['docs/new.md']);
  assert.deepEqual(validateAllowedPaths(['src/', 'test/a.test.js']), []);
  assert.ok(validateAllowedPaths(['../outside']).some((error) => error.includes('stay inside')));
});

test('committed rename checks both removed and added paths', () => {
  const root = temporaryRepo();
  git(root, 'switch', '-c', 'worker');
  git(root, 'mv', 'README.md', 'renamed.md');
  git(root, 'commit', '-m', 'rename');
  assert.deepEqual(gitChangedPaths(root, 'main').sort(), ['README.md', 'renamed.md']);
});

test('safe GitHub arguments require one body file and reject inline bodies', () => {
  assert.deepEqual(buildGhArgs('create', ['--title', 'Example', '--body-file', 'body.md']), ['issue', 'create', '--title', 'Example', '--body-file', 'body.md']);
  assert.deepEqual(buildGhArgs('comment', ['17', '--body-file', 'body.md']), ['issue', 'comment', '17', '--body-file', 'body.md']);
  assert.throws(() => buildGhArgs('edit', ['17', '--body', 'unsafe']), /inline --body/);
  assert.throws(() => buildGhArgs('comment', ['nope', '--body-file', 'body.md']), /numeric issue/);
  assert.throws(() => buildGhArgs('create', ['--body-file', 'one.md', '--body-file', 'two.md']), /exactly one/);
});

test('worktree classification uses temporary git state and live pane cwd', () => {
  const root = temporaryRepo();
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-safe`);
  git(root, 'switch', '-c', 'safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'safe');
  const busy = path.join(path.dirname(root), `${path.basename(root)}-wt-busy`);
  git(root, 'worktree', 'add', '-b', 'busy', busy, 'main');
  const dirty = path.join(path.dirname(root), `${path.basename(root)}-wt-dirty`);
  git(root, 'worktree', 'add', '-b', 'dirty', dirty, 'main');
  fs.writeFileSync(path.join(dirty, 'local.txt'), 'uncommitted\n');
  const config = loadProjectConfig({ cwd: root });
  const classified = classifyWorktrees(config, { panes: [{ cwd: path.join(busy, 'src') }], now: Date.now() });
  const byPath = new Map(classified.map((item) => [item.path, item]));
  assert.equal(byPath.get(safe).merged, true);
  assert.equal(byPath.get(safe).clean, true);
  assert.equal(byPath.get(safe).removable, true);
  assert.equal(byPath.get(busy).livePane, true);
  assert.equal(byPath.get(busy).removable, false);
  assert.equal(byPath.get(dirty).clean, false);
  assert.equal(byPath.get(dirty).removable, false);
  assert.equal(byPath.get(root).isPrimary, true);
});

test('worktree apply removes a clean merged worker tree in a temporary repo', () => {
  const root = temporaryRepo();
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-safe`);
  git(root, 'switch', '-c', 'safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'safe');
  const config = loadProjectConfig({ cwd: root });
  const output = [];
  const remaining = pruneWorktrees(config, { apply: true, herdr: () => ({ panes: [] }), output: (text) => output.push(text) });
  assert.equal(remaining.find((item) => item.path === safe).removable, true);
  assert.equal(fs.existsSync(safe), false);
  assert.throws(() => git(root, 'show-ref', '--verify', 'refs/heads/safe'));
  assert.ok(output.some((line) => line.includes(`Removed ${safe}`)));
});

test('worktree prune blocks live cwd processes, missing-worktree orphans, and failed scans', (t) => {
  const root = temporaryRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safe = path.join(path.dirname(root), `${path.basename(root)}-wt-process`);
  git(root, 'switch', '-c', 'process-safe');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'merged\n');
  git(root, 'add', 'safe.txt');
  git(root, 'commit', '-m', 'safe change');
  git(root, 'switch', 'main');
  git(root, 'merge', '--no-ff', 'process-safe', '-m', 'merge safe');
  git(root, 'worktree', 'add', safe, 'process-safe');
  const config = loadProjectConfig({ cwd: root });
  const live = [];
  const kept = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [{ pid: 321, ppid: 44, command: 'node --token should-not-print', cwd: path.join(safe, 'src') }],
    output: (line) => live.push(line),
  });
  assert.equal(kept.find((item) => item.path === safe).removable, false);
  assert.equal(kept.find((item) => item.path === safe).processBlocked, true);
  assert.equal(kept.find((item) => item.path === safe).processes[0].pid, 321);
  assert.equal(fs.existsSync(safe), true);
  assert.ok(live.some((line) => line.includes(`node (pid 321, ppid 44, cwd ${path.join(safe, 'src')})`)));
  assert.ok(!live.join('\n').includes('should-not-print'));

  fs.rmSync(safe, { recursive: true, force: true });
  const orphanLines = [];
  const orphaned = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => [{ pid: 322, ppid: 1, command: 'zsh', cwd: path.join(safe, 'deleted-subdir') }],
    output: (line) => orphanLines.push(line),
  });
  const missing = orphaned.find((item) => item.path === safe);
  assert.equal(missing.exists, false);
  assert.equal(missing.processBlocked, true);
  assert.deepEqual(missing.processes.map((item) => item.pid), [322]);
  assert.ok(orphanLines.some((line) => line.includes(`zsh (pid 322, ppid 1, cwd ${path.join(safe, 'deleted-subdir')})`)));
  assert.ok(git(root, 'worktree', 'list', '--porcelain').includes(safe), 'the missing worktree record stays available for inspection');

  const failedLines = [];
  const afterFailure = pruneWorktrees(config, {
    apply: true,
    herdr: () => ({ panes: [] }),
    listProcesses: () => { throw new Error('lsof unavailable'); },
    output: (line) => failedLines.push(line),
  });
  assert.equal(afterFailure.find((item) => item.path === safe).processScanError, 'lsof unavailable');
  assert.ok(failedLines.some((line) => /Process scan failed.*no worktrees can be removed/.test(line)));
});

test('project locks enforce pane ownership, wait, stale takeover, and safe release', (t) => {
  const root = temporaryRepo('herdr-lock-');
  const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  git(root, 'worktree', 'add', '-b', 'linked-lock-test', linked, 'main');
  t.after(() => {
    try { git(root, 'worktree', 'remove', '--force', linked); } catch {}
    try { git(root, 'branch', '-D', 'linked-lock-test'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  });
  const config = loadProjectConfig({ cwd: root });
  const linkedConfig = loadProjectConfig({ cwd: linked });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const livePanes = new Set(['ws:orch-a', 'ws:orch-b']);
  const livePids = new Set([501, 502]);
  let caller = 'ws:orch-a';
  let sleepCount = 0;
  const calls = [];
  const herdr = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: args.at(-1) === 'ws:orch-a' ? 501 : 502 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...livePanes].map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = (projectConfig = config) => ({
    config: projectConfig,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr,
    pidAlive: (pid) => livePids.has(pid),
    output: () => {},
    now: () => Date.parse('2026-09-26T12:00:00.000Z'),
    pause: () => {
      sleepCount += 1;
      caller = 'ws:orch-a';
      runKitCommand('lock', ['release', 'deploy'], options(config));
      caller = 'ws:orch-b';
    },
  });
  const output = [];
  caller = 'ws:orch-a';
  const created = runKitCommand('lock', ['acquire', 'deploy'], { ...options(), output: (line) => output.push(line) });
  assert.equal(created.ownerPane, 'ws:orch-a');
  assert.equal(created.pid, 501);
  assert.equal(created.command, 'herdr-boss lock acquire deploy');
  assert.equal(created.acquiredAt, '2026-09-26T12:00:00.000Z');
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy'], { ...options(), config: linkedConfig }), /held by active pane ws:orch-a \(PID 501/i);
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], { ...options(), config: linkedConfig }), /active lock.*another pane/i);
  const waited = runKitCommand('lock', ['acquire', 'deploy', '--wait', '2'], { ...options(linkedConfig), output: (line) => output.push(line) });
  assert.equal(waited.ownerPane, 'ws:orch-b');
  assert.equal(sleepCount, 1);
  assert.ok(calls.includes('pane get ws:orch-b'));
  assert.equal(fs.statSync(path.join(dataDir, 'locks')).mode & 0o777, 0o700);
  const repositoryLocksDir = path.join(dataDir, 'locks', fs.readdirSync(path.join(dataDir, 'locks'))[0]);
  assert.equal(fs.statSync(repositoryLocksDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(repositoryLocksDir, 'deploy.json')).mode & 0o777, 0o600);
  const listed = runKitCommand('lock', ['list'], { ...options(linkedConfig), output: (line) => output.push(line) });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ownerPane, 'ws:orch-b');
  assert.equal(listed[0].state, 'live');
  const permissionDenied = runKitCommand('lock', ['list'], {
    ...options(linkedConfig),
    pidAlive: () => { const error = new Error('permission denied'); error.code = 'EPERM'; throw error; },
    output: () => {},
  });
  assert.equal(permissionDenied[0].state, 'live');
  const herdrUnavailable = (args) => {
    if (args[0] === 'pane' && args[1] === 'list') throw new Error('pane service unavailable');
    return herdr(args);
  };
  assert.throws(() => runKitCommand('lock', ['list'], { ...options(linkedConfig), herdr: herdrUnavailable, output: () => {} }), /pane service unavailable/);
  caller = 'ws:orch-a';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], options()), /active lock.*another pane/i);
  livePids.delete(502);
  caller = 'ws:orch-a';
  const stale = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(stale[0].state, 'stale');
  const takeover = runKitCommand('lock', ['acquire', 'deploy'], { ...options(), output: (line) => output.push(line) });
  assert.equal(takeover.ownerPane, 'ws:orch-a');
  assert.equal(takeover.state, 'live');
  assert.ok(output.some((line) => /NOTICE.*taking over stale lock.*ws:orch-b.*502/i.test(line)));
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['release', 'deploy'], options()), /active lock.*another pane/i);
  caller = 'ws:orch-a';
  runKitCommand('lock', ['release', 'deploy'], options());
  assert.equal(runKitCommand('lock', ['list'], { ...options(), output: () => {} }).length, 0);
  runKitCommand('lock', ['acquire', 'closed-pane'], options());
  livePanes.delete('ws:orch-a');
  const closedPaneLock = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(closedPaneLock[0].state, 'stale');
  caller = 'ws:orch-b';
  assert.equal(runKitCommand('lock', ['acquire', 'closed-pane'], options()).ownerPane, 'ws:orch-b');
  runKitCommand('lock', ['release', 'closed-pane'], options());
  assert.throws(() => runKitCommand('lock', ['acquire', '../unsafe'], options()), /lock name.*path-safe/i);
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy', '--wait', '1.5'], options()), /whole non-negative number/i);
});

test('a concurrent lock mutation cannot replace an observed stale lock during takeover', (t) => {
  const root = temporaryRepo('herdr-lock-race-');
  const config = loadProjectConfig({ cwd: root });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-race-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const livePanes = new Set(['ws:orch-a', 'ws:orch-b', 'ws:orch-stale']);
  const livePids = new Set([701, 702, 703]);
  const pids = { 'ws:orch-a': 701, 'ws:orch-b': 702, 'ws:orch-stale': 703 };
  let caller = 'ws:orch-stale';
  let competingAcquireTried = false;
  let competingAcquireError;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: pids[args.at(-1)] } };
    if (args[0] === 'pane' && args[1] === 'list') {
      if (!competingAcquireTried) {
        competingAcquireTried = true;
        caller = 'ws:orch-b';
        try { runKitCommand('lock', ['acquire', 'deploy'], options()); }
        catch (error) { competingAcquireError = error; }
        finally { caller = 'ws:orch-a'; }
      }
      return { panes: [...livePanes].map((pane_id) => ({ pane_id })) };
    }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const options = () => ({
    config,
    lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr,
    pidAlive: (pid) => livePids.has(pid),
    output: () => {},
    now: () => Date.parse('2026-09-26T12:00:00.000Z'),
  });

  runKitCommand('lock', ['acquire', 'deploy'], options());
  livePanes.delete('ws:orch-stale');
  caller = 'ws:orch-a';
  const takeover = runKitCommand('lock', ['acquire', 'deploy'], options());

  assert.match(competingAcquireError?.message || '', /lock operation is already in progress/i);
  assert.equal(takeover.ownerPane, 'ws:orch-a');
  caller = 'ws:orch-b';
  assert.throws(() => runKitCommand('lock', ['acquire', 'deploy'], options()), /held by active pane ws:orch-a/i);
  const listed = runKitCommand('lock', ['list'], { ...options(), output: () => {} });
  assert.equal(listed[0].ownerPane, 'ws:orch-a');
  assert.equal(listed[0].state, 'live');
});

test('worker start dry-run prints the plan and makes no worktree or agent changes', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} {{allowedPaths}}');
  const configFile = path.join(root, '.herdr-boss.json');
  fs.writeFileSync(configFile, JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: '2026-09-24T12:00:00.000Z', avoidKinds: [], preferredKinds: ['codex'], memFreePercent: 50, notes: [], policy: { allowedKinds: ['codex'], excludedModels: [], preferredModels: { codex: 'gpt-6-sol' } } }));
  const models = loadModels();
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent') return { agents: [] };
    if (args[0] === 'tab') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, now: Date.parse('2026-09-24T12:00:00Z'), output: (text) => output.push(text),
  });
  assert.equal(result.dryRun, true);
  assert.match(output.join('\n'), /git worktree add -b demo/);
  assert.match(output.join('\n'), /Validate kind\/model\/effort: codex \/ gpt-6-sol/);
  assert.match(output.join('\n'), /herdr pane split ws:p1 --direction right --cwd/);
  assert.match(output.join('\n'), /New pane: <new-pane-id>/);
  assert.match(output.join('\n'), /herdr agent start demo --kind codex --pane '<new-pane-id>' --timeout 90000 --/);
  assert.ok(!output.join('\n').includes('tab create'));
  assert.match(output.join('\n'), /Read \.worker\/brief\.md in your working directory and execute it/);
  assert.ok(calls.some((call) => call.join(' ') === 'agent list'));
  const newPath = path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(root), 'demo');
  assert.equal(result.worktree, newPath);
  assert.ok(output.join('\n').includes(newPath));
  assert.ok(!fs.existsSync(config.worktreePath('demo')));
  assert.ok(!fs.existsSync(path.dirname(newPath)));
  assert.ok(!fs.existsSync(path.join(config.runsPath, 'demo.json')));
  assert.deepEqual(git(root, 'branch', '--show-current'), 'main');
  const explicitOutput = [];
  startWorker('demo-explicit', { kind: 'codex', model: 'gpt-6-astra', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, now: Date.parse('2026-09-24T12:00:00Z'), output: (text) => explicitOutput.push(text),
  });
  assert.match(explicitOutput.join('\n'), /Validate kind\/model\/effort: codex \/ gpt-6-astra/);
  fs.writeFileSync(rulesFile, JSON.stringify({ avoidProviders: ['claude'], policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { 'gpt-6-sol': 'claude' } } }));
  assert.throws(() => startWorker('demo-routed', { kind: 'codex', model: 'gpt-6-sol', task: 'x', allow: ['src/'], dryRun: true }, {
    config, models, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile, output: () => {},
  }), /claude is ahead of quota pace or near exhaustion/);
});

test('worker start validates the caller pane and uses it for placement and reporting', () => {
  const f = setupFixture(null);
  const template = path.join(f.root, 'brief-template.md');
  fs.writeFileSync(template, 'Report target: {{orchPane}}');
  fs.writeFileSync(path.join(f.root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: f.root });
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('caller-valid') } };
    return f.herdr(args);
  };
  const result = startWorker('caller-valid', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Report target: ws:orch\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.');
  assert.ok(calls.some((args) => args.join(' ') === 'tab list --workspace ws'));
  assert.ok(calls.some((args) => args.join(' ') === 'pane get ws:orch'));

  for (const [name, env, pane, options, message] of [
    ['caller-no-pane', { ...f.env, HERDR_PANE_ID: undefined }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /HERDR_PANE_ID is required/],
    ['caller-no-workspace', { ...f.env, HERDR_WORKSPACE_ID: undefined }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /HERDR_WORKSPACE_ID is required/],
    ['caller-id', f.env, { pane_id: 'ws:someone-else', workspace_id: 'ws', label: 'orch' }, {}, /differs from HERDR_PANE_ID/],
    ['caller-workspace', { ...f.env, HERDR_WORKSPACE_ID: 'other' }, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, {}, /workspace/],
    ['caller-label', f.env, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'worker' }, {}, /label/],
    ['caller-orch', f.env, { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' }, { orch: 'ws:other' }, /--orch must match/],
  ]) {
    const fixtureEntries = new Set(fs.readdirSync(f.root));
    const fixtureStatus = git(f.root, 'status', '--porcelain');
    const callsBefore = f.calls.length;
    const rejectedHerdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane };
      return f.herdr(args);
    };
    assert.throws(() => startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], ...options }, {
      config, models: loadModels(), herdr: rejectedHerdr, env, rulesFile: f.rulesFile, output: () => {},
    }), (error) => message.test(error.message) && /Pass explicit HERDR_PANE_ID and HERDR_WORKSPACE_ID values/.test(error.message) && /restart the Codex session/.test(error.message));
    assert.equal(fs.existsSync(config.worktreePath(name)), false);
    assert.equal(fs.existsSync(path.join(config.runsPath, `${name}.json`)), false);
    assert.ok(!f.calls.slice(callsBefore).includes('agent start'));
    assert.ok(!f.calls.slice(callsBefore).some((call) => ['pane split', 'tab create', 'agent start'].includes(call)), 'invalid caller creates no worker-side Herdr resources');
    assert.equal(git(f.root, 'status', '--porcelain'), fixtureStatus, 'invalid caller does not change the fixture repository');
    assert.deepEqual(new Set(fs.readdirSync(f.root)), fixtureEntries, 'invalid caller leaves its isolated fixture paths unchanged');
  }
});

test('worker start refuses excluded caller workspace before creating worktree, tab, or agent', (t) => {
  const f = setupFixture(null);
  t.after(() => {
    const worktree = f.config.worktreePath('excluded-caller');
    try { if (fs.existsSync(worktree)) git(f.root, 'worktree', 'remove', '--force', worktree); } catch {}
    try { git(f.root, 'branch', '-D', 'excluded-caller'); } catch {}
    fs.rmSync(path.join(f.config.runsPath, 'excluded-caller.json'), { force: true });
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const workspaceId = 'workspace-excluded';
  const workspaceLabel = 'Research Room';
  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    avoidKinds: [],
    policy: {
      allowedKinds: ['codex'], excludedModels: [], preferredModels: { codex: 'gpt-6-luna' },
      projects: { [f.config.slug]: { share: 100, mode: 'auto', excludedKinds: [], excludedModels: [] } },
    },
    control: {
      runningWorkers: 0, maxWorkers: 8,
      projects: { [f.config.slug]: { running: 0, slots: 8, effectiveMode: 'active' } },
      workspaces: [{ workspace: workspaceId, label: workspaceLabel, excluded: true }],
    },
  }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get' && args[2] === 'ws:orch') {
      return { pane: { pane_id: 'ws:orch', workspace_id: workspaceId, label: 'orch' } };
    }
    if (args[0] === 'tab' && args[1] === 'create') throw new Error('Test guard: unexpected tab creation.');
    return f.herdr(args);
  };
  let failure;
  try {
    startWorker('excluded-caller', { kind: 'codex', task: 'x', allow: ['src/'], force: true }, {
      config: f.config, models: loadModels(), herdr, env: { ...f.env, HERDR_WORKSPACE_ID: workspaceId }, rulesFile: f.rulesFile, output: () => {},
    });
  } catch (error) { failure = error; }
  assert.ok(failure, 'worker start must refuse the excluded workspace');
  assert.match(failure.message, new RegExp(`${workspaceLabel}.*has no worker slots`));
  assert.equal(fs.existsSync(f.config.worktreePath('excluded-caller')), false);
  assert.throws(() => git(f.root, 'show-ref', '--verify', 'refs/heads/excluded-caller'));
  assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create'), false);
  assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'start'), false);
});

test('worker collect --record uses the provider recorded at start, including null routes', () => {
  for (const [name, route, expected, failUsage] of [['collect-routed', 'claude', 'claude', false], ['collect-free', null, null, false], ['collect-failure', 'claude', 'claude', true]]) {
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
    const collect = () => collectWorker(name, { record: true, outcome: 'done', gatePassed: true }, {
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
    const savedRun = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
    assert.equal(savedRun.provider, expected);
    assert.equal(savedRun.finishedAt, '2026-09-25T17:00:00.000Z');
    assert.equal(usage[0].provider, expected);
    assert.equal(usage[0].recordedProvider, expected ?? 'unmetered-or-unknown');
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
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Worker demo: x\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.');
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
  const collect = () => collectWorker('stable-base', {}, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
  });
  const beforeMerge = collect();
  git(f.root, 'merge', '--ff-only', run.branch);
  const afterMerge = collect();
  assert.deepEqual(beforeMerge.actualPaths, ['src/change.js']);
  assert.deepEqual(afterMerge.actualPaths, beforeMerge.actualPaths);
});

test('worker collect --record refuses invalid reports and scopes without printing a success summary', () => {
  const cases = [
    { name: 'collect-scope-refusal', changedPath: 'docs/outside.md', allowedPaths: ['src/', '.orchestration/runs/'], reportPaths: ['docs/outside.md'], error: /outside its allowed scope/ },
    { name: 'collect-omitted-refusal', changedPath: 'src/change.js', allowedPaths: ['src/', '.orchestration/runs/'], reportPaths: [], error: /omitted changed paths/ },
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
        : {};
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
  assert.equal(fs.existsSync(config.worktreePath('branch-with-work')), false);
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
  for (const kind of ['pi', 'opencode', 'future-harness']) {
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
  assert.throws(() => collectWorker('read-only', {}, {
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

test('worker start refuses a reached provider lane cap while night watch is active', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.rulesFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    night: { active: true, maxWorkersByLane: { codex: 1 } },
    control: { runningWorkers: 0, maxWorkers: 8, runningByLane: { codex: 1 }, projects: {} },
  }));
  assert.throws(() => startWorker('night-lane-refused', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  }), /Night worker lane limit \(1\) for codex is reached/);
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

function setupFixture(setup) {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} Inputs: {{copyPaths}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template, setup }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let paneCwd = root;
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'pane' && args[1] === 'read') return { text: '% ' };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
    if (args[0] === 'pane' && args[1] === 'close') return {};
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'read') return { text: ALL_READY_SCREENS };
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  return { root, config, rulesFile, calls, herdr, env };
}

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
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker/brief.md'), 'utf8'), 'Budget 6. The project setting overrides the kit default.');
});

test('worker brief names the orchestrator by pane and stable agent name', () => {
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  const brief = renderBrief(template, { orchPane: 'w1:p9', orchAgent: 'demo-orch' });
  assert.match(brief, /Your orchestrator is pane `w1:p9` \(agent `demo-orch`\)\./);
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
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Limit: Add `--poolOptions.forks.maxForks=2` to each test runner command.\n\n## Worker start details\n\nScreenshot budget: 10 screenshots. The project setting overrides the kit default.');
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
  assert.throws(() => collectWorker('scope-collect', {}, {
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
  assert.equal(start('extra-preferred', { kind: 'pi' }).result.model, extra);

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
    'beta: kit revision abcdef012345 (old); agents check 1 errors, 0 warnings',
    'gamma: kit revision none (not published); agents check not published',
    `check kit: FAIL (current revision ${current}; 3 projects, 2 not current)`,
  ]);

  write('beta', { kitRevision: current });
  fs.rmSync(path.join(dataDir, 'projects', 'gamma.json'));
  const pass = spawnSync(process.execPath, [cli, 'check', 'kit'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /check kit: PASS \(current revision [0-9a-f]{12}; 2 projects, 0 not current\)/);
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
  assert.match(app, /kitRevisionLine\(p\)/);
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
  assert.deepEqual(listed[1].queue.map((ticket) => [ticket.position, ticket.project, ticket.pane, ticket.kind]), [
    [1, 'alpha', 'ws:orch-b', 'suite'],
  ]);
  assert.ok(lines.some((line) => /^  Queue: 1\. alpha ws:orch-b \(suite\) \d+m$/.test(line)), lines.join('\n'));
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

test('manual full-suite locks expire after an hour and the engine warns the holder at takeover', async (t) => {
  const root = temporaryRepo('herdr-manual-suite-lock-');
  const config = loadProjectConfig({ cwd: root });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-manual-suite-lock-data-'));
  t.after(() => [root, dataDir].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const panes = new Set(['ws:orch-a', 'ws:orch-b']);
  const pids = new Set([501, 502]);
  const calls = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: args.at(-1) === 'ws:orch-a' ? 501 : 502 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...panes].map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  let caller = 'ws:orch-a';
  let now = Date.parse('2026-09-28T10:00:00.000Z');
  const output = [];
  const options = () => ({
    config, lockDataDir: dataDir,
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: caller },
    herdr, pidAlive: (pid) => pids.has(pid), now: () => now,
    output: (line) => output.push(line),
  });

  const held = runKitCommand('lock', ['acquire', 'full-suite'], options());
  assert.equal(held.kind, 'manual');
  assert.equal(held.pid, 501);
  assert.equal(held.expiresAt, '2026-09-28T11:00:00.000Z');
  now += 3 * 60 * 1000;
  const listed = runKitCommand('lock', ['list'], options());
  assert.equal(listed[0].state, 'live');
  assert.match(output.at(-1), /full-suite .*ws:orch-a.*manual.*3m.*57m/);

  now += 58 * 60 * 1000;
  caller = 'ws:orch-b';
  const takeover = runKitCommand('lock', ['acquire', 'full-suite'], options());
  assert.equal(takeover.ownerPane, 'ws:orch-b');
  assert.equal(takeover.kind, 'manual');
  const noticesDir = path.join(dataDir, 'locks', 'machine', 'notices');
  const noticeFiles = fs.readdirSync(noticesDir);
  assert.equal(noticeFiles.length, 1);
  const notice = JSON.parse(fs.readFileSync(path.join(noticesDir, noticeFiles[0]), 'utf8'));
  assert.equal(notice.severity, 'warn');
  assert.equal(notice.ownerPane, 'ws:orch-a');
  assert.equal(notice.text, 'Your full-suite lock expired after 60 minutes and was released. Use herdr-boss suite -- <command> next time.');

  const engine = Object.create(Engine.prototype);
  engine.lockDataDir = dataDir;
  engine.push = true;
  engine.herdrRunner = async (...args) => { calls.push(args); return '{}'; };
  engine.log = (...args) => calls.push(['log', ...args]);
  await engine.deliverLockTakeoverNotices({ panes: [{ id: 'ws:orch-a' }, { id: 'ws:orch-b' }] });
  const sent = calls.filter((call) => call[0] === 'herdr');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1][0], 'agent');
  assert.equal(sent[0][1][1], 'prompt');
  assert.equal(sent[0][1][2], 'ws:orch-a');
  assert.match(sent[0][1][3], /Your full-suite lock expired after 60 minutes and was released/);
  assert.ok(calls.some((call) => call[0] === 'log' && call[3]?.severity === 'warn'));
  await engine.deliverLockTakeoverNotices({ panes: [{ id: 'ws:orch-a' }] });
  assert.equal(calls.filter((call) => call[0] === 'herdr').length, 1, 'the holder gets one notice');
});

test('the bulletin shows the current machine lock holder, kind, and age', () => {
  const text = renderBulletin({
    updatedAt: '2026-09-28T10:15:00.000Z',
    locks: [{
      name: 'full-suite', scope: 'machine', state: 'live', ownerPane: 'ws:orch', kind: 'suite', ageSeconds: 900,
      queue: [{ position: 1, project: 'alpha', pane: 'ws:alpha-orch', kind: 'suite', waitSeconds: 2460 }],
    }],
  }, { alerts: [], advice: [] }, { dashboardPort: 4477 });
  assert.match(text, /- full-suite held by ws:orch \(suite\) for 15m; queue: 1\. alpha ws:alpha-orch 41m\./);
});

test('the allocation Locks panel renders each full-suite queue entry', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function machineLocksBlock\(s\)/);
  assert.match(app, /ticket\.position/);
  assert.match(app, /ticket\.project/);
  assert.match(app, /ticket\.pane/);
  assert.match(app, /ticket\.kind/);
  assert.match(app, /ticket\.waitSeconds/);
});

test('worker start gives the pane absolute TMPDIR and HERDR_WORKTREE paths and creates the folder', () => {
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
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    if (args[0] === 'agent' && args[1] === 'read') return { text: ALL_READY_SCREENS };
    if (args[0] === 'agent' && (args[1] === 'start' || args[1] === 'prompt')) return {};
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  const start = (name, options) => startWorker(name, { kind: 'opencode', task: 'x', allow: ['src/'], ...options }, { config, models: loadModels(), herdr, env, rulesFile, wait: () => {}, output: () => {} });
  const envValues = (args) => Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === '--env' ? [arg.split(/=(.*)/s).slice(0, 2)] : [])));

  const run = start('abspaths', {});
  const values = envValues(creates.at(-1));
  assert.ok(path.isAbsolute(run.worktree));
  assert.equal(values.HERDR_WORKTREE, run.worktree);
  assert.equal(values.TMPDIR, path.join(run.worktree, '.worker', 'tmp'));
  assert.ok(fs.statSync(values.TMPDIR).isDirectory());

  const shared = start('sharedpaths', { noWorktree: true });
  const sharedValues = envValues(creates.at(-1));
  assert.equal(shared.worktree, root);
  assert.equal(sharedValues.HERDR_WORKTREE, root);
  assert.equal(sharedValues.TMPDIR, path.join(root, '.worker', 'sharedpaths', 'tmp'));
  assert.ok(fs.statSync(sharedValues.TMPDIR).isDirectory());
});

test('the worker brief template uses absolute worker paths and the kit names no load threshold', () => {
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.doesNotMatch(template, /\$PWD\/\.worker/);
  assert.match(template, /"\$TMPDIR"/);
  assert.match(template, /"\$HERDR_WORKTREE\/\.worker\//);
  assert.match(template, /Never use `\.\.\/`/);
  const gates = template.slice(template.indexOf('## Gates on a shared machine'), template.indexOf('## Reports'));
  assert.doesNotMatch(gates, /herdr-boss lock acquire full-suite/);
  const processSafety = template.slice(template.indexOf('## Process safety'), template.indexOf('## Edit scope'));
  assert.ok(template.indexOf('## Process safety') > 0 && template.indexOf('## Process safety') < template.indexOf('## Edit scope'));
  assert.match(processSafety, /List processes only with `pgrep -l NAME` or `ps -o pid,ppid,etime,comm`\./);
  assert.match(processSafety, /Never use `ps e`, `ps -E`, `ps eww`, `ps aux`, `ps -ef`, or `pgrep -fl`\./);
  assert.match(processSafety, /Run each `herdr-boss browser` command and each `ps` or `pgrep` command alone\. Do not join it to other commands with `&&`, `;`, or a pipe\./);
  assert.match(processSafety, /Run `herdr-boss suite -- npm test` as a background command, then wait for it and read its exit code\. The tool timeout is 600 seconds\./);
  assert.match(gates, /Run only the scoped acceptance commands named in this brief or task contract\./);
  const grep = spawnSync('grep', ['-rn', 'load average is under 30', 'kit', 'docs'], { encoding: 'utf8' });
  assert.equal(grep.stdout, '');
  const backgroundSuiteRule = /Run `herdr-boss suite -- npm test` as a background command, then wait for it and read its exit code\. The tool timeout is 600 seconds\./;
  const fullSuiteLockRule = /Never take the full-suite lock with a bare lock acquire for a suite\./;
  for (const file of ['kit/templates/project-kit.md', 'kit/skills/herdr-orchestrator/SKILL.md', 'kit/templates/worker-brief.md']) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    assert.match(text, backgroundSuiteRule, file);
    assert.match(text, fullSuiteLockRule, file);
    assert.doesNotMatch(text, /herdr-boss lock acquire full-suite/, file);
  }
  const projectKit = fs.readFileSync(path.resolve('kit/templates/project-kit.md'), 'utf8');
  assert.match(projectKit, /Use `--read-only` for a task that changes no repository file\./);
  assert.match(projectKit, /Run each `herdr-boss browser` command and each `ps` or `pgrep` command alone\. Do not join it to other commands with `&&`, `;`, or a pipe\./);
  assert.ok(projectKit.includes('The full-suite lock serves waiters in order. Start your suite once, and wait; do not restart it to jump the queue.'));
  assert.ok(projectKit.includes('Exit code 75 means the lock was busy and no test ran.'));
  const userGuide = fs.readFileSync(path.resolve('docs/user-guide.md'), 'utf8');
  assert.match(userGuide, fullSuiteLockRule);
  assert.match(userGuide, /Run a full test suite with `herdr-boss suite -- <command>`/);
  const cli = fs.readFileSync(path.resolve('docs/cli.md'), 'utf8');
  assert.match(cli, /herdr-boss suite -- npm test/);
  assert.match(cli, /herdr-boss push/);
  assert.doesNotMatch(cli, /herdr-boss lock acquire full-suite --wait 1800/);
});

test('the orchestrator skill stays short and links each reference file', () => {
  const dir = path.resolve('kit/skills/herdr-orchestrator');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const words = skill.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 2300 && words <= 2700, `SKILL.md has ${words} words`);
  assert.match(skill, /^---\nname: herdr-orchestrator\ndescription: Use when /);
  assert.match(skill, /Use `--read-only` for a task that changes no repository file\./);
  const references = ['herdr-control.md', 'machine-and-quota.md', 'handover.md', 'ledger-and-evidence.md'];
  for (const name of references) assert.match(skill, new RegExp(`^- \\[reference/${name.replace('.', '\\.')}\\]\\(reference/${name.replace('.', '\\.')}\\): read `, 'm'), name);
  assert.match(skill, /\]\(\.\.\/\.\.\/models\.md\)/);
  assert.match(skill, /\]\(\.\.\/\.\.\/browser-service\.md\)/);
  for (const file of ['SKILL.md', ...references.map((name) => `reference/${name}`)]) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(dir, file)), target)), `${file} links ${target}`);
    }
  }
  const all = [skill, ...references.map((name) => fs.readFileSync(path.join(dir, 'reference', name), 'utf8'))].join('\n');
  for (const rule of [
    'Never stop the Herdr server or kill the main Herdr process to recover a worker.',
    'Treat `idle` as ready for input, not as proof of completion.',
    '`vitest run --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`',
    'Limit a shared cheap provider lane to two concurrent workers.',
    'Review its output before `handoff activate <id> --confirmed`.',
    'Treat the ledger as operational telemetry, not acceptance evidence.',
    'Do not promote local tests to hosted, visual, accessibility, performance, commercial, hardware, or Owner proof.',
  ]) assert.ok(all.includes(rule), rule);
});

test('the brief template has the leased resources line and the kit names the lease rule', () => {
  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.match(template, /^- Leased resources: {{leases}}$/m);
  const rendered = renderBrief('Leased resources: {{leases}}', { leases: '`HERDR_SERVE_PORT=47100` (pool `serve-ports`). Use only these.' });
  assert.equal(rendered, 'Leased resources: `HERDR_SERVE_PORT=47100` (pool `serve-ports`). Use only these.');
  assert.equal(renderBrief('Leased resources: {{leases}}', {}), 'Leased resources: (none)');
  const rule = 'Lease a shared resource with `herdr-boss lease acquire POOL` or `worker start --lease POOL`. Never pick a port from a pool by hand.';
  for (const file of ['kit/skills/herdr-orchestrator/SKILL.md', 'docs/user-guide.md']) assert.ok(fs.readFileSync(path.resolve(file), 'utf8').includes(rule), file);
});

test('worker start dry-run names each lease pool and takes no lease', () => {
  const f = setupFixture(null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-lease-'));
  const pools = [{ name: 'serve-ports', items: ['47100'], split: {}, env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: null, graceMinutes: 10 }];
  const output = [];
  startWorker('lease-plan', { kind: 'codex', task: 'x', allow: ['src/'], lease: ['serve-ports'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line), leaseOptions: { dataDir, pools },
  });
  assert.match(output.join('\n'), /Lease one item of pool serve-ports and pass it in the pane environment/);
  assert.equal(fs.existsSync(path.join(dataDir, 'leases.json')), false);
  assert.throws(() => startWorker('lease-unknown', { kind: 'codex', task: 'x', allow: ['src/'], lease: ['gpu'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {}, leaseOptions: { dataDir, pools },
  }), /Unknown resource pool gpu/);
});

test('worker start warns when a Codex brief mentions browser work', async () => {
  const { codexBrowserWarning } = await import('../src/kit/workers.js');
  assert.match(codexBrowserWarning('codex', 'Capture a screenshot with Playwright.'), /Codex cannot launch Chromium/);
  assert.equal(codexBrowserWarning('claude', 'Capture a screenshot with Playwright.'), null);
  assert.equal(codexBrowserWarning('codex', 'Refactor the lock module.'), null);
});

test('Codex browser warning allows project browser commands and catches other browser tools', async () => {
  const { codexBrowserWarning } = await import('../src/kit/workers.js');
  assert.equal(codexBrowserWarning('codex', 'Use the project browser.'), null);
  assert.equal(codexBrowserWarning('codex', '`herdr-boss browser screenshot demo --tab 1`'), null);
  assert.equal(codexBrowserWarning('codex', 'Use the project browser with `herdr-boss browser tab new demo http://127.0.0.1:4477` and `herdr-boss browser screenshot demo --tab 1`.'), null);
  assert.match(codexBrowserWarning('codex', 'Use the project browser and run Playwright.'), /Codex cannot launch Chromium/);
  assert.match(codexBrowserWarning('codex', 'Use Puppeteer.'), /Codex cannot launch Chromium/);
  assert.match(codexBrowserWarning('codex', 'Use playwright-cli.'), /Codex cannot launch Chromium/);
  assert.match(codexBrowserWarning('codex', 'Update the gallery.'), /Codex cannot launch Chromium/);
  assert.match(codexBrowserWarning('codex', 'Use the screenshot tool.'), /Codex cannot launch Chromium/);
  assert.match(codexBrowserWarning('codex', 'Launch Chromium outside `herdr-boss browser`.'), /Codex cannot launch Chromium/);
});

test('the kit rules name waitingOn, the Mailbox id, and blockedBy', () => {
  const rules = [
    'Set `waitingOn: owner` only for the escalation categories.',
    'Always post a Mailbox item that needs an Owner action, and set `mailboxId` to its id.',
    'Use `blockedBy` for waits on other tasks.',
    'Your orchestrator agent is named `<slug>-orch`. Prompt workers and the Boss by pane ID or by that name.',
  ];
  const text = fs.readFileSync(path.resolve('kit/templates/project-kit.md'), 'utf8');
  for (const rule of rules) assert.ok(text.includes(rule), `kit/templates/project-kit.md: ${rule}`);
});

test('a worker report can carry an optional tool suggestion', () => {
  const base = { issue: null, branch: 'b', worktree: '/w', changedPaths: [], commands: ['npm test: pass'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false };
  const opts = { evidenceTiers: ['unit'] };
  assert.deepEqual(validateWorkerReport(base, opts), []);
  assert.deepEqual(validateWorkerReport({ ...base, toolSuggestion: null }, opts), []);
  assert.deepEqual(validateWorkerReport({ ...base, toolSuggestion: { missing: 'a tab list filter', why: 'many tabs', command: 'herdr-boss browser tabs SLUG --mine' } }, opts), []);
  assert.deepEqual(validateWorkerReport({ ...base, toolSuggestion: 'more tools' }, opts), ['toolSuggestion must be null or an object with missing, why, and command.']);
  assert.deepEqual(validateWorkerReport({ ...base, toolSuggestion: { missing: 'x', why: '' , command: 'y' } }, opts), ['toolSuggestion.why must be a non-empty string.']);
  const kit = fs.readFileSync(path.resolve('kit/templates/project-kit.md'), 'utf8');
  assert.ok(kit.includes('Pass each worker `toolSuggestion` to the Boss in one line.'));
  assert.ok(kit.includes('Keep `herdr-boss browser` a thin helper for visual checks.'));
  const brief = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.ok(brief.includes('"toolSuggestion": null'));
  assert.ok(brief.includes('**Tool suggestion**'));
});

test('project config in a .herdr-wt worker worktree resolves the main checkout project', () => {
  const main = temporaryRepo('herdr-kit-main-');
  // The project file is untracked, as in projects that git-ignore it, so the worktree has no copy.
  fs.writeFileSync(path.join(main, '.herdr-boss.json'), JSON.stringify({ slug: 'tmalpha' }));
  const worktree = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-wt-'))), 'Projects', '.herdr-wt', 'Alpha', 'pm1tube');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 'pm1tube', worktree);
  assert.equal(fs.existsSync(path.join(worktree, '.herdr-boss.json')), false);
  const config = loadProjectConfig({ cwd: worktree });
  assert.equal(config.slug, 'tmalpha');
  assert.equal(config.root, worktree);
  assert.equal(config.mainRoot, main);
  assert.equal(config.repo, path.basename(main));
  assert.equal(config.configPath, path.join(main, '.herdr-boss.json'));
  // Without any project file, the main checkout name is the slug, never the worktree folder name.
  fs.rmSync(path.join(main, '.herdr-boss.json'));
  assert.equal(loadProjectConfig({ cwd: worktree }).slug, path.basename(main).toLowerCase());
  // A worktree with its own tracked file keeps that file.
  fs.writeFileSync(path.join(worktree, '.herdr-boss.json'), JSON.stringify({ slug: 'own' }));
  assert.equal(loadProjectConfig({ cwd: worktree }).slug, 'own');
});

test('a numeric string issue in a worker report is normalized with a warning', async () => {
  const { normalizeWorkerReport } = await import('../src/kit/orchestration.js');
  for (const value of ['204', '#204', ' #204 ']) {
    const { report, warnings } = normalizeWorkerReport({ issue: value, branch: 'b' });
    assert.equal(report.issue, 204);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /read as the number 204\. Write issue as a number\./);
  }
  for (const value of ['0', '-3', 'abc', '20x', '#', '1.5']) {
    const { report, warnings } = normalizeWorkerReport({ issue: value });
    assert.equal(report.issue, value);
    assert.deepEqual(warnings, []);
    assert.ok(validateWorkerReport(report).some((error) => /issue must be null or a positive integer/.test(error)));
  }
  assert.deepEqual(normalizeWorkerReport({ issue: 12 }).warnings, []);
  const brief = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  assert.ok(brief.includes('"issue": 204,'));
});

test('worker start keeps every repeated --allow path in the run record', () => {
  const f = setupFixture(null);
  const result = runKitCommand('worker', ['start', 'three-allow', '--kind', 'pi', '--model', 'opencode-go/space-bunny-free', '--issue', '331', '--task', 'x',
    '--allow', 'src/a.js', '--allow', 'test/a.test.js', '--allow', 'docs/a.md'], {
    config: f.config, herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
  for (const item of ['src/a.js', 'test/a.test.js', 'docs/a.md']) assert.ok(record.allowedPaths.includes(item), `${item} in ${record.allowedPaths.join(', ')}`);
});

test('modelOutcome validation accepts null and valid objects', () => {
  const base = { issue: null, branch: 'b', worktree: '/w', changedPaths: [], commands: ['test'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false };
  assert.deepEqual(validateWorkerReport({ ...base, modelOutcome: null }, { evidenceTiers: ['unit'] }), []);
  const valid = { kind: 'pi', model: 'opencode-go/space-bunny-free', result: 'first-time', reason: 'clean run' };
  assert.deepEqual(validateWorkerReport({ ...base, modelOutcome: valid }, { evidenceTiers: ['unit'] }), []);
  for (const result of ['rework', 'failed']) {
    const outcome = { ...valid, result };
    assert.deepEqual(validateWorkerReport({ ...base, modelOutcome: outcome }, { evidenceTiers: ['unit'] }), []);
  }
  // Invalid: missing fields
  assert.ok(validateWorkerReport({ ...base, modelOutcome: { kind: 'pi', model: 'm', result: 'first-time' } }, { evidenceTiers: ['unit'] }).some((e) => e.includes('reason')));
  // Invalid: bad result value
  assert.ok(validateWorkerReport({ ...base, modelOutcome: { kind: 'pi', model: 'm', result: 'unknown', reason: 'r' } }, { evidenceTiers: ['unit'] }).some((e) => e.includes('result')));
  // Invalid: reason too long
  assert.ok(validateWorkerReport({ ...base, modelOutcome: { kind: 'pi', model: 'm', result: 'first-time', reason: 'x'.repeat(201) } }, { evidenceTiers: ['unit'] }).some((e) => e.includes('reason')));
});

test('worker collect --record derives model outcome defaults', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('model-default', { kind: 'pi', model: 'opencode-go/space-bunny-free', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const usageEvents = [];
  collectWorker('model-default', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: (event) => { usageEvents.push(event); return { errors: [], duplicate: false }; },
  });
  const ledger = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
  assert.equal(ledger[0].modelOutcome.result, 'first-time');
  assert.equal(usageEvents[0].modelOutcome.result, 'first-time');
  try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('worker collect --record orchestrator overrides report model outcome', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('model-override', { kind: 'pi', model: 'opencode-go/space-bunny-free', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
    modelOutcome: { kind: 'pi', model: 'opencode-go/space-bunny-free', result: 'first-time', reason: 'clean' },
  }));
  const usageEvents = [];
  collectWorker('model-override', { record: true, outcome: 'done', gatePassed: true, modelResult: 'rework', modelReason: 'needed fixes' }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: (event) => { usageEvents.push(event); return { errors: [], duplicate: false }; },
  });
  const ledger = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
  assert.equal(ledger[0].modelOutcome.result, 'rework');
  assert.equal(ledger[0].modelOutcome.reason, 'needed fixes');
  assert.equal(usageEvents[0].modelOutcome.result, 'rework');
  try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('worker collect --record derives failed model outcome from gate failure', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('model-failed', { kind: 'pi', model: 'opencode-go/space-bunny-free', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const usageEvents = [];
  collectWorker('model-failed', { record: true, outcome: 'done', gateFailed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: (event) => { usageEvents.push(event); return { errors: [], duplicate: false }; },
  });
  const ledger = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
  assert.equal(ledger[0].modelOutcome.result, 'failed');
  assert.equal(usageEvents[0].modelOutcome.result, 'failed');
  try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('worker collect --record derives rework model outcome from rework count', () => {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker('model-rework', { kind: 'pi', model: 'opencode-go/space-bunny-free', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`],
    commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const usageEvents = [];
  collectWorker('model-rework', { record: true, outcome: 'done', gatePassed: true, rework: 2 }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: (event) => { usageEvents.push(event); return { errors: [], duplicate: false }; },
  });
  const ledger = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers });
  assert.equal(ledger[0].modelOutcome.result, 'rework');
  assert.equal(usageEvents[0].modelOutcome.result, 'rework');
  try { git(f.root, 'worktree', 'remove', '--force', run.worktree); } catch {}
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('model scorecard computes runs, first-time, rework, failed, rework rate, and median duration', async () => {
  const { buildModelScorecard } = await import('../src/engine.js');
  const now = Date.parse('2026-09-28T12:00:00Z');
  const events = [
    { kind: 'pi', model: 'opencode-go/space-bunny-free', startedAt: '2026-09-27T10:00:00Z', endedAt: '2026-09-27T10:30:00Z', modelOutcome: { result: 'first-time' } },
    { kind: 'pi', model: 'opencode-go/space-bunny-free', startedAt: '2026-09-26T10:00:00Z', endedAt: '2026-09-26T10:45:00Z', modelOutcome: { result: 'rework' } },
    { kind: 'pi', model: 'opencode-go/space-bunny-free', startedAt: '2026-09-25T10:00:00Z', endedAt: '2026-09-25T10:15:00Z', modelOutcome: { result: 'failed' } },
    { kind: 'codex', model: 'gpt-6-luna', startedAt: '2026-09-27T11:00:00Z', endedAt: '2026-09-27T11:20:00Z', modelOutcome: { result: 'first-time' } },
    { kind: 'codex', model: 'gpt-6-luna', startedAt: '2026-09-26T11:00:00Z', endedAt: '2026-09-26T11:10:00Z', modelOutcome: { result: 'first-time' } },
  ];
  const rows = buildModelScorecard(events, now);
  assert.equal(rows.length, 2);
  // Sorted by runs: pi has 3 runs, codex has 2
  assert.equal(rows[0].kind, 'pi');
  assert.equal(rows[0].model, 'opencode-go/space-bunny-free');
  assert.equal(rows[0].runs, 3);
  assert.equal(rows[0].firstTime, 1);
  assert.equal(rows[0].rework, 1);
  assert.equal(rows[0].failed, 1);
  assert.ok(Math.abs(rows[0].reworkRate - 2 / 3) < 0.001);
  // Median of [15, 30, 45] = 30
  assert.equal(rows[0].medianMinutes, 30);
  assert.equal(rows[1].kind, 'codex');
  assert.equal(rows[1].model, 'gpt-6-luna');
  assert.equal(rows[1].runs, 2);
  assert.equal(rows[1].firstTime, 2);
  assert.equal(rows[1].rework, 0);
  assert.equal(rows[1].failed, 0);
  assert.equal(rows[1].reworkRate, 0);
  // Median of [10, 20] = 15
  assert.equal(rows[1].medianMinutes, 15);
});

test('Analytics page includes the Model scorecard table', async () => {
  const fs = await import('fs');
  const appJs = fs.readFileSync('public/app.js', 'utf8');
  assert.ok(appJs.includes('Model scorecard'));
  assert.ok(appJs.includes('modelScorecard'));
  assert.ok(appJs.includes('Rework rate'));
  assert.ok(appJs.includes('Median time'));
});

test('project kit includes the model outcome rule', async () => {
  const fs = await import('fs');
  const kit = fs.readFileSync('kit/templates/project-kit.md', 'utf8');
  assert.ok(kit.includes('worker collect --record --model-result'));
  assert.ok(kit.includes('--model-reason'));
});

test('worker collect --record with --model-result writes the ledger and a valid usage record end to end', () => {
  const f = setupFixture(null);
  const model = 'gpt-6-luna';
  fs.writeFileSync(f.rulesFile, JSON.stringify({ policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { [model]: 'codex' } } }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const name = 'collect-model-result';
  const run = startWorker(name, { kind: 'codex', model, task: 'x', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${name}.json`], commands: ['focused check'],
    evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const usage = [];
  // The real usage validator runs on the record, so a helper that only this flag path uses cannot be missing.
  collectWorker(name, { record: true, outcome: 'done', gatePassed: true, modelResult: 'first-time', modelReason: 'right the first time' }, {
    config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: () => {}, listWorktreeProcesses: () => [],
    recordUsageFn: (event) => { const errors = validateUsage(event); usage.push({ event, errors }); return { errors, duplicate: false }; },
  });
  assert.deepEqual(usage[0].errors, []);
  assert.deepEqual(usage[0].event.modelOutcome, { kind: 'codex', model, result: 'first-time', reason: 'right the first time' });
  const ledger = fs.readFileSync(f.config.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].modelOutcome.result, 'first-time');
});

test('worker collect accepts a folder entry with a trailing slash inside the allowed paths, and still refuses a real omission', () => {
  const setup = (name, changedPaths, extraFile = null) => {
    const f = setupFixture(null);
    fs.writeFileSync(f.rulesFile, JSON.stringify({ policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { 'gpt-6-luna': 'codex' } } }));
    git(f.root, 'add', '-A');
    git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
    const run = startWorker(name, { kind: 'codex', model: 'gpt-6-luna', task: 'x', allow: ['docs/', '.orchestration/runs/'], noWorktree: true }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    });
    fs.mkdirSync(path.join(run.worktree, 'docs', 'shots'), { recursive: true });
    for (const file of ['a.png', 'b.png']) fs.writeFileSync(path.join(run.worktree, 'docs', 'shots', file), file);
    if (extraFile) fs.writeFileSync(path.join(run.worktree, extraFile), 'x');
    git(run.worktree, 'add', '-A');
    git(run.worktree, 'commit', '-m', 'worker change');
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: null, branch: run.branch, worktree: run.worktree, changedPaths, commands: ['focused check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
    }));
    return () => collectWorker(name, { record: true, outcome: 'done', gatePassed: true }, {
      config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: () => {}, listWorktreeProcesses: () => [],
      recordUsageFn: () => ({ errors: [], duplicate: false }),
    });
  };
  const runs = (name) => `.orchestration/runs/${name}.json`;
  // The folder entry covers both screenshots.
  assert.doesNotThrow(setup('folder-ok', ['docs/shots/', runs('folder-ok')]));
  // A file outside the folder that the report does not name is still an omission.
  assert.throws(setup('folder-omit', ['docs/shots/', runs('folder-omit')], 'docs/notes.md'), /omitted changed paths from its report: docs\/notes\.md/);
  // A folder entry without the trailing slash covers nothing.
  assert.throws(setup('folder-noslash', ['docs/shots', runs('folder-noslash')]), /omitted changed paths/);
});
