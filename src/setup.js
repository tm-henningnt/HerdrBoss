// Resumable first-hour setup. Persist only fixed step states and Owner confirmations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolveAlias } from './config.js';
import { assertSetupFiles, readDataFile, writeDataFile } from './data-file-safety.js';
import { runDoctor } from './doctor.js';
import { SETUP_ACTIONS, createSetupExecutor, hasSetupProject, readSetupPacing, runSetupAction } from './setup-actions.js';

export const SETUP_STEPS = Object.freeze([
  ['guide', 'Let an agent guide you'], ['check', 'Check your computer'],
  ['tools', 'Install the missing tools'], ['signin', 'Sign in to Claude'],
  ['settings', 'Let the agents work'], ['service', 'Start Herdr Boss'],
  ['pacing', 'Choose how to use your usage limits'], ['project', 'Create your first project'],
  ['dashboard', 'Open the dashboard'], ['answer', 'Answer your first question'],
  ['review', 'Review your first pack'],
].map(([id, name]) => Object.freeze({ id, name })));
export const SETUP_USAGE = 'Usage: setup [--resume] [--dry-run] [--pacing paced|unpaced]';
const STATES = new Set(['pending', 'done', 'waiting', 'failed']);
const DOCTOR_STEPS = new Set(['check', 'tools', 'signin', 'settings', 'service', 'pacing', 'dashboard']);
const SETUP_CONFLICT_MESSAGE = 'Another setup run changed the progress. Run setup --resume.';

function parseArgs(args) {
  const seen = new Set();
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!['--resume', '--dry-run', '--pacing'].includes(arg) || seen.has(arg)) throw new Error(SETUP_USAGE);
    seen.add(arg);
    if (arg === '--pacing') {
      options.pacing = args[++index];
      if (!['paced', 'unpaced'].includes(options.pacing)) throw new Error(SETUP_USAGE);
    } else options[arg === '--resume' ? 'resume' : 'dryRun'] = true;
  }
  return options;
}

export function readSetupState(dataDir) {
  let saved;
  try { saved = JSON.parse(readDataFile(path.join(dataDir, 'setup.json'), dataDir)); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw new Error('Cannot read setup progress. Check setup.json in the data folder.'); }
  if (saved?.schema !== 'herdr-boss.setup/1' || !saved.steps || typeof saved.steps !== 'object' || Array.isArray(saved.steps)) return null;
  const revision = saved.revision === undefined ? 0 : saved.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  // Copy only allowed values. Never carry an arbitrary field or command into a new write.
  const state = { schema: saved.schema, revision, steps: {} };
  for (const { id, name } of SETUP_STEPS) {
    const status = saved.steps[id]?.status ?? 'pending';
    if (!STATES.has(status)) return null;
    state.steps[id] = { name, status };
  }
  if (['paced', 'unpaced'].includes(saved.pacing)) state.pacing = saved.pacing;
  for (const key of ['dashboardOpened', 'answer', 'review']) if (saved[key] === true) state[key] = true;
  return state;
}

function writeState(dataDir, state) {
  assertSetupFiles(dataDir);
  if ((readSetupState(dataDir)?.revision ?? 0) !== state.revision) return false;
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('The setup progress revision cannot be increased.');
  writeDataFile(path.join(dataDir, 'setup.json'), `${JSON.stringify({ ...state, revision }, null, 2)}\n`, dataDir);
  state.revision = revision;
  return true;
}

async function terminalAsk(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(question); }
  finally { terminal.close(); }
}

function stepDone(id, report, context) {
  const { state, dataDir } = context;
  if (report && !report.ok) return false;
  if (id === 'guide') return true; // Choosing setup selects the terminal path.
  if (id === 'pacing') return Boolean(state.pacing) && readSetupPacing(dataDir) === (state.pacing === 'paced' ? 'managed' : 'ignore');
  if (id === 'project') return hasSetupProject(dataDir);
  if (id === 'dashboard') return state.dashboardOpened === true;
  if (id === 'answer' || id === 'review') return state[id] === true;
  return report?.ok === true;
}

export async function runSetup({ env = process.env, home = env.HOME || os.homedir(),
  dataDir = env.HERDR_BOSS_DIR || path.join(home, '.herdr-boss'), dryRun = false, resume = false,
  pacing, runner, timeoutMs, ask = terminalAsk, output = console.log, execute = createSetupExecutor({ env }) } = {}) {
  const steps = SETUP_STEPS.map((step) => ({ ...step, status: 'pending' }));
  if (dryRun) {
    output('Dry run: no files or settings change.');
    for (const { id, name } of steps) output(`${id}: ${name}. ${SETUP_ACTIONS[id]}`);
    return { exitCode: 0, steps: steps.map((step) => ({ ...step, status: 'planned' })), waitingStep: null };
  }
  const privateDir = resolveAlias(path.join(home, '.config', 'herdr-boss'));
  const relative = path.relative(privateDir, resolveAlias(dataDir));
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('The setup data folder must be outside the private access folder.');
  dataDir = resolveAlias(dataDir);
  assertSetupFiles(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const state = readSetupState(dataDir) ?? { schema: 'herdr-boss.setup/1', revision: 0, steps: Object.fromEntries(steps.map(({ id, name }) => [id, { name, status: 'pending' }])) };
  const context = { home, env: { ...env, platform: os.platform() }, state, dataDir, pacing, ask, output, execute };
  output(resume ? 'Resume setup.' : 'Start setup. Saved progress continues.');
  for (const step of steps) {
    const check = () => DOCTOR_STEPS.has(step.id) ? runDoctor({ home, env, stepId: step.id, runner, timeoutMs }) : null;
    let report = await check();
    let done = stepDone(step.id, report, context);
    // An explicit new pacing choice must be saved even when the old choice passed.
    if (step.id === 'pacing' && pacing && pacing !== state.pacing) done = false;
    let status = 'done';
    if (!done) {
      output(`${step.id}: ${step.name}. ${SETUP_ACTIONS[step.id]}`);
      const red = report?.items.filter((item) => item.status === 'red') ?? [];
      for (const item of red) output(`Fix: ${item.fix}`);
      try {
        assertSetupFiles(dataDir);
        status = await runSetupAction(step.id, { ...context, red });
        if (status === 'done') {
          report = await check();
          status = stepDone(step.id, report, context) ? 'done' : 'waiting';
          if (status === 'waiting') for (const item of report?.items.filter((item) => item.status === 'red') ?? []) output(`Fix: ${item.fix}`);
        }
      } catch { status = 'failed'; }
    }
    if (status === 'refused') status = 'failed';
    step.status = status;
    state.steps[step.id] = { name: step.name, status };
    // A prior done state is not evidence for a later step after a new failure.
    if (status !== 'done') for (const later of steps.slice(steps.indexOf(step) + 1)) state.steps[later.id].status = 'pending';
    if (!writeState(dataDir, state)) {
      output(SETUP_CONFLICT_MESSAGE);
      return { exitCode: 1, steps, waitingStep: null };
    }
    output(`${status}: ${step.name}.`);
    if (status !== 'done') {
      output(`${status === 'waiting' ? 'Waiting for you' : 'Setup refused or the action failed'}: ${step.name}. ${SETUP_ACTIONS[step.id]}`);
      output('Next: complete this step, then run herdr-boss setup --resume.');
      return { exitCode: status === 'waiting' ? 3 : 1, steps, waitingStep: status === 'waiting' ? step.id : null };
    }
  }
  output('Setup is complete. All steps passed.');
  return { exitCode: 0, steps, waitingStep: null };
}

export async function setupCommand(args, options = {}) {
  const parsed = parseArgs(args);
  if (!parsed.dryRun) {
    const { verifyProjectCaller } = await import('./project-new-cli.js');
    const env = options.env ?? process.env;
    let herdr = options.herdr;
    if (!herdr && (env.HERDR_ENV === '1' || env.HERDR_PANE_ID || env.HERDR_WORKSPACE_ID)) {
      const { createHerdrRunner } = await import('./kit/workers.js');
      herdr = createHerdrRunner();
    }
    try { verifyProjectCaller(env, herdr); }
    catch { throw new Error('Setup is refused in this pane. Ask your project lead.'); }
  }
  try { return (await runSetup({ ...options, ...parsed })).exitCode; }
  catch { throw new Error('Setup cannot read or write its local files. Check the data folder and setup.json.'); }
}
