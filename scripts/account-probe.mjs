#!/usr/bin/env node
// Keep this file standalone: the Owner can copy it without the service or other repository files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const IDENTITY_KEYS = ['id', 'account', 'accountId', 'account_id', 'email', 'user', 'name', 'org', 'sub'];
const ENV_NAMES = ['OPENCODE_API_KEY', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR'];
const REFUSAL = 'Run account probe at an Owner terminal. It is not available in a Herdr pane.\n';
const TTY_REFUSAL = 'Use an Owner terminal with TTYs on stdin and stdout for account probe.\n';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const yesNo = (value) => value ? 'yes' : 'no';

export function hasHerdrPaneVariables(env) {
  return Object.keys(env).some((name) => name === 'HERDR_ENV' || /^HERDR_PANE(?:_|$)/.test(name) || name === 'HERDR_WORKSPACE_ID' || name === 'HERDR_WORKTREE');
}

export function probeTerminalRefusal(io) {
  if (hasHerdrPaneVariables(io.env)) { io.stderr.write(REFUSAL); return 3; }
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) { io.stderr.write(TTY_REFUSAL); return 1; }
  return 0;
}

// pgrep matches known launchers internally. Its full-command match returns PIDs only.
// Pass no provider variables to the child, and never return arguments or environments.
export function listToolProcesses(tool, { uid = process.getuid?.(), run = spawnSync } = {}) {
  if (!['opencode', 'pi'].includes(tool) || !Number.isInteger(uid)) return { verified: 'no', pids: [] };
  const executable = '([^[:space:]]*/)?';
  const node = `${executable}node([[:space:]]+--[^[:space:]]+)*[[:space:]]+`;
  const script = tool === 'pi'
    ? `(${executable}pi|[^[:space:]]*/(@earendil-works|@mariozechner)/pi-coding-agent/dist/cli\\.js)`
    : `${executable}opencode`;
  const launcher = `^${executable}${tool}([[:space:]]|$)|^${node}${script}([[:space:]]|$)`;
  const pids = new Set();
  try {
    for (const args of [['-l', '-u', String(uid), '-x', tool], ['-u', String(uid), '-f', launcher]]) {
      const result = run('pgrep', args, {
        encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      if (result.error || ![0, 1].includes(result.status)) return { verified: 'no', pids: [...pids].sort((a, b) => a - b) };
      if (result.status === 1) continue;
      for (const line of String(result.stdout || '').split('\n')) {
        if (!line.trim()) continue;
        const match = (args.includes('-l') ? /^\s*([1-9]\d*)\s+/ : /^\s*([1-9]\d*)\s*$/).exec(line);
        if (!match || !Number.isSafeInteger(Number(match[1]))) return { verified: 'no', pids: [...pids].sort((a, b) => a - b) };
        pids.add(Number(match[1]));
      }
    }
    return { verified: 'yes', pids: [...pids].sort((a, b) => a - b) };
  } catch { return { verified: 'no', pids: [...pids].sort((a, b) => a - b) }; }
}

function metadata(file, filesystem, uid) {
  try {
    const stat = filesystem.lstatSync(file);
    if (stat.isSymbolicLink()) return { path: file, exists: 'yes', mode: 'unverified', ownerOnly: 'unverified', symlink: 'yes', regular: false };
    return { path: file, exists: 'yes', mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'), ownerOnly: yesNo(stat.uid === uid && (stat.mode & 0o077) === 0), symlink: 'no', regular: stat.isFile() };
  } catch (error) {
    return { path: file, exists: error.code === 'ENOENT' ? 'no' : 'unverified', mode: 'unverified', ownerOnly: 'unverified', symlink: 'unverified', regular: false };
  }
}

// Remove comments and trailing commas only outside strings. Never evaluate configuration text.
function parseJsonc(text) {
  function stringEnd(start) {
    let end = start + 1;
    for (; end < text.length; end += 1) {
      if (text[end] === '\\') end += 1;
      else if (text[end] === '"') return end + 1;
    }
    throw new Error('Invalid JSONC');
  }
  let clean = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') { const end = stringEnd(i); clean += text.slice(i, end); i = end; }
    else if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; clean += ' '; }
    else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Invalid JSONC');
      clean += ' '; i = end + 2;
    } else { clean += text[i]; i += 1; }
  }
  text = clean;
  clean = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') { const end = stringEnd(i); clean += text.slice(i, end); i = end; }
    else if (text[i] === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) i += 1;
    else { clean += text[i]; i += 1; }
  }
  return JSON.parse(clean);
}

function readJson(file, filesystem, uid, jsonc = false) {
  const { regular, ...meta } = metadata(file, filesystem, uid);
  const report = { ...meta, readable: 'no', validJson: 'unverified' };
  if (!regular) return { report };
  try {
    if (filesystem.statSync(file).size > 1024 * 1024) return { report };
    const text = filesystem.readFileSync(file, 'utf8');
    report.readable = 'yes';
    try {
      const value = jsonc ? parseJsonc(text) : JSON.parse(text);
      report.validJson = 'yes';
      return { report, value };
    } catch { report.validJson = 'no'; }
  } catch { /* Raw file and parser errors can hold values. */ }
  return { report };
}

function loginReport(file, filesystem, uid) {
  const { report, value } = readJson(file, filesystem, uid);
  const topLevelKeys = object(value) ? Object.keys(value).sort() : [];
  return { ...report, objectRoot: report.validJson === 'yes' ? yesNo(object(value)) : 'unverified', topLevelKeys,
    entries: topLevelKeys.map((name) => {
      const entry = value[name];
      const keys = object(entry) ? Object.keys(entry).sort() : [];
      return { name, object: yesNo(object(entry)),
        keys: keys.map((key) => ({ name: key, string: yesNo(typeof entry[key] === 'string'), object: yesNo(entry[key] !== null && typeof entry[key] === 'object') })),
        candidateIdentityKeys: keys.filter((key) => IDENTITY_KEYS.includes(key)),
      };
    }),
  };
}

function configurationReport(file, filesystem, uid) {
  const { report, value } = readJson(file, filesystem, uid, file.endsWith('.jsonc'));
  const fields = new Set();
  const pending = [value];
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    for (const [name, child] of Object.entries(node)) {
      if (name === 'apiKey' || name === 'api_key') fields.add(name);
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return { ...report, apiKeyFields: [...fields].sort() };
}

function otherPiFiles(dir, filesystem, uid) {
  try {
    const files = filesystem.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== 'auth.json' && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => {
        const { regular, ...meta } = metadata(path.join(dir, entry.name), filesystem, uid);
        return meta;
      }).sort((a, b) => a.path.localeCompare(b.path));
    return { path: dir, readable: 'yes', files };
  } catch { return { path: dir, readable: 'no', files: [] }; }
}

function timestamps(file, filesystem) {
  try {
    const stat = filesystem.statSync(file);
    return { atime: stat.atimeMs, mtime: stat.mtimeMs };
  } catch { return null; }
}

export async function collectAccountProbe({ env = process.env, cwd = process.cwd(), filesystem = fs, uid = process.getuid?.(), listProcesses = listToolProcesses, wait = delay } = {}) {
  const home = env.HOME || os.homedir();
  const piDir = path.join(home, '.pi', 'agent');
  const loginPaths = [path.join(home, '.local', 'share', 'opencode', 'auth.json'), path.join(piDir, 'auth.json')];
  const configPaths = [path.join(home, '.config', 'opencode'), cwd]
    .flatMap((dir) => ['opencode.json', 'opencode.jsonc'].map((name) => path.join(dir, name)))
    .concat(['settings.json', 'models.json'].map((name) => path.join(piDir, name)));
  const report = {
    loginFiles: loginPaths.map((file) => loginReport(file, filesystem, uid)),
    otherPiFiles: otherPiFiles(piDir, filesystem, uid),
    environment: [...new Set([...ENV_NAMES, ...Object.keys(env).filter((name) => /OPENCODE|_API_KEY|^XDG_DATA_HOME$|^PI_/.test(name))])]
      .sort().map((name) => ({ name, status: Object.hasOwn(env, name) ? 'set' : 'unset' })),
    configurationFiles: [...new Set(configPaths)].map((file) => configurationReport(file, filesystem, uid)),
    overrideBehavior: 'unverified',
    processes: ['opencode', 'pi'].map((tool) => ({ tool, ...listProcesses(tool) })).map(({ tool, pids, verified }) => ({ tool, count: pids.length, pids, verified })),
  };
  // Baselines follow every probe content read. No content read runs in or after the wait.
  const before = loginPaths.map((file) => timestamps(file, filesystem));
  const performed = report.processes.some((row) => row.pids.length > 0);
  if (performed) await wait(10000);
  const after = performed ? loginPaths.map((file) => timestamps(file, filesystem)) : [];
  const runningAfter = performed ? ['opencode', 'pi'].map((tool) => listProcesses(tool)) : [];
  report.passiveCheck = {
    performed: yesNo(performed),
    processesStillRunning: performed ? (runningAfter.some((row) => row.pids.length > 0) ? 'yes' : runningAfter.every((row) => row.verified === 'yes') ? 'no' : 'unverified') : 'unverified',
    files: loginPaths.map((file, index) => ({ path: file,
      atimeChanged: performed && before[index] && after[index] ? yesNo(after[index].atime !== before[index].atime) : 'unverified',
      mtimeChanged: performed && before[index] && after[index] ? yesNo(after[index].mtime !== before[index].mtime) : 'unverified',
      reRead: 'unverified', conclusion: 'cannot tell',
    })),
    rotationWaitsForProcesses: 'yes',
  };
  return report;
}

export async function writeAccountProbe(io) {
  try {
    const report = await collectAccountProbe({ ...io.probeOptions, env: io.env });
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch {
    io.stderr.write('Account probe did not finish. No file or process error text is printed.\n');
    return 1;
  }
}

export async function standaloneAccountProbe(args, io) {
  if (args.length) { io.stderr.write('Usage: node scripts/account-probe.mjs\n'); return 1; }
  const refusal = probeTerminalRefusal(io);
  return refusal || await writeAccountProbe(io);
}

let direct = false;
if (process.argv[1]) {
  try { direct = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { direct = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
}
if (direct) process.exitCode = await standaloneAccountProbe(process.argv.slice(2), { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
