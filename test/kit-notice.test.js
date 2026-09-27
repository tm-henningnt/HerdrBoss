import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { formatKitNotice, readKitNotice, pendingKitAlert, kitNoticeTargets, KIT_PATHS } from '../src/kit-notice.js';
import { projectKit } from '../src/kit/agents-check.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-09-27T10:00:00.000Z');
const REV = projectKit().revision;

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitSync(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(t) {
  const root = tmpDir(t, 'herdr-kit-notice-');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  commit(root, 'README.md', 'Initial commit');
  return root;
}

function commit(root, file, subject) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `${subject}\n`);
  gitSync(root, ['add', file]);
  gitSync(root, ['commit', '-m', subject]);
  return gitSync(root, ['rev-parse', 'HEAD']);
}

// The real git boundary, with a record of each call.
function recordingGit(calls = []) {
  const git = (args) => new Promise((resolve, reject) => {
    calls.push(args);
    execFile('git', args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  git.calls = calls;
  return git;
}

test('the first start stores HEAD and sends nothing', async (t) => {
  const root = makeRepo(t);
  commit(root, 'kit/models.md', 'Kit change before the first start');
  const head = gitSync(root, ['rev-parse', 'HEAD']);
  const result = await readKitNotice({ root, stored: undefined, git: recordingGit(), now: NOW });
  assert.equal(result.alert, null);
  assert.equal(result.event, null);
  assert.deepEqual(result.state, { commit: head, at: NOW });
});

test('an unchanged HEAD sends nothing and runs no git log', async (t) => {
  const root = makeRepo(t);
  const head = commit(root, 'kit/models.md', 'Kit change');
  const git = recordingGit();
  const stored = { commit: head, at: NOW - 1000 };
  const result = await readKitNotice({ root, stored, git, now: NOW });
  assert.equal(result.alert, null);
  assert.equal(result.event, null);
  assert.deepEqual(result.state, stored);
  assert.deepEqual(git.calls, [['-C', root, 'rev-parse', 'HEAD']]);
});

test('two kit commits and one non-kit commit give one alert with only the kit subjects', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/skills/herdr-orchestrator/SKILL.md', 'Change the orchestrator skill');
  commit(root, 'src/server.js', 'Change the dashboard server');
  commit(root, 'src/kit/workers.js', 'Change worker start');
  const head = gitSync(root, ['rev-parse', 'HEAD']);
  const git = recordingGit();
  const result = await readKitNotice({ root, stored: { commit: base, at: NOW - 1000 }, git, now: NOW });
  assert.deepEqual(result.state.commit, head);
  assert.equal(result.state.at, NOW);
  assert.equal(result.event, null);
  assert.equal(result.alert.key, `kit:${head.slice(0, 7)}`);
  assert.equal(result.alert.severity, 'info');
  assert.equal(result.alert.scope, 'all');
  assert.equal(result.alert.once, true);
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${REV} (2 change(s)): Change worker start; Change the orchestrator skill. Run herdr-boss kit install, then re-read docs/orchestration/herdr-boss.md now; your loaded copy is stale.`);
  assert.deepEqual(result.state.alert, result.alert);
  assert.deepEqual(git.calls, [
    ['-C', root, 'rev-parse', 'HEAD'],
    ['-C', root, 'merge-base', '--is-ancestor', base, head],
    ['-C', root, 'log', '--format=%h%x09%s', `${base}..HEAD`, '--', 'kit', 'src/kit', 'docs/orchestrator-instructions.md'],
  ]);
});

test('the orchestrator instructions file counts as a kit path', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'docs/orchestrator-instructions.md', 'Change the orchestrator block');
  commit(root, 'docs/user-guide.md', 'Change the user guide');
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  assert.match(result.alert.text, /\(1 change\(s\)\): Change the orchestrator block\. Run/);
});

test('the kit and stub templates count as kit paths', async (t) => {
  for (const file of ['kit/templates/project-kit.md', 'kit/templates/agents-stub.md']) {
    assert.ok(KIT_PATHS.some((kitPath) => file === kitPath || file.startsWith(`${kitPath}/`)), file);
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    commit(root, file, `Change ${path.basename(file)}`);
    const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
    assert.match(result.alert.text, new RegExp(`\\(1 change\\(s\\)\\): Change ${path.basename(file).replace('.', '\\.')}\\. Run`));
  }
});

test('only non-kit commits store HEAD and send nothing', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  const head = commit(root, 'src/server.js', 'Change the dashboard server');
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  assert.equal(result.alert, null);
  assert.deepEqual(result.state, { commit: head, at: NOW });
});

test('more than 10 kit commits list the 10 newest and then and N more', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  for (let i = 1; i <= 13; i += 1) commit(root, 'kit/models.md', `Kit change ${i}`);
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  const subjects = Array.from({ length: 10 }, (_, i) => `Kit change ${13 - i}`).join('; ');
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${REV} (13 change(s)): ${subjects}; and 3 more. Run herdr-boss kit install, then re-read docs/orchestration/herdr-boss.md now; your loaded copy is stale.`);
});

test('the notice text stays under 1200 characters with long subjects', () => {
  const commits = Array.from({ length: 30 }, (_, i) => ({ hash: `h${i}`, subject: `${'x'.repeat(400)} ${i}` }));
  const text = formatKitNotice(commits, 'abcdef012345');
  assert.ok(text.length < 1200, `length ${text.length}`);
  assert.match(text, /^\[herdr-boss\] Kit revision abcdef012345 \(30 change\(s\)\): /);
  assert.match(text, /; and 20 more\. Run herdr-boss kit install, then re-read docs\/orchestration\/herdr-boss\.md now; your loaded copy is stale\.$/);
});

test('a git failure sends nothing, stores HEAD, and gives one event', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  const head = commit(root, 'kit/models.md', 'Kit change');
  const real = recordingGit();
  const git = (args) => (args.includes('log') ? Promise.reject(new Error('git log failed')) : real(args));
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git, now: NOW });
  assert.equal(result.alert, null);
  assert.deepEqual(result.state, { commit: head, at: NOW });
  assert.match(result.event, /git log failed/);
});

test('a failed rev-parse keeps the stored commit and gives one event', async () => {
  const stored = { commit: 'a'.repeat(40), at: 0 };
  const result = await readKitNotice({ root: '/nowhere', stored, git: () => Promise.reject(new Error('not a git repository')), now: NOW });
  assert.equal(result.alert, null);
  assert.deepEqual(result.state, stored);
  assert.match(result.event, /not a git repository/);
});

test('a stored commit that is not an ancestor of HEAD sends nothing and stores HEAD', async (t) => {
  const root = makeRepo(t);
  gitSync(root, ['checkout', '-b', 'side']);
  const side = commit(root, 'kit/models.md', 'Kit change on a side branch');
  gitSync(root, ['checkout', 'main']);
  const head = commit(root, 'kit/models.md', 'Kit change on main');
  const git = recordingGit();
  const result = await readKitNotice({ root, stored: { commit: side, at: 0 }, git, now: NOW });
  assert.equal(result.alert, null);
  assert.deepEqual(result.state, { commit: head, at: NOW });
  assert.match(result.event, /not an ancestor/);
  assert.equal(git.calls.some((args) => args.includes('log')), false);
});

test('a pending kit alert stays active for seven days', () => {
  const alert = { key: 'kit:abc1234', severity: 'info', scope: 'all', once: true, title: 'Kit updated', text: 'x' };
  assert.deepEqual(pendingKitAlert({ commit: 'abc', at: NOW, alert }, NOW + 1000), alert);
  assert.equal(pendingKitAlert({ commit: 'abc', at: NOW, alert }, NOW + 8 * 86400 * 1000), null);
  assert.equal(pendingKitAlert({ commit: 'abc', at: NOW }, NOW), null);
  assert.equal(pendingKitAlert(undefined, NOW), null);
});

test('kit notice targets exclude the Boss pane and the Boss workspace', () => {
  const orchs = [
    { id: 'wBoss:p1', workspace: 'wBoss', workspaceLabel: 'Boss', label: 'boss', orch: true, agent: 'claude' },
    { id: 'wBoss:p2', workspace: 'wBoss', workspaceLabel: 'Boss', label: 'orch', orch: true, agent: 'claude' },
    { id: 'wA:p1', workspace: 'wA', workspaceLabel: 'Alpha', label: 'orch', orch: true, agent: 'codex' },
  ];
  assert.deepEqual(kitNoticeTargets(orchs).map((o) => o.id), ['wA:p1']);
});

const engineProbe = `
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './src/engine.js';
import { loadConfig } from './src/config.js';
const input = JSON.parse(process.env.KIT_SCENARIO);
const gitCalls = [];
const prompts = [];
const cfg = loadConfig();
cfg.push = false;
cfg.quotaSeconds = 300;
cfg.tickSeconds = 30;
cfg.browsers.reapOrphanDaemons = false;
const engine = new Engine(cfg, {
  push: false,
  act: false,
  gitRunner: async (args) => {
    gitCalls.push(args);
    if (args.includes('log')) return input.log || '';
    return args.includes('rev-parse') ? input.head + '\\n' : '';
  },
  kitRoot: '/kit-root',
  herdrRunner: async (cmd, args) => { prompts.push(args); return ''; },
  collectors: {
    collectHerdr: async () => input.herdr,
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
  },
});
const out = {};
if (input.mode === 'read') {
  await engine.readKitNotice(Date.parse('2026-09-27T10:00:00.000Z'));
  fs.writeFileSync(path.join(process.env.HERDR_BOSS_DIR, 'memory.json'), JSON.stringify(engine.memory));
  out.events = engine.events.filter((e) => e.type === 'kit').map((e) => e.text);
} else if (input.mode === 'tick') {
  const snap = await engine.tick();
  out.alerts = (snap.alerts || []).map((a) => a.key);
} else {
  engine.push = true;
  const alert = { key: 'kit:abc1234', severity: 'info', scope: 'all', once: true, title: 'Kit updated', text: '[herdr-boss] Kit updated (1 change(s)): x.' };
  for (const [i, panes] of input.rounds.entries()) await engine.deliver([alert], { panes }, Date.parse('2026-09-27T10:00:00.000Z') + i * 60000);
}
const memoryFile = path.join(process.env.HERDR_BOSS_DIR, 'memory.json');
out.gitCalls = gitCalls;
out.prompts = prompts;
out.memoryKitNotice = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')).kitNotice ?? null : null;
out.engineKitNotice = engine.memory.kitNotice ?? null;
console.log(JSON.stringify(out));
`;

function runEngine(t, scenario) {
  const dir = tmpDir(t, 'herdr-kit-engine-');
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  if (scenario.memory) fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(scenario.memory));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', engineProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, KIT_SCENARIO: JSON.stringify(scenario) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('the read-only engine (act: false) runs no git and sends and stores no kit notice', { timeout: 30000 }, (t) => {
  const out = runEngine(t, {
    mode: 'tick',
    head: 'b'.repeat(40),
    herdr: { workspaces: [{ id: 'wA', label: 'Alpha' }], panes: [{ id: 'wA:p1', workspace: 'wA', label: 'orch', orch: true, agent: 'codex', status: 'idle' }] },
  });
  assert.deepEqual(out.gitCalls, []);
  assert.deepEqual(out.prompts, []);
  assert.equal(out.memoryKitNotice, null);
  assert.equal(out.engineKitNotice, null);
  assert.equal(out.alerts.some((key) => key.startsWith('kit:')), false);
});

test('the kit notice reaches each idle project orchestrator once and never the Boss', { timeout: 30000 }, (t) => {
  const boss = { id: 'wBoss:p1', workspace: 'wBoss', workspaceLabel: 'Boss', label: 'boss', orch: true, agent: 'claude', status: 'idle' };
  const bossWorker = { id: 'wBoss:p2', workspace: 'wBoss', workspaceLabel: 'Boss', label: null, orch: false, agent: 'codex', status: 'working' };
  const alpha = { id: 'wA:p1', workspace: 'wA', workspaceLabel: 'Alpha', label: 'orch', orch: true, agent: 'codex', status: 'idle' };
  const beta = { id: 'wB:p1', workspace: 'wB', workspaceLabel: 'Beta', label: 'orch', orch: true, agent: 'claude', status: 'working' };
  const out = runEngine(t, {
    mode: 'deliver',
    rounds: [
      [boss, bossWorker, alpha, beta],
      [boss, bossWorker, alpha, { ...beta, status: 'done' }],
      [boss, bossWorker, alpha, { ...beta, status: 'idle' }],
    ],
  });
  const targets = out.prompts.filter((args) => args[0] === 'agent' && args[1] === 'prompt').map((args) => args[2]);
  assert.deepEqual(targets, ['wA:p1', 'wB:p1']);
  assert.ok(out.prompts.every((args) => args.at(-1).includes('Kit updated (1 change(s))')));
});

test('the engine stores the kit notice state and logs the queued notice', { timeout: 30000 }, (t) => {
  const base = 'a'.repeat(40);
  const head = 'c'.repeat(40);
  const out = runEngine(t, {
    mode: 'read',
    head,
    log: 'ccccccc\tChange the kit\n',
    memory: { paneSince: {}, pushes: {}, notified: {}, kitNotice: { commit: base, at: 0 } },
  });
  assert.deepEqual(out.gitCalls, [
    ['-C', '/kit-root', 'rev-parse', 'HEAD'],
    ['-C', '/kit-root', 'merge-base', '--is-ancestor', base, head],
    ['-C', '/kit-root', 'log', '--format=%h%x09%s', `${base}..HEAD`, '--', 'kit', 'src/kit', 'docs/orchestrator-instructions.md'],
  ]);
  assert.equal(out.memoryKitNotice.commit, head);
  assert.equal(out.memoryKitNotice.alert.key, 'kit:ccccccc');
  assert.match(out.memoryKitNotice.alert.text, /Kit revision [0-9a-f]{12} \(1 change\(s\)\): Change the kit\. Run herdr-boss kit install/);
  assert.deepEqual(out.events, ['Queued kit notice kit:ccccccc for each project orchestrator']);
});
