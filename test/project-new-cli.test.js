import { withTestGitIdentity } from './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProjectNewArgs, verifyProjectCaller, projectCommand } from '../src/project-new-cli.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const REPO = path.resolve(path.dirname(CLI), '..');
// A worker shell can set TMPDIR inside the repository. project new refuses a folder there, so use the system folder then.
const TMP = path.resolve(os.tmpdir()).startsWith(REPO) ? '/tmp' : os.tmpdir();

function fixture() {
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-project-new-cli-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tuseConfigOnly = true\n');
  const env = withTestGitIdentity({ PATH: process.env.PATH, HOME: root, HERDR_BOSS_DIR: dataDir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, dataDir, group, env, cli, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('parses the flags of project new', () => {
  const parsed = parseProjectNewArgs(['demo', '--group', '/g', '--remote', 'gh', '--visibility', 'private', '--org', 'acme', '--kind', 'codex', '--goal', 'A goal', '--start', '--dry-run', '--resume']);
  assert.equal(parsed.slug, 'demo');
  assert.equal(parsed.group, '/g');
  assert.equal(parsed.remote, 'gh');
  assert.equal(parsed.visibility, 'private');
  assert.equal(parsed.org, 'acme');
  assert.equal(parsed.kind, 'codex');
  assert.equal(parsed.goal, 'A goal');
  assert.equal(parsed.start, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.resume, true);
});

test('the defaults are remote none, private, and no start', () => {
  const parsed = parseProjectNewArgs(['demo', '--path', '/p']);
  assert.equal(parsed.remote, 'none');
  assert.equal(parsed.visibility, 'private');
  assert.equal(parsed.start, false);
  assert.equal(parsed.dryRun, false);
});

test('refuses bad flags with the usage line', () => {
  const bad = [
    [['demo'], /--group|--path/],
    [[], /Usage/],
    [['demo', '--group', '/g', '--path', '/p'], /only one/i],
    [['demo', '--group', '/g', '--bogus'], /Unknown option: --bogus.*Usage/s],
    [['demo', '--group', '/g', '--visibility', 'secret'], /--visibility/],
    [['demo', '--group', '/g', '--visibility', 'public'], /public.*remote/i],
    [['demo', '--group', '/g', '--visibility', 'public', '--remote', 'none'], /public.*remote/i],
    [['demo', '--group', '/g', '--remote', 'ftp://x'], /--remote/],
    [['demo', '--group', '/g', '--remote', 'https://user:secret@host/x.git'], /credentials/],
    [['demo', '--group', '/g', '--kind', 'vim'], /--kind/],
    [['demo', '--group', '/g', '--group', '/h'], /only once/],
    [['demo', '--group'], /needs a value/],
    [['demo', 'other', '--group', '/g'], /Usage/],
  ];
  for (const [args, pattern] of bad) assert.throws(() => parseProjectNewArgs(args), pattern, args.join(' '));
});

test('a refusal never prints a remote that holds credentials', () => {
  try { parseProjectNewArgs(['demo', '--group', '/g', '--remote', 'https://user:secret@host/x.git']); } catch (error) { assert.doesNotMatch(error.message, /secret/); return; }
  assert.fail('expected a refusal');
});

test('accepts a public repository only with a remote that is not none', () => {
  assert.equal(parseProjectNewArgs(['demo', '--group', '/g', '--visibility', 'public', '--remote', 'gh']).visibility, 'public');
  assert.equal(parseProjectNewArgs(['demo', '--group', '/g', '--visibility', 'public', '--remote', 'https://example.invalid/x.git']).visibility, 'public');
  assert.equal(parseProjectNewArgs(['demo', '--group', '/g', '--remote', 'git@example.invalid:x/y.git']).remote, 'git@example.invalid:x/y.git');
});

const pane = (label) => () => ({ pane: { pane_id: 'p1', workspace_id: 'w1', label } });
const paneEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'w1' };

test('a plain terminal, the boss, and an orchestrator may run project new', () => {
  assert.equal(verifyProjectCaller({}, () => { throw new Error('no call'); }).role, 'owner');
  assert.equal(verifyProjectCaller(paneEnv, pane('boss')).role, 'boss');
  assert.equal(verifyProjectCaller(paneEnv, pane('orch')).role, 'orch');
});

test('a worker pane and an unverified pane are refused', () => {
  assert.throws(() => verifyProjectCaller(paneEnv, pane('png')), /Only the pane labeled boss or a pane labeled orch.*project new/);
  assert.throws(() => verifyProjectCaller(paneEnv, pane(undefined)), /project new/);
  assert.throws(() => verifyProjectCaller({ HERDR_ENV: '1' }, pane('boss')), /HERDR_PANE_ID/);
  assert.throws(() => verifyProjectCaller({ HERDR_PANE_ID: 'p1' }, pane('boss')), /HERDR_WORKSPACE_ID|HERDR_ENV/);
});

test('a worker pane creates nothing', () => {
  const f = fixture();
  try {
    const out = [];
    assert.throws(() => projectCommand(['new', 'demo', '--group', f.group], { env: paneEnv, herdr: pane('png'), dataDir: f.dataDir, log: (l) => out.push(l) }), /project new/);
    assert.deepEqual(fs.readdirSync(f.group), []);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
  } finally { f.cleanup(); }
});

test('a dry run prints each step, the path, and the next action, and changes nothing', () => {
  const f = fixture();
  try {
    const out = [];
    const code = projectCommand(['new', 'demo', '--group', f.group, '--dry-run'], { env: {}, herdr: () => { throw new Error('no call'); }, dataDir: f.dataDir, log: (l) => out.push(l) });
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /validate\s+would check the slug demo/);
    assert.match(text, /folder\s+would run mkdir -p/);
    assert.match(text, /files\s+would write AGENTS\.md/);
    assert.match(text, /remote\s+skipped: --remote none/);
    assert.match(text, /harness\s+skipped: not the live data dir/);
    assert.match(text, /check\s+not built yet/);
    assert.match(text, new RegExp(`Path: ${path.join(f.group, 'demo').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /Next: /);
    assert.deepEqual(fs.readdirSync(f.group), []);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
  } finally { f.cleanup(); }
});

test('cli: a dry run exits 0 and writes nothing', () => {
  const f = fixture();
  try {
    const result = f.cli('project', 'new', 'demo', '--group', f.group, '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would run mkdir -p/);
    assert.deepEqual(fs.readdirSync(f.group), []);
  } finally { f.cleanup(); }
});

test('cli: a real run creates the folder, prints done states, and exits 0', () => {
  const f = fixture();
  try {
    const result = f.cli('project', 'new', 'demo', '--group', f.group);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /folder\s+done/);
    assert.match(result.stdout, /commit\s+done/);
    assert.match(result.stdout, /workspace\s+skipped: no --start/);
    assert.equal(execFileSync('git', ['-C', path.join(f.group, 'demo'), 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim(), 'Test User <test@example.invalid>');
    assert.ok(fs.existsSync(path.join(f.group, 'demo', 'AGENTS.md')));
  } finally { f.cleanup(); }
});

test('cli: usage errors and refusals exit 1 with a message on stderr', () => {
  const f = fixture();
  try {
    for (const args of [
      ['project', 'new', 'demo'],
      ['project', 'new', 'demo', '--group', f.group, '--bogus'],
      ['project', 'new', 'demo', '--group', f.group, '--visibility', 'public'],
      ['project', 'new', 'Bad Slug', '--group', f.group],
      ['project', 'new', 'demo', '--group', f.group, '--resume'],
      ['project', 'new'],
      ['project'],
      ['project', 'bogus'],
    ]) {
      const result = f.cli(...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.ok(result.stderr.length > 0, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(f.group), []);
  } finally { f.cleanup(); }
});

test('cli: an unknown flag prints the usage line', () => {
  const f = fixture();
  try {
    const result = f.cli('project', 'new', 'demo', '--group', f.group, '--bogus');
    assert.match(result.stderr, /Unknown option: --bogus/);
    assert.match(result.stderr, /Usage: project new <slug>/);
  } finally { f.cleanup(); }
});

test('cli: project check exits 1 on a usage error and 4 for a project that is not registered', () => {
  const f = fixture();
  try {
    const result = f.cli('project', 'check', 'demo');
    assert.equal(result.status, 4);
    assert.match(result.stdout, /folder\s+missing: no folder is known/);
    assert.equal(f.cli('project', 'check').status, 1);
    assert.match(f.cli('project', 'check', 'demo', '--bogus').stderr, /Usage: project check/);
  } finally { f.cleanup(); }
});

test('cli: the help lists project new and project check', () => {
  const f = fixture();
  try {
    const result = f.cli();
    assert.match(result.stdout, /project new <slug>/);
    assert.match(result.stdout, /project check <slug>/);
  } finally { f.cleanup(); }
});

test('in a factory the parser needs neither --group nor --path, and a Mac install keeps the refusal', () => {
  const parsed = parseProjectNewArgs(['demo', '--remote', 'none'], { factory: true });
  assert.equal(parsed.slug, 'demo');
  assert.equal(parsed.group, undefined);
  assert.equal(parsed.path, undefined);
  assert.throws(() => parseProjectNewArgs(['demo'], { factory: false }), /--group DIR or --path DIR/);
  assert.throws(() => parseProjectNewArgs(['demo']), /--group DIR or --path DIR/);
});
