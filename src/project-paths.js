import fs from 'node:fs';
import path from 'node:path';
import { readProjectRepos } from './harness.js';
import { mainCheckoutRoot } from './kit/config.js';

function canonicalPath(target) {
  const absolute = path.resolve(target);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return absolute;
    throw error;
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Read registered paths only. Git's common directory identifies a linked worktree's main checkout.
export function listProjectPaths({ dataDir, cwd = process.cwd() } = {}) {
  const rows = readProjectRepos(dataDir);
  const currentPath = canonicalPath(cwd);
  const ownerPath = canonicalPath(mainCheckoutRoot(cwd));
  const registeredPaths = rows.map((row) => canonicalPath(row.repo));
  const currentRepo = registeredPaths.find((repo) => repo === ownerPath)
    ?? registeredPaths
      .filter((repo) => containsPath(repo, currentPath))
      .sort((a, b) => b.length - a.length)[0];

  return rows
    .filter((row) => !currentRepo || canonicalPath(row.repo) !== currentRepo)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((row) => ({ slug: row.slug, path: row.repo }));
}
