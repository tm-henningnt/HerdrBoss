import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { startWorker } from './helpers/start-worker.js';
import { git, setupFixture, TEST_HOME } from './helpers/kit-fixture.js';

const kitBrief = path.resolve('kit/templates/worker-brief.md');

function options(f) {
  f.config.briefTemplatePath = kitBrief;
  return { config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {} };
}

function commitFeature(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'checkout', '-b', 'review-target');
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'export const feature = 1;\n');
  git(root, 'add', 'src/feature.js');
  git(root, 'commit', '-m', 'add feature');
  git(root, 'checkout', 'main');
}

// A sibling Git worktree of the fixture repository, so the target is not the worker worktree.
function targetWorktree(f, name, branch) {
  const target = path.join(path.dirname(f.root), `${path.basename(f.root)}-${name}`);
  git(f.root, 'worktree', 'add', '-b', branch, target, 'main');
  return target;
}

test('worker start copies the branch diff and changed file list for a read-only review worker', () => {
  const f = setupFixture(null);
  commitFeature(f.root);
  const run = startWorker('reviewer-branch', { kind: 'codex', task: 'review the branch', readOnly: true, base: 'review-target' }, options(f));

  const patch = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review.diff'), 'utf8');
  assert.match(patch, /diff --git a\/src\/feature\.js b\/src\/feature\.js/);
  assert.match(patch, /export const feature = 1;/);
  const list = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review-files.txt'), 'utf8');
  assert.equal(list, 'src/feature.js\n');

  const brief = fs.readFileSync(path.join(run.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /## Review inputs\n/);
  assert.match(brief, /review-target/);
  assert.match(brief, /\.worker\/inputs\/review\.diff/);
  assert.match(brief, /\.worker\/inputs\/review-files\.txt/);
  assert.match(brief, /Do not read another worktree\./);
});

test('worker start copies the diff and status of an uncommitted review worktree', () => {
  const f = setupFixture(null);
  const target = targetWorktree(f, 'review', 'review-work');
  fs.appendFileSync(path.join(target, 'README.md'), 'pending review change\n');
  const run = startWorker('reviewer-worktree', { kind: 'codex', task: 'review the worktree', readOnly: true, reviewWorktree: target }, options(f));

  const patch = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review.diff'), 'utf8');
  assert.match(patch, /pending review change/);
  const status = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review-status.txt'), 'utf8');
  assert.match(status, /modified:\s+README\.md/);
  assert.equal(fs.existsSync(path.join(run.worktree, '.worker/inputs/review-files.txt')), false);

  const brief = fs.readFileSync(path.join(run.worktree, '.worker/brief.md'), 'utf8');
  assert.match(brief, /\.worker\/inputs\/review-status\.txt/);
  assert.match(brief, /Do not read another worktree\./);
});

test('worker start copies staged-only and mixed uncommitted edits of a review worktree', () => {
  const f = setupFixture(null);
  const target = targetWorktree(f, 'stage', 'review-stage');
  fs.writeFileSync(path.join(target, 'staged.txt'), 'staged only\n');
  git(target, 'add', 'staged.txt');
  fs.appendFileSync(path.join(target, 'README.md'), 'unstaged edit\n');
  fs.writeFileSync(path.join(target, 'mixed.txt'), 'mixed first\n');
  git(target, 'add', 'mixed.txt');
  fs.appendFileSync(path.join(target, 'mixed.txt'), 'mixed second\n');

  const run = startWorker('reviewer-stage', { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: target }, options(f));
  const patch = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review.diff'), 'utf8');
  assert.match(patch, /staged only/);
  assert.match(patch, /unstaged edit/);
  assert.match(patch, /mixed first/);
  assert.match(patch, /mixed second/);
});

test('worker start keeps a binary worktree diff and an empty diff as review files', () => {
  const f = setupFixture(null);
  const binary = targetWorktree(f, 'binary', 'review-binary');
  fs.writeFileSync(path.join(binary, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(binary, 'add', 'blob.bin');
  const run = startWorker('reviewer-binary', { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: binary }, options(f));
  assert.match(fs.readFileSync(path.join(run.worktree, '.worker/inputs/review.diff'), 'utf8'), /Binary files/);

  const clean = targetWorktree(f, 'empty', 'review-empty');
  const emptyRun = startWorker('reviewer-empty', { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: clean }, options(f));
  assert.equal(fs.readFileSync(path.join(emptyRun.worktree, '.worker/inputs/review.diff'), 'utf8'), '');
});

test('worker start refuses --review-worktree for a worker that may write', () => {
  const f = setupFixture(null);
  const target = targetWorktree(f, 'write', 'review-write');
  fs.appendFileSync(path.join(target, 'README.md'), 'pending\n');
  assert.throws(
    () => startWorker('reviewer-write', { kind: 'codex', task: 'x', allow: ['src/'], reviewWorktree: target }, options(f)),
    /--review-worktree needs --read-only/,
  );
  assert.equal(fs.existsSync(f.config.worktreePath('reviewer-write')), false, 'the refusal leaves no worker worktree');

  assert.throws(
    () => runKitCommand('worker', ['start', 'reviewer-cli-write', '--kind', 'codex', '--task', 'x', '--allow', 'src/', '--review-worktree', target], {
      config: f.config, herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
      freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }),
    }),
    /--review-worktree needs --read-only/,
  );
});

test('worker start refuses --base and --review-worktree even when --base is the project base branch', () => {
  const f = setupFixture(null);
  const target = targetWorktree(f, 'bothmain', 'review-both-main');
  fs.appendFileSync(path.join(target, 'README.md'), 'pending\n');
  assert.throws(
    () => startWorker('reviewer-both-main', { kind: 'codex', task: 'x', readOnly: true, base: 'main', reviewWorktree: target }, options(f)),
    /Give --base BRANCH or --review-worktree PATH, not both/,
  );
  assert.equal(fs.existsSync(f.config.worktreePath('reviewer-both-main')), false, 'the refusal leaves no worker worktree');
});

test('worker start refuses a worktree review with a tracked secret or config path', () => {
  for (const [name, relative, reason] of [
    ['dotenv', '.env', /dotenv/],
    ['credentials', 'credentials.json', /credentials/],
    ['key', 'server.key', /key file/],
    ['opencode', 'opencode.json', /OpenCode config/],
  ]) {
    const f = setupFixture(null);
    const target = targetWorktree(f, name, `review-${name}`);
    fs.writeFileSync(path.join(target, relative), 'invented value\n');
    git(target, 'add', '--', relative);
    assert.throws(
      () => startWorker(`reviewer-${name}`, { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: target }, options(f)),
      reason,
      `${relative} must be refused`,
    );
    assert.equal(fs.existsSync(f.config.worktreePath(`reviewer-${name}`)), false, `${relative}: the refusal leaves no worker worktree`);
    assert.equal(fs.existsSync(path.join(target, 'review.diff')), false, `${relative}: no review artifact in the target`);
  }
});

test('worker start refuses a branch review with a tracked secret path', () => {
  const f = setupFixture(null);
  git(f.root, 'checkout', '-b', 'review-secret');
  fs.writeFileSync(path.join(f.root, '.env'), 'INVENTED=1\n');
  git(f.root, 'add', '.env');
  git(f.root, 'commit', '-m', 'add dotenv');
  git(f.root, 'checkout', 'main');
  assert.throws(
    () => startWorker('reviewer-secret', { kind: 'codex', task: 'x', readOnly: true, base: 'review-secret' }, options(f)),
    /dotenv/,
  );
  assert.equal(fs.existsSync(f.config.worktreePath('reviewer-secret')), false, 'the refusal leaves no worker worktree');
});

test('worker start refuses a worktree review when a rename touches a denied path', () => {
  for (const [name, from, to] of [['to-denied', 'src/keep.txt', '.env'], ['from-denied', '.env', 'src/keep.txt']]) {
    const f = setupFixture(null);
    const target = targetWorktree(f, name, `review-${name}`);
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, from), 'invented\n');
    git(target, 'add', '--', from);
    git(target, 'commit', '-m', 'add keep');
    git(target, 'mv', from, to);
    assert.throws(
      () => startWorker(`reviewer-${name}`, { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: target }, options(f)),
      /the target changes a secret or config path|dotenv/,
      `${from} -> ${to} must be refused`,
    );
  }
});

test('worker start copies a safe rename in a branch review with both paths', () => {
  const f = setupFixture(null);
  fs.mkdirSync(path.join(f.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'src', 'old.js'), 'export const renamed = 1;\n');
  git(f.root, 'add', 'src/old.js');
  git(f.root, 'commit', '-m', 'add old');
  git(f.root, 'checkout', '-b', 'review-rename');
  git(f.root, 'mv', 'src/old.js', 'src/new.js');
  git(f.root, 'commit', '-m', 'rename');
  git(f.root, 'checkout', 'main');
  const run = startWorker('reviewer-rename', { kind: 'codex', task: 'x', readOnly: true, base: 'review-rename' }, options(f));
  const list = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review-files.txt'), 'utf8');
  assert.match(list, /src\/old\.js/);
  assert.match(list, /src\/new\.js/);
  const patch = fs.readFileSync(path.join(run.worktree, '.worker/inputs/review.diff'), 'utf8');
  assert.match(patch, /rename from src\/old\.js/);
  assert.match(patch, /rename to src\/new\.js/);
});

test('worker start refuses a review worktree that is not a Git worktree', () => {
  const f = setupFixture(null);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'herdr-not-git-'));
  assert.throws(
    () => startWorker('reviewer-bad', { kind: 'codex', task: 'x', readOnly: true, reviewWorktree: dir }, options(f)),
    /--review-worktree .* is not a Git worktree/,
  );
});

test('worker start refuses both --base review and --review-worktree', () => {
  const f = setupFixture(null);
  commitFeature(f.root);
  assert.throws(
    () => runKitCommand('worker', ['start', 'reviewer-both', '--kind', 'codex', '--task', 'x', '--read-only', '--base', 'review-target', '--review-worktree', f.root], {
      config: f.config, herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
      freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }),
    }),
    /Give --base BRANCH or --review-worktree PATH, not both/,
  );
});

test('worker start takes no review inputs for a normal worker or a read-only worker on the base branch', () => {
  const f = setupFixture(null);
  const normal = startWorker('author', { kind: 'codex', task: 'x', allow: ['src/'] }, options(f));
  assert.equal(fs.existsSync(path.join(normal.worktree, '.worker/inputs/review.diff')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(normal.worktree, '.worker/brief.md'), 'utf8'), /## Review inputs/);

  const onBase = startWorker('reviewer-base', { kind: 'codex', task: 'x', readOnly: true, base: 'main' }, options(f));
  assert.equal(fs.existsSync(path.join(onBase.worktree, '.worker/inputs/review.diff')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(onBase.worktree, '.worker/brief.md'), 'utf8'), /## Review inputs/);
});

test('the CLI accepts --review-worktree and writes the copied review inputs', () => {
  const f = setupFixture(null);
  const target = targetWorktree(f, 'cli-review', 'cli-review-work');
  fs.appendFileSync(path.join(target, 'README.md'), 'cli review change\n');
  const run = runKitCommand('worker', ['start', 'reviewer-cli', '--kind', 'codex', '--task', 'x', '--read-only', '--review-worktree', target], {
    config: f.config, herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }),
  });
  assert.equal(run.worktree, path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(f.root), 'reviewer-cli'));
  assert.match(fs.readFileSync(path.join(run.worktree, '.worker/inputs/review-status.txt'), 'utf8'), /cli review change|README\.md/);
});
