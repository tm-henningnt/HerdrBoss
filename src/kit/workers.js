import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, gitLog, readJson, validateAllowedPaths, validateWorkerReport } from './orchestration.js';
import { recordUsage } from '../usage.js';
import { providerFor } from '../control.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const BRIEF_SLOTS = new Set([
  'name', 'kind', 'model', 'effort', 'project', 'repo', 'worktree', 'branch', 'base', 'issue', 'task',
  'allowedPaths', 'reportPath', 'reportJsonPath', 'orchPane', 'orchName', 'bulletinPath', 'date',
]);

function git(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding });
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
  return (args) => parseHerdrJson(exec(args));
}

const BRIEF_PROMPT = 'Read .worker/brief.md in your working directory and execute it.';

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

function deliverBrief(name, herdr, readText, wait) {
  return deliverPrompt(name, BRIEF_PROMPT, '.worker/brief.md', { herdr, readText, wait });
}

// The machine load only warns. Orchestrators decide whether a worker is worth starting on a loaded machine.
export function loadWarning(rules) {
  const load = rules?.load;
  if (!load || !Number.isFinite(load.fiveMinute) || !Number.isFinite(load.limit) || load.fiveMinute <= load.limit) return null;
  return [
    `Warning: the machine is overloaded. The 5-minute load is ${load.fiveMinute} on ${load.cpus} cores; the limit is ${load.limit}.`,
    'The worker starts, but it competes with the running work of every project. Before you continue:',
    '  1. Wait for the load to drop below the limit if the task can wait. Check it with `uptime` or ~/.herdr-boss/bulletin.md.',
    '  2. In the brief, tell the worker to run focused tests only, with at most two runner threads. The flag for each runner is in the kit skill, section "Machine load".',
    '  3. Do not start a full test suite until the load is below the limit.',
  ].join('\n');
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

function validateSelection(kind, options, models, config) {
  const policy = models.kinds[kind];
  if (!policy) throw new Error(`Unknown agent kind: ${kind}. Choose one of ${Object.keys(models.kinds).join(', ')}.`);
  const model = options.model ?? policy.defaultModel;
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
    const created = herdr(['tab', 'create', '--workspace', workspaceId, '--label', 'Workers', '--cwd', worktree, '--no-focus']);
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
    return { paneId: getPane(rootPane), tabId: getTab(foundTab), command: ['tab', 'create', '--workspace', workspaceId, '--label', 'Workers', '--cwd', worktree, '--no-focus'], createdTab: true };
  }

  const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => getTab(pane) === getTab(workerTab));
  if (!panes.length) throw new Error('The Workers tab has no pane to split.');
  const source = panes[0];
  let dimensions = findDimensions(source);
  if (!dimensions) {
    try { dimensions = findDimensions(herdr(['pane', 'layout', '--pane', getPane(source)])); } catch {}
  }
  const direction = dimensions && dimensions.height > dimensions.width ? 'down' : 'right';
  const command = ['pane', 'split', getPane(source), '--direction', direction, '--cwd', worktree, '--no-focus'];
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

function renderStartPlan(plan) {
  const lines = [
    `1. Validate agent name: ${plan.name}`,
    `   $ herdr agent list`,
    `2. Read resource rules: ${plan.rulesFile}${plan.rulesStale ? ' (stale or missing; warn)' : ''}`,
    `3. Validate kind/model/effort: ${plan.kind} / ${plan.model} / ${plan.effort ?? '(none)'}`,
    `4. Create worktree: ${plan.noWorktree ? '(disabled; use current worktree)' : plan.worktree}`,
    ...(plan.noWorktree ? [] : [`   $ git worktree add -b ${displayArg(plan.branch)} ${displayArg(plan.worktree)} ${displayArg(plan.base)}`]),
    `   Append /.worker/ to ${plan.excludeFile}`,
    `5. Render brief: ${plan.worktree}/.worker/brief.md from ${plan.template}`,
    ...(plan.setup ? [`   Run project setup in the worktree (timeout ${plan.setupTimeoutSeconds} s):`, `   $ ${plan.setup}`] : []),
    `6. Place worker in workspace ${plan.workspaceId}:`,
    `   $ herdr ${plan.paneCommand.map(displayArg).join(' ')}`,
    `7. Start agent:`,
    `   $ herdr agent start ${displayArg(plan.name)} --kind ${displayArg(plan.kind)} --pane ${displayArg(plan.paneId)} -- ${plan.launchArgs.map(displayArg).join(' ')}`,
    `8. Write run record: ${plan.recordFile}`,
    `9. Send task prompt and observe agent activity:`,
    `   $ herdr agent prompt ${displayArg(plan.name)} "${BRIEF_PROMPT}"`,
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
  const liveAgents = checkLiveName(name, herdr);
  const modelConfig = models ?? JSON.parse(fs.readFileSync(new URL('../../kit/models.json', import.meta.url), 'utf8'));
  const rulesPath = rulesFile ?? path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'rules.json');
  const rules = readRules(rulesPath);
  const staleRules = rulesWarning(rules, now);
  if (staleRules) output(`Warning: Herdr Boss rules are older than 10 minutes or have no valid timestamp: ${rulesPath}`);
  const overload = loadWarning(rules);
  if (overload) output(overload);
  if (!options.kind) throw new Error('--kind is required.');
  if (rules.avoidKinds !== undefined && !Array.isArray(rules.avoidKinds)) throw new Error(`Herdr Boss rules avoidKinds must be an array: ${rulesPath}`);
  if ((rules.avoidKinds ?? []).includes(options.kind)) {
    if (!options.force) throw new Error(`Herdr Boss rules avoid ${options.kind}; pass --force to override.`);
    output(`Warning: --force overrides Herdr Boss rules for ${options.kind}.`);
  }
  const { model, effort, launchArgs } = validateSelection(options.kind, options, modelConfig, config);
  const policy = rules.policy;
  const projectPolicy = policy?.projects?.[config.slug];
  if (policy) {
    if (!policy.allowedKinds?.includes(options.kind)) throw new Error(`${options.kind} is disabled globally by Herdr Boss.`);
    if (policy.excludedModels?.includes(model)) throw new Error(`${model} is disabled globally by Herdr Boss.`);
    if (projectPolicy?.excludedKinds?.includes(options.kind) || projectPolicy?.excludedModels?.includes(model)) throw new Error(`${options.kind}/${model} is excluded for project ${config.slug}.`);
    if (projectPolicy?.mode === 'paused' && !options.force) throw new Error(`Project ${config.slug} is paused. Use --force only for an authorized override.`);
  }
  const provider = providerFor(options.kind, model);
  if (provider && rules.avoidProviders?.includes(provider) && !options.force) throw new Error(`${provider} is ahead of quota pace or near exhaustion; choose another model or use --force.`);
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

  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error('HERDR_WORKSPACE_ID is required to place a worker in the caller workspace.');
  if (!(options.orch ?? env.HERDR_PANE_ID)) throw new Error('Use --orch or run from an orchestrator pane with HERDR_PANE_ID.');
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
      paneCommand = ['pane', 'split', getPane(source), '--direction', direction, '--cwd', worktree, '--no-focus'];
      paneId = '<new-pane-id>';
    } else {
      paneCommand = ['tab', 'create', '--workspace', workspaceId, '--label', 'Workers', '--cwd', worktree, '--no-focus'];
      paneId = '<new-root-pane-id>';
    }
  }

  const plan = {
    name, kind: options.kind, model, effort, rulesFile: rulesPath, rulesStale: staleRules,
    noWorktree: !!options.noWorktree, worktree, branch, base, template: config.briefTemplatePath,
    workspaceId, paneId, paneCommand, launchArgs, recordFile, excludeFile,
    // A worker in the current worktree uses its existing dependencies, so setup runs only for a new worktree.
    setup: options.noWorktree ? null : config.setup ?? null, setupTimeoutSeconds: config.setupTimeoutSeconds ?? 900,
  };
  if (options.dryRun) {
    output(renderStartPlan(plan));
    return { ...plan, dryRun: true };
  }

  const reportPath = path.join(worktree, '.worker', 'report.md');
  const reportJsonPath = path.join(worktree, '.worker', 'report.json');
  const orchPane = options.orch ?? env.HERDR_PANE_ID ?? '(none)';
  const orchName = getName(liveAgents.find((agent) => getPane(agent) === orchPane)) ?? '(none)';
  const template = fs.readFileSync(config.briefTemplatePath, 'utf8');
  const brief = renderBrief(template, {
    name, kind: options.kind, model, effort, project: config.slug, repo: config.root, worktree, branch, base,
    issue: options.issue ?? null, task, allowedPaths: options.allow ?? [], reportPath, reportJsonPath,
    orchPane, orchName, bulletinPath: path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'bulletin.md'),
    date: new Date(now).toISOString().slice(0, 10),
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
    fs.mkdirSync(path.join(worktree, '.worker'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.worker', 'brief.md'), brief);
    if (plan.setup) {
      output(`Running project setup in ${worktree}: ${plan.setup}`);
      const started = Date.now();
      try { runSetup(plan.setup, worktree, plan.setupTimeoutSeconds * 1000); }
      catch (error) { throw setupFailure(error, plan.setup, plan.setupTimeoutSeconds); }
      output(`Project setup finished in ${Math.round((Date.now() - started) / 1000)} s.`);
    }
    placement = chooseWorkerPane(workspaceId, worktree, herdr);
    paneId = placement.paneId;
    try {
      herdr(['agent', 'start', name, '--kind', options.kind, '--pane', paneId, '--', ...launchArgs]);
    } catch (startError) {
      // Herdr can report agent_not_ready while leaving a blocked agent in the pane.
      try { agentStarted = listFrom(herdr(['agent', 'list']), 'agents').some((agent) => getName(agent) === name); } catch {}
      throw startError;
    }
    agentStarted = true;
    const record = {
      name,
      kind: options.kind,
      model,
      effort,
      issue: options.issue == null ? null : Number(options.issue),
      worktree,
      branch,
      base,
      pane: paneId,
      allowedPaths: options.allow ?? [],
      startedAt: new Date(now).toISOString(),
    };
    writeJsonAtomic(recordFile, record);
    const delivery = deliverBrief(name, herdr, readText, wait);
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
      try {
        git(config.root, ['worktree', 'remove', worktree]);
        git(config.root, ['branch', '-d', branch]);
      } catch (cleanupError) {
        error.message += ` (cleanup also failed: ${cleanupError.message})`;
      }
    }
    if (agentStarted) error.message += ` Agent ${name} may still be running in pane ${paneId}; inspect it before retrying.`;
    throw error;
  }
}

function readRun(config, name) {
  if (!NAME_PATTERN.test(name)) throw new Error('Worker name must match [a-z][a-z0-9-]{0,31}.');
  const file = path.join(config.runsPath, `${name}.json`);
  const run = readJson(file);
  if (run.name !== name) throw new Error(`Run record name does not match ${name}.`);
  return { file, run };
}

export function collectWorker(name, options, { config, now = Date.now(), output = console.log } = {}) {
  const { file, run } = readRun(config, name);
  if (run.finishedAt) throw new Error(`Run ${name} is already marked finished at ${run.finishedAt}.`);
  const reportDir = path.join(run.worktree, '.worker');
  const reportJson = readJson(path.join(reportDir, 'report.json'));
  const reportMd = fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  const errors = validateWorkerReport(reportJson, { evidenceTiers: config.evidenceTiers });
  if (errors.length) throw new Error(`Invalid worker report:\n- ${errors.join('\n- ')}`);
  if (path.resolve(reportJson.worktree) !== path.resolve(run.worktree)) throw new Error(`Report worktree ${reportJson.worktree} does not match run worktree ${run.worktree}.`);
  const actualBranch = git(run.worktree, ['branch', '--show-current']).trim();
  if (actualBranch !== run.branch) throw new Error(`Worktree branch ${actualBranch || '(detached)'} does not match run branch ${run.branch}.`);
  if (run.issue != null && reportJson.issue !== run.issue) throw new Error(`Report issue ${reportJson.issue} does not match run issue ${run.issue}.`);
  if (reportJson.branch !== run.branch) throw new Error(`Report branch ${reportJson.branch} does not match run branch ${run.branch}.`);
  const log = gitLog(run.worktree, run.base);
  const changed = gitChangedPaths(run.worktree, run.base);
    const reportScope = compareChangedPaths(reportJson.changedPaths, run.allowedPaths ?? []);
    const actualScope = compareChangedPaths(changed, run.allowedPaths ?? []);
    const scopeErrors = [...new Set([...reportScope, ...actualScope])];
    const omitted = changed.filter((item) => !reportJson.changedPaths.includes(item));
  const summary = {
    name,
    issue: reportJson.issue,
    kind: run.kind,
    model: run.model,
    branch: run.branch,
    worktree: run.worktree,
    commits: log ? log.split('\n') : [],
    reportedPaths: reportJson.changedPaths,
    actualPaths: changed,
    outOfScope: scopeErrors,
    report: reportMd,
  };
    output(JSON.stringify(summary, null, 2));
    if (scopeErrors.length) throw new Error(`Worker ${name} changed paths outside its allowed scope: ${scopeErrors.join(', ')}.`);
    if (omitted.length) throw new Error(`Worker ${name} omitted changed paths from its report: ${omitted.join(', ')}.`);
  if (options.record) {
    if (!['done', 'partial', 'failed'].includes(options.outcome)) throw new Error('--record requires --outcome done|partial|failed.');
    if (options.gatePassed === options.gateFailed) throw new Error('--record requires exactly one of --gate-passed or --gate-failed.');
    if (!Number.isSafeInteger(options.defects ?? 0) || (options.defects ?? 0) < 0) throw new Error('--defects must be a non-negative integer.');
    if (!Number.isSafeInteger(options.rework ?? 0) || (options.rework ?? 0) < 0) throw new Error('--rework must be a non-negative integer.');
    const entry = {
      issue: run.issue,
      model: run.model,
      surface: 'herdr',
      worktree: run.worktree,
      startedAt: run.startedAt,
      endedAt: new Date(now).toISOString(),
      outcome: options.outcome,
      timedOut: false,
      toolCalls: null,
      changedPaths: reportJson.changedPaths,
      independentGate: { passed: !!options.gatePassed, command: 'Independent gate result supplied by orchestrator; command and evidence are in the worker report and review.' },
      defectsFound: Array.from({ length: options.defects ?? 0 }, (_value, index) => `defect ${index + 1}`),
      rework: Array.from({ length: options.rework ?? 0 }, (_value, index) => `rework ${index + 1}`),
      evidenceTier: reportJson.evidenceTier,
    };
    appendDelegatedRun(config.ledgerPath, entry, { evidenceTiers: config.evidenceTiers });
    run.finishedAt = entry.endedAt;
    run.outcome = entry.outcome;
    writeJsonAtomic(file, run);
    const usage = reportJson.usage || {};
    const recorded = recordUsage({
      id: `worker:${config.slug}:${name}:${run.startedAt}`,
      project: config.slug, workspace: run.pane?.split(':')[0] || null,
      kind: run.kind, model: run.model, provider: providerFor(run.kind, run.model) || 'unmetered-or-unknown',
      startedAt: run.startedAt, endedAt: entry.endedAt, outcome: entry.outcome,
      gatePassed: entry.independentGate.passed, issue: run.issue,
      inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
      cachedTokens: usage.cachedTokens ?? null, cost: usage.cost ?? null,
    });
    if (recorded.errors.length) output(`Warning: usage was not recorded: ${recorded.errors.join(' ')}`);
  }
  return summary;
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
