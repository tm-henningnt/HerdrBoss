import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { PROJECT_NEW_STEPS, runProjectNew, runProjectStep } from '../src/project-new.js';
import { checkProject, formatCheck } from '../src/project-new-check.js';
import { labelsStep } from '../src/project-new-labels.js';
import { loadLabelPreset } from '../src/kit/gh.js';
import { makeFakeGh } from './fake-gh.js';

// Git reads its identity and its URL rewrites from a temporary global file, never from the machine.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-labels-git-'));
const URL_TARGET = path.join(GIT_HOME, 'url-target.git');
execFileSync('git', ['init', '-q', '--bare', URL_TARGET]);
fs.writeFileSync(path.join(GIT_HOME, 'gitconfig'), `[user]\n\tname = Test User\n\temail = test@example.invalid\n[url "${URL_TARGET}"]\n\tinsteadOf = https://github.com/acme/demo.git\n\tinsteadOf = https://github.com/octo/demo.git\n\tinsteadOf = https://example.invalid/acme/demo.git\n`);
process.env.GIT_CONFIG_GLOBAL = path.join(GIT_HOME, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

const TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const GITHUB_URL = 'https://github.com/acme/demo.git';
const PRIVATE_DECISION = { visibility: 'private', source: 'wizard' };
const PUBLIC_DECISION = { visibility: 'public', source: 'wizard', confirmPublic: true };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-labels-'));
  const dataDir = assertTempDataDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const repoRoot = path.join(root, 'boss-repo');
  fs.mkdirSync(repoRoot);
  const fake = makeFakeGh(path.join(root, 'fake'), { token: TOKEN });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, dataDir, group, repoRoot, fake, home, ceiling: root, env: fake.env(), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const base = (f, extra = {}) => ({ slug: 'demo', group: f.group, name: 'Demo', dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, env: f.env, home: f.home, ...extra });
const step = (result, name) => result.steps.find((s) => s.name === name);
const hasRepo = (f) => f.fake.calls().filter((args) => args[0] === 'label').every((args) => args.some((arg) => /^--repo=[\w.-]+\/[\w.-]+$/.test(arg)));
const labelCalls = (f) => f.fake.calls().filter((args) => args[0] === 'label');
const viewCalls = (f) => f.fake.calls().filter((args) => args[0] === 'repo' && args[1] === 'view');

test('the labels step comes after remote and before policy', () => {
  const at = (name) => PROJECT_NEW_STEPS.indexOf(name);
  assert.ok(at('labels') > at('remote') && at('labels') < at('policy'));
});

test('without a remote the labels step is skipped and gh is not called', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.match(step(result, 'labels').detail, /no remote/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('a private repository from the wizard gets the triage labels', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { remote: 'gh', visibility: 'private', decision: PRIVATE_DECISION }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'done');
    const creates = f.fake.calls().filter((args) => args[0] === 'label' && args[1] === 'create');
    assert.deepEqual(creates.map((args) => args.at(-1)), loadLabelPreset('triage').map((label) => label.name));
    assert.deepEqual(viewCalls(f), []);
    assert.ok(hasRepo(f));
    assert.ok(f.fake.calls().filter((args) => args[0] === 'label').every((args) => args.includes('--repo=octo/demo')));
    for (const env of f.fake.envs()) assert.equal(env.ghRepo, null);
    assert.equal(step(result, 'policy').status, 'done');
  } finally { f.cleanup(); }
});

test('a public repository skips the labels step', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { remote: 'gh', visibility: 'public', decision: PUBLIC_DECISION }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.match(step(result, 'labels').detail, /public/);
    assert.deepEqual(labelCalls(f), []);
  } finally { f.cleanup(); }
});

test('a GitHub URL remote reads the visibility with gh repo view', () => {
  const f = fixture();
  try {
    let result = runProjectNew(base(f, { remote: GITHUB_URL }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'done');
    assert.equal(viewCalls(f).length, 1);
    assert.ok(labelCalls(f).some((args) => args[1] === 'create'));
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.fake.set('visibility', 'PUBLIC');
    const result = runProjectNew(base(g, { remote: GITHUB_URL }));
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.deepEqual(labelCalls(g), []);
    assert.equal(g.fake.writes().length, 0);
  } finally { g.cleanup(); }
});

test('an origin that is not a GitHub repository skips the labels step', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { remote: 'https://example.invalid/acme/demo.git' }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.match(step(result, 'labels').detail, /GitHub/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('without a gh login the labels step is skipped and gh auth login never runs', () => {
  const f = fixture();
  try {
    f.fake.set('mode', 'loggedout');
    const result = runProjectNew(base(f, { remote: GITHUB_URL }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.match(step(result, 'labels').detail, /not logged in/);
    assert.ok(!f.fake.calls().some((args) => args[0] === 'auth' && args[1] === 'login'));
    assert.deepEqual(labelCalls(f), []);
  } finally { f.cleanup(); }
});

test('without gh installed the labels step is skipped', () => {
  const f = fixture();
  try {
    const probeCalls = [];
    const ghProbe = (command, args) => {
      probeCalls.push([command, args]);
      return { status: null, error: { code: 'ENOENT' }, stdout: '', stderr: '' };
    };
    const result = runProjectNew(base(f, {
      remote: GITHUB_URL,
      stepRunners: { labels: (inputs, context) => labelsStep(inputs, { ...context, ghProbe }) },
    }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'labels').status, 'skipped');
    assert.match(step(result, 'labels').detail, /not installed/);
    assert.deepEqual(probeCalls, [['gh', ['auth', 'status']]]);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('a failed label write fails the step with a redacted message and resume retries it', () => {
  const f = fixture();
  try {
    f.fake.set('mode', 'failwrite');
    const options = base(f, { remote: 'gh', visibility: 'private', decision: PRIVATE_DECISION });
    const result = runProjectNew(options);
    assert.equal(result.ok, false);
    assert.equal(step(result, 'labels').status, 'failed');
    assert.ok(!step(result, 'labels').detail.includes(TOKEN));
    assert.match(step(result, 'labels').detail, /needs-triage/);
    assert.equal(step(result, 'policy').status, 'pending');
    f.fake.set('mode', 'ok');
    const resumed = runProjectNew({ ...options, resume: true });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(step(resumed, 'labels').status, 'done');
    assert.equal(step(resumed, 'policy').status, 'done');
    // The remote step does not run twice.
    assert.equal(f.fake.calls().filter((args) => args[0] === 'repo' && args[1] === 'create').length, 1);
  } finally { f.cleanup(); }
});

test('the dry run describes the labels step and runs no gh command', () => {
  const f = fixture();
  try {
    const none = runProjectNew(base(f, { dryRun: true }));
    assert.match(step(none, 'labels').detail, /skipped/);
    const gh = runProjectNew(base(f, { dryRun: true, remote: 'gh' }));
    assert.match(step(gh, 'labels').detail, /label sync --preset triage/);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
});

test('project check --fix labels runs the step', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { remote: GITHUB_URL }));
    const before = labelCalls(f).length;
    const fixed = runProjectStep('labels', { slug: 'demo', dataDir: f.dataDir, env: f.env, home: f.home });
    assert.equal(fixed.ok, true, fixed.error);
    assert.ok(labelCalls(f).length > before);
  } finally { f.cleanup(); }
});

const checkOpts = (f, extra = {}) => ({ dataDir: f.dataDir, home: f.home, env: f.env, herdr: () => { throw new Error('no herdr'); }, ...extra });
const labelItem = (check) => check.items.find((entry) => entry.name === 'labels');

test('project check reports the labels of a private GitHub remote and calls no write command', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { remote: GITHUB_URL }));
    const writesBefore = f.fake.writes().length;
    f.fake.set('labels.json', [{ name: 'needs-triage', color: 'FBCA04', description: 'Maintainer needs to evaluate this issue' }]);
    const missing = labelItem(checkProject('demo', checkOpts(f)));
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /gh label sync/);
    assert.match(formatCheck(checkProject('demo', checkOpts(f))).join('\n'), /missing: .*gh label sync/);
    f.fake.set('labels.json', loadLabelPreset('triage'));
    const present = labelItem(checkProject('demo', checkOpts(f)));
    assert.equal(present.ok, true);
    assert.equal(f.fake.writes().length, writesBefore);
  } finally { f.cleanup(); }
});

test('project check has no labels item without a remote, for a public repository, or without gh', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    assert.equal(labelItem(checkProject('demo', checkOpts(f))), undefined);
    assert.deepEqual(f.fake.calls(), []);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    runProjectNew(base(g, { remote: GITHUB_URL }));
    g.fake.set('visibility', 'PUBLIC');
    assert.equal(labelItem(checkProject('demo', checkOpts(g))), undefined);
    const env = { ...g.env, PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin' + path.delimiter + '/bin' };
    g.fake.set('visibility', 'PRIVATE');
    assert.equal(labelItem(checkProject('demo', checkOpts(g, { env }))), undefined);
    g.fake.set('mode', 'loggedout');
    assert.equal(labelItem(checkProject('demo', checkOpts(g))), undefined);
  } finally { g.cleanup(); }
});

test('GH_REPO in the environment and an upstream remote do not redirect the step', () => {
  const f = fixture();
  try {
    const env = { ...f.env, GH_REPO: 'evil/elsewhere', GH_HOST: 'ghe.example.invalid' };
    const options = base(f, { remote: GITHUB_URL, env });
    // Create the folder and origin first, then add a second remote and run the flow.
    const result = runProjectNew(options);
    assert.equal(result.ok, true, result.error);
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/other/upstream.git'], { cwd: path.join(f.group, 'Demo') });
    runProjectStep('labels', { slug: 'demo', dataDir: f.dataDir, env, home: f.home });
    const calls = f.fake.calls().filter((args) => args[0] === 'label' || (args[0] === 'repo' && args[1] === 'view'));
    assert.ok(calls.length > 0);
    for (const args of calls) assert.ok(args.includes('--repo=acme/demo') || args.includes('acme/demo'), args.join(' '));
    for (const e of f.fake.envs()) assert.deepEqual(e, { ghRepo: null, ghHost: 'github.com' });
  } finally { f.cleanup(); }
});

test('a wizard decision counts only when the created repository is the origin', () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, 'repo');
    fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', GITHUB_URL], { cwd: dir });
    const inputs = { slug: 'demo', path: dir };
    f.fake.set('visibility', 'PUBLIC');
    const other = labelsStep(inputs, { env: f.env, ids: { remoteDecision: { visibility: 'private' }, remoteCreated: 'other/repo' } });
    assert.equal(other.status, 'skipped');
    assert.equal(viewCalls(f).length, 1);
    assert.deepEqual(labelCalls(f), []);
    const same = labelsStep(inputs, { env: f.env, ids: { remoteDecision: { visibility: 'private' }, remoteCreated: 'acme/demo' } });
    assert.equal(same.status, undefined);
    assert.equal(viewCalls(f).length, 1);
    assert.ok(labelCalls(f).length > 0);
    // Unknown visibility skips.
    f.fake.set('visibility', '');
    assert.equal(labelsStep(inputs, { env: f.env, ids: {} }).status, 'skipped');
  } finally { f.cleanup(); }
});
