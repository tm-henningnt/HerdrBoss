import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installService, uninstallService, launchdPlist, systemdUnit, LINUX_UNIT_NAME, SERVICE_LABEL, stableNodePath } from '../src/install.js';

// Each test runs the installer against a temporary home folder and a fake executor. No test writes a
// real service file and no test runs systemctl or launchctl.
function fixture(t, { platform = 'linux' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const calls = [];
  const exec = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (options.ignoreFailure) return '';
    const failure = options.fail?.(command, args);
    if (failure) throw failure;
    return '';
  };
  const options = {
    platform,
    root,
    entry: path.join(root, 'repo', 'src', 'cli.js'),
    home,
    dataDir: path.join(home, 'configured-data'),
    defaultDataDir: path.join(home, '.herdr-boss'),
    execPath: '/usr/bin/node',
    dashboard: 'http://127.0.0.1:4477',
    uid: 501,
    exec,
  };
  return { root, home, calls, options, dataDir: options.dataDir };
}

// systemd parses ExecStart and Environment lines itself. This reader implements the primary rules of the
// unit file format: a double quoted string, a backslash before `"` and `\`, and %% for a literal percent.
// It turns the unit text back into the argument list, so a wrong escape shows up as a wrong argument.
function readQuotedValue(rest, label) {
  if (!rest.startsWith('"')) throw new Error(`${label} is not quoted: ${rest}`);
  let current = '';
  for (let index = 1; index < rest.length; index += 1) {
    const character = rest[index];
    if (character === '"') return { value: current, tail: rest.slice(index + 1) };
    if (character === '%' && rest[index + 1] === '%') { current += '%'; index += 1; continue; }
    if (character === '\\' && ['"', '\\'].includes(rest[index + 1])) { current += rest[index + 1]; index += 1; continue; }
    current += character;
  }
  throw new Error(`${label} has no closing quote: ${rest}`);
}

function readQuoted(line, key) {
  if (!line.startsWith(`${key}=`)) return null;
  return readQuotedValue(line.slice(key.length + 1), key);
}

// systemd reads a path scalar such as WorkingDirectory and the file of StandardOutput=append: without quote
// removal. Only the percent specifier is processed: %% is a literal percent sign.
function scalarOf(unit, key, prefix = '') {
  const line = unit.split('\n').find((entry) => entry.startsWith(`${key}=${prefix}`));
  assert.ok(line, `the unit must have a ${key} line`);
  const raw = line.slice(key.length + 1 + prefix.length);
  assert.equal(raw.startsWith('/'), true, `${key} must start with an absolute path, not a quote: ${raw}`);
  return raw.replace(/%%/g, '%');
}

function execStartArgv(unit) {
  const line = unit.split('\n').find((entry) => entry.startsWith('ExecStart='));
  assert.ok(line, 'the unit must have an ExecStart line');
  const argv = [];
  let rest = line.slice('ExecStart='.length);
  for (;;) {
    while (rest.startsWith(' ')) rest = rest.slice(1);
    if (!rest) return argv;
    if (rest.startsWith('"')) {
      const { value, tail } = readQuotedValue(rest, 'an ExecStart argument');
      argv.push(value);
      rest = tail;
      continue;
    }
    const end = rest.indexOf(' ');
    argv.push(end < 0 ? rest : rest.slice(0, end));
    rest = end < 0 ? '' : rest.slice(end);
  }
}

function environmentOf(unit) {
  const values = {};
  for (const line of unit.split('\n')) {
    if (!line.startsWith('Environment=')) continue;
    const { value, tail } = readQuoted(line, 'Environment');
    assert.equal(tail, '', `the Environment line has trailing text: ${line}`);
    const split = value.indexOf('=');
    values[value.slice(0, split)] = value.slice(split + 1);
  }
  return values;
}

test('the Linux install writes a user unit in the systemd user folder', (t) => {
  const { options, home } = fixture(t);
  const result = installService(options);
  const unitPath = path.join(home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`);
  assert.equal(fs.existsSync(unitPath), true, 'the unit file must exist');
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /^\[Unit\]\nDescription=Herdr Boss dashboard and collector\nAfter=default\.target\n\n\[Service\]\n/);
  assert.match(unit, /\n\[Install\]\nWantedBy=default\.target\n$/);
  assert.equal(fs.statSync(unitPath).mode & 0o777, 0o644);
  assert.deepEqual(result.lines, [`installed ${unitPath}`, 'dashboard http://127.0.0.1:4477']);
});

test('the Linux install calls systemctl with exact argument arrays', (t) => {
  const { options, calls } = fixture(t);
  installService(options);
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', LINUX_UNIT_NAME],
    ['systemctl', '--user', 'restart', LINUX_UNIT_NAME],
  ]);
  assert.equal(calls.some(([command]) => command === 'sudo' || command === 'system'), false, 'no root service');
});

test('the Linux unit runs the configured entry with the configured data directory', (t) => {
  const { options, dataDir } = fixture(t);
  installService(options);
  const unit = fs.readFileSync(path.join(options.home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`), 'utf8');
  assert.deepEqual(execStartArgv(unit), ['/usr/bin/node', path.join(options.root, 'repo', 'src', 'cli.js'), 'serve']);
  assert.equal(environmentOf(unit).HERDR_BOSS_DIR, dataDir);
  assert.equal(environmentOf(unit).HERDR_BOSS_LIVE_DIR, dataDir);
  assert.match(unit, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m);
  const log = path.join(dataDir, 'server.log');
  assert.equal(scalarOf(unit, 'StandardOutput', 'append:'), log);
  assert.equal(scalarOf(unit, 'StandardError', 'append:'), log);
  assert.equal(scalarOf(unit, 'WorkingDirectory'), options.root);
  assert.equal(/access-token|sessions\.json|token/i.test(unit), false, 'the unit holds no secret file value');
});

test('the Linux unit writes no data directory line when the data directory is the default', (t) => {
  const { options } = fixture(t);
  installService({ ...options, dataDir: options.defaultDataDir });
  const unit = fs.readFileSync(path.join(options.home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`), 'utf8');
  assert.deepEqual(environmentOf(unit), { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
});

test('the Linux unit escapes spaces, quotes and percent signs', (t) => {
  const { options } = fixture(t);
  const root = path.join(options.root, "a dir 'q' 100%");
  const dataDir = path.join(options.home, 'data dir "two" 50%');
  installService({ ...options, root, dataDir, entry: path.join(root, 'src', 'cli.js') });
  const unit = fs.readFileSync(path.join(options.home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`), 'utf8');
  assert.deepEqual(execStartArgv(unit), ['/usr/bin/node', path.join(root, 'src', 'cli.js'), 'serve']);
  assert.equal(environmentOf(unit).HERDR_BOSS_DIR, dataDir);
  const environment = unit.split('\n').find((line) => line.startsWith('Environment=') && line.includes('HERDR_BOSS_DIR'));
  assert.ok(environment, 'the unit sets the configured data directory');
  assert.ok(environment.includes('50%%'), 'the percent sign of the data directory must be doubled');
  assert.equal(/(?<!%)%(?!%)/.test(environment), false, 'no single percent sign remains');
  const working = unit.split('\n').find((line) => line.startsWith('WorkingDirectory='));
  assert.equal(scalarOf(unit, 'WorkingDirectory'), root);
  assert.ok(working.includes('100%%'), 'the percent sign of the repository path must be doubled');
  assert.equal(/(?<!%)%(?!%)/.test(working), false, 'no single percent sign remains');
});

test('the Linux install rejects a path with a newline or a control character', (t) => {
  const { options, home } = fixture(t);
  for (const bad of ['/tmp/a\nExecStart=/bin/false', '/tmp/a\tb', '/tmp/a\rb']) {
    assert.throws(() => installService({ ...options, root: bad }), /control character|newline/);
  }
  assert.equal(fs.existsSync(path.join(home, '.config')), false, 'a rejected install writes no unit folder');
});

test('the Linux uninstall stops the unit, removes the owned unit, and reloads the daemon', (t) => {
  const { options, home, calls } = fixture(t);
  installService(options);
  const unitPath = path.join(home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`);
  const other = path.join(home, '.config', 'systemd', 'user', 'other.service');
  fs.writeFileSync(other, '[Service]\n');
  calls.length = 0;
  const result = uninstallService(options);
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'disable', '--now', LINUX_UNIT_NAME],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
  assert.equal(fs.existsSync(unitPath), false, 'the unit must be removed');
  assert.equal(fs.existsSync(other), true, 'the uninstall touches no other unit');
  assert.deepEqual(result.lines, ['uninstalled']);
});

test('a failing systemctl call stops the install and reports the error', (t) => {
  const { options, home } = fixture(t);
  const optionsWithFailure = {
    ...options,
    exec: (command, args, execOptions = {}) => {
      if (command === 'systemctl' && args[1] === 'enable') throw new Error('Failed to enable unit: Access denied');
      if (execOptions.ignoreFailure) return '';
      return '';
    },
  };
  assert.throws(() => installService(optionsWithFailure), /Failed to enable unit/);
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`)), true, 'the unit file stays for a repair run');
  assert.throws(() => uninstallService({ ...options, exec: () => { throw new Error('Failed to disable unit: no session'); } }), /no session/);
});

test('the macOS install keeps the launchd plist text and the printed lines', (t) => {
  const { options, home, calls } = fixture(t, { platform: 'darwin' });
  const result = installService(options);
  const plistPath = path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const log = path.join(options.dataDir, 'server.log');
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${path.join(options.root, 'repo', 'src', 'cli.js')}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${options.root}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath, 'utf8'), expected);
  assert.deepEqual(result.lines, [`installed ${plistPath}`, 'dashboard http://127.0.0.1:4477']);
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501', plistPath],
    ['launchctl', 'bootstrap', 'gui/501', plistPath],
  ]);
});

test('the macOS install prefers a stable node link on PATH', () => {
  const links = { '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.1.0/bin/node', '/usr/local/bin/node': '/usr/local/Cellar/node/24.0.0/bin/node' };
  const realpathSync = (value) => {
    if (value in links) return links[value];
    if (value === links['/opt/homebrew/bin/node'] || value === links['/usr/local/bin/node']) return value;
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  assert.equal(stableNodePath({ execPath: '/opt/homebrew/Cellar/node/26.1.0/bin/node', realpathSync }), '/opt/homebrew/bin/node');
  assert.equal(stableNodePath({ execPath: '/usr/local/Cellar/node/24.0.0/bin/node', realpathSync }), '/usr/local/bin/node');
  assert.equal(stableNodePath({ execPath: '/usr/lib/node', realpathSync }), '/usr/lib/node');
});

test('the macOS uninstall stops the agent and removes the plist', (t) => {
  const { options, home, calls } = fixture(t, { platform: 'darwin' });
  installService(options);
  const plistPath = path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  calls.length = 0;
  const result = uninstallService(options);
  assert.deepEqual(calls, [['launchctl', 'bootout', 'gui/501', plistPath]]);
  assert.equal(fs.existsSync(plistPath), false);
  assert.deepEqual(result.lines, ['uninstalled']);
});

test('a bootout failure before the install does not stop the install', (t) => {
  const { options, calls } = fixture(t, { platform: 'darwin' });
  const result = installService({ ...options, exec: (command, args, execOptions = {}) => {
    calls.push([command, ...args]);
    if (execOptions.ignoreFailure) throw new Error('bootout found no loaded agent');
    return '';
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], 'bootout');
  assert.equal(result.lines[1], 'dashboard http://127.0.0.1:4477');
});

test('an unsupported platform fails clearly and writes nothing', (t) => {
  const { options, home, calls } = fixture(t, { platform: 'win32' });
  assert.throws(() => installService(options), /cannot install a service on win32/);
  assert.throws(() => uninstallService(options), /cannot uninstall a service on win32/);
  assert.deepEqual(calls, [], 'no command runs on an unsupported platform');
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.config')), false);
});

test('the unit and plist builders name the service and the entry', () => {
  const unit = systemdUnit({ node: '/usr/bin/node', entry: '/srv/herdr/src/cli.js', root: '/srv/herdr', log: '/home/u/.herdr-boss/server.log', dataDir: '/home/u/.herdr-boss', defaultDataDir: '/home/u/.herdr-boss' });
  assert.match(unit, /^\[Unit\]\n/);
  assert.match(unit, /^Restart=always\nRestartSec=5$/m);
  assert.equal(unit.includes('\n\n'), true);
  assert.match(unit, /^WorkingDirectory=\/srv\/herdr$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/u\/\.herdr-boss\/server\.log$/m);
  const plist = launchdPlist({ node: '/usr/bin/node', entry: '/srv/herdr/src/cli.js', root: '/srv/herdr', log: '/home/u/.herdr-boss/server.log' });
  assert.match(plist, /<key>Label<\/key><string>no\.tallmaker\.herdr-boss<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
});

test('the Linux unit writes scalar paths without quotes, also for a path with spaces and quotes', (t) => {
  const { options } = fixture(t);
  const dataDir = path.join(options.home, 'data dir "two" 50%');
  installService({ ...options, dataDir });
  const unit = fs.readFileSync(path.join(options.home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`), 'utf8');
  const log = path.join(dataDir, 'server.log');
  assert.equal(scalarOf(unit, 'StandardOutput', 'append:'), log);
  assert.equal(scalarOf(unit, 'StandardError', 'append:'), log);
  assert.equal(unit.split('\n').find((line) => line.startsWith('StandardOutput=')).includes('"'), true, 'a double quote in the path stays literal');
  assert.equal(unit.split('\n').find((line) => line.startsWith('StandardOutput=')).startsWith('StandardOutput=append:"'), false);
});

test('the Linux unit keeps a dollar sign in the entry path literal in ExecStart only', (t) => {
  const { options } = fixture(t);
  const root = path.join(options.root, 'a${UNSET}b$HOME');
  const dataDir = path.join(options.home, 'd$X');
  installService({ ...options, root, dataDir, entry: path.join(root, 'src', 'cli.js') });
  const unit = fs.readFileSync(path.join(options.home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`), 'utf8');
  const exec = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.equal(/\$(?!\$)/.test(exec.replace(/\$\$/g, '')), false, 'every dollar sign in ExecStart is doubled');
  assert.equal(exec.replace(/\$\$/g, '$').includes(path.join(root, 'src', 'cli.js')), true);
  assert.equal(scalarOf(unit, 'WorkingDirectory'), root, 'a scalar path keeps a single dollar sign');
  assert.equal(environmentOf(unit).HERDR_BOSS_DIR, dataDir, 'Environment keeps a single dollar sign');
});

test('the Linux uninstall keeps the unit and reports a failure to stop the service', (t) => {
  const { options, home } = fixture(t);
  installService(options);
  const unitPath = path.join(home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`);
  const exec = (command, args) => {
    if (args.includes('disable')) throw new Error('Failed to disable unit: Access denied');
    return '';
  };
  assert.throws(() => uninstallService({ ...options, exec }), /Access denied/);
  assert.equal(fs.existsSync(unitPath), true, 'the unit stays for a repair run');
});

test('the Linux uninstall without an installed unit tolerates a disable failure', (t) => {
  const { options } = fixture(t);
  const exec = (command, args) => { if (args.includes('disable')) throw new Error('unit not found'); return ''; };
  assert.deepEqual(uninstallService({ ...options, exec }).lines, ['uninstalled']);
});

test('the Linux reinstall restarts the service after the daemon reload and enable', (t) => {
  const { options, calls } = fixture(t);
  installService(options);
  calls.length = 0;
  installService({ ...options, root: path.join(options.root, 'moved'), entry: path.join(options.root, 'moved', 'src', 'cli.js') });
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', LINUX_UNIT_NAME],
    ['systemctl', '--user', 'restart', LINUX_UNIT_NAME],
  ]);
});

test('a failing restart reports the error and keeps the unit', (t) => {
  const { options, home } = fixture(t);
  const exec = (command, args) => { if (args.includes('restart')) throw new Error('Failed to restart unit'); return ''; };
  assert.throws(() => installService({ ...options, exec }), /Failed to restart/);
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${LINUX_UNIT_NAME}`)), true);
});

test('the macOS uninstall keeps its original behavior when the plist cannot be removed', (t) => {
  const { options, home, calls } = fixture(t, { platform: 'darwin' });
  installService(options);
  calls.length = 0;
  const realFs = fs;
  const denied = { ...realFs, unlinkSync: () => { throw Object.assign(new Error('fixture unlink denied'), { code: 'EACCES' }); } };
  const result = uninstallService({ ...options, fs: denied });
  assert.deepEqual(result.lines, ['uninstalled']);
  assert.equal(calls.length, 1);
});

// The CLI must refuse an unsupported platform before loadConfig and the access migration write anything.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
for (const command of ['install', 'uninstall']) {
  test(`the CLI ${command} refuses an unsupported platform before any write`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-boss-install-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const data = path.join(root, 'data');
    fs.mkdirSync(home);
    const preload = path.join(root, 'platform.mjs');
    fs.writeFileSync(preload, "import os from 'node:os';\nos.platform = () => 'win32';\n");
    const run = spawnSync(process.execPath, ['--import', preload, CLI, command], {
      env: { ...process.env, HOME: home, HERDR_BOSS_DIR: data, HERDR_BOSS_LIVE_DIR: data },
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`cannot ${command} a service on win32`));
    assert.equal(fs.existsSync(data), false, 'no data directory is created');
    assert.deepEqual(fs.readdirSync(home), [], 'nothing is written to the home folder');
  });
}
