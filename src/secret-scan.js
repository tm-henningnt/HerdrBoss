// A scan for secrets in the staged files of a Git repository. A finding names the file and the class, never the value.
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 200 * 1024;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;
const CONTENT_PATTERNS = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[posur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['credential assignment', /\b[\w-]{0,40}(?:password|passwd|secret|token|api[_-]?key)[\w-]{0,40}["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{16,}/i],
];

// The classes of secret that one file holds, from its path and its text.
export function scanText(file, text) {
  const classes = [];
  if (ENV_FILE.test(file) && !ENV_EXAMPLE.test(file)) classes.push('.env file');
  // Each pattern sees at most the first 200 KB of a line, so a long line cannot make the scan slow.
  const lines = text.split('\n').map((line) => line.slice(0, MAX_LINE));
  for (const [name, pattern] of CONTENT_PATTERNS) if (lines.some((line) => pattern.test(line))) classes.push(name);
  return classes;
}

function git(cwd, args) { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }); }

// Scan the staged content of each added or changed file. Returns [{ file, classes }].
// A file over 2 MB or with a NUL byte cannot be scanned. It is a finding, unless its path is in allowUnscanned.
export function scanStaged(cwd, { allowUnscanned = [] } = {}) {
  const names = git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  for (const file of names) {
    const content = git(cwd, ['show', `:${file}`]);
    const unscanned = content.length > MAX_BYTES || content.includes(0);
    const classes = unscanned ? (allowUnscanned.includes(file) ? [] : ['unscanned large or binary file']) : scanText(file, content.toString('utf8'));
    if (classes.length) findings.push({ file, classes });
  }
  return findings;
}
