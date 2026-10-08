// Harness settings that Herdr Boss orchestration needs. See docs/harness-setup.md.
// Never print a setting value that is not a path: the settings files can hold keys.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { expandHome, sharedWorktreeRoot } from './kit/config.js';
import { recordHarnessFacts } from './harness-facts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'kit', 'templates', 'harness');
const MODELS_FILE = path.join(ROOT, 'kit', 'models.json');
const SECTION = '[sandbox_workspace_write]';
const STOP_OWN_RULE = 'prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")';
// Only an exact three-component prefix_rule with decision allow or forbidden counts. A commented,
// malformed, broader, or prompt line does not count.
const STOP_OWN_RULE_PATTERN = /^\s*prefix_rule\(\s*pattern\s*=\s*\[\s*"herdr-boss"\s*,\s*"worker"\s*,\s*"stop-own"\s*\]\s*,\s*decision\s*=\s*"(allow|forbidden)"\s*\)/;
const STOP_OWN_COMMENT = '# A worker stops its own process through the helper, never with a raw signal.';
const RELEASE_COMMANDS = ['request', 'publish'];
const CLAUDE_RELEASE_RULES = {
  request: 'Run only `herdr-boss release request`.',
  publish: 'Run only `herdr-boss release publish`.',
};
const FORBIDDEN_PS = ['e', '-E', 'eww', 'auxe', 'auxeww'];
const PROJECTS_LABEL = 'Herdr Boss projects';
const PROJECTS_LINE = `**${PROJECTS_LABEL}**`;
const MARKER_FILE = 'docs/orchestration/herdr-boss.md';
const MAX_PARENTS = 10;
const LAUNCH_FLAGS = {
  claude: [['--permission-mode', 'auto']],
  codex: [['-s', 'workspace-write']],
  opencode: [['--agent', 'worker']],
  pi: [['--no-approve'], ['--no-extensions'], ['-e', '~/.pi/agent/extensions/herdr-guard.ts']],
};
// A fixed label for each launch-argument check. The label holds no value from the models file.
const LAUNCH_LABELS = {
  claude: 'Claude launch arguments',
  codex: 'Codex launch arguments',
  opencode: 'OpenCode launch arguments',
  pi: 'Pi launch arguments',
};

function homeDir() { return os.homedir(); }
function registryFile(dataDir = DATA_DIR) { return path.join(dataDir, 'project-repos.json'); }
function temporaryFile(file, contents) {
  const temporary = `${file}.${Date.now()}-${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    return temporary;
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
function backupRegistry(file, contents) {
  const stamp = Date.now();
  let backup;
  for (let suffix = 0; backup === undefined; suffix += 1) {
    const candidate = `${file}.${stamp}-${process.pid}${suffix ? `-${suffix}` : ''}.bak`;
    try {
      const descriptor = fs.openSync(candidate, 'wx', 0o600);
      fs.closeSync(descriptor);
      backup = candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  const temporary = `${backup}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, backup);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    try { fs.unlinkSync(backup); } catch {}
    throw error;
  }
  return backup;
}
function codexConfigFile(home) { return path.join(home, '.codex', 'config.toml'); }
function codexRulesFile(home) { return path.join(home, '.codex', 'rules', 'herdr.rules'); }
// The state of the exact stop-own rule in a rules file: 'allow', 'forbidden', 'conflict', or null.
// 'forbidden' means only an exact forbidden rule exists. 'conflict' means an exact allow rule and an
// exact forbidden rule exist at the same time. Both check and sync use this helper.
function stopOwnRuleState(text) {
  let allow = false;
  let forbidden = false;
  for (const line of String(text).split('\n')) {
    const decision = STOP_OWN_RULE_PATTERN.exec(line)?.[1];
    if (decision === 'allow') allow = true;
    else if (decision === 'forbidden') forbidden = true;
  }
  if (allow && forbidden) return 'conflict';
  if (forbidden) return 'forbidden';
  return allow ? 'allow' : null;
}

// Read one exact Codex command prefix. A broader, malformed, commented, or prompt rule does not count.
function codexPrefixRuleState(text, target) {
  let allow = false;
  let forbidden = false;
  for (const line of String(text).split('\n')) {
    const match = /^\s*prefix_rule\(\s*pattern\s*=\s*(\[[^\]]*\])\s*,\s*decision\s*=\s*"(allow|forbidden)"\s*\)\s*$/.exec(line);
    if (!match) continue;
    let pattern;
    try { pattern = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(pattern) || pattern.length !== target.length || pattern.some((part, index) => part !== target[index])) continue;
    if (match[2] === 'allow') allow = true;
    else forbidden = true;
  }
  if (allow && forbidden) return 'conflict';
  if (forbidden) return 'forbidden';
  return allow ? 'allow' : null;
}

// Remove URL credentials and query data before a remote can leave its source file.
// An scp-style remote has a strict fallback because URL cannot parse its form.
export function stripRemoteCredentials(remote) {
  const text = String(remote || '').trim();
  if (/%(3f|23|3b|40)|;/i.test(text)) return '';
  const cleanUrl = (url) => {
    if (url.protocol === 'http:' || url.protocol === 'https:') url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return cleanUrl(new URL(text));
    } catch {
      // A slash inside an HTTP password makes the URL invalid. Recover only when the
      // authority cannot parse and the suffix after @ is a valid host and path.
      const match = /^(https?:\/\/)([^@\s]+)@([^\s]+)$/i.exec(text);
      if (!match || !match[2].includes(':') || /\s/.test(text)) return '';
      try {
        return cleanUrl(new URL(`${match[1]}${match[3].split(/[?#]/, 1)[0]}`));
      } catch {
        return '';
      }
    }
  }
  const scp = /^([^@/:\s]+)(?::([^@/\s]*))?@([^@/:\s]+):([^\s?#]+)$/.exec(text);
  if (scp) return `${scp[1]}@${scp[3]}:${scp[4]}`;
  if (text.includes('@') || text.includes('?') || text.includes('#')) return '';
  return text;
}

export function readProjectRepos(dataDir = DATA_DIR) {
  try {
    const rows = JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8'));
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.slug === 'string' && typeof row.repo === 'string' && row.repo) : [];
  } catch { return []; }
}

export function unregisterProjectRepo(slug, { dataDir = DATA_DIR } = {}) {
  const file = registryFile(dataDir);
  let rows;
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
    rows = JSON.parse(contents);
  } catch { return { removed: false, backup: null }; }
  if (!Array.isArray(rows) || !rows.some((row) => row && row.slug === slug)) return { removed: false, backup: null };

  const backup = backupRegistry(file, contents);

  let temporary;
  try {
    const kept = rows.filter((row) => row?.slug !== slug);
    temporary = temporaryFile(file, `${JSON.stringify(kept, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch {}
    }
    throw error;
  }
  return { removed: true, backup };
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
  return [{ path: path.join(home, '.herdr-boss'), slug: null }, { path: sharedWorktreeRoot(home, dataDir), slug: null }, ...projects];
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
  return text.replaceAll('{{HOME}}/Projects/.herdr-wt', sharedWorktreeRoot(home, dataDir))
    .replace(/\{\{([A-Z_]+)\}\}/g, (all, name) => (name in values ? values[name] : all));
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

// Add the stop-own allow rule to ~/.codex/rules/herdr.rules. Keep every other line.
// The rule goes before the first forbidden rule, as in the template. A missing rules file is not a
// failure: the Owner copies the template, and harness check reports the missing file. An exact
// forbidden rule or an allow-plus-forbidden pair is a conflict: sync writes nothing, because an
// allow rule does not establish effective permission over an explicit deny.
export function syncCodexRules({ home = homeDir(), dryRun = false, now = new Date() } = {}) {
  const file = codexRulesFile(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: true, changed: false, lines: [`No Codex rules at ${file}. Nothing was changed. Add this line to it:`, STOP_OWN_RULE] };
  }
  const state = stopOwnRuleState(text);
  if (state === 'allow') return { ok: true, changed: false, lines: [`Codex rules in ${file}: nothing to add.`] };
  if (state === 'forbidden') {
    return { ok: false, changed: false, lines: [`Codex rules in ${file} forbid the stop-own rule. Conflict: harness sync writes nothing, because an allow rule does not override an explicit forbidden rule. Remove the forbidden rule yourself.`] };
  }
  if (state === 'conflict') {
    return { ok: false, changed: false, lines: [`Codex rules in ${file} allow and forbid the stop-own rule at the same time. Conflict: harness sync writes nothing. Remove one of the two rules yourself.`] };
  }
  if (dryRun) return { ok: true, changed: false, lines: [`Dry run. harness sync would add this line to ${file}:`, `+ ${STOP_OWN_RULE}`] };
  let body = text.replace(/\n+$/, '').split('\n');
  if (body.length === 1 && body[0] === '') body = [];
  const index = body.findIndex((line) => /decision\s*=\s*"forbidden"/.test(line));
  const at = index < 0 ? body.length : index;
  const next = [...body.slice(0, at), STOP_OWN_COMMENT, STOP_OWN_RULE, ...body.slice(at)].join('\n');
  const backup = `${file}.bak-${stamp(now)}`;
  const mode = fs.statSync(file).mode & 0o777;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, mode);
  fs.writeFileSync(`${file}.tmp`, `${next}\n`, { mode });
  fs.chmodSync(`${file}.tmp`, mode);
  fs.renameSync(`${file}.tmp`, file);
  return { ok: true, changed: true, backup, lines: [`Backed up ${file} to ${backup}.`, `Codex rules: added the stop-own rule to ${file}.`] };
}

function normalizedClaudeLine(line, home) {
  return String(line).split(home).join('~').replace(/\s+/g, ' ').trim();
}

function claudeLineLabel(line) {
  return /^\*\*(.+?)\*\*:/.exec(String(line).trim())?.[1] ?? null;
}

// The path test of checkHarness(): a path is named only when no path character touches it.
function namesClaudePath(line, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,:])${escaped}(?=$|[\\s,.;)(])`).test(line);
}

// A folder is also named when a child follows it, as in "~/Projects/.herdr-wt/<repo>".
function namesClaudeFolder(line, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,:])${escaped}(?=$|[\\s,.;)(/])`).test(line);
}

// The real path of a folder. A path that does not exist keeps its resolved form.
function realPath(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

// A folder that the Claude line may not name as a parent: the root, the home folder, or a folder above it.
function unusableParent(parent, home) { return inside(home, parent); }

// Every folder above the repository that a parent line may name, nearest first. All paths are real paths.
function parentCandidates(repo, home) {
  const out = [];
  const realHome = realPath(home);
  for (let dir = path.dirname(realPath(repo)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (!unusableParent(dir, realHome)) out.push(dir);
  }
  return out;
}

// The folders that a line names: each word that starts with / or ~/. A .. segment is resolved.
// A trailing slash, comma, semicolon, or full stop is not part of the path, so /work/apps.old/ is not /work/apps.
function namedFolders(line, home) {
  const out = [];
  for (const match of String(line).matchAll(/(?:^|[\s,:(])((?:~|\/)[^\s,;()]*)/g)) {
    const text = match[1].replace(/[.]+$/, '');
    const expanded = text === '~' || text.startsWith('~/') ? path.join(home, text.slice(1)) : text;
    out.push(realPath(path.resolve(expanded)));
  }
  return out;
}

// The marker rule: the words holds, contains, or has, then the marker file, in a sentence that has no negation before them.
function statesMarkerRule(line) {
  const match = new RegExp(`\\b(?:holds|contains|has)\\s+(?:the\\s+)?(?:file\\s+)?${MARKER_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(line);
  if (!match) return false;
  const before = line.slice(0, match.index);
  const sentence = before.slice(before.search(/\.\s(?!.*\.\s)/) + 1 || 0);
  return !/(^|\s)(?:not|no|never)(\s|$)/i.test(sentence);
}

// Return the parent folder that a Claude projects line names for the repository, or null.
// The line must state the marker rule. A line without it names projects one by one.
export function parentCovering(line, repo, home) {
  if (!statesMarkerRule(String(line))) return null;
  const named = new Set(namedFolders(line, home));
  return parentCandidates(repo, home).find((dir) => named.has(dir)) ?? null;
}

function namesRepo(line, repo, home) {
  return namesClaudePath(normalizedClaudeLine(line, home), normalizedClaudeLine(repo, home));
}

// The parent folders for the recommended line. Each distinct parent appears once, sorted.
// A parent inside another named parent is dropped. A project that has no usable parent is named by path.
export function parentFolders(repos, home) {
  const parents = new Set();
  const single = [];
  for (const repo of repos) {
    const parent = path.dirname(path.resolve(repo));
    if (unusableParent(parent, home)) single.push(repo); else parents.add(parent);
  }
  const sorted = [...parents].sort((a, b) => a.localeCompare(b));
  const top = sorted.filter((dir) => !sorted.some((other) => other !== dir && inside(dir, other))).slice(0, MAX_PARENTS);
  const uncovered = repos.filter((repo) => !top.some((dir) => inside(repo, dir)));
  return { parents: top, single: [...new Set([...single, ...uncovered])].sort((a, b) => a.localeCompare(b)) };
}

// The recommended Herdr Boss projects line, built from the registered project repositories.
function recommendedProjectsLine(filled, repos, home) {
  const tail = /\. Worker worktrees.*$/s.exec(filled)?.[0] ?? '.';
  const { parents, single } = parentFolders(repos, home);
  if (!parents.length && !single.length) return filled;
  const parts = [];
  if (parents.length) parts.push(`every repository under ${parents.map((dir) => `${dir}/`).join(' or ')} that contains the file ${MARKER_FILE} is a Herdr Boss project, with its own origin remote only`);
  if (single.length) parts.push(`${parents.length ? 'These projects are also Herdr Boss projects' : 'the Herdr Boss projects are'}: ${single.join(', ')}`);
  const closing = parents.length ? ' A folder without that file is not a Herdr Boss project.' : '';
  return `${PROJECTS_LINE}: ${parts.join('. ')}${tail}${closing}`;
}

function compareClaudeLines(area, expected, current, home, projectsLinePaths = []) {
  const used = new Set();
  const changes = [];
  for (const line of expected) {
    const label = claudeLineLabel(line);
    const index = current.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex) || typeof candidate !== 'string') return false;
      if (label != null) return claudeLineLabel(candidate) === label;
      return normalizedClaudeLine(candidate, home) === normalizedClaudeLine(line, home);
    });
    if (index < 0) {
      changes.push(`missing ${area}: ${line}`);
      continue;
    }
    used.add(index);
    const currentText = normalizedClaudeLine(current[index], home);
    if (area === 'environment' && label === PROJECTS_LABEL) {
      const missing = projectsLinePaths.filter(({ target, folder }) => !(folder ? namesClaudeFolder(currentText, normalizedClaudeLine(target, home)) : namesRepo(current[index], target, home) || parentCovering(current[index], target, home)));
      if (missing.length) {
        changes.push(`change environment "${label}": ${line}`, `now: ${current[index]}`);
        for (const { target } of missing) changes.push(`missing path: ${target}`);
      }
      continue;
    }
    if (currentText !== normalizedClaudeLine(line, home)) {
      if (area === 'environment' && label != null) {
        changes.push(`change environment "${label}": ${line}`, `now: ${current[index]}`);
      } else changes.push(`missing ${area}: ${line}`);
    }
  }
  const extraCount = current.reduce((count, line, index) => count + (typeof line === 'string' && !used.has(index) ? 1 : 0), 0);
  return { changes, extraCount };
}

export function claudeLines(options = {}) {
  const home = options.home ?? homeDir();
  const file = path.join(home, '.claude', 'settings.json');
  const template = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'claude-automode.json'), 'utf8'));
  const expected = Object.fromEntries(Object.entries(template).map(([key, lines]) => [key, lines.map((line) => fillTemplate(line, options))]));
  const repos = readProjectRepos(options.dataDir ?? DATA_DIR).map((row) => row.repo);
  expected.environment = expected.environment.map((line) => (claudeLineLabel(line) === PROJECTS_LABEL ? recommendedProjectsLine(line, repos, home) : line));
  const settings = readJson(file);
  const autoMode = settings.value?.autoMode;
  if (settings.error || !autoMode || typeof autoMode !== 'object' || Array.isArray(autoMode)) {
    const reason = settings.error === 'missing' ? 'settings file is missing' : settings.error === 'not valid JSON' ? 'settings file is not valid JSON' : 'settings file has no autoMode key';
    return [
      `Claude ${reason}: ${file}. Add the full template below to autoMode in ~/.claude/settings.json.`,
      JSON.stringify(expected, null, 2),
    ];
  }

  const environment = Array.isArray(autoMode.environment) ? autoMode.environment : [];
  const allow = Array.isArray(autoMode.allow) ? autoMode.allow : [];
  const requiredPaths = [
    ...repos.map((repo) => ({ target: repo })),
    { target: sharedWorktreeRoot(home), folder: true },
  ];
  const environmentResult = compareClaudeLines('environment', expected.environment, environment, home, requiredPaths);
  const allowResult = compareClaudeLines('allow', expected.allow, allow, home);
  const changes = [...environmentResult.changes, ...allowResult.changes];
  const lines = changes.length
    ? ['Claude autoMode differences for ~/.claude/settings.json:', ...changes]
    : ['Claude autoMode: nothing to change.'];
  lines.push(`Owner lines kept: ${environmentResult.extraCount} environment, ${allowResult.extraCount} allow`);
  return lines;
}

function recordFactsSafely(options, recordFacts) {
  try { recordFacts(options); }
  catch { process.stderr.write('Warning: Could not record harness changes.\n'); }
}

export function syncHarness({ codexOnly = false, recordFacts = recordHarnessFacts, ...options } = {}) {
  const codex = syncCodex(options);
  const rules = syncCodexRules(options);
  // The roots decide, and a stop-own conflict also fails. A missing rules file stays a report line.
  const lines = [...codex.lines, ...rules.lines];
  if (!codexOnly) lines.push('', ...claudeLines(options));
  if (!options.dryRun) recordFactsSafely({ home: homeDir(), dataDir: DATA_DIR, modelsFile: MODELS_FILE, ...options }, recordFacts);
  return { ...codex, ok: codex.ok && rules.ok, changed: codex.changed || rules.changed, lines };
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

// Return one finding per checked entry: { status: ok|missing|bad, area, item, text }.
// item is a fixed label for the entry. It holds no path and no setting value.
export function checkHarness({ home = homeDir(), dataDir = DATA_DIR, modelsFile = MODELS_FILE, recordFacts = recordHarnessFacts } = {}) {
  const findings = [];
  const add = (status, area, item, text) => findings.push({ status, area, item, text });
  const projects = readProjectRepos(dataDir);

  const configFile = codexConfigFile(home);
  let codexText = null;
  try { codexText = fs.readFileSync(configFile, 'utf8'); } catch {}
  const parsed = codexText == null ? { error: `no Codex config at ${configFile}` } : parseCodexRoots(codexText);
  if (parsed.error) add('missing', 'codex writable_roots', 'Codex writable_roots section', `${parsed.error}; run herdr-boss harness sync`);
  else {
    const roots = parsed.items.map((item) => expandHome(item.value, home));
    const herdrBoss = path.join(home, '.herdr-boss');
    add(roots.some((root) => samePath(root, herdrBoss)) ? 'ok' : 'missing', 'codex writable_roots', 'Herdr Boss data folder', herdrBoss);
    const secret = path.join(home, '.config', 'herdr-boss');
    const exposing = roots.filter((root) => inside(secret, root));
    if (exposing.length) add('bad', 'codex writable_roots', 'Private config folder not writable', `${exposing.join(', ')} makes ${secret} writable; ${secret} must not be writable`);
    else add('ok', 'codex writable_roots', 'Private config folder not writable', `${secret} is not writable`);
    const worktrees = sharedWorktreeRoot(home, dataDir);
    add(roots.some((root) => samePath(root, worktrees)) ? 'ok' : 'missing', 'codex writable_roots', 'Worker worktrees root', `${worktrees} (worker worktrees)`);
    // Workers commit through the .git folder of the main repository.
    for (const project of projects) {
      const git = path.join(project.repo, '.git');
      add(roots.some((root) => samePath(root, git)) ? 'ok' : 'missing', 'codex writable_roots', 'Project git root', `${git} (${project.slug})`);
    }
  }

  const rulesFile = path.join(home, '.codex', 'rules', 'herdr.rules');
  let rules = null;
  try { rules = fs.readFileSync(rulesFile, 'utf8'); } catch {}
  if (rules == null) add('missing', 'codex rules', 'Codex rules file', `${rulesFile}`);
  else {
    const forbidden = new Set();
    for (const line of rules.split('\n')) {
      const match = /^\s*prefix_rule\(\s*pattern\s*=\s*\[\s*"ps"\s*,\s*"([^"]+)"\s*\]\s*,\s*decision\s*=\s*"forbidden"\s*\)/.exec(line);
      if (match) forbidden.add(match[1]);
    }
    for (const command of ['pkill', 'killall']) {
      const has = rules.split('\n').some((line) => new RegExp(`^\\s*prefix_rule\\(\\s*pattern\\s*=\\s*\\[\\s*"${command}"\\s*\\]\\s*,\\s*decision\\s*=\\s*"forbidden"\\s*\\)`).test(line));
      add(has ? 'ok' : 'missing', 'codex rules', `Forbidden ${command} rule`, has ? `${command} is forbidden` : `${command} is not forbidden in ${rulesFile}`);
    }
    // A Codex worker stops its own process with stop-own only when the rules file holds an active
    // exact allow rule. An explicit deny or a deny-plus-allow pair is a conflict, not permission.
    const stopOwn = stopOwnRuleState(rules);
    if (stopOwn === 'allow') add('ok', 'codex rules', 'Stop-own rule', `stop-own is allowed in ${rulesFile}`);
    else if (stopOwn === 'forbidden') add('bad', 'codex rules', 'Stop-own rule', `${rulesFile} forbids the stop-own rule; harness sync writes no allow rule over an explicit forbidden rule; remove the forbidden rule yourself`);
    else if (stopOwn === 'conflict') add('bad', 'codex rules', 'Stop-own rule', `${rulesFile} allows and forbids the stop-own rule at the same time; the rules conflict; remove one of the two rules`);
    else add('missing', 'codex rules', 'Stop-own rule', `${rulesFile} has no stop-own rule; run herdr-boss harness sync or add: ${STOP_OWN_RULE}`);
    for (const arg of FORBIDDEN_PS) add(forbidden.has(arg) ? 'ok' : 'missing', 'codex rules', `Forbidden ps ${arg} rule`, forbidden.has(arg) ? `ps ${arg} is forbidden` : `ps ${arg} is not forbidden in ${rulesFile}`);
    for (const command of RELEASE_COMMANDS) {
      const rule = `prefix_rule(pattern=["herdr-boss", "release", "${command}"], decision="allow")`;
      const status = codexPrefixRuleState(rules, ['herdr-boss', 'release', command]);
      if (status === 'allow') add('ok', 'codex rules', `Release ${command} permission`, `release ${command} is allowed in ${rulesFile}`);
      else if (status === 'forbidden') add('bad', 'codex rules', `Release ${command} permission`, `${rulesFile} forbids release ${command}; remove the forbidden rule before adding: ${rule}`);
      else if (status === 'conflict') add('bad', 'codex rules', `Release ${command} permission`, `${rulesFile} allows and forbids release ${command}; remove one of the conflicting rules`);
      else add('missing', 'codex rules', `Release ${command} permission`, `${rulesFile} has no release ${command} rule; add: ${rule}`);
    }
  }

  // Read the autoMode key only.
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const settings = readJson(settingsFile);
  const environment = settings.value?.autoMode?.environment;
  if (settings.error) add(settings.error === 'missing' ? 'missing' : 'bad', 'claude autoMode', 'Claude settings file', `${settingsFile} is ${settings.error}`);
  else if (!Array.isArray(environment)) add('missing', 'claude autoMode', 'Claude autoMode environment', `${settingsFile} has no autoMode.environment`);
  else {
    const line = environment.find((entry) => typeof entry === 'string' && entry.startsWith(PROJECTS_LINE));
    if (!line) add('missing', 'claude autoMode', 'Herdr Boss projects line', `${PROJECTS_LINE} line`);
    for (const project of projects) {
      if (!line) continue;
      const named = namesRepo(line, project.repo, home);
      const parent = named ? null : parentCovering(line, project.repo, home);
      if (parent) add('ok', 'claude autoMode', 'Herdr Boss projects line', `${PROJECTS_LINE} covers ${project.repo} (${project.slug}) through the parent folder ${parent}`);
      else add(named ? 'ok' : 'missing', 'claude autoMode', 'Herdr Boss projects line', `${PROJECTS_LINE} ${named ? 'names' : 'does not name'} ${project.repo} (${project.slug})`);
    }
  }
  const autoMode = settings.value?.autoMode;
  if (!settings.error) {
    const allow = Array.isArray(autoMode?.allow) ? autoMode.allow : [];
    for (const command of RELEASE_COMMANDS) {
      const rule = CLAUDE_RELEASE_RULES[command];
      const has = allow.includes(rule);
      add(has ? 'ok' : 'missing', 'claude autoMode', `Release ${command} permission`, has
        ? `release ${command} is allowed in ${settingsFile}`
        : `${settingsFile} has no autoMode.allow line for release ${command}; add: ${rule}`);
    }
  }

  const opencode = openCodeWorker(home);
  add(opencode.status, 'opencode', 'OpenCode worker agent', opencode.status === 'ok' ? 'agent worker exists' : `agent worker: ${opencode.file} ${opencode.note || 'has no agent.worker'}`);

  const guard = path.join(home, '.pi', 'agent', 'extensions', 'herdr-guard.ts');
  add(fs.existsSync(guard) ? 'ok' : 'missing', 'pi', 'Pi guard', guard);

  const models = readJson(modelsFile);
  for (const [kind, flagSets] of Object.entries(LAUNCH_FLAGS)) {
    const args = models.value?.kinds?.[kind]?.launchArgs || [];
    for (const flags of flagSets) add(hasFlags(args, flags) ? 'ok' : 'missing', `models.json ${kind}`, LAUNCH_LABELS[kind], flags.join(' '));
  }
  recordFactsSafely({ home, dataDir, modelsFile }, recordFacts);
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

function lookupCodexBrowser(project, { env, launch }) {
  if (!project) return null;
  const helper = fileURLToPath(new URL('./codex-browser.js', import.meta.url));
  const result = spawnSync(process.execPath, [helper, project, ...(launch ? [] : ['--no-launch'])], {
    env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

// Pass the project browser address to DevTools for this launch only. Do not change the user config.
export function codexBrowserArgs(kind, project, { lookup = lookupCodexBrowser, output = console.log, env = process.env, launch = true } = {}) {
  if (kind !== 'codex') return [];
  let browser;
  try { browser = lookup(project, { env, launch }); } catch { /* Do not print an error that can hold private data. */ }
  if (Number.isInteger(browser?.port) && browser.port > 0 && browser.port <= 65535) {
    return ['-c', `mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:${browser.port}"]`];
  }
  output('Codex: no project browser is available. Chrome DevTools MCP is disabled for this launch.');
  return ['-c', 'mcp_servers.chrome-devtools.enabled=false'];
}

const LIVE_PROMPT = "Run this exact shell command and print its output line and nothing else: sh -c 'echo HERDR_ENV=${HERDR_ENV:+set} PANE=${HERDR_PANE_ID:+set}'";

// Run one codex exec with the worker shell variables of the caller pane. Report only set or missing, never a value.
export function liveCodexCheck({ env = process.env, modelsFile = MODELS_FILE, timeoutMs = 180_000, run = spawnSync } = {}) {
  const area = 'codex live';
  const values = { HERDR_ENV: 'missing', HERDR_PANE_ID: 'missing' };
  const finding = (status, note) => ({ status, area, item: 'Codex live check', values, text: `HERDR_ENV ${values.HERDR_ENV}, HERDR_PANE_ID ${values.HERDR_PANE_ID}${note ? ` (${note})` : ''}` });
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
