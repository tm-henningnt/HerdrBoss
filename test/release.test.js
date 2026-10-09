// Tests for the release approval commands. They use a fake gh runner, a fake herdr runner, and a temporary data dir.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-test-'));
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = path.join(root, 'data');
process.env.HERDR_BOSS_PORT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.HERDR_BOSS_DIR, { recursive: true });

const { assertTempDataDir } = await import('../src/data-dir-guard.js');
assertTempDataDir(process.env.HERDR_BOSS_DIR);
const release = await import('../src/release.js');
const { openMessageStore } = await import('../src/message-store.js');
const { scanTokenText } = await import('../scripts/docs-gate.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const REPO = 'example-org/example-app';
const TAG = 'v1.0.0';
const config = { releases: { repos: [{ name: REPO, project: 'example', kind: 'app' }] } };
const knownHosts = ['tenant.example.test'];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
let counter = 0;
const newDir = () => { const dir = path.join(root, `case-${++counter}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

// A fake gh. `state` can change between calls: state.draft, state.files (name -> content), state.body.
function fakeGh(state = {}) {
  state.draft ??= true;
  state.body ??= 'Changelog text';
  state.files ??= { 'app.tar.gz': 'archive bytes' };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const ok = (stdout = '') => ({ status: 0, error: null, stdout, stderr: '' });
    if (args[0] === 'release' && args[1] === 'view') {
      return ok(JSON.stringify({
        name: 'Test', tagName: args[2], isDraft: state.draft, body: state.body, targetCommitish: 'abc1234', url: 'https://github.com/example-org/example-app/releases/tag/v1.0.0',
        assets: Object.entries(state.files).map(([name, content]) => ({ name, size: content.length, digest: `sha256:${sha(content)}` })),
      }));
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name), state.files[name]);
      return ok();
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      state.uploadedPaths = args.slice(5);
      state.onUpload?.(state.uploadedPaths);
      for (const file of args.slice(5)) state.files[path.basename(file)] = fs.readFileSync(file);
      return ok();
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      if (args.includes('--draft=false')) state.draft = false;
      if (args.includes('--notes')) state.body = args[args.indexOf('--notes') + 1];
      return ok();
    }
    if (args[0] === 'release' && args[1] === 'list') return ok(JSON.stringify([{ tagName: TAG, isDraft: state.draft, isLatest: false, publishedAt: '2026-10-01T00:00:00Z' }]));
    return { status: 1, error: null, stdout: '', stderr: 'unexpected gh call' };
  };
  run.calls = calls;
  run.state = state;
  return run;
}

function fakeHerdr() {
  const prompts = [];
  const run = (args) => { if (args[0] === 'agent' && args[1] === 'prompt') prompts.push({ pane: args[2], text: args[3] }); return {}; };
  run.prompts = prompts;
  return run;
}

const request = (dir, run, extra = {}) => release.requestRelease({ repo: REPO, tag: TAG, run, dir, knownHosts, config, requesterPane: 'wA:p1', ...extra });
const answer = (dir, id, text, offset = 1000) => openMessageStore({ dir }).append({
  thread: 'example', from: 'owner', to: 'orch', kind: 'message', text, replyTo: id, status: 'queued', at: new Date(Date.now() + offset).toISOString(),
});
const item = (dir, id) => openMessageStore({ dir }).all().find((record) => record.id === id);
const publish = (dir, run, id, extra = {}) => release.publishRelease({ repo: REPO, tag: TAG, approvalId: id, run, dir, knownHosts, config, who: 'wA:p1', ...extra });
const requestAssets = (dir, run, files, extra = {}) => release.requestAddAsset({
  repo: REPO, tag: TAG, files, reason: 'Add the demo app', run, dir, knownHosts, config, requesterPane: 'wA:p1', ...extra,
});
const applyAssets = (dir, run, id, extra = {}) => release.applyAddAsset({ repo: REPO, tag: TAG, approvalId: id, run, dir, knownHosts, config, who: 'wA:p1', ...extra });
const releaseCaller = (paneId, label, workspaceId = paneId.split(':')[0]) => ({
  env: { HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_WORKSPACE_ID: workspaceId },
  herdr: (args) => ({ pane: { pane_id: args[2], workspace_id: workspaceId, label } }),
});
async function cancel(dir, run, paneId = 'wA:p1', label = 'orch', extra = []) {
  const lines = [];
  const caller = releaseCaller(paneId, label);
  const code = await release.releaseCommand(['cancel', REPO, TAG, ...extra], {
    ...caller, dataDir: dir, config, run, out: (line) => lines.push(line), err: (line) => lines.push(line),
  });
  return { code, lines };
}

test('request posts one Mailbox item the Owner can answer, with all card fields', () => {
  const dir = newDir();
  const run = fakeGh();
  const result = request(dir, run);
  assert.equal(result.alreadyOpen, false);
  const record = item(dir, result.id);
  assert.equal(record.kind, 'report');
  assert.equal(record.action, 'approve');
  assert.equal(record.to, 'owner');
  assert.equal(record.thread, 'example');
  assert.equal(record.release.assets[0].sha256, sha('archive bytes'));
  for (const part of [/Repository: example-org\/example-app/, /Tag: v1\.0\.0/, /releases\/tag\/v1\.0\.0/, /## Changelog/, /app\.tar\.gz: \d+ bytes, sha256 [0-9a-f]{64}/, /Pass: no secrets found/, /abc1234/, /## Review coverage/, /Approve makes the release public and marks it as the latest/]) {
    assert.match(record.text, part);
  }
});

test('request is refused for a repository outside releases.repos', () => {
  assert.throws(() => release.requestRelease({ repo: 'other-org/other', tag: TAG, run: fakeGh(), dir: newDir(), config, knownHosts }), /not in the releases\.repos setting.*Settings.*Releases/);
});

test('a second request for the same repository and tag returns the open item', () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const second = request(dir, run);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(openMessageStore({ dir }).all().filter((record) => record.release).length, 1);
});

test('an open request made with a notes file is not stale when repeated without that file', () => {
  const dir = newDir();
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'Notes file text');
  const run = fakeGh();
  const first = request(dir, run, { notesFile });
  assert.equal(item(dir, first.id).release.notesFromFile, true);
  const second = request(dir, run);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.stale, false);
});

test('an unreadable draft leaves the existing request open without a stale result', () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const unreadable = (args) => args[1] === 'view'
    ? { status: 1, error: null, stdout: '', stderr: 'release is unavailable' }
    : run(args);
  let second;
  assert.doesNotThrow(() => { second = request(dir, unreadable); });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.stale, undefined);
});

test('unreadable assets leave the existing request open without a stale result', () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const unreadable = (args) => args[1] === 'download'
    ? { status: 1, error: null, stdout: '', stderr: 'asset is unavailable' }
    : run(args);
  let second;
  assert.doesNotThrow(() => { second = request(dir, unreadable); });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.stale, undefined);
});

test('an open request is stale when the changelog text changes', () => {
  const dir = newDir();
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'First notes');
  const run = fakeGh();
  const first = request(dir, run, { notesFile });
  assert.equal(item(dir, first.id).release.notesSha256, sha('First notes'));
  fs.writeFileSync(notesFile, 'Updated notes');
  const second = request(dir, run, { notesFile });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.stale, true);
  assert.equal(openMessageStore({ dir }).all().filter((record) => record.release).length, 1);
});

test('an open request is stale when an asset checksum changes', () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  run.state.files['app.tar.gz'] = 'updated archive bytes';
  const second = request(dir, run);
  assert.equal(second.id, first.id);
  assert.equal(second.stale, true);
});

test('an older request without a notes hash has no notes mismatch', () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const store = openMessageStore({ dir });
  const record = item(dir, first.id);
  delete record.release.notesSha256;
  store.update(first.id, { release: record.release });
  const second = request(dir, run);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.stale, false);
});

test('the release command explains how to supersede a stale request', async () => {
  const dir = newDir();
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'First notes');
  const run = fakeGh();
  const first = request(dir, run, { notesFile });
  fs.writeFileSync(notesFile, 'Updated notes');
  const lines = [];
  const result = await release.releaseCommand(['request', REPO, TAG, '--notes', notesFile], {
    dataDir: dir, config, run, env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => lines.push(line), err: (line) => lines.push(line),
  });
  assert.equal(result, 0);
  assert.deepEqual(lines, [`The open request ${first.id} shows older notes; run release cancel ${REPO} ${TAG}, then request again.`]);
});

test('the requester can cancel a manually closed request, with a bounded reason and one audit line', async () => {
  const { closeMailboxItem } = await import('../src/messages.js');
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  closeMailboxItem(first.id, { dir });
  const reason = 'Updated release notes';
  const result = await cancel(dir, run, 'wA:p1', 'orch', ['--reason', reason]);
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /cancelled/i);
  const record = item(dir, first.id);
  assert.equal(record.closeNote, 'superseded');
  assert.equal(record.supersededReason, reason);
  assert.equal(record.closedBy, 'project');
  assert.ok(record.closedAt);
  assert.ok(record.readAt);
  assert.equal(release.releaseStatus({ run, dir, config }).openRequests.length, 0);
  const audit = fs.readFileSync(path.join(dir, 'releases', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.deepEqual({ approvalId: audit[0].approvalId, who: audit[0].who, repo: audit[0].repo, tag: audit[0].tag, action: audit[0].action, reason: audit[0].reason }, {
    approvalId: first.id, who: 'wA:p1', repo: REPO, tag: TAG, action: 'cancel', reason,
  });
  const next = request(dir, run);
  assert.equal(next.alreadyOpen, false);
  assert.notEqual(next.id, first.id);
});

test('the Boss pane can cancel a release request', async () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const result = await cancel(dir, run, 'wB:p1', 'boss');
  assert.equal(result.code, 0);
  assert.equal(item(dir, first.id).closeNote, 'superseded');
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'releases', 'audit.jsonl'), 'utf8').trim());
  assert.equal(line.who, 'wB:p1');
});

test('another orchestrator cannot cancel a release request', async () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const result = await cancel(dir, run, 'wA:p2', 'orch');
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /Only the requesting orchestrator pane or the Boss can cancel/);
  assert.equal(item(dir, first.id).closeNote, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'releases', 'audit.jsonl')), false);
});

test('an Owner approval blocks cancellation and names the publish path', async () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  answer(dir, first.id, 'Approved.');
  const result = await cancel(dir, run);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /release publish.*Owner denial/i);
  assert.equal(item(dir, first.id).closeNote, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'releases', 'audit.jsonl')), false);
});

test('cancel without an open request exits non-zero with a plain message', async () => {
  const dir = newDir();
  const result = await cancel(dir, fakeGh());
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /No open release request/);
  assert.doesNotMatch(result.lines.join('\n'), /TypeError|ReferenceError|at release/i);
});

test('cancel truncates a stored reason to 500 characters', async () => {
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  const longReason = 'x'.repeat(600);
  assert.equal((await cancel(dir, run, 'wA:p1', 'orch', ['--reason', longReason])).code, 0);
  assert.equal(item(dir, first.id).supersededReason.length, 500);
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'releases', 'audit.jsonl'), 'utf8').trim());
  assert.equal(line.reason.length, 500);
});

test('add-asset posts hashes, scan results, reason, and the full Demo app notes block', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  const notesFile = path.join(dir, 'demo-notes.md');
  fs.writeFileSync(file, 'demo bundle');
  fs.writeFileSync(notesFile, 'Try the sample app.\nOpen the README for steps.\n');
  const result = requestAssets(dir, run, [file], { appendNotesFile: notesFile });
  const record = item(dir, result.id);
  const block = '## Demo app\n\nTry the sample app.\nOpen the README for steps.\n';
  assert.equal(result.alreadyOpen, false);
  assert.equal(result.scanOk, true);
  assert.equal(record.release.operation, 'add-asset');
  assert.equal(record.release.bodyHash, sha('Changelog text'));
  assert.deepEqual(record.release.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })), [
    { name: 'demo.zip', size: 11, sha256: sha('demo bundle') },
  ]);
  assert.match(record.text, /Repository: example-org\/example-app/);
  assert.match(record.text, /Tag: v1\.0\.0/);
  assert.match(record.text, /Reason: Add the demo app/);
  assert.match(record.text, new RegExp(`demo\\.zip: 11 bytes, sha256 ${sha('demo bundle')}`));
  assert.match(record.text, /Pass: no secrets found\./);
  assert.ok(record.text.includes(block));
  assert.equal(record.text.includes(file), false);
});

test('add-asset refuses a file name that already exists on the release', () => {
  const dir = newDir();
  const file = path.join(dir, 'app.tar.gz');
  fs.writeFileSync(file, 'new bundle');
  assert.throws(() => requestAssets(dir, fakeGh(), [file]), /already exists on the release/);
  assert.equal(openMessageStore({ dir }).all().length, 0);
});

test('add-asset refuses a symlink and a file name that contains a hash', () => {
  const dir = newDir();
  const target = path.join(dir, 'demo.zip');
  const link = path.join(dir, 'demo-link.zip');
  const hashFile = path.join(dir, 'demo#app.zip');
  fs.writeFileSync(target, 'demo bundle');
  fs.symlinkSync(target, link);
  fs.writeFileSync(hashFile, 'demo bundle');
  assert.throws(() => requestAssets(dir, fakeGh({ draft: false }), [link]), /symlink/i);
  assert.throws(() => requestAssets(dir, fakeGh({ draft: false }), [hashFile]), /cannot contain #/);
  assert.throws(() => requestAssets(dir, fakeGh({ draft: false }), [dir]), /not a regular file/);
  assert.equal(openMessageStore({ dir }).all().length, 0);
});

test('add-asset requires a non-empty reason and at least one readable non-empty file', async () => {
  const dir = newDir();
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, '');
  const lines = [];
  const code = await release.releaseCommand(['add-asset', REPO, TAG, file], {
    dataDir: dir, config, run: fakeGh({ draft: false }), env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => lines.push(line), err: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /--reason is required/);
  assert.throws(() => requestAssets(dir, fakeGh({ draft: false }), [file]), /is empty/);
  assert.throws(() => requestAssets(dir, fakeGh({ draft: false }), [path.join(dir, 'missing.zip')]), /Cannot read asset file/);
  assert.equal(openMessageStore({ dir }).all().length, 0);
});

test('a second identical add-asset request returns its open approval ID', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const first = requestAssets(dir, run, [file]);
  const second = requestAssets(dir, run, [file]);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  assert.equal(openMessageStore({ dir }).all().filter((record) => record.release?.operation === 'add-asset').length, 1);
});

test('apply-asset waits for an Owner Accept and does not upload', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  const result = applyAssets(dir, run, id);
  assert.equal(result.ok, false);
  assert.equal(result.waiting, true);
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset refuses a file that changed after the request', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  answer(dir, id, 'Approved.');
  fs.writeFileSync(file, 'changed bundle');
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'file-changed');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset refuses when a requested asset name exists at apply time', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  answer(dir, id, 'Approved.');
  run.state.files['demo.zip'] = 'another upload';
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'asset-name-exists');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset settles and refuses an Owner denial', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  answer(dir, id, 'Rejected.');
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'not-accept');
  assert.equal(item(dir, id).closeNote, 'denied by the Owner');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('release commands reject an approval for the other operation', () => {
  const publishDir = newDir();
  const publishRun = fakeGh();
  const publishRequest = request(publishDir, publishRun);
  assert.equal(applyAssets(publishDir, publishRun, publishRequest.id).code, 'wrong-operation');

  const addDir = newDir();
  const addRun = fakeGh({ draft: false });
  const file = path.join(addDir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const addRequest = requestAssets(addDir, addRun, [file]);
  answer(addDir, addRequest.id, 'Approved.');
  assert.equal(publish(addDir, addRun, addRequest.id).code, 'wrong-operation');
  assert.ok(!addRun.calls.some((args) => args[1] === 'edit'));
});

test('apply-asset refuses an Owner answer older than the request', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  answer(dir, id, 'Approved.', -60000);
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'answer-too-old');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset refuses files that fail the scan', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  fs.writeFileSync(file, `bundle ${fakeToken}`);
  const requested = requestAssets(dir, run, [file]);
  assert.equal(requested.scanOk, false);
  const { id } = requested;
  answer(dir, id, 'Approved.');
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'scan-failed');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset refuses when the release body changed after the request', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  answer(dir, id, 'Approved.');
  run.state.body = 'Updated changelog text';
  const result = applyAssets(dir, run, id);
  assert.equal(result.code, 'body-changed');
  assert.equal(result.reason, 'the release body changed since the request; cancel and request again');
  assert.ok(!run.calls.some((args) => args[1] === 'upload'));
});

test('apply-asset uploads files, appends notes, audits names, and closes the request', () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  const notesFile = path.join(dir, 'demo-notes.md');
  fs.writeFileSync(file, 'demo bundle');
  fs.writeFileSync(notesFile, 'Try the sample app.');
  const { id } = requestAssets(dir, run, [file], { appendNotesFile: notesFile });
  answer(dir, id, 'Approved.');
  let stagedPath;
  let stagedDirectory;
  run.state.onUpload = (paths) => {
    stagedPath = paths[0];
    stagedDirectory = path.dirname(stagedPath);
    assert.notEqual(stagedPath, file);
    assert.equal(path.basename(stagedPath), 'demo.zip');
    assert.equal(fs.statSync(stagedDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(stagedPath, 'utf8'), 'demo bundle');
    fs.writeFileSync(file, 'changed after verification');
  };
  const result = applyAssets(dir, run, id);
  assert.equal(result.ok, true);
  assert.deepEqual(run.calls.find((args) => args[1] === 'upload'), ['release', 'upload', TAG, '--repo', REPO, stagedPath]);
  assert.equal(run.calls.some((args) => args.includes('--clobber')), false);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.existsSync(stagedDirectory), false);
  const edit = run.calls.find((args) => args[1] === 'edit');
  assert.deepEqual(edit, ['release', 'edit', TAG, '--repo', REPO, '--notes', 'Changelog text\n\n## Demo app\n\nTry the sample app.']);
  assert.ok(run.state.body.startsWith('Changelog text'));
  assert.equal(item(dir, id).closeNote, 'assets added');
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'releases', 'audit.jsonl'), 'utf8').trim());
  assert.deepEqual({ approvalId: line.approvalId, who: line.who, repo: line.repo, tag: line.tag, action: line.action, files: line.files }, {
    approvalId: id, who: 'wA:p1', repo: REPO, tag: TAG, action: 'add-asset', files: ['demo.zip'],
  });
});

test('apply-asset reports uploaded file names when the body changes before the notes edit', async () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  const notesFile = path.join(dir, 'demo-notes.md');
  fs.writeFileSync(file, 'demo bundle');
  fs.writeFileSync(notesFile, 'Try the sample app.');
  const { id } = requestAssets(dir, run, [file], { appendNotesFile: notesFile });
  answer(dir, id, 'Approved.');
  let stagedPath;
  run.state.onUpload = (paths) => { stagedPath = paths[0]; run.state.body = 'Edited after upload'; };
  const lines = [];
  const code = await release.releaseCommand(['apply-asset', REPO, TAG, '--approval', id], {
    dataDir: dir, config, run, env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => lines.push(line), err: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /demo\.zip/);
  assert.match(lines.join('\n'), /cancel the request and request again; the uploaded assets stay/);
  assert.ok(!run.calls.some((args) => args[1] === 'edit'));
  assert.equal(fs.existsSync(stagedPath), false);
});

test('the add-asset command posts an approval and its Owner notice names apply-asset', async () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const lines = [];
  const code = await release.releaseCommand(['add-asset', REPO, TAG, file, '--reason', 'Add the sample app'], {
    dataDir: dir, config, run, env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => lines.push(line), err: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /Posted add-asset approval/);
  const approval = openMessageStore({ dir }).all()[0];
  const herdr = fakeHerdr();
  const reply = answer(dir, approval.id, 'Accept.');
  assert.equal(release.noticeReleaseAnswer(reply, { dir, herdr }).verdict, 'accepted');
  assert.match(herdr.prompts[0].text, new RegExp(`release apply-asset ${REPO.replace('/', '\\/')} ${TAG} --approval ${approval.id}`));
  const applyLines = [];
  const applyCode = await release.releaseCommand(['apply-asset', REPO, TAG, '--approval', approval.id], {
    dataDir: dir, config, run, env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => applyLines.push(line), err: (line) => applyLines.push(line),
  });
  assert.equal(applyCode, 0);
  assert.match(applyLines.join('\n'), /Added approved assets/);
});

test('cancel settles an open add-asset request', async () => {
  const dir = newDir();
  const run = fakeGh({ draft: false });
  const file = path.join(dir, 'demo.zip');
  fs.writeFileSync(file, 'demo bundle');
  const { id } = requestAssets(dir, run, [file]);
  const result = await cancel(dir, run);
  assert.equal(result.code, 0);
  assert.equal(item(dir, id).closeNote, 'superseded');
  assert.equal(release.releaseStatus({ run, dir, config }).openRequests.length, 0);
});

test('request refuses a release that is not a draft', () => {
  assert.throws(() => request(newDir(), fakeGh({ draft: false })), /no longer a draft/);
});

test('the scan names the class, never the value, for notes and for asset content', () => {
  const dir = newDir();
  const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, `Token ${fakeToken}\nBuilt in /Users/someone/work\nSee https://tenant.example.test/app\n`);
  const run = fakeGh({ files: { 'app.tar.gz': `key -----BEGIN PRIVATE KEY-----\n` } });
  const result = request(dir, run, { notesFile });
  assert.equal(result.scanOk, false);
  const text = item(dir, result.id).text;
  assert.match(text, /Fail:/);
  for (const name of ['GitHub token', 'private path', 'tenant host', 'private key']) assert.match(text, new RegExp(name));
  assert.ok(!text.includes(fakeToken));
});

test('the scan blocks an inline license blob and allows a public verification key', () => {
  const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo';
  const bad = request(newDir(), fakeGh({ files: { 'app.js': `license: ${blob}\n` } }));
  assert.equal(bad.scanOk, false);
  const good = request(newDir(), fakeGh({ files: { 'app.js': '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n' } }));
  assert.equal(good.scanOk, true);
});

test('a checksum that differs from the listed digest is a finding', () => {
  const run = fakeGh();
  const view = run;
  const wrapped = (args) => {
    const result = view(args);
    if (args[1] === 'view') { const data = JSON.parse(result.stdout); data.assets[0].digest = `sha256:${'0'.repeat(64)}`; return { ...result, stdout: JSON.stringify(data) }; }
    return result;
  };
  const dir = newDir();
  const result = request(dir, wrapped);
  assert.equal(result.scanOk, false);
  assert.match(item(dir, result.id).text, /checksum differs/);
});

test('the card names the review pack answer when the review store has one', () => {
  const dir = newDir();
  const result = request(dir, fakeGh(), { pack: 'landing' });
  assert.match(item(dir, result.id).text, /Pack landing: /);
});

test('publish waits while the Owner has not answered', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  const result = publish(dir, run, id);
  assert.equal(result.ok, false);
  assert.equal(result.waiting, true);
  assert.ok(!run.calls.some((args) => args[1] === 'edit'));
});

test('publish refuses with no approval, with another repository, and with a repository outside the setting', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  assert.equal(publish(dir, run, 'm-none').code, 'no-approval');
  assert.equal(release.publishRelease({ repo: 'other-org/other', tag: TAG, approvalId: id, run, dir, config: { releases: { repos: [{ name: 'other-org/other', project: 'x', kind: 'app' }] } } }).code, 'wrong-approval');
  assert.equal(release.publishRelease({ repo: 'other-org/other', tag: TAG, approvalId: id, run, dir, config }).code, 'repo-not-allowed');
});

test('a deny closes the item and publish refuses', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Rejected.');
  const result = publish(dir, run, id);
  assert.equal(result.code, 'not-accept');
  assert.ok(item(dir, id).closedAt);
  assert.equal(publish(dir, run, id).code, 'closed');
  assert.ok(!run.calls.some((args) => args[1] === 'edit'));
});

test('an answer older than the request is refused', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Approved.', -60000);
  assert.equal(publish(dir, run, id).code, 'answer-too-old');
});

test('a changed asset after the request is refused', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Approved.');
  run.state.files['app.tar.gz'] = 'other bytes';
  assert.equal(publish(dir, run, id).code, 'checksum-mismatch');
  run.state.files['app.tar.gz'] = 'archive bytes';
  run.state.files['extra.zip'] = 'new';
  assert.equal(publish(dir, run, id).code, 'checksum-mismatch');
  assert.ok(!run.calls.some((args) => args[1] === 'edit'));
});

test('a scan finding after the request is refused', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Approved.');
  run.state.body = 'Built in /Users/someone/work';
  assert.equal(publish(dir, run, id).code, 'scan-failed');
});

test('a release that is no longer a draft is refused', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Approved.');
  run.state.draft = false;
  assert.equal(publish(dir, run, id).code, 'not-draft');
  assert.ok(!run.calls.some((args) => args[1] === 'edit'));
});

test('publish edits the draft, writes an audit line, and closes the item', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Approved.');
  const result = publish(dir, run, id);
  assert.equal(result.published, true);
  assert.deepEqual(run.calls.find((args) => args[1] === 'edit'), ['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest']);
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'releases', 'audit.jsonl'), 'utf8').trim());
  assert.equal(line.approvalId, id);
  assert.equal(line.who, 'wA:p1');
  assert.ok(line.at);
  assert.equal(item(dir, id).closeNote, 'published');
  assert.ok(!run.calls.some((args) => ['delete', 'create', 'upload'].includes(args[1])));
});

test('publish uses --latest=false when the card says so', () => {
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run, { latest: false });
  answer(dir, id, 'Approved.');
  publish(dir, run, id);
  assert.equal(run.calls.find((args) => args[1] === 'edit').at(-1), '--latest=false');
});

test('the Owner answer sends one notice to the requesting pane, and a deny closes the item', () => {
  const dir = newDir();
  const herdr = fakeHerdr();
  const { id } = request(dir, fakeGh());
  const reply = answer(dir, id, 'Approved.');
  assert.equal(release.noticeReleaseAnswer(reply, { dir, herdr }).verdict, 'accepted');
  assert.equal(release.noticeReleaseAnswer(reply, { dir, herdr }), null);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(herdr.prompts[0].pane, 'wA:p1');
  assert.match(herdr.prompts[0].text, /Owner accepted the release example-org\/example-app v1\.0\.0.*release publish .* --approval /);
  assert.ok(!item(dir, id).closedAt);

  const second = request(dir, fakeGh(), { requesterPane: 'wA:p2' }).id === id ? null : null;
  assert.equal(second, null);
});

test('the answer watcher notices a deny from the message store without polling', async () => {
  const dir = newDir();
  const herdr = fakeHerdr();
  const { id } = request(dir, fakeGh());
  const store = openMessageStore({ dir });
  const stop = release.watchReleaseAnswers(store, { dir, herdr });
  try {
    answer(dir, id, 'Rejected.');
    assert.equal(herdr.prompts.length, 1);
    assert.match(herdr.prompts[0].text, /denied/);
    assert.ok(item(dir, id).closedAt);
  } finally { stop(); }
});

test('release status lists drafts, open requests, and the last published release', () => {
  const dir = newDir();
  const run = fakeGh();
  request(dir, run);
  const status = release.releaseStatus({ run, dir, config });
  assert.deepEqual(status.repos[0].drafts, [TAG]);
  assert.equal(status.openRequests.length, 1);
  assert.equal(status.openRequests[0].tag, TAG);
});

test('the command returns exit codes 0, 1 and 3 and prints no token-shaped text', async () => {
  const dir = newDir();
  const run = fakeGh();
  const lines = [];
  const options = { dataDir: dir, config, run, env: { HERDR_PANE_ID: 'wA:p1' }, out: (line) => lines.push(line), err: (line) => lines.push(line) };
  assert.equal(await release.releaseCommand(['request', REPO, TAG], options), 0);
  const id = openMessageStore({ dir }).all().find((record) => record.release).id;
  assert.equal(await release.releaseCommand(['publish', REPO, TAG, '--approval', id], options), 3);
  answer(dir, id, 'Rejected.');
  assert.equal(await release.releaseCommand(['publish', REPO, TAG, '--approval', id], options), 1);
  assert.equal(await release.releaseCommand(['request', 'other-org/other', TAG], options), 1);
  assert.equal(await release.releaseCommand(['status'], options), 0);
  assert.deepEqual(scanTokenText(lines.join('\n')), []);
  assert.deepEqual(scanTokenText(item(dir, id).text), []);
});

test('releases.repos validation accepts a good entry and names each bad one', async () => {
  const { validateReleasesRepos } = await import('../src/config.js');
  assert.deepEqual(validateReleasesRepos(config.releases.repos).errors, []);
  const bad = validateReleasesRepos([{ name: 'no-slash', project: 'Bad Slug', kind: '' }, config.releases.repos[0], config.releases.repos[0]]);
  assert.equal(bad.errors.length, 4);
  assert.deepEqual(bad.repos, [config.releases.repos[0]]);
});

test('releases.repos validation keeps only the policy fields', async () => {
  const { validateReleasesRepos } = await import('../src/config.js');
  const result = validateReleasesRepos([{ name: REPO, project: 'example', kind: 'app', token: 'fixture-only' }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.repos, [{ name: REPO, project: 'example', kind: 'app' }]);
});

test('releases.repos is a visible service setting that accepts and validates repository rows', async () => {
  const { loadConfig, serviceSettingsView, validateServiceSettings, writeServiceSettings } = await import('../src/config.js');
  writeServiceSettings({ 'releases.repos': config.releases.repos }, { dataDir: process.env.HERDR_BOSS_DIR });
  const view = serviceSettingsView(loadConfig());
  assert.deepEqual(view.find(({ setting }) => setting === 'releases.repos'), {
    group: 'Releases', setting: 'releases.repos', value: config.releases.repos, source: 'config',
  });
  assert.deepEqual(serviceSettingsView({}).find(({ setting }) => setting === 'releases.repos'), {
    group: 'Releases', setting: 'releases.repos', value: [], source: 'default',
  });
  assert.deepEqual(validateServiceSettings({ 'releases.repos': config.releases.repos }), { 'releases.repos': config.releases.repos });
  assert.throws(() => validateServiceSettings({ 'releases.repos': [{ name: 'bad', project: 'Bad Slug', kind: '' }] }), /releases\.repos\[0\]/);
});

test('an Owner answer through the real close path leaves the request answered, not closed', async () => {
  const { closeMailboxItem } = await import('../src/messages.js');
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  const reply = answer(dir, id, 'Approved.');
  closeMailboxItem(id, { dir });
  assert.ok(item(dir, id).closedAt);
  assert.equal(item(dir, id).closedBy, undefined);
  // The notice does not depend on the order of the close and the append event.
  const herdr = fakeHerdr();
  assert.equal(release.noticeReleaseAnswer(reply, { dir, herdr }).verdict, 'accepted');
  assert.equal(herdr.prompts.length, 1);
  assert.equal(publish(dir, run, id).published, true);
  assert.equal(item(dir, id).closeNote, 'published');
  assert.equal(item(dir, id).closedBy, 'project');
  assert.equal(publish(dir, run, id).code, 'closed');
});

test('a Reject through the real close path is settled by the notice or by publish', async () => {
  const { closeMailboxItem } = await import('../src/messages.js');
  const dir = newDir();
  const run = fakeGh();
  const { id } = request(dir, run);
  answer(dir, id, 'Rejected.');
  closeMailboxItem(id, { dir });
  assert.equal(publish(dir, run, id).code, 'not-accept');
  assert.equal(item(dir, id).closeNote, 'denied by the Owner');
  assert.equal(publish(dir, run, id).code, 'closed');
});

test('a second request after the Owner answer and before publish posts no duplicate', async () => {
  const { closeMailboxItem } = await import('../src/messages.js');
  const dir = newDir();
  const run = fakeGh();
  const first = request(dir, run);
  answer(dir, first.id, 'Approved.');
  closeMailboxItem(first.id, { dir });
  const second = request(dir, run);
  assert.equal(second.alreadyOpen, true);
  assert.equal(second.id, first.id);
  assert.equal(release.releaseStatus({ run, dir, config }).openRequests.length, 1);
  assert.equal(openMessageStore({ dir }).all().filter((record) => record.release).length, 1);
});

// RS1: the Qlik Engine writes its own inline-table path into a .qvf. Only that exact pattern passes, only for a .qvf asset.
const ENGINE_PATH = '/home/engine/0123abcd-4567-89ab-cdef-0123456789ab.inline';

test('RS1: a qvf with the Engine inline path passes and the card counts the path', () => {
  const dir = newDir();
  const run = fakeGh({ files: { 'demo.qvf': `head\0${ENGINE_PATH}\0mid\0${ENGINE_PATH}\0tail` } });
  const result = request(dir, run);
  assert.equal(result.scanOk, true);
  const text = item(dir, result.id).text;
  assert.match(text, /Pass:/);
  assert.match(text, /demo\.qvf: qvf engine inline paths: 2, allowed/);
  assert.ok(!text.includes('/home/engine'), 'the card never shows the path');
});

test('RS1: a qvf with another path class still fails', () => {
  for (const bad of ['/Users/x/work/app', '/home/other/dir/file', '/home/engine/not-a-uuid.inline', `${ENGINE_PATH}/evil`, '/home/engine/0123abcd-4567-89ab-cdef-0123456789ab.txt']) {
    const dir = newDir();
    const run = fakeGh({ files: { 'demo.qvf': `a\0${ENGINE_PATH}\0${bad}\0b` } });
    const result = request(dir, run);
    assert.equal(result.scanOk, false, bad);
    assert.match(item(dir, result.id).text, /demo\.qvf: private path/);
  }
});

test('RS1: the same string in a zip or in the notes fails', () => {
  const dir = newDir();
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, `Source ${ENGINE_PATH}\n`);
  const zip = request(newDir(), fakeGh({ files: { 'demo.zip': `x${ENGINE_PATH}y` } }));
  assert.equal(zip.scanOk, false);
  const notes = request(dir, fakeGh({ files: { 'demo.qvf': 'clean' } }), { notesFile });
  assert.equal(notes.scanOk, false);
  assert.match(item(dir, notes.id).text, /notes: private path/);
});

test('RS1: scanRelease allows the Engine path only for a qvf file name', () => {
  assert.deepEqual(release.scanRelease(`a ${ENGINE_PATH} b`, { file: 'App.QVF' }), []);
  assert.deepEqual(release.scanRelease(`a ${ENGINE_PATH} b`, { file: 'app.zip' }), ['private path']);
  assert.deepEqual(release.scanRelease(`a ${ENGINE_PATH} b`), ['private path']);
});

test('RS1b: the real qvf byte shape passes with a length-prefix byte before the path', () => {
  const prefix = String.fromCharCode(ENGINE_PATH.length);
  const real = `...labels${prefix}${ENGINE_PATH}\0\0\0\0\0\0tail`;
  assert.deepEqual(release.scanRelease(real, { file: 'app.qvf' }), []);
  assert.deepEqual(release.scanRelease(real, { file: 'app.zip' }), ['private path']);
});

test('RS1b: a wrong prefix or a longer path before the Engine path still fails', () => {
  const wrong = String.fromCharCode(ENGINE_PATH.length + 1);
  for (const before of [wrong, 'x', '/Users/me', '/srv']) {
    assert.deepEqual(release.scanRelease(`ab${before}${ENGINE_PATH}\0`, { file: 'app.qvf' }), ['private path'], before);
  }
});
