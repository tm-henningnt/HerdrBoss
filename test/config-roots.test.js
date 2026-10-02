import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('saved worktree root reaches workers, leases, harness roots, and log attribution with project overrides', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  const repo = path.join(home, 'Shop');
  const trees = path.join(home, 'custom trees');
  fs.mkdirSync(data); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ worktreeRoot: trees, projectRoot: '~/custom projects' }));
  const source = `
    import fs from 'node:fs';
    import { loadProjectConfig, sharedWorktreeRoot } from './src/kit/config.js';
    import { projectWorktreeRoot } from './src/leases.js';
    import { requiredRoots, fillTemplate } from './src/harness.js';
    import { projectFor, projectForPiFolder } from './src/denials.js';
    const home = process.env.HOME, repo = home + '/Shop', trees = home + '/custom trees';
    const worker = loadProjectConfig({ cwd: repo, home });
    const roots = requiredRoots({ home, dataDir: process.env.HERDR_BOSS_DIR });
    const template = fillTemplate('Worker worktrees are in {{HOME}}/Projects/.herdr-wt/<repo>/<name>.', { home, dataDir: process.env.HERDR_BOSS_DIR });
    const repos = [{ slug: 'shop', repo }];
    const shared = sharedWorktreeRoot(home);
    const leaseRoot = projectWorktreeRoot(repo);
    const attribution = projectFor(trees + '/Shop/fix/src', repos, home);
    const pi = projectForPiFolder('--' + (trees + '/Shop/fix').replace(/^[/]/, '').replaceAll('/', '-') + '--', repos, home);
    fs.writeFileSync(repo + '/.herdr-boss.json', JSON.stringify({ worktreeRoot: '~/project trees' }));
    const own = loadProjectConfig({ cwd: repo, home });
    console.log(JSON.stringify({ shared, worker: worker.worktreePath('fix'), leaseRoot, roots, template, attribution, pi, own: own.worktreePath('fix') }));
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data },
  });
  const answer = JSON.parse(result);
  assert.equal(answer.shared, trees);
  assert.equal(answer.worker, path.join(trees, 'Shop', 'fix'));
  assert.equal(answer.leaseRoot, path.join(trees, 'Shop'));
  assert.ok(answer.roots.some((entry) => entry.path === trees));
  assert.equal(answer.template, `Worker worktrees are in ${trees}/<repo>/<name>.`);
  assert.equal(answer.attribution, 'shop');
  assert.equal(answer.pi, 'shop');
  assert.equal(answer.own, path.join(home, 'project trees', 'Shop', 'fix'));
});
