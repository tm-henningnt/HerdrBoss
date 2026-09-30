import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { heldWorkspaces } from '../src/engine.js';
import { formatKitNotice, readKitNotice, pendingKitAlert, kitNoticeTargets, KIT_PATHS, KIT_REVISION_PATHS } from '../src/kit-notice.js';
import { kitRevision, projectKit } from '../src/kit/agents-check.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-09-27T10:00:00.000Z');
const REV = projectKit().revision;
const REQUIRED = 'Kit-Impact: required';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitSync(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
}

// A project root that holds the same installed kit assets as the repository, so it is a real kit
// root and its kit revision equals the kit revision of the repository. A commit that changes an
// asset moves the fixture revision, so tests that change one compute the revision again.
function makeRepo(t) {
  const root = tmpDir(t, 'herdr-kit-notice-');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  commit(root, 'README.md', 'Initial commit');
  for (const relative of KIT_REVISION_PATHS) {
    const source = path.join(repo, relative);
    const target = path.join(root, relative);
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } else fs.cpSync(source, target, { recursive: true });
  }
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-m', 'Add the installed kit assets']);
  assert.equal(kitRevision(root), kitRevision());
  return root;
}

function commit(root, file, subject, trailers = '') {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `${subject}\n`);
  gitSync(root, ['add', file]);
  gitSync(root, ['commit', '-m', trailers ? `${subject}\n\n${trailers}` : subject]);
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

function changesFile(t, text) {
  const file = path.join(tmpDir(t, 'herdr-kit-changes-notice-'), 'CHANGES.md');
  fs.writeFileSync(file, text);
  return file;
}

// A change log with one required, one useful, and one later required change.
const CHANGES_TEXT = [
  '## 111111111111',
  'Impact: required',
  'Summary: An earlier change.',
  '',
  '## 222222222222',
  'Impact: useful',
  'Summary: A useful change.',
  '',
  '## 333333333333',
  'Impact: required',
  'Summary: A later change.',
  '',
].join('\n');

// A change log whose only entry after 111111111111 is a useful change.
const USEFUL_TEXT = [
  '## 111111111111',
  'Impact: required',
  'Summary: An earlier change.',
  '',
  '## 222222222222',
  'Impact: useful',
  'Summary: A useful change.',
  '',
].join('\n');

test('the first start stores HEAD and sends nothing', async (t) => {
  const root = makeRepo(t);
  commit(root, 'kit/models.md', 'Kit change before the first start');
  const head = gitSync(root, ['rev-parse', 'HEAD']);
  const result = await readKitNotice({ root, stored: undefined, git: recordingGit(), now: NOW });
  assert.equal(result.alert, null);
  assert.equal(result.event, null);
  assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV });
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

test('the notice and the stored state take the kit revision of the given project root', async (t) => {
  const root = makeRepo(t);
  // A project root with its own kit assets, so its kit revision differs from the default kit root.
  for (const relative of KIT_REVISION_PATHS) {
    const isFile = /\.(?:md|json)$/.test(relative);
    const file = path.join(root, isFile ? relative : path.join(relative, 'asset.md'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture ${relative}`);
  }
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-m', 'Add the fixture kit assets']);
  const expected = kitRevision(root);
  assert.match(expected, /^[0-9a-f]{12}$/);
  assert.notEqual(expected, kitRevision(), 'the fixture root must not have the default kit revision');
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/models.md', 'Change the kit', REQUIRED);
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  assert.equal(result.state.revision, expected);
  assert.ok(result.alert.text.startsWith(`[herdr-boss] Kit revision ${expected} (1 change(s)): `), result.alert.text);
});

test('two kit commits and one non-kit commit give one alert with only the kit subjects', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/skills/herdr-orchestrator/SKILL.md', 'Change the orchestrator skill', REQUIRED);
  commit(root, 'src/server.js', 'Change the dashboard server');
  commit(root, 'src/kit/workers.js', 'Change worker start', REQUIRED);
  const head = gitSync(root, ['rev-parse', 'HEAD']);
  // The skill template is an installed kit asset, so the kit commit moves the fixture revision.
  const revision = kitRevision(root);
  const git = recordingGit();
  const result = await readKitNotice({ root, stored: { commit: base, at: NOW - 1000 }, git, now: NOW });
  assert.deepEqual(result.state.commit, head);
  assert.equal(result.state.at, NOW);
  assert.equal(result.state.revision, revision);
  assert.equal(result.event, null);
  assert.equal(result.alert.key, `kit:${head.slice(0, 7)}`);
  assert.equal(result.alert.severity, 'info');
  assert.equal(result.alert.scope, 'all');
  assert.equal(result.alert.once, true);
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${revision} (2 change(s)): Change worker start; Change the orchestrator skill. Run herdr-boss kit update and continue. The command prints the current kit file.`);
  assert.deepEqual(result.state.alert, result.alert);
  assert.deepEqual(git.calls, [
    ['-C', root, 'rev-parse', 'HEAD'],
    ['-C', root, 'merge-base', '--is-ancestor', base, head],
    ['-C', root, 'log', '--format=%h%x1f%s%x1f%B%x00', `${base}..HEAD`, '--', ...KIT_PATHS],
    ['-C', root, 'log', '--format=%h%x00', `${base}..HEAD`, '--', ...KIT_REVISION_PATHS],
  ]);
});

test('the orchestrator instructions file counts as a kit path', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'docs/orchestrator-instructions.md', 'Change the orchestrator block', REQUIRED);
  commit(root, 'docs/user-guide.md', 'Change the user guide');
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  assert.match(result.alert.text, /\(1 change\(s\)\): Change the orchestrator block\. Run/);
});

test('the kit and stub templates count as kit paths', async (t) => {
  for (const file of ['kit/templates/project-kit.md', 'kit/templates/agents-stub.md']) {
    assert.ok(KIT_PATHS.some((kitPath) => file === kitPath || file.startsWith(`${kitPath}/`)), file);
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    commit(root, file, `Change ${path.basename(file)}`, REQUIRED);
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
  assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV });
});

test('a useful or none kit trailer sends no notice and still stores HEAD and the revision', async (t) => {
  for (const impact of ['useful', 'none', 'USEFUL', 'None']) {
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    const head = commit(root, 'kit/models.md', `Kit change with ${impact} impact`, `Kit-Impact: ${impact}`);
    const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
    assert.equal(result.alert, null, impact);
    assert.equal(result.event, null, impact);
    assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV }, impact);
  }
});

test('a mixed batch names only the required changes', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/models.md', 'An old useful change', 'Kit-Impact: useful');
  commit(root, 'kit/models.md', 'A change that needs action', 'Kit-Impact: required');
  commit(root, 'kit/models.md', 'A cosmetic change', 'Kit-Impact: none');
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${REV} (1 change(s)): A change that needs action. Run herdr-boss kit update and continue. The command prints the current kit file.`);
});

test('a missing, invalid, or ambiguous impact sends no notice', async (t) => {
  const cases = [
    ['no trailer', ''],
    ['an invalid value', 'Kit-Impact: maybe'],
    ['a duplicated trailer', 'Kit-Impact: required\nKit-Impact: none'],
    ['a body line', 'Body text.\nKit-Impact: required\nMore body text.'],
  ];
  for (const [name, trailers] of cases) {
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    const head = commit(root, 'kit/models.md', `Kit change with ${name}`, trailers);
    const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
    assert.equal(result.alert, null, name);
    assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV }, name);
  }
});

test('a recorded useful change sends no notice when the change log lines up with the commits', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  const head = commit(root, 'kit/templates/project-kit.md', 'Record a useful change');
  const result = await readKitNotice({
    root, stored: { commit: base, revision: '111111111111', at: 0 }, git: recordingGit(), now: NOW, changesFile: changesFile(t, USEFUL_TEXT),
  });
  assert.equal(result.alert, null);
  assert.equal(result.event, null);
  assert.deepEqual(result.state, { commit: head, at: NOW, revision: kitRevision(root) });
});

test('a recorded required change sends a notice when the change log lines up with the commits', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/templates/project-kit.md', 'Record a change that needs action');
  const result = await readKitNotice({
    root, stored: { commit: base, revision: '222222222222', at: 0 }, git: recordingGit(), now: NOW, changesFile: changesFile(t, CHANGES_TEXT),
  });
  assert.ok(result.alert);
  // The project kit template is an installed kit asset, so the kit commit moves the fixture revision.
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${kitRevision(root)} (1 change(s)): Record a change that needs action. Run herdr-boss kit update and continue. The command prints the current kit file.`);
});

test('a batch of asset commits takes one record per commit, newest first', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/templates/project-kit.md', 'Record the older useful change');
  commit(root, 'kit/models.json', 'Record the newer useful change');
  const result = await readKitNotice({
    root, stored: { commit: base, revision: '111111111111', at: 0 }, git: recordingGit(), now: NOW, changesFile: changesFile(t, CHANGES_TEXT),
  });
  // The newest commit takes the newest record, which is the required one. Only it is named.
  assert.ok(result.alert);
  // Both commits change an installed kit asset, so they move the fixture revision.
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${kitRevision(root)} (1 change(s)): Record the newer useful change. Run herdr-boss kit update and continue. The command prints the current kit file.`);
});

test('a change log that does not line up with the commits sends no notice', async (t) => {
  const cases = [
    ['two asset commits and one entry', ['kit/templates/project-kit.md', 'kit/models.json']],
    ['a code commit and one entry', ['src/kit/workers.js']],
  ];
  for (const [name, files] of cases) {
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    for (const [index, file] of files.entries()) commit(root, file, `Kit change ${index + 1} for ${name}`);
    const result = await readKitNotice({
      root, stored: { commit: base, revision: '111111111111', at: 0 }, git: recordingGit(), now: NOW, changesFile: changesFile(t, USEFUL_TEXT),
    });
    assert.equal(result.alert, null, name);
  }
});

test('an unknown stored revision or an old cursor sends no notice', async (t) => {
  for (const stored of [{ revision: 'deadbeefcafe' }, {}]) {
    const root = makeRepo(t);
    const base = gitSync(root, ['rev-parse', 'HEAD']);
    commit(root, 'kit/templates/project-kit.md', 'Record a useful change');
    const result = await readKitNotice({
      root, stored: { commit: base, at: 0, ...stored }, git: recordingGit(), now: NOW, changesFile: changesFile(t, CHANGES_TEXT),
    });
    assert.equal(result.alert, null, JSON.stringify(stored));
  }
});

test('an unreadable change log sends no notice', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  commit(root, 'kit/templates/project-kit.md', 'Record a useful change');
  const missing = path.join(tmpDir(t, 'herdr-kit-changes-absent-'), 'CHANGES.md');
  const result = await readKitNotice({
    root, stored: { commit: base, revision: '111111111111', at: 0 }, git: recordingGit(), now: NOW, changesFile: missing,
  });
  assert.equal(result.alert, null);
});

test('the kit revision paths are the installed kit assets that the revision hashes', (t) => {
  const root = fs.realpathSync(tmpDir(t, 'herdr-kit-revision-paths-'));
  // A path that names a file keeps its name. A path that names a folder holds one file.
  const asset = (relative) => (/\.(?:md|json)$/.test(relative) ? relative : path.join(relative, 'asset.md'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const relative of KIT_REVISION_PATHS) write(asset(relative), `content of ${relative}`);
  write('kit/templates/project-kit.md', 'canonical body');
  write('src/engine.js', 'service');
  const revision = kitRevision(root);
  assert.match(revision, /^[0-9a-f]{12}$/);
  for (const relative of KIT_REVISION_PATHS) {
    assert.ok(KIT_PATHS.some((kitPath) => relative === kitPath || relative.startsWith(`${kitPath}/`)), relative);
    write(asset(relative), `changed ${relative}`);
    assert.notEqual(kitRevision(root), revision, `${relative} must change the kit revision`);
  }
  const withAssets = kitRevision(root);
  for (const relative of ['src/engine.js', 'public/app.js', 'docs/orchestrator-instructions.md', 'kit/CHANGES.md']) {
    write(relative, `product code in ${relative}`);
    assert.equal(kitRevision(root), withAssets, `${relative} must not change the kit revision`);
  }
});

test('more than 10 kit commits list the 10 newest and then and N more', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  for (let i = 1; i <= 13; i += 1) commit(root, 'kit/models.md', `Kit change ${i}`, REQUIRED);
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git: recordingGit(), now: NOW });
  const subjects = Array.from({ length: 10 }, (_, i) => `Kit change ${13 - i}`).join('; ');
  assert.equal(result.alert.text, `[herdr-boss] Kit revision ${REV} (13 change(s)): ${subjects}; and 3 more. Run herdr-boss kit update and continue. The command prints the current kit file.`);
});

test('the notice text stays under 1200 characters with long subjects', () => {
  const commits = Array.from({ length: 30 }, (_, i) => ({ hash: `h${i}`, subject: `${'x'.repeat(400)} ${i}` }));
  const text = formatKitNotice(commits, 'abcdef012345');
  assert.ok(text.length < 1200, `length ${text.length}`);
  assert.match(text, /^\[herdr-boss\] Kit revision abcdef012345 \(30 change\(s\)\): /);
  assert.match(text, /; and 20 more\. Run herdr-boss kit update and continue\. The command prints the current kit file\.$/);
});

test('a git failure sends nothing, stores HEAD, and gives one event', async (t) => {
  const root = makeRepo(t);
  const base = gitSync(root, ['rev-parse', 'HEAD']);
  const head = commit(root, 'kit/models.md', 'Kit change');
  const real = recordingGit();
  const git = (args) => (args.includes('log') ? Promise.reject(new Error('git log failed')) : real(args));
  const result = await readKitNotice({ root, stored: { commit: base, at: 0 }, git, now: NOW });
  assert.equal(result.alert, null);
  assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV });
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
  assert.deepEqual(result.state, { commit: head, at: NOW, revision: REV });
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

test('kit notice targets skip the workspaces of held projects', () => {
  const orchs = [
    { id: 'wA:p1', workspace: 'wA', workspaceLabel: 'Alpha', label: 'orch', orch: true, agent: 'codex' },
    { id: 'wB:p1', workspace: 'wB', workspaceLabel: 'Beta', label: 'orch', orch: true, agent: 'codex' },
  ];
  assert.deepEqual(kitNoticeTargets(orchs, new Set(['wB'])).map((o) => o.id), ['wA:p1']);
  assert.deepEqual(kitNoticeTargets(orchs, new Set()).map((o) => o.id), ['wA:p1', 'wB:p1']);
});

test('heldWorkspaces lists paused, held, and stood-down projects', () => {
  const projects = [
    { slug: 'alpha', workspace: 'wA', status: 'active', summary: 'Building.' },
    { slug: 'beta', workspace: 'wB', status: 'paused', summary: 'Waiting.' },
    { slug: 'gamma', workspace: 'wC', status: 'active', summary: 'Stood down by the Owner until Monday.' },
    { slug: 'delta', workspace: 'wD', status: 'active', summary: 'Building.' },
  ];
  const control = { projects: { alpha: { workspace: 'wA', effectiveMode: 'auto' }, delta: { workspace: 'wD', effectiveMode: 'paused' } } };
  assert.deepEqual([...heldWorkspaces(projects, control)].sort(), ['wB', 'wC', 'wD']);
  assert.deepEqual([...heldWorkspaces([], null)], []);
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
    if (args.includes('log')) return args[2] === '--format=%h%x00' ? '' : (input.log || '');
    return args.includes('rev-parse') ? input.head + '\\n' : '';
  },
  kitRoot: input.kitRoot || '/kit-root',
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
  for (const [i, panes] of input.rounds.entries()) await engine.deliver([alert], { panes }, Date.parse('2026-09-27T10:00:00.000Z') + i * 60000, null, new Set((input.heldRounds ? input.heldRounds[i] : input.held) || []));
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

test('the kit notice skips the orchestrator of a held project', { timeout: 30000 }, (t) => {
  const alpha = { id: 'wA:p1', workspace: 'wA', workspaceLabel: 'Alpha', label: 'orch', orch: true, agent: 'codex', status: 'idle' };
  const beta = { id: 'wB:p1', workspace: 'wB', workspaceLabel: 'Beta', label: 'orch', orch: true, agent: 'claude', status: 'idle' };
  const out = runEngine(t, { mode: 'deliver', held: ['wB'], rounds: [[alpha, beta]] });
  const targets = out.prompts.filter((args) => args[0] === 'agent' && args[1] === 'prompt').map((args) => args[2]);
  assert.deepEqual(targets, ['wA:p1']);
});

test('a paused project gets no kit notice and gets it once when it resumes', { timeout: 30000 }, (t) => {
  const alpha = { id: 'wA:p1', workspace: 'wA', workspaceLabel: 'Alpha', label: 'orch', orch: true, agent: 'codex', status: 'idle' };
  const beta = { id: 'wB:p1', workspace: 'wB', workspaceLabel: 'Beta', label: 'orch', orch: true, agent: 'claude', status: 'idle' };
  const out = runEngine(t, { mode: 'deliver', heldRounds: [['wB'], ['wB'], [], []], rounds: [[alpha, beta], [alpha, beta], [alpha, beta], [alpha, beta]] });
  const targets = out.prompts.filter((args) => args[0] === 'agent' && args[1] === 'prompt').map((args) => args[2]);
  assert.deepEqual(targets, ['wA:p1', 'wB:p1']);
});

test('the engine stores the kit notice state and logs the queued notice', { timeout: 30000 }, (t) => {
  const base = 'a'.repeat(40);
  const head = 'c'.repeat(40);
  const out = runEngine(t, {
    mode: 'read',
    head,
    // A real kit root, so the notice takes the kit revision of the root that the engine supplies.
    kitRoot: repo,
    log: `ccccccc\x1fChange the kit\x1fChange the kit\n\n${'Kit-Impact: required'}\n\x00`,
    memory: { paneSince: {}, pushes: {}, notified: {}, kitNotice: { commit: base, at: 0 } },
  });
  assert.deepEqual(out.gitCalls, [
    ['-C', repo, 'rev-parse', 'HEAD'],
    ['-C', repo, 'merge-base', '--is-ancestor', base, head],
    ['-C', repo, 'log', '--format=%h%x1f%s%x1f%B%x00', `${base}..HEAD`, '--', 'kit', 'src/kit', 'docs/orchestrator-instructions.md'],
    ['-C', repo, 'log', '--format=%h%x00', `${base}..HEAD`, '--', 'kit/templates', 'kit/skills/herdr-orchestrator/SKILL.md', 'kit/skills/herdr-orchestrator/reference', 'kit/models.json', 'kit/watch'],
  ]);
  assert.equal(out.memoryKitNotice.commit, head);
  assert.equal(out.memoryKitNotice.alert.key, 'kit:ccccccc');
  assert.equal(out.memoryKitNotice.revision, kitRevision(repo));
  assert.match(out.memoryKitNotice.alert.text, new RegExp(`Kit revision ${kitRevision(repo)} \\(1 change\\(s\\)\\): Change the kit\\. Run herdr-boss kit update`));
  assert.deepEqual(out.events, ['Queued kit notice kit:ccccccc for each project orchestrator']);
});
