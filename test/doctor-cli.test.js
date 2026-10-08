import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'uncreated-data');
  const preload = path.join(home, 'fake-probes.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const write = () => { throw new Error('doctor attempted a write'); };
for (const name of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'chmodSync', 'chownSync']) fs[name] = write;
for (const name of ['mkdir', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'chmod', 'chown']) fsp[name] = write;
const originalRead = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  const allowedToolsState = process.env.HERDR_BOSS_DIR + '/tools-state.json';
  if ((String(file).startsWith(process.env.HERDR_BOSS_DIR) && String(file) !== allowedToolsState) || String(file).startsWith(process.env.HOME + '/.config/herdr-boss')) throw new Error('doctor read private data');
  return originalRead(file, ...args);
};
os.platform = () => 'darwin';
os.totalmem = () => 16 * 1024 ** 3;
process.getuid = () => Number(process.env.DOCTOR_TEST_UID || 501);
if (process.env.DOCTOR_KEEP_ALIVE) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => { setTimeout(() => write(...args), 25); return true; };
  setInterval(() => {}, 60000);
}
const green = process.env.DOCTOR_FIXTURE === 'green';
cp.execFile = (command, args, options, callback) => {
  const values = {
    node: 'v26.10.0', git: args[0] === 'config' ? 'Invented Owner' : 'git version 2.50.0', herdr: 'herdr 1.0',
    claude: args[0] === 'auth' ? '{"loggedIn":true}' : '2.0', codex: args[0] === 'login' ? 'Logged in using ChatGPT' : '1.0',
    opencode: args[0] === 'auth' ? '1 credentials' : '1.0', pi: args[0] === '--list-models' ? 'provider model\\nanthropic claude' : '1.0',
    gh: 'gh version 2.0', codexbar: args[0] === 'usage' ? '[{"provider":"claude","usage":{"primary":{"usedPercent":10}}}]' : '1.0',
    launchctl: 'state = running'
  };
  queueMicrotask(() => green ? callback(null, values[command] ?? '', process.env.DOCTOR_WARNINGS ? 'invented tool warning' : '') : callback(Object.assign(new Error('fake unavailable'), { code: 'ENOENT' }), '', ''));
};
cp.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  for (const stream of [child.stdout, child.stderr]) { stream.setEncoding = () => {}; stream.destroy = () => {}; }
  child.kill = () => {};
  child.unref = () => {};
  cp.execFile(command, args, options, (error, stdout, stderr) => {
    if (command === 'launchctl' && process.getuid() === 0) error = new Error('fake gui/0 unavailable');
    child.stdout.emit('data', stdout);
    child.stderr.emit('data', stderr);
    child.emit('exit', error ? 1 : 0, null);
    child.emit('close', error ? 1 : 0, null);
  });
  return child;
};
fsp.statfs = async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 });
fsp.lstat = async () => ({ isDirectory: () => green });
fsp.access = async () => {};
fsp.realpath = async (file) => file;
fsp.stat = async () => ({ isFile: () => true, isDirectory: () => green, size: 100 });
fsp.readFile = async (file) => {
  if (!green) throw Object.assign(new Error('fake missing'), { code: 'ENOENT' });
  if (file.endsWith('/.claude/settings.json')) return JSON.stringify({ autoMode: { environment: ['### Herdr Boss orchestration','**Supervisor**','**Messages from the supervisor**','**Herdr Boss projects**','**Owner decisions**'], allow: ['$defaults','A Herdr Boss orchestrator pushes','A Herdr Boss orchestrator removes','A Herdr Boss orchestrator or the Boss records','The HerdrBoss orchestrator and its workers edit'] }});
  if (file.endsWith('/.codex/config.toml')) return '[sandbox_workspace_write]\\nwritable_roots = [' + JSON.stringify(process.env.HOME + '/.herdr-boss') + ',' + JSON.stringify(process.env.HOME + '/Projects/.herdr-wt') + ']';
  if (file.endsWith('/.codex/rules/herdr.rules')) return ['ps:e','ps:-E','ps:eww','ps:auxe','ps:auxeww','pkill','killall'].map((rule) => 'prefix_rule(pattern=' + JSON.stringify(rule.split(':')) + ', decision="forbidden")').join('\\n');
  if (file.endsWith('/.config/opencode/opencode.json')) return '{"agent":{"worker":{}}}';
  throw new Error('unexpected settings read');
};
http.get = (_options, callback) => {
  const req = new EventEmitter();
  req.destroy = (error) => req.emit('error', error);
  queueMicrotask(() => {
    if (!green) return req.emit('error', new Error('fake offline'));
    const res = new EventEmitter();
    res.setEncoding = () => {};
    res.statusCode = 200;
    callback(res);
    res.emit('data', '{"schema":1,"contractVersion":"1.0.0","version":"0.1.0","kitRevision":"abcdef123456"}');
    res.emit('end');
  });
  return req;
};
syncBuiltinESMExports();
`);
  return {
    home, data,
    run: (args, state, warnings = '', { keepAlive = '', uid = 501 } = {}) => spawnSync(process.execPath, ['--import', preload, CLI, ...args], {
      env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, DOCTOR_FIXTURE: state, DOCTOR_WARNINGS: warnings, DOCTOR_KEEP_ALIVE: keepAlive, DOCTOR_TEST_UID: String(uid) },
      encoding: 'utf8', timeout: keepAlive ? 3000 : 15000,
    }),
  };
}

for (const [state, exitCode] of [['green', 0], ['red', 4]]) {
  test(`the CLI doctor exits ${exitCode} for ${state} probes without loading or creating data`, (t) => {
    const f = fixture(t);
    const before = fs.readdirSync(f.home);
    const result = f.run(['doctor', '--json'], state);
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, 'herdr-boss.doctor/1');
    assert.equal(report.ok, state === 'green');
    assert.equal(report.exitCode, exitCode);
    assert.equal(report.items.length, 25);
    assert.equal(fs.existsSync(f.data), false);
    assert.deepEqual(fs.readdirSync(f.home), before);
    assert.ok(!result.stdout.includes(f.home));
  });
}

test('the CLI rejects doctor options without echoing their values or writing data', (t) => {
  const f = fixture(t);
  const result = f.run(['doctor', '--private=192.0.2.1'], 'green');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Usage: doctor [--json] [--factory-host]');
  assert.equal(fs.existsSync(f.data), false);
});

test('the CLI accepts valid JSON probes when tools also print warnings to stderr', (t) => {
  const f = fixture(t);
  const result = f.run(['doctor', '--json'], 'green', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.ok(!result.stdout.includes('invented tool warning'));
});

test('the CLI flushes its full report and exits even when a probe leaves an event-loop handle', (t) => {
  const f = fixture(t);
  const result = f.run(['doctor', '--json'], 'green', '', { keepAlive: '1' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).items.length, 25);
});

test('a failed sudo service probe says gui/0 and instructs the user to rerun without sudo', (t) => {
  const f = fixture(t);
  const result = f.run(['doctor', '--json'], 'green', '', { uid: 0 });
  assert.equal(result.status, 4, result.stderr);
  const service = JSON.parse(result.stdout).items.find((item) => item.id === 'service');
  assert.match(service.fix, /without sudo/);
  assert.match(service.fix, /gui\/0/);
});

test('doctor prints late tools as notes and security releases as failures', (t) => {
  const late = fixture(t);
  fs.mkdirSync(late.data);
  fs.writeFileSync(path.join(late.data, 'tools-state.json'), JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    tools: [{ id: 'opencode', name: 'OpenCode', trackedVersion: '1.18.34', latest: '1.18.35', ageDays: 17, risk: 'late' }],
  }));
  const lateResult = late.run(['doctor'], 'green');
  assert.equal(lateResult.status, 0, lateResult.stderr);
  assert.match(lateResult.stdout, /note: OpenCode update: installed 1\.18\.34, latest 1\.18\.35, 17 days\./);

  const security = fixture(t);
  fs.mkdirSync(security.data);
  fs.writeFileSync(path.join(security.data, 'tools-state.json'), JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    tools: [{ id: 'gh', name: 'GitHub CLI', trackedVersion: '2.101.0', latest: '2.102.0', ageDays: 2, risk: 'security' }],
  }));
  const securityResult = security.run(['doctor', '--json'], 'green');
  assert.equal(securityResult.status, 4, securityResult.stderr);
  const report = JSON.parse(securityResult.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 4);
  assert.equal(report.toolUpdates[0].line, 'error: GitHub CLI update: installed 2.101.0, latest 2.102.0, 2 days.');
});

test('doctor reports a stale security check as a note and keeps exit code zero', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.data);
  fs.writeFileSync(path.join(f.data, 'tools-state.json'), JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    tools: [{ id: 'gh', name: 'GitHub CLI', trackedVersion: '2.101.0', latest: '2.102.0', ageDays: 2, risk: 'security' }],
  }));

  const result = f.run(['doctor'], 'green');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /note: tool check is stale, run herdr-boss tools check\./);
  assert.doesNotMatch(result.stdout, /error: GitHub CLI update/);
});
