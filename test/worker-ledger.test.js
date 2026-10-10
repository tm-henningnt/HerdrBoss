import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { runKitCommand } from '../src/kit/cli.js';
import { readDelegatedRuns } from '../src/kit/orchestration.js';
import { readWorkerFacts } from '../src/task-state.js';

function fixture(t, { commits = false, panes = [], agents = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-ledger-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'repo'), dataDir = path.join(home, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dataDir);
  const env = { HOME: home, HERDR_BOSS_DIR: dataDir, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'fixture\n');
  git('add', 'seed.txt'); git('commit', '-qm', 'fixture base');
  const baseCommit = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'parked-worker');
  if (commits) {
    fs.writeFileSync(path.join(root, 'result.txt'), 'unfinished change\n');
    git('add', 'result.txt'); git('commit', '-qm', 'fixture change');
  }
  const config = {
    root, slug: 'alpha', runsPath: path.join(root, '.orchestration', 'runs'),
    ledgerPath: path.join(root, 'delegated-runs.jsonl'), evidenceTiers: ['unit'],
    worktreePath: (name) => path.join(home, name),
  };
  fs.mkdirSync(config.runsPath, { recursive: true });
  const file = path.join(config.runsPath, 'parked-worker.json');
  const record = {
    name: 'parked-worker', project: 'alpha', issue: null, taskId: 'T1', kind: 'codex', model: 'fixture-model',
    worktree: root, branch: 'parked-worker', base: 'main', baseCommit, pane: 'ws:old-worker',
    startedAt: '2026-10-10T08:00:00.000Z', parked: { at: '2026-10-10T08:10:00.000Z', reason: 'fixture wait' },
  };
  fs.writeFileSync(file, JSON.stringify(record));
  const calls = [], output = [];
  const herdr = (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'list') return { panes };
    if (args[0] === 'agent' && args[1] === 'list') return { agents };
    throw new Error('Unexpected Herdr call');
  };
  const options = { config, env, herdr, lockDataDir: dataDir, now: () => Date.parse('2026-10-10T09:00:00.000Z'), output: (line) => output.push(line) };
  return { home, root, dataDir, env, config, file, record, git, calls, output, options };
}

const repair = (f, name = 'parked-worker', reason = 'fixture recovery') => runKitCommand('worker', ['ledger', 'repair', name, '--reason', reason], f.options);

for (const [commits, outcome] of [[false, 'abandoned'], [true, 'failed']]) {
  test(`worker ledger repair marks a parked run without a pane ${outcome} and audits a masked reason`, (t) => {
    const f = fixture(t, { commits });
    const credential = ['fixture', 'credential'].join('-');
    const result = repair(f, 'parked-worker', `recovery Bearer ${credential}`);
    assert.equal(result.outcome, outcome);
    const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(saved.state, outcome);
    assert.equal(saved.outcome, outcome);
    assert.equal(saved.finishedAt, '2026-10-10T09:00:00.000Z');
    assert.equal(saved.parked, undefined);
    const entries = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: ['unit'] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, outcome);
    assert.equal(entries[0].independentGate.passed, false);
    assert.deepEqual(entries[0].changedPaths, commits ? ['result.txt'] : []);
    assert.match(entries[0].independentGate.command, /unverified/i);
    const audit = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'action-audit.jsonl'), 'utf8').trim());
    assert.equal(audit.command, 'worker ledger repair');
    assert.equal(audit.workerName, 'parked-worker');
    assert.equal(audit.project, 'alpha');
    assert.ok(!audit.reason.includes(credential));
    assert.match(audit.reason, /\[REDACTED\]/);
    assert.ok(f.output.some((line) => line.includes(outcome)));
    assert.equal(readWorkerFacts(f.config.runsPath, { isLive: () => false, now: Date.parse(saved.finishedAt) })[0].phase, outcome);
    runKitCommand('ledger', ['check', '--runs'], f.options);
    assert.ok(f.output.some((line) => line.includes('ledger: PASS')));
    assert.equal(f.git('branch', '--show-current'), 'parked-worker');
    assert.ok(fs.existsSync(path.join(f.root, 'seed.txt')));
    assert.throws(() => repair(f), /already.*finished/i);
    assert.equal(readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: ['unit'] }).length, 1);
  });
}

test('worker ledger repair refuses a parked run with a live pane even without a live agent', (t) => {
  const f = fixture(t, { panes: [{ pane_id: 'ws:old-worker' }] });
  const before = fs.readFileSync(f.file);
  assert.throws(() => repair(f), /live pane/i);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'action-audit.jsonl')), false);
});

test('worker ledger repair refuses an unknown worker', (t) => {
  const f = fixture(t);
  assert.throws(() => repair(f, 'unknown'), /No run record for worker unknown/);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'action-audit.jsonl')), false);
});

test('worker ledger repair refuses a missing reason, unreadable live panes, or unprovable commits', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  assert.throws(() => runKitCommand('worker', ['ledger', 'repair', 'parked-worker'], f.options), /reason/);
  assert.throws(() => repair({ ...f, options: { ...f.options, herdr: () => { throw new Error('unavailable'); } } }), /live pane|Herdr/i);
  f.git('branch', '-m', 'other');
  assert.throws(() => repair(f), /commits/i);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(f.config.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'action-audit.jsonl')), false);
});
