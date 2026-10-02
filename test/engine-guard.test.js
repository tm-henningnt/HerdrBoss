import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const probe = `
  const { Engine } = await import('./src/engine.js');
  const engine = new Engine({ push: true, quotaSeconds: 300, tickSeconds: 30 });
  console.log(JSON.stringify({ act: engine.act, push: engine.push, guard: engine.events.find((event) => event.type === 'guard')?.text ?? null }));
`;

function inspectEngine(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-guard-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HERDR_BOSS_DIR: dataDir, ...overrides },
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('Engine disables actions and push in the Node test context and logs the reason', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(result.act, false);
  assert.equal(result.push, false);
  assert.match(result.guard, /NODE_TEST_CONTEXT/);
});

test('Engine disables actions and push for a non-live data directory', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: '' });
  assert.equal(result.act, false);
  assert.equal(result.push, false);
  assert.match(result.guard, /data directory/);
});

test('HERDR_BOSS_ALLOW_ACTIONS=1 overrides both guards', { timeout: 10000 }, () => {
  const result = inspectEngine({ NODE_TEST_CONTEXT: 'child-v8', HERDR_BOSS_ALLOW_ACTIONS: '1' });
  assert.equal(result.act, true);
  assert.equal(result.push, true);
  assert.equal(result.guard, null);
});

const tickProbe = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { Engine } from './src/engine.js';
  import { loadConfig } from './src/config.js';
  const cfg = loadConfig();
  cfg.push = false;
  cfg.browsers.reapOrphanDaemons = false;
  const engine = new Engine(cfg, { push: false, act: process.env.TEST_ACT === '1' });
  await engine.tick();
  const handoffs = JSON.parse(fs.readFileSync(path.join(process.env.HERDR_BOSS_DIR, 'handoffs.json'), 'utf8'));
  console.log(JSON.stringify({
    act: engine.act,
    handoff: handoffs[0],
    errors: engine.state.errors,
    paneIds: (engine.state.herdr?.panes || []).map((pane) => pane.id),
  }));
`;

function runEngineTick(t, { act, failPaneList = false }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-engine-handoff-tick-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bin = path.join(dataDir, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const herdrCjs = path.join(bin, 'herdr.cjs');
  fs.writeFileSync(herdrCjs, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_HERDR_CALLS, JSON.stringify(args) + '\\n');
let result = {};
if (args[0] === 'workspace' && args[1] === 'list') result = { workspaces: [] };
if (args[0] === 'tab' && args[1] === 'list') result = { tabs: [] };
if (args[0] === 'pane' && args[1] === 'list') {
  if (process.env.TEST_FAIL_PANE_LIST === '1') {
    process.stderr.write('fake pane list failed\\n');
    process.exit(1);
  }
  result = { panes: [] };
}
if (args[0] === 'agent' && args[1] === 'list') result = { agents: [] };
console.log(JSON.stringify({ result }));
`);
  const writeExecutable = (name, source) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, source);
    fs.chmodSync(file, 0o755);
  };
  const processCalls = path.join(dataDir, 'process-calls.log');
  const writeProcessRunner = (name, output) => writeExecutable(name, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$TEST_PROCESS_CALLS"\n${output}\n`);
  writeExecutable('herdr', '#!/bin/sh\nexec node "$(dirname "$0")/herdr.cjs" "$@"\n');
  writeProcessRunner('codexbar', "printf '[]\\n'");
  writeProcessRunner('ps', 'exit 0');
  writeProcessRunner('memory_pressure', "printf 'System-wide memory free percentage: 60%%\\n'");
  writeProcessRunner('sysctl', "printf 'total = 1024.00M used = 1.00M free = 1023.00M\\n'");
  writeProcessRunner('ioreg', "printf '\"HIDIdleTime\" = 1000000000\\n'");

  fs.writeFileSync(path.join(dataDir, 'handoffs.json'), JSON.stringify([
    { id: 'stale', sourcePane: 'ws:p1', workspace: 'ws', newPane: 'ws:p2', status: 'needs-inspection' },
  ]));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    herdr: {
      workspaces: [],
      panes: [{ id: 'ws:p1', workspace: 'ws', workspaceLabel: 'Project', label: null, orch: false, agent: null, status: null, cwd: null, shellPid: null }],
    },
  }));
  const herdrCalls = path.join(dataDir, 'herdr-calls.jsonl');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', tickProbe], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dataDir,
      HERDR_BOSS_DIR: dataDir,
      HERDR_BOSS_LIVE_DIR: dataDir,
      HERDR_BOSS_ALLOW_ACTIONS: '1',
      NODE_TEST_CONTEXT: '',
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      TEST_ACT: act ? '1' : '0',
      TEST_FAIL_PANE_LIST: failPaneList ? '1' : '0',
      TEST_HERDR_CALLS: herdrCalls,
      TEST_PROCESS_CALLS: processCalls,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    ...JSON.parse(result.stdout.trim()),
    herdrCalls: fs.readFileSync(herdrCalls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    processCalls: fs.readFileSync(processCalls, 'utf8').trim().split('\n'),
  };
}

test('Engine.tick expires stale handoffs only with actions and a fresh successful Herdr snapshot', { timeout: 30000 }, (t) => {
  const activeFresh = runEngineTick(t, { act: true });
  assert.equal(activeFresh.act, true);
  assert.deepEqual(activeFresh.paneIds, []);
  assert.equal(activeFresh.errors.some((error) => error.startsWith('herdr:')), false);
  assert.equal(activeFresh.handoff.status, 'expired');
  assert.ok(Number.isFinite(Date.parse(activeFresh.handoff.expiredAt)));

  const actionsDisabled = runEngineTick(t, { act: false });
  assert.equal(actionsDisabled.act, false);
  assert.deepEqual(actionsDisabled.paneIds, []);
  assert.equal(actionsDisabled.handoff.status, 'needs-inspection');

  const failedCollection = runEngineTick(t, { act: true, failPaneList: true });
  assert.equal(failedCollection.act, true);
  assert.deepEqual(failedCollection.paneIds, ['ws:p1'], 'Engine.tick must use the cached snapshot after collection fails');
  assert.equal(failedCollection.errors.some((error) => error.startsWith('herdr:')), true);
  assert.equal(failedCollection.handoff.status, 'needs-inspection', 'cached state must not be used to infer pane absence');
  const expectedProcessCalls = process.platform === 'linux'
    ? ['codexbar', 'ps']
    : ['codexbar', 'ioreg', 'memory_pressure', 'ps', 'sysctl'];
  for (const result of [activeFresh, actionsDisabled, failedCollection]) {
    assert.ok(result.herdrCalls.some((args) => args[0] === 'pane' && args[1] === 'list'), 'all Herdr calls must use the fake runner');
    assert.deepEqual(new Set(result.processCalls), new Set(expectedProcessCalls));
  }
});
