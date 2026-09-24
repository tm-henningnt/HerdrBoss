import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig, PROJECT_DEFAULTS } from '../src/kit/config.js';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, readDelegatedRuns, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from '../src/kit/orchestration.js';
import { buildGhArgs } from '../src/kit/gh.js';
import { renderBrief, startWorker } from '../src/kit/workers.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';

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

test('project config finds the git root and applies contract defaults', () => {
  const root = temporaryRepo();
  fs.mkdirSync(path.join(root, 'nested'));
  const config = loadProjectConfig({ cwd: path.join(root, 'nested') });
  assert.equal(config.root, root);
  assert.equal(config.slug, path.basename(root).toLowerCase());
  for (const [key, value] of Object.entries(PROJECT_DEFAULTS)) assert.deepEqual(config[key], value);
  assert.equal(config.worktreePath('worker'), path.join(path.dirname(root), `${path.basename(root)}-wt-worker`));
});

test('project config reads overrides and rejects malformed allowedModels', () => {
  const root = temporaryRepo();
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'example', baseBranch: 'trunk', allowedModels: ['gpt-6-luna'] }));
  const config = loadProjectConfig({ cwd: root });
  assert.equal(config.slug, 'example');
  assert.equal(config.baseBranch, 'trunk');
  assert.deepEqual(config.allowedModels, ['gpt-6-luna']);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ allowedModels: 'gpt-6-luna' }));
  assert.throws(() => loadProjectConfig({ cwd: root }), /allowedModels must be null or an array/);
});

test('brief rendering fills known slots and rejects an unknown slot', () => {
  assert.equal(renderBrief('Worker {{name}} in {{project}}: {{task}} / {{allowedPaths}}', {
    name: 'demo', project: 'sample', task: 'do the work', allowedPaths: ['src/', 'test/'],
  }), 'Worker demo in sample: do the work / - src/\n- test/');
  assert.equal(renderBrief('Issue {{issue}}', {}), 'Issue (none)');
  assert.throws(() => renderBrief('Bad {{notAContractSlot}}', {}), /Unknown brief template slot/);
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

test('worker start dry-run prints the plan and makes no worktree or agent changes', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}} {{allowedPaths}}');
  const configFile = path.join(root, '.herdr-boss.json');
  fs.writeFileSync(configFile, JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: '2026-09-24T12:00:00.000Z', avoidKinds: [], preferredKinds: ['codex'], memFreePercent: 50, notes: [] }));
  const models = loadModels();
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
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
  assert.match(output.join('\n'), /herdr pane split ws:p1 --direction right --cwd/);
  assert.match(output.join('\n'), /Read \.worker\/brief\.md in your working directory and execute it/);
  assert.ok(calls.some((call) => call.join(' ') === 'agent list'));
  assert.ok(!fs.existsSync(config.worktreePath('demo')));
  assert.ok(!fs.existsSync(path.join(config.runsPath, 'demo.json')));
  assert.deepEqual(git(root, 'branch', '--show-current'), 'main');
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
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
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
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Worker demo: x');
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
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'prompt') throw new Error('agent_prompt_stalled');
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: status } };
    if (args[0] === 'agent' && args[1] === 'send-keys') { assert.deepEqual(args.slice(2), ['demo', 'enter']); status = 'working'; return {}; }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('demo', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: (line) => output.push(line),
    readText: () => '❯ Read .worker/brief.md in your working directory and execute it.', wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(calls.filter((call) => call === 'agent prompt').length, 1);
  assert.ok(calls.includes('agent send-keys'));
  assert.ok(output.some((line) => line.startsWith('Sent Enter to demo')));
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
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') return {};
    if (args[0] === 'agent' && args[1] === 'prompt') { prompts++; if (prompts === 1) throw new Error('agent_prompt_stalled'); return {}; }
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { agent_status: 'idle' } };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const output = [];
  startWorker('demo', { kind: 'claude', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, output: (line) => output.push(line), readText: () => '❯ ', wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(prompts, 2);
  assert.ok(output.some((line) => line.startsWith('Resent the brief prompt to demo')));
});

test('worker start load warning names the load, the limit, and the actions', async () => {
  const { loadWarning } = await import('../src/kit/workers.js');
  assert.equal(loadWarning({ load: { fiveMinute: 12, cpus: 10, limit: 20 } }), null);
  assert.equal(loadWarning({}), null);
  const text = loadWarning({ load: { fiveMinute: 84.2, cpus: 10, limit: 20 } });
  assert.match(text, /5-minute load is 84\.2 on 10 cores; the limit is 20/);
  assert.match(text, /--maxWorkers=2/);
  assert.match(text, /full test suite/);
});

function setupFixture(setup) {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template, setup }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'pane' && args[1] === 'close') return {};
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
