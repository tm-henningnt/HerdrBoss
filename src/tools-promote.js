import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { postToolPromotionFailure } from './messages.js';
import { acquireLock } from './factory-host.js';
import { TOOL_REGISTRY } from './tools-check.js';

export const TOOLS_PROMOTE_FILE = 'tools-promote.json';
export const TOOLS_PROMOTE_SCHEMA = 1;
export const TOOLS_PROMOTE_CANARY = 'win1';
export const TOOLS_PROMOTE_SOAK_MS = 24 * 60 * 60 * 1000;
export const TOOLS_PROMOTE_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
export const TOOLS_PROMOTE_POLL_MS = 5_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = path.join(ROOT, 'factory', 'pins.json');
const FACTORY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_PIN = /^[A-Za-z0-9][A-Za-z0-9_.:+~-]{0,255}$/;
const STAGES = new Set(['planned', 'building', 'canary', 'soaking', 'promoting', 'done', 'failed']);

function usage() {
  return 'Usage: tools promote TOOL [--dry-run]';
}

function parse(args) {
  const positional = [];
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run') {
      if (dryRun) throw new Error(usage());
      dryRun = true;
    } else if (arg.startsWith('--')) throw new Error(usage());
    else positional.push(arg);
  }
  if (positional.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(positional[0])) throw new Error(usage());
  return { tool: positional[0], dryRun };
}

function pinVersion(tool, pins) {
  const definition = TOOL_REGISTRY[tool];
  if (!definition?.pinKey) throw new Error(`Tool ${tool} has no factory pin to promote.`);
  let pin = pins[definition.pinKey];
  if (tool === 'base-image') pin = pin?.digest;
  if (tool === 'buildkit') pin = pin?.version ?? pin?.digest;
  if (typeof pin !== 'string' || !SAFE_PIN.test(pin)) throw new Error(`The factory pin for ${tool} is invalid.`);
  return pin;
}

function readPins(file) {
  let pins;
  try { pins = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('The factory pins cannot be read.'); }
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) throw new Error('The factory pins are invalid.');
  return pins;
}

function readPromotionState(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || state.schema !== TOOLS_PROMOTE_SCHEMA || !state.tools || typeof state.tools !== 'object' || Array.isArray(state.tools)) throw new Error();
    for (const [tool, versions] of Object.entries(state.tools)) {
      if (!/^[a-z][a-z0-9-]*$/.test(tool) || !versions || typeof versions !== 'object' || Array.isArray(versions)) throw new Error();
      for (const [version, rollout] of Object.entries(versions)) {
        if (!rollout || typeof rollout !== 'object' || !rollout.factories || typeof rollout.factories !== 'object' || Array.isArray(rollout.factories)) throw new Error();
        for (const [name, record] of Object.entries(rollout.factories)) {
          if (!FACTORY_NAME.test(name) || !record || typeof record !== 'object' || !STAGES.has(record.stage)) throw new Error();
          if (record.stage === 'failed' && !STAGES.has(record.resumeStage)) throw new Error();
        }
        if (rollout.version !== version || typeof rollout.pinsHash !== 'string' || !/^[a-f0-9]{64}$/.test(rollout.pinsHash) || !Array.isArray(rollout.order)) throw new Error();
      }
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: TOOLS_PROMOTE_SCHEMA, tools: {} };
    throw new Error('The tools promotion state cannot be read.');
  }
}

function ensureDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Herdr Boss data directory is not a real directory.');
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || stat.uid === uid) fs.chmodSync(dir, 0o700);
}

function savePromotionState(file, state) {
  const dir = path.dirname(file);
  ensureDataDir(dir);
  try {
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error();
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('The tools promotion state cannot be written.'); }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* Some file systems do not support syncing a directory. */ }
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error('The tools promotion state cannot be written.');
  }
}

function currentTime(now) {
  const value = now();
  if (!Number.isFinite(value)) throw new Error('The tools promotion clock is invalid.');
  return value;
}

function validateFactories(value) {
  const rows = Array.isArray(value) ? value : value?.factories;
  if (!Array.isArray(rows)) throw new Error('The factory list is invalid.');
  const names = [];
  for (const row of rows) {
    if (row?.kind !== 'container') continue;
    if (!FACTORY_NAME.test(row.name || '') || names.includes(row.name)) throw new Error('The factory list is invalid.');
    names.push(row.name);
  }
  if (!names.includes(TOOLS_PROMOTE_CANARY)) throw new Error('The win1 canary factory is not registered.');
  return [TOOLS_PROMOTE_CANARY, ...names.filter((name) => name !== TOOLS_PROMOTE_CANARY).sort()];
}

function freshRollout(tool, version, pinsHash, imageTag, order, now) {
  return {
    version,
    pinsHash,
    imageTag,
    order,
    factories: Object.fromEntries(order.map((name) => [name, { stage: 'planned' }])),
    startedAt: now,
  };
}

function ownerApprovalRecorded({ root, name, tool, version, pinsHash }) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'docs', 'orchestration', 'memory.md'), 'utf8'); }
  catch { return false; }
  return text.split(/\r?\n/).some((line) => line.includes('yes image update') && line.includes(name)
    && (line.includes(`${tool} ${version}`) || line.includes(pinsHash) || line.includes(pinsHash.slice(0, 12))));
}

function ownerApprovalRequired(name) {
  const command = `herdr-boss factory update ${name} --tier image --allow-boss-restart`;
  const error = new Error(`A Boss pane is live. The Owner has not approved this image update. Run '${command}' only after the Owner records this update in docs/orchestration/memory.md.`);
  error.code = 'OWNER_APPROVAL_REQUIRED';
  return error;
}

function isBossRestartRefusal(error) {
  return typeof error?.message === 'string' && /A Boss pane is live\. Repeat the image update with --allow-boss-restart/.test(error.message);
}

async function captureFactoryCommand(args, options) {
  const factoryCommand = options.factoryCommand;
  if (factoryCommand) return await factoryCommand(args);
  const { factoryCommand: run } = await import('./factory-host.js');
  let stdout = '';
  let stderr = '';
  const context = {
    env: options.env ?? process.env,
    stdout: { write: (text) => { stdout += String(text); } },
    stderr: { write: (text) => { stderr += String(text); } },
    ...(options.factoryIO ?? {}),
  };
  const code = await run(args, context);
  if (code !== 0) throw new Error(stderr.trim() || `The factory command failed with exit code ${code}.`);
  return { stdout, stderr, code };
}

function defaultDependencies(options, imageTag) {
  const env = options.env ?? process.env;
  return {
    factories: async () => {
      const result = await captureFactoryCommand(['list', '--json'], options);
      let rows;
      try { rows = JSON.parse(result.stdout); } catch { throw new Error('The factory list is invalid.'); }
      return rows.factories;
    },
    status: async (name) => {
      const result = await captureFactoryCommand(['status', name, '--json'], options);
      try { return JSON.parse(result.stdout); } catch { throw new Error(`The status of factory ${name} is invalid.`); }
    },
    build: async (name) => captureFactoryCommand(['build', name, '--image', imageTag], options),
    update: async (name, flags = []) => captureFactoryCommand(['update', name, '--tier', 'image', ...flags], options),
    smoke: async (name) => {
      const { hostFor } = await import('./factory-core.js');
      const host = hostFor(env, name);
      const smokeEnv = { ...env };
      if (host.transport === 'docker-context' && host.dockerContext) smokeEnv.DOCKER_CONTEXT = host.dockerContext;
      else delete smokeEnv.DOCKER_CONTEXT;
      execFileSync('sh', [path.join(ROOT, 'factory', 'smoke-test.sh'), imageTag], { cwd: ROOT, env: smokeEnv, stdio: 'inherit' });
    },
    readers: async (name) => captureFactoryCommand([
      'shell', name, '--', 'node', '/home/factory/herdr-boss/src/cli.js', 'doctor', '--json',
    ], options),
    ownerApproval: (details) => ownerApprovalRecorded({ root: ROOT, ...details }),
  };
}

function validateStatus(status, name) {
  if (!status || !Number.isInteger(status.workers) || status.workers < 0) {
    throw new Error(`The status of factory ${name} cannot prove that no worker is running.`);
  }
  return status;
}

async function drain(name, deps, now, timeoutMs, pollMs) {
  const deadline = currentTime(now) + timeoutMs;
  for (;;) {
    const status = validateStatus(await deps.status(name), name);
    if (status.workers === 0) return status;
    const remaining = deadline - currentTime(now);
    if (remaining <= 0) throw new Error(`Factory ${name} drain timeout. A worker is still running. The factory was not updated.`);
    await deps.sleep(Math.min(pollMs, remaining));
  }
}

async function applyImageUpdate(name, rollout, tool, deps) {
  try {
    await deps.update(name, []);
  } catch (error) {
    if (!isBossRestartRefusal(error)) throw error;
    const approved = await deps.ownerApproval({ name, tool, version: rollout.version, pinsHash: rollout.pinsHash });
    if (!approved) throw ownerApprovalRequired(name);
    await deps.update(name, ['--allow-boss-restart']);
  }
}

function markFailed(state, file, rollout, name, stage, reason, now) {
  rollout.factories[name] = {
    ...rollout.factories[name],
    stage: 'failed',
    resumeStage: stage,
    failure: reason,
    failedAt: currentTime(now),
  };
  savePromotionState(file, state);
}

function canaryFailure(tool, rollout, name, stage, state, file, deps, now) {
  markFailed(state, file, rollout, name, stage, 'canary-failed', now);
  try {
    postToolPromotionFailure(tool, rollout.version, name, { dir: deps.dataDir, now: currentTime(now), messageStore: deps.messageStore });
  } catch {
    throw new Error(`The canary failed during ${stage}. The rollout stopped. The failure state is saved, but the Mailbox item could not be posted.`);
  }
  throw new Error(`The canary failed during ${stage}. The rollout stopped. Other factories still use the previous image.`);
}

async function waitForSoak(rollout, row, state, file, deps, now) {
  if (!Number.isFinite(row.soakUntil)) {
    row.soakUntil = currentTime(now) + TOOLS_PROMOTE_SOAK_MS;
    savePromotionState(file, state);
  }
  const remaining = row.soakUntil - currentTime(now);
  if (remaining > 0) await deps.sleep(remaining);
  if (currentTime(now) < row.soakUntil) throw new Error('The canary soak has not finished. Run tools promote again to resume.');
  row.stage = 'done';
  savePromotionState(file, state);
}

function getRollout(state, tool, version, pinsHash, imageTag, order, now) {
  state.tools[tool] ??= {};
  let rollout = state.tools[tool][version];
  if (rollout && rollout.pinsHash !== pinsHash) {
    if (!Object.values(rollout.factories).every((row) => row.stage === 'done')) {
      throw new Error(`A different ${tool} pin set is still in progress. Resume it before promoting another pin set.`);
    }
    rollout = null;
  }
  if (!rollout) rollout = state.tools[tool][version] = freshRollout(tool, version, pinsHash, imageTag, order, currentTime(now));
  for (const name of order) rollout.factories[name] ??= { stage: 'planned' };
  rollout.order = order;
  return rollout;
}

function resetFailed(row, state, file) {
  const stage = row.resumeStage;
  row.stage = stage;
  delete row.resumeStage;
  delete row.failure;
  delete row.failedAt;
  savePromotionState(file, state);
  return stage;
}

async function promoteFactory({ name, isCanary, state, file, rollout, tool, deps, now, timeoutMs, pollMs }) {
  const row = rollout.factories[name];
  if (row.stage === 'done') return;
  let stage = row.stage === 'failed' ? resetFailed(row, state, file) : row.stage;

  if (stage === 'planned' || stage === 'building') {
    const current = await drain(name, deps, now, timeoutMs, pollMs);
    if (current.pinsHash !== rollout.pinsHash) {
      row.stage = 'building';
      savePromotionState(file, state);
      try { await deps.build(name, rollout.imageTag); }
      catch (error) {
        if (isCanary) canaryFailure(tool, rollout, name, stage, state, file, deps, now);
        markFailed(state, file, rollout, name, stage, 'build-failed', now);
        throw new Error(`Factory ${name} image build failed. The rollout stopped.`);
      }
    }
    stage = isCanary ? 'canary' : 'promoting';
    row.stage = stage;
    savePromotionState(file, state);
  }

  if (isCanary && stage === 'canary') {
    try {
      const before = validateStatus(await deps.status(name), name);
      if (before.pinsHash !== rollout.pinsHash) {
        await drain(name, deps, now, timeoutMs, pollMs);
        await applyImageUpdate(name, rollout, tool, deps);
      }
    } catch (error) {
      if (error.code === 'OWNER_APPROVAL_REQUIRED') throw error;
      canaryFailure(tool, rollout, name, 'canary', state, file, deps, now);
    }
    try {
      await deps.smoke(name, rollout.imageTag);
      await deps.readers(name);
    } catch (error) {
      canaryFailure(tool, rollout, name, 'canary', state, file, deps, now);
    }
    row.stage = 'soaking';
    row.soakUntil = currentTime(now) + TOOLS_PROMOTE_SOAK_MS;
    savePromotionState(file, state);
    stage = 'soaking';
  }

  if (isCanary && stage === 'soaking') {
    await waitForSoak(rollout, row, state, file, deps, now);
    return;
  }

  if (!isCanary && stage === 'promoting') {
    try {
      const before = validateStatus(await deps.status(name), name);
      if (before.pinsHash !== rollout.pinsHash) {
        await drain(name, deps, now, timeoutMs, pollMs);
        await applyImageUpdate(name, rollout, tool, deps);
      }
    } catch (error) {
      if (error.code === 'OWNER_APPROVAL_REQUIRED') throw error;
      markFailed(state, file, rollout, name, 'promoting', 'factory-update-failed', now);
      throw new Error(`Factory ${name} update failed. The rollout stopped.`);
    }
    row.stage = 'done';
    savePromotionState(file, state);
  }
}

export async function runToolsPromote(args, options = {}) {
  const { tool, dryRun } = parse(args);
  const pinsFile = options.pinsFile ?? PIN_FILE;
  const pins = readPins(pinsFile);
  const version = pinVersion(tool, pins);
  const bytes = fs.readFileSync(pinsFile);
  const pinsHash = createHash('sha256').update(bytes).digest('hex');
  const imageTag = `herdr-boss-factory:${pinsHash}`;
  const dataDir = options.dataDir ?? DATA_DIR;
  const stateFile = options.stateFile ?? path.join(dataDir, TOOLS_PROMOTE_FILE);
  const output = options.output ?? console.log;
  const now = options.now ?? Date.now;
  const deps = {
    ...defaultDependencies(options, imageTag),
    ...options,
    dataDir,
    now,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const order = validateFactories(await deps.factories());
  if (dryRun) {
    output(`Would promote ${tool} ${version}: ${TOOLS_PROMOTE_CANARY} first, then ${order.slice(1).join(', ') || 'no other factories'}; wait 24 hours after the canary checks.`);
    return 0;
  }

  const timeoutMs = options.drainTimeoutMs ?? TOOLS_PROMOTE_DRAIN_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? TOOLS_PROMOTE_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 1) throw new Error('The factory drain limits are invalid.');
  ensureDataDir(dataDir);
  const release = acquireLock(path.join(dataDir, 'tools-promote.lock'), 'A tools promotion is already running. Retry later.');
  try {
    const state = readPromotionState(stateFile);
    const rollout = getRollout(state, tool, version, pinsHash, imageTag, order, now);
    savePromotionState(stateFile, state);
    for (const name of order) {
      await promoteFactory({ name, isCanary: name === TOOLS_PROMOTE_CANARY, state, file: stateFile, rollout, tool, deps, now, timeoutMs, pollMs });
    }
    rollout.completedAt = currentTime(now);
    savePromotionState(stateFile, state);
    output(`Promoted ${tool} ${version} to ${order.join(', ')}.`);
    return 0;
  } finally { release(); }
}
