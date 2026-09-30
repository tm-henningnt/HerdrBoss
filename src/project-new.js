// The flow of `herdr-boss project new`: validate the inputs, create the folder, write the first files.
// Later steps (remote, policy, register, workspace, harness, check) are named and report `not built yet`.
// The state file flows/<slug>.json in the data dir records finished steps, so a rerun continues where the last run stopped.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, LIVE_DATA_DIR } from './config.js';
import { KIT_ROOT } from './kit/config.js';
import { agentsWithStub, installKit } from './kit/agents-check.js';
import { scanStaged } from './secret-scan.js';
import { readProjectRepos } from './harness.js';
import { SLUG } from './projects.js';

export const PROJECT_NEW_STEPS = ['validate', 'folder', 'files', 'kit', 'commit', 'remote', 'policy', 'register', 'workspace', 'harness', 'check'];
const NOT_BUILT = new Set(['remote', 'policy', 'register', 'workspace', 'harness', 'check']);
const TEMPLATES = path.join(KIT_ROOT, 'kit', 'templates');
const GITIGNORE = 'node_modules/\n.DS_Store\n.orchestration/\n.worker/\n';
const COMMIT_MESSAGE = 'Set up the project with Herdr Boss';
const DEFAULT_GOAL = 'Describe the goal of this project here.';

export class ProjectNewError extends Error {}
function refuse(message) { throw new ProjectNewError(message); }

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Turn the options into the resolved inputs that the state file records.
export function resolveInputs(options) {
  const slug = typeof options.slug === 'string' ? options.slug : '';
  if (!SLUG.test(slug)) refuse('The slug must match [a-z0-9][a-z0-9-]{0,63}.');
  if (options.group && options.path) refuse('Give only one of --group and --path.');
  if (!options.group && !options.path) refuse('Give --group DIR or --path DIR. There is no default folder.');
  const name = String(options.name || slug).trim() || slug;
  if (options.group && (/[\\/\0]/.test(name) || name === '..' || name.startsWith('.'))) refuse('With --group the name must be one folder name: no slash, no "..", no leading dot.');
  const dir = options.path ? path.resolve(options.path) : path.join(path.resolve(options.group), name);
  const goal = String(options.goal || '').trim().slice(0, 1000);
  return { slug, name, path: dir, goal };
}

// The real path of a path that may not exist yet: the real path of the nearest existing ancestor plus the missing segments.
function realTarget(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try { return { real: path.join(fs.realpathSync(current), ...missing), ancestor: current }; } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
function realOrResolved(dir) { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } }

function checkFolder(dir, { dataDir, repoRoot, group, ceiling }) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) refuse(`The path ${dir} is a symlink.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { real, ancestor } = realTarget(dir);
  for (const guard of [repoRoot]) if (inside(dir, guard) || inside(real, realOrResolved(guard))) refuse(`The path ${dir} is inside the Herdr Boss repository.`);
  for (const guard of [dataDir, LIVE_DATA_DIR]) if (inside(dir, guard) || inside(real, realOrResolved(guard))) refuse(`The path ${dir} is inside the data dir.`);
  if (group && !inside(real, realTarget(group).real)) refuse(`The path ${dir} is outside the group ${group}.`);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (error) {
    if (error.code === 'ENOENT') entries = null;
    else if (error.code === 'ENOTDIR') refuse(`The path ${dir} is a file.`);
    else throw error;
  }
  if (entries) {
    if (fs.existsSync(path.join(dir, '.git'))) refuse(`The path ${dir} is already a Git repository.`);
    if (entries.length) refuse(`The folder ${dir} is not empty.`);
  }
  // A new project is a new top-level repository. Refuse a target below any folder that holds .git.
  const stop = ceiling ? realOrResolved(ceiling) : path.parse(ancestor).root;
  for (let current = fs.realpathSync(ancestor); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git')) && !(entries && current === real)) refuse(`The path ${dir} is inside another Git repository (${current}).`);
    if (current === stop || current === path.dirname(current)) break;
  }
}

function checkSlug(slug, dataDir) {
  const registered = readProjectRepos(dataDir).some((row) => row.slug === slug) || fs.existsSync(path.join(dataDir, 'projects', `${slug}.json`));
  if (registered) refuse(`The slug ${slug} is already registered.`);
}

function stateFilePath(dataDir, slug) { return path.join(dataDir, 'flows', `${slug}.json`); }
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function writeState(file, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A unique name and flag wx: a planted file or symlink at the temp path is never followed.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function template(file, values) {
  return fs.readFileSync(path.join(TEMPLATES, file), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

// The files of the `files` step, each as [relative path, content].
function projectFiles(inputs) {
  const values = { name: inputs.name, slug: inputs.slug, goal: inputs.goal || DEFAULT_GOAL };
  return [
    ['AGENTS.md', () => agentsWithStub(template('agents-project.md', values))],
    ['docs/orchestration/memory.md', () => `# ${inputs.name} project memory\n\n${template('project-memory.md', values)}`],
    ['.herdr-boss.json', () => `${JSON.stringify({ slug: inputs.slug }, null, 2)}\n`],
    ['.gitignore', () => GITIGNORE],
    ['README.md', () => template('readme.md', values)],
    ['docs/ideas/.gitkeep', () => ''],
  ];
}

const DESCRIBE = {
  validate: (i) => `check the slug ${i.slug}, the folder ${i.path}, and that the slug is not registered`,
  folder: (i) => `run mkdir -p ${i.path}, then git init -b main`,
  kit: (i) => `write the kit file, the AGENTS.md stub, and the SessionStart hook in ${i.path}/.claude/settings.json`,
  commit: () => `stage all files, scan the staged files for secrets, and commit "${COMMIT_MESSAGE}"`,
  files: (i) => `write ${projectFiles(i).map(([f]) => f).join(', ')} in ${i.path}; keep each file that exists`,
};

const RUN = {
  validate(inputs, context) {
    checkFolder(inputs.path, context);
    checkSlug(inputs.slug, context.dataDir);
    return 'inputs are valid';
  },
  folder(inputs) {
    fs.mkdirSync(inputs.path, { recursive: true });
    if (!fs.existsSync(path.join(inputs.path, '.git'))) {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inputs.path, stdio: 'pipe' });
    }
    return `created ${inputs.path} with a Git repository on main`;
  },
  files(inputs) {
    const written = [];
    const kept = [];
    for (const [relative, content] of projectFiles(inputs)) {
      const file = path.join(inputs.path, relative);
      if (fs.existsSync(file)) { kept.push(relative); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { fs.writeFileSync(file, content(), { flag: 'wx' }); written.push(relative); } catch (error) {
        if (error.code === 'EEXIST') kept.push(relative); else throw error;
      }
    }
    return `wrote ${written.length} files, kept ${kept.length} existing files`;
  },
  kit(inputs) {
    const result = installKit(inputs.path);
    return `kit revision ${result.revision}: wrote ${result.written.length} files, kept ${result.unchanged.length} unchanged`;
  },
  commit(inputs, context) {
    const cwd = inputs.path;
    const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    try { git(['rev-parse', '--verify', '-q', 'HEAD']); return 'the project already has a commit'; } catch {}
    // git var honors the environment and fails when it cannot build an identity. Nothing here invents one or writes config.
    try { git(['var', 'GIT_AUTHOR_IDENT']); git(['var', 'GIT_COMMITTER_IDENT']); } catch {
      refuse('Git has no user.name or user.email. Set them with git config, then run the flow again with --resume.');
    }
    git(['add', '-A']);
    const findings = scanStaged(cwd, { allowUnscanned: context.allowUnscanned });
    if (findings.length) {
      try { git(['reset', '-q']); } catch { git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']); }
      refuse(`The commit is refused. ${findings.map((f) => `${f.file}: ${f.classes.join(', ')}`).join('; ')}. Remove each secret, then run the flow again with --resume.`);
    }
    git(['commit', '-q', '-m', COMMIT_MESSAGE]);
    return `committed ${git(['rev-parse', '--short', 'HEAD'])}`;
  },
};

// Run the flow. Input errors throw ProjectNewError before any change.
// A step failure is recorded in the state file and returned as { ok: false, error }.
// options: slug, group | path, name, goal, dryRun, resume, dataDir, repoRoot (the Herdr Boss repository, default: this one), ceiling, allowUnscanned (paths of large or binary files that the commit scan skips, default none), stepRunners (tests replace step functions).
export function runProjectNew(options = {}) {
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const inputs = resolveInputs(options);
  const stateFile = stateFilePath(dataDir, inputs.slug);
  const saved = readState(stateFile);
  if (options.resume && !saved) refuse(`There is no state for ${inputs.slug}. Nothing to resume.`);
  if (saved && JSON.stringify(saved.inputs) !== JSON.stringify(inputs)) refuse(`The state for ${inputs.slug} has different inputs. Use the same inputs, or remove ${stateFile}.`);
  const state = saved || { inputs, createdAt: new Date().toISOString(), steps: {} };
  // ceiling (tests): the nested-repository walk stops at this folder.
  const context = { dataDir, repoRoot: path.resolve(options.repoRoot || KIT_ROOT), group: options.group ? path.resolve(options.group) : null, ceiling: options.ceiling, allowUnscanned: options.allowUnscanned || [] };
  const runners = { ...RUN, ...(options.stepRunners || {}) };
  const finished = (name) => ['done', 'skipped'].includes(state.steps[name]?.status);
  const result = { ok: true, dryRun: Boolean(options.dryRun), slug: inputs.slug, path: inputs.path, stateFile, steps: [] };

  if (options.dryRun) {
    if (!finished('validate')) { checkFolder(inputs.path, context); checkSlug(inputs.slug, dataDir); }
    for (const name of PROJECT_NEW_STEPS) {
      const detail = NOT_BUILT.has(name) ? 'not built yet' : `would ${DESCRIBE[name](inputs)}`;
      result.steps.push({ name, status: finished(name) ? state.steps[name].status : 'planned', detail });
    }
    return result;
  }

  if (!finished('validate')) { checkFolder(inputs.path, context); checkSlug(inputs.slug, dataDir); }
  let ran = false;
  for (const name of PROJECT_NEW_STEPS) {
    if (NOT_BUILT.has(name)) { result.steps.push({ name, status: 'not-built', detail: 'not built yet' }); continue; }
    if (finished(name)) { result.steps.push({ name, status: state.steps[name].status, detail: state.steps[name].detail }); continue; }
    ran = true;
    try {
      const detail = runners[name](inputs, context) || 'done';
      state.steps[name] = { status: 'done', at: new Date().toISOString(), detail };
      result.steps.push({ name, status: 'done', detail });
    } catch (error) {
      state.steps[name] = { status: 'failed', at: new Date().toISOString(), detail: error.message };
      result.steps.push({ name, status: 'failed', detail: error.message });
      result.ok = false;
      result.error = error.message;
      for (const rest of PROJECT_NEW_STEPS.slice(PROJECT_NEW_STEPS.indexOf(name) + 1)) result.steps.push({ name: rest, status: 'pending', detail: 'waits for the failed step' });
      break;
    }
  }
  if (ran) {
    state.updatedAt = new Date().toISOString();
    writeState(stateFile, state);
  }
  return result;
}
