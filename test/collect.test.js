import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMachine, collectWorktreeCounts } from '../src/collect.js';

test('machine snapshot measures free space on the supplied data filesystem', async () => {
  const machine = await collectMachine(process.cwd());
  assert.ok(Number.isFinite(machine.diskFreeBytes) && machine.diskFreeBytes > 0);
  assert.ok(Number.isFinite(machine.diskFreePercent) && machine.diskFreePercent > 0);
  assert.ok(Number.isFinite(machine.diskTotalBytes) && machine.diskTotalBytes >= machine.diskFreeBytes);
  assert.equal(machine.diskFreePercent, machine.diskFreeBytes / machine.diskTotalBytes * 100);
});

test('worktree counts deduplicate common repositories and cache results', async () => {
  const calls = [];
  const runner = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('--git-common-dir')) return '/repo/.git\n';
    if (args.includes('list')) return 'worktree /repo\nHEAD a\n\nworktree /repo-wt\nHEAD b\n\nworktree /missing\nHEAD c\nprunable gone\n';
    throw new Error('unexpected');
  };
  const panes = [{ orch: true, workspace: 'a', cwd: '/repo' }, { orch: true, workspace: 'b', cwd: '/repo-wt' }];
  const first = await collectWorktreeCounts(panes, { now: 1000, runner });
  assert.deepEqual(first, { a: { linked: 2, prunable: 1 }, b: { linked: 2, prunable: 1 } });
  assert.equal(calls.filter((args) => args.includes('list')).length, 1);
  calls.length = 0;
  await collectWorktreeCounts(panes, { now: 2000, runner });
  assert.equal(calls.filter((args) => args.includes('list')).length, 0);
});

test('failed Git worktree listing skips that project', async () => {
  const runner = async (_cmd, args) => {
    if (args.includes('--git-common-dir')) return '/failed/.git\n';
    throw new Error('git unavailable');
  };
  assert.deepEqual(await collectWorktreeCounts([{ orch: true, workspace: 'failed', cwd: '/failed' }], { now: 900000, runner }), {});
});
