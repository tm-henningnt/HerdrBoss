import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withMutationLock } from './locks.js';
import { processStartIdentity } from './process-info.js';
import { getProcessInfo } from '../process-facts.js';

const RELEASE_WAIT_MS = 60_000;

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function readOwner(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0
      && typeof owner.token === 'string' && owner.token.length > 0
      && (owner.pidStart === null || validStart(owner.pidStart)) ? { ...owner, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}

function validStart(start) { return typeof start === 'string' && start.length <= 256 && Number.isFinite(Date.parse(start)); }
function normalizeStart(start) { return validStart(start) ? start.trim().replace(/\s+/g, ' ') : null; }

function ownerAlive(owner, readProcessStart, readProcessFacts) {
  if (readProcessFacts) {
    const facts = readProcessFacts(owner.pid);
    if (!facts.known) return true;
    if (!facts.alive) return false;
    const currentStart = normalizeStart(facts.start);
    return !currentStart || !owner.pidStart || currentStart === normalizeStart(owner.pidStart);
  }
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code !== 'EPERM') throw error; }
  const currentStart = normalizeStart(readProcessStart(owner.pid));
  // An unreadable identity is not proof of death, regardless of the lock file age.
  if (!currentStart || !owner.pidStart) return true;
  return currentStart === normalizeStart(owner.pidStart);
}

// Use the mutation guard only for short owner-record changes. A long TUI start must not
// hold that guard: the shared mutation guard can expire after 60 seconds.
export function withOpenCodeStartLock(dataDir, operation, {
  wait = pause, output = console.log, timeoutMs = 300_000, now = () => performance.now(),
  readProcessStart = processStartIdentity, mutationLock = withMutationLock, wallNow = Date.now,
  readProcessFacts = readProcessStart === processStartIdentity ? getProcessInfo : null,
} = {}) {
  const deadline = now() + timeoutMs;
  const timedOut = () => new Error(`OpenCode start lock is still busy after ${timeoutMs / 1000} s. No TUI was launched; retry after the other start finishes.`);
  const directory = path.join(dataDir, 'opencode-start');
  const file = path.join(directory, 'owner.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let announced = false;
  for (;;) {
    let acquired = false;
    try {
      acquired = mutationLock(directory, () => {
        if (timeoutMs > 0 && now() >= deadline) throw timedOut();
        const owner = readOwner(file);
        if (owner && ownerAlive(owner, readProcessStart, readProcessFacts)) return false;
        const pidStart = normalizeStart(readProcessStart(process.pid));
        if (timeoutMs > 0 && now() >= deadline) throw timedOut();
        const temporary = path.join(directory, `${token}.tmp`);
        try {
          fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, pidStart, token }), { mode: 0o600, flag: 'wx' });
          fs.rmSync(file, { force: true });
          fs.renameSync(temporary, file);
        } finally { fs.rmSync(temporary, { force: true }); }
        return true;
      }, { waitMs: Math.min(5000, Math.max(0, deadline - now())) });
    } catch (error) {
      if (error.code !== 'ELOCKBUSY') throw error;
    }
    if (acquired) break;
    if (!announced) { output('Waiting for OpenCode start lock (another TUI is starting).'); announced = true; }
    const remaining = deadline - now();
    if (remaining <= 0) throw timedOut();
    wait(Math.min(100, remaining));
  }
  try { return operation(); }
  finally {
    // A waiting process can claim the guard again and again. A busy guard must not fail a start that already ran.
    // Retry until the owner record is released or the guard wait ends.
    const releaseDeadline = now() + RELEASE_WAIT_MS;
    for (;;) {
      try {
        mutationLock(directory, () => {
          const owner = readOwner(file);
          if (owner?.pid === process.pid && owner.token === token) fs.unlinkSync(file);
        });
        break;
      } catch (error) {
        if (error.code !== 'ELOCKBUSY' || now() >= releaseDeadline) throw error;
        wait(Math.min(50, Math.max(0, releaseDeadline - now())));
      }
    }
  }
}

function agentMissing(error) {
  return error?.code === 'agent_not_found' || /\bagent_not_found\b/.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
}

function failedAgent(name, paneId, kind, herdr) {
  let agent;
  try { const result = herdr(['agent', 'get', name]); agent = result?.agent ?? result; }
  catch (error) { if (agentMissing(error)) return null; throw new Error(`Cannot verify the TUI: ${error.message}`); }
  if (!agent || agent.name !== name || (agent.pane_id ?? agent.pane) !== paneId || (agent.agent ?? agent.kind) !== kind
    || !['idle', 'done'].includes(agent.agent_status ?? agent.status)) {
    throw new Error('Relaunch stopped: the pane is busy, unknown, or no longer owns this agent.');
  }
  return agent;
}

// A missing registration can leave a shell pane. Check that no replacement agent owns
// it before closing the pane created by this start.
export function closeFailedWorkerPane(name, kind, paneId, workspaceId, worktree, herdr) {
  const agent = failedAgent(name, paneId, kind, herdr);
  let pane;
  try { const result = herdr(['pane', 'get', paneId]); pane = result?.pane ?? result; }
  catch (error) {
    if (error?.code === 'pane_not_found' || /\bpane_not_found\b/.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`)) return;
    throw error;
  }
  const cwd = pane?.foreground_cwd ?? pane?.cwd;
  if ((pane?.pane_id ?? pane?.id) !== paneId || (pane?.workspace_id ?? pane?.workspace) !== workspaceId
    || !cwd || path.resolve(cwd) !== path.resolve(worktree) || ['orch', 'boss', 'parked'].includes(pane?.label)
    || (pane?.agent && (pane.agent !== kind || !['idle', 'done'].includes(pane.agent_status ?? pane.status)))) {
    throw new Error('Failed-start pane was kept because its ownership or state could not be confirmed.');
  }
  if (!agent) {
    const result = herdr(['agent', 'list']);
    const agents = Array.isArray(result) ? result : result?.agents;
    if (pane.agent || !Array.isArray(agents) || agents.some((item) => (item.pane_id ?? item.pane) === paneId || item.name === name)) {
      throw new Error('Failed-start pane was kept because a replacement or unknown agent can still own it.');
    }
  }
  herdr(['pane', 'close', paneId]);
}

export function retryOpenCodeStart(name, paneId, operation, { herdr, output = console.log } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return operation(attempt); }
    catch (error) {
      // A launch block marks the model. A refused flag is a CLI problem. Another launch of the same model cannot work.
      if (error?.code === 'model_launch_blocked' || error?.code === 'opencode_unsupported_flag') throw error;
      const failure = (detail = '') => new Error(`OpenCode worker ${name} failed after ${attempt} launch attempts: ${error.message}${detail}`, { cause: error });
      if (attempt === 3) throw failure();
      let agent;
      try { agent = failedAgent(name, paneId, 'opencode', herdr); }
      catch (lookupError) { throw failure(` ${lookupError.message}`); }
      if (agent) {
        try { herdr(['agent', 'close', name]); }
        catch (closeError) { if (!agentMissing(closeError)) throw failure(` TUI close failed: ${closeError.message}`); }
      }
      output(`Relaunching OpenCode worker ${name} (${attempt + 1}/3): ${error.message}`);
    }
  }
}
