// Shared Git pins hold hashes, never config values or hook contents.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, PRIVATE_ACCESS_DIR } from './config.js';
import { commonGitDir } from './git-directory.js';
import { readDataFile, writeDataFile } from './data-file-safety.js';
import { redactSecrets } from './redact.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const cache = new Map();
export const GIT_PIN_CACHE_MS = 10000;
export const GIT_PIN_NOTICE_TEXT_LIMIT = 500;
export const safeGitPinName = (name) => redactSecrets(String(name)).replace(/[^A-Za-z0-9._@-]/g, '?').slice(0, 64);
export function gitPinChangesText(result) {
  const names = result.changed.slice(0, 10).map(safeGitPinName);
  const remaining = (result.changedCount ?? result.changed.length) - names.length;
  return [...names, ...(remaining > 0 ? [`+${remaining} more`] : [])].join(', ');
}

export function sharedGitEnabled(slug, { dataDir = DATA_DIR } = {}) {
  let saved;
  try { saved = JSON.parse(readDataFile(path.join(dataDir, 'policy.json'), dataDir)).projects?.[slug]?.codexSharedGit; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read codexSharedGit policy.'); }
  if (saved !== undefined && typeof saved !== 'boolean') throw new Error('codexSharedGit must be true or false.');
  return saved ?? (slug !== 'herdrboss');
}

// Use the same HOME-based private directory as the access token. Never use HERDR_BOSS_DIR.
export function gitPinsDir({ home, env = process.env } = {}) {
  return path.join(home ? path.join(home, '.config', 'herdr-boss') : env.HOME ? path.join(env.HOME, '.config', 'herdr-boss') : PRIVATE_ACCESS_DIR, 'git-pins');
}
function pinFile(project, directory) {
  return path.join(directory, `${digest(project.slug)}.json`);
}
function readIndex(directory) {
  try {
    const record = JSON.parse(readDataFile(path.join(directory, 'index.json'), directory));
    if (record.schema !== 1 || !Array.isArray(record.projects) || record.projects.some((p) => typeof p.slug !== 'string' || !p.slug || typeof p.repo !== 'string' || !path.isAbsolute(p.repo))) throw new Error('invalid');
    return record.projects;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A lost index must not erase the fact that pin files already exist.
      if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.json'))) throw new Error('Cannot read Git pin index.');
      return [];
    }
    throw new Error('Cannot read Git pin index.');
  }
}
export function pinnedProjects(options = {}) {
  return readIndex(gitPinsDir(options));
}
function ensurePrivateDirectory(directory) {
  const directories = [path.dirname(path.dirname(directory)), path.dirname(directory), directory];
  for (const folder of directories) {
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('invalid');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
function withPrivateMutation(directory, operation) {
  const lock = path.join(directory, 'mutation.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('The private Git pins are busy. Ask the orchestrator to ask the Boss.');
    throw new Error('Cannot write private Git pins. Ask the orchestrator to ask the Boss. Nothing was changed.');
  }
  try { return operation(); } finally { fs.rmdirSync(lock); }
}
export function assertPinDirectoryWritable(options = {}) {
  const directory = gitPinsDir(options);
  try {
    // Check the nearest existing parent before creating anything or writing an audit line.
    let parent = directory;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!(fs.statSync(parent).mode & 0o200)) throw new Error('not writable');
    fs.accessSync(parent, fs.constants.W_OK);
    ensurePrivateDirectory(directory);
    const probe = path.join(directory, `.write-check-${process.pid}`);
    const fd = fs.openSync(probe, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd); fs.unlinkSync(probe);
  } catch { throw new Error('Cannot write private Git pins. Ask the orchestrator to ask the Boss. Nothing was changed.'); }
  return directory;
}
function fileHash(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return digest('missing'); throw error; }
  try {
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('invalid');
    if (stat.isSymbolicLink() && !fs.statSync(file).isFile()) throw new Error('invalid');
    return digest(Buffer.concat([Buffer.from(JSON.stringify([stat.mode & 0o777, stat.isSymbolicLink() ? fs.readlinkSync(file) : null])), fs.readFileSync(file)]));
  } catch { throw new Error('Cannot read Git file.'); }
}
function folderHashes(folder) {
  const files = Object.create(null);
  const visit = (folder, prefix = '') => {
    let names;
    try { names = fs.readdirSync(folder).sort(); } catch (error) { if (error.code === 'ENOENT' && !prefix) return; throw error; }
    for (const name of names) {
      const file = path.join(folder, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isDirectory()) { files[relative + '/'] = digest('directory'); visit(file, relative + '/'); }
      else {
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Cannot read hook file.');
        files[relative] = fileHash(file);
      }
    }
  };
  visit(folder);
  return files;
}
function snapshot(project, { env = process.env } = {}) {
  const common = commonGitDir(project.repo, project.slug);
  if (!common) throw new Error('Cannot read shared Git directory.');
  let hooks, hooksPath = Object.create(null), files;
  try {
    hooks = folderHashes(path.join(common, 'hooks'));
    files = { config: fileHash(path.join(common, 'config')), 'config.worktree': fileHash(path.join(common, 'config.worktree')), 'info/attributes': fileHash(path.join(common, 'info', 'attributes')) };
    const worktrees = path.join(common, 'worktrees');
    for (const name of fs.existsSync(worktrees) ? fs.readdirSync(worktrees).sort() : []) {
      const folder = path.join(worktrees, name);
      if (!fs.lstatSync(folder).isDirectory()) throw new Error('invalid');
      const file = path.join(folder, 'config.worktree');
      try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      files[`worktrees/${name}/config.worktree`] = fileHash(file);
    }
  } catch { throw new Error('Cannot read shared Git files.'); }
  // git config reads settings only. It runs no hook, pager, editor, transport, or fsmonitor.
  const result = spawnSync('git', ['-C', project.repo, 'config', '--null', '--includes', '--get-regexp', String.raw`^(core\.hookspath|remote\..*\.(url|pushurl))$`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Cannot read Git config keys.');
  const values = new Map();
  let hooksFolder;
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const split = entry.indexOf('\n');
    if (split < 0) throw new Error('Cannot read Git config keys.');
    const rawKey = entry.slice(0, split), value = entry.slice(split + 1);
    if (rawKey.toLowerCase() === 'core.hookspath') { hooksFolder = value; continue; }
    const remote = /^remote\.(.*)\.(url|pushurl)$/i.exec(rawKey);
    if (!remote) throw new Error('Cannot read Git config keys.');
    const key = `remote.${remote[1]}`;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push([remote[2].toLowerCase(), value]);
  }
  if (hooksFolder) {
    if (hooksFolder.startsWith('~/')) hooksFolder = path.join(env.HOME || path.dirname(path.dirname(PRIVATE_ACCESS_DIR)), hooksFolder.slice(2));
    try { hooksPath = folderHashes(path.resolve(project.repo, hooksFolder)); }
    catch { throw new Error('Cannot read hooksPath folder files.'); }
  }
  const config = Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, digest(JSON.stringify(value))]));
  const hooksHash = digest(JSON.stringify(Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))));
  return { common: digest(common), hooks, hooksHash, files, hooksPath, config };
}
function readPin(project, directory) {
  try {
    const pin = JSON.parse(readDataFile(pinFile(project, directory), directory));
    if (pin.schema !== 2 || pin.slug !== project.slug || typeof pin.repo !== 'string' || !path.isAbsolute(pin.repo) || !HASH.test(pin.state?.common) || !HASH.test(pin.state?.hooksHash)
      || ['hooks', 'config', 'files', 'hooksPath'].some((kind) => !pin.state[kind] || typeof pin.state[kind] !== 'object' || Array.isArray(pin.state[kind]) || !Object.values(pin.state[kind]).every((value) => HASH.test(value)))
      || (pin.lastNotifiedChangeSet !== undefined && !/^[a-f0-9-]{36}$/.test(pin.lastNotifiedChangeSet))) throw new Error('invalid');
    return pin;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (readIndex(directory).some((p) => p.slug === project.slug)) throw new Error('Missing Git pins for a previously pinned project.');
      return null;
    }
    throw new Error('Cannot read Git pins.');
  }
}
export function pinProject(project, { home, env = process.env, now = Date.now, beforeWrite = () => {}, newBaselineOnly = false } = {}) {
  const directory = assertPinDirectoryWritable({ home, env });
  return withPrivateMutation(directory, () => {
    if (newBaselineOnly && readPin(project, directory)) throw new Error('Git pins already have a baseline. Retry harness check.');
    const state = snapshot(project, { env });
    const projects = readIndex(directory).filter((p) => p.slug !== project.slug);
    projects.push({ slug: project.slug, repo: path.resolve(project.repo) });
    beforeWrite();
    // Record that this project was pinned first. A failed or deleted pin then fails closed.
    writeDataFile(path.join(directory, 'index.json'), JSON.stringify({ schema: 1, projects }) + '\n', directory);
    writeDataFile(pinFile(project, directory), JSON.stringify({ schema: 2, slug: project.slug, repo: path.resolve(project.repo), recordedAt: new Date(now()).toISOString(), state }) + '\n', directory);
    const prefix = pinFile(project, directory) + '\0';
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    return state;
  });
}

// Remove a reviewed cleanup candidate without reading its now-deleted Git directory.
export function unpinProject(slug, options = {}) {
  const directory = gitPinsDir(options);
  const projects = readIndex(directory);
  if (!projects.some(project => project.slug === slug)) return false;
  assertPinDirectoryWritable(options);
  return withPrivateMutation(directory, () => {
    const current = readIndex(directory);
    fs.rmSync(pinFile({ slug }, directory), { force: true });
    writeDataFile(path.join(directory, 'index.json'), JSON.stringify({ schema: 1, projects: current.filter(project => project.slug !== slug) }) + '\n', directory);
    const prefix = pinFile({ slug }, directory) + '\0';
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    return true;
  });
}
function changedNames(before, after) {
  const names = [];
  if (before.common !== after.common) names.push('common Git directory');
  for (const kind of ['files', 'hooks', 'hooksPath', 'config']) {
    for (const key of [...new Set([...Object.keys(before[kind]), ...Object.keys(after[kind])])].sort()) {
      if (before[kind][key] !== after[kind][key]) names.push(['hooks', 'hooksPath'].includes(kind) ? path.basename(key.replace(/\/$/, '')) : key);
    }
  }
  return [...new Set(names)];
}
function queueNotice(project, pin, live, changed, dataDir, directory, now) {
  const hash = digest(JSON.stringify(['git-pins', project.slug, pin.state, live]));
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  if (pin.lastNotifiedChangeSet === id) return;
  return withPrivateMutation(directory, () => {
    const current = readPin(project, directory);
    // A concurrent refresh owns its new baseline. Never overwrite it with an older check's state.
    if (!current || digest(JSON.stringify(current.state)) !== digest(JSON.stringify(pin.state)) || current.recordedAt !== pin.recordedAt || current.lastNotifiedChangeSet === id) return;
    const notices = path.join(dataDir, 'locks', 'machine', 'notices');
    fs.mkdirSync(notices, { recursive: true, mode: 0o700 });
    const file = path.join(notices, `${id}.json`);
    const notice = { id, type: 'git-pins', severity: 'warn', ownerPane: '', project: safeGitPinName(project.slug), text: `Git pins: ${safeGitPinName(project.slug)} changed ${gitPinChangesText({ changed })}. Ask the Boss. Do not run the hook.`.slice(0, GIT_PIN_NOTICE_TEXT_LIMIT), createdAt: new Date(now()).toISOString() };
    // An exclusive create deduplicates concurrent CLI checks too.
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(notice) + '\n'); } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    writeDataFile(pinFile(project, directory), JSON.stringify({ ...current, lastNotifiedChangeSet: id }) + '\n', directory);
  });
}
export function checkProjectPin(project, { dataDir = DATA_DIR, home, env = process.env, now = Date.now, cached = false, allowBaseline = false } = {}) {
  const directory = gitPinsDir({ home, env }), file = pinFile(project, directory), time = now();
  const cacheKey = file + '\0' + path.resolve(project.repo);
  const previous = cache.get(cacheKey);
  let result, pinHash;
  try {
    readIndex(directory);
    const pin = readPin(project, directory);
    pinHash = pin ? digest(JSON.stringify(pin)) : null;
    // Always read the trust record. Deletion, corruption, and an external refresh invalidate the cache.
    if (pin && cached && previous?.pinHash === pinHash && time >= previous.time && time - previous.time < GIT_PIN_CACHE_MS) return previous.result;
    if (!pin) {
      if (!allowBaseline) throw new Error('Git pins have no reviewed baseline.');
      pinProject(project, { home, env, now, newBaselineOnly: true }); result = { ok: true, baseline: true, changed: [] };
    }
    else {
      const live = snapshot(project, { env }), changed = changedNames(pin.state, live);
      result = { ok: changed.length === 0, baseline: false, changed };
      if (!result.ok) {
        try { queueNotice(project, pin, live, changed, dataDir, directory, now); }
        catch (error) { if (error.code !== 'EEXIST') result.noticeFailed = true; }
      }
    }
  } catch (error) {
    result = { ok: false, changed: [], error: error.message, baseline: false };
  }
  if (cached) {
    if (cache.size > 256) cache.clear();
    cache.set(cacheKey, { time, result, pinHash });
  }
  return result;
}
export function assertProjectGitPins({ config, dataDir = DATA_DIR, env = process.env, now = Date.now, output = console.log, gitPinOverride = false } = {}) {
  const directory = gitPinsDir({ env });
  let projects;
  try { projects = readIndex(directory); }
  catch { throw new Error('Cannot read private Git pins. Ask the Boss. Do not run the hook.'); }
  const common = commonGitDir(config.root, config.slug);
  let project;
  try {
    project = projects.find((row) => row?.slug === config.slug)
      ?? projects.find((row) => common && readPin(row, directory)?.state.common === digest(common));
  } catch { throw new Error('Cannot read private Git pins. Ask the Boss. Do not run the hook.'); }
  if (!project) throw new Error('Git pins have no reviewed baseline. Ask the Boss. Do not run the hook.');
  // Compare the caller's actual Git directory, even if a linked worktree pointer changed.
  const result = checkProjectPin({ ...project, repo: config.root }, { dataDir, env, now, cached: true });
  if (result.baseline) output(`Git pins: ${safeGitPinName(project.slug)} recorded a baseline.`);
  if (!result.ok) {
    const message = `Git pins: ${safeGitPinName(project.slug)} ${result.error || `changed ${gitPinChangesText(result)}`}. Ask the Boss. Do not run the hook.`;
    if (!gitPinOverride) throw new Error(message);
    output(message + ' Boss override is audited.');
  }
}
