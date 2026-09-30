// The flow of `herdr-boss project new`: validate the inputs, create the folder, write the first files.
// The step check is named and reports `not built yet`.
// The state file flows/<slug>.json in the data dir records finished steps, so a rerun continues where the last run stopped.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, LIVE_DATA_DIR } from './config.js';
import { KIT_ROOT } from './kit/config.js';
import { agentsWithStub, installKit } from './kit/agents-check.js';
import { scanStaged } from './secret-scan.js';
import { readProjectRepos, recordProjectRepo } from './harness.js';
import { SLUG, validateProject, writeProject } from './projects.js';
import { loadPolicy, savePolicy } from './control.js';
import { loadModels } from './kit/config.js';
import { kitRevision } from './kit/agents-check.js';
import { describeWorkspace, workspaceStep } from './project-new-workspace.js';
import { describeHarness, harnessStep } from './project-new-check.js';
import { ORG_NAME, RemoteError, checkDecision, describeRemote, remoteStep, validateRemoteUrl } from './project-new-remote.js';

export const PROJECT_NEW_STEPS = ['validate', 'folder', 'files', 'kit', 'commit', 'remote', 'policy', 'register', 'status', 'workspace', 'harness', 'check'];
export const NOT_BUILT = new Set(['check']);
// `project check --fix STEP` runs one of these. validate refuses a folder that exists. check is not a change.
export const FIXABLE_STEPS = PROJECT_NEW_STEPS.filter((name) => !['validate', 'check'].includes(name));
export const NEW_PROJECT_SHARE = 10;
const TEMPLATES = path.join(KIT_ROOT, 'kit', 'templates');
const GITIGNORE = 'node_modules/\n.DS_Store\n.orchestration/\n.worker/\n';
const COMMIT_MESSAGE = 'Set up the project with Herdr Boss';
const FIRST_TASK = 'Set up the project';
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
// The saved state of a flow, or null. The dashboard status route reads it.
export function readFlowState(dataDir, slug) { return readState(stateFilePath(path.resolve(dataDir), slug)); }
// Mark the first unfinished step as failed after a crash of the process that ran the flow. Returns the step name, or null when there is no state.
export function markFlowCrashed(dataDir, slug, message) {
  const file = stateFilePath(path.resolve(dataDir), slug);
  const state = readState(file);
  if (!state) return null;
  const name = PROJECT_NEW_STEPS.find((step) => !NOT_BUILT.has(step) && !['done', 'skipped'].includes(state.steps?.[step]?.status));
  if (!name) return null;
  state.steps[name] = { status: 'failed', at: new Date().toISOString(), detail: message };
  state.updatedAt = new Date().toISOString();
  writeState(file, state);
  return name;
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

// Add the entry of a new project to a policy object. Return { policy, changed, before, after }.
// before and after map each slug to its share. The input is not changed.
// The other shares scale down to make room for the new project when the total would pass 100.
// The largest remainder method keeps the scaled total exact. The order of the entries breaks a tie.
// Only shares change. A share of 1 or more that would fall below 1 is refused.
export function addProjectPolicy(policy, slug, options = {}) {
  const share = options.share ?? NEW_PROJECT_SHARE;
  if (!Number.isInteger(share) || share < 1 || share > 100) refuse('The share of a new project must be a whole number from 1 to 100.');
  const next = structuredClone(policy || {});
  next.projects = next.projects && typeof next.projects === 'object' && !Array.isArray(next.projects) ? next.projects : {};
  const shares = () => Object.fromEntries(Object.entries(next.projects).map(([name, project]) => [name, project.share]));
  const before = shares();
  for (const [name, value] of Object.entries(before)) {
    if (!Number.isInteger(value) || value < 0) refuse(`The share of ${name} is not a whole number of 0 or more. Correct it in the dashboard, then run the flow again with --resume.`);
  }
  if (Object.hasOwn(next.projects, slug)) return { policy: next, changed: false, before, after: before };
  const sum = Object.values(before).reduce((acc, value) => acc + value, 0);
  const room = 100 - share;
  if (sum > room) {
    const names = Object.keys(next.projects);
    const parts = names.map((name, order) => {
      const exact = before[name] * room / sum;
      return { name, order, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    let spare = room - parts.reduce((acc, part) => acc + part.floor, 0);
    for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.order - b.order)) {
      if (spare <= 0) break;
      part.floor += 1;
      spare -= 1;
    }
    // A share of 1 or more stays at 1 or more. The shares that scale the most give up the points.
    for (const part of parts) {
      if (before[part.name] < 1 || part.floor >= 1) continue;
      const donor = [...parts].sort((a, b) => b.floor - a.floor || a.order - b.order)[0];
      if (donor.floor <= 1) refuse(`The share of ${part.name} would fall below 1 (${before[part.name]} -> 0). Lower a share in the dashboard, then run the flow again with --resume.`);
      donor.floor -= 1;
      part.floor = 1;
    }
    for (const part of parts) next.projects[part.name].share = part.floor;
  }
  next.projects[slug] = { share, mode: 'auto', excludedKinds: [], excludedModels: [] };
  return { policy: next, changed: true, before, after: shares() };
}

const showShares = (shares) => Object.entries(shares).map(([name, value]) => `${name} ${value}`).join(', ') || 'none';

function policyFile(dataDir) { return path.join(dataDir, 'policy.json'); }

// Read the local policy, add the project, and save through the validated writer of `policy set`.
function applyProjectPolicy(slug, dataDir) {
  const file = policyFile(dataDir);
  const models = loadModels();
  const result = addProjectPolicy(loadPolicy({ file, models, warn: () => {} }), slug);
  if (!result.changed) return `the policy already has ${slug}, shares unchanged: ${showShares(result.after)}`;
  const errors = savePolicy(result.policy, models, { file, caller: 'project-new' });
  if (errors.length) refuse(`The policy is not valid: ${errors.join(' ')}`);
  return `added ${slug} with share ${result.after[slug]}. Shares before: ${showShares(result.before)}. Shares after: ${showShares(result.after)}`;
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
  policy: (i) => `add ${i.slug} to the policy with share ${NEW_PROJECT_SHARE} and scale the other shares down so the total stays at most 100`,
  register: (i) => `record ${i.slug} and ${i.path} in project-repos.json`,
  status: (i) => `publish the first status of ${i.slug} with the task "${FIRST_TASK}"`,
  remote: describeRemote,
  workspace: describeWorkspace,
  harness: describeHarness,
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
  remote: remoteStep,
  policy(inputs, context) { return applyProjectPolicy(inputs.slug, context.dataDir); },
  register(inputs, context) {
    const git = (args) => execFileSync('git', args, { cwd: inputs.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    const repo = git(['rev-parse', '--show-toplevel']);
    let remote = '';
    try { remote = git(['remote', 'get-url', 'origin']); } catch {}
    const row = readProjectRepos(context.dataDir).find((r) => r.slug === inputs.slug);
    if (row) {
      const same = (a, b) => realOrResolved(a) === realOrResolved(b);
      if (!same(row.repo, repo)) refuse(`The slug ${inputs.slug} is registered with another folder: ${row.repo}. This project is ${repo}.`);
      return `${inputs.slug} is already registered with ${row.repo}`;
    }
    if (!recordProjectRepo(inputs.slug, repo, remote, { dataDir: context.dataDir }).recorded) refuse(`The project ${inputs.slug} could not be registered.`);
    return `registered ${inputs.slug} with ${repo}`;
  },
  workspace: workspaceStep,
  harness: harnessStep,
  status(inputs, context) {
    const dir = path.join(context.dataDir, 'projects');
    if (fs.existsSync(path.join(dir, `${inputs.slug}.json`))) return `${inputs.slug} already has a status`;
    const data = {
      project: inputs.name,
      ...(inputs.goal ? { goal: inputs.goal } : {}),
      summary: `New project. ${FIRST_TASK}.`,
      kitRevision: kitRevision(),
      tasks: [{ id: 'set-up-the-project', title: FIRST_TASK, status: 'todo', priority: 1 }],
    };
    const errors = writeProject(inputs.slug, data, { dir });
    if (errors.length) refuse(`The first status is not valid: ${errors.join(' ')}`);
    return `published the first status of ${inputs.slug}`;
  },
};

// The context of the step functions. ceiling (tests): the nested-repository walk stops at this folder.
// home and reserveBrowser belong to the step harness. persist false keeps the ids in memory only.
function makeContext(options, { dataDir, state, stateFile, persist }) {
  return { dataDir, repoRoot: path.resolve(options.repoRoot || KIT_ROOT), group: options.group ? path.resolve(options.group) : null, ceiling: options.ceiling, allowUnscanned: options.allowUnscanned || [],
    remote: options.remote ?? 'none', visibility: options.visibility ?? 'private', decision: options.decision, org: options.org, start: Boolean(options.start), kind: options.kind, herdr: options.herdr, hooks: options.hooks, env: options.env, home: options.home, reserveBrowser: options.reserveBrowser, ids: state.ids,
    remember(patch) { Object.assign(state.ids, patch); if (!persist) return; state.updatedAt = new Date().toISOString(); writeState(stateFile, state); } };
}

// Run the flow. Input errors throw ProjectNewError before any change.
// A step failure is recorded in the state file and returned as { ok: false, error }.
// options: slug, group | path, name, goal, remote (gh, none, or a Git URL; default none), visibility (private or public), org, dryRun, resume, dataDir, repoRoot (the Herdr Boss repository, default: this one), ceiling, allowUnscanned (paths of large or binary files that the commit scan skips, default none), stepRunners (tests replace step functions), home and reserveBrowser (the step harness).
export function runProjectNew(options = {}) {
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const inputs = resolveInputs(options);
  if (options.org !== undefined && !ORG_NAME.test(String(options.org))) refuse('The organization must be an organization or user name: letters, digits, and hyphens, and it must not start with a hyphen.');
  if (options.remote && options.remote !== 'gh' && options.remote !== 'none') {
    try { validateRemoteUrl(options.remote); } catch (error) { if (error instanceof RemoteError) refuse(error.message); throw error; }
  }
  if (options.decision !== undefined) {
    try { checkDecision(options.decision); } catch (error) { if (error instanceof RemoteError) refuse(error.message); throw error; }
    if (options.remote !== 'gh') refuse('A decision needs --remote gh.');
    if (options.visibility !== undefined && options.visibility !== options.decision.visibility) refuse('The decision visibility must match the visibility option.');
  }
  const stateFile = stateFilePath(dataDir, inputs.slug);
  const saved = readState(stateFile);
  if (options.resume && !saved) refuse(`There is no state for ${inputs.slug}. Nothing to resume.`);
  if (saved && JSON.stringify(saved.inputs) !== JSON.stringify(inputs)) refuse(`The state for ${inputs.slug} has different inputs. Use the same inputs, or remove ${stateFile}.`);
  const state = saved || { inputs, createdAt: new Date().toISOString(), steps: {} };
  state.ids ||= {};
  const context = makeContext(options, { dataDir, state, stateFile, persist: true });
  const runners = { ...RUN, ...(options.stepRunners || {}) };
  // A step that was skipped for a missing --start runs when a later run gives --start.
  const finished = (name) => ['done', 'skipped'].includes(state.steps[name]?.status) && state.steps[name].reason !== 'no-start';
  const result = { ok: true, dryRun: Boolean(options.dryRun), slug: inputs.slug, path: inputs.path, stateFile, steps: [] };

  if (options.dryRun) {
    if (!finished('validate')) { checkFolder(inputs.path, context); checkSlug(inputs.slug, dataDir); }
    for (const name of PROJECT_NEW_STEPS) {
      const text = NOT_BUILT.has(name) ? null : DESCRIBE[name](inputs, context);
      const detail = text === null ? 'not built yet' : text.startsWith('skipped') ? text : `would ${text}`;
      result.steps.push({ name, status: finished(name) ? state.steps[name].status : 'planned', detail });
    }
    return result;
  }

  if (!finished('validate')) { checkFolder(inputs.path, context); checkSlug(inputs.slug, dataDir); }
  let ran = false;
  for (const name of PROJECT_NEW_STEPS) {
    if (NOT_BUILT.has(name)) { result.steps.push({ name, status: 'not-built', detail: 'not built yet' }); continue; }
    if (finished(name)) { result.steps.push({ name, status: state.steps[name].status, detail: state.steps[name].detail }); continue; }
    try {
      const outcome = runners[name](inputs, context) || 'done';
      const { status = 'done', detail, reason, lines } = typeof outcome === 'string' ? { detail: outcome } : outcome;
      // A skip for a missing --start changes nothing, so a repeated run writes no state.
      // Each recorded step is saved at once, so a status reader sees the progress of a running flow.
      if (!(reason === 'no-start' && state.steps[name]?.reason === 'no-start')) {
        state.steps[name] = { status, at: new Date().toISOString(), detail, ...(reason ? { reason } : {}) };
        state.updatedAt = new Date().toISOString();
        writeState(stateFile, state);
        ran = true;
      }
      result.steps.push({ name, status, detail, ...(lines?.length ? { lines } : {}) });
      if (status === 'waiting') {
        result.waiting = true;
        for (const rest of PROJECT_NEW_STEPS.slice(PROJECT_NEW_STEPS.indexOf(name) + 1)) result.steps.push({ name: rest, status: 'pending', detail: 'waits for the Owner decision' });
        break;
      }
    } catch (error) {
      ran = true;
      state.steps[name] = { status: 'failed', at: new Date().toISOString(), detail: error.message };
      state.updatedAt = new Date().toISOString();
      writeState(stateFile, state);
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

// Run one step again for `project check --fix STEP`. No other step runs.
// The flow state is optional: a project that project new did not make has none. The state file is updated only when it exists.
// options: slug, dataDir, start, kind, remote (default gh, so the step still asks the Owner), visibility, org, herdr, hooks, env, home, reserveBrowser, stepRunners.
// Returns { ok, waiting, step: { name, status, detail, lines } }. Input errors throw ProjectNewError.
export function runProjectStep(name, options = {}) {
  if (!FIXABLE_STEPS.includes(name)) refuse(`--fix needs one of: ${FIXABLE_STEPS.join(', ')}.`);
  const slug = typeof options.slug === 'string' ? options.slug : '';
  if (!SLUG.test(slug)) refuse('The slug must match [a-z0-9][a-z0-9-]{0,63}.');
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const stateFile = stateFilePath(dataDir, slug);
  const saved = readState(stateFile);
  let inputs = saved?.inputs;
  if (!inputs) {
    const row = readProjectRepos(dataDir).find((entry) => entry.slug === slug);
    if (!row) refuse(`The project ${slug} has no flow state and is not registered. The folder is unknown.`);
    inputs = { slug, name: path.basename(row.repo), path: row.repo, goal: '' };
  }
  const state = saved || { inputs, steps: {}, ids: {} };
  state.ids ||= {};
  const context = makeContext({ ...options, remote: options.remote ?? (name === 'remote' ? 'gh' : 'none') }, { dataDir, state, stateFile, persist: Boolean(saved) });
  const runner = { ...RUN, ...(options.stepRunners || {}) }[name];
  let step;
  try {
    const outcome = runner(inputs, context) || 'done';
    const { status = 'done', detail, reason, lines } = typeof outcome === 'string' ? { detail: outcome } : outcome;
    step = { name, status, detail, ...(lines?.length ? { lines } : {}) };
    if (saved) state.steps[name] = { status, at: new Date().toISOString(), detail, ...(reason ? { reason } : {}) };
  } catch (error) {
    step = { name, status: 'failed', detail: error.message };
    if (saved) state.steps[name] = { status: 'failed', at: new Date().toISOString(), detail: error.message };
  }
  if (saved) { state.updatedAt = new Date().toISOString(); writeState(stateFile, state); }
  return { ok: step.status !== 'failed', waiting: step.status === 'waiting', ...(step.status === 'failed' ? { error: step.detail } : {}), step };
}
