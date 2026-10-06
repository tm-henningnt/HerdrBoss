// The service installer for the platforms that Herdr Boss supports. The module owns the file it writes and the
// commands it runs. Every caller injects the executor and the file system, so a test never writes a real service
// file and never runs a real service command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVICE_LABEL = 'no.tallmaker.herdr-boss';
export const LINUX_UNIT_NAME = 'herdr-boss.service';
const MACOS_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function launchdPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home = os.homedir()) {
  return path.join(home, '.config', 'systemd', 'user', LINUX_UNIT_NAME);
}

// A package manager upgrade removes a versioned path such as .../Cellar/node/<version>/bin/node. Prefer a stable
// link on PATH that points to the same binary, so the service survives an upgrade.
export function stableNodePath({ execPath = process.execPath, realpathSync = fs.realpathSync } = {}) {
  const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((candidate) => {
    try { return realpathSync(candidate) === realpathSync(execPath); } catch { return false; }
  });
  return stable || execPath;
}

export function launchdPlist({ node, entry, root, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${entry}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${MACOS_PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

// systemd reads the unit itself. The module never hands systemd shell text. Each directive has its own encoding:
// - ExecStart and Environment use command-line quoting: a quoted value, a backslash before a backslash and a
//   double quote, and %% for a percent sign. In ExecStart a dollar sign also starts a substitution, so it becomes $$.
// - A path scalar (WorkingDirectory, StandardOutput=append:) has no quote removal. The path is written raw. Only
//   the percent sign is doubled, because systemd expands specifiers in these values.
// A control character, a newline, or a carriage return cannot be written safely, so the installer refuses it.
function assertUnitValue(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`The systemd unit cannot hold an empty ${name}.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`The systemd unit cannot hold a ${name} with a control character or a newline. Move the repository, the entry, or the data directory to a path without control characters.`);
  return value;
}

function unitValue(value, name, { exec = false } = {}) {
  assertUnitValue(value, name);
  const quoted = value.replace(/[\\"]/g, (character) => `\\${character}`).replace(/%/g, '%%');
  return `"${exec ? quoted.replace(/\$/g, '$$$$') : quoted}"`;
}

function unitPath(value, name) {
  assertUnitValue(value, name);
  return value.replace(/%/g, '%%');
}

export function systemdUnit({ node, entry, root, log, dataDir, defaultDataDir }) {
  assertUnitValue(node, 'node path');
  assertUnitValue(entry, 'entry path');
  assertUnitValue(root, 'repository path');
  assertUnitValue(log, 'log path');
  const environment = [`Environment=${unitValue(`PATH=${LINUX_PATH}`, 'service PATH')}`];
  // The service must keep the configured data directory, so it never writes into the data directory of another
  // factory. The live directory line keeps the serve guard happy when the configured directory is not the default.
  if (dataDir && path.resolve(dataDir) !== path.resolve(defaultDataDir || dataDir)) {
    assertUnitValue(dataDir, 'data directory');
    environment.push(`Environment=${unitValue(`HERDR_BOSS_DIR=${dataDir}`, 'data directory')}`);
    environment.push(`Environment=${unitValue(`HERDR_BOSS_LIVE_DIR=${dataDir}`, 'live data directory')}`);
  }
  return `[Unit]
Description=Herdr Boss dashboard and collector
After=default.target

[Service]
Type=simple
WorkingDirectory=${unitPath(root, 'repository path')}
ExecStart=${unitValue(node, 'node path', { exec: true })} ${unitValue(entry, 'entry path', { exec: true })} serve
${environment.join('\n')}
StandardOutput=append:${unitPath(log, 'log path')}
StandardError=append:${unitPath(log, 'log path')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function runExec(command, args, { ignoreFailure = false } = {}) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return '';
  } catch (error) {
    if (ignoreFailure) return '';
    throw error;
  }
}

function options(input) {
  const home = input.home ?? os.homedir();
  const root = input.root ?? ROOT;
  return {
    platform: input.platform ?? os.platform(),
    home,
    root,
    entry: input.entry ?? path.join(root, 'src', 'cli.js'),
    dataDir: input.dataDir ?? path.join(home, '.herdr-boss'),
    defaultDataDir: input.defaultDataDir ?? path.join(home, '.herdr-boss'),
    execPath: input.execPath ?? process.execPath,
    dashboard: input.dashboard ?? '',
    uid: input.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    exec: input.exec ?? runExec,
    realpathSync: input.realpathSync ?? fs.realpathSync,
    fs: input.fs ?? fs,
  };
}

function refuse(platform, action) {
  throw new Error(`Herdr Boss cannot ${action} a service on ${platform}. The supported platforms are macOS and Linux.`);
}

// A caller may inject an executor that has no ignore flag of its own. The installer still swallows a failure of
// a command that it marked as optional, and it still reports a failure of every other command.
function call(setting, command, args, { ignoreFailure = false } = {}) {
  try {
    return setting.exec(command, args, { ignoreFailure });
  } catch (error) {
    if (ignoreFailure) return '';
    throw error;
  }
}

// The CLI calls this before it loads the configuration, so an unsupported platform causes no write.
export function assertServiceSupported(action, platform = os.platform()) {
  if (platform !== 'darwin' && platform !== 'linux') refuse(platform, action);
}

export function installService(input = {}) {
  const setting = options(input);
  if (setting.platform === 'darwin') {
    const node = stableNodePath({ execPath: setting.execPath, realpathSync: setting.realpathSync });
    const plist = launchdPlist({ node, entry: setting.entry, root: setting.root, log: path.join(setting.dataDir, 'server.log') });
    const file = launchdPath(setting.home);
    setting.fs.mkdirSync(path.dirname(file), { recursive: true });
    call(setting, 'launchctl', ['bootout', `gui/${setting.uid}`, file], { ignoreFailure: true });
    setting.fs.writeFileSync(file, plist);
    call(setting, 'launchctl', ['bootstrap', `gui/${setting.uid}`, file]);
    return { file, lines: [`installed ${file}`, `dashboard ${setting.dashboard}`] };
  }
  if (setting.platform === 'linux') {
    const unit = systemdUnit({
      node: setting.execPath,
      entry: setting.entry,
      root: setting.root,
      log: path.join(setting.dataDir, 'server.log'),
      dataDir: setting.dataDir,
      defaultDataDir: setting.defaultDataDir,
    });
    const file = systemdUnitPath(setting.home);
    setting.fs.mkdirSync(path.dirname(file), { recursive: true });
    setting.fs.writeFileSync(file, unit, { mode: 0o644 });
    call(setting, 'systemctl', ['--user', 'daemon-reload']);
    // A restart applies the new paths to a service that already runs. A start request would keep the old process.
    call(setting, 'systemctl', ['--user', 'enable', LINUX_UNIT_NAME]);
    call(setting, 'systemctl', ['--user', 'restart', LINUX_UNIT_NAME]);
    return { file, lines: [`installed ${file}`, `dashboard ${setting.dashboard}`] };
  }
  refuse(setting.platform, 'install');
}

export function uninstallService(input = {}) {
  const setting = options(input);
  if (setting.platform === 'darwin') {
    const file = launchdPath(setting.home);
    call(setting, 'launchctl', ['bootout', `gui/${setting.uid}`, file], { ignoreFailure: true });
    // The earlier CLI printed uninstalled when the plist could not be removed. macOS keeps that behavior.
    try { setting.fs.unlinkSync(file); } catch {}
    return { file, lines: ['uninstalled'] };
  }
  if (setting.platform === 'linux') {
    const file = systemdUnitPath(setting.home);
    // A failure to stop the service stops the uninstall and keeps the unit file for a repair run. Without an
    // installed unit file there is nothing to stop, so a failure is allowed.
    call(setting, 'systemctl', ['--user', 'disable', '--now', LINUX_UNIT_NAME], { ignoreFailure: !setting.fs.existsSync(file) });
    if (setting.fs.existsSync(file)) setting.fs.unlinkSync(file);
    call(setting, 'systemctl', ['--user', 'daemon-reload']);
    return { file, lines: ['uninstalled'] };
  }
  refuse(setting.platform, 'uninstall');
}