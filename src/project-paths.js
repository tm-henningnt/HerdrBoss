import path from 'node:path';
import { readProjectRepos } from './harness.js';

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Read registered paths only. The current checkout is identified from its working-directory path.
export function listProjectPaths({ dataDir, cwd = process.cwd() } = {}) {
  const rows = readProjectRepos(dataDir);
  const currentPath = path.resolve(cwd);
  const currentRepo = rows
    .map((row) => path.resolve(row.repo))
    .filter((repo) => containsPath(repo, currentPath))
    .sort((a, b) => b.length - a.length)[0];

  return rows
    .filter((row) => !currentRepo || path.resolve(row.repo) !== currentRepo)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((row) => ({ slug: row.slug, path: row.repo }));
}
