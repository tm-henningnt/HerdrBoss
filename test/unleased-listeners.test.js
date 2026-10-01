import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-unleased-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-unleased-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_LIVE_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';
// The test runner sets NODE_TEST_CONTEXT for each test file. One test reads the acting tick that sends the notice.
process.env.HERDR_BOSS_ALLOW_ACTIONS = '1';
process.on('exit', () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const [{ reconcileUnleasedListeners, markUnleasedNotified, projectOfCwd, listenerPid, processCwd, processLabel, unleasedNoticeText, UNLEASED_NOTICE_MINUTES }, { validateResourcePools, loadConfig }, { Engine }] = await Promise.all([
  import('../src/leases.js'),
  import('../src/config.js'),
  import('../src/engine.js'),
]);

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MINUTE = 60000;
const REPO = path.join(dataDir, 'repos', 'other-project');
const OTHER_REPO = path.join(dataDir, 'repos', 'third-project');
const base = { env: 'HERDR_SERVE_PORT' };
const poolOf = (spec, extra = {}) => validateResourcePools([{ ...base, ...spec, ...extra }]).pools[0];
const POOL = poolOf({ name: 'serve-ports', range: '47400-47402', check: 'tcp' });
const PROJECTS = [{ slug: 'other-project', path: REPO }, { slug: 'third-project', path: OTHER_REPO }];
const held = (item, extra = {}) => ({ pool: 'serve-ports', item, project: 'shop', worker: null, pane: 'w:p2', at: new Date(NOW).toISOString(), expiresAt: null, borrowed: false, ...extra });

// The three reads that name a process. A listener PID, the working directory of that PID, and the name of that PID.
function reads({ pid = 4242, cwd = path.join(REPO, 'src'), name = 'node' } = {}) {
  return {
    pidOf: (port) => (port === '47402' ? pid : null),
    cwdOf: () => cwd,
    labelOf: () => name,
  };
}

// Only the listed items answer a connection. Every other item is refused.
const listeningOn = (items, unknown = []) => async (item) => (items.includes(item) ? true : unknown.includes(item) ? null : false);

test('a free item with a listener shows the process, the owner, and the age of the listener', async () => {
  const state = new Map();
  const first = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort: listeningOn(['47402']), ...reads(), projectPaths: PROJECTS });
  assert.equal(first.unleased.length, 1);
  assert.deepEqual(first.unleased[0], {
    pool: 'serve-ports', item: '47402', pid: 4242, name: 'node',
    firstSeen: new Date(NOW).toISOString(), ageMinutes: 0, owner: 'other-project',
  });
  assert.deepEqual(first.notices, [], 'a young listener gets no notice');

  const later = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 7 * MINUTE, probePort: listeningOn(['47402']), ...reads(), projectPaths: PROJECTS });
  assert.equal(later.unleased[0].ageMinutes, 7);
  assert.equal(later.unleased[0].firstSeen, new Date(NOW).toISOString(), 'the age starts at the first tick that saw the listener');
  assert.deepEqual(later.notices, [], 'the listener is still younger than the notice age');
});

test('the record and the warning go when a lease takes the item', async () => {
  const state = new Map();
  await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort: listeningOn(['47402']), ...reads(), projectPaths: PROJECTS });
  assert.equal(state.size, 1);

  const leased = await reconcileUnleasedListeners({ pools: [POOL], leases: [held('47402')], state, now: NOW + MINUTE, probePort: listeningOn(['47402']), ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(leased.unleased, [], 'a leased item is not an unleased listener');
  assert.deepEqual(leased.notices, []);
  assert.equal(state.size, 0, 'the record of a leased item is cleared');

  const released = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 2 * MINUTE, probePort: listeningOn(['47402']), ...reads(), projectPaths: PROJECTS });
  assert.equal(released.unleased[0].ageMinutes, 0, 'the age starts again when no lease holds the item');
});

test('the record goes when the listener goes, so a later listener starts a new age', async () => {
  const state = new Map();
  const heard = ['47402'];
  const probePort = async (item) => (heard.includes(item) ? true : false);
  await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort, ...reads(), projectPaths: PROJECTS });
  await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 9 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });

  heard.length = 0;
  const gone = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 10 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(gone.unleased, [], 'a closed port is no listener');
  assert.equal(state.size, 0, 'the record of a closed port is cleared');

  heard.push('47402');
  const again = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 20 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(again.unleased[0].firstSeen, new Date(NOW + 20 * MINUTE).toISOString());
  assert.equal(again.unleased[0].ageMinutes, 0);
  assert.deepEqual(again.notices, [], 'the old age does not carry over to a new listener');
});

test('an unknown probe answer keeps the record and shows no warning', async () => {
  const state = new Map();
  const probePort = listeningOn(['47402'], ['47401']);
  await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort, ...reads(), projectPaths: PROJECTS });
  const timeout = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 11 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(timeout.unleased.length, 1, 'only the item that answers with a connection is a listener');
  assert.equal(timeout.unleased[0].item, '47402');
  assert.equal(state.size, 1, 'a timeout does not end the age of a listener');
  assert.deepEqual(timeout.notices.map((notice) => notice.item), ['47402'], 'the port 47401 timed out, so it never became a listener');
});

test('the owner gets one notice after the notice age, and the engine sends it once to the orchestrator pane', async () => {
  const state = new Map();
  const probePort = listeningOn(['47402']);
  const clean = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort, ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(clean.notices, []);

  const due = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + UNLEASED_NOTICE_MINUTES * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(due.notices.length, 1);
  assert.equal(due.notices[0].ageMinutes, 10);

  const text = unleasedNoticeText(due.notices[0]);
  assert.match(text, /Process 4242 \(node\) has listened on port 47402 of pool serve-ports for 10 minutes/);
  assert.match(text, /herdr-boss lease acquire serve-ports --for other-project --prefer 47402 --pid 4242/);
  assert.ok(text.includes('herdr-boss lease bind serve-ports 47402 --pid 4242'), 'the bind command follows the acquire command');

  const sent = [];
  const engine = new Engine(loadConfig(), { push: false, act: true });
  engine.push = true;
  // The service reconciles and marks in the same map, so the notice goes out once.
  engine.unleasedListeners = state;
  engine.herdrRunner = async (_command, args) => { sent.push(args); return '{}'; };
  const control = { projects: { 'other-project': { orch: { pane: 'w:orch' } } } };
  const panes = [{ id: 'w:orch', label: 'orch', agent: 'claude' }];
  await engine.notifyUnleasedOwners(due.notices, { control, panes });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 3), ['agent', 'prompt', 'w:orch']);
  assert.match(sent[0][3], /^\[herdr-boss\] /);

  const again = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 11 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(again.notices, [], 'a marked listener sends no second notice');

  // A missing orchestrator pane leaves the notice unmarked, so the next tick tries it again.
  const retry = new Map();
  await reconcileUnleasedListeners({ pools: [POOL], state: retry, now: NOW, probePort, ...reads(), projectPaths: PROJECTS });
  const dueAgain = await reconcileUnleasedListeners({ pools: [POOL], state: retry, now: NOW + UNLEASED_NOTICE_MINUTES * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(dueAgain.notices.length, 1);
  await engine.notifyUnleasedOwners(dueAgain.notices, { control: { projects: {} }, panes });
  assert.equal(sent.length, 1, 'a missing orchestrator pane adds no second notice');
  const still = await reconcileUnleasedListeners({ pools: [POOL], state: retry, now: NOW + 20 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(still.notices.length, 1, 'a notice that no pane received stays due');
  markUnleasedNotified(retry, still.notices[0]);
  const settled = await reconcileUnleasedListeners({ pools: [POOL], state: retry, now: NOW + 21 * MINUTE, probePort, ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(settled.notices, []);
});

test('the notice goes only to a live orchestrator pane', async () => {
  const engine = new Engine(loadConfig(), { push: false, act: true });
  engine.push = true;
  const sent = [];
  engine.herdrRunner = async (_command, args) => { sent.push(args); return '{}'; };
  const notices = [{ pool: 'serve-ports', item: '47402', pid: 4242, name: 'node', ageMinutes: 10, owner: 'other-project' }];
  const control = { projects: { 'other-project': { orch: { pane: 'w:orch' } } } };
  await engine.notifyUnleasedOwners(notices, { control, panes: [{ id: 'w:worker', label: 'worker', agent: 'claude' }] });
  assert.deepEqual(sent, [], 'a pane that is not labelled orch receives nothing');
  await engine.notifyUnleasedOwners(notices, { control, panes: [{ id: 'w:orch', label: 'orch' }] });
  assert.deepEqual(sent, [], 'a pane without an agent receives nothing');
  await engine.notifyUnleasedOwners(notices, { control, panes: [{ id: 'w:other', label: 'orch', agent: 'claude' }] });
  assert.deepEqual(sent, [], 'another pane than the control names receives nothing');
});

test('an unknown owner gives a warning and no notice', async () => {
  const state = new Map();
  const probePort = listeningOn(['47402']);
  const outside = { ...reads({ cwd: path.join(dataDir, 'elsewhere') }) };
  const fresh = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort, ...outside });
  assert.equal(fresh.unleased[0].owner, null);
  assert.equal(fresh.unleased[0].pid, 4242, 'the page still shows which process holds the port');
  const due = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 30 * MINUTE, probePort, ...outside });
  assert.equal(due.unleased[0].owner, null);
  assert.equal(due.unleased[0].ageMinutes, 30);
  assert.deepEqual(due.notices, [], 'a listener with no known owner gets no notice');

  const sibling = await reconcileUnleasedListeners({ pools: [POOL], state: new Map(), now: NOW, probePort, ...reads({ cwd: `${REPO}-other/src` }), projectPaths: PROJECTS });
  assert.equal(sibling.unleased[0].owner, null, 'a path that only starts with a project path is not inside it');
});

test('a process without a listener PID gives a warning and no notice', async () => {
  const state = new Map();
  const probePort = listeningOn(['47402']);
  const withoutLsof = { pidOf: () => null, cwdOf: () => null, labelOf: () => null };
  const found = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW, probePort, ...withoutLsof });
  assert.equal(found.unleased[0].pid, null);
  assert.equal(found.unleased[0].name, null);
  assert.equal(found.unleased[0].owner, null);
  const due = await reconcileUnleasedListeners({ pools: [POOL], state, now: NOW + 30 * MINUTE, probePort, ...withoutLsof });
  assert.deepEqual(due.notices, [], 'lsof cannot name the process, so no notice goes out');
});

test('one tick probes every free item of a ports pool once, at most 8 at a time, and skips the pools with no idle rule', async () => {
  const big = poolOf({ name: 'big-ports', range: '47500-47519', check: 'tcp' });
  const cdp = poolOf({ name: 'cdp-ports', range: '47600-47601', check: 'cdp' });
  const browser = { name: 'project-browsers', builtIn: true, items: ['9223'], check: 'cdp' };
  const pools = [big, cdp, browser, POOL];
  const probed = [];
  let inFlight = 0;
  let peak = 0;
  const probePort = async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    probed.push(item);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return false;
  };
  await reconcileUnleasedListeners({ pools, state: new Map(), now: NOW, probePort, ...reads(), projectPaths: PROJECTS });
  assert.equal(probed.length, 23, 'the 20 items of the big pool and the 3 items of serve-ports');
  assert.equal(new Set(probed).size, probed.length, 'no item is probed twice in one tick');
  assert.ok(peak <= 8 && peak > 1, `at most 8 probes at a time (peak ${peak})`);
  assert.equal(probed.includes('47600'), false, 'a cdp pool has no idle rule, so its items are not probed');
  assert.equal(probed.includes('9223'), false, 'the built-in browser pool is not probed');
});

test('a wide pool gives every item one probe in one tick, and finds the one listener at its end', async () => {
  const pools = [poolOf({ name: 'wide', range: '47700-47799', check: 'tcp' })];
  const probed = [];
  const result = await reconcileUnleasedListeners({
    pools, state: new Map(), now: NOW,
    probePort: async (item) => { probed.push(item); return item === '47799'; }, ...reads(), projectPaths: PROJECTS,
  });
  assert.equal(probed.length, 100, 'every item of the pool gets a probe');
  assert.equal(new Set(probed).size, 100, 'no item is probed twice in one tick');
  assert.deepEqual(result.unleased.map((entry) => entry.item), ['47799'], 'the listener at the end of the range is found');
});

test('projectOfCwd holds the project path itself, a child path, and nothing else', () => {
  assert.equal(projectOfCwd(REPO, PROJECTS), 'other-project');
  assert.equal(projectOfCwd(`${REPO}/src/pages`, PROJECTS), 'other-project');
  assert.equal(projectOfCwd(OTHER_REPO, PROJECTS), 'third-project');
  assert.equal(projectOfCwd(path.dirname(REPO), PROJECTS), null);
  assert.equal(projectOfCwd(`${REPO}-copy`, PROJECTS), null);
  assert.equal(projectOfCwd(null, PROJECTS), null);
  assert.equal(projectOfCwd(REPO, []), null, 'an empty registry has no owner');
});

test('without lsof the process reads give null instead of a guess', () => {
  assert.equal(listenerPid('47402', { hasLsof: false }), null);
  assert.equal(processCwd(4242, { hasLsof: false }), null);
  assert.equal(listenerPid(null, { hasLsof: true }), null, 'no port names no PID');
  assert.equal(processCwd(null, { hasLsof: true }), null, 'no PID names no working directory');
  assert.equal(processLabel(undefined), null);
  assert.match(String(processLabel(process.pid)), /node/, 'ps gives the name of this test runner');
});

test('the source names a process with lsof and ps, and never reads a command line or an environment', () => {
  const source = fs.readFileSync(new URL('../src/leases.js', import.meta.url), 'utf8');
  assert.match(source, /lsofOutput\(\['-nP', `-iTCP:\$\{port\}`, '-sTCP:LISTEN', '-Fp'\]\)/, 'the listener PID comes from lsof with a field list');
  assert.match(source, /lsofOutput\(\['-a', '-p', String\(pid\), '-d', 'cwd', '-Fn'\]\)/, 'the working directory comes from lsof with a field list');
  assert.match(source, /spawnSync\('ps', \['-o', 'comm=', '-p', String\(pid\)\]/, 'the process name comes from ps with a name column only');
  // The banned forms list or dump a command line or an environment.
  for (const banned of ["'command='", "'args='", "'aux'", "'-ef'", "'-E'", "'eww'", "'-ww'"]) {
    assert.equal(source.includes(banned), false, `leases.js must not run ps with ${banned}`);
  }
  assert.equal(/spawnSync\('ps', \[(?!'-o')/.test(source), false, 'every ps call names the columns it wants');
  assert.equal(source.includes("spawnSync('sh'"), false, 'no shell reads a process table');
});

test('the state API carries the unleased listeners of the tick', async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const repo = path.join(dataDir, 'repos', 'shop');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'project-repos.json'), `${JSON.stringify([{ slug: 'shop', repo }])}\n`);
  fs.writeFileSync(path.join(dataDir, 'leases.json'), `${JSON.stringify({ leases: [held('47400', { pane: null })] })}\n`);
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify({ host: '127.0.0.1', port: 0, tickSeconds: 3600, resourcePools: [{ name: 'serve-ports', range: '47400-47402', env: 'HERDR_SERVE_PORT', ttlMinutes: 240, check: 'tcp', graceMinutes: 10 }] })}\n`, { mode: 0o600 });
  const cfg = loadConfig();
  cfg.browsers.reapOrphanDaemons = false;
  const engine = new Engine(cfg, { push: false, act: true, collectors: {
    collectHerdr: async () => ({ workspaces: [], panes: [] }),
    collectMachine: async () => null,
    collectProcesses: async () => new Map(),
    collectQuotas: async () => null,
    collectPiModels: async () => null,
    collectWorktreeCounts: async () => ({}),
    collectCwdProcesses: async () => [],
    collectMissingWorktreeProcesses: async () => [],
    readWorkerScreen: async () => '',
    codeSignCloneDir: () => null,
    runSpendScan: async () => null,
    runDenialScan: async () => null,
    probePort: async (item) => (item === '47402' ? true : false),
    listenerPid: (item) => (item === '47402' ? 4242 : null),
    processCwd: () => path.join(repo, 'src'),
    processLabel: () => 'node',
  } });
  engine.push = true;
  // The tick asks git for the kit and delivers watch routines. Both stay inside this test.
  engine.gitRunner = async () => '{}';
  engine.readKitNotice = async () => {};
  engine.deliver = async () => {};
  engine.deliverWatchRoutines = async () => {};
  const sent = [];
  engine.herdrRunner = async (_command, args) => { sent.push(args); return '{}'; };
  await engine.tick();
  const state = engine.state;
  assert.equal(state.resourceLeases.unleased.length, 1, 'the listener of the free item is in the state API');
  assert.equal(state.resourceLeases.unleased[0].item, '47402');
  assert.equal(state.resourceLeases.unleased[0].pid, 4242);
  assert.equal(state.resourceLeases.unleased[0].name, 'node');
  assert.equal(state.resourceLeases.unleased[0].owner, 'shop');
  assert.equal(state.resourceLeases.unleased[0].ageMinutes, 0);
  assert.match(state.resourceLeases.unleased[0].firstSeen, /^2026|^\d{4}-/, 'firstSeen is an ISO time');
  assert.equal(state.resourceLeases.leases.length, 1);
  assert.equal(state.resourceLeases.leases[0].item, '47400');
  assert.equal(sent.length, 0, 'a young listener sends no notice from the tick');
  assert.equal(engine.events.some((event) => event.type === 'tick-error'), false, JSON.stringify(engine.events.filter((event) => event.type === 'error').map((event) => event.text)));
});

test('a listener on a leased item never reaches the state API', async () => {
  const state = new Map();
  const leased = await reconcileUnleasedListeners({ pools: [POOL], leases: [held('47400'), held('47401')], state, now: NOW, probePort: listeningOn(['47400', '47401', '47402']), ...reads(), projectPaths: PROJECTS });
  assert.deepEqual(leased.unleased.map((entry) => entry.item), ['47402']);
  assert.equal(state.size, 1);
});

test('the engine reconciles the listeners on the tick that probes the leases, and never on an inactive tick', () => {
  const source = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  assert.match(source, /if \(this\.act && this\.collectors\.probePort\)[\s\S]{0,200}reconcileUnleasedListeners/);
  assert.match(source, /this\.notifyUnleasedOwners\(unleasedNotices, \{ control, panes: herdr\.panes \}\)/);
  assert.equal(source.includes('setInterval'), false, 'the check starts no loop of its own');
});
