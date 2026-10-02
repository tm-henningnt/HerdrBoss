import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE_FILES = ['report.md', 'report.json', 'brief.md'];
const ARCHIVE_MAX_BYTES = 1024 * 1024;
const ARCHIVE_FOLDER = path.join('.orchestration', 'reports');

function realDirectory(folder, label) {
  let stat;
  try { stat = fs.lstatSync(folder); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a real directory (${folder}).`);
  return true;
}

function utcStamp(now) {
  return new Date(now).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

// Copies the worker reports of a worktree to <main checkout>/.orchestration/reports/<name>/.
// A supplied run record is copied as run.json. workerDir selects the worker's report folder.
// It skips a missing file and a file over 1 MB, and reports each skip through output.
// It never overwrites a file. When the folder already holds one of the files, it writes all files to
// a new folder <name>-<UTC time>, with -2, -3 added when that folder also exists.
// It throws when .worker or a target folder is a symlink or a file, or when a copy fails.
// Returns the target folder, or null when nothing was copied.
export function archiveWorkerReports(worktree, name, mainRoot, { output = () => {}, now = Date.now(), runFile = null, workerDir = '.worker' } = {}) {
  const workerFolder = path.join(worktree, workerDir);
  const hasWorkerFolder = realDirectory(workerFolder, '.worker');
  const sources = [];
  for (const file of hasWorkerFolder ? ARCHIVE_FILES : []) {
    const source = path.join(workerFolder, file);
    let stat;
    try { stat = fs.lstatSync(source); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      output(`skipped ${file}: missing`);
      continue;
    }
    if (!stat.isFile()) output(`skipped ${file}: not a regular file`);
    else if (stat.size > ARCHIVE_MAX_BYTES) output(`skipped ${file}: over 1 MB`);
    else sources.push({ file, source });
  }
  if (runFile) {
    const stat = fs.lstatSync(runFile);
    if (!stat.isFile() || stat.size > ARCHIVE_MAX_BYTES) throw new Error('The failed run record is not a regular file under 1 MB.');
    sources.push({ file: 'run.json', source: runFile });
  }
  if (!sources.length) return null;
  const reports = path.join(mainRoot, ARCHIVE_FOLDER);
  realDirectory(path.join(mainRoot, '.orchestration'), '.orchestration');
  realDirectory(reports, 'Report archive folder');
  let target = path.join(reports, name);
  if (realDirectory(target, 'Archive folder') && sources.some(({ file }) => fs.existsSync(path.join(target, file)))) {
    const base = path.join(reports, `${name}-${utcStamp(now)}`);
    target = base;
    for (let counter = 2; fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false }); counter += 1) target = `${base}-${counter}`;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const { file, source } of sources) fs.copyFileSync(source, path.join(target, file), fs.constants.COPYFILE_EXCL);
  return target;
}
