import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createFleetGuideAccess, createFleetReadAccess } from '../src/fleet-access.js';
import { writeFleetFile } from '../src/fleet-store.js';
import { appendMessage, readMessages } from '../src/messages.js';
import { installedKitRevision, kitRevision } from '../src/kit/agents-check.js';
import { startWorker } from '../src/kit/workers.js';
import { recordProjectRepo } from '../src/harness.js';
import { writeProject } from '../src/projects.js';
import { createProjectTransferLock, readProjectTransferLock } from '../src/project-transfer-locks.js';
import { createProjectTransfer, projectTransferCommand, projectTransferRoot } from '../src/project-transfer.js';
import { serve } from '../src/server.js';
import { FACTORY_PROJECT_GROUP } from '../src/factory-role.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
const SOURCE_ID = 'factory-source';
const TARGET_ID = 'factory-target';
const SOURCE_NAME = 'factory-one';
const TARGET_NAME = 'factory-two';
const DASHBOARD = 'https://factory-two.example.invalid';
const GUIDE = `hf_guide_${randomBytes(32).toString('hex')}`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fakeHerdr({ workspaces = [], panes = [], agentStatus = 'working', events = [] } = {}) {
  const calls = [];
  const state = { workspaces: [...workspaces], panes: [...panes], prompts: [] };
  const run = (args) => {
    calls.push(args);
    const [area, action] = args;
    if (area === 'workspace' && action === 'list') return { workspaces: state.workspaces };
    if (area === 'workspace' && action === 'create') {
      const id = `workspace-${state.workspaces.length + 1}`;
      const paneId = `${id}:pane-1`;
      const workspace = { workspace_id: id, label: args[args.indexOf('--label') + 1] };
      const pane = { pane_id: paneId, tab_id: `${id}:tab-1`, workspace_id: id, label: null, agent: null, foreground_cwd: args[args.indexOf('--cwd') + 1] };
      state.workspaces.push(workspace); state.panes.push(pane);
      return { workspace, root_pane: pane };
    }
    if (area === 'pane' && action === 'list') {
      const workspace = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
      return { panes: state.panes.filter((pane) => !workspace || pane.workspace_id === workspace) };
    }
    if (area === 'pane' && action === 'get') {
      const pane = state.panes.find((row) => row.pane_id === args[2]);
      if (!pane) { const error = new Error('pane not found'); error.code = 'pane_not_found'; throw error; }
      return { pane };
    }
    if (area === 'pane' && action === 'rename') {
      state.panes.find((row) => row.pane_id === args[2]).label = args[3];
      return {};
    }
    if (area === 'pane' && action === 'read') return { text: '' };
    if (area === 'pane' && action === 'close') {
      events.push(`pane close ${args[2]}`);
      const pane = state.panes.find((row) => row.pane_id === args[2]);
      state.panes = state.panes.filter((row) => row.pane_id !== args[2]);
      if (pane && !state.panes.some((row) => row.workspace_id === pane.workspace_id)) {
        state.workspaces = state.workspaces.filter((row) => row.workspace_id !== pane.workspace_id);
      }
      return {};
    }
    if (area === 'agent' && action === 'start') {
      const pane = state.panes.find((row) => row.pane_id === args[args.indexOf('--pane') + 1]);
      pane.agent = args[args.indexOf('--kind') + 1]; pane.agent_name = args[2]; pane.agent_status = 'idle';
      return { agent: { name: args[2] } };
    }
    if (area === 'agent' && action === 'get') return { agent: { agent_status: typeof agentStatus === 'function' ? agentStatus(args[2], state) : agentStatus } };
    if (area === 'agent' && action === 'prompt') { state.prompts.push(args[3]); return {}; }
    throw new Error(`Unexpected fake Herdr call: ${args.slice(0, 2).join(' ')}`);
  };
  run.calls = calls;
  run.state = state;
  return run;
}

function fixture({ sourceKit = kitRevision(), targetKit = sourceKit, runningWorkers = [], dashboardUrl = DASHBOARD, sourceOptions = {}, targetOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-transfer-'));
  const sourceData = path.join(root, 'source-data');
  const targetData = path.join(root, 'target-data');
  const sourcePrivate = path.join(root, 'source-private');
  const targetPrivate = path.join(root, 'target-private');
  const sourceRoot = path.join(root, 'source-projects');
  const targetRoot = path.join(root, 'target-projects');
  const repo = path.join(sourceRoot, 'alpha');
  const remote = path.join(root, 'fake-github.git');
  const sequence = [];
  const herdr = fakeHerdr({ events: sequence });
  const sourceHerdr = fakeHerdr({
    workspaces: [{ workspace_id: 'source-workspace', label: 'alpha' }],
    panes: [{ pane_id: 'source-pane', workspace_id: 'source-workspace', label: 'orch', agent: 'codex', agent_name: 'alpha-orch' }],
    agentStatus: (name, state) => state.panes.some((row) => row.agent_name === name) ? 'idle' : 'working',
    events: sequence,
  });
  for (const dir of [sourceData, targetData, sourcePrivate, targetPrivate, sourceRoot, targetRoot]) fs.mkdirSync(dir, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  fs.mkdirSync(path.join(repo, 'docs', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Sample project\n');
  fs.writeFileSync(path.join(repo, 'docs', 'orchestration', 'memory.md'), '# Project memory\nRead the current task before work.\n');
  fs.writeFileSync(path.join(repo, 'docs', 'orchestration', 'herdr-boss.md'), '<!-- old kit -->\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Alpha\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Set up sample project');
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '--set-upstream', 'origin', 'main');
  recordProjectRepo('alpha', repo, remote, { dataDir: sourceData });
  writeProject('alpha', { project: 'Alpha', summary: 'Sample project.', kitRevision: sourceKit, tasks: [], workspace: 'source-workspace' }, { dir: path.join(sourceData, 'projects') });
  fs.writeFileSync(path.join(sourcePrivate, 'fleet-guide-remotes.json'), JSON.stringify({ [TARGET_ID]: GUIDE }));

  const target = createProjectTransfer({
    role: 'target', dataDir: targetData, privateDir: targetPrivate,
    settings: () => ({ factoryId: TARGET_ID, name: TARGET_NAME }),
    projectRoot: targetRoot, kitRevision: () => targetKit, herdr,
    hooks: { waitForPane: () => {}, waitForReady: () => true, readText: () => '', wait: () => {} },
    env: { ...process.env, HOME: root, HERDR_BOSS_DIR: targetData, HERDR_ENV: '1' },
    allowGitRemote: () => true,
    ...targetOptions,
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    sequence.push('target request');
    assert.equal(options.headers.authorization, `Bearer ${GUIDE}`);
    assert.equal(options.redirect, 'error');
    const query = new URL(url).searchParams;
    const result = options.method === 'GET'
      ? target.jobStatus(query.get('slug'), query.get('jobId')) : await target.submit(JSON.parse(options.body));
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
  };
  const source = createProjectTransfer({
    role: 'source', dataDir: sourceData, privateDir: sourcePrivate,
    settings: () => ({ factoryId: SOURCE_ID, name: SOURCE_NAME }),
    factories: [{ factoryId: TARGET_ID, name: TARGET_NAME, dashboardUrl, kitRevision: targetKit }],
    projectRoot: sourceRoot, kitRevision: () => sourceKit, fetchImpl, herdr: sourceHerdr,
    hooks: { waitForPane: () => {}, waitForReady: () => true, readText: () => '', wait: () => {} },
    env: { ...process.env, HOME: root, HERDR_BOSS_DIR: sourceData },
    allowGitRemote: () => true,
    getRunningWorkers: () => runningWorkers,
    pollIntervalMs: 0,
    ...sourceOptions,
  });
  return { root, sourceData, targetData, sourcePrivate, targetPrivate, sourceRoot, targetRoot, repo, remote, herdr, sourceHerdr, source, target, calls, sequence,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function command(service, action, f, log = []) {
  const code = await projectTransferCommand([action, 'alpha', '--to', TARGET_NAME], { service, log: (line) => log.push(line) });
  return { code, text: log.join('\n') };
}

function decide(f, text) {
  const ask = readMessages({ dir: f.sourceData }).find((row) => row.from === 'boss' && row.action === 'decide' && row.text.includes('switch project alpha'));
  assert.ok(ask, 'transfer must ask the Owner through the source Mailbox');
  appendMessage({ thread: 'boss', from: 'owner', to: 'boss', kind: 'reply', text, replyTo: ask.id, action: 'answer', status: 'new' }, { dir: f.sourceData });
}

test('a slow start polls the accepted target job until the project lead is ready', async (t) => {
  let elapsed = 0;
  let polls = 0;
  let f;
  const jobId = '00000000-0000-4000-8000-000000000021';
  f = fixture({ sourceOptions: {
    timeoutMs: 100, pollIntervalMs: 10, now: () => elapsed,
    wait: async (ms) => { elapsed += ms; },
    fetchImpl: async (url, options) => {
      let result;
      if (options.method === 'GET') {
        const query = new URL(url).searchParams;
        assert.equal(query.get('jobId'), jobId);
        assert.equal(query.get('slug'), 'alpha');
        polls += 1;
        result = { status: polls < 3 ? 202 : 200, body: { ok: true, factoryId: TARGET_ID,
          status: polls < 3 ? 'starting' : 'pending', jobId } };
      } else if (JSON.parse(options.body).action === 'start') {
        result = { status: 202, body: { ok: true, factoryId: TARGET_ID, status: 'starting', jobId } };
      } else result = await f.target.handle(JSON.parse(options.body));
      return Response.json(result.body, { status: result.status });
    },
  } });
  t.after(f.cleanup);
  const result = await command(f.source, 'start', f);
  assert.equal(result.code, 3, result.text);
  assert.equal(polls, 3);
  assert.equal(elapsed, 30);
  assert.match(result.text, /target project lead is ready/i);
});

test('a start deadline keeps the same transfer locked for retry and prints the working message', async (t) => {
  let elapsed = 0;
  let f;
  const ids = [];
  f = fixture({ sourceOptions: {
    timeoutMs: 25, pollIntervalMs: 10, now: () => elapsed,
    wait: async (ms) => { elapsed += ms; },
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (body?.action === 'plan') {
        const result = await f.target.handle(body);
        return Response.json(result.body, { status: result.status });
      }
      if (body) ids.push(body.transferId);
      return Response.json({ ok: true, factoryId: TARGET_ID, status: 'starting', jobId: ids.at(-1) }, { status: 202 });
    },
  } });
  t.after(f.cleanup);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await command(f.source, 'start', f);
    assert.equal(result.code, 1);
    assert.equal(result.text, 'Error: The target is still working. Run the same command again.');
    assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }).transferId, ids[0]);
  }
  assert.equal(elapsed, 50);
  assert.deepEqual(ids, [ids[0], ids[0]]);
  assert.equal(f.sourceHerdr.calls.filter((args) => args[0] === 'pane' && args[1] === 'close').length, 1);
});

test('a connection failure keeps the unreachable message while a start abort reports working', async (t) => {
  let fail = false;
  let abort = false;
  let f;
  f = fixture({ sourceOptions: { fetchImpl: async (url, options) => {
    if (fail) throw new TypeError('Connection refused');
    const body = JSON.parse(options.body);
    if (abort && body.action === 'start') throw new DOMException('Deadline passed', 'TimeoutError');
    const result = await f.target.handle(body);
    return Response.json(result.body, { status: result.status });
  } } });
  t.after(f.cleanup);
  fail = true;
  const unreachable = await command(f.source, 'plan', f);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.text, /target factory could not be reached/);
  fail = false; abort = true;
  const timedOut = await command(f.source, 'start', f);
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.text, 'Error: The target is still working. Run the same command again.');
  fail = true;
  const disconnected = await command(f.source, 'start', f);
  assert.match(disconnected.text, /target factory could not be reached/);
  assert.doesNotMatch(disconnected.text, /target is still working/);
});

test('start uses 300 seconds and plan, switch, and cancel use 30 seconds', async (t) => {
  const timeouts = [];
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return original.call(AbortSignal, ms); });
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'plan', f)).code, 0);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  decide(f, 'Accept the switch');
  assert.equal((await command(f.source, 'switch', f)).code, 0);
  const g = fixture(); t.after(g.cleanup);
  assert.equal((await command(g.source, 'start', g)).code, 3);
  assert.equal((await command(g.source, 'cancel', g)).code, 0);
  assert.deepEqual(timeouts, [30000, 30000, 300000, 30000, 30000, 300000, 30000]);
});

async function finishedJob(target, slug, jobId) {
  for (;;) {
    const result = target.jobStatus(slug, jobId);
    if (result.status !== 202) return result;
    await nextTurn();
  }
}

test('production import work runs off the request thread and leaves a failed clone resumable', { timeout: 20000 }, async (t) => {
  const f = fixture();
  const bin = path.join(f.root, 'fake-bin');
  fs.mkdirSync(bin);
  let markStarted;
  let socket;
  let released = false;
  const entered = new Promise((resolve) => { markStarted = resolve; });
  const bridge = net.createServer((connection) => {
    socket = connection; markStarted();
    if (released) socket.end('finish clone');
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const release = () => { released = true; socket?.end('finish clone'); };
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
import fs from 'node:fs';
import net from 'node:net';
if (process.argv[2] === 'clone') {
  fs.mkdirSync(process.argv.at(-1), { recursive: true });
  const socket = net.connect(${bridge.address().port}, '127.0.0.1');
  socket.on('data', () => { socket.end(); process.exitCode = 1; });
}
`, { mode: 0o700 });
  const target = createProjectTransfer({ role: 'target', dataDir: f.targetData, projectRoot: f.targetRoot,
    privateDir: f.targetPrivate, settings: () => ({ factoryId: TARGET_ID, name: TARGET_NAME }),
    kitRevision: kitRevision, env: { ...process.env, HOME: f.root, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const body = { action: 'start', slug: 'alpha', transferId: '00000000-0000-4000-8000-000000000026',
    sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME, sourceKitRevision: kitRevision(),
    sourceRemote: 'https://github.com/example/alpha.git' };
  t.after(async () => {
    release();
    await finishedJob(target, body.slug, body.transferId);
    await new Promise((resolve) => bridge.close(resolve)); f.cleanup();
  });
  assert.equal((await target.submit(body)).status, 202);
  await entered;
  assert.equal(target.jobStatus(body.slug, body.transferId).status, 202);
  assert.equal((await target.submit(body)).status, 202);
  release();
  const result = await finishedJob(target, body.slug, body.transferId);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /could not be cloned/);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }).transferId, body.transferId);
});

test('the target accepts one background import and returns its result on repeated start', async (t) => {
  let release;
  let installing;
  let installs = 0;
  const entered = new Promise((resolve) => { installing = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ targetOptions: { install: async () => { installs += 1; installing(); await gate; } } });
  const body = { action: 'start', slug: 'alpha', transferId: '00000000-0000-4000-8000-000000000022',
    sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME, sourceKitRevision: kitRevision(), sourceRemote: f.remote };
  t.after(async () => { release(); await finishedJob(f.target, body.slug, body.transferId); f.cleanup(); });
  const accepted = await f.target.submit(body);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.jobId, body.transferId);
  await entered;
  assert.equal((await f.target.submit(body)).status, 202);
  assert.equal(f.target.jobStatus('alpha', body.transferId).status, 202);
  release();
  const complete = await finishedJob(f.target, 'alpha', body.transferId);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.status, 'pending');
  assert.equal((await f.target.submit(body)).body.status, 'pending');
  assert.equal(installs, 1);
  assert.equal(f.herdr.state.prompts.length, 1);
});

test('retry resumes the owned half-finished clone after a failed kit install', async (t) => {
  let installs = 0;
  const f = fixture({ targetOptions: { install: () => { if (++installs === 1) throw new Error('Kit installation interrupted.'); } } });
  t.after(f.cleanup);
  const failed = await command(f.source, 'start', f);
  assert.equal(failed.code, 1);
  const repo = path.join(f.targetRoot, 'alpha');
  assert.equal(fs.existsSync(path.join(repo, '.git')), true);
  const lock = readProjectTransferLock('alpha', { dataDir: f.targetData });
  assert.ok(lock);
  fs.writeFileSync(path.join(repo, 'resume-marker'), 'owned clone');
  const result = await command(f.source, 'start', f);
  assert.equal(result.code, 3, result.text);
  assert.equal(fs.readFileSync(path.join(repo, 'resume-marker'), 'utf8'), 'owned clone');
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }).transferId, lock.transferId);
  assert.equal(f.herdr.state.prompts.length, 1);
  assert.equal(installs, 2);
});

test('retry resumes a half-started project lead without starting a second agent', async (t) => {
  let readyChecks = 0;
  const f = fixture({ targetOptions: { hooks: {
    waitForPane: () => {}, readText: () => '', wait: () => {},
    waitForReady: () => { if (++readyChecks === 1) throw new Error('Project lead startup interrupted.'); return true; },
  } } });
  t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 1);
  const stateFile = path.join(f.targetData, 'project-transfers', 'alpha.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.status, 'starting');
  assert.equal(state.workspace.agentStarted, true);
  const result = await command(f.source, 'start', f);
  assert.equal(result.code, 3, result.text);
  assert.equal(f.herdr.calls.filter((args) => args[0] === 'agent' && args[1] === 'start').length, 1);
  assert.equal(f.herdr.state.workspaces.length, 1);
  assert.equal(f.herdr.state.prompts.length, 1);
});

test('retry replaces an interrupted clone owned by the same transfer', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const body = { action: 'start', slug: 'alpha', transferId: '00000000-0000-4000-8000-000000000023',
    sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME, sourceKitRevision: kitRevision(), sourceRemote: f.remote };
  const repo = path.join(f.targetRoot, 'alpha');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'incomplete-clone'), 'partial clone');
  fs.mkdirSync(path.join(f.targetData, 'project-transfers'));
  fs.writeFileSync(path.join(f.targetData, 'project-transfers', 'alpha.json'), JSON.stringify({ schema: 1,
    slug: 'alpha', transferId: body.transferId, status: 'starting', toFactory: TARGET_NAME,
    sourceFactoryId: SOURCE_ID, targetFactoryId: TARGET_ID, repoPath: repo, workspace: {} }));
  createProjectTransferLock('alpha', { transferId: body.transferId, side: 'target', peerFactoryId: SOURCE_ID, dataDir: f.targetData });
  const result = await f.target.handle(body);
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.status, 'pending');
  assert.equal(fs.existsSync(path.join(repo, '.git')), true);
  assert.equal(fs.existsSync(path.join(repo, 'incomplete-clone')), false);
});

test('plan checks both factories and a reachable remote without changing either factory', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const before = [fs.readdirSync(f.sourceData), fs.readdirSync(f.targetData), fs.readdirSync(f.targetRoot)];
  const { code, text } = await command(f.source, 'plan', f);
  assert.equal(code, 0, text);
  assert.match(text, /Transfer plan for alpha/);
  assert.match(text, /factory-two/);
  assert.match(text, /kit.*match/i);
  assert.match(text, /remote.*reachable/i);
  assert.doesNotMatch(text, /factory-two\.example|hf_guide_|fake-github/);
  assert.deepEqual([fs.readdirSync(f.sourceData), fs.readdirSync(f.targetData), fs.readdirSync(f.targetRoot)], before);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }), null);
});

test('plan names HTTPS and factory connect when the registered dashboard uses plain HTTP', async (t) => {
  const f = fixture({ dashboardUrl: 'http://factory-two.example.invalid:4478' }); t.after(f.cleanup);
  const { code, text } = await command(f.source, 'plan', f);
  assert.equal(code, 1);
  assert.match(text, /safe dashboard connection/);
  assert.match(text, /HTTPS.*factory connect factory-two/);
  assert.doesNotMatch(text, /factory-two\.example|hf_guide_/);
  assert.equal(f.calls.length, 0);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
});

test('start clones, installs the kit, creates a fresh project lead, asks the Owner, and locks both projects', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { code, text } = await command(f.source, 'start', f);
  assert.equal(code, 3, text);
  assert.match(text, /Owner.*Mailbox|Mailbox.*Owner/i);
  const cloned = path.join(f.targetRoot, 'alpha');
  assert.equal(fs.readFileSync(path.join(cloned, 'docs', 'orchestration', 'memory.md'), 'utf8'), '# Project memory\nRead the current task before work.\n');
  assert.equal(installedKitRevision(cloned), kitRevision());
  assert.ok(fs.existsSync(path.join(f.targetData, 'projects', 'alpha.json')));
  assert.equal(fs.existsSync(path.join(f.targetData, 'project-repos.json')), true);
  assert.equal(f.herdr.state.prompts.length, 1);
  assert.match(f.herdr.state.prompts[0], /docs\/orchestration\/memory\.md/);
  assert.ok(f.sequence.indexOf('pane close source-pane') < f.sequence.lastIndexOf('target request'), 'source lead closes before target preparation');
  assert.equal(f.sourceHerdr.state.panes.some((pane) => pane.pane_id === 'source-pane'), false);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }).side, 'source');
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }).side, 'target');
  assert.ok(fs.existsSync(path.join(f.sourceData, 'project-transfers', 'audit.jsonl')));
  assert.ok(fs.existsSync(path.join(f.targetData, 'project-transfers', 'audit.jsonl')));
  assert.equal(new URL(f.calls.at(-1).url).pathname, '/api/fleet/transfer');
  assert.equal(f.calls.at(-1).options.method, 'GET');
});

test('the accepted Mailbox decision switches ownership and marks the source project transferred', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  decide(f, 'Accept the switch.');
  const { code, text } = await command(f.source, 'switch', f);
  assert.equal(code, 0, text);
  const sourceStatus = JSON.parse(fs.readFileSync(path.join(f.sourceData, 'projects', 'alpha.json'), 'utf8'));
  assert.equal(sourceStatus.transfer.status, 'transferred');
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }), null);
  assert.ok(readMessages({ dir: f.sourceData }).find((row) => row.action === 'decide')?.closedAt);
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-one', HERDR_WORKSPACE_ID: 'workspace-one', HERDR_BOSS_DIR: f.sourceData };
  const herdr = (args) => args[0] === 'pane' && args[1] === 'get' ? { pane: { pane_id: 'pane-one', workspace_id: 'workspace-one', label: 'orch' } } : {};
  assert.throws(() => startWorker('sample-worker', { kind: 'codex', task: 'sample task', readOnly: true }, { config: { slug: 'alpha', root: f.repo }, env, herdr }), /transferred/i);
  assert.match(fs.readFileSync(path.join(f.sourceData, 'project-transfers', 'audit.jsonl'), 'utf8'), /switched/);
  assert.match(fs.readFileSync(path.join(f.targetData, 'project-transfers', 'audit.jsonl'), 'utf8'), /switched/);
});

test('cancel removes the target record and clone, and keeps private and Owner data at the source', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  fs.writeFileSync(path.join(f.sourceData, 'private-fixture.json'), '{"sample":"example-only-secret"}');
  fs.mkdirSync(path.join(f.sourceData, 'review-packs'), { recursive: true });
  fs.writeFileSync(path.join(f.sourceData, 'review-packs', 'alpha.json'), '{"sample":"review text"}');
  appendMessage({ thread: 'boss', from: 'owner', to: 'boss', kind: 'reply', text: 'Source-only mailbox text.', replyTo: null, action: 'answer', status: 'new' }, { dir: f.sourceData });
  assert.equal((await command(f.source, 'start', f)).code, 3);
  const { code, text } = await command(f.source, 'cancel', f);
  assert.equal(code, 0, text);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'alpha')), false);
  assert.equal(fs.existsSync(path.join(f.targetData, 'projects', 'alpha.json')), false);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }), null);
  assert.equal(fs.existsSync(path.join(f.sourceData, 'private-fixture.json')), true);
  assert.equal(fs.existsSync(path.join(f.sourceData, 'review-packs', 'alpha.json')), true);
  assert.equal(readMessages({ dir: f.sourceData }).some((row) => row.text === 'Source-only mailbox text.'), true);
  assert.ok(readMessages({ dir: f.sourceData }).find((row) => row.action === 'decide')?.closedAt);
  assert.equal(readMessages({ dir: f.targetData }).length, 0);
  assert.equal(fs.existsSync(path.join(f.targetData, 'review-packs')), false);
  assert.equal(f.sourceHerdr.state.panes.some((pane) => pane.agent_name === 'alpha-orch'), true, 'cancel restarts the source lead');
  assert.equal(f.sourceHerdr.state.panes.find((pane) => pane.agent_name === 'alpha-orch').agent, 'codex');
});

test('a denied switch removes the target and restarts the source lead', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  decide(f, 'Deny the switch.');
  const { code, text } = await command(f.source, 'switch', f);
  assert.equal(code, 0, text);
  assert.match(text, /denied/i);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'alpha')), false);
  assert.ok(readMessages({ dir: f.sourceData }).find((row) => row.action === 'decide')?.closedAt);
  assert.equal(f.sourceHerdr.state.panes.some((pane) => pane.agent_name === 'alpha-orch'), true);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
});

test('cancel frees the target for a later transfer of the same project', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  assert.equal((await command(f.source, 'cancel', f)).code, 0);
  const { code, text } = await command(f.source, 'start', f);
  assert.equal(code, 3, text);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }).side, 'source');
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }).side, 'target');
  assert.equal(fs.existsSync(path.join(f.targetData, 'projects', 'alpha.json')), true);
});

test('target start refuses a pre-existing project symlink without changing its repository', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const original = fs.readFileSync(path.join(f.repo, 'docs', 'orchestration', 'herdr-boss.md'), 'utf8');
  fs.symlinkSync(f.repo, path.join(f.targetRoot, 'alpha'), 'dir');
  const result = await f.target.handle({ action: 'start', slug: 'alpha', transferId: '00000000-0000-4000-8000-000000000020',
    sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME, sourceKitRevision: kitRevision(), sourceRemote: f.remote });
  assert.equal(result.status, 409);
  assert.equal(fs.readFileSync(path.join(f.repo, 'docs', 'orchestration', 'herdr-boss.md'), 'utf8'), original);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.targetData }), null);
});

test('start lists dirty work, unpushed commits, and unpushed branches and makes no lock', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  fs.writeFileSync(path.join(f.repo, 'dirty-file.txt'), 'sample');
  git(f.repo, 'add', 'dirty-file.txt'); git(f.repo, 'commit', '-m', 'local commit');
  git(f.repo, 'switch', '-c', 'sample-unpushed');
  fs.writeFileSync(path.join(f.repo, 'branch.txt'), 'sample');
  git(f.repo, 'add', 'branch.txt'); git(f.repo, 'commit', '-m', 'branch commit');
  fs.writeFileSync(path.join(f.repo, 'still-dirty.txt'), 'sample');
  const { code, text } = await command(f.source, 'start', f);
  assert.equal(code, 1);
  assert.match(text, /dirty tree/i);
  assert.match(text, /unpushed commit/i);
  assert.match(text, /unpushed branch/i);
  assert.doesNotMatch(text, /sample-unpushed/);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'alpha')), false);
});

test('start refuses a running worker before either factory changes', async (t) => {
  const f = fixture({ runningWorkers: ['worker-one'] }); t.after(f.cleanup);
  const { code, text } = await command(f.source, 'start', f);
  assert.equal(code, 1);
  assert.match(text, /running worker/i);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'alpha')), false);
});

test('worker start refuses while either factory holds the transfer lock', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  for (const dataDir of [f.sourceData, f.targetData]) {
    const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-one', HERDR_WORKSPACE_ID: 'workspace-one', HERDR_BOSS_DIR: dataDir };
    const herdr = (args) => args[0] === 'pane' && args[1] === 'get' ? { pane: { pane_id: 'pane-one', workspace_id: 'workspace-one', label: 'orch' } } : {};
    assert.throws(() => startWorker('sample-worker', { kind: 'codex', task: 'sample task', readOnly: true }, { config: { slug: 'alpha', root: f.repo }, env, herdr }), /transfer/i);
  }
});

test('plan refuses a target with an older or different kit revision', async (t) => {
  const f = fixture({ targetKit: '000000000000' }); t.after(f.cleanup);
  const { code, text } = await command(f.source, 'plan', f);
  assert.equal(code, 1);
  assert.match(text, /kit.*(older|match|revision)/i);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }), null);
});

test('plan refuses a missing or unreachable GitHub remote without printing its address', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  git(f.repo, 'remote', 'remove', 'origin');
  const { code, text } = await command(f.source, 'plan', f);
  assert.equal(code, 1);
  assert.match(text, /remote/i);
  assert.doesNotMatch(text, /fake-github|factory-two\.example|hf_guide_/);
  assert.equal(f.calls.length, 0);
});

test('plan refuses an unreachable GitHub remote without printing its address', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const unreachable = path.join(f.root, 'unreachable.git');
  git(f.repo, 'remote', 'set-url', 'origin', unreachable);
  const { code, text } = await command(f.source, 'plan', f);
  assert.equal(code, 1);
  assert.match(text, /remote.*reachable/i);
  assert.doesNotMatch(text, /unreachable\.git|factory-two\.example|hf_guide_/);
  assert.equal(f.calls.length, 0);
});

test('switch waits for a clear Owner answer and cancel after a switch is refused', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  assert.equal((await command(f.source, 'switch', f)).code, 3);
  decide(f, 'Accept the switch.');
  assert.equal((await command(f.source, 'switch', f)).code, 0);
  const { code, text } = await command(f.source, 'cancel', f);
  assert.equal(code, 1);
  assert.match(text, /already switched|transferred/i);
});

test('a second transfer for the same project is refused while the first is open', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await command(f.source, 'start', f)).code, 3);
  const { code, text } = await command(f.source, 'start', f);
  assert.equal(code, 1);
  assert.match(text, /open transfer|already in progress|transfer lock/i);
  assert.equal(readProjectTransferLock('alpha', { dataDir: f.sourceData }).side, 'source');
});

test('factory transfer projects use the factory work group', () => {
  assert.equal(projectTransferRoot({ env: { HOME: '/tmp/factory-fixture' }, factoryRole: () => true, projectRoot: '/tmp/configured-projects' }), path.resolve(FACTORY_PROJECT_GROUP));
  assert.equal(projectTransferRoot({ env: { HOME: '/tmp/home-fixture' }, factoryRole: () => false, projectRoot: '/tmp/configured-projects' }), path.resolve('/tmp/configured-projects'));
});

test('the HTTP transfer routes require fleetGuide and serve status during a slow import', async (t) => {
  let release;
  let installing;
  const entered = new Promise((resolve) => { installing = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture();
  const dataDir = process.env.HERDR_BOSS_DIR;
  const privateDir = path.join(dataDir, 'private-transfer-route');
  writeFleetFile(path.join(dataDir, 'factory-identity.json'), { factoryId: TARGET_ID });
  writeFleetFile(path.join(dataDir, 'fleet-settings.json'), { name: TARGET_NAME, dashboardUrl: DASHBOARD, headOffice: false, shareItemTitles: false });
  writeFleetFile(path.join(dataDir, 'fleet-accounts.json'), []);
  const guide = createFleetGuideAccess({ privateDir }).rotate();
  const read = createFleetReadAccess({ privateDir }).rotate();
  const cfg = { ...loadConfig(), host: '127.0.0.1', port: 0, projectRoot: path.join(dataDir, 'transfer-route-projects'), allowedHosts: ['*.localhost'] };
  const engine = new EventEmitter();
  engine.state = { updatedAt: new Date().toISOString(), herdr: { panes: [] }, kit: { current: kitRevision() }, quotas: [], projects: [], machine: {} };
  engine.tick = async () => engine.state;
  engine.log = () => {};
  const app = serve(cfg, { liveDataDir: dataDir, createEngine: () => engine, fleet: { privateDir,
    registryFile: path.join(dataDir, 'empty-fleet.json'), projectTransfer: {
      dataDir: f.targetData, projectRoot: f.targetRoot, herdr: f.herdr,
      env: { ...process.env, HOME: f.root, HERDR_BOSS_DIR: f.targetData },
      allowGitRemote: () => true, install: async () => { installing(); await gate; },
      hooks: { waitForPane: () => {}, waitForReady: () => true, readText: () => '', wait: () => {} },
    } } });
  let completed;
  t.after(async () => {
    release();
    if (completed) await completed;
    await app.close(); f.cleanup();
  });
  if (!app.server.listening) await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/fleet/transfer`;
  const body = { action: 'plan', slug: 'alpha', sourceFactoryId: SOURCE_ID, sourceKitRevision: kitRevision() };
  const request = (token, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(read)).status, 403);
  assert.equal((await request(guide, 'GET')).status, 400);
  assert.equal((await request(null, 'GET')).status, 401);
  assert.equal((await request(read, 'GET')).status, 403);
  const response = await request(guide);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).factoryId, TARGET_ID);
  const start = { action: 'start', slug: 'alpha', transferId: '00000000-0000-4000-8000-000000000024',
    sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME, sourceKitRevision: kitRevision(), sourceRemote: f.remote };
  const post = (body) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${guide}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const accepted = await post(start);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).jobId, start.transferId);
  const statusUrl = `${url}?${new URLSearchParams({ slug: 'alpha', jobId: start.transferId })}`;
  const poll = () => fetch(statusUrl, { headers: { authorization: `Bearer ${guide}` } });
  completed = (async () => {
    await gate;
    for (;;) {
      const result = await poll();
      if (result.status !== 202) return { status: result.status, body: await result.json() };
      await result.body.cancel();
    }
  })();
  await entered;
  assert.equal((await poll()).status, 202);
  assert.equal((await post(start)).status, 202);
  assert.equal((await post({ ...start, transferId: '00000000-0000-4000-8000-000000000025' })).status, 409);
  const cancel = { action: 'cancel', slug: 'alpha', transferId: start.transferId, sourceFactoryId: SOURCE_ID, sourceName: SOURCE_NAME };
  assert.equal((await post(cancel)).status, 409);
  release();
  const done = await completed;
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'pending');
  assert.deepEqual(Object.keys(done.body).sort(), ['factoryId', 'ok', 'status']);
  assert.equal((await post(start)).status, 200);
  assert.equal(f.herdr.state.prompts.length, 1);
});
