import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectCommand } from '../src/project-new-cli.js';
import { readRegister, writeRegister } from '../src/project-register.js';

const TMP = path.resolve(os.tmpdir()).startsWith(path.resolve(process.cwd())) ? '/tmp' : os.tmpdir();
const at = '2026-10-07T12:00:00.000Z';

function record(slug, over = {}) {
  return {
    slug, title: slug, group: '', repo: '', remote: '', factory: 'factory-zero',
    state: 'parked', pinned: false, priority: 'normal', issueSource: null,
    autoOpen: 'off', lastOpenedAt: '', lastActivityAt: '', nextAction: '', notes: '',
    createdAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

function fixture(t, settings = {}) {
  const { state = 'parked', factory = 'factory-zero', pinned = false } = settings;
  const root = fs.mkdtempSync(path.join(TMP, 'herdr-project-lifecycle-'));
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.orchestration', 'runs'), { recursive: true });
  const project = record('acme-web', { state, factory, pinned, repo });
  writeRegister({ version: 1, projects: [project] }, dataDir);
  fs.writeFileSync(path.join(dataDir, 'projects', 'acme-web.json'), JSON.stringify({
    project: 'Acme Web', updated: at, workspace: 'ws-acme', tasks: [],
  }));
  fs.writeFileSync(path.join(dataDir, 'leases.json'), JSON.stringify({ leases: [
    { pool: 'project-browsers', item: '9223', project: 'acme-web' },
  ] }));
  fs.writeFileSync(path.join(repo, '.herdr-boss.json'), JSON.stringify({ slug: 'acme-web' }));
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') {
      return { pane: { pane_id: args[2], label: process.env.TEST_CALLER_LABEL || 'boss', workspace_id: 'ws-owner' } };
    }
    if (args[0] === 'workspace' && args[1] === 'list') {
      return { workspaces: [{ id: 'ws-acme', label: 'acme-web' }] };
    }
    if (args[0] === 'pane' && args[1] === 'list') {
      return { panes: [{ pane_id: 'p-lead', label: 'orch', agent_name: 'acme-web-orch', workspace_id: 'ws-acme' }] };
    }
    if (args[0] === 'agent' && args[1] === 'list') {
      return { agents: [{ name: 'acme-web-orch', pane_id: 'p-lead', agent_status: 'idle' }] };
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      return { agent: { name: args[2], agent_status: 'idle' } };
    }
    return {};
  };
  const messages = [];
  const log = (line) => messages.push(String(line));
  const result = () => ({ version: 1, projects: readRegister(dataDir).projects });
  const commands = [];
  const missing = new Set(['folder', 'agents', 'kit', 'policy', 'register', 'workspace', 'harness']);
  const clearStep = (step) => {
    for (const name of [...missing]) {
      if ((step === 'kit' && ['agents', 'kit'].includes(name)) || name === step) missing.delete(name);
    }
  };
  const lifecycle = {
    checkProject: () => ({
      slug: 'acme-web', path: repo, ok: missing.size === 0,
      items: [
        { name: 'folder', ok: !missing.has('folder'), detail: 'folder needs repair', fix: 'folder' },
        { name: 'agents', ok: !missing.has('agents'), detail: 'AGENTS is missing', fix: 'kit' },
        { name: 'kit', ok: !missing.has('kit'), detail: 'kit needs repair', fix: 'kit' },
        { name: 'policy', ok: !missing.has('policy'), detail: 'policy is missing', fix: 'policy' },
        { name: 'register', ok: !missing.has('register'), detail: 'repository row is missing', fix: 'register' },
        { name: 'workspace', ok: !missing.has('workspace'), detail: 'not started: the flow ran without --start', fix: 'workspace' },
        { name: 'harness', ok: !missing.has('harness'), detail: 'harness needs repair', fix: 'harness' },
      ],
    }),
    runProjectStep(name, options) {
      commands.push({ name, options });
      clearStep(name);
      return { ok: true, step: { name, status: 'done', detail: 'done' } };
    },
    startProject(options) {
      commands.push({ name: 'startProject', options });
      clearStep('workspace');
      return { ok: true, step: { name: 'workspace', status: 'done', detail: 'workspace started' } };
    },
    listProjectLocks: () => [],
    git: (_cwd, args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'log' && args[1] === '@{u}..') return '';
      if (args[0] === 'log' && args.includes('docs/orchestration/memory.md')) return '2026-10-06T00:00:00Z';
      if (args[0] === 'log') return '2026-10-06T00:00:00Z';
      return '';
    },
    releaseBrowser: async (slug) => { commands.push({ name: 'releaseBrowser', slug }); return { released: true }; },
    projectConfig: { slug: 'acme-web', root: repo, runsPath: path.join(repo, '.orchestration', 'runs') },
    now: () => Date.parse(at),
    wait: () => {},
    ...settings.lifecycle,
  };
  const env = { HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '' };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, repo, project, calls, commands, messages, log, herdr, env, lifecycle, result };
}

async function run(f, args, extra = {}) {
  try {
    return await projectCommand(args, {
      env: f.env, herdr: f.herdr, dataDir: f.dataDir, log: f.log,
      lifecycleOptions: f.lifecycle, flowOptions: { home: f.root }, ...extra,
    });
  } catch (error) {
    f.log(`Error: ${error.message}`);
    return 1;
  }
}

function audit(f) {
  const file = path.join(f.dataDir, 'project-audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

test('project open fixes missing steps in order, starts through the existing flow, and audits the register change', async (t) => {
  const f = fixture(t);
  const code = await run(f, ['open', 'acme-web', '--start']);
  assert.equal(code, 0);
  assert.deepEqual(f.commands.map((entry) => entry.name), ['folder', 'kit', 'policy', 'register', 'startProject', 'harness']);
  assert.equal(f.commands.find((entry) => entry.name === 'startProject').options.start, true);
  const opened = f.result().projects[0];
  assert.equal(opened.state, 'open');
  assert.equal(opened.lastOpenedAt, at);
  assert.deepEqual(audit(f).map(({ action, result }) => [action, result]), [['open', 'done']]);
  assert.match(f.messages.at(-1), /Next action:/);
});

test('project open dry run prints the checks and steps but changes no register, audit, or lock', async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.dataDir, 'project-register.json'), 'utf8');
  assert.equal(await run(f, ['open', 'acme-web', '--dry-run', '--start']), 0);
  assert.deepEqual(f.commands, []);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'project-register.json'), 'utf8'), before);
  assert.deepEqual(audit(f), []);
  assert.ok(f.messages.some((line) => /Dry run/.test(line)));
});

test('a failed open step leaves the project parked and records the failed check', async (t) => {
  const f = fixture(t, { lifecycle: {
    runProjectStep(name) { return { ok: false, error: 'fixture step failed', step: { name, status: 'failed', detail: 'fixture step failed' } }; },
  } });
  assert.equal(await run(f, ['open', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'parked');
  assert.deepEqual(audit(f).map(({ action, result, failedCheck }) => [action, result, failedCheck]), [['open', 'failed', 'folder']]);
});

test('the open cap refuses by default and --force overrides only the cap', async (t) => {
  const f = fixture(t, { lifecycle: { cap: 1 } });
  const other = record('another-project', { state: 'open' });
  writeRegister({ version: 1, projects: [f.project, other] }, f.dataDir);
  assert.equal(await run(f, ['open', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'parked');
  assert.equal(await run(f, ['open', 'acme-web', '--force']), 0);
  assert.equal(f.result().projects[0].state, 'open');
  const archived = fixture(t, { state: 'archived', lifecycle: { cap: 1 } });
  assert.equal(await run(archived, ['open', 'acme-web', '--force']), 1);
  assert.equal(archived.result().projects[0].state, 'archived');
});

test('project open refuses archived projects and projects assigned to another factory', async (t) => {
  const archived = fixture(t, { state: 'archived' });
  assert.equal(await run(archived, ['open', 'acme-web']), 1);
  assert.equal(archived.result().projects[0].state, 'archived');
  assert.deepEqual(archived.commands, []);

  const otherFactory = fixture(t, { factory: 'factory-two' });
  assert.equal(await run(otherFactory, ['open', 'acme-web']), 1);
  assert.equal(otherFactory.result().projects[0].state, 'parked');
  assert.deepEqual(otherFactory.commands, []);
});

test('a worker pane cannot open or park a project', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p-worker', HERDR_WORKSPACE_ID: 'ws-worker' };
  f.herdr = (args) => args[0] === 'pane' && args[1] === 'get'
    ? { pane: { pane_id: 'p-worker', label: 'worker', workspace_id: 'ws-worker' } }
    : {};
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(await run(f, ['open', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'open');
  assert.deepEqual(f.commands, []);
});

test('project park checks before it releases the browser reservation or closes the exact workspace', async (t) => {
  const f = fixture(t, { state: 'open', pinned: true });
  assert.equal(await run(f, ['park', 'acme-web']), 0);
  assert.deepEqual(f.commands.map((entry) => entry.name), ['releaseBrowser']);
  assert.deepEqual(f.calls.filter((args) => args[0] === 'workspace' && args[1] === 'close'), [['workspace', 'close', 'ws-acme']]);
  const parked = f.result().projects[0];
  assert.equal(parked.state, 'parked');
  assert.equal(parked.pinned, false);
  assert.ok(fs.existsSync(path.join(f.repo, '.herdr-boss.json')), 'park keeps project files');
  assert.deepEqual(audit(f).map(({ action, result }) => [action, result]), [['park', 'started'], ['park', 'done']]);
  assert.ok(!f.calls.some((args) => args[0] === 'browser' && args[1] === 'close'), 'park never closes a browser');
});

test('project park refuses a busy check and does not release resources or change state', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.lifecycle.listProjectLocks = () => [{ project: 'acme-web', name: 'release', state: 'live' }];
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'open');
  assert.deepEqual(f.commands, []);
  assert.ok(!f.calls.some((args) => args[0] === 'workspace' && args[1] === 'close'));
  assert.equal(audit(f).length, 1);
  assert.equal(audit(f)[0].result, 'failed');
});

test('project park dry run prints checks but sends no prompt or resource command', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.lifecycle.git = (_cwd, args) => args[0] === 'status' ? ' M README.md'
    : args[0] === 'log' && args[1] === '@{u}..' ? ''
      : args[0] === 'log' ? '2026-10-06T00:00:00Z' : '';
  assert.equal(await run(f, ['park', 'acme-web', '--dry-run', '--prepare']), 1);
  assert.equal(f.result().projects[0].state, 'open');
  assert.deepEqual(f.commands, []);
  assert.deepEqual(audit(f), []);
  assert.ok(f.messages.some((line) => /would ask the project lead/.test(line)));
});

test('project park --prepare asks once, waits for an idle lead, and checks again', async (t) => {
  const f = fixture(t, { state: 'open' });
  let dirty = true;
  let clock = Date.parse(at);
  let agentStatus = 'idle';
  const realHerdr = f.herdr;
  f.herdr = (args) => {
    if (args[0] === 'agent' && args[1] === 'prompt') { agentStatus = 'working'; f.calls.push(args); return {}; }
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { name: args[2], agent_status: agentStatus } };
    return realHerdr(args);
  };
  f.lifecycle.git = (_cwd, args) => {
    if (args[0] === 'status') return dirty ? ' M README.md' : '';
    if (args[0] === 'log' && args[1] === '@{u}..') return '';
    if (args[0] === 'log' && args.includes('docs/orchestration/memory.md')) return '2026-10-06T00:00:00Z';
    if (args[0] === 'log') return '2026-10-06T00:00:00Z';
    return '';
  };
  f.lifecycle.now = () => clock;
  f.lifecycle.wait = (ms) => { clock += ms; dirty = false; agentStatus = 'idle'; };
  assert.equal(await run(f, ['park', 'acme-web', '--prepare']), 0);
  const prompts = f.calls.filter((args) => args[0] === 'agent' && args[1] === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][2], 'acme-web-orch');
  assert.ok(!prompts[0].includes('--wait'));
  assert.equal(f.result().projects[0].state, 'parked');
});

test('project park --prepare does not prompt while a project worker is live', async (t) => {
  const f = fixture(t, { state: 'open' });
  fs.writeFileSync(path.join(f.repo, '.orchestration', 'runs', 'worker-a.json'), JSON.stringify({
    name: 'worker-a', pane: 'p-worker', worktree: path.join(f.root, 'worker-a'), startedAt: at,
  }));
  f.lifecycle.git = (_cwd, args) => args[0] === 'status' ? ' M README.md'
    : args[0] === 'log' && args[1] === '@{u}..' ? ''
      : args[0] === 'log' ? '2026-10-06T00:00:00Z' : '';
  assert.equal(await run(f, ['park', 'acme-web', '--prepare']), 1);
  assert.ok(!f.calls.some((args) => args[0] === 'agent' && args[1] === 'prompt'));
  assert.equal(f.result().projects[0].state, 'open');
});

test('project park does not close a browser when release refuses', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.lifecycle.releaseBrowser = async () => { throw new Error('The browser is still open.'); };
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'open');
  assert.ok(!f.calls.some((args) => args[0] === 'workspace' && args[1] === 'close'));
  assert.ok(!f.calls.some((args) => args[0] === 'browser' && args[1] === 'close'));
});

test('archive and unarchive use only parked state transitions and write audit lines', async (t) => {
  const f = fixture(t);
  assert.equal(await run(f, ['archive', 'acme-web']), 0);
  assert.equal(f.result().projects[0].state, 'archived');
  assert.equal(await run(f, ['unarchive', 'acme-web']), 0);
  assert.equal(f.result().projects[0].state, 'parked');
  assert.deepEqual(audit(f).map((line) => line.action), ['archive', 'unarchive']);
});
