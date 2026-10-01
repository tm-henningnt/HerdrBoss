// The command line of `herdr-boss project new` and `herdr-boss project check`.
// Exit codes: 0 done, 1 usage or refusal (thrown), 2 not built, 3 waiting for an Owner decision, 4 project check found a missing item.
import { verifyMessageCaller } from './messages.js';
import { FIXABLE_STEPS, runProjectNew, runProjectStep } from './project-new.js';
import { checkProject, formatCheck } from './project-new-check.js';

export const PROJECT_NEW_USAGE = 'Usage: project new <slug> [--group DIR | --path DIR] [--remote gh|URL|none] [--visibility private|public] [--org NAME] [--kind claude|codex] [--goal TEXT] [--start] [--dry-run] [--resume]';
export const PROJECT_CHECK_USAGE = 'Usage: project check <slug> [--fix STEP [--start]]';
export const PROJECT_USAGE = `${PROJECT_NEW_USAGE}\n${PROJECT_CHECK_USAGE}`;
export const EXIT_NOT_BUILT = 2;
export const EXIT_WAITING = 3;
export const EXIT_MISSING = 4;

const VALUE_FLAGS = ['--group', '--path', '--remote', '--visibility', '--org', '--kind', '--goal'];
const BOOLEAN_FLAGS = ['--start', '--dry-run', '--resume'];
const REMOTE_URL = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)[^\s]+$/;

function usageError(message) { return new Error(`${message} ${PROJECT_NEW_USAGE}`); }

// Turn the arguments after `project new` into the options of runProjectNew. Throws with the usage line on a bad flag.
export function parseProjectNewArgs(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (!VALUE_FLAGS.includes(token) && !BOOLEAN_FLAGS.includes(token)) throw usageError(`Unknown option: ${token}.`);
    if (token in flags) throw usageError(`${token} may be used only once.`);
    if (BOOLEAN_FLAGS.includes(token)) { flags[token] = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw usageError(`${token} needs a value.`);
    flags[token] = value;
  }
  if (positional.length !== 1) throw usageError('Give exactly one slug.');
  if ('--group' in flags && '--path' in flags) throw usageError('Give only one of --group and --path.');
  if (!('--group' in flags) && !('--path' in flags)) throw usageError('Give --group DIR or --path DIR. There is no default folder.');
  const remote = flags['--remote'] ?? 'none';
  if (remote !== 'gh' && remote !== 'none') {
    // Never echo the value: a URL can hold a credential.
    if (!REMOTE_URL.test(remote)) throw usageError('--remote must be gh, none, or a Git URL (https, ssh, git, or user@host:path).');
    if (/^[a-z]+:\/\/[^/@]*@/i.test(remote)) throw usageError('--remote must not hold credentials. Remove the user name and the password from the URL.');
  }
  const visibility = flags['--visibility'] ?? 'private';
  if (!['private', 'public'].includes(visibility)) throw usageError('--visibility must be private or public.');
  if (visibility === 'public' && remote === 'none') throw usageError('--visibility public needs a remote that is not none.');
  const kind = flags['--kind'];
  if (kind !== undefined && !['claude', 'codex'].includes(kind)) throw usageError('--kind must be claude or codex.');
  const org = flags['--org'];
  if (org !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) throw usageError('--org must be an organization or user name.');
  return {
    slug: positional[0],
    group: flags['--group'],
    path: flags['--path'],
    remote,
    visibility,
    org,
    kind,
    goal: flags['--goal'],
    start: Boolean(flags['--start']),
    dryRun: Boolean(flags['--dry-run']),
    resume: Boolean(flags['--resume']),
  };
}

// A plain terminal is the Owner. A pane must be labeled boss or orch, the same pane check as `say`. A worker pane is refused.
export function verifyProjectCaller(env, herdr) {
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  try { return verifyMessageCaller(env, herdr, 'project new'); } catch (error) {
    throw new Error(error.message.replace(' A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.', ' A worker asks its orchestrator.'));
  }
}

const LABEL = { done: 'done', skipped: 'skipped', planned: '', 'not-built': 'not built yet', failed: 'failed', pending: 'pending', waiting: 'waiting' };

function stepLine(step) {
  const state = LABEL[step.status] ?? step.status;
  const detail = step.detail && step.detail !== 'done' && step.detail !== state ? step.detail : '';
  // A detail that starts with the state, such as "skipped: no --start", is not repeated.
  const same = detail.startsWith(`${state}:`);
  return `  ${step.name.padEnd(10)}${(same ? [detail] : [state, detail]).filter(Boolean).join(' ')}`;
}

// Turn the arguments after `project check` into { slug, fix, start }. Throws with the usage line on a bad argument.
export function parseProjectCheckArgs(args) {
  const fail = (message) => new Error(`${message} ${PROJECT_CHECK_USAGE}`);
  const positional = [];
  let fix;
  let start = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--fix') {
      if (fix !== undefined) throw fail('--fix may be used only once.');
      fix = args[++index];
      if (fix === undefined || fix.startsWith('--')) throw fail('--fix needs a step name.');
    } else if (token === '--start') {
      if (start) throw fail('--start may be used only once.');
      start = true;
    } else if (token.startsWith('--')) throw fail(`Unknown option: ${token}.`);
    else positional.push(token);
  }
  if (positional.length !== 1) throw fail('Give exactly one slug.');
  if (fix !== undefined && !FIXABLE_STEPS.includes(fix)) throw new Error(`--fix needs one of: ${FIXABLE_STEPS.join(', ')}.`);
  if (start && fix !== 'workspace') throw fail('--start is only for --fix workspace.');
  return { slug: positional[0], fix, start };
}

// Run `project check`. With --fix STEP, run that one step first, then check again.
// Exit code: 0 all items present, 3 the step waits for the Owner, 4 an item is missing. A failed step or a usage error gives 1.
function checkCommand(args, { herdr, dataDir, log, hooks, env, flowOptions }) {
  const { slug, fix, start } = parseProjectCheckArgs(args);
  let code = 0;
  if (fix) {
    // A fix changes files and can spend model quota or ask the Owner. The read-only check needs no caller check.
    verifyProjectCaller(env, herdr);
    const { decision: _decision, ...allowedFlow } = flowOptions; // eslint-disable-line no-unused-vars
    const fixed = runProjectStep(fix, { slug, start, dataDir, herdr, hooks, env, ...allowedFlow });
    log(`Fix ${fix} for ${slug}`);
    log(stepLine(fixed.step));
    for (const line of fixed.step.lines ?? []) log(`    ${line}`);
    if (!fixed.ok) code = 1;
    else if (fixed.waiting) code = EXIT_WAITING;
  }
  const check = checkProject(slug, { dataDir, herdr, home: flowOptions.home });
  for (const line of formatCheck(check)) log(line);
  return code || (check.ok ? 0 : EXIT_MISSING);
}

// Run `project new` or `project check`. Returns the exit code. A usage error or a refusal throws.
export function projectCommand(args, { env = process.env, herdr, dataDir, log = console.log, hooks, flowOptions = {} } = {}) {
  const [action, ...rest] = args;
  if (action === 'check') return checkCommand(rest, { herdr, dataDir, log, hooks, env, flowOptions });
  if (action !== 'new') throw new Error(PROJECT_USAGE);
  // The caller check runs first: a worker pane must not reach any other step.
  verifyProjectCaller(env, herdr);
  const options = parseProjectNewArgs(rest);
  // A decision belongs to the dashboard routes. The command line always asks in the Mailbox.
  const { decision: _decision, ...allowedFlow } = flowOptions; // eslint-disable-line no-unused-vars
  const result = runProjectNew({ ...options, dataDir, herdr, hooks, env, ...allowedFlow });
  log(`${result.dryRun ? 'Dry run' : 'Project'} ${result.slug}`);
  for (const step of result.steps) {
    log(stepLine(step));
    for (const line of step.lines ?? []) log(`    ${line}`);
  }
  log(`Path: ${result.path}`);
  if (result.waiting) {
    log('Waiting for an Owner decision. Answer the Mailbox item, then run the same command with --resume.');
    return EXIT_WAITING;
  }
  if (!result.ok) {
    log(`Error: ${result.error}`);
    log('Next: fix the error, then run the same command with --resume.');
    return 1;
  }
  if (result.dryRun) log('Next: run the same command without --dry-run.');
  else {
    if (result.steps.some((step) => step.name === 'workspace' && step.status === 'skipped')) log('Next: add --start to create the Herdr workspace and start the orchestrator. The command sends the first prompt to the model.');
    log(`Next: open ${result.path}, describe the goal in README.md, and commit. The steps marked "not built yet" do not run yet.`);
  }
  return 0;
}
