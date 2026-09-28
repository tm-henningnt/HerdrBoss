import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseScreenshotOptions, saveBrowserScreenshot } from '../src/browser-output.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-output-'));
}

test('browser screenshot saves under TMPDIR when set', () => {
  const dir = tempDir();
  const file = saveBrowserScreenshot(Buffer.from('jpeg'), { env: { TMPDIR: dir } });
  assert.equal(path.dirname(file), dir);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('jpeg'));
});

test('browser screenshot --out overrides TMPDIR and accepts --tab with it', () => {
  const tmp = tempDir();
  const out = path.join(tempDir(), 'captures');
  const options = parseScreenshotOptions(['--tab', 'tab-1', '--out', out]);
  assert.deepEqual(options, { tab: 'tab-1', out });
  const file = saveBrowserScreenshot(Buffer.from('jpeg'), { out: options.out, env: { TMPDIR: tmp } });
  assert.equal(path.dirname(file), out);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('jpeg'));
});

function browserCliFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-caller-'));
  const root = path.join(base, 'project');
  const dataDir = path.join(base, 'data');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'alpha' }));
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify({
    alpha: { project: 'alpha', port: 1, profile: path.join(dataDir, 'browser-profiles', 'alpha'), headless: true, windowSize: { width: 1280, height: 800 }, bookmarks: [], startPage: null },
    beta: { project: 'beta', port: 1, profile: path.join(dataDir, 'browser-profiles', 'beta'), headless: true, windowSize: { width: 1280, height: 800 }, bookmarks: [], startPage: null },
  }));
  fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify({ control: { workspaces: [
    { slug: 'alpha', workspace: 'workspace-alpha', label: 'Alpha', boss: false },
    { slug: 'beta', workspace: 'workspace-beta', label: 'Beta', boss: false },
    { slug: 'boss', workspace: 'workspace-boss', label: 'Boss', boss: true },
  ] } }));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'pane' || args[1] !== 'get') process.exit(2);\nconst id = args[2];\nconst label = id === 'boss-pane' ? 'boss' : id === 'worker-pane' ? 'worker' : id === 'helper-pane' ? undefined : 'orch';\nconsole.log(JSON.stringify({ result: { pane: { pane_id: id, workspace_id: process.env.HERDR_WORKSPACE_ID, label } } }));\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const envFor = ({ pane = 'orch-pane', workspace = 'workspace-alpha' } = {}) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_BOSS_DIR: dataDir };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_WORKSPACE_ID;
    delete env.HERDR_ENV;
    delete env.HERDR_WORKTREE;
    if (pane) Object.assign(env, { HERDR_ENV: '1', HERDR_PANE_ID: pane, HERDR_WORKSPACE_ID: workspace });
    return env;
  };
  const run = (args, options = {}) => spawnSync(process.execPath, [CLI, 'browser', ...args], {
    cwd: options.cwd ?? root,
    env: envFor(options),
    encoding: 'utf8',
  });
  return { base, root, dataDir, run };
}

test('browser CLI refuses a project orchestrator changing another project browser', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['size', 'beta', '1200', '700']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trim(), 'The beta browser belongs to project beta. This pane is in workspace Alpha (workspace-alpha), which belongs to project alpha. Only a pane in the beta workspace or the Boss can change it.');
});

test('browser CLI allows the caller project and the Boss to change project browsers', (t) => {
  const fixture = browserCliFixture(t);
  const own = fixture.run(['size', 'alpha', '1200', '700']);
  assert.equal(own.status, 0, own.stderr);
  const boss = fixture.run(['size', 'beta', '1200', '700'], { pane: 'boss-pane', workspace: 'workspace-boss' });
  assert.equal(boss.status, 0, boss.stderr);
});

test('browser CLI keeps plain-terminal behavior and warns when no Herdr pane exists', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['size', 'beta', '1200', '700'], { pane: null });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), 'Warning: no Herdr pane; the project check is skipped.');
});

test('browser CLI leaves list and tabs available for another project', (t) => {
  const fixture = browserCliFixture(t);
  fs.writeFileSync(path.join(fixture.dataDir, 'browser-sessions.json'), '{}');
  const list = fixture.run(['list']);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), []);
  assert.equal(list.stderr, '');
  const tabs = fixture.run(['tabs', 'beta']);
  assert.equal(tabs.status, 1);
  assert.match(tabs.stderr, /No project browser is registered/);
  assert.doesNotMatch(tabs.stderr, /belongs to project/);
  assert.doesNotMatch(tabs.stderr, /no Herdr pane/);
  const bookmarks = fixture.run(['bookmarks', 'beta', 'list']);
  assert.equal(bookmarks.status, 0, bookmarks.stderr);
  assert.deepEqual(JSON.parse(bookmarks.stdout), { bookmarks: [], startPage: null });
});

test('browser request checks the caller before reserving another project browser', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['request', 'beta', '--reserve']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trim(), 'The beta browser belongs to project beta. This pane is in workspace Alpha (workspace-alpha), which belongs to project alpha. Only a pane in the beta workspace or the Boss can change it.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'browser-sessions.json'), 'utf8')).beta.port, 1);
});

test('browser CLI identifies a worker by its live pane and worktree record', (t) => {
  const fixture = browserCliFixture(t);
  const runs = path.join(fixture.root, '.orchestration', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'worker-a.json'), JSON.stringify({ name: 'worker-a', pane: 'worker-pane', worktree: fixture.root }));
  const result = fixture.run(['size', 'beta', '1200', '700'], { pane: 'worker-pane', workspace: 'workspace-alpha' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trim(), 'The beta browser belongs to project beta. This pane is in workspace Alpha (workspace-alpha), which belongs to project alpha. Only a pane in the beta workspace or the Boss can change it.');
});

test('browser CLI allows an unlabeled pane in the project workspace', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['size', 'alpha', '1200', '700'], { pane: 'helper-pane', workspace: 'workspace-alpha' });
  assert.equal(result.status, 0, result.stderr);
});

test('browser CLI refuses a pane in another project workspace, whatever its cwd config', (t) => {
  const fixture = browserCliFixture(t);
  // The cwd config says alpha, but the pane sits in the beta workspace, so the workspace decides.
  const own = fixture.run(['size', 'beta', '1200', '700'], { pane: 'helper-pane', workspace: 'workspace-beta' });
  assert.equal(own.status, 0, own.stderr);
  const other = fixture.run(['size', 'alpha', '1200', '700'], { pane: 'helper-pane', workspace: 'workspace-beta' });
  assert.equal(other.status, 1, other.stderr);
  assert.equal(other.stderr.trim(), 'The alpha browser belongs to project alpha. This pane is in workspace Beta (workspace-beta), which belongs to project beta. Only a pane in the alpha workspace or the Boss can change it.');
});

test('browser CLI allows any pane in the Boss workspace', (t) => {
  const fixture = browserCliFixture(t);
  const result = fixture.run(['size', 'beta', '1200', '700'], { pane: 'helper-pane', workspace: 'workspace-boss' });
  assert.equal(result.status, 0, result.stderr);
});

test('browser CLI allows a worker in a shared .herdr-wt worktree by its workspace alone', (t) => {
  const fixture = browserCliFixture(t);
  // A worker worktree under ~/Projects/.herdr-wt/<repo>/<name> has no run record that matches its cwd.
  const worktree = path.join(fixture.base, 'Projects', '.herdr-wt', 'Alpha', 'w1');
  fs.mkdirSync(worktree, { recursive: true });
  const own = fixture.run(['size', 'alpha', '1200', '700'], { pane: 'worker-pane', workspace: 'workspace-alpha', cwd: worktree });
  assert.equal(own.status, 0, own.stderr);
  const other = fixture.run(['size', 'beta', '1200', '700'], { pane: 'worker-pane', workspace: 'workspace-alpha', cwd: worktree });
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /belongs to project beta\. This pane is in workspace Alpha \(workspace-alpha\)/);
});
