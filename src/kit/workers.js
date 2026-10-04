import fs from 'node:fs';
import { readFactoryShares, FACTORY_SHARE_ERROR } from '../fleet-pacing.js';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendDelegatedRun, compareChangedPaths, gitLog, gitWorkerChangedPaths, readJson, validateAllowedPaths, validateScopePaths, normalizeWorkerReport, validateWorkerReport } from './orchestration.js';
import { recordUsage } from '../usage.js';
import { claudePaceHoldText, goalSummary, mergeModels, modelEnabled, providerFor, quotaPlanLaneText, selectModel, unavailablePiModels, unmeteredClosedParts, unmeteredSummary } from '../control.js';
import { DATA_DIR, loadConfig } from '../config.js';
import { readBoundedWorkerReport, workerStatusFromState } from '../worker-failures.js';
import { checkAgentsFile, kitBehindLine, refreshKitIfRequired, safeRefreshKit } from './agents-check.js';
import { acquireLeaseFor, dropLeases, portEnvStatus, setLeasePane } from '../leases.js';
import { portEnvFor } from '../config.js';
import { codexBrowserArgs, codexShellEnvArgs } from '../harness.js';
import { TASK_ID } from '../task-state.js';
import { swapRefusal, swapExempt } from './swap-guard.js';
import { recordWorkerReport, workerRunId } from '../agent-messages.js';
import { scheduleWorkerPaneClose } from '../maintenance.js';
import { agentPromptTimeoutMs } from '../agent-prompt.js';
import { PLANNER_LABEL, activeSessionForPane, endSession, startSession } from '../planner-sessions.js';
import { closeFailedWorkerPane, retryOpenCodeStart, withOpenCodeStartLock } from './opencode-start.js';
import { activeLaunchRecords, detectLaunchBlock, launchBlockedError, markModelUnavailable, newPaneLines, untilText } from './model-unavailable.js';
import { OPEN_CODE_CONFIG_NAME, openCodeConfigText, opencodeTuiAcceptsModelFlags, unsupportedOpenCodeFlag } from './opencode-cli.js';
import { archiveWorkerReports } from './worker-archive.js';
import { briefCopy, firstParagraph, maskText, titleFromTask } from '../worker-view.js';
import { assertProjectTransferAllowsWorker } from '../project-transfer-locks.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_READY_MARKERS = Object.freeze({
  claude: Object.freeze({
    inputLine: /^❯$/,
    boxRule: /─/,
    footerLine: /(?:auto mode|\? for shortcuts)/i,
  }),
  codex: Object.freeze({
    inputLine: /^› /,
    footerLine: /\? for shortcuts/i,
  }),
  opencode: null,
  pi: null,
});
const KNOWN_AGENT_STATUSES = new Set(['idle', 'working', 'blocked', 'done']);
// The kit installs and updates these files. It writes them in a worker worktree, so a worker never has to report them.
export const KIT_MANAGED_PATHS = Object.freeze(['docs/orchestration/herdr-boss.md', 'AGENTS.md', '.claude/settings.json']);
const READY_POLL_MS = 500;
const READY_WAIT_MS = 45_000;
const STALLED_PROMPT_WAIT_MS = 20_000;
const BRIEF_SLOTS = new Set([
  'name', 'kind', 'model', 'effort', 'project', 'repo', 'worktree', 'branch', 'base', 'issue', 'task',
  'allowedPaths', 'reportPath', 'reportJsonPath', 'orchPane', 'orchAgent', 'bulletinPath', 'herdrEnvPrefix', 'herdrBin', 'date', 'evidenceTiers', 'threadLimit', 'imageBudget', 'copyPaths', 'leases',
  'kindHeaderNote', 'kindWaitNote', 'portInstruction', 'readOnlySection', 'stopRule', 'kindCommitRule',
]);
const MAX_COPIED_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;

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

function callerProcessTree(processes, callerPid, callerPpid = null) {
  const byPid = new Map(processes.map((item) => [Number(item.pid), item]));
  const tree = [];
  const seen = new Set();
  let current = Number(callerPid) > 1
    ? byPid.get(Number(callerPid)) ?? { pid: Number(callerPid), ppid: callerPpid }
    : null;
  while (current && Number(current.pid) > 1 && !seen.has(Number(current.pid))) {
    seen.add(Number(current.pid));
    tree.push(current);
    const parentPid = Number(current.ppid);
    current = parentPid > 1 ? byPid.get(parentPid) : null;
  }
  return tree;
}

function isInWorktree(item, root) {
  return item.cwd && (path.resolve(item.cwd) === root || path.resolve(item.cwd).startsWith(`${root}${path.sep}`));
}

function isShellProcess(item) {
  return /^(?:-?)(?:zsh|bash|fish|sh|dash|ksh|tcsh|csh)$/i.test(String(item?.command ?? ''));
}

export function filterCollectProcesses(processes, { worktree, shellPid = null, callerPid = null, callerPpid = null } = {}) {
  const root = path.resolve(worktree);
  const callerTree = callerProcessTree(processes, callerPid, callerPpid);
  const callerPids = new Set(callerTree.map((item) => Number(item.pid)));
  const inTree = processes.filter((item) => isInWorktree(item, root));
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
    if (callerPids.has(Number(item.pid))) return false;
    if (Number(item.ppid) === 1 || workload(item)) return true;
    if (daemon(item) || sharedRuntime(item) || workerRuntime(item)) return false;
    return true;
  });
}

export function listCwdProcesses() {
  let output;
  try {
    output = execFileSync('lsof', ['-a', '-d', 'cwd', '-FpcnR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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

function workerBriefHerdrCommands(env) {
  const validate = (name, value) => {
    const hasUnsafeCharacter = [...value].some((char) => {
      const code = char.charCodeAt(0);
      return char === '"' || char === "'" || char === '\\' || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    if (hasUnsafeCharacter) {
      throw new Error(`The value of ${name} has a quote, a backslash, or a control character.`);
    }
    return value;
  };
  const socketPath = env.HERDR_SOCKET_PATH ? validate('HERDR_SOCKET_PATH', String(env.HERDR_SOCKET_PATH)) : null;
  const binaryPath = env.HERDR_BIN_PATH ? validate('HERDR_BIN_PATH', String(env.HERDR_BIN_PATH)) : null;
  return {
    herdrEnvPrefix: `HERDR_ENV=1${socketPath ? ` HERDR_SOCKET_PATH=${displayArg(socketPath)}` : ''} `,
    herdrBin: binaryPath && path.isAbsolute(binaryPath) ? displayArg(binaryPath) : 'herdr',
  };
}

export function renderBrief(template, slots) {
  const names = [...template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]);
  for (const name of names) if (!BRIEF_SLOTS.has(name)) throw new Error(`Unknown brief template slot: {{${name}}}.`);
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name) => {
    const value = slots[name];
    if (['kindHeaderNote', 'kindWaitNote', 'portInstruction', 'readOnlySection', 'stopRule', 'kindCommitRule'].includes(name) && (value === undefined || value === null || value === '')) return '';
    if (value === undefined || value === null || value === '') return '(none)';
    if (name === 'allowedPaths' && Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : '(none)';
    if (name === 'copyPaths' && Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : '(none)';
    return String(value);
  });
}

function parseHerdrJson(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch (error) { throw new Error(`Herdr returned invalid JSON: ${error.message}`); }
  if (data?.error) throw Object.assign(new Error(data.error.message || String(data.error)), { code: data.error.code });
  return data?.result ?? data;
}

// Wrap a Herdr runner so that an error from a command that carried a secret value never shows the value.
function maskingHerdr(herdr, secrets) {
  const mask = (text) => secrets.reduce((result, secret) => result.split(secret).join('[masked]'), String(text));
  return (args) => {
    try { return herdr(args); }
    catch (error) {
      if (error && typeof error === 'object') {
        for (const key of ['message', 'stderr', 'stdout']) if (error[key] != null) error[key] = mask(error[key]);
        delete error.cmd;
        delete error.spawnargs;
      }
      throw error;
    }
  };
}

export function createHerdrRunner(exec = (args, options) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })) {
  return (args, options = {}) => {
    const prompt = args[0] === 'agent' && args[1] === 'prompt';
    const stdout = exec(args, { ...(prompt ? { timeout: agentPromptTimeoutMs(), killSignal: 'SIGKILL' } : {}), ...options });
    if ((args[0] === 'pane' || args[0] === 'agent') && args[1] === 'read') return { text: stdout };
    return parseHerdrJson(stdout);
  };
}

// A worker in its own worktree uses .worker/. Workers that share a checkout (--no-worktree) each use .worker/<name>/.
const workerDirName = (name, shared) => (shared ? `.worker/${name}` : '.worker');
const briefPrompt = (dir) => `Read ${dir}/brief.md in your working directory and execute it.`;

// The recent-unwrapped source joins wrapped lines, so a dialog in a narrow pane reads as complete lines.
export function readAgentText(name, exec = execFileSync) {
  return exec('herdr', ['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '60'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function hasAgentReadyMarker(text, marker) {
  if (!marker) return true;
  const lines = String(text).split(/\r?\n/);
  if (!lines.some((line) => marker.footerLine.test(line))) return false;
  const promptIndex = lines.findIndex((line) => marker.inputLine.test(line));
  if (promptIndex < 0) return false;
  if (!marker.boxRule) return true;
  return marker.boxRule.test(lines[promptIndex - 1] ?? '')
    && marker.boxRule.test(lines[promptIndex + 1] ?? '');
}

// True when the pane text shows the input prompt of the harness. A harness without a marker always counts as ready.
export const agentReadyVisible = (kind, text) => hasAgentReadyMarker(text, AGENT_READY_MARKERS[kind]);

export function waitForAgentReady(name, kind, { herdr, readText = readAgentText, wait = pause } = {}, timeoutMs = READY_WAIT_MS) {
  const marker = AGENT_READY_MARKERS[kind];
  let elapsed = 0;
  for (;;) {
    let statusKnown = false;
    try {
      const result = herdr(['agent', 'get', name]);
      const agent = result?.agent ?? result;
      statusKnown = kind === 'opencode'
        ? ['idle', 'done'].includes(agent?.agent_status) && agent?.interactive_ready === true
        : KNOWN_AGENT_STATUSES.has(agent?.agent_status);
    } catch {}
    if (statusKnown) {
      if (!marker) return true;
      try {
        if (hasAgentReadyMarker(readText(name), marker)) return true;
      } catch {}
    }
    if (elapsed >= timeoutMs) return false;
    const delay = Math.min(READY_POLL_MS, timeoutMs - elapsed);
    wait(delay);
    elapsed += delay;
  }
}

function isAgentPromptStalled(error) {
  return error?.code === 'agent_prompt_stalled'
    || /agent_prompt_stalled/.test(String(error?.stderr ?? ''))
    || /agent_prompt_stalled/.test(String(error?.message ?? ''));
}

// An agent can report ready before its input box works. The prompt is then lost, or typed but not submitted.
// Resend once when the pane shows no trace of the marker text. When it shows the marker, send Enter once:
// Enter submits unsent input and does nothing in an empty input box.
export function deliverPrompt(name, text, marker, { herdr, readText = readAgentText, wait = pause, kind = null }) {
  const settled = () => {
    const status = herdr(['agent', 'get', name]);
    return ['working', 'blocked'].includes((status.agent ?? status).agent_status);
  };
  let resent = false;
  let firstError = null;
  for (;;) {
    let promptError;
    try {
      herdr(['agent', 'prompt', name, text, '--wait', '--timeout', '20000']);
      return firstError ? 'stalled-retry' : resent ? 'resent' : 'sent';
    } catch (error) { promptError = error; }
    if (isAgentPromptStalled(promptError)) {
      if (firstError) {
        try { if (settled()) return 'stalled-retry'; } catch {}
        throw new Error(`Brief prompt failed on both tries for ${name}. Try 1: ${firstError.message || firstError}. Try 2: ${promptError.message || promptError}.`);
      }
      firstError = promptError;
      waitForAgentReady(name, kind, { herdr, readText, wait }, STALLED_PROMPT_WAIT_MS);
      continue;
    }
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

function deliverBrief(name, kind, herdr, readText, wait, output, dir = '.worker') {
  const ready = waitForAgentReady(name, kind, { herdr, readText, wait });
  if (!ready && kind === 'opencode') throw new Error(`OpenCode TUI ${name} did not become idle and interactive in 45 s; the brief was not sent.`);
  if (!ready) output(`Notice: ${name} did not show a ready prompt in 45 s; sent the brief anyway.`);
  return deliverPrompt(name, briefPrompt(dir), `${dir}/brief.md`, { herdr, readText, wait, kind });
}

function inAbout(iso, now) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function describeLane(provider, lane, now = Date.now()) {
  const goals = goalSummary(lane?.goals);
  const reading = lane?.reading;
  const readingAge = Number.isFinite(reading?.ageMinutes) ? `${reading.ageMinutes} min old` : 'age unknown';
  const readingText = Number.isFinite(reading?.usedPercent) && (Number.isFinite(reading?.ageMinutes) || reading.stale)
    ? `; last reading ${reading.usedPercent}% ${String(reading.window || 'quota').toLowerCase()}, ${readingAge}${reading.stale ? ', stale' : ''}`
    : '';
  const planText = provider === 'codex' ? quotaPlanLaneText(lane?.planGuidance) : '';
  const planReplacesPace = planText && !lane?.ignored && lane?.state === 'open';
  const holdText = claudePaceHoldText(lane?.paceHold);
  const suffix = `${goals ? `; ${goals}` : ''}${readingText}${planText && !planReplacesPace ? `; plan guidance: ${planText}` : ''}${holdText && lane?.state !== 'open' ? `; pace guidance: ${holdText}` : ''}${lane?.factoryShareError ? `; ${lane.factoryShareError}` : ''}`;
  if (holdText && lane.state === 'open' && !lane.ignored) return `${provider} ${holdText}${suffix}`;
  if (planReplacesPace) return `${provider} ${planText}${suffix}`;
  if (lane?.state === 'open' && lane.onPace) {
    const { usedPercent, expectedPercent, tolerancePoints } = lane.onPace;
    return `${provider} on pace (${usedPercent}% used, expected ${expectedPercent}%, tolerance ${tolerancePoints} points)${suffix}`;
  }
  if (!lane || lane.state === 'open') return `${provider} open${suffix}`;
  if (lane.state === 'unknown') return `${provider} unknown (no quota data)${suffix}`;
  if (lane.state === 'exhausted') return `${provider} exhausted: ${lane.usedPercent}% used in the ${lane.window} window; exhausted until ${lane.resetAt || 'an unknown time'}${suffix}`;
  if (lane.state === 'trickle') {
    const name = { claude: 'Claude', codex: 'Codex', opencodego: 'OpenCode Go' }[provider] || provider;
    return `${name}: trickle (${lane.window} ${lane.usedPercent}% used, ahead of pace): about ${lane.allowancePercent.toFixed(1)}%/day, ${(lane.usedTodayPercent || 0).toFixed(1)}% used today${suffix}`;
  }
  const numbers = `${lane.usedPercent}% used${lane.expectedPercent != null ? ` against ${lane.expectedPercent}% expected` : ''} in the ${lane.window} window`;
  if (lane.state === 'reserve') return `${provider} near exhaustion: ${numbers}; resets in ${inAbout(lane.backOnPaceAt, now)}${suffix}`;
  const tolerance = lane.expectedPercent != null && Number.isFinite(lane.tolerancePoints) ? `; tolerance ${lane.tolerancePoints} points` : '';
  return `${provider} ahead of pace: ${numbers}; back on pace in about ${inAbout(lane.backOnPaceAt, now)} if unused${tolerance}${suffix}`;
}

export function describeUnmetered(lane, project = null) {
  const summary = unmeteredSummary(lane, project);
  const closed = unmeteredClosedParts(lane, project);
  const head = lane?.state === 'closed' ? 'unmetered closed: no unmetered model can start'
    : project && !Object.hasOwn(lane?.byProject || {}, project) ? 'unmetered open; no unmetered models are available after exclusions'
      : summary ? `unmetered open: ${summary}` : 'unmetered open; no unmetered models are available after exclusions';
  return [head, ...closed].join('\n');
}

// A Pi model that the last good `pi --list-models` result does not list cannot run, so --force does not bypass it.
export function unmeteredGate(kind, model, rules) {
  if (kind === 'pi' && Array.isArray(rules?.piModels?.models) && !rules.piModels.models.includes(model)) {
    const [missing] = unavailablePiModels([model], rules.piModels);
    const reason = missing.reason === 'no-credential'
      ? `Pi has no credential for the ${missing.provider} provider.`
      : 'Pi does not list this model.';
    return { error: `pi cannot run ${model}: the last pi --list-models result does not list it. ${reason} --force cannot bypass this refusal.` };
  }
  return {};
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
export function providerGate(provider, rules, { force = false, now = Date.now(), project = null, allowedModels = null, factoryShare } = {}) {
  if (!provider) return {};
  const lane = rules.lanes?.[provider];
  if (factoryShare !== undefined && (factoryShare === 0 || Math.max(lane?.factoryShareUsedPercent ?? 0, lane?.usedPercent ?? 0, lane?.reading?.usedPercent ?? 0) >= factoryShare)) {
    return { error: `${provider} has reached its factory share ceiling (${factoryShare}%). Change the share at the head office before starting new workers.` };
  }
  if (lane?.factoryShareBlocked) return { error: `${provider} has reached its factory share ceiling (${lane.factoryShare}%). Change the share at the head office before starting new workers.` };
  if (lane?.state === 'trickle') {
    const usedToday = lane.usedTodayPercent || 0;
    if (usedToday < lane.allowancePercent) return {};
    if (force) return { warning: `Warning: --force overrides the quota guard: ${describeLane(provider, lane, now)}.` };
    return { error: `${provider} trickle used for today: ${usedToday.toFixed(1)}% of about ${lane.allowancePercent.toFixed(1)}%/day; the next allowance starts at 00:00 UTC.` };
  }
  if (!rules.avoidProviders?.includes(provider)) return {};
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

// One bulletin line for the project: effective slots with the borrowed, lent, or free count, global use, and the machine load.
export function allocationSummary(rules, slug) {
  const control = rules?.control;
  const p = control?.projects?.[slug];
  if (!p) return null;
  const loan = p.borrowed ? ` (+${p.borrowed} borrowed)` : p.lent ? ` (${p.lent} lent)` : p.offered ? ` (${p.offered} free for others)` : '';
  const load = Number.isFinite(rules.machine?.fiveMinute) ? rules.machine.fiveMinute : 'unknown';
  return `Allocation for ${slug}: ${p.running}/${p.slots} effective slots${loan}; ${control.runningWorkers ?? 'unknown'}/${control.maxWorkers ?? 'unknown'} working agents globally; 5-minute load ${load}.`;
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

const OPUS_MODEL = 'claude-opus-5-5';

// Fold case, drop a bracketed suffix such as [1m], and map each Opus spelling to the catalog model.
// The allow-list and the approval check then see one name.
export function normalizeModel(model) {
  if (typeof model !== 'string') return model;
  const name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  return /^(claude-)?opus(-5-5)?$/.test(name) ? OPUS_MODEL : model.trim();
}

export const isOpus = (model) => /(^|[-/])opus($|[-.\d])/i.test(model);

const retryText = (record) => untilText(record.retryAt);

function activeUnavailableModel(unavailableModels, kind, model, now) {
  const records = Array.isArray(unavailableModels) ? unavailableModels : Object.values(unavailableModels || {});
  return records.find((item) => item?.kind === kind && item?.model === model
    && Number.isSafeInteger(item.retryAt) && item.retryAt > now);
}

function validateSelection(kind, options, models, config, resourcePolicy = null, onOpusRefused = null, unavailableModels = {}, now = Date.now(), runningOpus = 0) {
  const policy = models.kinds[kind];
  if (!policy) throw new Error(`Unknown agent kind: ${kind}. Choose one of ${Object.keys(models.kinds).join(', ')}.`);
  const startable = (candidate) => policy.allowedModels.includes(candidate) && modelEnabled(kind, candidate, resourcePolicy) &&
    (config.allowedModels === null || config.allowedModels.includes(candidate));
  const explicit = normalizeModel(options.model);
  const heldBack = explicit == null ? null : activeUnavailableModel(unavailableModels, kind, explicit, now);
  if (heldBack?.untilReenabled) throw new Error(`Model ${explicit} of ${kind} is unavailable until the Owner re-enables it (${heldBack.reason || heldBack.label || 'launch blocked'}). Run herdr-boss models enable ${kind}/${explicit} to re-enable it.`);
  let model = explicit;
  let modelSource = 'flag';
  let modelFallback;
  if (explicit == null) {
    // Without --model the kit default applies. The preferred model of the policy is a fallback for a default that cannot start.
    const kitDefault = normalizeModel(policy.defaultModel);
    if (!kitDefault) throw new Error(`${kind} has no default model in kit/models.json. Pass --model.`);
    model = kitDefault;
    modelSource = 'default';
    const unavailable = activeUnavailableModel(unavailableModels, kind, kitDefault, now);
    if (unavailable) {
      const lane = providerFor(kind, kitDefault, resourcePolicy);
      const defaultIndex = policy.allowedModels.indexOf(kitDefault);
      const projectPolicy = resourcePolicy?.projects?.[config.slug];
      const ordered = defaultIndex < 0 ? policy.allowedModels : [
        ...policy.allowedModels.slice(defaultIndex + 1), ...policy.allowedModels.slice(0, defaultIndex),
      ];
      const candidate = ordered.find((item) => item !== kitDefault && startable(item)
        && providerFor(kind, item, resourcePolicy) === lane
        && !projectPolicy?.excludedKinds?.includes(kind) && !projectPolicy?.excludedModels?.includes(item)
        && !activeUnavailableModel(unavailableModels, kind, item, now)
        && (!isOpus(item) || options.force));
      if (!candidate) throw new Error(`The default model ${kitDefault} of ${kind} is unavailable until ${retryText(unavailable)} and no available model in the same lane can start.`);
      model = candidate;
      modelSource = 'fallback';
      modelFallback = { from: kitDefault, retryAt: unavailable.retryAt, reason: unavailable.reason || unavailable.label || 'provider cooldown' };
    } else if (!startable(kitDefault)) {
      const preferred = normalizeModel(resourcePolicy?.preferredModels?.[kind]);
      if (!preferred || !startable(preferred)) throw new Error(`The default model ${kitDefault} of ${kind} cannot start and no preferred model can. Pass --model.`);
      model = preferred;
      modelSource = 'policy';
    }
  }
  if (!policy.allowedModels.includes(model)) throw new Error(`Model ${model} is not allowed for ${kind}.`);
  // The Owner can allow Opus without --force. The allowance has a limit on running Opus workers; --force skips it.
  let opusAllowed = false;
  if (isOpus(model) && !options.force) {
    const opus = resourcePolicy?.opus;
    if (opus?.allowWithoutForce !== true) {
      onOpusRefused?.(model);
      throw new Error(`${model} needs the Owner's approval. Ask the Owner, then start with --force. The Owner can allow Opus starts without --force with the setting opus.allowWithoutForce.`);
    }
    const limit = Number.isInteger(opus.maxConcurrent) ? opus.maxConcurrent : 2;
    if ((runningOpus ?? 0) >= limit) {
      onOpusRefused?.(model);
      throw new Error(`${model} is at the limit of ${limit} running Opus workers (setting opus.maxConcurrent). Wait for an Opus worker to finish, or start with --force.`);
    }
    opusAllowed = true;
  }
  if (config.allowedModels !== null && !config.allowedModels.includes(model)) throw new Error(`Project ${config.slug} does not allow model ${model}.`);
  const effort = options.effort ?? policy.defaultEffort;
  if (effort !== null && !policy.allowedEfforts.includes(effort)) throw new Error(`Effort ${effort} is not allowed for ${kind}.`);
  if (effort === null && options.effort != null) throw new Error(`${kind} does not support a reasoning effort.`);
  const effortSource = options.effort != null ? 'flag' : effort !== null ? 'default' : null;
  const launchArgs = policy.launchArgs.map((arg) => arg.replaceAll('{{model}}', model).replaceAll('{{effort}}', effort ?? ''));
  return { model, modelSource, modelFallback, effort, effortSource, launchArgs, force: isOpus(model) && (!!options.force || opusAllowed), opusAllowed };
}

function appendWorkerEvent(env, event, now) {
  const dir = env.HERDR_BOSS_DIR || DATA_DIR;
  const line = { at: new Date(now).toISOString(), ...event };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch { /* The event log does not control whether a worker can start. */ }
}

function taskIdForEvent(options) {
  if (options.taskId != null) return String(options.taskId);
  if (options.issue != null) return String(options.issue);
  return null;
}

export function alertBossForOpus(name, model, options, config, env, herdr, now, output) {
  const text = `Opus worker: ${name} runs ${model} (${options.allowedByPolicy ? 'allowed by opus.allowWithoutForce' : 'forced'}).`;
  const taskId = taskIdForEvent(options);
  appendWorkerEvent(env, { type: 'worker-opus', text, worker: name, taskId, project: config.slug }, now);
  output(text);
  let boss = null;
  try { boss = listFrom(herdr(['pane', 'list']), 'panes').find((pane) => pane.label === 'boss' && getPane(pane)) ?? null; }
  catch { /* A missing pane is reported below. */ }
  if (!boss) {
    output('Warning: no Boss pane was found; the Opus start alert was not sent.');
    return;
  }
  try { herdr(['agent', 'prompt', getPane(boss), text]); }
  catch { output('Warning: the Opus start alert could not reach the Boss pane.'); }
}

function recordOpusRefusal(name, model, options, config, env, now) {
  const taskId = taskIdForEvent(options);
  appendWorkerEvent(env, {
    type: 'worker-opus-refused',
    text: `Opus worker start refused for ${name}; --force was not set.`,
    worker: name,
    model,
    taskId,
    project: config.slug,
  }, now);
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
  const lines = current.split(/\r?\n/);
  const missing = ['/.worker/', '/.orchestration/local/', `/${OPEN_CODE_CONFIG_NAME}`].filter((entry) => !lines.includes(entry));
  if (missing.length) fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
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

const WORKERS_TAB = 'Workers';

// A Codex worker pane needs HERDR_ENV, or the agent in it cannot run Herdr commands. Other kinds keep the pane environment they had.
// TMPDIR and HERDR_WORKTREE are absolute, so a worker that changes folder still reaches its own .worker files.
// Each leased item becomes one more variable, for example HERDR_SERVE_PORT=8001.
function workerPaneEnv(kind, worktree, tmpDir, leaseEnv = []) {
  return [
    ...(kind === 'codex' ? ['--env', 'HERDR_ENV=1'] : []),
    '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus',
    '--env', `TMPDIR=${tmpDir}`, '--env', `HERDR_WORKTREE=${path.resolve(worktree)}`,
    ...leaseEnv.flatMap((lease) => ['--env', `${lease.env}=${lease.item}`]),
  ];
}

function paneOrder(pane, index) {
  const match = /(\d+)$/.exec(getPane(pane) ?? '');
  return match ? Number(match[1]) : index;
}

export const WORKER_PANES_PER_TAB = 3;

// Workers is tab 1; Workers 2, Workers 3, and so on follow. Other labels are not worker tabs.
function workersTabNumber(label) {
  if (label === WORKERS_TAB) return 1;
  const match = /^Workers ([2-9]|[1-9]\d+)$/.exec(String(label ?? ''));
  return match ? Number(match[1]) : null;
}

function workersTabLabel(number) {
  return number === 1 ? WORKERS_TAB : `${WORKERS_TAB} ${number}`;
}

// Worker tabs hold at most `cap` live panes. Use the first tab in label order with a free slot, else the lowest free label.
// A listed tab with no live panes counts as free. Herdr has no pane to split there, so worker start creates a new tab with that label.
function findWorkersTab(workspaceId, herdr, cap = WORKER_PANES_PER_TAB) {
  const tabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
  const workerTabs = tabs
    .map((tab, index) => ({ tab, index, number: workersTabNumber(tab.label) }))
    .filter((item) => item.number !== null && getWorkspace(item.tab) === workspaceId);
  const allPanes = workerTabs.length ? listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes') : [];
  const candidates = workerTabs.map((item) => ({ ...item, panes: allPanes.filter((pane) => getTab(pane) === getTab(item.tab) && getPane(pane)) }))
    // With two tabs of one label, prefer the tab with live panes.
    .sort((a, b) => a.number - b.number || Math.min(b.panes.length, 1) - Math.min(a.panes.length, 1) || a.index - b.index);
  const chosen = candidates.find((item) => item.panes.length < cap);
  if (chosen && chosen.panes.length) {
    const source = chosen.panes
      .map((pane, index) => ({ pane, order: paneOrder(pane, index), index }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .at(-1).pane;
    return { tabs, tab: chosen.tab, label: workersTabLabel(chosen.number), panes: chosen.panes, source, cap };
  }
  let number = chosen?.number;
  if (number === undefined) {
    const used = new Set(candidates.map((item) => item.number));
    number = 1;
    while (used.has(number)) number++;
  }
  return { tabs, tab: null, label: workersTabLabel(number), panes: [], source: null, cap };
}

function workerPanePlan(workspaceId, worktree, kind, herdr, tmpDir, cap, leaseEnv = []) {
  const found = findWorkersTab(workspaceId, herdr, cap);
  if (!found.tab) {
    return { ...found, command: ['tab', 'create', '--workspace', workspaceId, '--label', found.label, '--cwd', worktree, ...workerPaneEnv(kind, worktree, tmpDir, leaseEnv)] };
  }
  let dimensions = findDimensions(found.source);
  if (!dimensions) {
    try { dimensions = findDimensions(herdr(['pane', 'layout', '--pane', getPane(found.source)])); } catch {}
  }
  const direction = dimensions && dimensions.height > dimensions.width ? 'down' : 'right';
  return { ...found, command: ['pane', 'split', getPane(found.source), '--direction', direction, '--cwd', worktree, ...workerPaneEnv(kind, worktree, tmpDir, leaseEnv)] };
}

function chooseWorkerPane(workspaceId, worktree, kind, herdr, tmpDir, cap, leaseEnv = []) {
  const plan = workerPanePlan(workspaceId, worktree, kind, herdr, tmpDir, cap, leaseEnv);
  const { command } = plan;
  if (!plan.tab) {
    const created = herdr(command);
    const tabId = getTab(created) ?? created.tab?.tab_id ?? created.id;
    const freshTabs = listFrom(herdr(['tab', 'list', '--workspace', workspaceId]), 'tabs');
    const foundTab = freshTabs.find((tab) => getWorkspace(tab) === workspaceId
      && (tab.tab_id === tabId || (tab.label === plan.label && !plan.tabs.some((old) => getTab(old) === getTab(tab)))));
    if (!foundTab) throw new Error(`Herdr created tab ${plan.label} but did not return a tab id that can be found.`);
    const panes = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes');
    const rootPane = panes.find((pane) => getTab(pane) === getTab(foundTab));
    if (!rootPane || !getPane(rootPane)) {
      try { herdr(['tab', 'close', getTab(foundTab)]); } catch {}
      throw new Error(`The new ${plan.label} tab has no root pane.`);
    }
    return { paneId: getPane(rootPane), tabId: getTab(foundTab), command, createdTab: true, createdPane: true };
  }
  const result = herdr(command);
  let paneId = result?.pane_id ?? result?.paneId ?? result?.pane?.pane_id ?? result?.new_pane_id ?? null;
  if (!paneId) {
    const refreshed = listFrom(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => getTab(pane) === getTab(plan.tab));
    const added = refreshed.filter((pane) => !plan.panes.some((old) => getPane(old) === getPane(pane)));
    if (added.length !== 1) throw new Error(`Herdr split the ${plan.label} tab but did not return the new pane id.`);
    paneId = getPane(added[0]);
  }
  return { paneId, tabId: getTab(plan.tab), command, createdTab: false, createdPane: true };
}

export function waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait = pause, { retryCommand = 'worker start', timeoutMs = 20_000, launchBlock = null } = {}) {
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
          const screenResponse = herdr(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text']);
          const screen = typeof screenResponse === 'string'
            ? screenResponse
            : screenResponse?.text ?? screenResponse?.output ?? '';
          const lines = String(screen).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trimEnd());
          // Only an OpenCode launch passes `launchBlock`. Its baseline hides text that was on the pane before the launch.
          const block = launchBlock ? detectLaunchBlock(newPaneLines(lines.join('\n'), launchBlock.baseline).join('\n')) : null;
          if (block) {
            const error = new Error(`Worker pane ${paneId} shows "${block.phrase}" at launch.`);
            error.code = 'model_launch_blocked';
            error.launchBlock = block;
            throw error;
          }
          // A launch phrase from an earlier launch stays on the screen. It is not a question for the Owner.
          const question = interactiveShellQuestion(launchBlock ? lines.filter((line) => !detectLaunchBlock(line)) : lines);
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
      if (error?.code === 'worker_pane_interactive_question' || error?.code === 'model_launch_blocked') throw error;
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
    `3. Validate kind/model/effort: ${plan.kind} / ${plan.model} / ${plan.effort ?? '(none)'} (model source: ${plan.modelSource}${plan.effortSource ? `, effort source: ${plan.effortSource}` : ''}${plan.force ? ', --force: Opus approved by the Owner' : ''})`,
    ...(plan.modelFallback ? [`   Fallback: ${plan.modelFallback.from} unavailable until ${retryText(plan.modelFallback)} (${plan.modelFallback.reason})`] : []),
    `4. Create worktree: ${plan.noWorktree ? '(disabled; use current worktree)' : plan.worktree}`,
    ...(plan.noWorktree ? [] : [`   $ git worktree add -b ${displayArg(plan.branch)} ${displayArg(plan.worktree)} ${displayArg(plan.base)}`]),
    `   Append /.worker/ and /.orchestration/local/ to ${plan.excludeFile}`,
    `5. Render brief: ${plan.worktree}/${plan.workerDir}/brief.md from ${plan.template}`,
    ...plan.leasePools.map((pool) => `   Lease one item of pool ${pool} and pass it in the pane environment`),
    ...(plan.setup ? [`   Run project setup in the worktree (timeout ${plan.setupTimeoutSeconds} s):`, `   $ ${plan.setup}`] : []),
    `6. Place worker in ${plan.paneTab} of workspace ${plan.workspaceId}:`,
    `   $ herdr ${plan.paneCommand.map(displayArg).join(' ')}`,
    `   ${plan.paneCommand[0] === 'pane' ? 'New pane' : 'Root pane'}: ${plan.paneId}`,
    `7. Start agent:`,
    `   $ herdr agent start ${displayArg(plan.name)} --kind ${displayArg(plan.kind)} --pane ${displayArg(plan.paneId)} --timeout ${plan.agentStartTimeoutMs} -- ${plan.agentArgs.map(displayArg).join(' ')}`,
    `8. Write run record: ${plan.recordFile}`,
    `9. Send task prompt and observe agent activity:`,
    `   $ herdr agent prompt ${displayArg(plan.name)} "${briefPrompt(plan.workerDir)}"`,
    ...(plan.planner ? [`10. Start a planner session for the worker pane and label the pane ${PLANNER_LABEL}:`, `   $ herdr pane rename ${displayArg(plan.paneId)} ${PLANNER_LABEL}`] : []),
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

// The lease pools come from the Herdr Boss config.json. A test passes its own pools and data directory.
function resolveLeaseContext(leaseOptions) {
  if (leaseOptions?.pools) return { dataDir: DATA_DIR, probeTcp: undefined, ...leaseOptions };
  const cfg = loadConfig();
  if (cfg.resourcePoolErrors.length) throw new Error(`The resourcePools setting in the Herdr Boss config.json is invalid:\n- ${cfg.resourcePoolErrors.join('\n- ')}`);
  return { dataDir: DATA_DIR, probeTcp: undefined, ...leaseOptions, pools: cfg.resourcePools };
}

function releaseStartLeases(leases, name, config, leaseContext) {
  if (!leases.length) return;
  const taken = new Set(leases.map((lease) => `${lease.pool}\n${lease.item}`));
  try {
    dropLeases((lease) => lease.project === config.slug && lease.worker === name && taken.has(`${lease.pool}\n${lease.item}`), { dataDir: leaseContext.dataDir });
  } catch {}
}

// Codex runs in the seatbelt sandbox, which refuses the Chromium Mach port (MachPortRendezvousServer, error 1100).
// Herdr-managed project browser commands run outside the sandbox. Warn for other browser tools and launches.
const BROWSER_WORDS = /\b(playwright|chromium|chrome|browser|screenshots?|galler(y|ies)|perf replays?|puppeteer|cdp)\b/i;
export function codexBrowserWarning(kind, task) {
  if (kind !== 'codex') return null;
  const text = String(task || '');
  const withoutProjectCommands = text
    .replace(/`[^`\n]*`/g, (code) => /^`\s*(?:\$\s*)?herdr-boss\s+browser\b/i.test(code) ? ' '.repeat(code.length) : code)
    .replace(/^\s*(?:[-*]\s+)?(?:\$\s*)?herdr-boss\s+browser\b[^\n]*$/gim, (line) => ' '.repeat(line.length))
    .replace(/\bthe\s+project\s+browser\b/gi, (phrase) => ' '.repeat(phrase.length));
  if (!BROWSER_WORDS.test(withoutProjectCommands)) return null;
  return 'Warning: this brief mentions browser work. Codex cannot launch Chromium in its sandbox. Use --kind claude, opencode, or pi for tasks that launch a browser.';
}

// A Codex tool shell can run under a shared app-server daemon with another environment, so a codex worker gets
// its pane variables as -c shell_environment_policy.set.* launch arguments. Other kinds get no extra arguments.
function workerAgentArgs(kind, launchArgs, { paneId, tabId, workspaceId, env, tmpDir, worktree }) {
  if (kind !== 'codex') return launchArgs;
  return [...launchArgs, ...codexShellEnvArgs({
    HERDR_ENV: '1', HERDR_PANE_ID: paneId, HERDR_TAB_ID: tabId, HERDR_WORKSPACE_ID: workspaceId,
    HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH, HERDR_BIN_PATH: env.HERDR_BIN_PATH, TMPDIR: tmpDir, HERDR_WORKTREE: path.resolve(worktree),
  })];
}

function checkedCopyFile(root, source, label, destinationRelative = null) {
  const resolvedRoot = path.resolve(root);
  const resolvedSource = path.resolve(source);
  const relative = path.relative(resolvedRoot, resolvedSource);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Copy path ${label} must be inside the repository.`);
  }
  let stats;
  try { stats = fs.lstatSync(resolvedSource); } catch { throw new Error(`Copy path ${label} does not exist.`); }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Copy path ${label} must be a regular file.`);
  const realRoot = fs.realpathSync(resolvedRoot);
  const realSource = fs.realpathSync(resolvedSource);
  const realRelative = path.relative(realRoot, realSource);
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Copy path ${label} must be inside the repository.`);
  }
  return {
    source: resolvedSource,
    relative: (destinationRelative ?? realRelative).split(path.sep).join('/'),
    size: stats.size,
  };
}

function workerInputFiles(root, name) {
  const inputRoot = path.join(root, '.orchestration', 'state', 'inputs', name);
  let rootStats;
  try { rootStats = fs.lstatSync(inputRoot); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`Worker input path ${inputRoot} must be a directory.`);
  const files = [];
  const visit = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Worker input ${relative} must not be a symbolic link.`);
      if (entry.isDirectory()) visit(source, relative);
      else if (entry.isFile()) files.push(checkedCopyFile(root, source, relative, relative));
      else throw new Error(`Worker input ${relative} must be a regular file.`);
    }
  };
  visit(inputRoot);
  return files;
}

function mainCheckout(root) {
  const worktrees = git(root, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  return worktrees.find((candidate) => {
    try { return fs.statSync(path.join(candidate, '.git')).isDirectory(); } catch { return false; }
  }) ?? worktrees[0] ?? root;
}

function lstatMaybe(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Copy the local orchestration inputs to a new worker checkout. Do not follow links or replace files.
function copyLocalOrchestration(mainRoot, worktree) {
  const sourceParent = path.join(mainRoot, '.orchestration');
  const sourceParentStat = lstatMaybe(sourceParent);
  if (!sourceParentStat || !sourceParentStat.isDirectory() || sourceParentStat.isSymbolicLink()) return null;
  const sourceRoot = path.join(sourceParent, 'local');
  const sourceRootStat = lstatMaybe(sourceRoot);
  if (!sourceRootStat || !sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) return null;

  const destinationParent = path.join(worktree, '.orchestration');
  const destinationParentStat = lstatMaybe(destinationParent);
  if (destinationParentStat && (!destinationParentStat.isDirectory() || destinationParentStat.isSymbolicLink())) {
    throw new Error('Could not copy local orchestration files into the worker worktree.');
  }
  if (!destinationParentStat) fs.mkdirSync(destinationParent, { mode: 0o700 });
  const destinationRoot = path.join(destinationParent, 'local');
  let copied = 0;
  let oversized = 0;
  let unreadable = 0;

  const visit = (source, destination, sourceStat) => {
    const destinationStat = lstatMaybe(destination);
    let created = false;
    if (destinationStat) {
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error('Could not copy local orchestration files into the worker worktree.');
      }
    } else {
      fs.mkdirSync(destination, { mode: (sourceStat.mode & 0o777) | 0o700 });
      created = true;
    }
    const entries = fs.readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === '.worker' || entry.name === '.git') continue;
      const sourceFile = path.join(source, entry.name);
      const destinationFile = path.join(destination, entry.name);
      const stat = lstatMaybe(sourceFile);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(sourceFile, destinationFile, stat);
      } else if (stat.isFile()) {
        if (stat.size > MAX_LOCAL_FILE_BYTES) {
          oversized += 1;
          continue;
        }
        if (lstatMaybe(destinationFile)) continue;
        try {
          fs.copyFileSync(sourceFile, destinationFile, fs.constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          if (error.code === 'EACCES' || error.code === 'EPERM') {
            let sourceUnreadable = false;
            try { fs.accessSync(sourceFile, fs.constants.R_OK); }
            catch (accessError) { sourceUnreadable = accessError.code === 'EACCES' || accessError.code === 'EPERM'; }
            if (!sourceUnreadable) throw new Error('Could not copy local orchestration files into the worker worktree.');
            try { fs.unlinkSync(destinationFile); }
            catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw new Error('Could not copy local orchestration files into the worker worktree.'); }
            unreadable += 1;
            continue;
          }
          throw new Error('Could not copy local orchestration files into the worker worktree.');
        }
        fs.chmodSync(destinationFile, stat.mode & 0o777);
        copied += 1;
      }
    }
    if (created) fs.chmodSync(destination, sourceStat.mode & 0o777);
  };

  try { visit(sourceRoot, destinationRoot, sourceRootStat); }
  catch (error) {
    if (/Could not copy local orchestration/.test(error.message)) throw error;
    throw new Error('Could not copy local orchestration files into the worker worktree.');
  }
  return { copied, oversized, unreadable };
}

// A model that shows a launch block is marked unavailable. A start without --model then picks the next model of the lane.
export function startWorker(name, options, deps = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return startWorkerOnce(name, options, deps); }
    catch (error) {
      if (error?.code !== 'model_launch_blocked') throw error;
      if (!error.blockedModel) throw new Error(`A launch block was reported without a model: ${error.message} Herdr Boss did not mark a model and did not retry.`);
      if (options.model != null || attempt >= 4) throw error;
      (deps.output ?? console.log)(`Model ${error.blockedModel} cannot start (${error.launchBlock.phrase}). Trying the next model of the same lane.`);
    }
  }
}

function startWorkerOnce(name, options, {
  config,
  models,
  herdr = createHerdrRunner(),
  env = process.env,
  rulesFile,
  now = Date.now(),
  output = console.log,
  readText = null,
  projectStatus = null,
  wait = pause,
  runSetup = runSetupCommand,
  leaseOptions = null,
  browserLookup,
  refreshKit = refreshKitIfRequired,
  tuiSupportsModelFlags = opencodeTuiAcceptsModelFlags,
} = {}) {
  if (!NAME_PATTERN.test(name)) throw new Error('Worker name must match [a-z][a-z0-9-]{0,31}.');
  if (env.HERDR_ENV !== '1') throw new Error('Run worker start from a Herdr-managed pane (HERDR_ENV=1).');
  const caller = verifyCallerPane(env, herdr, options.orch);
  if (config?.slug) assertProjectTransferAllowsWorker(config.slug, { dataDir: env.HERDR_BOSS_DIR || DATA_DIR });
  const herdrCommands = workerBriefHerdrCommands(env);
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
  // A dry run writes no file, so it only reports the gap.
  const kitRefresh = config?.root && !options.dryRun ? safeRefreshKit(config.root, { refresh: refreshKit }) : null;
  if (kitRefresh?.line) output(kitRefresh.line);
  // A refreshed kit is current. In every other case the gap line stays.
  const kitLine = kitRefresh?.status === 'refreshed' || !config?.root ? null : kitBehindLine(config.root);
  if (kitLine) output(kitLine);
  const overload = loadWarning(rules);
  if (overload) throw new Error(overload);
  const swapText = options.forceSwap || swapExempt(env, herdr) ? null : swapRefusal(rules, { now, override: 'Pass --force-swap to override. --force cannot bypass this refusal.' });
  if (swapText) throw new Error(swapText);
  if (!options.kind) throw new Error('--kind is required.');
  if (rules.avoidKinds !== undefined && !Array.isArray(rules.avoidKinds)) throw new Error(`Herdr Boss rules avoidKinds must be an array: ${rulesPath}`);
  if ((rules.avoidKinds ?? []).includes(options.kind)) {
    if (!options.force) throw new Error(`Herdr Boss rules avoid ${options.kind}; pass --force to override.`);
    output(`Warning: --force overrides Herdr Boss rules for ${options.kind}.`);
  }
  const policy = rules.policy;
  // Local extra models from the policy join the harness allow-list and use its launch arguments.
  const onOpusRefused = options.kind === 'claude' && !options.dryRun
    ? (model) => recordOpusRefusal(name, model, options, config, env, now)
    : null;
  const bossDir = env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss');
  const knownUnavailable = [...Object.values(rules.unavailableModels || {}), ...activeLaunchRecords(bossDir, now)];
  const { model, modelSource, modelFallback, effort, effortSource, launchArgs: modelLaunchArgs, force: opusForce, opusAllowed } = validateSelection(options.kind, options, mergeModels(modelConfig, policy), config, policy, onOpusRefused, knownUnavailable, now, rules.control?.runningOpus ?? 0);
  // A v2 OpenCode TUI rejects --model and --agent. Select the model and the worker agent in a project config file instead.
  const openCodeConfig = options.kind === 'opencode' && tuiSupportsModelFlags({ env }) === false;
  const launchArgs = openCodeConfig ? [] : modelLaunchArgs;
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
  const laneName = provider || 'unmetered';
  const nightLaneCap = rules.night?.maxWorkersByLane?.[laneName];
  if (rules.night?.active === true && Number.isInteger(nightLaneCap) &&
      (rules.control?.runningByLane?.[laneName] || 0) >= nightLaneCap && !options.force) {
    throw new Error(`Watch worker lane limit (${nightLaneCap}) for ${laneName} is reached; wait for a slot to open.`);
  }
  const freeGate = unmeteredGate(options.kind, model, rules);
  if (freeGate.error) throw new Error(freeGate.error);
  let factoryShare;
  if (provider) {
    try { factoryShare = readFactoryShares(bossDir)[provider]; }
    catch { throw new Error(`Factory share check failed. ${FACTORY_SHARE_ERROR}`); }
  }
  const gate = providerGate(provider, rules, { force: options.force, now, project: config.slug, allowedModels: config.allowedModels, factoryShare });
  if (gate.error) throw new Error(gate.error);
  if (gate.warning) output(gate.warning);
  if (rules.control?.runningWorkers >= rules.control?.maxWorkers && !options.force) throw new Error(`Global worker limit (${rules.control.maxWorkers}) is reached; wait or use --force.`);
  const projectSlots = rules.control?.projects?.[config.slug];
  if (projectSlots?.effectiveMode === 'paused' && !options.force) throw new Error(`Project ${config.slug} is paused. Use --force only for an authorized override.`);
  const summary = allocationSummary(rules, config.slug);
  if (summary) output(summary);
  if (projectSlots && projectSlots.running >= projectSlots.slots && !options.force) output(`Notice: ${config.slug} uses ${projectSlots.running}/${projectSlots.slots} effective slots. This share is advisory; global limit still applies.`);
  const requestedPaths = options.allow ?? [];
  if (options.readOnly && requestedPaths.length) throw new Error('--read-only cannot be used with --allow.');
  const workerDir = workerDirName(name, !!options.noWorktree);
  const allowedErrors = validateAllowedPaths(requestedPaths);
  if (allowedErrors.length) throw new Error(allowedErrors.join('\n'));
  if (!options.readOnly && !requestedPaths.length) throw new Error('Give at least one --allow path or use --read-only.');
  const allowedPaths = [...requestedPaths, `${workerDir}/**`];
  if (!!options.task === !!options.taskFile) throw new Error('Provide exactly one of --task or --task-file.');
  if (options.issue != null && (!/^\d+$/.test(String(options.issue)) || Number(options.issue) <= 0)) throw new Error('--issue must be a positive integer.');
  if (options.taskId != null && !TASK_ID.test(String(options.taskId))) throw new Error('--task-id must be a task id from the published status: letters, digits, ".", "_" or "-", up to 64 characters.');
  if (options.taskId != null && options.issue != null) throw new Error('Give --task-id or --issue, not both. --issue N is an alias for a numeric task id.');
  const task = options.taskFile ? fs.readFileSync(path.resolve(options.taskFile), 'utf8').trimEnd() : options.task;
  const taskIdNote = taskIdWarning(options);
  if (taskIdNote) {
    output(taskIdNote);
    const suggestion = suggestedTask(options, projectStatus);
    if (suggestion) output(`Suggested: --task-id ${suggestion.id} (${suggestion.title})`);
  }
  const browserWarning = codexBrowserWarning(options.kind, task);
  if (browserWarning) output(browserWarning);
  if (!task?.trim()) throw new Error('Task text must not be empty.');
  const copyFiles = [
    ...(options.copy ?? []).map((input) => checkedCopyFile(config.root, path.resolve(config.root, input), input)),
    ...workerInputFiles(config.root, name),
  ];
  const destinations = copyFiles.map(({ relative }) => relative);
  if (new Set(destinations).size !== destinations.length) throw new Error('Copy paths have a destination collision.');
  if (copyFiles.reduce((total, file) => total + file.size, 0) > MAX_COPIED_INPUT_BYTES) {
    throw new Error('Copied inputs exceed the 200 MB total limit.');
  }
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
  const leasePools = [...(options.lease ?? [])];
  const autoServeLease = !leasePools.includes('serve-ports') && task.includes('serve:live');
  let autoLeasedServePort = false;
  let leaseContext = null;
  if (leasePools.length || autoServeLease) leaseContext = resolveLeaseContext(leaseOptions);
  if (autoServeLease && leaseContext.pools.some((pool) => pool.name === 'serve-ports')) {
    leasePools.push('serve-ports');
    autoLeasedServePort = true;
  }
  for (const [index, pool] of leasePools.entries()) {
    if (leasePools.indexOf(pool) !== index) throw new Error(`--lease ${pool} may be used only once.`);
  }
  if (leaseContext) {
    const unknown = leasePools.find((pool) => !leaseContext.pools.some((candidate) => candidate.name === pool));
    if (unknown) throw new Error(`Unknown resource pool ${unknown}. Pools: ${leaseContext.pools.map((candidate) => candidate.name).join(', ') || '(none)'}.`);
  }

  const workspaceId = caller.workspaceId;
  const tmpDir = path.join(path.resolve(worktree), workerDir, 'tmp');
  if (tmpDir.length > 90) output('Warning: TMPDIR is longer than 90 characters; a Unix socket path can fail.');
  let paneId = null;
  const paneCap = config.workerPanesPerTab ?? WORKER_PANES_PER_TAB;
  let paneCommand;
  let paneTab;
  let planTabId = '<tab-id>';
  if (options.dryRun) {
    const panePlan = workerPanePlan(workspaceId, worktree, options.kind, herdr, tmpDir, paneCap);
    paneCommand = panePlan.command;
    paneTab = panePlan.tab
      ? `tab "${panePlan.label}" (${getTab(panePlan.tab)}, ${panePlan.panes.length} of ${paneCap} panes)`
      : `tab "${panePlan.label}" (new tab)`;
    paneId = paneCommand[0] === 'pane' ? '<new-pane-id>' : '<new-root-pane-id>';
    if (panePlan.tab) planTabId = getTab(panePlan.tab);
  }
  // The placeholders also check the caller values, so a bad value stops the start before any side effect.
  const envAgentArgs = workerAgentArgs(options.kind, launchArgs, { paneId: '<pane-id>', tabId: planTabId, workspaceId, env, tmpDir, worktree });
  const browserArgs = codexBrowserArgs(options.kind, config.slug, { lookup: browserLookup, output, env, launch: !options.dryRun });
  const agentArgs = [...envAgentArgs, ...browserArgs];

  const plan = {
    name, kind: options.kind, model, modelSource, ...(modelFallback ? { modelFallback } : {}), effort, effortSource, force: opusForce, rulesFile: rulesPath, rulesStale: staleRules,
    noWorktree: !!options.noWorktree, readOnly: !!options.readOnly, allowedPaths, worktree, branch, base, template: config.briefTemplatePath,
    workspaceId, paneId, paneCommand, paneTab, launchArgs, agentArgs, recordFile, excludeFile,
    // A worker in the current worktree uses its existing dependencies, so setup runs only for a new worktree.
    setup: options.noWorktree ? null : config.setup ?? null, setupTimeoutSeconds: config.setupTimeoutSeconds ?? 900,
    agentStartTimeoutMs: config.agentStartTimeoutMs ?? 90000,
    workerDir, tmpDir,
    copyFiles,
    leasePools,
    planner: !!options.planner,
  };
  if (options.dryRun) {
    output(renderStartPlan(plan));
    return { ...plan, dryRun: true };
  }

  // Read and check the brief template first, so a bad template cannot fail the start after the leases are taken.
  const template = fs.readFileSync(config.briefTemplatePath, 'utf8');
  renderBrief(template, {});
  // Take the leases before the worktree or the pane exists, so an empty pool stops the start with no side effect.
  const leases = [];
  // The port values of a pool (for example a client id) go only into the pane environment. They are never in leases, the run record, the brief, or the output.
  const leaseExtraEnv = [];
  const leaseEnvNotes = [];
  const leaseNotices = [];
  const leaseLog = (item) => leaseNotices.push(`Reclaimed lease ${item.pool} ${item.item} of ${item.project}: ${item.reason}.`);
  try {
    for (const poolName of leasePools) {
      const pool = leaseContext.pools.find((candidate) => candidate.name === poolName);
      const lease = acquireLeaseFor(poolName, { project: config.slug, worker: name, pane: null, runFile: recordFile }, {
        pools: leaseContext.pools, dataDir: leaseContext.dataDir, probeTcp: leaseContext.probeTcp, now, log: leaseLog,
      });
      leases.push({ pool: poolName, item: lease.item, env: pool.env });
      leaseExtraEnv.push(...portEnvFor(pool, lease.item));
      for (const status of portEnvStatus(pool, lease.item)) leaseEnvNotes.push(`${status.env} for port ${lease.item}: ${status.set ? 'set' : 'not set'}`);
    }
  } catch (error) {
    releaseStartLeases(leases, name, config, leaseContext);
    error.message = `${error.message}\nSTART FAILED: ${error.message.split('\n')[0]}`;
    throw error;
  }
  for (const notice of leaseNotices) output(notice);
  for (const lease of leases) output(`Leased ${lease.pool} ${lease.item} as ${lease.env}.`);
  for (const note of leaseEnvNotes) output(note);
  if (leaseExtraEnv.length) herdr = maskingHerdr(herdr, leaseExtraEnv.map((entry) => entry.value));
  if (autoLeasedServePort) output('Automatically leased serve-ports for the serve:live task.');

  const reportPath = path.join(worktree, plan.workerDir, 'report.md');
  const reportJsonPath = path.join(worktree, plan.workerDir, 'report.json');
  const orchPane = caller.paneId;
  const orchAgent = `${config.slug}-orch`;
  const briefSlots = {
    name, kind: options.kind, model, effort, project: config.slug, repo: config.root, worktree, branch, base,
    issue: options.issue ?? null, task, allowedPaths, reportPath, reportJsonPath,
    orchPane, orchAgent, bulletinPath: path.join(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), 'bulletin.md'),
    ...herdrCommands,
    date: new Date(now).toISOString().slice(0, 10),
    evidenceTiers: (config.evidenceTiers || []).join(', '),
    imageBudget: config.imageBudget ?? 10,
    copyPaths: copyFiles.map(({ relative }) => path.posix.join(plan.workerDir, 'inputs', relative)),
    leases: leases.length ? `${leases.map((lease) => `\`${lease.env}=${lease.item}\` (pool \`${lease.pool}\`)`).join(', ')}. Use only these.` : null,
    kindHeaderNote: [
      options.kind === 'codex' ? 'In a Codex shell, run `setopt NO_BG_NICE` before a background command.' : '',
      // In the vendor test, Luna failed to report a broken tool in 28.7% of cases. Sol 6.1 failed in 2.8%.
      model === 'gpt-6-luna' ? 'Report a failing tool, a missing file, or missing evidence explicitly in your report. Never give a best guess in place of a result. The orchestrator verifies each claim at the source.' : '',
    ].filter(Boolean).join('\n'),
    kindWaitNote: options.kind === 'claude' ? 'To wait, use a background command and wait for its exit. Do not run sleep and then poll. Do not run herdr-boss wait: it waits on other workers.' : '',
    stopRule: options.kind === 'codex'
      ? `Stop it with \`herdr-boss worker stop-own ${name} --pid <pid>\`. Never run \`kill\`, \`pkill\`, \`killall\`, or \`kill\` with a name pattern such as \`kill $(pgrep …)\`.`
      : 'Stop it with `kill <pid>`. Never use `pkill`, `killall`, or `kill` with a name pattern such as `kill $(pgrep …)`.',
    kindCommitRule: options.kind === 'codex'
      ? `Codex worker commit rule: do not run \`git add\` or \`git commit\`. Leave the change in the working tree. Say in your report that the change is uncommitted. The orchestrator commits the change with \`herdr-boss worker commit ${name} -m MESSAGE\`.`
      : '',
    portInstruction: leases.some((lease) => lease.pool === 'serve-ports')
      ? `Use only the port in \`${path.posix.join(plan.workerDir, 'port')}\`. Take no other serve port.`
      : '',
    threadLimit: config.testThreadsFlag
      ? `Add \`${config.testThreadsFlag}\` to each test runner command.`
      : 'Use the form that the project instructions name. For Vitest 2 with the forks pool, use `--poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`; `--maxWorkers=2` fails there. For Vitest 3 and later, use `--maxWorkers=2`.',
    readOnlySection: options.readOnly
      ? '## Read-only review\n\nThis task is read-only. Do not change a repository file. Do not run `git stash`, `git reset`, or `git checkout` of any path or branch. Use `git show`, `git diff`, and `git log` only.'
      : '',
  };
  const missingBriefDetails = [];
  if (!/{{\s*imageBudget\s*}}/.test(template)) {
    missingBriefDetails.push(`Screenshot budget: ${briefSlots.imageBudget} screenshots. The project setting overrides the kit default.`);
  }
  if (leases.length && !/{{\s*leases\s*}}/.test(template)) missingBriefDetails.push(`Leased resources: ${briefSlots.leases}`);
  if (briefSlots.copyPaths.length && !/{{\s*copyPaths\s*}}/.test(template)) {
    missingBriefDetails.push(`Copied inputs:\n${briefSlots.copyPaths.map((item) => `- ${item}`).join('\n')}`);
  }
  for (const slot of ['kindHeaderNote', 'kindWaitNote', 'portInstruction', 'stopRule', 'kindCommitRule']) {
    if (briefSlots[slot] && !new RegExp(`{{\\s*${slot}\\s*}}`).test(template)) missingBriefDetails.push(briefSlots[slot]);
  }
  const brief = `${renderBrief(template, briefSlots)}${missingBriefDetails.length ? `\n\n## Worker start details\n\n${missingBriefDetails.join('\n\n')}` : ''}`;
  const readWorkerText = readText ?? ((agentName) => {
    const result = herdr(['agent', 'read', agentName, '--source', 'recent-unwrapped', '--lines', '60']);
    return result?.text ?? String(result ?? '');
  });

  let createdWorktree = false;
  let agentStarted = false;
  let placement = null;
  let plannerRegistered = false;
  let startAttempts = 0;
  try {
    if (!options.noWorktree) {
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      git(config.root, ['worktree', 'add', '-b', branch, worktree, base]);
      createdWorktree = true;
      const localCopy = copyLocalOrchestration(mainCheckout(config.root), worktree);
      if (localCopy) {
        const fileWord = localCopy.copied === 1 ? 'file' : 'files';
        output(`Copied ${localCopy.copied} ${fileWord} from .orchestration/local.`);
        if (localCopy.oversized) {
          const skippedWord = localCopy.oversized === 1 ? 'file' : 'files';
          output(`Warning: skipped ${localCopy.oversized} ${skippedWord} over 5 MB from .orchestration/local.`);
        }
        if (localCopy.unreadable) {
          output(`Warning: skipped ${localCopy.unreadable} unreadable file(s) from .orchestration/local.`);
        }
      }
    }
    addExclude(worktree);
    if (openCodeConfig) {
      // A v2 TUI reads the project config of its working folder. The exclude keeps the file out of the worker commit.
      fs.writeFileSync(path.join(worktree, OPEN_CODE_CONFIG_NAME), openCodeConfigText(model), { mode: 0o600 });
      output(`Wrote ${OPEN_CODE_CONFIG_NAME} in ${worktree} with model ${model} and agent worker.`);
    }
    fs.mkdirSync(path.join(worktree, plan.workerDir), { recursive: true });
    fs.mkdirSync(plan.tmpDir, { recursive: true });
    const servePort = leases.find((lease) => lease.pool === 'serve-ports');
    if (servePort) fs.writeFileSync(path.join(worktree, plan.workerDir, 'port'), `${servePort.item}\n`, { flag: 'wx' });
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
    placement = chooseWorkerPane(workspaceId, worktree, options.kind, herdr, plan.tmpDir, paneCap, [...leases, ...leaseExtraEnv.map((entry) => ({ env: entry.env, item: entry.value }))]);
    paneId = placement.paneId;
    for (const lease of leases) setLeasePane(lease.pool, lease.item, paneId, { dataDir: leaseContext.dataDir });
    // Answer nothing at a launch block. Mark the model, close the TUI, and stop this model.
    const markAndStop = (block) => {
      try {
        markModelUnavailable(bossDir, {
          kind: options.kind, model, provider: providerFor(options.kind, model, policy), untilReenabled: block.untilReenabled,
          label: block.phrase, reason: block.phrase, now,
        });
      } catch (markError) { output(`Warning: could not record ${model} as unavailable: ${markError.message}`); }
      try { herdr(['agent', 'close', name]); } catch { /* The pane cleanup below closes what remains. */ }
      const error = launchBlockedError(model, block, { fallback: modelSource !== 'flag' });
      error.blockedModel = model;
      throw error;
    };
    // The TUI refused a launch flag. This is a CLI version problem, not a model problem. Stop without a record.
    const openCodeFlagError = (flag) => {
      const error = new Error(`OpenCode refused the launch flag ${flag}: the pane shows "Unrecognized flag: ${flag} in command opencode". The installed OpenCode TUI does not accept this flag. Worker start stopped, and Herdr Boss marks no model.`);
      error.code = 'opencode_unsupported_flag';
      error.unsupportedFlag = flag;
      return error;
    };
    const readPaneSnapshot = () => {
      try {
        const response = herdr(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text']);
        return typeof response === 'string' ? response : response?.text ?? response?.output ?? '';
      } catch { return null; }
    };
    // The pane text before the agent starts. A reused pane can hold the phrase of an earlier launch.
    let launchBaseline = null;
    // `cutAtBrief` stops the scan at the first line of the typed brief, so brief text never counts.
    const checkLaunchBlock = ({ baseline = launchBaseline, cutAtBrief = false } = {}) => {
      if (options.kind !== 'opencode' || baseline == null) return;
      const text = readPaneSnapshot();
      if (text == null) return;
      let lines = newPaneLines(text, baseline);
      if (cutAtBrief) {
        const marker = briefPrompt(plan.workerDir).slice(0, 24);
        const at = lines.findIndex((line) => line.includes(marker));
        if (at >= 0) lines = lines.slice(0, at);
      }
      const joined = lines.join('\n');
      // A refused flag is a CLI problem, not a model problem. Fail without a record.
      const refusedFlag = unsupportedOpenCodeFlag(joined);
      if (refusedFlag) throw openCodeFlagError(refusedFlag);
      const block = detectLaunchBlock(joined);
      if (block) markAndStop(block);
    };
    const waitForShell = () => {
      try {
        waitForWorkerPane(paneId, workspaceId, worktree, herdr, wait,
          options.kind === 'opencode' && launchBaseline != null ? { launchBlock: { baseline: launchBaseline } } : {});
      } catch (error) {
        if (error?.code === 'model_launch_blocked' && options.kind === 'opencode') markAndStop(error.launchBlock);
        throw error;
      }
    };
    const startAndDeliver = (attempt = 1) => {
      startAttempts = attempt;
      waitForShell();
      const shellPid = workerPaneShellPid(paneId, herdr);
      if (options.kind === 'opencode') launchBaseline = readPaneSnapshot();
      const paneAgentArgs = [...workerAgentArgs(options.kind, launchArgs, { paneId, tabId: placement.tabId, workspaceId, env, tmpDir: plan.tmpDir, worktree }), ...browserArgs];
      try {
        herdr(['agent', 'start', name, '--kind', options.kind, '--pane', paneId, '--timeout', String(plan.agentStartTimeoutMs), '--', ...paneAgentArgs]);
      } catch (startError) {
        // Herdr can report agent_not_ready while leaving a blocked agent in the pane.
        try { agentStarted ||= listFrom(herdr(['agent', 'list']), 'agents').some((agent) => getName(agent) === name); } catch {}
        checkLaunchBlock();
        if (options.kind !== 'opencode' && !agentStarted && isAgentPaneBusy(startError)) {
          waitForShell();
          try {
            herdr(['agent', 'start', name, '--kind', options.kind, '--pane', paneId, '--timeout', String(plan.agentStartTimeoutMs), '--', ...paneAgentArgs]);
          } catch (retryError) {
            try { agentStarted ||= listFrom(herdr(['agent', 'list']), 'agents').some((agent) => getName(agent) === name); } catch {}
            throw retryError;
          }
        } else throw startError;
      }
      agentStarted = true;
      checkLaunchBlock();
      const record = {
        name,
        kind: options.kind,
        model,
        modelSource,
        ...(modelFallback ? { modelFallback } : {}),
        ...(options.kind === 'opencode' ? { startAttempts: attempt } : {}),
        ...(opusForce ? { force: true } : {}),
        provider,
        effort,
        ...(effortSource ? { effortSource } : {}),
        issue: options.issue == null ? null : Number(options.issue),
        ...(options.taskId != null ? { taskId: String(options.taskId) } : {}),
        ...(titleFromTask(task) ? { title: titleFromTask(task) } : {}),
        briefCopy: briefCopy(brief, now),
        worktree,
        branch,
        base,
        baseCommit,
        shellPid,
        pane: paneId,
        workerDir: plan.workerDir,
        allowedPaths,
        readOnly: !!options.readOnly,
        ...(leases.length ? { leases } : {}),
        startedAt: new Date(now).toISOString(),
      };
      writeJsonAtomic(recordFile, record);
      if (options.planner && !plannerRegistered) {
        // The worker pane gets the label planner and a registry record. The pane can then run `review publish` for this project.
        herdr(['pane', 'rename', paneId, PLANNER_LABEL]);
        const session = startSession({ dir: env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'), now, kind: options.kind, project: config.slug, pane: paneId, input: path.join(worktree, plan.workerDir, 'brief.md') });
        plannerRegistered = true;
        output(`Started planner session ${session.id} for ${config.slug} on pane ${paneId}.`);
      }
      if (options.kind === 'claude' && opusForce) alertBossForOpus(name, model, { ...options, allowedByPolicy: opusAllowed }, config, env, herdr, now, output);
      let delivery;
      const preBriefBaseline = options.kind === 'opencode' ? readPaneSnapshot() : null;
      try { delivery = deliverBrief(name, options.kind, herdr, readWorkerText, wait, output, plan.workerDir); }
      catch (deliverError) {
        // The brief text stays on the pane. A retry must not scan it.
        launchBaseline = null;
        checkLaunchBlock({ baseline: preBriefBaseline, cutAtBrief: true });
        throw deliverError;
      }
      if (delivery === 'resent') output(`Resent the brief prompt to ${name}: the first prompt did not reach the agent.`);
      if (delivery === 'stalled-retry') output(`Resent the brief prompt to ${name} after agent_prompt_stalled.`);
      if (delivery === 'submitted') output(`Sent Enter to ${name}: the brief prompt was typed but not submitted.`);
      return { ...record, recordFile, dryRun: false };
    };
    if (options.kind === 'opencode') {
      return withOpenCodeStartLock(env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss'),
        () => retryOpenCodeStart(name, paneId, startAndDeliver, { herdr, output }), { wait, output });
    }
    return startAndDeliver();
  } catch (error) {
    const failedReason = error.message;
    let safeCleanup = !agentStarted;
    let paneStopped = !placement && !agentStarted;
    if (placement && (options.kind === 'opencode' || agentStarted)) {
      safeCleanup = false;
      try {
        closeFailedWorkerPane(name, options.kind, paneId, workspaceId, worktree, herdr);
        safeCleanup = true;
        paneStopped = true;
        agentStarted = false;
        if (plannerRegistered) {
          const dir = env.HERDR_BOSS_DIR || path.join(os.homedir(), '.herdr-boss');
          const planner = activeSessionForPane({ dir, pane: paneId });
          if (planner) endSession({ dir, id: planner.id });
        }
      } catch (cleanupError) {
        safeCleanup = false;
        error.message += ` Failed-start cleanup stopped: ${cleanupError.message} Worktree, branch, and run record were kept.`;
      }
    } else if (placement) {
      try {
        // Close only what this start created: the worker tab when it made the tab, or else its own pane.
        if (placement.createdTab) herdr(['tab', 'close', placement.tabId]);
        else if (placement.createdPane) herdr(['pane', 'close', placement.paneId]);
        paneStopped = true;
      } catch (cleanupError) {
        safeCleanup = false;
        error.message += ` (Herdr pane cleanup also failed: ${cleanupError.message})`;
      }
    }
    if (safeCleanup) {
      try {
        const runFile = fs.existsSync(recordFile) ? recordFile : null;
        if (runFile) {
          if (!fs.lstatSync(runFile).isFile()) throw new Error('The failed run record is not a regular file.');
          const run = readJson(runFile);
          if (run.name !== name || run.worktree !== worktree) throw new Error('The failed run record belongs to another start.');
          writeJsonAtomic(runFile, {
            ...run, finishedAt: new Date().toISOString(), outcome: 'failed', startFailed: true,
            ...(options.kind === 'opencode' ? { startAttempts } : {}),
          });
        }
        const archive = archiveWorkerReports(worktree, name, mainCheckout(config.root), {
          output, now, runFile, workerDir: plan.workerDir,
        });
        if (runFile) fs.unlinkSync(runFile);
        if (archive) error.message += ` Failed-start evidence archived to ${archive}.`;
      } catch (cleanupError) {
        safeCleanup = false;
        error.message += ` Failed-start archive failed: ${cleanupError.message} Worktree, branch, and run record were kept.`;
      }
    }
    if (createdWorktree && safeCleanup) {
      try {
        const changes = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
        const uniqueCommits = git(worktree, ['rev-list', `${baseCommit}..HEAD`, `${baseCommit}..${branch}`]).trim();
        if (changes) {
          error.message += ` Failed-start worktree and branch ${branch} were kept because the worktree has changes.`;
        } else if (uniqueCommits) {
          error.message += ` Failed-start branch ${branch} was kept because it has commits beyond base ${base}; its worktree was also kept.`;
        } else {
          git(config.root, ['worktree', 'remove', worktree]);
          git(config.root, ['branch', '-D', branch]);
          error.message += ` Clean failed-start worktree and branch removed; worker name ${name} is reusable.`;
        }
      } catch (cleanupError) {
        error.message += ` Failed-start worktree or branch cleanup failed: ${cleanupError.message}`;
      }
    }
    if (paneStopped) releaseStartLeases(leases, name, config, leaseContext);
    else error.message += ` Agent ${name} may still be running in pane ${paneId}; inspect it before retrying.`;
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

// A run that names no task never shows on the project board. Warn, and start the worker.
export function taskIdWarning(options) {
  if (options?.taskId != null || options?.issue != null) return null;
  return 'No --task-id: the project board shows this worker as Unplanned work.';
}

const TASK_SUGGESTION_STOPWORDS = new Set(['add', 'the', 'fix', 'test', 'tests', 'docs', 'and', 'for', 'with', 'task', 'from', 'into']);

function suggestedTask(options, projectStatus) {
  const input = options?.taskFile ? path.basename(String(options.taskFile)) : String(options?.task || '');
  const tasks = (Array.isArray(projectStatus?.tasks) ? projectStatus.tasks : []).filter((task) =>
    String(task?.status || '').toLowerCase() !== 'done'
      && TASK_ID.test(String(task?.id || '')) && typeof task?.title === 'string' && task.title.trim());
  const exactIds = tasks.filter((task) => {
    const id = String(task?.id || '');
    if (id.length < 2) return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(input);
  });
  if (exactIds.length === 1) return { id: exactIds[0].id, title: exactIds[0].title };
  if (exactIds.length > 1) return null;

  const tokens = (value) => new Set((String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => Array.from(token).length >= 3 && !TASK_SUGGESTION_STOPWORDS.has(token)));
  const inputTokens = tokens(input);
  const ranked = tasks.map((task) => {
    const id = String(task?.id || '');
    const taskTokens = tokens(`${id} ${task.title}`);
    const shared = [...inputTokens].filter((token) => taskTokens.has(token)).length;
    return { id, title: task.title, shared };
  }).filter((task) => task.shared >= 2).sort((a, b) => b.shared - a.shared);
  if (!ranked.length || ranked[1]?.shared === ranked[0].shared) return null;
  return ranked[0];
}

function readRun(config, name) {
  if (!NAME_PATTERN.test(name)) throw new Error('Worker name must match [a-z][a-z0-9-]{0,31}.');
  const file = path.join(config.runsPath, `${name}.json`);
  const run = readJson(file);
  if (run.name !== name) throw new Error(`Run record name does not match ${name}.`);
  return { file, run };
}

// Name every missing recording flag at once, with a hint from the worker report. The orchestrator still decides.
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

// Derive the model outcome: orchestrator override wins, then report, then defaults.
export function deriveModelOutcome(options, reportJson = {}) {
  if (options.modelResult) return { result: options.modelResult, reason: options.modelReason || '' };
  if (reportJson.modelOutcome) return { result: reportJson.modelOutcome.result, reason: reportJson.modelOutcome.reason || '' };
  if (options.outcome === 'failed' || options.gateFailed) return { result: 'failed', reason: '' };
  if ((options.rework ?? 0) > 0) return { result: 'rework', reason: '' };
  return { result: 'first-time', reason: '' };
}

// Stop one process of a worker. The caller runs in the worker pane. The target must be a descendant
// of the worker pane shell, or have its current directory inside the worker worktree. Nothing else is
// stopped. The command prints only the pid and the command name.
export function stopOwnWorker(name, { pid = null } = {}, {
  config,
  output = console.log,
  listProcesses = listCwdProcesses,
  kill = (target, signal) => process.kill(target, signal),
  callerPid = process.pid,
  callerPpid = process.ppid,
} = {}) {
  const { run } = readRun(config, name);
  const target = Number(pid);
  if (!Number.isSafeInteger(target) || target <= 1) throw new Error('worker stop-own needs --pid PID with a process id greater than 1.');
  const processes = listProcesses();
  const byPid = new Map(processes.map((item) => [Number(item.pid), item]));
  const targetProcess = byPid.get(target);
  const callerPids = new Set(callerProcessTree(processes, callerPid, callerPpid).map((item) => Number(item.pid)));
  if (callerPids.has(target)) throw new Error(`worker stop-own refuses pid ${target}: it is the caller or one of its parents.`);
  const shellPid = Number(run.shellPid);
  const inShellTree = (() => {
    let current = targetProcess;
    const seen = new Set();
    while (current && !seen.has(Number(current.pid))) {
      if (Number(current.pid) === shellPid && Number.isSafeInteger(shellPid) && shellPid > 1) return true;
      seen.add(Number(current.pid));
      current = byPid.get(Number(current.ppid));
    }
    return false;
  })();
  if (!targetProcess || (!inShellTree && !isInWorktree(targetProcess, path.resolve(run.worktree)))) {
    throw new Error(`worker stop-own refuses pid ${target}: it is not in the process tree or worktree of worker ${name}.`);
  }
  const command = targetProcess.command || 'unknown';
  if (/^app-server/.test(command)) throw new Error(`worker stop-own refuses pid ${target}: the Codex app-server is shared. Do not stop it.`);
  try { kill(target, 'SIGTERM'); }
  catch (error) { throw new Error(`worker stop-own could not stop pid ${target} (${error.code || error.message}).`); }
  output(`${target} ${command}`);
  return { pid: target, command };
}

// Commit the scoped change of one worker on its own branch. The orchestrator runs this from its own
// pane, because a Codex worker cannot write the shared Git metadata of a worktree. The command stages
// the changed paths inside the worker scope and refuses every path outside it.
export function commitWorker(name, { message = null } = {}, { config, output = console.log } = {}) {
  const { run } = readRun(config, name);
  const text = String(message ?? '').trim();
  if (!text) throw new Error('worker commit needs -m MESSAGE.');
  const actualBranch = git(run.worktree, ['branch', '--show-current']).trim();
  if (actualBranch !== run.branch) throw new Error(`Worktree branch ${actualBranch || '(detached)'} does not match run branch ${run.branch}.`);
  const baseRef = run.baseCommit || run.base;
  // The worker's own brief and report files never count. The kit writes its own files in the worktree.
  const ownFile = (item) => item === '.worker' || String(item).startsWith('.worker/') || KIT_MANAGED_PATHS.includes(String(item));
  const extensionPaths = (Array.isArray(run.scopeExtensions) ? run.scopeExtensions : []).flatMap((extension) => Array.isArray(extension?.paths) ? extension.paths : []);
  const allowedPaths = [...new Set([...(run.allowedPaths ?? []), ...extensionPaths])];
  const changed = gitWorkerChangedPaths(run.worktree, baseRef, run.base).filter((item) => !ownFile(item));
  const outOfScope = compareChangedPaths(changed, allowedPaths);
  if (outOfScope.length) throw new Error(`Worker ${name} changed paths outside its allowed scope: ${outOfScope.join(', ')}.`);
  if (!changed.length) {
    output(`Nothing to commit for worker ${name}.`);
    return { committed: false, paths: [] };
  }
  git(run.worktree, ['add', '--', ...changed]);
  git(run.worktree, ['commit', '-m', text, '--', ...changed]);
  const commit = git(run.worktree, ['rev-parse', '--short', 'HEAD']).trim();
  output(`Committed ${commit} on ${run.branch}: ${text.split('\n')[0]}`);
  return { committed: true, commit, paths: changed };
}

export function collectWorker(name, options, { config, now = Date.now(), output = console.log, recordUsageFn = recordUsage, listWorktreeProcesses = worktreeCwdProcesses, leaseDataDir = DATA_DIR, schedulePaneCloseFn = scheduleWorkerPaneClose, callerPid = process.pid, callerPpid = process.ppid } = {}) {
  const record = options.noRecord !== true && options.record !== false;
  let ledgerWritten = false;
  try {
    const { file, run } = readRun(config, name);
    if (run.finishedAt) throw new Error(`Run ${name} is already marked finished at ${run.finishedAt}.`);
    const reportDir = path.join(run.worktree, run.workerDir || '.worker');
    const normalized = normalizeWorkerReport(readJson(path.join(reportDir, 'report.json')));
    const reportJson = normalized.report;
    if (record) {
      const missing = recordFlagErrors(options, reportJson);
      if (missing.length) throw new Error(`--record needs:\n- ${missing.join('\n- ')}\nUse --no-record to read the report without a ledger entry.`);
    }
    const reportFile = path.join(reportDir, 'report.md');
    readBoundedWorkerReport(reportFile); // refuses a symlink or a non-regular report before the full read
    const reportMd = fs.readFileSync(reportFile, 'utf8');
    const errors = validateWorkerReport(reportJson, { evidenceTiers: config.evidenceTiers });
    if (errors.length) throw new Error(`Invalid worker report:\n- ${errors.join('\n- ')}`);
    if (path.resolve(reportJson.worktree) !== path.resolve(run.worktree)) throw new Error(`Report worktree ${reportJson.worktree} does not match run worktree ${run.worktree}.`);
    const actualBranch = git(run.worktree, ['branch', '--show-current']).trim();
    if (actualBranch !== run.branch) throw new Error(`Worktree branch ${actualBranch || '(detached)'} does not match run branch ${run.branch}.`);
    const processList = listWorktreeProcesses(run.worktree);
    const root = path.resolve(run.worktree);
    const callerShell = callerProcessTree(processList, callerPid, callerPpid)
      .find((item) => isShellProcess(item) && isInWorktree(item, root));
    const leftovers = filterCollectProcesses(processList, { worktree: run.worktree, shellPid: run.shellPid, callerPid, callerPpid });
    const backgroundShell = leftovers.find(isShellProcess);
    if (backgroundShell) {
      throw new Error(`your own background shell (pid ${backgroundShell.pid}, command ${backgroundShell.command}) has its cwd in the worktree. Change directory or stop it.`);
    }
    if (leftovers.length) throw new Error(`Worker ${name} still has processes in its worktree: ${leftovers.map((process) => `${process.command || 'unknown'} (pid ${process.pid})`).join('; ')}. Stop them before collection.`);
    if (run.issue != null && reportJson.issue !== run.issue) throw new Error(`Report issue ${reportJson.issue} does not match run issue ${run.issue}.`);
    if (reportJson.branch !== run.branch) throw new Error(`Report branch ${reportJson.branch} does not match run branch ${run.branch}.`);
    const baseRef = run.baseCommit || run.base;
    const log = gitLog(run.worktree, baseRef);
    // The worker's own brief and report files live under .worker/ and never count as changed product paths.
    // The kit writes its own files in the worktree. They never count as changed product paths either.
    const ownFile = (item) => item === '.worker' || String(item).startsWith('.worker/') || KIT_MANAGED_PATHS.includes(String(item));
    const extensionPaths = (Array.isArray(run.scopeExtensions) ? run.scopeExtensions : []).flatMap((extension) => Array.isArray(extension?.paths) ? extension.paths : []);
    const oneTimePaths = Array.isArray(options.allow) ? options.allow : [];
    for (const [label, paths] of [['approved', extensionPaths], ['--allow', oneTimePaths]]) {
      if (!paths.length) continue;
      const errors = scopeEscapeErrors(run.worktree, paths);
      if (errors.length) throw new Error(`Worker ${name} has invalid ${label} paths: ${errors.join(', ')}.`);
    }
    const allowedPaths = [...new Set([...(run.allowedPaths ?? []), ...extensionPaths, ...oneTimePaths])];
    const reported = (reportJson.changedPaths || []).filter((item) => !ownFile(item));
    const changed = gitWorkerChangedPaths(run.worktree, baseRef, run.base).filter((item) => !ownFile(item));
    const reportScope = compareChangedPaths(reported, allowedPaths);
    const actualScope = compareChangedPaths(changed, allowedPaths);
    const scopeErrors = [...new Set([...reportScope, ...actualScope])];
    // A report entry that ends in / covers every changed file under that folder, when the folder is inside the
    // allowed paths. The scope check above still runs on each real file.
    const folders = reported.filter((item) => item.endsWith('/') && compareChangedPaths([item], allowedPaths).length === 0);
    const omitted = changed.filter((item) => !reported.includes(item) && !folders.some((folder) => item.startsWith(folder)));
    // --accept-scope passes only the listed files that lie outside the allowed scope. Any other outside file still refuses.
    let scopeException = null;
    let unlistedErrors = scopeErrors;
    if (options.acceptScope != null) {
      const reason = String(options.acceptScopeReason ?? '').trim();
      if (!reason) throw new Error('--accept-scope needs --reason TEXT with a reason that is not blank.');
      const listed = [...new Set(options.acceptScope.map((item) => String(item).trim()).filter(Boolean))];
      if (!listed.length) throw new Error('--accept-scope needs at least one repository-relative path.');
      const notOutside = listed.filter((item) => !scopeErrors.includes(item));
      if (notOutside.length) throw new Error(`--accept-scope lists paths that are not changed outside the allowed scope of worker ${name}: ${notOutside.join(', ')}.`);
      unlistedErrors = scopeErrors.filter((item) => !listed.includes(item));
      scopeException = { files: listed, reason: maskText(reason) };
    } else if (options.acceptScopeReason != null) {
      throw new Error('--reason needs --accept-scope FILE[,FILE].');
    }
    if (unlistedErrors.length) throw new Error(`Worker ${name} changed paths outside its allowed scope: ${unlistedErrors.join(', ')}.`);
    // A Codex worker cannot write the shared Git metadata, so it leaves its change in the working tree.
    // Collection accepts that state and names it, so the orchestrator commits with worker commit.
    const uncommitted = run.kind === 'codex' && !log.trim() && changed.length > 0;
    if (uncommitted) output(`Codex worker ${name} left ${changed.length} changed path(s) uncommitted; the orchestrator commits with herdr-boss worker commit ${name} -m MESSAGE.`);
    const recordedPaths = omitted.length ? changed : reported;
    try {
      const reportStat = fs.statSync(path.join(reportDir, 'report.json'));
      recordWorkerReport({
        project: config.slug, name: run.name, pane: run.pane,
        taskId: run.taskId ?? run.issue ?? null,
        runId: workerRunId(run, config.slug), mtimeMs: reportStat.mtimeMs,
        summary: readBoundedWorkerReport(reportFile), toPane: process.env.HERDR_PANE_ID || null,
      }, { dir: DATA_DIR, now });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : 'error';
      output(`Warning: worker report store failed (${code}).`);
    }
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
      recordedPaths,
      outOfScope: unlistedErrors,
      ...(uncommitted ? { uncommitted: true } : {}),
      ...(scopeException ? { scopeException } : {}),
      scopeExtensions: run.scopeExtensions ?? [],
      artifactWarnings: collectArtifactWarnings(run.worktree, reportMd, config.artifactChecks ?? []),
      report: reportMd,
    };
    let usageWarning = null;
    const releasedLeases = [];
    if (record) {
      const modelOutcome = deriveModelOutcome(options, reportJson);
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
        changedPaths: recordedPaths,
        independentGate: { passed: !!options.gatePassed, command: 'Independent gate result supplied by orchestrator; command and evidence are in the worker report and review.' },
        defectsFound: Array.from({ length: options.defects ?? 0 }, (_value, index) => `defect ${index + 1}`),
        rework: Array.from({ length: options.rework ?? 0 }, (_value, index) => `rework ${index + 1}`),
        evidenceTier: reportJson.evidenceTier,
        scopeExtensions: run.scopeExtensions ?? [],
        modelOutcome: { kind: run.kind, model: run.model, result: modelOutcome.result, reason: modelOutcome.reason },
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
        modelOutcome: entry.modelOutcome,
      });
      if (recorded.errors.length) usageWarning = `Warning: usage was not recorded: ${recorded.errors.join(' ')}`;
      appendDelegatedRun(config.ledgerPath, entry, { evidenceTiers: config.evidenceTiers });
      ledgerWritten = true;
      run.finishedAt = entry.endedAt;
      run.outcome = entry.outcome;
      const reportSummary = firstParagraph(reportMd);
      if (reportSummary) run.reportSummary = reportSummary;
      run.collectedAt = run.collectedAt || entry.endedAt;
      if (scopeException) run.scopeException = scopeException;
      writeJsonAtomic(file, run);
      if (run.leases?.length) {
        const taken = new Set(run.leases.map((lease) => `${lease.pool}\n${lease.item}`));
        releasedLeases.push(...dropLeases((lease) => lease.project === config.slug && lease.worker === name && taken.has(`${lease.pool}\n${lease.item}`), { dataDir: leaseDataDir }));
      }
    }
    if (omitted.length) output(`report.json omits ${omitted.length} changed path(s); recorded the diff paths`);
    // The collected worker is done, so its planner session ends. A later result goes to the orch pane.
    if (record && run.pane) {
      try {
        const planner = activeSessionForPane({ dir: leaseDataDir, pane: run.pane });
        if (planner) {
          endSession({ dir: leaseDataDir, now, id: planner.id });
          output(`Ended planner session ${planner.id}.`);
        }
      } catch (error) { output(`Warning: planner session was not ended: ${error.message}`); }
    }
    if (callerShell) output(`cd ${displayArg(config.mainRoot ?? config.root)}`);
    for (const warning of normalized.warnings) output(warning);
    if (record && !reportJson.modelOutcome && !options.modelResult) {
      const { result } = deriveModelOutcome(options, reportJson);
      output(`Warning: report.json has no modelOutcome; recorded ${result} from the outcome. Add --model-result next time.`);
    }
    if (record && !options.keepPane) {
      const delayMinutes = Number.isSafeInteger(options.paneCloseDelayMinutes) ? options.paneCloseDelayMinutes : 2;
      try {
        schedulePaneCloseFn({
          project: config.slug,
          name,
          runId: workerRunId(run, config.slug),
          dueAt: now + delayMinutes * 60_000,
        });
      } catch (error) {
        output(`Warning: worker pane close was not scheduled: ${error.message}`);
      }
    }
    if (scopeException) output(`Scope exception\n- files: ${scopeException.files.join(', ')}\n- reason: ${scopeException.reason}`);
    output(JSON.stringify(summary, null, 2));
    for (const warning of summary.artifactWarnings) output(`Warning: ${warning}`);
    if (usageWarning) output(usageWarning);
    for (const lease of releasedLeases) output(`Released lease ${lease.pool} ${lease.item}.`);
    if (record) output('After you review this collection, remove the worktree with herdr-boss worktree prune --apply');
    return summary;
  } catch (error) {
    if (!record) throw error;
    const reason = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
    const message = ledgerWritten
      ? `worker collect: ledger entry written, but collection did not finish: ${reason}`
      : `worker collect: no ledger entry written: ${reason}`;
    const refusal = new Error(message, { cause: error });
    if (error?.exitCode !== undefined) refusal.exitCode = error.exitCode;
    throw refusal;
  }
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
