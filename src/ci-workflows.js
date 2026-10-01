import fs from 'node:fs';
import path from 'node:path';

// Read only regular workflow files from the project's local .github/workflows folder.
// A missing folder or an unreadable workflow gives no files to lint.
export function readWorkflowFiles(root) {
  const githubDirectory = path.join(root, '.github');
  const directory = path.join(githubDirectory, 'workflows');
  try {
    const githubInfo = fs.lstatSync(githubDirectory);
    if (!githubInfo.isDirectory() || githubInfo.isSymbolicLink()) return [];
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    const names = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return names.map((name) => ({ path: `.github/workflows/${name}`, text: fs.readFileSync(path.join(directory, name), 'utf8') }));
  } catch {
    return [];
  }
}
