// The command line of `herdr-boss project new` and `herdr-boss project check`.
// Exit codes: 0 done, 1 usage or refusal (thrown), 2 not built, 3 waiting for an Owner decision.
import { verifyMessageCaller } from './messages.js';
import { runProjectNew } from './project-new.js';

export const PROJECT_NEW_USAGE = 'Usage: project new <slug> [--group DIR | --path DIR] [--remote gh|URL|none] [--visibility private|public] [--org NAME] [--kind claude|codex] [--goal TEXT] [--start] [--dry-run] [--resume]';
export const PROJECT_CHECK_USAGE = 'Usage: project check <slug>';
export const PROJECT_USAGE = `${PROJECT_NEW_USAGE}\n${PROJECT_CHECK_USAGE}`;
export const EXIT_NOT_BUILT = 2;

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
  return `  ${step.name.padEnd(10)}${[state, detail].filter(Boolean).join(' ')}`;
}

// Run `project new` or `project check`. Returns the exit code. A usage error or a refusal throws.
export function projectCommand(args, { env = process.env, herdr, dataDir, log = console.log } = {}) {
  const [action, ...rest] = args;
  if (action === 'check') {
    if (rest.length !== 1 || rest[0].startsWith('--')) throw new Error(PROJECT_CHECK_USAGE);
    log('project check is not built yet');
    return EXIT_NOT_BUILT;
  }
  if (action !== 'new') throw new Error(PROJECT_USAGE);
  // The caller check runs first: a worker pane must not reach any other step.
  verifyProjectCaller(env, herdr);
  const options = parseProjectNewArgs(rest);
  const result = runProjectNew({ ...options, dataDir });
  log(`${result.dryRun ? 'Dry run' : 'Project'} ${result.slug}`);
  for (const step of result.steps) log(stepLine(step));
  log(`Path: ${result.path}`);
  if (!result.ok) {
    log(`Error: ${result.error}`);
    log('Next: fix the error, then run the same command with --resume.');
    return 1;
  }
  if (result.dryRun) log('Next: run the same command without --dry-run.');
  else log(`Next: open ${result.path}, describe the goal in README.md, and commit. The steps marked "not built yet" do not run yet.`);
  return 0;
}
