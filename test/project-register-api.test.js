import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRegisterApi } from '../src/project-register-api.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-register-api-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const record = {
    slug: 'pine-api', title: 'Pine API', group: 'platform', clientTag: 'Example Client',
    repo: '/tmp/private-project-path', remote: 'example/pine-api', factory: 'factory-zero',
    state: 'parked', pinned: false, priority: 'high', issueSource: { repo: 'example/pine-api', label: 'ready-for-agent' },
    autoOpen: 'off', lastOpenedAt: '', lastActivityAt: '2026-10-08T12:00:00.000Z', nextAction: 'Review sample flow',
    notes: 'Internal sample note', createdAt: '2026-10-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects: [record] })}\n`, { mode: 0o600 });
  return { dataDir, record };
}

test('project register API returns display and issue-triage fields without repository paths or notes', async (t) => {
  const { dataDir } = fixture(t);
  const api = createProjectRegisterApi({ dataDir, readOnly: true });
  const response = await api.handle('GET', '/api/project-register');
  assert.equal(response.status, 200);
  assert.equal(response.body.readOnly, true);
  assert.deepEqual(response.body.projects[0], {
    slug: 'pine-api', title: 'Pine API', group: 'platform', clientTag: 'Example Client', factory: 'factory-zero',
    state: 'parked', pinned: false, priority: 'high', lastOpenedAt: '', lastActivityAt: '2026-10-08T12:00:00.000Z',
    nextAction: 'Review sample flow', createdAt: '2026-10-01T00:00:00.000Z',
    issueSource: { repo: 'example/pine-api', label: 'ready-for-agent' }, autoOpen: 'off',
  });
  assert.doesNotMatch(JSON.stringify(response.body), /private-project-path|Internal sample note/);
});

test('project register API starts a project through the shared lifecycle action', async (t) => {
  const { dataDir } = fixture(t);
  const calls = [];
  const api = createProjectRegisterApi({ dataDir, runLifecycle: async (...args) => { calls.push(args); return 0; } });
  const response = await api.handle('POST', '/api/project-register/pine-api/action', { action: 'open' });
  assert.deepEqual(calls, [['open', ['pine-api', '--start']]]);
  assert.deepEqual(response, { status: 200, body: { ok: true, action: 'open', slug: 'pine-api' } });
});

test('project register API shows policy-only projects and adds them through the register add path', async (t) => {
  const { dataDir } = fixture(t);
  const addCalls = [];
  const api = createProjectRegisterApi({
    dataDir,
    policyProjects: () => ['north-star'],
    runRegisterAdd: async (slug) => { addCalls.push(slug); return 0; },
  });

  const listed = await api.handle('GET', '/api/project-register');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.projects.find((project) => project.slug === 'north-star'), {
    slug: 'north-star', title: 'north-star', state: 'policy-only', registered: false, inPolicy: true,
  });
  const added = await api.handle('POST', '/api/project-register/north-star/action', { action: 'add' });
  assert.deepEqual(addCalls, ['north-star']);
  assert.deepEqual(added, { status: 200, body: { ok: true, action: 'add', slug: 'north-star' } });
});

test('project register API refuses mutation in preview and validates action bodies', async (t) => {
  const { dataDir } = fixture(t);
  let calls = 0;
  const api = createProjectRegisterApi({ dataDir, readOnly: true, runLifecycle: async () => { calls += 1; } });
  assert.equal((await api.handle('POST', '/api/project-register/pine-api/action', { action: 'park' })).status, 403);
  const writeApi = createProjectRegisterApi({ dataDir, runLifecycle: async () => { calls += 1; return 0; } });
  assert.equal((await writeApi.handle('POST', '/api/project-register/pine-api/action', { action: 'drop' })).status, 400);
  assert.equal((await writeApi.handle('POST', '/api/project-register/%2e%2e/action', { action: 'open' })).status, 400);
  assert.equal(calls, 0);
});

test('project register API pins only an open project and writes an owner-page audit entry', async (t) => {
  const { dataDir, record } = fixture(t);
  record.state = 'open';
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects: [record] })}\n`, { mode: 0o600 });
  const api = createProjectRegisterApi({ dataDir });
  const response = await api.handle('POST', '/api/project-register/pine-api/action', { action: 'pin' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'project-register.json'), 'utf8')).projects[0].pinned, true);
  const audit = fs.readFileSync(path.join(dataDir, 'project-audit.jsonl'), 'utf8');
  assert.match(audit, /"by":"owner-page"/);
  assert.doesNotMatch(audit, /private-project-path|example\/pine-api/);
});

test('project register API rolls back a pin when the audit write fails', async (t) => {
  const { dataDir, record } = fixture(t);
  record.state = 'open';
  fs.writeFileSync(path.join(dataDir, 'project-register.json'), `${JSON.stringify({ version: 1, projects: [record] })}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(dataDir, 'project-audit.jsonl'));
  const api = createProjectRegisterApi({ dataDir });

  const response = await api.handle('POST', '/api/project-register/pine-api/action', { action: 'pin' });

  assert.equal(response.status, 500);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'project-register.json'), 'utf8')).projects[0].pinned, false);
});

test('project register API routes typed Mailbox Accept and Deny decisions', async (t) => {
  const { dataDir } = fixture(t);
  const calls = [];
  const api = createProjectRegisterApi({
    dataDir,
    runTriageDecision: async (...args) => { calls.push(args); return { status: 200, decision: args[1], slug: 'pine-api' }; },
  });
  assert.deepEqual(await api.handle('POST', '/api/project-register/triage/m-abc-12345678', { decision: 'accept' }), {
    status: 200, body: { ok: true, decision: 'accept', slug: 'pine-api' },
  });
  assert.deepEqual(calls, [['m-abc-12345678', 'accept']]);
  assert.equal((await api.handle('POST', '/api/project-register/triage/m-abc-12345678', { decision: 'open' })).status, 400);
  assert.equal((await api.handle('POST', '/api/project-register/triage/m-abc-12345678', { decision: 'deny' })).status, 200);
});

test('project register API refuses triage decisions in preview mode', async (t) => {
  const { dataDir } = fixture(t);
  const api = createProjectRegisterApi({ dataDir, readOnly: true, runTriageDecision: async () => ({ status: 200 }) });
  assert.equal((await api.handle('POST', '/api/project-register/triage/m-abc-12345678', { decision: 'accept' })).status, 403);
});
