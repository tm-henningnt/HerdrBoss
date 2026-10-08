import fs from 'node:fs';
import path from 'node:path';

function realGitDirectory(directory) {
  try {
    const real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, 'HEAD'))) return null;
    return real;
  } catch { return null; }
}

export function commonGitDir(repo, slug, onWarning) {
  const dotGit = path.join(repo, '.git');
  let gitDir = dotGit;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!pointer) throw new Error('Invalid gitdir pointer');
      gitDir = path.resolve(repo, pointer[1].trim());
      const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      if (!common) throw new Error('Missing common Git directory');
      gitDir = path.resolve(gitDir, common);
    } else if (stat.isDirectory()) {
      try {
        const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (common) gitDir = path.resolve(gitDir, common);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } else throw new Error('Invalid .git entry');
    const resolved = realGitDirectory(gitDir);
    if (resolved) return resolved;
  } catch { /* Try the repository .git path as a fallback below. */ }

  const fallback = realGitDirectory(dotGit);
  onWarning?.(fallback
    ? 'Warning: could not resolve the shared Git directory for project ' + slug + '; using its .git directory.'
    : 'Warning: could not resolve a valid Git directory for project ' + slug + '; no project Git root was added.');
  return fallback;
}

