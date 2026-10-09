import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctorCommand } from '../src/doctor.js';
import { renderBulletin } from '../src/rules.js';
import { startWorker } from '../src/kit/workers.js';
import { loadModels } from '../src/kit/config.js';
import { hasCodexHookReviewDialog, readCodexLaneBlock, writeCodexLaneBlock } from '../src/codex-lane.js';
import { setupFixture } from './helpers/kit-fixture.js';

const REASON = 'blocked: Codex hook needs Owner review';
const INSTRUCTION = 'Run codex once in a terminal and review the changed hook.';
const BLOCK_FILE = 'codex-lane.json';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function putBlock(dataDir, blockedAt = NOW) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, BLOCK_FILE), JSON.stringify({
    schema: 1,
    kind: 'codex',
    reason: REASON,
    blockedAt: new Date(blockedAt).toISOString(),
  }));
}

function workerFixture(t, name, paneSnapshotReader, {
  workerKind = 'codex',
  clock: injectedClock = null,
  wait: injectedWait = null,
  wrapHerdr = null,
} = {}) {
  const f = setupFixture(null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codex-hook-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  f.env.HERDR_BOSS_DIR = dataDir;
  const commands = [];
  const output = [];
  let agentClosed = false;
  const baseHerdr = (args) => {
    commands.push(args.slice(0, 2).join(' '));
    if (args[0] === 'agent' && args[1] === 'close') { agentClosed = true; return {}; }
    if (args[0] === 'agent' && args[1] === 'get' && agentClosed) throw Object.assign(new Error('agent_not_found'), { code: 'agent_not_found' });
    return f.herdr(args);
  };
  const herdr = wrapHerdr ? wrapHerdr(baseHerdr, { commands, f }) : baseHerdr;
  let clockNow = NOW;
  const run = (deps = {}) => startWorker(name, {
    kind: workerKind, task: 'x', allow: ['src/'], noWorktree: true,
  }, {
    config: f.config,
    models: loadModels(),
    herdr,
    env: f.env,
    rulesFile: f.rulesFile,
    freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }),
    serviceConfig: { worktrees: { minFreeGb: 8 } },
    paneSnapshotReader,
    clock: injectedClock ?? (() => clockNow),
    wait: injectedWait ?? ((ms) => { clockNow += ms; }),
    output: (line) => output.push(line),
    ...deps,
  });
  return { f, dataDir, commands, output, run, get clockNow() { return clockNow; } };
}

test('a Codex hook review dialog blocks the run, closes the pane, and records the lane block', (t) => {
  let reads = 0;
  const fixture = workerFixture(t, 'codex-hook-review', () => {
    reads += 1;
    if (reads === 1) return 'shell prompt';
    return reads >= 4 ? '1 hook needs review' : 'Codex is starting';
  });
  const result = fixture.run();
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));

  assert.equal(record.state, 'blocked');
  assert.equal(record.reason, REASON);
  assert.ok(fixture.commands.includes('agent close'));
  assert.ok(fixture.commands.includes('pane close'));
  assert.equal(fixture.commands.includes('agent prompt'), false, 'the dialog receives no prompt');
  assert.equal(fs.existsSync(path.join(fixture.dataDir, BLOCK_FILE)), true);
  assert.deepEqual(fixture.output.slice(-2), [REASON, INSTRUCTION]);
});

test('the plural hooks review dialog also blocks a Codex run', (t) => {
  let reads = 0;
  const fixture = workerFixture(t, 'codex-hooks-review', () => {
    reads += 1;
    return reads === 1 ? 'shell prompt' : reads >= 3 ? '2 hooks need review' : 'Codex is starting';
  });
  const result = fixture.run();
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
  assert.equal(record.state, 'blocked');
  assert.equal(record.reason, REASON);
  assert.ok(fixture.commands.includes('pane close'));
});

test('a Codex start without the dialog stays running and clears the lane block', (t) => {
  let reads = 0;
  const fixture = workerFixture(t, 'codex-hook-clear', () => {
    reads += 1;
    return reads === 1 ? 'shell prompt' : 'Codex is ready';
  });
  putBlock(fixture.dataDir);

  const result = fixture.run();
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
  assert.equal(record.state, 'running');
  assert.equal(fixture.commands.includes('agent prompt'), true);
  assert.equal(fs.existsSync(path.join(fixture.dataDir, BLOCK_FILE)), false);
});

test('a healthy Codex prompt ends pane polling without advancing the injected clock', (t) => {
  let launched = false;
  let prompted = false;
  let pollWaits = 0;
  const fixture = workerFixture(t, 'codex-prompt-ready', () => launched
    ? '› Ask Codex to do anything\n? for shortcuts'
    : 'shell prompt', {
    clock: () => NOW,
    wait: () => { if (launched && !prompted) pollWaits += 1; },
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'start') launched = true;
      if (args[0] === 'agent' && args[1] === 'prompt') prompted = true;
      return base(args);
    },
  });

  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(pollWaits, 0);
  assert.equal(prompted, true);
});

test('a pane that reads as unavailable does not fail the Codex start', (t) => {
  let reads = 0;
  const fixture = workerFixture(t, 'codex-pane-unreadable', () => {
    reads += 1;
    return null;
  });
  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(fixture.commands.includes('agent prompt'), true);
  assert.equal(fixture.output.some((line) => /secret|private|token/i.test(line)), false);
});

test('a pane read failure during the poll does not fail the Codex start', (t) => {
  let launched = false;
  let now = NOW;
  let promptSent = false;
  const fixture = workerFixture(t, 'codex-pane-read-failure', null, {
    clock: () => now,
    wait: (ms) => { now += ms; },
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'start') launched = true;
      if (args[0] === 'agent' && args[1] === 'prompt') promptSent = true;
      if (launched && args[0] === 'pane' && args[1] === 'read') throw new Error('private read diagnostic');
      return base(args);
    },
  });
  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(promptSent, true);
  assert.equal(fixture.output.some((line) => line.includes('private read diagnostic')), false);
});

test('a missing pane read command does not fail the Codex start', (t) => {
  let launched = false;
  const fixture = workerFixture(t, 'codex-pane-read-missing', null, {
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'start') launched = true;
      if (launched && args[0] === 'pane' && args[1] === 'read') throw Object.assign(new Error('unknown command'), { code: 'unknown_command' });
      return base(args);
    },
  });
  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(fixture.commands.includes('agent prompt'), true);
});

test('a review word alone reaches the no-match timeout and does not block Codex', (t) => {
  let launched = false;
  let prompted = false;
  let now = NOW;
  let pollWaitMs = 0;
  const fixture = workerFixture(t, 'codex-review-word', () => launched ? 'review' : 'shell prompt', {
    clock: () => now,
    wait: (ms) => {
      if (launched && !prompted) pollWaitMs += ms;
      now += ms;
    },
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'start') launched = true;
      if (args[0] === 'agent' && args[1] === 'prompt') prompted = true;
      return base(args);
    },
  });
  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(pollWaitMs, 20_000);
  assert.equal(prompted, true);
});

test('hook review wording in an echoed brief does not block the pane', (t) => {
  let launched = false;
  const fixture = workerFixture(t, 'codex-echoed-brief', () => launched
    ? `Read .worker/codex-echoed-brief/brief.md in your working directory and execute it.\nThe task says hook needs review.`
    : 'shell prompt', {
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'start') launched = true;
      return base(args);
    },
  });
  const result = fixture.run();
  assert.equal(result.state, 'running');
  assert.equal(fixture.commands.includes('agent prompt'), true);
});

test('only the two exact hook review phrases match', () => {
  assert.equal(hasCodexHookReviewDialog('1 hook needs review'), true);
  assert.equal(hasCodexHookReviewDialog('2 hooks need review'), true);
  assert.equal(hasCodexHookReviewDialog('hook need review'), false);
  assert.equal(hasCodexHookReviewDialog('hooks needs review'), false);
  assert.equal(hasCodexHookReviewDialog('hook needs reviewer'), false);
  assert.equal(hasCodexHookReviewDialog('review'), false);
});

test('a Codex close failure keeps the blocked record and lane block and reports the open pane', (t) => {
  let reads = 0;
  const fixture = workerFixture(t, 'codex-close-failure', () => {
    reads += 1;
    return reads === 1 ? 'shell prompt' : 'hook needs review';
  }, {
    wrapHerdr: (base) => (args) => {
      if (args[0] === 'agent' && args[1] === 'close') throw new Error('private close diagnostic');
      return base(args);
    },
  });
  const result = fixture.run();
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
  assert.equal(record.state, 'blocked');
  assert.equal(record.reason, REASON);
  assert.equal(fs.existsSync(path.join(fixture.dataDir, BLOCK_FILE)), true);
  assert.equal(fixture.commands.includes('pane close'), false);
  assert.ok(fixture.output.includes('The Codex worker pane stays open because Herdr could not close the agent.'));
  assert.equal(fixture.output.some((line) => line.includes('private close diagnostic')), false);
});

test('a non-Codex worker record does not gain a state field', (t) => {
  const fixture = workerFixture(t, 'claude-no-new-state', null, { workerKind: 'claude' });
  const result = fixture.run();
  const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
  assert.equal(Object.hasOwn(record, 'state'), false);
});

test('doctor prints the active Codex lane block and its recovery instruction', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codex-doctor-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  putBlock(dataDir);
  const lines = [];
  await doctorCommand([], {
    home: path.join(os.tmpdir(), 'invented-owner-home'),
    env: {},
    dataDir,
    now: NOW,
    runner: async () => true,
    output: (line) => lines.push(line),
  });
  assert.ok(lines.some((line) => line.includes(REASON) && line.includes(INSTRUCTION)));

  const jsonLines = [];
  await doctorCommand(['--json'], {
    home: path.join(os.tmpdir(), 'invented-owner-home'),
    env: {},
    dataDir,
    now: NOW,
    runner: async () => true,
    output: (line) => jsonLines.push(line),
  });
  const report = JSON.parse(jsonLines[0]);
  assert.ok(report.warnings.some((warning) => warning.includes(REASON) && warning.includes(INSTRUCTION)));
});

test('the bulletin shows a blocked Codex lane with the recorded reason', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codex-bulletin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  putBlock(dataDir);
  const bulletin = renderBulletin({
    updatedAt: new Date(NOW).toISOString(),
    lanes: { codex: { state: 'open', roomPercent: 25 } },
  }, { alerts: [], advice: [] }, {}, { dataDir, now: NOW });
  assert.match(bulletin, /Use now: codex \(blocked: Codex hook needs Owner review\)/);
});

test('the Codex lane block expires after six hours', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codex-expiry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  putBlock(dataDir, NOW);
  const activeBulletin = renderBulletin({
    updatedAt: new Date(NOW).toISOString(),
    lanes: { codex: { state: 'open', roomPercent: 25 } },
  }, { alerts: [], advice: [] }, {}, { dataDir, now: NOW });
  assert.match(activeBulletin, /Use now: codex \(blocked: Codex hook needs Owner review\)/);
  const bulletin = renderBulletin({
    updatedAt: new Date(NOW + 6 * 60 * 60_000).toISOString(),
    lanes: { codex: { state: 'open', roomPercent: 25 } },
  }, { alerts: [], advice: [] }, {}, { dataDir, now: NOW + 6 * 60 * 60_000 });
  assert.match(bulletin, /Use now: codex \(below pace\)/);
});

test('a second Codex block overwrites the first timestamp', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codex-overwrite-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  writeCodexLaneBlock({ dir: dataDir, now: NOW - 1000 });
  writeCodexLaneBlock({ dir: dataDir, now: NOW });
  const block = readCodexLaneBlock({ dir: dataDir, now: NOW });
  assert.equal(block.blockedAt, NOW);
});
