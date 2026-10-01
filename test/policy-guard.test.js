// The share guard of the policy write (PC1) and the policy change log (PC2). Temporary data dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-guard-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-guard-home-'));
process.env.HOME = homeDir;
process.env.HERDR_BOSS_DIR = dataDir;
process.env.HERDR_BOSS_PORT = '0';
const { assertTempDataDir } = await import('../src/data-dir-guard.js');
assertTempDataDir(dataDir);

const [{ serve }, { loadConfig, DATA_DIR }, control, log, { loadModels }, analytics] = await Promise.all([
  import('../src/server.js'),
  import('../src/config.js'),
  import('../src/control.js'),
  import('../src/policy-log.js'),
  import('../src/kit/config.js'),
  import('../src/analytics.js'),
]);
assert.equal(fs.realpathSync(DATA_DIR), fs.realpathSync(dataDir), 'the test writes only to its temporary data dir');
const { POLICY_DEFAULTS, savePolicy, loadPolicy, policyShareGuard, writePolicy } = control;
const models = loadModels();
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-policy-log-'));
  assertTempDataDir(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const entry = (share) => ({ share, mode: 'auto', excludedKinds: [], excludedModels: [] });
const projects = (shares) => Object.fromEntries(Object.entries(shares).map(([slug, share]) => [slug, entry(share)]));
const policyWith = (shares, patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), projects: projects(shares), ...patch });
const FIVE = { a: 20, b: 20, c: 20, d: 20, e: 20 };
const logFile = (dir) => path.join(dir, log.POLICY_CHANGES_FILE);
const logLines = (dir) => fs.readFileSync(logFile(dir), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function startServer(t, shares) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(policyWith(shares))}\n`);
  fs.rmSync(logFile(dataDir), { force: true });
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.port = 0;
  cfg.tickSeconds = 3600;
  const { server, close } = serve(cfg, {
    createEngine: () => {
      const engine = new EventEmitter();
      engine.state = { control: null, quotas: [] };
      engine.tick = async () => engine.state;
      engine.log = () => {};
      return engine;
    },
  });
  t.after(async () => { await close(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const put = (body, headers = {}) => fetch(`${base}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      resolve({ base, put });
    });
  });
}
const withShares = (shares, patch = {}) => ({ ...loadPolicy({ file: path.join(dataDir, 'policy.json'), models, warn: () => {} }), projects: projects(shares), ...patch });

test('PUT /api/policy rejects invalid lock lane and guard ranges with field messages', async (t) => {
  const { put } = await startServer(t, FIVE);
  const cases = [
    ['slots', 5, /locks\.slots must be an integer from 1 to 4/],
    ['shortLimitMinutes', 61, /locks\.shortLimitMinutes must be an integer from 1 to 60/],
    ['maxLoadPercent', 1001, /locks\.guard\.maxLoadPercent must be an integer from 0 to 1000/],
    ['maxSwapPercent', 101, /locks\.guard\.maxSwapPercent must be an integer from 0 to 100/],
    ['minFreeMemPercent', -1, /locks\.guard\.minFreeMemPercent must be an integer from 0 to 100/],
  ];
  for (const [key, value, expected] of cases) {
    const draft = withShares(FIVE);
    if (key === 'slots' || key === 'shortLimitMinutes') draft.locks[key] = value;
    else draft.locks.guard[key] = value;
    const response = await put(draft);
    assert.equal(response.status, 400, key);
    assert.match((await response.json()).errors.join(' '), expected, key);
  }
  assert.equal(loadPolicy().locks.slots, 2, 'rejected saves keep the defaults');
});

test('PUT /api/policy saves a change of one share with a total of 100', async (t) => {
  const { put } = await startServer(t, FIVE);
  const response = await put(withShares({ ...FIVE, a: 30, b: 10 }));
  assert.equal(response.status, 200, 'two shares');
  const one = await put(withShares({ a: 30, b: 15, c: 20, d: 20, e: 15 }));
  assert.equal(one.status, 200, 'two more shares');
  const single = await put(withShares({ a: 35, b: 10, c: 20, d: 20, e: 15 }));
  assert.equal(single.status, 200);
});

test('PUT /api/policy refuses a change of three shares unless confirmed is true', async (t) => {
  const { put } = await startServer(t, FIVE);
  const draft = withShares({ a: 10, b: 30, c: 30, d: 20, e: 10 });
  const refused = await put(draft);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /a 20 -> 10/);
  assert.match(body.error, /b 20 -> 30/);
  assert.match(body.error, /c 20 -> 30/);
  assert.match(body.error, /e 20 -> 10/);
  assert.doesNotMatch(body.error, /d 20/);
  assert.match(body.error, /"confirmed": true/);
  assert.equal(loadPolicy().projects.a.share, 20, 'the refused write changes nothing');
  assert.equal(fs.existsSync(logFile(dataDir)), false, 'a refusal logs nothing');
  const saved = await put({ ...draft, confirmed: true });
  assert.equal(saved.status, 200);
  assert.equal(loadPolicy().projects.a.share, 10);
  assert.equal('confirmed' in loadPolicy(), false, 'the flag is not stored');
});

test('PUT /api/policy refuses shares that do not total 100 unless allowSum is true', async (t) => {
  const { put } = await startServer(t, FIVE);
  const draft = withShares({ a: 20, b: 20, c: 20, d: 20, e: 19 });
  const refused = await put(draft);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /99.*"allowSum": true/s);
  assert.equal((await put({ ...draft, confirmed: true })).status, 409, 'confirmed does not allow the sum');
  const saved = await put({ ...draft, allowSum: true });
  assert.equal(saved.status, 200);
  assert.equal(loadPolicy().projects.e.share, 19);
  assert.equal('allowSum' in loadPolicy(), false);
});

test('PUT /api/policy refuses the incident of five shares 9, 36, 31, 13, 10 against 20 each', async (t) => {
  const { put } = await startServer(t, { alpha: 20, bravo: 20, charlie: 20, delta: 20, echo: 20 });
  const draft = withShares({ alpha: 9, bravo: 36, charlie: 31, delta: 13, echo: 10 });
  const refused = await put(draft);
  assert.equal(refused.status, 409);
  const { error } = await refused.json();
  for (const text of ['alpha 20 -> 9', 'bravo 20 -> 36', 'charlie 20 -> 31', 'delta 20 -> 13', 'echo 20 -> 10', '99', 'confirmed', 'allowSum']) assert.ok(error.includes(text), text);
  assert.equal(loadPolicy().projects.alpha.share, 20);
});

test('PUT /api/policy saves a request that changes no share, also when the saved total is not 100', async (t) => {
  const { put } = await startServer(t, { a: 20, b: 20, c: 20, d: 20, e: 19 });
  const draft = withShares({ a: 20, b: 20, c: 20, d: 20, e: 19 });
  draft.machine = { ...draft.machine, swapWarnPercent: 70 };
  const response = await put(draft);
  assert.equal(response.status, 200);
  assert.equal(loadPolicy().machine.swapWarnPercent, 70);
});

test('the policy guard counts a removed project and a new project as changes', () => {
  const old = policyWith(FIVE);
  const guard = policyShareGuard(old, policyWith({ a: 40, b: 30, c: 30 }), {});
  assert.deepEqual(guard.changed.map((c) => [c.slug, c.old, c.new]), [['a', 20, 40], ['b', 20, 30], ['c', 20, 30], ['d', 20, null], ['e', 20, null]]);
  assert.equal(policyShareGuard(old, old, {}), null);
  assert.equal(policyShareGuard(old, policyWith({ ...FIVE, a: 25, b: 15 }), {}), null);
  assert.equal(policyShareGuard(old, policyWith({ ...FIVE, a: 25, b: 15, c: 19, d: 21 }), { confirmed: true }), null);
});

test('every write appends one line with the caller kind and the changed keys', async (t) => {
  const { put } = await startServer(t, FIVE);
  const draft = withShares({ ...FIVE, a: 30, b: 10 });
  draft.machine = { ...draft.machine, swapWarnPercent: 70 };
  assert.equal((await put(draft, { 'x-herdr-boss-caller': 'page' })).status, 200);
  assert.equal((await put(withShares({ ...FIVE, a: 25, b: 15 }), { 'x-herdr-boss-caller': 'rogue' })).status, 200);
  assert.equal((await put(withShares({ ...FIVE, a: 20, b: 20 }))).status, 200);
  const lines = logLines(dataDir);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.caller), ['page', 'unknown', 'unknown']);
  assert.ok(Number.isFinite(Date.parse(lines[0].at)));
  const keys = Object.fromEntries(lines[0].changes.map((c) => [c.key, [c.old, c.new]]));
  assert.deepEqual(keys, { 'projects.a.share': [20, 30], 'projects.b.share': [20, 10], 'machine.swapWarnPercent': [80, 70] });
  assert.equal(fs.statSync(logFile(dataDir)).mode & 0o777, 0o600);
});

test('a write that changes nothing appends no line', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'policy.json');
  assert.deepEqual(savePolicy(policyWith(FIVE), models, { file, caller: 'cli' }), []);
  assert.equal(logLines(dir).length, 1, 'the first write has changes against an absent file');
  assert.deepEqual(savePolicy(policyWith(FIVE), models, { file, caller: 'cli' }), []);
  assert.equal(logLines(dir).length, 1, 'the same policy adds no line');
});

test('writePolicy logs arrays as changed, cuts long strings, and masks secret keys', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, `${JSON.stringify({ allowedKinds: ['codex'], note: 'x', apiToken: 'one', projects: {} })}\n`);
  writePolicy({ allowedKinds: ['codex', 'pi'], note: 'y'.repeat(200), apiToken: 'two', projects: { p: { share: 5, excludedKinds: ['pi'] } } }, { caller: 'page', dir });
  const [line] = logLines(dir);
  const by = Object.fromEntries(line.changes.map((c) => [c.key, c]));
  assert.deepEqual(by.allowedKinds, { key: 'allowedKinds', old: 'changed', new: 'changed' });
  assert.equal(by.note.old, 'x');
  assert.equal(by.note.new.length, 80);
  assert.deepEqual([by.apiToken.old, by.apiToken.new], ['changed', 'changed']);
  assert.deepEqual([by['projects.p.share'].old, by['projects.p.share'].new], [null, 5]);
  assert.doesNotMatch(fs.readFileSync(logFile(dir), 'utf8'), /"one"|"two"/);
  assert.equal(line.caller, 'page');
});

test('the caller kind accepts page, cli, project-new, and project new; anything else is unknown', () => {
  assert.equal(log.callerKind('page'), 'page');
  assert.equal(log.callerKind('cli'), 'cli');
  assert.equal(log.callerKind('project-new'), 'project-new');
  assert.equal(log.callerKind('project new'), 'project-new');
  for (const bad of [undefined, null, '', 'CLI', 'admin', 5, {}]) assert.equal(log.callerKind(bad), 'unknown');
});

test('the log keeps the last 500 lines and at most 256 KB', (t) => {
  const dir = tmp(t);
  const one = (n) => ({ at: new Date(1e12 + n * 1000).toISOString(), caller: 'cli', changes: [{ key: 'maxWorkers', old: n, new: n + 1 }] });
  for (let n = 0; n < 520; n++) log.appendPolicyChange(dir, one(n));
  let lines = logLines(dir);
  assert.equal(lines.length, 500);
  assert.equal(lines[0].changes[0].old, 20);
  assert.equal(lines.at(-1).changes[0].old, 519);
  const big = { at: new Date().toISOString(), caller: 'cli', changes: Array.from({ length: 120 }, (_, i) => ({ key: `projects.p${i}.note`, old: 'o'.repeat(80), new: 'n'.repeat(80) })) };
  for (let n = 0; n < 60; n++) log.appendPolicyChange(dir, big);
  assert.ok(fs.statSync(logFile(dir)).size <= 256 * 1024);
  lines = logLines(dir);
  assert.ok(lines.length < 500);
  assert.deepEqual(lines.at(-1).changes.length, 120, 'the newest line stays whole');
  assert.equal(fs.statSync(logFile(dir)).mode & 0o777, 0o600);
});

test('the log reader skips broken lines, never throws, and returns the last 100 newest first', (t) => {
  const dir = tmp(t);
  assert.deepEqual(log.readPolicyChanges(dir), [], 'no file');
  const good = (n) => JSON.stringify({ at: new Date(1e12 + n * 1000).toISOString(), caller: 'page', changes: [{ key: 'maxWorkers', old: n, new: n + 1 }] });
  const rows = [good(0), '{broken', 'null', '[]', JSON.stringify({ at: 'x', caller: 'page', changes: [] }), JSON.stringify({ at: new Date().toISOString(), caller: 'page', changes: 'no' }), JSON.stringify({ at: new Date(1e12).toISOString(), caller: 'root', changes: [{ key: 'k', old: { a: 1 }, new: 2 }] }), good(1)];
  fs.writeFileSync(logFile(dir), `${rows.join('\n')}\n`);
  const read = log.readPolicyChanges(dir);
  assert.equal(read.length, 3);
  assert.deepEqual(read.map((r) => r.caller), ['page', 'unknown', 'page']);
  assert.deepEqual(read[1].changes, [{ key: 'k', old: 'changed', new: 2 }]);
  fs.writeFileSync(logFile(dir), Array.from({ length: 150 }, (_, n) => good(n)).join('\n'));
  const last = log.readPolicyChanges(dir);
  assert.equal(last.length, 100);
  assert.equal(last[0].changes[0].old, 149);
  assert.equal(log.readPolicyChanges(path.join(dir, 'missing')).length, 0);
});

test('the analytics summary carries the policy changes', (t) => {
  const dir = tmp(t);
  log.appendPolicyChange(dir, { at: new Date().toISOString(), caller: 'cli', changes: [{ key: 'maxWorkers', old: 8, new: 9 }] });
  const summary = analytics.analyticsSummary({ dataDir: dir });
  assert.equal(summary.policyChanges.length, 1);
  assert.equal(summary.policyChanges[0].caller, 'cli');
  assert.deepEqual(analytics.analyticsSummary({ dataDir: tmp(t) }).policyChanges, []);
});

test('policy set refuses a change of three shares and a total other than 100, and the flags allow them', (t) => {
  const dir = tmp(t);
  const home = tmp(t);
  fs.writeFileSync(path.join(dir, 'policy.json'), `${JSON.stringify(policyWith(FIVE))}\n`);
  const env = { PATH: process.env.PATH, HOME: home, HERDR_BOSS_DIR: dir };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8' });
  const draft = path.join(home, 'draft.json');
  fs.writeFileSync(draft, JSON.stringify(policyWith({ a: 9, b: 36, c: 31, d: 13, e: 10 })));
  const refused = cli('policy', 'set', draft);
  assert.notEqual(refused.status, 0);
  const text = `${refused.stderr}${refused.stdout}`;
  for (const part of ['a 20 -> 9', 'b 20 -> 36', 'e 20 -> 10', '--confirmed', '--allow-sum']) assert.ok(text.includes(part), part);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')).projects.a.share, 20);
  assert.notEqual(cli('policy', 'set', draft, '--confirmed').status, 0, 'the sum still needs --allow-sum');
  const saved = cli('policy', 'set', draft, '--confirmed', '--allow-sum');
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')).projects.a.share, 9);
  assert.deepEqual(logLines(dir).map((l) => l.caller), ['cli']);
  assert.ok(logLines(dir)[0].changes.some((c) => c.key === 'projects.a.share' && c.old === 20 && c.new === 9));
  const small = path.join(home, 'small.json');
  fs.writeFileSync(small, JSON.stringify(policyWith({ a: 10, b: 36, c: 31, d: 13, e: 10 })));
  assert.equal(cli('policy', 'set', small).status, 0, 'one share changed, total 100');
});

test('the page labels its policy writes and sends the flags only after a confirmation', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const POLICY_PUT_HEADERS = \{ 'content-type': 'application\/json', 'x-herdr-boss-caller': 'page' \}/);
  assert.equal((app.match(/fetch\('\/api\/policy', \{ method: 'PUT', headers: POLICY_PUT_HEADERS/g) || []).length, 2, 'both policy writes of the page carry the label');
  assert.doesNotMatch(app, /fetch\('\/api\/policy', \{ method: 'PUT', headers: \{/);
  assert.match(app, /const confirmed = check\.action === 'confirm';\n\s*if \(confirmed && !window\.confirm\(confirmText\(check\.rows\)\)\)/);
  assert.match(app, /if \(check\.confirmSum && !window\.confirm\(sumConfirmText\(total\)\)\)/);
  assert.match(app, /\.\.\.\(confirmed \? \{ confirmed: true \} : \{\}\), \.\.\.\(check\.confirmSum \? \{ allowSum: true \} : \{\}\)/);
});

test('a policy write with a body that is not a JSON object is a 400', async (t) => {
  const { base } = await startServer(t, FIVE);
  for (const body of ['null', '[]', '5', '"x"']) {
    const response = await fetch(`${base}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).error, 'The body must be a JSON object.');
  }
});

test('the log cuts keys at 120 characters on write and masks a secret word anywhere in the path', (t) => {
  const dir = tmp(t);
  const long = 'x'.repeat(200);
  const changes = log.diffPolicy({}, { projects: { [long]: { share: 1 } }, apiToken: { nested: 'a' }, auth: { Authorization: 'b' }, credentials: { user: 'c' }, cfg: { API_KEY: 'd', 'api key': 'e', password: { p: 'f' } }, plain: 'g' });
  for (const c of changes) assert.ok(c.key.length <= 120, c.key.length);
  const by = Object.fromEntries(changes.map((c) => [c.key, c]));
  for (const key of ['apiToken.nested', 'auth.Authorization', 'credentials.user', 'cfg.API_KEY', 'cfg.api key', 'cfg.password.p']) assert.deepEqual([by[key].old, by[key].new], [null, 'changed'], key);
  assert.equal(by.plain.new, 'g');
  log.appendPolicyChange(dir, { caller: 'cli', changes: [{ key: long, old: 1, new: 2 }] });
  assert.equal(logLines(dir)[0].changes[0].key.length, 120);
  assert.equal(fs.existsSync(`${logFile(dir)}.lock`), false, 'the lock is released');
});

test('the page imports every name that it uses from the helper modules it imports', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const name of ['allocation-draft', 'analytics']) {
    const source = fs.readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8');
    const exported = new Set([...source.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]));
    const line = app.match(new RegExp(`^import \\{([^}]*)\\} from './${name}\\.js';`, 'm'));
    assert.ok(line, `${name} import`);
    const imported = line[1].split(',').map((x) => x.trim()).filter(Boolean);
    for (const item of imported) assert.ok(exported.has(item), `${item} is exported by ${name}.js`);
    const body = app.replace(line[0], '');
    for (const item of exported) {
      if (new RegExp(`(?<![A-Za-z0-9_$.])${item}\\(`).test(body)) assert.ok(imported.includes(item), `app.js uses ${item} from ${name}.js but does not import it`);
    }
  }
});
