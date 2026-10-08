import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMachine, collectProcesses, collectQuotas, collectWorktreeCounts } from '../src/collect.js';

test('collectProcesses parses cputime and process start from one ps sample', async () => {
  const calls = [];
  const processes = await collectProcesses({ runner: async (...args) => {
    calls.push(args);
    return '2468 1 00:01:30 80.0 00:00:12 Mon Sep 28 10:00:00 2026 2048 node --sample-argument\n';
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ps');
  assert.match(calls[0][1].at(-1), /cputime=.*lstart=/);
  assert.equal(calls[0][2].env.LC_ALL, 'C');
  assert.deepEqual(processes.get(2468), {
    pid: 2468, ppid: 1, age: 90, cpu: 80, cpuTimeMs: 12_000,
    start: 'Mon Sep 28 10:00:00 2026', rssMB: 2, cmd: 'node --sample-argument',
  });
});

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

test('a timed-out quota probe reports the provider and uses the first back-off timeout', async () => {
  const calls = [];
  const runner = async (_cmd, args, opts) => {
    calls.push({ provider: args.at(-1), timeout: opts.timeout });
    throw Object.assign(new Error('Command failed: codexbar usage --format json'), { killed: true, signal: 'SIGTERM', code: null, stderr: '' });
  };
  const rows = await collectQuotas({ runner });
  assert.deepEqual(calls, [
    { provider: 'codex', timeout: 20000 },
    { provider: 'claude', timeout: 60000 },
    { provider: 'opencodego', timeout: 20000 },
  ]);
  assert.match(rows.find((row) => row.provider === 'claude').error, /Claude usage probe timed out after 60 s/);
  assert.match(rows.find((row) => row.provider === 'codex').error, /codex quota probe timed out after 20 s/);
  assert.ok(rows.every((row) => row.error));
});

test('a codexbar non-zero exit reports the exit code and the first stderr line per provider', async () => {
  const fail = (stderr) => async () => { throw Object.assign(new Error('Command failed: codexbar usage --format json'), { killed: false, signal: null, code: 2, stderr }); };
  const first = await collectQuotas({ runner: fail('login expired\nsecond line\n') });
  assert.ok(first.every((row) => row.error.includes('exited with code 2: login expired')));
  const second = await collectQuotas({ runner: fail('\n') });
  assert.ok(second.every((row) => row.error.includes('exited with code 2')));
});

test('collectQuotas parses the codexbar rows from the runner', async () => {
  const runner = async () => JSON.stringify([{ provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: 'r', windowMinutes: 300 } } }]);
  const [row] = await collectQuotas({ runner });
  assert.equal(row.provider, 'codex');
  assert.equal(row.windows[0].usedPercent, 12);
});

test('collectQuotas keeps only safe Codex reset credit fields', async () => {
  const runner = async () => JSON.stringify([{
    provider: 'codex',
    usage: {
      primary: { usedPercent: 12, resetsAt: '2032-04-08T00:00:00.000Z', windowMinutes: 10080 },
      codexResetCredits: {
        availableCount: 2,
        credits: [
          { id: 'credit-a', status: 'available', granted_at: '2032-04-01T00:00:00Z', expires_at: '2032-04-10T00:00:00Z', account_id: 'private-account', email: 'owner@example.invalid', token: 'private-token', extra: 'drop' },
          { status: 'used', granted_at: '2032-03-01T00:00:00Z', expires_at: '2032-03-10T00:00:00Z', account_id: 'also-private' },
        ],
      },
    },
  }]);
  const [row] = await collectQuotas({ runner });
  assert.equal(row.resetCredits, 2);
  assert.deepEqual(row.codexResetCredits, [
    { id: 'credit-a', status: 'available', grantedAt: '2032-04-01T00:00:00.000Z', expiresAt: '2032-04-10T00:00:00.000Z' },
    { id: row.codexResetCredits[1].id, status: 'used', grantedAt: '2032-03-01T00:00:00.000Z', expiresAt: '2032-03-10T00:00:00.000Z' },
  ]);
  assert.match(row.codexResetCredits[1].id, /^credit-[0-9a-f]{10}$/);
  assert.doesNotMatch(JSON.stringify(row), /private-account|owner@example|private-token|drop/);
});

test('a credit without a provider id keeps its id when the list changes', async () => {
  const credit = (grant, expiry) => ({ status: 'available', granted_at: grant, expires_at: expiry });
  const a = credit('2032-04-01T00:00:00Z', '2032-04-10T00:00:00Z');
  const b = credit('2032-04-02T00:00:00Z', '2032-04-17T00:00:00Z');
  const rowFor = async (credits) => {
    const runner = async () => JSON.stringify([{ provider: 'codex', usage: { primary: { usedPercent: 12, resetsAt: '2032-04-08T00:00:00.000Z', windowMinutes: 10080 }, codexResetCredits: { credits } } }]);
    return (await collectQuotas({ runner }))[0];
  };
  const both = await rowFor([a, b]);
  const onlyB = await rowFor([b]);
  assert.equal(onlyB.codexResetCredits[0].id, both.codexResetCredits[1].id);
});
