import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeLaunchRecords, detectLaunchBlock, enableModel, markModelUnavailable, RATE_LIMIT_COOLDOWN_MS, untilText, UNTIL_REENABLED_AT } from '../src/kit/model-unavailable.js';
import { loadModels } from '../src/kit/config.js';
import { trialModelStatus } from '../src/engine.js';

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-unavailable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('detectLaunchBlock finds each phrase in any letter case and ignores other text', () => {
  assert.equal(detectLaunchBlock('DID YOU MEAN THIS?'), null, 'the shell text is not a launch block');
  assert.deepEqual(detectLaunchBlock('Error: This model is Not Available In Your Country.'), { phrase: 'not available in your country', untilReenabled: true });
  assert.deepEqual(detectLaunchBlock('\u001b[31mrate LIMIT exceeded\u001b[0m'), { phrase: 'Rate limit exceeded', untilReenabled: false });
  assert.equal(detectLaunchBlock('Free usage exceeded'), null);
  assert.equal(detectLaunchBlock(undefined), null);
});

test('a rate limit record lasts 30 minutes and an until-re-enabled record has no end', (t) => {
  const dir = tempDir(t);
  const now = 1_800_000_000_000;
  const rate = markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/a', label: 'Rate limit exceeded', now });
  assert.equal(rate.retryAt, now + RATE_LIMIT_COOLDOWN_MS);
  const held = markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/b', untilReenabled: true, label: 'x', now });
  assert.equal(held.retryAt, UNTIL_REENABLED_AT);
  assert.equal(untilText(held.retryAt), 're-enabled');
  assert.deepEqual(activeLaunchRecords(dir, now + 1).map((item) => item.model).sort(), ['opencode/a', 'opencode/b']);
  assert.deepEqual(activeLaunchRecords(dir, now + RATE_LIMIT_COOLDOWN_MS + 1).map((item) => item.model), ['opencode/b']);
  // A rate limit does not shorten a record that lasts until re-enabled.
  assert.equal(markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/b', label: 'Rate limit exceeded', now }).untilReenabled, true);
  assert.equal(enableModel(dir, 'opencode', 'opencode/b'), true);
  assert.equal(activeLaunchRecords(dir, now + 1).length, 1);
});

test('trialModelStatus counts results per model and drops a model at 5 results', () => {
  const models = loadModels();
  const event = (model, result) => ({ kind: 'opencode', model, modelOutcome: result ? { result } : undefined });
  const events = [
    ...Array.from({ length: 4 }, () => event('opencode/ling-3.1-flash-free', 'first-time')),
    event('opencode/ling-3.1-flash-free', null),
    ...Array.from({ length: 5 }, () => event('opencode/fledge-alpha-free', 'rework')),
    event('opencode/big-pickle', 'first-time'),
  ];
  assert.deepEqual(trialModelStatus(models, events), [
    { kind: 'opencode', model: 'opencode/ling-3.1-flash-free', results: 4 },
    { kind: 'opencode', model: 'opencode/exo-free', results: 0 },
    { kind: 'opencode', model: 'opencode/step-5-preview-free', results: 0 },
    { kind: 'pi', model: 'opencode-go/step-5-preview-free', results: 0 },
  ]);
  assert.deepEqual(trialModelStatus(models, []).map((item) => item.results), [0, 0, 0, 0, 0]);
});

test('a corrupt unavailable-models.json counts as empty, warns once, and does not throw', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'unavailable-models.json'), '{ not json');
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    assert.deepEqual(activeLaunchRecords(dir), []);
    assert.equal(enableModel(dir, 'opencode', 'opencode/a'), false);
    const record = markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/a', untilReenabled: true, label: 'x' });
    assert.equal(record.model, 'opencode/a');
  } finally { process.stderr.write = original; }
  assert.equal(written.filter((line) => /could not read/i.test(line)).length, 1);
  assert.equal(activeLaunchRecords(dir).length, 1);
});

test('markModelUnavailable and enableModel take a lock file and release it', (t) => {
  const dir = tempDir(t);
  const lock = path.join(dir, 'unavailable-models.json.lock');
  const seen = [];
  const realWrite = fs.renameSync;
  fs.renameSync = (...args) => { seen.push(fs.existsSync(lock)); return realWrite(...args); };
  try {
    markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/a', label: 'x' });
    enableModel(dir, 'opencode', 'opencode/a');
  } finally { fs.renameSync = realWrite; }
  assert.deepEqual(seen, [true, true], 'each write happens while the lock exists');
  assert.equal(fs.existsSync(lock), false);
});

test('a held lock makes a second writer wait, and a stale lock is taken over', (t) => {
  const dir = tempDir(t);
  const lock = path.join(dir, 'unavailable-models.json.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const record = markModelUnavailable(dir, { kind: 'opencode', model: 'opencode/a', label: 'x' });
  assert.equal(record.model, 'opencode/a');
  assert.equal(fs.existsSync(lock), false);
});

test('two concurrent processes keep both records', async (t) => {
  const dir = tempDir(t);
  const module = new URL('../src/kit/model-unavailable.js', import.meta.url).href;
  const { spawn } = await import('node:child_process');
  const run = (model) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { markModelUnavailable } from ${JSON.stringify(module)}; for (let i = 0; i < 20; i++) markModelUnavailable(${JSON.stringify(dir)}, { kind: 'opencode', model: '${model}' + i, label: 'x' });`]);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run('a'), run('b')]);
  assert.equal(activeLaunchRecords(dir).length, 40);
});
