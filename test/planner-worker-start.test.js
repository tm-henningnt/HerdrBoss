// PS1: `worker start --planner` creates the planner session record for the new worker pane and labels the pane.
import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModels } from '../src/kit/config.js';
import { collectWorker, startWorker } from '../src/kit/workers.js';
import { listSessions, getSession } from '../src/planner-sessions.js';
import { git, setupFixture } from './helpers/kit-fixture.js';

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

// A fixture whose Herdr runner also records the full arguments of each call and accepts `pane rename`.
function fixture() {
  const f = setupFixture(null);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [], policy: { allowedKinds: ['codex'], excludedModels: [], modelProviders: { 'gpt-6-luna': null } } }));
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '--allow-empty', '-m', 'fixture configuration');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-planner-start-'));
  dirs.push(dataDir);
  const renames = [];
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'rename') { renames.push(args); return {}; }
    return f.herdr(args);
  };
  return { ...f, herdr, renames, dataDir, env: { ...f.env, HERDR_BOSS_DIR: dataDir } };
}

const start = (f, name, extra = {}) => startWorker(name, { kind: 'codex', model: 'gpt-6-luna', task: 'Plan the export feature.', allow: ['.orchestration/runs/'], noWorktree: true, ...extra }, {
  config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
});

test('worker start --planner records a planner session for the new pane and labels the pane', () => {
  const f = fixture();
  const run = start(f, 'plan-one', { planner: true });
  const sessions = listSessions({ dir: f.dataDir });
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.project, f.config.slug);
  assert.equal(session.pane, run.pane);
  assert.equal(session.kind, 'codex');
  assert.ok(session.input.endsWith(path.join(run.workerDir, 'brief.md')), session.input);
  assert.deepEqual(f.renames, [['pane', 'rename', run.pane, 'planner']]);
});

test('worker start without --planner writes no session and does not rename the pane', () => {
  const f = fixture();
  start(f, 'plain-one');
  assert.deepEqual(listSessions({ dir: f.dataDir, all: true }), []);
  assert.deepEqual(f.renames, []);
});

test('a dry run with --planner writes no session and names the step in the plan', () => {
  const f = fixture();
  const lines = [];
  startWorker('plan-dry', { kind: 'codex', model: 'gpt-6-luna', task: 'x', allow: ['.orchestration/runs/'], noWorktree: true, dryRun: true, planner: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: (line) => lines.push(line),
  });
  assert.deepEqual(listSessions({ dir: f.dataDir, all: true }), []);
  assert.match(lines.join('\n'), /planner session/i);
});

test('the kit CLI parses --planner as a switch, passes it on, and lists it in the usage', () => {
  const source = fs.readFileSync(new URL('../src/kit/cli.js', import.meta.url), 'utf8');
  assert.match(source, /boolean: \[[^\]]*'--planner'/);
  assert.match(source, /knownFlags\(flags, \[[^\]]*'planner'/);
  assert.match(source, /planner: flags\.planner/);
  assert.match(source, /worker start <name> --kind <kind>[^\n]*\[--planner\]/);
});

test('worker collect ends the planner session of the collected pane', () => {
  const f = fixture();
  const run = start(f, 'plan-two', { planner: true });
  const [session] = listSessions({ dir: f.dataDir });
  const reportDir = path.join(run.worktree, run.workerDir);
  fs.writeFileSync(path.join(reportDir, 'report.md'), 'Done.\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
    issue: null, branch: run.branch, worktree: run.worktree, changedPaths: ['.orchestration/runs/plan-two.json'], commands: ['focused check'],
    evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
  }));
  const lines = [];
  collectWorker('plan-two', { record: true, outcome: 'done', gatePassed: true }, {
    config: f.config, now: Date.parse('2026-09-25T17:00:00Z'), output: (line) => lines.push(line), listWorktreeProcesses: () => [],
    recordUsageFn: () => ({ errors: [], duplicate: false }), leaseDataDir: f.dataDir, schedulePaneCloseFn: () => {},
  });
  assert.equal(getSession({ dir: f.dataDir, id: session.id }).endedAt, '2026-09-25T17:00:00.000Z');
  assert.match(lines.join('\n'), /Ended planner session/);
});
