import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { startWorker } from '../src/kit/workers.js';
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
  const target = path.join(path.dirname(f.root), `${path.basename(f.root)}-review`);
  git(f.root, 'worktree', 'add', '-b', 'review-work', target, 'main');
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
  const target = path.join(path.dirname(f.root), `${path.basename(f.root)}-cli-review`);
  git(f.root, 'worktree', 'add', '-b', 'cli-review-work', target, 'main');
  fs.appendFileSync(path.join(target, 'README.md'), 'cli review change\n');
  const run = runKitCommand('worker', ['start', 'reviewer-cli', '--kind', 'codex', '--task', 'x', '--read-only', '--review-worktree', target], {
    config: f.config, herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  assert.equal(run.worktree, path.join(TEST_HOME, 'Projects', '.herdr-wt', path.basename(f.root), 'reviewer-cli'));
  assert.match(fs.readFileSync(path.join(run.worktree, '.worker/inputs/review-status.txt'), 'utf8'), /cli review change|README\.md/);
});
