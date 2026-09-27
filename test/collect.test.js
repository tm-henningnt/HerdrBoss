import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMachine, collectQuotas, collectWorktreeCounts } from '../src/collect.js';

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
  assert.deepEqual(first, { a: { linked: 2, prunable: 1 } });
  assert.equal(calls.filter((args) => args.includes('list')).length, 1);
  calls.length = 0;
  await collectWorktreeCounts(panes, { now: 2000, runner });
  assert.equal(calls.filter((args) => args.includes('list')).length, 0);
});

test('worktree counts exclude Boss panes and attribute a shared repository once to its orch workspace', async () => {
  const calls = [];
  const runner = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('--git-common-dir')) return '/repo/.git\n';
    if (args.includes('list')) return 'worktree /repo\nHEAD a\n\nworktree /repo-wt\nHEAD b\n';
    throw new Error('unexpected');
  };
  const panes = [
    { orch: true, label: 'orch', workspaceLabel: 'Boss', workspace: 'wBoss', cwd: '/repo' },
    { orch: true, label: 'orch', workspace: 'wB', cwd: '/repo-wt' },
    { orch: false, workspace: 'wOther', cwd: '/repo' },
  ];
  assert.deepEqual(await collectWorktreeCounts(panes, { now: 4000000, runner }), { wB: { linked: 1, prunable: 0 } });
  assert.equal(calls.filter((args) => args.includes('--git-common-dir')).length, 1);
  assert.equal(calls.filter((args) => args.includes('list')).length, 1);
});

test('failed Git worktree listing skips that project', async () => {
  const runner = async (_cmd, args) => {
    if (args.includes('--git-common-dir')) return '/failed/.git\n';
    throw new Error('git unavailable');
  };
  assert.deepEqual(await collectWorktreeCounts([{ orch: true, workspace: 'failed', cwd: '/failed' }], { now: 900000, runner }), {});
});

test('a codexbar timeout reports the timeout and the read waits 240 seconds', async () => {
  let options;
  const runner = async (_cmd, _args, opts) => {
    options = opts;
    throw Object.assign(new Error('Command failed: codexbar usage --format json'), { killed: true, signal: 'SIGTERM', code: null, stderr: '' });
  };
  await assert.rejects(collectQuotas({ runner }), { message: 'codexbar timed out after 240 s' });
  assert.equal(options.timeout, 240000);
});

test('a codexbar non-zero exit reports the exit code and the first stderr line', async () => {
  const fail = (stderr) => async () => { throw Object.assign(new Error('Command failed: codexbar usage --format json'), { killed: false, signal: null, code: 2, stderr }); };
  await assert.rejects(collectQuotas({ runner: fail('login expired\nsecond line\n') }), { message: 'codexbar exited with code 2: login expired' });
  await assert.rejects(collectQuotas({ runner: fail('\n') }), { message: 'codexbar exited with code 2' });
});

test('collectQuotas parses the codexbar rows from the runner', async () => {
  const runner = async () => JSON.stringify([{ provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: 'r', windowMinutes: 300 } } }]);
  const [row] = await collectQuotas({ runner });
  assert.equal(row.provider, 'codex');
  assert.equal(row.windows[0].usedPercent, 12);
});
