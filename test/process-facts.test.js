import './helpers/test-env.js';
import './helpers/isolated-test-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const table = ' 1 0 S Sat Oct 10 09:00:00 2026 /sbin/launchd\n 500 1 S Sat Oct 10 09:01:00 2026 /bin/zsh\n 501 500 S Sat Oct 10 10:00:00 2026 /usr/bin/node\n 502 501 S Sat Oct 10 10:01:00 2026 /usr/bin/node\n';
const local = (command) => ({ status: 0, stdout: command === 'ps' ? table : 'p501\ncnode\nn/work/project\n', stderr: '' });

test('process facts use the service before a sandbox local probe', async () => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const client = createProcessFactsClient({
    request: () => ({ reachable: true, status: 200, body: {
      known: true, pid: 501, alive: true, start: 'Sat Oct 10 10:00:00 2026',
      state: 'alive', parents: [{ pid: 500, ppid: 1, command: 'zsh' }],
      args: 'PRIVATE_SENTINEL', environment: 'PRIVATE_SENTINEL',
    } }),
    runner: () => { throw new Error('Local runner must not be used'); },
  });
  const result = client.processInfo(501);
  assert.equal(result.known, true);
  assert.equal(result.alive, true);
  assert.equal(result.parents[0].command, 'zsh');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});

test('an unreachable service falls back locally and two failures give explicit unknown', async () => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const client = createProcessFactsClient({ request: () => ({ reachable: false }), runner: local });
  const result = client.processInfo(501);
  assert.equal(result.start, 'Sat Oct 10 10:00:00 2026');
  assert.deepEqual(result.parents.map((p) => p.pid), [500, 1]);
  assert.equal(client.processInfo(900).alive, false);
  const failed = createProcessFactsClient({ request: () => ({ reachable: false }), runner: () => ({ error: new Error('PRIVATE_SENTINEL') }) });
  for (const answer of [failed.processInfo(501), failed.portClients(9223), failed.processesInCwd('/work/project')]) {
    assert.equal(answer.known, false);
    assert.equal(typeof answer.reason, 'string');
    assert.doesNotMatch(JSON.stringify(answer), /PRIVATE_SENTINEL/);
  }
});

test('a reachable refusal or unknown answer never bypasses the service with a local probe', async () => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  for (const response of [{ reachable: true, status: 403 }, { reachable: true, status: 200, body: { known: false } }]) {
    const client = createProcessFactsClient({ request: () => response, runner: () => assert.fail('Local probe bypassed refusal') });
    assert.equal(client.processInfo(501).known, false);
    assert.equal(client.portClients(9223).known, false);
    assert.equal(client.processesInCwd('/work/project').known, false);
  }
});

test('review: a connected child timeout stays unknown and a failed connection falls back', async () => {
  const { createProcessFactsClient, requestProcessFacts } = await import('../src/process-facts.js');
  const timeout = { error: Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ETIMEDOUT' }), status: null,
    stdout: '{"connected":true}\n' };
  const client = createProcessFactsClient({ request: (route) => requestProcessFacts(route, { runner: () => timeout }),
    runner: () => assert.fail('A connected timeout must not run a local probe') });
  const result = client.processInfo(501);
  assert.equal(result.known, false);
  assert.match(result.reason, /timed out/i);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  const failed = createProcessFactsClient({ request: (route) => requestProcessFacts(route, {
    runner: () => ({ status: 0, stdout: '{"reachable":false}' }),
  }), runner: local });
  assert.equal(failed.processInfo(501).known, true);
});

test('review: cwd probes share one deadline and a filesystem root matches child directories', async () => {
  const { localProcessFacts } = await import('../src/process-facts.js');
  let now = 0;
  const calls = [];
  const result = localProcessFacts('cwd', '/', { now: () => now, runner: (command, _args, options) => {
    calls.push(options.timeout); now += command === 'ps' ? 1250 : 500;
    return local(command);
  } });
  assert.deepEqual(calls, [2000, 750]);
  assert.equal(result.known, true);
  assert.equal(result.processes.find((row) => row.pid === 501).inCwd, true);
  now = 0;
  const expired = localProcessFacts('cwd', '/', { now: () => now, runner: (command) => {
    now += command === 'ps' ? 1250 : 1000; return local(command);
  } });
  assert.equal(expired.known, false);
  assert.match(expired.reason, /timed out/i);
});

test('review: root cwd matches its descendants independently of the deadline', async () => {
  const { localProcessFacts } = await import('../src/process-facts.js');
  assert.equal(localProcessFacts('cwd', '/', { runner: local }).processes.find((row) => row.pid === 501).inCwd, true);
});

test('review: port facts exclude listeners and service PIDs before the browser adapter', async () => {
  const { createProcessFactsApi } = await import('../src/process-facts-api.js');
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const api = createProcessFactsApi({ herdr: () => ({ pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }),
    runner: (_command, args) => ({ status: 0, stdout: args.includes('-sTCP:LISTEN') ? 'p600\ncChrome\n'
      : `p600\ncChrome\np${process.pid}\ncnode\np501\ncnode\np501\ncnode\n` }),
  });
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {
    host: '127.0.0.1:4477', 'x-herdr-env': '1', 'x-herdr-pane-id': 'ws:orch', 'x-herdr-workspace-id': 'ws',
  } };
  const response = api.handle(req, new URL('http://127.0.0.1/api/process-facts/port?port=9223'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.clients, [{ pid: 501, command: 'node' }]);
  const client = createProcessFactsClient({ request: () => ({ reachable: true, status: 200, body: {
    known: true, listeners: [{ pid: 600, command: 'Chrome' }],
    clients: [{ pid: 600, command: 'Chrome' }, { pid: process.pid, command: 'node' },
      { pid: 900, command: 'node' }, { pid: 501, command: 'node' }], servicePid: 900,
  } }), runner: () => assert.fail('Local probe must not run') });
  assert.deepEqual(client.portClients(9223).clients, [{ pid: 501, command: 'node' }]);
});

test('review: repository worktree roots cannot grant the filesystem root or home directory', async (t) => {
  const { registeredProcessRoots, createProcessFactsApi } = await import('../src/process-facts-api.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-process-root-bound-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(home, 'repo'), dataDir = path.join(home, 'data');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'project-repos.json'), JSON.stringify([{ slug: 'sample', repo }]));
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {
    host: '127.0.0.1:4477', 'x-herdr-env': '1', 'x-herdr-pane-id': 'ws:orch', 'x-herdr-workspace-id': 'ws',
  } };
  const roots = () => registeredProcessRoots(dataDir, { home });
  const api = createProcessFactsApi({ roots,
    herdr: () => ({ pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }),
    runner: () => assert.fail('A rejected root must not run a process probe'),
  });
  const outside = path.join(home, 'outside');
  const route = new URL(`http://127.0.0.1/api/process-facts/cwd?path=${encodeURIComponent(outside)}`);
  const escape = path.join(home, 'escape'); fs.symlinkSync('/', escape);
  for (const worktreeRoot of ['/', home, '~', 'relative', path.dirname(home), escape]) {
    fs.writeFileSync(path.join(repo, '.herdr-boss.json'), JSON.stringify({ worktreeRoot }));
    assert.equal(api.handle(req, route).status, 403, `Root must not grant outside paths: ${worktreeRoot}`);
    assert.ok(!roots().includes('/'));
    assert.ok(!roots().includes(home));
  }
  const valid = path.join(home, 'worktrees');
  for (const worktreeRoot of [valid, '~/worktrees']) {
    fs.writeFileSync(path.join(repo, '.herdr-boss.json'), JSON.stringify({ worktreeRoot }));
    assert.ok(roots().includes(valid));
  }
});

test('cwd facts retain descendants after chdir and names only in every response', async () => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const calls = [];
  const client = createProcessFactsClient({ request: () => ({ reachable: false }), runner: (command, args, options) => {
    calls.push({ command, args, options }); return local(command);
  } });
  assert.deepEqual(client.processesInCwd('/work/project').processes, [
    { pid: 1, ppid: null, command: 'launchd', inCwd: false },
    { pid: 500, ppid: 1, command: 'zsh', inCwd: false },
    { pid: 501, ppid: 500, command: 'node', inCwd: true },
    { pid: 502, ppid: 501, command: 'node', inCwd: false },
  ]);
  assert.equal(client.portClients(9223).known, true);
  for (const call of calls) {
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 2000);
    assert.doesNotMatch(call.args.join(' '), /command=|args=|(?:^|\s)(?:aux|eww)(?:\s|$)/);
  }
});

test('cwd context keeps the process tree when the recorded shell and every child moved outside the worktree', async () => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const client = createProcessFactsClient({ request: () => ({ reachable: false }), runner: (command) => ({
    status: 0, stdout: command === 'ps' ? table : 'p500\nczsh\nn/other/directory\np501\ncnode\nn/other/directory\n',
  }) });
  const result = client.processesInCwd('/work/project');
  assert.deepEqual(result.processes.map((item) => item.pid), [1, 500, 501, 502]);
  assert.ok(result.processes.every((item) => !item.inCwd));
});

test('legacy collection recognizes the shared daemon from safe command names', async () => {
  const { filterCollectProcesses } = await import('../src/kit/workers.js');
  const result = filterCollectProcesses([
    { pid: 501, ppid: 100, command: 'app-server-daemon', cwd: '/work/project' },
    { pid: 502, ppid: 501, command: 'node', cwd: '/work/project' },
    { pid: 503, ppid: 1, command: 'node', cwd: '/work/project' },
  ], { worktree: '/work/project' });
  assert.deepEqual(result.map((item) => item.pid), [503]);
});

test('local cwd fallback recognizes a canonical directory behind a path alias', async (t) => {
  const { createProcessFactsClient } = await import('../src/process-facts.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-process-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real'), alias = path.join(root, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias);
  const client = createProcessFactsClient({ request: () => ({ reachable: false }), runner: (command) => ({
    status: 0, stdout: command === 'ps' ? table : `p501\ncnode\nn${fs.realpathSync(real)}\n`,
  }) });
  assert.equal(client.processesInCwd(alias).processes.find((item) => item.pid === 501).inCwd, true);
});

test('process facts API refuses foreign callers and paths outside canonical registered roots', async (t) => {
  const { createProcessFactsApi } = await import('../src/process-facts-api.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-process-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), outside = path.join(root, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(project, 'escape'));
  let probes = 0;
  const api = createProcessFactsApi({ roots: () => [project], runner: () => { probes++; return { status: 0, stdout: table }; },
    herdr: () => ({ pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } }),
  });
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {
    host: '127.0.0.1:4477', 'x-herdr-env': '1', 'x-herdr-pane-id': 'ws:orch', 'x-herdr-workspace-id': 'ws',
  } };
  const route = (kind, query) => new URL(`http://127.0.0.1/api/process-facts/${kind}?${query}`);
  assert.equal(api.handle(req, route('info', 'pid=501')).status, 200);
  for (const cwd of [outside, `${project}-sibling`, path.join(project, 'escape'), path.join(project, 'escape', 'missing')]) {
    assert.equal(api.handle(req, route('cwd', `path=${encodeURIComponent(cwd)}`)).status, 403);
  }
  const before = probes;
  assert.equal(api.handle({ ...req, headers: { ...req.headers, 'x-herdr-workspace-id': 'foreign' } }, route('info', 'pid=501')).status, 403);
  assert.equal(api.handle({ ...req, socket: { remoteAddress: '192.0.2.1' } }, route('port', 'port=9223')).status, 403);
  assert.equal(api.handle({ ...req, method: 'POST' }, route('info', 'pid=501')).status, 405);
  assert.equal(api.handle(req, route('info', 'pid=0')).status, 400);
  assert.equal(probes, before);
});

test('worker and browser readers consume service facts and keep unknown explicit', async () => {
  const { worktreeCwdProcesses } = await import('../src/kit/workers.js');
  const { collectBrowserClients } = await import('../src/collect.js');
  const { publicProcessFacts } = await import('../src/process-facts.js');
  const facts = { known: true, processes: [{ pid: 501, ppid: 500, command: 'node', inCwd: true },
    { pid: 502, ppid: 501, command: 'node', inCwd: false }] };
  assert.deepEqual(worktreeCwdProcesses('/work/project', { readFacts: () => facts }), { known: true, processes: [
    { pid: 501, ppid: 500, command: 'node', cwd: '/work/project' },
    { pid: 502, ppid: 501, command: 'node', cwd: null },
  ] });
  assert.equal(worktreeCwdProcesses('/work/project', { readFacts: () => ({ known: false, reason: 'unknown' }) }).known, false);
  assert.equal(await collectBrowserClients(9223, { servicePid: 800, readFacts: () => publicProcessFacts('port', { known: true, servicePid: 900,
    listeners: [{ pid: 600, command: 'Chrome' }], clients: [600, 800, 900, 501, 501].map((pid) => ({ pid, command: 'node' })),
  }) }), 1);
  assert.equal(await collectBrowserClients(9223, { readFacts: () => ({ known: false, reason: 'unknown' }) }), null);
});

test('worktree pruning asks process facts for each worktree and keeps unknown worktrees', async (t) => {
  const { pruneWorktrees } = await import('../src/kit/worktrees.js');
  const { temporaryRepo, git } = await import('./helpers/kit-fixture.js');
  const { loadProjectConfig } = await import('../src/kit/config.js');
  const root = temporaryRepo('herdr-process-prune-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker');
  git(root, 'worktree', 'add', '-b', 'worker', worker);
  t.after(() => { try { git(root, 'worktree', 'remove', '--force', worker); } catch {} });
  const queries = [], output = [];
  const result = pruneWorktrees(loadProjectConfig({ cwd: root }), {
    herdr: () => ({ panes: [] }), archive: false, output: (line) => output.push(line),
    readProcessFacts: (cwd) => { queries.push(cwd); return cwd === worker
      ? { known: false, reason: 'Process facts unavailable' } : { known: true, processes: [] }; },
  });
  assert.ok(queries.includes(worker));
  assert.equal(result.find((item) => item.path === worker).removable, false);
  assert.match(result.find((item) => item.path === worker).processScanError, /Process facts unavailable/);
  assert.equal(fs.existsSync(worker), true);
});

test('review: pruning and build cleanup continue for known worktrees after an unknown check', async (t) => {
  const { pruneWorktrees } = await import('../src/kit/worktrees.js');
  const { temporaryRepo, git } = await import('./helpers/kit-fixture.js');
  const { loadProjectConfig } = await import('../src/kit/config.js');
  const root = temporaryRepo('herdr-process-prune-independent-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unknown = path.join(root, 'unknown'), safe = path.join(root, 'safe'), build = path.join(root, 'build');
  for (const [branch, target] of [['unknown', unknown], ['safe', safe], ['build', build]]) {
    git(root, 'worktree', 'add', '-b', branch, target);
  }
  fs.mkdirSync(path.join(unknown, 'dist')); fs.writeFileSync(path.join(unknown, 'dist', 'sample.js'), 'synthetic');
  fs.mkdirSync(path.join(build, 'dist')); fs.writeFileSync(path.join(build, 'dist', 'sample.js'), 'synthetic');
  fs.writeFileSync(path.join(build, 'KEEP.md'), 'keep this dirty worktree');
  const queries = [];
  const result = pruneWorktrees(loadProjectConfig({ cwd: root }), {
    apply: true, cleanBuild: true, archive: false, herdr: () => ({ panes: [] }), output: () => {},
    readProcessFacts: (cwd) => { queries.push(cwd); return cwd === unknown
      ? { known: false, reason: 'Process facts unavailable' } : { known: true, processes: [] }; },
  });
  assert.ok(queries.includes(safe));
  assert.equal(result.find((row) => row.path === unknown).removable, false);
  assert.match(result.find((row) => row.path === unknown).processScanError, /unavailable/);
  assert.equal(result.find((row) => row.path === safe).processScanError, null);
  assert.equal(result.find((row) => row.path === safe).removable, true);
  assert.equal(fs.existsSync(safe), false);
  assert.equal(fs.existsSync(path.join(unknown, 'dist', 'sample.js')), true);
  assert.equal(fs.existsSync(path.join(build, 'dist', 'sample.js')), false);
  assert.equal(fs.existsSync(path.join(build, 'KEEP.md')), true);
});

test('worker collection continues on unknown facts and preserves the recorded process tree rule', async (t) => {
  const { collectWorker } = await import('../src/kit/workers.js');
  const { setupFixture, git } = await import('./helpers/kit-fixture.js');
  const { startWorker } = await import('./helpers/start-worker.js');
  const { loadModels } = await import('../src/kit/config.js');
  const f = setupFixture(null);
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-m', 'synthetic fixture configuration');
  const run = startWorker('process-facts-worker', { kind: 'codex', task: 'fixture', allow: ['.orchestration/runs/'], noWorktree: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
  });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Synthetic process facts check.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ issue: null, branch: run.branch, worktree: run.worktree,
    changedPaths: [`.orchestration/runs/${run.name}.json`], commands: ['stub check passed'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const options = { config: f.config, output: () => {}, herdr: f.herdr, callerPid: 700, callerPpid: 600,
    leaseDataDir: path.join(f.root, 'lease-data'), schedulePaneCloseFn: () => {},
    listWorktreeProcesses: () => ({ known: true, processes: [
      { pid: run.shellPid, ppid: 1, command: 'zsh', cwd: f.root },
      { pid: 501, ppid: run.shellPid, command: 'node', cwd: null },
      { pid: 600, ppid: 1, command: 'zsh', cwd: f.root },
      { pid: 700, ppid: 600, command: 'node', cwd: f.root },
    ] }),
  };
  assert.throws(() => collectWorker(run.name, { noRecord: true }, options), /node \(pid 501, ancestor zsh\): worker descendant remains active/);
  const output = [];
  assert.doesNotThrow(() => collectWorker(run.name, { noRecord: true }, { ...options, output: (line) => output.push(line),
    listWorktreeProcesses: () => ({ known: false, reason: 'Process facts unavailable' }),
  }));
  assert.ok(output.some((line) => /process check unknown.*Continued collection/.test(line)));
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
});
