import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pools-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pools-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';
process.on('exit', () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const [{ serve }, { loadConfig, validateResourcePools }, { Engine }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/engine.js'),
]);

const secret = () => `test-client-${randomBytes(8).toString('hex')}`;
const base = { name: 'serve-ports', env: 'HERDR_SERVE_PORT' };
const errorsOf = (pool, options) => validateResourcePools([{ ...base, ...pool }], options).errors.join('\n');

// ----- validation -----

test('a ports pool accepts a range, a list of ranges and ports, and later additions', () => {
  const first = validateResourcePools([{ ...base, range: '47100-47109' }]);
  assert.deepEqual(first.errors, []);
  assert.equal(first.pools[0].items.length, 10);
  const mixed = validateResourcePools([{ ...base, range: '47100-47104, 47110,47115-47116' }]);
  assert.deepEqual(mixed.errors, []);
  assert.deepEqual(mixed.pools[0].items, ['47100', '47101', '47102', '47103', '47104', '47110', '47115', '47116']);
  const grown = validateResourcePools([{ ...base, range: '47100-47104,47105-47109' }]);
  assert.deepEqual(grown.pools[0].items, first.pools[0].items);
});

test('a ports pool limits the port numbers, the count, duplicates, and the dashboard port', () => {
  assert.match(errorsOf({ range: '1000-1100' }), /from 1024 to 65535/);
  assert.match(errorsOf({ items: ['1023'], check: 'tcp' }), /from 1024 to 65535/);
  assert.match(errorsOf({ items: ['47000', '65536'] }), /from 1024 to 65535/);
  assert.equal(errorsOf({ range: '47000-47099' }), '', '100 ports are allowed');
  assert.match(errorsOf({ range: '47000-47100' }), /at most 100 ports/);
  assert.match(errorsOf({ range: '47000-47003,47002-47005' }), /duplicate/i);
  assert.match(errorsOf({ range: '47000-47003' }, { dashboardPort: 47002 }), /dashboard port 47002/);
  assert.equal(errorsOf({ range: '47000-47003' }, { dashboardPort: 4477 }), '');
});

test('idleMinutes and waitSeconds have defaults and limits', () => {
  const [pool] = validateResourcePools([{ ...base, range: '47100-47101' }]).pools;
  assert.equal(pool.idleMinutes, 20);
  assert.equal(pool.waitSeconds, 0);
  assert.equal(errorsOf({ range: '47100-47101', idleMinutes: 1 }), '');
  assert.equal(errorsOf({ range: '47100-47101', idleMinutes: 240 }), '');
  assert.match(errorsOf({ range: '47100-47101', idleMinutes: 0 }), /idleMinutes must be a whole number from 1 to 240/);
  assert.match(errorsOf({ range: '47100-47101', idleMinutes: 241 }), /idleMinutes must be a whole number from 1 to 240/);
  assert.match(errorsOf({ range: '47100-47101', idleMinutes: 1.5 }), /idleMinutes/);
  assert.equal(errorsOf({ range: '47100-47101', waitSeconds: 3600 }), '');
  assert.match(errorsOf({ range: '47100-47101', waitSeconds: 3601 }), /waitSeconds must be a whole number from 0 to 3600/);
});

test('portEnv validates ranges, values, and variable names and never echoes a value', () => {
  const value = secret();
  const ok = validateResourcePools([{ ...base, range: '47100-47109', portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': value, '47105-47109': secret() } } }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.pools[0].portEnv.TM_SERVE_LIVE_CLIENT_ID['47100-47104'], value);
  const bad = (portEnv) => errorsOf({ range: '47100-47109', portEnv });
  assert.match(bad({ TM_CLIENT: { '47200': value } }), /47200 is not in the pool/);
  assert.match(bad({ TM_CLIENT: { '47100-47104': value, '47104-47105': value } }), /47104 is in more than one/);
  assert.match(bad({ lower: { '47100': value } }), /environment variable name/);
  assert.match(bad({ HERDR_SERVE_PORT: { '47100': value } }), /HERDR_SERVE_PORT is the lease variable/);
  assert.match(bad({ TM_CLIENT: { '47100': 'has space' } }), /no whitespace/);
  assert.match(bad({ TM_CLIENT: { '47100': 'line\nbreak' } }), /no whitespace/);
  assert.match(bad({ TM_CLIENT: { '47100': 'x'.repeat(201) } }), /at most 200 characters/);
  assert.match(bad({ TM_CLIENT: { '47100': 7 } }), /must be a string/);
  assert.match(bad({ TM_CLIENT: { '47100': '' } }), /must be a string of 1 to 200/);
  for (const portEnv of [{ TM_CLIENT: { '47100': `${value} x` } }, { TM_CLIENT: { '47100': 'x'.repeat(201) } }, { TM_CLIENT: { '47200': value } }]) {
    assert.equal(bad(portEnv).includes(value), false, 'an error never holds a value');
  }
});

// ----- the pools API -----

async function poolServer(t, pools) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ host: '127.0.0.1', port: 0, tickSeconds: 3600, resourcePools: pools })}\n`, { mode: 0o600 });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  let engine;
  const { server, close } = serve(cfg, {
    createEngine: (engineCfg, options) => {
      engine = new Engine(engineCfg, { ...options, act: false, push: false });
      engine.state = { resourceLeases: { pools: [], errors: [], leases: [] } };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${url}/api/pools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = () => fetch(`${url}/api/pools`);
  const saved = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return { put, get, saved, engine: () => engine, url };
}

const servePool = (extra = {}) => ({ name: 'serve-ports', range: '47100-47109', split: {}, env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp', graceMinutes: 10, ...extra });
const writeLeases = (leases) => fs.writeFileSync(path.join(dataDir, 'leases.json'), JSON.stringify({ leases }));
const heldLease = (item, extra = {}) => ({ pool: 'serve-ports', item, project: 'project-a', worker: 'worker-a', pane: 'ws:p2', at: new Date(Date.now() - 30 * 60000).toISOString(), expiresAt: null, borrowed: false, ...extra });

test('GET /api/pools returns set flags and never a value', { timeout: 20000 }, async (t) => {
  const value = secret();
  const f = await poolServer(t, [servePool({ portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47105-47109': value } } })]);
  const response = await f.get();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(value), false);
  const body = JSON.parse(text);
  const pool = body.pools.find((item) => item.name === 'serve-ports');
  assert.deepEqual(pool.portEnv, { TM_SERVE_LIVE_CLIENT_ID: { '47105-47109': 'set' } });
  assert.equal(pool.idleMinutes, 20);
  assert.equal(pool.items.length, 10);
});

test('PUT stores a port value in config.json only, answers with flags, keeps an unchanged value, and clears an empty one', { timeout: 20000 }, async (t) => {
  const first = secret();
  const second = secret();
  const f = await poolServer(t, [servePool()]);
  const created = await f.put({ action: 'update', pool: servePool({ portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': first, '47105-47109': second } } }) });
  const createdText = await created.text();
  assert.equal(created.status, 200, createdText);
  assert.equal(createdText.includes(first) || createdText.includes(second), false, 'the PUT answer holds no value');
  assert.deepEqual(JSON.parse(createdText).pools[0].portEnv, { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': 'set', '47105-47109': 'set' } });
  assert.equal(f.saved().resourcePools[0].portEnv.TM_SERVE_LIVE_CLIENT_ID['47100-47104'], first);
  assert.equal(JSON.stringify(f.engine().state).includes(first), false, 'the engine state holds no value');
  assert.equal(JSON.stringify(f.engine().state).includes(second), false);

  const kept = await f.put({ action: 'update', pool: servePool({ idleMinutes: 30, portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': null, '47105-47109': second } } }) });
  assert.equal(kept.status, 200, await kept.clone().text());
  assert.equal(f.saved().resourcePools[0].portEnv.TM_SERVE_LIVE_CLIENT_ID['47100-47104'], first, 'null keeps the stored value');
  assert.equal(f.saved().resourcePools[0].idleMinutes, 30);

  const cleared = await f.put({ action: 'update', pool: servePool({ portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': '', '47105-47109': null } } }) });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.deepEqual(f.saved().resourcePools[0].portEnv, { TM_SERVE_LIVE_CLIENT_ID: { '47105-47109': second } }, 'an empty value clears the entry');

  const nothing = await f.put({ action: 'update', pool: servePool({ portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100-47104': null } } }) });
  assert.equal(nothing.status, 400, 'null with no stored value is an error');
  assert.equal((await nothing.text()).includes(second), false);
});

test('PUT refuses a bad port value without echoing it', { timeout: 20000 }, async (t) => {
  const value = `${secret()} with space`;
  const f = await poolServer(t, [servePool()]);
  const response = await f.put({ action: 'update', pool: servePool({ portEnv: { TM_SERVE_LIVE_CLIENT_ID: { '47100': value } } }) });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(text.includes(value), false);
  assert.match(text, /whitespace/);
});

test('PUT refuses the dashboard port', { timeout: 20000 }, async (t) => {
  const f = await poolServer(t, [servePool()]);
  const port = Number(f.url.split(':').at(-1));
  const response = await f.put({ action: 'update', pool: servePool({ range: `${port}-${port + 1}` }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /dashboard port/);
});

test('PUT refuses to drop a port that a bound holder or a listener still uses, and names the holder', { timeout: 20000 }, async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => (listener.listening ? listener.close(resolve) : resolve())));
  const { port } = listener.address();
  const both = `${port},47190`;
  const f = await poolServer(t, [servePool({ range: both })]);
  writeLeases([heldLease(String(port))]);
  const withListener = await f.put({ action: 'update', pool: servePool({ range: '47190' }) });
  const body = await withListener.json();
  assert.equal(withListener.status, 409, body.error);
  assert.match(body.error, new RegExp(`${port}`));
  assert.equal(body.holder.project, 'project-a');
  assert.equal(body.holder.worker, 'worker-a');
  assert.equal(f.saved().resourcePools[0].range, both, 'nothing was written');

  writeLeases([heldLease('47190', { pid: process.pid })]);
  const bound = await f.put({ action: 'update', pool: servePool({ range: String(port) }) });
  assert.equal(bound.status, 409, 'a bound lease keeps its port');
  assert.equal((await bound.json()).holder.item, '47190');
});

test('PUT drops a leased port only when the lease is unbound and idle, and releases that lease', { timeout: 20000 }, async (t) => {
  const f = await poolServer(t, [servePool()]);
  writeLeases([heldLease('47109')]);
  const shrink = await f.put({ action: 'update', pool: servePool({ range: '47100-47107' }) });
  assert.equal(shrink.status, 200, await shrink.clone().text());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'leases.json'), 'utf8')).leases, []);
  assert.equal(f.saved().resourcePools[0].range, '47100-47107');
});

// ----- the dashboard -----

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const body = (name) => { const start = app.indexOf(`function ${name}(`); assert.ok(start >= 0, `${name} exists`); return app.slice(start, app.indexOf('\n}\n', start)); };
function loadPanel() {
  const names = ['leaseRow', 'leasePoolBlock', 'leaseTtlText', 'leaseReclaimText', 'poolIsPorts', 'leaseAgeText', 'leaseTimeLeftText', 'leaseServerText', 'leaseListenerText', 'leaseIdleText', 'browserRunningForLease'];
  const ctx = {
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    dur: (seconds) => `${Math.max(0, Math.round(seconds / 60))}m`,
    ago: (iso) => (iso ? `${Math.round((Date.now() - new Date(iso)) / 60000)}m ago` : '–'),
    until: (iso) => (iso ? `${Math.round((new Date(iso) - Date.now()) / 60000)}m` : '–'),
    poolBusy: false, poolRemoveBusy: false, Date,
  };
  vm.runInNewContext(`${names.map(body).map((x) => `${x}\n}`).join('\n')}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}

test('the Resource leases panel shows holder, age, pid or unbound, listener, idle minutes, and time left', () => {
  const { leasePoolBlock } = loadPanel();
  const now = Date.now();
  const pool = { name: 'serve-ports', items: ['47100', '47101', '47102'], env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp', idleMinutes: 20 };
  const leases = [
    { pool: 'serve-ports', item: '47100', project: 'project-a', worker: 'worker-a', pane: 'ws:p2', at: new Date(now - 5 * 60000).toISOString(), expiresAt: new Date(now + 60 * 60000).toISOString(), pid: 4242, listener: true },
    { pool: 'serve-ports', item: '47101', project: 'project-a', worker: null, pane: 'ws:p3', at: new Date(now - 12 * 60000).toISOString(), expiresAt: null, listener: false, idleSince: new Date(now - 7 * 60000).toISOString() },
  ];
  const html = leasePoolBlock({ resourceLeases: { leases } }, pool);
  assert.match(html, /<th>Server<\/th><th>Listener<\/th><th>Idle<\/th>/);
  const rows = html.split('<tr id=').slice(1);
  assert.match(rows[0], /data-label="Server">pid 4242</);
  assert.match(rows[0], /data-label="Listener">yes</);
  assert.doesNotMatch(rows[0], /lease-idle/);
  assert.match(rows[1], /lease-idle/);
  assert.match(rows[1], /data-label="Server">unbound</);
  assert.match(rows[1], /data-label="Listener">no</);
  assert.match(rows[1], /data-label="Idle">7m</);
  assert.match(rows[2], /lease-free/);
});

test('the Resource leases panel escapes every lease value', () => {
  const { leasePoolBlock } = loadPanel();
  const pool = { name: 'serve-ports', items: ['47100'], env: 'X', ttlMinutes: 240, check: 'tcp', idleMinutes: 20 };
  const evil = '<img src=x onerror=alert(1)>';
  const html = leasePoolBlock({ resourceLeases: { leases: [{ pool: 'serve-ports', item: '47100', project: evil, worker: evil, pane: evil, at: new Date().toISOString(), expiresAt: null, pid: evil, listener: false }] } }, pool);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('the pools editor sets the port list, idle minutes, wait default, and masked client values', () => {
  assert.match(app, /name="idleMinutes"/);
  assert.match(app, /name="waitSeconds"/);
  assert.match(app, /data-pool-env-add/);
  assert.match(app, /data-pool-env-change/);
  assert.match(app, /stored in the private config file on this machine only/);
  assert.match(app, /type="password"/);
  const help = fs.readFileSync(new URL('../public/setting-help.js', import.meta.url), 'utf8');
  for (const key of ['pool.ports', 'pool.idleMinutes', 'pool.waitSeconds', 'pool.portEnv']) assert.match(help, new RegExp(key.replace('.', '\\.')));
});

// ----- the tick probes -----

test('the engine probes at most 8 ports at a time and 25 for each tick, round robin, keyed by pool and item', async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const pools = validateResourcePools([
    { name: 'pool-a', range: '47500-47539', env: 'A_PORT', check: 'tcp' },
    { name: 'pool-b', range: '47500-47501', env: 'B_PORT', check: 'tcp' },
  ]).pools;
  const held = (pool, item) => ({ pool, item, project: 'project-a', worker: null, pane: 'ws:p2', at: new Date().toISOString(), expiresAt: null, borrowed: false });
  fs.writeFileSync(path.join(dataDir, 'leases.json'), JSON.stringify({ leases: [...pools[0].items.map((item) => held('pool-a', item)), held('pool-b', '47500')] }));
  const engine = new Engine(loadConfig(), { act: false, push: false });
  let inFlight = 0;
  let peak = 0;
  const probed = [];
  engine.collectors = { ...engine.collectors, probePort: async (port) => { inFlight += 1; peak = Math.max(peak, inFlight); probed.push(port); await new Promise((resolve) => setImmediate(resolve)); inFlight -= 1; return port === '47500' ? true : null; } };
  await engine.probeLeaseListeners(pools, 1000);
  assert.equal(probed.length, 25, 'at most 25 probes for one tick');
  assert.ok(peak <= 8 && peak > 1, `at most 8 at a time (peak ${peak})`);
  await engine.probeLeaseListeners(pools, 2000);
  assert.equal(probed.length, 50, 'the second tick probes 25 more, starting after the first 25');
  const keys = [...engine.leaseListeners.keys()];
  assert.equal(keys.length, 41, 'every leased port has an answer after two ticks');
  assert.ok(keys.includes('pool-a\n47500') && keys.includes('pool-b\n47500'), 'pools that share a port number keep separate answers');
  assert.equal(engine.leaseListeners.get('pool-a\n47501').value, null, 'a probe that cannot tell is unknown');
});

test('the engine source probes only on acting ticks and looks answers up by pool and item', () => {
  const source = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  assert.match(source, /if \(this\.act && this\.collectors\.probePort\) await this\.probeLeaseListeners/);
  assert.doesNotMatch(source, /endsWith\(`:\$\{port\}`\)/);
});
