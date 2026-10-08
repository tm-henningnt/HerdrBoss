import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { collectWorker, startWorker } from '../src/kit/workers.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const record = { record: true, outcome: 'done', gatePassed: true, keepPane: true };
const discardedPath = 'docs/discarded.md';

function setup(t, name, { committed = [], reported = [discardedPath], allow = ['src/'] } = {}) {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-m', 'fixture configuration');
  const run = startWorker(name, { kind: 'codex', task: 'fixture', allow: [...allow, '.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
    freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }),
    serviceConfig: { worktrees: { minFreeGb: 8 } },
  });
  const write = (relative, text = 'fixture change\n') => {
    const file = path.join(run.worktree, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const relative of committed) {
    write(relative);
    git(run.worktree, 'add', relative);
  }
  if (committed.length) git(run.worktree, 'commit', '-m', 'worker fixture change');
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: reported,
    commands: ['fixture check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const dataDir = path.join(f.root, 'data');
  const auditFile = path.join(dataDir, 'action-audit.jsonl');
  const collect = (options = {}) => collectWorker(name, { ...record, ...options }, {
    config: f.config, now: Date.parse('2026-10-08T10:00:00Z'), output: () => {},
    listWorktreeProcesses: () => [], recordUsageFn: () => ({ errors: [], duplicate: false }),
    leaseDataDir: dataDir,
  });
  return { f, run, write, collect, auditFile };
}

test('collect excludes a discarded outside path and records one redacted audit line', (t) => {
  const { f, run, collect, auditFile } = setup(t, 'exclude-gone', { committed: [discardedPath, 'src/kept.js'], reported: [discardedPath, 'src/kept.js'] });
  git(run.worktree, 'rm', discardedPath);
  git(run.worktree, 'commit', '-m', 'discard outside fixture path');
  const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
  const summary = collect({ excludePaths: [discardedPath], excludeReason: `Discarded hook change; key ${secret}` });
  assert.deepEqual(summary.outOfScope, []);
  assert.deepEqual(summary.recordedPaths, ['src/kept.js', `.orchestration/runs/${run.name}.json`]);
  const saved = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
  assert.ok(saved.finishedAt);
  assert.deepEqual(saved.scopeExclusions.paths, [discardedPath]);
  assert.doesNotMatch(saved.scopeExclusions.reason, new RegExp(secret));
  const ledger = fs.readFileSync(f.config.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].changedPaths, ['src/kept.js', `.orchestration/runs/${run.name}.json`]);
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const audit = JSON.parse(lines[0]);
  assert.equal(audit.command, 'worker collect');
  assert.equal(audit.workerName, run.name);
  assert.deepEqual(audit.paths, [discardedPath]);
  assert.match(audit.reason, /Discarded hook change/);
  assert.ok(!lines[0].includes(secret));
  assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: 'already done' }), /already marked finished/);
  assert.equal(fs.readFileSync(auditFile, 'utf8').trim().split('\n').length, 1);
});

test('collect refuses an exclusion still in the branch diff, even when the worktree removes it', (t) => {
  const { run, collect, auditFile, f } = setup(t, 'exclude-commit', { committed: [discardedPath] });
  fs.unlinkSync(path.join(run.worktree, discardedPath));
  assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: 'discarded' }),
    /docs\/discarded\.md.*branch diff against .*docs\/discarded\.md.*worktree diff or status/);
  assert.equal(fs.existsSync(auditFile), false);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.equal(JSON.parse(fs.readFileSync(run.recordFile, 'utf8')).finishedAt, undefined);
});

test('collect refuses unstaged, staged, untracked, and renamed outside paths in the worktree', (t) => {
  for (const state of ['unstaged', 'staged', 'untracked', 'renamed']) {
    const { f, run, write, collect, auditFile } = setup(t, `exclude-${state}`);
    if (state !== 'untracked') {
      write(discardedPath, 'base contents\n');
      git(run.worktree, 'add', discardedPath);
      git(run.worktree, 'commit', '-m', 'base fixture path');
      const saved = JSON.parse(fs.readFileSync(run.recordFile, 'utf8'));
      saved.baseCommit = git(run.worktree, 'rev-parse', 'HEAD');
      fs.writeFileSync(run.recordFile, JSON.stringify(saved));
    }
    if (state === 'renamed') git(run.worktree, 'mv', discardedPath, 'docs/renamed.md');
    else write(discardedPath);
    if (state === 'staged') git(run.worktree, 'add', discardedPath);
    assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: 'discarded' }),
      /docs\/discarded\.md.*worktree diff or status: .*docs\/discarded\.md/);
    assert.equal(fs.existsSync(auditFile), false);
    assert.equal(fs.existsSync(f.config.ledgerPath), false);
  }
});

test('collect requires an exclusion reason with 1 to 300 characters', (t) => {
  const { collect, auditFile, f } = setup(t, 'exclude-reason');
  for (const reason of [undefined, null, '', '   ', 'a'.repeat(301)]) {
    assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: reason }), /--reason.*1 to 300 characters/);
  }
  assert.equal(fs.existsSync(auditFile), false);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.doesNotThrow(() => collect({ excludePaths: [discardedPath], excludeReason: 'a'.repeat(300) }));
});

test('a valid exclusion reason stays valid when redaction makes it longer', (t) => {
  const { collect, auditFile } = setup(t, 'exclude-expanded');
  const reason = 'api_key=x '.repeat(29).trim();
  assert.ok(reason.length <= 300);
  const summary = collect({ excludePaths: [discardedPath], excludeReason: reason });
  assert.ok(summary.scopeExclusions.reason.length > 300);
  assert.ok(!summary.scopeExclusions.reason.includes('api_key=x'));
  assert.equal(JSON.parse(fs.readFileSync(auditFile, 'utf8')).reason, summary.scopeExclusions.reason);
});

test('collect refuses exclusions inside scope and invalid repository paths', (t) => {
  const { collect } = setup(t, 'exclude-invalid');
  assert.throws(() => collect({ excludePaths: ['src/unchanged.js'], excludeReason: 'discarded' }), /inside the allowed scope.*src\/unchanged\.js/);
  for (const paths of [[], [''], ['/outside.md'], ['../outside.md'], ['.worker/report.md']]) {
    assert.throws(() => collect({ excludePaths: paths, excludeReason: 'discarded' }), /Invalid --exclude-path/);
  }
  assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: 'discarded', noRecord: true }), /recorded collection/);
});

test('collect refuses exclusions that normalize to the repository root', (t) => {
  for (const [index, rootPath] of ['.', './', '././', '.\\'].entries()) {
    const { collect, auditFile } = setup(t, `exclude-root-${index}`, { reported: [] });
    assert.throws(() => collect({ excludePaths: [rootPath], excludeReason: 'discarded' }), /repository root/);
    assert.equal(fs.existsSync(auditFile), false);
  }
});

const impeccableRule = 'Workers never run impeccable ignores or edit .impeccable/config.json. A hook finding does not authorize an ignore command or a config edit. Report a false positive in the worker report; the orchestrator decides.';

test('collect refuses Impeccable changes even under broad or explicit allowed scope', (t) => {
  for (const [index, allow] of [['.'], ['.impeccable/'], ['.impeccable/**']].entries()) {
    const item = '.impeccable/config.json';
    const { collect, auditFile } = setup(t, `impeccable-scope-${index}`, { committed: [item], reported: [item], allow });
    assert.throws(() => collect(), (error) => error.message.includes(item) && error.message.includes(impeccableRule));
    assert.equal(fs.existsSync(auditFile), false);
    assert.throws(() => collect({ acceptScope: [item], acceptScopeReason: 'approved' }),
      (error) => error.message.includes('--accept-scope') && error.message.includes(impeccableRule));
  }
});

test('collect refuses unreported Impeccable changes and keeps this rule for report-only collection', (t) => {
  const { collect, write } = setup(t, 'impeccable-unreported', { allow: ['.'], reported: [] });
  write('.impeccable/hook.cache.json');
  for (const options of [{}, { noRecord: true }, { allow: ['.impeccable/'] }]) {
    assert.throws(() => collect(options), (error) => error.message.includes('.impeccable/hook.cache.json') && error.message.includes(impeccableRule));
  }
});

test('a discarded Impeccable path can be excluded despite broad allowed scope', (t) => {
  const item = '.impeccable/config.json';
  const { run, collect, auditFile } = setup(t, 'impeccable-discarded', { allow: ['.'], committed: [item], reported: [item] });
  git(run.worktree, 'rm', item);
  git(run.worktree, 'commit', '-m', 'discard hook fixture change');
  const summary = collect({ excludePaths: [item], excludeReason: 'discarded hook change' });
  assert.deepEqual(summary.outOfScope, []);
  assert.deepEqual(summary.scopeExclusions.paths, [item]);
  assert.ok(!summary.recordedPaths.includes(item));
  assert.deepEqual(JSON.parse(fs.readFileSync(auditFile, 'utf8')).paths, [item]);
});

test('a folder exclusion cannot hide a changed child and a rejected batch writes no audit', (t) => {
  const { collect, write, auditFile, f } = setup(t, 'exclude-folder');
  write('docs/remaining.md');
  assert.throws(() => collect({ excludePaths: [discardedPath, 'docs/'], excludeReason: 'discarded' }),
    /cannot exclude docs.*worktree diff or status: docs\/remaining\.md/);
  assert.equal(fs.existsSync(auditFile), false);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
});

test('normalized exclusions remove report-only paths without changing the report', (t) => {
  const { collect, run } = setup(t, 'exclude-normalized');
  const reportFile = path.join(run.worktree, run.workerDir, 'report.json');
  const before = fs.readFileSync(reportFile);
  const summary = collect({ excludePaths: ['./docs/discarded.md'], excludeReason: 'x' });
  assert.deepEqual(summary.scopeExclusions.paths, [discardedPath]);
  assert.ok(!summary.recordedPaths.includes(discardedPath));
  assert.deepEqual(fs.readFileSync(reportFile), before);
});

test('exclusions leave unrelated outside paths blocked and accept-scope still approves them', (t) => {
  const { collect, auditFile } = setup(t, 'exclude-partial', { committed: ['docs/approved.md'], reported: [discardedPath, 'docs/approved.md'] });
  assert.throws(() => collect({ excludePaths: [discardedPath], excludeReason: 'discarded' }), /outside its allowed scope: docs\/approved\.md/);
  assert.equal(fs.existsSync(auditFile), false);
  const summary = collect({ excludePaths: [discardedPath], excludeReason: 'discarded', acceptScope: ['docs/approved.md'], acceptScopeReason: 'approved' });
  assert.deepEqual(summary.scopeException, { files: ['docs/approved.md'], reason: 'approved' });
  assert.deepEqual(summary.outOfScope, []);
});

test('the collect command parses comma-separated exclusions and refuses missing values or reasons', (t) => {
  const { f, run } = setup(t, 'exclude-cli', { reported: [discardedPath, 'docs/other.md'] });
  const command = (args) => runKitCommand('worker', ['collect', run.name, ...args], {
    config: f.config, output: () => {}, herdr: f.herdr, listWorktreeProcesses: () => [],
    serviceConfig: { worktrees: { pruneAtCollect: false } },
  });
  assert.throws(() => command(['--exclude-path']), /--exclude-path needs a value/);
  assert.throws(() => command(['--exclude-path', discardedPath]), /--exclude-path needs --reason/);
  assert.throws(() => command(['--exclude-path', ',', '--reason', 'discarded']), /--exclude-path needs at least one/);
  assert.throws(() => command(['--exclude-path', discardedPath, '--reason', 'x'.repeat(301)]), /1 to 300 characters/);
  const summary = command(['--exclude-path', `${discardedPath}, docs/other.md,${discardedPath}`, '--reason', 'discarded', '--record', '--outcome', 'done', '--gate-passed', '--keep-pane']);
  assert.deepEqual(summary.scopeExclusions, { paths: [discardedPath, 'docs/other.md'], reason: 'discarded' });
  assert.deepEqual(summary.outOfScope, []);
});
