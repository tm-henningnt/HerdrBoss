import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { runProjectNew } from '../src/project-new.js';
import { projectCommand } from '../src/project-new-cli.js';
import { classifyAnswer, redact, validateRemoteUrl } from '../src/project-new-remote.js';
import { readMessages, appendMessage } from '../src/messages.js';

// Git reads its identity and its URL rewrites from a temporary global file, never from the machine.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-remote-git-'));
const GIT_CONFIG = path.join(GIT_HOME, 'gitconfig');
const URL_TARGET = path.join(GIT_HOME, 'url-target.git');
execFileSync('git', ['init', '-q', '--bare', URL_TARGET]);
fs.writeFileSync(GIT_CONFIG, `[user]\n\tname = Test User\n\temail = test@example.invalid\n[url "${URL_TARGET}"]\n\tinsteadOf = https://example.invalid/acme/reachable.git\n`);
process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

// The token-like string is built at run time, so no scanner finds a literal in this file.
const TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const PASSWORD_URL = ['https://', 'octo', ':', 'hunter2hunter2', '@github.com/acme/demo.git'].join('');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-remote-'));
  const dataDir = assertTempDataDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const group = path.join(root, 'group');
  fs.mkdirSync(group);
  const repoRoot = path.join(root, 'boss-repo');
  fs.mkdirSync(repoRoot);
  const fake = path.join(root, 'fake-gh');
  fs.mkdirSync(fake);
  // The worker TMPDIR is inside a package of type module. The fake gh is CommonJS.
  fs.writeFileSync(path.join(fake, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(fake, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_GH_DIR;
const mode = fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() : 'ok';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\\n');
const token = process.env.FAKE_GH_TOKEN;
if (args[0] === 'auth' && args[1] === 'token') { console.log(token); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'loggedout') { console.error('You are not logged into any GitHub hosts. Token ' + token); process.exit(1); }
  console.log('Logged in to github.com account octo (keyring). Token: ' + token);
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user') { console.log('octo'); process.exit(0); }
if (args[0] === 'repo' && args[1] === 'create') {
  const repo = args[2];
  if (mode === 'clash') { console.error('GraphQL: Name already exists on this account (createRepository) ' + process.env.FAKE_GH_URL + ' ' + token); process.exit(1); }
  const bare = path.join(dir, 'remotes', repo + '.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const source = args[args.indexOf('--source') + 1];
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: source });
  console.log('Created repository ' + repo + ' ' + process.env.FAKE_GH_URL + ' ' + token);
  process.exit(0);
}
console.error('fake gh: unexpected ' + args.join(' '));
process.exit(9);
`, { mode: 0o755 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
  const env = { ...clean, PATH: `${fake}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: fake, FAKE_GH_TOKEN: TOKEN, FAKE_GH_URL: PASSWORD_URL };
  const calls = () => (fs.existsSync(path.join(fake, 'calls.log')) ? fs.readFileSync(path.join(fake, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  const mode = (value) => fs.writeFileSync(path.join(fake, 'mode'), value);
  return { root, dataDir, group, repoRoot, ceiling: root, fake, env, calls, mode, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const base = (f, extra = {}) => ({ slug: 'demo', group: f.group, name: 'Demo', dataDir: f.dataDir, repoRoot: f.repoRoot, ceiling: f.ceiling, env: f.env, remote: 'gh', stepRunners: { labels: () => ({ status: 'skipped', detail: 'skipped: the label step has its own tests' }) }, ...extra });
const step = (result, name) => result.steps.find((s) => s.name === name);
const projectDir = (f) => path.join(f.group, 'Demo');
const items = (f) => readMessages({ dir: f.dataDir }).filter((r) => r.action === 'decide' || r.action === 'answer');
const ownerReply = (f, id, text) => appendMessage({ thread: 'boss', from: 'owner', to: 'boss', kind: 'message', text, replyTo: id, status: 'queued' }, { dir: f.dataDir });
const createCalls = (f) => f.calls().filter((line) => line.startsWith('repo create'));

test('the default is private, the item names the repository, and the flow waits with no gh call', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f));
    assert.equal(result.ok, true);
    assert.equal(result.waiting, true);
    assert.equal(step(result, 'remote').status, 'waiting');
    assert.equal(step(result, 'policy').status, 'pending');
    assert.deepEqual(f.calls(), []);
    const [item, ...more] = items(f);
    assert.equal(more.length, 0);
    assert.equal(item.from, 'boss');
    assert.equal(item.to, 'owner');
    assert.equal(item.thread, 'boss');
    assert.equal(item.action, 'decide');
    assert.match(item.text, /<gh login>\/demo/);
    assert.match(item.text, /private/i);
    assert.match(item.text, /- Create private/);
    assert.match(item.text, /- Do not create/);
    assert.doesNotMatch(item.text, /Create public/);
    const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
    assert.equal(state.ids.remoteAsk.id, item.id);
  } finally { f.cleanup(); }
});

test('the organization from --org is in the item and in the create call', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { org: 'acme' }));
    assert.match(items(f)[0].text, /acme\/demo/);
    ownerReply(f, items(f)[0].id, 'Create private');
    const result = runProjectNew(base(f, { org: 'acme', resume: true }));
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(createCalls(f), [`repo create acme/demo --private --source ${projectDir(f)} --remote origin`]);
  } finally { f.cleanup(); }
});

test('the item offers Create public only with --visibility public', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { visibility: 'public' }));
    const text = items(f)[0].text;
    assert.match(text, /- Create private/);
    assert.match(text, /- Create public/);
    assert.match(text, /- Do not create/);
  } finally { f.cleanup(); }
});

test('a rerun without an answer waits, posts no second item, and calls no gh', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(again.waiting, true);
    assert.equal(items(f).length, 1);
    assert.deepEqual(f.calls(), []);
    ownerReply(f, items(f)[0].id, 'hmm, let me think about it');
    const unclear = runProjectNew(base(f, { resume: true }));
    assert.equal(unclear.waiting, true);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

test('a private answer creates a private repository, verifies origin, and the flow continues', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.ok, true, result.error);
    assert.notEqual(result.waiting, true);
    assert.equal(step(result, 'remote').status, 'done');
    assert.equal(step(result, 'register').status, 'done');
    const calls = f.calls();
    assert.equal(calls[0], 'auth status');
    assert.equal(createCalls(f).length, 1);
    assert.match(createCalls(f)[0], /^repo create octo\/demo --private --source .* --remote origin$/);
    assert.ok(!calls.some((line) => /token/.test(line)));
    assert.ok(!createCalls(f)[0].includes('--push'));
    assert.match(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectDir(f), encoding: 'utf8' }), /octo\/demo\.git/);
  } finally { f.cleanup(); }
});

test('a public repository needs the word public in the answer', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { visibility: 'public' }));
    const id = items(f)[0].id;
    ownerReply(f, id, 'yes');
    assert.equal(runProjectNew(base(f, { visibility: 'public', resume: true })).waiting, true);
    assert.deepEqual(f.calls(), []);
    ownerReply(f, id, 'Create public');
    const result = runProjectNew(base(f, { visibility: 'public', resume: true }));
    assert.equal(result.ok, true, result.error);
    assert.match(createCalls(f)[0], /--public/);
    assert.doesNotMatch(createCalls(f)[0], /--private/);
  } finally { f.cleanup(); }
});

test('a yes for private never creates a public repository, and public is refused when it was not asked', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { visibility: 'public' }));
    ownerReply(f, items(f)[0].id, 'Create private');
    runProjectNew(base(f, { visibility: 'public', resume: true }));
    assert.match(createCalls(f)[0], /--private/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    runProjectNew(base(g));
    ownerReply(g, items(g)[0].id, 'Create public');
    const result = runProjectNew(base(g, { resume: true }));
    assert.equal(result.waiting, true);
    assert.deepEqual(g.calls(), []);
  } finally { g.cleanup(); }
});

test('Do not create skips the step and the flow continues without a remote', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Do not create');
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'remote').status, 'skipped');
    assert.match(step(result, 'remote').detail, /Owner declined/);
    assert.equal(step(result, 'register').status, 'done');
    assert.deepEqual(f.calls(), []);
    assert.throws(() => execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectDir(f), stdio: 'pipe' }));
  } finally { f.cleanup(); }
});

test('the answer classifier accepts a clear choice and rejects an unclear one', () => {
  const both = { offerPublic: true };
  const only = { offerPublic: false };
  assert.equal(classifyAnswer('Create private', only), 'private');
  assert.equal(classifyAnswer('yes', only), 'private');
  assert.equal(classifyAnswer('Yes, go ahead', only), 'private');
  assert.equal(classifyAnswer('Do not create', only), 'decline');
  assert.equal(classifyAnswer("don't create it", both), 'decline');
  assert.equal(classifyAnswer('no', only), 'decline');
  assert.equal(classifyAnswer('Create public', both), 'public');
  assert.equal(classifyAnswer('public please', both), 'public');
  assert.equal(classifyAnswer('yes', both), null);
  assert.equal(classifyAnswer('create public', only), null);
  assert.equal(classifyAnswer('private or public, not sure', both), null);
  for (const text of ['not private', "isn't private", 'no, not private', 'do not create private', 'wait, not sure', 'create private, not public', 'no longer private', 'never public']) {
    assert.equal(classifyAnswer(text, both), null, text);
    assert.equal(classifyAnswer(text, only), null, text);
  }
  assert.equal(classifyAnswer('maybe later', only), null);
  assert.equal(classifyAnswer('', only), null);
});

test('not logged in: no login attempt, a clear message, and one answer item', () => {
  const f = fixture();
  try {
    f.mode('loggedout');
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.ok, false);
    assert.match(result.error, /gh auth login/);
    assert.equal(createCalls(f).length, 0);
    assert.ok(!f.calls().some((line) => /auth login|auth token|auth refresh/.test(line)));
    const answers = items(f).filter((r) => r.action === 'answer');
    assert.equal(answers.length, 1);
    assert.match(answers[0].text, /gh auth login/);
    runProjectNew(base(f, { resume: true }));
    assert.equal(items(f).filter((r) => r.action === 'answer').length, 1);
    f.mode('ok');
    const done = runProjectNew(base(f, { resume: true }));
    assert.equal(done.ok, true, done.error);
    assert.equal(step(done, 'remote').status, 'done');
  } finally { f.cleanup(); }
});

test('a name clash fails the step with the message and no retry', () => {
  const f = fixture();
  try {
    f.mode('clash');
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.ok, false);
    assert.match(result.error, /already exists/);
    assert.equal(createCalls(f).length, 1);
    assert.equal(step(result, 'remote').status, 'failed');
  } finally { f.cleanup(); }
});

test('no token or URL credential reaches the output, the state, or the mailbox', () => {
  const f = fixture();
  try {
    f.mode('clash');
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const result = runProjectNew(base(f, { resume: true }));
    f.mode('ok');
    const done = runProjectNew(base(f, { resume: true }));
    const everything = JSON.stringify([result, done, readMessages({ dir: f.dataDir }).filter((r) => r.from === 'boss'), fs.readFileSync(result.stateFile, 'utf8')]);
    assert.ok(!everything.includes(TOKEN), 'token');
    assert.ok(!everything.includes('hunter2hunter2'), 'password');
    assert.match(result.error, /\[redacted\]|\*\*\*/);
  } finally { f.cleanup(); }
});

test('redact removes tokens and URL credentials', () => {
  const text = redact(`a ${TOKEN} b ${PASSWORD_URL} c https://tok@example.invalid/x.git github_pat_${'A1b2C3d4E5'.repeat(3)} Bearer abcdefghijklmnop0123`);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('tok@'));
  assert.ok(!text.includes('github_pat_'));
  assert.ok(!text.includes('abcdefghijklmnop0123'));
  assert.match(text, /github\.com\/acme\/demo\.git/);
});

test('an origin that matches makes the step do nothing, with no question and no gh call', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const first = runProjectNew(base(f, { resume: true }));
    assert.equal(first.ok, true, first.error);
    const stateFile = first.stateFile;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.steps.remote;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const before = f.calls().length;
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(again.ok, true, again.error);
    assert.equal(step(again, 'remote').status, 'done');
    assert.match(step(again, 'remote').detail, /origin/);
    assert.equal(f.calls().length, before);
    assert.equal(items(f).length, 1);
  } finally { f.cleanup(); }
});

test('the state that records a created repository stops a second create', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    ownerReply(f, items(f)[0].id, 'Create private');
    const first = runProjectNew(base(f, { resume: true }));
    const state = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
    assert.equal(state.ids.remoteCreated, 'octo/demo');
    delete state.steps.remote;
    fs.writeFileSync(first.stateFile, JSON.stringify(state));
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: projectDir(f) });
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(again.ok, false);
    assert.match(again.error, /origin/);
    assert.equal(createCalls(f).length, 1);
  } finally { f.cleanup(); }
});

test('an origin that points elsewhere is refused before any question', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { remote: 'none' }));
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/other/thing.git'], { cwd: projectDir(f) });
    const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'flows', 'demo.json'), 'utf8'));
    delete state.steps.remote;
    fs.writeFileSync(path.join(f.dataDir, 'flows', 'demo.json'), JSON.stringify(state));
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.ok, false);
    assert.match(result.error, /origin/);
    assert.equal(items(f).length, 0);
  } finally { f.cleanup(); }
});

test('--remote none skips the step and touches neither gh nor the mailbox', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { remote: 'none' }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'remote').status, 'skipped');
    assert.match(step(result, 'remote').detail, /--remote none/);
    assert.deepEqual(f.calls(), []);
    assert.equal(items(f).length, 0);
  } finally { f.cleanup(); }
});

test('--remote URL adds origin, verifies it, and pushes nothing', () => {
  const f = fixture();
  try {
    const url = 'https://example.invalid/acme/reachable.git';
    const result = runProjectNew(base(f, { remote: url }));
    assert.equal(result.ok, true, result.error);
    assert.equal(step(result, 'remote').status, 'done');
    assert.equal(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: projectDir(f), encoding: 'utf8' }).trim(), url);
    assert.equal(execFileSync('git', ['ls-remote', URL_TARGET], { encoding: 'utf8' }).trim(), '');
    assert.deepEqual(f.calls(), []);
    assert.equal(items(f).length, 0);
    const rows = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'project-repos.json'), 'utf8'));
    // The register step reads the URL with git remote get-url, which applies the insteadOf rewrite of the test config.
    assert.match(rows[0].remote, /reachable\.git|url-target\.git/);
  } finally { f.cleanup(); }
});

test('--remote URL that cannot be reached fails and leaves no origin', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { remote: 'https://example.invalid/acme/unreachable.git' }));
    assert.equal(result.ok, false);
    assert.equal(step(result, 'remote').status, 'failed');
    assert.throws(() => execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectDir(f), stdio: 'pipe' }));
  } finally { f.cleanup(); }
});

test('URL validation refuses credentials, other schemes, and spaces, and never echoes the value', () => {
  for (const good of ['https://github.com/acme/demo.git', 'ssh://git@github.com/acme/demo.git', 'git@github.com:acme/demo.git', 'git://example.invalid/x.git']) {
    assert.equal(validateRemoteUrl(good), good);
  }
  for (const bad of [PASSWORD_URL, 'https://tokenonly@github.com/acme/demo.git', 'ssh://octo:pw12345@github.com/x.git', 'ftp://example.invalid/x.git', 'file:///tmp/x', '/tmp/x', 'https://example.invalid/a b', '']) {
    assert.throws(() => validateRemoteUrl(bad), (error) => !error.message.includes('hunter2') && !error.message.includes('pw12345') && !error.message.includes('tokenonly'), bad);
  }
});

test('a credential URL is refused by the flow before any change', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew(base(f, { remote: PASSWORD_URL })), (error) => /credentials/.test(error.message) && !error.message.includes('hunter2'));
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
  } finally { f.cleanup(); }
});

test('a dry run names the remote step and writes and posts nothing', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { dryRun: true }));
    assert.equal(step(result, 'remote').status, 'planned');
    assert.match(step(result, 'remote').detail, /decide item/);
    assert.deepEqual(f.calls(), []);
    assert.equal(items(f).length, 0);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
  } finally { f.cleanup(); }
});

test('cli: the command exits 3 and prints the waiting message, then continues after the answer', () => {
  const f = fixture();
  try {
    const out = [];
    const run = (extra = []) => projectCommand(['new', 'demo', '--group', f.group, '--remote', 'gh', ...extra], { env: f.env, herdr: () => { throw new Error('no call'); }, dataDir: f.dataDir, log: (l) => out.push(l), flowOptions: { repoRoot: f.repoRoot, ceiling: f.ceiling, stepRunners: { labels: () => 'done' } } });
    assert.equal(run(), 3);
    const text = out.join('\n');
    assert.match(text, /waiting for an Owner decision/);
    assert.match(text, new RegExp(items(f)[0].id));
    assert.match(text, /remote\s+waiting/);
    ownerReply(f, items(f)[0].id, 'Create private');
    assert.equal(run(['--resume']), 0);
  } finally { f.cleanup(); }
});

test('only the newest Owner reply counts: an unclear newest reply keeps waiting', () => {
  const f = fixture();
  try {
    runProjectNew(base(f));
    const id = items(f)[0].id;
    ownerReply(f, id, 'Create private');
    ownerReply(f, id, 'wait, not sure');
    const result = runProjectNew(base(f, { resume: true }));
    assert.equal(result.waiting, true);
    assert.deepEqual(f.calls(), []);
    ownerReply(f, id, 'Do not create');
    assert.equal(step(runProjectNew(base(f, { resume: true })), 'remote').status, 'skipped');
  } finally { f.cleanup(); }
});

test('an organization that starts with a dash or holds a bad character is refused before any change', () => {
  const f = fixture();
  try {
    for (const org of ['-x', '--help', 'a/b', 'a b', '']) {
      assert.throws(() => runProjectNew(base(f, { org })), /organization/i, org);
    }
    assert.equal(fs.existsSync(path.join(f.dataDir, 'flows')), false);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

const wizard = (visibility, extra = {}) => ({ visibility, source: 'wizard', ...(visibility === 'public' ? { confirmPublic: true } : {}), ...extra });
const stateOf = (result) => JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));

test('a wizard decision for private creates the repository and posts no item', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { decision: wizard('private') }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.waiting, undefined);
    assert.equal(items(f).length, 0);
    assert.deepEqual(createCalls(f), [`repo create octo/demo --private --source ${projectDir(f)} --remote origin`]);
    assert.equal(step(result, 'remote').status, 'done');
  } finally { f.cleanup(); }
});

test('a wizard decision for public with the confirmation creates a public repository and posts no item', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { visibility: 'public', decision: wizard('public') }));
    assert.equal(result.ok, true, result.error);
    assert.equal(items(f).length, 0);
    assert.deepEqual(createCalls(f), [`repo create octo/demo --public --source ${projectDir(f)} --remote origin`]);
  } finally { f.cleanup(); }
});

test('a wizard decision for public without confirmPublic is refused before any change', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew(base(f, { visibility: 'public', decision: { visibility: 'public', source: 'wizard' } })), /confirm/i);
    assert.throws(() => runProjectNew(base(f, { visibility: 'public', decision: { visibility: 'public', source: 'wizard', confirmPublic: 'yes' } })), /confirm/i);
    assert.equal(fs.existsSync(projectDir(f)), false);
    assert.deepEqual(f.calls(), []);
    assert.equal(items(f).length, 0);
  } finally { f.cleanup(); }
});

test('a decision needs source wizard and a valid visibility', () => {
  const f = fixture();
  try {
    assert.throws(() => runProjectNew(base(f, { decision: { visibility: 'private', source: 'cli' } })), /decision/i);
    assert.throws(() => runProjectNew(base(f, { decision: { visibility: 'internal', source: 'wizard' } })), /visibility/i);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

test('the state records the wizard decision without a secret', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { decision: wizard('private') }));
    const decision = stateOf(result).ids.remoteDecision;
    assert.deepEqual(Object.keys(decision).sort(), ['at', 'source', 'visibility']);
    assert.equal(decision.visibility, 'private');
    assert.equal(decision.source, 'wizard');
    assert.ok(!Number.isNaN(Date.parse(decision.at)));
    assert.doesNotMatch(JSON.stringify(stateOf(result)), /ghp_|hunter2/);
  } finally { f.cleanup(); }
});

test('a resumed flow that has a decision never posts an item', () => {
  const f = fixture();
  try {
    f.mode('loggedout');
    const first = runProjectNew(base(f, { decision: wizard('private') }));
    assert.equal(first.ok, false);
    assert.equal(step(first, 'remote').status, 'failed');
    f.mode('ok');
    const again = runProjectNew(base(f, { resume: true }));
    assert.equal(again.ok, true, again.error);
    assert.equal(createCalls(f).length, 1);
    assert.equal(createCalls(f)[0].includes('--private'), true);
    assert.equal(items(f).filter((r) => r.action === 'decide').length, 0);
  } finally { f.cleanup(); }
});

test('a flow with a posted item that the wizard then decides closes the item and creates the repository', () => {
  const f = fixture();
  try {
    const first = runProjectNew(base(f));
    assert.equal(first.waiting, true);
    const [item] = items(f);
    assert.equal(item.closedAt, undefined);
    const resumed = runProjectNew(base(f, { resume: true, decision: wizard('private') }));
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(createCalls(f).length, 1);
    const closed = readMessages({ dir: f.dataDir }).find((r) => r.id === item.id);
    assert.ok(closed.closedAt);
    assert.match(closed.closeNote, /answered in the wizard/);
    assert.equal(items(f).filter((r) => r.action === 'decide').length, 1);
  } finally { f.cleanup(); }
});

test('a wizard decision wins over an Owner reply to an item that was posted earlier', () => {
  const f = fixture();
  try {
    runProjectNew(base(f, { visibility: 'public' }));
    ownerReply(f, items(f)[0].id, 'Create public');
    const resumed = runProjectNew(base(f, { resume: true, decision: wizard('private') }));
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(createCalls(f)[0].includes('--private'), true);
  } finally { f.cleanup(); }
});

test('cli: --visibility public still posts the decide item', () => {
  const f = fixture();
  try {
    const out = [];
    const code = projectCommand(['new', 'demo', '--group', f.group, '--remote', 'gh', '--visibility', 'public'], { env: f.env, herdr: () => { throw new Error('no call'); }, dataDir: f.dataDir, log: (l) => out.push(l), flowOptions: { repoRoot: f.repoRoot, ceiling: f.ceiling } });
    assert.equal(code, 3);
    assert.equal(items(f).filter((r) => r.action === 'decide').length, 1);
    assert.deepEqual(createCalls(f), []);
  } finally { f.cleanup(); }
});

test('cli: a decision in the options of the command is ignored', () => {
  const f = fixture();
  try {
    const out = [];
    const code = projectCommand(['new', 'demo', '--group', f.group, '--remote', 'gh'], { env: f.env, herdr: () => { throw new Error('no call'); }, dataDir: f.dataDir, log: (l) => out.push(l), flowOptions: { repoRoot: f.repoRoot, ceiling: f.ceiling, decision: wizard('private') } });
    assert.equal(code, 3);
    assert.equal(items(f).filter((r) => r.action === 'decide').length, 1);
    assert.deepEqual(createCalls(f), []);
  } finally { f.cleanup(); }
});

test('a dry run with a decision names the repository and says that no item is posted', () => {
  const f = fixture();
  try {
    const result = runProjectNew(base(f, { dryRun: true, decision: wizard('private') }));
    assert.doesNotMatch(step(result, 'remote').detail, /post a decide item/);
    assert.match(step(result, 'remote').detail, /without a decide item/);
    assert.match(step(result, 'remote').detail, /gh repo create .*--private/);
    assert.equal(items(f).length, 0);
  } finally { f.cleanup(); }
});
