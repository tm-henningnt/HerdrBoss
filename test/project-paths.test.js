import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinProject, pinnedProjects } from '../src/git-pins.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const REPO = path.resolve(path.dirname(CLI), '..');
const TMP = path.resolve(os.tmpdir()).startsWith(REPO) ? '/tmp' : os.tmpdir();

function fixture() {
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-project-paths-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const env = { PATH: process.env.PATH, HOME: root, HERDR_BOSS_DIR: dataDir };
  const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, 'project', ...args], { cwd, env, encoding: 'utf8' });
  const cli = (cwd, ...args) => run(cwd, 'paths', ...args);
  const project = (...args) => run(root, ...args);
  return { root, dataDir, env, cli, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
    assert.match(help.stdout, /project unregister <slug>/);
  } finally { f.cleanup(); }
});

test('project unregister backs up the registry and removes only the selected row', () => {
  const f = fixture();
  try {
    const keep = { slug: 'keep', repo: path.join(f.root, 'keep-project'), remote: 'none' };
    const remove = { slug: 'remove', repo: path.join(f.root, 'remove-project'), remote: 'none' };
    const unrelated = { legacy: true };
    initGitRepo(keep.repo);
    initGitRepo(remove.repo);
    const worktree = path.join(f.root, 'remove-worktree');
    git(remove.repo, 'worktree', 'add', '-q', '-b', 'registered-worktree', worktree);
    const registry = path.join(f.dataDir, 'project-repos.json');
    const original = `${JSON.stringify([keep, remove, unrelated], null, 2)}\n`;
    fs.writeFileSync(registry, original, { mode: 0o600 });

    const result = f.project('unregister', 'remove');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Project remove unregistered/);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')), [keep, unrelated]);
    const backups = fs.readdirSync(f.dataDir).filter((name) => name.startsWith('project-repos.json.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(f.dataDir, backups[0]), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(remove.repo, 'README.md'), 'utf8'), 'fixture\n');
    assert.ok(fs.existsSync(path.join(worktree, 'README.md')));
    assert.match(git(remove.repo, 'branch', '--list'), /registered-worktree/);
    assert.ok(git(remove.repo, 'worktree', 'list', '--porcelain').includes(worktree));
    assert.ok(fs.existsSync(path.join(keep.repo, 'README.md')));
  } finally { f.cleanup(); }
});

test('project unregister refuses an unknown slug without changing the registry', () => {
  const f = fixture();
  try {
    const rows = [{ slug: 'known', repo: path.join(f.root, 'known-project'), remote: 'none' }];
    const registry = path.join(f.dataDir, 'project-repos.json');
    const original = `${JSON.stringify(rows, null, 2)}\n`;
    fs.writeFileSync(registry, original, { mode: 0o600 });

    const result = f.project('unregister', 'missing');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown project slug: missing/);
    assert.equal(fs.readFileSync(registry, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(f.dataDir), ['project-repos.json']);
  } finally { f.cleanup(); }
});

test('project unregister clears only its Git pin and browser reservation and leaves the browser record', () => {
  const f = fixture();
  try {
    const remove = { slug: 'remove', repo: path.join(f.root, 'remove') };
    const keep = { slug: 'keep', repo: path.join(f.root, 'keep') };
    for (const project of [remove, keep]) {
      initGitRepo(project.repo);
      pinProject(project, { home: f.root, env: f.env });
    }
    fs.writeFileSync(path.join(f.dataDir, 'project-repos.json'), JSON.stringify([remove, keep]));
    const reservations = [
      { pool: 'project-browsers', project: 'remove', item: '9223' },
      { pool: 'project-browsers', project: 'keep', item: '9224' },
      { pool: 'serve-ports', project: 'remove', worker: 'test', item: '5000' },
    ];
    fs.writeFileSync(path.join(f.dataDir, 'leases.json'), JSON.stringify({ leases: reservations }));
    const browserRecord = JSON.stringify({ remove: { project: 'remove', port: 9223, headless: true } });
    fs.writeFileSync(path.join(f.dataDir, 'browser-sessions.json'), browserRecord);
    const result = f.project('unregister', 'remove');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pinnedProjects({ home: f.root }), [keep]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'leases.json'), 'utf8')).leases, reservations.slice(1));
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'browser-sessions.json'), 'utf8'), browserRecord);
    assert.ok(fs.existsSync(path.join(remove.repo, 'README.md')));
  } finally { f.cleanup(); }
});
