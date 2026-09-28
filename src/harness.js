// Harness settings that Herdr Boss orchestration needs. See docs/harness-setup.md.
// Never print a setting value that is not a path: the settings files can hold keys.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'kit', 'templates', 'harness');
const MODELS_FILE = path.join(ROOT, 'kit', 'models.json');
const SECTION = '[sandbox_workspace_write]';
const FORBIDDEN_PS = ['e', '-E', 'eww', 'auxe', 'auxeww'];
const PROJECTS_LINE = '**Herdr Boss projects**';
const LAUNCH_FLAGS = {
  claude: [['--permission-mode', 'auto']],
  codex: [['-s', 'workspace-write']],
  opencode: [['--agent', 'worker']],
  pi: [['--no-approve'], ['--no-extensions'], ['-e', '~/.pi/agent/extensions/herdr-guard.ts']],
};

function homeDir() { return os.homedir(); }
function registryFile(dataDir = DATA_DIR) { return path.join(dataDir, 'project-repos.json'); }
function codexConfigFile(home) { return path.join(home, '.codex', 'config.toml'); }

// Remove the user information of an http(s) URL and the password of any other URL.
// An scp-style remote such as git@host:owner/repo holds no credential.
export function stripRemoteCredentials(remote) {
  const text = String(remote || '').trim();
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@(.*)$/i.exec(text);
  if (!match) return text;
  const [, scheme, user, rest] = match;
  if (/^https?:\/\//i.test(scheme)) return `${scheme}${rest}`;
  return `${scheme}${user.split(':')[0]}@${rest}`;
}

export function readProjectRepos(dataDir = DATA_DIR) {
  try {
    const rows = JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8'));
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.slug === 'string' && typeof row.repo === 'string' && row.repo) : [];
  } catch { return []; }
}

// The first record for a slug is the project registration. A later publish keeps it.
export function recordProjectRepo(slug, repo, remote, { dataDir = DATA_DIR } = {}) {
  if (!repo || !fs.existsSync(repo)) return { recorded: false, isNew: false };
  const rows = readProjectRepos(dataDir);
  if (rows.some((row) => row.slug === slug)) return { recorded: false, isNew: false };
  rows.push({ slug, repo, remote: stripRemoteCredentials(remote) });
  const file = registryFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(`${file}.tmp`, 0o600);
  fs.renameSync(`${file}.tmp`, file);
  return { recorded: true, isNew: true };
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function samePath(a, b) { return path.resolve(a) === path.resolve(b); }
function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Parse one TOML array body of plain strings. Return null for anything else, such as a comment.
function parseStringArray(body) {
  const items = [];
  const string = /"((?:[^"\\\n]|\\["\\])*)"|'([^'\n]*)'/y;
  let index = 0;
  const skip = () => { while (index < body.length && /\s/.test(body[index])) index += 1; };
  for (;;) {
    skip();
    if (index >= body.length) return items;
    string.lastIndex = index;
    const match = string.exec(body);
    if (!match) return null;
    items.push({ raw: match[0], value: match[1] != null ? match[1].replace(/\\(["\\])/g, '$1') : match[2] });
    index = string.lastIndex;
    skip();
    if (index >= body.length) return items;
    if (body[index] !== ',') return null;
    index += 1;
  }
}

// Find [sandbox_workspace_write] writable_roots. Return { error } when the text is not safe to rewrite.
export function parseCodexRoots(text) {
  const lines = text.split('\n');
  const headers = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /^\[/.test(line));
  const sections = headers.filter(({ line }) => line === SECTION);
  if (!sections.length) return { error: `no ${SECTION} section` };
  if (sections.length > 1) return { error: `more than one ${SECTION} section` };
  const start = sections[0].index;
  const next = headers.find(({ index }) => index > start);
  const end = next ? next.index : lines.length;
  const keys = [];
  for (let index = start + 1; index < end; index += 1) if (/^\s*writable_roots\s*=/.test(lines[index])) keys.push(index);
  if (!keys.length) return { error: 'no writable_roots array in the section' };
  if (keys.length > 1) return { error: 'more than one writable_roots key in the section' };
  const first = keys[0];
  const open = /^(\s*)writable_roots\s*=\s*\[(.*)$/.exec(lines[first]);
  if (!open) return { error: 'writable_roots is not an array' };
  let body = open[2];
  let last = first;
  while (!body.includes(']')) {
    last += 1;
    if (last >= end) return { error: 'the writable_roots array has no closing bracket' };
    body += `\n${lines[last]}`;
  }
  const close = body.indexOf(']');
  if (body.slice(close + 1).trim() !== '') return { error: 'text after the writable_roots array' };
  const items = parseStringArray(body.slice(0, close));
  if (!items) return { error: 'the writable_roots array holds something other than plain strings' };
  return { lines, first, last, indent: open[1], items };
}

export function requiredRoots({ home = homeDir(), dataDir = DATA_DIR } = {}) {
  const projects = readProjectRepos(dataDir).map((row) => ({ path: path.join(row.repo, '.git'), slug: row.slug }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return [{ path: path.join(home, '.herdr-boss'), slug: null }, ...projects];
}

function quote(value) { return JSON.stringify(value); }

function addLines(roots) {
  return [SECTION, 'writable_roots = [', ...roots.map((root) => `  ${quote(root)},`), ']'];
}

function remoteName(remote) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote || '');
  return match ? match[1] : (remote || 'no remote');
}

export function projectList(dataDir = DATA_DIR) {
  return readProjectRepos(dataDir).map((row) => `${row.repo} (${remoteName(row.remote)})`).join(', ');
}

export function fillTemplate(text, { home = homeDir(), dataDir = DATA_DIR, url = 'http://127.0.0.1:4477' } = {}) {
  const values = { HOME: home, UID: String(process.getuid?.() ?? ''), HERDR_BOSS_REPO: ROOT, HERDR_BOSS_URL: url, PROJECT_LIST: projectList(dataDir) };
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (all, name) => (name in values ? values[name] : all));
}

function stamp(date = new Date()) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

// Add the missing writable roots to ~/.codex/config.toml. Keep every other line.
export function syncCodex({ home = homeDir(), dataDir = DATA_DIR, dryRun = false, now = new Date() } = {}) {
  const file = codexConfigFile(home);
  const wanted = requiredRoots({ home, dataDir });
  const out = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    out.push(`No Codex config at ${file}. Nothing was changed. Add these lines to it:`, ...addLines(wanted.map((root) => root.path)));
    return { ok: false, changed: false, added: [], lines: out };
  }
  const parsed = parseCodexRoots(text);
  if (parsed.error) {
    out.push(`${file}: ${parsed.error}. Nothing was changed. Add these lines to ${SECTION} by hand:`, ...addLines(wanted.map((root) => root.path)));
    return { ok: false, changed: false, added: [], lines: out };
  }
  const existing = parsed.items.map((item) => expandHome(item.value, home));
  const missing = wanted.filter((root) => !existing.some((entry) => samePath(entry, root.path)));
  if (!missing.length) {
    out.push(`Codex writable_roots in ${file}: nothing to add.`);
    return { ok: true, changed: false, added: [], lines: out };
  }
  if (dryRun) {
    out.push(`Dry run. harness sync would add these writable_roots to ${file}:`, ...missing.map((root) => `+ ${quote(root.path)}`));
    return { ok: true, changed: false, added: missing.map((root) => root.path), lines: out };
  }
  const indent = parsed.indent + '  ';
  const entries = [...parsed.items.map((item) => item.raw), ...missing.map((root) => quote(root.path))];
  const array = [`${parsed.indent}writable_roots = [`, ...entries.map((entry) => `${indent}${entry},`), `${parsed.indent}]`];
  const lines = [...parsed.lines.slice(0, parsed.first), ...array, ...parsed.lines.slice(parsed.last + 1)];
  const backup = `${file}.bak-${stamp(now)}`;
  const mode = fs.statSync(file).mode & 0o777;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, mode);
  fs.writeFileSync(`${file}.tmp`, lines.join('\n'), { mode });
  fs.chmodSync(`${file}.tmp`, mode);
  fs.renameSync(`${file}.tmp`, file);
  out.push(`Backed up ${file} to ${backup}.`, `Codex writable_roots: added ${missing.map((root) => root.path).join(', ')}.`);
  return { ok: true, changed: true, added: missing.map((root) => root.path), backup, lines: out };
}

export function claudeLines(options = {}) {
  const template = fs.readFileSync(path.join(TEMPLATES, 'claude-automode.json'), 'utf8');
  return [
    'Claude: the Owner pastes these lines into "autoMode" in ~/.claude/settings.json. Herdr Boss does not edit that file.',
    'Merge "environment" into autoMode.environment. Merge "allow" into autoMode.allow, with "$defaults" first.',
    ...fillTemplate(template, options).trimEnd().split('\n'),
  ];
}

export function syncHarness({ codexOnly = false, ...options } = {}) {
  const codex = syncCodex(options);
  const lines = [...codex.lines];
  if (!codexOnly) lines.push('', ...claudeLines(options));
  return { ...codex, lines };
}

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) { return { error: error.code === 'ENOENT' ? 'missing' : 'not valid JSON' }; }
}

// Remove // and /* */ comments and trailing commas outside strings, for opencode.jsonc.
function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const match = end.exec(text);
      if (!match) return out + text.slice(i);
      out += match[0];
      i = end.lastIndex - 1;
    } else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { const close = text.indexOf('*/', i + 2); i = close < 0 ? text.length : close + 1; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function openCodeWorker(home) {
  const dir = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'opencode') : path.join(home, '.config', 'opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(stripJsonComments(text)); } catch { return { file, status: 'bad', note: 'is not valid JSON' }; }
    // Read the .agent.worker key only. Print no value.
    const worker = data?.agent?.worker;
    const present = worker != null && typeof worker === 'object' && !Array.isArray(worker);
    return { file, status: present ? 'ok' : 'missing' };
  }
  return { file: path.join(dir, 'opencode.json'), status: 'missing', note: 'no config file' };
}

function hasFlags(args, flags) {
  for (let i = 0; i + flags.length <= args.length; i += 1) if (flags.every((flag, j) => args[i + j] === flag)) return true;
  return false;
}

// Return one finding per checked entry: { status: ok|missing|bad, area, text }.
export function checkHarness({ home = homeDir(), dataDir = DATA_DIR, modelsFile = MODELS_FILE } = {}) {
  const findings = [];
  const add = (status, area, text) => findings.push({ status, area, text });
  const projects = readProjectRepos(dataDir);

  const configFile = codexConfigFile(home);
  let codexText = null;
  try { codexText = fs.readFileSync(configFile, 'utf8'); } catch {}
  const parsed = codexText == null ? { error: `no Codex config at ${configFile}` } : parseCodexRoots(codexText);
  if (parsed.error) add('missing', 'codex writable_roots', `${parsed.error}; run herdr-boss harness sync`);
  else {
    const roots = parsed.items.map((item) => expandHome(item.value, home));
    const herdrBoss = path.join(home, '.herdr-boss');
    add(roots.some((root) => samePath(root, herdrBoss)) ? 'ok' : 'missing', 'codex writable_roots', herdrBoss);
    const secret = path.join(home, '.config', 'herdr-boss');
    const exposing = roots.filter((root) => inside(secret, root));
    if (exposing.length) add('bad', 'codex writable_roots', `${exposing.join(', ')} makes ${secret} writable; ${secret} must not be writable`);
    else add('ok', 'codex writable_roots', `${secret} is not writable`);
    for (const project of projects) {
      const git = path.join(project.repo, '.git');
      add(roots.some((root) => samePath(root, git)) ? 'ok' : 'missing', 'codex writable_roots', `${git} (${project.slug})`);
    }
  }

  const rulesFile = path.join(home, '.codex', 'rules', 'herdr.rules');
  let rules = null;
  try { rules = fs.readFileSync(rulesFile, 'utf8'); } catch {}
  if (rules == null) add('missing', 'codex rules', `${rulesFile}`);
  else {
    const forbidden = new Set();
    for (const line of rules.split('\n')) {
      const match = /^\s*prefix_rule\(\s*pattern\s*=\s*\[\s*"ps"\s*,\s*"([^"]+)"\s*\]\s*,\s*decision\s*=\s*"forbidden"\s*\)/.exec(line);
      if (match) forbidden.add(match[1]);
    }
    for (const arg of FORBIDDEN_PS) add(forbidden.has(arg) ? 'ok' : 'missing', 'codex rules', forbidden.has(arg) ? `ps ${arg} is forbidden` : `ps ${arg} is not forbidden in ${rulesFile}`);
  }

  // Read the autoMode key only.
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const settings = readJson(settingsFile);
  const environment = settings.value?.autoMode?.environment;
  if (settings.error) add(settings.error === 'missing' ? 'missing' : 'bad', 'claude autoMode', `${settingsFile} is ${settings.error}`);
  else if (!Array.isArray(environment)) add('missing', 'claude autoMode', `${settingsFile} has no autoMode.environment`);
  else {
    const line = environment.find((entry) => typeof entry === 'string' && entry.startsWith(PROJECTS_LINE));
    if (!line) add('missing', 'claude autoMode', `${PROJECTS_LINE} line`);
    for (const project of projects) {
      if (!line) continue;
      const escaped = project.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const named = new RegExp(`(^|[\\s,:])${escaped}(?=$|[\\s,.;)(])`).test(line);
      add(named ? 'ok' : 'missing', 'claude autoMode', `${PROJECTS_LINE} ${named ? 'names' : 'does not name'} ${project.repo} (${project.slug})`);
    }
  }

  const opencode = openCodeWorker(home);
  add(opencode.status, 'opencode', opencode.status === 'ok' ? 'agent worker exists' : `agent worker: ${opencode.file} ${opencode.note || 'has no agent.worker'}`);

  const guard = path.join(home, '.pi', 'agent', 'extensions', 'herdr-guard.ts');
  add(fs.existsSync(guard) ? 'ok' : 'missing', 'pi', guard);

  const models = readJson(modelsFile);
  for (const [kind, flagSets] of Object.entries(LAUNCH_FLAGS)) {
    const args = models.value?.kinds?.[kind]?.launchArgs || [];
    for (const flags of flagSets) add(hasFlags(args, flags) ? 'ok' : 'missing', `models.json ${kind}`, flags.join(' '));
  }
  return findings;
}

// The variables that a Codex worker tool shell needs. A Codex tool shell can run under a shared app-server daemon,
// which has the daemon environment and not the pane environment. So worker start passes each value explicitly.
export const CODEX_SHELL_ENV = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'TMPDIR', 'HERDR_WORKTREE'];

// Return one -c shell_environment_policy.set.NAME="value" pair per known value, as array items for execFile.
// A value that is null, undefined, or empty is left out. The error names the variable, never the value.
export function codexShellEnvArgs(values) {
  const args = [];
  for (const name of CODEX_SHELL_ENV) {
    const value = values[name];
    if (value == null || value === '') continue;
    if (/["'\\\u0000-\u001f\u007f]/.test(String(value))) throw new Error(`The value of ${name} has a quote, a backslash, or a control character. Codex cannot receive it as a TOML string.`);
    args.push('-c', `shell_environment_policy.set.${name}="${value}"`);
  }
  return args;
}

const LIVE_PROMPT = "Run this exact shell command and print its output line and nothing else: sh -c 'echo HERDR_ENV=${HERDR_ENV:+set} PANE=${HERDR_PANE_ID:+set}'";

// Run one codex exec with the worker shell variables of the caller pane. Report only set or missing, never a value.
export function liveCodexCheck({ env = process.env, modelsFile = MODELS_FILE, timeoutMs = 180_000, run = spawnSync } = {}) {
  const area = 'codex live';
  const values = { HERDR_ENV: 'missing', HERDR_PANE_ID: 'missing' };
  const finding = (status, note) => ({ status, area, values, text: `HERDR_ENV ${values.HERDR_ENV}, HERDR_PANE_ID ${values.HERDR_PANE_ID}${note ? ` (${note})` : ''}` });
  const models = readJson(modelsFile);
  const model = models.value?.kinds?.codex?.defaultModel;
  if (!model) return finding('bad', `no codex default model in ${modelsFile}`);
  let envArgs;
  try {
    envArgs = codexShellEnvArgs(Object.fromEntries(CODEX_SHELL_ENV.map((name) => [name, name === 'HERDR_ENV' ? (env.HERDR_ENV ? '1' : null) : env[name]])));
  } catch (error) { return finding('bad', error.message); }
  const args = ['exec', '-m', model, '-c', 'model_reasoning_effort=low', '-s', 'workspace-write', '--skip-git-repo-check', ...envArgs, LIVE_PROMPT];
  const result = run('codex', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (result.error?.code === 'ETIMEDOUT' || (result.signal && result.status == null)) return finding('bad', `codex exec timed out after ${Math.round(timeoutMs / 1000)} s`);
  if (result.error) return finding('bad', result.error.code === 'ENOENT' ? 'codex is not on PATH' : 'codex exec did not start');
  if (result.status !== 0) return finding('bad', `codex exec exited with status ${result.status}`);
  const matches = [...String(result.stdout ?? '').matchAll(/HERDR_ENV=(set)?[ \t]+PANE=(set)?(?=\s|$)/gm)];
  const last = matches.at(-1);
  if (!last) return finding('bad', 'codex printed no result line');
  values.HERDR_ENV = last[1] ? 'set' : 'missing';
  values.HERDR_PANE_ID = last[2] ? 'set' : 'missing';
  return finding(last[1] && last[2] ? 'ok' : 'missing');
}

export function formatFinding({ status, area, text }) { return `${status.padEnd(7)} ${area}: ${text}`; }
