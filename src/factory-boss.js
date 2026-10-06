import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { maskLine } from './factory-host.js';
import { redactSecrets } from './redact.js';
import { assertOwned, managedFactory, transportFor, inspect } from './factory-core.js';
import { assertName } from './factory-store.js';
import { ensureFactoryGitIdentity, FACTORY_PROJECT_GROUP } from './factory-role.js';
import { verifyHarnessLogin, openCodeCredentialCount, openCodeMissingLine } from './factory-wizard.js';
import { waitForAgentReady } from './kit/workers.js';

const WORKER_LABEL = 'herdr-factory-spike';
const BOSS_ROOT = '/home/factory/herdr-boss';
const WORK_ROOT = FACTORY_PROJECT_GROUP;
const DATA_ROOT = '/home/factory/.herdr-boss';
const LOGIN_TIMEOUT_MS = 30 * 60_000;
const BOSS_PROMPT_MARKER = 'You are the Boss of this factory.';
const BOSS_PROMPT_RETRY_LIMIT = 3;
const BOSS_PROMPT_RETRY_WAIT_MS = 20_000;

export const BOSS_START_CALL_PLAN = Object.freeze([
  'harness-login',
  'kit-install',
  'herdr-workspace-and-pane',
  'boss-prompt',
  'ready-prompt-check',
]);

const BOSS_PROMPT = '[herdr-boss] You are the Boss of this factory. Read AGENTS.md, PRODUCT.md, docs/user-guide.md, docs/orchestration/memory.md, and docs/orchestration/herdr-boss.md in this factory. Follow the kit rules. Start project orchestrators with `herdr-boss project new` from this factory. Keep projects, messages, and handover state in this factory. Write your run notes to ~/work/boss-notes/memory.md and not to docs/orchestration/memory.md in the repository. Report missing files and blocked work to the Owner.';
const BOSS_RESUME_PROBE_SCRIPT = String.raw`
import { createHerdrRunner, readAgentText } from '/home/factory/herdr-boss/src/kit/workers.js';
import { inspectBossPromptText } from '/home/factory/herdr-boss/src/factory-boss.js';
const [prompt, promptMarker] = process.argv.slice(1);
const herdr = createHerdrRunner();
herdr(['agent', 'get', 'boss']);
console.log(JSON.stringify(inspectBossPromptText(readAgentText('boss'), prompt, promptMarker)));
`;
const BOSS_PROMPT_SCRIPT = String.raw`
import { createHerdrRunner, deliverPrompt, readAgentText, waitForWorkerPane } from '/home/factory/herdr-boss/src/kit/workers.js';
import { loadPolicy } from '/home/factory/herdr-boss/src/control.js';
import { loadModels } from '/home/factory/herdr-boss/src/kit/config.js';
import { handoffTarget, successorAgentArgs } from '/home/factory/herdr-boss/src/handoff.js';
import { runBossPromptReadiness } from '/home/factory/herdr-boss/src/factory-boss.js';

const [harness, pane, workspace, prompt, resumeExistingArg] = process.argv.slice(1);
const herdr = createHerdrRunner();
const policy = loadPolicy({ warn: () => {} });
const target = handoffTarget(harness, {}, policy, loadModels());
const launch = successorAgentArgs({ toKind: harness, newPane: pane, newTab: null, workspace, project: 'boss' }, target.launchArgs, process.env, {
  browserLookup: () => null,
  output: () => {},
});
let resumeExisting = false;
if (resumeExistingArg === 'true') {
  try {
    const value = herdr(['agent', 'get', 'boss']);
    resumeExisting = Boolean(value.agent ?? value);
  } catch {}
}
if (!resumeExisting) {
  waitForWorkerPane(pane, workspace, '/home/factory/herdr-boss', herdr, undefined, { retryCommand: 'factory boss start', timeoutMs: 20000 });
  herdr(['agent', 'start', 'boss', '--kind', harness, '--pane', pane, '--', ...launch]);
}
const promptMarker = 'You are the Boss of this factory.';
const readyOptions = { herdr, readText: readAgentText };
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const result = runBossPromptReadiness({
  herdr,
  wait,
  harness,
  readText: readAgentText,
  deliverPrompt: () => deliverPrompt('boss', prompt, promptMarker, { ...readyOptions, kind: harness }),
  resumeExisting,
  promptMarker,
});
console.log(JSON.stringify(result));
`;

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function inspectBossPromptText(text, prompt, promptMarker) {
  const visible = String(text ?? '').trimEnd();
  const promptTyped = Boolean(prompt) && visible.endsWith(prompt);
  const priorText = promptTyped ? visible.slice(0, -prompt.length) : visible;
  return { promptMarkerPresent: priorText.includes(promptMarker), promptTyped };
}

function startupDialog(text) {
  const visible = stripVTControlCharacters(String(text ?? ''));
  if (/choose (?:the |a )?(?:text style|theme)|select (?:a |your )?(?:color )?theme/i.test(visible)) return 'theme';
  if (/do you trust|trust this (?:folder|directory|workspace)|yes, I trust|is this a project you created/i.test(visible)) return 'trust';
  if (/not logged in|please (?:run )?\/login|sign in (?:to|with)|log in (?:to|with)|device (?:code|authorization)/i.test(visible)) return 'login';
  if (/update available|new version available|update (?:now|Codex|Claude)|upgrade (?:now|available)/i.test(visible)) return 'update';
  if (/press (?:enter|return) to continue|select (?:an|one) option|do you want to proceed/i.test(visible)) return 'unknown';
  return null;
}

function maskBossDiagnostic(value, host = {}) {
  let text = stripVTControlCharacters(String(value ?? ''));
  text = redactSecrets(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:device|authorization|login)[ _-]?code\s*[:=]\s*\S+/gi, 'code=[REDACTED]')
    .replace(/(?:\/home\/|\/Users\/|\/root(?:\/|\b)|~\/|[A-Z]:\\Users\\)[^\s"'<>]*/gi, '<home>')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<account>');
  for (const name of [host.hostname, host.factoryHostname, host.hostId]) {
    if (typeof name === 'string' && name) text = text.split(name).join('<host>');
  }
  return maskLine(text, host, true).trim().slice(0, 6000);
}

async function readBossPane(docker, name, pane) {
  for (const source of [['--source', 'detection'], []]) {
    try {
      const result = await herdrCall(docker, name, ['pane', 'read', pane, ...source, '--lines', '120', '--format', 'text']);
      return typeof result === 'string' ? result : result?.text ?? result?.output ?? '';
    } catch { /* Try the plain read next. */ }
  }
  return null;
}

function bossStartError(pane, text, stderr, host, dialog = startupDialog(text) ?? 'unknown') {
  return new Error(`The factory Boss could not start: ${dialog} dialog in pane ${pane}. Inspect this pane before you retry.\n` +
    `Pane text:\n${text === null ? '(capture unavailable)' : maskBossDiagnostic(text, host) || '(empty)'}\n` +
    `Prompt script stderr:\n${maskBossDiagnostic(stderr, host) || '(empty)'}`);
}

export function runBossPromptReadiness({
  herdr,
  wait = pause,
  harness,
  readText,
  isReady,
  deliverPrompt,
  resumeExisting = false,
  promptMarker,
  enterAttempts = 0,
}) {
  const ready = (timeoutMs) => {
    try {
      return Boolean(isReady
        ? isReady(timeoutMs)
        : waitForAgentReady('boss', harness, { herdr, readText, wait }, timeoutMs));
    } catch { return false; }
  };
  const readStatus = () => {
    try {
      const value = herdr(['agent', 'get', 'boss']);
      return (value.agent ?? value).agent_status ?? null;
    } catch { return null; }
  };
  const readTextSafe = () => {
    try { return readText('boss') || ''; } catch { return ''; }
  };

  let text = readTextSafe();
  if (startupDialog(text)) return { outcome: 'dialog', enterAttempts };
  const promptAlreadyPresent = text.includes(promptMarker);
  if (!ready(BOSS_PROMPT_RETRY_WAIT_MS) && !(resumeExisting && promptAlreadyPresent)) {
    return { outcome: 'not-ready', enterAttempts };
  }
  if (!promptAlreadyPresent && deliverPrompt) {
    try {
      if (deliverPrompt() === 'submitted') enterAttempts = 1;
    } catch {
      // The readiness check below decides whether the prompt was submitted.
      enterAttempts = 1;
    }
  }

  let isAgentReady = ready(BOSS_PROMPT_RETRY_WAIT_MS);
  let readyChecks = 0;
  let agentStatus = null;
  while (!isAgentReady && enterAttempts < BOSS_PROMPT_RETRY_LIMIT && readyChecks < BOSS_PROMPT_RETRY_LIMIT) {
    agentStatus = readStatus();
    text = readTextSafe();
    if (startupDialog(text)) return { outcome: 'dialog', enterAttempts };
    if (ready(1)) { isAgentReady = true; break; }
    if (['idle', 'done'].includes(agentStatus) && text.includes(promptMarker)) {
      try { herdr(['agent', 'send-keys', 'boss', 'enter']); } catch {}
      enterAttempts += 1;
    }
    readyChecks += 1;
    wait(BOSS_PROMPT_RETRY_WAIT_MS);
    isAgentReady = ready(1);
  }
  if (isAgentReady) return { outcome: 'ready', enterAttempts };

  agentStatus = readStatus();
  text = readTextSafe();
  return {
    outcome: ['idle', 'done'].includes(agentStatus) && text.includes(promptMarker) ? 'unsent' : 'failed',
    enterAttempts,
  };
}

function containerLabels(container) { return container?.Config?.Labels || container?.Labels || {}; }

function assertFactoryContainer(container, name) {
  assertOwned(container, name);
  const worker = containerLabels(container)[WORKER_LABEL];
  if (typeof worker !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(worker)) {
    throw new Error('The factory container has no matching factory and worker labels.');
  }
  if (!container.State?.Running || container.State?.Paused) throw new Error('The factory container must be running and unpaused.');
}

function parseArgs(args, { boss = false } = {}) {
  const positional = [];
  const flags = {};
  const allowed = boss ? ['--harness', '--resume', '--dry-run'] : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (!allowed.includes(token) || Object.hasOwn(flags, token)) throw new Error(boss
      ? 'Use factory boss start NAME [--harness claude|codex] [--resume] [--dry-run].'
      : 'Use factory login NAME HARNESS.');
    if (token === '--resume' || token === '--dry-run') flags[token] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('The harness option needs a value.');
      flags[token] = value;
    }
  }
  if (boss ? positional.length !== 1 : positional.length !== 2) throw new Error(boss
    ? 'Give exactly one factory name.'
    : 'Give one factory name and one harness.');
  return { positional, flags };
}

function decodeHerdr(output) {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('Herdr returned an invalid response.'); }
  return value?.result ?? value;
}

function rows(value, key) { return Array.isArray(value?.[key]) ? value[key] : Array.isArray(value) ? value : []; }
function workspaceId(value) { return value?.workspace_id ?? value?.workspaceId ?? value?.id ?? null; }
function paneId(value) { return value?.pane_id ?? value?.paneId ?? value?.id ?? null; }

async function herdrCall(docker, name, args) {
  const raw = await dockerCall(docker, ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', `hf-${name}`, 'herdr', ...args]);
  return decodeHerdr(raw);
}

async function dockerCall(docker, args) {
  const result = await docker.run(args);
  if (result.code !== 0) throw new Error('The factory Boss operation failed. Check the factory and try again.');
  return result.stdout;
}

async function inspectFactory(name, io) {
  const factory = managedFactory(io.env, name);
  const docker = transportFor(factory.host, io);
  const container = await inspect(docker, 'container', factory.record.containerName);
  if (!container) throw new Error('The factory container is missing.');
  assertFactoryContainer(container, name);
  return { ...factory, docker, diagnosticHost: { ...factory.host, hostname: container.Config?.Hostname, factoryHostname: factory.record.hostname } };
}

async function probeBoss(docker, name) {
  let workspaces;
  try { workspaces = rows(await herdrCall(docker, name, ['workspace', 'list']), 'workspaces'); }
  catch { throw new Error('The Herdr server is not running. Run factory configure NAME --resume.'); }
  const matches = workspaces.filter((item) => String(item.label || '').toLowerCase() === 'boss');
  if (matches.length > 1) throw new Error('More than one Boss workspace exists. Inspect the factory before you retry.');
  if (!matches.length) return { workspace: null, workspaceId: null, panes: [], pane: null, live: false };
  const workspace = matches[0];
  const id = workspaceId(workspace);
  if (!id) throw new Error('The Boss workspace has no ID. Inspect the factory before you retry.');
  const panes = rows(await herdrCall(docker, name, ['pane', 'list', '--workspace', id]), 'panes');
  const bosses = panes.filter((pane) => pane.label === 'boss');
  if (bosses.length > 1) throw new Error('More than one Boss pane exists. Inspect the factory before you retry.');
  const pane = bosses[0] || null;
  const status = pane?.agent_status ?? pane?.status ?? null;
  const live = !!pane?.agent && (!status || !['stopped', 'exited', 'closed', 'missing'].includes(status));
  return { workspace, workspaceId: id, panes, pane, live, state: status || (pane?.agent ? 'running' : 'pane-ready') };
}

async function hasTypedUnsentBossPrompt(docker, name, state) {
  const pane = paneId(state.pane);
  const workspace = state.workspaceId;
  if (!pane || !workspace) return false;
  const result = await docker.run([
    'exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', `HERDR_BOSS_DIR=${DATA_ROOT}`,
    '--env', 'HERDR_ENV=1', '--env', `HERDR_PANE_ID=${pane}`, '--env', `HERDR_WORKSPACE_ID=${workspace}`,
    `hf-${name}`, 'node', '--input-type=module', '-e', BOSS_RESUME_PROBE_SCRIPT, BOSS_PROMPT, BOSS_PROMPT_MARKER,
  ], { timeout: 20_000 });
  if (result.code !== 0) return false;
  try {
    const probe = JSON.parse(result.stdout);
    return probe.promptMarkerPresent === false && probe.promptTyped === true;
  } catch { return false; }
}

function safeProjectPath(value) {
  if (!path.isAbsolute(value) || value.includes('\0')) return false;
  const relative = path.relative(WORK_ROOT, path.resolve(value));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function kitCommand(name, cwd, command) {
  return ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', `HERDR_BOSS_DIR=${DATA_ROOT}`,
    '--workdir', cwd, `hf-${name}`, 'herdr-boss', ...command];
}

async function readFactoryRoots(docker, name) {
  const raw = await dockerCall(docker, ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', `HERDR_BOSS_DIR=${DATA_ROOT}`,
    `hf-${name}`, 'herdr-boss', 'project', 'paths', '--json']);
  let projects;
  try { projects = JSON.parse(raw); } catch { throw new Error('The factory project paths are invalid.'); }
  if (!Array.isArray(projects)) throw new Error('The factory project paths are invalid.');
  const roots = [...new Set([BOSS_ROOT, ...projects.map((project) => project?.path).filter((value) => typeof value === 'string')])];
  for (const cwd of roots) {
    if (cwd !== BOSS_ROOT && !safeProjectPath(cwd)) throw new Error('A project path is outside the factory work volume.');
  }
  return roots;
}

// The Boss and its projects live in the factory checkout and under the work volume root.
// The work root is a trusted folder too, but it is not a project, so it gets no kit files.
function trustRoots(roots) { return [...new Set([...roots, WORK_ROOT])]; }

async function prepareFactoryHarness(docker, name, harness, roots) {
  const script = `import { prepareHarnessHome } from '${BOSS_ROOT}/src/factory-harness-state.js';\nprepareHarnessHome(process.argv[1], JSON.parse(process.argv[2]));`;
  const result = await docker.run(['exec', '--user', 'factory', '--env', 'HOME=/home/factory',
    `hf-${name}`, 'node', '--input-type=module', '-e', script, harness, JSON.stringify(roots)]);
  if (result.code !== 0) throw new Error('The harness first-run state could not be prepared. Check the factory configuration.');
}

async function installFactoryKits(docker, name, roots) {
  for (const cwd of roots) {
    const check = await docker.run(kitCommand(name, cwd, ['check', 'agents']));
    if (check.code === 0) continue;
    const install = await docker.run(kitCommand(name, cwd, ['kit', 'install']));
    if (install.code !== 0) throw new Error('The Herdr Boss kit could not be installed in the factory.');
    const verify = await docker.run(kitCommand(name, cwd, ['check', 'agents']));
    if (verify.code !== 0) throw new Error('The Herdr Boss kit check failed after installation.');
  }
}

async function ensureBossPane(docker, name, state) {
  let workspace = state.workspace;
  let id = state.workspaceId;
  let pane = state.pane;
  if (!workspace) {
    const latest = await probeBoss(docker, name);
    if (latest.workspace) {
      workspace = latest.workspace;
      id = latest.workspaceId;
      state = latest;
      pane = latest.pane;
    } else {
      const result = await herdrCall(docker, name, ['workspace', 'create', '--cwd', BOSS_ROOT, '--label', 'Boss', '--no-focus']);
      workspace = result.workspace ?? result;
      id = workspaceId(workspace);
      if (!id) throw new Error('Herdr created a Boss workspace without an ID. Inspect the factory before you retry.');
      state = await probeBoss(docker, name);
      pane = state.pane;
      workspace = state.workspace ?? workspace;
      id = state.workspaceId ?? id;
    }
  }
  if (!pane) {
    const latest = await probeBoss(docker, name);
    if (latest.workspace) {
      workspace = latest.workspace;
      id = latest.workspaceId;
      state = latest;
      pane = latest.pane;
    }
  }
  if (!pane) {
    let created;
    try { created = await herdrCall(docker, name, ['tab', 'create', '--workspace', id, '--label', 'Boss', '--cwd', BOSS_ROOT, '--no-focus']); }
    catch { throw new Error('Herdr could not create a new Boss tab and pane. Inspect the Boss workspace and try again.'); }
    const root = created.root_pane ?? created.pane ?? created;
    const newPane = paneId(root);
    if (!newPane) throw new Error('Herdr created a Boss tab without a pane ID. Inspect the factory before you retry.');
    pane = { ...root, pane_id: newPane, workspace_id: id, label: root.label || '' };
  }
  const paneName = paneId(pane);
  if (!paneName) throw new Error('The Boss pane has no ID. Inspect the factory before you retry.');
  if (pane.label !== 'boss') {
    const newlyCreated = !state.panes.some((item) => paneId(item) === paneName);
    if (!newlyCreated) throw new Error('The Boss pane is not labeled boss. Inspect the Boss workspace before you retry.');
    try { await herdrCall(docker, name, ['pane', 'rename', paneName, 'boss']); }
    catch { throw new Error('Herdr created a new Boss tab but could not label the new Boss pane. Inspect the Boss workspace and try again.'); }
  }
  return { workspaceId: id, paneId: paneName };
}

async function startBossPrompt(docker, name, harness, { workspaceId: workspace, paneId: pane }, { resumeExisting = false, diagnosticHost } = {}) {
  const result = await docker.run([
    'exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', `HERDR_BOSS_DIR=${DATA_ROOT}`,
    '--env', 'HERDR_ENV=1', '--env', `HERDR_PANE_ID=${pane}`, '--env', `HERDR_WORKSPACE_ID=${workspace}`,
    '--env', 'USER=factory', '--workdir', BOSS_ROOT, `hf-${name}`, 'node', '--input-type=module', '-e', BOSS_PROMPT_SCRIPT,
    harness, pane, workspace, BOSS_PROMPT, String(resumeExisting),
  ], { timeout: 300_000 });
  const text = await readBossPane(docker, name, pane);
  const dialog = startupDialog(text);
  if (result.code !== 0 || dialog) throw bossStartError(pane, text, result.stderr, diagnosticHost, dialog ?? 'unknown');
  let outcome;
  try { outcome = JSON.parse(result.stdout); }
  catch { throw bossStartError(pane, text, result.stderr, diagnosticHost); }
  if (!['ready', 'unsent'].includes(outcome?.outcome)) throw bossStartError(pane, text, result.stderr, diagnosticHost);
  return outcome;
}

const MAILBOX_SCRIPT = String.raw`
import { openMessageStore } from '/home/factory/herdr-boss/src/message-store.js';
const [text] = process.argv.slice(1);
const dir = '/home/factory/.herdr-boss';
const store = openMessageStore({ dir });
const exists = store.all().some((item) => item.thread === 'boss' && item.from === 'boss' && item.to === 'owner' && item.kind === 'reply' && item.text === text && !item.closedAt);
if (!exists) store.append({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text, action: 'answer', replyTo: null, status: 'new' });
store.close?.();
`;

async function postOwnerWaitItem(docker, name, text) {
  await dockerCall(docker, ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', `HERDR_BOSS_DIR=${DATA_ROOT}`,
    `hf-${name}`, 'node', '--input-type=module', '-e', MAILBOX_SCRIPT, text]);
}

function loginItemText(name, harness) {
  return `The ${harness} login is not ready. Run \`herdr-boss factory login ${name} ${harness}\` at an Owner terminal, then run \`herdr-boss factory boss start ${name} --resume\`.`;
}

function promptItemText(name) {
  return `The Boss prompt in factory ${name} is still unsent. Check the Boss pane, then run \`herdr-boss factory boss start ${name} --resume\`.`;
}

function dryRunText(name, harness, resume) {
  const displayHarness = harness === 'claude' ? 'Claude' : 'Codex';
  const lines = [
    `Factory boss start ${name} with ${displayHarness}:`,
    'Return the live Boss pane and its state before starting a new session.',
    `1. Check the ${displayHarness} login. If it is missing, post one Mailbox item with the factory login command.`,
    '2. Check and install the Herdr Boss kit in the Boss folder and registered project folders.',
    '3. Check the Herdr server and create or reuse the Boss workspace and pane.',
    '4. Start the harness with the factory Boss prompt and kit rules.',
    '5. Check for a ready prompt. Retry a verified Enter at most 3 times, 20 seconds apart.',
  ];
  if (resume) lines.push('Resume from the first step that still needs work.');
  return `${lines.join('\n')}\n`;
}

// Run an interactive harness login in the labeled factory container. The terminal stays attached, so the command captures no output.
function runHarnessLogin(docker, containerName, command) {
  return docker.run(['exec', '-it', '--user', 'factory', containerName, ...command], { interactive: true, timeout: LOGIN_TIMEOUT_MS });
}

async function openCodeLogin(name, io) {
  try {
    const { record, docker } = await inspectFactory(name, io);
    await runHarnessLogin(docker, record.containerName, ['opencode', 'auth', 'login']);
    const count = await openCodeCredentialCount(docker, name);
    if (count > 0) {
      io.stdout.write(`OpenCode: logged in in factory ${name} (${count} ${count === 1 ? 'credential' : 'credentials'})\n`);
      return 0;
    }
    io.stdout.write(`${openCodeMissingLine(name)}\n`);
    return 3;
  } catch {
    io.stdout.write('failed\n');
    return 1;
  }
}

export async function factoryLoginCommand(args, io) {
  const { positional } = parseArgs(args);
  const [name, harness] = positional;
  assertName(name);
  if (!['claude', 'codex', 'opencode'].includes(harness)) throw new Error('Choose the Claude, Codex, or OpenCode harness.');
  if (harness === 'opencode') return openCodeLogin(name, io);
  try {
    const { record, docker } = await inspectFactory(name, io);
    const command = harness === 'claude' ? ['claude', 'auth', 'login'] : ['codex', 'login', '--device-auth'];
    const result = await runHarnessLogin(docker, record.containerName, command);
    const verified = await verifyHarnessLogin(docker, name, harness);
    const ok = result.code === 0 && verified;
    if (ok) {
      await prepareFactoryHarness(docker, name, harness, trustRoots(await readFactoryRoots(docker, name)));
      await ensureFactoryGitIdentity(docker, name);
    }
    io.stdout.write(`${ok ? 'ok' : 'failed'}\n`);
    return ok ? 0 : 1;
  } catch {
    io.stdout.write('failed\n');
    return 1;
  }
}

export async function factoryBossStart(args, io) {
  const { positional, flags } = parseArgs(args, { boss: true });
  const [name] = positional;
  assertName(name);
  const harness = flags['--harness'] ?? 'claude';
  if (!['claude', 'codex'].includes(harness)) throw new Error('--harness must be claude or codex.');
  const resume = flags['--resume'] === true;
  if (flags['--dry-run']) {
    managedFactory(io.env, name);
    io.stdout.write(dryRunText(name, harness, resume));
    return 0;
  }

  const { docker, diagnosticHost } = await inspectFactory(name, io);
  const existing = await probeBoss(docker, name);
  let resumeExisting = false;
  if (existing.live) {
    if (['blocked', 'unknown', 'idle'].includes(existing.state)) {
      const text = await readBossPane(docker, name, paneId(existing.pane));
      if (startupDialog(text)) throw bossStartError(paneId(existing.pane), text, '', diagnosticHost);
    }
    if (resume && existing.pane?.agent === harness && existing.state === 'idle') {
      resumeExisting = await hasTypedUnsentBossPrompt(docker, name, existing);
    }
    if (!resumeExisting) {
      io.stdout.write(`Boss is ${existing.state} in pane ${paneId(existing.pane)}.\n`);
      return 0;
    }
  }
  if (existing.pane?.agent && !existing.live) throw new Error(`The Boss pane is ${existing.state}. Inspect it before you retry.`);

  if (!(await verifyHarnessLogin(docker, name, harness))) {
    await postOwnerWaitItem(docker, name, loginItemText(name, harness));
    io.stdout.write(`Factory ${name}: ${harness} login is required. A Mailbox item names the Owner command.\n`);
    return 3;
  }
  const roots = await readFactoryRoots(docker, name);
  await prepareFactoryHarness(docker, name, harness, trustRoots(roots));
  await ensureFactoryGitIdentity(docker, name);
  await installFactoryKits(docker, name, roots);
  const bossPane = await ensureBossPane(docker, name, existing);
  const result = await startBossPrompt(docker, name, harness, bossPane, { resumeExisting, diagnosticHost });
  if (result?.outcome === 'ready') {
    io.stdout.write(`Started the ${harness} Boss in pane ${bossPane.paneId}.\n`);
    return 0;
  }
  if (result?.outcome === 'unsent') {
    await postOwnerWaitItem(docker, name, promptItemText(name));
    io.stdout.write(`Factory ${name}: the Boss prompt is still unsent. A Mailbox item names the resume command.\n`);
    return 3;
  }
  throw new Error('The Boss prompt did not reach a ready input prompt. Inspect the Boss pane before you retry.');
}

export async function factoryBossCommand(args, io) {
  const [action, ...rest] = args;
  if (action !== 'start') throw new Error('Use factory boss start NAME [--harness claude|codex] [--resume] [--dry-run].');
  return factoryBossStart(rest, io);
}
