// The `herdr-boss plan` commands. See docs/cli.md, section Planner sessions.
// Exit codes: 0 done, 1 usage or refusal, 3 the session does not exist.
// Every function takes the environment, the Herdr runner, the data dir, and the time as options, so a test never reads the live data dir.
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';
import { readControl, verifyMessageCaller } from './messages.js';
import { ReviewCliError, isPlainTerminal, projectOf, verifyReviewCaller } from './review-cli.js';
import { PLANNER_LABEL, startSession, listSessions, getSession, endSession } from './planner-sessions.js';

export const EXIT = Object.freeze({ ok: 0, refused: 1, missing: 3 });

const projectWorkspace = (control, project) => Object.values(control?.projects || {}).find((entry) => entry?.slug === project)?.workspace ?? null;

const USAGE = {
  start: 'Usage: plan start KIND PROJECT --input PATH --pane PANE',
  list: 'Usage: plan list [PROJECT] [--all] [--json]',
  end: 'Usage: plan end ID',
};
const USAGE_ALL = `${USAGE.start}\n${USAGE.list}\n${USAGE.end}`;

// Parse `--flag VALUE` and `--switch` options. Each option appears at most once. Other tokens are positional.
function parse(args, { values = [], switches = [] }, usage) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (![...values, ...switches].includes(token)) throw new ReviewCliError(`Unknown option: ${token}. ${usage}`);
    if (token in flags) throw new ReviewCliError(`${token} may be used only once.`);
    if (switches.includes(token)) { flags[token] = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new ReviewCliError(`${token} needs a value.`);
    flags[token] = value;
  }
  return { flags, positional };
}

function startCommand(args, ctx) {
  const { flags, positional } = parse(args, { values: ['--input', '--pane'] }, USAGE.start);
  if (positional.length !== 2) throw new ReviewCliError(USAGE.start);
  const [kind, project] = positional;
  if (!SLUG.test(project)) throw new ReviewCliError(`The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${USAGE.start}`);
  if (flags['--input'] === undefined) throw new ReviewCliError(`--input is required. ${USAGE.start}`);
  if (flags['--pane'] === undefined) throw new ReviewCliError(`--pane is required. ${USAGE.start}`);
  const caller = verifyReviewCaller('plan start', project, ctx);
  // The target pane must belong to the workspace of the caller. A plain terminal uses the workspace of the project.
  const expected = caller.role === 'owner' ? projectWorkspace(ctx.control(), project) : ctx.env.HERDR_WORKSPACE_ID;
  if (!expected) throw new ReviewCliError(`No workspace is known for project ${project}. Publish the project status, then wait for the next Herdr Boss tick.`);
  let target;
  try { const response = ctx.herdr(['pane', 'get', flags['--pane']]); target = response?.pane ?? response ?? {}; }
  catch (error) { throw new ReviewCliError(`Herdr could not read pane ${flags['--pane']}: ${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`); }
  const targetId = target.pane_id ?? target.paneId ?? target.id ?? null;
  const targetWorkspace = target.workspace_id ?? target.workspaceId ?? target.workspace ?? null;
  if (targetId !== flags['--pane']) throw new ReviewCliError(`Herdr returned the pane ${targetId ?? '(missing)'} for ${flags['--pane']}.`);
  if (targetWorkspace !== expected) throw new ReviewCliError(`The pane ${flags['--pane']} is in workspace ${targetWorkspace ?? '(unknown)'}, not in ${expected}. A planner session needs a pane of the workspace of its project.`);
  if (['boss', 'orch'].includes(target.label)) throw new ReviewCliError(`The pane ${flags['--pane']} is labeled ${target.label}. A planner session cannot take that pane.`);
  // The label comes first: a pane that Herdr cannot label gets no record.
  ctx.herdr(['pane', 'rename', flags['--pane'], PLANNER_LABEL]);
  let session;
  try { session = startSession({ dir: ctx.dir, now: ctx.now, kind, project, pane: flags['--pane'], input: flags['--input'] }); }
  catch (error) {
    try { ctx.herdr(['pane', 'rename', flags['--pane'], '--clear']); } catch { /* the label stays; plan end clears it */ }
    throw error;
  }
  ctx.out(`Started planner session ${session.id} for ${project} on pane ${session.pane}.`);
  return EXIT.ok;
}

function listCommand(args, ctx) {
  const { flags, positional } = parse(args, { switches: ['--all', '--json'] }, USAGE.list);
  if (positional.length > 1) throw new ReviewCliError(USAGE.list);
  let project = positional[0];
  if (project !== undefined && !SLUG.test(project)) throw new ReviewCliError(`The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${USAGE.list}`);
  // The scope is the same as for `review list`. An orch pane lists its own project. The Boss and a plain terminal list every project.
  if (!isPlainTerminal(ctx.env)) {
    const caller = verifyMessageCaller(ctx.env, ctx.herdr, 'plan list');
    if (caller.role === 'orch') {
      const own = projectOf(ctx.control(), caller.workspaceId);
      if (!own) throw new ReviewCliError(`No project uses workspace ${caller.workspaceId}. Publish the project status, then wait for the next Herdr Boss tick.`);
      if (project !== undefined && project !== own) throw new ReviewCliError(`This pane belongs to project ${own}. It can run herdr-boss plan list only for the slug ${own}, not for ${project}.`);
      project = own;
    }
  }
  const sessions = listSessions({ dir: ctx.dir, project, all: !!flags['--all'] });
  if (flags['--json']) { ctx.out(JSON.stringify(sessions, null, 2)); return EXIT.ok; }
  if (!sessions.length) { ctx.out('No planner sessions.'); return EXIT.ok; }
  for (const entry of sessions) {
    ctx.out(`${entry.id}  ${entry.project}  ${entry.kind}  pane ${entry.pane}  round ${entry.round}  ${entry.endedAt ? `ended ${entry.endedAt}` : `started ${entry.startedAt}`}  ${entry.input}`);
  }
  return EXIT.ok;
}

function endCommand(args, ctx) {
  const { positional } = parse(args, {}, USAGE.end);
  if (positional.length !== 1) throw new ReviewCliError(USAGE.end);
  const session = getSession({ dir: ctx.dir, id: positional[0] });
  if (!session) { ctx.err(`No planner session ${positional[0]} exists.`); return EXIT.missing; }
  verifyReviewCaller('plan end', session.project, ctx);
  if (session.endedAt) throw new ReviewCliError(`The planner session ${session.id} already ended at ${session.endedAt}.`);
  endSession({ dir: ctx.dir, now: ctx.now, id: session.id });
  try { ctx.herdr(['pane', 'rename', session.pane, '--clear']); }
  catch (error) { ctx.out(`Ended ${session.id}. Herdr could not clear the label of pane ${session.pane}: ${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`); return EXIT.ok; }
  ctx.out(`Ended planner session ${session.id}.`);
  return EXIT.ok;
}

// Run one plan command. Returns the exit code.
export function planCommand(args, { env = process.env, herdr, dir = DATA_DIR, now = Date.now(), out = (line) => console.log(line), err = (line) => console.error(line) } = {}) {
  const [sub, ...rest] = args;
  let control = null;
  const ctx = { env, herdr, dir, now, out, err, control: () => (control ??= readControl(dir)) };
  const commands = { start: startCommand, list: listCommand, end: endCommand };
  try {
    if (!Object.hasOwn(commands, sub)) throw new ReviewCliError(USAGE_ALL);
    return commands[sub](rest, ctx);
  } catch (error) {
    if (error instanceof ReviewCliError) { err(error.message); return error.exitCode; }
    err(error instanceof Error ? error.message : String(error));
    return EXIT.refused;
  }
}
