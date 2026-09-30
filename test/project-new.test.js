import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { runProjectNew, PROJECT_NEW_STEPS } from '../src/project-new.js';

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
    for (const name of ['kit', 'commit', 'remote', 'policy', 'register', 'workspace']) {
      assert.equal(status(result, name), 'not-built', name);
      assert.match(result.steps.find((s) => s.name === name).detail, /not built yet/);
    }
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
    assert.equal(state.steps.kit, undefined);
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
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Mine\n');
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
