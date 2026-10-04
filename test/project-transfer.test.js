import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createFleetGuideAccess, createFleetReadAccess } from '../src/fleet-access.js';
import { writeFleetFile } from '../src/fleet-store.js';
import { appendMessage, readMessages } from '../src/messages.js';
import { installedKitRevision, kitRevision } from '../src/kit/agents-check.js';
import { startWorker } from '../src/kit/workers.js';
import { recordProjectRepo } from '../src/harness.js';
import { writeProject } from '../src/projects.js';
import { readProjectTransferLock } from '../src/project-transfer-locks.js';
import { createProjectTransfer, projectTransferCommand, projectTransferRoot } from '../src/project-transfer.js';
import { fleetGuideRouteAllowed, serve } from '../src/server.js';
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

function fixture({ sourceKit = kitRevision(), targetKit = sourceKit, runningWorkers = [] } = {}) {
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
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    sequence.push('target request');
    const body = JSON.parse(options.body);
    assert.equal(options.headers.authorization, `Bearer ${GUIDE}`);
    assert.equal(options.redirect, 'error');
    const result = await target.handle(body);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
  };
  const source = createProjectTransfer({
    role: 'source', dataDir: sourceData, privateDir: sourcePrivate,
    settings: () => ({ factoryId: SOURCE_ID, name: SOURCE_NAME }),
    factories: [{ factoryId: TARGET_ID, name: TARGET_NAME, dashboardUrl: DASHBOARD, kitRevision: targetKit }],
    projectRoot: sourceRoot, kitRevision: () => sourceKit, fetchImpl, herdr: sourceHerdr,
    hooks: { waitForPane: () => {}, waitForReady: () => true, readText: () => '', wait: () => {} },
    env: { ...process.env, HOME: root, HERDR_BOSS_DIR: sourceData },
    allowGitRemote: () => true,
    getRunningWorkers: () => runningWorkers,
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
  assert.equal(f.calls.at(-1).url, `${DASHBOARD}/api/fleet/transfer`);
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

test('the transfer API is a POST-only fleetGuide route', () => {
  assert.equal(fleetGuideRouteAllowed('POST', '/api/fleet/transfer'), true);
  assert.equal(fleetGuideRouteAllowed('GET', '/api/fleet/transfer'), false);
  assert.equal(fleetGuideRouteAllowed('POST', '/api/fleet/role'), false);
  assert.equal(fleetGuideRouteAllowed('POST', '/api/workers/start'), false);
});

test('factory transfer projects use the factory work group', () => {
  assert.equal(projectTransferRoot({ env: { HOME: '/tmp/factory-fixture' }, factoryRole: () => true, projectRoot: '/tmp/configured-projects' }), path.resolve(FACTORY_PROJECT_GROUP));
  assert.equal(projectTransferRoot({ env: { HOME: '/tmp/home-fixture' }, factoryRole: () => false, projectRoot: '/tmp/configured-projects' }), path.resolve('/tmp/configured-projects'));
});

test('the HTTP transfer route requires the fleetGuide credential', async (t) => {
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
  const app = serve(cfg, { liveDataDir: dataDir, createEngine: () => engine, fleet: { privateDir, registryFile: path.join(dataDir, 'empty-fleet.json') } });
  t.after(async () => { await app.close(); });
  if (!app.server.listening) await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/fleet/transfer`;
  const body = { action: 'plan', slug: 'alpha', sourceFactoryId: SOURCE_ID, sourceKitRevision: kitRevision() };
  const request = (token, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(read)).status, 403);
  assert.equal((await request(guide, 'GET')).status, 403);
  const response = await request(guide);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).factoryId, TARGET_ID);
});
