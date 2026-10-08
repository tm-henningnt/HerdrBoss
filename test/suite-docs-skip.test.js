import './helpers/test-env.js';
import { pinProject } from '../src/git-pins.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadProjectConfig } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { readSuitePasses } from '../src/kit/suite-passes.js';
import { POLICY_DEFAULTS } from '../src/control.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The fixture repository has a test that reads docs/read-by-test.md. Each run of the suite command adds a line to runs.log.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-docs-skip-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('README.md', 'seed\n');
  write('src/a.js', 'export const a = 1;\n');
  write('docs/guide.md', 'one\n');
  write('docs/read-by-test.md', 'one\n');
  write('docs/walked/x.md', 'one\n');
  write('test/a.test.js', "import fs from 'node:fs';\nfs.readFileSync('docs/read-by-test.md');\nfs.readdirSync('docs/walked');\n");
  write('package.json', '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ locks: POLICY_DEFAULTS.locks }));
  const config = loadProjectConfig({ cwd: root });
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [{ pane_id: 'ws:orch' }] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const runsLog = path.join(base, 'runs.log');
  const script = path.join(base, 'suite.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(runsLog)}, 'run\\n');\n`);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  pinProject({ slug: config.slug, repo: root }, { env });
  const lines = [];
  const suite = (flags = []) => runKitCommand('suite', [...flags, '--', process.execPath, script], {
    config, lockDataDir: dataDir, env, herdr, pidAlive: (pid) => pid === 601, output: (line) => lines.push(line), suiteStdio: 'ignore',
  });
  const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length : 0);
  const commit = (file, text) => { write(file, text); git(root, 'add', '.'); git(root, 'commit', '-m', `change ${file}`); };
  return { root, dataDir, lines, suite, runs, commit };
}

const SKIPPED = 'suite: skipped, only docs changed';

test('suite --skip-docs skips the run when only a doc that no test reads changed, and records it', (t) => {
  const f = fixture(t);
  f.suite();
  assert.equal(f.runs(), 1);
  f.commit('docs/guide.md', 'two\n');
  f.lines.length = 0;

  const result = f.suite(['--skip-docs']);

  assert.equal(result.exitCode, 0);
  assert.equal(f.runs(), 1);
  assert.ok(f.lines.includes(SKIPPED), f.lines.join('\n'));
  const records = readSuitePasses(f.dataDir);
  assert.equal(records.length, 2);
  assert.equal(records.at(-1).skipped, 'docs');
});

test('suite without --skip-docs still runs after a docs-only change', (t) => {
  const f = fixture(t);
  f.suite();
  f.commit('docs/guide.md', 'two\n');

  f.suite();

  assert.equal(f.runs(), 2);
  assert.ok(!f.lines.includes(SKIPPED));
});

test('suite --skip-docs runs when a changed file is under src, test, or is a package file', (t) => {
  for (const [file, text] of [['src/a.js', 'export const a = 2;\n'], ['test/b.test.js', 'x\n'], ['package.json', '{"a":1}\n'], ['kit/note.md', 'x\n']]) {
    const f = fixture(t);
    f.suite();
    f.commit(file, text);
    f.suite(['--skip-docs']);
    assert.equal(f.runs(), 2, file);
    assert.ok(!f.lines.includes(SKIPPED), file);
  }
});

test('suite --skip-docs runs when a test reads the changed doc by name or reads its folder', (t) => {
  for (const file of ['docs/read-by-test.md', 'docs/walked/x.md', 'README.md']) {
    const f = fixture(t);
    if (file === 'README.md') f.commit('test/readme.test.js', "fs.readFileSync('README.md');\n");
    f.suite();
    f.commit(file, 'changed\n');
    f.suite(['--skip-docs']);
    assert.equal(f.runs(), 2, file);
  }
});

test('suite --skip-docs runs when one changed file is not a doc', (t) => {
  const f = fixture(t);
  f.suite();
  fs.writeFileSync(path.join(f.root, 'docs/guide.md'), 'two\n');
  fs.writeFileSync(path.join(f.root, 'src/a.js'), 'export const a = 3;\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'both');

  f.suite(['--skip-docs']);

  assert.equal(f.runs(), 2);
});

test('suite --skip-docs runs when no earlier pass exists or the tree is dirty', (t) => {
  const f = fixture(t);
  f.suite(['--skip-docs']);
  assert.equal(f.runs(), 1);
  f.commit('docs/guide.md', 'two\n');
  fs.writeFileSync(path.join(f.root, 'src/a.js'), 'dirty\n');
  f.suite(['--skip-docs']);
  assert.equal(f.runs(), 2);
});

test('a skip chains: a second docs-only commit skips against the recorded skip', (t) => {
  const f = fixture(t);
  f.suite();
  f.commit('docs/guide.md', 'two\n');
  f.suite(['--skip-docs']);
  f.commit('docs/guide.md', 'three\n');
  f.suite(['--skip-docs']);
  assert.equal(f.runs(), 1);
});

// Each case commits files, runs the suite, commits the change, and expects a real run with --skip-docs.
function runsAfter(t, { before = [], change, symlink = null }) {
  const f = fixture(t);
  for (const [file, text] of before) f.commit(file, text);
  f.suite();
  if (symlink) {
    fs.symlinkSync(symlink.target, path.join(f.root, symlink.file));
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-m', 'link');
  } else {
    f.commit(change[0], change[1]);
  }
  f.suite(['--skip-docs']);
  return f.runs();
}

test('suite --skip-docs runs when a non-markdown file under docs changed', (t) => {
  assert.equal(runsAfter(t, { before: [['docs/contracts/x.json', '{}\n']], change: ['docs/contracts/x.json', '{"a":1}\n'] }), 2);
  assert.equal(runsAfter(t, { before: [['tickets/t.txt', 'a\n']], change: ['tickets/t.txt', 'b\n'] }), 2);
});

test('suite --skip-docs runs when src names the doc with a computed path', (t) => {
  assert.equal(runsAfter(t, {
    before: [['src/server.js', "const read = (name) => fs.readFileSync(`docs/${name}.md`);\nread('plan-notes');\n"], ['docs/plan-notes.md', 'a\n']],
    change: ['docs/plan-notes.md', 'b\n'],
  }), 2);
});

test('suite --skip-docs runs when src reads the doc at runtime', (t) => {
  assert.equal(runsAfter(t, {
    before: [['src/server.js', "fs.readFileSync(path.join(root, 'docs', 'project-status.md'));\n"], ['docs/project-status.md', 'a\n']],
    change: ['docs/project-status.md', 'b\n'],
  }), 2);
});

test('suite --skip-docs runs when public or kit names the doc', (t) => {
  for (const folder of ['public', 'kit']) {
    assert.equal(runsAfter(t, {
      before: [[`${folder}/x.js`, "load('docs/shown.md');\n"], ['docs/shown.md', 'a\n']],
      change: ['docs/shown.md', 'b\n'],
    }), 2, folder);
  }
});

test('suite --skip-docs runs when a changed doc is a symbolic link', (t) => {
  assert.equal(runsAfter(t, { symlink: { file: 'docs/link.md', target: '../src/a.js' } }), 2);
});
