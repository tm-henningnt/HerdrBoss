#!/usr/bin/env node
// The docs gate. A branch that changes a behavior path must also change the docs or the page help,
// or record an exemption with a reason. The path rules are in scripts/docs-gate.config.json.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs-gate.config.json');
const TOKEN_CLASSES = new Set(['jwt', 'PEM private key block', 'license blob']);

export function loadRules(file = CONFIG) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// "**" matches any text, including "/". "*" matches any text except "/".
function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${source}$`);
}

const matches = (file, globs = []) => globs.some((glob) => globToRegExp(glob).test(file));

// The class of a changed path: behavior, docs, or other.
export function classify(file, rules) {
  if (matches(file, rules.docs) && !matches(file, rules.docsIgnore)) return 'docs';
  if (matches(file, rules.behavior) && !matches(file, rules.behaviorIgnore)) return 'behavior';
  return 'other';
}

// A key name that holds a license or a token: license, license_key, LICENSE_KEY, licenseToken, access_token, license-key.
// A word that only starts with the name, such as tokenizer, is not a key name.
const KEY_NAME = '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*?(?:licen[cs]e|token)(?:[_-]?(?:key|token|text|blob|data|value|code))*(?![A-Za-z0-9])';
const BLOB_PATTERN = /[A-Za-z0-9+/=_-]{40,}/;
const BLOB = BLOB_PATTERN.source;
// A key at the end of a line, optionally followed by a YAML block marker. The value is on a later line.
const KEY_ONLY_LINE = new RegExp(`${KEY_NAME}["']?\\s*[:=]\\s*(?:[|>][-+]?)?\\s*$`, 'i');
const BLOB_ONLY_LINE = new RegExp(`^\\s*["']?${BLOB}["']?,?\\s*$`);

// The token-shaped strings that the gate finds in a tracked file. Each entry is a class name and a pattern.
// A JWT has three base64url parts, and its first part starts with eyJ.
export const TOKEN_PATTERNS = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/],
  ['PEM private key block', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['license blob', new RegExp(`${KEY_NAME}["']?\\s*[:=]\\s*["']?(${BLOB})`, 'i')],
];

// A line with a public verification key or a certificate holds no secret. These lines stay allowed.
const PUBLIC_KEY_LINE = /-----BEGIN (?:[A-Z0-9 ]+ )?(?:PUBLIC KEY|CERTIFICATE)-----/;

// Return token classes and exact matched strings. Callers must not print the values.
export function scanTokenMatches(text) {
  const found = [];
  const add = (tokenClass, value) => found.push({ tokenClass, value });
  const source = String(text);
  let keyOnly = false;
  for (let start = 0; start <= source.length;) {
    let end = source.indexOf('\n', start);
    if (end === -1) end = source.length;
    const line = source.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    if (PUBLIC_KEY_LINE.test(line)) { keyOnly = false; continue; }
    for (const [tokenClass, pattern] of TOKEN_PATTERNS) {
      const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of line.matchAll(globalPattern)) {
        add(tokenClass, tokenClass === 'license blob' ? match[1] : match[0]);
      }
    }
    if (keyOnly && BLOB_ONLY_LINE.test(line)) {
      const value = BLOB_PATTERN.exec(line)?.[0];
      if (value) add('license blob', value);
    }
    keyOnly = KEY_ONLY_LINE.test(line);
  }
  return found;
}

// Keep the class-only helper for callers that do not need the matched values.
export function scanTokenText(text) {
  return [...new Set(scanTokenMatches(text).map(({ tokenClass }) => tokenClass))];
}

function readTokenAllowlist(root, head, rules, includeWorktree) {
  if (!rules.tokenAllowlist) return [];
  const file = path.resolve(root, rules.tokenAllowlist);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The token allowlist path must stay inside the repository.');
  }
  const content = includeWorktree ? fs.readFileSync(file, 'utf8') : git(root, ['show', `${head}:${rules.tokenAllowlist}`]);
  const entries = JSON.parse(content);
  if (!Array.isArray(entries)) throw new Error('The token allowlist must be a JSON array.');
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each token allowlist entry must be an object.');
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== 'class,path,reason,sha256') throw new Error('Each token allowlist entry must have only path, class, reason, and sha256.');
    if (typeof entry.path !== 'string' || !entry.path || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith('/') || entry.path === '..' || entry.path.startsWith('../') || entry.path.includes('\\')) {
      throw new Error('Each token allowlist path must be a normalized repository-relative path.');
    }
    if (!TOKEN_CLASSES.has(entry.class)) throw new Error('Each token allowlist entry must name a known token class.');
    if (typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.trim().length > 160) {
      throw new Error('Each token allowlist entry must have a short reason of at most 160 characters.');
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Each token allowlist entry must have a lowercase SHA-256 hash.');
    const key = `${entry.path}\0${entry.class}\0${entry.sha256}`;
    if (seen.has(key)) throw new Error('The token allowlist has a duplicate path, class, and hash.');
    seen.add(key);
  }
  return entries;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
}

// The reason of each Docs-Exempt trailer line in the commit messages. A line with no reason does not count.
function trailerReasons(root, range) {
  const messages = git(root, ['log', '--format=%B%x00', range]);
  return messages.split('\n').map((line) => /^Docs-Exempt:[ \t]*(\S.*)$/i.exec(line)?.[1].trim()).filter(Boolean);
}

// The entries that the branch adds to the exemption file. An entry has the form "<glob> | <reason>".
// Only added lines count, so an entry that already exists in the base exempts nothing.
function fileEntries(root, mergeBase, head, file) {
  const diff = git(root, ['diff', '-U0', mergeBase, head, '--', file]);
  return diff.split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => /^([^|]+?)\s*\|\s*(\S.*)$/.exec(line.slice(1).trim()))
    .filter(Boolean)
    .map(([, glob, reason]) => ({ glob, reason: reason.trim() }));
}

// The token classes of each changed shipped artifact. It reads the content at head, or the working tree content
// with includeWorktree. A deleted file and a binary file give no class.
function tokenFindings(root, head, files, rules, includeWorktree) {
  const findings = [];
  const allowlist = readTokenAllowlist(root, head, rules, includeWorktree);
  for (const file of files.filter((name) => matches(name, rules.tokens || []))) {
    let content;
    try {
      content = includeWorktree ? fs.readFileSync(path.join(root, file), 'utf8') : git(root, ['show', `${head}:${file}`]);
    } catch { continue; }
    if (/\0/.test(content)) continue;
    const classes = new Set();
    for (const match of scanTokenMatches(content)) {
      const sha256 = createHash('sha256').update(match.value).digest('hex');
      const allowed = allowlist.some((entry) => entry.path === file && entry.class === match.tokenClass && entry.sha256 === sha256);
      if (!allowed) classes.add(match.tokenClass);
    }
    if (classes.size) findings.push({ file, classes: [...classes] });
  }
  return findings;
}

// Compare head with the merge base of base and head, and check the docs rule.
// Returns { ok, behavior, docs, exemptions, files, lines }.
function checkDocsChange({ root = process.cwd(), base = 'main', head = 'HEAD', rules = loadRules(), includeWorktree = false } = {}) {
  const mergeBase = git(root, ['merge-base', base, head]).trim();
  const changed = new Set(git(root, ['diff', '--name-only', mergeBase, head]).split('\n').filter(Boolean));
  if (includeWorktree) {
    for (const line of git(root, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean)) changed.add(line.slice(3).split(' -> ').pop());
  }
  const files = [...changed];
  const behavior = files.filter((file) => classify(file, rules) === 'behavior');
  const docs = files.filter((file) => classify(file, rules) === 'docs');
  if (!behavior.length) return { ok: true, behavior, docs, exemptions: [], files, lines: ['Docs gate: no behavior path changed.'] };
  if (docs.length) return { ok: true, behavior, docs, exemptions: [], files, lines: [`Docs gate: ${behavior.length} behavior file(s) and ${docs.length} docs file(s) changed.`] };

  const exemptions = trailerReasons(root, `${mergeBase}..${head}`).map((reason) => ({ scope: 'branch', reason }));
  if (exemptions.length) {
    return { ok: true, behavior, docs, exemptions, files, lines: exemptions.map((entry) => `Docs gate: exempt by Docs-Exempt trailer: ${entry.reason}`) };
  }
  const entries = rules.exemptionFile ? fileEntries(root, mergeBase, head, rules.exemptionFile) : [];
  const uncovered = behavior.filter((file) => !entries.some((entry) => matches(file, [entry.glob])));
  if (entries.length && !uncovered.length) {
    return { ok: true, behavior, docs, exemptions: entries, files, lines: entries.map((entry) => `Docs gate: exempt by ${rules.exemptionFile}: ${entry.glob}: ${entry.reason}`) };
  }
  return {
    ok: false,
    behavior,
    docs,
    exemptions: entries,
    files,
    lines: [
      'Docs gate failed: the branch changes behavior and changes no docs.',
      ...uncovered.map((file) => `  behavior: ${file}`),
      'Change the docs under docs/ or the page help under docs/help/ in the same branch.',
      `For a change with no effect on behavior, add a "Docs-Exempt: <reason>" trailer to a commit message, or add "<path glob> | <reason>" to ${rules.exemptionFile}.`,
    ],
  };
}

// The docs check and the token check of a branch. Returns { ok, behavior, docs, exemptions, tokens, files, lines }.
// The gate fails when the docs check fails or when a shipped artifact of the branch holds a token-shaped string.
export function checkDocsGate(options = {}) {
  const docs_ = checkDocsChange(options);
  const rules = options.rules ?? loadRules();
  const tokens = tokenFindings(options.root ?? process.cwd(), options.head ?? 'HEAD', docs_.files, rules, Boolean(options.includeWorktree));
  const tokenLines = tokens.flatMap((finding) => [
    'Token gate failed: a tracked file holds a token-shaped string.',
    ...finding.classes.map((name) => `  token: ${finding.file}: ${name}`),
    'Remove the token-shaped string or licensed state from the file. Keep a public verification key.',
    `For a documented synthetic sample, add its path, class, reason, and SHA-256 to ${rules.tokenAllowlist || 'the token allowlist'}. Do not store the matched string in the allowlist.`,
  ]);
  return { ...docs_, tokens, ok: docs_.ok && !tokens.length, lines: [...docs_.lines, ...tokenLines] };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--include-worktree') options.includeWorktree = true;
    else if (['--root', '--base', '--head', '--config'].includes(arg)) options[arg.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { config, ...options } = parseArgs(process.argv.slice(2));
    const result = checkDocsGate({ ...options, ...(config ? { rules: loadRules(config) } : {}) });
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Docs gate error: ${(error.stderr?.toString().trim() || error.message)}\n`);
    process.exitCode = 2;
  }
}
