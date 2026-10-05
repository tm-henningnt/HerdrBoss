#!/usr/bin/env node
// The docs gate. A branch that changes a behavior path must also change the docs or the page help,
// or record an exemption with a reason. The path rules are in scripts/docs-gate.config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs-gate.config.json');

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

// The token-shaped strings that the gate finds in a shipped artifact. Each entry is a class name and a pattern.
// A JWT has three base64url parts, and its first part starts with eyJ.
export const TOKEN_PATTERNS = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/],
  ['PEM private key block', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['license blob', /\b(?:licen[cs]e(?:Key)?|token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{40,}/i],
];

// A line with the allow marker keeps its fake test strings. The marker is the exact text below.
export const ALLOW_MARKER = 'herdr-boss: allow-test-token';

// A line with a public verification key or a certificate holds no secret. These lines stay allowed.
const PUBLIC_KEY_LINE = /-----BEGIN (?:[A-Z0-9 ]+ )?(?:PUBLIC KEY|CERTIFICATE)-----/;

// The token classes of one text, without the values. A line with the allow marker, a public verification key,
// or a certificate gives no class. An empty array means the text holds no token-shaped string.
export function scanTokenText(text) {
  const classes = [];
  for (const line of String(text).split('\n').slice(0, 20000)) {
    if (line.includes(ALLOW_MARKER) || PUBLIC_KEY_LINE.test(line)) continue;
    for (const [name, pattern] of TOKEN_PATTERNS) if (pattern.test(line) && !classes.includes(name)) classes.push(name);
  }
  return classes;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

// The token classes of each changed shipped artifact. It reads the content at head. A binary file gives no class.
function tokenFindings(root, head, files, rules) {
  const findings = [];
  for (const file of files.filter((name) => matches(name, rules.tokens || []))) {
    let content;
    try { content = git(root, ['show', `${head}:${file}`]); } catch { continue; }
    if (/\0/.test(content)) continue;
    const classes = scanTokenText(content);
    if (classes.length) findings.push({ file, classes });
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
  const tokens = tokenFindings(options.root ?? process.cwd(), options.head ?? 'HEAD', docs_.files, rules);
  const tokenLines = tokens.flatMap((finding) => [
    'Token gate failed: a shipped artifact of the branch holds a token-shaped string.',
    ...finding.classes.map((name) => `  token: ${finding.file}: ${name}`),
    'Remove the license text, token, key text, or licensed state from the artifact. Keep a public verification key.',
    'For a fake test string that must stay, put the allow marker on the same line: herdr-boss: allow-test-token.',
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
