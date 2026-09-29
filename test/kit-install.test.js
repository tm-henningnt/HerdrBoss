import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentsBlock, blockHash, HOOK_COMMAND, kitRevision, projectKit } from '../src/kit/agents-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const KIT_FILE = path.join('docs', 'orchestration', 'herdr-boss.md');
const SETTINGS = path.join('.claude', 'settings.json');

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-kit-install-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', path.join(dir, 'repo')]);
  return { home: dir, root: path.join(dir, 'repo') };
}

function run(r, args, cwd = r.root) {
  const env = { ...process.env, HOME: r.home, HERDR_BOSS_DIR: path.join(r.home, 'boss'), TMPDIR: r.home };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function read(r, file) { return fs.readFileSync(path.join(r.root, file), 'utf8'); }
function hooks(r) { return JSON.parse(read(r, SETTINGS)).hooks.SessionStart.flatMap((entry) => entry.hooks); }

test('the kit file has a version line, a do-not-edit line, and the template body', () => {
  const kit = projectKit();
  const body = fs.readFileSync(path.join(ROOT, 'kit', 'templates', 'project-kit.md'), 'utf8').replace(/[ \t]+$/gm, '').trimEnd();
  assert.equal(kit.revision, kitRevision());
  assert.notEqual(kit.revision, blockHash(body));
  assert.match(kit.revision, /^[0-9a-f]{12}$/);
  const lines = kit.text.split('\n');
  assert.equal(lines[0], `<!-- herdr-boss kit v=${kit.revision} -->`);
  assert.equal(lines[1], 'Herdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.');
  assert.ok(kit.text.endsWith(`${body}\n`));
});

test('the stub has 6 to 8 lines and names the kit file and memory', () => {
  const stub = agentsBlock();
  const lines = stub.body.split('\n');
  assert.ok(lines.length >= 6 && lines.length <= 8, `${lines.length} lines`);
  assert.match(stub.body, /Read `docs\/orchestration\/herdr-boss\.md` and `docs\/orchestration\/memory\.md` at start and at resume\. On a `Kit updated` notice, run `herdr-boss kit update` and continue\./);
  assert.match(stub.body, /Open no selection dialogs\. Decide, or report that you are blocked\./);
  assert.match(stub.body, /The kit file and the Owner decisions in `memory\.md` are the operating rules of this project\. Report a conflict with them to the Boss\. Do not work around them\./);
});

test('the kit text has the new rules and the stub precedence line', () => {
  const { body } = projectKit();
  for (const rule of [
    /Report every problem with the kit or the tools to the Boss\. The Boss decides the fix\./,
    /Never open a selection dialog\. Decide, or report that you are blocked\./,
    /After a dispatch, end the turn\./,
    /Run `herdr-boss wait \[<worker>\.\.\.\] \[--timeout SECONDS\]` only when you must block on a worker\./,
    /Write the full text of an Owner decision into `docs\/orchestration\/memory\.md`, not a pointer\./,
    /Put the relevant Owner decisions into each worker brief\./,
    /A handoff note carries no rules and no pane IDs\./,
    /The kit file and the Owner decisions in `memory\.md` are the operating rules of this project\./,
    /Decide and run your own pushes, deployments, and releases\./,
  ]) assert.match(body, rule);
  assert.doesNotMatch(body, /take precedence over conflicting project text/);
  assert.equal(fs.existsSync(path.join(ROOT, 'kit', 'templates', 'agents-section.md')), false);
});

test('kit install in an empty repository writes the kit file, AGENTS.md, and the hook', (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.root, 'sub'));
  const result = run(r, ['kit', 'install'], path.join(r.root, 'sub'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(r, KIT_FILE), projectKit().text);
  const agents = read(r, 'AGENTS.md');
  assert.ok(agents.startsWith('# '), agents);
  assert.ok(agents.includes(agentsBlock().block), agents);
  assert.deepEqual(hooks(r), [{ type: 'command', command: HOOK_COMMAND }]);
  for (const file of [KIT_FILE, 'AGENTS.md', SETTINGS]) assert.match(result.stdout, new RegExp(`^wrote ${file.replaceAll('.', '\\.')}$`, 'm'));

  const check = run(r, ['check', 'agents']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /0 errors, 0 warnings/);
});

test('kit install replaces an old full block and keeps the project text', (t) => {
  const r = repo(t);
  const oldBody = '## Herdr Boss orchestration\n\n' + Array.from({ length: 20 }, (_, i) => `- Old rule ${i}.`).join('\n');
  fs.writeFileSync(path.join(r.root, 'AGENTS.md'), `# Project\n\nProject rules before.\n\n<!-- herdr-boss:begin v=${blockHash(oldBody)} -->\n${oldBody}\n<!-- herdr-boss:end -->\n\nProject rules after.\n`);
  const result = run(r, ['kit', 'install']);
  assert.equal(result.status, 0, result.stderr);
  const agents = read(r, 'AGENTS.md');
  assert.equal(agents, `# Project\n\nProject rules before.\n\n${agentsBlock().block}\nProject rules after.\n`);
  assert.doesNotMatch(agents, /Old rule/);
});

test('kit install puts the stub after the first heading when there are no markers', (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.root, 'AGENTS.md'), 'Intro line.\n# Project\n\nProject rules.\n## Section\n');
  const result = run(r, ['kit', 'install', '--no-hook']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(r, 'AGENTS.md'), `Intro line.\n# Project\n\n${agentsBlock().block}\nProject rules.\n## Section\n`);
});

test('a second kit install changes nothing and does not duplicate the hook', (t) => {
  const r = repo(t);
  assert.equal(run(r, ['kit', 'install']).status, 0);
  const before = [KIT_FILE, 'AGENTS.md', SETTINGS].map((file) => read(r, file));
  const again = run(r, ['kit', 'install']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([KIT_FILE, 'AGENTS.md', SETTINGS].map((file) => read(r, file)), before);
  assert.doesNotMatch(again.stdout, /^wrote /m);
  assert.equal(hooks(r).length, 1);
});

test('the hook merge keeps other settings and other hooks', (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.root, '.claude'));
  const settings = {
    permissions: { allow: ['Bash(npm test)'] },
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo other' }] }],
    },
  };
  fs.writeFileSync(path.join(r.root, SETTINGS), JSON.stringify(settings, null, 2));
  assert.equal(run(r, ['kit', 'install']).status, 0);
  assert.equal(run(r, ['kit', 'install']).status, 0);
  const merged = JSON.parse(read(r, SETTINGS));
  assert.deepEqual(merged.permissions, { ...settings.permissions, deny: ['AskUserQuestion'] });
  assert.equal(merged.model, 'x');
  assert.deepEqual(merged.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.deepEqual(hooks(r).map((hook) => hook.command), ['echo other', HOOK_COMMAND]);
});

test('kit install replaces an older Herdr Boss hook command', (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.root, '.claude'));
  fs.writeFileSync(path.join(r.root, SETTINGS), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat docs/orchestration/herdr-boss.md' }] }] } }));
  assert.equal(run(r, ['kit', 'install']).status, 0);
  assert.deepEqual(hooks(r).map((hook) => hook.command), [HOOK_COMMAND]);
});

test('kit install --no-hook writes no settings file', (t) => {
  const r = repo(t);
  const result = run(r, ['kit', 'install', '--no-hook']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(r.root, SETTINGS)), false);
  assert.doesNotMatch(result.stdout, /settings\.json/);
  assert.ok(fs.existsSync(path.join(r.root, KIT_FILE)));
});

test('kit install refuses invalid settings JSON and two blocks, and writes nothing', (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.root, '.claude'));
  fs.writeFileSync(path.join(r.root, SETTINGS), '{ not json');
  const bad = run(r, ['kit', 'install']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /settings\.json/);
  assert.equal(fs.existsSync(path.join(r.root, KIT_FILE)), false);
  assert.equal(read(r, SETTINGS), '{ not json');

  const s = repo(t);
  const block = agentsBlock().block;
  fs.writeFileSync(path.join(s.root, 'AGENTS.md'), `# Project\n${block}${block}`);
  const two = run(s, ['kit', 'install']);
  assert.notEqual(two.status, 0);
  assert.match(two.stderr, /more than one/);
  assert.equal(fs.existsSync(path.join(s.root, KIT_FILE)), false);
});

test('the hook command prints both files and succeeds when one is missing', (t) => {
  const r = repo(t);
  assert.equal(run(r, ['kit', 'install']).status, 0);
  const env = { PATH: '/usr/bin:/bin', HOME: r.home, CLAUDE_PROJECT_DIR: r.root };
  const missing = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { cwd: r.home, env, encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, projectKit().text);
  fs.writeFileSync(path.join(r.root, 'docs', 'orchestration', 'memory.md'), '# Memory\n');
  const both = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { cwd: r.home, env, encoding: 'utf8' });
  assert.equal(both.stdout, `${projectKit().text}# Memory\n`);
});

test('kit block prints the stub for old instructions', (t) => {
  const r = repo(t);
  const result = run(r, ['kit', 'block']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, agentsBlock().block);
});
