import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, gitLog, readJson, validateAllowedPaths, validateScopePaths, validateWorkerReport } from './orchestration.js';
import { recordUsage } from '../usage.js';
import { providerFor, selectModel, unmeteredSummary } from '../control.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const BRIEF_SLOTS = new Set([
  'name', 'kind', 'model', 'effort', 'project', 'repo', 'worktree', 'branch', 'base', 'issue', 'task',
  'allowedPaths', 'reportPath', 'reportJsonPath', 'orchPane', 'orchName', 'bulletinPath', 'date', 'evidenceTiers', 'threadLimit',
]);

function git(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding });
}

export function parseWorktreeCwdProcesses(output, worktree) {
  const root = path.resolve(worktree);
  const processes = [];
  let processInfo = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      if (processInfo?.cwd && (processInfo.cwd === root || processInfo.cwd.startsWith(`${root}${path.sep}`))) processes.push(processInfo);
      processInfo = { pid: Number(line.slice(1)), command: null, cwd: null };
    } else if (processInfo && line.startsWith('c')) processInfo.command = line.slice(1);
    else if (processInfo && line.startsWith('n')) processInfo.cwd = line.slice(1);
  }
  if (processInfo?.cwd && (processInfo.cwd === root || processInfo.cwd.startsWith(`${root}${path.sep}`))) processes.push(processInfo);
  return processes;
}

function worktreeCwdProcesses(worktree) {
  const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpcn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseWorktreeCwdProcesses(output, worktree);
}

function displayArg(value) {
  if (/^[a-zA-Z0-9_./:=,@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderBrief(template, slots) {
  const names = [...template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]);
  for (const name of names) if (!BRIEF_SLOTS.has(name)) throw new Error(`Unknown brief template slot: {{${name}}}.`);
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name) => {
    const value = slots[name];
    if (value === undefined || value === null || value === '') return '(none)';
    if (name === 'allowedPaths' && Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : '(none)';
    return String(value);
  });
}

function parseHerdrJson(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch (error) { throw new Error(`Herdr returned invalid JSON: ${error.message}`); }
  if (data?.error) throw new Error(data.error.message || String(data.error));
  return data?.result ?? data;
}

export function createHerdrRunner(exec = (args) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  return (args) => {
    const stdout = exec(args);
    if (args[0] === 'pane' && args[1] === 'read') return { text: stdout };
    return parseHerdrJson(stdout);
  };
}

// A worker in its own worktree uses .worker/. Workers that share a checkout (--no-worktree) each use .worker/<name>/.
const workerDirName = (name, shared) => (shared ? `.worker/${name}` : '.worker');
const briefPrompt = (dir) => `Read ${dir}/brief.md in your working directory and execute it.`;

function readAgentText(name) {
  return execFileSync('herdr', ['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '60'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// An agent can report ready before its input box works. The prompt is then lost, or typed but not submitted.
// Resend once when the pane shows no trace of the marker text. When it shows the marker, send Enter once:
// Enter submits unsent input and does nothing in an empty input box.
export function deliverPrompt(name, text, marker, { herdr, readText = readAgentText, wait = pause }) {
  const settled = () => {
    const status = herdr(['agent', 'get', name]);
    return ['working', 'blocked'].includes((status.agent ?? status).agent_status);
  };
  let resent = false;
  for (;;) {
    let promptError;
    try {
      herdr(['agent', 'prompt', name, text, '--wait', '--timeout', '20000']);
      return resent ? 'resent' : 'sent';
    } catch (error) { promptError = error; }
    if (settled()) return resent ? 'resent' : 'sent';
    let seen = true;
    try { seen = readText(name).includes(marker); } catch {}
    if (!seen && !resent) { resent = true; wait(3000); continue; }
    if (!seen) throw promptError;
    // The status check below decides the result, so an unparsable send-keys response does not abort.
    try { herdr(['agent', 'send-keys', name, 'enter']); } catch {}
    wait(3000);
    if (settled()) return 'submitted';
    throw promptError;
  }
}

function deliverBrief(name, herdr, readText, wait, dir = '.worker') {
  return deliverPrompt(name, briefPrompt(dir), `${dir}/brief.md`, { herdr, readText, wait });
}

function inAbout(iso, now) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function describeLane(provider, lane, now = Date.now()) {
  if (!lane || lane.state === 'open') return `${provider} open`;
  if (lane.state === 'unknown') return `${provider} unknown (no quota data)`;
  const numbers = `${lane.usedPercent}% used${lane.expectedPercent != null ? ` against ${lane.expectedPercent}% expected` : ''} in the ${lane.window} window`;
  if (lane.state === 'reserve') return `${provider} near exhaustion: ${numbers}; resets in ${inAbout(lane.backOnPaceAt, now)}`;
  return `${provider} ahead of pace: ${numbers}; back on pace in about ${inAbout(lane.backOnPaceAt, now)} if unused`;
}

export function describeUnmetered(lane) {
  const summary = unmeteredSummary(lane);
  return summary ? `unmetered open: ${summary}` : 'unmetered open; no unmetered models are available after exclusions';
}

// The current project's permitted unmetered models, after its allow-list. Empty when none apply.
function unmeteredAlternatives(rules, project, allowedModels) {
  const kinds = project && rules.lanes?.unmetered?.byProject?.[project];
  if (!kinds) return '';
  const entries = Object.entries(kinds).map(([kind, names]) => {
    const permitted = allowedModels == null ? names : names.filter((model) => allowedModels.includes(model));
    return permitted.length ? `${kind} (${permitted.join(', ')})` : null;
  }).filter(Boolean);
  return entries.length ? `Unmetered alternatives for ${project}: ${entries.join('; ')}.` : '';
}

// Decide whether a worker on this provider may start. Returns { error } or { warning } or {}.
export function providerGate(provider, rules, { force = false, now = Date.now(), project = null, allowedModels = null } = {}) {
  if (!provider || !rules.avoidProviders?.includes(provider)) return {};
  const lane = rules.lanes?.[provider];
  const detail = lane ? describeLane(provider, lane, now) : `${provider} is ahead of quota pace or near exhaustion`;
  const alternatives = unmeteredAlternatives(rules, project, allowedModels);
  const lead = alternatives ? ` ${alternatives}` : '';
  if (force) return { warning: `Warning: --force overrides the quota guard: ${detail}.${lead}` };
  if (lane?.state === 'pace' && rules.leastOverProvider === provider) {
    return { warning: `Notice: every metered provider is over pace. ${detail}.${lead} It is the least over, so the worker starts. Keep the task small and record the reason in the run.` };
  }
  const open = Object.entries(rules.lanes || {}).filter(([, value]) => !value.unmetered && value.state === 'open').map(([name]) => name);
  const next = open.length ? `Open providers: ${open.join(', ')}.`
    : rules.leastOverProvider ? `Every metered provider is over pace; ${rules.leastOverProvider} is the least over and starts without --force.`
      : 'No metered provider is open; free models do not count against a quota.';
  return { error: `${detail}.${lead} ${next} Use --force only for an authorized override.` };
}

export function describeMachine(rules) {
  const machine = rules?.machine;
  if (!machine) return null;
  const cpu = Number.isFinite(machine.cpuPercent) ? `${machine.cpuPercent.toFixed(1)}%` : 'unknown';
  const load = Number.isFinite(machine.fiveMinute) ? machine.fiveMinute : 'unknown';
  const exceeded = (Number.isFinite(machine.cpuPercent) && Number.isFinite(machine.cpuLimit) && machine.cpuPercent > machine.cpuLimit)
    || (Number.isFinite(machine.fiveMinute) && Number.isFinite(machine.loadLimit) && machine.fiveMinute > machine.loadLimit);
  return `Machine: Owner ${machine.owner || 'unknown'}; CPU ${cpu} / limit ${machine.cpuLimit == null ? 'disabled' : `${machine.cpuLimit}%`}; 5-minute load ${load} / backstop ${machine.loadLimit ?? 'disabled'}${exceeded ? '. Stop new workers and full test suites.' : ''}`;
}

// The active machine CPU limit and enabled load backstop refuse starts, including with --force.
export function loadWarning(rules) {
  const machine = rules?.machine;
  if (!machine) return null;
  const cpuExceeded = Number.isFinite(machine.cpuPercent) && Number.isFinite(machine.cpuLimit) && machine.cpuPercent > machine.cpuLimit;
  const loadExceeded = Number.isFinite(machine.fiveMinute) && Number.isFinite(machine.loadLimit) && machine.fiveMinute > machine.loadLimit;
  if (!cpuExceeded && !loadExceeded) return null;
  return `Machine limit exceeded. ${describeMachine(rules)} --force cannot bypass this refusal.`;
}

function runSetupCommand(command, cwd, timeoutMs) {
  return execFileSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

function setupFailure(error, command, timeoutSeconds) {
  const tail = String(error.stderr || error.stdout || '').trim().split('\n').slice(-15).join('\n');
  const reason = error.signal === 'SIGTERM' ? `did not finish within ${timeoutSeconds} s` : `failed with exit code ${error.status ?? 'unknown'}`;
  return new Error(`Project setup \`${command}\` ${reason}. No agent was started.${tail ? `\n${tail}` : ''}`);
}

function listFrom(value, key) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function getName(agent) { return agent?.name ?? agent?.agent_name ?? null; }
function getWorkspace(value) { return value.workspace_id ?? value.workspaceId ?? value.workspace ?? null; }
function getTab(value) { return value.tab_id ?? value.tabId ?? null; }
function getPane(value) { return value.pane_id ?? value.paneId ?? value.id ?? null; }

function callerValidationError(reason) {
  return new Error(`Cannot verify the caller pane: ${reason} A shared Codex app-server daemon can pass another pane's environment. Pass explicit HERDR_PANE_ID and HERDR_WORKSPACE_ID values, or restart the Codex session. Do not stop the shared daemon.`);
}

function verifyCallerPane(env, herdr, requestedOrch) {
  const paneId = env.HERDR_PANE_ID;
  if (!paneId) throw callerValidationError('HERDR_PANE_ID is required.');
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw callerValidationError('HERDR_WORKSPACE_ID is required.');
  let response;
  try { response = herdr(['pane', 'get', paneId]); }
  catch (error) { throw callerValidationError(`Herdr could not read pane ${paneId}: ${error.message}`); }
  const pane = response?.pane ?? response;
  const returnedId = getPane(pane);
  if (returnedId !== paneId) throw callerValidationError(`The returned pane ID (${returnedId ?? '(missing)'}) differs from HERDR_PANE_ID (${paneId}).`);
  if (!['orch', 'boss'].includes(pane.label)) throw callerValidationError(`The caller pane label must be exactly orch or boss; received ${pane.label ?? '(missing)'}.`);
  const paneWorkspace = getWorkspace(pane);
  if (workspaceId !== paneWorkspace) throw callerValidationError(`HERDR_WORKSPACE_ID (${workspaceId}) differs from the pane workspace (${paneWorkspace ?? '(missing)'}).`);
  if (requestedOrch != null && requestedOrch !== returnedId) throw callerValidationError(`--orch must match the verified caller pane (${returnedId}).`);
  return { paneId: returnedId, workspaceId: paneWorkspace };
}

function findDimensions(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const width = Number(value.width ?? value.cols ?? value.columns);
  const height = Number(value.height ?? value.rows);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
  for (const child of Object.values(value)) {
    const dimensions = findDimensions(child, seen);
    if (dimensions) return dimensions;
  }
  return null;
}

function checkLiveName(name, herdr) {
  const agents = listFrom(herdr(['agent', 'list']), 'agents');
  if (agents.some((agent) => getName(agent) === name)) throw new Error(`A live Herdr agent is already named ${name}.`);
  return agents;
}

function readRules(file) {
  try {
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('expected a JSON object');
    return rules;
  } catch (error) {
    if (error.code === 'ENOENT') return { avoidKinds: [], preferredKinds: [], notes: [] };
    throw new Error(`Could not read Herdr Boss rules ${file}: ${error.message}`);
  }
}

function validateSelection(kind, options, models, config, resourcePolicy = null) {
  const policy = models.kinds[kind];
  if (!policy) throw new Error(`Unknown agent kind: ${kind}. Choose one of ${Object.keys(models.kinds).join(', ')}.`);
  const model = selectModel(kind, options.model, models, resourcePolicy);
  if (!policy.allowedModels.includes(model)) throw new Error(`Model ${model} is not allowed for ${kind}.`);
  if (config.allowedModels !== null && !config.allowedModels.includes(model)) throw new Error(`Project ${config.slug} does not allow model ${model}.`);
  const effort = options.effort ?? policy.defaultEffort;
  if (effort !== null && !policy.allowedEfforts.includes(effort)) throw new Error(`Effort ${effort} is not allowed for ${kind}.`);
  if (effort === null && options.effort != null) throw new Error(`${kind} does not support a reasoning effort.`);
  const launchArgs = policy.launchArgs.map((arg) => arg.replaceAll('{{model}}', model).replaceAll('{{effort}}', effort ?? ''));
  return { model, effort, launchArgs };
}

function branchExists(root, branch) {
  try {
    execFileSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function addExclude(worktree) {
  const exclude = git(worktree, ['rev-parse', '--git-path', 'info/exclude']).trim();
  const file = path.isAbsolute(exclude) ? exclude : path.resolve(worktree, exclude);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('/.worker/')) fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}/.worker/\n`, 'utf8');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function rulesWarning(rules, now = Date.now()) {
  const updated = Date.parse(rules.updatedAt ?? '');
  return !Number.isFinite(updated) || now - updated > 10 * 60 * 1000;
}

function chooseWorkerPane(workspaceId, worktree, herdr) {
  const tabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
  const workerTab = tabs.find((tab) => tab.label === 'Workers' && getWorkspace(tab) === workspaceId);
  if (!workerTab) {
    const command = [
      'tab', 'create', '--workspace', workspaceId, '--label', 'Workers', '--cwd', worktree,
      '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus',
    ];
    const created = herdr(command);
    const tabId = getTab(created) ?? created.tab?.tab_id ?? created.id;
    const freshTabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
    const foundTab = freshTabs.find((tab) => (tab.tab_id === tabId || tab.label === 'Workers') && getWorkspace(tab) === workspaceId);
    if (!foundTab) throw new Error('Herdr created a Workers tab but did not return a tab id that can be found.');
    const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes');
    const rootPane = panes.find((pane) => getTab(pane) === getTab(foundTab));
    if (!rootPane || !getPane(rootPane)) {
      try { herdr(['tab', 'close', getTab(foundTab)]); } catch {}
      throw new Error('The new Workers tab has no root pane.');
    }
    return { paneId: getPane(rootPane), tabId: getTab(foundTab), command, createdTab: true };
  }

  const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => getTab(pane) === getTab(workerTab));
  if (!panes.length) throw new Error('The Workers tab has no pane to split.');
  const source = panes[0];
  let dimensions = findDimensions(source);
  if (!dimensions) {
    try { dimensions = findDimensions(herdr(['pane', 'layout', '--pane', getPane(source)])); } catch {}
  }
  const direction = dimensions && dimensions.height > dimensions.width ? 'down' : 'right';
  const command = [
    'pane', 'split', getPane(source), '--direction', direction, '--cwd', worktree,
    '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus',
  ];
  const result = herdr(command);
  const paneId = result.pane_id ?? result.paneId ?? result.pane?.pane_id ?? result.new_pane_id;
  if (!paneId) {
    const refreshed = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => getTab(pane) === getTab(workerTab));
    const added = refreshed.find((pane) => (pane.foreground_cwd ?? pane.cwd) === worktree && !panes.some((old) => getPane(old) === getPane(pane)));
    if (!added) throw new Error('Herdr split the Workers tab but did not return the new pane id.');
    return { paneId: getPane(added), tabId: getTab(workerTab), command, createdTab: false, createdPane: true };
  }
  return { paneId, tabId: getTab(workerTab), command, createdTab: false, createdPane: true };
}

function waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait) {
  const intervalMs = 250;
  const timeoutMs = 20_000;
  let elapsedMs = 0;
  let previousScreen = null;
  let stableScreenMs = 0;
  while (elapsedMs <= timeoutMs) {
    const iterationStarted = Date.now();
    try {
      const response = herdr(['pane', 'get', paneId]);
      const pane = response?.pane ?? response;
      const paneReady = getPane(pane) === paneId
        && getWorkspace(pane) === workspaceId
        && pane.foreground_cwd === worktree;
      const agents = listFrom(herdr(['agent', 'list']), 'agents');
      const occupied = agents.some((agent) => getPane(agent) === paneId);
      if (paneReady && !occupied) {
        const processResponse = herdr(['pane', 'process-info', '--pane', paneId]);
        const info = processResponse?.process_info ?? processResponse;
        const shellPid = Number(info?.shell_pid);
        const foregroundProcesses = listFrom(info.foreground_processes, 'processes');
        const shellIsForeground = Number.isFinite(shellPid) && shellPid > 0
          && (foregroundProcesses.length
            ? foregroundProcesses.some((process) => Number(process.pid) === shellPid)
            : Number(info.foreground_process_group_id) === shellPid);
        if (shellIsForeground) {
          const screenResponse = herdr(['pane', 'read', paneId, '--source', 'visible', '--lines', '40', '--format', 'text']);
          const screen = typeof screenResponse === 'string'
            ? screenResponse
            : screenResponse?.text ?? screenResponse?.output ?? '';
          const lines = String(screen).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trimEnd());
          const question = interactiveShellQuestion(lines);
          if (question) {
            const error = new Error(`Worker pane ${paneId} is waiting at an interactive question: ${question}. Answer it in a shell once, then retry worker start.`);
            error.code = 'worker_pane_interactive_question';
            throw error;
          }
          const lastLine = lines.filter((line) => line.trim()).at(-1) ?? '';
          if (/[❯➜$%#>]\s*$/.test(lastLine)) return;
          if (screen.trim() && screen === previousScreen) {
            stableScreenMs += Math.max(intervalMs, Date.now() - iterationStarted);
            if (stableScreenMs >= 1000) return;
          } else {
            previousScreen = screen;
            stableScreenMs = 0;
          }
        } else {
          previousScreen = null;
          stableScreenMs = 0;
        }
      } else {
        previousScreen = null;
        stableScreenMs = 0;
      }
    } catch (error) {
      if (error?.code === 'worker_pane_interactive_question') throw error;
      previousScreen = null;
      stableScreenMs = 0;
    }
    if (elapsedMs === timeoutMs) break;
    const delay = Math.min(intervalMs, timeoutMs - elapsedMs);
    const checkDurationMs = Date.now() - iterationStarted;
    const waitStarted = Date.now();
    wait(delay);
    elapsedMs += checkDurationMs + Math.max(delay, Date.now() - waitStarted);
  }
  throw new Error(`Worker pane ${paneId} did not become an available shell in workspace ${workspaceId} at ${worktree} within 20 seconds.`);
}

function interactiveShellQuestion(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (/\[(?:y\/n|n\/y)\]\s*$/i.test(line)) {
      const previous = lines[index - 1]?.trim();
      return previous?.endsWith('?') ? `${previous} ${line}` : line;
    }
    if (/\?\s*$/.test(line)) return line;
  }
  return null;
}

function isAgentPaneBusy(error) {
  if (error?.code === 'agent_pane_busy') return true;
  return /"code"\s*:\s*"agent_pane_busy"/.test(String(error?.stderr ?? ''))
    || /agent_pane_busy/.test(String(error?.message ?? ''));
}

function renderStartPlan(plan) {
  const lines = [
    `1. Validate agent name: ${plan.name}`,
    `   $ herdr agent list`,
    `2. Read resource rules: ${plan.rulesFile}${plan.rulesStale ? ' (stale or missing; warn)' : ''}`,
    `3. Validate kind/model/effort: ${plan.kind} / ${plan.model} / ${plan.effort ?? '(none)'}`,
    `4. Create worktree: ${plan.noWorktree ? '(disabled; use current worktree)' : plan.worktree}`,
    ...(plan.noWorktree ? [] : [`   $ git worktree add -b ${displayArg(plan.branch)} ${displayArg(plan.worktree)} ${displayArg(plan.base)}`]),
    `   Append /.worker/ to ${plan.excludeFile}`,
    `5. Render brief: ${plan.worktree}/${plan.workerDir}/brief.md from ${plan.template}`,
    ...(plan.setup ? [`   Run project setup in the worktree (timeout ${plan.setupTimeoutSeconds} s):`, `   $ ${plan.setup}`] : []),
    `6. Place worker in workspace ${plan.workspaceId}:`,
    `   $ herdr ${plan.paneCommand.map(displayArg).join(' ')}`,
    `7. Start agent:`,
    `   $ herdr agent start ${displayArg(plan.name)} --kind ${displayArg(plan.kind)} --pane ${displayArg(plan.paneId)} --timeout ${plan.agentStartTimeoutMs} -- ${plan.launchArgs.map(displayArg).join(' ')}`,
    `8. Write run record: ${plan.recordFile}`,
    `9. Send task prompt and observe agent activity:`,
    `   $ herdr agent prompt ${displayArg(plan.name)} "${briefPrompt(plan.workerDir)}"`,
  ];
  return lines.join('\n');
}

export function startWorker(name, options, {
  config,
  models,
  herdr = createHerdrRunner(),
  env = process.env,
  rulesFile,
  now = Date.now(),
  output = console.log,
  readText = readAgentText,
  wait = pause,
  runSetup = runSetupCommand,
} = {}) {
  if (!NAME_PATTERN.test(name)) throw new Error('Worker name must match [a-z][a-z0-9-]{0,31}.');
  if (env.HERDR_ENV !== '1') throw new Error('Run worker start from a Herdr-managed pane (HERDR_ENV=1).');
  const caller = verifyCallerPane(env, herdr, options.orch);
  const liveAgents = checkLiveName(name, herdr);
  const modelConfig = models ?? JSON.parse(fs.readFileSync(new URL('../../kit/models.json', import.meta.url), 'utf8'));
  const rulesPath = rulesFile ?? path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'rules.json');
  const rules = readRules(rulesPath);
  const staleRules = rulesWarning(rules, now);
  if (staleRules) output(`Warning: Herdr Boss rules are older than 10 minutes or have no valid timestamp: ${rulesPath}`);
  const machineStatus = describeMachine(rules);
  if (machineStatus) output(machineStatus);
  const overload = loadWarning(rules);
  if (overload) throw new Error(overload);
  if (!options.kind) throw new Error('--kind is required.');
  if (rules.avoidKinds !== undefined && !Array.isArray(rules.avoidKinds)) throw new Error(`Herdr Boss rules avoidKinds must be an array: ${rulesPath}`);
  if ((rules.avoidKinds ?? []).includes(options.kind)) {
    if (!options.force) throw new Error(`Herdr Boss rules avoid ${options.kind}; pass --force to override.`);
    output(`Warning: --force overrides Herdr Boss rules for ${options.kind}.`);
  }
  const policy = rules.policy;
  const { model, effort, launchArgs } = validateSelection(options.kind, options, modelConfig, config, policy);
  const projectPolicy = policy?.projects?.[config.slug];
  if (policy) {
    if (!policy.allowedKinds?.includes(options.kind)) throw new Error(`${options.kind} is disabled globally by Herdr Boss.`);
    if (policy.excludedModels?.includes(model)) throw new Error(`${model} is disabled globally by Herdr Boss.`);
    if (projectPolicy?.excludedKinds?.includes(options.kind) || projectPolicy?.excludedModels?.includes(model)) throw new Error(`${options.kind}/${model} is excluded for project ${config.slug}.`);
    if (projectPolicy?.mode === 'paused' && !options.force) throw new Error(`Project ${config.slug} is paused. Use --force only for an authorized override.`);
  }
  const provider = providerFor(options.kind, model, policy);
  const gate = providerGate(provider, rules, { force: options.force, now, project: config.slug, allowedModels: config.allowedModels });
  if (gate.error) throw new Error(gate.error);
  if (gate.warning) output(gate.warning);
  if (rules.control?.runningWorkers >= rules.control?.maxWorkers && !options.force) throw new Error(`Global worker limit (${rules.control.maxWorkers}) is reached; wait or use --force.`);
  const projectSlots = rules.control?.projects?.[config.slug];
  if (projectSlots?.effectiveMode === 'paused' && !options.force) throw new Error(`Project ${config.slug} is paused. Use --force only for an authorized override.`);
  if (projectSlots && projectSlots.running >= projectSlots.slots && !options.force) output(`Notice: ${config.slug} uses ${projectSlots.running}/${projectSlots.slots} allocated slots. This share is advisory; global limit still applies.`);
  const allowedErrors = validateAllowedPaths(options.allow ?? []);
  if (allowedErrors.length) throw new Error(allowedErrors.join('\n'));
  if (!options.allow?.length) throw new Error('Give at least one --allow path (use --allow . only for an explicitly unrestricted task).');
  if (!!options.task === !!options.taskFile) throw new Error('Provide exactly one of --task or --task-file.');
  if (options.issue != null && (!/^\d+$/.test(String(options.issue)) || Number(options.issue) <= 0)) throw new Error('--issue must be a positive integer.');
  const task = options.taskFile ? fs.readFileSync(path.resolve(options.taskFile), 'utf8').trimEnd() : options.task;
  if (!task?.trim()) throw new Error('Task text must not be empty.');
  const base = options.base ?? config.baseBranch;
  const branch = options.noWorktree ? git(config.root, ['branch', '--show-current']).trim() : name;
  if (!branch) throw new Error('--no-worktree requires the current worktree to have a named branch.');
  const worktree = options.noWorktree ? config.root : config.worktreePath(name);
  const recordFile = path.join(config.runsPath, `${name}.json`);
  const excludePath = git(config.root, ['rev-parse', '--git-path', 'info/exclude']).trim();
  const excludeFile = path.isAbsolute(excludePath) ? excludePath : path.resolve(config.root, excludePath);
  if (fs.existsSync(recordFile)) throw new Error(`Run record already exists: ${recordFile}.`);
  if (!options.noWorktree && fs.existsSync(worktree)) throw new Error(`Worktree path already exists: ${worktree}.`);
  if (!options.noWorktree && branchExists(config.root, branch)) throw new Error(`Branch already exists: ${branch}.`);

  const workspaceId = caller.workspaceId;
  const tabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
  const hasWorkersTab = tabs.some((tab) => tab.label === 'Workers' && getWorkspace(tab) === workspaceId);
  let paneId = null;
  let paneCommand;
  if (options.dryRun) {
    if (hasWorkersTab) {
      const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => tabs.some((tab) => tab.label === 'Workers' && getTab(tab) === getTab(pane)));
      const source = panes[0];
      if (!source) throw new Error('The Workers tab has no pane to split.');
      let dimensions = findDimensions(source);
      if (!dimensions) {
        try { dimensions = findDimensions(herdr(['pane', 'layout', '--pane', getPane(source)])); } catch {}
      }
      const direction = dimensions && dimensions.height > dimensions.width ? 'down' : 'right';
      paneCommand = [
        'pane', 'split', getPane(source), '--direction', direction, '--cwd', worktree,
        '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus',
      ];
      paneId = '<new-pane-id>';
    } else {
      paneCommand = [
        'tab', 'create', '--workspace', workspaceId, '--label', 'Workers', '--cwd', worktree,
        '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus',
      ];
      paneId = '<new-root-pane-id>';
    }
  }

  const plan = {
    name, kind: options.kind, model, effort, rulesFile: rulesPath, rulesStale: staleRules,
    noWorktree: !!options.noWorktree, worktree, branch, base, template: config.briefTemplatePath,
    workspaceId, paneId, paneCommand, launchArgs, recordFile, excludeFile,
    // A worker in the current worktree uses its existing dependencies, so setup runs only for a new worktree.
    setup: options.noWorktree ? null : config.setup ?? null, setupTimeoutSeconds: config.setupTimeoutSeconds ?? 900,
    agentStartTimeoutMs: config.agentStartTimeoutMs ?? 90000,
    workerDir: workerDirName(name, !!options.noWorktree),
  };
  if (options.dryRun) {
    output(renderStartPlan(plan));
    return { ...plan, dryRun: true };
  }

  const reportPath = path.join(worktree, plan.workerDir, 'report.md');
  const reportJsonPath = path.join(worktree, plan.workerDir, 'report.json');
  const orchPane = caller.paneId;
  const orchName = getName(liveAgents.find((agent) => getPane(agent) === orchPane)) ?? '(none)';
  const template = fs.readFileSync(config.briefTemplatePath, 'utf8');
  const brief = renderBrief(template, {
    name, kind: options.kind, model, effort, project: config.slug, repo: config.root, worktree, branch, base,
    issue: options.issue ?? null, task, allowedPaths: options.allow ?? [], reportPath, reportJsonPath,
    orchPane, orchName, bulletinPath: path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'bulletin.md'),
    date: new Date(now).toISOString().slice(0, 10),
    evidenceTiers: (config.evidenceTiers || []).join(', '),
    threadLimit: config.testThreadsFlag
      ? `Add \`${config.testThreadsFlag}\` to each test runner command.`
      : 'Use the form that the project instructions name. For Vitest 2 with the forks pool, use `--poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`; `--maxWorkers=2` fails there. For Vitest 3 and later, use `--maxWorkers=2`.',
  });

  let createdWorktree = false;
  let agentStarted = false;
  let placement = null;
  try {
    if (!options.noWorktree) {
      git(config.root, ['worktree', 'add', '-b', branch, worktree, base]);
      createdWorktree = true;
    }
    addExclude(worktree);
    fs.mkdirSync(path.join(worktree, plan.workerDir), { recursive: true });
    fs.mkdirSync(path.join(worktree, '.worker', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(worktree, plan.workerDir, 'brief.md'), brief);
    if (plan.setup) {
      output(`Running project setup in ${worktree}: ${plan.setup}`);
      const started = Date.now();
      try { runSetup(plan.setup, worktree, plan.setupTimeoutSeconds * 1000); }
      catch (error) { throw setupFailure(error, plan.setup, plan.setupTimeoutSeconds); }
      output(`Project setup finished in ${Math.round((Date.now() - started) / 1000)} s.`);
    }
    placement = chooseWorkerPane(workspaceId, worktree, herdr);
    paneId = placement.paneId;
    waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait);
    try {
      herdr(['agent', 'start', name, '--kind', options.kind, '--pane', paneId, '--timeout', String(plan.agentStartTimeoutMs), '--', ...launchArgs]);
    } catch (startError) {
      // Herdr can report agent_not_ready while leaving a blocked agent in the pane.
      try { agentStarted = listFrom(herdr(['agent', 'list']), 'agents').some((agent) => getName(agent) === name); } catch {}
      if (!agentStarted && isAgentPaneBusy(startError)) {
        waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait);
        try {
          herdr(['agent', 'start', name, '--kind', options.kind, '--pane', paneId, '--timeout', String(plan.agentStartTimeoutMs), '--', ...launchArgs]);
        } catch (retryError) {
          try { agentStarted = listFrom(herdr(['agent', 'list']), 'agents').some((agent) => getName(agent) === name); } catch {}
          throw retryError;
        }
      } else throw startError;
    }
    agentStarted = true;
    const record = {
      name,
      kind: options.kind,
      model,
      provider,
      effort,
      issue: options.issue == null ? null : Number(options.issue),
      worktree,
      branch,
      base,
      pane: paneId,
      workerDir: plan.workerDir,
      allowedPaths: options.allow ?? [],
      startedAt: new Date(now).toISOString(),
    };
    writeJsonAtomic(recordFile, record);
    const delivery = deliverBrief(name, herdr, readText, wait, plan.workerDir);
    if (delivery === 'resent') output(`Resent the brief prompt to ${name}: the first prompt did not reach the agent.`);
    if (delivery === 'submitted') output(`Sent Enter to ${name}: the brief prompt was typed but not submitted.`);
    return { ...record, recordFile, dryRun: false };
  } catch (error) {
    if (!agentStarted && placement) {
      try {
        if (placement.createdTab) herdr(['tab', 'close', placement.tabId]);
        else if (placement.createdPane) herdr(['pane', 'close', placement.paneId]);
      } catch (cleanupError) {
        error.message += ` (Herdr pane cleanup also failed: ${cleanupError.message})`;
      }
    }
    if (createdWorktree && !agentStarted) {
      let worktreeRemoved = false;
      try {
        git(config.root, ['worktree', 'remove', worktree]);
        worktreeRemoved = true;
      } catch (cleanupError) {
        error.message += ` (worktree cleanup also failed: ${cleanupError.message})`;
      }
      if (!worktreeRemoved) {
        error.message += ` Failed-start branch ${branch} was kept because its worktree could not be removed.`;
      } else {
        let uniqueCommits;
        try { uniqueCommits = git(config.root, ['rev-list', `${base}..${branch}`]).trim(); }
        catch (cleanupError) {
          error.message += ` Failed-start branch ${branch} was kept because its commits against base ${base} could not be checked: ${cleanupError.message}`;
        }
        if (uniqueCommits) {
          error.message += ` Failed-start branch ${branch} was kept because it has commits beyond base ${base}.`;
        } else if (uniqueCommits === '') {
          try { git(config.root, ['branch', '-D', branch]); }
          catch (cleanupError) { error.message += ` Failed-start branch ${branch} could not be deleted: ${cleanupError.message}`; }
        }
      }
    }
    if (agentStarted) error.message += ` Agent ${name} may still be running in pane ${paneId}; inspect it before retrying.`;
    throw error;
  }
}

const MAX_SCOPE_SYMLINK_HOPS = 40;

// Walk a lexically inside-repository path and follow each symlink by hand.
// existsSync hides a dangling symlink and realpathSync hides its missing target, so resolve
// every component with lstat: a symlink to .worker or outside must be refused even when its
// target does not exist yet.
function resolveScopeTarget(root, target) {
  const queue = path.relative(root, target).split(path.sep).filter(Boolean);
  let resolved = root;
  let hops = 0;
  while (queue.length) {
    const part = queue.shift();
    if (part === '.') continue;
    if (part === '..') { resolved = path.dirname(resolved); continue; }
    const candidate = path.join(resolved, part);
    let stats;
    try { stats = fs.lstatSync(candidate); }
    catch (error) {
      // A missing component ends the walk. No symlink exists below it, so the rest is lexical.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { real: path.join(resolved, part, ...queue) };
      // Any other error is unknown. Fail closed instead of accepting the path.
      return { error: `Path ${target} could not be resolved: ${error.message}` };
    }
    if (!stats.isSymbolicLink()) { resolved = candidate; continue; }
    hops += 1;
    if (hops > MAX_SCOPE_SYMLINK_HOPS) return { error: `Path ${target} has too many symbolic links.` };
    let link;
    try { link = fs.readlinkSync(candidate); }
    catch (error) { return { error: `Path ${target} could not be resolved: ${error.message}` }; }
    if (path.isAbsolute(link)) resolved = path.parse(link).root;
    queue.unshift(...link.split(path.sep).filter(Boolean));
  }
  return { real: resolved };
}

// Repository-relative scope paths must also resolve inside the worktree and outside .worker.
// A symlink can point at either the .worker directory or a target outside the repository.
function scopeEscapeErrors(worktree, paths) {
  const errors = validateScopePaths(paths);
  if (errors.length) return errors;
  const root = fs.realpathSync(worktree);
  const workerDir = path.join(root, '.worker').toLowerCase();
  for (const item of paths) {
    const result = resolveScopeTarget(root, path.resolve(root, item));
    if (result.error) { errors.push(result.error); continue; }
    const real = result.real.toLowerCase();
    if (real === workerDir || real.startsWith(`${workerDir}${path.sep}`)) {
      errors.push(`Path ${item} resolves into .worker.`);
      continue;
    }
    if (real !== root.toLowerCase() && !real.startsWith(`${root.toLowerCase()}${path.sep}`)) errors.push(`Path ${item} resolves outside the repository.`);
  }
  return errors;
}

// The verified orchestrator or boss pane approves extra worker scope after a WORKER QUESTION.
export function allowWorkerScope(name, { paths = [], reason = null } = {}, {
  config,
  herdr = createHerdrRunner(),
  env = process.env,
  now = Date.now(),
  output = console.log,
} = {}) {
  if (env.HERDR_ENV !== '1') throw new Error('Run worker allow from a Herdr-managed pane (HERDR_ENV=1).');
  const caller = verifyCallerPane(env, herdr, null);
  const { file, run } = readRun(config, name);
  if (run.finishedAt) throw new Error(`Run ${name} is already finished at ${run.finishedAt}. Refuse changes to a finished run.`);
  if (!reason || !String(reason).trim()) throw new Error('worker allow needs --reason TEXT.');
  if (!paths.length) throw new Error('worker allow needs at least one path.');
  const scopeErrors = scopeEscapeErrors(run.worktree, paths);
  if (scopeErrors.length) throw new Error(scopeErrors.join('\n'));
  const allowedPaths = run.allowedPaths ?? [];
  for (const item of paths) if (!allowedPaths.includes(item)) allowedPaths.push(item);
  run.allowedPaths = allowedPaths;
  run.scopeExtensions = [...(run.scopeExtensions ?? []), { paths: [...paths], reason, at: new Date(now).toISOString(), by: caller.paneId }];
  writeJsonAtomic(file, run);
  output(`Worker ${name} may now change: ${paths.join(', ')}.`);
  return run;
}

function readRun(config, name) {
  if (!NAME_PATTERN.test(name)) throw new Error('Worker name must match [a-z][a-z0-9-]{0,31}.');
  const file = path.join(config.runsPath, `${name}.json`);
  const run = readJson(file);
  if (run.name !== name) throw new Error(`Run record name does not match ${name}.`);
  return { file, run };
}

// Name every missing --record flag at once, with a hint from the worker report. The orchestrator still decides.
export function recordFlagErrors(options, reportJson = {}) {
  const missing = [];
  if (!['done', 'partial', 'failed'].includes(options.outcome)) {
    const hint = reportJson.stoppedEarly === true ? 'the report says stoppedEarly: true, which usually means --outcome partial' : 'the report says the worker did not stop early; use --outcome done unless your review found otherwise';
    missing.push(`--outcome done|partial|failed (${hint})`);
  }
  if (options.gatePassed === options.gateFailed) missing.push('exactly one of --gate-passed or --gate-failed (the result of your own run of the acceptance commands)');
  if (!Number.isSafeInteger(options.defects ?? 0) || (options.defects ?? 0) < 0) missing.push('--defects as a non-negative integer');
  if (!Number.isSafeInteger(options.rework ?? 0) || (options.rework ?? 0) < 0) missing.push('--rework as a non-negative integer');
  return missing;
}

export function collectWorker(name, options, { config, now = Date.now(), output = console.log, recordUsageFn = recordUsage, listWorktreeProcesses = worktreeCwdProcesses } = {}) {
  const { file, run } = readRun(config, name);
  if (run.finishedAt) throw new Error(`Run ${name} is already marked finished at ${run.finishedAt}.`);
  const reportDir = path.join(run.worktree, run.workerDir || '.worker');
  const reportJson = readJson(path.join(reportDir, 'report.json'));
  if (options.record) {
    const missing = recordFlagErrors(options, reportJson);
    if (missing.length) throw new Error(`--record needs:\n- ${missing.join('\n- ')}`);
  }
  const reportMd = fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  const errors = validateWorkerReport(reportJson, { evidenceTiers: config.evidenceTiers });
  if (errors.length) throw new Error(`Invalid worker report:\n- ${errors.join('\n- ')}`);
  if (path.resolve(reportJson.worktree) !== path.resolve(run.worktree)) throw new Error(`Report worktree ${reportJson.worktree} does not match run worktree ${run.worktree}.`);
  const actualBranch = git(run.worktree, ['branch', '--show-current']).trim();
  if (actualBranch !== run.branch) throw new Error(`Worktree branch ${actualBranch || '(detached)'} does not match run branch ${run.branch}.`);
  const leftovers = listWorktreeProcesses(run.worktree).filter((process) => !['bash', 'fish', 'sh', 'zsh'].includes(process.command));
  if (leftovers.length) throw new Error(`Worker ${name} still has processes in its worktree: ${leftovers.map((process) => `${process.command || 'unknown'} (pid ${process.pid}, cwd ${process.cwd})`).join('; ')}. Stop them before collection.`);
  if (run.issue != null && reportJson.issue !== run.issue) throw new Error(`Report issue ${reportJson.issue} does not match run issue ${run.issue}.`);
  if (reportJson.branch !== run.branch) throw new Error(`Report branch ${reportJson.branch} does not match run branch ${run.branch}.`);
  const log = gitLog(run.worktree, run.base);
  // The worker's own brief and report files live under .worker/ and never count as changed product paths.
  const ownFile = (item) => item === '.worker' || String(item).startsWith('.worker/');
  const reported = (reportJson.changedPaths || []).filter((item) => !ownFile(item));
  const changed = gitChangedPaths(run.worktree, run.base).filter((item) => !ownFile(item));
    const reportScope = compareChangedPaths(reported, run.allowedPaths ?? []);
    const actualScope = compareChangedPaths(changed, run.allowedPaths ?? []);
    const scopeErrors = [...new Set([...reportScope, ...actualScope])];
    const omitted = changed.filter((item) => !reported.includes(item));
  const summary = {
    name,
    issue: reportJson.issue,
    kind: run.kind,
    model: run.model,
    branch: run.branch,
    worktree: run.worktree,
    commits: log ? log.split('\n') : [],
    reportedPaths: reported,
    actualPaths: changed,
    outOfScope: scopeErrors,
    scopeExtensions: run.scopeExtensions ?? [],
    report: reportMd,
  };
    output(JSON.stringify(summary, null, 2));
    if (scopeErrors.length) throw new Error(`Worker ${name} changed paths outside its allowed scope: ${scopeErrors.join(', ')}.`);
    if (omitted.length) throw new Error(`Worker ${name} omitted changed paths from its report: ${omitted.join(', ')}.`);
  if (options.record) {
    const entry = {
      issue: run.issue,
      model: run.model,
      surface: 'herdr',
      worktree: run.worktree,
      startedAt: run.startedAt,
      endedAt: new Date(now).toISOString(),
      outcome: options.outcome,
      timedOut: false,
      // null means unknown. A harness that counts tool calls can report usage.toolCalls.
      toolCalls: Number.isSafeInteger(reportJson.usage?.toolCalls) && reportJson.usage.toolCalls >= 0 ? reportJson.usage.toolCalls : null,
      changedPaths: reported,
      independentGate: { passed: !!options.gatePassed, command: 'Independent gate result supplied by orchestrator; command and evidence are in the worker report and review.' },
      defectsFound: Array.from({ length: options.defects ?? 0 }, (_value, index) => `defect ${index + 1}`),
      rework: Array.from({ length: options.rework ?? 0 }, (_value, index) => `rework ${index + 1}`),
      evidenceTier: reportJson.evidenceTier,
      scopeExtensions: run.scopeExtensions ?? [],
    };
    const usage = reportJson.usage || {};
    const provider = Object.hasOwn(run, 'provider') ? run.provider : providerFor(run.kind, run.model);
    const recorded = recordUsageFn({
      id: `worker:${config.slug}:${name}:${run.startedAt}`,
      project: config.slug, workspace: run.pane?.split(':')[0] || null,
      kind: run.kind, model: run.model, provider,
      startedAt: run.startedAt, endedAt: entry.endedAt, outcome: entry.outcome,
      gatePassed: entry.independentGate.passed, issue: run.issue,
      inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
      cachedTokens: usage.cachedTokens ?? null, cost: usage.cost ?? null,
    });
    if (recorded.errors.length) output(`Warning: usage was not recorded: ${recorded.errors.join(' ')}`);
    appendDelegatedRun(config.ledgerPath, entry, { evidenceTiers: config.evidenceTiers });
    run.finishedAt = entry.endedAt;
    run.outcome = entry.outcome;
    writeJsonAtomic(file, run);
  }
  return summary;
}

// A parked worker waits on purpose, for example for the Owner. Its pane label tells Herdr Boss to leave it out of idle notices.
export function parkWorker(name, { reason = null, unpark = false } = {}, { config, herdr = createHerdrRunner(), output = console.log } = {}) {
  const { file, run } = readRun(config, name);
  if (run.finishedAt) throw new Error(`Run ${name} is already finished.`);
  if (!run.pane) throw new Error(`Run ${name} has no pane.`);
  if (unpark) {
    herdr(['pane', 'rename', run.pane, '--clear']);
    delete run.parked;
    output(`Worker ${name} is active again. Idle notices include pane ${run.pane}.`);
  } else {
    if (!reason) throw new Error('worker park needs --reason TEXT.');
    herdr(['pane', 'rename', run.pane, 'parked']);
    run.parked = { reason, at: new Date().toISOString() };
    output(`Worker ${name} is parked: ${reason}. Idle notices skip pane ${run.pane}.`);
  }
  writeJsonAtomic(file, run);
  return run;
}

export function listWorkers(config, { herdr = createHerdrRunner(), output = console.log } = {}) {
  const live = listFrom(herdr(['agent', 'list']), 'agents');
  let records = [];
  try {
    records = fs.readdirSync(config.runsPath).filter((name) => name.endsWith('.json')).map((file) => readJson(path.join(config.runsPath, file)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = records.filter((record) => !record.finishedAt).map((record) => {
    const agent = live.find((item) => getName(item) === record.name);
    return { ...record, agentStatus: agent?.agent_status ?? agent?.status ?? 'not live' };
  });
  output(JSON.stringify(rows, null, 2));
  return rows;
}
