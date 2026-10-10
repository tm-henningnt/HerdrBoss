import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { runKitCommand } from '../src/kit/cli.js';
import { pruneWorktrees } from '../src/kit/worktrees.js';
import { startWorker } from './helpers/start-worker.js';
import { CODEX_READY_SCREEN, git, setupFixture } from './helpers/kit-fixture.js';

const trustScreen = (folder, selected = true) => [
  'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  folder,
  `${selected ? '› ' : '  '}1. Trust and continue`,
  `${selected ? '  ' : '› '}2. Open restricted`,
  'Press enter to continue',
].join('\n');

function fixture(t, name, { screen = null, launchError = null, retainPrompt = false, cleanupError = false } = {}) {
  const f = setupFixture(null);
  const worktree = f.config.worktreePath(name);
  const recordFile = path.join(f.config.runsPath, `${name}.json`);
  t.after(() => {
    if (fs.existsSync(worktree)) git(f.root, 'worktree', 'remove', '--force', worktree);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const commands = [];
  let launched = false;
  let closed = false;
  let answered = false;
  let elapsed = 0;
  const snapshot = () => launched && screen && (!answered || retainPrompt)
    ? screen(fs.realpathSync(worktree)) : CODEX_READY_SCREEN;
  const herdr = (args) => {
    commands.push(args);
    if (args[0] === 'agent' && args[1] === 'start') {
      launched = true;
      if (launchError) throw launchError;
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'list' && launched && !closed) {
      return { agents: [{ name, pane_id: 'ws:p2', agent: 'codex', agent_status: 'idle' }] };
    }
    if (args[0] === 'agent' && args[1] === 'get' && launched) {
      if (closed) throw Object.assign(new Error('agent_not_found'), { code: 'agent_not_found' });
      return { agent: { name, pane_id: 'ws:p2', agent: 'codex', agent_status: 'idle' } };
    }
    if (args[0] === 'agent' && args[1] === 'send-keys') {
      assert.deepEqual(args, ['agent', 'send-keys', name, 'enter']);
      answered = true;
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'read') return { text: snapshot() };
    if (args[0] === 'pane' && args[1] === 'read' && launched) return { text: snapshot() };
    if (args[0] === 'pane' && args[1] === 'close') {
      if (cleanupError) throw new Error('fixture pane cleanup refused');
      closed = true;
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'prompt') assert.equal(snapshot(), CODEX_READY_SCREEN);
    return f.herdr(args);
  };
  const start = (overrides = {}) => startWorker(name, { kind: 'codex', task: 'Scoped fixture task.', allow: ['src/'] }, {
    config: f.config, models: loadModels(), env: f.env, rulesFile: f.rulesFile,
    herdr, clock: () => elapsed, wait: (ms) => { elapsed += ms; }, output: () => {}, ...overrides,
  });
  return { ...f, start, herdr, commands, worktree, recordFile, snapshot,
    readRun: () => JSON.parse(fs.readFileSync(recordFile, 'utf8')) };
}

test('worker launch sees a starting run record before the harness starts', (t) => {
  const f = fixture(t, 'record-before-launch');
  const run = f.start({ herdr: (args) => {
    if (args[0] === 'agent' && args[1] === 'start') {
      const record = f.readRun();
      assert.equal(record.state, 'starting');
      assert.equal(record.worktree, f.worktree);
      assert.equal(record.pane, 'ws:p2');
      assert.equal(record.shellPid, 10);
    }
    return f.herdr(args);
  } });
  assert.equal(run.state, 'running');
  assert.equal(f.readRun().state, 'running');
});

for (const [name, reason, cleanupError] of [
  ['launch-fails', 'fixture harness launch failed', false],
  ['launch-interrupted', 'fixture start interrupted by SIGTERM', false],
  ['cleanup-fails', 'fixture harness launch failed', true],
]) {
  test(`worker start retains a failed record when ${name}`, (t) => {
    const f = fixture(t, name, { launchError: new Error(reason), cleanupError });
    assert.throws(() => f.start(), (error) => error.message.includes(reason));
    const record = f.readRun();
    assert.equal(record.state, 'failed');
    assert.equal(record.reason, reason);
    assert.equal(record.startFailed, true);
    assert.ok(record.finishedAt);
  });
}

for (const action of ['collect', 'stop-own']) {
  test(`worker ${action} names the missing worker record, worktree, and prune steps`, (t) => {
    const f = fixture(t, `missing-${action}`);
    const name = `missing-${action}`;
    assert.throws(() => runKitCommand('worker', [action, name, ...(action === 'collect' ? ['--no-record'] : ['--pid', '44'])], {
      config: f.config, herdr: f.herdr, env: f.env, output: () => {},
    }), (error) => {
      assert.match(error.message, /No run record/);
      assert.ok(error.message.includes(name));
      assert.ok(error.message.includes(f.worktree));
      assert.match(error.message, /herdr-boss worktree prune/);
      assert.match(error.message, /herdr-boss worktree prune --apply/);
      assert.doesNotMatch(error.message, /ENOENT/);
      return true;
    });
    assert.equal(f.commands.some((args) => args[1] === 'send-keys' || args[1] === 'close'), false);
  });
}

for (const recovery of [false, true]) {
  test(`Codex worker answers its exact selected folder prompt once${recovery ? ' after agent_not_ready' : ''}`, (t) => {
    const f = fixture(t, `trust-exact-${recovery}`, {
      screen: (folder) => trustScreen(folder),
      launchError: recovery ? Object.assign(new Error('agent_not_ready'), { code: 'agent_not_ready' }) : null,
    });
    const run = f.start();
    assert.equal(run.state, 'running');
    assert.equal(f.commands.filter((args) => args[1] === 'start').length, 1);
    assert.equal(f.commands.filter((args) => args[1] === 'send-keys').length, 1);
    assert.equal(f.commands.filter((args) => args[1] === 'prompt').length, 1);
  });
}

test('Codex worker answers its exact trust prompt after the shell-busy launch retry', (t) => {
  const f = fixture(t, 'trust-busy-retry', {
    screen: (folder) => trustScreen(folder),
    launchError: Object.assign(new Error('agent_not_ready'), { code: 'agent_not_ready' }),
  });
  let starts = 0;
  const run = f.start({ herdr: (args) => {
    if (args[0] === 'agent' && args[1] === 'start' && ++starts === 1) {
      throw Object.assign(new Error('agent_pane_busy'), { code: 'agent_pane_busy' });
    }
    return f.herdr(args);
  } });
  assert.equal(starts, 2);
  assert.equal(run.state, 'running');
  assert.equal(f.commands.filter((args) => args[1] === 'send-keys').length, 1);
  assert.equal(f.commands.filter((args) => args[1] === 'prompt').length, 1);
});

for (const [label, screen] of [
  ['parent', (folder) => trustScreen(path.dirname(folder))],
  ['sibling', (folder) => trustScreen(`${folder}-sibling`)],
  ['unselected', (folder) => trustScreen(folder, false)],
  ['two-selected', (folder) => trustScreen(folder).replace('  2.', '› 2.')],
]) {
  test(`Codex worker refuses the ${label} trust prompt without input`, (t) => {
    const f = fixture(t, `trust-refuse-${label}`, { screen,
      launchError: Object.assign(new Error('agent_not_ready'), { code: 'agent_not_ready' }) });
    assert.throws(() => f.start(), /trust prompt.*exact.*selected/i);
    assert.equal(f.commands.some((args) => args[1] === 'send-keys' || args[1] === 'prompt'), false);
    assert.equal(f.readRun().state, 'failed');
    assert.match(f.readRun().reason, /trust prompt/i);
  });
}

test('Codex worker times out after one trust answer when the prompt stays visible', (t) => {
  const f = fixture(t, 'trust-timeout', { screen: (folder) => trustScreen(folder), retainPrompt: true });
  assert.throws(() => f.start(), /trust.*timed out/i);
  assert.equal(f.commands.filter((args) => args[1] === 'send-keys').length, 1);
  assert.equal(f.commands.some((args) => args[1] === 'prompt'), false);
  assert.equal(f.readRun().state, 'failed');
});

for (const state of ['failed', 'missing']) {
  test(`worktree prune lists and safely removes a worktree with a ${state} run record`, (t) => {
    const f = fixture(t, `prune-record-${state}`);
    git(f.root, 'worktree', 'add', '-b', `prune-record-${state}`, f.worktree, 'main');
    if (state === 'failed') {
      fs.mkdirSync(f.config.runsPath, { recursive: true });
      fs.writeFileSync(f.recordFile, JSON.stringify({ name: `prune-record-${state}`, worktree: f.worktree, state: 'failed' }));
    }
    const lines = [];
    const deps = { herdr: f.herdr, listProcesses: () => [], output: (line) => lines.push(line) };
    const listed = pruneWorktrees(f.config, deps).find((item) => item.path === f.worktree);
    assert.equal(listed?.removable, true);
    assert.ok(lines.some((line) => line.startsWith(f.worktree)));
    pruneWorktrees(f.config, { ...deps, apply: true, archive: false });
    assert.equal(fs.existsSync(f.worktree), false);
  });
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`an interrupted worker start retains a failed record after ${signal}`, (t) => {
    const f = fixture(t, `signal-${signal.toLowerCase()}`);
    const workersModule = new URL('../src/kit/workers.js', import.meta.url).href;
    const configModule = new URL('../src/kit/config.js', import.meta.url).href;
    const code = `
      import { startWorker } from ${JSON.stringify(workersModule)};
      import { loadProjectConfig, loadModels } from ${JSON.stringify(configModule)};
      const [root, rulesFile, name, signal] = process.argv.slice(1);
      const config = loadProjectConfig({ cwd: root });
      const herdr = (args) => {
        const [group, action] = args;
        if (group === 'pane' && action === 'get') return { pane: {
          pane_id: args[2], workspace_id: 'ws', label: args[2] === 'ws:orch' ? 'orch' : null, foreground_cwd: root,
        } };
        if (group === 'pane' && action === 'process-info') return { process_info: { shell_pid: 10, foreground_process_group_id: 10 } };
        if (group === 'pane' && action === 'read') return { text: '% ' };
        if (group === 'pane' && action === 'list') return { panes: [{ pane_id: 'ws:p1', workspace_id: 'ws', tab_id: 'ws:t1' }] };
        if (group === 'pane' && action === 'split') return { pane: { pane_id: 'ws:p2' } };
        if (group === 'tab' && action === 'list') return { tabs: [{ tab_id: 'ws:t1', workspace_id: 'ws', label: 'Workers' }] };
        if (group === 'agent' && action === 'list') return { agents: [] };
        if (group === 'agent' && action === 'start') { process.kill(process.pid, signal); throw new Error('interrupted launch'); }
        throw new Error('No more work after interruption');
      };
      try { startWorker(name, { kind: 'codex', task: 'Signal fixture.', allow: ['src/'], noWorktree: true }, {
        config, models: loadModels(), rulesFile, herdr,
        env: { ...process.env, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' },
        freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }), wait: () => {}, output: () => {},
      }); } catch {}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.root, f.rulesFile, `signal-${signal.toLowerCase()}`, signal], {
      encoding: 'utf8', timeout: 10_000, env: process.env,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, 'the CLI handles the signal');
    assert.equal(result.status, exitCode);
    const record = f.readRun();
    assert.equal(record.state, 'failed');
    assert.match(record.reason, new RegExp(signal));
    assert.ok(record.finishedAt);
  });
}

test('worker start removes only its interruption handlers after the start returns', async (t) => {
  await new Promise((resolve) => setImmediate(resolve));
  const existing = Object.fromEntries(['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]));
  const f = fixture(t, 'signal-handler-cleanup');
  f.start();
  for (const signal of Object.keys(existing)) assert.equal(process.listenerCount(signal), existing[signal].length + 1);
  await new Promise((resolve) => setImmediate(resolve));
  for (const signal of Object.keys(existing)) assert.deepEqual(process.listeners(signal), existing[signal]);
});
