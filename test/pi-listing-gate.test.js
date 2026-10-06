import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadModels, loadProjectConfig } from '../src/kit/config.js';
import { startWorker } from '../src/kit/workers.js';
import { parsePiModels } from '../src/collect.js';

const models = loadModels();
const TABLE = [
  'provider     model                         context  max-out  thinking  images',
  'oc-sdk-go    space-bunny-free              1.0M     524.3K   yes       yes',
  'oc-sdk-go    longcat-2.5-preview-free      1M       131.1K   yes       yes',
  'opencode-go  deepseek-v4.1-flash           1M       384K     yes       yes',
  'opencode-go  mimo-v2.6-flash               1.0M     131.1K   yes       yes',
  'opencode-go  muse-spark-1.3-contributor    1.0M     131.1K   yes       yes',
  'opencode-go  longcat-2.5-preview-free      1M       131.1K   yes       yes',
  'opencode-go  glm-5.3                       1M       131.1K   yes       no',
  'opencode-go  kimi-k3                       1M       131.1K   yes       yes',
].join('\n');
const WARNINGS = 'Warning: No models match pattern "opencode-go/glm-5.1"\nWarning: No models match pattern "oc-sdk-go/glm-5"\n';
// A table without the opencode-go space-bunny-free row, as when only oc-sdk-go lists the model.
const LISTING = `${WARNINGS}${TABLE}\n${WARNINGS}`;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-listing-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-m', 'seed');
  fs.writeFileSync(path.join(root, '.herdr-boss.json'), JSON.stringify({ slug: 'herdrboss' }));
  const config = loadProjectConfig({ cwd: root });
  const rulesFile = path.join(root, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ updatedAt: new Date().toISOString(), avoidKinds: [] }));
  const herdr = (args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'ws:orch', workspace_id: 'ws', label: 'orch' } };
    if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
    if (args[0] === 'tab' && args[1] === 'list') return { tabs: [] };
    if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
    throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
  };
  const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_PANE_ID: 'ws:orch' };
  const messages = [];
  const start = (name, options, piModelLister) => startWorker(name, { task: 'x', allow: ['src/'], dryRun: true, ...options }, {
    config, models, herdr, env, rulesFile, output: (text) => messages.push(text), piModelLister,
  });
  return { root, start, messages };
}

// Each call needs its own runner function, because the process caches the answer for each runner.
const runnerFor = (text, calls = []) => () => { calls.push(1); if (text instanceof Error) throw text; return text; };

test('parsePiModels ignores Warning lines', () => {
  assert.deepEqual(parsePiModels(`${WARNINGS}${TABLE}\n${WARNINGS}`).slice(0, 2), ['oc-sdk-go/space-bunny-free', 'oc-sdk-go/longcat-2.5-preview-free']);
  assert.ok(!parsePiModels(`${WARNINGS}${TABLE}\n${WARNINGS}`).some((entry) => entry.startsWith('Warning')));
});

test('worker start accepts a Pi model that pi --list-models lists', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => f.start('piok', { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }, runnerFor(LISTING)));
  assert.deepEqual(f.messages.filter((text) => /--list-models/.test(text)), []);
});

test('worker start refuses a Pi model that the listing lacks, names the other provider, and shows up to five models', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const runner = runnerFor(LISTING, calls);
  assert.throws(() => f.start('pimiss', { kind: 'pi', model: 'opencode-go/space-bunny-free' }, runner), (error) => {
    assert.match(error.message, /^pi cannot run opencode-go\/space-bunny-free: pi --list-models does not list it\./);
    assert.match(error.message, /Only the provider oc-sdk-go lists space-bunny-free\./);
    assert.match(error.message, /Pi lists these opencode-go models: opencode-go\/deepseek-v4\.1-flash, opencode-go\/mimo-v2\.6-flash, opencode-go\/muse-spark-1\.3-contributor, opencode-go\/longcat-2\.5-preview-free, opencode-go\/glm-5\.3\./);
    assert.doesNotMatch(error.message, /kimi-k3/, 'at most five models');
    assert.match(error.message, /--force cannot bypass this refusal\.$/);
    return true;
  });
  assert.throws(() => f.start('pimisstwo', { kind: 'pi', model: 'opencode-go/space-bunny-free', force: true }, runner), /does not list it/);
  assert.equal(calls.length, 1, 'the process runs pi --list-models once for the same runner');
});

test('worker start names a provider that Pi lists no model for', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const onlyOther = 'provider  model  context\noc-sdk-go  space-bunny-free  1M\n';
  assert.throws(() => f.start('pinone', { kind: 'pi', model: 'opencode-go/space-bunny-free' }, runnerFor(onlyOther)),
    /Only the provider oc-sdk-go lists space-bunny-free\. Pi lists no opencode-go model\. Pi has no credential for the opencode-go provider\./);
});

test('worker start warns and continues when pi --list-models fails or lists nothing', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  for (const [name, runner] of [['pifail', runnerFor(new Error('spawn pi ENOENT'))], ['pitime', runnerFor(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))], ['piempty', runnerFor('provider  model  context\n')], ['pinohead', runnerFor('No API key\n')]]) {
    f.messages.length = 0;
    assert.doesNotThrow(() => f.start(name, { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }, runner), name);
    assert.ok(f.messages.some((text) => /^Warning: pi --list-models failed/.test(text)), `${name}: ${f.messages.join('|')}`);
  }
});

test('worker start does not run pi --list-models for another kind', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  assert.doesNotThrow(() => f.start('cl', { kind: 'claude' }, runnerFor(LISTING, calls)));
  assert.equal(calls.length, 0);
});
