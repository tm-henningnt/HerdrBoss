import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workerRunId } from '../src/agent-messages.js';
import { collectBrowserClients } from '../src/collect.js';
import { agentBrowserTabIds, forgetAgentBrowserTab, recordAgentBrowserTab } from '../src/browser-activity.js';
import {
  inspectUncollectedWorkers,
  processDueWorkerPaneCloses,
  readWorkerPaneCloses,
  scheduleWorkerPaneClose,
  shouldCloseManagedBrowser,
  trackBrowserIdle,
} from '../src/maintenance.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRecord(overrides = {}) {
  return {
    project: 'fixture-project',
    name: 'fixture-worker',
    kind: 'codex',
    startedAt: '2026-10-01T10:00:00.000Z',
    pane: 'fixture-pane',
    worktree: '/tmp/fixture-worktree',
    ...overrides,
  };
}

test('worker pane close waits until its due time and looks up the pane from the run record', async (t) => {
  const dir = tempDir(t);
  const run = runRecord({ finishedAt: '2026-10-01T10:01:00.000Z' });
  const runId = workerRunId(run, run.project);
  scheduleWorkerPaneClose({ project: run.project, name: run.name, runId, dueAt: 2000, dir });
  const closed = [];
  const shared = {
    dir,
    panes: [{ id: run.pane, name: run.name, agent: run.kind, status: 'done' }],
    readRun: () => run,
    closePane: async (pane) => closed.push(pane),
  };

  await processDueWorkerPaneCloses({ ...shared, now: 1999 });
  assert.deepEqual(closed, []);
  assert.equal(readWorkerPaneCloses({ dir }).length, 1);

  await processDueWorkerPaneCloses({ ...shared, now: 2000 });
  assert.deepEqual(closed, [run.pane]);
  assert.deepEqual(readWorkerPaneCloses({ dir }), []);
});

test('worker pane close skips a pane that now runs another agent', async (t) => {
  const dir = tempDir(t);
  const run = runRecord({ finishedAt: '2026-10-01T10:01:00.000Z' });
  scheduleWorkerPaneClose({ project: run.project, name: run.name, runId: workerRunId(run), dueAt: 1, dir });
  const closed = [];

  const result = await processDueWorkerPaneCloses({
    dir,
    now: 1,
    panes: [{ id: run.pane, name: 'replacement-agent', agent: 'claude', status: 'working' }],
    readRun: () => run,
    closePane: async (pane) => closed.push(pane),
  });

  assert.deepEqual(closed, []);
  assert.equal(result.skipped, 1);
  assert.deepEqual(readWorkerPaneCloses({ dir }), []);
});

test('uncollected worker alerts wait for the configured age and use one key per run', () => {
  const now = 1000;
  const run = runRecord();
  const pane = { id: run.pane, name: run.name, agent: run.kind, status: 'done', workspace: 'fixture-workspace' };
  const first = inspectUncollectedWorkers({ panes: [pane], runs: [run], now, minutes: 30 });
  assert.deepEqual(first.notices, []);

  const due = inspectUncollectedWorkers({ panes: [pane], runs: [run], observed: first.observed, now: now + 30 * 60_000, minutes: 30 });
  assert.equal(due.notices.length, 1);
  assert.equal(due.notices[0].key, `workers:uncollected:${workerRunId(run)}`);
  assert.equal(due.notices[0].scope, 'fixture-workspace');
  assert.match(due.notices[0].text, /fixture-worker.*30 minutes.*herdr-boss worker collect fixture-worker/);
  assert.equal(due.notices[0].once, true);
});

test('a project browser closes only after a quiet interval with no attached client or agent tab', () => {
  const session = { project: 'fixture-project', port: 9224, profile: '/tmp/profile', launchedAt: '2026-10-01T10:00:00.000Z' };
  const initialProbe = { ok: true, pageIds: ['default-tab'], attachedTabIds: [] };
  const first = trackBrowserIdle({}, session, { probe: initialProbe, clientCount: 0, agentTabIds: [] }, { now: 0, idleCloseMinutes: 20 });
  assert.equal(first.closeDue, false);

  const before = trackBrowserIdle(first.state, session, { probe: initialProbe, clientCount: 0, agentTabIds: [] }, { now: 20 * 60_000 - 1, idleCloseMinutes: 20 });
  assert.equal(before.closeDue, false);
  const due = trackBrowserIdle(before.state, session, { probe: initialProbe, clientCount: 0, agentTabIds: [] }, { now: 20 * 60_000, idleCloseMinutes: 20 });
  assert.equal(due.closeDue, true);

  const attached = trackBrowserIdle(first.state, session, { probe: initialProbe, clientCount: 1, agentTabIds: [] }, { now: 25 * 60_000, idleCloseMinutes: 20 });
  assert.equal(attached.closeDue, false);
  assert.equal(attached.state['fixture-project'].idleSince, null);

  const agentTab = trackBrowserIdle(first.state, session, { probe: initialProbe, clientCount: 0, agentTabIds: ['default-tab'] }, { now: 25 * 60_000, idleCloseMinutes: 20 });
  assert.equal(agentTab.closeDue, false);
  assert.equal(agentTab.state['fixture-project'].idleSince, null);
});

test('a foreign or unlaunched browser is never eligible for idle close', () => {
  assert.equal(shouldCloseManagedBrowser({ session: { launchedAt: null }, matched: true, closeDue: true }), false);
  assert.equal(shouldCloseManagedBrowser({ session: { launchedAt: '2026-10-01T10:00:00.000Z' }, matched: false, closeDue: true }), false);
  assert.equal(shouldCloseManagedBrowser({ session: { launchedAt: '2026-10-01T10:00:00.000Z' }, matched: true, closeDue: true }), true);
});

test('browser tab open and close events survive in the service data directory', (t) => {
  const dir = tempDir(t);
  recordAgentBrowserTab('fixture-project', 'agent-tab', { now: 1000, dir });
  assert.deepEqual(agentBrowserTabIds('fixture-project', { dir }), ['agent-tab']);
  forgetAgentBrowserTab('fixture-project', 'agent-tab', { dir });
  assert.deepEqual(agentBrowserTabIds('fixture-project', { dir }), []);
});

test('CDP client collection excludes the service and browser processes', async () => {
  let argsSeen;
  const count = await collectBrowserClients(9224, {
    servicePid: 101,
    browserPid: 202,
    runner: async (command, args) => {
      assert.equal(command, 'lsof');
      argsSeen = args;
      return 'p101\np202\np303\np303\n';
    },
  });
  assert.deepEqual(argsSeen, ['-nP', '-iTCP:9224', '-sTCP:ESTABLISHED', '-Fp']);
  assert.equal(count, 1);
});
