// Factory updates use Docker as the only host boundary. Private state stays in the factory volumes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultFactoryImage, FACTORY_LABEL, managedFactory, transportFor, inspect, dockerCall, readHealth, imageBuildMeta, configSafetyError } from './factory-core.js';
import { assertName, factoryFile, readPrivate, writePrivate, updateFleet, VOLUMES } from './factory-store.js';
import { restoreBackupInPlace } from './factory-recovery.js';
import { KIT_MANAGED_PATHS } from './kit/workers.js';
import { ensureFactoryGitIdentity } from './factory-role.js';
import { ensureClaudeHelper } from './factory-claude-install.js';
import { ensureCodexbar } from './factory-codexbar-install.js';
import { syncFactoryHarness } from './factory-harness.js';

const WORKER_LABEL = 'herdr-factory-spike';
const OWNER_NAME = /^(?=.{1,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
const STATE_SCRIPT = `const fs=require('node:fs');const base='/home/factory/.herdr-boss/';const s=JSON.parse(fs.readFileSync(base+'state.json','utf8'));let h=[];try{h=JSON.parse(fs.readFileSync(base+'handoffs.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}const orchestrators=Object.values(s.control?.projects||{}).filter(p=>p?.orch?.kind).map(p=>({slug:p.slug,workspace:p.workspace,pane:p.orch.pane,kind:p.orch.kind,mode:p.effectiveMode||p.mode||'auto',role:'project'}));console.log(JSON.stringify({updatedAt:s.updatedAt,workers:s.control?.runningWorkers,locks:s.locks,handoffs:h.map(x=>x.status),errors:s.errors,orchestrators,bossPane:Boolean(s.control?.bossHandoff?.pane)}));`;
const SCHEMA_SCRIPT = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/factory/.herdr-boss/herdr-boss.db',{readOnly:true});try{console.log(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_version').get().version)}finally{db.close()}`;
const START_ORCHESTRATORS_SCRIPT = `
import fs from 'node:fs';
import { loadPolicy } from '/home/factory/herdr-boss/src/control.js';
import { handoffTarget, successorAgentArgs } from '/home/factory/herdr-boss/src/handoff.js';
import { loadModels } from '/home/factory/herdr-boss/src/kit/config.js';
import { cleanGoal, goalPromptText } from '/home/factory/herdr-boss/src/goal.js';
import { createHerdrRunner, deliverPrompt, waitForWorkerPane } from '/home/factory/herdr-boss/src/kit/workers.js';

const candidates = JSON.parse(process.argv[1]);
const herdr = createHerdrRunner();
const rows = (value, key) => Array.isArray(value?.[key]) ? value[key] : Array.isArray(value) ? value : [];
const wid = (value) => value?.workspace_id ?? value?.workspaceId ?? value?.id ?? null;
const pid = (value) => value?.pane_id ?? value?.paneId ?? value?.id ?? null;
const policy = loadPolicy({ warn: () => {} });
const models = loadModels();
const started = [];

for (const candidate of candidates) {
  const label = candidate.slug;
  let workspaces = rows(herdr(['workspace', 'list']), 'workspaces');
  let workspace = workspaces.find((item) => wid(item) === candidate.workspace);
  if (!workspace) {
    const matches = workspaces.filter((item) => String(item.label || '').toLowerCase() === label.toLowerCase());
    if (matches.length > 1) throw new Error('More than one workspace matches an orchestrator.');
    workspace = matches[0] || null;
  }

  let newPane = null;
  let newTab = null;
  if (!workspace) {
    const created = herdr(['workspace', 'create', '--cwd', candidate.cwd, '--label', label, '--no-focus']);
    workspace = created?.workspace ?? created;
    newPane = pid(created?.root_pane ?? created?.pane);
    newTab = created?.tab?.tab_id ?? created?.root_pane?.tab_id ?? created?.tab_id ?? null;
  }
  const workspaceId = wid(workspace);
  if (!workspaceId) throw new Error('Herdr did not return an orchestrator workspace.');

  const oldLabel = 'orch';
  const previousLabel = 'orch previous';
  const oldPanes = rows(herdr(['pane', 'list', '--workspace', workspaceId]), 'panes').filter((pane) => pane.label === oldLabel);
  for (const pane of oldPanes) {
    const id = pid(pane);
    if (id) herdr(['pane', 'rename', id, previousLabel]);
  }

  if (!newPane) {
    const created = herdr(['tab', 'create', '--workspace', workspaceId, '--label', 'Orchestrator Next', '--cwd', candidate.cwd,
      '--env', 'DISABLE_UPDATE_PROMPT=true', '--env', 'DISABLE_AUTO_UPDATE=true', '--no-focus']);
    newPane = created?.root_pane?.pane_id ?? created?.pane?.pane_id ?? created?.root_pane?.id;
    newTab = created?.tab?.tab_id ?? created?.root_pane?.tab_id ?? created?.tab_id ?? null;
  }
  if (!newPane) throw new Error('Herdr created an orchestrator tab without a root pane.');
  waitForWorkerPane(newPane, workspaceId, candidate.cwd, herdr, undefined, { retryCommand: 'factory update', timeoutMs: 20000 });
  herdr(['pane', 'rename', newPane, oldLabel]);

  const projectPolicy = policy.projects?.[candidate.slug] || {};
  const choices = [{ kind: candidate.kind }, ...(policy.orchestratorLadder || [])];
  let target = null;
  for (const choice of choices) {
    if (!choice?.kind || projectPolicy.excludedKinds?.includes(choice.kind) || projectPolicy.excludedModels?.includes(choice.model)) continue;
    try {
      const next = { kind: choice.kind, ...handoffTarget(choice.kind, {
        ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}),
      }, policy, models) };
      if (!projectPolicy.excludedModels?.includes(next.model)) { target = next; break; }
    } catch {}
  }
  if (!target) throw new Error('No allowed orchestrator harness can restart an orchestrator.');

  const launch = successorAgentArgs({ toKind: target.kind, project: candidate.slug,
    newPane, newTab, workspace: workspaceId }, target.launchArgs, process.env, { browserLookup: () => null, output: () => {} });
  const name = candidate.slug + '-orch';
  herdr(['agent', 'start', name, '--kind', target.kind, '--pane', newPane, '--', ...launch]);

  const statusFile = '/home/factory/.herdr-boss/projects/' + candidate.slug + '.json';
  let status = {};
  let hasStatus = false;
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); hasStatus = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasStatus && status.workspace !== workspaceId) {
    status.workspace = workspaceId;
    const temporary = statusFile + '.update.tmp';
    fs.writeFileSync(temporary, JSON.stringify(status) + '\\n', { mode: 0o600 });
    fs.renameSync(temporary, statusFile);
  }
  const goal = cleanGoal(status.goal) || cleanGoal(policy.defaultOrchestratorGoal);
  const roleText = 'You are the fresh project orchestrator for ' + candidate.slug + ' after a factory image update. Read AGENTS.md, docs/orchestration/memory.md, and docs/orchestration/herdr-boss.md. Inspect the published project status, repository, and existing work before you act. Resume the current approved goal and task. Do not repeat completed work.';
  const goalText = goal ? '\\n' + goalPromptText({ goal, kind: target.kind, autoCommand: false }) : '';
  deliverPrompt(name, '[herdr-boss] ' + roleText + goalText, 'fresh orchestrator after factory image update', { herdr, kind: target.kind });
  started.push({ role: candidate.role, slug: candidate.slug, kind: target.kind });
}

console.log(JSON.stringify({ started }));
`;
const DATA_LOSS_MESSAGE = 'Rollback after a data migration needs --accept-data-loss.';

function bossGoneMessage(name) {
  return `The Boss pane is gone. Run 'herdr-boss factory boss start ${name}' to start the Boss in the factory.\n`;
}

function parse(args) {
  const positional = [], flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!word.startsWith('--')) { positional.push(word); continue; }
    if (!['--tier', '--dry-run', '--accept-data-loss', '--allow-boss-restart'].includes(word) || Object.hasOwn(flags, word)) throw new Error('Invalid factory update option.');
    if (word === '--dry-run' || word === '--accept-data-loss' || word === '--allow-boss-restart') flags[word] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('The factory update tier needs a value.');
      flags[word] = value;
    }
  }
  return { positional, flags };
}

function workerOwner(container, name) {
  const labels = container?.Config?.Labels || {};
  const owner = labels[WORKER_LABEL];
  if (labels[FACTORY_LABEL] !== name || !OWNER_NAME.test(owner || '')) throw new Error('The factory container has no matching factory and worker labels.');
  return owner;
}

async function updateResources(factory, docker, name, { allowStopped = false, missingOwner = null } = {}) {
  const container = await inspect(docker, 'container', factory.record.containerName);
  if (!container && !missingOwner) throw new Error('The factory container is missing.');
  const owner = container ? workerOwner(container, name) : missingOwner;
  if (!OWNER_NAME.test(owner || '')) throw new Error('The factory update owner record is invalid.');
  const unsafe = container ? configSafetyError(container, name) : null;
  if (unsafe) throw new Error(unsafe);
  for (const kind of Object.keys(VOLUMES)) {
    const volume = await inspect(docker, 'volume', `hf-${name}-${kind}`);
    const labels = volume?.Labels || volume?.Config?.Labels || {};
    if (labels[FACTORY_LABEL] !== name || labels[WORKER_LABEL] !== owner) throw new Error('A factory volume has no matching factory and worker labels.');
  }
  if (container && !allowStopped && (!container.State?.Running || container.State?.Paused)) throw new Error('The factory must be running and unpaused before an update.');
  return { container, owner };
}

// The service writes the state file about every 30 seconds. A stopped service writes nothing,
// so a snapshot after the stop is measured against the stop time.
const STATE_MAX_AGE_MS = 60_000;
const stoppedAt = new Map();
// A backup helper that cannot be removed keeps the container paused on purpose.
const pausedByDesign = new Set();

async function snapshot(docker, name) {
  const raw = await dockerCall(docker, ['exec', '--user', 'factory', `hf-${name}`, 'node', '-e', STATE_SCRIPT]);
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error('The factory work state is not valid.'); }
  const updated = Date.parse(state.updatedAt);
  if (!Number.isFinite(updated) || updated > Date.now() + 30_000 || (stoppedAt.get(name) ?? Date.now()) - updated > STATE_MAX_AGE_MS
    || !Number.isInteger(state.workers) || state.workers < 0 || !Array.isArray(state.locks) || !Array.isArray(state.handoffs) || !Array.isArray(state.errors) || !Array.isArray(state.orchestrators) || typeof state.bossPane !== 'boolean') {
    throw new Error('The factory cannot prove that work is idle.');
  }
  for (const project of state.orchestrators) {
    if (!project || !['project', 'boss'].includes(project.role) || (project.role === 'boss' ? project.slug !== 'boss' : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project.slug || ''))
      || !validHerdrId(project.workspace) || !validHerdrId(project.pane) || !['claude', 'codex', 'opencode', 'pi'].includes(project.kind) || typeof project.mode !== 'string') {
      throw new Error('The factory cannot prove which project orchestrators are active.');
    }
  }
  return state;
}

function validHerdrId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/.test(value); }

async function captureOrchestrators(docker, name, state) {
  const candidates = [];
  for (const project of state.orchestrators) {
    if (project.role === 'project' && project.mode === 'paused') continue;
    let response;
    try {
      const value = JSON.parse(await dockerCall(docker, ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', `hf-${name}`, 'herdr', 'pane', 'get', project.pane]));
      response = value?.result ?? value;
    }
    catch { throw new Error('The active project orchestrators could not be inspected before the image update.'); }
    const pane = response?.pane ?? response;
    const workspace = pane?.workspace_id ?? pane?.workspaceId;
    const cwd = pane?.foreground_cwd ?? pane?.cwd;
    const label = project.role === 'boss' ? 'boss' : 'orch';
    if ((pane?.pane_id ?? pane?.paneId ?? pane?.id) !== project.pane || workspace !== project.workspace || pane?.label !== label || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error('The active project orchestrator record does not match its Herdr pane.');
    }
    candidates.push({ slug: project.slug, workspace: project.workspace, pane: project.pane, kind: project.kind, mode: project.mode, role: project.role, cwd });
  }
  return candidates;
}

function validateOrchestrators(candidates) {
  if (!Array.isArray(candidates)) throw new Error('The saved orchestrator list is invalid.');
  for (const project of candidates) {
    if (!project || !['project', 'boss'].includes(project.role) || (project.role === 'boss' ? project.slug !== 'boss' : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project.slug || ''))
      || !validHerdrId(project.workspace) || !validHerdrId(project.pane)
      || !['claude', 'codex', 'opencode', 'pi'].includes(project.kind) || typeof project.cwd !== 'string' || !path.isAbsolute(project.cwd)
      || /[\u0000-\u001f\u007f]/.test(project.cwd)) throw new Error('The saved orchestrator list is invalid.');
  }
  return candidates;
}

async function startFreshOrchestrators(docker, name, candidates) {
  const projects = validateOrchestrators(candidates).filter((candidate) => candidate.role === 'project');
  if (!projects.length) return;
  await dockerCall(docker, ['exec', '--user', 'factory', '--env', 'HOME=/home/factory', '--env', 'USER=factory', '--env', 'HERDR_BOSS_DIR=/home/factory/.herdr-boss', `hf-${name}`, 'node', '--input-type=module', '-e', START_ORCHESTRATORS_SCRIPT, JSON.stringify(projects)], { timeout: 600_000 });
}

function assertIdle(state) {
  if (state.workers > 0) throw new Error('A worker is working. Wait for it to finish before updating the factory.');
  if (state.locks.some((lock) => lock?.name === 'full-suite' && lock.state === 'live' && ['suite', 'push'].includes(lock.kind))) {
    throw new Error('A suite or push holds the full-suite lock. Wait for it to finish before updating the factory.');
  }
  if (state.handoffs.some((status) => ['prepared', 'preparing', 'needs-inspection'].includes(status))) {
    throw new Error('A handover is prepared or in progress. Finish it before updating the factory.');
  }
}

function assertBossAllowed(state, tier, allowBossRestart) {
  if (tier === 'image' && state.bossPane && !allowBossRestart) {
    throw new Error('A Boss pane is live. Repeat the image update with --allow-boss-restart; the update will not start a Boss session.');
  }
}

async function assertUpdateStillSafe(docker, name, tier, allowBossRestart) {
  const state = await snapshot(docker, name);
  assertIdle(state);
  assertBossAllowed(state, tier, allowBossRestart);
  return state;
}

function resumePath(name, tier) {
  return `The factory was resumed. Run 'herdr-boss factory configure ${name} --resume' to check it, then retry the ${tier} update.`;
}

async function abortBeforeChange(docker, name, tier, error) {
  try { await resume(docker, name); }
  catch (resumeError) {
    throw new Error(`${error.message} The factory could not resume: ${resumeError.message} Run 'herdr-boss factory configure ${name} --resume' to check it.`);
  }
  throw new Error(`${error.message} ${resumePath(name, tier)}`);
}

async function raw(docker, args, options) { return docker.run(args, options); }

// The s6 tools are not in PATH inside the container.
const S6_SVC = '/command/s6-svc';
const S6_SVSTAT = '/command/s6-svstat';

// The code volume belongs to the user factory. Git refuses a repository that another user owns.
function gitArgs(name, args) {
  return ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', `hf-${name}`, 'git', '-C', '/home/factory/herdr-boss', ...args];
}

async function gitText(docker, name, args) {
  return dockerCall(docker, gitArgs(name, args));
}

// Name the failing step. The Docker error text holds no step and the step text holds no private data.
async function runStep(label, hint, action) {
  try { return await action(); }
  catch (error) { throw new Error(`The factory update failed at the ${label} step.${hint ? ` ${hint}` : ''}`, { cause: error }); }
}

function stripCredentials(text) { return String(text).trim().replace(/\/\/[^/@\s]*@/, '//'); }

function normalizeUrl(url) { return url.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase(); }

// The expected origin is the public repository of this Herdr Boss checkout, without credentials.
function expectedOriginUrl(io) {
  let configured = io.originUrl;
  if (!configured) {
    try {
      const repository = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).repository;
      configured = typeof repository === 'string' ? repository : repository?.url;
    } catch {}
  }
  if (!configured) {
    const result = spawnSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (result.status === 0) configured = result.stdout.trim();
  }
  if (!configured) throw new Error('The Herdr Boss repository URL is unknown. The factory update cannot set the origin remote.');
  let parsed;
  try { parsed = new URL(configured.replace(/^git\+/, '')); } catch { throw new Error('The Herdr Boss repository URL is not an HTTPS URL.'); }
  if (parsed.protocol !== 'https:') throw new Error('The Herdr Boss repository URL is not an HTTPS URL.');
  parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
  return parsed.href;
}

async function ensureOrigin(docker, name, expected) {
  const current = await raw(docker, gitArgs(name, ['remote', 'get-url', 'origin']));
  if (current.code !== 0) {
    await runStep('git remote add', '', () => gitText(docker, name, ['remote', 'add', 'origin', expected]));
    return;
  }
  const found = stripCredentials(current.stdout);
  if (normalizeUrl(found) !== normalizeUrl(expected)) {
    throw new Error(`The factory origin remote differs from the Herdr Boss repository. Expected ${expected}. Found ${found}. Fix the remote before the update.`);
  }
}

async function schemaVersion(docker, name) {
  const result = await raw(docker, ['exec', `hf-${name}`, 'node', '-e', SCHEMA_SCRIPT]);
  if (result.code !== 0 || !/^\d+\s*$/.test(result.stdout)) return null;
  return Number(result.stdout.trim());
}

async function serviceState(docker, name) {
  const result = await raw(docker, ['exec', `hf-${name}`, S6_SVSTAT, '-o', 'up', '/run/service/herdr-boss-serve']);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function waitFor(docker, name, predicate, message, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() <= end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

async function quiesce(docker, name, timeoutMs = 10_000, pauseContainer = true) {
  stoppedAt.set(name, Date.now());
  await dockerCall(docker, ['exec', `hf-${name}`, S6_SVC, '-d', '/run/service/herdr-boss-serve']);
  await waitFor(docker, name, async () => (await serviceState(docker, name)) === 'false', 'The factory service did not stop.', timeoutMs);
  if (pauseContainer) await dockerCall(docker, ['pause', `hf-${name}`]);
}

// `stoppedAt` stays set until `factoryUpdateCommand` ends. `recoverService` reads it after each resume.
async function resume(docker, name) {
  const container = await inspect(docker, 'container', `hf-${name}`);
  if (container?.State?.Paused) await dockerCall(docker, ['unpause', `hf-${name}`]);
  await dockerCall(docker, ['exec', `hf-${name}`, S6_SVC, '-u', '/run/service/herdr-boss-serve']);
}

// The update stops the factory service. Every path that stops it starts it again, whatever fails later.
// The command names the host the way the Owner reaches it: a plain docker command for the local host,
// `factory docker HOST` for a registered host. The container name is hf-NAME in both forms.
function dockerCommand(factory, name, words) {
  const { host } = factory;
  if (host.transport === 'local') {
    const context = host.dockerContext || (host.runtime === 'orbstack' ? 'orbstack' : '');
    return `docker ${context ? `--context ${context} ` : ''}${words}`;
  }
  return `herdr-boss factory docker ${host.hostId} -- ${words}`;
}

function recoveryHint(factory, name, kept = false) {
  const start = dockerCommand(factory, name, `exec hf-${name} ${S6_SVC} -u /run/service/herdr-boss-serve`);
  const state = `herdr-boss factory status ${name}`;
  if (kept) return `The factory container stays paused. Repair the archive helper, then run '${dockerCommand(factory, name, `unpause hf-${name}`)}' and '${start}'. Then run '${state}' to check the state.`;
  return `The factory service is not answering. Run '${start}' to start it. Then run '${state}' to check the state. Retry the update only after the service writes a new state file.`;
}

// Return null when the service runs and answers /api/health. Return a message when it stays down.
// Run it after every failure that follows the stop, whether or not an earlier step resumed the service.
async function recoverService(docker, name, factory, timeoutMs) {
  if (!stoppedAt.has(name)) return null;
  if (pausedByDesign.has(name)) return recoveryHint(factory, name, true);
  try {
    if (await serviceState(docker, name) !== 'true') await resume(docker, name);
    await waitFor(docker, name, async () => { try { await readHealth(docker, name); return true; } catch { return false; } },
      'The factory service did not answer /api/health.', timeoutMs);
    return null;
  } catch (error) { return `${error.message} ${recoveryHint(factory, name)}`; }
}

async function createBackup(name, docker, io) {
  await factoryRecoveryBackup(name, { ...io, updateQuiescedBackup: true });
  const receipt = readPrivate(factoryFile(io.env, name, 'backup.json'), null);
  if (!receipt?.file || !receipt?.sha256) throw new Error('The private update backup receipt is missing.');
  return receipt;
}

async function takeQuiescedBackup(name, docker, io) {
  try {
    const receipt = await createBackup(name, docker, io);
    await dockerCall(docker, ['unpause', `hf-${name}`]);
    return receipt;
  } catch (error) {
    // A helper cleanup failure keeps the source paused for repair. For any other error,
    // `recoverService` returns the quiesced service to its running state and reports a failure.
    if (/archive helper cleanup failed/i.test(error.message)) pausedByDesign.add(name);
    throw error;
  }
}

async function waitForCleanTick(docker, name, before, timeoutMs = 30_000) {
  const cutoff = Date.now() + timeoutMs;
  while (Date.now() <= cutoff) {
    const route = await raw(docker, ['exec', `hf-${name}`, 'curl', '-fsS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', 'http://127.0.0.1:4477/api/state'], { timeout: 2_000 });
    if (route.code === 0 && route.stdout.trim() === '200') {
      try {
        const state = await snapshot(docker, name);
        if (Date.parse(state.updatedAt) > Date.parse(before.updatedAt) && state.errors.length === 0) return await readHealth(docker, name);
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The updated service did not return /api/state 200 and one clean tick within 30 seconds.');
}

function updateRecord(name, factory, health, imageTag = factory.local.imageTag, imageMeta = factory.local.image) {
  updateFleet(factory.io.env, (fleet) => {
    const record = fleet.factories.find((item) => item.name === name);
    if (!record) throw new Error('The factory registration is missing.');
    record.version = health.version;
    record.kitRevision = health.kitRevision;
    if (imageMeta) record.image = imageMeta;
  });
  writePrivate(factoryFile(factory.io.env, name), { ...factory.local, imageTag, version: health.version, kitRevision: health.kitRevision, ...(imageMeta ? { image: imageMeta } : {}) });
}

function pendingFile(env, name) { return factoryFile(env, name, 'update-pending.json'); }

function validatePending(pending, factory) {
  const validBase = pending && typeof pending === 'object' && pending.schema === 1
    && ['service', 'image'].includes(pending.tier) && typeof pending.backupFile === 'string' && path.isAbsolute(pending.backupFile)
    && Number.isInteger(pending.schemaVersion) && pending.schemaVersion >= 0
    && Number.isFinite(Date.parse(pending.beforeUpdatedAt));
  if (!validBase) throw new Error('The pending factory update record is invalid.');
  if (pending.tier === 'service' && !/^[a-f0-9]{40,64}$/i.test(pending.oldCommit || '')) throw new Error('The pending factory update record is invalid.');
  if (pending.tier === 'image' && (pending.oldImageTag !== factory.local.imageTag || !OWNER_NAME.test(pending.resourceOwner || '') || !Array.isArray(pending.orchestrators) || typeof pending.bossPane !== 'boolean')) {
    throw new Error('The pending factory update record is invalid.');
  }
}

async function rollbackService(name, docker, io, original, backup, acceptDataLoss) {
  const currentSchema = await schemaVersion(docker, name);
  await quiesce(docker, name, io.updateTimeoutMs ?? 10_000);
  const schemaIncreased = currentSchema !== null && currentSchema > original.schemaVersion;
  const schemaUnreadable = currentSchema === null;
  const dataRisk = schemaIncreased || schemaUnreadable;
  const dataLossMessage = schemaUnreadable
    ? 'The factory database schema is unreadable. Rollback status is unknown; repeat with --accept-data-loss to restore the private backup.'
    : DATA_LOSS_MESSAGE;
  if (dataRisk && !acceptDataLoss) {
    writePrivate(pendingFile(io.env, name), { schema: 1, tier: 'service', oldCommit: original.commit, schemaVersion: original.schemaVersion, schemaState: schemaUnreadable ? 'unreadable' : 'increased', backupFile: backup.file, beforeUpdatedAt: original.state.updatedAt, createdAt: new Date().toISOString() });
    // `recoverService` resumes again when this resume fails, and reports the failure.
    await resume(docker, name).catch(() => {});
    throw new Error(dataLossMessage);
  }
  if (dataRisk) await restoreBackupInPlace(name, backup.file, io);
  await dockerCall(docker, ['unpause', `hf-${name}`]);
  await gitText(docker, name, ['reset', '--keep', original.commit]);
  const before = await snapshot(docker, name).catch(() => original.state);
  await dockerCall(docker, ['exec', `hf-${name}`, S6_SVC, '-u', '/run/service/herdr-boss-serve']);
  return waitForCleanTick(docker, name, before, io.updateTimeoutMs ?? 30_000);
}

function containerCreateArgs(name, record, host, owner, imageTag) {
  const args = ['container', 'create', '--name', record.containerName, '--hostname', `${name}.localhost`, '--label', `${FACTORY_LABEL}=${name}`, '--label', `${WORKER_LABEL}=${owner}`,
    '--restart', 'unless-stopped', '--cpus', '4', '--memory', host.transport === 'local' ? '4g' : '8g', '--memory-swap', host.transport === 'local' ? '4g' : '8g', '--pids-limit', '512', '--shm-size', '1g',
    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '-p', `127.0.0.1:${record.ports.dashboard}:4477`, '-p', `127.0.0.1:${record.ports.ssh}:22`,
    '--security-opt', `seccomp=${new URL('../factory/seccomp-codex.json', import.meta.url).pathname}`, '--security-opt', 'systempaths=unconfined'];
  for (const [kind, target] of Object.entries(VOLUMES)) args.push('--mount', `type=volume,source=hf-${name}-${kind},target=${target}`);
  args.push(imageTag);
  return args;
}

async function removeOwnedContainer(docker, name, owner) {
  const container = await inspect(docker, 'container', `hf-${name}`);
  if (!container) return;
  if (workerOwner(container, name) !== owner) throw new Error('The factory container labels changed.');
  if (container.State?.Running) await dockerCall(docker, ['stop', '--time', '30', `hf-${name}`]);
  const current = await inspect(docker, 'container', `hf-${name}`);
  if (!current || workerOwner(current, name) !== owner || current.Id !== container.Id) throw new Error('The factory container changed. Retry the update.');
  await dockerCall(docker, ['container', 'rm', `hf-${name}`]);
}

async function recreate(docker, name, record, host, owner, imageTag, onStartAttempt = () => {}) {
  await dockerCall(docker, containerCreateArgs(name, record, host, owner, imageTag));
  const created = await inspect(docker, 'container', record.containerName);
  if (!created || workerOwner(created, name) !== owner) throw new Error('The replacement factory container has no matching labels.');
  const unsafe = configSafetyError(created, name);
  if (unsafe) throw new Error(unsafe);
  onStartAttempt();
  await dockerCall(docker, ['start', record.containerName]);
}

// Read and save documentation inside the factory. Only saved paths leave the factory.
const SAVE_UPDATE_NOTES_SCRIPT = `
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const files = JSON.parse(process.argv[1]);
const memory = 'docs/orchestration/memory.md';
const notesFile = '/home/factory/work/boss-notes/memory.md';
const patchDir = '/home/factory/work/boss-notes/update-patches';
const gitDiff = (args, paths) => execFileSync('git', ['-C', '/home/factory/herdr-boss', '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...args, '--', ...paths], { maxBuffer: 32 * 1024 * 1024 });
const patches = [];
const documents = files.filter(file => file !== memory);
const added = [];
for (const phase of [{ args: ['--cached'], suffix: '-index' }, { args: [], suffix: '' }]) {
  if (documents.length) {
    const patch = gitDiff([...phase.args, '--binary'], documents);
    if (patch.length) {
      fs.mkdirSync(patchDir, { recursive: true, mode: 0o700 });
      const file = patchDir + '/' + new Date().toISOString().replaceAll(':', '-') + '-' + randomBytes(6).toString('hex') + phase.suffix + '.patch';
      fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 });
      patches.push(file);
    }
  }
  const diff = files.includes(memory) ? gitDiff([...phase.args, '--unified=0'], [memory]).toString('utf8') : '';
  let inHunk = false;
  for (const line of diff.split('\\n')) {
    if (line.startsWith('@@ ')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added.push(line.slice(1));
  }
}
if (added.length) {
  fs.mkdirSync('/home/factory/work/boss-notes', { recursive: true, mode: 0o700 });
  fs.appendFileSync(notesFile, added.join('\\n') + '\\n', { mode: 0o600 });
}
console.log(JSON.stringify({ patches, notesFile: added.length ? notesFile : null }));
`;

// Save local documentation before restoring the files that would block the fast-forward.
async function saveLocalDocumentation(docker, name, io) {
  const status = await runStep('git status', '', () => gitText(docker, name, ['status', '--porcelain', '-z', '--untracked-files=no']));
  const entries = status.split('\0');
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    paths.add(entry.slice(3));
    // Porcelain -z puts the old path after a rename or copy, without a status prefix.
    if (/[RC]/.test(entry.slice(0, 2))) {
      const oldPath = entries[++index];
      if (entry.slice(0, 2).includes('R')) paths.add(oldPath);
    }
  }
  const changed = [...paths];
  const documents = changed.filter(file => /\.(?:md|markdown|rst|adoc|txt)$/i.test(file) || /^(?:README|LICENSE|COPYING)$/.test(file));
  const source = changed.filter(file => !documents.includes(file) && !KIT_MANAGED_PATHS.includes(file));
  if (source.length) {
    const quoted = source.map(file => "'" + file.replaceAll("'", "'\\''") + "'").join(' ');
    const patch = '~/work/boss-notes/update-patches/local-changes-' + new Date().toISOString().replaceAll(':', '-') + '.patch';
    const command = `mkdir -p ~/work/boss-notes/update-patches && git -C /home/factory/herdr-boss diff --binary HEAD -- ${quoted} > ${patch}`;
    throw new Error(`Local changes are not documentation: ${source.map(file => JSON.stringify(file)).join(', ')}. Save them in the factory with: ${command}`);
  }
  if (documents.length) {
    const saved = JSON.parse(await runStep('save local documentation', 'The local files were kept.', () => dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', `hf-${name}`, 'node', '--input-type=module', '-e', SAVE_UPDATE_NOTES_SCRIPT, JSON.stringify(documents)])));
    for (const file of saved.patches) io.stdout.write(`Saved local documentation patch: ${file}.\n`);
    if (saved.notesFile) io.stdout.write(`Saved local memory notes: ${saved.notesFile}.\n`);
  }
  return changed.filter(file => documents.includes(file) || KIT_MANAGED_PATHS.includes(file));
}

async function updateService(name, factory, docker, owner, flags, initial) {
  const expectedOrigin = expectedOriginUrl(factory.io);
  const commit = (await runStep('git rev-parse', '', () => gitText(docker, name, ['rev-parse', 'HEAD']))).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('The factory code revision is invalid.');
  await ensureOrigin(docker, name, expectedOrigin);
  await runStep('git fetch', 'The factory cannot reach the remote.', () => gitText(docker, name, ['fetch', 'origin', 'main']));
  const ancestor = await raw(docker, gitArgs(name, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']));
  if (ancestor.code !== 0) throw new Error('The factory code update is not a fast-forward.');
  const schema = await schemaVersion(docker, name);
  if (schema === null) throw new Error('The factory database version cannot be read.');
  const original = { commit, schemaVersion: schema, state: initial };
  const timeoutMs = factory.io.updateTimeoutMs ?? 30_000;
  let backup = null;
  let mergeStarted = false;
  let failure = null;
  try {
    await quiesce(docker, name, factory.io.updateTimeoutMs ?? 10_000, false);
    // Include the saved files in the work-volume backup so a migration rollback keeps them.
    let documents;
    try { documents = await saveLocalDocumentation(docker, name, factory.io); }
    catch (error) { await abortBeforeChange(docker, name, 'service', error); }
    await dockerCall(docker, ['pause', `hf-${name}`]);
    backup = await takeQuiescedBackup(name, docker, factory.io);
    await assertUpdateStillSafe(docker, name, 'service', false);
    if (documents.length) await runStep('git restore', '', () => gitText(docker, name, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...documents]));
    mergeStarted = true;
    await runStep('git merge', '', () => gitText(docker, name, ['merge', '--ff-only', 'FETCH_HEAD']));
    await runStep('kit install', '', () => dockerCall(docker, ['exec', '--user', 'factory', '-e', 'HOME=/home/factory', '--workdir', '/home/factory/herdr-boss', `hf-${name}`, 'herdr-boss', 'kit', 'install']));
    await runStep('harness setup', '', () => syncFactoryHarness(docker, name, factory.io));
    await runStep('git identity', '', () => ensureFactoryGitIdentity(docker, name));
    await runStep('restart', '', () => dockerCall(docker, ['exec', `hf-${name}`, S6_SVC, '-u', '/run/service/herdr-boss-serve']));
    const health = await waitForCleanTick(docker, name, initial, timeoutMs);
    updateRecord(name, factory, health);
    fs.rmSync(pendingFile(factory.io.env, name), { force: true });
    await ensureClaudeHelper(docker, name, factory.io);
    await ensureCodexbar(docker, name, factory.io);
    factory.io.stdout.write(`Updated factory ${name} service. Idle panes remain available.\n`);
    return 0;
  } catch (error) { failure = error; }
  let ending = '';
  if (mergeStarted) {
    try {
      const health = await rollbackService(name, docker, factory.io, original, backup, flags['--accept-data-loss'] === true);
      updateRecord(name, factory, health);
      fs.rmSync(pendingFile(factory.io.env, name), { force: true });
      ending = 'The factory service was rolled back.';
    } catch (rollbackError) { failure = new Error(`${failure.message} ${rollbackError.message}`); }
  } else if (backup) {
    try { await resume(docker, name); ending = resumePath(name, 'service'); }
    catch (resumeError) { ending = `The factory could not resume: ${resumeError.message} Run 'herdr-boss factory configure ${name} --resume' to check it.`; }
  }
  // `factoryUpdateCommand` checks the service and appends the recovery hint when it does not answer.
  throw new Error(`${failure.message} ${ending}`.trimEnd());
}

async function updateImage(name, factory, docker, owner, flags, initial, orchestrators, bossPane) {
  const imageTag = defaultFactoryImage();
  if (imageTag === factory.local.imageTag) throw new Error('The pinned factory image is already current.');
  const image = await inspect(docker, 'image', imageTag);
  if (!image) throw new Error('The factory image is missing. Run factory build NAME before the image update.');
  const imageMeta = imageBuildMeta(image);
  if (imageMeta.pinsHash === factory.local.image?.pinsHash) throw new Error('The pinned factory image is already current.');
  const oldSchema = await schemaVersion(docker, name);
  if (oldSchema === null) throw new Error('The factory database version cannot be read.');
  await quiesce(docker, name, factory.io.updateTimeoutMs ?? 10_000);
  const backup = await takeQuiescedBackup(name, docker, factory.io);
  await runImageUpdate({ name, factory, docker, owner, flags, initial, orchestrators, bossPane, backup, oldSchema, imageTag, imageMeta });
  return 0;
}

async function runImageUpdate({ name, factory, docker, owner, flags, initial, orchestrators, bossPane, backup, oldSchema, imageTag, imageMeta }) {
  let replacementStartAttempted = false;
  const onStartAttempt = () => { replacementStartAttempted = true; };
  try {
    await assertUpdateStillSafe(docker, name, 'image', flags['--allow-boss-restart'] === true);
    await removeOwnedContainer(docker, name, owner);
    await recreate(docker, name, factory.record, factory.host, owner, imageTag, onStartAttempt);
    const health = await waitForCleanTick(docker, name, initial, factory.io.updateTimeoutMs ?? 30_000);
    await startFreshOrchestrators(docker, name, orchestrators);
    updateRecord(name, factory, health, imageTag, { builtAt: imageMeta.builtAt, pinsHash: imageMeta.pinsHash });
    fs.rmSync(pendingFile(factory.io.env, name), { force: true });
    factory.io.stdout.write(`Updated factory ${name} image and started ${orchestrators.length} fresh orchestrator session${orchestrators.length === 1 ? '' : 's'}.\n`);
    if (bossPane) factory.io.stdout.write(bossGoneMessage(name));
    return 0;
  } catch (error) {
    const current = await inspect(docker, 'container', factory.record.containerName).catch(() => null);
    if (current?.Config?.Image === factory.local.imageTag) return abortBeforeChange(docker, name, 'image', error);
    const startedAt = Date.parse(current?.State?.StartedAt || '');
    const replacementStarted = replacementStartAttempted && (!current || current.State?.Running || (Number.isFinite(startedAt) && startedAt > 0));
    const currentSchema = replacementStarted ? await schemaVersion(docker, name) : null;
    const schemaIncreased = replacementStarted && currentSchema !== null && currentSchema > oldSchema;
    const schemaUnreadable = replacementStarted && currentSchema === null;
    const dataRisk = schemaIncreased || schemaUnreadable;
    const dataLossMessage = schemaUnreadable
      ? 'The replacement factory database schema is unreadable. Rollback status is unknown; repeat with --accept-data-loss to restore the private backup.'
      : DATA_LOSS_MESSAGE;
    if (dataRisk && flags['--accept-data-loss'] !== true) {
      writePrivate(pendingFile(factory.io.env, name), { schema: 1, tier: 'image', oldImageTag: factory.local.imageTag, schemaVersion: oldSchema, schemaState: schemaUnreadable ? 'unreadable' : 'increased', backupFile: backup.file, beforeUpdatedAt: initial.updatedAt, resourceOwner: owner, orchestrators, bossPane, createdAt: new Date().toISOString() });
      if (bossPane) factory.io.stdout.write(bossGoneMessage(name));
      throw new Error(`${error.message} ${dataLossMessage}`);
    }
    try {
      if (dataRisk) {
        const current = await inspect(docker, 'container', factory.record.containerName);
        if (current?.State?.Running) await dockerCall(docker, ['stop', '--time', '30', `hf-${name}`]);
        await restoreBackupInPlace(name, backup.file, factory.io);
      }
      await removeOwnedContainer(docker, name, owner);
      await recreate(docker, name, factory.record, factory.host, owner, factory.local.imageTag);
      const health = await waitForCleanTick(docker, name, initial, factory.io.updateTimeoutMs ?? 30_000);
      await startFreshOrchestrators(docker, name, orchestrators);
      updateRecord(name, factory, health);
      fs.rmSync(pendingFile(factory.io.env, name), { force: true });
      if (bossPane) factory.io.stdout.write(bossGoneMessage(name));
    } catch (rollbackError) { throw new Error(`${error.message} Rollback failed: ${rollbackError.message}`); }
    throw new Error(`${error.message} The factory image was rolled back.`);
  }
}

async function pendingRollback(name, factory, docker, owner, pending, acceptDataLoss) {
  if (!acceptDataLoss) {
    if (pending.schemaState === 'unreadable') throw new Error('The factory database schema is unreadable. Rollback status is unknown; repeat with --accept-data-loss to restore the private backup.');
    throw new Error(DATA_LOSS_MESSAGE);
  }
  if (pending.tier === 'service') {
    const container = await inspect(docker, 'container', factory.record.containerName);
    if (!container?.State?.Running) throw new Error('Start the factory container, then repeat its pending service rollback.');
    if (container.State?.Paused) await dockerCall(docker, ['unpause', factory.record.containerName]);
    const health = await rollbackService(name, docker, factory.io, { commit: pending.oldCommit, schemaVersion: pending.schemaVersion, state: { updatedAt: pending.beforeUpdatedAt } }, { file: pending.backupFile }, true);
    updateRecord(name, factory, health);
  } else if (pending.tier === 'image') {
    const orchestrators = validateOrchestrators(pending.orchestrators);
    const before = { updatedAt: pending.beforeUpdatedAt };
    const container = await inspect(docker, 'container', factory.record.containerName);
    if (container?.State?.Running) await dockerCall(docker, ['stop', '--time', '30', factory.record.containerName]);
    await restoreBackupInPlace(name, pending.backupFile, factory.io);
    await removeOwnedContainer(docker, name, owner);
    await recreate(docker, name, factory.record, factory.host, owner, pending.oldImageTag);
    const health = await waitForCleanTick(docker, name, before, factory.io.updateTimeoutMs ?? 30_000);
    await startFreshOrchestrators(docker, name, orchestrators);
    updateRecord(name, factory, health);
  } else throw new Error('The pending factory update record is invalid.');
  fs.rmSync(pendingFile(factory.io.env, name), { force: true });
  factory.io.stdout.write(`Rolled back factory ${name} from its private update backup.\n`);
  if (pending.tier === 'image' && pending.bossPane) factory.io.stdout.write(bossGoneMessage(name));
  return 0;
}

async function factoryRecoveryBackup(name, io) {
  const { factoryRecoveryCommand } = await import('./factory-recovery.js');
  return factoryRecoveryCommand(['backup', name, '--include-home'], io);
}

// The update stops the factory service. When a step after the stop fails, start the service again,
// check /api/health, and name the recovery commands only when the service still does not answer.
export async function factoryUpdateCommand(args, io) {
  let name;
  let factory;
  try { return await runFactoryUpdate(args, io, (value) => { factory = value; name = value.name; }); }
  catch (error) {
    const recovery = factory ? await recoverService(factory.docker, name, factory, factory.io.updateTimeoutMs ?? 30_000) : null;
    throw recovery ? new Error(`${error.message} ${recovery}`) : error;
  } finally {
    if (name) { stoppedAt.delete(name); pausedByDesign.delete(name); }
  }
}

async function runFactoryUpdate(args, io, track) {
  const { positional, flags } = parse(args);
  if (positional.length !== 1) throw new Error('Give exactly one factory name.');
  const name = positional[0]; assertName(name);
  const tier = flags['--tier'];
  if (!['service', 'image'].includes(tier)) throw new Error('Choose --tier service or image.');
  if (flags['--allow-boss-restart'] && tier !== 'image') throw new Error('--allow-boss-restart is only valid with --tier image.');
  const factory = managedFactory(io.env, name);
  factory.io = io;
  factory.name = name;
  const docker = transportFor(factory.host, io);
  factory.docker = docker;
  track(factory);
  const pending = readPrivate(pendingFile(io.env, name), null);
  if (flags['--dry-run'] && flags['--accept-data-loss']) throw new Error('Use --dry-run or --accept-data-loss, not both.');
  if (pending) validatePending(pending, factory);
  if (pending && pending.tier !== tier) throw new Error(`A ${pending.tier} rollback is pending. Repeat factory update with --tier ${pending.tier}.`);
  const { container, owner } = await updateResources(factory, docker, name, pending?.tier === 'image'
    ? { allowStopped: true, missingOwner: pending.resourceOwner }
    : {});
  if (pending?.tier === 'image' && owner !== pending.resourceOwner) throw new Error('The pending factory update owner does not match the labeled resources.');
  if (pending) {
    if (flags['--dry-run']) {
      io.stdout.write(`A ${pending.tier} rollback is pending for factory ${name}. No factory resources changed.\n`);
      return 0;
    }
    if (pending.tier === 'service' || (container?.State?.Running && !container.State?.Paused)) {
      const state = await snapshot(docker, name);
      assertIdle(state);
    }
    return pendingRollback(name, factory, docker, owner, pending, flags['--accept-data-loss'] === true);
  }
  const state = await snapshot(docker, name);
  assertIdle(state);
  assertBossAllowed(state, tier, flags['--allow-boss-restart'] === true);
  if (flags['--dry-run']) {
    if (tier === 'image') {
      if (defaultFactoryImage() === factory.local.imageTag) throw new Error('The pinned factory image is already current.');
      const image = await inspect(docker, 'image', defaultFactoryImage());
      if (!image) throw new Error('The factory image is missing. Run factory build NAME before the image update.');
      if (imageBuildMeta(image).pinsHash === factory.local.image?.pinsHash) throw new Error('The pinned factory image is already current.');
    }
    io.stdout.write(`Would update factory ${name} at the ${tier} tier. No factory resources changed.\n`);
    return 0;
  }
  const readCommit = async () => {
    try {
      const value = (await gitText(docker, name, ['rev-parse', 'HEAD'])).trim();
      return /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
    } catch { return null; }
  };
  const beforeCommit = await readCommit();
  if (tier === 'service') {
    const result = await updateService(name, factory, docker, owner, flags, state);
    if (result === 0) {
      const afterCommit = await readCommit();
      io.stdout.write(`Commit: ${beforeCommit?.slice(0, 7) || 'unknown'} -> ${afterCommit?.slice(0, 7) || 'unknown'}.\n`);
    }
    return result;
  }
  const orchestrators = await captureOrchestrators(docker, name, state);
  const result = await updateImage(name, factory, docker, owner, flags, state, orchestrators, state.bossPane);
  if (result === 0) {
    const afterCommit = await readCommit();
    io.stdout.write(`Commit: ${beforeCommit?.slice(0, 7) || 'unknown'} -> ${afterCommit?.slice(0, 7) || 'unknown'}.\n`);
  }
  return result;
}
