import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { collectWorker } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

// A worker that changed the listed paths. Paths under src/ are inside the scope. The others are outside it.
function setup(name, changed) {
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const run = startWorker(name, { kind: 'codex', task: 'x', allow: ['src/', '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  for (const relative of changed) {
    const file = path.join(run.worktree, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'changed\n');
    git(run.worktree, 'add', relative);
  }
  if (changed.length) git(run.worktree, 'commit', '-m', 'worker change');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: changed, commands: ['focused check'],
    evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const collect = (options) => {
    const output = [];
    const summary = collectWorker(name, options, {
      config: f.config, now: Date.parse('2026-10-03T10:00:00Z'), output: (line) => output.push(line),
      listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [], duplicate: false }),
    });
    return { summary, output };
  };
  return { f, run, collect };
}

const record = { record: true, outcome: 'done', gatePassed: true };
const noRecord = { noRecord: true };

test('a listed outside file passes with --record and is saved with the reason in the run record', () => {
  const { run, collect } = setup('as-record', ['src/a.js', 'docs/extra.md']);
  const { summary, output } = collect({ ...record, acceptScope: ['docs/extra.md'], acceptScopeReason: 'Orchestrator approved docs/extra.md by message' });
  assert.deepEqual(summary.outOfScope, []);
  assert.deepEqual(summary.scopeException, { files: ['docs/extra.md'], reason: 'Orchestrator approved docs/extra.md by message' });
  const saved = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.deepEqual(saved.scopeException, { files: ['docs/extra.md'], reason: 'Orchestrator approved docs/extra.md by message' });
  assert.ok(saved.finishedAt);
  const text = output.join('\n');
  assert.match(text, /Scope exception\n- files: docs\/extra\.md\n- reason: Orchestrator approved docs\/extra\.md by message/);
});

test('a listed outside file passes with --no-record and the report shows the block', () => {
  const { run, collect } = setup('as-norecord', ['docs/extra.md']);
  const { summary, output } = collect({ ...noRecord, acceptScope: ['docs/extra.md'], acceptScopeReason: 'approved' });
  assert.deepEqual(summary.scopeException, { files: ['docs/extra.md'], reason: 'approved' });
  assert.match(output.join('\n'), /Scope exception/);
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).scopeException, undefined);
});

test('--accept-scope still records a discarded file as an accepted scope exception', () => {
  const { run, collect } = setup('as-discarded', ['docs/extra.md']);
  git(run.worktree, 'rm', 'docs/extra.md');
  git(run.worktree, 'commit', '-m', 'discard fixture path');
  const reason = 'a'.repeat(301);
  const { summary } = collect({ ...record, acceptScope: ['docs/extra.md'], acceptScopeReason: reason });
  assert.deepEqual(summary.scopeException, { files: ['docs/extra.md'], reason });
  assert.ok(summary.recordedPaths.includes('docs/extra.md'));
  assert.equal(summary.scopeExclusions, undefined);
});

test('an outside file that is not listed still refuses and is named', () => {
  for (const options of [record, noRecord]) {
    const { collect } = setup(`as-unlisted-${options.record ? 'r' : 'n'}`, ['docs/extra.md', 'README.md']);
    assert.throws(() => collect({ ...options, acceptScope: ['docs/extra.md'], acceptScopeReason: 'approved' }),
      (error) => /outside its allowed scope: README\.md\./.test(error.message) && !/docs\/extra\.md/.test(error.message));
  }
});

test('the scope refusal shows the exact --accept-scope form with an example', () => {
  const { collect } = setup('as-form', ['docs/extra.md']);
  assert.throws(() => collect({ ...noRecord }), (error) =>
    /The allowed command form is: herdr-boss worker collect as-form --accept-scope FILE\[,FILE\] --reason TEXT\./.test(error.message)
    && /Example: herdr-boss worker collect as-form --accept-scope 'docs\/extra\.md' --reason "approved by the orchestrator"\./.test(error.message));
});

test('the scope refusal example lists every unlisted file, comma separated and shell-quoted', () => {
  const { collect } = setup('as-two', ['docs/extra.md', 'README.md']);
  assert.throws(() => collect({ ...noRecord }), (error) =>
    /changed paths outside its allowed scope: docs\/extra\.md, README\.md\./.test(error.message)
    && /Example: herdr-boss worker collect as-two --accept-scope 'docs\/extra\.md,README\.md' --reason "approved by the orchestrator"\./.test(error.message));
});

test('an empty or blank reason refuses', () => {
  for (const reason of ['', '   ', undefined, null]) {
    const { collect } = setup(`as-blank-${String(reason).length}-${typeof reason}`, ['docs/extra.md']);
    assert.throws(() => collect({ ...noRecord, acceptScope: ['docs/extra.md'], acceptScopeReason: reason }), /--reason/);
  }
});

test('a listed file that is inside the scope or unchanged refuses and is named', () => {
  const { collect } = setup('as-typo', ['src/a.js', 'docs/extra.md']);
  assert.throws(() => collect({ ...noRecord, acceptScope: ['docs/extra.md', 'src/a.js'], acceptScopeReason: 'approved' }), /src\/a\.js/);
  assert.throws(() => collect({ ...noRecord, acceptScope: ['docs/extra.md', 'docs/extr.md'], acceptScopeReason: 'approved' }), /docs\/extr\.md/);
});

test('--accept-scope refuses when no file is outside the scope', () => {
  const { collect } = setup('as-none', ['src/a.js']);
  assert.throws(() => collect({ ...noRecord, acceptScope: ['docs/extra.md'], acceptScopeReason: 'approved' }), /docs\/extra\.md/);
});

test('the reason is masked with the redaction helper', () => {
  const { collect } = setup('as-mask', ['docs/extra.md']);
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const { summary, output } = collect({ ...noRecord, acceptScope: ['docs/extra.md'], acceptScopeReason: `key ${secret}` });
  assert.ok(!summary.scopeException.reason.includes(secret));
  assert.ok(!output.join('\n').includes(secret));
});

test('the command line refuses --reason alone and --accept-scope without a value or reason', () => {
  const { f } = setup('as-cli', ['docs/extra.md']);
  const run = (args) => () => runKitCommand('worker', ['collect', 'as-cli', '--no-record', ...args], { config: f.config, output: () => {} });
  assert.throws(run(['--reason', 'approved']), /--reason needs --accept-scope/);
  assert.throws(run(['--accept-scope']), /--accept-scope needs a value/);
  assert.throws(run(['--accept-scope', 'docs/extra.md']), /--accept-scope needs --reason/);
  assert.throws(run(['--accept-scope', ',', '--reason', 'x']), /--accept-scope needs/);
});
