import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { pinProject } from '../src/git-pins.js';
import { POLICY_DEFAULTS, validatePolicy } from '../src/control.js';
import { loadModels, loadProjectConfig, workerConfigView } from '../src/kit/config.js';
import { runSuite, suiteLockForCommand } from '../src/kit/suite.js';
import { acquireProjectLock, readLockLedger, readLockQueue, readMachineLocks, releaseProjectLock } from '../src/kit/locks.js';
import { git, temporaryRepo } from './helpers/kit-fixture.js';

function fixture(t, { networkCommands = [] } = {}) {
  const root = temporaryRepo('herdr-network-lock-');
  const base = path.dirname(root);
  const dataDir = path.join(base, 'boss-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(root, '.herdr-boss.json');
  fs.writeFileSync(configFile, JSON.stringify({ slug: 'network-test', networkCommands }));
  const config = loadProjectConfig({ cwd: root });
  const locks = structuredClone(POLICY_DEFAULTS.locks);
  locks.network = { slots: 2 };
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ locks }));
  const panes = new Set(['ws:orch', 'ws:holder-a', 'ws:holder-b', 'ws:wait-a', 'ws:wait-b', 'ws:wait-c']);
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') {
      return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
    }
    if (args[0] === 'pane' && args[1] === 'process-info') return { process_info: { shell_pid: 601 } };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [...panes].map((pane_id) => ({ pane_id })) };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: base,
    HERDR_BOSS_DIR: dataDir,
    HERDR_ENV: '1',
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_PANE_ID: 'ws:orch',
  };
  pinProject({ slug: config.slug, repo: root }, { env });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const options = (pane = 'ws:orch', extra = {}) => ({
    config,
    env: { ...env, HERDR_PANE_ID: pane },
    herdr,
    dataDir,
    pidAlive: () => true,
    output: () => {},
    ...extra,
  });
  return { root, base, dataDir, config, configFile, panes, herdr, env, options };
}

function queueFiles(dataDir, name = 'network') {
  const directory = path.join(dataDir, 'locks', 'machine', 'queue', name);
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')))
      .sort((left, right) => left.seq - right.seq);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(condition, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function startWaiter(t, f, pane, lockName = 'network') {
  const script = path.join(f.base, `${pane.replaceAll(':', '-')}.mjs`);
  const locksUrl = pathToFileURL(path.resolve('src/kit/locks.js')).href;
  const configUrl = pathToFileURL(path.resolve('src/kit/config.js')).href;
  const lifecycleUrl = pathToFileURL(path.resolve('src/kit/lifecycle.js')).href;
  fs.writeFileSync(script, `
    import { acquireProjectLock, releaseProjectLock } from ${JSON.stringify(locksUrl)};
    import { loadProjectConfig } from ${JSON.stringify(configUrl)};
    import { initializeLifecyclePort } from ${JSON.stringify(lifecycleUrl)};
    initializeLifecyclePort();
    const fs = await import('node:fs');
    const config = loadProjectConfig({ cwd: process.argv[2] });
    const panes = JSON.parse(process.argv[6]);
    const name = process.argv[7];
    const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: process.argv[4], HERDR_BOSS_DIR: process.argv[3] };
    const herdr = (args) => {
      if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: args[2], workspace_id: 'ws', label: 'orch' } };
      if (args[0] === 'pane' && args[1] === 'list') return { panes: panes.map((pane_id) => ({ pane_id })) };
      throw new Error('Unexpected Herdr call: ' + args.join(' '));
    };
    const options = { config, env, herdr, dataDir: process.argv[3], kind: 'suite', waitSeconds: 20, pidAlive: () => true, output: () => {} };
    try {
      const lock = acquireProjectLock(name, options);
      process.stdout.write(JSON.stringify({ event: 'acquired', pane: lock.ownerPane }) + '\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      releaseProjectLock(name, { ...options, expectedRecord: lock });
      process.stdout.write(JSON.stringify({ event: 'released', pane: lock.ownerPane }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ event: 'error', message: error.message, exitCode: error.exitCode ?? null }) + '\\n');
      process.exitCode = error.exitCode ?? 1;
    }
  `);
  const child = spawn(process.execPath, [script, f.root, f.dataDir, pane, '20', JSON.stringify([...f.panes]), lockName], {
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: f.base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  let stderr = '';
  let processError = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { processError = error.message; });
  child.on('exit', (code, signal) => messages.push({ event: 'exit', code, signal, stderr }));
  const event = (name) => waitFor(() => messages.find((message) => message.event === name)
    ?? (messages.find((message) => message.event === 'error') || null), `${pane} did not report ${name}`);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  return { child, event, messages, diagnostics: () => ({ messages, stderr, processError }) };
}

test('network runs use two machine slots and release three waiters in ticket order', async (t) => {
  const f = fixture(t);
  const first = acquireProjectLock('network', { ...f.options('ws:holder-a'), kind: 'manual' });
  const second = acquireProjectLock('network', { ...f.options('ws:holder-b'), kind: 'manual' });
  const holders = readMachineLocks({ dataDir: f.dataDir, livePanes: f.panes, pidAlive: () => true }).filter((lock) => lock.class === 'network');
  assert.deepEqual(holders.map((lock) => lock.slot).sort(), [1, 2]);
  assert.ok(holders.every((lock) => lock.slotLimit === 2 && lock.configuredSlotLimit === 2));
  const waiterA = startWaiter(t, f, 'ws:wait-a');
  const waiterB = startWaiter(t, f, 'ws:wait-b');
  const waiterC = startWaiter(t, f, 'ws:wait-c');

  try {
    let tickets;
    try {
      tickets = await waitFor(() => {
        const queued = queueFiles(f.dataDir);
        if (queued.length === 3) return queued;
        return [waiterA, waiterB, waiterC].flatMap((waiter) => waiter.messages).find((message) => message.event !== 'acquired') ?? null;
      }, 'all three network waiters did not queue');
    } catch (error) {
      throw new Error(`${error.message}; waiter A ${JSON.stringify(waiterA.diagnostics())}; waiter B ${JSON.stringify(waiterB.diagnostics())}; waiter C ${JSON.stringify(waiterC.diagnostics())}`);
    }
    assert.equal(tickets.length, 3, JSON.stringify(tickets));
    const ticketOrder = tickets.map((ticket) => ticket.pane);
    const waiterByPane = new Map([['ws:wait-a', waiterA], ['ws:wait-b', waiterB], ['ws:wait-c', waiterC]]);
    const queue = readLockQueue({ dataDir: f.dataDir, name: 'network', livePanes: f.panes, pidAlive: () => true });
    assert.deepEqual(queue.map((ticket) => ticket.position), [1, 2, 3]);
    assert.ok(queue.every((ticket) => ticket.class === 'network' && ticket.lane === 'network'));

    releaseProjectLock('network', { ...f.options('ws:holder-a'), expectedRecord: first });
    assert.deepEqual(await waiterByPane.get(ticketOrder[0]).event('acquired'), { event: 'acquired', pane: ticketOrder[0] });
    assert.deepEqual(queueFiles(f.dataDir).map((ticket) => ticket.pane), ticketOrder.slice(1));

    releaseProjectLock('network', { ...f.options('ws:holder-b'), expectedRecord: second });
    assert.deepEqual(await waiterByPane.get(ticketOrder[1]).event('acquired'), { event: 'acquired', pane: ticketOrder[1] });
    assert.deepEqual(queueFiles(f.dataDir).map((ticket) => ticket.pane), [ticketOrder[2]]);

    waiterByPane.get(ticketOrder[0]).child.stdin.write('\n');
    assert.deepEqual(await waiterByPane.get(ticketOrder[0]).event('released'), { event: 'released', pane: ticketOrder[0] });
    assert.deepEqual(await waiterByPane.get(ticketOrder[2]).event('acquired'), { event: 'acquired', pane: ticketOrder[2] });
    waiterByPane.get(ticketOrder[1]).child.stdin.write('\n');
    waiterByPane.get(ticketOrder[2]).child.stdin.write('\n');
    await Promise.all([waiterByPane.get(ticketOrder[1]).event('released'), waiterByPane.get(ticketOrder[2]).event('released')]);
  } finally {
    for (const record of [first, second]) {
      try { releaseProjectLock('network', { ...f.options(record.ownerPane), expectedRecord: record }); } catch {}
    }
  }
});

test('a dead network holder PID is taken over', (t) => {
  const f = fixture(t);
  const stale = acquireProjectLock('network', { ...f.options('ws:holder-a'), kind: 'suite' });
  const replacement = acquireProjectLock('network', {
    ...f.options('ws:holder-b', { pidAlive: (pid) => pid !== stale.pid }),
    kind: 'suite',
  });
  assert.equal(replacement.class, 'network');
  assert.equal(replacement.slot, 1);
  const takeovers = readLockLedger({ dataDir: f.dataDir }).filter((line) => line.event === 'release' && line.takeover && line.class === 'network');
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0].pane, stale.ownerPane);
  releaseProjectLock('network', { ...f.options('ws:holder-b'), expectedRecord: replacement });
});

test('a runtime cap decrease blocks admission until live network holders drain', (t) => {
  const f = fixture(t);
  const first = acquireProjectLock('network', { ...f.options('ws:holder-a'), kind: 'manual' });
  const second = acquireProjectLock('network', { ...f.options('ws:holder-b'), kind: 'manual' });
  const policyFile = path.join(f.dataDir, 'policy.json');
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policy.locks.network.slots = 1;
  fs.writeFileSync(policyFile, JSON.stringify(policy));

  assert.throws(() => acquireProjectLock('network', { ...f.options('ws:wait-a'), kind: 'manual', waitSeconds: 0 }),
    (error) => error.code === 'ELOCKBUSY');
  const current = readMachineLocks({ dataDir: f.dataDir, livePanes: f.panes, pidAlive: () => true }).filter((lock) => lock.class === 'network');
  assert.equal(current.length, 2);
  assert.ok(current.every((lock) => lock.configuredSlotLimit === 1 && lock.slotLimit === 1));

  releaseProjectLock('network', { ...f.options('ws:holder-a'), expectedRecord: first });
  assert.throws(() => acquireProjectLock('network', { ...f.options('ws:wait-a'), kind: 'manual', waitSeconds: 0 }),
    (error) => error.code === 'ELOCKBUSY');
  releaseProjectLock('network', { ...f.options('ws:holder-b'), expectedRecord: second });
  const next = acquireProjectLock('network', { ...f.options('ws:wait-a'), kind: 'manual', waitSeconds: 0 });
  assert.equal(next.ownerPane, 'ws:wait-a');
  assert.equal(next.slot, 1);
  releaseProjectLock('network', { ...f.options('ws:wait-a'), expectedRecord: next });
});

test('network and full-suite runs never consume or block each other’s capacity', (t) => {
  const f = fixture(t);
  const suite = acquireProjectLock('full-suite', { ...f.options(), kind: 'suite', waitSeconds: 0 });
  const network = acquireProjectLock('network', { ...f.options(), kind: 'suite', waitSeconds: 0 });
  assert.equal(network.class, 'network');
  releaseProjectLock('full-suite', { ...f.options(), expectedRecord: suite });
  releaseProjectLock('network', { ...f.options(), expectedRecord: network });

  const first = acquireProjectLock('network', { ...f.options('ws:holder-a'), kind: 'manual' });
  const second = acquireProjectLock('network', { ...f.options('ws:holder-b'), kind: 'manual' });
  const fullSuite = acquireProjectLock('full-suite', { ...f.options(), kind: 'suite', waitSeconds: 0 });
  assert.equal(fullSuite.name, 'full-suite');
  releaseProjectLock('full-suite', { ...f.options(), expectedRecord: fullSuite });
  releaseProjectLock('network', { ...f.options('ws:holder-a'), expectedRecord: first });
  releaseProjectLock('network', { ...f.options('ws:holder-b'), expectedRecord: second });
});

test('suite selects network by whitespace-normalized command and keeps other commands in full-suite', (t) => {
  const networkFixture = fixture(t);
  const marker = path.join(networkFixture.base, 'network-lock-result.json');
  const script = path.join(networkFixture.base, 'probe.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; const d=${JSON.stringify(networkFixture.dataDir)}; const names=fs.readdirSync(d+'/locks/machine'); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({network:names.some(n=>n.startsWith('network.')),fullSuite:names.some(n=>n.startsWith('full-suite'))}));`);
  const argv = [process.execPath, script];
  networkFixture.config.networkCommands = [` ${argv[0]}\t ${argv[1]} `];
  const options = {
    config: networkFixture.config,
    env: networkFixture.env,
    herdr: networkFixture.herdr,
    dataDir: networkFixture.dataDir,
    cwd: networkFixture.root,
    stdio: 'ignore',
    output: () => {},
    pidAlive: () => true,
  };
  const networkResult = runSuite(argv, options);
  assert.equal(networkResult.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { network: true, fullSuite: false });

  networkFixture.config.networkCommands = [];
  fs.unlinkSync(marker);
  const fullResult = runSuite(argv, options);
  assert.equal(fullResult.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { network: false, fullSuite: true });
  const ledger = readLockLedger({ dataDir: networkFixture.dataDir });
  assert.ok(ledger.some((line) => line.event === 'acquire' && line.class === 'network' && line.project === 'network-test'));
  assert.ok(ledger.some((line) => line.event === 'release' && line.class === 'network' && Number.isFinite(line.holdMs)));
});

test('a near-miss command stays in the CPU full-suite class', () => {
  const registered = ['npm', 'run', 'verify:remote'];
  const allowed = [registered.join(' ')];
  assert.equal(suiteLockForCommand(registered, allowed), 'network');
  assert.equal(suiteLockForCommand([...registered, '--', '--fix'], allowed), 'full-suite');
  assert.equal(suiteLockForCommand(['npm', 'run', 'verify:remote;', 'echo', 'unexpected'], allowed), 'full-suite');
});

test('project config validates and shows networkCommands; network cap is validated', (t) => {
  const f = fixture(t, { networkCommands: ['npm run verify:remote'] });
  assert.deepEqual(f.config.networkCommands, ['npm run verify:remote']);
  assert.deepEqual(workerConfigView(f.config).fields.find((field) => field.key === 'networkCommands').value, ['npm run verify:remote']);
  for (const networkCommands of [null, 'npm run verify:remote', [1], [''], ['  ']]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ networkCommands }));
    assert.throws(() => loadProjectConfig({ cwd: f.root }), /networkCommands/);
  }
  const valid = structuredClone(POLICY_DEFAULTS);
  valid.locks.network.slots = 8;
  assert.deepEqual(validatePolicy(valid, loadModels()).filter((error) => error.includes('locks.network.slots')), []);
  for (const slots of [0, 9, 1.5, '2']) {
    const policy = structuredClone(valid);
    policy.locks.network.slots = slots;
    assert.match(validatePolicy(policy, loadModels()).join(' '), /locks\.network\.slots must be an integer from 1 to 8/);
  }
});
