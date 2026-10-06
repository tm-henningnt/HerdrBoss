// Tests for the release approval commands. Uses a fake gh runner and a temporary data dir.
// The fake gh runner returns canned responses for gh release view, edit, and list.
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-test-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';

const { assertTempDataDir } = await import('../src/data-dir-guard.js');
assertTempDataDir(dataDir);
const release = await import('../src/release.js');
const { openMessageStore } = await import('../src/message-store.js');
const { loadConfig } = await import('../src/config.js');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// A fake gh runner that returns canned responses.
function fakeGhRunner({ draft = true, assets = [], body = 'Changelog text' } = {}) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[0] === 'release' && args[1] === 'view') {
        return {
          status: 0,
          error: null,
          stdout: JSON.stringify({
            name: 'Test Release',
            tagName: args[3],
            draft,
            body,
            assets: assets.map((a) => ({ name: a.name, size: a.size, digest: a.sha256, url: `https://example.test/${a.name}` })),
          }),
          stderr: '',
        };
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        return { status: 0, error: null, stdout: '', stderr: '' };
      }
      if (args[0] === 'release' && args[1] === 'list') {
        return { status: 0, error: null, stdout: JSON.stringify([]), stderr: '' };
      }
      return { status: 1, error: new Error('unexpected gh call'), stdout: '', stderr: 'unexpected' };
    },
  };
}

// A fake herdr runner that records prompts to panes.
function fakeHerdr() {
  const prompts = [];
  return {
    prompts,
    run(args) {
      if (args[0] === 'agent' && args[1] === 'prompt') {
        prompts.push({ pane: args[2], text: args[3] });
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

const config = {
  releases: {
    repos: [
      { name: 'example-org/example-app', project: 'example', kind: 'app' },
    ],
  },
};

const knownHosts = ['tenant.example.test'];

test('request posts one Mailbox item with all card fields', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'request-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true, assets: [{ name: 'app.tar.gz', size: 1024, sha256: 'abc123' }] });
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    run,
    dir,
    knownHosts,
    requesterPane: 'wA:p1',
  });
  assert.equal(result.alreadyOpen, false);
  assert.ok(result.id);
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  assert.ok(item);
  assert.equal(item.kind, 'release-approval');
  assert.equal(item.action, 'approve');
  assert.equal(item.release.repo, 'example-org/example-app');
  assert.equal(item.release.tag, 'v1.0.0');
  assert.equal(item.requesterPane, 'wA:p1');
  assert.match(item.text, /Repository: example-org\/example-app/);
  assert.match(item.text, /Tag: v1\.0\.0/);
  assert.match(item.text, /## Changelog/);
  assert.match(item.text, /## Assets/);
  assert.match(item.text, /app\.tar\.gz/);
  assert.match(item.text, /## Scan result/);
  assert.match(item.text, /## Effect/);
  assert.match(item.text, /makes the release public/);
});

test('second request returns the same id', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'second-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const first = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  const second = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyOpen, true);
  const records = openMessageStore({ dir }).all();
  const items = records.filter((r) => r.kind === 'release-approval');
  assert.equal(items.length, 1);
});

test('scan blocks a token in notes and the item shows the scan result', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'scan-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'Release notes with token: ghp_abcdefghijklmnopqrstuvwxyz123456\n');
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    notesFile,
    run,
    dir,
    knownHosts,
  });
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  assert.match(item.text, /## Scan result/);
  assert.match(item.text, /Fail/);
  assert.match(item.text, /GitHub token/);
});

test('scan blocks a private path in notes', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'scan-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'Built by /Users/john/project\n');
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    notesFile,
    run,
    dir,
    knownHosts,
  });
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  assert.match(item.text, /private path/);
});

test('scan blocks a tenant host in notes', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'scan-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'Deployed to https://tenant.example.test/app\n');
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    notesFile,
    run,
    dir,
    knownHosts,
  });
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  assert.match(item.text, /tenant host/);
});

test('scan blocks an inline license token', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'scan-license-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, 'license: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo\n');
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    notesFile,
    run,
    dir,
    knownHosts,
  });
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  assert.match(item.text, /license blob/);
});

test('publish refuses when no approval item exists', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-no-approval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: 'm-nonexistent',
    run,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No approval item exists/);
});

test('publish refuses when approval is for another repo', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-wrong-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const request = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  const result = release.publishRelease({
    repo: 'other-org/other-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /another repository or tag/);
});

test('publish refuses when Owner has not answered', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-no-answer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const request = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.equal(result.waiting, true);
  assert.match(result.reason, /not answered/);
});

test('publish refuses when Owner denies', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-deny-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const request = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  // Owner denies
  openMessageStore({ dir }).append({
    id: 'm-deny',
    at: new Date(Date.now() + 1000).toISOString(),
    thread: 'boss',
    from: 'owner',
    to: 'orch',
    kind: 'message',
    text: 'Deny',
    replyTo: request.id,
    status: 'sent',
  });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /denied/);
  // The item is closed
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === request.id);
  assert.ok(item.closedAt);
});

test('publish refuses when checksum changes', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-checksum-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true, assets: [{ name: 'app.tar.gz', size: 1024, sha256: 'abc123' }] });
  const request = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  // Owner accepts
  openMessageStore({ dir }).append({
    id: 'm-accept',
    at: new Date(Date.now() + 1000).toISOString(),
    thread: 'boss',
    from: 'owner',
    to: 'orch',
    kind: 'message',
    text: 'Accept',
    replyTo: request.id,
    status: 'sent',
  });
  // Now change the asset checksum
  const run2 = fakeGhRunner({ draft: true, assets: [{ name: 'app.tar.gz', size: 1024, sha256: 'def456' }] });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run: run2,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /assets changed/);
});

test('publish refuses when release is not a draft', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-not-draft-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const request = release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  // Owner accepts
  openMessageStore({ dir }).append({
    id: 'm-accept',
    at: new Date(Date.now() + 1000).toISOString(),
    thread: 'boss',
    from: 'owner',
    to: 'orch',
    kind: 'message',
    text: 'Accept',
    replyTo: request.id,
    status: 'sent',
  });
  // Now the release is not a draft
  const run2 = fakeGhRunner({ draft: false });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run: run2,
    dir,
    knownHosts,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer a draft/);
});

test('publish succeeds and writes audit line and closes item', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'publish-success-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true, assets: [{ name: 'app.tar.gz', size: 1024, sha256: 'abc123' }] });
  const herdr = fakeHerdr();
  const request = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    run,
    dir,
    knownHosts,
    requesterPane: 'wA:p1',
  });
  // Owner accepts
  openMessageStore({ dir }).append({
    id: 'm-accept',
    at: new Date(Date.now() + 1000).toISOString(),
    thread: 'boss',
    from: 'owner',
    to: 'orch',
    kind: 'message',
    text: 'Accept',
    replyTo: request.id,
    status: 'sent',
  });
  const result = release.publishRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    approvalId: request.id,
    run,
    dir,
    knownHosts,
    herdr,
    who: 'wA:p1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.published, true);
  // Audit line written
  const auditFile = path.join(dir, 'releases', 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile));
  const auditLine = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim());
  assert.equal(auditLine.approvalId, request.id);
  assert.equal(auditLine.repo, 'example-org/example-app');
  assert.equal(auditLine.tag, 'v1.0.0');
  assert.equal(auditLine.action, 'publish');
  // Item closed
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === request.id);
  assert.ok(item.closedAt);
  assert.equal(item.closeNote, 'published');
  // Notice sent to requester pane
  assert.ok(herdr.prompts.some((p) => p.pane === 'wA:p1' && p.text.includes('published')));
});

test('no output holds an invented token-shaped string', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'no-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  const result = release.requestRelease({
    repo: 'example-org/example-app',
    tag: 'v1.0.0',
    run,
    dir,
    knownHosts,
  });
  const records = openMessageStore({ dir }).all();
  const item = records.find((r) => r.id === result.id);
  // The item text must not contain token-shaped strings
  const { scanTokenText } = await import('../scripts/docs-gate.js');
  const classes = scanTokenText(item.text);
  assert.deepEqual(classes, []);
});

test('repo not in releases.repos is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'repo-not-allowed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  assert.throws(() => release.requestRelease({
    repo: 'other-org/other-app',
    tag: 'v1.0.0',
    run,
    dir,
    knownHosts,
  }), /not in the releases\.repos setting/);
});

test('release status lists drafts, open requests and last published', (t) => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = fakeGhRunner({ draft: true });
  // Create an open request
  release.requestRelease({ repo: 'example-org/example-app', tag: 'v1.0.0', run, dir, knownHosts });
  const result = release.releaseStatus({ repo: 'example-org/example-app', run, dir });
  assert.ok(Array.isArray(result.drafts));
  assert.ok(Array.isArray(result.openRequests));
  assert.equal(result.openRequests.length, 1);
  assert.equal(result.openRequests[0].repo, 'example-org/example-app');
  assert.equal(result.openRequests[0].tag, 'v1.0.0');
});
