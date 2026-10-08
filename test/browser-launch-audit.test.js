import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserSafetyNotices, browserSafetyNoticeDelta, browserSafetyAlert } from '../src/browser-safety.js';

const startedAt = 'Thu Oct 8 10:00:00 2026';
const pane = { id: 'w1:p2', workspace: 'w1', shellPid: 10, agent: 'worker' };
const projects = { alpha: { workspace: 'w1' } };
function processes(launcher = 'node /fixture/perf-harness.js', startIdentity = startedAt) {
  return new Map([
    [10, { pid: 10, ppid: 1, cmd: 'zsh' }],
    [20, { pid: 20, ppid: 10, cmd: launcher }],
    [30, { pid: 30, ppid: 20, startIdentity,
      cmd: 'Chromium --remote-debugging-pipe --headless --user-data-dir=/fixture/private-profile https://private.example.test/?code=fixture-value' }],
  ]);
}

test('independent launch notices attribute the browser to its parent pane and launcher without argument text', () => {
  const [notice] = browserSafetyNotices({ processes: processes(), panes: [pane], projects });
  assert.deepEqual({ pid: notice.pid, pane: notice.pane, startIdentity: notice.startIdentity, launcherKind: notice.launcherKind },
    { pid: 30, pane: 'w1:p2', startIdentity: startedAt, launcherKind: 'perf-harness' });
  assert.equal(notice.project, 'alpha');
  assert.doesNotMatch(JSON.stringify(notice), /private-profile|private\.example|fixture-value|perf-harness\.js/);
});

test('the first observed association survives an orphan, a missing snapshot, and a service restart', () => {
  const associations = {};
  const first = browserSafetyNotices({ processes: processes(), panes: [pane], projects, associations });
  const orphan = new Map([[30, { ...processes().get(30), ppid: 1 }]]);
  browserSafetyNotices({ processes: new Map(), associations });
  const restored = JSON.parse(JSON.stringify(associations));
  const later = browserSafetyNotices({ processes: orphan, associations: restored });
  assert.deepEqual(later, first);
  // A changed pane tree must not rewrite the first association of this process.
  assert.deepEqual(browserSafetyNotices({ processes: processes('playwright'), panes: [{ ...pane, id: 'w2:p3', workspace: 'w2' }],
    projects: { beta: { workspace: 'w2' } }, associations: restored }), first);
  const reused = browserSafetyNotices({ processes: processes('playwright', 'Thu Oct 8 11:00:00 2026'), panes: [pane], projects, associations: restored });
  assert.equal(reused[0].launcherKind, 'playwright');
  assert.notEqual(reused[0].key, first[0].key);
});

test('the process collector keeps a stable observed start identity from a fixture snapshot', async () => {
  const { collectProcesses } = await import('../src/collect.js');
  const calls = [];
  const rows = await collectProcesses({ runner: async (command, args) => {
    calls.push([command, args]);
    return '30 20 01:00 0.5 00:01.50 Thu Oct  8 10:00:00 2026 1024 Chromium --remote-debugging-pipe --headless\n';
  } });
  assert.equal(calls.length, 1, 'use the fixture process reader');
  assert.deepEqual(rows.get(30), { pid: 30, ppid: 20, age: 60, cpu: 0.5, cpuTimeMs: 1500, rssMB: 1,
    start: startedAt, cmd: 'Chromium --remote-debugging-pipe --headless' });
  assert.ok(calls[0][1].some((arg) => arg.includes('lstart=')));
});

test('one independent process emits one audit event even after it disappears and returns', () => {
  const [notice] = browserSafetyNotices({ processes: processes(), panes: [pane], projects });
  const seen = {};
  const first = browserSafetyNoticeDelta([notice], {}, seen);
  assert.deepEqual(first.added, [notice]);
  assert.deepEqual(browserSafetyNoticeDelta([notice], first.active, seen).added, []);
  const absent = browserSafetyNoticeDelta([], first.active, seen);
  assert.deepEqual(browserSafetyNoticeDelta([notice], absent.active, JSON.parse(JSON.stringify(seen))).added, []);
  const [reused] = browserSafetyNotices({ processes: processes('agent-browser', 'Thu Oct 8 11:00:00 2026'), panes: [pane], projects });
  assert.deepEqual(browserSafetyNoticeDelta([reused], {}, seen).added, [reused]);
});

test('the dashboard alert keeps the safe process attribution', () => {
  const [notice] = browserSafetyNotices({ processes: processes(), panes: [pane], projects });
  const alert = browserSafetyAlert(notice);
  assert.deepEqual({ pid: alert.pid, pane: alert.pane, startIdentity: alert.startIdentity, launcherKind: alert.launcherKind },
    { pid: 30, pane: 'w1:p2', startIdentity: startedAt, launcherKind: 'perf-harness' });
});

test('launcher kinds come only from ancestor command names, with unknown as the fallback', () => {
  for (const [command, expected] of [
    ['perf-harness --url=https://private.example.test/', 'perf-harness'],
    ['node /fixture/agent-browser/dist/daemon.js --profile=/fixture/private-profile', 'agent-browser'],
    ['agent-browser', 'agent-browser'],
    ['node /fixture/playwright/cli.js test', 'playwright'],
    ['playwright-mcp', 'playwright'],
    ['node worker.js --name=perf-harness --url=https://agent-browser.example.test/playwright', 'unknown'],
    ['node https://private.example.test/playwright/cli.js', 'unknown'],
    ['unknown-tool --name=playwright', 'unknown'],
  ]) {
    const [notice] = browserSafetyNotices({ processes: processes(command), panes: [pane], projects });
    assert.equal(notice.launcherKind, expected, command);
    assert.doesNotMatch(JSON.stringify(notice), /private\.example|private-profile|worker\.js|unknown-tool/);
  }
});

test('Engine.tick writes attributed audit rows once across missing observations and restarts', { timeout: 60000 }, async (t) => {
  const { Engine } = await import('../src/engine.js');
  const { loadConfig, DATA_DIR } = await import('../src/config.js');
  const oldAllow = process.env.HERDR_BOSS_ALLOW_ACTIONS;
  process.env.HERDR_BOSS_ALLOW_ACTIONS = '1';
  t.after(() => {
    if (oldAllow === undefined) delete process.env.HERDR_BOSS_ALLOW_ACTIONS;
    else process.env.HERDR_BOSS_ALLOW_ACTIONS = oldAllow;
  });
  let table = processes();
  let now = Date.parse('2026-10-08T10:01:00.000Z');
  const cfg = loadConfig();
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  cfg.browsers.sweepCodeSignClones = false;
  const options = { push: false, act: true, clock: () => now, psRunner: async () => '', collectors: {
    collectHerdr: async () => ({ panes: [pane], workspaces: [{ id: 'w1', label: 'Alpha' }], agents: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => table,
    collectQuotas: async () => [],
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectPiModels: async () => null,
    checkHarness: () => [],
    runDenialScan: async () => ({ state: {}, denials: [] }),
    probePort: async () => false,
    readWorkerScreen: async () => '',
  } };
  let engine = new Engine(cfg, options);
  await engine.tick();
  await engine.tick();
  table = new Map();
  now += 5000;
  await engine.tick();
  engine = new Engine(cfg, options);
  table = new Map([[30, { ...processes().get(30), ppid: 1 }]]);
  await engine.tick();
  const events = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((row) => row.warning === 'independent-browser-launch');
  assert.equal(events.length, 1);
  assert.deepEqual({ pid: events[0].pid, pane: events[0].pane, startIdentity: events[0].startIdentity, launcherKind: events[0].launcherKind },
    { pid: 30, pane: 'w1:p2', startIdentity: startedAt, launcherKind: 'perf-harness' });
  assert.equal(engine.state.browserSafetyNotices[0].pane, 'w1:p2');
  assert.doesNotMatch(JSON.stringify(events), /private-profile|private\.example|fixture-value|perf-harness\.js/);
  table = processes('playwright', 'Thu Oct 8 11:00:00 2026');
  await engine.tick();
  const reused = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((row) => row.warning === 'independent-browser-launch');
  assert.equal(reused.length, 2);
  assert.deepEqual(engine.state.browserLaunchAudit.map((row) => [row.pid, row.launcherKind, row.project]),
    [[30, 'playwright', 'alpha'], [30, 'perf-harness', 'alpha']]);
});

test('browser audit lists the last 50 safe rows and filters by project without changing files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-audit-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = Array.from({ length: 120 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 8, 10, i)).toISOString(),
    type: 'browser-safety', warning: 'independent-browser-launch', pid: 1000 + i, pane: 'w1:p2',
    startIdentity: startedAt, launcherKind: 'playwright', project: i % 2 ? 'beta' : 'alpha',
    cmd: 'node worker.js --url=https://private.example.test/?code=fixture-value', profile: '/fixture/private-profile' }));
  const file = path.join(dir, 'events.jsonl');
  // Large unrelated rows must not hide older matches or grow the result. The read scans from the end.
  fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n' + JSON.stringify({ type: 'other', text: 'x'.repeat(150000) }) + '\n{broken\n');
  const before = fs.readFileSync(file);
  const run = (args) => spawnSync(process.execPath, [path.resolve('src/cli.js'), 'browser', 'audit', ...args], {
    encoding: 'utf8', env: { HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, PATH: '/fixture/no-tools' },
  });
  for (const [args, firstPid, lastPid] of [[[], '1119', '1070'], [['alpha'], '1118', '1020'], [['beta'], '1119', '1021']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines[0], 'Time\tPID\tPane\tLauncher\tProject');
    assert.equal(lines.length, 51);
    assert.equal(lines[1].split('\t')[1], firstPid);
    assert.equal(lines.at(-1).split('\t')[1], lastPid);
    assert.doesNotMatch(result.stdout, /private\.example|private-profile|fixture-value|worker\.js|startIdentity/);
    assert.equal(result.stderr, '');
  }
  assert.match(run(['gamma']).stdout, /No independent browser launches recorded/);
  assert.equal(run(['alpha', 'extra']).status, 1);
  assert.equal(run(['--unknown']).status, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir), ['events.jsonl']);
});

test('a malformed start identity cannot put command or URL text into a notice', () => {
  const [notice] = browserSafetyNotices({ processes: processes('playwright', 'https://private.example.test/?code=fixture-value'), panes: [pane], projects });
  assert.equal(notice.startIdentity, 'unknown');
  assert.doesNotMatch(JSON.stringify(notice), /private\.example|fixture-value/);
});

test('the Browsers page renders the latest safe audit list, an empty state, and escaped cells', async () => {
  const vm = await import('node:vm');
  const source = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is part of the Browsers page`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const tableStart = source.indexOf('const vizTable =');
  const context = { browserResources: () => '<div>Managed browsers</div>',
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.runInNewContext(`${source.slice(tableStart, source.indexOf('\n', tableStart))}\n${body('browsersView')}\n${body('browserLaunchAuditBlock')}\nthis.render = browsersView;`, context);
  assert.match(context.render({ browserLaunchAudit: [] }), /No independent browser launches recorded/);
  const html = context.render({ browserLaunchAudit: Array.from({ length: 55 }, (_, i) => ({ at: '2026-10-08T10:00:00.000Z',
    pid: 1000 + i, pane: '<img src=x>', launcherKind: 'unknown', project: '<script>bad</script>' })) });
  assert.match(html, /Independent browser launches/);
  assert.equal((html.match(/<tr>/g) || []).length, 51);
  assert.match(html, /data-label="Time"/);
  assert.match(html, /data-label="Launcher"/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img|<script>/);
});

test('Engine still starts when the audit log cannot be read', async () => {
  const { Engine } = await import('../src/engine.js');
  const { loadConfig, DATA_DIR } = await import('../src/config.js');
  const file = path.join(DATA_DIR, 'events.jsonl');
  const saved = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  try {
    assert.doesNotThrow(() => new Engine(loadConfig(), { act: false, push: false }));
  } finally {
    fs.rmdirSync(file);
    fs.writeFileSync(file, saved);
  }
});
