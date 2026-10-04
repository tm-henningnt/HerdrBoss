import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t, { green = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  const preload = path.join(home, 'probes.mjs');
  fs.writeFileSync(preload, `
import os from 'node:os';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
os.platform = () => 'darwin';
os.totalmem = () => 16 * 1024 ** 3;
fs.statfs = async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 });
cp.spawn = (command, args) => {
  const child = new EventEmitter();
  for (const name of ['stdout', 'stderr']) {
    child[name] = new EventEmitter();
    child[name].setEncoding = () => {};
    child[name].destroy = () => {};
  }
  child.unref = () => {};
  queueMicrotask(() => {
    if (!process.env.SETUP_GREEN) return child.emit('error', new Error('invented private probe error'));
    const values = {
      node: 'v26.10.0', git: args[0] === 'config' ? 'Invented Owner' : 'git version 2.50.0', herdr: '1.0',
      claude: args[0] === 'auth' ? '{"loggedIn":true}' : '2.0', codex: args[0] === 'login' ? 'Logged in using ChatGPT' : '1.0',
      opencode: args[0] === 'auth' ? '1 credentials' : '1.0', pi: args[0] === '--list-models' ? 'provider model\\nanthropic claude' : '1.0',
      gh: 'gh version 2.0', codexbar: args[0] === 'usage' ? '[{"provider":"claude","usage":{"primary":{"usedPercent":10}}}]' : '1.0',
      launchctl: 'state = running',
    };
    child.stdout.emit('data', values[command] ?? '');
    child.emit('close', 0);
  });
  return child;
};
cp.execFileSync = () => { throw new Error('setup must not run a write command without consent'); };
http.get = (_options, callback) => {
  const req = new EventEmitter();
  req.destroy = (error) => req.emit('error', error);
  queueMicrotask(() => {
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
  const env = { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[key];
  if (green) {
    env.SETUP_GREEN = '1';
    const write = (file, content) => {
      const target = path.join(home, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write('.claude/settings.json', JSON.stringify({ autoMode: {
      environment: ['### Herdr Boss orchestration', '**Supervisor**', '**Messages from the supervisor**', '**Herdr Boss projects**', '**Owner decisions**'],
      allow: ['$defaults', 'A Herdr Boss orchestrator pushes', 'A Herdr Boss orchestrator removes', 'A Herdr Boss orchestrator or the Boss records', 'The HerdrBoss orchestrator and its workers edit'],
    } }));
    write('.codex/config.toml', `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([path.join(home, '.herdr-boss'), path.join(home, 'Projects/.herdr-wt')])}`);
    write('.codex/rules/herdr.rules', ['ps:e', 'ps:-E', 'ps:eww', 'ps:auxe', 'ps:auxeww', 'pkill', 'killall'].map((rule) => `prefix_rule(pattern=${JSON.stringify(rule.split(':'))}, decision="forbidden")`).join('\n'));
    write('.config/opencode/opencode.json', '{"agent":{"worker":{}}}');
    const repo = path.join(home, 'InventedProject');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write('data/project-repos.json', JSON.stringify([{ slug: 'invented', repo }]));
    write('data/projects/invented.json', '{"slug":"invented"}');
    write('data/policy.json', '{"providerModes":{"claude":"managed"}}');
    write('data/setup.json', '{"schema":"herdr-boss.setup/1","steps":{},"pacing":"paced","dashboardOpened":true,"answer":true,"review":true}');
  } else delete env.SETUP_GREEN;
  const run = (...args) => spawnSync(process.execPath, ['--import', preload, CLI, 'setup', ...args], { env, encoding: 'utf8', timeout: 10000 });
  return { home, data, run };
}

test('fresh CLI setup stops at tools with exit 3 and stores only named progress', (t) => {
  const { data, home, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /Install the missing tools/);
  assert.match(result.stdout, /brew install node/);
  assert.match(result.stdout, /herdr-boss setup --resume/);
  assert.ok(!result.stdout.includes(home));
  assert.ok(!result.stdout.includes('invented private probe error'));
  assert.deepEqual(fs.readdirSync(data), ['setup.json']);
  const state = JSON.parse(fs.readFileSync(path.join(data, 'setup.json')));
  assert.equal(state.steps.check.status, 'done');
  assert.equal(state.steps.tools.status, 'waiting');
  const resumed = run('--resume');
  assert.equal(resumed.status, 3, resumed.stderr);
});

test('a finished fixture exits 0 at the real CLI boundary without repeating actions', (t) => {
  const { data, run } = fixture(t, { green: true });
  const result = run('--resume');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Setup is complete\. All steps passed/);
  const state = JSON.parse(fs.readFileSync(path.join(data, 'setup.json')));
  assert.equal(Object.values(state.steps).filter((step) => step.status === 'done').length, 11);
  assert.equal(fs.existsSync(path.join(data, 'config.json')), false);
});

test('CLI dry run and invalid arguments leave the fixture unchanged before config startup', (t) => {
  const { data, run } = fixture(t);
  const result = run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Review your first pack/);
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.existsSync(data), false);
  for (const args of [['--unknown=private-value'], ['--resume', '--resume']]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage: setup/);
    assert.ok(!invalid.stderr.includes('private-value'));
    assert.equal(fs.existsSync(data), false);
  }
});
