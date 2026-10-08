import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { SETTING_GROUPS } from '../public/setting-help.js';
import { MENU_ROUTES, NAV_LABEL, matchRoute } from '../public/routes.js';
import { PAGE_READS } from '../public/store.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-preview-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ serve }, { loadConfig, serviceSettingsView }, { Engine }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/engine.js'),
]);

test('the state API exposes only allow-listed effective service settings', { timeout: 20000 }, (t) => {
  const defaults = serviceSettingsView({});
  assert.equal(defaults.find(({ setting }) => setting === 'watch.maxWorkers').value, null);
  assert.deepEqual(defaults.find(({ setting }) => setting === 'watch.maxWorkersByLane').value,
    { unmetered: null, codex: null, claude: null, opencodego: null });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-service-settings-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const live = path.join(root, 'live');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accessTokenPath = path.join(root, 'private-access-token');
  const roamgateTokenPath = path.join(root, 'private-roamgate-token');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    port: 0,
    host: '127.0.0.1',
    push: true,
    tickSeconds: 45,
    quotaSeconds: 420,
    machine: { memFreeWarnPercent: 18 },
    quota: { warnPercent: 85, criticalPercent: 97 },
    staleStatusMinutes: 75,
    workers: { staleIdleMinutes: 110 },
    watch: { maxWorkers: 16, maxWorkersByLane: { unmetered: 12, codex: null, claude: 6, opencodego: 4 } },
    browsers: { reapOrphanDaemons: false, orphanDaemonMinAgeSeconds: 3600, staleOwnedMinutes: 25 },
    providerKinds: { codex: ['codex', 'pi'] },
    orchestratorLabel: 'orchestrator',
    access: { tokenFile: accessTokenPath, sessionDays: 20 },
    roamgate: { port: 8888, tokenFile: roamgateTokenPath },
    serviceApiKey: 'must-not-enter-the-view',
  }));

  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const script = `
import { loadConfig, serviceSettingsView } from ${JSON.stringify(configUrl)};
import { serve } from ${JSON.stringify(serverUrl)};
import { Engine } from ${JSON.stringify(engineUrl)};
const cfg = loadConfig();
const view = serviceSettingsView(cfg);
console.log = () => {};
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  collectPiModels: async () => ({ models: [] }),
};
const app = serve(cfg, { readOnlyPreview: true, createEngine: (config, options) => new Engine(config, { ...options, collectors }) });
try {
  if (app.engine.state?.serviceSettings) {
    // The first tick can finish before this probe starts.
  } else {
    await new Promise((resolve) => app.engine.once('state', resolve));
  }
  if (!app.server.listening) await new Promise((resolve, reject) => {
    app.server.once('listening', resolve);
    app.server.once('error', reject);
  });
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/state');
  const state = await response.json();
  process.stdout.write(JSON.stringify({ view, state }));
} finally {
  await app.close();
}
`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: home,
      HERDR_BOSS_DIR: data,
      HERDR_BOSS_LIVE_DIR: live,
      HERDR_BOSS_PORT: '',
      HERDR_BOSS_PUSH: '',
    },
  });
  const { view, state } = JSON.parse(result.trim());
  const keys = view.map((item) => item.setting);
  assert.deepEqual(keys, [
    'worktreeRoot', 'projectRoot',
    'machine.memFreeWarnPercent',
    'quota.warnPercent', 'quota.criticalPercent', 'quota.opencodeGoResetAt', 'quota.opencodeStatsDays',
    'quotaPlan.burstPace', 'quotaPlan.applyThreshold', 'quotaPlan.margin', 'quotaPlan.horizon', 'quotaPlan.tolerance', 'quotaPlan.holdMargin', 'quotaPlan.slowFactor', 'quotaPlan.planMode',
    'staleStatusMinutes',
    'staleTextMinutes',
    'workers.staleIdleMinutes',
    'workers.paneCloseDelayMinutes',
    'workers.uncollectedNoticeMinutes',
    'workers.leaseGraceMinutes', 'worktrees.pruneAtCollect', 'worktrees.minFreeGb',
    'watch.maxWorkers', 'watch.maxWorkersByLane', 'watch.quietHours',
    'browsers.reapOrphanDaemons', 'browsers.orphanDaemonMinAgeSeconds', 'browsers.staleOwnedMinutes', 'browsers.sweepCodeSignClones', 'browser.idleCloseMinutes', 'browser.allowVisible', 'chromePath', 'releases.repos',
    'tickSeconds', 'quotaSeconds', 'push', 'alertCooldownSeconds', 'providerKinds', 'orchestratorLabel', 'port', 'host', 'allowedHosts', 'log.maxMegabytes', 'log.keepFiles', 'factories.claudeUsageHelper', 'analytics.actionsMinutes',
  ]);
  assert.deepEqual(view.map(({ source }) => source), [
    'default', 'default',
    'config', 'config', 'config', 'default', 'default', 'default', 'default', 'default', 'default', 'default', 'default', 'default', 'default',
    'config', 'default', 'config', 'default', 'default', 'default', 'default', 'default', 'config', 'config', 'default',
    'config', 'config', 'config', 'default', 'default', 'default', 'default', 'default', 'config', 'config', 'config',
    'default', 'config', 'config', 'config', 'config', 'default', 'default', 'default', 'default', 'default',
  ]);
  assert.deepEqual(view.find(({ setting }) => setting === 'watch.maxWorkers'), {
    group: 'Workers', setting: 'watch.maxWorkers', value: 16, source: 'config',
  });
  assert.deepEqual(view.find(({ setting }) => setting === 'watch.maxWorkersByLane'), {
    group: 'Workers', setting: 'watch.maxWorkersByLane',
    value: { unmetered: 12, codex: null, claude: 6, opencodego: 4 }, source: 'config',
  });
  assert.deepEqual(view.find(({ setting }) => setting === 'watch.quietHours'), {
    group: 'Watch', setting: 'watch.quietHours', value: false, source: 'default',
  });
  assert.deepEqual(view.find(({ setting }) => setting === 'browsers.sweepCodeSignClones'), {
    group: 'Browsers', setting: 'browsers.sweepCodeSignClones', value: true, source: 'default',
  });
  assert.deepEqual(state.serviceSettings, view, 'the engine puts this same view in state');
  assert.deepEqual(Object.keys(state.quotaPlanSummary).sort(), ['nextCreditAt', 'plannedUsageNow', 'state']);
  assert.equal(state.quotaPlanSummary.state, 'unavailable');
  assert.equal(state.serviceSettings.find(({ setting }) => setting === 'providerKinds').value.codex.includes('pi'), true);
  for (const text of [JSON.stringify(view), JSON.stringify(state)]) {
    assert.equal(text.includes(accessTokenPath), false, 'the access token path never enters the view or API state');
    assert.equal(text.includes(roamgateTokenPath), false, 'the Roamgate token path never enters the view or API state');
    assert.equal(text.includes('must-not-enter-the-view'), false, 'an unlisted secret-like config value never enters the view or API state');
  }
  const assertSafeNames = (value) => {
    if (Array.isArray(value)) return value.forEach(assertSafeNames);
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      assert.doesNotMatch(name, /token|secret|password|key/i, `service settings must not contain ${name}`);
      assertSafeNames(child);
    }
  };
  assertSafeNames(view);
  for (const { setting } of view) assert.doesNotMatch(setting, /token|secret|password|key/i, `service settings must not include ${setting}`);
});

for (const { title, lane, ageMinutes, eligible } of [
  { title: 'engine lock snapshots include live full-suite queue tickets', lane: 'long', ageMinutes: 41, eligible: true },
  { title: 'engine lock snapshots include legacy queue tickets younger than 30 minutes', ageMinutes: 29, eligible: true },
  { title: 'engine lock snapshots exclude legacy queue tickets older than 30 minutes', ageMinutes: 41, eligible: false },
]) {
  test(title, { timeout: 20000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-queue-state-'));
    const lockDataDir = path.join(root, 'boss-data');
    const machineDir = path.join(lockDataDir, 'locks', 'machine');
    const queueDir = path.join(machineDir, 'queue', 'full-suite');
    fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = new Date();
    fs.writeFileSync(path.join(machineDir, 'full-suite.json'), JSON.stringify({
      name: 'full-suite', scope: 'machine', gitCommonDir: '/fixture/repo/.git', ownerPane: 'ws:holder',
      pid: process.pid, kind: 'suite', command: 'herdr-boss lock acquire full-suite', acquiredAt: now.toISOString(),
    }));
    const ticketId = '00000000-0000-4000-8000-000000000002';
    fs.writeFileSync(path.join(queueDir, `${ticketId}.json`), JSON.stringify({
      id: ticketId, seq: 4, pane: 'ws:waiter', project: 'alpha', pid: process.pid, kind: 'suite',
      // New-code tickets have a lane and do not use the legacy 30-minute age limit.
      ...(lane ? { lane, predictedMs: null } : {}),
      command: 'herdr-boss lock acquire full-suite', createdAt: new Date(now.getTime() - ageMinutes * 60 * 1000).toISOString(),
    }));
    const cfg = loadConfig();
    cfg.host = '127.0.0.1';
    cfg.port = 0;
    const engine = new Engine(cfg, { push: false, act: false, lockDataDir, collectors: {
      collectHerdr: async () => ({ panes: [{ id: 'ws:holder' }, { id: 'ws:waiter' }], workspaces: [] }),
      collectMachine: async () => null,
      collectProcesses: async () => new Map(),
      collectQuotas: async () => [],
      collectWorktreeCounts: async () => ({}),
      collectCwdProcesses: async () => [],
      collectMissingWorktreeProcesses: async () => [],
      collectPiModels: async () => ({ models: [] }),
    } });
    const state = await engine.tick();
    assert.equal(state.locks.length, 1);
    assert.deepEqual(state.locks[0].queue.map((ticket) => [ticket.position, ticket.project, ticket.pane, ticket.kind]), eligible ? [
      [1, 'alpha', 'ws:waiter', 'suite'],
    ] : []);
    if (eligible) {
      assert.ok(state.locks[0].queue[0].waitSeconds >= ageMinutes * 60);
      assert.equal(state.locks[0].queue[0].legacy, lane === undefined);
      assert.equal(state.locks[0].queue[0].lane, 'long');
    }
    assert.equal(state.lockStats.acquires, 0);
    assert.equal(state.lockStats.medianHoldMs, null);
  });
}

test('engine lock snapshots include the median hold and wait from the lock ledger', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-ledger-state-'));
  const lockDataDir = path.join(root, 'boss-data');
  fs.mkdirSync(lockDataDir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const lines = [
    { at, event: 'acquire', name: 'full-suite', project: 'alpha', kind: 'suite', waitMs: 2000 },
    { at, event: 'release', name: 'full-suite', project: 'alpha', kind: 'suite', holdMs: 100000 },
    { at, event: 'acquire', name: 'full-suite', project: 'beta', kind: 'push', waitMs: 6000 },
    { at, event: 'release', name: 'full-suite', project: 'beta', kind: 'push', holdMs: 300000 },
    { at: '2020-01-01T00:00:00.000Z', event: 'release', name: 'full-suite', project: 'old', kind: 'suite', holdMs: 9000000 },
  ];
  fs.writeFileSync(path.join(lockDataDir, 'lock-ledger.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  const engine = new Engine(cfg, { push: false, act: false, lockDataDir, collectors: {
    collectHerdr: async () => ({ panes: [], workspaces: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    collectPiModels: async () => ({ models: [] }),
  } });
  const state = await engine.tick();
  assert.equal(state.lockStats.windowDays, 7);
  assert.equal(state.lockStats.acquires, 2);
  assert.equal(state.lockStats.medianWaitMs, 4000);
  assert.equal(state.lockStats.medianHoldMs, 200000);
  assert.equal(state.lockStats.byName['full-suite'].medianHoldMs, 200000);
});

test('the state API sends the watch state, read from the old night.json file, with the fields of the read view', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const since = new Date(Date.now() - 3600000).toISOString();
  const until = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'night.json'), JSON.stringify({ active: true, since, until, by: 'boss', quietHours: true, noticeStartAt: {} }));
  t.after(async () => { fs.rmSync(path.join(dataDir, 'night.json'), { force: true }); });
  const collectors = {
    collectHerdr: async () => ({ panes: [], workspaces: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    collectPiModels: async () => ({ models: [] }),
  };
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const app = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (config, options) => new Engine(config, { ...options, collectors }),
  });
  t.after(async () => { await app.close(); });
  await new Promise((resolve, reject) => {
    app.server.once('listening', resolve);
    app.server.once('error', reject);
  });
  if (!app.engine.state) await new Promise((resolve) => app.engine.once('state', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(Object.keys(state.night).sort(), ['active', 'adhoc', 'by', 'quietHours', 'reportAt', 'reportDaily', 'routines', 'since', 'until', 'untilCancelled']);
  assert.equal(state.night.active, true);
  assert.equal(state.night.since, since);
  assert.equal(state.night.until, until);
  assert.equal(state.night.by, 'boss');
  assert.equal(state.night.quietHours, true);
  await app.close();
});

test('read-only preview allows reads and rejects all API methods that can change state', { timeout: 20000 }, async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  let engineOptions;
  const { server, close } = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      engineOptions = actions;
      engine = new EventEmitter();
      engine.act = actions.act;
      engine.push = actions.push;
      engine.state = {};
      engine.tickCalls = 0;
      engine.tick = async () => { engine.tickCalls += 1; return engine.state; };
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.deepEqual(engineOptions, { push: false, act: false });
  assert.equal(engine.act, false, 'preview disables actions such as reaping and handovers');
  assert.equal(engine.push, false, 'preview disables prompts and notifications');
  for (const route of ['/', '/login', '/api/state', '/api/models', '/api/policy', '/api/usage', '/api/projects', '/api/handoffs', '/api/mailbox']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, `${route} remains readable`);
  }
  assert.equal((await fetch(`${base}/api/state`, { method: 'HEAD' })).status, 200);

  const writes = [
    ['PUT', '/api/policy'],
    ['PUT', '/api/settings'],
    ['POST', '/api/browser-sessions/window-size'],
    ['POST', '/api/browser-sessions/navigate'],
    ['POST', '/api/browser-sessions/history'],
    ['POST', '/api/browser-sessions/input'],
    ['POST', '/api/browser-sessions/new-tab'],
    ['POST', '/api/browser-sessions/tab-close'],
    ['POST', '/api/browser-sessions/close'],
    ['POST', '/api/browser-sessions/request'],
    ['POST', '/api/browser-sessions/bookmarks'],
    ['POST', '/api/browser-sessions/restart'],
    ['POST', '/api/handoffs/plan'],
    ['POST', '/api/handoffs/prepare'],
    ['POST', '/api/handoffs/activate'],
    ['PUT', '/api/projects/demo'],
    ['POST', '/api/projects/demo'],
    ['DELETE', '/api/projects/demo'],
    ['POST', '/api/usage'],
    ['POST', '/api/tick'],
    ['POST', '/api/messages'],
    ['POST', '/api/messages/read'],
    ['POST', '/api/messages/dismiss'],
    ['POST', '/api/agent-messages'],
    ['POST', '/api/agent-pairs'],
    ['POST', '/api/agent-meta'],
    ['POST', '/api/watch/start'],
    ['POST', '/api/watch/stop'],
    ['POST', '/api/night/start'],
    ['POST', '/api/night/stop'],
    ['POST', '/api/chats/alpha/read'],
    ['POST', '/api/leases/release'],
    ['POST', '/api/avatars/boss'],
    ['DELETE', '/api/avatars/boss'],
    ['PATCH', '/api/unknown'],
    ['OPTIONS', '/api/state'],
  ];
  for (const [method, route] of writes) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : '{}',
    });
    assert.equal(response.status, 403, `${method} ${route} is refused`);
  }

  assert.equal(engine.tickCalls, 1, 'blocked API writes did not start an extra engine tick');
  await close();
  assert.equal(server.listening, false, 'close stops the HTTP server');
  assert.equal(engine.tickCalls, 1, 'close clears the recurring tick timer');

  const customTokenFile = path.join(dataDir, 'custom-access-token');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ access: { tokenFile: customTokenFile } }));
  const customCfg = loadConfig();
  customCfg.host = '127.0.0.1';
  customCfg.port = 0;
  customCfg.tickSeconds = 3600;
  const customServer = serve(customCfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      const customEngine = new EventEmitter();
      customEngine.act = actions.act;
      customEngine.push = actions.push;
      customEngine.state = {};
      customEngine.tick = async () => customEngine.state;
      customEngine.log = () => {};
      return customEngine;
    },
  });
  t.after(async () => { await customServer.close(); });
  await new Promise((resolve, reject) => {
    customServer.server.once('listening', resolve);
    customServer.server.once('error', reject);
  });
  const loginPage = await fetch(`http://127.0.0.1:${customServer.server.address().port}/login`);
  assert.equal(loginPage.status, 200);
  assert.doesNotMatch(await loginPage.text(), /Unlock dashboard|name="token"/, 'the preview has no login page');
  const privateSessions = path.join(homeDir, '.config', 'herdr-boss', 'sessions.json');
  assert.equal(fs.existsSync(customTokenFile), false, 'the preview does not create the configured custom token');
  assert.equal(fs.existsSync(privateSessions), false, 'the preview does not create a session file');
  assert.equal(fs.existsSync(path.join(path.dirname(customTokenFile), 'sessions.json')), false, 'sessions are not stored beside the custom token');
  assert.equal(fs.existsSync(path.dirname(privateSessions)), false, 'the preview does not create the private access directory');
  await customServer.close();
});

test('PUT /api/settings persists allowed values and updates the running engine config immediately', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    other: { keep: true },
    quota: { warnPercent: 90, criticalPercent: 98, note: 'keep' },
    machine: { memFreeWarnPercent: 15 },
  }, null, 2));
  fs.chmodSync(configFile, 0o640);
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  let configuredQuotaPlan;
  const quotaPlanReplans = [];
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: (config) => {
      engine = new EventEmitter();
      engine.cfg = config;
      engine.state = {
        serviceSettings: serviceSettingsView(config),
        quotaThresholds: { warnPercent: config.quota.warnPercent, criticalPercent: config.quota.criticalPercent },
        quotas: [{ provider: 'codex' }],
      };
      engine.quotaPlanService = {
        configure: (settings) => { configuredQuotaPlan = structuredClone(settings); },
        replan: (options) => { quotaPlanReplans.push(options); },
        summary: () => ({ nextCreditAt: null, state: 'unavailable', plannedUsageNow: null }),
      };
      engine.memory = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: {
      worktreeRoot: '/tmp/fixture worker trees',
      projectRoot: '~/fixture projects',
      'quota.warnPercent': 85,
      'quota.criticalPercent': 96,
      'quotaPlan.burstPace': 1.5,
      'machine.memFreeWarnPercent': 22,
      tickSeconds: 20,
      quotaSeconds: 600,
      push: false,
      'analytics.actionsMinutes': false,
      'watch.maxWorkers': 20,
      'watch.maxWorkersByLane': { unmetered: 12, codex: 8, claude: null, opencodego: 4 },
    } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(engine.cfg.worktreeRoot, '/tmp/fixture worker trees');
  assert.equal(engine.cfg.projectRoot, path.join(homeDir, 'fixture projects'));
  assert.equal(result.settings.find(({ setting }) => setting === 'projectRoot').value, path.join(homeDir, 'fixture projects'));
  assert.equal(engine.cfg.quota.warnPercent, 85);
  assert.equal(engine.cfg.quota.criticalPercent, 96);
  assert.equal(engine.cfg.quotaPlan.burstPace, 1.5);
  assert.equal(result.settings.find(({ setting }) => setting === 'quotaPlan.burstPace').value, 1.5);
  assert.deepEqual(configuredQuotaPlan, engine.cfg.quotaPlan);
  assert.equal(quotaPlanReplans.length, 1);
  assert.equal(quotaPlanReplans[0].provider, 'codex');
  assert.equal(quotaPlanReplans[0].force, true);
  assert.equal(engine.cfg.machine.memFreeWarnPercent, 22);
  assert.equal(engine.cfg.tickSeconds, 20);
  assert.equal(engine.cfg.quotaSeconds, 600);
  assert.equal(engine.cfg.push, false);
  assert.equal(engine.cfg.analytics.actionsMinutes, false);
  assert.equal(engine.state.serviceSettings.find(({ setting }) => setting === 'push').value, false);
  assert.equal(engine.state.serviceSettings.find(({ setting }) => setting === 'analytics.actionsMinutes').value, false);
  assert.equal(engine.state.serviceSettings.find(({ setting }) => setting === 'tickSeconds').source, 'config');
  assert.equal(engine.cfg.watch.maxWorkers, 20);
  assert.deepEqual(engine.cfg.watch.maxWorkersByLane, { unmetered: 12, codex: 8, claude: null, opencodego: 4 });
  assert.deepEqual(engine.state.quotaThresholds, { warnPercent: 85, criticalPercent: 96 });
  assert.equal(engine.state.serviceSettings.find(({ setting }) => setting === 'machine.memFreeWarnPercent').value, 22);
  assert.equal(engine.state.serviceSettings.find(({ setting }) => setting === 'watch.maxWorkers').value, 20);
  assert.deepEqual(engine.state.serviceSettings.find(({ setting }) => setting === 'watch.maxWorkersByLane').value,
    { unmetered: 12, codex: 8, claude: null, opencodego: 4 });
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.other, { keep: true });
  assert.equal(saved.worktreeRoot, '/tmp/fixture worker trees');
  assert.equal(saved.projectRoot, path.join(homeDir, 'fixture projects'));
  assert.equal(saved.quota.note, 'keep');
  assert.equal(saved.watch.maxWorkers, 20);
  assert.deepEqual([saved.tickSeconds, saved.quotaSeconds, saved.push], [20, 600, false]);
  assert.deepEqual(saved.watch.maxWorkersByLane, { unmetered: 12, codex: 8, claude: null, opencodego: 4 });
  assert.equal(fs.statSync(configFile).mode & 0o7777, 0o640);

  const dayValues = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: {
      'watch.maxWorkers': null,
      'watch.maxWorkersByLane': { unmetered: null, codex: null, claude: null, opencodego: null },
    } }),
  });
  assert.equal(dayValues.status, 200);
  assert.equal(engine.cfg.watch.maxWorkers, null);
  assert.deepEqual(engine.cfg.watch.maxWorkersByLane, { unmetered: null, codex: null, claude: null, opencodego: null });

  const before = fs.readFileSync(configFile, 'utf8');
  const rejected = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: { host: '0.0.0.0' } }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);

  for (const value of [0, 41, 1.5]) {
    const invalid = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: { 'watch.maxWorkers': value } }),
    });
    assert.equal(invalid.status, 400, `global night cap ${value} must be rejected`);
  }
  for (const value of [0, 41, 1.5]) {
    const invalid = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: { 'watch.maxWorkersByLane': { unmetered: value } } }),
    });
    assert.equal(invalid.status, 400, `lane night cap ${value} must be rejected`);
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'invalid night caps must not change config.json');
});

test('quota.criticalPercent 100 persists across an engine restart and other writes keep it', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  fs.rmSync(configFile, { force: true });
  const start = async () => {
    const cfg = loadConfig();
    cfg.host = '127.0.0.1';
    cfg.port = 0;
    cfg.tickSeconds = 3600;
    const app = serve(cfg, {
      liveDataDir: process.env.HERDR_BOSS_DIR,
      createEngine: (config) => {
        const engine = new EventEmitter();
        engine.cfg = config;
        engine.state = { serviceSettings: serviceSettingsView(config), quotaThresholds: {} };
        engine.memory = {};
        engine.tick = async () => engine.state;
        engine.log = () => {};
        return engine;
      },
    });
    await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
    return { app, cfg, base: `http://127.0.0.1:${app.server.address().port}` };
  };
  const put = (base, changes) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  let first = await start();
  try {
    // 90 below 100 passes. The default warning level 90 is below 100 as well.
    assert.equal((await put(first.base, { 'quota.criticalPercent': 100 })).status, 200);
    const equal = await put(first.base, { 'quota.warnPercent': 99, 'quota.criticalPercent': 99 });
    assert.equal(equal.status, 400);
    assert.match((await equal.json()).error, /warnPercent must be below quota\.criticalPercent/);
    const result = await (await put(first.base, { 'quota.warnPercent': 90, 'quota.criticalPercent': 100 })).json();
    assert.equal(result.settings.find(({ setting }) => setting === 'quota.criticalPercent').value, 100);
    // A write of another group keeps the quota section.
    assert.equal((await put(first.base, { tickSeconds: 30 })).status, 200);
  } finally { await first.app.close(); }
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).quota.criticalPercent, 100);

  const second = await start();
  try {
    assert.equal(second.cfg.quota.criticalPercent, 100);
    assert.equal(serviceSettingsView(second.cfg).find(({ setting }) => setting === 'quota.criticalPercent').value, 100);
    assert.equal((await put(second.base, { 'machine.memFreeWarnPercent': 20 })).status, 200);
  } finally { await second.app.close(); }
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).quota.criticalPercent, 100);
});

test('POST /api/watch/start and /api/watch/stop write and clear the watch state, and the time checks refuse', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const nightFile = path.join(dataDir, 'watch.json');
  t.after(() => {
    fs.rmSync(nightFile, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: (config) => {
      const engine = new EventEmitter();
      engine.cfg = config;
      engine.state = {};
      engine.memory = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const read = await fetch(`${base}/api/watch`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { active: false }, 'the read view of no night is inactive');

  const started = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ until: '07:30', quietHours: true }),
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).ok, true);
  const record = JSON.parse(fs.readFileSync(nightFile, 'utf8'));
  assert.equal(record.active, true);
  assert.equal(record.quietHours, true);
  assert.equal(record.by, 'dashboard');
  // HH:MM means the next such local time, so the stored end time is in the future.
  assert.ok(Date.parse(record.until) > Date.now());
  assert.equal(new Date(record.until).getHours(), 7);
  assert.equal(new Date(record.until).getMinutes(), 30);
  assert.equal(fs.statSync(nightFile).mode & 0o7777, 0o600, 'the night file keeps its own-only mode');

  // The default end time is the next 07:30.
  const withDefault = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(withDefault.status, 200);
  const storedUntil = JSON.parse(fs.readFileSync(nightFile, 'utf8')).until;

  for (const [until, reason] of [
    [new Date(Date.now() - 3600000).toISOString(), 'a past end time'],
    ['noonish', 'a value that is not a time'],
  ]) {
    const refused = await fetch(`${base}/api/watch/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ until }),
    });
    assert.equal(refused.status, 400, `${reason} must be refused`);
    assert.equal(JSON.parse(fs.readFileSync(nightFile, 'utf8')).until, storedUntil, 'a refused start keeps the stored end time');
  }

  // A far end time is accepted. The answer carries a warning above 48 hours.
  const far = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ until: new Date(Date.now() + 96 * 3600000).toISOString() }),
  });
  assert.equal(far.status, 200);
  assert.match((await far.json()).warning, /This watch lasts \d+(\.\d)? hours/);

  // Until cancelled stores no end time and no report time. A daily report time repeats.
  const forever = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ untilCancelled: true }),
  });
  assert.equal(forever.status, 200);
  const foreverRecord = JSON.parse(fs.readFileSync(nightFile, 'utf8'));
  assert.equal(foreverRecord.until, null);
  assert.equal(foreverRecord.untilCancelled, true);
  assert.equal(foreverRecord.reportAt, undefined);
  const daily = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ untilCancelled: true, report: '07:30' }),
  });
  assert.equal(daily.status, 200);
  const dailyRecord = JSON.parse(fs.readFileSync(nightFile, 'utf8'));
  assert.equal(dailyRecord.reportDaily, '07:30');
  assert.equal(new Date(dailyRecord.reportAt).getHours(), 7);
  const both = await fetch(`${base}/api/watch/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ untilCancelled: true, until: '07:30' }),
  });
  assert.equal(both.status, 400, 'an end time with until cancelled is refused');

  // The old /api/night paths still work.
  const legacy = await fetch(`${base}/api/night`);
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).untilCancelled, true);

  const stopped = await fetch(`${base}/api/watch/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(stopped.status, 200);
  const stopBody = await stopped.json();
  assert.equal(stopBody.ok, true);
  assert.equal(fs.existsSync(nightFile), false, 'a stop clears the night file');

  // A stop without a night answers the same way.
  const again = await fetch(`${base}/api/watch/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(again.status, 200);
  await close();
});

test('the dashboard shows a watch symbol with a confirmed Stop, and the Agents page has a Watch box', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The top bar has a watch symbol and a popover. The page has no banner.
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="watch-toggle"/);
  assert.match(html, /id="watch-pop"/);
  assert.match(html, /id="watch-toggle"[^>]*aria-haspopup="dialog"/);
  // A stop closes the popover and returns focus to the toggle. Tab out and Esc close it.
  assert.match(app, /if \(action === 'stop'\) closeWatchPopover\(true\);/);
  assert.match(app, /function closeWatchPopover\(refocus = false\) \{\s+toggleWatchPopover\(false\);\s+if \(refocus\) document\.getElementById\('watch-toggle'\)\?\.focus\(\);/);
  assert.match(app, /addEventListener\('focusout'/);
  assert.match(app, /e\.key === 'Escape' && pop && !pop\.hidden\) closeWatchPopover\(true\)/);
  assert.match(app, /function updateWatchIcon\(s\)/);
  assert.match(app, /updateWatchIcon\(state\)/);
  assert.doesNotMatch(app, /nightBanner/);
  assert.doesNotMatch(app, /night-banner/);
  assert.match(app, /The Boss acts for the Owner/);
  assert.match(app, /Quiet hours on/);
  assert.match(app, /data-night-stop="true"/);
  assert.match(app, /postJson\(`\/api\/watch\/\$\{action\}`/);
  assert.match(app, /Stop the watch\?/);
  // The Agents page starts a watch. The watch popover links to it.
  assert.match(app, /watchPanel\(s\),/);
  assert.match(app, /href="\/agents#watch"/);
  assert.match(app, /data-night-start="true"/);
  assert.match(app, /type="datetime-local" data-night-until/);
  assert.match(app, /data-night-forever/);
  assert.match(app, /Until I cancel/);
  assert.match(app, /Daily report/);
  assert.match(app, /data-night-quiet-hours/);
  // The label hides on a phone, and the popover button keeps a 44 px touch target.
  assert.match(css, /\.watch-icon\b/);
  assert.match(css, /@media \(max-width: \d+px\)[^\n]*\.watch-label \{ display: none/);
  assert.match(css, /\.watch-pop button \{ min-height: 44px/);
  assert.doesNotMatch(css, /\.night-banner/);
  // The page help and the guide describe the symbol and the box.
  const settingsHelp = /settings: \['Settings', `([\s\S]*?)`\],\s+agents:/.exec(app)?.[1] || '';
  assert.doesNotMatch(settingsHelp, /<h3>Watch<\/h3>/);
  assert.match(app, /<h3>Watch symbol<\/h3>/);
  assert.match(guide, /### Watch in the dashboard/);
  assert.match(guide, /POST \/api\/watch\/start/);
  assert.match(guide, /POST \/api\/watch\/stop/);
});

test('Settings renders editable nullable watch global and provider lane caps', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("'watch.maxWorkers': [1, 40]"));
  assert.ok(app.includes("'watch.maxWorkersByLane': [1, 40]"));
  assert.ok(app.includes('Watch ${label} worker cap'));
  assert.ok(app.includes('data-service-lane="${lane}"'));
  assert.ok(app.includes("input.value === '' && nullableServiceSettings.has(setting) ? null : Number(input.value)"));
  assert.ok(app.includes("changes[setting][input.dataset.serviceLane] = input.value === '' ? null : Number(input.value)"));
});

test('the policy API saves per-harness model assignments and rejects unsafe model strings', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: null, quotas: [{ provider: 'codex', windows: [{ key: 'primary', label: 'Daily', windowMinutes: 1440, resetsAt: new Date(Date.now() + 12 * 3600000).toISOString() }] }] };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const shared = 'opencode-go/deepseek-v4.1-flash';
  const current = await (await fetch(`${base}/api/policy`)).json();
  assert.deepEqual([current.extraModels, current.disabledModels, current.harnessRoutes], [{}, {}, {}], 'a policy without the new fields reads as empty assignments');
  assert.equal(current.autoHandoverForceContextTokens, 400000, 'the policy API returns the default forced context threshold');
  assert.equal(current.machine.guardEnabled, true, 'the fresh policy enables the guard explicitly');
  assert.equal(current.machine.guardPausedUntil, null);
  const draft = {
    ...current,
    machine: { ...current.machine, guardEnabled: false, guardPausedUntil: '2026-09-26T13:00:00.000Z' },
    modelProviders: { [shared]: null },
    extraModels: { pi: ['opencode-go/glm-5.2'] },
    disabledModels: { opencode: [shared] },
    harnessRoutes: { pi: { 'opencode-go/glm-5.2': 'opencodego' } },
    autoHandoverForceContextTokens: 450000,
  };
  const put = (body) => fetch(`${base}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await put(draft);
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).policy;
  assert.deepEqual(stored.extraModels, draft.extraModels);
  assert.deepEqual(stored.disabledModels, draft.disabledModels);
  assert.deepEqual(stored.harnessRoutes, draft.harnessRoutes);
  assert.deepEqual(stored.modelProviders, { ...current.modelProviders, ...draft.modelProviders }, 'the legacy route stays beside the default routes');
  assert.equal(stored.autoHandoverForceContextTokens, draft.autoHandoverForceContextTokens);
  assert.equal(stored.machine.guardEnabled, false);
  assert.equal(stored.machine.guardPausedUntil, draft.machine.guardPausedUntil);
  assert.deepEqual([current.machine.swapWarnPercent, current.machine.swapRefusePercent, current.machine.swapMinUsedGB], [80, 95, 2], 'the fresh policy carries the swap defaults');
  const swapSaved = await put({ ...draft, machine: { ...draft.machine, swapWarnPercent: 70, swapRefusePercent: null, swapMinUsedGB: 3.5 } });
  assert.equal(swapSaved.status, 200);
  assert.deepEqual((({ swapWarnPercent, swapRefusePercent, swapMinUsedGB }) => ({ swapWarnPercent, swapRefusePercent, swapMinUsedGB }))((await swapSaved.json()).policy.machine), { swapWarnPercent: 70, swapRefusePercent: null, swapMinUsedGB: 3.5 });
  const swapReread = (await (await fetch(`${base}/api/policy`)).json()).machine;
  assert.deepEqual([swapReread.swapWarnPercent, swapReread.swapRefusePercent, swapReread.swapMinUsedGB], [70, null, 3.5]);
  const invalidSwap = await put({ ...draft, machine: { ...draft.machine, swapWarnPercent: 101 } });
  assert.equal(invalidSwap.status, 400);
  assert.match((await invalidSwap.json()).errors.join(' '), /machine.swapWarnPercent/);
  const invalidGuard = await put({ ...draft, machine: { ...draft.machine, guardEnabled: 'off' } });
  assert.equal(invalidGuard.status, 400);
  assert.match((await invalidGuard.json()).errors.join(' '), /machine.guardEnabled/);
  const invalidForceThreshold = await put({ ...draft, autoHandoverForceContextTokens: draft.autoHandoverContextTokens });
  assert.equal(invalidForceThreshold.status, 400);
  assert.match((await invalidForceThreshold.json()).errors.join(' '), /autoHandoverForceContextTokens must be greater than autoHandoverContextTokens/);
  const invalidPause = await put({ ...draft, machine: { ...draft.machine, guardPausedUntil: 'tomorrow' } });
  assert.equal(invalidPause.status, 400);
  assert.match((await invalidPause.json()).errors.join(' '), /machine.guardPausedUntil/);
  const rejected = await put({ ...draft, extraModels: { pi: ['glm; rm -rf ~'] } });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).errors.join(' '), /extraModels/);
  assert.deepEqual((await (await fetch(`${base}/api/policy`)).json()).extraModels, draft.extraModels, 'a rejected save keeps the stored policy');
  const crossed = await put({ ...draft, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6-luna': 'claude' } } });
  assert.equal(crossed.status, 400);
  assert.match((await crossed.json()).errors.join(' '), /harnessRoutes: codex\/gpt-6-luna cannot use claude\. Choose codex or null \(unmetered\)\./);
  const compatible = await put({ ...draft, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6-luna': null }, claude: { 'claude-opus-5-5': 'claude' } } });
  assert.equal(compatible.status, 200);
  assert.deepEqual((await compatible.json()).policy.harnessRoutes.codex, { 'gpt-6-luna': null });
  const inherited = await put({ ...draft, modelProviders: { ...draft.modelProviders, 'gpt-6.1-sol': 'claude' } });
  assert.equal(inherited.status, 400);
  assert.match((await inherited.json()).errors.join(' '), /modelProviders: codex\/gpt-6.1-sol inherits claude\. Choose codex or null \(unmetered\) in harnessRoutes\.codex\./);
  const pruned = await put({ ...draft, modelProviders: { ...draft.modelProviders, 'claude-opus-5': 'claude' }, disabledModels: { ...draft.disabledModels, claude: ['claude-opus-5'] }, extraModels: { ...draft.extraModels, claude: ['claude-opus-5-5'] } });
  assert.equal(pruned.status, 200);
  const prunedBody = await pruned.json();
  assert.equal(prunedBody.notes.length, 1);
  assert.match(prunedBody.notes[0], /claude-opus-5 \(disabledModels\.claude, modelProviders\)/);
  assert.equal(prunedBody.policy.modelProviders['claude-opus-5'], undefined);
  assert.equal(prunedBody.policy.disabledModels.claude, undefined);
  assert.equal(prunedBody.policy.extraModels.claude, undefined);
  assert.deepEqual((await (await put(draft)).json()).notes, [], 'a clean save has no note');
  const stillStrict = await put({ ...draft, disabledModels: { claude: ['claude-opus-5'] }, maxWorkers: 0 });
  assert.equal(stillStrict.status, 400);
  assert.match((await stillStrict.json()).errors.join(' '), /maxWorkers/);
  const overridden = await put({ ...draft, modelProviders: { ...draft.modelProviders, 'gpt-6.1-sol': 'claude', 'claude-opus-5-5': 'claude' }, harnessRoutes: { ...draft.harnessRoutes, codex: { 'gpt-6.1-sol': 'codex' } }, ignoredRoutes: { codex: ['gpt-6.1-sol'] } });
  assert.equal(overridden.status, 200);
  const overriddenPolicy = (await overridden.json()).policy;
  assert.equal(overriddenPolicy.modelProviders['gpt-6.1-sol'], 'claude', 'the raw legacy route is kept');
  assert.deepEqual(overriddenPolicy.ignoredRoutes, {}, 'the override makes the legacy route compatible');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'policy.json'), 'utf8')).ignoredRoutes, undefined, 'the derived field is not stored');
  const resetAt = (await (await fetch(`${base}/api/state`)).json()).quotas[0].windows[0].resetsAt;
  const timed = { ...draft, pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: new Date(Date.now() + 6 * 3600000).toISOString() } } } } };
  const acceptedGoal = await put(timed);
  assert.equal(acceptedGoal.status, 200);
  assert.equal((await acceptedGoal.json()).policy.pacingGoals.codex.primary.end.resetAt, resetAt);
  for (const [bad, reason] of [
    [new Date(Date.now() - 3600000).toISOString(), /after now/],
    [new Date(Date.parse(resetAt) + 3600000).toISOString(), /at or before reset/],
  ]) {
    const rejectedGoal = await put({ ...timed, pacingGoals: { codex: { primary: { percent: 80, end: { type: 'at', at: bad } } } } });
    assert.equal(rejectedGoal.status, 400);
    assert.match((await rejectedGoal.json()).errors.join(' '), reason);
  }
  assert.equal((await (await fetch(`${base}/api/policy`)).json()).pacingGoals.codex.primary.end.resetAt, resetAt, 'a rejected end keeps the saved goal');
  const catalog = await (await fetch(`${base}/api/models`)).json();
  assert.ok(!catalog.pi.allowedModels.includes('opencode-go/glm-5.2'), 'the model catalog endpoint stays the kit catalog');
});

test('the model catalog endpoint lists free opencode/ models only for the opencode harness', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: null, quotas: [] };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalogResponse = await fetch(`${base}/api/models`);
  assert.equal(catalogResponse.status, 200);
  const catalogHeaders = Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'x-frame-options', 'referrer-policy']
    .map((name) => [name, catalogResponse.headers.get(name)]));
  assert.deepEqual(catalogHeaders, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  const catalogBody = await catalogResponse.text();
  const catalog = JSON.parse(catalogBody);
  assert.equal(catalogBody, JSON.stringify(catalog), 'the catalog response uses compact JSON');
  assert.deepEqual(Object.keys(catalog).sort(), ['claude', 'codex', 'opencode', 'pi']);
  for (const provider of Object.values(catalog)) {
    assert.equal(typeof provider.defaultModel, 'string');
    assert.ok(Array.isArray(provider.allowedModels));
  }
  const malformedQuery = await fetch(`${base}/api/models?bad=%E0%A4%A`);
  assert.equal(malformedQuery.status, 200, 'the route ignores a malformed query value');
  assert.deepEqual(Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'x-frame-options', 'referrer-policy']
    .map((name) => [name, malformedQuery.headers.get(name)])), catalogHeaders);
  assert.equal(await malformedQuery.text(), catalogBody, 'the malformed query does not change the response bytes');
  const unsupportedMethod = await fetch(`${base}/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(unsupportedMethod.status, 404, 'an unsupported method reaches the existing fallback');
  assert.equal(await unsupportedMethod.text(), '{"error":"not found"}');
  assert.deepEqual(catalog.pi.allowedModels.filter((model) => model.startsWith('opencode/')), [], 'Pi lists no free opencode/ model');
  assert.ok(catalog.opencode.allowedModels.includes('opencode/big-pickle'), 'the opencode harness lists its free models');
  assert.equal(catalog.pi.defaultModel, 'opencode-go/muse-spark-1.3-contributor', 'the Pi default is unchanged');
  await close();
});

test('handoff API accepts a live boss-labeled pane without a project control entry', { timeout: 30000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const bin = path.join(homeDir, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
let result = {};
if (args[0] === 'pane' && args[1] === 'get') result = { pane: {
  pane_id: args[2], workspace_id: 'ws-boss', label: 'boss', agent: 'codex',
  cwd: process.cwd(), foreground_cwd: process.cwd(), agent_session: { kind: 'id', value: 'boss-session' },
} };
if (args[0] === 'pane' && args[1] === 'process-info') result = { process_info: {
  shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: 'zsh' }],
} };
if (args[0] === 'pane' && args[1] === 'read') result = { text: '% ' };
if (args[0] === 'agent' && args[1] === 'list') result = { agents: [] };
if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'ws-boss:p2' } };
if (args[0] === 'agent' && args[1] === 'get') result = { agent_status: 'working' };
console.log(JSON.stringify({ result }));
`);
  fs.chmodSync(herdr, 0o755);
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ control: { projects: {}, risks: {} } }));
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const bossHandoff = { pane: 'ws-boss:p1', workspace: 'ws-boss', label: 'Boss' };
  let engine;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      engine = new EventEmitter();
      engine.state = {
        control: { projects: {}, bossHandoff },
        herdr: { panes: [{ id: bossHandoff.pane, workspace: bossHandoff.workspace, label: 'boss' }] },
        quotas: [],
      };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { project: 'Boss', pane: bossHandoff.pane, to: 'pi', model: 'opencode-go/deepseek-v4.1-flash', mode: 'fresh' };
  const request = (route, requestBody = body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  });
  const planResponse = await request('/api/handoffs/plan');
  const planText = await planResponse.text();
  assert.equal(planResponse.status, 200, planText);
  const plan = JSON.parse(planText);
  assert.equal(plan.boss, true);
  assert.equal(plan.project, 'Boss');
  const wrongPane = await request('/api/handoffs/plan', { ...body, pane: 'ws-boss:p9' });
  assert.equal(wrongPane.status, 400, 'the Boss path still requires the current boss pane');
  assert.match((await wrongPane.json()).error, /Unknown current orchestrator pane/);
  engine.state.herdr.panes[0].label = 'orch';
  const wrongLabel = await request('/api/handoffs/plan');
  assert.equal(wrongLabel.status, 400, 'the Boss path requires the exact boss label');
  assert.match((await wrongLabel.json()).error, /Unknown current orchestrator pane/);
  engine.state.herdr.panes[0].label = 'boss';
  const prepareResponse = await request('/api/handoffs/prepare');
  const prepareText = await prepareResponse.text();
  assert.equal(prepareResponse.status, 200, prepareText);
  const prepared = JSON.parse(prepareText);
  assert.equal(prepared.boss, true);
  assert.equal(prepared.sourcePane, bossHandoff.pane);
  assert.equal(prepared.status, 'prepared');
  await close();
  assert.equal(server.listening, false, 'the API integration stops its server');
});

test('the lease release endpoint refuses a changed lease and releases a matching one', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: null, quotas: [] };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const leaseFile = path.join(dataDir, 'leases.json');
  const seed = (project) => fs.writeFileSync(leaseFile, JSON.stringify({ leases: [{
    pool: 'project-browsers', item: '9225', project, worker: null, pane: null, holder: 'project',
    at: new Date().toISOString(), expiresAt: null, borrowed: false,
  }] }));
  const post = (body) => fetch(`${base}/api/leases/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await post({ pool: 'project-browsers', item: '9225' })).status, 400, 'the body needs pool, item, and project');

  seed('beta');
  const conflict = await post({ pool: 'project-browsers', item: '9225', project: 'alpha' });
  assert.equal(conflict.status, 409, 'a lease of another project is a conflict');
  assert.equal((await conflict.json()).error, 'The lease changed. Reload the page.');
  assert.equal(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).leases.length, 1, 'a conflict keeps the lease');

  seed('alpha');
  const released = await post({ pool: 'project-browsers', item: '9225', project: 'alpha' });
  const releasedText = await released.text();
  assert.equal(released.status, 200, releasedText);
  assert.equal(JSON.parse(releasedText).released.item, '9225');
  assert.deepEqual(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).leases, []);
  await close();
});

function rawRequest(base, method, route, { headers = {}, body } = {}) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('the messages API validates Owner sends, refuses cross-origin and unauthenticated remote requests, and limits the rate', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const { readMessages, STATUS_REQUEST_TEXT, NUDGES } = await import('../src/messages.js');
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let engine;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { slug: 'alpha', workspace: 'wA', orch: { pane: 'wA:p1' } } } }, herdr: { panes: [] } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const invalid = [
    [{ thread: 'alpha', kind: 'message', text: '' }, 400],
    [{ thread: 'alpha', kind: 'message', text: '   ' }, 400],
    [{ thread: 'alpha', kind: 'message', text: 'x'.repeat(2001) }, 400],
    [{ thread: 'alpha', kind: 'message' }, 400],
    [{ thread: 'alpha', kind: 'nudge', text: 'Delete everything.' }, 400],
    [{ thread: 'alpha', kind: 'reply', text: 'Hi.' }, 400],
    [{ thread: 'Not A Slug', kind: 'message', text: 'Hi.' }, 400],
    [{ thread: 'gamma', kind: 'message', text: 'Hi.' }, 404],
  ];
  for (const [body, status] of invalid) {
    const response = await post(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.ok((await response.json()).error);
  }
  const wrongType = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 400);

  const crossOrigin = await rawRequest(base, 'POST', '/api/messages', {
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(crossOrigin.status, 403, 'a cross-origin send is refused');
  const crossSite = await rawRequest(base, 'POST', '/api/messages', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(crossSite.status, 403, 'a cross-site send is refused');
  const remote = await rawRequest(base, 'POST', '/api/messages', {
    headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/json' }, body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'Hi.' }),
  });
  assert.equal(remote.status, 401, 'a remote send without a session is refused');
  const remoteRead = await rawRequest(base, 'GET', '/api/messages?thread=boss', { headers: { host: 'mac.tail0000.ts.net' } });
  assert.equal(remoteRead.status, 401, 'a remote read without a session is refused');
  const remoteAgentMeta = await rawRequest(base, 'GET', '/api/agent-meta?project=alpha', { headers: { host: 'mac.tail0000.ts.net' } });
  assert.equal(remoteAgentMeta.status, 401, 'agent metadata uses the same remote login rule');
  assert.deepEqual(readMessages(), [], 'no refused request reaches the store');

  const token = fs.readFileSync(cfg.access.tokenFile, 'utf8').trim();
  const login = await rawRequest(base, 'POST', '/login', {
    headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const remoteSend = await rawRequest(base, 'POST', '/api/messages', {
    headers: { host: 'mac.tail0000.ts.net', cookie, 'content-type': 'application/json', origin: 'http://mac.tail0000.ts.net' },
    body: JSON.stringify({ thread: 'boss', kind: 'message', text: 'From the phone.' }),
  });
  assert.equal(remoteSend.status, 200, remoteSend.text);

  const sent = await post({ thread: 'alpha', kind: 'message', text: '  Please continue.  ' });
  assert.equal(sent.status, 200);
  const record = (await sent.json()).message;
  assert.equal(record.thread, 'alpha');
  assert.equal(record.from, 'owner');
  assert.equal(record.to, 'orch');
  assert.equal(record.status, 'queued');
  assert.equal(record.text, 'Please continue.');
  const nudge = await post({ thread: 'alpha', kind: 'nudge', text: NUDGES[1] });
  assert.equal((await nudge.json()).message.text, 'Use your free worker slots.');
  const statusRequest = await post({ thread: 'boss', kind: 'status-request' });
  const statusRecord = (await statusRequest.json()).message;
  assert.equal(statusRecord.text, STATUS_REQUEST_TEXT);
  assert.equal(STATUS_REQUEST_TEXT, 'Send a short status report with herdr-boss say, and publish your status file.');
  assert.equal(statusRecord.to, 'boss');

  const thread = await fetch(`${base}/api/messages?thread=alpha`);
  assert.equal(thread.status, 200);
  assert.deepEqual((await thread.json()).map((m) => m.text), ['Please continue.', 'Use your free worker slots.'], 'newest last');
  assert.equal((await fetch(`${base}/api/messages?thread=Bad Thread`)).status, 400);
  assert.equal((await fetch(`${base}/api/messages`)).status, 400);

  // Four sends so far. The rate limit allows 10 in a minute across all threads.
  for (let i = 0; i < 6; i += 1) assert.equal((await post({ thread: i % 2 ? 'boss' : 'alpha', kind: 'message', text: `Send ${i}.` })).status, 200);
  const limited = await post({ thread: 'boss', kind: 'message', text: 'One too many.' });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /10/);
  assert.equal(readMessages().length, 10);
});

test('chat routes list writable threads, page messages, and mark Owner messages read', { timeout: 20000 }, async (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const { openMessageStore } = await import('../src/message-store.js');
  const store = openMessageStore({ dir: dataDir });
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const append = (thread, fields, offset) => store.append({ thread, ...fields }, { now: now + offset });
  const alpha = [
    append('alpha', { from: 'owner', to: 'orch', text: 'Alpha 0.' }, 0),
    append('alpha', { from: 'orch', to: 'owner', kind: 'reply', text: 'Alpha 1.' }, 1),
    append('alpha', { from: 'owner', to: 'orch', text: 'Alpha 2.' }, 2),
    append('alpha', { from: 'orch', to: 'owner', kind: 'reply', text: 'Alpha 3.', readAt: new Date(now + 3).toISOString() }, 3),
    append('alpha', { from: 'orch', to: 'owner', kind: 'reply', text: 'A'.repeat(150) }, 4),
  ];
  append('boss', { from: 'boss', to: 'owner', kind: 'reply', text: 'Boss update.' }, 3);
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: {
        alpha: { project: 'Alpha Project', orch: { pane: 'wA:p1' } },
        beta: { project: 'Beta Project', orch: { pane: 'wB:p1' } },
        offline: { project: 'Offline Project', orch: null },
      } } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const chatsResponse = await fetch(`${base}/api/chats`);
  assert.equal(chatsResponse.status, 200);
  const chats = await chatsResponse.json();
  assert.deepEqual(chats.map((chat) => [chat.thread, chat.title, chat.unread]), [
    ['alpha', 'Alpha Project', 2], ['boss', 'Boss', 1], ['beta', 'Beta Project', 0],
  ]);
  assert.deepEqual(Object.keys(chats[0].last), ['id', 'at', 'from', 'channel', 'title', 'text', 'status']);
  assert.equal(chats[0].last.id, alpha[4].id);
  assert.equal(chats[0].last.text.length, 120);
  assert.equal(chats[2].last, null, 'a project chat appears before it has messages');

  const pageResponse = await fetch(`${base}/api/chats/alpha?before=${alpha[4].id}&limit=2`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.thread, 'alpha');
  assert.deepEqual(page.messages.map((record) => record.text), ['Alpha 2.', 'Alpha 3.']);
  assert.equal(page.more, true);
  const lastPage = await fetch(`${base}/api/chats/alpha?before=${alpha[3].id}&limit=3`);
  assert.equal((await lastPage.json()).more, false);
  assert.equal((await fetch(`${base}/api/chats/alpha?limit=101`)).status, 400);

  const marked = await fetch(`${base}/api/chats/alpha/read`, { method: 'POST' });
  assert.equal(marked.status, 200);
  assert.deepEqual(await marked.json(), { ok: true, updated: 2 });
  assert.equal(store.chats().find((chat) => chat.thread === 'alpha').unreadForOwner, 0);
});

test('the chat routes mark each record with its channel, and a report is not chat unread', { timeout: 20000 }, async (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const { openMessageStore } = await import('../src/message-store.js');
  const store = openMessageStore({ dir: dataDir });
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const append = (thread, fields, offset) => store.append({ thread, ...fields }, { now: now + offset });
  const chatReply = append('alpha', { from: 'orch', to: 'owner', kind: 'reply', text: 'Information only.' }, 1);
  const approve = append('alpha', { from: 'orch', to: 'owner', kind: 'reply', text: 'Approve the plan?', action: 'approve' }, 2);
  const report = append('alpha', { from: 'boss', to: 'owner', kind: 'report', title: 'Morning handback', text: '# Morning handback' }, 3);
  const { recordAgentMessage } = await import('../src/agent-messages.js');
  const boss = { role: 'boss', project: null, name: null, pane: 'wB:p1' };
  const orch = { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' };
  const agentFirst = recordAgentMessage({ from: boss, to: orch, text: 'Internal task for alpha.', kind: 'task' }, { dir: dataDir, now: now + 4 });
  const agentSecond = recordAgentMessage({ from: orch, to: boss, text: 'Follow-up on the task.', kind: 'reply' }, { dir: dataDir, now: now + 5 });
  const betaOrch = { role: 'orch', project: 'beta', name: null, pane: 'wB:p2' };
  const betaAgent = recordAgentMessage({ from: boss, to: betaOrch, text: 'Internal task for beta.', kind: 'task' }, { dir: dataDir, now: now + 6 });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { project: 'Alpha Project', orch: { pane: 'wA:p1' } } } } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await (await fetch(`${base}/api/chats/alpha?limit=10`)).json();
  assert.deepEqual(page.messages.map((record) => [record.id, record.channel]), [
    [chatReply.id, 'chat'], [approve.id, 'both'], [report.id, 'mail'],
  ]);
  const chats = await (await fetch(`${base}/api/chats`)).json();
  assert.equal(chats[0].unread, 2, 'the two chat records to the Owner are unread. The report is mail.');
  assert.equal(chats[0].last.title, 'Morning handback', 'the last record keeps the report title for the short report line');

  const marked = await fetch(`${base}/api/chats/alpha/read`, { method: 'POST' });
  assert.deepEqual(await marked.json(), { ok: true, updated: 2 });
  const reportRecord = store.all().find((record) => record.id === report.id);
  assert.equal(reportRecord.readAt, undefined, 'reading a chat does not mark a report read');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.mailbox.mailUnread, 1, 'the report stays mail unread');
  assert.equal(state.mailbox.chatUnread, 0);
  assert.equal(state.mailbox.needsAction, 1, 'the approve item is open in Needs you');

  const query = new URLSearchParams({ project: 'alpha', pair: agentFirst.pairKey, q: 'internal', limit: '10' });
  const agentPage = await fetch(`${base}/api/agent-messages?${query}`);
  assert.equal(agentPage.status, 200);
  assert.deepEqual((await agentPage.json()).map((item) => item.id), [agentFirst.id]);
  const recentQuery = new URLSearchParams({ project: 'alpha', pair: agentFirst.pairKey, limit: '1' });
  const recentAgentPage = await (await fetch(`${base}/api/agent-messages?${recentQuery}`)).json();
  assert.deepEqual(recentAgentPage.map((item) => item.id), [agentSecond.id]);
  recentQuery.set('before', agentSecond.id);
  const olderAgentPage = await (await fetch(`${base}/api/agent-messages?${recentQuery}`)).json();
  assert.deepEqual(olderAgentPage.map((item) => item.id), [agentFirst.id]);
  const pairs = await (await fetch(`${base}/api/agent-pairs?project=alpha`)).json();
  assert.deepEqual(pairs, [{ pairKey: agentFirst.pairKey, count: 2, lastAt: agentSecond.createdAt }]);
  const allAgentMessages = await (await fetch(`${base}/api/agent-messages`)).json();
  assert.deepEqual(new Set(allAgentMessages.map((item) => item.id)), new Set([agentFirst.id, agentSecond.id, betaAgent.id]));
  const allPairs = await (await fetch(`${base}/api/agent-pairs`)).json();
  assert.deepEqual(allPairs.map((item) => item.pairKey).sort(), [agentFirst.pairKey, betaAgent.pairKey].sort());
  const since = agentFirst.createdAt;
  const until = agentSecond.createdAt;
  const metaQuery = new URLSearchParams({ project: 'alpha', since, until, limit: '10' });
  const metaResponse = await fetch(`${base}/api/agent-meta?${metaQuery}`);
  assert.equal(metaResponse.status, 200);
  const metadata = await metaResponse.json();
  assert.deepEqual(metadata.map((row) => row.id), [agentSecond.id, agentFirst.id]);
  assert.ok(metadata.every((row) => row.respondedAt === null && !Object.hasOwn(row, 'text')));
  const allMetadata = await (await fetch(`${base}/api/agent-meta`)).json();
  assert.deepEqual(new Set(allMetadata.map((row) => row.id)), new Set([agentFirst.id, agentSecond.id, betaAgent.id]));
  const standardIso = new URLSearchParams({ project: 'alpha', since: '2026-01-01T00:00:00Z' });
  assert.equal((await fetch(`${base}/api/agent-meta?${standardIso}`)).status, 200, 'ISO timestamps without fractional seconds are valid');
  assert.equal((await fetch(`${base}/api/agent-meta?project=alpha&since=not-an-iso-time`)).status, 400);
  assert.equal((await fetch(`${base}/api/agent-meta?project=alpha&since=2026-02-30T00%3A00%3A00Z`)).status, 400);
  assert.equal((await fetch(`${base}/api/agent-meta`, { method: 'POST' })).status, 404, 'the Owner has no metadata write route');
});

test('message events stream local changes and report a second process append once on the next tick', { timeout: 30000 }, async (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const { openMessageStore } = await import('../src/message-store.js');
  const { pathToFileURL } = await import('node:url');
  const { once } = await import('node:events');
  const storeEntry = pathToFileURL(path.resolve('src/message-store.js')).href;
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const collectors = {
    collectHerdr: async () => ({ panes: [], workspaces: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => [],
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    collectPiModels: async () => ({ models: [] }),
  };
  let engine;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: (config, options) => {
      engine = new Engine(config, { ...options, collectors, kitRoot: path.join(dataDir, 'kit'), lockDataDir: dataDir });
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  if (!engine.state?.control) await once(engine, 'state');
  const emitted = [];
  engine.on('message', (event) => emitted.push(event));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextMessage = async () => {
    for (;;) {
      let boundary = buffer.indexOf('\n\n');
      while (boundary < 0) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'the event stream stays open');
        buffer += decoder.decode(value, { stream: true });
        boundary = buffer.indexOf('\n\n');
      }
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!/^event: message$/m.test(frame)) continue;
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      return JSON.parse(data.slice(6));
    }
  };
  const childSource = `import { openMessageStore } from ${JSON.stringify(storeEntry)}; openMessageStore({ dir: process.argv[1] }).append({ thread: 'alpha', from: 'orch', to: 'owner', text: 'External append.' });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', childSource, dataDir], {
    env: { ...process.env, HOME: homeDir, HERDR_BOSS_DIR: dataDir },
  });
  const serviceAppendEvent = nextMessage();
  const serviceRecord = openMessageStore({ dir: dataDir }).append({ thread: 'boss', from: 'boss', to: 'owner', text: 'Service append.' });
  assert.deepEqual(await serviceAppendEvent, { type: 'append', record: serviceRecord });

  const externalAppendEvent = nextMessage();
  await engine.tick();
  const externalEvent = await externalAppendEvent;
  assert.equal(externalEvent.type, 'append');
  assert.equal(externalEvent.record.text, 'External append.');
  await engine.tick();
  assert.deepEqual(emitted.map(({ type, record }) => [type, record.text]), [
    ['append', 'Service append.'], ['append', 'External append.'],
  ]);
  await reader.cancel();
});

test('organization page offers the Plain and Cards styles, motion with a reduced-motion fallback, and a phone worker count', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // The switch stores the choice in localStorage behind try/catch, and Plain is the default.
  assert.match(app, /\['plain', 'cards'\]\.map\(\(style\) => `<button type="button" data-org-style="\$\{style\}" aria-pressed=/);
  assert.match(app, /const ORG_STYLE_KEY = 'herdr-boss\.orgStyle'/);
  assert.match(app, /try \{ return localStorage\.getItem\(ORG_STYLE_KEY\) === 'cards' \? 'cards' : 'plain'; \} catch \{ return 'plain'; \}/);
  assert.match(app, /try \{ localStorage\.setItem\(ORG_STYLE_KEY, orgStyle\); \} catch \{\}/);
  // Cards show an inline-SVG mark for each harness and a quota bar for Codex and Claude.
  for (const kind of ['claude', 'codex', 'opencode', 'pi', 'unknown']) assert.match(app, new RegExp(`\\b${kind}: '<svg`), `harness mark for ${kind}`);
  assert.match(app, /<div class="org-quota\$\{quota\.stale \? ' stale' : ''\}" role="img"/);
  assert.match(css, /\.org-cards \.org-state-working\b[^{]*\{[^}]*animation: org-pulse/);
  assert.match(css, /\.org-cards \.org-state-blocked\b/);
  assert.match(css, /\.org-cards \.org-state-failed\b/);
  // Motion reads the loaded events and falls back to a highlight when the viewer asks for reduced motion.
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(app, /function orgEventLinks\(/);
  assert.match(app, /wrote its report/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.org-cards \.org-state-working/);
  assert.match(css, /\.org-flash\b/);
  // On a phone, a project shows a worker count that expands, with buttons of at least 44 px.
  assert.match(app, /data-org-workers="/);
  assert.match(css, /\.org-worker-count\b/);
  assert.match(css, /@media \(max-width: 760px\) \{[^@]*\.org-style-switch button[^}]*min-height: 44px/);
  assert.match(app, /Plain<\/b> and <b>Cards/);
});

test('quota cards show the shared pacing goal text in each window and the trickle footer', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /lane\?\.goals\?\.find\(\(goal\) => goal\.key === w\.key\)\?\.text/);
  assert.match(app, /const goalLabel = windowGoalText \? ` <span class="muted">· \$\{esc\(windowGoalText\)\}<\/span>`/);
  assert.match(app, /<div class="win-row"><span>\$\{esc\(w\.label\)\}\$\{goalLabel\}/);
  assert.match(app, /Trickle allowance: about \$\{lane\.allowancePercent\.toFixed\(1\)\}%\/day.*?\$\{esc\(trickleGoalText\)\}/s);
});

test('quota colors use configured thresholds and Settings shows their values', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /usedPercent\s*>=\s*(?:98|90|70)\b/, 'quota colors do not use fixed thresholds');
  assert.match(app, /state\?\.quotaThresholds|s\?\.quotaThresholds/);
  assert.match(app, /fallback = \{ warnPercent: 90, criticalPercent: 98 \}/);
  assert.match(app, /quotaThresholds\(s, \{ warnPercent: 70, criticalPercent: 90 \}\)/);
  assert.match(app, /w\.usedPercent >= thresholds\.criticalPercent/);
  assert.match(app, /w\.usedPercent >= thresholds\.warnPercent/);
  assert.match(app, /quota\.usedPercent >= quota\.criticalPercent[^\n]+quota\.usedPercent >= quota\.warnPercent/);
  assert.doesNotMatch(app, /Quota warning at \$\{esc\(warnPercent\)\}/, 'the two levels show as rows of the Service settings table, not as an inline line');
  const settingsHelp = /settings: \['Settings', `([\s\S]*?)`\],\s+agents:/.exec(app)?.[1] || '';
  assert.match(settingsHelp, /usage limit colors use the warning and critical values from <code>config\.json<\/code>/i);
  assert.match(app, /data-service-setting=/);
  assert.match(app, /data-save-service-settings=/);
  assert.match(SETTING_GROUPS.find((group) => group.id === 'service').safe, /A row without an input is read-only\. Change it in config\.json\./);
  assert.match(app, /restart required/);
  assert.match(settingsHelp, /select <b>Save<\/b>[\s\S]*?applies saved values at once/i);
});

test('organization cards show an unavailable or stale quota bar, and the header keeps the brand and the updated text on one line', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // A Claude or Codex card without quota data shows a muted empty bar with a label.
  assert.match(app, /function orgQuotaMeter\(s, kind\)/);
  assert.match(app, /aria-label="\$\{esc\(`\$\{PROVIDERS\[agent\]\} usage limit unavailable`\)\}"/);
  assert.match(app, /class="org-quota-note" aria-hidden="true">usage limit unavailable</);
  assert.match(app, /usage limit from \${clock\(quota\.staleSince\)\}, the last probe failed/);
  assert.match(app, /last reading \$\{reading\.usedPercent\}%/);
  assert.match(app, /\$\{readingAge\}\$\{reading\.stale \? ' · stale' : ''\}/);
  // A missing usage reader shows the reading as unknown with its reason, never as a probe failure.
  assert.match(app, /if \(q\.unavailable\) return `[\s\S]*?<span class="tag">unknown<\/span>[\s\S]*?Usage limit unknown: \$\{esc\(q\.reason \|\| q\.error\)\}/);
  assert.match(app, /if \(q\?\.unavailable\) return `\$\{PROVIDERS\[kind\]\} usage limit unknown · \$\{q\.reason \|\| q\.error\}`/);
  assert.match(app, /const unknown = lane\.state === 'unknown' && lane\.reason/);
  assert.match(app, /The Boss gets one warning when the Claude probe fails for over 60 minutes/);
  assert.match(css, /\.org-quota\.unavailable\b/);
  assert.match(css, /\.org-quota\.stale > i\b[^{]*\{/);
  assert.match(css, /\.org-quota-note\b[^{]*\{[^}]*color: var\(--muted\)/);
  // The brand and the updated text never break inside themselves.
  assert.match(css, /\.brand \{[^}]*white-space: nowrap/);
  assert.match(css, /\.live \{[^}]*white-space: nowrap/);
});

test('the dependency graph draws every task, with fit, zoom, pan, and a full-size overlay', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // Every task in the filter is a node, including tasks without links. The 90-task cut and the empty-edge bail-out are gone.
  assert.doesNotMatch(app, /if \(!edges\.length\) return ''/);
  assert.doesNotMatch(app, /first 90/);
  assert.doesNotMatch(app, /nodes\.length > 90/);
  assert.match(app, /const nodes = graphTasks\(all, \{ openOnly: !view\.graphAll \}\)/);
  // A task without links sits in column 0, after the linked tasks of that column.
  assert.match(app, /linked\.has\(keyOf\.get\(a\)\) \? 0 : 1/);
  // The toolbar has Fit, out, in, 100%, and Full size. Each button has an aria-label.
  for (const action of ['fit', 'out', 'in', '100', 'full']) assert.match(app, new RegExp(`data-dep-action="${action}"`), `${action} button`);
  assert.match(app, /aria-label="Fit the whole graph/);
  assert.match(app, /aria-label="Zoom out"/);
  assert.match(app, /aria-label="Zoom in"/);
  assert.match(app, /aria-label="Zoom to 100 percent"/);
  assert.match(app, /aria-label="Show the graph at full size"/);
  assert.match(app, /aria-label="Close full size"/);
  // The buttons are at least 32 px high on a desktop and 44 px on a phone.
  assert.match(css, /\.dep-btn\b[^{]*\{[^}]*min-height: 32px/);
  assert.match(css, /\.dep-btn, \.dep-close \{ min-height: 44px/);
  // The dark-theme global button color must not hide the toolbar labels.
  assert.match(css, /:root:not\(\[data-theme="light"\]\) \.dep-btn[^{]*\{[^}]*color: var\(--text\)/);
  // Zoom and pan change the viewBox only. The page is never scaled.
  assert.match(app, /const DEP_MIN_ZOOM = 0\.25/);
  assert.match(app, /DEP_MAX_ZOOM = 4/);
  assert.match(app, /svg\.setAttribute\('viewBox'/);
  assert.doesNotMatch(app, /\.dep-graph[^;]*transform: scale/);
  // Ctrl or Cmd with the wheel zooms around the pointer. A plain wheel scrolls the page.
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /if \(!\(e\.ctrlKey \|\| e\.metaKey\)\) return;/);
  assert.match(app, /\{ passive: false \}/);
  // Drag the background with pointer capture. A drag that starts on a task box does not pan.
  assert.match(app, /stage\.setPointerCapture\(e\.pointerId\)/);
  assert.match(app, /closest\?\.\('button, a, \.dep-node-group'\)/);
  // Full size is a fixed overlay with a close button. Escape and the button close it.
  assert.match(app, /function setDepFull\(slug, on\)/);
  assert.match(app, /body\.classList\.toggle\('dep-full-open', on\)/);
  assert.match(css, /\.dep-stage\.full\b[^{]*\{[^}]*position: fixed[^}]*inset: 0/);
  assert.match(app, /if \(e\.key !== 'Escape'\) return;[\s\S]{0,200}setDepFull/);
  // The help panel and the user guide describe the toolbar and the gestures.
  assert.match(app, /<b>Fit<\/b> to show the whole graph/);
  assert.match(app, /Drag the background to pan/);
  assert.match(guide, /Graph view/);
  assert.match(guide, /Ctrl or Cmd/);
});

test('the project page shows a Needs your decision group, wait labels, and an Overview count', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The group lists each open task that waits on the Owner, with its ask and a Mailbox conversation link.
  assert.match(app, /function decisionsBlock\(p, m, slug\)/);
  assert.match(app, /t\.waitingOn === 'owner'/);
  assert.match(app, /Needs your decision/);
  assert.match(app, /href="\/mailbox\?thread=\$\{encodeURIComponent\(slug\)\}&conversation=\$\{encodeURIComponent\(t\.mailboxId\)\}"/);
  assert.match(app, /decisionsBlock\(p, work, slug\)/);
  // A task that waits only on open tasks shows the blocker IDs. The other waits name their party and the ask.
  assert.match(app, /waiting on \$\{open\.map\(\(id\) => `#\$\{id\}`\)\.join\(', '\)\}/);
  assert.match(app, /waits for the Boss/);
  assert.match(app, /waits for an external party/);
  // Each project card and the Overview line count the open Owner waits.
  assert.match(app, /Needs your decision \$\{decisions\}/);
  assert.match(app, /function decisionSummary\(s\)/);
  assert.match(app, /decisionSummary\(s\)/);
  assert.match(css, /\.decision-item\b/);
  assert.match(app, /<h3>Needs your decision<\/h3>/);
  assert.match(guide, /Needs your decision/);
  assert.match(guide, /waitingOn/);
});

test('one Agents tab has Chart and List views, a new menu order, and an /organization redirect', async () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // The menu holds the pages in the Owner order, with no Organization entry.
  const nav = /<nav id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] || '';
  assert.deepEqual(MENU_ROUTES.map((r) => r.id).slice(0, 9), ['overview', 'fleet', 'board', 'reviews', 'agents', 'projects', 'browsers', 'allocation', 'analytics']);
  assert.equal(NAV_LABEL.organization, undefined);
  assert.doesNotMatch(app, /organization: 'Organization'/);
  assert.doesNotMatch(app, /route === 'organization'/);
  // Settings goes before the Roamgate link, which keeps its new-tab attributes.
  assert.deepEqual(MENU_ROUTES.slice(-2).map((r) => r.id), ['settings', 'docs']);
  assert.match(app, /mountMenu\(\$nav\)/);
  assert.match(nav, /<a id="roamgate-link" href="\/roamgate" target="_blank" rel="noopener noreferrer" hidden>/);
  // One Agents page has a Chart and a List view. Chart is the default.
  assert.match(app, /const AGENTS_VIEW_KEY = 'herdr-boss\.agentsView'/);
  assert.match(app, /try \{ return localStorage\.getItem\(AGENTS_VIEW_KEY\) === 'list' \? 'list' : 'chart'; \} catch \{ return 'chart'; \}/);
  assert.match(app, /data-agents-view="\$\{key\}"/);
  assert.match(app, /url\.searchParams\.set\('view', next\)/);
  assert.match(css, /\.agents-view-switch\b/);
  // Motion runs only in the Chart view.
  assert.match(app, /if \(route === 'agents' && agentsViewMode\(\) === 'chart'\) orgMotion\(state\)/);
  // /organization opens the Chart view in place.
  assert.equal((await import('../public/routes.js')).resolveAlias('/organization').url, '/agents?view=chart');
});

test('the browser tab-close route closes one tab, refuses an attached tab, reports a missing tab, and refuses the preview', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const calls = [];
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: {} } } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
    closeTab: async (project, tabId, options) => {
      calls.push({ project, tabId, force: options?.force === true });
      if (tabId === 'gone') throw new Error('That tab is no longer open. Run browser tabs again.');
      if (tabId === 'held' && !options?.force) throw new Error('An agent is attached to this tab. Close it when that agent is done, or pass --force.');
      return { closed: tabId };
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/browser-sessions/tab-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const ok = await post({ project: 'alpha', tabId: 't1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { closed: 't1' });
  assert.deepEqual(calls.at(-1), { project: 'alpha', tabId: 't1', force: false }, 'the route closes one tab without force');

  const held = await post({ project: 'alpha', tabId: 'held' });
  assert.equal(held.status, 409);
  assert.match((await held.json()).error, /agent is attached/);

  const forced = await post({ project: 'alpha', tabId: 'held', force: true });
  assert.equal(forced.status, 200);
  assert.deepEqual(calls.at(-1), { project: 'alpha', tabId: 'held', force: true }, 'a confirmed close sends force');

  const gone = await post({ project: 'alpha', tabId: 'gone' });
  assert.equal(gone.status, 409);
  assert.match((await gone.json()).error, /no longer open/);

  assert.equal((await post({ project: 'other', tabId: 't1' })).status, 404, 'an unknown project is refused');
  assert.equal((await post({ project: 'alpha' })).status, 400, 'a missing tabId is refused');
  await close();
});

test('the bookmark API lists, adds, renames, moves, removes, sets the start page, and refuses a bad URL or project', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dataDir, 'browser-sessions.json'), JSON.stringify({
    alpha: { project: 'alpha', port: 9299, profile: path.join(dataDir, 'browser-profiles', 'alpha'), headless: true, windowSize: { width: 1280, height: 800 }, pid: null },
  }));
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: {} } } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/browser-sessions/bookmarks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (project = 'alpha') => fetch(`${base}/api/browser-sessions/bookmarks?project=${encodeURIComponent(project)}`);

  assert.deepEqual(await (await get()).json(), { bookmarks: [], startPage: null }, 'a fresh project has no bookmarks');
  const added = await post({ project: 'alpha', action: 'add', name: 'Docs', url: 'https://docs.example/' });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).bookmarks, [{ name: 'Docs', url: 'https://<tenant>.example/' }]);
  await post({ project: 'alpha', action: 'add', name: 'Code', url: 'https://code.example/' });
  assert.deepEqual((await (await get()).json()).bookmarks.map((b) => b.name), ['Docs', 'Code']);

  const renamed = await post({ project: 'alpha', action: 'rename', index: 0, name: 'Handbook' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).bookmarks[0].name, 'Handbook');
  const moved = await post({ project: 'alpha', action: 'move', index: 0, to: 1 });
  assert.deepEqual((await moved.json()).bookmarks.map((b) => b.name), ['Code', 'Handbook']);
  const removed = await post({ project: 'alpha', action: 'remove', index: 0 });
  assert.deepEqual((await removed.json()).bookmarks.map((b) => b.name), ['Handbook']);

  const start = await post({ project: 'alpha', action: 'start', url: 'https://start.example/' });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).startPage, 'https://<tenant>.example/');
  assert.equal((await post({ project: 'alpha', action: 'start', url: '' })).status, 200, 'an empty start page clears it');
  assert.equal((await (await get()).json()).startPage, null);

  const credential = await post({ project: 'alpha', action: 'add', name: 'Cred', url: 'https://user:secret@example.com/' });
  assert.equal(credential.status, 400);
  assert.match((await credential.json()).error, /must not hold credentials/);
  const fileUrl = await post({ project: 'alpha', action: 'add', name: 'File', url: 'file:///etc/passwd' });
  assert.equal(fileUrl.status, 400);
  assert.match((await fileUrl.json()).error, /http or https/);
  assert.equal((await post({ project: 'alpha', action: 'bogus' })).status, 400, 'an unknown action is refused');
  assert.equal((await post({ project: 'other', action: 'add', name: 'X', url: 'https://x.example/' })).status, 404, 'an unknown project is refused');
  assert.equal((await get('other')).status, 404, 'an unknown project list is refused');
  await close();
});

test('the Browsers page selects the whole address on first focus and offers one close control for each tab', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The first focus selects all text. A per-focus flag keeps the second click as a normal cursor.
  assert.match(app, /addEventListener\('focus', \(e\) => \{[\s\S]{0,400}\.browser-navigate input\[name="url"\]/);
  assert.match(app, /input\.select\(\)/);
  assert.match(app, /addEventListener\('pointerup', \(e\) => \{[\s\S]{0,400}\.browser-navigate input\[name="url"\]/);
  assert.match(app, /selectAllForFocus/);
  // Every tab row and grid tile carries a close control with the tab title in its aria-label.
  assert.match(app, /data-browser-close-tab="\$\{esc\(slug\)\}"/);
  assert.match(app, /aria-label="Close tab \$\{esc\(/);
  assert.match(app, /function browserTabRow\(slug, tab\)/);
  assert.match(app, /browser-tab-row/);
  assert.match(app, /browser-tab-pick/);
  assert.match(css, /\.browser-tab-close\b[^{]*\{[^}]*min-height: 32px/);
  assert.match(css, /@media \(max-width: 760px\) \{[^@]*\.browser-tab-close[^}]*min-height: 44px/);
  // The close asks before it removes a tab that an agent holds, and warns for the last tab.
  assert.match(app, /belongs to \$\{/);
  assert.match(app, /This is the last tab\. The browser keeps running with no page\./);
  assert.match(app, /\/api\/browser-sessions\/tab-close/);
  // The help text and the guide describe both behaviours.
  // The Browsers help is the file docs/help/browsers.md.
  assert.match(fs.readFileSync(new URL('../docs/help/browsers.md', import.meta.url), 'utf8'), /## Tabs[\s\S]*Close tab/);
  assert.match(guide, /Close tab/);
  assert.match(guide, /selects all its text/);
});

test('Allocation shows machine locks without internal process or git fields', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const allocation = /function allocationView\(s\) \{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
  const locks = /function machineLocksBlock\(s\) \{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
  assert.match(allocation, /machineLocksBlock\(s\)/);
  assert.ok(allocation.indexOf('machineLocksBlock(s)') < allocation.indexOf('leasesBlock(s)'), 'Locks appears above Resource leases');
  assert.match(locks, /<h2>Locks<\/h2>/);
  assert.match(locks, /No machine locks are held\./);
  assert.match(locks, /ageSeconds/);
  assert.match(locks, /expiresAt/);
  assert.match(locks, /until the command ends/);
  assert.match(locks, /lock\.state/);
  assert.doesNotMatch(locks, /gitCommonDir|\bpid\b/);
});

test('the Browsers page has a bookmark list, a start-page field, and phone-sized controls', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // Each card renders the section, and the page posts to the bookmark route.
  assert.match(app, /function browserBookmarkSection\(slug, b\)/);
  assert.match(app, /\$\{browserBookmarkSection\(p\.slug, b\)\}/);
  assert.match(app, /data-browser-bookmark-add="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-open="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-open-tab="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-rename="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-up="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-down="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-bookmark-remove="\$\{esc\(slug\)\}"/);
  assert.match(app, /data-browser-start-page="\$\{esc\(slug\)\}"/);
  assert.match(app, /\/api\/browser-sessions\/bookmarks/);
  // Add current page uses the selected tab, and delete confirms first.
  assert.match(app, /tabs\.find\(\(t\) => t\.id === browserSelectedTab\[slug\]\) \|\| tabs\[0\]/);
  assert.match(app, /browserConfirm\(`Delete the bookmark \$\{bookmark\.name\}\?`, 'Delete'\)/);
  // The phone layout gives the bookmark controls at least 44 px.
  assert.match(css, /\.browser-bookmarks\b/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.browser-bookmark-actions button,[^}]*min-height: 44px/);
  // Help and guide describe the feature.
  assert.match(fs.readFileSync(new URL('../docs/help/browsers.md', import.meta.url), 'utf8'), /^## Bookmarks$/m);
  assert.match(guide, /Bookmarks and the start page/);
  assert.match(guide, /Bookmarks must not hold credentials/);
});

test('Analytics and Mailbox show the scan and store limits from the state', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The two read-only lines take the fixed limits from the state.
  assert.match(app, /function denialLimitsLine\(s\)/);
  assert.match(app, /function messageLimitsLine\(s\)/);
  assert.match(app, /const l = s\?\.limits\?\.denials/);
  assert.match(app, /const l = s\?\.limits\?\.messages/);
  assert.match(app, /Scans every \$\{minutes\} min, reads at most \$\{megabytes\} MB for each scan, keeps \$\{l\.retainDays\} days, and marks a rise at \$\{l\.riseFactor\}× the 6-day mean and \$\{l\.riseMinEvents\} events\./);
  assert.match(app, /Herdr Boss keeps messages for \$\{days\} days and accepts at most \$\{l\.sendLimitPerMinute\} Owner messages a minute\./);
  // Analytics shows the denial line in the denials section, and Mailbox shows the message line in the folder pane footer.
  assert.match(app, /denialsBlock\(s\)/);
  assert.match(app, /const limits = denialLimitsLine\(s\)/);
  assert.match(app, /<aside class="mail-folder-pane" data-key="mail-rail">[^`]*<nav class="mail-folder-nav" aria-label="Mailbox folders">\$\{mailFolderLinks\(folder, counts, 'mail-folder-link'\)\}<\/nav>\$\{messageLimitsLine\(s\)\}<\/aside>/);
  // Help and the guide describe both lines.
  assert.match(app, /A read-only line shows the limits/);
  assert.match(app, /The folder pane shows the fixed limits/);
  assert.match(guide, /A read-only line with the limits/);
  assert.match(guide, /The folder pane shows a read-only line with the limits/);
});

test('Analytics shows the top ten denial counts by harness, model, and cause', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Counts by agent app and model/);
  assert.match(app, /<th>Agent app<\/th><th>Model<\/th><th>Cause<\/th><th>Count<\/th>/);
  assert.match(app, /modelRows\.slice\(0, 10\)/);
  assert.match(app, /data-label="Count" class="mono"/);
  assert.match(app, /modelMoreCount\.toLocaleString\(\)} more/);
});

test('the project page shows the memory and kit file paths with a home-relative repository path', { timeout: 20000 }, async (t) => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const projects = fs.readFileSync(new URL('../src/projects.js', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The Files panel shows the project memory, the kit file, the kit revision, and the Boss memory.
  assert.match(app, /function filesBlock\(p, kit\)/);
  assert.match(app, /filesBlock\(p, s\.kit\)/);
  assert.match(app, /docs\/orchestration\/memory\.md/);
  assert.match(app, /docs\/orchestration\/herdr-boss\.md/);
  assert.match(app, /~\/\.herdr-boss\/boss-memory\.md/);
  assert.match(app, /kitRevisionLine\(p, kit\)/);
  // The repository path comes from the project data, and the home folder shows as ~.
  assert.match(app, /p\.repo/);
  assert.match(projects, /function tildePath\(value, home\)/);
  assert.match(projects, /tildePath\(registered, home\)/);
  // Help and the guide describe the panel.
  assert.match(app, /<h3>Files<\/h3>/);
  assert.match(guide, /Boss memory file/);
  // The registered repository path reaches the state as a home-relative path.
  const { listProjects } = await import('../src/projects.js');
  const repo = path.join(homeDir, 'Projects', 'demo');
  const statusFile = path.join(dataDir, 'projects', 'demo.json');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({ project: 'Demo' }));
  fs.writeFileSync(path.join(dataDir, 'project-repos.json'), JSON.stringify([{ slug: 'demo', repo, remote: '' }]));
  t.after(() => {
    fs.rmSync(path.join(dataDir, 'projects', 'demo.json'), { force: true });
    fs.rmSync(path.join(dataDir, 'project-repos.json'), { force: true });
  });
  const row = listProjects().find((p) => p.slug === 'demo');
  assert.equal(row.repo, '~/Projects/demo');
  assert.equal(row.publishedAt, fs.statSync(statusFile).mtime.toISOString(), 'the status file modification time is the publish time');
});

test('the engine state shows the allow-listed worker config of each project and one bad config as an error', { timeout: 30000 }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-worker-config-')));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const live = path.join(root, 'live');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A good project repository with a .herdr-boss.json that also holds secret-like keys.
  const good = path.join(root, 'good');
  fs.mkdirSync(good, { recursive: true });
  execFileSync('git', ['-C', good, 'init', '-b', 'main'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(good, '.herdr-boss.json'), JSON.stringify({
    slug: 'good',
    baseBranch: 'develop',
    worktreeRoot: path.join(home, 'trees'),
    setup: 'npm ci --prefer-offline',
    imageBudget: 7,
    accessToken: 'must-not-enter-the-state',
    roamgate: { tokenFile: path.join(root, 'private-token') },
  }));

  // A bad project repository: the .herdr-boss.json is not valid JSON.
  const bad = path.join(root, 'bad');
  fs.mkdirSync(bad, { recursive: true });
  execFileSync('git', ['-C', bad, 'init', '-b', 'main'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(bad, '.herdr-boss.json'), '{ not json');

  fs.writeFileSync(path.join(data, 'project-repos.json'), JSON.stringify([
    { slug: 'good', repo: good, remote: '' },
    { slug: 'bad', repo: bad, remote: '' },
  ]));

  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const script = `
import { loadConfig } from ${JSON.stringify(configUrl)};
import { Engine } from ${JSON.stringify(engineUrl)};
console.log = () => {};
const cfg = loadConfig();
cfg.host = '127.0.0.1';
cfg.port = 0;
cfg.tickSeconds = 3600;
const collectors = {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  collectPiModels: async () => ({ models: [] }),
};
const engine = new Engine(cfg, { push: false, act: false, collectors });
const state = await engine.tick();
process.stdout.write(JSON.stringify(state.workerConfig));
`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      HOME: home,
      HERDR_BOSS_DIR: data,
      HERDR_BOSS_LIVE_DIR: live,
      HERDR_BOSS_PORT: '',
      HERDR_BOSS_PUSH: '',
    },
  });
  const workerConfig = JSON.parse(result.trim());

  assert.deepEqual(Object.keys(workerConfig).sort(), ['bad', 'good']);
  const fields = workerConfig.good.fields;
  assert.deepEqual(fields.map((field) => field.key), [
    'slug', 'baseBranch', 'worktreeRoot', 'worktreeName',
    'evidenceTiers', 'allowedModels', 'workerPanesPerTab', 'imageBudget',
    'setup', 'setupTimeoutSeconds', 'agentStartTimeoutMs', 'testThreadsFlag',
  ]);
  const field = (key) => fields.find((item) => item.key === key);
  assert.deepEqual(field('setup'), { key: 'setup', value: 'set', source: 'config' });
  assert.deepEqual(field('worktreeRoot'), { key: 'worktreeRoot', value: '~/trees', source: 'config' });
  assert.equal(field('baseBranch').value, 'develop');
  assert.equal(field('imageBudget').value, 7);
  const text = JSON.stringify(workerConfig);
  assert.equal(text.includes('must-not-enter-the-state'), false, 'a key outside the allow-list never enters the state');
  assert.equal(text.includes(path.join(root, 'private-token')), false, 'a token path never enters the state');
  assert.ok(workerConfig.bad.error.length > 0, 'a bad config reaches the state as an error');
  assert.deepEqual(workerConfig.bad.fields, []);
});

test('the project page shows the worker config panel read-only', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const guide = readUserGuide();
  assert.match(app, /function workerConfigBlock\(s, slug\)/);
  assert.match(app, /s\.workerConfig\?\.\[slug\]/);
  assert.match(app, /Change these in <span class="mono">\.herdr-boss\.json<\/span> in the repository\./);
  assert.match(app, /<h3>Worker config<\/h3>/);
  assert.match(guide, /### Worker config/);
  assert.match(guide, /Change a field in `\.herdr-boss\.json`/);
});

test('the engine checks harness readiness once at start and then every 10 minutes', { timeout: 20000 }, async () => {
  const { Engine, HARNESS_CHECK_INTERVAL_MS } = await import('../src/engine.js');
  const calls = [];
  const engine = new Engine(loadConfig(), {
    push: false,
    act: false,
    collectors: { checkHarness: () => { calls.push(Date.now()); return [{ status: 'ok', area: 'pi', item: 'Pi guard', text: 'a text with a value' }]; } },
  });
  const t0 = 100 * 60 * 60 * 1000;
  const first = engine.readHarness(t0);
  assert.equal(calls.length, 1, 'the first read runs the check');
  assert.deepEqual(first.findings, [{ status: 'ok', area: 'pi', item: 'Pi guard' }], 'the state holds status, area, and item only');
  assert.equal(first.checkedAt, new Date(t0).toISOString());
  assert.equal(engine.readHarness(t0 + HARNESS_CHECK_INTERVAL_MS - 1), first, 'a read inside the interval reuses the result');
  assert.equal(calls.length, 1);
  const second = engine.readHarness(t0 + HARNESS_CHECK_INTERVAL_MS);
  assert.equal(calls.length, 2, 'a read after the interval runs the check again');
  assert.notEqual(second, first);
  assert.equal(engine.readHarness(t0 + 2 * HARNESS_CHECK_INTERVAL_MS - 1), second);
  assert.equal(calls.length, 2);
});

test('the harness state holds status, area, and item only and carries no text or home path', { timeout: 20000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-harness-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const live = path.join(root, 'live');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    `[sandbox_workspace_write]\nwritable_roots = [\n  "${path.join(home, '.config')}",\n]\n`);
  const engineUrl = new URL('../src/engine.js', import.meta.url).href;
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const harnessUrl = new URL('../src/harness.js', import.meta.url).href;
  const script = `
import { Engine } from ${JSON.stringify(engineUrl)};
import { loadConfig } from ${JSON.stringify(configUrl)};
import { checkHarness } from ${JSON.stringify(harnessUrl)};
const findings = checkHarness({ home: process.env.HOME, dataDir: process.env.HERDR_BOSS_DIR });
console.log = () => {};
const engine = new Engine(loadConfig(), { push: false, act: false, collectors: {
  collectHerdr: async () => ({ panes: [], workspaces: [] }),
  collectMachine: async () => null,
  collectProcesses: async () => new Map(),
  collectQuotas: async () => [],
  collectWorktreeCounts: async () => ({}),
  collectCwdProcesses: async () => [],
  collectMissingWorktreeProcesses: async () => [],
  checkHarness: () => findings,
} });
const state = await engine.tick();
process.stdout.write(JSON.stringify({ harness: state.harness, findings }));
`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: live, NODE_TEST_CONTEXT: '1' },
  });
  const { harness, findings } = JSON.parse(result.trim());
  assert.ok(findings.length > 0);
  assert.ok(findings.some((finding) => finding.text.includes(home)), 'the fixture reports a home path in a finding text');
  assert.deepEqual(Object.keys(harness).sort(), ['checkedAt', 'findings']);
  assert.ok(harness.findings.length > 0);
  for (const finding of harness.findings) assert.deepEqual(Object.keys(finding).sort(), ['area', 'item', 'status']);
  const serialized = JSON.stringify(harness);
  assert.equal(serialized.includes(home), false, 'the home path never enters the harness state');
  for (const finding of findings) assert.equal(serialized.includes(finding.text), false, 'a finding text never enters the harness state');
});

test('Settings shows a read-only harness readiness table with the fixed sync line', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  assert.match(app, /<h2>Agent app readiness\$\{helpButton\('harness\.readiness'\)\}<\/h2>/);
  assert.match(app, /s\?\.harness\?\.findings/);
  assert.doesNotMatch(app, /Run herdr-boss harness sync to see the changes to make\./, 'the readiness group text in the schema holds the sync hint');
  assert.match(app, /<th scope="col">Status<\/th><th scope="col">Area<\/th><th scope="col">Item<\/th>/);
  assert.match(css, /\.harness-readiness-panel\b/);
  assert.match(css, /\.harness-readiness-bad\b/);
  assert.match(app, /<h3>Agent app readiness<\/h3>/);
  assert.match(guide, /Harness readiness/);
  assert.match(guide, /Run `herdr-boss harness sync` to see the changes to make/);
});

test('the resource pool API creates, updates, and removes pools safely', { timeout: 20000 }, async (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const configFile = path.join(dataDir, 'config.json');
  const original = {
    host: '127.0.0.1', port: 0, tickSeconds: 3600,
    resourcePools: [{ name: 'serve-ports', items: ['47100'], split: {}, env: 'HERDR_SERVE_PORT', ttlMinutes: 120, check: null, graceMinutes: 10 }],
    unrelatedSetting: { keep: true },
  };
  fs.writeFileSync(configFile, `${JSON.stringify(original)}\n`);
  fs.chmodSync(configFile, 0o640);
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  let poolEngine;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: (engineCfg, options) => {
      poolEngine = new Engine(engineCfg, { ...options, act: false, push: false });
      poolEngine.state = { resourceLeases: { pools: engineCfg.resourcePools, errors: [], leases: [] } };
      poolEngine.tick = async () => poolEngine.state;
      poolEngine.log = () => {};
      return poolEngine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/pools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pool = (name, items) => ({ name, items, split: {}, env: 'HERDR_OTHER_PORT', ttlMinutes: 60, check: null, graceMinutes: 5 });
  const mode = () => fs.statSync(configFile).mode & 0o7777;

  const remote = await rawRequest(base, 'PUT', '/api/pools', {
    headers: { host: 'mac.tail0000.ts.net', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', pool: pool('serve-ports-2', ['48000']) }),
  });
  assert.equal(remote.status, 401, 'a remote write needs dashboard authorization');

  const created = await put({ action: 'create', pool: pool('serve-ports-2', ['48000']) });
  assert.equal(created.status, 200, await created.text());
  assert.deepEqual(poolEngine.cfg.resourcePools.find((item) => item.name === 'serve-ports-2').items, ['48000'], 'the engine applies the pool at once');
  assert.ok(poolEngine.state.resourceLeases.pools.some((item) => item.name === 'serve-ports-2'));
  let saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.unrelatedSetting, original.unrelatedSetting, 'the writer keeps every other config key');
  assert.equal(mode(), 0o640, 'the writer keeps the config file mode');
  assert.deepEqual(saved.resourcePools.map((item) => item.name), ['serve-ports', 'serve-ports-2']);

  const updated = await put({ action: 'update', pool: pool('serve-ports-2', ['48000', '48001']) });
  assert.equal(updated.status, 200, await updated.text());
  assert.deepEqual(poolEngine.cfg.resourcePools.find((item) => item.name === 'serve-ports-2').items, ['48000', '48001']);

  const leaseFile = path.join(dataDir, 'leases.json');
  fs.writeFileSync(leaseFile, JSON.stringify({ leases: [{ pool: 'serve-ports-2', item: '48000', project: 'alpha', pane: 'wA:p2', worker: 'build' }] }));
  const heldUpdate = await put({ action: 'update', pool: pool('serve-ports-2', ['48001']) });
  assert.equal(heldUpdate.status, 409, 'an update cannot drop a held item');
  const heldUpdateBody = await heldUpdate.json();
  assert.equal(heldUpdateBody.holder.project, 'alpha');
  assert.equal(heldUpdateBody.holder.pane, 'wA:p2');
  assert.match(heldUpdateBody.error, /alpha/);
  const heldRemove = await put({ action: 'remove', pool: { name: 'serve-ports-2' } });
  assert.equal(heldRemove.status, 409, 'a pool with a held item cannot be removed');
  assert.equal((await heldRemove.json()).holder.item, '48000');

  const builtIn = await put({ action: 'create', pool: pool('project-browsers', ['48002']) });
  assert.equal(builtIn.status, 400, 'the built-in pool name is reserved');
  const protectedRange = await put({ action: 'create', pool: pool('unsafe-ports', ['9225']) });
  assert.equal(protectedRange.status, 400, 'project browser ports are reserved');
  const protectedRangeAsRange = await put({ action: 'create', pool: { ...pool('unsafe-range', []), items: undefined, range: '9298-9299' } });
  assert.equal(protectedRangeAsRange.status, 400, 'ranges cannot include project browser ports');

  fs.writeFileSync(leaseFile, JSON.stringify({ leases: [] }));
  const removed = await put({ action: 'remove', pool: { name: 'serve-ports-2' } });
  assert.equal(removed.status, 200, await removed.text());
  assert.equal(poolEngine.cfg.resourcePools.some((item) => item.name === 'serve-ports-2'), false, 'the engine applies pool removal at once');
  saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.resourcePools.map((item) => item.name), ['serve-ports']);
  assert.deepEqual(saved.unrelatedSetting, original.unrelatedSetting);
  assert.equal(mode(), 0o640);
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.startsWith('config.json.') && name.endsWith('.tmp')), [], 'atomic writes leave no temporary file');
});


test('Allocation manages config pools and documents the safe limits', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  assert.match(app, /data-pool-add/);
  assert.match(app, /const controls = pool\.builtIn \? '' :/);
  assert.match(app, /data-pool-edit=/);
  assert.match(app, /data-pool-remove=/);
  assert.match(app, /name="items"/);
  assert.match(app, /name="split"/);
  assert.match(app, /name="env"/);
  assert.match(app, /name="ttlMinutes"/);
  assert.match(app, /name="check"/);
  assert.match(app, /name="graceMinutes"/);
  assert.match(app, /Remove the resource pool \$\{name\}\?/);
  assert.match(app, /<h3>Manage pools<\/h3>/);
  assert.match(css, /\.resource-pool-fields/);
  assert.match(guide, /Select \*\*Add pool\*\*/);
  assert.match(guide, /A held item blocks removal and any update that drops it\./);
  assert.match(guide, /The read-only preview refuses pool changes\./);
});

test('the Chat page has a route, a menu position, a composer key rule, a before page, and a message event handler', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The page and the route. Chat goes right after Mailbox.
  assert.match(app, /chat: \['Chat'/);
  assert.equal(NAV_LABEL.chat, 'Chat');
  assert.equal(matchRoute('/chat').id, 'chat');
  assert.match(app, /route === 'chat' \? chatView\(state\)/);
  const nav = /<nav id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] || '';
  assert.ok(!MENU_ROUTES.some((r) => r.id === 'chat'), 'the menu has no Chat entry');
  assert.doesNotMatch(nav, /href="\/chat"/);
  assert.match(html, /<a class="top-icon" data-top-icon="chat" data-empty="true" href="\/chat" aria-label="Chat">/);
  // The list reads the chat API and shows a badge with the total unread count.
  assert.match(app, /readApiUrl\('\/api\/chats'/);
  // Enter sends. Shift+Enter makes a new line.
  assert.match(app, /if \(e\.key !== 'Enter' \|\| e\.shiftKey\) return;/);
  assert.match(app, /async function chatSend\(retry = null\)/);
  assert.match(app, /data-chat-draft/);
  assert.match(app, /const CHAT_MAX_LINES = 6/);
  // A scroll to the top reads an older page with before, and keeps the scroll position.
  assert.match(app, /const before = oldest \? `&before=\$\{encodeURIComponent\(oldest\.id\)\}` : '';/);
  assert.match(app, /if \(scroller\.scrollTop < 32 && chat\.more && !chat\.moreLoading\) loadChatOlder\(\);/);
  assert.match(app, /chat\.keepScroll = \{ top: scroller\.scrollTop, height: scroller\.scrollHeight \};/);
  // The app passes message events from the client store to Chat.
  assert.match(app, /clientStore\.subscribeEvent\('message', onChatMessage\)/);
  assert.match(app, /function onChatMessage\(event\)/);
  assert.match(app, /chat\.unseen \+= 1;/);
  assert.match(app, /data-chat-jump/);
  // Opening a chat marks it read. A send is the only write path, and a refused send offers a retry.
  assert.match(app, /fetch\(`\/api\/chats\/\$\{encodeURIComponent\(thread\)\}\/read`, \{ method: 'POST' \}\)/);
  assert.match(app, /postJson\('\/api\/messages', \{ thread, kind: 'message', text, \.\.\.\(attached\.ids\.length \? \{ attachments: attached\.ids \} : \{\}\) \}\);/);
  assert.match(app, /data-chat-retry/);
  assert.match(css, /\.chat-layout\b/);
  assert.match(css, /\.chat-bubble\.from-owner\b/);
  assert.match(css, /\.chat-jump\b/);
  assert.match(guide, /## Chat page/);
});

test('the Chat page shows the Mailbox action cards, uses the Mailbox write route, and moves the focus', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // A card is a normal bubble. Only a real choice shows one.
  assert.match(app, /const isCard = !owner && !record\.closedAt && \(record\.action === 'answer' \|\| options\.length > 0\);/);
  assert.match(app, /const text = isCard \? chatQuestionText\(record\.text\) : record\.text;/);
  // A decide without a choice list is not a real choice. A card is the same bubble, with no frame.
  assert.match(app, /function chatQuestionText\(text\)/);
  assert.match(app, /const at = body\.search\(\/\^#\{1,6\}/);
  // Card one: approve, accept, deny, and postpone.
  assert.match(app, /function chatApproveOptions\(\)/);
  assert.match(app, /\{ value: 'Approved\.', label: 'Approve' \}/);
  assert.match(app, /\{ value: 'Rejected\.', label: 'Reject', deny: true \}/);
  assert.match(app, /\{ value: 'later', label: 'Later', later: true \}/);
  // Card two: decide, one small button for each choice.
  assert.match(app, /return chatParseChoices\(record\.text\)\.map\(\(choice\) => \(\{ value: `Choice: \$\{choice\}`, label: choice \}\)\);/);
  assert.match(app, /data-chat-option="\$\{id\}" data-chat-value="\$\{esc\(option\.value\)\}"\${off}>/);
  // Card three: answer, a one-line text field and a small Send button.
  assert.match(app, /data-chat-card-draft="\$\{id\}" type="text"/);
  assert.match(app, /<input id="chat-card-\$\{id\}" data-chat-card-draft="\$\{id\}" type="text" maxlength="1700" value="\$\{esc\(chat\.drafts\[record\.id\] \|\| ''\)\}" placeholder="Answer…">/);
  assert.match(app, /<button type="submit"\$\{off}>Send<\/button><\/form>/);
  // Later only collapses the card. It writes nothing and the Mailbox item stays open.
  assert.match(app, /if \(option\.dataset\.chatValue === 'later'\) \{/);
  assert.match(app, /chat\.results\[item\.id\] = 'Later\. The item stays open in the Mailbox\.';/);
  // The choices use the same rule as parseChoices in src/messages.js.
  assert.match(app, /function chatParseChoices\(text\)/);
  assert.match(app, /const start = lines\.findIndex\(\(line\) => \/\^#\{1,6\}/);
  // One write path. The card sends the same request the Mailbox sends, with replyTo set to the item.
  assert.match(app, /async function chatSendAction\(record, text\)/);
  assert.match(app, /await postJson\('\/api\/messages', \{ thread: record\.thread, kind: 'message', text, replyTo: record\.id \}\);/);
  assert.match(app, /chat\.results\[record\.id\] = `\$\{chatResultLabel\(text\)\} \$\{clock\(new Date\(\)\.toISOString\(\)\)\}`;/);
  assert.match(app, /await loadChatThread\(record\.thread\);/);
  // The log is a live region, and every bubble has a name with the sender, the time, the text, and the state.
  assert.match(app, /<ol class="chat-bubbles" role="log" aria-live="polite" aria-label="Messages in the \$\{esc\(title\)\} chat">/);
  assert.match(app, /const label = esc\(chatBubbleLabel\(sender, \{ \.\.\.record, text \}, state\)\);/);
  assert.match(app, /aria-label="\$\{label\}"/);
  assert.match(app, /function chatBubbleLabel\(sender, record, state\)/);
  // Opening a chat does not focus the composer, so the keyboard stays closed. The focus moves to the list row on Back.
  assert.doesNotMatch(app, /chat\.focus = 'composer'/);
  assert.match(app, /function closeChat\(\) \{[\s\S]*?chat\.focus = 'row';/);
  assert.match(app, /if \(chat\.focus === 'row' && chat\.backThread\) \$app\.querySelector\(`\[data-chat-open="\$\{CSS\.escape\(chat\.backThread\)\}"\]`\)\?\.focus\(\);/);
  // The keyboard: arrow keys move through the list, Enter opens a row, and Escape goes back.
  assert.match(app, /<button class="chat-row" type="button" data-chat-open=/);
  assert.match(app, /const step = e\.key === 'ArrowDown' \? 1 : e\.key === 'ArrowUp' \? -1 : e\.key === 'Home' \? -index : e\.key === 'End' \? rows\.length - 1 - index : 0;/);
  assert.match(app, /if \(e\.key === 'Escape' && chat\.thread\) \{ closeChat\(\); return; \}/);
  // The cards follow the dashboard tokens, and the small text keeps its contrast in both themes.
  assert.match(css, /\.chat-card-options\b/);
  assert.match(css, /\.chat-card-answer\b/);
  assert.match(css, /\.chat-card-deny\b/);
  assert.match(css, /\.chat-card-later\b/);
  assert.match(css, /\.chat-card-result\b/);
  assert.match(css, /#app \.chat-card-options button \{ min-height: 32px;/);
  assert.match(css, /min-height: 44px/);
  assert.match(app, /<h3>Action cards<\/h3>/);
  assert.match(guide, /### Action cards/);
  assert.match(guide, /The card uses the same send route as the Mailbox\./);
});

test('the top bar shows three icons with a count, and a faded icon when it has nothing to show', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const icons = /<div class="top-icons"[\s\S]*?<\/div>/.exec(html)?.[0] || '';
  // Three inline SVG icons: chat, mail, and needs action. Each has a badge and a link.
  for (const [name, href] of [['chat', '/chat'], ['mail', '/mailbox?folder=updates'], ['needs-action', '/mailbox?folder=needs-you']]) {
    assert.match(icons, new RegExp(`data-top-icon="${name}" data-empty="true" href="${href.replace('?', '\\?').replace('=', '=')}"`), `${name} links to its page`);
    assert.match(icons, new RegExp(`data-top-badge="${name}" hidden`));
    assert.match(icons, new RegExp(`<svg viewBox="0 0 24 24" aria-hidden="true">[\\s\\S]*?</svg>`), `${name} holds an inline SVG`);
  }
  assert.equal([...icons.matchAll(/data-top-icon="([^"]+)"/g)].map((m) => m[1]).join(','), 'chat,mail,needs-action');
  // The counts come from the state. An empty icon is faded and has no badge.
  assert.match(app, /chat: s\?\.mailbox\?\.chatUnread \?\? 0,/);
  assert.match(app, /mail: s\?\.mailbox\?\.mailUnread \?\? 0,/);
  assert.match(app, /'needs-action': s\?\.mailbox\?\.needsAction \?\? s\?\.mailbox\?\.open \?\? 0,/);
  assert.match(app, /icon\.dataset\.empty = count \? 'false' : 'true';/);
  assert.match(app, /icon\.setAttribute\('aria-label', count \? TOP_ICON_COUNT_LABEL\[name\]\(count\) : TOP_ICON_NAMES\[name\]\);/);
  assert.match(app, /badge\.hidden = !count;/);
  assert.match(css, /\.top-icon\[data-empty="true"\] \{ opacity: 0\.35; \}/);
  assert.match(css, /\.top-icon-needs .top-icon-badge \{ background: var\(--warn\);/);
  // The icons are on the desktop and on the phone.
  assert.doesNotMatch(css, /\.top-icons \{ display: none/);
  assert.match(css, /\.top-icon \{ width: 44px; height: 44px; \}/);
});

test('the Chat page is compact: no page heading, slim bubbles, a round send button, and a dense list', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // No big heading above the conversation. The header holds the avatar and the chat name.
  assert.doesNotMatch(app, /<h1>Chat<\/h1>/);
  assert.match(app, /\$\{avatarSlot\(chat\.thread, \{ title: avatarTitle\(chat\.thread, title\), size: 28 \}\)\}<\$\{titleTag\}>\$\{esc\(title\)\}<\/\$\{titleTag\}>/, 'the chat name is the h1 on a phone and an h2 on a desktop');
  // A slim bubble. It has no card border and the time is 11 px.
  assert.match(css, /\.chat-bubble \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 1px; max-width: 75%; padding: 6px 8px;/);
  assert.doesNotMatch(css, /\.chat-bubble \{[^}]*border: 1px solid/);
  assert.match(css, /\.chat-bubble-time \{ font-size: 11px; \}/);
  // The composer is one line that grows to 6 lines. The send button is a round 36 px button.
  assert.match(css, /\.chat-composer textarea \{[^}]*max-height: calc\(1\.4em \* 6\);/);
  assert.match(css, /\.chat-send \{ flex: 0 0 auto; display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border-radius: 50%;/);
  assert.match(css, /\.chat-send \{ width: 44px; height: 44px; \}/);
  // A dense list: each row shows the title and the time on the first line, then the last message and the unread badge.
  assert.match(app, /<span class="chat-line-one"><span class="chat-name">\$\{esc\(item\.title\)\}<\/span>\$\{time \? `<span class="chat-time">\$\{esc\(time\)\}<\/span>` : ''\}<\/span><span class="chat-line-two"><span class="chat-preview">\$\{esc\(preview\)\}<\/span>\$\{badge\}<\/span>/);
  assert.match(css, /button\.chat-row \{[^}]*min-height: 72px;/);
  // A mail report is one short line in the chat.
  assert.match(app, /if \(record\.channel === 'mail' && !releaseApproval\) \{[\s\S]*?Report: \$\{esc\(record\.title \|\| 'Report'\)\}[\s\S]*?Open in Mailbox/);
  assert.match(css, /\.chat-report \{/);
});

// The avatar block of public/app.js runs in the browser. The test reads the block and calls the functions.
function avatarBlock() {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const block = /\/\/ ---------- Avatars[^\n]*----------\n([\s\S]*?)\/\/ ---------- End avatars ----------/.exec(source)?.[1];
  assert.ok(block, 'public/app.js holds the avatar functions between the two avatar markers');
  return new Function(`${block}
return { AVATAR_PALETTE, AVATAR_SIZES, avatarSvg, avatarInitials, avatarColor, avatarTextColor, avatarContrast, avatarTitle };`)();
}

test('an avatar gives each slug a stable color, two initials from the title, and the Boss a fixed glyph', () => {
  const { AVATAR_PALETTE, AVATAR_SIZES, avatarSvg, avatarInitials, avatarColor, avatarTextColor, avatarContrast } = avatarBlock();
  // A fixed palette of 12 hues. No pure white and no pure black circle.
  assert.equal(AVATAR_PALETTE.length, 12);
  assert.equal(new Set(AVATAR_PALETTE).size, 12, 'every hue in the palette is used once');
  assert.equal(AVATAR_PALETTE.includes('#ffffff'), false);
  assert.equal(AVATAR_PALETTE.includes('#000000'), false);
  // The same slug always gets the same color. Two slugs do not share one by accident.
  assert.equal(avatarColor('herdrboss'), avatarColor('herdrboss'));
  assert.equal(avatarSvg('herdrboss', { title: 'HerdrBoss', size: 28 }), avatarSvg('herdrboss', { title: 'HerdrBoss', size: 28 }));
  assert.notEqual(avatarColor('herdrboss'), avatarColor('alphabeta'));
  assert.ok(AVATAR_PALETTE.includes(avatarColor('herdrboss')), 'the color comes from the palette');
  // The initials come from the title.
  assert.equal(avatarInitials('HerdrBoss'), 'HB');
  assert.equal(avatarInitials('AlphaBeta'), 'AB');
  assert.equal(avatarInitials('qlik-ai'), 'QA');
  assert.equal(avatarInitials('A'), 'A');
  assert.equal(avatarInitials(''), '?');
  assert.match(avatarSvg('alphabeta', { title: 'AlphaBeta', size: 28 }), />AB</);
  // The initials take the color of the best contrast on the circle, and reach WCAG AA.
  for (const color of AVATAR_PALETTE) {
    const text = avatarTextColor(color);
    assert.ok(['#ffffff', '#14181d'].includes(text), `${color} uses white or dark initials`);
    assert.ok(avatarContrast(color, text) >= 4.5, `${color} with ${text} reaches the AA contrast of 4.5`);
  }
  // The three sizes.
  assert.deepEqual(AVATAR_SIZES, [20, 28, 36]);
  for (const size of AVATAR_SIZES) {
    assert.match(avatarSvg('alpha', { title: 'Alpha', size }), new RegExp(`width="${size}" height="${size}"`));
    assert.match(avatarSvg('boss', { title: 'Boss', size }), new RegExp(`width="${size}" height="${size}"`));
  }
  assert.match(avatarSvg('alpha', { title: 'Alpha', size: 30 }), /width="28" height="28"/, 'an unknown size falls back to 28');
  // The avatar is decoration. The name stays as text next to it.
  assert.match(avatarSvg('alpha', { title: 'Alpha', size: 28 }), /aria-hidden="true"/);
  // The Boss gets a fixed crown in the accent color, and no initials.
  const boss = avatarSvg('boss', { title: 'Boss', size: 28 });
  assert.match(boss, /fill="var\(--accent\)"/);
  assert.doesNotMatch(boss, /<text/);
  assert.doesNotMatch(boss, /[A-Z]{2}<\/text>/);
});

test('the avatar routes store an image with mode 0600, and read and remove it again', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: { projects: { alpha: { slug: 'alpha', label: 'Alpha', orch: { pane: 'w1' } } } } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const avatars = path.join(dataDir, 'avatars');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = (slug, body, type) => fetch(`${base}/api/avatars/${slug}`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body });

  // A good PNG for the Boss is stored, read back, and removed.
  const stored = await upload('boss', png, 'image/png');
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).ok, true);
  const file = path.join(avatars, 'boss.png');
  assert.equal(fs.readFileSync(file).equals(png), true, 'the service stores the bytes it received');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the stored image has mode 0600');
  const read = await fetch(`${base}/api/avatars/boss`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await read.arrayBuffer()).equals(png), true);

  // A project slug stores next to the Boss.
  assert.equal((await upload('alpha', png, 'image/png')).status, 200);
  assert.equal(fs.existsSync(path.join(avatars, 'alpha.png')), true);

  // An unknown slug and an unsafe name are refused.
  assert.equal((await upload('nope', png, 'image/png')).status, 404);
  assert.equal((await upload('..%2Fescape', png, 'image/png')).status, 400, 'an unsafe slug is refused');
  assert.equal(fs.existsSync(path.join(dataDir, 'escape.png')), false);

  // An SVG is refused. Its content type and its bytes.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await upload('boss', svg, 'image/svg+xml')).status, 415);
  assert.equal((await upload('boss', svg, 'image/png')).status, 415, 'the magic bytes decide, not the declared type');
  // A file over 512 KB is refused.
  const big = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
  const tooBig = await upload('boss', big, 'image/png');
  assert.equal(tooBig.status, 413);
  assert.equal(fs.readFileSync(file).equals(png), true, 'a refused upload keeps the stored image');

  // A good JPEG and WebP pass, and each slug holds one file.
  assert.equal((await upload('boss', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]), 'image/jpeg')).status, 200);
  assert.equal(fs.existsSync(path.join(avatars, 'boss.jpg')), true);
  assert.equal(fs.existsSync(path.join(avatars, 'boss.png')), false, 'a new image replaces the old file of that slug');
  assert.equal(fs.statSync(path.join(avatars, 'boss.jpg')).mode & 0o777, 0o600);

  // Remove puts the generated avatar back.
  assert.equal((await fetch(`${base}/api/avatars/boss`, { method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(path.join(avatars, 'boss.jpg')), false);
  assert.equal((await fetch(`${base}/api/avatars/boss`)).status, 404);
  assert.equal((await fetch(`${base}/api/avatars/boss`, { method: 'DELETE' })).status, 404);
  assert.equal(fs.existsSync(path.join(avatars, 'alpha.png')), true, 'one slug does not remove another');
});

test('one title gives one avatar, and the Chat, the Mailbox, the Agents cards, and Settings agree', () => {
  const { avatarSvg, avatarInitials, avatarTitle } = avatarBlock();
  const projects = { herdrboss: { slug: 'herdrboss', label: 'HerdrBoss' }, alphabeta: { slug: 'alphabeta', label: 'AlphaBeta' } };
  // The project display name is the one title. The chat title and then the slug are the fallbacks.
  assert.equal(avatarTitle('herdrboss', 'herdrboss', projects), 'HerdrBoss');
  assert.equal(avatarTitle('alphabeta', 'alphabeta', projects), 'AlphaBeta');
  assert.equal(avatarTitle('boss', 'Boss', projects), 'Boss');
  assert.equal(avatarTitle('noslug', 'Chat title', projects), 'Chat title');
  assert.equal(avatarTitle('noslug', '', projects), 'noslug');
  // A chat that knows only the slug and a Settings row that knows the label show the same avatar.
  const fromChat = avatarSvg('herdrboss', { title: avatarTitle('herdrboss', 'herdrboss', projects), size: 28 });
  const fromSettings = avatarSvg('herdrboss', { title: avatarTitle('herdrboss', 'HerdrBoss', projects), size: 28 });
  assert.equal(fromChat, fromSettings, 'the Chat and Settings show the same avatar for one project');
  assert.match(fromChat, />HB</, 'the project display name gives the initials, not the slug');
  assert.notEqual(avatarInitials('herdrboss'), 'HB');

  // Every page passes the title through the one source. A page with its own title fails here.
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const slots = [...app.matchAll(/avatarSlot\(([^,]+), \{ title: avatarTitle\(/g)].map((match) => match[1]);
  assert.equal(slots.length, 8, 'eight avatar slots: Settings row, Mailbox row, Mailbox thread header, Chat list row, Chat header, chat bubble, Agents card, and review pack row');
  for (const slug of slots) assert.doesNotMatch(slug, /\.title$|\btitle\b/, 'no page passes its own title to an avatar slot');
});

test('the pages show the avatar, the Settings page manages the image, and the composer hides its scroll bar', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const guide = readUserGuide();
  // The Chat list, the Chat header, the first bubble of a run, the Mailbox rows, and the Agents chart cards.
  assert.match(app, /\$\{avatarSlot\(item\.thread, \{ title: avatarTitle\(item\.thread, item\.title\), size: 36 \}\)\}/);
  assert.match(app, /\$\{avatarSlot\(chat\.thread, \{ title: avatarTitle\(chat\.thread, title\), size: 28 \}\)\}/);
  assert.match(app, /\$\{avatarSlot\(record\.thread, \{ title: avatarTitle\(record\.thread\), size: 20 \}\)\}/);
  assert.match(app, /avatar: \(thread\) => avatarSlot\(thread, \{ title: avatarTitle\(thread\), size: 36 \}\)/);
  assert.match(app, /\$\{avatarSlot\(selected\.thread, \{ title: avatarTitle\(selected\.thread\), size: 28 \}\)\}/);
  assert.match(app, /avatarSlot\(avatar\.slug, \{ title: avatarTitle\(avatar\.slug, avatar\.title\), size: 36 \}\)/);
  assert.match(app, /\$\{avatarSlot\(row\.slug, \{ title: avatarTitle\(row\.slug, row\.title\), size: 28 \}\)\}/);
  // The image of the Owner replaces the generated avatar when it exists.
  assert.match(app, /src="\/api\/avatars\/\$\{encodeURIComponent\(slug\)\}"/);
  assert.match(app, /document\.addEventListener\('load', \(e\) => avatarImageLoaded\(e\.target\), true\);/);
  assert.match(app, /document\.addEventListener\('error', \(e\) => avatarImageFailed\(e\.target\), true\);/);
  // The Settings page has one Avatars section with a row for the Boss and for each project.
  assert.match(app, /<h2>Avatars\$\{helpButton\('avatar\.upload'\)\}<\/h2>/);
  assert.match(app, /\{ slug: 'boss', title: 'Boss' \}, \.\.\.Object\.entries\(s\.control\?\.projects \|\| \{\}\)/);
  assert.match(app, /data-avatar-upload="\$\{esc\(row\.slug\)\}"/);
  assert.match(app, /data-avatar-reset="\$\{esc\(row\.slug\)\}"/);
  assert.match(app, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(app, /const AVATAR_MAX_BYTES = 512 \* 1024;/);
  // The composer hides the scroll bar until the text is longer than six lines. The limit is the 6-line height of the text area.
  assert.match(app, /const limit = Math\.round\(line\) \* CHAT_MAX_LINES;/);
  assert.match(app, /field\.classList\.toggle\('chat-overflow', field\.scrollHeight > limit\);/);
  assert.match(css, /\.chat-composer textarea \{[^}]*overflow-y: hidden;/);
  assert.match(css, /\.chat-composer textarea\.chat-overflow \{ overflow-y: auto;/);
  // Only the class turns the scroll bar on. No other rule sets the overflow of the text area.
  assert.equal((css.match(/\.chat-composer textarea[^{]*\{[^}]*overflow/g) || []).length, 2, 'two rules set the overflow: the base rule and the class rule');
  // The page help and the guide describe the avatars and the scroll bar.
  const chatHelp = /chat: \['Chat', `([\s\S]*?)`\],/.exec(app)?.[1] || '';
  assert.match(chatHelp, /avatar/i);
  const settingsHelp = /settings: \['Settings', `([\s\S]*?)`\],\s+agents:/.exec(app)?.[1] || '';
  assert.match(settingsHelp, /<h3>Avatars<\/h3>/);
  assert.match(guide, /### Avatars/);
  assert.match(guide, /The composer hides the scroll bar until the text is longer than 6 lines\./);
  assert.match(guide, /## Avatars/);
});

test('GET /api/machine-hours summarizes the sample file, limits days, and works in the read-only preview', { timeout: 20000 }, async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      const engine = new EventEmitter();
      engine.act = actions.act;
      engine.push = actions.push;
      engine.state = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  const samplesFile = path.join(dataDir, 'machine-samples.jsonl');
  t.after(async () => {
    await close();
    fs.rmSync(samplesFile, { force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const empty = await fetch(`${base}/api/machine-hours`);
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.days, 14);
  assert.equal(emptyBody.hours.length, 24);
  assert.equal(emptyBody.totals.samples, 0);
  assert.equal(emptyBody.coverage, 0);

  const at = new Date(Date.now() - 3600000);
  at.setMinutes(0, 0, 0);
  const line = { at: at.toISOString(), l1: 1, l5: 40, l15: 1, cpus: 10, cpu: 10, memFree: 30, memGB: 24, swapMB: 100, swapTotalMB: 4096, holders: ['suite'], waiters: 1, waiterKinds: ['push'] };
  const old = { ...line, at: new Date(Date.now() - 5 * 86400000).toISOString() };
  fs.writeFileSync(samplesFile, `${JSON.stringify(line)}\nbroken line\n${JSON.stringify(old)}\n`);

  // The result is cached for 60 seconds: the new file is not read yet.
  assert.equal((await (await fetch(`${base}/api/machine-hours`)).json()).totals.samples, 0);
  const realNow = Date.now();
  t.mock.method(Date, 'now', () => realNow + 61000);

  const body = await (await fetch(`${base}/api/machine-hours?days=14`)).json();
  assert.equal(body.totals.samples, 2);
  assert.equal(body.daysWithData, 2);
  fs.appendFileSync(samplesFile, `${JSON.stringify(line)}\n`);
  assert.equal((await (await fetch(`${base}/api/machine-hours?days=14`)).json()).totals.samples, 2, 'cached');
  assert.equal(body.hours[at.getHours()].overloadMin, 1);
  assert.equal(body.hours[at.getHours()].idleWaitMin, 1);
  assert.deepEqual(body.hours[at.getHours()].holderKinds, { suite: 1 });
  assert.doesNotMatch(JSON.stringify(body), /\/Users|\/tmp|herdr-preview/);

  assert.equal((await (await fetch(`${base}/api/machine-hours?days=1`)).json()).totals.samples, 1);
  assert.equal((await (await fetch(`${base}/api/machine-hours?days=99`)).json()).days, 14);
  assert.equal((await (await fetch(`${base}/api/machine-hours?days=0`)).json()).days, 14);
  assert.equal((await (await fetch(`${base}/api/machine-hours?days=abc`)).json()).days, 14);

  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}/api/machine-hours`, { method, body: method === 'DELETE' ? undefined : '{}' })).status, 403, method);
  }
});

test('GET /api/analytics returns notice counts and the machine timeline, cached for 60 seconds', { timeout: 20000 }, async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      const engine = new EventEmitter();
      engine.act = actions.act;
      engine.push = actions.push;
      engine.state = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const hadEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile) : null;
  t.after(async () => {
    await close();
    if (hadEvents) fs.writeFileSync(eventsFile, hadEvents);
    else fs.rmSync(eventsFile, { force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(eventsFile, `${JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), type: 'notify', pane: 'w1:p1', text: 'Client Name notice' })}\n`);
  const first = await fetch(`${base}/api/analytics`);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.notices.total, 1);
  assert.equal(body.notices.days.length, 7);
  assert.equal(body.timeline.points.length, 144);
  assert.deepEqual(body.actionsMinutes, { available: false, weeks: [], repos: [], updatedAt: null });
  assert.doesNotMatch(JSON.stringify(body), /Client Name|\/Users|\/tmp/);
  fs.appendFileSync(eventsFile, `${JSON.stringify({ at: new Date().toISOString(), type: 'notify', pane: 'w1:p1' })}\n`);
  assert.equal((await (await fetch(`${base}/api/analytics`)).json()).notices.total, 1, 'cached');
  const realNow = Date.now();
  t.mock.method(Date, 'now', () => realNow + 61000);
  assert.equal((await (await fetch(`${base}/api/analytics`)).json()).notices.total, 2);
  assert.equal((await fetch(`${base}/api/analytics`, { method: 'POST', body: '{}' })).status, 403);
});

test('GET /api/analytics returns memoryByClass from the memory samples in the data directory', { timeout: 20000 }, async (t) => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    readOnlyPreview: true,
    createEngine: (_config, actions) => {
      const engine = new EventEmitter();
      engine.act = actions.act;
      engine.push = actions.push;
      engine.state = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  const file = path.join(dataDir, 'memory-samples.jsonl');
  const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(async () => {
    await close();
    if (had) fs.writeFileSync(file, had);
    else fs.rmSync(file, { force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const mb = { claude: 5000, codex: 1200, browsers: 8000, mcp: 600, vitest: 300, other: 2400 };
  fs.writeFileSync(file, `${JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), mb })}\n`);
  const body = await (await fetch(`${base}/api/analytics`)).json();
  assert.equal(body.memoryByClass.bucketMin, 60);
  assert.equal(body.memoryByClass.hours, 24);
  assert.deepEqual(body.memoryByClass.classes, ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other']);
  assert.equal(body.memoryByClass.points.filter((p) => p.samples).length, 1);
  assert.deepEqual(body.memoryByClass.latest.mb, mb);
  assert.deepEqual(body.memoryByClass.peak, mb);
});

test('the Analytics page serves and its script fetches and draws the machine hours', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /machineHours: \{ url: '\/api\/machine-hours', intervalMs: 30000 \}/);
  assert.ok(PAGE_READS.analytics.includes('machineHours'), 'Analytics reads the machine-hours resource');
  assert.match(app, /clientStore\.subscribe\('machineHours', \(value\) => \{/);
  assert.match(app, /if \(value\?\.hours\) machineHours = value;/);
  assert.match(app, /function machineHoursBlock/);
  assert.match(app, /<details class="mh-details" data-mh-detail/);
  assert.match(app, /machineHoursOpen = e\.target\.open/);
  assert.match(app, /addEventListener\('pointerout', hideMachineTip\)/);
  assert.match(app, /addEventListener\('focusout', hideMachineTip\)/);
  assert.match(app, /analytics: \['Analytics'[\s\S]*Machine overload and idle waiting/);
});

test('/api/settings/prices reads the price table and writes a validated override', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    createEngine: (config) => {
      const engine = new EventEmitter();
      engine.cfg = config;
      engine.state = { serviceSettings: serviceSettingsView(config) };
      engine.memory = {};
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => {
    await close();
    fs.rmSync(path.join(dataDir, 'spend-prices.override.json'), { force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/settings/prices`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const read = await (await fetch(`${base}/api/settings/prices`)).json();
  assert.equal(read.costLabel, 'API-price equivalent');
  assert.equal(read.prices['claude/claude-opus-5-5'].cacheRead, 0.20);
  assert.deepEqual(read.overrides, { models: {} });
  assert.equal(read.defaults['claude/claude-opus-5-5'].cacheRead, 0.20);

  const saved = await put({ models: { 'claude/claude-opus-5-5': { cacheRead: 0.4 } } });
  assert.equal(saved.status, 200);
  const after = await saved.json();
  assert.equal(after.prices['claude/claude-opus-5-5'].cacheRead, 0.4);
  assert.equal(after.defaults['claude/claude-opus-5-5'].cacheRead, 0.20);
  assert.deepEqual(after.overrides, { models: { 'claude/claude-opus-5-5': { cacheRead: 0.4 } } });

  const before = fs.readFileSync(path.join(dataDir, 'spend-prices.override.json'), 'utf8');
  for (const body of [{ models: { 'claude/claude-opus-5-5': { input: 1001 } } }, { models: { 'claude/made-up': { input: 1 } } }, { models: { 'claude/claude-opus-5-5': { colour: 1 } } }, []]) {
    const rejected = await put(body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(fs.readFileSync(path.join(dataDir, 'spend-prices.override.json'), 'utf8'), before);
  }
  const cleared = await put({ models: {} });
  assert.equal(cleared.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'spend-prices.override.json')), false);
});

test('/api/projects serves sync and unplanned fields from the current worker and agent facts', { timeout: 20000 }, async (t) => {
  const projectsDir = path.join(dataDir, 'projects');
  const projectFile = path.join(projectsDir, 'alpha.json');
  const previous = fs.existsSync(projectFile) ? fs.readFileSync(projectFile) : null;
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(projectFile, JSON.stringify({
    project: 'Alpha', workspace: 'w-alpha', updated: new Date(Date.now() - 40 * 60000).toISOString(),
    tasks: [{ id: 'A', title: 'A task', status: 'todo' }],
  }));
  const { applyTaskState } = await import('../src/task-state.js');
  const workers = [{ name: 'unplanned', taskId: null, phase: 'live', kind: 'codex', model: 'gpt-6-luna', startedAt: new Date(Date.now() - 8 * 60000).toISOString(), pane: 'w-alpha:p2' }];
  const herdr = { panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', orch: true, agent: 'claude', status: 'working' }] };
  const control = { projects: { alpha: { slug: 'alpha', workspace: 'w-alpha' } } };
  const engine = new EventEmitter();
  engine.state = { control, herdr, projects: [] };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  engine.decorateProjects = (projects) => applyTaskState(projects, { alpha: workers }, { herdr, control, now: Date.now() });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  t.after(async () => {
    await close();
    if (previous) fs.writeFileSync(projectFile, previous);
    else fs.rmSync(projectFile, { force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`);
  assert.equal(response.status, 200);
  const projects = await response.json();
  const alpha = projects.find((project) => project.slug === 'alpha');
  assert.deepEqual(alpha.unplanned.map(({ name, pane }) => [name, pane]), [['unplanned', 'w-alpha:p2']]);
  assert.equal(alpha.sync.unplanned, 1);
  assert.equal(alpha.sync.agentsWorking, 1);
  assert.equal(alpha.sync.inSync, false);
  const state = await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
  const stateAlpha = state.projects.find((project) => project.slug === 'alpha');
  assert.equal(stateAlpha.sync.unplanned, 1);
  assert.deepEqual(stateAlpha.unplanned.map(({ name, pane }) => [name, pane]), [['unplanned', 'w-alpha:p2']]);
});

test('/api/projects shows Review for a collected done worker until its branch is merged', { timeout: 20000 }, async (t) => {
  const projectsDir = path.join(dataDir, 'projects');
  const projectFile = path.join(projectsDir, 'alpha.json');
  const previous = fs.existsSync(projectFile) ? fs.readFileSync(projectFile) : null;
  const runsDir = path.join(dataDir, 'runs-bd1c');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(projectFile, JSON.stringify({
    project: 'Alpha', workspace: 'w-alpha', updated: new Date().toISOString(),
    tasks: [{ id: 'BD1', title: 'Collected worker', status: 'doing' }],
  }));
  fs.writeFileSync(path.join(runsDir, 'collected.json'), JSON.stringify({
    name: 'collected', taskId: 'BD1', startedAt: new Date(Date.now() - 10 * 60000).toISOString(),
    collectedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date(Date.now() - 60000).toISOString(),
    outcome: 'done', branch: 'collected', base: 'main', baseCommit: 'abc123',
  }));
  const { applyTaskState, readWorkerFacts } = await import('../src/task-state.js');
  const workers = readWorkerFacts(runsDir, { now: Date.now(), isLive: () => false, isMerged: () => false });
  const herdr = { panes: [{ id: 'w-alpha:p1', workspace: 'w-alpha', orch: true, agent: 'claude', status: 'idle' }] };
  const control = { projects: { alpha: { slug: 'alpha', workspace: 'w-alpha' } } };
  const engine = new EventEmitter();
  engine.state = { control, herdr, projects: [] };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  engine.decorateProjects = (projects) => applyTaskState(projects, { alpha: workers }, { herdr, control, now: Date.now() });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, { readOnlyPreview: true, createEngine: () => engine });
  t.after(async () => {
    await close();
    if (previous) fs.writeFileSync(projectFile, previous);
    else fs.rmSync(projectFile, { force: true });
    fs.rmSync(runsDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`);
  assert.equal(response.status, 200);
  const projects = await response.json();
  const collected = projects.find((project) => project.slug === 'alpha').tasks[0];
  assert.equal(collected.publishedStatus, 'doing');
  assert.equal(collected.state, 'review');
  assert.equal(collected.worker.name, 'collected');
});
