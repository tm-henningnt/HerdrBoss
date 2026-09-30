import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { execFileSync } from 'node:child_process';
import { runProjectNew, addProjectPolicy, PROJECT_NEW_STEPS } from '../src/project-new.js';
import { validatePolicy } from '../src/control.js';
import { loadModels } from '../src/kit/config.js';
import { validateProject } from '../src/projects.js';
import { scanText } from '../src/secret-scan.js';

// Git reads its identity from a temporary global file, never from the machine.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-git-'));
const WITH_IDENTITY = path.join(GIT_HOME, 'with');
const WITHOUT_IDENTITY = path.join(GIT_HOME, 'without');
fs.writeFileSync(WITH_IDENTITY, '[user]\n\tname = Test User\n\temail = test@example.invalid\n');
fs.writeFileSync(WITHOUT_IDENTITY, '[user]\n\tuseConfigOnly = true\n');
process.env.GIT_CONFIG_GLOBAL = WITH_IDENTITY;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));
const gitOut = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-'));
  const dataDir = assertTempDataDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const repoRoot = path.join(root, 'boss-repo');
  fs.mkdirSync(repoRoot);
  return { root, dataDir, group, repoRoot, ceiling: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function tree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); out.push(path.relative(dir, f)); if (e.isDirectory()) walk(f); } };
  walk(dir);
  return out.sort();
}
const status = (result, name) => result.steps.find((s) => s.name === name)?.status;

test('refuses a bad slug', () => {
  const f = fixture();
  try {
    for (const slug of ['', 'Bad', '-x', 'a b', 'a/b', '../x']) {
      assert.throws(() => runProjectNew({ slug, group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /slug/i, slug);
    }
  } finally { f.cleanup(); }
});

test('needs --group or --path and refuses both', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew({ slug: 'demo', dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /--group|--path/);
    assert.throws(() => runProjectNew({ slug: 'demo', group: f.group, path: path.join(f.group, 'x'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /both|only one/i);
  } finally { f.cleanup(); }
});

test('refuses a path inside the Herdr Boss repository or the data dir', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew({ slug: 'demo', path: path.join(f.dataDir, 'demo'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /data dir/i);
    assert.throws(() => runProjectNew({ slug: 'demo', path: path.join(f.repoRoot, 'sub', 'demo'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /Herdr Boss repository/i);
  } finally { f.cleanup(); }
});

test('refuses a non-empty folder and an existing repository', () => {
  const f = fixture();
  try {
    const full = path.join(f.group, 'full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'a.txt'), 'x');
    assert.throws(() => runProjectNew({ slug: 'full', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /not empty/i);
    const repo = path.join(f.group, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    assert.throws(() => runProjectNew({ slug: 'repo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /repository|not empty/i);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
  } finally { f.cleanup(); }
});

test('refuses a registered slug', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([{ slug: 'taken', repo: '/somewhere', remote: '' }]));
    assert.throws(() => runProjectNew({ slug: 'taken', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /registered/i);
    fs.mkdirSync(path.join(f.dataDir, 'projects'));
    fs.writeFileSync(path.join(f.dataDir, 'projects', 'other.json'), '{}');
    assert.throws(() => runProjectNew({ slug: 'other', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /registered/i);
  } finally { f.cleanup(); }
});

test('dry run prints each step and changes nothing', () => {
  const f = fixture();
  try {
    const before = tree(f.root);
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.steps.map((s) => s.name), PROJECT_NEW_STEPS);
    for (const step of result.steps) assert.ok(step.detail, step.name);
    assert.deepEqual(tree(f.root), before);
    assert.equal(fs.existsSync(path.join(f.group, 'demo')), false);
  } finally { f.cleanup(); }
});

test('builds the folder and files, keeps later steps unbuilt, and writes a 0600 state file', () => {
  const f = fixture();
  try {
    const result = runProjectNew({ slug: 'demo', group: f.group, name: 'Demo', goal: 'Ship the demo.', dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    const dir = path.join(f.group, 'demo');
    assert.equal(result.ok, true);
    assert.equal(status(result, 'validate'), 'done');
    assert.equal(status(result, 'folder'), 'done');
    assert.equal(status(result, 'files'), 'done');
    assert.equal(status(result, 'kit'), 'done');
    assert.equal(status(result, 'commit'), 'done');
    assert.equal(status(result, 'harness'), 'skipped');
    assert.match(result.steps.find((s) => s.name === 'harness').detail, /not the live data dir/);
    assert.equal(status(result, 'check'), 'not-built');
    assert.equal(status(result, 'remote'), 'skipped');
    assert.match(result.steps.find((s) => s.name === 'remote').detail, /--remote none/);
    assert.equal(status(result, 'workspace'), 'skipped');
    assert.match(result.steps.find((s) => s.name === 'workspace').detail, /no --start/);
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Demo/);
    assert.match(agents, /herdr-boss:begin/);
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /Ship the demo\./);
    assert.match(fs.readFileSync(path.join(dir, 'docs/orchestration/memory.md'), 'utf8'), /^# Demo project memory/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.herdr-boss.json'), 'utf8')), { slug: 'demo' });
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.worker\//);
    const stateFile = path.join(f.dataDir, 'flows', 'demo.json');
    assert.equal(result.stateFile, stateFile);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(stateFile)).mode & 0o777, 0o700);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.steps.files.status, 'done');
    assert.equal(state.steps.kit.status, 'done');
    assert.equal(fs.existsSync(path.join(dir, 'flows')), false);
    assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /token|password|secret/i);
  } finally { f.cleanup(); }
});

test('a second run changes nothing', () => {
  const f = fixture();
  try {
    runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    const dir = path.join(f.group, 'demo');
    const stateFile = path.join(f.dataDir, 'flows', 'demo.json');
    const snapshot = () => [...tree(f.root)].map((rel) => { const p = path.join(f.root, rel); const s = fs.statSync(p); return `${rel}:${s.isFile() ? fs.readFileSync(p, 'utf8') : ''}:${s.mtimeMs}`; });
    const before = snapshot();
    const again = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, resume: true });
    assert.equal(again.ok, true);
    assert.equal(status(again, 'files'), 'done');
    assert.deepEqual(snapshot(), before);
    const third = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    assert.equal(third.ok, true);
    assert.deepEqual(snapshot(), before);
    assert.ok(fs.existsSync(dir) && fs.existsSync(stateFile));
  } finally { f.cleanup(); }
});

test('--resume without a state file is refused', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, resume: true }), /no state|nothing to resume/i);
  } finally { f.cleanup(); }
});

test('files step never overwrites an existing file', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    // The folder step runs first, so pre-create files by failing after the folder step.
    runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, stepRunners: { files: () => { throw new Error('stop'); } } });
    fs.writeFileSync(path.join(dir, 'README.md'), 'my readme\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mine\n');
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, resume: true });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'my readme\n');
    // The files step keeps the file. The kit step then adds the Herdr Boss stub after the heading.
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /^# Mine\n\n<!-- herdr-boss:begin/);
    assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  } finally { f.cleanup(); }
});

test('resume after a failure between two steps skips the finished step', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const failed = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, stepRunners: { files: () => { throw new Error('disk full'); } } });
    assert.equal(failed.ok, false);
    assert.equal(status(failed, 'folder'), 'done');
    assert.equal(status(failed, 'files'), 'failed');
    assert.match(failed.error, /disk full/);
    assert.equal(fs.statSync(failed.stateFile).mode & 0o777, 0o600);
    let folderRuns = 0;
    const resumed = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, resume: true, stepRunners: { folder: () => { folderRuns += 1; } } });
    assert.equal(folderRuns, 0);
    assert.equal(resumed.ok, true);
    assert.equal(status(resumed, 'files'), 'done');
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  } finally { f.cleanup(); }
});

test('a rerun with different inputs is refused', () => {
  const f = fixture();
  try {
    runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    assert.throws(() => runProjectNew({ slug: 'demo', path: path.join(f.group, 'elsewhere'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, resume: true }), /different|inputs/i);
  } finally { f.cleanup(); }
});

test('refuses a --group name that leaves the group', () => {
  const f = fixture();
  try {
    for (const name of ['../escape', 'a/b', '..', '.hidden', 'a\\b', '/abs']) {
      assert.throws(() => runProjectNew({ slug: 'demo', group: f.group, name, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /name/i, name);
    }
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
  } finally { f.cleanup(); }
});

test('refuses a symlinked target and a symlinked group that points into a guarded folder', () => {
  const f = fixture();
  try {
    const real = path.join(f.root, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(f.group, 'linked'));
    assert.throws(() => runProjectNew({ slug: 'linked', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /symlink/i);
    fs.symlinkSync(f.dataDir, path.join(f.root, 'datalink'));
    assert.throws(() => runProjectNew({ slug: 'demo', group: path.join(f.root, 'datalink'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /data dir/i);
    fs.symlinkSync(f.repoRoot, path.join(f.root, 'repolink'));
    assert.throws(() => runProjectNew({ slug: 'demo', path: path.join(f.root, 'repolink', 'x'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /Herdr Boss repository/i);
    assert.deepEqual(fs.readdirSync(real), []);
    assert.deepEqual(fs.readdirSync(f.dataDir), []);
  } finally { f.cleanup(); }
});

test('refuses a target inside another Git repository', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.group, '.git'));
    assert.throws(() => runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /inside another Git repository/i);
    assert.throws(() => runProjectNew({ slug: 'deep', path: path.join(f.group, 'a', 'b', 'deep'), dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling }), /inside another Git repository/i);
    assert.equal(fs.existsSync(path.join(f.group, 'demo')), false);
    assert.equal(fs.existsSync(path.join(f.group, 'a')), false);
  } finally { f.cleanup(); }
});

test('the state temp file never follows a planted symlink', () => {
  const f = fixture();
  try {
    const victim = path.join(f.root, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.mkdirSync(path.join(f.dataDir, 'flows'));
    fs.symlinkSync(victim, path.join(f.dataDir, 'flows', 'demo.json.tmp'));
    const result = runProjectNew({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.equal(fs.statSync(result.stateFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'flows')).filter((n) => n !== 'demo.json.tmp'), ['demo.json']);
  } finally { f.cleanup(); }
});

const base = (f, extra = {}) => ({ slug: 'demo', group: f.group, dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, ...extra });

test('the kit step writes the kit file and the hook inside the project and a rerun changes nothing', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const result = runProjectNew(base(f));
    assert.equal(status(result, 'kit'), 'done');
    assert.match(fs.readFileSync(path.join(dir, 'docs/orchestration/herdr-boss.md'), 'utf8'), /herdr-boss kit v=/);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /herdr-boss\.md/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /herdr-boss:begin/);
    // Forget the kit step, then repeat it: the files stay byte for byte and keep their mtime.
    const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
    delete state.steps.kit;
    fs.writeFileSync(result.stateFile, JSON.stringify(state));
    const files = ['docs/orchestration/herdr-boss.md', '.claude/settings.json', 'AGENTS.md'];
    const snap = () => files.map((r) => `${fs.readFileSync(path.join(dir, r), 'utf8')}:${fs.statSync(path.join(dir, r)).mtimeMs}`);
    const before = snap();
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(status(again, 'kit'), 'done');
    assert.match(again.steps.find((s) => s.name === 'kit').detail, /wrote 0 files/);
    assert.deepEqual(snap(), before);
    assert.deepEqual(fs.readdirSync(f.group), ['demo']);
  } finally { f.cleanup(); }
});

test('the commit step makes one commit with the plain message and no trailer', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const result = runProjectNew(base(f));
    assert.equal(status(result, 'commit'), 'done');
    assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(gitOut(dir, 'log', '-1', '--format=%B'), 'Set up the project with Herdr Boss');
    assert.equal(gitOut(dir, 'log', '-1', '--format=%an <%ae>'), 'Test User <test@example.invalid>');
    assert.equal(gitOut(dir, 'status', '--porcelain'), '');
    assert.match(gitOut(dir, 'ls-files'), /\.claude\/settings\.json/);
    const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
    delete state.steps.commit;
    fs.writeFileSync(result.stateFile, JSON.stringify(state));
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(status(again, 'commit'), 'done');
    assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1');
  } finally { f.cleanup(); }
});

test('a token in a file stops the commit, names the file and class, and leaves the files unstaged', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const token = `gh${'p_'}${'a1B2c3D4e5'.repeat(4)}`;
    const failed = runProjectNew(base(f, { stepRunners: { files: (inputs) => {
      fs.writeFileSync(path.join(inputs.path, 'notes.md'), `key: ${token}\n`);
      fs.writeFileSync(path.join(inputs.path, '.env'), 'A=1\n');
      fs.writeFileSync(path.join(inputs.path, 'README.md'), 'hello\n');
    } } }));
    assert.equal(failed.ok, false);
    assert.equal(status(failed, 'commit'), 'failed');
    assert.match(failed.error, /notes\.md: GitHub token/);
    assert.match(failed.error, /\.env: \.env file/);
    assert.doesNotMatch(JSON.stringify(failed) + fs.readFileSync(failed.stateFile, 'utf8'), new RegExp(token));
    assert.equal(gitOut(dir, 'diff', '--cached', '--name-only'), '');
    assert.throws(() => gitOut(dir, 'rev-parse', '--verify', '-q', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), `key: ${token}\n`);
    fs.rmSync(path.join(dir, 'notes.md'));
    fs.rmSync(path.join(dir, '.env'));
    const fixed = runProjectNew(base(f, { resume: true }));
    assert.equal(fixed.ok, true);
    assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1');
  } finally { f.cleanup(); }
});

test('a missing Git identity fails the commit step and sets no identity', () => {
  const f = fixture();
  process.env.GIT_CONFIG_GLOBAL = WITHOUT_IDENTITY;
  try {
    const dir = path.join(f.group, 'demo');
    const failed = runProjectNew(base(f));
    assert.equal(failed.ok, false);
    assert.equal(status(failed, 'kit'), 'done');
    assert.equal(status(failed, 'commit'), 'failed');
    assert.match(failed.error, /user\.name|user\.email/);
    assert.throws(() => gitOut(dir, 'rev-parse', '--verify', '-q', 'HEAD'));
    assert.equal(fs.readFileSync(WITHOUT_IDENTITY, 'utf8'), '[user]\n\tuseConfigOnly = true\n');
    process.env.GIT_CONFIG_GLOBAL = WITH_IDENTITY;
    assert.equal(runProjectNew(base(f, { resume: true })).ok, true);
  } finally { process.env.GIT_CONFIG_GLOBAL = WITH_IDENTITY; f.cleanup(); }
});

test('dry run describes the kit and commit steps and runs neither', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { dryRun: true }));
    for (const name of ['kit', 'commit']) {
      assert.equal(status(result, name), 'planned');
      assert.match(result.steps.find((s) => s.name === name).detail, /^would /);
    }
    assert.equal(fs.existsSync(path.join(f.group, 'demo')), false);
  } finally { f.cleanup(); }
});

test('scanText names the class for each secret pattern and skips clean text', () => {
  const cases = {
    'private key': '-----BEGIN RSA ' + 'PRIVATE KEY-----',
    'GitHub token': `gh${'o_'}${'x'.repeat(30)}`,
    'AWS access key': `id AK${'IA'}0123456789ABCDEF`,
    'Slack token': `xox${'b-'}1234567890-abcdef`,
    'credential assignment': `api${'_key'} = "abcdef0123456789abcdef"`,
  };
  for (const [name, text] of Object.entries(cases)) assert.deepEqual(scanText('a.txt', text), [name], name);
  assert.deepEqual(scanText('config/.env', 'A=1'), ['.env file']);
  assert.deepEqual(scanText('.env.example', 'A=1'), []);
  assert.deepEqual(scanText('a.md', 'Set the token with `herdr-boss token`. password = "x"'), []);
});

test('a rerun after a refusal refuses again while the secret stays and passes when it is gone', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const planted = { files: (inputs) => { fs.writeFileSync(path.join(inputs.path, 'a.txt'), `xox${'b-'}1234567890-abcdef\n`); } };
    const first = runProjectNew(base(f, { stepRunners: planted }));
    assert.equal(first.ok, false);
    const second = runProjectNew(base(f, { resume: true }));
    assert.equal(second.ok, false);
    assert.match(second.error, /a\.txt: Slack token/);
    assert.equal(gitOut(dir, 'diff', '--cached', '--name-only'), '');
    fs.rmSync(path.join(dir, 'a.txt'));
    assert.equal(runProjectNew(base(f, { resume: true })).ok, true);
    assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1');
  } finally { f.cleanup(); }
});

test('a binary or large file is refused as unscanned unless it is on the allow list', () => {
  const f = fixture();
  try {
    const dir = path.join(f.group, 'demo');
    const plant = { files: (inputs) => {
      fs.writeFileSync(path.join(inputs.path, 'blob.bin'), Buffer.from([1, 0, 2]));
      fs.writeFileSync(path.join(inputs.path, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    } };
    const failed = runProjectNew(base(f, { stepRunners: plant }));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /blob\.bin: unscanned large or binary file/);
    assert.match(failed.error, /big\.txt: unscanned large or binary file/);
    assert.equal(gitOut(dir, 'diff', '--cached', '--name-only'), '');
    const allowed = runProjectNew(base(f, { resume: true, allowUnscanned: ['blob.bin', 'big.txt'] }));
    assert.equal(allowed.ok, true);
  } finally { f.cleanup(); }
});

test('scanText finishes a 200k character line in under one second', () => {
  const start = process.hrtime.bigint();
  assert.deepEqual(scanText('a.txt', 'a-'.repeat(100000)), []);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e9 < 1);
});

const entry = (share, extra = {}) => ({ share, mode: 'auto', excludedKinds: [], excludedModels: [], ...extra });
const total = (projects) => Object.values(projects).reduce((sum, p) => sum + p.share, 0);
const forget = (f, ...names) => {
  const file = path.join(f.dataDir, 'flows', 'demo.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of names) delete state.steps[name];
  fs.writeFileSync(file, JSON.stringify(state));
};
const writePolicyFile = (f, projects) => fs.writeFileSync(path.join(f.dataDir, 'policy.json'), `${JSON.stringify({ projects })}\n`);
const readPolicyFile = (f) => JSON.parse(fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8'));

test('addProjectPolicy adds an entry with share 10 and keeps the total at most 100', () => {
  const result = addProjectPolicy({ projects: { a: entry(50), b: entry(50, { mode: 'paused', excludedKinds: ['pi'] }) } }, 'demo');
  assert.equal(result.changed, true);
  assert.equal(result.policy.projects.demo.share, 10);
  assert.ok(total(result.policy.projects) <= 100);
  assert.deepEqual(result.before, { a: 50, b: 50 });
  assert.deepEqual(result.after, { a: 45, b: 45, demo: 10 });
  assert.equal(result.policy.projects.b.mode, 'paused');
  assert.deepEqual(result.policy.projects.b.excludedKinds, ['pi']);
  assert.equal(validatePolicy({ ...structuredClone(addProjectPolicy({ projects: {} }, 'x').policy) }, loadModels()).some((e) => /share/.test(e)), false);
});

test('addProjectPolicy leaves shares alone when there is room', () => {
  const result = addProjectPolicy({ projects: { a: entry(30), b: entry(0) } }, 'demo');
  assert.deepEqual(result.after, { a: 30, b: 0, demo: 10 });
});

test('addProjectPolicy rounds down with integers and refuses a share that would fall below 1', () => {
  const rounded = addProjectPolicy({ projects: { a: entry(33), b: entry(33), c: entry(34) } }, 'demo');
  for (const share of Object.values(rounded.after)) assert.ok(Number.isInteger(share));
  assert.ok(total(rounded.policy.projects) <= 100);
  const many = {};
  for (let i = 0; i < 100; i += 1) many[`p${i}`] = entry(1);
  assert.throws(() => addProjectPolicy({ projects: many }, 'demo'), /below 1/);
});

test('addProjectPolicy does not change the input and is idempotent', () => {
  const input = { projects: { a: entry(95) } };
  const first = addProjectPolicy(input, 'demo');
  assert.equal(input.projects.a.share, 95);
  const second = addProjectPolicy(first.policy, 'demo');
  assert.equal(second.changed, false);
  assert.deepEqual(second.policy, first.policy);
});

test('the policy step writes the temp policy file, keeps other fields, and a rerun changes nothing', () => {
  const f = fixture();
  try {
    writePolicyFile(f, { a: entry(60, { mode: 'idle' }), b: entry(40, { excludedKinds: ['pi'] }) });
    const result = runProjectNew(base(f));
    assert.equal(result.ok, true);
    assert.equal(status(result, 'policy'), 'done');
    assert.match(result.steps.find((s) => s.name === 'policy').detail, /Shares before: a 60, b 40\. Shares after: a 54, b 36, demo 10/);
    const policy = readPolicyFile(f);
    assert.equal(policy.projects.demo.share, 10);
    assert.ok(total(policy.projects) <= 100);
    assert.equal(policy.projects.a.mode, 'idle');
    assert.deepEqual(policy.projects.b.excludedKinds, ['pi']);
    const text = fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8');
    forget(f, 'policy');
    const again = runProjectNew(base(f));
    assert.equal(again.ok, true);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8'), text);
    assert.match(again.steps.find((s) => s.name === 'policy').detail, /already/);
  } finally { f.cleanup(); }
});

test('the policy step fails when a share would fall below 1 and writes nothing', () => {
  const f = fixture();
  try {
    const many = {};
    for (let i = 0; i < 100; i += 1) many[`p${i}`] = entry(1);
    writePolicyFile(f, many);
    const before = fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8');
    const result = runProjectNew(base(f));
    assert.equal(result.ok, false);
    assert.equal(status(result, 'policy'), 'failed');
    assert.match(result.error, /below 1/);
    assert.equal(status(result, 'register'), 'pending');
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('the register step writes only the temp project-repos file and a rerun keeps it', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f));
    assert.equal(status(result, 'register'), 'done');
    const rows = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'project-repos.json'), 'utf8'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, 'demo');
    assert.equal(rows[0].repo, fs.realpathSync(path.join(f.group, 'demo')));
    assert.equal(rows[0].remote, '');
    assert.equal(fs.statSync(path.join(f.dataDir, 'project-repos.json')).mode & 0o777, 0o600);
    forget(f, 'register');
    const again = runProjectNew(base(f));
    assert.match(again.steps.find((s) => s.name === 'register').detail, /already/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'project-repos.json'), 'utf8')).length, 1);
  } finally { f.cleanup(); }
});

test('the status step publishes a valid first status into the temp data dir', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { name: 'Demo', goal: 'Ship the demo.' }));
    assert.equal(status(result, 'status'), 'done');
    const file = path.join(f.dataDir, 'projects', 'demo.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(validateProject(data), []);
    assert.equal(data.summary, 'New project. Set up the project.');
    assert.equal(data.goal, 'Ship the demo.');
    assert.match(data.kitRevision, /^[0-9a-f]{12}$/);
    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].title, 'Set up the project');
    assert.equal(data.tasks[0].status, 'todo');
    assert.equal(data.tasks[0].priority, 1);
    const text = fs.readFileSync(file, 'utf8');
    forget(f, 'status');
    const again = runProjectNew(base(f, { name: 'Demo', goal: 'Ship the demo.' }));
    assert.match(again.steps.find((s) => s.name === 'status').detail, /already/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally { f.cleanup(); }
});

test('the status step leaves out the goal without --goal', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'projects', 'demo.json'), 'utf8')), 'goal'), false);
  } finally { f.cleanup(); }
});

test('a dry run names the policy, register, and status steps and writes nothing', () => {
  const f = fixture();
  try {
    writePolicyFile(f, { a: entry(100) });
    const before = tree(f.root);
    const text = fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8');
    const result = runProjectNew(base(f, { dryRun: true }));
    for (const name of ['policy', 'register', 'status']) {
      assert.equal(status(result, name), 'planned', name);
      assert.doesNotMatch(result.steps.find((s) => s.name === name).detail, /not built yet/);
    }
    assert.deepEqual(tree(f.root), before);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'policy.json'), 'utf8'), text);
  } finally { f.cleanup(); }
});

test('addProjectPolicy refuses a share that is missing or not a whole number', () => {
  for (const bad of [undefined, 1.5, '20', -1, null]) {
    assert.throws(() => addProjectPolicy({ projects: { a: { ...entry(50), share: bad }, b: entry(60) } }, 'demo'), /whole number/, String(bad));
  }
});

test('the register step refuses a slug that is registered to another folder', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    const file = path.join(f.dataDir, 'project-repos.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows[0].repo = path.join(f.root, 'elsewhere');
    fs.writeFileSync(file, JSON.stringify(rows));
    forget(f, 'register');
    const again = runProjectNew(base(f));
    assert.equal(again.ok, false);
    assert.equal(status(again, 'register'), 'failed');
    assert.match(again.error, /another folder/);
    assert.equal(status(again, 'status'), 'pending');
  } finally { f.cleanup(); }
});
