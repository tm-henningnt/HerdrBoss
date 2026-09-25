import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig, PROJECT_DEFAULTS } from '../src/kit/config.js';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, readDelegatedRuns, validateAllowedPaths, validateDelegatedRun, validateWorkerReport } from '../src/kit/orchestration.js';
import { buildGhArgs } from '../src/kit/gh.js';
import { collectWorker, parseWorktreeCwdProcesses, renderBrief, startWorker } from '../src/kit/workers.js';
import { classifyWorktrees, pruneWorktrees } from '../src/kit/worktrees.js';
import { usageProvider } from '../src/usage.js';

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

test('worker process check finds only cwd paths inside the exact worktree', () => {
  const worktree = path.resolve('/tmp/worker-tree');
  const output = [
    'p101', 'cnode', `n${worktree}/test/server.test.js`,
    'p102', 'cnpm', `n${worktree}-other`,
    'p103', 'czsh', `n${worktree}`,
  ].join('\n');
  assert.deepEqual(parseWorktreeCwdProcesses(output, worktree), [
    { pid: 101, command: 'node', cwd: `${worktree}/test/server.test.js` },
    { pid: 103, command: 'zsh', cwd: worktree },
  ]);
});

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
  assert.match(output.join('\n'), /Read \.worker\/brief\.md in your working directory and execute it/);
  assert.ok(calls.some((call) => call.join(' ') === 'agent list'));
  assert.ok(!fs.existsSync(config.worktreePath('demo')));
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
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Report target: ws:orch');
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
    const before = new Set(fs.readdirSync(path.dirname(f.root)));
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
    assert.deepEqual(new Set(fs.readdirSync(path.dirname(f.root))), before);
  }
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
    const collect = () => collectWorker(name, { record: true, outcome: 'done', gatePassed: true }, {
      config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: () => {},
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
  }
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

test('worker start waits for a ready shell and retries agent_pane_busy once', () => {
  const root = temporaryRepo();
  const template = path.join(root, 'brief-template.md');
  fs.writeFileSync(template, 'Worker {{name}}: {{task}}');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const calls = [];
  let paneReads = 0;
  let starts = 0;
  let prompts = 0;
  let waits = 0;
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') {
      if (args[2] === 'ws:orch') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
      paneReads++;
      return { pane: { pane_id: 'ws:p2', workspace_id: 'ws', foreground_cwd: paneReads < 2 ? '/tmp/starting' : config.worktreePath('demo') } };
    }
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'agent' && args[1] === 'start') { starts++; if (starts === 1) throw new Error('agent_pane_busy'); return {}; }
    if (args[0] === 'agent' && args[1] === 'prompt') { prompts++; return {}; }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, wait: () => { waits++; },
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  });
  assert.equal(result.pane, 'ws:p2');
  assert.equal(starts, 2);
  assert.equal(prompts, 1);
  assert.ok(waits >= 2);
  assert.ok(paneReads >= 2);
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
  let paneClosed = false;
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') return { pane: { pane_id: 'ws:p2' } };
    if (args[0] === 'pane' && args[1] === 'close') { paneClosed = true; return {}; }
    if (args[0] === 'agent' && args[1] === 'start') { starts++; throw new Error('agent_pane_busy'); }
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  assert.throws(() => startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config, models: loadModels(), herdr, wait: () => {},
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, rulesFile,
  }), /agent_pane_busy/);
  assert.equal(starts, 2);
  assert.equal(paneClosed, true);
  assert.equal(fs.existsSync(config.worktreePath('demo')), false);
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
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: config.worktreePath('demo') } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
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
  const { describeMachine, loadWarning } = await import('../src/kit/workers.js');
  assert.equal(loadWarning({ machine: { owner: 'present', cpuPercent: 12, cpuLimit: 70, fiveMinute: 12, loadLimit: 20 } }), null);
  assert.equal(loadWarning({}), null);
  const text = loadWarning({ machine: { owner: 'away', cpuPercent: 98, cpuLimit: 95, fiveMinute: 84.2, loadLimit: null } });
  assert.match(describeMachine({ machine: { owner: 'away', cpuPercent: 98, cpuLimit: 95, fiveMinute: 84.2, loadLimit: null } }), /Owner away; CPU 98\.0% \/ limit 95%; 5-minute load 84\.2 \/ backstop disabled/);
  assert.match(text, /CPU 98\.0% \/ limit 95%/);
  assert.match(text, /5-minute load 84\.2 \/ backstop disabled/);
  assert.match(text, /--force cannot bypass/);
  assert.match(loadWarning({ machine: { owner: 'present', cpuLimit: 70, fiveMinute: 25, loadLimit: 24 } }), /CPU unknown/);
});

test('worker start refuses machine limits even with --force', () => {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), machine: { owner: 'present', cpuPercent: 71, cpuLimit: 70, fiveMinute: 1, loadLimit: null } }));
  const output = [];
  assert.throws(() => startWorker('machine-refused', { kind: 'codex', task: 'x', allow: ['src/'], force: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => output.push(line),
  }), /--force cannot bypass this refusal/);
  assert.match(output.join('\n'), /Owner present; CPU 71\.0% \/ limit 70%/);
  assert.ok(!f.calls.includes('agent start'));
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
  assert.match(output, /codex open/);
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
  let paneCwd = root;
  const herdr = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pane' && args[1] === 'get') return args[2] === 'ws:orch'
      ? { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }
      : { pane: { pane_id: args[2], workspace_id: 'ws', foreground_cwd: paneCwd } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
    if (args[0] === 'pane' && args[1] === 'split') { paneCwd = args[args.indexOf('--cwd') + 1]; return { pane: { pane_id: 'ws:p2' } }; }
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

test('worker start puts the project thread limit flag in the brief', () => {
  const f = setupFixture(null);
  const cfgFile = path.join(f.root, '.herdr-boss.json');
  const template = path.join(f.root, 'brief-template.md');
  fs.writeFileSync(template, 'Limit: {{threadLimit}}');
  fs.writeFileSync(cfgFile, JSON.stringify({ briefTemplate: template, testThreadsFlag: '--poolOptions.forks.maxForks=2' }));
  const config = loadProjectConfig({ cwd: f.root });
  const result = startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, { config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} });
  assert.equal(fs.readFileSync(path.join(result.worktree, '.worker', 'brief.md'), 'utf8'), 'Limit: Add `--poolOptions.forks.maxForks=2` to each test runner command.');
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
    config: f.config, output: () => {}, recordUsageFn: () => ({ errors: [], duplicate: false }),
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
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    lanes: {
      codex: { state: 'pace', window: 'Weekly', usedPercent: 60, expectedPercent: 50, overPercent: 10, backOnPaceAt: new Date(Date.now() + 3600000).toISOString() },
      unmetered: { state: 'open', unmetered: true, byProject: { herdrboss: { opencode: ['opencode/space-bunny-free'] } } },
    },
    leastOverProvider: null,
  }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
  const output = execFileSync(process.execPath, [cli, 'lanes'], { env: { ...process.env, HOME: home, HERDR_BOSS_DIR: dir }, encoding: 'utf8' });
  assert.match(output, /codex ahead of pace/);
  assert.match(output, /unmetered open: herdrboss: opencode \(opencode\/space-bunny-free\)/);
});
