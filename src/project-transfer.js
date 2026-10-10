import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { DATA_DIR, PRIVATE_ACCESS_DIR } from './config.js';
import { SLUG, writeProject } from './projects.js';
import { readProjectRepos, recordProjectRepo } from './harness.js';
import { kitRevision, installKit } from './kit/agents-check.js';
import { FACTORY_PROJECT_GROUP, isFactoryRole } from './factory-role.js';
import { createHerdrRunner } from './kit/workers.js';
import { workspaceStep } from './project-new-workspace.js';
import { appendMessage, closeMailboxItem, readMessages } from './messages.js';
import { factoryRecords } from './fleet-poller.js';
import { readFleetFile } from './fleet-store.js';
import { FLEET_GUIDE_TOKEN } from './fleet-access.js';
import { createProjectTransferLock, readProjectTransferLock, releaseProjectTransferLock } from './project-transfer-locks.js';

const TRANSFER_ID = /^[0-9a-f-]{36}$/i;
const KIT_REVISION = /^[0-9a-f]{12}$/;
const TARGET_TOKEN_FILE = 'fleet-guide-remotes.json';
const LOCK_ERROR = 'The project already has an open transfer.';
const START_TIMEOUT_MS = 300000;
const ACTION_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const STILL_WORKING = 'The target is still working. Run the same command again.';
function safeError(message) {
  return String(message || 'The project transfer failed.')
    .replace(/\bhf_[a-z0-9]+_[a-f0-9]{64}\b/gi, '[credential]')
    .replace(/\b(?:https?|ssh|git):\/\/[^\s"'<>]+/gi, '[address]')
    .replace(/(?<![\w])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g, '[path]')
    .replace(/(?<!\w)[A-Z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '[path]')
    .replace(/[\r\n]+/g, ' ').slice(0, 240);
}

export const PROJECT_TRANSFER_USAGE = 'Usage: project transfer plan|start|switch|cancel <slug> --to <factory>';

export function projectTransferRoot(options = {}) {
  const env = options.env || process.env;
  if ((options.factoryRole || isFactoryRole)(env)) return path.resolve(FACTORY_PROJECT_GROUP);
  return path.resolve(options.projectRoot || options.config?.projectRoot || path.join(env.HOME || os.homedir(), 'Projects'));
}

function refuse(message, status = 400) { throw Object.assign(new Error(message), { status }); }

export function parseProjectTransferArgs(args) {
  const [action, slug, ...rest] = args;
  if (!['plan', 'start', 'switch', 'cancel'].includes(action) || !SLUG.test(slug || '')) throw new Error(PROJECT_TRANSFER_USAGE);
  let to = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--to' || to !== null) throw new Error(PROJECT_TRANSFER_USAGE);
    to = rest[++index] || null;
  }
  if (!to || !SLUG.test(to)) throw new Error(PROJECT_TRANSFER_USAGE);
  return { action, slug, to };
}

function jsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`The transfer record ${path.basename(file)} cannot be read.`); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* The file remains in a private data directory. */ }
}

const transferDirectory = (dataDir) => path.join(dataDir, 'project-transfers');
const transferFile = (slug, dataDir) => path.join(transferDirectory(dataDir), `${slug}.json`);
const auditFile = (dataDir) => path.join(transferDirectory(dataDir), 'audit.jsonl');

function readTransfer(slug, dataDir) {
  const record = jsonFile(transferFile(slug, dataDir));
  if (record === null) return null;
  if (record.schema !== 1 || record.slug !== slug || !TRANSFER_ID.test(record.transferId || '')
    || !['starting', 'pending', 'switched', 'cancelled', 'denied'].includes(record.status)
    || typeof record.toFactory !== 'string' || typeof record.targetFactoryId !== 'string') {
    throw new Error(`The transfer record for ${slug} is invalid.`);
  }
  return record;
}

function writeTransfer(record, dataDir) { writeJson(transferFile(record.slug, dataDir), record); }

function audit(dataDir, settings, peerFactoryId, slug, transferId, event, now) {
  const file = auditFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = { at: new Date(now()).toISOString(), factoryId: settings.factoryId, peerFactoryId, slug, transferId, event };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Keep audit output inside the private data directory. */ }
}

function git(cwd, args, message = 'Git could not check the project.') {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { refuse(message); }
}

function githubRemote(remote, allowGitRemote) {
  if (typeof allowGitRemote === 'function') return allowGitRemote(remote) === true;
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote)
    || /^ssh:\/\/git@github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote)
    || /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote);
}

function assertRemote(remote, allowGitRemote) {
  if (typeof remote !== 'string' || remote.length > 2048 || /[\s\0]/.test(remote) || !githubRemote(remote, allowGitRemote)) {
    refuse('The project needs a GitHub remote named origin. The remote URL is not shown.');
  }
}

function reachableOrigin(repo, allowGitRemote) {
  let remote;
  try { remote = git(repo, ['remote', 'get-url', 'origin'], 'The project has no reachable GitHub remote named origin.'); }
  catch { refuse('The project has no reachable GitHub remote named origin.'); }
  assertRemote(remote, allowGitRemote);
  git(repo, ['ls-remote', '--heads', 'origin'], 'The GitHub remote is not reachable.');
  return remote;
}

function remoteRefs(repo) {
  const text = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], 'The project branches could not be checked.');
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function sourceBlockers(repo, runningWorkers) {
  const blockers = [];
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=normal'], 'The project tree could not be checked.').split(/\r?\n/).filter(Boolean);
  if (dirty.length) blockers.push(`Dirty tree: ${dirty.length} uncommitted path(s).`);
  const refs = remoteRefs(repo);
  const branchRows = git(repo, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)', 'refs/heads'], 'The project branches could not be checked.')
    .split(/\r?\n/).filter(Boolean).map((row) => row.split('\0'));
  const unpushed = new Set();
  for (const [branch] of branchRows) {
    const commits = git(repo, ['rev-list', '--reverse', branch, '--not', ...refs], 'The project branches could not be checked.')
      .split(/\r?\n/).filter(Boolean);
    for (const commit of commits) unpushed.add(commit.slice(0, 12));
    if (!refs.includes(`origin/${branch}`)) blockers.push('Unpushed branch: a local branch has no remote copy.');
  }
  for (const commit of unpushed) blockers.push(`Unpushed commit: ${commit}.`);
  const workers = Array.isArray(runningWorkers) ? runningWorkers : Number.isInteger(runningWorkers) && runningWorkers > 0
    ? Array.from({ length: runningWorkers }, (_, index) => `worker-${index + 1}`) : [];
  for (const worker of workers) blockers.push(`Running worker: ${/^[a-z][a-z0-9-]{0,31}$/.test(String(worker)) ? worker : 'worker'}.`);
  return { blockers };
}

function localRunningWorkers(slug, dataDir) {
  const rules = jsonFile(path.join(dataDir, 'rules.json'), {});
  const count = rules.control?.projects?.[slug]?.running ?? 0;
  return Number.isInteger(count) && count > 0 ? count : [];
}

function safeDashboard(record) {
  let url;
  try { url = new URL(record.dashboardUrl); } catch { refuse('The target factory is not available in the factory list.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    const name = SLUG.test(record.name) ? record.name : 'NAME';
    refuse(`The target factory does not have a safe dashboard connection. Create the HTTPS Serve route. Then run herdr-boss factory connect ${name} and retry the transfer.`);
  }
  return url.origin;
}

function localFactorySettings(dataDir, config = {}) {
  const identity = jsonFile(path.join(dataDir, 'factory-identity.json'));
  if (!identity || typeof identity.factoryId !== 'string') refuse('This factory has no factory identity.');
  const saved = jsonFile(path.join(dataDir, 'fleet-settings.json'), {});
  return { factoryId: identity.factoryId, name: saved.name || config.fleet?.name || 'factory-zero' };
}

function targetRecords(options) {
  if (Array.isArray(options.factories)) return options.factories;
  const env = options.env || process.env;
  const registryFile = options.registryFile || path.join(env.HERDR_FACTORIES_DIR || path.join(env.HOME || os.homedir(), '.herdr-factories'), 'fleet.json');
  try { return factoryRecords(registryFile); } catch { refuse('The factory list is invalid or unavailable.'); }
}

function guideToken(privateDir, factoryId) {
  const tokens = readFleetFile(path.join(privateDir, TARGET_TOKEN_FILE), {});
  const token = tokens?.[factoryId];
  if (!FLEET_GUIDE_TOKEN.test(token || '')) refuse('A guide credential for the target factory is not available.');
  return token;
}

async function boundedJson(response) {
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/json')) refuse('The target factory returned an invalid transfer response.', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) refuse('The target factory returned an oversized transfer response.', 502);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { refuse('The target factory returned an invalid transfer response.', 502); }
  } finally { await reader.cancel().catch(() => {}); }
}

function removeProjectRegistration(slug, repo, dataDir) {
  const rows = readProjectRepos(dataDir);
  const match = rows.find((row) => row.slug === slug);
  if (match && path.resolve(match.repo) !== path.resolve(repo)) refuse('The target project registration changed during the transfer.', 409);
  if (!match) return;
  const file = path.join(dataDir, 'project-repos.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(rows.filter((row) => row.slug !== slug), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function removeTargetFiles(slug, repo, dataDir, projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedRepo = path.resolve(repo);
  if (path.dirname(resolvedRepo) !== resolvedRoot || path.basename(resolvedRepo) !== slug) refuse('The target project path is invalid.');
  try {
    const stat = fs.lstatSync(resolvedRepo);
    if (stat.isSymbolicLink()) refuse('The target project path is a symbolic link.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  removeProjectRegistration(slug, resolvedRepo, dataDir);
  fs.rmSync(path.join(dataDir, 'projects', `${slug}.json`), { force: true });
  fs.rmSync(path.join(dataDir, 'flows', `${slug}.json`), { force: true });
  fs.rmSync(resolvedRepo, { recursive: true, force: true });
}

function writeInitialProject(slug, repo, dataDir, revision, transfer) {
  const errors = writeProject(slug, {
    project: slug,
    summary: 'Transferred project. The project lead reads docs/orchestration/memory.md.',
    kitRevision: revision,
    tasks: [],
    transfer,
  }, { dir: path.join(dataDir, 'projects') });
  if (errors.length) refuse('The target project record is invalid.');
  const registered = recordProjectRepo(slug, repo, git(repo, ['remote', 'get-url', 'origin']), { dataDir });
  if (!registered.recorded && !readProjectRepos(dataDir).some((row) => row.slug === slug && path.resolve(row.repo) === path.resolve(repo))) {
    refuse('The target project could not be registered.');
  }
}

function startFreshProjectLead({ slug, repo, dataDir, herdr, env, home, hooks, state }) {
  if (!fs.existsSync(path.join(repo, 'docs', 'orchestration', 'memory.md'))) refuse('The GitHub project has no docs/orchestration/memory.md.');
  const ids = { ...(state.workspace || {}) };
  const inputs = { slug, name: slug, path: repo, goal: '' };
  workspaceStep(inputs, {
    start: true, kind: null, factory: true, dataDir, herdr, env, home, hooks, ids,
    remember(patch) {
      Object.assign(ids, patch); state.workspace = { ...ids };
      writeTransfer(state, dataDir);
    },
  });
  return ids;
}

function sourceProjectLead(slug, project, herdr) {
  const workspace = project?.workspace;
  if (typeof workspace !== 'string' || !workspace) return { closed: false };
  let panes;
  try {
    const response = herdr(['pane', 'list', '--workspace', workspace]);
    panes = Array.isArray(response) ? response : response?.panes;
  } catch { refuse('The source project lead state cannot be checked. The transfer stays locked.'); }
  if (!Array.isArray(panes)) refuse('The source project lead state cannot be checked. The transfer stays locked.');
  const pane = panes.find((row) => row?.label === 'orch' && row?.agent)
    || panes.find((row) => row?.agent_name === `${slug}-orch`);
  if (!pane) return { closed: false };
  const paneId = pane.pane_id ?? pane.paneId ?? pane.id;
  if (typeof paneId !== 'string') refuse('The source project lead pane is invalid. The transfer stays locked.');
  let agent;
  try {
    const response = herdr(['agent', 'get', pane.agent_name || `${slug}-orch`]);
    agent = response?.agent ?? response;
  } catch { refuse('The source project lead state cannot be checked. The transfer stays locked.'); }
  if (!['idle', 'done'].includes(agent?.agent_status)) refuse('The source project lead is still working or waiting for input. Let it finish, then run transfer start again.');
  try { herdr(['pane', 'close', paneId]); }
  catch { refuse('The source project lead could not be closed. The transfer stays locked.'); }
  return { closed: true, kind: ['claude', 'codex'].includes(pane.agent) ? pane.agent : null };
}

function resumeSourceProjectLead({ transfer, slug, repo, dataDir, herdr, env, hooks }) {
  if (!transfer.sourceLeadClosed) return;
  const ids = {};
  workspaceStep({ slug, name: slug, path: repo, goal: '' }, {
    start: true, kind: transfer.sourceLeadKind || null, factory: false, dataDir, herdr, env, home: env.HOME, hooks, ids,
    remember(patch) { Object.assign(ids, patch); },
  });
}

function answerFor(transfer, dataDir) {
  if (!transfer.mailboxId) return null;
  const messages = readMessages({ dir: dataDir }).filter((row) => row.from === 'owner' && row.replyTo === transfer.mailboxId);
  const newest = messages.at(-1);
  if (!newest) return null;
  const text = String(newest.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:accept|approve|approved|yes|switch|accept the switch|approve the switch|confirm switch)$/.test(text)) return 'accept';
  if (/^(?:deny|decline|no|cancel|do not switch|dont switch|deny the switch)$/.test(text)) return 'deny';
  return null;
}

function closeTransferDecision(transfer, dataDir, now) {
  if (transfer.mailboxId) closeMailboxItem(transfer.mailboxId, { dir: dataDir, now: now() });
}

function decisionItem(transfer, dataDir) {
  const marker = `Transfer: ${transfer.transferId}`;
  const existing = readMessages({ dir: dataDir }).find((row) => row.from === 'boss' && row.action === 'decide' && row.text.includes(marker));
  if (existing) return existing.id;
  const text = [
    `Decision: switch project ${transfer.slug} to ${transfer.toFactory}?`,
    '',
    marker,
    'The target has a fresh project lead. The lead reads docs/orchestration/memory.md.',
    'Herdr Boss keeps local data, secrets, logins, Owner items, review packs, and Mailbox messages at this factory.',
    '',
    '### Choices',
    '',
    '- Accept the switch',
    '- Deny the switch',
  ].join('\n');
  return appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text, action: 'decide', replyTo: null, status: 'new' }, { dir: dataDir }).id;
}

function appendAudit(dataDir, settings, peerFactoryId, slug, transferId, event, now) {
  audit(dataDir, settings, peerFactoryId, slug, transferId, event, now);
}

export function createProjectTransfer(options = {}) {
  const role = options.role || 'source';
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const env = options.env || process.env;
  const config = options.config || {};
  const privateDir = path.resolve(options.privateDir || PRIVATE_ACCESS_DIR);
  const now = options.now || Date.now;
  const currentKit = options.kitRevision || kitRevision;
  const settings = options.settings || (() => localFactorySettings(dataDir, config));
  const allowGitRemote = options.allowGitRemote;
  const herdr = options.herdr || createHerdrRunner();
  const hooks = options.hooks || {};
  const projectRoot = projectTransferRoot({ ...options, env, config });
  const request = options.fetchImpl || fetch;
  const jobs = new Map();

  const send = async (record, body) => {
    const dashboardUrl = safeDashboard(record);
    const token = guideToken(privateDir, record.factoryId);
    const starting = body.action === 'start';
    const timeoutMs = options.timeoutMs ?? (starting ? START_TIMEOUT_MS : ACTION_TIMEOUT_MS);
    const deadline = now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
    const receive = async (url, init) => {
      const response = await request(url, { ...init, headers, redirect: 'error', signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        refuse(`The target factory refused the transfer request (HTTP ${response.status}).`, response.status);
      }
      return { status: response.status, body: await boundedJson(response) };
    };
    try {
      let reply = await receive(`${dashboardUrl}/api/fleet/transfer`, { method: 'POST', body: JSON.stringify(body) });
      if (starting && now() >= deadline) refuse(STILL_WORKING, 504);
      if (!starting || reply.status !== 202) return reply.body;
      const jobId = reply.body.jobId;
      if (!TRANSFER_ID.test(jobId || '')) refuse('The target factory returned an invalid transfer job.', 502);
      const query = new URLSearchParams({ slug: body.slug, jobId });
      while (reply.status === 202) {
        if (reply.body.ok !== true || reply.body.factoryId !== record.factoryId || reply.body.status !== 'starting' || reply.body.jobId !== jobId) {
          refuse('The target factory returned an invalid transfer job.', 502);
        }
        const remaining = deadline - now();
        if (remaining <= 0) refuse(STILL_WORKING, 504);
        const interval = Math.min(options.pollIntervalMs ?? POLL_INTERVAL_MS, remaining);
        if (options.wait) await options.wait(interval, signal);
        else await wait(interval, undefined, { signal });
        if (now() >= deadline) refuse(STILL_WORKING, 504);
        reply = await receive(`${dashboardUrl}/api/fleet/transfer?${query}`, { method: 'GET' });
        if (now() >= deadline) refuse(STILL_WORKING, 504);
      }
      return reply.body;
    } catch (error) {
      if (starting && (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name))) refuse(STILL_WORKING, 504);
      if (error.status) throw error;
      refuse('The target factory could not be reached. The transfer remains locked so you can retry or cancel.', 503);
    }
  };

  const resolveTarget = (name) => {
    const matches = targetRecords({ ...options, env }).filter((row) => row.name === name);
    if (matches.length !== 1 || matches[0].factoryId === settings().factoryId) refuse('The target factory is missing or is this factory.');
    safeDashboard(matches[0]);
    return matches[0];
  };

  const sourceRepo = (slug) => {
    const row = readProjectRepos(dataDir).find((entry) => entry.slug === slug);
    if (!row || !fs.existsSync(row.repo)) refuse(`Project ${slug} is not registered on this factory.`);
    const repo = fs.realpathSync(row.repo);
    const status = jsonFile(path.join(dataDir, 'projects', `${slug}.json`));
    if (status?.transfer?.status === 'transferred') refuse(`Project ${slug} was already transferred to ${status.transfer.toFactory}.`);
    return { repo, status };
  };

  const inspectSource = (slug) => {
    const source = sourceRepo(slug);
    const remote = reachableOrigin(source.repo, allowGitRemote);
    return { ...source, remote };
  };

  const plan = async (slug, to) => {
    if (role !== 'source') refuse('This factory accepts transfer requests but cannot plan a source transfer.', 403);
    const source = inspectSource(slug);
    if (readProjectTransferLock(slug, { dataDir })) refuse(LOCK_ERROR, 409);
    const target = resolveTarget(to);
    const sourceRevision = currentKit();
    if (!KIT_REVISION.test(sourceRevision || '')) refuse('The source kit revision is unavailable.');
    const reply = await send(target, { action: 'plan', slug, sourceFactoryId: settings().factoryId, sourceKitRevision: sourceRevision });
    if (reply.ok !== true || reply.factoryId !== target.factoryId || reply.factoryName !== target.name || !KIT_REVISION.test(reply.kitRevision || '')) {
      refuse('The target factory returned an invalid plan.');
    }
    if (reply.kitRevision !== sourceRevision) refuse('The target kit is older or different from the source kit. Update the target kit before transfer.');
    if (reply.projectExists || reply.transferOpen) refuse('The target already has this project or an open transfer.');
    return { target, source, sourceRevision, reply,
      lines: [`Transfer plan for ${slug}`, `Source: ${settings().name}`, `Target: ${target.name}`, 'Repository: GitHub remote is reachable', `Kit: ${sourceRevision} matches on both factories`, 'Target project: ready to import', 'Plan check: no changes made.'] };
  };

  const targetPlan = (body) => {
    const local = settings();
    const revision = currentKit();
    if (!KIT_REVISION.test(revision || '')) refuse('The target kit revision is unavailable.', 409);
    const registered = readProjectRepos(dataDir).some((row) => row.slug === body.slug);
    const status = fs.existsSync(path.join(dataDir, 'projects', `${body.slug}.json`));
    const folder = path.join(projectRoot, body.slug);
    const transfer = jsonFile(transferFile(body.slug, dataDir));
    const transferOpen = Boolean(readProjectTransferLock(body.slug, { dataDir }))
      || Boolean(jobs.get(body.slug)?.running)
      || Boolean(transfer && !['cancelled', 'switched'].includes(transfer.status));
    return { ok: true, factoryId: local.factoryId, factoryName: local.name, kitRevision: revision,
      projectExists: registered || status || fs.existsSync(folder), transferOpen };
  };

  const targetStart = async (body) => {
    const local = settings();
    const revision = currentKit();
    if (body.sourceKitRevision !== revision) refuse('The source and target kit revisions do not match.', 409);
    assertRemote(body.sourceRemote, allowGitRemote);
    const existing = readProjectTransferLock(body.slug, { dataDir });
    if (existing && existing.transferId !== body.transferId) refuse(LOCK_ERROR, 409);
    const stateFile = transferFile(body.slug, dataDir);
    let state = jsonFile(stateFile);
    const repo = path.join(projectRoot, body.slug);
    const retry = state?.transferId === body.transferId && state.status === 'starting';
    const reusable = state?.status === 'cancelled';
    if (state && (!retry && !reusable && !(state.transferId === body.transferId && ['pending', 'switched'].includes(state.status)))) refuse('The target project already has a transfer record.', 409);
    if (state?.transferId === body.transferId && (state.slug !== body.slug || state.sourceFactoryId !== body.sourceFactoryId
      || state.targetFactoryId !== local.factoryId || path.resolve(state.repoPath || '') !== path.resolve(repo))) {
      refuse('The target transfer record is invalid.', 409);
    }
    if (state?.transferId === body.transferId && ['pending', 'switched'].includes(state.status)) {
      let existingPath;
      try { existingPath = fs.lstatSync(repo); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existingPath?.isSymbolicLink() || !existingPath?.isDirectory()) refuse('The target project path is invalid.', 409);
      return { ok: true, factoryId: local.factoryId, status: state.status };
    }
    let existingPath;
    try { existingPath = fs.lstatSync(repo); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existingPath?.isSymbolicLink()) refuse('The target project path is a symbolic link.', 409);
    if (existingPath && !existingPath.isDirectory()) refuse('The target project path is invalid.', 409);
    const existingRegistration = readProjectRepos(dataDir).find((row) => row.slug === body.slug);
    const existingProject = jsonFile(path.join(dataDir, 'projects', `${body.slug}.json`));
    if (!retry && (existingPath || existingRegistration || existingProject)) refuse('The target already has this project.', 409);
    if (retry && ((existingRegistration && path.resolve(existingRegistration.repo) !== path.resolve(repo))
      || (existingProject && existingProject.transfer?.transferId !== body.transferId))) {
      refuse('The target project changed during the transfer.', 409);
    }
    if (retry && existingPath) {
      let completeClone = false;
      let metadata;
      try { metadata = fs.lstatSync(path.join(repo, '.git')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) refuse('The target project changed during the transfer.', 409);
      try {
        completeClone = Boolean(metadata) && git(repo, ['--git-dir=.git', 'rev-parse', '--verify', 'HEAD']).length > 0;
      } catch { /* An interrupted clone can lack its Git metadata. */ }
      if (completeClone && git(repo, ['--git-dir=.git', 'remote', 'get-url', 'origin']) !== body.sourceRemote) refuse('The target project changed during the transfer.', 409);
      if (!completeClone) {
        if (state.cloneComplete || existingRegistration || existingProject || state.workspace?.workspaceId || state.workspace?.paneId) {
          refuse('The target project changed during the transfer.', 409);
        }
        // This record and lock own the incomplete clone. No project lead uses it yet.
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
    try { execFileSync('git', ['ls-remote', '--heads', '--', body.sourceRemote], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: options.gitTimeoutMs || 60000 }); }
    catch { refuse('The GitHub remote is not reachable.'); }
    if (!existing) createProjectTransferLock(body.slug, { transferId: body.transferId, side: 'target', peerFactoryId: body.sourceFactoryId, dataDir, now });
    state = { schema: 1, slug: body.slug, transferId: body.transferId, status: 'starting', toFactory: local.name,
      targetFactoryId: local.factoryId, sourceFactoryId: body.sourceFactoryId, sourceName: body.sourceName, repoPath: repo,
      cloneComplete: retry && state.cloneComplete === true, workspace: retry ? state.workspace || {} : {} };
    writeTransfer(state, dataDir);
    try {
      fs.mkdirSync(projectRoot, { recursive: true });
      if (!fs.existsSync(repo)) {
        try { execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--', body.sourceRemote, repo], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: options.gitTimeoutMs || 60000 }); }
        catch { refuse('The GitHub project could not be cloned.'); }
      }
      if (!fs.existsSync(path.join(repo, 'docs', 'orchestration', 'memory.md'))) refuse('The GitHub project has no docs/orchestration/memory.md.');
      state.cloneComplete = true; writeTransfer(state, dataDir);
      const installed = options.install || installKit;
      await installed(repo);
      writeInitialProject(body.slug, repo, dataDir, revision, { status: 'pending', transferId: body.transferId, fromFactory: body.sourceName });
      const ids = startFreshProjectLead({ slug: body.slug, repo, dataDir, herdr, env, home: env.HOME, hooks, state });
      state.workspace = ids;
      state.status = 'pending';
      writeTransfer(state, dataDir);
      appendAudit(dataDir, local, body.sourceFactoryId, body.slug, body.transferId, 'prepared', now);
      return { ok: true, factoryId: local.factoryId, status: 'pending' };
    } catch (error) {
      // Retain the owned import and its workspace checkpoints for retry or cancel.
      writeTransfer(state, dataDir);
      throw error;
    }
  };

  const targetActivate = (body) => {
    const local = settings();
    const state = jsonFile(transferFile(body.slug, dataDir));
    if (state?.transferId !== body.transferId || !['pending', 'switched'].includes(state.status)) refuse('The target transfer is not ready to switch.', 409);
    if (state.status !== 'switched') {
      const projectFile = path.join(dataDir, 'projects', `${body.slug}.json`);
      const project = jsonFile(projectFile);
      if (!project) refuse('The target project record is missing.', 409);
      project.transfer = { ...project.transfer, status: 'received', fromFactory: body.sourceName };
      const errors = writeProject(body.slug, project, { dir: path.dirname(projectFile) });
      if (errors.length) refuse('The target project record could not be updated.', 409);
      releaseProjectTransferLock(body.slug, body.transferId, { dataDir });
      state.status = 'switched'; writeTransfer(state, dataDir);
      appendAudit(dataDir, local, body.sourceFactoryId, body.slug, body.transferId, 'switched', now);
    }
    return { ok: true, factoryId: local.factoryId, status: 'switched' };
  };

  const targetCancel = (body) => {
    const local = settings();
    const stateFile = transferFile(body.slug, dataDir);
    const state = jsonFile(stateFile);
    if (state?.transferId !== body.transferId) {
      const lock = readProjectTransferLock(body.slug, { dataDir });
      if (!state && (!lock || lock.transferId === body.transferId)) {
        if (lock) releaseProjectTransferLock(body.slug, body.transferId, { dataDir });
        return { ok: true, factoryId: local.factoryId, status: 'cancelled' };
      }
      refuse('The target transfer is not open.', 409);
    }
    if (state.status === 'switched') refuse('The project was already switched.', 409);
    if (state.workspace?.paneId) {
      try { herdr(['pane', 'close', state.workspace.paneId]); }
      catch { refuse('The target project lead could not be closed. The transfer lock stays in place.', 409); }
    }
    removeTargetFiles(body.slug, state.repoPath || path.join(projectRoot, body.slug), dataDir, projectRoot);
    releaseProjectTransferLock(body.slug, body.transferId, { dataDir });
    state.status = 'cancelled'; delete state.repoPath; delete state.workspace; writeTransfer(state, dataDir);
    appendAudit(dataDir, local, body.sourceFactoryId, body.slug, body.transferId, 'cancelled', now);
    return { ok: true, factoryId: local.factoryId, status: 'cancelled' };
  };

  const validateRequest = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string' || !SLUG.test(body.slug || '')) refuse('The transfer request is invalid.');
    const fields = {
      plan: ['action', 'slug', 'sourceFactoryId', 'sourceKitRevision'],
      start: ['action', 'slug', 'transferId', 'sourceFactoryId', 'sourceName', 'sourceKitRevision', 'sourceRemote'],
      activate: ['action', 'slug', 'transferId', 'sourceFactoryId', 'sourceName'],
      cancel: ['action', 'slug', 'transferId', 'sourceFactoryId', 'sourceName'],
    }[body.action];
    if (!fields || Object.keys(body).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(body, key))) refuse('The transfer request is invalid.');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.sourceFactoryId || '') || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.sourceName || body.sourceFactoryId)
      || !KIT_REVISION.test(body.sourceKitRevision || '') && body.action !== 'activate' && body.action !== 'cancel'
      || (['start', 'activate', 'cancel'].includes(body.action) && !TRANSFER_ID.test(body.transferId || ''))
      || (body.action === 'start' && (typeof body.sourceRemote !== 'string' || body.sourceRemote.length > 2048))) refuse('The transfer request is invalid.');
    return body;
  };

  const handle = async (input) => {
    if (role !== 'target') return { status: 403, body: { error: 'This factory does not accept transfer requests.' } };
    try {
      const body = validateRequest(input);
      if (jobs.get(body.slug)?.running && body.action !== 'plan') refuse('The target import is still working. Retry after it finishes.', 409);
      let result;
      if (body.action === 'plan') result = targetPlan(body);
      else if (body.action === 'start') result = await targetStart(body);
      else if (body.action === 'activate') result = targetActivate(body);
      else result = targetCancel(body);
      return { status: 200, body: result };
    } catch (error) {
      const status = error.status || 400;
      return { status, body: { error: safeError(error.message) } };
    }
  };

  const jobStatus = (slug, jobId) => {
    try {
      if (role !== 'target') refuse('This factory does not accept transfer requests.', 403);
      if (!SLUG.test(slug || '') || !TRANSFER_ID.test(jobId || '')) refuse('The transfer job request is invalid.');
      const job = jobs.get(slug);
      if (job?.id === jobId) {
        if (!job.running) return job.result;
        return { status: 202, body: { ok: true, factoryId: settings().factoryId, status: 'starting', jobId } };
      }
      const state = jsonFile(transferFile(slug, dataDir));
      if (state?.transferId !== jobId || !['starting', 'pending', 'switched'].includes(state.status)) refuse('The transfer job was not found.', 404);
      return { status: state.status === 'starting' ? 202 : 200,
        body: { ok: true, factoryId: settings().factoryId, status: state.status, jobId } };
    } catch (error) { return { status: error.status || 400, body: { error: safeError(error.message) } }; }
  };

  const submit = async (input) => {
    try {
      if (role !== 'target') refuse('This factory does not accept transfer requests.', 403);
      const body = validateRequest(input);
      if (body.action !== 'start') return handle(body);
      const existing = jobs.get(body.slug);
      if (existing?.running) {
        if (existing.id !== body.transferId || Object.keys(body).some((key) => existing.body[key] !== body[key])) refuse(LOCK_ERROR, 409);
        return jobStatus(body.slug, body.transferId);
      }
      const state = jsonFile(transferFile(body.slug, dataDir));
      if (state?.transferId === body.transferId && ['pending', 'switched'].includes(state.status)) return handle(body);
      const lock = readProjectTransferLock(body.slug, { dataDir });
      if (lock && lock.transferId !== body.transferId) refuse(LOCK_ERROR, 409);
      if (body.sourceKitRevision !== currentKit()) refuse('The source and target kit revisions do not match.', 409);
      assertRemote(body.sourceRemote, allowGitRemote);
      const job = { id: body.transferId, body, running: true, result: null };
      jobs.set(body.slug, job);
      const finish = (result) => { job.result = result; job.running = false; };
      if (options.herdr || options.install || options.hooks) {
        // Injected test adapters can run in process. Production work uses an isolated thread.
        setImmediate(async () => {
          try { finish({ status: 200, body: await targetStart(body) }); }
          catch (error) { finish({ status: error.status || 400, body: { error: safeError(error.message) } }); }
        });
      } else {
        let worker;
        try { worker = new Worker(new URL('./project-transfer-job.js', import.meta.url), {
          env: { ...env, HERDR_BOSS_DIR: dataDir },
          workerData: { body, options: { dataDir, privateDir, config, projectRoot, gitTimeoutMs: options.gitTimeoutMs },
            settings: settings(), revision: currentKit() },
        }); } catch {
          finish({ status: 503, body: { error: 'The target import could not start. Run the same command again.' } });
          return job.result;
        }
        worker.once('message', finish);
        worker.once('error', () => { if (job.running) finish({ status: 503, body: { error: 'The target import stopped. Run the same command again.' } }); });
        worker.once('exit', () => { if (job.running) finish({ status: 503, body: { error: 'The target import stopped. Run the same command again.' } }); });
      }
      return jobStatus(body.slug, body.transferId);
    } catch (error) { return { status: error.status || 400, body: { error: safeError(error.message) } }; }
  };

  const command = async (action, slug, to) => {
    if (role !== 'source') refuse('This factory accepts transfer requests but cannot run source commands.', 403);
    if (action === 'plan') {
      const result = await plan(slug, to);
      return { code: 0, lines: result.lines };
    }
    const source = inspectSource(slug);
    const target = resolveTarget(to);
    let transfer = readTransfer(slug, dataDir);
    if (action === 'start') {
      if (transfer?.status === 'pending' || transfer?.status === 'switched') refuse(LOCK_ERROR, 409);
      const blockers = sourceBlockers(source.repo, (options.getRunningWorkers || localRunningWorkers)(slug, dataDir)).blockers;
      if (blockers.length) refuse(`Transfer freeze refused for ${slug}:\n${blockers.join('\n')}`);
      const sourceRevision = currentKit();
      if (!KIT_REVISION.test(sourceRevision || '')) refuse('The source kit revision is unavailable.');
      if (!transfer || transfer.status !== 'starting') {
        const planResult = await plan(slug, to);
        transfer = { schema: 1, slug, transferId: randomUUID(), status: 'starting', toFactory: target.name,
          targetFactoryId: target.factoryId, sourceFactoryId: settings().factoryId, createdAt: new Date(now()).toISOString(), mailboxId: null };
        createProjectTransferLock(slug, { transferId: transfer.transferId, side: 'source', peerFactoryId: target.factoryId, dataDir, now });
        writeTransfer(transfer, dataDir);
        appendAudit(dataDir, settings(), target.factoryId, slug, transfer.transferId, 'started', now);
        // Keep the checked source remote private. It is sent only in the authenticated target request.
        transfer.remote = source.remote;
        transfer.targetRevision = planResult.reply.kitRevision;
      } else if (transfer.toFactory !== target.name || transfer.targetFactoryId !== target.factoryId) {
        refuse('The open transfer names a different target factory.', 409);
      }
      const sourceLock = readProjectTransferLock(slug, { dataDir });
      if (!sourceLock || sourceLock.transferId !== transfer.transferId) refuse('The project transfer lock is missing. Refusing to continue.', 409);
      const afterLock = sourceBlockers(source.repo, (options.getRunningWorkers || localRunningWorkers)(slug, dataDir)).blockers;
      if (afterLock.length) {
        releaseProjectTransferLock(slug, transfer.transferId, { dataDir });
        fs.rmSync(transferFile(slug, dataDir), { force: true });
        refuse(`Transfer freeze refused for ${slug}:\n${afterLock.join('\n')}`);
      }
      if (!transfer.sourceLeadClosed) {
        const closed = sourceProjectLead(slug, source.status, herdr);
        transfer.sourceLeadClosed = closed.closed;
        if (closed.kind) transfer.sourceLeadKind = closed.kind;
        writeTransfer(transfer, dataDir);
      }
      const result = await send(target, { action: 'start', slug, transferId: transfer.transferId, sourceFactoryId: settings().factoryId,
        sourceName: settings().name, sourceKitRevision: sourceRevision, sourceRemote: transfer.remote || source.remote });
      if (result.ok !== true || result.factoryId !== target.factoryId || result.status !== 'pending') refuse('The target factory did not prepare the project.', 502);
      transfer.mailboxId = decisionItem(transfer, dataDir);
      transfer.status = 'pending'; delete transfer.remote; delete transfer.targetRevision; writeTransfer(transfer, dataDir);
      return { code: 3, lines: [`Transfer started for ${slug}.`, 'The target project lead is ready.', 'Waiting for the Owner to accept or deny the switch in the Mailbox.'] };
    }
    if (!transfer || transfer.toFactory !== target.name || transfer.targetFactoryId !== target.factoryId) refuse('There is no open transfer for this project and target.');
    if (action === 'switch') {
      if (transfer.status === 'switched') refuse(`Project ${slug} was already transferred to ${transfer.toFactory}.`, 409);
      if (transfer.status === 'cancelled' || transfer.status === 'denied') refuse('The project transfer is no longer open.', 409);
      const answer = answerFor(transfer, dataDir);
      if (!answer) return { code: 3, lines: [`Transfer for ${slug} is waiting for a clear Owner answer in the Mailbox.`] };
      if (answer === 'deny') {
        await send(target, { action: 'cancel', slug, transferId: transfer.transferId, sourceFactoryId: settings().factoryId, sourceName: settings().name });
        closeTransferDecision(transfer, dataDir, now);
        releaseProjectTransferLock(slug, transfer.transferId, { dataDir });
        transfer.status = 'denied'; writeTransfer(transfer, dataDir);
        appendAudit(dataDir, settings(), target.factoryId, slug, transfer.transferId, 'denied', now);
        try { resumeSourceProjectLead({ transfer, slug, repo: source.repo, dataDir, herdr, env, hooks }); }
        catch { return { code: 0, lines: ['The Owner denied the switch. The target project was removed and the source project stays here.', 'The source project lead did not restart. Start it with project new --start --resume.'] }; }
        return { code: 0, lines: [`The Owner denied the switch. The target project was removed and the source project stays here.`] };
      }
      const result = await send(target, { action: 'activate', slug, transferId: transfer.transferId, sourceFactoryId: settings().factoryId, sourceName: settings().name });
      if (result.ok !== true || result.status !== 'switched') refuse('The target factory did not complete the switch.', 502);
      closeTransferDecision(transfer, dataDir, now);
      const file = path.join(dataDir, 'projects', `${slug}.json`);
      const project = jsonFile(file);
      if (!project) refuse('The source project record is missing.', 409);
      project.transfer = { status: 'transferred', toFactory: target.name, transferId: transfer.transferId };
      const errors = writeProject(slug, project, { dir: path.dirname(file) });
      if (errors.length) refuse('The source project record could not be updated.', 409);
      releaseProjectTransferLock(slug, transfer.transferId, { dataDir });
      transfer.status = 'switched'; writeTransfer(transfer, dataDir);
      appendAudit(dataDir, settings(), target.factoryId, slug, transfer.transferId, 'switched', now);
      return { code: 0, lines: [`Project ${slug} transferred to ${target.name}. The source project is marked transferred.`] };
    }
    if (action === 'cancel') {
      if (transfer.status === 'switched' || jsonFile(path.join(dataDir, 'projects', `${slug}.json`))?.transfer?.status === 'transferred') {
        refuse(`Project ${slug} was already transferred. Cancel is not available after the switch.`, 409);
      }
      if (transfer.status === 'cancelled' || transfer.status === 'denied') refuse('The project transfer is already closed.', 409);
      await send(target, { action: 'cancel', slug, transferId: transfer.transferId, sourceFactoryId: settings().factoryId, sourceName: settings().name });
      closeTransferDecision(transfer, dataDir, now);
      releaseProjectTransferLock(slug, transfer.transferId, { dataDir });
      transfer.status = 'cancelled'; writeTransfer(transfer, dataDir);
      appendAudit(dataDir, settings(), target.factoryId, slug, transfer.transferId, 'cancelled', now);
      try { resumeSourceProjectLead({ transfer, slug, repo: source.repo, dataDir, herdr, env, hooks }); }
      catch { return { code: 0, lines: ['Transfer cancelled. The target project and clone were removed.', 'The source project lead did not restart. Start it with project new --start --resume.'] }; }
      return { code: 0, lines: [`Transfer cancelled for ${slug}. The target project and clone were removed.`] };
    }
    throw new Error(PROJECT_TRANSFER_USAGE);
  };

  return { role, dataDir, handle, submit, jobStatus, command, plan, start: (slug, to) => command('start', slug, to),
    switch: (slug, to) => command('switch', slug, to), cancel: (slug, to) => command('cancel', slug, to) };
}

export async function projectTransferCommand(args, options = {}) {
  const parsed = parseProjectTransferArgs(args);
  const service = options.service || createProjectTransfer(options);
  const log = options.log || console.log;
  try {
    const result = await service.command(parsed.action, parsed.slug, parsed.to);
    for (const line of result.lines || []) log(line);
    return result.code || 0;
  } catch (error) {
    log(`Error: ${safeError(error.message)}`);
    return 1;
  }
}
