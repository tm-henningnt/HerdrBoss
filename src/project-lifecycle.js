// Open, park, archive, and unarchive records in the project register.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DATA_DIR } from './config.js';
import { readMessages, appendMessage, isMailboxItem } from './messages.js';
import { loadProjectConfig } from './kit/config.js';
import { FULL_SUITE_LOCK, listProjectLocks, withMutationLock } from './kit/locks.js';
import { PROJECT_BROWSER_POOL_NAME, readLeases } from './leases.js';
import { projectTransferRefusal, readProjectTransferLock } from './project-transfer-locks.js';
import { runProjectStep, readFlowState } from './project-new.js';
import { checkProject, formatCheck } from './project-new-check.js';
import { verifyProjectCaller } from './project-caller.js';
import { appendForcedAction, forceReason } from './force-audit.js';
import { SLUG, appendAudit, localFactory, readRegister, withRegisterLock, writeRegister } from './project-register.js';

const OPEN_STEPS = ['folder', 'kit', 'policy', 'register', 'workspace', 'harness'];
const PARK_CHECKS = ['workers', 'prompt', 'git', 'locks', 'status', 'memory', 'owner'];
const TEN_MINUTES = 10 * 60 * 1000;
const WAIT_STEP_MS = 2000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rows = (response, key) => (Array.isArray(response?.[key]) ? response[key] : Array.isArray(response) ? response : []);
const idOf = (row) => row?.workspace_id ?? row?.workspaceId ?? row?.id ?? null;
const paneOf = (row) => row?.pane_id ?? row?.paneId ?? row?.id ?? null;
const agentOf = (row) => row?.name ?? row?.agent_name ?? row?.agentName ?? null;

function usage(action) {
  if (action === 'open') return 'Usage: project open SLUG [--start] [--force --reason TEXT] [--dry-run]';
  if (action === 'park') return 'Usage: project park SLUG [--prepare] [--dry-run]';
  return `Usage: project ${action} SLUG [--dry-run]`;
}

function parseArgs(action, args) {
  const allowed = action === 'open' ? ['--start', '--force', '--dry-run']
    : action === 'park' ? ['--prepare', '--dry-run'] : ['--dry-run'];
  const flags = new Set();
  let reason;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (action === 'open' && arg === '--reason') {
      if (reason !== undefined) throw new Error(`--reason may be used only once. ${usage(action)}`);
      reason = args[++index];
      if (reason === undefined || reason.startsWith('--')) throw new Error(`--reason needs text. ${usage(action)}`);
      continue;
    }
    if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}. ${usage(action)}`);
    if (flags.has(arg)) throw new Error(`${arg} may be used only once. ${usage(action)}`);
    flags.add(arg);
  }
  if (positional.length !== 1) throw new Error(`Give exactly one slug. ${usage(action)}`);
  if (!SLUG.test(positional[0])) throw new Error(`The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${usage(action)}`);
  const safeReason = action === 'open' ? forceReason(flags.has('--force'), reason) : null;
  return {
    slug: positional[0],
    start: flags.has('--start'),
    force: flags.has('--force'),
    reason: safeReason,
    prepare: flags.has('--prepare'),
    dryRun: flags.has('--dry-run'),
  };
}

function actionLockDirectory(dataDir, slug) {
  return path.join(dataDir, 'locks', 'project-lifecycle', slug);
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Keep an action lock across asynchronous browser checks. The mutation guard protects lock creation and release.
function takeActionLock(dataDir, slug) {
  const directory = actionLockDirectory(dataDir, slug);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ownerFile = path.join(directory, 'owner.json');
  return withMutationLock(directory, () => {
    try {
      const old = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (pidIsAlive(old.pid)) throw new Error(`A project action for ${slug} is already running. Retry when it finishes.`);
      fs.unlinkSync(ownerFile);
    } catch (error) {
      if (error.code !== 'ENOENT' && !/already running/.test(error.message)) throw error;
      if (/already running/.test(error.message)) throw error;
    }
    const owner = { pid: process.pid, token: crypto.randomUUID(), at: new Date().toISOString() };
    const fd = fs.openSync(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`); fs.fchmodSync(fd, 0o600); }
    finally { fs.closeSync(fd); }
    return owner;
  }, { waitMs: 0, busyMessage: `A project action for ${slug} is already starting. Retry when it finishes.` });
}

function releaseActionLock(dataDir, slug, owner) {
  const directory = actionLockDirectory(dataDir, slug);
  const ownerFile = path.join(directory, 'owner.json');
  return withMutationLock(directory, () => {
    let current;
    try { current = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (current.pid !== owner.pid || current.token !== owner.token) throw new Error(`The project action lock for ${slug} changed. Refusing to release it.`);
    fs.unlinkSync(ownerFile);
  }, { waitMs: 0, busyMessage: `A project action for ${slug} is still changing its lock.` });
}

async function withActionLock(dataDir, slug, operation) {
  const owner = takeActionLock(dataDir, slug);
  try { return await operation(); }
  finally { releaseActionLock(dataDir, slug, owner); }
}

function findRecord(slug, dataDir) {
  const record = readRegister(dataDir).projects.find((item) => item.slug === slug);
  if (!record) throw new Error(`${slug} is not in the project register. Run herdr-boss project register add ${slug} first.`);
  return record;
}

function assertFactory(record, dataDir) {
  const factory = localFactory(dataDir);
  if (record.factory !== factory) throw new Error(`Project ${record.slug} belongs to factory ${record.factory}. Run this command on that factory.`);
}

function writeRecord(slug, dataDir, action, update, { result = 'done', failedCheck = null, by = 'owner-cli', now = Date.now, write = writeRegister } = {}) {
  return withRegisterLock(dataDir, () => {
    const register = readRegister(dataDir);
    const index = register.projects.findIndex((item) => item.slug === slug);
    if (index < 0) throw new Error(`${slug} is no longer in the project register.`);
    const previous = register.projects[index];
    register.projects[index] = update({ ...previous });
    write(register, dataDir);
    try {
      appendAudit(slug, action, dataDir, { result, failedCheck, by, dryRun: false, at: new Date(now()).toISOString() });
    } catch (error) {
      register.projects[index] = previous;
      try { write(register, dataDir); }
      catch { throw new Error(`The ${action} audit line could not be written, and the register change could not be reverted.`); }
      throw error;
    }
    return register.projects[index];
  });
}

function logCheck(check, log) {
  for (const line of formatCheck(check)) log(line);
}

function missingSteps(check) {
  const needed = new Set();
  for (const item of check.items) {
    if (item.ok) continue;
    if (OPEN_STEPS.includes(item.fix)) needed.add(item.fix);
  }
  return OPEN_STEPS.filter((step) => needed.has(step));
}

function checkProjectForOpen(slug, options, requireWorkspace = false) {
  return (options.checkProject ?? checkProject)(slug, {
    dataDir: options.dataDir,
    home: options.flowOptions.home,
    env: options.env,
    herdr: options.herdr,
    requireWorkspace,
  });
}

function stepResult(step, slug, options) {
  if (step === 'workspace' && options.startProject) {
    return options.startProject({ slug, start: true, dataDir: options.dataDir, herdr: options.herdr, env: options.env, hooks: options.hooks, ...options.flowOptions });
  }
  return (options.runProjectStep ?? runProjectStep)(step, {
    slug,
    start: step === 'workspace' && options.start,
    dataDir: options.dataDir,
    herdr: options.herdr,
    env: options.env,
    hooks: options.hooks,
    ...options.flowOptions,
  });
}

function printStep(step, slug, outcome, log) {
  const detail = outcome?.step?.detail ?? outcome?.error ?? 'done';
  log(`Fix ${step} for ${slug}`);
  log(`  ${step.padEnd(10)}${outcome?.step?.status ?? (outcome?.ok === false ? 'failed' : 'done')}${detail && detail !== 'done' ? ` ${detail}` : ''}`);
  for (const line of outcome?.step?.lines ?? []) log(`    ${line}`);
}

function remainingOpenFailures(check, start) {
  return check.items.filter((item) => !item.ok
    && !(!start && ['workspace', 'orchestrator'].includes(item.name)));
}

function nextAction(slug, record, dataDir) {
  if (record.nextAction) return record.nextAction;
  try {
    const status = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${slug}.json`), 'utf8'));
    if (typeof status.ask === 'string' && status.ask) return status.ask;
    const task = status.tasks?.find((item) => item?.frontier === 'current') ?? status.tasks?.find((item) => item?.status === 'doing');
    if (task?.title) return task.title;
  } catch {}
  return 'Continue from the published project status.';
}

function openProject(parsed, options) {
  const { slug, dataDir, log } = { ...parsed, ...options };
  const operate = () => {
    const record = findRecord(slug, dataDir);
    assertFactory(record, dataDir);
    if (record.state === 'archived') throw new Error(`Project ${slug} is archived. Run herdr-boss project unarchive ${slug} first.`);
    if (record.state === 'open') { log(`Project ${slug} is already open.`); return 0; }
    let transfer;
    try { transfer = readProjectTransferLock(slug, { dataDir }); }
    catch (error) { throw error; }
    if (transfer) throw new Error(`Project ${slug} has an open transfer. Finish or cancel the transfer before opening it.`);
    const transferRefusal = projectTransferRefusal(slug, { dataDir });
    if (transferRefusal) throw new Error(transferRefusal);
    const registerSettings = options.registerSettings ?? {};
    const cap = registerSettings.cap ?? options.cap ?? 3;
    const capCountsPinned = registerSettings.capCountsPinned ?? false;
    const projects = readRegister(dataDir).projects;
    const open = projects.filter((item) => ['open', 'parking'].includes(item.state)
      && (capCountsPinned || !item.pinned)).length;
    if (!parsed.force && open >= cap) {
      const current = projects.filter((item) => item.state === 'open').map((item) => item.slug);
      throw new Error(`The open project cap is ${cap}. Open projects: ${current.join(', ')}. Park one project or use --force --reason TEXT for an authorized override.`);
    }
    if (parsed.force && open >= cap && !parsed.dryRun) appendForcedAction({
      dataDir,
      time: new Date(options.now()).toISOString(),
      command: 'project open',
      project: slug,
      workerName: null,
      refusalKind: 'open-project-cap',
      reason: parsed.reason,
    });

    const first = checkProjectForOpen(slug, options, parsed.start);
    logCheck(first, log);
    if (parsed.dryRun) {
      log(`Dry run: project ${slug} stays parked. No lock, step, register change, or audit line was written.`);
      const steps = missingSteps(first);
      for (const step of OPEN_STEPS) {
        if (step === 'workspace' && !parsed.start) log('  workspace skipped: add --start to start the project lead.');
        else log(`  ${steps.includes(step) ? `would fix ${step}` : `already present: ${step}`}`);
      }
      return 0;
    }

    const steps = missingSteps(first);
    let failedStep = null;
    for (const step of steps) {
      if (step === 'workspace' && !parsed.start) {
        log('  workspace start skipped: add --start to start the project lead.');
        continue;
      }
      const outcome = stepResult(step, slug, { ...options, start: parsed.start });
      printStep(step, slug, outcome, log);
      if (!outcome || outcome.ok === false || outcome.step?.status === 'failed' || outcome.waiting) {
        failedStep = step;
        break;
      }
    }

    const final = checkProjectForOpen(slug, options, parsed.start);
    logCheck(final, log);
    const unresolved = remainingOpenFailures(final, parsed.start);
    if (!failedStep && unresolved.length) failedStep = unresolved[0].name;
    if (failedStep) {
      appendAudit(slug, 'open', dataDir, { result: 'failed', failedCheck: failedStep, by: options.auditBy ?? 'owner-cli' });
      const item = final.items.find((candidate) => candidate.name === failedStep);
      log(`Open stopped at ${failedStep}. The project stays parked.`);
      if (item?.fix) log(`Next: herdr-boss project check ${slug} --fix ${item.fix}${item.fix === 'workspace' ? ' --start' : ''}`);
      return 1;
    }

    writeRecord(slug, dataDir, 'open', (current) => ({ ...current, state: 'open', lastOpenedAt: new Date(options.now()).toISOString() }), { now: options.now, by: options.auditBy ?? 'owner-cli' });
    log(`Opened ${slug}.`);
    log(`Next action: ${nextAction(slug, record, dataDir)}`);
    return 0;
  };
  if (parsed.dryRun) return operate();
  return operate();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function projectStatus(slug, dataDir) {
  return readJson(path.join(dataDir, 'projects', `${slug}.json`));
}

function resolveRecordedWorkspace(slug, record, status, flow, herdr, options) {
  const expectedId = status?.workspace ?? flow?.ids?.workspaceId ?? null;
  if (typeof expectedId !== 'string' || !expectedId) throw new Error('The project has no saved Herdr workspace ID. Refusing to close a workspace by its label.');
  const workspaces = rows(herdr(['workspace', 'list']), 'workspaces');
  const workspace = workspaces.find((item) => idOf(item) === expectedId);
  const runDir = (options.projectConfig ?? loadProjectConfig({ cwd: record.repo })).runsPath;
  const runFiles = listRunRecords(runDir);
  if (!workspace) return { id: expectedId, workspace: null, panes: [], agents: [], runFiles };
  if (workspace.label !== slug) throw new Error(`Saved workspace ${expectedId} does not belong to ${slug}. Refusing to close it.`);
  if (workspace.label?.toLowerCase() === 'boss') throw new Error('The Boss workspace cannot be parked.');
  const panes = rows(herdr(['pane', 'list', '--workspace', expectedId]), 'panes');
  const agents = rows(herdr(['agent', 'list']), 'agents');
  const allowedPanes = new Set(runFiles.map((run) => run.pane).filter(Boolean));
  for (const pane of panes) {
    const name = pane.agent_name ?? pane.agentName ?? agentOf(pane);
    const lead = pane.label === 'orch' && name === `${slug}-orch`;
    if (!lead && !allowedPanes.has(paneOf(pane))) throw new Error('The project workspace has a pane that is not its lead or a recorded worker. Refusing to close it.');
  }
  return { id: expectedId, workspace, panes, agents, runFiles };
}

function listRunRecords(runsPath) {
  let names;
  try { names = fs.readdirSync(runsPath).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.map((name) => {
    const file = path.join(runsPath, name);
    let run;
    try { run = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('A worker run record cannot be read. Refusing to park the project.'); }
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('A worker run record is invalid. Refusing to park the project.');
    return run;
  });
}

function agentStatusFor(pane, agents) {
  const id = paneOf(pane);
  const name = pane.agent_name ?? pane.agentName ?? agentOf(pane);
  return agents.find((agent) => paneOf(agent) === id || (name && agentOf(agent) === name)) ?? null;
}

function waitingForInput(agent, pane) {
  const status = agent?.agent_status ?? pane?.agent_status ?? pane?.status;
  return status === 'blocked' || agent?.waiting_for_input === true || agent?.waitingForInput === true
    || pane?.waiting_for_input === true || pane?.waitingForInput === true
    || agent?.permission_prompt === true || pane?.permission_prompt === true;
}

function parseTime(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

function gitAt(repo, args, options) {
  if (options.git) return options.git(repo, args);
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function auditMailboxBlocked(status, dataDir) {
  const tasks = Array.isArray(status?.tasks) ? status.tasks : [];
  const waiting = tasks.filter((task) => task?.waitingOn === 'owner' && task.status === 'blocked'
    && typeof task.mailboxId === 'string' && task.mailboxId);
  if (!waiting.length) return null;
  const messages = readMessages({ dir: dataDir });
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const task of waiting) {
    const item = byId.get(task.mailboxId);
    if (!item || !isMailboxItem(item) || item.closedAt) continue;
    const answered = messages.some((message) => message.from === 'owner' && message.replyTo === item.id);
    if (!answered) return task.mailboxId;
  }
  return null;
}

function inspectPark(slug, record, options) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const dataDir = options.dataDir;
  const status = projectStatus(slug, dataDir);
  let workspaceInfo = null;
  let runFiles = [];
  let herdrError = null;
  try {
    if (!record.repo) throw new Error('The project has no repository path in the register.');
    const flow = readFlowState(dataDir, slug);
    workspaceInfo = resolveRecordedWorkspace(slug, record, status, flow, options.herdr, options);
    runFiles = workspaceInfo.runFiles ?? [];
  } catch (error) { herdrError = error; }

  if (herdrError) {
    add('workers', false, `cannot confirm project workers: ${herdrError.message}`);
    add('prompt', false, 'cannot confirm project prompts. Check Herdr, then retry.');
  } else {
    const liveRuns = runFiles.filter((run) => !run.finishedAt);
    const workingPanes = (workspaceInfo?.panes ?? []).filter((pane) => (agentStatusFor(pane, workspaceInfo.agents)?.agent_status
      ?? pane.agent_status ?? pane.status) === 'working');
    add('workers', liveRuns.length === 0 && workingPanes.length === 0, liveRuns.length || workingPanes.length
      ? 'a project worker or lead is still working.' : 'no project worker or lead is working.');
    const blocked = (workspaceInfo?.panes ?? []).some((pane) => waitingForInput(agentStatusFor(pane, workspaceInfo.agents), pane));
    add('prompt', !blocked, blocked ? 'a project pane waits for an answer or permission prompt.' : 'no project pane waits for input.');
  }

  const clean = gitAt(record.repo, ['status', '--porcelain'], options);
  const ahead = gitAt(record.repo, ['log', '@{u}..', '--oneline'], options);
  add('git', clean === '' && ahead === '', clean === null || ahead === null
    ? 'Git could not confirm a clean, pushed main checkout.'
    : clean !== '' ? 'the main checkout has uncommitted changes.'
      : ahead !== '' ? 'the main checkout has commits that are not on its upstream.' : 'the main checkout is clean and pushed.');

  let locks = null;
  let leases = null;
  try {
    const config = options.projectConfig ?? loadProjectConfig({ cwd: record.repo, home: options.flowOptions.home });
    locks = (options.listProjectLocks ?? listProjectLocks)({
      config, env: options.env, herdr: options.herdr, dataDir, output: () => {},
    });
    leases = (options.readLeases ?? readLeases)(dataDir).leases;
  } catch { /* An unreadable lock or lease list fails the check. */ }
  if (!Array.isArray(locks) || !Array.isArray(leases)) add('locks', false, 'lock or lease state could not be read.');
  else {
    const held = locks.filter((lock) => lock.project === slug && lock.state === 'live');
    const tickets = locks.flatMap((lock) => lock.name === FULL_SUITE_LOCK ? (lock.queue ?? []) : [])
      .filter((ticket) => ticket.project === slug);
    const projectLeases = leases.filter((lease) => lease.project === slug && lease.pool !== PROJECT_BROWSER_POOL_NAME);
    const busy = held.length > 0 || tickets.length > 0 || projectLeases.length > 0;
    add('locks', !busy, busy ? 'the project holds a live lock, a lock ticket, or a lease.' : 'the project holds no lock, ticket, or non-browser lease.');
  }

  const updated = parseTime(status?.updated);
  const lastCommitText = gitAt(record.repo, ['log', '-1', '--format=%cI'], options);
  const lastCommit = parseTime(lastCommitText);
  const lastWorkerEnd = Math.max(0, ...runFiles.map((run) => parseTime(run.finishedAt)).filter((value) => value !== null));
  const statusOk = updated !== null && lastCommit !== null && updated > lastCommit && updated > lastWorkerEnd;
  add('status', statusOk, statusOk ? 'the published status is newer than the last commit and worker.'
    : 'publish a status that is newer than the last commit and worker end.');

  const memoryDirty = gitAt(record.repo, ['status', '--porcelain', '--', 'docs/orchestration/memory.md'], options);
  const memoryCommitText = gitAt(record.repo, ['log', '-1', '--format=%cI', '--', 'docs/orchestration/memory.md'], options);
  const memoryCommit = parseTime(memoryCommitText);
  const memoryOk = memoryDirty === '' && memoryCommit !== null && memoryCommit >= lastWorkerEnd;
  add('memory', memoryOk, memoryOk ? 'the project memory is committed and current.'
    : 'commit the project memory after the last worker end.');

  let ownerBlock = null;
  try { ownerBlock = auditMailboxBlocked(status, dataDir); }
  catch { ownerBlock = 'unreadable'; }
  add('owner', !ownerBlock, ownerBlock ? 'a blocking Owner mailbox item is unanswered.' : 'no blocking Owner mailbox item is unanswered.');

  return { slug, status, workspaceInfo, checks, ok: checks.every((check) => check.ok) };
}

function showParkChecks(result, log) {
  for (const check of result.checks) log(`  ${check.id.padEnd(9)}${check.ok ? 'ok' : 'blocked'}: ${check.detail}`);
  log(result.ok ? 'All park checks pass.' : `${result.checks.filter((check) => !check.ok).length} park check(s) need attention.`);
}

function failureId(result) {
  return result.checks.find((check) => !check.ok)?.id ?? null;
}

function projectLead(result) {
  const pane = result.workspaceInfo?.panes?.find((item) => item.label === 'orch');
  return pane?.agent_name ?? pane?.agentName ?? `${result.slug}-orch`;
}

function mailboxNotice(slug, dataDir, now) {
  const text = `Park of ${slug} is blocked. The project lead did not become idle within 10 minutes. Check the project, then run herdr-boss project park ${slug} again.`;
  const existing = readMessages({ dir: dataDir }).find((item) => item.thread === 'boss' && item.from === 'boss'
    && item.text === text && !item.closedAt);
  if (existing) return existing.id;
  return appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text, action: 'answer', replyTo: null, status: 'new' }, { dir: dataDir, now }).id;
}

function preparePrompt(slug) {
  return `[herdr-boss] Prepare ${slug} for park. Commit and push with the project rules. Update docs/orchestration/memory.md. Run herdr-boss publish ${slug} FILE --sync. Do not stop a worker or close a browser. Report when the work is complete.`;
}

async function prepareProject(slug, initial, record, options) {
  const failed = initial.checks.filter((check) => !check.ok).map((check) => check.id);
  if (!failed.length || failed.some((id) => !['git', 'status', 'memory'].includes(id))) return initial;
  if (!initial.workspaceInfo || !initial.checks.find((check) => check.id === 'workers')?.ok
    || !initial.checks.find((check) => check.id === 'prompt')?.ok) return initial;
  const lead = projectLead(initial);
  try { options.herdr(['agent', 'prompt', lead, preparePrompt(slug)]); }
  catch { return initial; }
  const now = options.now;
  const wait = options.wait;
  const startedAt = now();
  while (now() - startedAt < TEN_MINUTES) {
    let status = null;
    try { status = options.herdr(['agent', 'get', lead])?.agent ?? {}; } catch {}
    if (['idle', 'done'].includes(status.agent_status)) return inspectPark(slug, record, options);
    wait(Math.min(WAIT_STEP_MS, TEN_MINUTES - (now() - startedAt)));
  }
  mailboxNotice(slug, options.dataDir, now());
  return inspectPark(slug, record, options);
}

function closeWorkspaceById(slug, record, parkResult, options) {
  const { herdr } = options;
  const info = parkResult.workspaceInfo;
  if (!info?.workspace) return;
  if (info.workspace.label !== slug) throw new Error(`Saved workspace ${info.id} does not belong to ${slug}. Refusing to close it.`);
  const panes = rows(herdr(['pane', 'list', '--workspace', info.id]), 'panes');
  const runDir = (options.projectConfig ?? loadProjectConfig({ cwd: record.repo, home: options.flowOptions.home })).runsPath;
  const allowedPanes = new Set(listRunRecords(runDir).map((run) => run.pane).filter(Boolean));
  for (const pane of panes) {
    const name = pane.agent_name ?? pane.agentName ?? agentOf(pane);
    const lead = pane.label === 'orch' && name === `${slug}-orch`;
    if (!lead && !allowedPanes.has(paneOf(pane))) throw new Error('The project workspace has a pane that is not its lead or a recorded worker. Refusing to close it.');
  }
  herdr(['workspace', 'close', info.id]);
}

async function releaseBrowserReservation(slug, dataDir, options) {
  const leases = (options.readLeases ?? readLeases)(dataDir).leases;
  const held = leases.find((lease) => lease.pool === PROJECT_BROWSER_POOL_NAME && lease.project === slug);
  if (!held) return;
  if (options.releaseBrowser) return options.releaseBrowser(slug, { dataDir });
  const { releaseBrowser } = await import('./browser-pool.js');
  // This call releases only a closed project's reservation. It never closes a browser.
  return releaseBrowser(slug);
}

async function restoreBrowserReservation(slug, dataDir, options) {
  let leases;
  try { leases = (options.readLeases ?? readLeases)(dataDir).leases; } catch {}
  if (leases?.some((lease) => lease.pool === PROJECT_BROWSER_POOL_NAME && lease.project === slug)) return;
  if (options.reserveBrowser) await options.reserveBrowser(slug, { dataDir });
  else {
    const { requestBrowser } = await import('./browser-pool.js');
    await requestBrowser(slug, { launch: false, dataDir });
  }
  const restored = (options.readLeases ?? readLeases)(dataDir).leases
    .some((lease) => lease.pool === PROJECT_BROWSER_POOL_NAME && lease.project === slug);
  if (!restored) throw new Error(`The browser reservation for ${slug} could not be restored.`);
}

async function parkProject(parsed, options) {
  const { slug, dataDir, log } = { ...parsed, ...options };
  const record = findRecord(slug, dataDir);
  assertFactory(record, dataDir);
  if (record.state === 'archived') throw new Error(`Project ${slug} is archived. Run herdr-boss project unarchive ${slug} first.`);
  if (record.state === 'parked') { log(`Project ${slug} is already parked.`); return 0; }
  if (!['open', 'parking'].includes(record.state)) throw new Error(`Project ${slug} cannot park from state ${record.state}.`);

  let checked = inspectPark(slug, record, options);
  showParkChecks(checked, log);
  if (parsed.dryRun) {
    log(`Dry run: project ${slug} stays open. No prompt, lock, browser release, workspace close, register change, or audit line was written.`);
    if (parsed.prepare && failureId(checked)) log('  would ask the project lead to prepare only when git, status, or memory blocks the park.');
    return checked.ok ? 0 : 1;
  }

  if (!checked.ok && parsed.prepare) {
    checked = await prepareProject(slug, checked, record, options);
    showParkChecks(checked, log);
  }
  if (!checked.ok) {
    const failedCheck = failureId(checked);
    appendAudit(slug, 'park', dataDir, { result: 'failed', failedCheck, by: options.auditBy ?? 'owner-cli' });
    return 1;
  }

  return withActionLock(dataDir, slug, async () => {
    const current = findRecord(slug, dataDir);
    assertFactory(current, dataDir);
    if (!['open', 'parking'].includes(current.state)) throw new Error(`Project ${slug} changed state before park. Run the command again.`);
    checked = inspectPark(slug, current, options);
    showParkChecks(checked, log);
    if (!checked.ok) {
      appendAudit(slug, 'park', dataDir, { result: 'failed', failedCheck: failureId(checked), by: options.auditBy ?? 'owner-cli' });
      return 1;
    }

    let failedStep = 'register';
    try {
      writeRecord(slug, dataDir, 'park', (project) => ({ ...project, state: 'parking' }), {
        result: 'started', failedCheck: null, now: options.now, write: options.writeRegister, by: options.auditBy ?? 'owner-cli',
      });
      failedStep = 'workspace';
      closeWorkspaceById(slug, current, checked, options);
      failedStep = 'browser';
      await releaseBrowserReservation(slug, dataDir, options);
      failedStep = 'register';
      writeRecord(slug, dataDir, 'park', (project) => ({ ...project, state: 'parked', pinned: false }), {
        now: options.now, write: options.writeRegister, by: options.auditBy ?? 'owner-cli',
      });
      log(`Parked ${slug}. Its project files and status stay in place.`);
      return 0;
    } catch (error) {
      let reservationError = null;
      try { await restoreBrowserReservation(slug, dataDir, options); } catch (restoreError) { reservationError = restoreError; }
      try { appendAudit(slug, 'park', dataDir, { result: 'failed', failedCheck: failedStep, by: options.auditBy ?? 'owner-cli' }); } catch {}
      const state = (() => { try { return findRecord(slug, dataDir).state; } catch { return 'unknown'; } })();
      log(`Park stopped at ${failedStep}. Project ${slug} stays in state ${state}. ${error.message}${reservationError ? ` The browser reservation could not be restored: ${reservationError.message}` : ''}`);
      return 1;
    }
  });
}

function transitionState(parsed, options) {
  const { slug, dataDir, log } = { ...parsed, ...options };
  const record = findRecord(slug, dataDir);
  assertFactory(record, dataDir);
  const action = options.action;
  const from = action === 'archive' ? 'parked' : 'archived';
  const to = action === 'archive' ? 'archived' : 'parked';
  if (record.state === to) { log(`Project ${slug} is already ${to}.`); return 0; }
  if (record.state !== from) throw new Error(`Project ${slug} must be ${from} before it can ${action}.`);
  if (parsed.dryRun) { log(`Dry run: would change ${slug} from ${from} to ${to}.`); return 0; }
  writeRecord(slug, dataDir, action, (current) => ({ ...current, state: to, ...(action === 'archive' ? { pinned: false } : {}) }), { now: options.now, by: options.auditBy ?? 'owner-cli' });
  log(`${action === 'archive' ? 'Archived' : 'Unarchived'} ${slug}.`);
  return 0;
}

export async function projectLifecycleCommand(action, args, {
  env = process.env,
  herdr,
  dataDir = DATA_DIR,
  log = console.log,
  hooks,
  flowOptions = {},
  now = Date.now,
  wait = pause,
  ...injections
} = {}) {
  const parsed = parseArgs(action, args);
  verifyProjectCaller(env, herdr, `project ${action}`, { targetSlug: parsed.slug, action });
  const options = { ...injections, env, herdr, dataDir, log, hooks, flowOptions, now, wait };
  if (action === 'open') {
    if (parsed.dryRun) return openProject(parsed, options);
    return withActionLock(dataDir, 'open-cap', () => withActionLock(dataDir, parsed.slug, () => openProject(parsed, options)));
  }
  if (action === 'park') return parkProject(parsed, options);
  const transition = () => transitionState(parsed, { ...options, action });
  if (parsed.dryRun) return transition();
  return withActionLock(dataDir, parsed.slug, transition);
}
