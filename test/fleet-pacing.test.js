import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupFixture } from './helpers/kit-fixture.js';
import { loadModels } from '../src/kit/config.js';
import { describeLane } from '../src/kit/workers.js';
import { startWorker } from './helpers/start-worker.js';
import { loadPolicy, laneStatus, pacingGoal, writePolicy } from '../src/control.js';
import { writeFleetFile } from '../src/fleet-store.js';

test('worker dispatch reads a newly lowered factory ceiling before the next rules tick, even with force', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dir = path.join(f.root, 'factory-data');
  const key = 'a'.repeat(64);
  writeFleetFile(path.join(dir, 'factory-identity.json'), { factoryId: 'factory-a' });
  writeFleetFile(path.join(dir, 'fleet-accounts.json'), [{ harness: 'codex', accountKey: key, scope: ['factory-a'] }]);
  fs.writeFileSync(f.rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), lanes: { codex: { state: 'open', factoryShareUsedPercent: 55, reading: { usedPercent: 25 } } } }));
  for (const share of [0, 20, 40]) {
    writeFleetFile(path.join(dir, 'fleet-guidance.json'), { shares: [{ accountKey: key, share }] });
    assert.throws(() => startWorker('fleet-refused', { kind: 'codex', task: 'Sample task', allow: ['src/'], force: true, reason: 'Verify the factory share refusal with an authorized override', dryRun: true }, {
      config: f.config, models: loadModels(), herdr: f.herdr, env: { ...f.env, HERDR_BOSS_DIR: dir }, rulesFile: f.rulesFile, output: () => {},
    }), /factory share/i);
    assert.ok(!f.calls.includes('agent start'));
  }
});


const accountKey = 'a'.repeat(64);
const localAccount = { harness: 'codex', accountKey, scope: ['factory-a'] };
for (const [name, file, value] of [
  ['corrupt guidance', 'fleet-guidance.json', '{PRIVATE broken'],
  ['out-of-range guidance', 'fleet-guidance.json', { shares: [{ accountKey, share: 101 }] }],
  ['invalid guidance structure', 'fleet-guidance.json', { shares: {} }],
  ['invalid unrelated share', 'fleet-guidance.json', { shares: [{ accountKey: 'b'.repeat(64), share: -1 }] }],
  ['corrupt accounts', 'fleet-accounts.json', '{PRIVATE broken'],
  ['out-of-range account count', 'fleet-accounts.json', Array.from({ length: 101 }, () => localAccount)],
  ['invalid account scope', 'fleet-accounts.json', [{ ...localAccount, scope: [] }]],
]) {
  test(`loadPolicy keeps pacing available with ${name}, shows the share problem, and logs once`, (t) => {
    const dir = fs.mkdtempSync(path.join(process.env.HERDR_BOSS_DIR, 'bad-shares-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const policyFile = path.join(dir, 'policy.json');
    writeFleetFile(policyFile, { pacingGoals: { codex: { primary: 80 } } });
    writeFleetFile(path.join(dir, 'factory-identity.json'), { factoryId: 'factory-a' });
    writeFleetFile(path.join(dir, 'fleet-accounts.json'), [localAccount]);
    if (typeof value === 'string') fs.writeFileSync(path.join(dir, file), value);
    else writeFleetFile(path.join(dir, file), value);
    const warnings = [];
    const load = () => loadPolicy({ file: policyFile, warn: (text) => warnings.push(text) });
    let policy;
    assert.doesNotThrow(() => { policy = load(); });
    assert.equal(policy.factoryShares, undefined);
    assert.equal(pacingGoal(policy, 'codex', 'primary'), 80);
    assert.match(policy.factoryShareError, /factory shares could not be read/i);
    const now = Date.now();
    const lanes = laneStatus([{ provider: 'codex', windows: [{ key: 'primary', usedPercent: 10, expectedPercent: 50, windowMinutes: 1440, resetsAt: new Date(now + 3600000).toISOString() }] }], policy, now);
    assert.equal(lanes.codex.factoryShareError, policy.factoryShareError);
    assert.match(describeLane('codex', lanes.codex), /factory shares could not be read/i);
    assert.match(laneStatus([], policy).codex.factoryShareError, /factory shares could not be read/i);
    load();
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /PRIVATE|broken/);
    writePolicy(policy, { file: policyFile });
    assert.equal(JSON.parse(fs.readFileSync(policyFile)).factoryShareError, undefined);
    fs.rmSync(path.join(dir, file));
    const repaired = load();
    assert.equal(repaired.factoryShareError, undefined);
    assert.equal(warnings.length, 1);
  });
}

test('dispatch fails closed with a plain share-check error for corrupt fleet data', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dir = path.join(f.root, 'factory-data');
  writeFleetFile(path.join(dir, 'fleet-accounts.json'), [localAccount]);
  fs.writeFileSync(path.join(dir, 'fleet-guidance.json'), '{PRIVATE broken');
  assert.throws(() => startWorker('invalid-shares', { kind: 'codex', task: 'Sample task', allow: ['src/'], force: true, reason: 'Verify the corrupt share refusal with an authorized override', dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: { ...f.env, HERDR_BOSS_DIR: dir }, rulesFile: f.rulesFile, output: () => {},
  }), /factory share check failed/i);
  assert.ok(!f.calls.includes('agent start'));
});

test('corrupt fleet share files do not block an unmetered worker dispatch', (t) => {
  const f = setupFixture(null);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dir = path.join(f.root, 'factory-data');
  writeFleetFile(path.join(dir, 'fleet-accounts.json'), [localAccount]);
  fs.writeFileSync(path.join(dir, 'fleet-guidance.json'), '{PRIVATE broken');
  assert.doesNotThrow(() => startWorker('free-model', { kind: 'opencode', model: 'opencode/space-bunny-free', task: 'Sample task', allow: ['src/'], dryRun: true }, {
    config: f.config, models: loadModels(), herdr: f.herdr, env: { ...f.env, HERDR_BOSS_DIR: dir }, rulesFile: f.rulesFile, output: () => {},
  }));
  assert.ok(!f.calls.includes('agent start'), 'dry run never launches an agent');
});

test('loadPolicy reports corrupt guidance even before an account is provisioned', (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.HERDR_BOSS_DIR, 'empty-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'fleet-guidance.json'), '{PRIVATE broken');
  const warnings = [];
  const policy = loadPolicy({ file: path.join(dir, 'policy.json'), warn: (text) => warnings.push(text) });
  assert.equal(policy.factoryShares, undefined);
  assert.match(policy.factoryShareError, /factory shares could not be read/i);
  assert.equal(warnings.length, 1);
});
