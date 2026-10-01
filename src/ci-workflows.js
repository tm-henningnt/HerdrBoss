import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from './kit/config.js';

export const CI_WORKFLOW_TEMPLATES = ['quick.yml', 'verify-changed.yml', 'full-gate.yml'];
const TEMPLATE_DIRECTORY = path.join(KIT_ROOT, 'kit', 'templates', 'workflows');

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

// Copy missing CI templates into a project. Existing files are always kept.
export function copyWorkflowTemplates(root) {
  const templates = CI_WORKFLOW_TEMPLATES.map((name) => ({
    name,
    text: fs.readFileSync(path.join(TEMPLATE_DIRECTORY, name), 'utf8'),
  }));
  const copied = [];
  const skipped = [];
  const relativePath = (name) => `.github/workflows/${name}`;
  const skipAll = (reason) => {
    for (const { name } of templates) skipped.push({ path: relativePath(name), reason });
  };
  const isRealDirectory = (directory) => {
    try {
      const info = fs.lstatSync(directory);
      return info.isDirectory() && !info.isSymbolicLink();
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  let rootIsDirectory;
  try {
    const info = fs.lstatSync(root);
    rootIsDirectory = info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    rootIsDirectory = false;
  }
  if (!rootIsDirectory) {
    skipAll('the project folder is missing or is not a real directory');
  } else {
    const githubDirectory = path.join(root, '.github');
    const workflowDirectory = path.join(githubDirectory, 'workflows');
    let githubStatus = isRealDirectory(githubDirectory);
    if (githubStatus === null) {
      try { fs.mkdirSync(githubDirectory); githubStatus = true; }
      catch (error) { if (error.code === 'EEXIST') githubStatus = isRealDirectory(githubDirectory); else throw error; }
    }
    let workflowStatus = githubStatus ? isRealDirectory(workflowDirectory) : false;
    if (workflowStatus === null) {
      try { fs.mkdirSync(workflowDirectory); workflowStatus = true; }
      catch (error) { if (error.code === 'EEXIST') workflowStatus = isRealDirectory(workflowDirectory); else throw error; }
    }
    if (!workflowStatus) {
      skipAll('the .github/workflows path is not a real directory');
    } else {
      for (const { name, text } of templates) {
        const target = path.join(workflowDirectory, name);
        try {
          fs.writeFileSync(target, text, { flag: 'wx' });
          copied.push(relativePath(name));
        } catch (error) {
          if (error.code === 'EEXIST') skipped.push({ path: relativePath(name), reason: 'already exists' });
          else throw error;
        }
      }
    }
  }

  return {
    copied,
    skipped,
    lines: [
      ...copied.map((file) => `Copied ${file}`),
      ...skipped.map(({ path: file, reason }) => reason === 'already exists' ? `Skipped existing ${file}` : `Skipped ${file}: ${reason}`),
    ],
  };
}
