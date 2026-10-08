import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createDoctorRunner, runDoctor } from '../src/doctor.js';
import { installService } from '../src/install.js';

const fakeSupervisor = `#!/bin/sh
case "$0" in */launchctl) name=launchctl;; *) name=systemctl;; esac
operation=$1
if [ "$name" = systemctl ] && [ "$1" = --user ]; then operation=$2; fi
printf '%s\\t%s\\n' "$name" "$*" >> "$SUPERVISOR_LOG"
if [ "$SUPERVISOR_FAIL" = "$name:$operation" ]; then exit 1; fi
if [ "$name" = launchctl ] && [ "$operation" = print ]; then printf 'state = running\\n'; fi
if [ "$name" = systemctl ] && [ "$operation" = is-active ]; then printf 'active\\n'; fi
`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-contract-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'boss-data');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'supervisor.jsonl');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(bin);
  for (const command of ['launchctl', 'systemctl']) {
    const file = path.join(bin, command);
    fs.writeFileSync(file, fakeSupervisor, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  const env = {
    HOME: home,
    HERDR_BOSS_DIR: dataDir,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
    SUPERVISOR_LOG: log,
    SUPERVISOR_FAIL: '',
  };
  return { root, home, dataDir, bin, log, env };
}

function calls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const [name, ...args] = line.split('\t');
    return { name, args: args.join('\t').split(' ') };
  });
}

for (const { platform, command, operation, restart } of [
  { platform: 'darwin', command: 'launchctl', operation: 'bootstrap', restart: 'bootout/bootstrap' },
  { platform: 'linux', command: 'systemctl', operation: 'restart', restart: 'systemctl --user restart herdr-boss.service' },
]) {
  test(`${platform} install uses the fake ${command} command and applies its restart path`, (t) => {
    const f = fixture(t);
    const result = installService({
      platform,
      home: f.home,
      root: f.root,
      entry: path.join(f.root, 'src', 'cli.js'),
      dataDir: f.dataDir,
      defaultDataDir: path.join(f.home, '.herdr-boss'),
      execPath: process.execPath,
      uid: 501,
      exec: (name, argv) => execFileSync(name, argv, { env: f.env, encoding: 'utf8' }),
    });
    assert.ok(fs.existsSync(result.file));
    const seen = calls(f.log);
    assert.equal(seen.every((call) => call.name === command), true);
    if (platform === 'darwin') assert.deepEqual(seen.map((call) => call.args[0]), ['bootout', 'bootstrap']);
    else assert.deepEqual(seen.map((call) => call.args.slice(1, 2)[0] || call.args[0]), ['daemon-reload', 'enable', 'restart']);
    assert.ok(seen.some((call) => call.args.includes(operation)), restart);
  });

  test(`${platform} install reports a fake ${command} restart failure`, (t) => {
    const f = fixture(t);
    f.env.SUPERVISOR_FAIL = `${command}:${operation}`;
    assert.throws(() => installService({
      platform,
      home: f.home,
      root: f.root,
      entry: path.join(f.root, 'src', 'cli.js'),
      dataDir: f.dataDir,
      defaultDataDir: path.join(f.home, '.herdr-boss'),
      execPath: process.execPath,
      uid: 501,
      exec: (name, argv) => execFileSync(name, argv, { env: f.env, encoding: 'utf8' }),
    }));
    assert.ok(calls(f.log).some((call) => call.name === command && call.args.includes(operation)));
  });

  test(`${platform} doctor ready check passes and fails through fake ${command}`, async (t) => {
    const f = fixture(t);
    const runner = createDoctorRunner({ home: f.home, env: f.env, platform, uid: 501 });
    const ready = await runDoctor({ home: f.home, env: f.env, stepId: 'service', runner });
    assert.equal(ready.exitCode, 0);
    assert.equal(ready.items.find((item) => item.id === 'service').status, 'green');

    f.env.SUPERVISOR_FAIL = `${command}:${platform === 'darwin' ? 'print' : 'is-active'}`;
    const notReady = await runDoctor({ home: f.home, env: f.env, stepId: 'service', runner });
    assert.equal(notReady.exitCode, 4);
    assert.equal(notReady.items.find((item) => item.id === 'service').status, 'red');
    assert.ok(calls(f.log).some((call) => call.name === command));
  });
}
