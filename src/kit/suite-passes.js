import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { globMatches, suiteUntestedProblem } from './config.js';

// A suite pass says that a command passed on a clean tree. The key of a pass has the repository, the tested hash of the tree,
// the hashes of the lockfiles on disk, the Node version, and the command. The tested hash covers every file of HEAD except the
// files that match an untested glob, so a change to a file that no test reads keeps the pass.
export const SUITE_PASSES_FILE = 'suite-passes.json';
export const PUSH_HOOKS_FILE = 'push-hooks.json';
const MAX_SUITE_PASSES = 200;
const MAX_PUSH_HOOK_REPOS = 100;
export const DEFAULT_SUITE_UNTESTED = Object.freeze(['.worker/**', '.orchestration/**']);

export function gitText(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim();
}

const LOCKFILE_NAMES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
];

// The tree hash covers a tracked lockfile. This hash also covers an ignored lockfile.
function lockfileHashes(root) {
  const locks = {};
  for (const name of LOCKFILE_NAMES) {
    try {
      locks[name] = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    } catch {}
  }
  return locks;
}

const isUntested = (patterns, file) => patterns.some((pattern) => globMatches(pattern, file));

// The paths that git status reports as changed. A rename or a copy has two paths.
function dirtyPaths(root) {
  const fields = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    paths.push(fields[i].slice(3));
    if (/^[RC]/.test(fields[i].slice(0, 2))) { i += 1; paths.push(fields[i]); }
  }
  return paths;
}

// The hash over every file of HEAD (mode, object, path) that no untested glob covers. The list of globs is part of the hash.
function testedHash(root, patterns) {
  const listing = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  const hash = createHash('sha256');
  hash.update(`untested:${JSON.stringify([...patterns].sort())}\0`);
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    const file = entry.slice(entry.indexOf('\t') + 1);
    if (!isUntested(patterns, file)) hash.update(`${entry}\0`);
  }
  return hash.digest('hex');
}

// The key of the clean tree in root, or null when the tree is not clean. A changed or untracked file that matches an untested glob
// does not make the tree unclean.
export function cleanTreeKey(root, untested = DEFAULT_SUITE_UNTESTED) {
  try {
    // An invalid list is ignored as a whole.
    const patterns = suiteUntestedProblem(untested) === null ? untested : DEFAULT_SUITE_UNTESTED;
    if (dirtyPaths(root).some((file) => !isUntested(patterns, file))) return null;
    const commonDir = gitText(root, 'rev-parse', '--git-common-dir');
    const repo = fs.realpathSync(path.resolve(root, commonDir));
    const tree = gitText(root, 'rev-parse', 'HEAD^{tree}');
    if (!repo || !/^[0-9a-f]{40,64}$/i.test(tree)) return null;
    const tested = testedHash(root, patterns);
    const locks = lockfileHashes(root);
    return Object.keys(locks).length ? { repo, tree, tested, locks } : { repo, tree, tested };
  } catch {
    return null;
  }
}

export function sameTreeKey(left, right) {
  return left?.repo === right?.repo
    && left?.tested === right?.tested
    && JSON.stringify(left?.locks ?? {}) === JSON.stringify(right?.locks ?? {});
}

// A record from before the tested hash existed has no tested value. It matches only the same tree.
export function samePassKey(record, key, command) {
  const tree = typeof record?.tested === 'string' ? record.tested === key.tested : record?.tree === key.tree;
  return record?.repo === key.repo
    && tree
    && JSON.stringify(record?.locks ?? {}) === JSON.stringify(key.locks ?? {})
    && record?.node === process.version
    && Array.isArray(record?.command)
    && JSON.stringify(record.command) === JSON.stringify(command);
}

function readJsonList(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value.filter((record) => record && typeof record === 'object' && !Array.isArray(record)) : [];
  } catch {
    return [];
  }
}

function writeJsonList(dataDir, name, records, limit) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, name);
  const temporary = path.join(dataDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(records.slice(-limit), null, 2)}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export const readSuitePasses = (dataDir) => readJsonList(path.join(dataDir, SUITE_PASSES_FILE));
export const writeSuitePasses = (dataDir, records) => writeJsonList(dataDir, SUITE_PASSES_FILE, records, MAX_SUITE_PASSES);

export function findSuitePass(dataDir, key, command) {
  return readSuitePasses(dataDir).slice().reverse().find((record) => samePassKey(record, key, command)) ?? null;
}

export const hookFileHash = (file) => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};

// A hook is reusable only when every line is a comment, a blank line, a plain shell setup line, or a herdr-boss suite call.
// A raw test command in the hook would run on a push that skips the lock, so such a hook is not reusable.
const HOOK_SUITE_LINE = /^(exec\s+)?(\S*\/)?(herdr-boss|node\s+\S*cli\.js)\s+suite(\s|$)/;
const HOOK_SETUP_LINE = /^(set\s+-[a-z]+|exit(\s+\S+)?|cd\s+\S+|export\s+[A-Za-z_][A-Za-z0-9_]*=\S*|#.*)$/;
export function hookRunsOnlySuites(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const lines = text.split('\n').map((line) => line.trim().replace(/['"]/g, '')).filter(Boolean);
  return lines.length > 0 && lines.some((line) => HOOK_SUITE_LINE.test(line))
    && lines.every((line) => HOOK_SUITE_LINE.test(line) || HOOK_SETUP_LINE.test(line));
}

// The suite commands that the pre-push hook of a repository ran in its last push. Each record is { repo, hook, commands, time }.
// The commands count only for the same hook file content.
export function readPushHookCommands(dataDir, repo, hook) {
  const record = readJsonList(path.join(dataDir, PUSH_HOOKS_FILE)).find((entry) => entry.repo === repo);
  const commands = record?.commands;
  if (!hook || record?.hook !== hook) return [];
  return Array.isArray(commands) && commands.every((command) => Array.isArray(command) && command.every((part) => typeof part === 'string')) ? commands : [];
}

export function writePushHookCommands(dataDir, repo, hook, commands, time) {
  const others = readJsonList(path.join(dataDir, PUSH_HOOKS_FILE)).filter((entry) => entry.repo !== repo);
  if (commands.length && hook) others.push({ repo, hook, commands, time });
  writeJsonList(dataDir, PUSH_HOOKS_FILE, others, MAX_PUSH_HOOK_REPOS);
}

// A push can skip the full-suite lock when every suite command of its last hook run has a pass for the tree in root.
export function reusablePushPass(root, { dataDir, hookFile, untested = DEFAULT_SUITE_UNTESTED } = {}) {
  const key = cleanTreeKey(root, untested);
  if (!key || !hookRunsOnlySuites(hookFile)) return null;
  const commands = readPushHookCommands(dataDir, key.repo, hookFileHash(hookFile));
  if (!commands.length) return null;
  const passes = commands.map((command) => findSuitePass(dataDir, key, command));
  return passes.every(Boolean) ? { key, commands, passes } : null;
}

// A docs-only skip. A changed path counts as a doc only when it is LICENSE or a .md file outside the code folders. A doc is never
// a symbolic link or a submodule. A doc counts as read, and the suite runs, when any test file, or any tracked file under src, test,
// public, or kit, contains its relative path or its name without the extension, or when a test reads a folder of the path with
// readdir, glob, or walk. When unsure, the suite runs.
const NEVER_DOC = /^(src|public|test|tests|__tests__|spec|kit|bin|scripts|\.github)\//;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const READER_FOLDER = /^(src|test|public|kit)\//;
const MAX_READER_FILES = 5000;
const MAX_READER_BYTES = 64 * 1024 * 1024;

const isDocPath = (file) => !NEVER_DOC.test(file) && (file === 'LICENSE' || file.endsWith('.md'));

// The texts of the tracked files that can read a doc: the test files and every file under src, test, public, and kit.
// Returns null when the set is too large to check.
function readerTexts(root) {
  const files = gitText(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
    .filter((file) => file && (TEST_FILE.test(file) || READER_FOLDER.test(file)));
  if (files.length > MAX_READER_FILES) return null;
  let bytes = 0;
  const texts = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    bytes += text.length;
    if (bytes > MAX_READER_BYTES) return null;
    texts.push(text);
  }
  return texts;
}

const quoted = (name) => new RegExp(`['"\`]${name.replace(/[.*+^${}()|[\]\\]/g, '\\$&')}['"\`]`);

function readByCode(file, texts) {
  const segments = file.split('/');
  const base = segments.at(-1);
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const folders = segments.slice(0, -1);
  const folderNamed = (text) => folders.some((name, index) => quoted(name).test(text) || quoted(`${folders.slice(0, index + 1).join('/')}/?`).test(text));
  return texts.some((text) => text.includes(file) || text.includes(stem) || quoted(base).test(text)
    || (/readdir|glob|walk/i.test(text) && folderNamed(text)));
}

// The changed paths from tree fromTree to tree toTree, with the git modes. Returns null when a path is a symbolic link or a submodule.
function changedPaths(root, fromTree, toTree) {
  const fields = gitText(root, 'diff-tree', '-r', '--no-renames', '--raw', '-z', fromTree, toTree).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [oldMode, newMode] = fields[i].slice(1).split(' ');
    if ([oldMode, newMode].some((mode) => mode === '120000' || mode === '160000')) return null;
    files.push(fields[i + 1]);
  }
  return files;
}

// Returns { skip: true, files } when every path that changed from the tree fromTree to the tree of HEAD is a doc that no code reads.
export function docsOnlyChange(root, fromTree) {
  try {
    if (!/^[0-9a-f]{40,64}$/i.test(fromTree ?? '')) return { skip: false };
    const toTree = gitText(root, 'rev-parse', 'HEAD^{tree}');
    const files = changedPaths(root, fromTree, toTree);
    if (!files?.length || !files.every(isDocPath)) return { skip: false };
    const texts = readerTexts(root);
    if (!texts || files.some((file) => readByCode(file, texts))) return { skip: false };
    return { skip: true, files };
  } catch {
    return { skip: false };
  }
}

// The newest pass of the same repository, lockfiles, Node version, and command, whatever its tree. A docs-only change from it
// can reuse it.
export function findDocsOnlyBase(dataDir, key, command, root) {
  const pass = readSuitePasses(dataDir).slice().reverse().find((record) => record?.repo === key.repo
    && JSON.stringify(record.locks ?? {}) === JSON.stringify(key.locks ?? {})
    && record.node === process.version && Array.isArray(record.command)
    && JSON.stringify(record.command) === JSON.stringify(command));
  if (!pass) return null;
  const change = docsOnlyChange(root, pass.tree);
  return change.skip ? { pass, files: change.files } : null;
}

