// The CLI of `herdr-boss project scan`: it lists Git repositories under a folder and proposes
// register records. The command is read-only. Each test runs the CLI in a temporary data folder.
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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-scan-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nif [ "$1" = "pane" ] && [ "$2" = "get" ]; then\n  printf '{"pane":{"pane_id":"%s","label":"%s","workspace_id":"ws-1"}}\\n' "$3" "\${FAKE_HERDR_LABEL:-boss}"\n  exit 0\nfi\nexit 1\n`, { mode: 0o755 });
  const base = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir };
  const run = (args, env = base) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  const registerPath = path.join(dataDir, 'project-register.json');
  const auditPath = path.join(dataDir, 'project-audit.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, dataDir, base, run, registerPath, auditPath };
}

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function gitInit(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
}

function writeRegisterFile(dataDir, records) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects: records }, null, 2)}\n`, { mode: 0o600 });
}

function registered(slug) {
  return {
    slug,
    title: slug,
    group: '',
    repo: '',
    remote: '',
    factory: 'factory-zero',
    state: 'parked',
    pinned: false,
    priority: 'normal',
    issueSource: null,
    autoOpen: 'off',
    lastOpenedAt: '',
    lastActivityAt: '',
    nextAction: '',
    notes: '',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

// A small folder tree:
//   acme-web, harbor-docs, kite-sdk, orchard-api, and Bad_Name are Git repositories.
//   kite-sdk sits at depth 3. notgit is a plain folder. A hidden folder is skipped.
function buildTree(root) {
  gitInit(path.join(root, 'Bad_Name'));
  gitInit(path.join(root, 'acme-web'), 'https://user:secretpass1@example.invalid/acme/web');
  gitInit(path.join(root, 'mid', 'harbor-docs'), 'acme/harbor-docs');
  gitInit(path.join(root, 'mid', 'deep', 'kite-sdk'));
  fs.mkdirSync(path.join(root, 'notgit'), { recursive: true });
  gitInit(path.join(root, 'orchard-api'));
  gitInit(path.join(root, '.hidden', 'hidden-repo'));
}

test('project scan proposes each repository with a stripped remote and counts the results', (t) => {
  const f = fixture(t);
  buildTree(f.root);
  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'skip Bad_Name: the folder name is not a project slug.',
    `propose acme-web ${path.join(f.root, 'acme-web')} https://example.invalid/acme/web`,
    `propose harbor-docs ${path.join(f.root, 'mid', 'harbor-docs')} acme/harbor-docs`,
    `propose orchard-api ${path.join(f.root, 'orchard-api')} -`,
    '3 proposed, 0 registered, 1 without a valid slug.',
    'Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.',
    '',
  ].join('\n'));
  assert.ok(!result.stdout.includes('secretpass1'), 'the scan prints no credential of a remote');
  assert.ok(!result.stdout.includes('hidden-repo'), 'a hidden folder is skipped');
  assert.ok(!fs.existsSync(f.registerPath), 'the scan writes no register');
  assert.ok(!fs.existsSync(f.auditPath), 'the scan writes no audit file');
});

test('project scan marks a repository that the register already holds', (t) => {
  const f = fixture(t);
  buildTree(f.root);
  writeRegisterFile(f.dataDir, [registered('acme-web')]);

  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'skip Bad_Name: the folder name is not a project slug.',
    'registered acme-web',
    `propose harbor-docs ${path.join(f.root, 'mid', 'harbor-docs')} acme/harbor-docs`,
    `propose orchard-api ${path.join(f.root, 'orchard-api')} -`,
    '2 proposed, 1 registered, 1 without a valid slug.',
    'Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.',
    '',
  ].join('\n'));
  const before = fs.readFileSync(f.registerPath, 'utf8');
  assert.equal(fs.readFileSync(f.registerPath, 'utf8'), before, 'the scan changes nothing');
});

test('project scan honors the depth limit', (t) => {
  const f = fixture(t);
  buildTree(f.root);

  const shallow = f.run(['project', 'scan', f.root, '--depth', '1']);
  assert.equal(shallow.status, 0, shallow.stderr);
  assert.equal(shallow.stdout, [
    'skip Bad_Name: the folder name is not a project slug.',
    `propose acme-web ${path.join(f.root, 'acme-web')} https://example.invalid/acme/web`,
    `propose orchard-api ${path.join(f.root, 'orchard-api')} -`,
    '2 proposed, 0 registered, 1 without a valid slug.',
    'Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.',
    '',
  ].join('\n'));

  const deep = f.run(['project', 'scan', f.root, '--depth', '3']);
  assert.equal(deep.status, 0, deep.stderr);
  assert.equal(deep.stdout, [
    'skip Bad_Name: the folder name is not a project slug.',
    `propose acme-web ${path.join(f.root, 'acme-web')} https://example.invalid/acme/web`,
    `propose kite-sdk ${path.join(f.root, 'mid', 'deep', 'kite-sdk')} -`,
    `propose harbor-docs ${path.join(f.root, 'mid', 'harbor-docs')} acme/harbor-docs`,
    `propose orchard-api ${path.join(f.root, 'orchard-api')} -`,
    '4 proposed, 0 registered, 1 without a valid slug.',
    'Next: run herdr-boss project register add SLUG --repo PATH --title TEXT.',
    '',
  ].join('\n'));

  const rootOnly = f.run(['project', 'scan', f.root, '--depth', '0']);
  assert.equal(rootOnly.status, 0, rootOnly.stderr);
  assert.equal(rootOnly.stdout, `No Git repositories found under ${f.root}.\n`);
});

test('project scan does not follow a symlinked folder', (t) => {
  const f = fixture(t);
  // The target is a hidden folder, so the only way to see it is the symlink.
  gitInit(path.join(f.root, '.hidden-target'));
  fs.symlinkSync(path.join(f.root, '.hidden-target'), path.join(f.root, 'zlink'), 'dir');

  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('zlink'), 'the scan does not enter a symlink');
  assert.ok(!result.stdout.includes('hidden-target'), 'the scan sees the target only through the link');
  assert.equal(result.stdout, `No Git repositories found under ${f.root}.\n`);
});

test('project scan does not treat a .git symlink as a repository and removes control characters from output', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'odd\nname', '.git'), { recursive: true });
  fs.mkdirSync(path.join(f.root, '.hidden-git-target'));
  fs.mkdirSync(path.join(f.root, 'linked-repo'));
  fs.symlinkSync(path.join(f.root, '.hidden-git-target'), path.join(f.root, 'linked-repo', '.git'), 'dir');

  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes('odd\nname'), 'folder names do not inject control characters into output');
  assert.ok(!result.stdout.includes('linked-repo'), 'a symlinked .git entry is not a repository');
  assert.ok(result.stdout.includes('skip oddname:'), 'the folder name prints without control characters');
});

test('project scan removes control characters from printed paths', (t) => {
  const f = fixture(t);
  const root = `${f.root}/root\npath`;
  const repo = path.join(root, 'clean-project');
  gitInit(repo);

  const result = f.run(['project', 'scan', root]);
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes('root\npath'), 'a path cannot inject a line break into output');
  assert.ok(result.stdout.includes(`propose clean-project ${repo.replace('\n', '')} -`), 'the path prints without control characters');
});

test('project scan strips URL credentials and query data before printing remotes', (t) => {
  const f = fixture(t);
  gitInit(path.join(f.root, 'query-project'), 'https://host/o/n?access_token=example');
  gitInit(path.join(f.root, 'slash-password'), 'https://user:pa/ss@host/o/n');

  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes('access_token') && !result.stderr.includes('access_token'), 'scan prints no query data');
  assert.ok(!result.stdout.includes('pa/ss') && !result.stderr.includes('pa/ss'), 'scan prints no credential');
  assert.ok(result.stdout.includes('https://host/o/n'), 'scan prints the clean remote');
});

test('project scan --add registers candidates through the register command and supports a dry run', (t) => {
  const f = fixture(t);
  const repo = path.join(f.root, 'candidate-project');
  gitInit(repo, 'https://host/o/candidate-project');

  const dry = f.run(['project', 'scan', f.root, '--add', '--dry-run']);
  assert.equal(dry.status, 0, 'the scan dry run succeeds');
  assert.match(dry.stdout, /would add candidate-project/);
  assert.ok(!fs.existsSync(f.registerPath), 'the dry run writes no register');
  assert.ok(!fs.existsSync(f.auditPath), 'the dry run writes no audit');

  const added = f.run(['project', 'scan', f.root, '--add']);
  assert.equal(added.status, 0, 'the add uses the register add command');
  const record = JSON.parse(fs.readFileSync(f.registerPath, 'utf8')).projects[0];
  assert.ok(record.slug === 'candidate-project' && record.repo === repo, 'the candidate is registered with its folder path');
  assert.equal(record.remote, 'https://host/o/candidate-project');
  assert.equal(fs.readFileSync(f.auditPath, 'utf8').trim().split('\n').length, 1, 'the register add path writes an audit line');
});

test('project scan --add refuses a worker through the register add caller check', (t) => {
  const f = fixture(t);
  gitInit(path.join(f.root, 'candidate-project'));
  const workerEnv = { ...f.base, HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'ws-1', FAKE_HERDR_LABEL: 'worker' };

  const result = f.run(['project', 'scan', f.root, '--add'], workerEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /project lead/);
  assert.ok(!fs.existsSync(f.registerPath), 'a worker adds no project');
});

test('project scan changes no file of the data folder', (t) => {
  const f = fixture(t);
  buildTree(f.root);
  writeRegisterFile(f.dataDir, [registered('acme-web')]);
  const before = fs.readFileSync(f.registerPath, 'utf8');

  const result = f.run(['project', 'scan', f.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /registered acme-web/);
  assert.equal(fs.readFileSync(f.registerPath, 'utf8'), before, 'the register bytes stay');
  assert.ok(!fs.existsSync(f.auditPath), 'the scan writes no audit file');
});

test('project scan runs from any pane: it has no caller check', (t) => {
  const f = fixture(t);
  gitInit(path.join(f.root, 'orchard-api'));
  const workerEnv = { ...f.base, HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'ws-1' };

  const owner = f.run(['project', 'scan', f.root]);
  const worker = f.run(['project', 'scan', f.root], workerEnv);
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(worker.stdout, owner.stdout, 'the read-only scan works from a worker pane');
});

test('project scan rejects bad usage', (t) => {
  const f = fixture(t);
  gitInit(path.join(f.root, 'orchard-api'));

  const none = f.run(['project', 'scan']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage: project scan DIR/);

  const badDepth = f.run(['project', 'scan', f.root, '--depth', 'x']);
  assert.equal(badDepth.status, 1);
  assert.match(badDepth.stderr, /--depth must be a whole number from 0 to 10/);

  const bigDepth = f.run(['project', 'scan', f.root, '--depth', '11']);
  assert.equal(bigDepth.status, 1);
  assert.match(bigDepth.stderr, /--depth must be a whole number from 0 to 10/);

  const noValue = f.run(['project', 'scan', f.root, '--depth']);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--depth needs a value/);

  const flag = f.run(['project', 'scan', f.root, '--bogus']);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /Unknown option: --bogus/);

  const twoDirs = f.run(['project', 'scan', f.root, path.join(f.root, 'orchard-api')]);
  assert.equal(twoDirs.status, 1);
  assert.match(twoDirs.stderr, /Usage: project scan DIR/);

  const missing = f.run(['project', 'scan', path.join(f.root, 'missing')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not a directory/);
});
