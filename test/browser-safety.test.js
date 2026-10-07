import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserSafetyNotices, browserSafetyNoticeDelta, browserSafetyAlert, migrateVisibleBrowserSession } from '../src/browser-safety.js';
import { renderBulletin } from '../src/rules.js';

const visibleProcesses = new Map([
  [41, { pid: 41, ppid: 1, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=/profiles/alpha' }],
]);
const session = { project: 'alpha', port: 9223, profile: '/profiles/alpha', headless: true };

test('a visible Chrome process with a project profile gets one actionable project warning', () => {
  const warnings = browserSafetyNotices({ processes: visibleProcesses, sessions: [session] });
  assert.deepEqual(warnings.map(({ project, kind, text }) => ({ project, kind, text })), [{
    project: 'alpha', kind: 'visible-project-browser',
    text: 'The project browser for alpha is visible. Run herdr-boss browser restart alpha --headless.',
  }]);
});

test('visible-project warnings honor browser.allowVisible', () => {
  assert.deepEqual(browserSafetyNotices({ processes: visibleProcesses, sessions: [session], allowVisible: true }), []);
});

test('automation Chrome matching uses the executable path, not arguments', () => {
  const processes = new Map([
    [10, { pid: 10, ppid: 1, cmd: 'zsh' }],
    [20, { pid: 20, ppid: 10, cmd: 'worker' }],
    [41, { pid: 41, ppid: 20, cmd: 'node worker.js --label="Google Chrome --remote-debugging-port=9223"' }],
    [42, { pid: 42, ppid: 20, cmd: '/usr/bin/env --label=/tmp/Chromium --remote-debugging-port=9224' }],
  ]);
  assert.deepEqual(browserSafetyNotices({ processes, panes: [{ id: 'pane-alpha', workspace: 'workspace-alpha', shellPid: 10, agent: 'worker' }],
    projects: { alpha: { workspace: 'workspace-alpha' } }, sessions: [session] }), []);
});

test('a project worker or lead that launches automation Chrome gets a shared-browser fix', () => {
  const processes = new Map([
    [10, { pid: 10, ppid: 1, cmd: 'zsh' }],
    [20, { pid: 20, ppid: 10, cmd: 'claude' }],
    [30, { pid: 30, ppid: 20, cmd: 'Chromium --remote-debugging-pipe --enable-automation --user-data-dir=/tmp/automation --headless' }],
  ]);
  const warnings = browserSafetyNotices({ processes, panes: [{ id: 'pane-alpha', workspace: 'workspace-alpha', shellPid: 10, agent: 'worker-1', label: null }],
    projects: { alpha: { workspace: 'workspace-alpha' } }, sessions: [] });
  assert.deepEqual(warnings.map(({ project, kind, text }) => ({ project, kind, text })), [{
    project: 'alpha', kind: 'independent-browser-launch',
    text: 'A worker or project lead launched Chrome for alpha outside herdr-boss browser. Attach with herdr-boss browser request alpha.',
  }]);
});

test('a Chrome launch through herdr-boss browser does not raise an independent-launch warning', () => {
  const processes = new Map([
    [10, { pid: 10, ppid: 1, cmd: 'zsh' }],
    [20, { pid: 20, ppid: 10, cmd: '/opt/herdr/bin/herdr-boss browser request alpha' }],
    [30, { pid: 30, ppid: 20, cmd: 'Chromium --remote-debugging-port=9223 --user-data-dir=/profiles/alpha --headless' }],
  ]);
  const warnings = browserSafetyNotices({ processes, panes: [{ id: 'pane-alpha', workspace: 'workspace-alpha', shellPid: 10, agent: 'worker-1' }],
    projects: { alpha: { workspace: 'workspace-alpha' } }, sessions: [session] });
  assert.deepEqual(warnings, []);
});

test('headless safety warnings emit once while active and again only after they clear', () => {
  const warning = { key: 'browser:safety:alpha:visible-project-browser', project: 'alpha' };
  const first = browserSafetyNoticeDelta([warning], {});
  assert.deepEqual(first.added, [warning]);
  const repeat = browserSafetyNoticeDelta([warning], first.active);
  assert.deepEqual(repeat.added, []);
  assert.deepEqual(repeat.active, { [warning.key]: true });
  const cleared = browserSafetyNoticeDelta([], repeat.active);
  assert.deepEqual(cleared.removed, [warning.key]);
  assert.deepEqual(browserSafetyNoticeDelta([warning], cleared.active).added, [warning]);
});

test('the safety alert reaches the dashboard state and the Owner bulletin', () => {
  const warning = { key: 'browser:safety:alpha:independent-browser-launch:30', project: 'alpha', kind: 'independent-browser-launch',
    text: 'A worker or project lead launched Chrome for alpha outside herdr-boss browser. Attach with herdr-boss browser request alpha.' };
  const alert = browserSafetyAlert(warning);
  assert.deepEqual(alert, { key: warning.key, severity: 'warn', scope: 'user', once: true,
    title: 'Project browser needs attention', text: warning.text });
  const bulletin = renderBulletin({ updatedAt: '2026-10-07T10:00:00.000Z', resourceLeases: { pools: [], errors: [], leases: [] } },
    { alerts: [alert], advice: [] }, { host: '127.0.0.1', port: 4477 });
  assert.match(bulletin, /Rules now[\s\S]*A worker or project lead launched Chrome for alpha[\s\S]*herdr-boss browser request alpha/);
});

test('visible session migration restarts only the browser whose PID Herdr Boss recorded', async () => {
  const calls = [];
  const owned = await migrateVisibleBrowserSession({ ...session, headless: false, pid: 41, launchedAt: '2026-10-01T00:00:00.000Z' }, { pid: 41 }, {
    restart: async (project) => calls.push(['restart', project]),
    setHeadlessPreference: async (project) => calls.push(['preference', project]),
    now: 1000,
  });
  assert.equal(owned.action, 'restarted');
  assert.deepEqual(calls, [['restart', 'alpha']]);
  assert.equal(owned.at, new Date(1000).toISOString());

  calls.length = 0;
  const external = await migrateVisibleBrowserSession({ ...session, headless: false, pid: 41, launchedAt: '2026-10-01T00:00:00.000Z' }, { pid: 99 }, {
    restart: async (project) => calls.push(['restart', project]),
    setHeadlessPreference: async (project) => calls.push(['preference', project]),
    now: 2000,
  });
  assert.equal(external.action, 'preference-only');
  assert.deepEqual(calls, [['preference', 'alpha']]);
});

test('migration leaves no-process sessions headless and skips a session already recorded as migrated', async () => {
  const calls = [];
  const result = await migrateVisibleBrowserSession({ ...session, headless: false, pid: null }, null, {
    restart: async () => calls.push('restart'),
    setHeadlessPreference: async (project) => calls.push(['preference', project]),
    now: 3000,
  });
  assert.equal(result.action, 'preference-only');
  assert.deepEqual(calls, [['preference', 'alpha']]);
  assert.equal(await migrateVisibleBrowserSession({ ...session, headless: true }, null, {
    restart: async () => assert.fail('already-headless session must not restart'),
    setHeadlessPreference: async () => assert.fail('already-headless session must not update'),
  }), null);
});

test('Engine.tick records a failed headless migration once', { timeout: 60000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-safety-engine-')));
  try {
    const bin = path.join(dir, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const executable = (name, source) => { fs.writeFileSync(path.join(bin, name), source); fs.chmodSync(path.join(bin, name), 0o755); };
    executable('herdr', `#!/bin/sh\ncase "$1 $2" in\n  "workspace list") echo '{"result":{"workspaces":[]}}' ;;\n  "tab list") echo '{"result":{"tabs":[]}}' ;;\n  "pane list") echo '{"result":{"panes":[]}}' ;;\n  "agent list") echo '{"result":{"agents":[]}}' ;;\n  *) echo '{"result":{}}' ;;\nesac\n`);
    executable('codexbar', "#!/bin/sh\nprintf '[]\\n'\n");
    executable('ps', '#!/bin/sh\nexit 0\n');
    executable('memory_pressure', "#!/bin/sh\nprintf 'System-wide memory free percentage: 60%%\\n'\n");
    executable('sysctl', "#!/bin/sh\nprintf 'total = 1024.00M used = 1.00M free = 1023.00M\\n'\n");
    executable('ioreg', "#!/bin/sh\nprintf '\"HIDIdleTime\" = 1000000000\\n'\n");
    const profile = path.join(dir, 'browser-profiles', 'alpha');
    const session = { project: 'alpha', port: 9223, profile, headless: false, pid: 4201,
      launchedAt: '2026-10-01T00:00:00.000Z', windowSize: { width: 1280, height: 800 } };
    fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify({ alpha: session }));
    const script = `
      import { Engine } from './src/engine.js';
      import { loadConfig } from './src/config.js';
      const cfg = loadConfig(); cfg.push = false; cfg.browsers.reapOrphanDaemons = false; cfg.browsers.sweepCodeSignClones = false;
      const processes = new Map([[4201, { pid: 4201, ppid: 1, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=' + ${JSON.stringify(profile)} }]]);
      let restartCalls = 0;
      const engine = new Engine(cfg, { push: false, act: true, collectors: {
        collectHerdr: async () => ({ panes: [], workspaces: [], agents: [] }),
        collectMachine: async () => null,
        collectProcesses: async () => processes,
        collectCwdProcesses: async () => [],
        collectMissingWorktreeProcesses: async () => [],
        collectWorktreeCounts: async () => ({}),
        collectBrowserClients: async () => 0,
        cdpResponds: async () => false,
        probeBrowser: async () => ({ ok: true }),
        restartBrowser: async () => { restartCalls++; throw new Error('fixture restart failure'); },
        markBrowserHeadless: async () => { throw new Error('must not change preference for an owned browser'); },
        collectPiModels: async () => null,
        runDenialScan: async () => ({ state: {}, denials: [] }),
      } });
      await engine.tick();
      const first = { errors: engine.state.errors, migrations: engine.state.browserHeadlessMigrations };
      await engine.tick();
      console.log(JSON.stringify({ first, second: { errors: engine.state.errors, migrations: engine.state.browserHeadlessMigrations }, restartCalls }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname), encoding: 'utf8',
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, HOME: dir, HERDR_BOSS_DIR: dir,
        HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', HERDR_BOSS_PUSH: '0' },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.restartCalls, 1);
    assert.match(out.first.errors.join('\n'), /browser headless migration alpha/);
    assert.equal(Object.values(out.first.migrations)[0]?.action, 'failed');
    assert.deepEqual(out.second.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
