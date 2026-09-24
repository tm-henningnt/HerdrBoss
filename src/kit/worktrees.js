import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHerdrRunner } from './workers.js';

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
  return list.map((worktree) => {
    const exists = fs.existsSync(worktree.path);
    let clean = false;
    if (exists) clean = git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']).trim() === '';
    const merged = !!worktree.head && isAncestor(config.root, worktree.head, config.baseBranch);
    let stat;
    try { stat = fs.statSync(worktree.path); } catch { stat = null; }
    const createdAt = stat?.birthtimeMs || stat?.mtimeMs || now;
    const ageMs = Math.max(0, now - createdAt);
    const livePane = panes.some((pane) => (pane.foreground_cwd ?? pane.cwd) && cwdIsInWorktree(pane.foreground_cwd ?? pane.cwd, worktree.path));
    const isPrimary = pathKey(worktree.path) === projectRoot;
    const removable = merged && clean && !livePane && !isPrimary && !worktree.detached && !worktree.prunable;
    return {
      ...worktree,
      exists,
      merged,
      clean,
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

export function pruneWorktrees(config, { apply = false, herdr = createHerdrRunner(), output = console.log, now = Date.now() } = {}) {
  const panesResponse = herdr(['pane', 'list']);
  const panes = Array.isArray(panesResponse) ? panesResponse : panesResponse.panes ?? [];
  const worktrees = classifyWorktrees(config, { panes, now });
  for (const worktree of worktrees) {
    const cleanState = worktree.exists ? (worktree.clean ? 'clean' : 'dirty') : 'missing';
    const state = [worktree.merged ? 'merged' : 'unmerged', cleanState, worktree.livePane ? 'live pane' : 'no live pane', worktree.removable ? 'eligible' : (worktree.isPrimary ? 'primary' : 'keep')].join(', ');
    output(`${worktree.path} [${worktree.branch ?? 'detached'}] ${state}, age ${worktree.age}`);
  }
  if (apply) {
    for (const worktree of worktrees.filter((item) => item.removable)) {
      git(config.root, ['worktree', 'remove', worktree.path]);
      git(config.root, ['branch', '-d', worktree.branch]);
      output(`Removed ${worktree.path} and branch ${worktree.branch}.`);
    }
  }
  if (!worktrees.length) output('No worktrees found.');
  return worktrees;
}
