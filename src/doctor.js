// Onboarding checks. Raw probe output never reaches a report.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCodexRoots } from './harness.js';
import { claudeRateLimitsDir } from './claude-statusline.js';
import { ROOT_DEFAULTS, resolveRootPath } from './config.js';

export const DOCTOR_TIMEOUT_MS = 5000;
export const DOCTOR_MIN_DISK_BYTES = 5 * 1024 ** 3;
export const DOCTOR_DISK_NOTE_BYTES = 15_000_000_000;
export const DOCTOR_MIN_MEMORY_BYTES = 8 * 1024 ** 3;
// The Claude helper file is stale after this age. It matches the stale limit of the Claude reader.
export const DOCTOR_CLAUDE_USAGE_MAX_AGE_MS = 3 * 3600_000;
// The orchestrator verified the Mac installers. ONB1g extends the Linux column.
export const DOCTOR_INSTALL_FIXES = Object.freeze({
  node: { darwin: 'Run brew install node. Use Node 26.10 or later. Put node on PATH.', linux: 'Follow the Node vendor instructions. Install Node 26.10 or later. Put node on PATH.' },
  git: { darwin: 'Run brew install git. Put git on PATH.', linux: 'Install Git with the package manager of your system. Put git on PATH.' },
  herdr: { darwin: 'Run brew install herdr. Put herdr on PATH.', linux: 'Follow the Herdr vendor instructions. Put herdr on PATH.' },
  'claude-installed': { darwin: 'Run brew install --cask claude-code@latest. Put claude on PATH.', linux: 'Follow the Claude Code vendor instructions. Put claude on PATH.' },
  'codex-installed': { darwin: 'Run brew install --cask codex. Put codex on PATH.', linux: 'Follow the Codex vendor instructions. Put codex on PATH.' },
  'opencode-installed': { darwin: 'Run npm install -g opencode-ai. Put opencode on PATH.', linux: 'Follow the OpenCode vendor instructions. Put opencode on PATH.' },
  'pi-installed': { darwin: 'Run npm install -g @earendil-works/pi-coding-agent. Put pi on PATH.', linux: 'Run npm install -g @earendil-works/pi-coding-agent. Put pi on PATH.' },
  gh: { darwin: 'Run brew install gh. Put gh on PATH.', linux: 'Install the GitHub command gh with the package manager of your system. Put gh on PATH.' },
  codexbar: { darwin: 'Run brew install --cask codexbar. Put codexbar on PATH.', linux: 'CodexBar does not exist on Linux and is not needed. The Codex usage and Claude usage checks replace it.' },
});
const LABEL = 'no.tallmaker.herdr-boss';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const text = (value) => typeof value === 'string' ? value.trim() : '';
function json(value) { try { return JSON.parse(value); } catch { return null; } }
const nonempty = (value) => Boolean(text(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (file, dir) => {
  const relative = path.relative(dir, file);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function doctorDiskPaths(home, env) {
  const dataDir = path.resolve(env.HERDR_BOSS_DIR || path.join(home, '.herdr-boss'));
  let worktreeRoot;
  try {
    const config = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const value = config?.worktreeRoot ?? ROOT_DEFAULTS.worktreeRoot;
    worktreeRoot = resolveRootPath(value, home);
  } catch { worktreeRoot = resolveRootPath(ROOT_DEFAULTS.worktreeRoot, home); }
  return [...new Set([path.resolve(dataDir), worktreeRoot])];
}

async function readFreeSpace(file) {
  let target = path.resolve(file);
  for (;;) {
    try {
      await fs.stat(target);
      return await fs.statfs(target);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      target = parent;
    }
  }
}

function jsonc(value) {
  // Keep strings intact. Comments and trailing commas are legal in OpenCode JSONC.
  let clean = '';
  const source = text(value);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      const start = index;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '"') break;
      }
      clean += source.slice(start, index + 1);
    } else if (char === '/' && source[index + 1] === '/') {
      for (; index < source.length && source[index] !== '\n'; index += 1) {}
      clean += '\n';
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 1;
      clean += ' ';
    } else clean += char;
  }
  let result = '';
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index] === '"') {
      const start = index;
      for (index += 1; index < clean.length; index += 1) {
        if (clean[index] === '\\') index += 1;
        else if (clean[index] === '"') break;
      }
      result += clean.slice(start, index + 1);
    } else if (clean[index] !== ',' || !/^\s*[}\]]/.test(clean.slice(index + 1))) result += clean[index];
  }
  return json(result);
}

function checks({ home, env, factoryHost }) {
  const command = (id, stepId, name, cmd, args, fix, pass = nonempty) => ({ id, stepId, name, fix, pass, request: { kind: 'command', command: cmd, args } });
  const read = (id, name, file, fix, pass) => ({ id, stepId: 'settings', name, fix, pass, request: { kind: 'read', file: path.join(home, file) } });
  // `only` limits a check to one platform. The os check runs first and sets the platform.
  const rows = [
    { id: 'os', stepId: 'check', name: 'Operating system', fix: 'Use macOS or Linux. On Windows, install Ubuntu under WSL2 and run this command in Ubuntu.', pass: (value) => ['darwin', 'linux'].includes(value), request: { kind: 'platform' } },
    command('node', 'tools', 'Node', 'node', ['--version'], null, (value) => {
      const match = /^v?(\d+)\.(\d+)\.(\d+)\b/.exec(text(value));
      return Boolean(match && (Number(match[1]) > 26 || (Number(match[1]) === 26 && Number(match[2]) >= 10)));
    }),
    command('git', 'tools', 'Git', 'git', ['--version'], null, (value) => /^git version \d/.test(text(value))),
    command('git-name', 'tools', 'Git name', 'git', ['config', '--global', '--get', 'user.name'], 'Run git config --global user.name "Your name". Replace Your name with your name.'),
    command('herdr', 'tools', 'Herdr', 'herdr', ['--version'], null),
    command('claude-installed', 'tools', 'Claude Code installed', 'claude', ['--version'], null),
    command('claude-signed-in', 'signin', 'Claude Code signed in', 'claude', ['auth', 'status'], 'Only you: run claude auth login in your terminal. Sign in on the browser page.', (value) => json(value)?.loggedIn === true),
    command('codex-installed', 'tools', 'Codex installed', 'codex', ['--version'], null),
    command('codex-signed-in', 'signin', 'Codex signed in', 'codex', ['login', 'status'], 'Only you: run codex login in your terminal. Sign in on the browser page.', (value) => /^Logged in\b/i.test(text(value))),
    command('opencode-installed', 'tools', 'OpenCode installed', 'opencode', ['--version'], null),
    command('opencode-signed-in', 'signin', 'OpenCode signed in', 'opencode', ['auth', 'list'], 'Only you: run herdr-boss factory login NAME opencode at an Owner terminal. Complete the sign-in there.', (value) => /\b[1-9]\d* credentials?\b/i.test(text(value))),
    command('pi-installed', 'tools', 'Pi installed', 'pi', ['--version'], null),
    command('pi-signed-in', 'signin', 'Pi signed in', 'pi', ['--list-models'], 'Only you: open pi in your terminal. Run /login and sign in to your provider.', (value) => {
      const lines = text(value).split(/\r?\n/);
      const header = lines.findIndex((line) => /^\s*provider\s+model(\s|$)/i.test(line));
      return header >= 0 && lines.slice(header + 1).some((line) => /^\s*\S+\s+\S+/.test(line));
    }),
    command('gh', 'tools', 'GitHub command', 'gh', ['--version'], null, (value) => /^gh version \d/.test(text(value))),
    command('codexbar', 'tools', 'CodexBar', 'codexbar', ['--version'], null),
    { id: 'service', stepId: 'service', name: 'Herdr Boss service', fix: 'Run doctor as your normal user, without sudo. On macOS, sudo checks gui/0. Run bin/herdr-boss install from the Herdr Boss folder. On Linux, set up the systemd user service.', pass: (value) => /\bstate = running\b/.test(text(value)) || text(value) === 'active', request: { kind: 'service' } },
    { id: 'data-folder', stepId: 'service', name: 'Data folder', fix: 'Run bin/herdr-boss install. Give your user read, write, and search access to the data folder.', pass: (value) => value === true, request: { kind: 'directory', file: env.HERDR_BOSS_DIR || path.join(home, '.herdr-boss') } },
    read('claude-settings', 'Claude autoMode', '.claude/settings.json', 'Only you: run herdr-boss harness sync. Back up ~/.claude/settings.json. Add the missing autoMode lines in your editor.', (value) => {
      const mode = json(value)?.autoMode;
      return Array.isArray(mode?.environment) && ['### Herdr Boss orchestration', '**Supervisor**', '**Messages from the supervisor**', '**Herdr Boss projects**', '**Owner decisions**'].every((prefix) => mode.environment.some((line) => typeof line === 'string' && line.startsWith(prefix)))
        && Array.isArray(mode.allow) && mode.allow[0] === '$defaults' && ['A Herdr Boss orchestrator pushes', 'A Herdr Boss orchestrator removes', 'A Herdr Boss orchestrator or the Boss records', 'The HerdrBoss orchestrator and its workers edit'].every((prefix) => mode.allow.some((line) => typeof line === 'string' && line.startsWith(prefix)));
    }),
    read('codex-settings', 'Codex folder rules', '.codex/config.toml', 'Run herdr-boss harness sync --codex-only. Keep ~/.config/herdr-boss and its parent folders outside writable_roots.', (value) => {
      const parsed = parseCodexRoots(text(value));
      if (parsed.error) return false;
      const roots = parsed.items.map((item) => path.resolve(item.value.replace(/^~(?=\/|$)/, home)));
      const privateDir = path.join(home, '.config', 'herdr-boss');
      return [path.join(home, '.herdr-boss'), path.join(home, 'Projects', '.herdr-wt')].every((root) => roots.includes(root)) && !roots.some((root) => {
        const relative = path.relative(root, privateDir);
        return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
      });
    }),
    read('codex-rules', 'Codex command rules', '.codex/rules/herdr.rules', 'Copy kit/templates/harness/codex-herdr.rules to ~/.codex/rules/herdr.rules. Replace {{UID}} with your numeric user ID.', (value) => {
      const forbidden = new Set();
      for (const line of text(value).split('\n')) {
        const match = /^\s*prefix_rule\(\s*pattern\s*=\s*(\[[^\]]+\])\s*,\s*decision\s*=\s*"forbidden"\s*\)/.exec(line);
        const args = match && json(match[1]);
        if (Array.isArray(args)) forbidden.add(args.join(':'));
      }
      return ['ps:e', 'ps:-E', 'ps:eww', 'ps:auxe', 'ps:auxeww', 'pkill', 'killall'].every((rule) => forbidden.has(rule));
    }),
    { ...read('opencode-settings', 'OpenCode worker profile', '.config/opencode/opencode.json', 'Copy the worker profile from kit/templates/harness/opencode-worker-agent.json into ~/.config/opencode/opencode.json under agent.worker.', (value) => object(jsonc(value)?.agent?.worker)), request: { kind: 'opencode-settings' } },
    { id: 'disk', stepId: 'check', name: 'Disk', fix: 'Free at least 5 GiB on the disk that holds your Herdr Boss data and worktrees. Remove only files that you own.', pass: (value) => {
      const rows = Array.isArray(value) ? value : [value];
      return rows.length > 0 && rows.every((row) => Number(row?.bavail) * Number(row?.bsize) >= DOCTOR_MIN_DISK_BYTES);
    }, request: { kind: 'disk', files: doctorDiskPaths(home, env) } },
    { id: 'memory', stepId: 'check', name: 'Memory', fix: 'Use a computer with at least 8 GiB of memory. For a factory, give it at least 8 GiB.', pass: (value) => Number(value) >= DOCTOR_MIN_MEMORY_BYTES, request: { kind: 'memory' } },
    { ...command('usage-reading', 'pacing', 'Usage reading', 'codexbar', ['usage', '--format', 'json', '--provider', 'claude'], 'Only you: sign in to Claude Code. Set the Claude usage source in CodexBar to Auto. Run doctor again.', (value) => {
      const rows = json(value);
      return Array.isArray(rows) && rows.some((row) => row?.provider === 'claude' && !row.error && typeof row.usage?.primary?.usedPercent === 'number' && row.usage.primary.usedPercent >= 0 && row.usage.primary.usedPercent <= 100);
    }), only: 'darwin' },
    { ...command('codex-usage', 'pacing', 'Codex usage reader login', 'codex', ['login', 'status'], 'Install Codex in the factory image and log in as the factory user. Run doctor again.', (value) => /^Logged in\b/i.test(text(value))), only: 'linux' },
    { ...command('codex-version', 'pacing', 'Codex version', 'codex', ['--version'], 'Install Codex in the factory image. The usage reader runs codex app-server.', (value) => /\d+\.\d+\.\d+/.test(text(value))), only: 'linux' },
    { id: 'claude-usage-file', stepId: 'pacing', name: 'Claude usage helper file', fix: 'Start a Claude session in the factory. Check that Claude usage helper in factories is on in Settings. Run doctor again.', pass: (value) => Number.isFinite(value) && value >= 0 && value <= DOCTOR_CLAUDE_USAGE_MAX_AGE_MS, request: { kind: 'claude-usage-age' }, only: 'linux' },
    { ...command('claude-version', 'pacing', 'Claude version', 'claude', ['--version'], 'Install Claude Code in the factory image. The status line helper runs inside it.', (value) => /\d+\.\d+\.\d+/.test(text(value))), only: 'linux' },
    { id: 'service-answers', stepId: 'dashboard', name: 'Service answers', fix: 'Run bin/herdr-boss install from the Herdr Boss folder. Run doctor again after the service starts.', pass: (value) => value?.status === 200 && value.body?.schema === 1 && value.body?.contractVersion === '1.0.0' && typeof value.body?.version === 'string' && /^[a-f0-9]{12,64}$/.test(value.body?.kitRevision), request: { kind: 'health' } },
  ];
  if (factoryHost) rows.push(
    command('docker', 'tools', 'Docker', 'docker', ['context', 'inspect'], 'Install Docker on this factory host. Run docker context inspect to check its saved context.', (value) => {
      const contexts = json(value);
      return Array.isArray(contexts) && contexts.some((context) => nonempty(context?.Name) && nonempty(context?.Endpoints?.docker?.Host));
    }),
    command('docker-contexts', 'tools', 'Docker contexts', 'docker', ['context', 'ls', '--format', '{{json .}}'], 'Create one Docker context for each host with herdr-boss factory host add NAME --docker-context CONTEXT.', (value) => text(value).split('\n').some((line) => nonempty(json(line)?.Name))),
  );
  return rows;
}

function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    const { signal, timeout, ...spawnOptions } = options;
    if (signal?.aborted) { reject(signal.reason); return; }
    // A new POSIX process group belongs only to this probe and its helpers.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { ...spawnOptions, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let finished = false;
    let timer;
    const stop = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) stop();
      // Do not retain a pipe or a child handle if a helper escapes the group.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      // Codex login status can use stderr. Keep warnings out of JSON probes.
      else resolve(stdout.trim() || stderr.trim());
    };
    const abort = () => finish(signal.reason ?? new Error('Command aborted.'));
    const capture = (chunk, stream) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { finish(new Error('Command output is too large.')); return; }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => capture(chunk, 'stderr'));
    child.once('error', finish);
    child.once('exit', () => { if (!finished) stop(); });
    child.once('close', (code) => finish(code === 0 ? null : new Error('Command did not pass.')));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('Command timed out.')), timeout);
    if (signal?.aborted) abort();
  });
}

// A runner accepts a read request and { signal, timeout }. Tests replace the whole
// runner; they never call real tools, package managers, or the network.
export function createDoctorRunner({ home = os.homedir(), env = process.env, platform = os.platform(), uid = process.getuid?.() ?? 0, diskSpaceReader = readFreeSpace } = {}) {
  const openCodeDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const openCodeFiles = ['opencode.json', 'opencode.jsonc'].map((file) => path.join(openCodeDir, file));
  const allowed = ['.claude/settings.json', '.codex/config.toml', '.codex/rules/herdr.rules'].map((file) => path.join(home, file)).concat(openCodeFiles);
  const accessDir = path.join(home, '.config', 'herdr-boss');
  const bossData = [path.join(home, '.herdr-boss'), accessDir, env.HERDR_BOSS_DIR].filter(Boolean);
  const otherPrivate = ['.claude/.credentials.json', '.claude.json', '.claude/projects', '.codex/auth.json', '.codex/sessions', '.codex/history.jsonl', '.pi/agent', '.config/gh', '.config/opencode/auth.json', '.ssh', '.aws', '.gnupg'].map((file) => path.join(home, file));
  otherPrivate.push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode'));
  const inPrivateData = async (realFile, entries) => {
    for (const entry of entries) {
      // Resolve metadata only, so aliases cannot turn private data into settings.
      let canonical;
      try { canonical = await fs.realpath(entry); }
      catch (error) { if (error.code !== 'ENOENT') throw error; canonical = path.resolve(entry); }
      if (inside(realFile, canonical)) return true;
    }
    return false;
  };
  const readSettings = async (file, signal) => {
    if (!allowed.includes(file)) throw new Error('This settings file is outside the doctor scope.');
    const realFile = await fs.realpath(file);
    if (await inPrivateData(realFile, bossData)) throw new Error('Do not read private Herdr Boss data.');
    if (await inPrivateData(realFile, otherPrivate)) throw new Error('Do not read private tool data.');
    const stat = await fs.stat(realFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The settings file is not a small regular file.');
    return fs.readFile(realFile, { encoding: 'utf8', signal });
  };
  const run = async (request, { signal, timeout }) => {
    if (signal.aborted) throw signal.reason;
    switch (request.kind) {
      case 'platform': return platform;
      case 'memory': return os.totalmem();
      case 'command': return exec(request.command, request.args, { signal, timeout, env, cwd: ROOT });
      case 'service': return platform === 'darwin'
        ? exec('launchctl', ['print', `gui/${uid}/${LABEL}`], { signal, timeout, env })
        : exec('systemctl', ['--user', 'is-active', 'herdr-boss.service'], { signal, timeout, env });
      case 'directory': {
        const realDir = await fs.realpath(request.file);
        if (await inPrivateData(realDir, [accessDir, ...otherPrivate])) return false;
        const stat = await fs.stat(realDir);
        if (!stat.isDirectory()) return false;
        await fs.access(realDir, constants.R_OK | constants.W_OK | constants.X_OK);
        return true;
      }
      case 'disk': {
        const files = Array.isArray(request.files) ? request.files : [request.file];
        const values = await Promise.all(files.filter(Boolean).map((file) => diskSpaceReader(file)));
        return values.length === 1 ? values[0] : values;
      }
      // Return the age of the newest helper file in milliseconds, or null. Only the modification time is read, never the content.
      case 'claude-usage-age': {
        const dir = claudeRateLimitsDir(env.HERDR_BOSS_DIR || path.join(home, '.herdr-boss'));
        let newest = null;
        for (const name of await fs.readdir(dir).catch(() => [])) {
          if (!name.endsWith('.json')) continue;
          const stat = await fs.stat(path.join(dir, name)).catch(() => null);
          if (stat?.isFile() && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
        }
        return newest === null ? null : Math.max(0, Date.now() - newest);
      }
      case 'read': return readSettings(request.file, signal);
      case 'opencode-settings': {
        for (const file of openCodeFiles) {
          try { return await readSettings(file, signal); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        throw new Error('No OpenCode settings file.');
      }
      case 'health': {
        const port = Number(env.HERDR_BOSS_PORT || 4477);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port.');
        return new Promise((resolve, reject) => {
          const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', signal, timeout }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(new Error('Health reply too large.')); });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body: json(body) }));
          });
          req.on('timeout', () => req.destroy(new Error('Health check timed out.')));
          req.on('error', reject);
        });
      }
      default: throw new Error('Unknown doctor probe.');
    }
  };
  return run;
}

export async function runDoctor({ home = os.homedir(), env = process.env, factoryHost = false, stepId, timeoutMs = DOCTOR_TIMEOUT_MS, runner = createDoctorRunner({ home, env }) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The doctor timeout must be a positive number.');
  const items = [];
  let platform = 'linux';
  for (const check of checks({ home, env, factoryHost })) {
    // Setup checks one shared step at a time. The OS probe selects its installer text.
    if (stepId && check.stepId !== stepId && check.id !== 'os') continue;
    if (check.only && check.only !== platform) continue;
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    let good = false;
    let value;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Check timed out.')); }, timeoutMs);
      });
      value = await Promise.race([Promise.resolve().then(() => runner({ ...check.request, id: check.id }, { signal: controller.signal, timeout: timeoutMs })), deadline]);
      if (check.id === 'os') platform = value === 'darwin' ? 'darwin' : 'linux';
      good = check.pass(value) === true;
    } catch { /* Print fixed words only, never a probe error or its output. */ }
    finally { clearTimeout(timer); }
    if (stepId && check.stepId !== stepId) continue;
    const fix = DOCTOR_INSTALL_FIXES[check.id]?.[platform] ?? check.fix;
    const diskStats = check.id === 'disk' && value ? (Array.isArray(value) ? value : [value]) : [];
    const diskValues = diskStats.map((stat) => Number(stat?.bavail) * Number(stat?.bsize)).filter((bytes) => Number.isFinite(bytes) && bytes >= 0);
    const diskBytes = check.id === 'disk' && diskValues.length ? Math.min(...diskValues) : null;
    const diskSeverity = check.id === 'disk'
      ? Number.isFinite(diskBytes) ? (diskBytes < DOCTOR_MIN_DISK_BYTES ? 'error' : diskBytes < DOCTOR_DISK_NOTE_BYTES ? 'note' : 'info') : 'error'
      : null;
    const message = check.id === 'disk'
      ? Number.isFinite(diskBytes)
        ? `Disk has ${(diskBytes / 1_000_000_000).toFixed(1)} GB free.`
        : 'Disk free space could not be read.'
      : good ? `${check.name} is good.` : `${check.name} ${timedOut ? 'check timed out' : 'needs a fix'}.`;
    items.push({ id: check.id, stepId: check.stepId, name: check.name, status: good ? 'green' : 'red', ...(diskSeverity ? { severity: diskSeverity } : {}), ...(diskBytes !== null && Number.isFinite(diskBytes) ? { freeBytes: diskBytes } : {}), message, fix: good ? null : fix });
  }
  const ok = items.every((item) => item.status === 'green');
  return { schema: 'herdr-boss.doctor/1', ok, exitCode: ok ? 0 : 4, items };
}

export async function doctorCommand(args, { output = console.log, ...options } = {}) {
  if (args.some((arg) => !['--json', '--factory-host'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Usage: doctor [--json] [--factory-host]');
  const report = await runDoctor({ ...options, factoryHost: args.includes('--factory-host') });
  if (args.includes('--json')) output(JSON.stringify(report, null, 2));
  else for (const item of report.items) {
    const level = item.id === 'disk' && item.severity === 'note' ? 'note'
      : item.id === 'disk' && item.severity === 'error' ? 'error' : item.status;
    output(`${level}: ${item.message}${item.fix ? ` Fix: ${item.fix}` : ''}`);
  }
  return report.exitCode;
}
