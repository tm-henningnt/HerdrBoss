import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHerdrRunner, listCwdProcesses } from './workers.js';
import { archiveWorkerReports } from './worker-archive.js';
import { projectKit } from './agents-check.js';
export { archiveWorkerReports } from './worker-archive.js';

const GENERATED_KIT_FILE = 'docs/orchestration/herdr-boss.md';

function isWorkerUntrackedPath(relative) {
  return relative === '.worker' || relative.startsWith('.worker/')
    || relative === '.orchestration' || relative.startsWith('.orchestration/')
    || relative === 'opencode.json';
}

function generatedKitVersions(config) {
  const versions = new Set([projectKit().text]);
  const commits = git(config.root, ['log', '--format=%H', '--diff-filter=AM', config.baseBranch, '--', GENERATED_KIT_FILE])
    .split(/\r?\n/).filter(Boolean);
  for (const commit of commits) versions.add(git(config.root, ['show', `${commit}:${GENERATED_KIT_FILE}`]));
  return versions;
}

function worktreeDirt(root, isGeneratedKitContent) {
  const records = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const dirtyPaths = [];
  const untrackedPaths = [];
  let generatedKitDirty = false;
  for (const record of records) {
    const status = record.slice(0, 2);
    const relative = record.slice(3);
    if (relative === GENERATED_KIT_FILE) {
      let content = null;
      if (status[0] === ' ') {
        try {
          const file = path.join(root, GENERATED_KIT_FILE);
          if (fs.lstatSync(file).isFile()) content = fs.readFileSync(file, 'utf8');
        } catch {}
      }
      if (content !== null && isGeneratedKitContent(content)) {
        generatedKitDirty = true;
        continue;
      }
      dirtyPaths.push(relative);
      continue;
    }
    if (status === '??' && isWorkerUntrackedPath(relative)) {
      untrackedPaths.push(relative);
      continue;
    }
    dirtyPaths.push(relative || '(unreadable path)');
  }
  return { clean: dirtyPaths.length === 0, dirtyPaths, generatedKitDirty, untrackedPaths };
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options });
}

export function parseWorktrees(source) {
  const records = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false };
    } else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('prunable')) current.prunable = true;
    else if (line === '') { records.push(current); current = null; }
  }
  if (current) records.push(current);
  return records;
}

function pathKey(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function cwdIsInWorktree(cwd, worktree) {
  const root = pathKey(worktree);
  const current = pathKey(cwd);
  const relative = path.relative(root, current);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function shortCommand(command) {
  const executable = String(command || 'unknown').trim().split(/\s+/, 1)[0];
  return path.basename(executable).slice(0, 80) || 'unknown';
}

function isAncestor(repoRoot, ancestor, descendant) {
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function classifyWorktrees(config, { panes = [], now = Date.now() } = {}) {
  const list = parseWorktrees(git(config.root, ['worktree', 'list', '--porcelain']));
  const projectRoot = pathKey(config.root);
  let generatedKitContentVersions;
  const isGeneratedKitContent = (content) => {
    generatedKitContentVersions ??= generatedKitVersions(config);
    return generatedKitContentVersions.has(content);
  };
  return list.map((worktree) => {
    const exists = fs.existsSync(worktree.path);
    const dirt = exists ? worktreeDirt(worktree.path, isGeneratedKitContent) : { clean: false, dirtyPaths: [], generatedKitDirty: false, untrackedPaths: [] };
    const { clean } = dirt;
    const merged = !!worktree.head && isAncestor(config.root, worktree.head, config.baseBranch);
    let stat;
    try { stat = fs.statSync(worktree.path); } catch { stat = null; }
    const createdAt = stat?.birthtimeMs || stat?.mtimeMs || now;
    const ageMs = Math.max(0, now - createdAt);
    const livePane = panes.some((pane) => {
      const cwd = pane.foreground_cwd ?? pane.cwd;
      const parked = (pane.label ?? pane.name) === 'parked';
      return cwd && cwdIsInWorktree(cwd, worktree.path)
        && (parked || (pane.agent_status ?? pane.status) !== 'done');
    });
    const isPrimary = pathKey(worktree.path) === projectRoot;
    const removable = merged && clean && !livePane && !isPrimary && !worktree.detached && !worktree.prunable;
    return {
      ...worktree,
      exists,
      merged,
      clean,
      dirtyPaths: dirt.dirtyPaths,
      generatedKitDirty: dirt.generatedKitDirty,
      untrackedPaths: dirt.untrackedPaths,
      livePane,
      isPrimary,
      ageMs,
      age: formatAge(ageMs),
      removable,
    };
  });
}

export function formatAge(milliseconds) {
  const days = Math.floor(milliseconds / 86400000);
  if (days) return `${days}d`;
  const hours = Math.floor(milliseconds / 3600000);
  if (hours) return `${hours}h`;
  return `${Math.floor(milliseconds / 60000)}m`;
}

function workerNameOf(worktreePath, mainRoot) {
  const base = path.basename(worktreePath);
  const legacy = `${path.basename(mainRoot)}-wt-`;
  return base.startsWith(legacy) ? base.slice(legacy.length) : base;
}

export function pruneWorktrees(config, { apply = false, archive = true, worktreePath = null, herdr = createHerdrRunner(), output = console.log, now = Date.now(), listProcesses = listCwdProcesses, checkoutKitFile = (root, file) => git(root, ['checkout', '--', file]) } = {}) {
  if (worktreePath !== null && (typeof worktreePath !== 'string' || worktreePath.trim() === '')) {
    throw new Error('worktreePath must be null or a non-empty path.');
  }
  const panesResponse = herdr(['pane', 'list']);
  const panes = Array.isArray(panesResponse) ? panesResponse : panesResponse.panes ?? [];
  let processes = [];
  let processScanError = null;
  try {
    processes = listProcesses();
    if (!Array.isArray(processes)) throw new Error('process scan returned an invalid result');
  } catch (error) {
    processScanError = error.message || String(error);
    output(`Process scan failed: ${processScanError}; no worktrees can be removed.`);
  }
  const classified = classifyWorktrees(config, { panes, now }).filter((worktree) => worktreePath === null || path.resolve(worktree.path) === path.resolve(worktreePath));
  const worktrees = classified.map((worktree) => {
    const matches = processScanError ? [] : processes.filter((process) => {
      if (!process.cwd || !cwdIsInWorktree(process.cwd, worktree.path)) return false;
      if (worktree.exists && worktree.removable) return true;
      return (!worktree.exists || worktree.prunable) && Number(process.ppid) === 1;
    }).map(({ pid, ppid, command, cwd }) => ({ pid, ppid, command: shortCommand(command), cwd }));
    const processBlocked = matches.length > 0;
    return {
      ...worktree,
      processes: matches,
      processBlocked,
      processScanError,
      removable: worktree.removable && !processBlocked && !processScanError,
    };
  });
  for (const worktree of worktrees) {
    const cleanState = worktree.exists ? (worktree.clean ? 'clean' : 'dirty') : 'missing';
    const state = [worktree.merged ? 'merged' : 'unmerged', cleanState, worktree.livePane ? 'live pane' : 'no live pane', worktree.processBlocked ? 'process in worktree' : (worktree.processScanError ? 'process scan failed' : 'no blocking process'), worktree.removable ? 'eligible' : (worktree.isPrimary ? 'primary' : 'keep')].join(', ');
    output(`${worktree.path} [${worktree.branch ?? 'detached'}] ${state}, age ${worktree.age}`);
    if (!apply && worktree.removable && worktree.generatedKitDirty) output(`${worktree.path}: would restore the generated kit file`);
    for (const process of worktree.processes) {
      output(`  Process: ${process.command} (pid ${process.pid}, ppid ${process.ppid ?? 'unknown'}, cwd ${process.cwd})`);
    }
  }
  if (apply) {
    const mainRoot = parseWorktrees(git(config.root, ['worktree', 'list', '--porcelain']))[0]?.path ?? config.root;
    for (const worktree of worktrees.filter((item) => item.removable)) {
      if (worktree.generatedKitDirty) {
        try {
          checkoutKitFile(worktree.path, GENERATED_KIT_FILE);
          output(`Restored the generated kit file in ${worktree.path}.`);
        } catch (error) {
          worktree.restoreError = error.message;
          output(`Restore of the generated kit file failed: ${error.message}; worktree kept.`);
          continue;
        }
      }
      if (archive) {
        const name = workerNameOf(worktree.path, mainRoot);
        try {
          const target = archiveWorkerReports(worktree.path, name, mainRoot, { output, now });
          if (target) output(`archived reports of ${name} to ${target}`);
        } catch (error) {
          worktree.archiveError = error.message;
          output(`Archive of ${name} failed: ${error.message}; worktree kept. Fix the error or run with --no-archive.`);
          continue;
        }
      }
      if (worktree.untrackedPaths.length) {
        git(worktree.path, ['clean', '-fd', '--', ...worktree.untrackedPaths]);
      }
      git(config.root, ['worktree', 'remove', worktree.path]);
      git(config.root, ['branch', '-d', worktree.branch]);
      output(`Removed ${worktree.path} and branch ${worktree.branch}.`);
    }
  }
  if (!worktrees.length) output('No worktrees found.');
  return worktrees;
}
