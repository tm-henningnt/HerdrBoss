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
  const herdr = f.herdr;
  f.herdr = (args) => args[0] === 'workspace' && args[1] === 'list' ? { workspaces: [] }
    : args[0] === 'pane' && args[1] === 'list' ? { panes: [] }
      : args[0] === 'agent' && args[1] === 'list' ? { agents: [] } : herdr(args);
  const other = record('another-project', { state: 'open' });
  writeRegister({ version: 1, projects: [f.project, other] }, f.dataDir);
  assert.equal(await run(f, ['open', 'acme-web']), 1);
  assert.match(f.messages.at(-1), /--force --reason TEXT/);
  assert.equal(f.result().projects[0].state, 'parked');
  assert.equal(await run(f, ['open', 'acme-web', '--force']), 1);
  assert.match(f.messages.at(-1), /--force needs --reason TEXT/);
  assert.equal(await run(f, ['open', 'acme-web', '--force', '--reason', 'owner approved cap override api_key="sample"']), 0);
  assert.equal(f.result().projects[0].state, 'open');
  const forced = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'action-audit.jsonl'), 'utf8').trim());
  assert.deepEqual([forced.command, forced.project, forced.workerName, forced.refusalKind], ['project open', 'acme-web', null, 'open-project-cap']);
  assert.equal(forced.reason, 'owner approved cap override api_key=[REDACTED]');
  const archived = fixture(t, { state: 'archived', lifecycle: { cap: 1 } });
  assert.equal(await run(archived, ['open', 'acme-web', '--force', '--reason', 'owner approved cap override']), 1);
  assert.equal(archived.result().projects[0].state, 'archived');
});

test('the cap reads register settings and can exclude pinned open projects', async (t) => {
  const f = fixture(t, { lifecycle: { registerSettings: { cap: 2, capCountsPinned: false } } });
  writeRegister({ version: 1, projects: [
    f.project,
    record('pinned-project', { state: 'open', pinned: true }),
    record('open-project', { state: 'open' }),
  ] }, f.dataDir);
  assert.equal(await run(f, ['open', 'acme-web']), 0);
  assert.equal(f.result().projects.find((item) => item.slug === 'acme-web').state, 'open');

  const defaults = fixture(t, { lifecycle: { registerSettings: { cap: 3 } } });
  writeRegister({ version: 1, projects: [
    defaults.project,
    record('pinned-project', { state: 'open', pinned: true }),
    record('open-project-a', { state: 'open' }),
    record('open-project-b', { state: 'open' }),
  ] }, defaults.dataDir);
  assert.equal(await run(defaults, ['open', 'acme-web']), 0, 'the default cap is 3 and pinned projects do not use a cap slot');
  assert.equal(defaults.result().projects.find((item) => item.slug === 'acme-web').state, 'open');
});

test('the open cap does not refuse a project with a live orchestrator', async (t) => {
  const f = fixture(t, { lifecycle: { cap: 1 } });
  writeRegister({ version: 1, projects: [
    f.project,
    record('open-project-a', { state: 'open' }),
    record('open-project-b', { state: 'open' }),
  ] }, f.dataDir);

  const code = await run(f, ['open', 'acme-web']);

  assert.equal(code, 0, f.messages.join('\n'));
  assert.equal(f.result().projects.find((item) => item.slug === 'acme-web').state, 'open');
  assert.match(f.messages.join('\n'), /cap does not apply/);
});

test('lifecycle commands refuse an orch pane from another project', async (t) => {
  for (const [action, state] of [['open', 'parked'], ['park', 'open'], ['archive', 'parked'], ['unarchive', 'archived']]) {
    const f = fixture(t, { state });
    f.env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p-foreign', HERDR_WORKSPACE_ID: 'ws-other' };
    f.herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') {
        return { pane: { pane_id: 'p-foreign', label: 'orch', workspace_id: 'ws-other' } };
      }
      if (args[0] === 'workspace' && args[1] === 'list') {
        return { workspaces: [{ id: 'ws-acme', label: 'acme-web' }, { id: 'ws-other', label: 'other-project' }] };
      }
      return {};
    };
    assert.equal(await run(f, [action, 'acme-web']), 1, `${action} must refuse a foreign orch`);
    assert.equal(f.result().projects[0].state, state, `${action} must not change the target`);
    assert.deepEqual(f.commands, [], `${action} must not run project steps`);
  }
});

test('a project lead cannot park its own workspace, while the Boss can act across projects', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p-lead', HERDR_WORKSPACE_ID: 'ws-acme' };
  const makeHerdr = (label, workspaceId) => (args) => {
    if (args[0] === 'pane' && args[1] === 'get') {
      return { pane: { pane_id: args[2], label, workspace_id: workspaceId } };
    }
    if (args[0] === 'workspace' && args[1] === 'list') {
      return { workspaces: [{ id: 'ws-acme', label: 'acme-web' }, { id: 'ws-other', label: 'other-project' }] };
    }
    if (args[0] === 'pane' && args[1] === 'list') {
      return { panes: [{ pane_id: 'p-lead', label: 'orch', agent_name: 'acme-web-orch', workspace_id: 'ws-acme' }] };
    }
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [{ name: 'acme-web-orch', pane_id: 'p-lead', agent_status: 'idle' }] };
    if (args[0] === 'workspace' && args[1] === 'close') return {};
    return {};
  };
  f.herdr = makeHerdr('orch', 'ws-acme');
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'open');
  assert.deepEqual(f.commands, []);

  const boss = fixture(t, { state: 'parked' });
  boss.env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p-boss', HERDR_WORKSPACE_ID: 'ws-other' };
  boss.herdr = makeHerdr('boss', 'ws-other');
  assert.equal(await run(boss, ['archive', 'acme-web']), 0);
  assert.equal(boss.result().projects[0].state, 'archived');
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
  const order = [];
  let stateAtClose;
  const herdr = f.herdr;
  f.herdr = (args) => {
    if (args[0] === 'workspace' && args[1] === 'close') {
      order.push('close');
      stateAtClose = f.result().projects[0].state;
    }
    return herdr(args);
  };
  let stateAtRelease;
  f.lifecycle.releaseBrowser = async (slug) => {
    order.push('release');
    stateAtRelease = f.result().projects[0].state;
    f.commands.push({ name: 'releaseBrowser', slug });
    return { released: true };
  };
  assert.equal(await run(f, ['park', 'acme-web']), 0);
  assert.deepEqual(order, ['close', 'release']);
  assert.equal(stateAtClose, 'parking');
  assert.equal(stateAtRelease, 'parking');
  assert.equal(f.calls.filter((args) => args[0] === 'pane' && args[1] === 'list').length, 3, 'the pane list is checked again immediately before close');
  assert.deepEqual(f.commands.map((entry) => entry.name), ['releaseBrowser']);
  assert.deepEqual(f.calls.filter((args) => args[0] === 'workspace' && args[1] === 'close'), [['workspace', 'close', 'ws-acme']]);
  const parked = f.result().projects[0];
  assert.equal(parked.state, 'parked');
  assert.equal(parked.pinned, false);
  assert.ok(fs.existsSync(path.join(f.repo, '.herdr-boss.json')), 'park keeps project files');
  assert.deepEqual(audit(f).map(({ action, result }) => [action, result]), [['park', 'started'], ['park', 'done']]);
  assert.ok(!f.calls.some((args) => args[0] === 'browser' && args[1] === 'close'), 'park never closes a browser');
});

test('auto-park can suppress internal park audit rows for one combined result', async (t) => {
  const f = fixture(t, { state: 'open' });
  assert.equal(await run(f, ['park', 'acme-web'], {
    lifecycleOptions: { ...f.lifecycle, auditBy: 'auto-park', suppressAudit: true },
  }), 0);
  assert.deepEqual(audit(f), []);
  assert.equal(f.result().projects[0].state, 'parked');
});

test('auto-park suppresses a lifecycle refusal audit so its caller can write one skip', async (t) => {
  const f = fixture(t, { state: 'open' });
  f.lifecycle.listProjectLocks = () => [{ project: 'acme-web', name: 'release', state: 'live' }];
  assert.equal(await run(f, ['park', 'acme-web'], {
    lifecycleOptions: { ...f.lifecycle, auditBy: 'auto-park', suppressAudit: true },
  }), 1);
  assert.deepEqual(audit(f), []);
  assert.equal(f.result().projects[0].state, 'open');
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
  assert.equal(f.result().projects[0].state, 'parking');
  assert.ok(f.calls.some((args) => args[0] === 'workspace' && args[1] === 'close'), 'the workspace closes before browser release');
  assert.ok(!f.calls.some((args) => args[0] === 'browser' && args[1] === 'close'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'leases.json'), 'utf8')).leases.some((lease) => lease.project === 'acme-web'));
  assert.equal(audit(f).at(-1).failedCheck, 'browser');
});

test('a workspace close failure keeps the parking state and browser reservation', async (t) => {
  const f = fixture(t, { state: 'open' });
  const herdr = f.herdr;
  f.herdr = (args) => {
    if (args[0] === 'workspace' && args[1] === 'close') throw new Error('workspace close failed');
    return herdr(args);
  };
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'parking');
  assert.deepEqual(f.commands, []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'leases.json'), 'utf8')).leases.some((lease) => lease.project === 'acme-web'));
  assert.equal(audit(f).at(-1).failedCheck, 'workspace');
});

test('a final register failure restores the browser reservation and leaves park retryable', async (t) => {
  const f = fixture(t, { state: 'open' });
  const leaseFile = path.join(f.dataDir, 'leases.json');
  let failFinalWrite = true;
  f.lifecycle.writeRegister = (register, dataDir) => {
    if (register.projects[0].state === 'parked' && failFinalWrite) {
      failFinalWrite = false;
      throw new Error('register write failed');
    }
    writeRegister(register, dataDir);
  };
  f.lifecycle.releaseBrowser = async (slug) => {
    const leases = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    leases.leases = leases.leases.filter((lease) => lease.project !== slug);
    fs.writeFileSync(leaseFile, JSON.stringify(leases));
    f.commands.push({ name: 'releaseBrowser', slug });
  };
  f.lifecycle.reserveBrowser = async (slug) => {
    const leases = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    leases.leases.push({ pool: 'project-browsers', item: '9223', project: slug });
    fs.writeFileSync(leaseFile, JSON.stringify(leases));
    f.commands.push({ name: 'reserveBrowser', slug });
  };
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'parking');
  assert.deepEqual(f.commands.map((entry) => entry.name), ['releaseBrowser', 'reserveBrowser']);
  assert.ok(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).leases.some((lease) => lease.project === 'acme-web'));
  assert.equal(audit(f).at(-1).failedCheck, 'register');
  assert.equal(await run(f, ['park', 'acme-web']), 0, 'park retries from the parking state');
  assert.equal(f.result().projects[0].state, 'parked');
  assert.deepEqual(f.commands.map((entry) => entry.name), ['releaseBrowser', 'reserveBrowser', 'releaseBrowser']);
  assert.ok(!JSON.parse(fs.readFileSync(leaseFile, 'utf8')).leases.some((lease) => lease.project === 'acme-web'));
});

test('park refuses a pane that appears before close and keeps the browser reservation', async (t) => {
  const f = fixture(t, { state: 'open' });
  const herdr = f.herdr;
  let paneLists = 0;
  f.herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'list') {
      paneLists += 1;
      if (paneLists === 3) {
        return { panes: [
          { pane_id: 'p-lead', label: 'orch', agent_name: 'acme-web-orch', workspace_id: 'ws-acme' },
          { pane_id: 'p-late', label: 'worker', workspace_id: 'ws-acme' },
        ] };
      }
    }
    return herdr(args);
  };
  assert.equal(await run(f, ['park', 'acme-web']), 1);
  assert.equal(f.result().projects[0].state, 'parking');
  assert.ok(!f.calls.some((args) => args[0] === 'workspace' && args[1] === 'close'));
  assert.deepEqual(f.commands, []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'leases.json'), 'utf8')).leases.some((lease) => lease.project === 'acme-web'));
  assert.equal(audit(f).at(-1).failedCheck, 'workspace');
});

test('archive and unarchive use only parked state transitions and write audit lines', async (t) => {
  const f = fixture(t);
  assert.equal(await run(f, ['archive', 'acme-web']), 0);
  assert.equal(f.result().projects[0].state, 'archived');
  assert.equal(await run(f, ['unarchive', 'acme-web']), 0);
  assert.equal(f.result().projects[0].state, 'parked');
  assert.deepEqual(audit(f).map((line) => line.action), ['archive', 'unarchive']);
});
