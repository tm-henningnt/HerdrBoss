// The stand-down buttons of the Watch page. A stand-down parks the idle project orchestrators with the policy mode
// paused, and the undo restores the mode each project had. The routes use the same policy save path as the Allocation
// page, so every change reaches the policy change log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-standdown-data-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-standdown-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const [{ serve }, { loadConfig }, { clearNight, writeNight }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/night.js'),
]);

// Invented projects. alpha is idle, bravo has a worker that runs, charlie is already paused, and delta has an
// orchestrator that works. The last entry is the Boss workspace, which the stand-down never changes.
// The projects of the fake engine. A test adds a project before a press.
const PROJECTS = {
    alpha: { slug: 'alpha', workspace: 'ws-alpha', label: 'Alpha', mode: 'auto', effectiveMode: 'auto', running: 0, orch: { pane: 'w1', status: 'idle' } },
    bravo: { slug: 'bravo', workspace: 'ws-bravo', label: 'Bravo', mode: 'active', effectiveMode: 'active', running: 1, orch: { pane: 'w2', status: 'working' } },
    charlie: { slug: 'charlie', workspace: 'ws-charlie', label: 'Charlie', mode: 'paused', effectiveMode: 'paused', running: 0, orch: { pane: 'w3', status: 'idle' } },
    delta: { slug: 'delta', workspace: 'ws-delta', label: 'Delta', mode: 'auto', effectiveMode: 'auto', running: 0, orch: { pane: 'w4', status: 'working' } },
    echo: { slug: 'echo', workspace: 'ws-echo', label: 'Echo', mode: 'active', effectiveMode: 'active', running: 0, orch: { pane: 'w5', status: 'done' } },
    bossproject: { slug: 'bossproject', workspace: 'ws-boss', label: 'Boss', boss: true, mode: 'auto', effectiveMode: 'auto', running: 0, orch: { pane: 'w9', status: 'idle' } },
};

const PANES = [
  { id: 'w1', workspace: 'ws-alpha', label: 'orch', orch: true, agent: 'pi', status: 'idle' },
  { id: 'w6', workspace: 'ws-bravo', label: 'sd1', agent: 'pi', status: 'working' },
  { id: 'w2', workspace: 'ws-bravo', label: 'orch', orch: true, agent: 'pi', status: 'working' },
  { id: 'w3', workspace: 'ws-charlie', label: 'orch', orch: true, agent: 'pi', status: 'idle' },
  { id: 'w4', workspace: 'ws-delta', label: 'orch', orch: true, agent: 'pi', status: 'working' },
  { id: 'w5', workspace: 'ws-echo', label: 'orch', orch: true, agent: 'pi', status: 'done' },
  { id: 'w9', workspace: 'ws-boss', label: 'boss', orch: true, agent: 'pi', status: 'idle' },
];

function savedPolicy() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'policy.json'), 'utf8')); }
  catch { return { projects: {} }; }
}

// The fake engine reads the saved policy on each tick, so the routes see the mode of the previous change.
// shares sets the saved policy of the start: 'default' gives every project a share of 20, 'none' stores no project.
function startServer(t, { readOnlyPreview = false, shares = 'default', projects = PROJECTS, panes = PANES } = {}) {
  const stored = shares === 'none'
    ? {}
    : Object.fromEntries(Object.values(projects).filter((entry) => !entry.boss)
      .map((entry) => [entry.slug, { share: 20, mode: entry.mode, excludedKinds: [], excludedModels: [] }]));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify({ projects: stored }, null, 2)}\n`);
  fs.rmSync(path.join(dataDir, 'watch.json'), { force: true });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    liveDataDir: process.env.HERDR_BOSS_DIR,
    readOnlyPreview,
    createEngine: (config) => {
      const engine = new EventEmitter();
      engine.cfg = config;
      engine.memory = {};
      engine.log = () => {};
      engine.tick = async () => {
        const stored = savedPolicy().projects || {};
        // The derived share is the even share of the projects, so it is a fraction without a saved share.
        const derived = Object.fromEntries(Object.entries(projects).map(([slug, entry]) => [slug, { ...entry, share: entry.share ?? Math.round(1000 / Object.keys(projects).length) / 10, effectiveMode: stored[slug]?.mode ?? entry.effectiveMode }]));
        engine.state = { control: { projects: derived }, herdr: { panes }, night: { active: false } };
        return engine.state;
      };
      return engine;
    },
  });
  t.after(async () => { await close(); });
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  }).then(() => ({ base: `http://127.0.0.1:${server.address().port}`, server }));
}

// The stand-down routes change the policy, so the request carries the page caller label of a policy write.
function post(base, route) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-herdr-boss-caller': 'page' }, body: '{}' });
}

function policyChanges() {
  try {
    return fs.readFileSync(path.join(dataDir, 'policy-changes.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

test('a stand-down parks the idle projects and skips the ones that work', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  const response = await post(base, '/api/watch/standdown');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.paused.sort(), ['alpha', 'echo']);
  assert.deepEqual(result.skipped, [
    { slug: 'bravo', reason: 'worker running' },
    { slug: 'charlie', reason: 'already paused' },
    { slug: 'delta', reason: 'orchestrator working' },
  ]);

  const stored = savedPolicy().projects || {};
  assert.equal(stored.alpha.mode, 'paused');
  assert.equal(stored.echo.mode, 'paused');
  assert.equal(stored.bossproject, undefined, 'the Boss workspace is never changed');

  // watch.json keeps the previous mode of each changed project.
  const watch = JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(watch.standDown.at)), 'the stand-down stores its time');
  assert.deepEqual(watch.standDown.projects, { alpha: 'auto', echo: 'active' });
  const read = await (await fetch(`${base}/api/watch`)).json();
  assert.equal(read.active, false, 'the stand-down starts no watch');
  assert.deepEqual(read.standDown.projects, { alpha: 'auto', echo: 'active' }, 'the dashboard reads the stored mark');

  // The policy change log holds the change of the mode, with the page as the caller.
  const modeChange = policyChanges().flatMap((entry) => entry.changes).find((change) => change.key === 'projects.alpha.mode');
  assert.deepEqual(modeChange, { key: 'projects.alpha.mode', old: 'auto', new: 'paused' });
  assert.ok(policyChanges().some((entry) => entry.caller === 'page'), 'the stand-down uses the page save path');

  // A second stand-down changes nothing new. The stored projects keep their first previous mode.
  const again = await (await post(base, '/api/watch/standdown')).json();
  assert.deepEqual(again.paused, []);
  assert.deepEqual(again.skipped.map((item) => item.slug), ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8')).standDown.projects, { alpha: 'auto', echo: 'active' });
});

test('the undo restores only the projects that are still paused', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  await post(base, '/api/watch/standdown');
  // The Owner sets one project back to active with the Allocation page before the undo.
  const policy = savedPolicy();
  policy.projects.echo.mode = 'active';
  fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);

  const response = await post(base, '/api/watch/standdown/undo');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).restored, ['alpha']);
  const stored = savedPolicy().projects;
  assert.equal(stored.alpha.mode, 'auto', 'a parked project returns to its own mode');
  assert.equal(stored.echo.mode, 'active', 'a project that is no longer paused keeps its mode');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8')).standDown, undefined, 'the undo clears the mark');

  // A second undo has nothing to restore.
  assert.deepEqual((await (await post(base, '/api/watch/standdown/undo')).json()).restored, []);
});

test('the read-only preview refuses both routes', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { readOnlyPreview: true });
  assert.equal((await post(base, '/api/watch/standdown')).status, 403);
  assert.equal((await post(base, '/api/watch/standdown/undo')).status, 403);
});

const standDownMark = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8')).standDown;

// A project that falls idle after the first press. It is the last pane in PANES, so the clean up pops it.
function addFoxtrot() {
  PROJECTS.foxtrot = { slug: 'foxtrot', workspace: 'ws-foxtrot', label: 'Foxtrot', mode: 'active', effectiveMode: 'active', running: 0, orch: { pane: 'w7', status: 'idle' } };
  PANES.push({ id: 'w7', workspace: 'ws-foxtrot', label: 'orch', orch: true, agent: 'pi', status: 'idle' });
}

function removeFoxtrot() {
  delete PROJECTS.foxtrot;
  PANES.pop();
}

// Save the policy of a test.
function savePolicyFile(policy) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
}

test('a second press keeps the stored mode of the projects of the first press', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  assert.deepEqual((await (await post(base, '/api/watch/standdown')).json()).paused, ['alpha', 'echo']);
  const first = standDownMark();
  // The Owner resumes both projects by hand, then another project falls idle.
  const policy = savedPolicy();
  policy.projects.alpha.mode = 'auto';
  policy.projects.echo.mode = 'idle';
  savePolicyFile(policy);
  addFoxtrot();
  t.after(removeFoxtrot);
  const second = await (await post(base, '/api/watch/standdown')).json();
  assert.deepEqual(second.paused.sort(), ['alpha', 'echo', 'foxtrot']);
  const merged = standDownMark();
  assert.equal(merged.projects.alpha, 'auto', 'a project of the mark keeps the mode of the first press');
  assert.equal(merged.projects.echo, 'active', 'a project of the mark keeps the mode of the first press');
  assert.equal(merged.projects.foxtrot, 'active', 'a new project joins the mark');
  assert.deepEqual(Object.keys(merged.projects).sort(), [...Object.keys(first.projects), 'foxtrot'].sort());
});

test('a refused policy write keeps the stored mark', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  await post(base, '/api/watch/standdown');
  const before = standDownMark();
  // A saved policy that no write can pass. savePolicy answers with errors, so the route answers 400.
  const broken = savedPolicy();
  broken.maxWorkers = 999;
  broken.projects.alpha.mode = 'auto';
  broken.projects.echo.mode = 'active';
  savePolicyFile(broken);
  const refused = await post(base, '/api/watch/standdown');
  assert.equal(refused.status, 400, 'the invalid policy refuses the write');
  assert.deepEqual(standDownMark(), before, 'the refused write leaves the old mark');
  assert.equal(savedPolicy().projects.alpha.mode, 'auto', 'the refused write changes no mode');
});

test('a project without a saved share keeps the shares at 100', { timeout: 20000 }, async (t) => {
  const projects = {
    one: { slug: 'one', workspace: 'ws-one', label: 'One', mode: 'auto', effectiveMode: 'auto', running: 0, orch: { pane: 'p1', status: 'idle' } },
    two: { slug: 'two', workspace: 'ws-two', label: 'Two', mode: 'auto', effectiveMode: 'auto', running: 0, orch: { pane: 'p2', status: 'idle' } },
    three: { slug: 'three', workspace: 'ws-three', label: 'Three', mode: 'active', effectiveMode: 'active', running: 0, orch: { pane: 'p3', status: 'done' } },
  };
  const { base } = await startServer(t, { shares: 'none', projects, panes: [{ id: 'p1', workspace: 'ws-one', label: 'orch', orch: true, agent: 'pi', status: 'idle' }, { id: 'p2', workspace: 'ws-two', label: 'orch', orch: true, agent: 'pi', status: 'idle' }, { id: 'p3', workspace: 'ws-three', label: 'orch', orch: true, agent: 'pi', status: 'done' }] });
  const response = await post(base, '/api/watch/standdown');
  assert.equal(response.status, 200, 'a stand-down asks for no share confirmation');
  const stored = savedPolicy().projects;
  assert.deepEqual(Object.keys(stored).sort(), ['one', 'three', 'two']);
  const total = Object.values(stored).reduce((sum, entry) => sum + entry.share, 0);
  assert.equal(total, 100, `the saved shares add up to 100, not ${total}`);
  for (const entry of Object.values(stored)) assert.ok(Number.isInteger(entry.share), 'each share is a whole number');
  assert.equal(stored.one.mode, 'paused');
  assert.equal(stored.two.mode, 'paused');
  assert.equal(stored.three.mode, 'paused');
});

test('a stand-down keeps the saved shares of a policy that has them', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  const before = Object.fromEntries(Object.entries(savedPolicy().projects).map(([slug, entry]) => [slug, entry.share]));
  const response = await post(base, '/api/watch/standdown');
  assert.equal(response.status, 200);
  const after = Object.fromEntries(Object.entries(savedPolicy().projects).map(([slug, entry]) => [slug, entry.share]));
  assert.deepEqual(after, before, 'a stand-down changes no share');
});

test('a stand-down survives a start and a stop of the watch', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  await post(base, '/api/watch/standdown');
  const mark = standDownMark();
  const started = await fetch(`${base}/api/watch/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until: '23:30' }) });
  assert.equal(started.status, 200);
  assert.deepEqual(standDownMark(), mark, 'a watch start keeps the mark');
  const stopped = await post(base, '/api/watch/stop');
  assert.equal(stopped.status, 200);
  assert.deepEqual(standDownMark(), mark, 'a watch stop keeps the mark');
  // The CLI watch path calls the same two functions, so the command keeps the mark too.
  clearNight({ dataDir });
  assert.deepEqual(standDownMark(), mark, 'clearNight of the command keeps the mark');
  writeNight({ active: true, since: new Date().toISOString(), until: null }, { dataDir });
  assert.deepEqual(standDownMark(), mark, 'writeNight of the command keeps the mark');
});

test('the undo clears the mark when no project is still paused', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  await post(base, '/api/watch/standdown');
  const policy = savedPolicy();
  policy.projects.alpha.mode = 'active';
  policy.projects.echo.mode = 'idle';
  savePolicyFile(policy);
  const response = await post(base, '/api/watch/standdown/undo');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).restored, [], 'nothing is paused, so nothing is restored');
  assert.equal(standDownMark(), undefined, 'the undo clears the mark');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8')).active, false);
});

// The card of the Watch page, read from public/app.js in the style of the other view tests.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const body = (name) => { const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, `${name} exists`); return source.slice(start, source.indexOf('\n}\n', start)); };
function load(names, context = {}) {
  const ctx = { esc: (value) => String(value), watchLabel: (iso) => String(iso).slice(11, 16), standDownBusy: false, standDownMessage: '', ...context };
  vm.runInNewContext(`${names.map((name) => `${body(name)}\n}\n`).join('')}\nthis.fns = { ${names.join(', ')} };`, ctx);
  return ctx.fns;
}

test('the stand-down card shows the text, both buttons, and the skipped reasons', () => {
  const { standDownCard } = load(['standDownCard']);
  const html = standDownCard({ standDown: { at: '2026-10-01T20:15:00.000Z', projects: { alpha: 'auto' } } }, { paused: ['alpha'], skipped: [{ slug: 'bravo', reason: 'worker running' }] });
  assert.match(html, /Park the idle project leads\. Goals stay set\. Running work continues\./);
  assert.match(html, /data-stand-down="true"/);
  assert.match(html, /data-stand-down-undo="true"/);
  assert.match(html, /bravo: worker running/, 'the card shows each skipped project with its reason');
  assert.match(html, /20:15/, 'the card shows the time of the last stand-down');

  const fresh = standDownCard({ active: false }, null);
  assert.doesNotMatch(fresh, /data-stand-down-undo/, 'the undo button shows only after a stand-down');
});

test('the help of the Agents page names the stand-down buttons', () => {
  assert.match(source, /Stand down<\/b>[^<]*button|stand-down/, 'the page help has a stand-down entry');
  const help = /agents: \['Agents', `([\s\S]*?)`\],/.exec(source);
  assert.ok(help, 'the Agents help entry exists');
  assert.match(help[1], /<h3>Stand down<\/h3>/);
});