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
  assert.deepEqual(detectLaunchBlock('DID YOU MEAN THIS?'), { phrase: 'Did you mean this?', untilReenabled: true });
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
  assert.deepEqual(trialModelStatus(models, events), [{ kind: 'opencode', model: 'opencode/ling-3.1-flash-free', results: 4 }]);
  assert.deepEqual(trialModelStatus(models, []).map((item) => item.results), [0, 0]);
});
