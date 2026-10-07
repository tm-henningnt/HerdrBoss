import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { toolsCommand } from '../src/tools-check.js';
import { readMessages } from '../src/messages.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'factory'), { recursive: true });
  const pinsFile = path.join(repoRoot, 'factory', 'pins.json');
  const source = fileURLToPath(new URL('../factory/pins.json', import.meta.url));
  const pins = JSON.parse(fs.readFileSync(source, 'utf8'));
  pins.codex = '0.160.1';
  fs.writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  const desiredHash = createHash('sha256').update(fs.readFileSync(pinsFile)).digest('hex');
  return { root, repoRoot, dataDir, pinsFile, desiredHash };
}

function fakeClock(start = Date.parse('2026-10-07T00:00:00.000Z')) {
  let time = start;
  const waits = [];
  return {
    now: () => time,
    waits,
    sleep: async (ms) => { waits.push(ms); time += ms; },
  };
}

function dependencies(f, overrides = {}) {
  const clock = overrides.clock || fakeClock();
  const names = overrides.names || ['win2', 'win1', 'win3'];
  const currentHashes = new Map(names.map((name) => [name, 'a'.repeat(64)]));
  const events = [];
  const calls = { status: [], build: [], update: [], smoke: [], readers: [] };
  const deps = {
    dataDir: f.dataDir,
    pinsFile: f.pinsFile,
    now: clock.now,
    sleep: clock.sleep,
    soakMs: 24 * 60 * 60 * 1000,
    pollIntervalMs: 5_000,
    drainTimeoutMs: 30_000,
    factories: async () => names.map((name) => ({ name, kind: 'container' })),
    status: async (name) => {
      events.push(`status:${name}`);
      calls.status.push(name);
      const next = overrides.status ? await overrides.status(name, calls) : { workers: 0 };
      return { pinsHash: currentHashes.get(name), ...next };
    },
    build: async (name, imageTag) => { events.push(`build:${name}`); calls.build.push({ name, imageTag }); return overrides.build?.(name, imageTag); },
    update: async (name, args = []) => {
      events.push(`update:${name}`);
      calls.update.push({ name, args });
      if (overrides.update) return overrides.update(name, args, currentHashes);
      currentHashes.set(name, f.desiredHash);
    },
    smoke: async (name, imageTag) => { events.push(`smoke:${name}`); calls.smoke.push({ name, imageTag }); return overrides.smoke?.(name, imageTag); },
    readers: async (name) => { events.push(`readers:${name}`); calls.readers.push(name); return overrides.readers?.(name); },
    output: (line) => { events.push(`output:${line}`); },
    ownerApproval: overrides.ownerApproval || (() => false),
  };
  return { deps, events, calls, currentHashes, clock };
}

test('tools promote updates win1 first, checks it, waits a day, then promotes factories one at a time', async (t) => {
  const f = fixture(t);
  const { deps, events, calls, currentHashes, clock } = dependencies(f);

  await toolsCommand(['promote', 'codex'], { promoteOptions: deps });

  assert.deepEqual(calls.build.map((call) => call.name), ['win1', 'win2', 'win3']);
  assert.deepEqual(calls.update.map((call) => call.name), ['win1', 'win2', 'win3']);
  assert.deepEqual(calls.smoke.map((call) => call.name), ['win1']);
  assert.deepEqual(calls.readers, ['win1']);
  assert.ok(events.indexOf('smoke:win1') < events.indexOf('build:win2'));
  assert.ok(events.indexOf('readers:win1') < events.indexOf('build:win2'));
  assert.deepEqual(clock.waits, [24 * 60 * 60 * 1000]);
  assert.ok([...currentHashes.values()].every((hash) => hash === f.desiredHash));
  const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'tools-promote.json'), 'utf8'));
  assert.deepEqual(state.tools.codex['0.160.1'].factories, {
    win1: { stage: 'done', soakUntil: Date.parse('2026-10-08T00:00:00.000Z') },
    win2: { stage: 'done' },
    win3: { stage: 'done' },
  });
  assert.equal(fs.statSync(path.join(f.dataDir, 'tools-promote.json')).mode & 0o777, 0o600);
});

test('tools promote waits for a worker to finish before building or updating the factory', async (t) => {
  const f = fixture(t);
  let checks = 0;
  const { deps, events, calls, clock } = dependencies(f, {
    names: ['win1'],
    status: async () => ({ workers: ++checks === 1 ? 1 : 0 }),
  });

  await toolsCommand(['promote', 'codex'], { promoteOptions: deps });

  assert.deepEqual(calls.build.map((call) => call.name), ['win1']);
  assert.ok(events.indexOf('status:win1') < events.indexOf('build:win1'));
  assert.deepEqual(clock.waits, [5_000, 24 * 60 * 60 * 1000]);
});

test('tools promote stops with drain timeout while a worker still runs', async (t) => {
  const f = fixture(t);
  const { deps, calls, clock } = dependencies(f, {
    names: ['win1'],
    status: async () => ({ workers: 1 }),
  });
  deps.drainTimeoutMs = 10_000;

  await assert.rejects(toolsCommand(['promote', 'codex'], { promoteOptions: deps }), /drain timeout/i);

  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.update, []);
  assert.deepEqual(clock.waits, [5_000, 5_000]);
  const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'tools-promote.json'), 'utf8'));
  assert.equal(state.tools.codex['0.160.1'].factories.win1.stage, 'planned');
});

test('canary failure stops before other factories and posts one keyed read Mailbox item', async (t) => {
  const f = fixture(t);
  const { deps, calls } = dependencies(f, {
    smoke: async () => { throw new Error('smoke failed'); },
  });

  await assert.rejects(toolsCommand(['promote', 'codex'], { promoteOptions: deps }), /canary.*failed/i);

  assert.deepEqual(calls.build.map((call) => call.name), ['win1']);
  assert.deepEqual(calls.update.map((call) => call.name), ['win1']);
  const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'tools-promote.json'), 'utf8'));
  assert.equal(state.tools.codex['0.160.1'].factories.win1.stage, 'failed');
  assert.equal(state.tools.codex['0.160.1'].factories.win1.resumeStage, 'canary');
  assert.equal(state.tools.codex['0.160.1'].factories.win2.stage, 'planned');
  const items = readMessages({ dir: f.dataDir }).filter((item) => item.key === 'tools:promote:codex:0.160.1');
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'read');
  assert.equal(items[0].title, 'Update failed: codex 0.160.1');
});

test('tools promote resumes a failed canary check without rebuilding or updating it again', async (t) => {
  const f = fixture(t);
  const first = dependencies(f, { smoke: async () => { throw new Error('smoke failed'); } });
  await assert.rejects(toolsCommand(['promote', 'codex'], { promoteOptions: first.deps }), /canary.*failed/i);

  const resumed = dependencies(f);
  resumed.currentHashes.set('win1', f.desiredHash);
  await toolsCommand(['promote', 'codex'], { promoteOptions: resumed.deps });

  assert.deepEqual(resumed.calls.build.map((call) => call.name), ['win2', 'win3']);
  assert.deepEqual(resumed.calls.update.map((call) => call.name), ['win2', 'win3']);
  assert.deepEqual(resumed.calls.smoke.map((call) => call.name), ['win1']);
  assert.deepEqual(resumed.calls.readers, ['win1']);
});

test('tools promote dry-run prints the rollout plan and writes nothing', async (t) => {
  const f = fixture(t);
  const { deps, events, calls } = dependencies(f);
  const before = fs.readdirSync(f.dataDir);

  await toolsCommand(['promote', 'codex', '--dry-run'], { promoteOptions: deps });

  assert.deepEqual(fs.readdirSync(f.dataDir), before);
  assert.deepEqual(calls.status, []);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.update, []);
  assert.deepEqual(calls.smoke, []);
  assert.deepEqual(calls.readers, []);
  assert.ok(events.some((event) => event.includes('win1')));
});

test('tools promote refuses when the factory status cannot prove that workers are idle', async (t) => {
  const f = fixture(t);
  const { deps, calls } = dependencies(f, { names: ['win1'], status: async () => ({ workers: null }) });

  await assert.rejects(toolsCommand(['promote', 'codex'], { promoteOptions: deps }), /cannot prove.*worker/i);

  assert.deepEqual(calls.build, []);
  assert.deepEqual(calls.update, []);
});

test('tools promote prints the exact factory update command when no Owner approval is recorded', async (t) => {
  const f = fixture(t);
  const { deps, calls } = dependencies(f, {
    names: ['win1'],
    update: async () => { throw new Error('A Boss pane is live. Repeat the image update with --allow-boss-restart; the update will not start a Boss session.'); },
  });

  await assert.rejects(toolsCommand(['promote', 'codex'], { promoteOptions: deps }), /herdr-boss factory update win1 --tier image --allow-boss-restart/);

  assert.deepEqual(calls.update, [{ name: 'win1', args: [] }]);
  const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'tools-promote.json'), 'utf8'));
  assert.equal(state.tools.codex['0.160.1'].factories.win1.stage, 'canary');
  assert.deepEqual(readMessages({ dir: f.dataDir }), []);
});

test('tools promote passes --allow-boss-restart only after an exact Owner approval', async (t) => {
  const f = fixture(t);
  const { deps, calls } = dependencies(f, {
    names: ['win1'],
    ownerApproval: () => true,
    update: async (name, args, currentHashes) => {
      if (!args.includes('--allow-boss-restart')) throw new Error('A Boss pane is live. Repeat the image update with --allow-boss-restart; the update will not start a Boss session.');
      currentHashes.set(name, f.desiredHash);
    },
  });

  await toolsCommand(['promote', 'codex'], { promoteOptions: deps });

  assert.deepEqual(calls.update, [
    { name: 'win1', args: [] },
    { name: 'win1', args: ['--allow-boss-restart'] },
  ]);
});

test('tools promote uses the existing factory build, update, status, and shell command paths', async (t) => {
  const f = fixture(t);
  const clock = fakeClock();
  const imageTag = `herdr-boss-factory:${f.desiredHash}`;
  const currentHashes = new Map([['win1', 'a'.repeat(64)]]);
  const commands = [];
  const factoryCommand = async (args) => {
    commands.push(args);
    if (args[0] === 'list') return { stdout: JSON.stringify({ factories: [{ name: 'win1', kind: 'container' }] }), code: 0 };
    if (args[0] === 'status') return { stdout: JSON.stringify({ workers: 0, pinsHash: currentHashes.get(args[1]) }), code: 0 };
    if (args[0] === 'update') currentHashes.set(args[1], f.desiredHash);
    return { stdout: '', code: 0 };
  };

  await toolsCommand(['promote', 'codex'], { promoteOptions: {
    dataDir: f.dataDir,
    pinsFile: f.pinsFile,
    env: {},
    factoryCommand,
    smoke: async () => {},
    ownerApproval: () => false,
    now: clock.now,
    sleep: clock.sleep,
    output: () => {},
  } });

  assert.ok(commands.some((args) => JSON.stringify(args) === JSON.stringify(['build', 'win1', '--image', imageTag])));
  assert.ok(commands.some((args) => JSON.stringify(args) === JSON.stringify(['update', 'win1', '--tier', 'image'])));
  assert.ok(commands.some((args) => JSON.stringify(args) === JSON.stringify(['status', 'win1', '--json'])));
  assert.ok(commands.some((args) => JSON.stringify(args) === JSON.stringify([
    'shell', 'win1', '--', 'node', '/home/factory/herdr-boss/src/cli.js', 'doctor', '--json',
  ])));
});
