// The command line of `herdr-boss goal set`.
// Exit codes: 0 goal active, 1 usage or refusal (thrown), 2 pane busy or not an orchestrator pane, 3 sent but not verified, 130 cancelled with SIGINT.
import { verifyMessageCaller } from './messages.js';
import { EXIT_CODES, GoalError, OUTCOME_TEXT, paneBlocker, resolveGoalTarget, setGoal } from './goal-set.js';
import { goalSetText } from './goal.js';

export const GOAL_USAGE = 'Usage: goal set <project|pane> [--text TEXT] [--dry-run]';

function usageError(message) { return new GoalError(`${message} ${GOAL_USAGE}`, EXIT_CODES.usage); }

// Turn the arguments after `goal set` into { target, text, dryRun }. Throws with the usage line on a bad flag.
export function parseGoalArgs(args) {
  const positional = [];
  let text;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--text') {
      if (text !== undefined) throw usageError('--text may be used only once.');
      text = args[++index];
      if (text === undefined || text.startsWith('--')) throw usageError('--text needs a value.');
    } else if (token === '--dry-run') {
      if (dryRun) throw usageError('--dry-run may be used only once.');
      dryRun = true;
    } else if (token.startsWith('--')) throw usageError(`Unknown option: ${token}.`);
    else positional.push(token);
  }
  if (positional.length !== 1) throw usageError('Give exactly one project slug or pane id.');
  return { target: positional[0], text, dryRun };
}

// A plain terminal is the Owner. A pane must be labeled boss or orch. A worker pane is refused.
export function verifyGoalCaller(env, herdr) {
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  try { return verifyMessageCaller(env, herdr, 'goal set'); } catch (error) {
    throw new GoalError(error.message.replace(' A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.', ' A worker asks its orchestrator.'));
  }
}

// Run `goal set`. Returns the exit code. A usage error or a refusal throws.
// options: env, herdr (sync runner of the CLI), control, policy, log, and the clock, sleep, waitMs, pollMs of setGoal.
export async function goalCommand(args, { env = process.env, herdr, control = {}, policy = {}, log = console.log, ...timing } = {}) {
  const [action, ...rest] = args;
  if (action !== 'set') throw new GoalError(GOAL_USAGE);
  // The caller check runs first: a worker pane must not reach any other step.
  const caller = verifyGoalCaller(env, herdr);
  const options = parseGoalArgs(rest);
  const checked = goalSetText(options.text ?? policy.defaultOrchestratorGoal ?? '');
  if (checked.error) throw new GoalError(options.text === undefined ? `No --text given and the Settings default goal is unusable: ${checked.error}` : checked.error);
  const run = async (command) => herdr(command);
  let target;
  try { target = await resolveGoalTarget(options.target, { run, control }); }
  catch (error) { if (error instanceof GoalError && error.code === EXIT_CODES.busy) { log(`Error: ${error.message}`); return EXIT_CODES.busy; } throw error; }
  if (caller.role === 'orch' && caller.workspaceId !== target.workspace) {
    throw new GoalError(`An orchestrator sets only the goal of its own project. Pane ${target.pane} is in another workspace.`);
  }
  log(`Goal for ${target.slug ?? target.pane}: pane ${target.pane}, agent ${target.kind}`);
  log(`Text: ${checked.text}`);
  if (options.dryRun) {
    const blocker = await paneBlocker({ run, pane: target.pane, kind: target.kind });
    log(`Dry run: the pane ${blocker ? `cannot take the command now (${blocker})` : 'can take the command now'}. Nothing was sent.`);
    return EXIT_CODES.active;
  }
  const result = await setGoal({ pane: target.pane, kind: target.kind, goal: checked.text, run, onState: (state, reason) => { if (state === 'waiting' && reason) log(`Waiting: ${reason}`); }, ...timing });
  log(`${result.message}${result.reason ? ` (${result.reason})` : ''}`);
  return EXIT_CODES[result.outcome];
}

export { OUTCOME_TEXT };
