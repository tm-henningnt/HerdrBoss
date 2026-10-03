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

// Compare head with the merge base of base and head. Returns { ok, behavior, docs, exemptions, lines }.
export function checkDocsGate({ root = process.cwd(), base = 'main', head = 'HEAD', rules = loadRules(), includeWorktree = false } = {}) {
  const mergeBase = git(root, ['merge-base', base, head]).trim();
  const changed = new Set(git(root, ['diff', '--name-only', mergeBase, head]).split('\n').filter(Boolean));
  if (includeWorktree) {
    for (const line of git(root, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean)) changed.add(line.slice(3).split(' -> ').pop());
  }
  const files = [...changed];
  const behavior = files.filter((file) => classify(file, rules) === 'behavior');
  const docs = files.filter((file) => classify(file, rules) === 'docs');
  if (!behavior.length) return { ok: true, behavior, docs, exemptions: [], lines: ['Docs gate: no behavior path changed.'] };
  if (docs.length) return { ok: true, behavior, docs, exemptions: [], lines: [`Docs gate: ${behavior.length} behavior file(s) and ${docs.length} docs file(s) changed.`] };

  const exemptions = trailerReasons(root, `${mergeBase}..${head}`).map((reason) => ({ scope: 'branch', reason }));
  if (exemptions.length) {
    return { ok: true, behavior, docs, exemptions, lines: exemptions.map((entry) => `Docs gate: exempt by Docs-Exempt trailer: ${entry.reason}`) };
  }
  const entries = rules.exemptionFile ? fileEntries(root, mergeBase, head, rules.exemptionFile) : [];
  const uncovered = behavior.filter((file) => !entries.some((entry) => matches(file, [entry.glob])));
  if (entries.length && !uncovered.length) {
    return { ok: true, behavior, docs, exemptions: entries, lines: entries.map((entry) => `Docs gate: exempt by ${rules.exemptionFile}: ${entry.glob}: ${entry.reason}`) };
  }
  return {
    ok: false,
    behavior,
    docs,
    exemptions: entries,
    lines: [
      'Docs gate failed: the branch changes behavior and changes no docs.',
      ...uncovered.map((file) => `  behavior: ${file}`),
      'Change the docs under docs/ or the page help under docs/help/ in the same branch.',
      `For a change with no effect on behavior, add a "Docs-Exempt: <reason>" trailer to a commit message, or add "<path glob> | <reason>" to ${rules.exemptionFile}.`,
    ],
  };
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
