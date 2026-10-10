import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { collectWorker, commitWorker } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

function fixture(t) {
  const f = setupFixture(null);
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.orchestration/\naudit-data/\n');
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-m', 'fixture configuration');
  t.after(() => {
    for (const run of f.runs ?? []) {
      if (run.worktree !== f.root) git(f.root, 'worktree', 'remove', '--force', run.worktree);
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  f.runs = [];
  return f;
}

function change(root, relative, body = 'worker change\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function inheritedBranch(f) {
  git(f.root, 'checkout', '-b', 'integration');
  change(f.root, 'docs/inherited.md', 'inherited change\n');
  git(f.root, 'add', 'docs/inherited.md');
  git(f.root, 'commit', '-m', 'inherited documentation');
  change(f.root, 'public/inherited.css', 'inherited style\n');
  git(f.root, 'add', 'public/inherited.css');
  git(f.root, 'commit', '-m', 'inherited style');
  return git(f.root, 'rev-parse', 'HEAD');
}

function start(f, name, options = {}, deps = {}) {
  const run = startWorker(name, { kind: 'codex', task: 'baseline regression', allow: ['src/'], ...options }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env,
    rulesFile: f.rulesFile, output: () => {}, ...deps,
  });
  f.runs.push(run);
  return run;
}

function report(run, paths) {
  const dir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(dir, 'report.md'), 'Worker report.\n');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: paths,
    commands: ['scoped check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
}

function collect(f, run, options = {}) {
  return collectWorker(run.name, { noRecord: true, ...options }, {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    leaseDataDir: path.join(f.root, 'audit-data'),
  });
}

function legacy(run) {
  const record = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  delete record.startCommit;
  fs.writeFileSync(run.recordFile, JSON.stringify(record));
}

function cli(f, run, action, args) {
  return runKitCommand('worker', [action, run.name, ...(action === 'commit' ? ['-m', 'explicit worker change'] : ['--no-record']), ...args], {
    config: f.config, output: () => {}, listWorktreeProcesses: () => [],
    lockDataDir: path.join(f.root, 'audit-data'),
  });
}

test('worker start records the start commit before launch and commits six scoped paths from an advanced base', (t) => {
  const f = fixture(t);
  const head = inheritedBranch(f);
  const paths = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js'];
  let starting;
  const run = start(f, 'advanced-base', { base: 'integration', allow: paths }, {
    herdr: (args) => {
      if (args[0] === 'agent' && args[1] === 'start') {
        starting = JSON.parse(fs.readFileSync(path.join(f.config.runsPath, 'advanced-base.json'), 'utf8'));
      }
      return f.herdr(args);
    },
  });
  assert.equal(starting.state, 'starting');
  assert.equal(starting.startCommit, head);
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).startCommit, head);
  for (const relative of paths) change(run.worktree, relative);
  const result = commitWorker(run.name, { message: 'six worker paths' }, { config: f.config, output: () => {} });
  assert.deepEqual(result.paths.sort(), paths);
  assert.deepEqual(git(run.worktree, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), paths);
  assert.equal(git(run.worktree, 'rev-list', '--count', `${head}..HEAD`), '1');
  report(run, paths);
  const summary = collect(f, run);
  assert.deepEqual(summary.actualPaths.sort(), paths);
  assert.equal(summary.commits.length, 1);
  assert.match(summary.commits[0], /six worker paths/);
});

test('a no-worktree continuation commits and collects only work after its start', (t) => {
  const f = fixture(t);
  const head = inheritedBranch(f);
  const run = start(f, 'continuation', { noWorktree: true });
  change(run.worktree, 'src/continuation.js');
  const result = commitWorker(run.name, { message: 'continuation work' }, { config: f.config, output: () => {} });
  assert.deepEqual(result.paths, ['src/continuation.js']);
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).startCommit, head);
  report(run, result.paths);
  const summary = collect(f, run);
  assert.deepEqual(summary.actualPaths, ['src/continuation.js']);
  assert.equal(summary.commits.length, 1);
  assert.match(summary.commits[0], /continuation work/);
  assert.equal(git(run.worktree, 'rev-list', '--count', `${head}..HEAD`), '1');
});

test('commit and collect name the baseline repair when an old record has no start commit', (t) => {
  const f = fixture(t);
  const run = start(f, 'missing-baseline');
  legacy(run);
  change(run.worktree, 'src/change.js');
  report(run, ['src/change.js']);
  const head = git(run.worktree, 'rev-parse', 'HEAD');
  for (const command of [
    () => commitWorker(run.name, { message: 'worker change' }, { config: f.config, output: () => {} }),
    () => collect(f, run),
  ]) {
    assert.throws(command, (error) => /no.*baseline/i.test(error.message)
      && error.message.includes('worker baseline missing-baseline')
      && error.message.includes('--baseline COMMIT') && error.message.includes('--base COMMIT'));
  }
  assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(run.worktree, 'diff', '--cached', '--name-only'), '');
});

test('worker baseline records the merge-base with the recorded base and restores an old run', (t) => {
  const f = fixture(t);
  const head = inheritedBranch(f);
  const run = start(f, 'repair-default', { base: 'integration' });
  legacy(run);
  change(run.worktree, 'src/change.js');
  git(run.worktree, 'add', 'src/change.js');
  git(run.worktree, 'commit', '-m', 'worker change');
  // The named base moves after start. The current merge-base still identifies the start.
  change(f.root, 'docs/later.md');
  git(f.root, 'add', 'docs/later.md');
  git(f.root, 'commit', '-m', 'later integration change');
  runKitCommand('worker', ['baseline', run.name], { config: f.config, output: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).startCommit, head);
  report(run, ['src/change.js']);
  const summary = collect(f, run);
  assert.deepEqual(summary.actualPaths, ['src/change.js']);
  assert.equal(summary.commits.length, 1);
});

test('worker baseline accepts an explicit start commit for a no-worktree continuation', (t) => {
  const f = fixture(t);
  const head = inheritedBranch(f);
  const run = start(f, 'repair-continuation', { noWorktree: true });
  legacy(run);
  runKitCommand('worker', ['baseline', run.name, '--commit', head], { config: f.config, output: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).startCommit, head);
  change(run.worktree, 'src/change.js');
  assert.deepEqual(commitWorker(run.name, { message: 'worker change' }, { config: f.config, output: () => {} }).paths, ['src/change.js']);
});

for (const action of ['commit', 'collect']) {
  test(`worker ${action} accepts an explicit ancestor baseline and audits its masked reason`, (t) => {
    const f = fixture(t);
    const head = inheritedBranch(f);
    const run = start(f, `override-${action}`, { base: 'integration' });
    legacy(run);
    change(run.worktree, 'src/change.js');
    if (action === 'collect') {
      git(run.worktree, 'add', 'src/change.js');
      git(run.worktree, 'commit', '-m', 'own worker change');
    }
    report(run, ['src/change.js']);
    const result = cli(f, run, action, ['--baseline', head, '--reason', 'repair api_key="sample"']);
    assert.deepEqual(action === 'commit' ? result.paths : result.actualPaths, ['src/change.js']);
    if (action === 'collect') {
      assert.equal(result.commits.length, 1);
      assert.match(result.commits[0], /own worker change/);
    }
    const audit = fs.readFileSync(path.join(f.root, 'audit-data/action-audit.jsonl'), 'utf8');
    const rows = audit.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workerName, run.name);
    assert.equal(rows[0].commit, head);
    assert.equal(rows[0].command, `worker ${action}`);
    assert.equal(rows[0].refusalKind, 'baseline');
    assert.equal(rows[0].reason, 'repair api_key=[REDACTED]');
    assert.ok(Number.isFinite(Date.parse(rows[0].time)));
    assert.doesNotMatch(audit, /sample/);
    assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).startCommit, undefined, 'an override does not replace the run baseline');
  });

  test(`worker ${action} refuses a non-ancestor or invalid explicit baseline and requires a reason`, (t) => {
    const f = fixture(t);
    const run = start(f, `invalid-${action}`);
    const head = git(run.worktree, 'rev-parse', 'HEAD');
    const sibling = inheritedBranch(f);
    change(run.worktree, 'src/change.js');
    report(run, ['src/change.js']);
    assert.throws(() => cli(f, run, action, ['--baseline', sibling, '--reason', 'repair']), /not an ancestor of the worker HEAD/);
    assert.throws(() => cli(f, run, action, ['--baseline', 'missing-ref', '--reason', 'repair']), /does not name a commit/);
    assert.throws(() => cli(f, run, action, ['--baseline', head]), /needs --reason TEXT/);
    assert.throws(() => cli(f, run, action, ['--baseline', head, '--reason', 'x'.repeat(301)]), /1 to 300 characters/);
    assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(run.worktree, 'diff', '--cached', '--name-only'), '');
    assert.equal(fs.existsSync(path.join(f.root, 'audit-data/action-audit.jsonl')), false);
  });

  test(`worker ${action} refuses an outside path with a recorded or explicit baseline`, (t) => {
    const f = fixture(t);
    const run = start(f, `scope-${action}`);
    const head = git(run.worktree, 'rev-parse', 'HEAD');
    change(run.worktree, 'src/change.js');
    change(run.worktree, 'docs/outside.md');
    report(run, ['src/change.js', 'docs/outside.md']);
    assert.throws(() => cli(f, run, action, []), /outside its allowed scope: docs\/outside\.md/);
    assert.throws(() => cli(f, run, action, ['--baseline', head, '--reason', 'repair']), /outside its allowed scope: docs\/outside\.md/);
    if (action === 'collect') {
      assert.throws(() => cli(f, run, action, ['--baseline', head, '--reason', 'repair', '--accept-scope', 'docs/outside.md']), /outside its allowed scope: docs\/outside\.md/);
      assert.throws(() => cli(f, run, action, ['--baseline', head, '--reason', 'repair', '--allow', 'docs/']), /outside its allowed scope: docs\/outside\.md/);
    }
    assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(run.worktree, 'diff', '--cached', '--name-only'), '');
    assert.equal(fs.existsSync(path.join(f.root, 'audit-data/action-audit.jsonl')), false);
  });
}

test('worker commit keeps --base as an audited alias for --baseline', (t) => {
  const f = fixture(t);
  const run = start(f, 'base-alias');
  const head = git(run.worktree, 'rev-parse', 'HEAD');
  legacy(run);
  change(run.worktree, 'src/change.js');
  assert.throws(() => cli(f, run, 'commit', ['--base', head, '--baseline', head, '--reason', 'repair']), /not both/);
  const result = cli(f, run, 'commit', ['--base', head, '--reason', 'repair']);
  assert.deepEqual(result.paths, ['src/change.js']);
  const row = JSON.parse(fs.readFileSync(path.join(f.root, 'audit-data/action-audit.jsonl'), 'utf8').trim());
  assert.equal(row.commit, head);
});

test('worker baseline refuses a non-ancestor commit without changing the run record', (t) => {
  const f = fixture(t);
  const run = start(f, 'repair-refused');
  legacy(run);
  const sibling = inheritedBranch(f);
  const before = fs.readFileSync(run.recordFile, 'utf8');
  assert.throws(() => runKitCommand('worker', ['baseline', run.name, '--commit', sibling], {
    config: f.config, output: () => {},
  }), /not an ancestor of the worker HEAD/);
  assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before);
});

test('a failed baseline audit stops commit and collection before Git or ledger writes', (t) => {
  for (const action of ['commit', 'collect']) {
    const f = fixture(t);
    const run = start(f, `audit-refused-${action}`);
    const head = git(run.worktree, 'rev-parse', 'HEAD');
    const before = fs.readFileSync(run.recordFile, 'utf8');
    change(run.worktree, 'src/change.js');
    report(run, ['src/change.js']);
    fs.writeFileSync(path.join(f.root, 'audit-data'), 'not a directory\n');
    assert.throws(() => cli(f, run, action, ['--baseline', head, '--reason', 'repair']), /EEXIST/);
    assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(run.worktree, 'diff', '--cached', '--name-only'), '');
    assert.equal(fs.readFileSync(run.recordFile, 'utf8'), before);
    assert.equal(fs.existsSync(f.config.ledgerPath), false);
  }
});
