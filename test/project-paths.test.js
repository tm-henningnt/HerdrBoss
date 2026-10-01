import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const REPO = path.resolve(path.dirname(CLI), '..');
const TMP = path.resolve(os.tmpdir()).startsWith(REPO) ? '/tmp' : os.tmpdir();

function fixture() {
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-project-paths-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const env = { PATH: process.env.PATH, HOME: root, HERDR_BOSS_DIR: dataDir };
  const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, 'project', 'paths', ...args], { cwd, env, encoding: 'utf8' });
  return { root, dataDir, env, cli, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initGitRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
}

test('project paths prints registered paths by slug and excludes the current checkout', () => {
  const f = fixture();
  try {
    const current = path.join(f.root, 'current');
    fs.mkdirSync(current);
    const currentSubdirectory = path.join(current, 'src');
    fs.mkdirSync(currentSubdirectory);
    const rows = [
      { slug: 'zeta', repo: path.join(f.root, 'missing-zeta') },
      { slug: 'current', repo: fs.realpathSync(current) },
      { slug: 'alpha', repo: path.join(f.root, 'missing-alpha') },
    ];
    fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify(rows));

    const text = f.cli(currentSubdirectory);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout, `alpha=${rows[2].repo} zeta=${rows[0].repo}\n`);

    const json = f.cli(currentSubdirectory, '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), [
      { slug: 'alpha', path: rows[2].repo },
      { slug: 'zeta', path: rows[0].repo },
    ]);
  } finally { f.cleanup(); }
});

test('project paths excludes the main checkout when run from a linked git worktree', () => {
  const f = fixture();
  try {
    const owner = path.join(f.root, 'owner');
    const worker = path.join(f.root, 'worker');
    initGitRepo(owner);
    git(owner, 'worktree', 'add', '-q', '-b', 'worker', worker);
    const rows = [
      { slug: 'owner', repo: owner },
      { slug: 'alpha', repo: path.join(f.root, 'missing-alpha') },
    ];
    fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify(rows));

    const result = f.cli(worker);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `alpha=${rows[1].repo}\n`);
  } finally { f.cleanup(); }
});

test('project paths resolves a symlinked registered path before excluding the current checkout', () => {
  const f = fixture();
  try {
    const current = path.join(f.root, 'current');
    const registeredAlias = path.join(f.root, 'registered-alias');
    initGitRepo(current);
    fs.symlinkSync(current, registeredAlias, 'dir');
    const rows = [
      { slug: 'current', repo: registeredAlias },
      { slug: 'other', repo: path.join(f.root, 'missing-other') },
    ];
    fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify(rows));

    const result = f.cli(current, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ slug: 'other', path: rows[1].repo }]);
  } finally { f.cleanup(); }
});

test('project paths prints an empty line or an empty JSON array when no projects are registered', () => {
  const f = fixture();
  try {
    const text = f.cli(f.root);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout, '\n');

    const json = f.cli(f.root, '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), []);
  } finally { f.cleanup(); }
});

test('project paths rejects unsupported arguments and appears in help', () => {
  const f = fixture();
  try {
    const bad = f.cli(f.root, '--bogus');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Usage: project paths \[--json\]/);

    const help = spawnSync(process.execPath, [CLI], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /project paths \[--json\]/);
  } finally { f.cleanup(); }
});
