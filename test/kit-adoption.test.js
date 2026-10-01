import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installedKitRevision, installKit, KIT_FILE, kitRequiredBehind, kitRevision, refreshKitIfRequired } from '../src/kit/agents-check.js';
import { loadModels } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { setupFixture } from './helpers/kit-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const OLD = 'aaaaaaaaaaaa';

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const commitCount = (root) => Number(git(root, 'rev-list', '--count', 'HEAD').trim());

// A repository with the current kit installed and committed, then the kit file set to an old revision.
function staleRepo(t, { revision = OLD, commit = true } = {}) {
  const root = tmp(t, 'herdr-kit-adopt-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  installKit(root);
  const file = path.join(root, KIT_FILE);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^<!-- herdr-boss kit v=\S+ -->/, `<!-- herdr-boss kit v=${revision} -->`));
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'seed'); }
  return root;
}

function changesFile(t, entries) {
  const file = path.join(tmp(t, 'herdr-kit-adopt-changes-'), 'CHANGES.md');
  fs.writeFileSync(file, `# Kit change log\n\n## Entries\n\n${entries.map(([revision, impact, summary]) => `## ${revision}\nImpact: ${impact}\nSummary: ${summary}\n`).join('\n')}`);
  return file;
}

test('refreshKitIfRequired writes a clean copy when the disk kit is behind on a required change and commits nothing', (t) => {
  const root = staleRepo(t);
  const before = commitCount(root);
  const result = refreshKitIfRequired(root);
  assert.equal(result.status, 'refreshed');
  assert.ok(result.written.includes(KIT_FILE));
  assert.equal(installedKitRevision(root), kitRevision());
  assert.equal(commitCount(root), before);
  assert.match(result.line, /^Kit refreshed: wrote .*docs\/orchestration\/herdr-boss\.md/);
  assert.match(result.line, new RegExp(`${OLD} to ${kitRevision()}`));
});

test('refreshKitIfRequired does nothing for a current kit, a missing kit, and a useful-only gap', (t) => {
  const current = staleRepo(t, { revision: kitRevision() });
  assert.deepEqual(refreshKitIfRequired(current), { status: 'current', written: [], line: null });
  const none = tmp(t, 'herdr-kit-adopt-none-');
  git(none, 'init', '-q');
  assert.equal(refreshKitIfRequired(none).status, 'current');
  assert.equal(fs.existsSync(path.join(none, KIT_FILE)), false);
  const useful = staleRepo(t, { revision: OLD });
  const file = changesFile(t, [[OLD, 'required', 'First.'], ['bbbbbbbbbbbb', 'useful', 'Second.']]);
  const before = fs.readFileSync(path.join(useful, KIT_FILE), 'utf8');
  const result = refreshKitIfRequired(useful, { changesFile: file, current: 'bbbbbbbbbbbb' });
  assert.equal(result.status, 'current');
  assert.equal(fs.readFileSync(path.join(useful, KIT_FILE), 'utf8'), before);
});

test('refreshKitIfRequired skips and warns when the kit file has a hand edit', (t) => {
  const root = staleRepo(t);
  const file = path.join(root, KIT_FILE);
  fs.appendFileSync(file, 'My own rule.\n');
  const before = fs.readFileSync(file, 'utf8');
  const result = refreshKitIfRequired(root);
  assert.equal(result.status, 'skipped');
  assert.match(result.line, /^Warning: kit files not refreshed: .*docs\/orchestration\/herdr-boss\.md has hand edits.* Run herdr-boss kit update/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refreshKitIfRequired skips and warns when the AGENTS.md stub has a hand edit', (t) => {
  const root = staleRepo(t);
  const agents = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agents, fs.readFileSync(agents, 'utf8').replace('<!-- herdr-boss:end -->', 'An extra rule.\n<!-- herdr-boss:end -->'));
  const before = fs.readFileSync(agents, 'utf8');
  const result = refreshKitIfRequired(root);
  assert.equal(result.status, 'skipped');
  assert.match(result.line, /AGENTS\.md has hand edits/);
  assert.equal(fs.readFileSync(agents, 'utf8'), before);
  assert.equal(installedKitRevision(root), OLD);
});

test('kitRequiredBehind counts the required changes after a revision', () => {
  const entries = [
    { revision: 'a1', impact: 'required' }, { revision: 'b2', impact: 'useful' },
    { revision: 'c3', impact: 'required' }, { revision: 'd4', impact: 'required' },
  ];
  assert.equal(kitRequiredBehind('a1', 'd4', entries), 2);
  assert.equal(kitRequiredBehind('c3', 'd4', entries), 1);
  assert.equal(kitRequiredBehind('d4', 'd4', entries), 0);
  assert.equal(kitRequiredBehind(null, 'd4', entries), null);
  assert.equal(kitRequiredBehind('zz', 'd4', entries), null);
});

test('publish refreshes the kit files and sets kitRevision from the refreshed disk copy', (t) => {
  const root = staleRepo(t);
  const home = tmp(t, 'herdr-kit-adopt-home-');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', kitRevision: OLD }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: path.join(home, 'boss'), TMPDIR: home };
  const before = commitCount(root);
  const result = spawnSync(process.execPath, [CLI, 'publish', 'demo', status], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^Kit refreshed: wrote /m);
  assert.equal(installedKitRevision(root), kitRevision());
  assert.equal(commitCount(root), before);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'boss', 'projects', 'demo.json'), 'utf8'));
  assert.equal(stored.kitRevision, kitRevision());
});

test('publish sets kitRevision from the disk copy when the status has none, and keeps the stale status out', (t) => {
  const root = staleRepo(t, { revision: kitRevision() });
  const home = tmp(t, 'herdr-kit-adopt-home-');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo', kitRevision: OLD }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: path.join(home, 'boss'), TMPDIR: home };
  const result = spawnSync(process.execPath, [CLI, 'publish', 'demo', status], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Kit refreshed/);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'boss', 'projects', 'demo.json'), 'utf8'));
  assert.equal(stored.kitRevision, kitRevision());
});

test('publish keeps the status kitRevision and warns when the refresh is skipped for a hand edit', (t) => {
  const root = staleRepo(t);
  fs.appendFileSync(path.join(root, KIT_FILE), 'My own rule.\n');
  const home = tmp(t, 'herdr-kit-adopt-home-');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo' }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: path.join(home, 'boss'), TMPDIR: home };
  const result = spawnSync(process.execPath, [CLI, 'publish', 'demo', status], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^Warning: kit files not refreshed: /m);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'boss', 'projects', 'demo.json'), 'utf8'));
  assert.equal(stored.kitRevision, OLD, 'the status shows the real disk revision');
});

// Install an old kit file in the fixture repository and commit it.
function stalenFixture(f) {
  installKit(f.root);
  const file = path.join(f.root, KIT_FILE);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^<!-- herdr-boss kit v=\S+ -->/, `<!-- herdr-boss kit v=${OLD} -->`));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-q', '-m', 'old kit');
}

test('worker start refreshes the kit files of the project, prints one line, and commits nothing', () => {
  const f = setupFixture(null);
  stalenFixture(f);
  const before = commitCount(f.root);
  const output = [];
  startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'] }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (text) => output.push(text),
  });
  assert.equal(output.filter((line) => line.startsWith('Kit refreshed:')).length, 1);
  assert.equal(output.filter((line) => line.startsWith('Kit update:')).length, 0);
  assert.equal(installedKitRevision(f.root), kitRevision());
  assert.equal(commitCount(f.root), before);
});

test('worker start with a dry run writes no kit file and prints the behind line', () => {
  const f = setupFixture(null);
  stalenFixture(f);
  const output = [];
  startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (text) => output.push(text),
  });
  assert.equal(output.filter((line) => line.startsWith('Kit update:')).length, 1);
  assert.equal(installedKitRevision(f.root), OLD);
});

const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function kitLineFor(project, changes) {
  const start = app.indexOf('function kitState(');
  const end = app.indexOf('\n}\n', app.indexOf('function kitRevisionLine(')) + 3;
  const esc = (s) => String(s);
  return vm.runInNewContext(`${app.slice(start, end)}; kitRevisionLine(project, { changes })`, { esc, project, changes });
}

test('the project page shows the published, disk, and current revision and the required changes behind', () => {
  const changes = [
    { revision: 'a1a1a1a1a1a1', impact: 'required' }, { revision: 'b2b2b2b2b2b2', impact: 'useful' },
    { revision: 'c3c3c3c3c3c3', impact: 'required' }, { revision: 'd4d4d4d4d4d4', impact: 'required' },
  ];
  const base = { currentKitRevision: 'd4d4d4d4d4d4' };
  const stale = kitLineFor({ ...base, kitRevision: 'a1a1a1a1a1a1', installedKitRevision: 'd4d4d4d4d4d4' }, changes);
  assert.match(stale, /class="warnbox"/);
  assert.match(stale, /published a1a1a1a1a1a1, on disk d4d4d4d4d4d4, current d4d4d4d4d4d4/);
  assert.match(stale, /2 required changes behind\./);
  assert.match(stale, /The disk copy is current\. The orchestrator must set .*kitRevision.* and publish\./);
  const behindDisk = kitLineFor({ ...base, kitRevision: 'a1a1a1a1a1a1', installedKitRevision: 'c3c3c3c3c3c3' }, changes);
  assert.match(behindDisk, /The disk copy is behind \(1 required change behind\)\./);
  const noDisk = kitLineFor({ ...base, kitRevision: 'c3c3c3c3c3c3' }, changes);
  assert.match(noDisk, /on disk unknown/);
  assert.match(noDisk, /1 required change behind\./);
  const current = kitLineFor({ ...base, kitRevision: 'd4d4d4d4d4d4', installedKitRevision: 'd4d4d4d4d4d4' }, changes);
  assert.match(current, /^<div class="win-foot">Kit revision published d4d4d4d4d4d4, on disk d4d4d4d4d4d4, current d4d4d4d4d4d4\.<\/div>$/);
  const unknown = kitLineFor({ ...base, kitRevision: '999999999999', installedKitRevision: null }, changes);
  assert.match(unknown, /class="warnbox"/);
  assert.doesNotMatch(unknown, /required change/);
});
