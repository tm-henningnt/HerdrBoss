import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// The data dir, home, and port are set before the modules load. No test touches ~/.herdr-boss.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-new-api-'));
const dataDir = path.join(root, 'data');
const homeDir = path.join(root, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const [{ serve }, { loadConfig }, { runProjectNew }, { runFlowInChild, createProjectNewApi, scrub }] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/project-new.js'),
  import('../src/project-new-api.js'),
]);

const group = path.join(root, 'group');
const repoRoot = path.join(root, 'boss-repo');
fs.mkdirSync(group);
fs.mkdirSync(repoRoot);

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const OUTSIDE = '/Users/someone/private/notes';

// Fake steps: no Git, no gh, no Herdr. `validate` stays real, so the folder and slug checks run.
let failStep = null;
let remoteDetail = null;
const fakeSteps = () => Object.fromEntries(['folder', 'files', 'kit', 'commit', 'policy', 'register', 'status', 'workspace', 'harness'].map((name) => [name, (inputs) => {
  if (failStep === name) throw new Error(`the ${name} step broke`);
  return `${name} done for ${inputs.slug}, token ${TOKEN}, log ${OUTSIDE}/log.txt, project ${inputs.path}/x`;
}]).concat([['remote', (_inputs, context) => {
  if (!remoteDetail) return { status: 'skipped', detail: 'skipped: --remote none' };
  context.remember({ remoteAsk: { id: remoteDetail, repo: 'o/r', visibility: 'private' } });
  return { status: 'waiting', detail: `waiting for an Owner decision: mailbox item ${remoteDetail}` };
}]]));

function flowOptions() {
  return { repoRoot, ceiling: root, home: homeDir, stepRunners: fakeSteps() };
}

let gates = [];
const calls = [];
let autoOpen = true;
// The injected flow runner: the real flow with fake steps. With autoOpen false, the run waits until the test opens its gate.
function runFlow(options) {
  calls.push(options);
  return new Promise((resolve, reject) => {
    const gate = { open: () => { try { resolve(runProjectNew({ ...options, ...flowOptions() })); } catch (error) { reject(error); } }, reject };
    gates.push(gate);
    if (autoOpen) gate.open();
  });
}

const collectorsEngine = (_config, actions = {}) => {
  const engine = new EventEmitter();
  engine.act = actions.act;
  engine.push = actions.push;
  engine.state = {};
  engine.tick = async () => engine.state;
  engine.log = () => {};
  return engine;
};

async function start(t, { readOnlyPreview = false } = {}) {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const app = serve(cfg, { readOnlyPreview, createEngine: collectorsEngine, projectNew: { runFlow, flowOptions: flowOptions() } });
  t.after(async () => { await app.close(); });
  await new Promise((resolve, reject) => { app.server.once('listening', resolve); app.server.once('error', reject); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, text, json };
  };
  return { call, base };
}

async function waitFor(condition, what) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reset() {
  gates = [];
  calls.length = 0;
  autoOpen = true;
  failStep = null;
  remoteDetail = null;
  fs.rmSync(path.join(dataDir, 'flows'), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'project-repos.json'), { force: true });
  fs.rmSync(group, { recursive: true, force: true });
  fs.mkdirSync(group);
}

const plan = (slug, extra = {}) => ({ slug, name: slug, group, ...extra });

test('the plan route returns the steps with would-text and writes nothing', async (t) => {
  reset();
  const { call } = await start(t);
  const before = fs.readdirSync(dataDir).sort();
  const response = await call('POST', '/api/project-new/plan', plan('demo', { goal: 'Build it' }));
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.dryRun, true);
  assert.equal(response.json.path, path.join(group, 'demo'));
  assert.deepEqual(response.json.steps.map((step) => step.name), ['validate', 'folder', 'files', 'kit', 'commit', 'remote', 'policy', 'register', 'status', 'workspace', 'harness', 'check']);
  assert.match(response.json.steps.find((step) => step.name === 'folder').detail, /^would run mkdir -p /);
  assert.equal(fs.existsSync(path.join(group, 'demo')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'flows')), false);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
  assert.equal(calls.length, 0);
});

test('the plan route refuses a bad slug, a bad path, an unknown field, and a wrong type with a 400', async (t) => {
  reset();
  const { call } = await start(t);
  for (const body of [
    { slug: 'Bad Slug', group },
    { slug: 'demo' },
    { slug: 'demo', group, path: path.join(root, 'x') },
    { slug: 'demo', group, name: '../evil' },
    { slug: 'demo', group, surprise: 1 },
    { slug: 'demo', group, start: 'yes' },
    { slug: 'demo', group, visibility: 'secret' },
    { slug: 'demo', group, kind: 'gpt' },
    { slug: 'demo', group, org: '-bad' },
    { slug: 'demo', group, visibility: 'public' },
    { slug: 'demo', group, remote: 'https://user:hunter2@example.com/o/r.git' },
    { slug: 'demo', group, remote: 'not a url' },
    { slug: 'demo', path: repoRoot },
    [],
    'text',
  ]) {
    const response = await call('POST', '/api/project-new/plan', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.ok, false);
    assert.equal(typeof response.json.error, 'string');
    assert.doesNotMatch(response.text, /hunter2/);
  }
});

test('start returns 202, runs in the background, and the status advances to done', async (t) => {
  reset();
  autoOpen = false;
  const { call } = await start(t);
  const started = await call('POST', '/api/project-new', plan('demo'));
  assert.equal(started.status, 202);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.slug, 'demo');
  assert.equal(started.json.url, '/api/project-new/demo');
  const running = await call('GET', '/api/project-new/demo');
  assert.equal(running.status, 200);
  assert.equal(running.json.state, 'running');
  assert.equal(running.json.running, true);
  assert.equal(running.json.exitCode, null);
  assert.equal(calls[0].start, false);
  assert.equal(calls[0].resume, false);
  gates[0].open();
  const done = await waitFor(async () => { const r = await call('GET', '/api/project-new/demo'); return r.json.state === 'done' ? r : null; }, 'the flow is done');
  assert.equal(done.json.exitCode, 0);
  assert.equal(done.json.running, false);
  assert.equal(done.json.path, path.join(group, 'demo'));
  assert.equal(done.json.steps.find((step) => step.name === 'folder').status, 'done');
  assert.equal(done.json.steps.find((step) => step.name === 'check').status, 'not-built');
  assert.equal(done.json.waiting, null);
  assert.ok(fs.existsSync(path.join(dataDir, 'flows', 'demo.json')));
});

test('start passes start true only when the body says start true', async (t) => {
  reset();
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/project-new', plan('one'))).status, 202);
  assert.equal((await call('POST', '/api/project-new', plan('two', { start: true }))).status, 202);
  await waitFor(() => calls.length === 2, 'two runs');
  assert.equal(calls.find((c) => c.slug === 'one').start, false);
  assert.equal(calls.find((c) => c.slug === 'two').start, true);
});

test('a second run of the same slug is refused while one runs, and at most 2 slugs run at once', async (t) => {
  reset();
  autoOpen = false;
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/project-new', plan('one'))).status, 202);
  const again = await call('POST', '/api/project-new', plan('one'));
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already running/);
  assert.equal((await call('POST', '/api/project-new', plan('two'))).status, 202);
  const third = await call('POST', '/api/project-new', plan('three'));
  assert.equal(third.status, 429);
  assert.equal(calls.length, 2);
  const resume = await call('POST', '/api/project-new/one/resume', {});
  assert.equal(resume.status, 409);
  gates[0].open();
  await waitFor(async () => (await call('GET', '/api/project-new/one')).json.state === 'done', 'one is done');
  assert.equal((await call('POST', '/api/project-new', plan('three'))).status, 202);
});

test('a failed step shows in the status, and resume continues at that step', async (t) => {
  reset();
  failStep = 'commit';
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/project-new', plan('demo'))).status, 202);
  const failed = await waitFor(async () => { const r = await call('GET', '/api/project-new/demo'); return r.json.state === 'failed' ? r : null; }, 'the flow failed');
  assert.equal(failed.json.exitCode, 1);
  assert.match(failed.json.error, /the commit step broke/);
  assert.equal(failed.json.steps.find((step) => step.name === 'commit').status, 'failed');
  assert.equal(failed.json.steps.find((step) => step.name === 'files').status, 'done');
  failStep = null;
  const resumed = await call('POST', '/api/project-new/demo/resume', {});
  assert.equal(resumed.status, 202);
  assert.equal(resumed.json.url, '/api/project-new/demo');
  await waitFor(async () => (await call('GET', '/api/project-new/demo')).json.state === 'done', 'the resumed flow is done');
  assert.equal(calls.at(-1).resume, true);
  assert.equal((await call('POST', '/api/project-new/unknown/resume', {})).status, 404);
});

test('a flow that waits for the Owner reports the decision item and exit status 3', async (t) => {
  reset();
  remoteDetail = 'msg-decide-1';
  const { call } = await start(t);
  const started = await call('POST', '/api/project-new', plan('demo', { remote: 'gh' }));
  assert.equal(started.status, 202);
  const waiting = await waitFor(async () => { const r = await call('GET', '/api/project-new/demo'); return r.json.state === 'waiting' ? r : null; }, 'the flow waits');
  assert.equal(waiting.json.exitCode, 3);
  assert.equal(waiting.json.waiting.reason, 'waiting for an Owner decision');
  assert.equal(waiting.json.waiting.item, 'msg-decide-1');
  assert.equal(waiting.json.steps.find((step) => step.name === 'remote').status, 'waiting');
  assert.equal(waiting.json.steps.find((step) => step.name === 'policy').status, 'pending');
  assert.equal(calls[0].remote, 'gh');
  // After the answer, resume finishes the flow.
  remoteDetail = null;
  assert.equal((await call('POST', '/api/project-new/demo/resume', { remote: 'gh' })).status, 202);
  await waitFor(async () => (await call('GET', '/api/project-new/demo')).json.state === 'done', 'done after the answer');
  assert.equal(calls.at(-1).remote, 'gh');
});

test('resume keeps the options of the first request when the body sends none', async (t) => {
  reset();
  failStep = 'files';
  const { call } = await start(t);
  await call('POST', '/api/project-new', plan('demo', { remote: 'gh', kind: 'codex', start: true, goal: 'Aim' }));
  await waitFor(async () => (await call('GET', '/api/project-new/demo')).json.state === 'failed', 'failed');
  failStep = null;
  await call('POST', '/api/project-new/demo/resume', {});
  await waitFor(() => calls.length === 2, 'the resume run');
  assert.equal(calls[1].remote, 'gh');
  assert.equal(calls[1].kind, 'codex');
  assert.equal(calls[1].start, true);
  assert.equal(calls[1].path, path.join(group, 'demo'));
  assert.equal(calls[1].goal, 'Aim');
});

test('a crash of the runner marks the step failed in the state file', async (t) => {
  reset();
  autoOpen = false;
  const { call } = await start(t);
  await call('POST', '/api/project-new', plan('demo'));
  // The flow saved the steps before kit, then the process died: the kit step has no record.
  runProjectNew({ ...calls[0], ...flowOptions(), stepRunners: { ...fakeSteps(), kit() { throw new Error('planted'); } } });
  const file = path.join(dataDir, 'flows', 'demo.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.steps.kit;
  fs.writeFileSync(file, JSON.stringify(saved));
  gates[0].reject(new Error('the runner exited with code 137'));
  const failed = await waitFor(async () => { const r = await call('GET', '/api/project-new/demo'); return r.json.state === 'failed' ? r : null; }, 'the crash shows');
  assert.match(failed.json.error, /exited with code 137/);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.steps.kit.status, 'failed');
  assert.match(state.steps.kit.detail, /exited with code 137/);
  assert.equal(state.steps.files.status, 'done');
  autoOpen = true;
  assert.equal((await call('POST', '/api/project-new', plan('demo'))).status, 202);
});

test('the status has no secret and no absolute path outside the project path', async (t) => {
  reset();
  const { call } = await start(t);
  await call('POST', '/api/project-new', plan('demo'));
  const done = await waitFor(async () => { const r = await call('GET', '/api/project-new/demo'); return r.json.state === 'done' ? r : null; }, 'done');
  const projectPath = path.join(group, 'demo');
  assert.match(done.text, new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(done.text, /ghp_/);
  assert.doesNotMatch(done.text, /someone\/private/);
  assert.doesNotMatch(done.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(data|home|boss-repo)'));
  const check = await call('GET', '/api/project-new/demo/check');
  assert.equal(check.status, 200);
  assert.doesNotMatch(check.text, /ghp_|someone\/private/);
  const planned = await call('POST', '/api/project-new/plan', plan('other'));
  assert.doesNotMatch(planned.text, /ghp_|someone\/private/);
  // The error of a state with other inputs names the state file. The path of the data dir does not leave the server.
  const errors = await call('POST', '/api/project-new/plan', plan('demo', { goal: 'Another goal' }));
  assert.equal(errors.status, 400);
  assert.match(errors.json.error, /different inputs/);
  assert.doesNotMatch(errors.text, /\/data\/flows|ghp_/);
});

test('the check route returns the read-only project check', async (t) => {
  reset();
  const { call } = await start(t);
  const before = fs.readdirSync(dataDir).sort();
  const response = await call('GET', '/api/project-new/unknown/check');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.slug, 'unknown');
  assert.ok(response.json.items.some((item) => item.name === 'folder' && item.ok === false));
  assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
  assert.equal((await call('GET', '/api/project-new/Bad_Slug/check')).status, 400);
});

test('the status of an unknown slug is a 404, and a bad route or method is refused', async (t) => {
  reset();
  const { call } = await start(t);
  assert.equal((await call('GET', '/api/project-new/nothing-here')).status, 404);
  assert.equal((await call('GET', '/api/project-new/Bad_Slug')).status, 400);
  assert.equal((await call('GET', '/api/project-new/a/b/c')).status, 404);
  assert.equal((await call('GET', '/api/project-new/demo/unknown')).status, 404);
  assert.equal((await call('DELETE', '/api/project-new/demo')).status, 405);
  assert.equal((await call('PUT', '/api/project-new')).status, 405);
  assert.equal((await call('GET', '/api/project-new')).status, 405);
});

test('a bad body is refused: invalid JSON, a wrong content type, and a body over the limit', async (t) => {
  reset();
  const { call, base } = await start(t);
  const bad = await call('POST', '/api/project-new', '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
  assert.equal((await call('POST', '/api/project-new/plan', '{not json')).status, 400);
  const text = await fetch(`${base}/api/project-new`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(plan('demo')) });
  assert.equal(text.status, 400);
  const big = await call('POST', '/api/project-new', JSON.stringify({ ...plan('demo'), goal: 'x'.repeat(40000) }));
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0);
});

test('the read-only preview refuses every project-new route, GET routes too', async (t) => {
  reset();
  const { call } = await start(t, { readOnlyPreview: true });
  const refusal = 'This read-only preview does not allow changes.';
  for (const [method, url, body] of [
    ['POST', '/api/project-new/plan', plan('demo')],
    ['POST', '/api/project-new', plan('demo')],
    ['GET', '/api/project-new/demo'],
    ['POST', '/api/project-new/demo/resume', {}],
    ['GET', '/api/project-new/demo/check'],
  ]) {
    const response = await call(method, url, body);
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.equal(response.json.error, refusal);
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'flows')), false);
});

test('the default runner runs the flow module in a child process and passes a refusal on', async () => {
  reset();
  const dry = await runFlowInChild({ slug: 'child', group, dataDir, dryRun: true, repoRoot, ceiling: root, home: homeDir });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.path, path.join(group, 'child'));
  assert.equal(fs.existsSync(path.join(group, 'child')), false);
  await assert.rejects(runFlowInChild({ slug: 'Bad Slug', group, dataDir, repoRoot }), /The slug must match/);
});

test('scrub removes every absolute path except the project path, also with spaces and one segment', () => {
  const project = '/work/group/demo';
  assert.equal(scrub(`open '/Users/Jane Doe/My Files/x.txt' failed`, project), `open '<path>' failed`);
  assert.equal(scrub('ENOENT: no such file or directory, mkdir /tmp', project), 'ENOENT: no such file or directory, mkdir <path>');
  assert.equal(scrub('cannot write /var/log/x.log now', project), 'cannot write <path> now');
  assert.equal(scrub(`kept ${project}/docs/a.md and ${project}`, project), `kept ${project}/docs/a.md and ${project}`);
  assert.equal(scrub('clone https://github.com/o/r.git', project), 'clone https://github.com/o/r.git');
  assert.equal(scrub(`token ${TOKEN}`, project), 'token [redacted]');
  assert.equal(scrub('see /Users/x/y', null), 'see <path>');
});

test('an unexpected error gives a 500 with a scrubbed message', async (t) => {
  reset();
  const { call } = await start(t);
  // A file where the flows folder belongs makes the state read fail with a path in the message.
  fs.writeFileSync(path.join(dataDir, 'flows'), 'not a folder');
  t.after(() => fs.rmSync(path.join(dataDir, 'flows'), { force: true }));
  for (const [method, url, body] of [['GET', '/api/project-new/demo'], ['POST', '/api/project-new', plan('demo')], ['POST', '/api/project-new/plan', plan('demo')]]) {
    const response = await call(method, url, body);
    assert.equal(response.status, 500, `${method} ${url}`);
    assert.equal(response.json.ok, false);
    assert.match(response.json.error, /ENOTDIR/);
    assert.doesNotMatch(response.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

function rawRequest(base, headers, body) {
  const url = new URL('/api/project-new/plan', base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the routes refuse a cross-site request with 403 and a request from another host without a token with 401', async (t) => {
  reset();
  const { base } = await start(t);
  const crossOrigin = await rawRequest(base, { origin: 'https://evil.example' }, plan('demo'));
  assert.equal(crossOrigin.status, 403);
  const crossSite = await rawRequest(base, { 'sec-fetch-site': 'cross-site' }, plan('demo'));
  assert.equal(crossSite.status, 403);
  // A Tailscale-style host name is not loopback, so the token is required.
  const noToken = await rawRequest(base, { host: 'dashboard.example.ts.net' }, plan('demo'));
  assert.equal(noToken.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'flows')), false);
  const local = await rawRequest(base, {}, plan('demo'));
  assert.equal(local.status, 200);
});

function directApi(runFlowFn) {
  return createProjectNewApi({ dataDir, runFlow: runFlowFn, flowOptions: flowOptions() });
}
const post = (api, url, body) => api.handle('POST', url, async () => body);

test('a run that a restart interrupted shows as interrupted, and resume clears it', async () => {
  reset();
  const first = directApi(() => new Promise(() => {}));
  assert.equal((await post(first, '/api/project-new', plan('demo'))).status, 202);
  assert.ok(fs.existsSync(path.join(dataDir, 'flows', 'demo.running')));
  // The steps before kit were saved. Then the service stopped.
  runProjectNew({ slug: 'demo', name: 'demo', group, dataDir, ...flowOptions(), stepRunners: { ...fakeSteps(), kit() { throw new Error('planted'); } } });
  const file = path.join(dataDir, 'flows', 'demo.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.steps.kit;
  fs.writeFileSync(file, JSON.stringify(saved));
  // A new instance with the same data dir has no run in memory.
  const second = directApi((options) => Promise.resolve(runProjectNew({ ...options, ...flowOptions() })));
  const interrupted = await second.handle('GET', '/api/project-new/demo');
  assert.equal(interrupted.status, 200);
  assert.equal(interrupted.body.state, 'interrupted');
  assert.equal(interrupted.body.running, false);
  assert.equal(interrupted.body.exitCode, 1);
  assert.match(interrupted.body.error, /interrupted/);
  assert.equal(interrupted.body.steps.find((step) => step.name === 'files').status, 'done');
  assert.equal((await post(second, '/api/project-new/demo/resume', {})).status, 202);
  await waitFor(() => second.stats().running === 0, 'the resumed run ends');
  const done = await second.handle('GET', '/api/project-new/demo');
  assert.equal(done.body.state, 'done');
  assert.equal(fs.existsSync(path.join(dataDir, 'flows', 'demo.running')), false);
});

test('a marker without state or run is also interrupted', async () => {
  reset();
  const first = directApi(() => new Promise(() => {}));
  await post(first, '/api/project-new', plan('early'));
  const second = directApi(async () => ({}));
  const status = await second.handle('GET', '/api/project-new/early');
  assert.equal(status.body.state, 'interrupted');
  assert.equal(status.body.path, path.join(group, 'early'));
});

test('the API keeps at most 20 finished runs in memory', async () => {
  reset();
  const api = directApi(async () => ({ ok: true }));
  for (let index = 0; index < 25; index += 1) {
    const slug = `run-${index}`;
    assert.equal((await post(api, '/api/project-new', plan(slug))).status, 202, slug);
    await waitFor(() => api.stats().running === 0, `${slug} ends`);
  }
  assert.ok(api.stats().tracked <= 20, `tracked ${api.stats().tracked}`);
  assert.equal(api.stats().running, 0);
});
