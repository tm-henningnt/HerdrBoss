import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOOK_COMMAND, KIT_FILE, kitBehindLine, kitRevision, projectKit } from '../src/kit/agents-check.js';
import { loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from './helpers/start-worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const OLD = '000000000000';

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t, { kit = null } = {}) {
  const root = tmp(t, 'herdr-kit-pull-');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'seed');
  if (kit) {
    fs.mkdirSync(path.join(root, 'docs', 'orchestration'), { recursive: true });
    fs.writeFileSync(path.join(root, KIT_FILE), `<!-- herdr-boss kit v=${kit} -->\nold body\n`);
  }
  return root;
}

function changesFile(t, entries) {
  const file = path.join(tmp(t, 'herdr-kit-changes-'), 'CHANGES.md');
  fs.writeFileSync(file, `# Kit change log\n\n## Entries\n\n${entries.map(([revision, impact, summary]) => `## ${revision}\nImpact: ${impact}\nSummary: ${summary}\n`).join('\n')}`);
  return file;
}

test('kitBehindLine is null for a current kit, a missing kit file, and none-only changes', (t) => {
  const file = changesFile(t, [['111111111111', 'required', 'First.'], ['222222222222', 'none', 'Second.'], ['333333333333', 'none', 'Third.']]);
  const opts = { changesFile: file, current: '333333333333' };
  assert.equal(kitBehindLine(gitRepo(t, { kit: '333333333333' }), opts), null);
  assert.equal(kitBehindLine(gitRepo(t), opts), null);
  assert.equal(kitBehindLine(gitRepo(t, { kit: '111111111111' }), opts), null);
});

test('kitBehindLine counts required and useful changes since the installed revision', (t) => {
  const file = changesFile(t, [['111111111111', 'required', 'First.'], ['222222222222', 'useful', 'Second.'], ['333333333333', 'required', 'Third.'], ['444444444444', 'useful', 'Fourth.'], ['555555555555', 'none', 'Fifth.']]);
  const line = kitBehindLine(gitRepo(t, { kit: '111111111111' }), { changesFile: file, current: '555555555555' });
  assert.equal(line, 'Kit update: this project kit is behind by 1 required and 2 useful change(s). Run herdr-boss kit update.');
  const usefulOnly = kitBehindLine(gitRepo(t, { kit: '333333333333' }), { changesFile: file, current: '555555555555' });
  assert.equal(usefulOnly, 'Kit update: this project kit is behind by 1 useful change(s). The update is optional to act on now. Run herdr-boss kit update at the next task boundary.');
  // A required change keeps the direct wording. A useful-only change is optional and waits for a task boundary.
  assert.doesNotMatch(line, /optional/);
  assert.match(line, /\. Run herdr-boss kit update\.$/);
  assert.match(usefulOnly, /optional to act on now/);
  assert.match(usefulOnly, /at the next task boundary/);
  assert.match(usefulOnly, /herdr-boss kit update/);
});

test('worker start prints the kit line when the project kit is behind', (t) => {
  const run = (root) => {
    const config = loadProjectConfig({ cwd: root });
    const rulesFile = path.join(root, 'rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: '2026-09-24T12:00:00.000Z', avoidKinds: [], preferredKinds: ['codex'], memFreePercent: 50, notes: [], policy: { allowedKinds: ['codex'], excludedModels: [], preferredModels: { codex: 'gpt-6.1-sol' } } }));
    const template = path.join(root, 'brief-template.md');
    fs.writeFileSync(template, 'Worker {{name}}: {{task}} {{allowedPaths}}');
    fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ briefTemplate: template }));
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
      if (args[0] === 'agent') return { agents: [] };
      if (args[0] === 'tab') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
      if (args[0] === 'pane') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1', width: 160, height: 45 }] };
      throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
    };
    const output = [];
    startWorker('demo', { kind: 'codex', task: 'x', allow: ['src/'], dryRun: true }, {
      config: loadProjectConfig({ cwd: root }), herdr, rulesFile, now: Date.parse('2026-09-24T12:00:00Z'),
      env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' }, output: (text) => output.push(text),
    });
    return output;
  };
  const behind = run(gitRepo(t, { kit: OLD })).filter((line) => line.startsWith('Kit update:'));
  assert.equal(behind.length, 1);
  assert.match(behind[0], /^Kit update: this project kit is behind by .* Run herdr-boss kit update\.$/);
  assert.deepEqual(run(gitRepo(t, { kit: kitRevision() })).filter((line) => line.startsWith('Kit update:')), []);
  assert.deepEqual(run(gitRepo(t)).filter((line) => line.startsWith('Kit update:')), []);
});

test('publish prints the kit line to stderr when the project kit is behind', (t) => {
  const home = tmp(t, 'herdr-kit-pull-home-');
  const status = path.join(home, 'status.json');
  fs.writeFileSync(status, JSON.stringify({ project: 'Demo' }));
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: path.join(home, 'boss'), TMPDIR: home };
  // The first publish registers the repository of a slug, and later publishes use it. Each repository gets its own slug.
  const publish = (repo, slug) => spawnSync(process.execPath, [CLI, 'publish', slug, status], { cwd: repo, env, encoding: 'utf8' });
  const behind = publish(gitRepo(t, { kit: OLD }), 'demo');
  assert.equal(behind.status, 0, behind.stderr);
  assert.match(behind.stderr, /^Kit update: this project kit is behind by .* Run herdr-boss kit update\.$/m);
  assert.doesNotMatch(behind.stdout, /Kit update/);
  const current = publish(gitRepo(t, { kit: kitRevision() }), 'demo-current');
  assert.equal(current.status, 0, current.stderr);
  assert.doesNotMatch(current.stderr, /Kit update:/);
});

test('the hook stub runs kit update --quiet before it prints the kit file', (t) => {
  assert.match(HOOK_COMMAND, /herdr-boss kit update --quiet/);
  assert.ok(HOOK_COMMAND.indexOf('herdr-boss kit update --quiet') < HOOK_COMMAND.indexOf('cat docs/orchestration/herdr-boss.md'));
  const dir = tmp(t, 'herdr-kit-hook-');
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'docs', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(project, KIT_FILE), 'KIT FILE\n');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'args.txt');
  fs.writeFileSync(path.join(bin, 'herdr-boss'), `#!/bin/sh\necho "$@" > "${marker}"\necho DIGEST\n`);
  fs.chmodSync(path.join(bin, 'herdr-boss'), 0o755);
  const withTool = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
  assert.equal(withTool.status, 0, withTool.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'kit update --quiet');
  assert.equal(withTool.stdout, 'DIGEST\nKIT FILE\n');
  const failing = path.join(bin, 'herdr-boss');
  fs.writeFileSync(failing, '#!/bin/sh\necho oops >&2\nexit 3\n');
  const failed = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
  assert.equal(failed.status, 0);
  assert.equal(failed.stdout, 'KIT FILE\n');
  fs.rmSync(failing);
  const without = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { cwd: dir, env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
  assert.equal(without.status, 0);
  assert.equal(without.stdout, 'KIT FILE\n');
  assert.ok(projectKit().text.length > 0);
});
