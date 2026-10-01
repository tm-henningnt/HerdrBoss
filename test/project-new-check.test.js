import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { runProjectNew, runProjectStep } from '../src/project-new.js';
import { checkProject, formatCheck, reserveBrowserCommand } from '../src/project-new-check.js';
import { projectCommand } from '../src/project-new-cli.js';
import { readMessages } from '../src/messages.js';

// Git reads its identity from a temporary global file, never from the machine.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-check-git-'));
const WITH_IDENTITY = path.join(GIT_HOME, 'with');
fs.writeFileSync(WITH_IDENTITY, '[user]\n\tname = Test User\n\temail = test@example.invalid\n');
process.env.GIT_CONFIG_GLOBAL = WITH_IDENTITY;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// The step harness edits a home folder only for the live data dir. The fixture marks its own data dir as the live one
// through HERDR_BOSS_LIVE_DIR. It is a temporary directory: the real ~/.herdr-boss and ~/.codex are never used.
function fixture({ live = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-check-'));
  const dataDir = assertTempDataDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const repoRoot = path.join(root, 'boss-repo');
  fs.mkdirSync(repoRoot);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[sandbox_workspace_write]\nwritable_roots = []\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ autoMode: { environment: ['Owner line'], allow: [] } }, null, 2)}\n`);
  const before = process.env.HERDR_BOSS_LIVE_DIR;
  if (live) process.env.HERDR_BOSS_LIVE_DIR = dataDir;
  else delete process.env.HERDR_BOSS_LIVE_DIR;
  const cleanup = () => {
    if (before === undefined) delete process.env.HERDR_BOSS_LIVE_DIR;
    else process.env.HERDR_BOSS_LIVE_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, dataDir, group, repoRoot, home, ceiling: root, dir: path.join(group, 'demo'), cleanup };
}

// A fake browser reservation. It records the calls and writes the session file like the real command.
function fakeBrowser(f) {
  const calls = [];
  const reserve = (slug) => {
    calls.push(slug);
    const file = path.join(f.dataDir, 'browser-sessions.json');
    let sessions = {};
    try { sessions = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    sessions[slug] = { project: slug, port: 9223 };
    fs.writeFileSync(file, JSON.stringify(sessions));
    return 'reserved port 9223';
  };
  reserve.calls = calls;
  return reserve;
}

function flow(f, extra = {}) {
  const reserveBrowser = extra.reserveBrowser ?? fakeBrowser(f);
  const result = runProjectNew({ slug: 'demo', group: f.group, goal: 'Ship the demo.', dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, home: f.home, reserveBrowser, ...extra });
  return { result, reserveBrowser };
}

const checkOpts = (f, extra = {}) => ({ dataDir: f.dataDir, home: f.home, herdr: () => { throw new Error('no herdr'); }, ...extra });
const item = (result, name) => result.items.find((entry) => entry.name === name);
const NAMES = ['folder', 'agents', 'memory', 'kit', 'config', 'gitignore', 'commit', 'remote', 'policy', 'register', 'status', 'workspace', 'orchestrator', 'harness', 'browser'];

function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const file = path.join(d, e.name); if (e.isDirectory()) walk(file); else out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8'); } };
  walk(dir);
  return out;
}

// A fake Herdr for the workspace and orchestrator items. It records each call.
function checkHerdr({ workspaces = [], panes = [], agents = [] } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'workspace' && args[1] === 'list') return { workspaces };
    if (args[0] === 'pane' && args[1] === 'list') return { panes };
    if (args[0] === 'agent' && args[1] === 'list') return { agents };
    throw new Error(`unexpected herdr call: ${args.join(' ')}`);
  };
  run.calls = calls;
  return run;
}

test('a finished project has every item present', () => {
  const f = fixture();
  try {
    const { result } = flow(f);
    assert.equal(result.ok, true, result.error);
    const check = checkProject('demo', checkOpts(f));
    assert.deepEqual(check.items.map((entry) => entry.name), NAMES);
    for (const entry of check.items) assert.equal(entry.ok, true, `${entry.name}: ${entry.detail}`);
    assert.equal(check.ok, true);
    assert.equal(check.path, fs.realpathSync(f.dir));
  } finally { f.cleanup(); }
});

// Each row breaks one item of a finished project. The item must report missing and name its fix step.
const BREAKS = [
  ['folder', 'folder', (f) => fs.rmSync(path.join(f.dir, '.git'), { recursive: true, force: true }), /git/i],
  ['folder', null, (f) => git(f.dir, 'checkout', '-q', '-b', 'other'), /main/],
  ['agents', 'files', (f) => fs.rmSync(path.join(f.dir, 'AGENTS.md')), /AGENTS\.md/],
  ['agents', 'kit', (f) => fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), '# Hello\n'), /stub|check agents/i],
  ['memory', 'files', (f) => fs.rmSync(path.join(f.dir, 'docs/orchestration/memory.md')), /memory\.md/],
  ['kit', 'kit', (f) => fs.rmSync(path.join(f.dir, 'docs/orchestration/herdr-boss.md')), /herdr-boss\.md/],
  ['kit', 'kit', (f) => { const file = path.join(f.dir, 'docs/orchestration/herdr-boss.md'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/kit v=[0-9a-f]+/, 'kit v=000000000000')); }, /revision/i],
  ['config', 'files', (f) => fs.rmSync(path.join(f.dir, '.herdr-boss.json')), /\.herdr-boss\.json/],
  ['config', null, (f) => fs.writeFileSync(path.join(f.dir, '.herdr-boss.json'), '{bad'), /not valid JSON/],
  ['config', null, (f) => fs.writeFileSync(path.join(f.dir, '.herdr-boss.json'), '{"slug":"other"}'), /slug/],
  ['gitignore', 'files', (f) => fs.rmSync(path.join(f.dir, '.gitignore')), /\.gitignore/],
  ['commit', 'commit', (f) => git(f.dir, 'update-ref', '-d', 'HEAD'), /commit/i],
  ['remote', 'remote', (f) => fs.rmSync(path.join(f.dataDir, 'flows', 'demo.json')), /origin|none/],
  ['policy', 'policy', (f) => { const file = path.join(f.dataDir, 'policy.json'); const policy = JSON.parse(fs.readFileSync(file, 'utf8')); delete policy.projects.demo; fs.writeFileSync(file, JSON.stringify(policy)); }, /policy/i],
  ['register', 'register', (f) => fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), '[]'), /project-repos/],
  ['status', 'status', (f) => fs.rmSync(path.join(f.dataDir, 'projects', 'demo.json')), /status/i],
  ['status', 'status', (f) => { const file = path.join(f.dataDir, 'projects', 'demo.json'); const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.tasks = []; fs.writeFileSync(file, JSON.stringify(data)); }, /task/i],
  ['harness', 'harness', (f) => fs.writeFileSync(path.join(f.home, '.codex', 'config.toml'), '[sandbox_workspace_write]\nwritable_roots = []\n'), /writable_roots|Codex/],
  ['browser', 'harness', (f) => fs.rmSync(path.join(f.dataDir, 'browser-sessions.json')), /browser|reserv/i],
];

for (const [name, fix, mutate, detail] of BREAKS) {
  test(`check ${name}: missing${fix ? ` with fix ${fix}` : ' by hand'} (${detail.source})`, () => {
    const f = fixture();
    try {
      flow(f);
      mutate(f);
      const check = checkProject('demo', checkOpts(f));
      const found = item(check, name);
      assert.equal(found.ok, false, `${name} should be missing`);
      assert.equal(found.fix ?? null, fix);
      assert.match(found.detail, detail);
      assert.equal(check.ok, false);
      const line = formatCheck(check).find((text) => text.trim().startsWith(name));
      assert.match(line, /missing: /);
      if (fix) assert.match(line, new RegExp(`--fix ${fix}`));
    } finally { f.cleanup(); }
  });
}

test('the remote item is present for a recorded none, for an origin, and missing for neither', () => {
  const f = fixture();
  try {
    flow(f);
    const none = item(checkProject('demo', checkOpts(f)), 'remote');
    assert.equal(none.ok, true);
    assert.match(none.detail, /none/);
    git(f.dir, 'remote', 'add', 'origin', 'https://example.invalid/demo.git');
    fs.rmSync(path.join(f.dataDir, 'flows', 'demo.json'));
    const origin = item(checkProject('demo', checkOpts(f)), 'remote');
    assert.equal(origin.ok, true);
    assert.match(origin.detail, /origin/);
    git(f.dir, 'remote', 'remove', 'origin');
    assert.equal(item(checkProject('demo', checkOpts(f)), 'remote').ok, false);
  } finally { f.cleanup(); }
});

test('a remote URL with credentials is never printed', () => {
  const f = fixture();
  try {
    flow(f);
    git(f.dir, 'remote', 'add', 'origin', 'https://user:secret-token@example.invalid/demo.git');
    const text = formatCheck(checkProject('demo', checkOpts(f))).join('\n');
    assert.doesNotMatch(text, /secret-token/);
  } finally { f.cleanup(); }
});

test('workspace and orchestrator items are not required when the flow ran without --start', () => {
  const f = fixture();
  try {
    flow(f);
    const herdr = checkHerdr();
    const check = checkProject('demo', checkOpts(f, { herdr }));
    assert.equal(item(check, 'workspace').ok, true);
    assert.match(item(check, 'workspace').detail, /not started/);
    assert.equal(item(check, 'orchestrator').ok, true);
    assert.deepEqual(herdr.calls, []);
  } finally { f.cleanup(); }
});

function markStarted(f) {
  const file = path.join(f.dataDir, 'flows', 'demo.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.steps.workspace = { status: 'done', at: new Date().toISOString(), detail: 'workspace w1' };
  state.ids.workspaceId = 'w1';
  fs.writeFileSync(file, JSON.stringify(state));
}

test('a started flow needs the workspace, the orch pane, and the agent name', () => {
  const f = fixture();
  try {
    flow(f);
    markStarted(f);
    const good = checkHerdr({
      workspaces: [{ workspace_id: 'w1', label: 'demo' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', label: 'orch' }],
      agents: [{ pane_id: 'w1:p1', name: 'demo-orch' }],
    });
    const ok = checkProject('demo', checkOpts(f, { herdr: good }));
    assert.equal(item(ok, 'workspace').ok, true);
    assert.equal(item(ok, 'orchestrator').ok, true);

    const noWorkspace = checkProject('demo', checkOpts(f, { herdr: checkHerdr() }));
    assert.equal(item(noWorkspace, 'workspace').ok, false);
    assert.equal(item(noWorkspace, 'workspace').fix, 'workspace');
    assert.equal(item(noWorkspace, 'orchestrator').ok, false);

    const noPane = checkProject('demo', checkOpts(f, { herdr: checkHerdr({ workspaces: [{ workspace_id: 'w1', label: 'demo' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', label: 'other' }] }) }));
    assert.equal(item(noPane, 'workspace').ok, true);
    assert.equal(item(noPane, 'orchestrator').ok, false);
    assert.match(item(noPane, 'orchestrator').detail, /orch/);

    const wrongName = checkProject('demo', checkOpts(f, { herdr: checkHerdr({
      workspaces: [{ workspace_id: 'w1', label: 'demo' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', label: 'orch' }],
      agents: [{ pane_id: 'w1:p1', name: 'claude-2' }],
    }) }));
    assert.equal(item(wrongName, 'orchestrator').ok, false);
    assert.match(item(wrongName, 'orchestrator').detail, /demo-orch/);

    const broken = checkProject('demo', checkOpts(f, { herdr: () => { throw new Error('herdr is down'); } }));
    assert.equal(item(broken, 'workspace').ok, false);
    assert.match(item(broken, 'workspace').detail, /herdr is down/);
  } finally { f.cleanup(); }
});

test('project check writes nothing and is idempotent', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    git(f.dir, 'update-ref', '-d', 'HEAD');
    const before = { root: tree(f.root), head: git(f.dir, 'status', '--porcelain') };
    const herdr = checkHerdr();
    const first = checkProject('demo', checkOpts(f, { herdr }));
    const second = checkProject('demo', checkOpts(f, { herdr }));
    assert.deepEqual(first, second);
    assert.deepEqual(tree(f.root), before.root);
    assert.equal(git(f.dir, 'status', '--porcelain'), before.head);
    assert.equal(fs.readdirSync(f.home).includes('.herdr-boss'), false);
    for (const call of herdr.calls) assert.ok(['list', 'get'].includes(call[1]), call.join(' '));
  } finally { f.cleanup(); }
});

test('the check works without a flow state file', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dataDir, 'flows'), { recursive: true });
    const check = checkProject('demo', checkOpts(f));
    for (const entry of check.items) {
      if (entry.name === 'remote') continue;
      assert.equal(entry.ok, true, `${entry.name}: ${entry.detail}`);
    }
    assert.equal(item(check, 'remote').ok, false);
  } finally { f.cleanup(); }
});

test('an unknown project reports the folder as missing and throws nothing', () => {
  const f = fixture();
  try {
    const check = checkProject('ghost', checkOpts(f));
    assert.equal(check.ok, false);
    assert.equal(item(check, 'folder').ok, false);
    assert.match(item(check, 'folder').detail, /registered|state/);
    assert.throws(() => checkProject('Bad Slug', checkOpts(f)), /slug/i);
  } finally { f.cleanup(); }
});

test('--fix runs the named step only', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    const file = path.join(f.dataDir, 'policy.json');
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete policy.projects.demo;
    fs.writeFileSync(file, JSON.stringify(policy));
    const fixed = runProjectStep('policy', { slug: 'demo', dataDir: f.dataDir, home: f.home });
    assert.equal(fixed.ok, true, fixed.error);
    assert.equal(fixed.step.name, 'policy');
    const check = checkProject('demo', checkOpts(f));
    assert.equal(item(check, 'policy').ok, true);
    assert.equal(item(check, 'gitignore').ok, false);
    assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), false);
    const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'flows', 'demo.json'), 'utf8'));
    assert.equal(state.steps.policy.status, 'done');
  } finally { f.cleanup(); }
});

test('--fix runs no other step, even when the state has none of them done', () => {
  const f = fixture();
  try {
    flow(f);
    const calls = [];
    const stepRunners = Object.fromEntries(['folder', 'files', 'kit', 'commit', 'remote', 'policy', 'register', 'status', 'workspace', 'harness'].map((name) => [name, () => { calls.push(name); return 'done'; }]));
    runProjectStep('status', { slug: 'demo', dataDir: f.dataDir, home: f.home, stepRunners });
    assert.deepEqual(calls, ['status']);
  } finally { f.cleanup(); }
});

test('--fix refuses validate, check, and unknown names', () => {
  const f = fixture();
  try {
    flow(f);
    for (const name of ['validate', 'check', 'bogus', '']) assert.throws(() => runProjectStep(name, { slug: 'demo', dataDir: f.dataDir, home: f.home }), /--fix/, name);
  } finally { f.cleanup(); }
});

test('--fix workspace needs --start and remote still asks the Owner', () => {
  const f = fixture();
  try {
    flow(f);
    const calls = [];
    const herdr = (args) => { calls.push(args); throw new Error('no herdr'); };
    const skipped = runProjectStep('workspace', { slug: 'demo', dataDir: f.dataDir, home: f.home, herdr });
    assert.equal(skipped.step.status, 'skipped');
    assert.match(skipped.step.detail, /--start/);
    assert.deepEqual(calls, []);
    const asked = runProjectStep('remote', { slug: 'demo', dataDir: f.dataDir, home: f.home });
    assert.equal(asked.step.status, 'waiting');
    assert.equal(asked.waiting, true);
    assert.equal(readMessages({ dir: f.dataDir }).filter((record) => record.action === 'decide').length, 1);
  } finally { f.cleanup(); }
});

test('--fix works without a flow state file and writes none', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dataDir, 'flows'), { recursive: true });
    fs.rmSync(path.join(f.dir, '.gitignore'));
    const fixed = runProjectStep('files', { slug: 'demo', dataDir: f.dataDir, home: f.home });
    assert.equal(fixed.ok, true, fixed.error);
    assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), true);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
    assert.throws(() => runProjectStep('files', { slug: 'ghost', dataDir: f.dataDir, home: f.home }), /ghost/);
  } finally { f.cleanup(); }
});

test('harness step: adds the Codex root with a backup, prints the Claude lines, and leaves the Claude settings alone', () => {
  const f = fixture();
  try {
    const settingsFile = path.join(f.home, '.claude', 'settings.json');
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
    const { result, reserveBrowser } = flow(f);
    const step = result.steps.find((s) => s.name === 'harness');
    assert.equal(step.status, 'done');
    assert.match(step.detail, /needs Owner action/);
    assert.ok(step.lines.some((line) => /Claude autoMode differences/.test(line)));
    assert.ok(step.lines.some((line) => /^missing /.test(line)));
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), settingsBefore);
    const config = fs.readFileSync(path.join(f.home, '.codex', 'config.toml'), 'utf8');
    assert.ok(config.includes(path.join(fs.realpathSync(f.dir), '.git')) || config.includes(path.join(f.dir, '.git')));
    assert.ok(fs.readdirSync(path.join(f.home, '.codex')).some((name) => name.startsWith('config.toml.bak-')));
    assert.deepEqual(reserveBrowser.calls, ['demo']);
    assert.equal(item(checkProject('demo', checkOpts(f)), 'harness').ok, true);
  } finally { f.cleanup(); }
});

test('harness step: idempotent', () => {
  const f = fixture();
  try {
    const { reserveBrowser } = flow(f);
    const config = fs.readFileSync(path.join(f.home, '.codex', 'config.toml'), 'utf8');
    const backups = fs.readdirSync(path.join(f.home, '.codex')).length;
    const again = runProjectStep('harness', { slug: 'demo', dataDir: f.dataDir, home: f.home, reserveBrowser });
    assert.equal(again.ok, true, again.error);
    assert.equal(fs.readFileSync(path.join(f.home, '.codex', 'config.toml'), 'utf8'), config);
    assert.equal(fs.readdirSync(path.join(f.home, '.codex')).length, backups);
    assert.deepEqual(reserveBrowser.calls, ['demo', 'demo']);
  } finally { f.cleanup(); }
});

test('harness step: a dry run changes nothing and reserves nothing', () => {
  const f = fixture();
  try {
    const reserveBrowser = fakeBrowser(f);
    const before = tree(f.root);
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, home: f.home, reserveBrowser, dryRun: true });
    const step = result.steps.find((s) => s.name === 'harness');
    assert.equal(step.status, 'planned');
    assert.match(step.detail, /would .*writable roots.*Claude.*browser/i);
    assert.deepEqual(reserveBrowser.calls, []);
    assert.deepEqual(tree(f.root), before);
  } finally { f.cleanup(); }
});

test('harness step: no Claude difference means no Owner action, a Codex or browser problem is a warning', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.home, '.codex'), { recursive: true });
    const failing = () => { throw new Error('no port free'); };
    const { result } = flow(f, { reserveBrowser: failing });
    assert.equal(result.ok, true, result.error);
    const step = result.steps.find((s) => s.name === 'harness');
    assert.equal(step.status, 'done');
    assert.match(step.detail, /warning/i);
    assert.match(step.detail, /no port free/);
  } finally { f.cleanup(); }
});

test('harness step: a temporary data dir skips the step, leaves the Codex config byte-identical, and creates no reservation', () => {
  const f = fixture({ live: false });
  try {
    const codexFile = path.join(f.home, '.codex', 'config.toml');
    const before = fs.readFileSync(codexFile);
    const codexNames = fs.readdirSync(path.join(f.home, '.codex'));
    const reserveBrowser = fakeBrowser(f);
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, home: f.home, reserveBrowser });
    const step = result.steps.find((s) => s.name === 'harness');
    assert.equal(step.status, 'skipped');
    assert.equal(step.detail, 'skipped: not the live data dir');
    assert.ok(step.lines.some((line) => /Claude autoMode differences/.test(line)));
    assert.ok(fs.readFileSync(codexFile).equals(before));
    assert.deepEqual(fs.readdirSync(path.join(f.home, '.codex')), codexNames);
    assert.deepEqual(reserveBrowser.calls, []);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'browser-sessions.json')), false);
  } finally { f.cleanup(); }
});

test('harness step: a temporary data dir without a home is skipped and touches nothing', () => {
  const f = fixture({ live: false });
  try {
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    const step = result.steps.find((s) => s.name === 'harness');
    assert.equal(step.status, 'skipped');
    assert.equal(step.detail, 'skipped: not the live data dir');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'browser-sessions.json')), false);
  } finally { f.cleanup(); }
});

test('harness step: a dry run for a temporary data dir prints the skip', () => {
  const f = fixture({ live: false });
  try {
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, home: f.home, dryRun: true });
    assert.equal(result.steps.find((s) => s.name === 'harness').detail, 'skipped: not the live data dir');
  } finally { f.cleanup(); }
});

test('projectCommand check: exit 0 when all is present, 4 when something is missing, one line per item', () => {
  const f = fixture();
  try {
    flow(f);
    const out = [];
    const run = (args) => { out.length = 0; return projectCommand(args, { env: {}, dataDir: f.dataDir, herdr: () => { throw new Error('no herdr'); }, log: (line) => out.push(line), flowOptions: { home: f.home, reserveBrowser: fakeBrowser(f) } }); };
    assert.equal(run(['check', 'demo']), 0);
    const text = out.join('\n');
    for (const name of NAMES) assert.match(text, new RegExp(`^\\s+${name}\\s+ok`, 'm'), name);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    assert.equal(run(['check', 'demo']), 4);
    assert.match(out.join('\n'), /gitignore\s+missing: .*--fix files/);
  } finally { f.cleanup(); }
});

test('projectCommand check: usage errors exit 1 by throwing the usage line', () => {
  const f = fixture();
  try {
    const call = (args) => projectCommand(args, { env: {}, dataDir: f.dataDir, log: () => {} });
    assert.throws(() => call(['check']), /Usage: project check/);
    assert.throws(() => call(['check', 'demo', '--bogus']), /Usage: project check/);
    assert.throws(() => call(['check', 'demo', '--fix']), /Usage: project check/);
    assert.throws(() => call(['check', 'demo', '--fix', 'files', '--fix', 'kit']), /Usage: project check|only once/);
    assert.throws(() => call(['check', 'demo', 'other']), /Usage: project check/);
    assert.throws(() => call(['check', 'demo', '--start']), /Usage: project check|--fix workspace/);
    assert.throws(() => call(['check', 'demo', '--fix', 'validate']), /--fix/);
  } finally { f.cleanup(); }
});

test('projectCommand check --fix STEP runs one step, prints the check again, and exits with the check code', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    const file = path.join(f.dataDir, 'policy.json');
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete policy.projects.demo;
    fs.writeFileSync(file, JSON.stringify(policy));
    const out = [];
    const code = projectCommand(['check', 'demo', '--fix', 'files'], { env: {}, dataDir: f.dataDir, herdr: () => { throw new Error('no herdr'); }, log: (line) => out.push(line), flowOptions: { home: f.home, reserveBrowser: fakeBrowser(f) } });
    const text = out.join('\n');
    assert.match(text, /files\s+done/);
    assert.match(text, /gitignore\s+ok/);
    assert.match(text, /policy\s+missing/);
    assert.equal(code, 4);
    assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), true);
  } finally { f.cleanup(); }
});

test('projectCommand check --fix remote exits 3 while the Owner has not answered', () => {
  const f = fixture();
  try {
    flow(f);
    const out = [];
    const code = projectCommand(['check', 'demo', '--fix', 'remote'], { env: {}, dataDir: f.dataDir, herdr: () => { throw new Error('no herdr'); }, log: (line) => out.push(line), flowOptions: { home: f.home } });
    assert.equal(code, 3);
    assert.match(out.join('\n'), /waiting/i);
  } finally { f.cleanup(); }
});

const paneEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'w1' };
const pane = (label) => () => ({ pane: { pane_id: 'p1', workspace_id: 'w1', label } });

test('--fix refuses a worker pane for every step and changes nothing', () => {
  const f = fixture();
  try {
    flow(f);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    const before = tree(f.root);
    const calls = [];
    const herdr = (args) => { calls.push(args); return pane('png')(); };
    for (const step of ['files', 'policy', 'remote', 'harness']) {
      assert.throws(() => projectCommand(['check', 'demo', '--fix', step], { env: paneEnv, herdr, dataDir: f.dataDir, log: () => {}, flowOptions: { home: f.home } }), /project new/, step);
    }
    assert.throws(() => projectCommand(['check', 'demo', '--fix', 'workspace', '--start'], { env: paneEnv, herdr, dataDir: f.dataDir, log: () => {}, flowOptions: { home: f.home } }), /project new/);
    assert.deepEqual(tree(f.root), before);
    assert.ok(calls.every((call) => call[0] === 'pane' && call[1] === 'get'));
  } finally { f.cleanup(); }
});

test('--fix is allowed for an orchestrator pane, the Boss pane, and a plain terminal', () => {
  const f = fixture();
  try {
    flow(f);
    const run = (env, herdr) => projectCommand(['check', 'demo', '--fix', 'files'], { env, herdr, dataDir: f.dataDir, log: () => {}, flowOptions: { home: f.home } });
    fs.rmSync(path.join(f.dir, '.gitignore'));
    assert.equal(run(paneEnv, pane('orch')), 0);
    assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), true);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    assert.equal(run(paneEnv, pane('boss')), 0);
    fs.rmSync(path.join(f.dir, '.gitignore'));
    run({}, () => { throw new Error('no call'); });
    assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), true);
  } finally { f.cleanup(); }
});

test('plain project check stays allowed for a worker pane and writes nothing', () => {
  const f = fixture();
  try {
    flow(f);
    const before = tree(f.root);
    const herdr = () => { throw new Error('no call'); };
    assert.equal(projectCommand(['check', 'demo'], { env: paneEnv, herdr, dataDir: f.dataDir, log: () => {}, flowOptions: { home: f.home } }), 0);
    assert.deepEqual(tree(f.root), before);
  } finally { f.cleanup(); }
});

test('harness step: a browser error in the detail is redacted', () => {
  const f = fixture();
  try {
    const token = `ghp_${'a'.repeat(30)}`;
    const { result } = flow(f, { reserveBrowser: () => { throw new Error(`failed https://user:${token}@example.invalid/x with ${token}`); } });
    const detail = result.steps.find((s) => s.name === 'harness').detail;
    assert.match(detail, /warning: browser not reserved/);
    assert.doesNotMatch(detail, /ghp_|user:/);
  } finally { f.cleanup(); }
});

test('the real reserve command reserves a port in a temp data dir and launches no browser', () => {
  const f = fixture();
  try {
    const detail = reserveBrowserCommand('demo', { dataDir: f.dataDir, home: f.home });
    assert.match(detail, /^reserved/);
    const sessions = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'browser-sessions.json'), 'utf8'));
    assert.equal(sessions.demo.pid, null);
    assert.equal(sessions.demo.launchedAt, null);
    assert.equal(fs.existsSync(path.join(f.home, '.herdr-boss')), false);
    assert.equal(item(checkProject('demo', checkOpts(f)), 'browser').ok, true);
  } finally { f.cleanup(); }
});
