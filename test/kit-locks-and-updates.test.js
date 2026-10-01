import './helpers/test-env.js';
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

test('the review pack section sits in the orchestrator skill and the worker brief template', () => {
  const skill = fs.readFileSync(path.resolve('kit/skills/herdr-orchestrator/SKILL.md'), 'utf8');
  const section = skill.slice(skill.indexOf('### Review packs'), skill.indexOf('## Resume from an unknown state'));
  assert.ok(skill.indexOf('### Human gates and parking') < skill.indexOf('### Review packs'));
  assert.ok(skill.indexOf('### Review packs') > 0 && skill.indexOf('### Review packs') < skill.indexOf('## Resume from an unknown state'));
  assert.match(section, /herdr-boss review publish <slug> <folder>/);
  assert.match(section, /herdr-boss review import <slug> <folder>/);
  assert.match(section, /herdr-boss review result <slug> <pack> --json/);
  assert.match(section, /Do not make a pack for a question that one Mailbox line answers\./);
  for (const rule of [
    'Run interaction checks yourself. Include before and after screenshots as evidence.',
    'Give each item a two-line description (what and why), exact steps, expected result, and app/sheet link.',
    'Send only items needing a human decision to the Owner: taste, business meaning, or a final call.',
    'Put one shared-space test app per scenario, named after its item.',
    'Before shipping, get an independent reviewer to run a design pass:',
  ]) assert.ok(section.includes(rule), rule);

  const template = fs.readFileSync(path.resolve('kit/templates/worker-brief.md'), 'utf8');
  const pack = template.slice(template.indexOf('## Review pack'), template.indexOf('## Gates on a shared machine'));
  assert.ok(template.indexOf('## Image budget') < template.indexOf('## Review pack'));
  assert.ok(template.indexOf('## Review pack') > 0 && template.indexOf('## Review pack') < template.indexOf('## Gates on a shared machine'));
  assert.match(pack, /write it to `\.worker\/review-pack\/`\. Do not publish it\./);
  assert.match(pack, /herdr-boss review check \.worker\/review-pack/);
  // The section has no slot, so the rendered brief keeps it.
  const rendered = renderBrief('## Review pack\n\nCheck the folder with `herdr-boss review check .worker/review-pack`.\n', {});
  assert.match(rendered, /## Review pack/);

  // Every command in the two sections is a command of the CLI help.
  const help = fs.readFileSync(path.resolve('src/cli.js'), 'utf8');
  for (const usage of ['review check FOLDER', 'review publish SLUG FOLDER', 'review import SLUG FOLDER-OR-FILE', 'review result [SLUG] PACK']) {
    assert.ok(help.includes(usage), usage);
  }
});

test('the orchestrator skill stays short and links each reference file', () => {
  const dir = path.resolve('kit/skills/herdr-orchestrator');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const words = skill.split(/\s+/).filter(Boolean).length;
  // The upper bound grew with the review pack section. The skill keeps its length limit.
  assert.ok(words >= 2300 && words <= 3000, `SKILL.md has ${words} words`);
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

test('browser guidance keeps credentials out of every output mode', () => {
  for (const file of ['docs/cli.md', 'kit/browser-service.md']) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    assert.match(text, /--full[^\n]*hosts/);
    assert.match(text, /query strings and fragments/);
    assert.match(text, /Bearer/);
    assert.match(text, /JWT/);
    assert.match(text, /<redacted>/);
  }
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  assert.match(app.slice(app.indexOf("browsers: ['Browsers'")), /query strings and fragments/);
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
    'Put task inputs in `.orchestration/state/inputs/<worker name>/`; worker start copies them into the worktree.',
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
  const none = normalizeWorkerReport({ issue: 'none' });
  assert.equal(none.report.issue, null);
  assert.match(none.warnings[0], /issue is the string "none"; it is read as null/);
  assert.deepEqual(validateWorkerReport({ ...validReport, issue: none.report.issue }, { evidenceTiers: ['unit'] }), []);
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
  assert.ok(kit.includes('worker collect --model-result'));
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

test('worker collect accepts folder entries and records the branch diff when report paths are omitted', (t) => {
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
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const output = [];
    const collect = () => collectWorker(name, { record: true, outcome: 'done', gatePassed: true }, {
      config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: (line) => output.push(line), listWorktreeProcesses: () => [],
      recordUsageFn: () => ({ errors: [], duplicate: false }),
    });
    return { collect, output, f };
  };
  const runs = (name) => `.orchestration/runs/${name}.json`;
  // The folder entry covers both screenshots.
  const folder = setup('folder-ok', ['docs/shots/', runs('folder-ok')]);
  assert.doesNotThrow(folder.collect);
  // The Git diff supplies paths that the report omits outside its folder entry.
  const omitted = setup('folder-omit', ['docs/shots/', runs('folder-omit')], 'docs/notes.md');
  const omittedSummary = omitted.collect();
  assert.ok(omitted.output.includes('report.json omits 1 changed path(s); recorded the diff paths'));
  assert.deepEqual(JSON.parse(fs.readFileSync(omitted.f.config.ledgerPath, 'utf8').trim()).changedPaths, omittedSummary.actualPaths);
  // A folder entry without the trailing slash covers neither screenshot.
  const noSlash = setup('folder-noslash', ['docs/shots', runs('folder-noslash')]);
  const noSlashSummary = noSlash.collect();
  assert.ok(noSlash.output.includes('report.json omits 2 changed path(s); recorded the diff paths'));
  assert.deepEqual(JSON.parse(fs.readFileSync(noSlash.f.config.ledgerPath, 'utf8').trim()).changedPaths, noSlashSummary.actualPaths);
});

// A real git repository with its own HOME, so the Claude settings file stays in a temporary folder.
function kitUpdateRepo(t) {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-update-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', path.join(dir, 'repo')]);
  const root = path.join(dir, 'repo');
  return {
    root,
    run: (args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: path.join(dir, 'boss'), TMPDIR: dir },
    }),
    lines: (result) => result.stdout.split('\n').filter(Boolean),
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
  };
}

test('the kit update digest names the impact and the summary of every change', () => {
  const changes = [
    { revision: '111111111111', impact: 'required', summary: 'Change the kit file.' },
    { revision: '222222222222', impact: 'none', summary: 'Fix a spelling.' },
  ];
  assert.deepEqual(formatKitDigest('000000000000', changes), [
    'kit update: 2 kit change(s) since installed revision 000000000000',
    '  required: Change the kit file. (111111111111)',
    '  none: Fix a spelling. (222222222222)',
  ]);
  // An unknown installed revision shows every known change.
  assert.deepEqual(formatKitDigest(null, changes), [
    'kit update: installed kit revision is unknown; showing all 2 known change(s)',
    '  required: Change the kit file. (111111111111)',
    '  none: Fix a spelling. (222222222222)',
  ]);
  // No change gives one line in each case.
  assert.deepEqual(formatKitDigest('000000000000', []), ['kit update: installed kit revision 000000000000 is current (no recorded change)']);
  assert.deepEqual(formatKitDigest(null, []), ['kit update: no installed kit revision found (no recorded change)']);
  // An entry without a summary names its revision.
  assert.deepEqual(formatKitDigest('000000000000', [{ revision: '333333333333', impact: 'useful', summary: null }]), [
    'kit update: 1 kit change(s) since installed revision 000000000000',
    '  useful: 333333333333 (333333333333)',
  ]);
});

test('kit update prints the digest before it installs the kit', (t) => {
  const r = kitUpdateRepo(t);
  const result = r.run(['kit', 'update']);
  assert.equal(result.status, 0, result.stderr);
  const lines = r.lines(result);
  // Nothing is installed yet, so the digest lists every known change.
  const changes = kitChangesSince(null);
  assert.equal(lines[0], `kit update: installed kit revision is unknown; showing all ${changes.length} known change(s)`);
  assert.deepEqual(lines.slice(1, 1 + changes.length), changes.map((change) => `  ${change.impact}: ${change.summary} (${change.revision})`));
  const digestEnd = changes.length;
  const wrote = lines.slice(digestEnd).filter((line) => line.startsWith('wrote ') || line.startsWith('unchanged '));
  assert.ok(wrote.length, 'the update installs the kit');
  assert.match(lines.at(-1), new RegExp(`^kit update: kit revision ${kitRevision()}, stub [0-9a-f]{12}, in ${r.root}$`));
  // The digest comes before every install line.
  assert.ok(lines.indexOf(lines.at(-1)) > lines.indexOf('wrote AGENTS.md'), 'the summary is last');
  // The installed kit file now carries the current revision.
  assert.equal(r.read('docs/orchestration/herdr-boss.md').split('\n')[0], `<!-- herdr-boss kit v=${kitRevision()} -->`);
});

test('kit update --quiet keeps the digest and hides the per-file lines', (t) => {
  const r = kitUpdateRepo(t);
  const first = r.run(['kit', 'update', '--quiet']);
  assert.equal(first.status, 0, first.stderr);
  const lines = r.lines(first);
  assert.equal(lines.filter((line) => /^(wrote|unchanged) /.test(line)).length, 0);
  assert.match(lines[0], /^kit update: /);
  assert.match(lines.at(-1), /^kit update: kit revision [0-9a-f]{12}, stub [0-9a-f]{12}, in /);
  // The install still happened, so a later update has nothing to write.
  const second = r.run(['kit', 'update', '--quiet']);
  assert.equal(second.status, 0, second.stderr);
  const again = r.lines(second);
  assert.equal(again.filter((line) => /^(wrote|unchanged) /.test(line)).length, 0);
  assert.deepEqual(again, [], 'a current project gets no output');
  assert.equal(second.stderr, '');
});

test('kit install and kit update write a file only when its content changes and leave a current project untouched', (t) => {
  const r = kitUpdateRepo(t);
  assert.equal(r.run(['kit', 'update', '--quiet']).status, 0);
  const files = ['docs/orchestration/herdr-boss.md', 'AGENTS.md', '.claude/settings.json'];
  const stamp = () => files.map((file) => fs.statSync(path.join(r.root, file)).mtimeMs);
  const before = stamp();
  const bytes = files.map((file) => r.read(file));
  const install = r.run(['kit', 'install']);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(r.lines(install).filter((line) => line.startsWith('wrote ')).length, 0, 'a current project has nothing to write');
  assert.equal(r.run(['kit', 'update', '--quiet']).stdout, '');
  assert.deepEqual(stamp(), before, 'no file is written again');
  assert.deepEqual(files.map((file) => r.read(file)), bytes);
  // A changed kit file is written again, and the quiet update reports it.
  fs.writeFileSync(path.join(r.root, 'docs/orchestration/herdr-boss.md'), '<!-- herdr-boss kit v=000000000000 -->\nold body\n');
  const changed = r.lines(r.run(['kit', 'update', '--quiet']));
  assert.ok(changed.length >= 2 && changed[0].startsWith('kit update: '), 'a changed kit prints the digest and the summary');
  assert.equal(r.read('docs/orchestration/herdr-boss.md'), bytes[0]);
});

test('kit update without --quiet prints the current kit file after the install lines', (t) => {
  const r = kitUpdateRepo(t);
  const lines = r.lines(r.run(['kit', 'update']));
  const kitLines = r.read('docs/orchestration/herdr-boss.md').split('\n').filter(Boolean);
  const start = lines.indexOf(kitLines[0]);
  assert.ok(start > lines.indexOf('wrote AGENTS.md'), 'the kit file follows the install lines');
  assert.deepEqual(lines.slice(start, start + kitLines.length), kitLines);
  assert.match(lines.at(-1), /^kit update: kit revision [0-9a-f]{12}, stub [0-9a-f]{12}, in /);
  // A current project still gets the kit file, so a stale loaded copy can be replaced.
  const again = r.lines(r.run(['kit', 'update']));
  assert.ok(again.includes(kitLines[0]));
});

test('kit update always installs, also when the change log has no change after the installed revision', (t) => {
  const r = kitUpdateRepo(t);
  assert.equal(r.run(['kit', 'update', '--quiet']).status, 0);
  // The installed kit file now carries the current revision, so the change log has nothing after it.
  const changes = kitChangesSince(kitRevision());
  assert.equal(r.read('docs/orchestration/herdr-boss.md').split('\n')[0], `<!-- herdr-boss kit v=${kitRevision()} -->`);
  // Delete one installed file. An update with no change must still write it.
  fs.rmSync(path.join(r.root, 'AGENTS.md'));
  const result = r.run(['kit', 'update']);
  assert.equal(result.status, 0, result.stderr);
  const lines = r.lines(result);
  assert.equal(lines[0], changes.length
    ? `kit update: ${changes.length} kit change(s) since installed revision ${kitRevision()}`
    : `kit update: installed kit revision ${kitRevision()} is current (no recorded change)`);
  assert.ok(lines.includes('wrote AGENTS.md'), 'an update with no change still installs');
  assert.match(lines.at(-1), new RegExp(`^kit update: kit revision ${kitRevision()}, stub [0-9a-f]{12}, in `));
  // A kit file with a revision that the change log does not know lists every known change.
  fs.writeFileSync(path.join(r.root, 'docs/orchestration/herdr-boss.md'), '<!-- herdr-boss kit v=000000000000 -->\nold body\n');
  const unknown = r.lines(r.run(['kit', 'update', '--quiet']));
  assert.deepEqual(unknown, formatKitDigest('000000000000', kitChangesSince('000000000000')).concat([unknown.at(-1)]));
});

test('kit update rejects an unknown or repeated option', (t) => {
  const r = kitUpdateRepo(t);
  for (const args of [['update', '--bogus'], ['update', '--quiet', '--quiet'], ['update', 'extra']]) {
    const result = r.run(['kit', ...args]);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /Usage: kit install \[--no-hook\] \| kit update \[--quiet\] \| kit block/);
  }
  // A rejected update writes nothing.
  assert.equal(fs.existsSync(path.join(r.root, 'AGENTS.md')), false);
});

test('worker start saves the task id in the run record, accepts the issue alias, and warns when a task is missing', () => {
  const f = setupFixture(null);
  const lines = [];
  const start = (name, options) => startWorker(name, { kind: 'codex', task: 'x', allow: ['src/'], noWorktree: true, ...options }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => lines.push(line),
  });
  const withTask = start('by-task', { taskId: 'B1a' });
  assert.equal(JSON.parse(fs.readFileSync(withTask.recordFile, 'utf8')).taskId, 'B1a');
  assert.equal(lines.filter((line) => /No --task-id/.test(line)).length, 0);
  const withIssue = start('by-issue', { issue: '7' });
  const issueRecord = JSON.parse(fs.readFileSync(withIssue.recordFile, 'utf8'));
  assert.equal(issueRecord.issue, 7);
  assert.equal(issueRecord.taskId, undefined);
  assert.equal(lines.filter((line) => /No --task-id/.test(line)).length, 0);
  const without = start('no-task', {});
  assert.ok(fs.existsSync(without.recordFile), 'a missing task id warns and does not fail');
  assert.equal(lines.filter((line) => /No --task-id/.test(line)).length, 1);
  assert.throws(() => start('bad-task', { taskId: 'bad id!' }), /--task-id must be a task id/);
  assert.throws(() => start('both-task', { taskId: 'A', issue: '7' }), /not both/);
});

test('worker collect records by default and the task facts follow the merge', () => {
  const f = setupFixture(null);
  const run = startWorker('task-mark', { kind: 'codex', task: 'x', allow: ['src/'], taskId: 'T1' }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
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
  const phase = () => readWorkerFacts(f.config.runsPath, { isLive: () => true, isMerged: gitIsMerged(f.root) })[0].phase;
  assert.equal(phase(), 'live');
  collectWorker('task-mark', { outcome: 'done', gatePassed: true }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }),
  });
  const record = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.match(record.collectedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(record.finishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(phase(), 'review');
  git(f.root, 'merge', '--ff-only', run.branch);
  assert.equal(phase(), 'merged');
});

test('worker collect closes each recorded outcome while --no-record changes nothing', () => {
  const scenarios = [
    { name: 'peek-early', report: { stoppedEarly: true }, options: { noRecord: true }, marked: false },
    { name: 'peek-done', report: { stoppedEarly: false }, options: { noRecord: true }, marked: false },
    { name: 'rec-failed', report: { stoppedEarly: false }, options: { outcome: 'failed', gateFailed: true }, marked: true },
    { name: 'rec-partial', report: { stoppedEarly: true }, options: { outcome: 'partial', gateFailed: true }, marked: true },
    { name: 'rec-done', report: { stoppedEarly: false }, options: { record: true, outcome: 'done', gatePassed: true }, marked: true },
  ];
  for (const scenario of scenarios) {
    const f = setupFixture(null);
    const run = startWorker(scenario.name, { kind: 'codex', task: 'x', allow: ['src/'], taskId: 'T1' }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    });
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Report.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [], commands: ['focused check'],
      evidenceTier: ['unit'], unverified: [], modelOutcome: null, ...scenario.report,
    }));
    const before = fs.readFileSync(run.recordFile, 'utf8');
    collectWorker(scenario.name, scenario.options, { config: f.config, output: () => {}, listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [] }) });
    const after = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
    assert.equal(Boolean(after.collectedAt), scenario.marked, scenario.name);
    assert.equal(Boolean(after.finishedAt), scenario.marked, `${scenario.name}: finishedAt`);
    if (scenario.options.noRecord) assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before, `${scenario.name}: the record is unchanged`);
  }
});

test('the kit texts carry the subagent and no-watching rule and no rule to re-read the kit on a notice', () => {
  const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');
  const kit = read('kit/templates/project-kit.md');
  const stub = read('kit/templates/agents-stub.md');
  const skill = read('kit/skills/herdr-orchestrator/SKILL.md');
  for (const [name, text] of [['kit file', kit], ['stub', stub], ['skill', skill]]) {
    assert.match(text, /subagents for diff reviews, long report reads, log searches, and code surveys/, name);
    assert.match(text, /file and line evidence/, name);
    assert.match(text, /[Vv]erif\w* a finding at the source/, name);
    assert.match(text, /[Ee]nd (your|the) turn/, name);
    assert.match(text, /sleep or until loops/, name);
    assert.doesNotMatch(text, /on each `Kit updated` notice/, name);
    assert.doesNotMatch(text, /re-read `?docs\/orchestration\/herdr-boss\.md/, name);
    assert.match(text, /herdr-boss kit update/, name);
  }
  for (const text of [kit, skill]) {
    assert.match(text, /cheaper subagent model/);
    assert.match(text, /Opus only for hard judgment/);
    assert.match(text, /at most one cheap check every 20 to 30 minutes/);
    assert.match(text, /`herdr-boss worker list` and the pane status line/);
    assert.match(text, /report back through herdr when done and to send a `WORKER QUESTION` when blocked/);
    assert.match(text, /stall, a block, and a missing report/);
  }
  assert.match(kit, /Commit a changed kit file, `AGENTS\.md` stub, or hook with your next commit/);
  assert.match(skill, /Commit a changed kit file with your next commit/);
  const lines = stub.trimEnd().split('\n').length;
  assert.ok(lines >= 6 && lines <= 8, `the stub has ${lines} lines`);
  const brief = read('kit/templates/worker-brief.md');
  assert.match(brief, /agent prompt {{orchAgent}} "WORKER QUESTION {{name}}:/);
  assert.match(brief, /agent prompt {{orchAgent}} "WORKER REPORT {{name}}:/);
  const change = readKitChanges().find((entry) => /subagent/i.test(entry.summary || ''));
  assert.ok(change, 'kit/CHANGES.md has an entry for the subagent rule');
  assert.equal(change.impact, 'required');
});
