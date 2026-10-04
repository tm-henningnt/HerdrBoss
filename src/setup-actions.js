// Fixed setup actions. No command comes from saved progress or a tool response.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOCTOR_INSTALL_FIXES } from './doctor.js';
import { assertSetupFiles, readDataFile } from './data-file-safety.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
export const SETUP_ACTIONS = Object.freeze({
  guide: 'Use this terminal wizard to follow the shared steps.',
  check: 'Run the computer checks. Correct each red item before you continue.',
  tools: 'Install each missing tool after you approve its command. Set the Git name yourself.',
  signin: 'Only you: sign in at the terminal or in the browser. Never put a secret in this wizard.',
  settings: 'Only you: add the Claude settings in your editor. Follow the doctor fixes for the other agent apps.',
  service: 'Run bin/herdr-boss install after you approve it. Check the service and the data folder.',
  pacing: 'Choose paced or unpaced for Claude. Save the choice to the policy.',
  project: 'Only you: choose a name and a folder. Run herdr-boss project new <slug> --group <folder> --start. Then resume setup.',
  dashboard: 'Open the local dashboard. Check that the service answers.',
  answer: 'Only you: open Mailbox. Answer your first question. Then resume setup in your terminal and confirm that you answered it.',
  review: 'Only you: open your first review pack. Judge its items and submit the result. Then resume setup in your terminal and confirm that you submitted it.',
});

export function createSetupExecutor({ env = process.env } = {}) {
  return (command, args) => {
    // Suppress raw command output and errors. They can hold private paths or credentials.
    execFileSync(command, args, { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024 });
  };
}

export function hasSetupProject(dataDir) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'project-repos.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(row?.slug) || typeof row.repo !== 'string') return false;
    try {
      const project = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${row.slug}.json`), 'utf8'));
      const metadata = fs.lstatSync(path.join(row.repo, '.git'));
      if (project.slug !== row.slug || (!metadata.isDirectory() && !metadata.isFile())) return false;
      const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[name];
      const result = execFileSync('git', ['-C', row.repo, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim().split('\n');
      return result[0] === 'true' && result.length === 2 && fs.realpathSync(result[1]) === fs.realpathSync(row.repo);
    } catch { return false; }
  });
}

export function readSetupPacing(dataDir) {
  try { return JSON.parse(readDataFile(path.join(dataDir, 'policy.json'), dataDir))?.providerModes?.claude; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function savePacing(choice, dataDir) {
  const { loadPolicy, savePolicy } = await import('./control.js');
  const { loadModels } = await import('./kit/config.js');
  const models = loadModels();
  const file = path.join(dataDir, 'policy.json');
  assertSetupFiles(dataDir);
  const policy = loadPolicy({ file, models, warn: () => {} });
  policy.providerModes.claude = choice === 'paced' ? 'managed' : 'ignore';
  const errors = savePolicy(policy, models, { file, caller: 'setup', strictLog: true });
  if (errors.length) throw new Error('The pacing policy is not valid. Correct it in Settings.');
}

async function approvedCommand(command, args, display, context) {
  context.output(`Command: ${display}`);
  const answer = await context.ask('Run this command? Type yes or no: ');
  if (answer === null) return 'waiting';
  if (answer.trim().toLowerCase() !== 'yes') return 'refused';
  await context.execute(command, args);
  return 'done';
}

export async function runSetupAction(id, context) {
  const { red, state, dataDir, ask, env, output } = context;
  if (id === 'guide') return 'done';
  if (id === 'check' && red.some((item) => item.id === 'os')) return 'refused';
  if (id === 'tools') {
    for (const item of red) {
      // Use the exact Mac installer strings already verified for doctor.
      const fix = DOCTOR_INSTALL_FIXES[item.id]?.darwin;
      const match = env.platform === 'darwin' && fix?.match(/^Run ((?:brew|npm) [^.]+)\./);
      if (!match) return 'waiting';
      const [command, ...args] = match[1].split(' ');
      const status = await approvedCommand(command, args, match[1], context);
      if (status !== 'done') return status;
    }
    return 'done';
  }
  if (id === 'service') {
    if (env.platform !== 'darwin') return 'waiting';
    return approvedCommand(process.execPath, [CLI, 'install'], 'bin/herdr-boss install', context);
  }
  if (id === 'pacing') {
    if (red.length) return 'waiting';
    const choice = context.pacing ?? await ask('Choose paced or unpaced for Claude: ');
    if (choice === null) {
      output('Run herdr-boss setup --resume --pacing paced, or herdr-boss setup --resume --pacing unpaced.');
      return 'waiting';
    }
    if (!['paced', 'unpaced'].includes(choice)) return 'refused';
    await savePacing(choice, dataDir);
    state.pacing = choice;
    return 'done';
  }
  if (id === 'dashboard') {
    if (red.length) return 'waiting';
    const port = Number(env.HERDR_BOSS_PORT || 4477);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'refused';
    output('Command: open the local dashboard in your browser.');
    await context.execute(env.platform === 'darwin' ? 'open' : 'xdg-open', [`http://127.0.0.1:${port}`]);
    state.dashboardOpened = true;
    return 'done';
  }
  if (id === 'answer' || id === 'review') {
    const answer = await ask(id === 'answer'
      ? 'Did you answer your first Mailbox question? Type yes after you answer it: '
      : 'Did you submit your first review pack? Type yes after you submit it: ');
    if (answer?.trim().toLowerCase() !== 'yes') return 'waiting';
    state[id] = true;
    return 'done';
  }
  return 'waiting';
}
