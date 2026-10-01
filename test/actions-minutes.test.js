import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectActionsMinutes, refreshActionsMinutes, readActionsMinutes } from '../src/actions-minutes.js';
import { actionsMinutesSeries, actionsMinutesDetailsHtml } from '../public/analytics.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-actions-minutes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function reply(value, status = 0) {
  return { status, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
}

test('collectActionsMinutes reads workflow runs and bills their runner minutes by ISO week', async () => {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args.at(-1).includes('/actions/runs?')) return reply({ workflow_runs: [
      { id: 10, created_at: '2026-09-22T10:00:00Z', status: 'completed' },
      { id: 11, created_at: '2026-10-01T10:00:00Z', status: 'completed' },
    ] });
    if (args.at(-1).endsWith('/runs/10/timing')) return reply({ billable: { UBUNTU: { total_ms: 120000 } } });
    if (args.at(-1).endsWith('/runs/11/timing')) return reply({ billable: { MACOS: { total_ms: 60000 } } });
    return reply({}, 1);
  };
  const result = await collectActionsMinutes({ repos: [{ slug: 'sample', repo: '/tmp/sample', remote: 'https://github.com/acme/sample.git' }], run, now: NOW });

  assert.equal(result.available, true);
  assert.deepEqual(result.weeks, ['2026-W29', '2026-W30', '2026-W31', '2026-W32', '2026-W33', '2026-W34', '2026-W35', '2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40']);
  assert.deepEqual(result.repos[0].minutes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1]);
  assert.deepEqual(result.repos[0].runs, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(result.repos[0].series.map((series) => series.runnerType), ['MACOS', 'UBUNTU']);
  assert.ok(calls.every((call) => call.options.timeout === 10000));
  assert.ok(calls.some((call) => call.args.at(-1) === 'repos/acme/sample/actions/billing/usage'));
  assert.ok(calls.some((call) => call.args.at(-1).includes('created=>=2026-07-13')));
  assert.doesNotMatch(JSON.stringify(result), /stderr|stdout|token|raw response/i);
});

test('collectActionsMinutes keeps ISO week numbers correct across the year boundary', async () => {
  const result = await collectActionsMinutes({
    repos: [{ slug: 'sample', remote: 'https://github.com/acme/sample.git' }],
    run: async (args) => args.at(-1).includes('/actions/runs?')
      ? reply({ workflow_runs: [{ id: 1, created_at: '2021-01-07T10:00:00Z', status: 'completed' }] })
      : args.at(-1).endsWith('/timing')
        ? reply({ run_duration_ms: 60000 })
        : reply({}, 1),
    now: Date.parse('2021-01-08T12:00:00.000Z'),
  });
  assert.deepEqual(result.weeks, ['2020-W43', '2020-W44', '2020-W45', '2020-W46', '2020-W47', '2020-W48', '2020-W49', '2020-W50', '2020-W51', '2020-W52', '2020-W53', '2021-W01']);
  assert.equal(result.repos[0].runs.at(-1), 1);
  assert.equal(result.repos[0].minutes.at(-1), 1);
});

test('collectActionsMinutes skips one failing repository and hides unavailable access', async () => {
  const run = async (args) => {
    const endpoint = args.at(-1);
    if (endpoint.includes('broken/repo')) return { status: 1, stderr: 'private token detail' };
    if (endpoint.includes('/actions/runs?')) return reply({ workflow_runs: [] });
    return reply({});
  };
  const repos = [
    { slug: 'broken', repo: '/tmp/a', remote: 'git@github.com:broken/repo.git' },
    { slug: 'working', repo: '/tmp/b', remote: 'https://github.com/working/repo.git' },
  ];
  const partial = await collectActionsMinutes({ repos, run, now: NOW });
  assert.equal(partial.available, true);
  assert.deepEqual(partial.repos.map((row) => row.repo), ['working/repo']);
  assert.doesNotMatch(JSON.stringify(partial), /private token detail/);

  const unavailable = await collectActionsMinutes({ repos, run: async () => ({ status: 1, stderr: 'token' }), now: NOW });
  assert.deepEqual(unavailable, { available: false, weeks: [], repos: [], updatedAt: null });
});

test('collectActionsMinutes skips a repository when timing would need too many API calls', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args.at(-1));
    if (args.at(-1).includes('/actions/billing/usage')) return reply({});
    if (args.at(-1).includes('/actions/runs?')) return reply({ workflow_runs: Array.from({ length: 26 }, (_, i) => ({ id: i + 1, status: 'completed', created_at: '2026-10-01T10:00:00Z' })) });
    return reply({ billable: { UBUNTU: { total_ms: 60000 } } });
  };
  const result = await collectActionsMinutes({ repos: [{ slug: 'busy', remote: 'https://github.com/acme/busy.git' }], run, now: NOW });
  assert.equal(result.available, false);
  assert.equal(calls.filter((endpoint) => endpoint.endsWith('/timing')).length, 0);
});

test('refreshActionsMinutes persists a 6 hour limit, shares in-flight work, and obeys the setting', async (t) => {
  const dataDir = temp(t);
  const repos = [{ slug: 'sample', repo: '/tmp/sample', remote: 'https://github.com/acme/sample.git' }];
  let calls = 0;
  const run = async (args) => {
    if (!args.at(-1).includes('/actions/runs?')) return reply({});
    calls++;
    if (args.at(-1).includes('/actions/runs?')) return reply({ workflow_runs: [] });
    return reply({ workflow_runs: [] });
  };
  const first = await refreshActionsMinutes({ dataDir, repos, run, now: NOW });
  assert.equal(first.available, true);
  assert.equal(calls, 1);
  assert.deepEqual(readActionsMinutes(dataDir), first);
  await refreshActionsMinutes({ dataDir, repos, run, now: NOW + 6 * 3600000 - 1 });
  assert.equal(calls, 1, 'a recent attempt blocks another API request');
  await refreshActionsMinutes({ dataDir, repos, run, now: NOW + 6 * 3600000 });
  assert.equal(calls, 2, 'the next API request starts at six hours');
  assert.deepEqual(readActionsMinutes(dataDir), await readActionsMinutes(dataDir));

  const gatedDir = temp(t);
  await refreshActionsMinutes({ dataDir: gatedDir, repos, run, now: NOW, enabled: false });
  assert.equal(calls, 2, 'the off setting makes no API request');
  assert.equal(readActionsMinutes(gatedDir, { enabled: false }).available, false);

  const pendingDir = temp(t);
  let release;
  let pendingCalls = 0;
  const slowRun = (args) => {
    if (!args.at(-1).includes('/actions/runs?')) return reply({});
    pendingCalls++;
    return new Promise((resolve) => { release = () => resolve(reply({ workflow_runs: [] })); });
  };
  const a = refreshActionsMinutes({ dataDir: pendingDir, repos, run: slowRun, now: NOW });
  const b = refreshActionsMinutes({ dataDir: pendingDir, repos, run: slowRun, now: NOW });
  assert.strictEqual(a, b, 'the in-flight refresh shares one promise');
  assert.equal(pendingCalls, 0, 'the refresh starts outside the caller stack');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingCalls, 1, 'only one API call runs while a refresh is in flight');
  release();
  assert.equal((await a).available, true);
  assert.equal((await b).available, true);
});

test('Actions minutes view helpers handle empty data and bound repository colors', async () => {
  const empty = actionsMinutesSeries({ weeks: [], repos: [] });
  assert.deepEqual(empty, { weeks: [], series: [], total: 0 });
  assert.equal(actionsMinutesDetailsHtml({ weeks: [], repos: [] }), '<div class="calm-state">No GitHub Actions runs are recorded in the last 12 weeks.</div>');

  const data = { weeks: ['2026-W39', '2026-W40'], repos: Array.from({ length: 8 }, (_, i) => ({ repo: `owner/repo-${i}`, minutes: [i + 1, i + 2], runs: [2, 3] })) };
  const win = actionsMinutesSeries(data);
  assert.equal(win.series.length, 6);
  assert.equal(win.series.at(-1).label, 'Other');
  assert.deepEqual(win.series.at(-1).values, [21, 24]);
  const details = actionsMinutesDetailsHtml(data);
  assert.match(details, /owner\/repo-0/);
  assert.match(details, /This week/);
  assert.match(details, /Last week/);
  assert.doesNotMatch(details, /NaN|Infinity|<table>/);
  const svg = (await import('../public/analytics.js')).stackedBars({
    cats: win.weeks.map((week) => ({ label: week, tip: week })), series: win.series, label: 'Actions minutes by repository',
  });
  assert.match(svg, /class="viz-fill s-other"/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});
