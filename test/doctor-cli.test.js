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
  if (String(file).startsWith(process.env.HERDR_BOSS_DIR) || String(file).startsWith(process.env.HOME + '/.config/herdr-boss')) throw new Error('doctor read private data');
  return originalRead(file, ...args);
};
os.platform = () => 'darwin';
os.totalmem = () => 16 * 1024 ** 3;
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
fsp.statfs = async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 });
fsp.lstat = async () => ({ isDirectory: () => green });
fsp.access = async () => {};
fsp.realpath = async (file) => file;
fsp.stat = async () => ({ isFile: () => true, size: 100 });
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
    run: (args, state, warnings = '') => spawnSync(process.execPath, ['--import', preload, CLI, ...args], {
      env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data, DOCTOR_FIXTURE: state, DOCTOR_WARNINGS: warnings },
      encoding: 'utf8', timeout: 15000,
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
