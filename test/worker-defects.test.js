import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { runKitCommand } from '../src/kit/cli.js';
import { loadModels } from '../src/kit/config.js';
import { readDelegatedRuns, validateDelegatedRun } from '../src/kit/orchestration.js';
import { startWorker, recordFlagErrors } from '../src/kit/workers.js';
import { buildModelScorecard } from '../src/engine.js';
import { readUsage, validateUsage } from '../src/usage.js';
import { git, setupFixture, validRun } from './helpers/kit-fixture.js';

test('worker collect records supplied counts and leaves an omitted count absent', (t) => {
  for (const defects of [3, 0, 99, undefined]) {
    const f = setupFixture(null);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    git(f.root, 'add', '-A');
    git(f.root, 'commit', '-m', 'fixture configuration');
    const run = startWorker(`count-${defects ?? 'unknown'}`, { kind: 'codex', task: 'x', noWorktree: true, allow: ['.orchestration/runs/'] }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: f.env, rulesFile: f.rulesFile, output: () => {},
      freeSpaceReader: () => ({ bsize: 1, bavail: 500 * 1024 ** 3 }), serviceConfig: { worktrees: { minFreeGb: 8 } },
    });
    const reportDir = path.join(run.worktree, run.workerDir);
    fs.writeFileSync(path.join(reportDir, 'report.md'), 'Reviewed.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({
      issue: null, branch: run.branch, worktree: run.worktree, changedPaths: [`.orchestration/runs/${run.name}.json`],
      commands: ['scoped check'], evidenceTier: ['unit'], unverified: [], stoppedEarly: false,
    }));
    runKitCommand('worker', ['collect', run.name, ...(defects === undefined ? [] : ['--defects', String(defects)]), '--outcome', 'done', '--gate-passed', '--keep-pane'], {
      config: f.config, herdr: f.herdr, output: () => {}, listWorktreeProcesses: () => [],
      serviceConfig: { worktrees: { pruneAtCollect: false } },
    });
    const entry = readDelegatedRuns(f.config.ledgerPath, { evidenceTiers: f.config.evidenceTiers })[0];
    assert.equal(entry.defects, defects);
    assert.equal(Object.hasOwn(entry, 'defects'), defects !== undefined);
    const event = readUsage().find((e) => e.id === `worker:${f.config.slug}:${run.name}:${run.startedAt}`);
    assert.equal(event.defects, defects);
    assert.equal(Object.hasOwn(event, 'defects'), defects !== undefined);
    const row = buildModelScorecard([event])[0];
    assert.equal(row.firstTime, 1);
    assert.equal(row.defects, defects ?? null);
    assert.equal(row.defectRuns, defects === undefined ? 0 : 1);
  }
});


test('defects is optional and accepts only integer counts from 0 to 99', () => {
  const options = { outcome: 'done', gatePassed: true };
  assert.deepEqual(recordFlagErrors(options), []);
  assert.deepEqual(validateDelegatedRun(validRun, { evidenceTiers: ['unit'] }), []);
  for (const defects of [0, 99]) {
    assert.deepEqual(recordFlagErrors({ ...options, defects }), []);
    assert.deepEqual(validateDelegatedRun({ ...validRun, defects }, { evidenceTiers: ['unit'] }), []);
  }
  for (const defects of [-1, 100, 0.5, '3', null, NaN]) {
    assert.match(recordFlagErrors({ ...options, defects }).join(), /defects.*0 to 99/);
    assert.match(validateDelegatedRun({ ...validRun, defects }, { evidenceTiers: ['unit'] }).join(), /defects.*0 to 99/);
    assert.match(validateUsage({ defects }).join(), /defects.*0 to 99/);
  }
});

test('scorecard distinguishes an unrecorded count from a recorded zero and counts coverage', () => {
  const event = { kind: 'codex', model: 'sample', startedAt: '2026-10-08T10:00:00Z', endedAt: '2026-10-08T10:01:00Z', modelOutcome: { result: 'first-time' } };
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(buildModelScorecard([event], now)[0].defects, null);
  const row = buildModelScorecard([event, { ...event, defects: 0 }, { ...event, defects: 4 }, { ...event, defects: 100 }], now)[0];
  assert.equal(row.defects, 4);
  assert.equal(row.defectRuns, 2);
});

test('scorecard details show defect totals and the number of runs with a count', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('function modelScorecardBlock('), source.indexOf('const HARNESS_NAMES ='));
  const render = runInNewContext(`${block}; modelScorecardBlock`, { esc: String, HARNESS_NAMES: {} });
  const html = render({ modelScorecard: [{ kind: 'codex', model: 'sample', runs: 3, firstTime: 1, rework: 2, failed: 0, reworkRate: 2 / 3, defects: 4, defectRuns: 2 }] });
  assert.match(html, /<th>Defects<\/th>/);
  assert.match(html, /data-label="Defects">4 \(2 \/ 3 runs\)/);
  assert.match(render({ modelScorecard: [{ kind: 'codex', model: 'old', reworkRate: 0 }] }), /data-label="Defects">—/);
});

test('worker collect refuses malformed and out-of-range defect flags before collection', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  for (const value of ['-1', '100', '0.5', '', 'NaN', '1e1']) {
    assert.throws(() => runKitCommand('worker', ['collect', 'absent', '--defects', value], { config: f.config }), /defects.*0 to 99/);
  }
});
