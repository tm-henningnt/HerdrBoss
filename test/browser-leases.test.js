import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// No test here opens a connection to a port from 9222 to 9299 or starts a Chrome.
// The port probe, the process table, and the launch are fake functions.
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-leases-')));
process.env.HERDR_BOSS_DIR = dataDir;
const pool = await import('../src/browser-pool.js');
const leases = await import('../src/leases.js');
const { renderBulletin } = await import('../src/rules.js');
const { validateResourcePools } = await import('../src/config.js');
const { knownBrowsers } = await import('../src/engine.js');

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NOW = Date.parse('2026-09-28T12:00:00Z');
const SESSIONS = path.join(dataDir, 'browser-sessions.json');
const LEASES = path.join(dataDir, 'leases.json');

function reset(sessions = {}) {
  fs.writeFileSync(SESSIONS, JSON.stringify(sessions));
  fs.rmSync(LEASES, { force: true });
}

function record(project, port) {
  return { project, port, profile: path.join(dataDir, 'browser-profiles', project), headless: true, windowSize: { width: 1280, height: 800 }, pid: null, codeSignClone: null };
}

function chromeCmd(port, profile, extra = '') {
  return `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=${port} --user-data-dir=${profile} --headless${extra}`;
}

// A fake machine: no port is open and no Chrome runs unless a test adds one.
function fakeMachine({ open = [], procs = [] } = {}) {
  const table = new Map(procs.map((entry, index) => [5000 + index, { pid: 5000 + index, cmd: entry }]));
  return {
    portOpen: async (port) => open.includes(Number(port)),
    collectProcesses: async () => new Map(table),
    spawn: () => { throw new Error('The test must not launch Chrome.'); },
    cloneDir: null,
  };
}

const builtIn = () => leases.leasePools({ resourcePools: [], resourcePoolErrors: [] }).pools;
const browserLeases = () => leases.readLeases(dataDir).leases.filter((lease) => lease.pool === 'project-browsers');

test('the built-in pool has ports 9223 to 9299 and never port 9222', () => {
  const [browsers] = builtIn();
  assert.equal(browsers.name, 'project-browsers');
  assert.equal(browsers.check, 'cdp');
  assert.equal(browsers.items[0], '9223');
  assert.equal(browsers.items.at(-1), '9299');
  assert.equal(browsers.items.length, 77);
  assert.ok(!browsers.items.includes('9222'));
});

test('acquireLeaseFor refuses port 9222 in any pool', () => {
  reset();
  const config = validateResourcePools([{ name: 'legacy', items: ['9222', '47200'], env: 'HERDR_LEGACY_PORT' }]);
  assert.deepEqual(config.errors, []);
  const pools = [...config.pools, ...builtIn()];
  const holder = { project: 'alpha', worker: null, pane: null };
  assert.throws(() => leases.acquireLeaseFor('legacy', holder, { pools, dataDir, prefer: '9222', now: NOW }), /Port 9222 is protected/);
  assert.equal(leases.acquireLeaseFor('legacy', holder, { pools, dataDir, now: NOW }).item, '47200');
  assert.throws(() => leases.acquireLeaseFor('legacy', holder, { pools, dataDir, now: NOW }), /No free item in pool legacy/);
  assert.throws(() => leases.acquireLeaseFor('project-browsers', holder, { pools, dataDir, prefer: '9222', now: NOW }), /Port 9222 is protected/);
});

test('the engine has no fixed browser entry for port 9222', () => {
  const known = knownBrowsers([], [{ port: 9230, profile: '/p/alpha', project: 'alpha' }]);
  assert.deepEqual(known, [{ port: 9230, profile: '/p/alpha', label: 'Managed browser: alpha' }]);
  assert.ok(!knownBrowsers([], []).some((entry) => String(entry.port) === '9222'));
  assert.deepEqual(knownBrowsers([{ port: 9250, label: 'Signed-in browser' }], []), [{ port: 9250, label: 'Signed-in browser' }]);
});

test('a config pool named project-browsers is an error, and the built-in pool stays', () => {
  const config = validateResourcePools([
    { name: 'serve-ports', range: '47100-47101', env: 'HERDR_SERVE_PORT' },
    { name: 'project-browsers', range: '47300-47301', env: 'HERDR_BROWSER_PORT' },
  ]);
  const result = leases.leasePools({ resourcePools: config.pools, resourcePoolErrors: config.errors });
  assert.match(result.errors.join('\n'), /project-browsers is a built-in pool/);
  assert.deepEqual(result.pools.map((entry) => entry.name), ['project-browsers']);
  assert.equal(result.pools[0].items[0], '9223');
  const good = leases.leasePools({ resourcePools: config.pools.slice(0, 1), resourcePoolErrors: [] });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.pools.map((entry) => entry.name), ['serve-ports', 'project-browsers']);
});

test('the migration writes one project lease for each of three records and keeps each port', () => {
  const sessions = { alpha: record('alpha', 9223), beta: record('beta', 9231), gamma: record('gamma', 9224) };
  reset(sessions);
  const events = [];
  const migrated = leases.migrateProjectBrowserLeases(sessions, { dataDir, now: NOW, log: (event) => events.push(event) });
  assert.deepEqual(migrated.map((lease) => [lease.project, lease.item]), [['alpha', '9223'], ['beta', '9231'], ['gamma', '9224']]);
  assert.deepEqual(events.map((event) => [event.project, event.item]), [['alpha', '9223'], ['beta', '9231'], ['gamma', '9224']]);
  for (const lease of browserLeases()) {
    assert.equal(lease.holder, 'project');
    assert.equal(lease.worker, null);
    assert.equal(lease.pane, null);
    assert.equal(lease.expiresAt, null);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(SESSIONS, 'utf8')), sessions, 'the migration changes no record');
  // The migration runs once. A second run, also after a release, writes nothing.
  assert.deepEqual(leases.migrateProjectBrowserLeases(sessions, { dataDir, now: NOW }), []);
  leases.dropLeases((lease) => lease.pool === 'project-browsers', { dataDir });
  assert.deepEqual(leases.migrateProjectBrowserLeases(sessions, { dataDir, now: NOW }), []);
  assert.deepEqual(browserLeases(), []);
});

test('the migration skips a record with a port outside the pool or a duplicate port', () => {
  const sessions = { alpha: record('alpha', 9222), beta: record('beta', 9230), gamma: record('gamma', 9230) };
  reset(sessions);
  const events = [];
  const migrated = leases.migrateProjectBrowserLeases(sessions, { dataDir, now: NOW, log: (event) => events.push(event) });
  assert.deepEqual(migrated.map((lease) => [lease.project, lease.item]), [['beta', '9230']]);
  assert.deepEqual(events.map((event) => [event.project, event.item, !!event.skipped]), [['alpha', '9222', true], ['beta', '9230', false], ['gamma', '9230', true]]);
});

test('requestBrowser leases the recorded port', async () => {
  reset({ alpha: record('alpha', 9240) });
  const status = await pool.requestBrowser('alpha', { launch: false, ...fakeMachine() });
  assert.equal(status.port, 9240);
  assert.deepEqual(browserLeases().map((lease) => [lease.project, lease.item, lease.holder]), [['alpha', '9240', 'project']]);
  // A second request keeps the one lease.
  await pool.requestBrowser('alpha', { launch: false, ...fakeMachine() });
  assert.equal(browserLeases().length, 1);
});

test('a new project gets the lowest free port that no other record and no listener uses', async () => {
  reset({ alpha: record('alpha', 9223), beta: record('beta', 9225) });
  leases.migrateProjectBrowserLeases(pool.listBrowserSessions(), { dataDir, now: NOW });
  // beta has no lease now, but its record keeps 9225. A listener holds 9224.
  leases.dropLeases((lease) => lease.project === 'beta', { dataDir });
  const status = await pool.requestBrowser('gamma', { launch: false, ...fakeMachine({ open: [9224] }) });
  assert.equal(status.port, 9226);
  assert.equal(pool.listBrowserSessions().gamma.port, 9226);
  assert.deepEqual(browserLeases().map((lease) => [lease.project, lease.item]), [['alpha', '9223'], ['gamma', '9226']]);
});

test('a recorded port that another project leases moves the record to a free port', async () => {
  reset({ alpha: record('alpha', 9223) });
  leases.acquireLeaseFor('project-browsers', { project: 'beta' }, { pools: builtIn(), dataDir, prefer: '9223', now: NOW });
  const status = await pool.requestBrowser('alpha', { launch: false, ...fakeMachine() });
  assert.equal(status.port, 9224);
  assert.deepEqual(browserLeases().map((lease) => [lease.project, lease.item]), [['beta', '9223'], ['alpha', '9224']]);
});

test('closeBrowser keeps the lease, and releaseBrowser removes it', async () => {
  reset({ alpha: record('alpha', 9241) });
  await pool.requestBrowser('alpha', { launch: false, ...fakeMachine() });
  const closed = await pool.closeBrowser('alpha', fakeMachine());
  assert.equal(closed.closed, true);
  assert.deepEqual(browserLeases().map((lease) => lease.item), ['9241']);
  const released = await pool.releaseBrowser('alpha', fakeMachine());
  assert.equal(released.released, true);
  assert.equal(released.port, 9241);
  assert.deepEqual(browserLeases(), []);
  assert.equal(pool.listBrowserSessions().alpha.port, 9241, 'the record stays');
});

test('releaseBrowser refuses while the project Chrome runs', async () => {
  const alpha = record('alpha', 9242);
  reset({ alpha });
  leases.migrateProjectBrowserLeases({ alpha }, { dataDir, now: NOW });
  const running = fakeMachine({ procs: [chromeCmd(9242, alpha.profile)] });
  await assert.rejects(pool.releaseBrowser('alpha', running), /Close the browser first/);
  assert.equal(browserLeases().length, 1);
});

// The CLI reads the process list with ps. A Codex sandbox refuses it, so this test runs only where ps works.
const psWorks = (() => { const r = spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' }); return !r.error && r.status === 0; })();

test('herdr-boss browser release SLUG removes the lease', { skip: psWorks ? false : 'the process list is not readable here (for example in a Codex sandbox)' }, () => {
  const alpha = record('alpha', 9243);
  reset({ alpha });
  leases.migrateProjectBrowserLeases({ alpha }, { dataDir, now: NOW });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-leases-home-'));
  const env = { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: dataDir };
  const result = spawnSync(process.execPath, [CLI, 'browser', 'release', 'alpha'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Released project browser port 9243 of alpha/);
  assert.deepEqual(browserLeases(), []);
  const again = spawnSync(process.execPath, [CLI, 'browser', 'release', 'alpha'], { env, encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /alpha holds no project browser lease/);
});

test('the generic lease commands do not change the built-in pool', () => {
  reset();
  const pools = builtIn();
  assert.throws(() => leases.acquireLease('project-browsers', { pools, dataDir, herdr: () => { throw new Error('no call'); } }), /Use herdr-boss browser request/);
  assert.throws(() => leases.releaseLease('project-browsers', '9223', { pools, dataDir, herdr: () => { throw new Error('no call'); } }), /Use herdr-boss browser release/);
});

function tick(check, now = NOW) {
  const events = [];
  leases.reclaimLeases({ pools: builtIn(), dataDir, now, browserProcess: check, log: (event) => events.push(event) });
  return events;
}

test('a project lease is reclaimed only when no Chrome matches on two ticks in a row', () => {
  const alpha = record('alpha', 9244);
  reset({ alpha });
  leases.migrateProjectBrowserLeases({ alpha }, { dataDir, now: NOW });
  // The table always holds one unrelated process. An empty table means that the process list failed.
  const table = new Map([[99, { pid: 99, cmd: '/sbin/launchd' }]]);
  const check = () => pool.browserProcessCheck(table, pool.listBrowserSessions());
  // A project lease has no TTL: a year later a running Chrome keeps it.
  table.set(1, { pid: 1, cmd: chromeCmd(9244, alpha.profile) });
  assert.deepEqual(tick(check(), NOW + 365 * 86400000), []);
  table.delete(1);
  assert.deepEqual(tick(check()), []);
  assert.equal(browserLeases()[0].cdpMisses, 1);
  // A Chrome on the port with another profile does not count.
  table.set(2, { pid: 2, cmd: chromeCmd(9244, '/tmp/other-profile') });
  const events = tick(check());
  assert.deepEqual(events.map((event) => [event.pool, event.item, event.project, event.reason]), [['project-browsers', '9244', 'alpha', 'no Chrome process has port 9244 and the alpha profile']]);
  assert.deepEqual(browserLeases(), []);
});

test('a Chrome that returns between the two ticks keeps the lease', () => {
  const alpha = record('alpha', 9245);
  reset({ alpha });
  leases.migrateProjectBrowserLeases({ alpha }, { dataDir, now: NOW });
  // The table always holds one unrelated process. An empty table means that the process list failed.
  const table = new Map([[99, { pid: 99, cmd: '/sbin/launchd' }]]);
  const check = () => pool.browserProcessCheck(table, pool.listBrowserSessions());
  tick(check());
  table.set(1, { pid: 1, cmd: chromeCmd(9245, alpha.profile) });
  tick(check());
  assert.equal(browserLeases()[0].cdpMisses, undefined);
  table.delete(1);
  assert.deepEqual(tick(check()), []);
  assert.equal(browserLeases().length, 1);
});

test('a not-responding browser is never reclaimed, and an unknown or empty process table changes nothing', () => {
  const alpha = record('alpha', 9246);
  reset({ alpha });
  leases.migrateProjectBrowserLeases({ alpha }, { dataDir, now: NOW });
  // The process is present, and the CDP probe is not part of the check. A hung Chrome keeps its lease.
  const table = new Map([[1, { pid: 1, cmd: chromeCmd(9246, alpha.profile) }]]);
  for (let index = 0; index < 5; index++) assert.deepEqual(tick(pool.browserProcessCheck(table, pool.listBrowserSessions())), []);
  // A failed process collection gives no check. Five ticks without a check reclaim nothing.
  for (let index = 0; index < 5; index++) assert.deepEqual(tick(pool.browserProcessCheck(null, pool.listBrowserSessions())), []);
  for (let index = 0; index < 5; index++) assert.deepEqual(tick(pool.browserProcessCheck(new Map(), pool.listBrowserSessions())), []);
  for (let index = 0; index < 5; index++) assert.deepEqual(tick(undefined), []);
  assert.equal(browserLeases().length, 1);
  assert.equal(browserLeases()[0].cdpMisses, undefined);
});

test('the Resource leases section lists the project browser pool, and the Project browsers section stays', () => {
  const pools = builtIn();
  const at = (minutes) => new Date(NOW - minutes * 60000).toISOString();
  const leased = [
    { pool: 'project-browsers', item: '9223', project: 'alpha', worker: null, pane: null, holder: 'project', at: at(125), expiresAt: null, borrowed: false },
    { pool: 'project-browsers', item: '9230', project: 'beta', worker: null, pane: null, holder: 'project', at: at(5), expiresAt: null, borrowed: false },
  ];
  assert.deepEqual(leases.leaseBulletinLines({ pools, leases: leased }, NOW), [
    '- project-browsers (built-in, ports 9223-9299; use herdr-boss browser request): 9223 alpha 2h 5m; 9230 beta 5m; 75 free',
  ]);
  const snap = {
    updatedAt: new Date(NOW).toISOString(),
    browsers: [{ kind: 'automation-chrome', port: '9223', profile: '/p/alpha' }],
    managedBrowsers: [{ project: 'alpha', port: 9223, profile: '/p/alpha', headless: true, responsive: true }],
    resourceLeases: { pools, errors: [], leases: leased },
  };
  const text = renderBulletin(snap, { alerts: [], advice: [] }, { host: '127.0.0.1', port: 4477 });
  assert.match(text, /## Project browsers\n\n- alpha: ready \(headless\)/);
  assert.match(text, /## Resource leases\n\n- project-browsers \(built-in, ports 9223-9299; use herdr-boss browser request\): 9223 alpha 2h 5m; 9230 beta 5m; 75 free/);
});

// The engine runs in a child process with a live-like temporary data directory, a fake Herdr, and fake system commands.
const engineProbe = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { Engine } from './src/engine.js';
  import { loadConfig } from './src/config.js';
  const dir = process.env.HERDR_BOSS_DIR;
  const profile = (project) => path.join(dir, 'browser-profiles', project);
  const chrome = (port, project) => ({ pid: port, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=' + port + ' --user-data-dir=' + profile(project) + ' --headless' });
  const tables = [
    new Map([[9223, chrome(9223, 'alpha')]]),
    null,
    new Map([[9223, chrome(9223, 'alpha')]]),
  ];
  let tickIndex = 0;
  const cfg = loadConfig();
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  cfg.browsers.sweepCodeSignClones = false;
  const engine = new Engine(cfg, { push: false, act: true, collectors: {
    collectProcesses: async () => { const table = tables[tickIndex]; if (!table) throw new Error('fake ps failed'); return new Map(table); },
    cdpResponds: async () => false,
    probeBrowser: async () => ({ ok: true }),
    collectBrowserClients: async () => 0,
    collectPiModels: async () => null,
    runDenialScan: async () => ({ state: {}, denials: [] }),
  } });
  const leases = () => JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8')).leases.map((lease) => [lease.project, lease.item, lease.cdpMisses ?? 0]);
  const result = [];
  for (; tickIndex < tables.length; tickIndex++) {
    await engine.tick();
    result.push(leases());
  }
  const bulletin = fs.readFileSync(path.join(dir, 'bulletin.md'), 'utf8');
  console.log(JSON.stringify({ act: engine.act, result, events: engine.events.filter((event) => event.type === 'lease').map((event) => event.text), bulletin }));
`;

test('the engine migrates the records at its first tick and reclaims a lease only on two known process tables', { timeout: 30000 }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-browser-leases-engine-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = (name, source) => { fs.writeFileSync(path.join(bin, name), source); fs.chmodSync(path.join(bin, name), 0o755); };
  executable('herdr', `#!/bin/sh\ncase "$1 $2" in\n  "workspace list") echo '{"result":{"workspaces":[]}}' ;;\n  "tab list") echo '{"result":{"tabs":[]}}' ;;\n  "pane list") echo '{"result":{"panes":[]}}' ;;\n  "agent list") echo '{"result":{"agents":[]}}' ;;\n  *) echo '{"result":{}}' ;;\nesac\n`);
  executable('codexbar', "#!/bin/sh\nprintf '[]\\n'\n");
  executable('ps', '#!/bin/sh\nexit 0\n');
  executable('memory_pressure', "#!/bin/sh\nprintf 'System-wide memory free percentage: 60%%\\n'\n");
  executable('sysctl', "#!/bin/sh\nprintf 'total = 1024.00M used = 1.00M free = 1023.00M\\n'\n");
  executable('ioreg', "#!/bin/sh\nprintf '\"HIDIdleTime\" = 1000000000\\n'\n");
  const profile = (project) => path.join(dir, 'browser-profiles', project);
  const sessions = Object.fromEntries([['alpha', 9223], ['beta', 9231], ['gamma', 9224]].map(([project, port]) => [project, { ...record(project, port), profile: profile(project) }]));
  fs.writeFileSync(path.join(dir, 'browser-sessions.json'), JSON.stringify(sessions));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', engineProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: dir, HERDR_BOSS_DIR: dir, HERDR_BOSS_LIVE_DIR: dir, HERDR_BOSS_ALLOW_ACTIONS: '1', HERDR_BOSS_PUSH: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.act, true);
  assert.deepEqual(output.result, [
    // Tick 1 migrates three records with their ports. beta and gamma have no Chrome: the first miss.
    [['alpha', '9223', 0], ['beta', '9231', 1], ['gamma', '9224', 1]],
    // Tick 2 has no process table. Nothing changes.
    [['alpha', '9223', 0], ['beta', '9231', 1], ['gamma', '9224', 1]],
    // Tick 3 is the second miss for beta and gamma.
    [['alpha', '9223', 0]],
  ]);
  assert.deepEqual(output.events, [
    'Migrated the alpha browser to project-browsers 9223',
    'Migrated the beta browser to project-browsers 9231',
    'Migrated the gamma browser to project-browsers 9224',
    'Reclaimed project-browsers 9231 of beta: no Chrome process has port 9231 and the beta profile',
    'Reclaimed project-browsers 9224 of gamma: no Chrome process has port 9224 and the gamma profile',
  ]);
  assert.match(output.bulletin, /## Resource leases\n\n- project-browsers \(built-in, ports 9223-9299; use herdr-boss browser request\): 9223 alpha 0m; 76 free/);
  assert.match(output.bulletin, /## Project browsers\n\n- alpha: not responding/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'browser-sessions.json'), 'utf8')), sessions, 'the engine changes no record');
});
