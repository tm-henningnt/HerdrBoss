import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendDelegatedRun, compareChangedPaths, gitChangedPaths, gitLog, readJson, validateAllowedPaths, validateScopePaths, validateWorkerReport } from './orchestration.js';
import { recordUsage } from '../usage.js';
import { goalSummary, mergeModels, modelEnabled, providerFor, selectModel, unavailablePiModels, unmeteredClosedParts, unmeteredSummary } from '../control.js';
import { DATA_DIR } from '../config.js';
import { workerStatusFromState } from '../worker-failures.js';
import { checkAgentsFile } from './agents-check.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const BRIEF_SLOTS = new Set([
  'name', 'kind', 'model', 'effort', 'project', 'repo', 'worktree', 'branch', 'base', 'issue', 'task',
  'allowedPaths', 'reportPath', 'reportJsonPath', 'orchPane', 'orchName', 'bulletinPath', 'date', 'evidenceTiers', 'threadLimit', 'imageBudget', 'copyPaths',
]);

function git(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding });
}

function globSegmentMatches(pattern, segment) {
  const escaped = pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replaceAll('\\*', '[^/]*');
  return new RegExp(`^${escaped}$`).test(segment);
}

function matchingRegularFiles(root, pattern) {
  const segments = pattern.split('/');
  const matches = new Map();
  const visit = (directory, patternIndex) => {
    if (patternIndex >= segments.length) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    const segment = segments[patternIndex];
    if (segment === '**') {
      visit(directory, patternIndex + 1);
      for (const entry of entries) {
        if (entry.name === '.git' && directory === root) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file, patternIndex);
        else if (entry.isFile() && patternIndex === segments.length - 1) {
          const relative = path.relative(root, file).split(path.sep).join('/');
          try {
            const stat = fs.statSync(file);
            if (stat.isFile()) matches.set(relative, stat.mtimeMs);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
      return;
    }
    const finalSegment = patternIndex === segments.length - 1;
    for (const entry of entries) {
      if (entry.name === '.git' && directory === root) continue;
      if (!globSegmentMatches(segment, entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !finalSegment) visit(file, patternIndex + 1);
      else if (entry.isFile() && finalSegment) {
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) {
            const relative = path.relative(root, file).split(path.sep).join('/');
            matches.set(relative, stat.mtimeMs);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  };
  visit(root, 0);
  return [...matches].map(([file, mtimeMs]) => ({ file, mtimeMs }));
}

function collectArtifactWarnings(worktree, reportMd, artifactChecks = []) {
  if (!/^Status: done(?=$|[\s\p{P}])(?!-[\p{L}\p{N}_-])/mu.test(reportMd)) return [];
  const warnings = [];
  for (const rule of artifactChecks) {
    const sources = matchingRegularFiles(worktree, rule.sources);
    if (!sources.length) continue;
    const artifacts = matchingRegularFiles(worktree, rule.artifacts);
    if (!artifacts.length) {
      warnings.push(`No files match artifacts "${rule.artifacts}" while sources match "${rule.sources}".`);
      continue;
    }
    const latestSource = sources.reduce((latest, item) => Math.max(latest, item.mtimeMs), -Infinity);
    const oldestArtifact = artifacts.reduce((oldest, item) => Math.min(oldest, item.mtimeMs), Infinity);
    if (latestSource > oldestArtifact) {
      warnings.push(`Artifacts matching "${rule.artifacts}" may be stale because sources matching "${rule.sources}" are newer.`);
    }
  }
  return warnings;
}

export function parseCwdProcesses(output) {
  const processes = [];
  let processInfo = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      if (processInfo?.cwd) processes.push(processInfo);
      processInfo = { pid: Number(line.slice(1)), ppid: null, command: null, cwd: null };
    } else if (processInfo && line.startsWith('c')) processInfo.command = line.slice(1);
    else if (processInfo && line.startsWith('R')) processInfo.ppid = Number(line.slice(1)) || null;
    else if (processInfo && line.startsWith('n')) processInfo.cwd = line.slice(1);
  }
  if (processInfo?.cwd) processes.push(processInfo);
  return processes;
}

export function parseWorktreeCwdProcesses(output, worktree) {
  const root = path.resolve(worktree);
  return parseCwdProcesses(output).filter(({ cwd }) => cwd === root || cwd.startsWith(`${root}${path.sep}`));
}

export function filterCollectProcesses(processes, { worktree, shellPid = null }) {
  const root = path.resolve(worktree);
  const inTree = processes.filter((item) => item.cwd && (path.resolve(item.cwd) === root || path.resolve(item.cwd).startsWith(`${root}${path.sep}`)));
  const byPid = new Map(processes.map((item) => [Number(item.pid), item]));
  const daemon = (item) => /(?:^|\/)Codex\.app\/Contents\/Resources\/app-server-daemon(?:\s|$)/.test(String(item.executable ?? item.args ?? ''));
  const workerRuntime = (item) => {
    const visited = new Set();
    let current = item;
    while (current && !visited.has(Number(current.pid))) {
      if (Number(current.pid) === Number(shellPid) && Number(shellPid) > 0) return true;
      visited.add(Number(current.pid));
      current = byPid.get(Number(current.ppid));
    }
    return false;
  };
  const sharedRuntime = (item) => {
    const visited = new Set();
    let current = item;
    while (current && !visited.has(Number(current.pid))) {
      if (daemon(current)) return true;
      visited.add(Number(current.pid));
      current = byPid.get(Number(current.ppid));
    }
    return false;
  };
  const workload = (item) => /(?:\bnode\s+--test\b|\b(?:jest|vitest|mocha|playwright)\b|\b(?:nodemon|watcher|watchpack|chokidar)\b|\b(?:vite|webpack|next)\s+(?:dev|serve)\b|\b(?:server|serve)\.js\b)/i.test(String(item.args ?? ''));
  return inTree.filter((item) => {
    if (Number(item.ppid) === 1 || workload(item)) return true;
    if (daemon(item) || sharedRuntime(item) || workerRuntime(item)) return false;
    return true;
  });
}

export function listCwdProcesses() {
  const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-FpcnR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseCwdProcesses(output);
}

function worktreeCwdProcesses(worktree) {
  const processes = listCwdProcesses();
  for (const item of processes) {
    if (!/^app-server/.test(item.command ?? '')) continue;
    try {
      item.executable = execFileSync('lsof', ['-a', '-p', String(item.pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {}
  }
  return processes;
}

function workerPaneShellPid(paneId, herdr) {
  try {
    const response = herdr(['pane', 'process-info', '--pane', paneId]);
    const info = response?.process_info ?? response;
    const pid = Number(info?.shell_pid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
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
    if (name === 'copyPaths' && Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : '(none)';
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
  const goals = goalSummary(lane?.goals);
  const suffix = goals ? `; ${goals}` : '';
  if (!lane || lane.state === 'open') return `${provider} open${suffix}`;
  if (lane.state === 'unknown') return `${provider} unknown (no quota data)${suffix}`;
  if (lane.state === 'exhausted') return `${provider} exhausted: ${lane.usedPercent}% used in the ${lane.window} window; exhausted until ${lane.resetAt || 'an unknown time'}${suffix}`;
  const numbers = `${lane.usedPercent}% used${lane.expectedPercent != null ? ` against ${lane.expectedPercent}% expected` : ''} in the ${lane.window} window`;
  if (lane.state === 'reserve') return `${provider} near exhaustion: ${numbers}; resets in ${inAbout(lane.backOnPaceAt, now)}${suffix}`;
  return `${provider} ahead of pace: ${numbers}; back on pace in about ${inAbout(lane.backOnPaceAt, now)} if unused${suffix}`;
}

export function describeUnmetered(lane, project = null) {
  const summary = unmeteredSummary(lane, project);
  const closed = unmeteredClosedParts(lane, undefined, project);
  const head = lane?.state === 'closed' ? 'unmetered closed: no unmetered model can start'
    : project && !Object.hasOwn(lane?.byProject || {}, project) ? 'unmetered open; no unmetered models are available after exclusions'
      : summary ? `unmetered open: ${summary}` : 'unmetered open; no unmetered models are available after exclusions';
  return [head, ...closed].join('\n');
}

// Refuse a free model that cannot start. A Pi model that the last good `pi --list-models` result does not list
// cannot run, so --force does not bypass it. An exhausted harness free lane yields to an authorized --force.
export function unmeteredGate(kind, model, provider, rules, { force = false, now = Date.now(), project = null, allowedModels = null } = {}) {
  if (kind === 'pi' && Array.isArray(rules?.piModels?.models) && !rules.piModels.models.includes(model)) {
    const [missing] = unavailablePiModels([model], rules.piModels);
    const reason = missing.reason === 'no-credential'
      ? `Pi has no credential for the ${missing.provider} provider. Adding one is the Owner's decision.`
      : 'Pi does not list this model.';
    return { error: `pi cannot run ${model}: the last pi --list-models result does not list it. ${reason} --force cannot bypass this refusal.` };
  }
  if (provider !== null) return {};
  const lane = (rules?.lanes?.unmetered?.exhaustedLanes || []).find((item) => item.kind === kind && Number.isFinite(item.retryAt) && item.retryAt > now);
  if (!lane) return {};
  const detail = `The ${kind} free lane is exhausted (${lane.reason || 'free usage exceeded'}); retry after ${new Date(lane.retryAt).toISOString()}${lane.retryKnown ? '' : ' (reset time unknown)'}.`;
  if (force) return { warning: `Warning: --force overrides the free lane guard. ${detail}` };
  const alternatives = unmeteredAlternatives(rules, project, allowedModels);
  return { error: `${detail}${alternatives ? ` ${alternatives}` : ''} Use --force only for an authorized override.` };
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
  if (lane?.state === 'exhausted') {
    const open = Object.entries(rules.lanes || {}).filter(([, value]) => !value.unmetered && value.state === 'open').map(([name]) => name);
    const next = open.length ? `Open providers: ${open.join(', ')}.` : 'No metered provider is open; free models do not count against a quota.';
    return { error: `${detail}.${lead} ${next} Use --force only for an authorized override.` };
  }
  if (lane?.state === 'pace' && rules.leastOverProvider === provider) {
    return { warning: `Notice: every metered provider is over pace. ${detail}.${lead} It is the least over, so the worker starts. Keep the task small and record the reason in the run.` };
  }
  const open = Object.entries(rules.lanes || {}).filter(([, value]) => !value.unmetered && value.state === 'open').map(([name]) => name);
  const next = open.length ? `Open providers: ${open.join(', ')}.`
    : rules.leastOverProvider ? `Every metered provider is over pace; ${rules.leastOverProvider} is the least over and starts without --force.`
      : 'No metered provider is open; free models do not count against a quota.';
  return { error: `${detail}.${lead} ${next} Use --force only for an authorized override.` };
}

function machineGuardState(machine, now = Date.now()) {
  if (machine.guardEnabled === false || machine.guardState === 'off') return 'off';
  const pauseAt = machine.guardPausedUntil == null ? NaN : Date.parse(machine.guardPausedUntil);
  if (Number.isFinite(pauseAt) && pauseAt > now) return 'paused';
  return 'active';
}

export function describeMachine(rules) {
  const machine = rules?.machine;
  if (!machine) return null;
  const guardState = machineGuardState(machine);
  const guardActive = guardState === 'active';
  const cpu = Number.isFinite(machine.cpuPercent) ? `${machine.cpuPercent.toFixed(1)}%` : 'unknown';
  const load = Number.isFinite(machine.fiveMinute) ? machine.fiveMinute : 'unknown';
  const exceeded = guardActive && ((Number.isFinite(machine.cpuPercent) && Number.isFinite(machine.cpuLimit) && machine.cpuPercent > machine.cpuLimit)
    || (Number.isFinite(machine.fiveMinute) && Number.isFinite(machine.loadLimit) && machine.fiveMinute > machine.loadLimit));
  const guardText = guardState === 'paused' ? `paused until ${machine.guardPausedUntil}` : guardState;
  const threshold = guardActive ? '' : 'configured ';
  return `Machine guard ${guardText}. Owner ${machine.owner || 'unknown'}; CPU ${cpu} / ${threshold}limit ${machine.cpuLimit == null ? 'disabled' : `${machine.cpuLimit}%`}; 5-minute load ${load} / ${threshold}backstop ${machine.loadLimit ?? 'disabled'}${exceeded ? '. Stop new workers and full test suites.' : ''}`;
}

// The active machine CPU limit and enabled load backstop refuse starts, including with --force.
export function loadWarning(rules) {
  const machine = rules?.machine;
  if (!machine || machineGuardState(machine) !== 'active') return null;
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

export function verifyCallerPane(env, herdr, requestedOrch = null) {
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

// A Codex worker pane needs HERDR_ENV, or the agent in it cannot run Herdr commands. Other kinds keep the pane environment they had.
function workerPaneCommand(workspaceId, worktree, name, kind) {
  const command = ['tab', 'create', '--workspace', workspaceId, '--label', `W ${name}`, '--cwd', worktree];
  if (kind === 'codex') command.push('--env', 'HERDR_ENV=1');
  command.push('--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus');
  return command;
}

function chooseWorkerPane(workspaceId, worktree, name, kind, herdr) {
  const existingTabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
  const command = workerPaneCommand(workspaceId, worktree, name, kind);
  const created = herdr(command);
  const tabId = getTab(created) ?? created.tab?.tab_id ?? created.id;
  const freshTabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
  const foundTab = freshTabs.find((tab) => getWorkspace(tab) === workspaceId
    && (tab.tab_id === tabId || (tab.label === `W ${name}` && !existingTabs.some((old) => getTab(old) === getTab(tab)))));
  if (!foundTab) throw new Error(`Herdr created tab W ${name} but did not return a tab id that can be found.`);
  const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes');
  const rootPane = panes.find((pane) => getTab(pane) === getTab(foundTab));
  if (!rootPane || !getPane(rootPane)) {
    try { herdr(['tab', 'close', getTab(foundTab)]); } catch {}
    throw new Error(`Worker tab W ${name} has no root pane.`);
  }
  return { paneId: getPane(rootPane), tabId: getTab(foundTab), command, createdTab: true };
}

export function waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait = pause, { retryCommand = 'worker start', timeoutMs = 20_000 } = {}) {
  const intervalMs = 250;
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
            const error = new Error(`Worker pane ${paneId} is waiting at an interactive question: ${question}. Answer it in a shell once, then retry ${retryCommand}.`);
            error.code = 'worker_pane_interactive_question';
            throw error;
          }
          const lastLine = lines.filter((line) => line.trim()).at(-1) ?? '';
          if (/[❯➜$%#>✗✔]\s*$/.test(lastLine)) return;
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
  throw new Error(`Worker pane ${paneId} did not become an available shell in workspace ${workspaceId} at ${worktree} within ${Math.ceil(timeoutMs / 1000)} seconds.`);
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

export function isAgentPaneBusy(error) {
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
    `   Root pane: ${plan.paneId}`,
    `7. Start agent:`,
    `   $ herdr agent start ${displayArg(plan.name)} --kind ${displayArg(plan.kind)} --pane ${displayArg(plan.paneId)} --timeout ${plan.agentStartTimeoutMs} -- ${plan.launchArgs.map(displayArg).join(' ')}`,
    `8. Write run record: ${plan.recordFile}`,
    `9. Send task prompt and observe agent activity:`,
    `   $ herdr agent prompt ${displayArg(plan.name)} "${briefPrompt(plan.workerDir)}"`,
  ];
  return lines.join('\n');
}

// A one-line warning when the project AGENTS.md has drift findings. The check never refuses a start.
function agentsDrift(root, rulesFile) {
  const file = root && path.join(root, 'AGENTS.md');
  if (!file || !fs.existsSync(file)) return null;
  try {
    const result = checkAgentsFile(file, { rulesFile, relative: 'AGENTS.md' });
    return result.findings.length ? `Warning: AGENTS.md drift: ${result.errors} errors, ${result.warnings} warnings. Run herdr-boss check agents.` : null;
  } catch { return null; }
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
  const modelConfig = models ?? JSON.parse(fs.readFileSync(new URL('../../kit/models.json', import.meta.url), 'utf8'));
  const rulesPath = rulesFile ?? path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'rules.json');
  const rules = readRules(rulesPath);
  const callerWorkspace = Array.isArray(rules.control?.workspaces)
    ? rules.control.workspaces.find((workspace) => workspace?.workspace === caller.workspaceId && workspace.excluded)
    : null;
  if (callerWorkspace) {
    const label = callerWorkspace.label || caller.workspaceId;
    throw new Error(`Workspace ${label} (${caller.workspaceId}) is excluded and has no worker slots.`);
  }
  const liveAgents = checkLiveName(name, herdr);
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
  // Local extra models from the policy join the harness allow-list and use its launch arguments.
  const { model, effort, launchArgs } = validateSelection(options.kind, options, mergeModels(modelConfig, policy), config, policy);
  const agentsWarning = agentsDrift(config.root, rulesPath);
  if (agentsWarning) output(agentsWarning);
  const projectPolicy = policy?.projects?.[config.slug];
  if (policy) {
    if (!policy.allowedKinds?.includes(options.kind)) throw new Error(`${options.kind} is disabled globally by Herdr Boss.`);
    if (policy.excludedModels?.includes(model)) throw new Error(`${model} is disabled globally by Herdr Boss.`);
    if (!modelEnabled(options.kind, model, policy)) throw new Error(`${model} is disabled for ${options.kind} by Herdr Boss.`);
    if (projectPolicy?.excludedKinds?.includes(options.kind) || projectPolicy?.excludedModels?.includes(model)) throw new Error(`${options.kind}/${model} is excluded for project ${config.slug}.`);
    if (projectPolicy?.mode === 'paused' && !options.force) throw new Error(`Project ${config.slug} is paused. Use --force only for an authorized override.`);
  }
  const provider = providerFor(options.kind, model, policy);
  const freeGate = unmeteredGate(options.kind, model, provider, rules, { force: options.force, now, project: config.slug, allowedModels: config.allowedModels });
  if (freeGate.error) throw new Error(freeGate.error);
  if (freeGate.warning) output(freeGate.warning);
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
  const copyFiles = (options.copy ?? []).map((input) => {
    const source = path.resolve(config.root, input);
    const relative = path.relative(config.root, source);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Copy path ${input} must be inside the repository.`);
    let stats;
    try { stats = fs.lstatSync(source); } catch { throw new Error(`Copy path ${input} does not exist.`); }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Copy path ${input} must be a regular file.`);
    const realRoot = fs.realpathSync(config.root);
    const realSource = fs.realpathSync(source);
    const realRelative = path.relative(realRoot, realSource);
    if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`Copy path ${input} must be inside the repository.`);
    return { source, relative: realRelative.split(path.sep).join('/') };
  });
  const destinations = copyFiles.map(({ relative }) => relative);
  if (new Set(destinations).size !== destinations.length) throw new Error('Copy paths have a destination collision.');
  const base = options.base ?? config.baseBranch;
  const baseCommit = git(config.root, ['rev-parse', base]).trim();
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
  let paneId = null;
  let paneCommand;
  if (options.dryRun) {
    paneCommand = workerPaneCommand(workspaceId, worktree, name, options.kind);
    paneId = '<new-root-pane-id>';
  }

  const plan = {
    name, kind: options.kind, model, effort, rulesFile: rulesPath, rulesStale: staleRules,
    noWorktree: !!options.noWorktree, worktree, branch, base, template: config.briefTemplatePath,
    workspaceId, paneId, paneCommand, launchArgs, recordFile, excludeFile,
    // A worker in the current worktree uses its existing dependencies, so setup runs only for a new worktree.
    setup: options.noWorktree ? null : config.setup ?? null, setupTimeoutSeconds: config.setupTimeoutSeconds ?? 900,
    agentStartTimeoutMs: config.agentStartTimeoutMs ?? 90000,
    workerDir: workerDirName(name, !!options.noWorktree),
    copyFiles,
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
  const briefSlots = {
    name, kind: options.kind, model, effort, project: config.slug, repo: config.root, worktree, branch, base,
    issue: options.issue ?? null, task, allowedPaths: options.allow ?? [], reportPath, reportJsonPath,
    orchPane, orchName, bulletinPath: path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'bulletin.md'),
    date: new Date(now).toISOString().slice(0, 10),
    evidenceTiers: (config.evidenceTiers || []).join(', '),
    imageBudget: config.imageBudget ?? 10,
    copyPaths: copyFiles.map(({ relative }) => path.posix.join(plan.workerDir, 'inputs', relative)),
    threadLimit: config.testThreadsFlag
      ? `Add \`${config.testThreadsFlag}\` to each test runner command.`
      : 'Use the form that the project instructions name. For Vitest 2 with the forks pool, use `--poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`; `--maxWorkers=2` fails there. For Vitest 3 and later, use `--maxWorkers=2`.',
  };
  const missingBriefDetails = [];
  if (!/{{\s*imageBudget\s*}}/.test(template)) {
    missingBriefDetails.push(`Screenshot budget: ${briefSlots.imageBudget} screenshots. The project setting overrides the kit default.`);
  }
  if (briefSlots.copyPaths.length && !/{{\s*copyPaths\s*}}/.test(template)) {
    missingBriefDetails.push(`Copied inputs:\n${briefSlots.copyPaths.map((item) => `- ${item}`).join('\n')}`);
  }
  const brief = `${renderBrief(template, briefSlots)}${missingBriefDetails.length ? `\n\n## Worker start details\n\n${missingBriefDetails.join('\n\n')}` : ''}`;

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
    for (const file of copyFiles) {
      const destination = path.join(worktree, plan.workerDir, 'inputs', ...file.relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) throw new Error(`Copy destination already exists: ${destination}.`);
      fs.copyFileSync(file.source, destination, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(path.join(worktree, plan.workerDir, 'brief.md'), brief);
    if (plan.setup) {
      output(`Running project setup in ${worktree}: ${plan.setup}`);
      const started = Date.now();
      try { runSetup(plan.setup, worktree, plan.setupTimeoutSeconds * 1000); }
      catch (error) { throw setupFailure(error, plan.setup, plan.setupTimeoutSeconds); }
      output(`Project setup finished in ${Math.round((Date.now() - started) / 1000)} s.`);
    }
    placement = chooseWorkerPane(workspaceId, worktree, name, options.kind, herdr);
    paneId = placement.paneId;
    waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait);
    const shellPid = workerPaneShellPid(paneId, herdr);
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
      baseCommit,
      shellPid,
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
    const failedReason = error.message;
    if (!agentStarted && placement) {
      try {
        if (placement.createdTab) herdr(['tab', 'close', placement.tabId]);
      } catch (cleanupError) {
        error.message += ` (Herdr tab cleanup also failed: ${cleanupError.message})`;
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
        try { uniqueCommits = git(config.root, ['rev-list', `${baseCommit}..${branch}`]).trim(); }
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
    error.message = `${error.message}\nSTART FAILED: ${failedReason.split('\n')[0]}`;
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
  const processList = listWorktreeProcesses(run.worktree);
  const leftovers = filterCollectProcesses(processList, { worktree: run.worktree, shellPid: run.shellPid });
  if (leftovers.length) throw new Error(`Worker ${name} still has processes in its worktree: ${leftovers.map((process) => `${process.command || 'unknown'} (pid ${process.pid}, ppid ${process.ppid ?? 'unknown'}, cwd ${process.cwd})`).join('; ')}. Stop them before collection.`);
  if (run.issue != null && reportJson.issue !== run.issue) throw new Error(`Report issue ${reportJson.issue} does not match run issue ${run.issue}.`);
  if (reportJson.branch !== run.branch) throw new Error(`Report branch ${reportJson.branch} does not match run branch ${run.branch}.`);
  const baseRef = run.baseCommit || run.base;
  const log = gitLog(run.worktree, baseRef);
  // The worker's own brief and report files live under .worker/ and never count as changed product paths.
  const ownFile = (item) => item === '.worker' || String(item).startsWith('.worker/');
  const reported = (reportJson.changedPaths || []).filter((item) => !ownFile(item));
  const changed = gitChangedPaths(run.worktree, baseRef).filter((item) => !ownFile(item));
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
    artifactWarnings: collectArtifactWarnings(run.worktree, reportMd, config.artifactChecks ?? []),
    report: reportMd,
  };
    output(JSON.stringify(summary, null, 2));
    for (const warning of summary.artifactWarnings) output(`Warning: ${warning}`);
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
    output(`After you merge ${run.branch}, remove the worktree with herdr-boss worktree prune --apply`);
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

export function listWorkers(config, { herdr = createHerdrRunner(), output = console.log, stateFile = path.join(DATA_DIR, 'state.json') } = {}) {
  const live = listFrom(herdr(['agent', 'list']), 'agents');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  let records = [];
  try {
    records = fs.readdirSync(config.runsPath).filter((name) => name.endsWith('.json')).map((file) => readJson(path.join(config.runsPath, file)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = records.filter((record) => !record.finishedAt).map((record) => {
    const agent = live.find((item) => getName(item) === record.name);
    return { ...record, agentStatus: workerStatusFromState(record.pane, state, record) || agent?.agent_status || agent?.status || 'not live' };
  });
  output(JSON.stringify(rows, null, 2));
  return rows;
}
