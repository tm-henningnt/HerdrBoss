import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withMutationLock } from '../src/kit/locks.js';
import { checkHarness, syncHarness } from '../src/harness.js';
import { recordHarnessFacts } from '../src/harness-facts.js';
import { appendHarnessChange, readHarnessChanges, MAX_CHANGE_LINES, MAX_CHANGE_BYTES } from '../src/harness-changes.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-auto-changes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'data');
  const modelsFile = path.join(home, 'models.json');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(home, '.codex'));
  const sandbox = (network) => fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[sandbox_workspace_write]\nnetwork_access = ${network}\nwritable_roots = ["${home}/private-project"]\n`);
  const models = (items) => fs.writeFileSync(modelsFile, JSON.stringify({ kinds: { codex: { allowedModels: items, launchArgs: ['-s', 'workspace-write'] } } }));
  const version = (value) => fs.writeFileSync(path.join(dataDir, 'tools-state.json'), JSON.stringify({ tools: [{ id: 'codex', installed: { mac: value } }] }));
  sandbox(true);
  models(['sample-one']);
  version('1.2.3');
  const options = { home, dataDir, modelsFile };
  return { home, dataDir, options, sandbox, models, version };
}

const recorderWarning = 'Warning: Could not record harness changes.\n';

for (const action of ['check', 'sync']) {
  test(`harness ${action} preserves its result when an injected recorder fails`, (t) => {
    const f = fixture(t);
    const run = (recordFacts) => action === 'check'
      ? checkHarness({ ...f.options, recordFacts })
      : syncHarness({ ...f.options, codexOnly: true, recordFacts });
    run(() => {}); // Apply sync changes before comparing stable results.
    const expected = run(() => {});
    const exitCode = process.exitCode;
    const warnings = [];
    t.mock.method(process.stderr, 'write', (line) => { warnings.push(line); return true; });
    for (const code of ['ELOCKBUSY', 'EACCES', 'EIO', 'ENOSPC', undefined]) {
      let calls = 0;
      const result = run(() => {
        calls++;
        throw Object.assign(new Error(`${code}: ${f.home}/private-project`), { code });
      });
      assert.equal(calls, 1, 'the injected recorder must run');
      assert.deepEqual(result, expected, code);
      assert.equal(process.exitCode, exitCode, code);
    }
    assert.deepEqual(warnings, Array(5).fill(recorderWarning));
    if (action === 'sync') {
      syncHarness({ ...f.options, codexOnly: true, dryRun: true, recordFacts: () => assert.fail('a dry run must not call the recorder') });
      assert.equal(warnings.length, 5);
    }
  });
}

test('a failed marker append advances the baseline and never duplicates successful markers', (t) => {
  const f = fixture(t);
  recordHarnessFacts(f.options);
  const stateFile = path.join(f.dataDir, 'harness-facts.json');
  const oldState = fs.readFileSync(stateFile, 'utf8');
  f.version('1.2.4');
  f.models(['sample-one', 'sample-two']);
  f.sandbox(false);
  const append = fs.appendFileSync;
  const injected = Object.assign(new Error('Injected append failure'), { code: 'ENOSPC' });
  let attempts = 0;
  const mock = t.mock.method(fs, 'appendFileSync', (file, text, options) => {
    if (file === path.join(f.dataDir, 'harness-changes.jsonl')) {
      attempts++;
      if (attempts === 2) throw injected;
    }
    return append(file, text, options);
  });
  assert.throws(() => recordHarnessFacts(f.options), (error) => error === injected);
  mock.mock.restore();
  assert.notEqual(fs.readFileSync(stateFile, 'utf8'), oldState, 'save the observed hashes before appending markers');
  assert.equal(attempts, 3, 'one failed append must not prevent other markers');
  const expected = ['Harness version changed', 'Sandbox settings changed'];
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => row.label), expected);
  assert.deepEqual(recordHarnessFacts(f.options), [], 'the failed marker is not retried');
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => row.label), expected);
});

test('CLI check and sync keep output and exit codes when recording fails', (t) => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  for (const [action, expectedCode] of [['check', 1], ['sync', 0], ['sync', 1]]) {
    const f = fixture(t);
    const env = { ...process.env, HOME: f.home, HERDR_BOSS_DIR: f.dataDir, TMPDIR: f.home };
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']) delete env[key];
    if (action === 'sync' && expectedCode === 1) {
      fs.mkdirSync(path.join(f.home, '.codex', 'rules'));
      fs.writeFileSync(path.join(f.home, '.codex', 'rules', 'herdr.rules'), 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="forbidden")\n');
    }
    const run = () => spawnSync(process.execPath, [cli, 'harness', action, ...(action === 'sync' ? ['--codex-only'] : [])], { env, encoding: 'utf8' });
    run(); // Apply sync changes before comparing stable command output.
    const expected = run();
    assert.equal(expected.status, expectedCode);
    const stateFile = path.join(f.dataDir, 'harness-facts.json');
    fs.unlinkSync(stateFile);
    fs.mkdirSync(stateFile); // The recorder's atomic rename now fails.
    const failed = run();
    assert.equal(failed.status, expected.status);
    assert.equal(failed.stdout, expected.stdout);
    assert.equal(failed.stderr, `${expected.stderr}${recorderWarning}`);
  }
});

test('harness checks record changed versions, model lists, and sandbox settings once', (t) => {
  const f = fixture(t);
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir), [], 'the first observation establishes a baseline');
  f.version('1.2.4');
  f.models(['sample-one', 'sample-two']);
  f.sandbox(false);
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir).map((r) => [r.harness, r.label]), [
    ['codex', 'Harness version changed'], ['codex', 'Model list changed'], ['codex', 'Sandbox settings changed'],
  ]);
  checkHarness(f.options);
  assert.equal(readHarnessChanges(f.dataDir).length, 3, 'unchanged checks add no duplicate');
  assert.doesNotMatch(fs.readFileSync(path.join(f.dataDir, 'harness-changes.jsonl'), 'utf8'), /private-project|sample-one/);
});

test('harness sync records changes and its dry run leaves the baseline and markers unchanged', (t) => {
  const f = fixture(t);
  checkHarness(f.options);
  f.version('1.2.4');
  syncHarness({ ...f.options, dryRun: true, codexOnly: true });
  assert.deepEqual(readHarnessChanges(f.dataDir), []);
  syncHarness({ ...f.options, codexOnly: true });
  assert.ok(readHarnessChanges(f.dataDir).some((row) => row.label === 'Harness version changed'));
  const count = readHarnessChanges(f.dataDir).length;
  checkHarness(f.options);
  assert.equal(readHarnessChanges(f.dataDir).length, count);
});

test('model ordering and unavailable version readings add no markers; local model policy changes do', (t) => {
  const f = fixture(t);
  f.models(['sample-two', 'sample-one']);
  checkHarness(f.options);
  f.models(['sample-one', 'sample-two']);
  f.version(null);
  checkHarness(f.options);
  f.version('1.2.3');
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir), []);
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({ extraModels: { codex: ['local-model'] } }));
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => row.label), ['Model list changed']);
  const snapshot = fs.readFileSync(path.join(f.dataDir, 'harness-facts.json'), 'utf8');
  assert.doesNotMatch(snapshot, /private-project|sample-one|local-model|1\.2\.3/);
  assert.ok(snapshot.length < 16 * 1024);
});

test('harness change writes keep at most 200 rows and 64 KB on disk', (t) => {
  const f = fixture(t);
  const file = path.join(f.dataDir, 'harness-changes.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(MAX_CHANGE_BYTES + 100)}\n`);
  for (let i = 0; i < MAX_CHANGE_LINES + 5; i++) appendHarnessChange(f.dataDir, { harness: 'codex', label: `change ${i}` });
  assert.ok(fs.statSync(file).size <= MAX_CHANGE_BYTES);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, MAX_CHANGE_LINES);
  assert.equal(readHarnessChanges(f.dataDir)[0].label, 'change 5');
});

test('an unavailable sandbox reading keeps the known fact', (t) => {
  const f = fixture(t);
  checkHarness(f.options);
  const file = path.join(f.home, '.codex', 'config.toml');
  fs.unlinkSync(file);
  checkHarness(f.options);
  f.sandbox(true);
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir), []);
});

test('the harness check CLI appends a marker even when readiness findings fail', (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, HOME: f.home, HERDR_BOSS_DIR: f.dataDir, TMPDIR: f.home };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']) delete env[key];
  const run = () => spawnSync(process.execPath, [cli, 'harness', 'check'], { env, encoding: 'utf8' });
  assert.equal(run().status, 1, 'the incomplete setup has readiness findings');
  assert.deepEqual(readHarnessChanges(f.dataDir), []);
  f.version('1.2.4');
  assert.equal(run().status, 1);
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => row.label), ['Harness version changed']);
});

test('checks record Claude and OpenCode sandbox settings and Pi launch changes with fixed labels', (t) => {
  const f = fixture(t);
  const claude = path.join(f.home, '.claude', 'settings.json');
  const opencode = path.join(f.home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.mkdirSync(path.dirname(opencode), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ sandbox: { enabled: false }, permissions: { defaultMode: 'default' } }));
  fs.writeFileSync(opencode, JSON.stringify({ permission: { bash: 'ask' } }));
  const kinds = Object.fromEntries(['codex', 'claude', 'opencode', 'pi'].map((kind) => [kind, { allowedModels: ['sample-one'], launchArgs: [] }]));
  fs.writeFileSync(f.options.modelsFile, JSON.stringify({ kinds }));
  checkHarness(f.options);
  fs.writeFileSync(claude, JSON.stringify({ sandbox: { enabled: true }, permissions: { defaultMode: 'default' } }));
  fs.writeFileSync(opencode, JSON.stringify({ permission: { bash: 'allow' } }));
  kinds.pi.launchArgs.push('--no-approve');
  fs.writeFileSync(f.options.modelsFile, JSON.stringify({ kinds }));
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => [row.harness, row.label]), [
    ['claude', 'Sandbox settings changed'], ['opencode', 'Sandbox settings changed'], ['pi', 'Sandbox settings changed'],
  ]);
});

test('automatic markers start a new line when the existing file has no final newline', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'harness-changes.jsonl'), JSON.stringify({ date: '2026-10-07', harness: 'codex', label: 'Earlier change' }));
  checkHarness(f.options);
  f.version('1.2.4');
  checkHarness(f.options);
  assert.deepEqual(readHarnessChanges(f.dataDir).map((row) => row.label), ['Earlier change', 'Harness version changed']);
});

test('manual markers cannot write while another harness fact check holds the guard', (t) => {
  const f = fixture(t);
  const module = new URL('../src/harness-changes.js', import.meta.url).href;
  const script = `import { appendHarnessChange } from ${JSON.stringify(module)};
    appendHarnessChange(${JSON.stringify(f.dataDir)}, { harness: 'codex', label: 'Manual change' });`;
  withMutationLock(f.dataDir, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'a concurrent writer must refuse rather than append during compaction');
    assert.deepEqual(readHarnessChanges(f.dataDir), []);
  });
});
