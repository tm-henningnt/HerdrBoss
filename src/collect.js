import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from './config.js';
import { collectLinuxMachine } from './linux-machine.js';

const PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH].join(':');

export function run(cmd, args, { timeout = 30000, killSignal = 'SIGTERM' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, killSignal, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PATH } }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); } else resolve(stdout);
    });
  });
}

async function herdrJson(args) {
  const out = await run('herdr', args);
  return JSON.parse(out).result;
}

// ---------- Pi models ----------

// `pi --list-models` prints only the models that Pi can use, as a table with a header row.
// Returns the provider/model strings, or null when the output has no header row.
export function parsePiModels(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*provider\s+model(\s|$)/i.test(line));
  if (header < 0) return null;
  return lines.slice(header + 1).filter((line) => !/^\s*warning:/i.test(line)).map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 2 && cells[0] && cells[1])
    .map(([provider, model]) => `${provider}/${model}`);
}

// The only input is the model table. Never read Pi credential files or keys here.
export async function collectPiModels({ now = Date.now(), runner = run } = {}) {
  try {
    const models = parsePiModels(await runner('pi', ['--list-models'], { timeout: 30000 }));
    return models ? { at: now, models } : null;
  } catch { return null; }
}

// ---------- Herdr ----------

const shellPidCache = new Map(); // pane_id -> shell_pid

export async function collectHerdr(orchLabel) {
  const [ws, tabs, panes, agents] = await Promise.all([
    herdrJson(['workspace', 'list']),
    herdrJson(['tab', 'list']),
    herdrJson(['pane', 'list']),
    herdrJson(['agent', 'list']),
  ]);
  const agentName = Object.fromEntries(agents.agents.filter((a) => a.name).map((a) => [a.pane_id, a.name]));
  const live = new Set(panes.panes.map((p) => p.pane_id));
  for (const id of shellPidCache.keys()) if (!live.has(id)) shellPidCache.delete(id);
  await Promise.all(panes.panes.filter((p) => !shellPidCache.has(p.pane_id)).map(async (p) => {
    try {
      const r = await herdrJson(['pane', 'process-info', '--pane', p.pane_id]);
      shellPidCache.set(p.pane_id, r.process_info.shell_pid);
    } catch {}
  }));
  const tabLabel = Object.fromEntries(tabs.tabs.map((t) => [t.tab_id, t.label]));
  const workspaceLabel = Object.fromEntries(ws.workspaces.map((w) => [w.workspace_id, w.label]));
  return {
    workspaces: ws.workspaces.map((w) => ({ id: w.workspace_id, label: w.label, status: w.agent_status, panes: w.pane_count, tabs: w.tab_count })),
    panes: panes.panes.map((p) => ({
      id: p.pane_id,
      workspace: p.workspace_id,
      workspaceLabel: workspaceLabel[p.workspace_id] || null,
      tab: p.tab_id,
      tabLabel: tabLabel[p.tab_id] || null,
      label: p.label || null,
      orch: p.label === orchLabel || p.label === 'boss',
      agent: p.agent || null,
      name: agentName[p.pane_id] || null,
      sessionId: p.agent_session?.kind === 'id' ? p.agent_session.value : null,
      status: p.agent ? p.agent_status : null,
      cwd: p.foreground_cwd || p.cwd,
      title: p.terminal_title_stripped || '',
      shellPid: shellPidCache.get(p.pane_id) || null,
    })),
  };
}

// ---------- Quotas ----------

export const QUOTA_PROVIDERS = Object.freeze(['codex', 'claude', 'opencodego']);
export const QUOTA_TIMEOUT_BACKOFF_MS = Object.freeze([20_000, 45_000, 90_000]);
export const QUOTA_TIMEOUT_BACKOFF_BY_PROVIDER_MS = Object.freeze({
  codex: QUOTA_TIMEOUT_BACKOFF_MS,
  claude: Object.freeze([60_000, 90_000]),
  opencodego: QUOTA_TIMEOUT_BACKOFF_MS,
});
export const DEFAULT_QUOTA_TIMEOUTS_MS = Object.freeze(Object.fromEntries(QUOTA_PROVIDERS.map((provider) => [provider, QUOTA_TIMEOUT_BACKOFF_BY_PROVIDER_MS[provider][0]])));
export const QUOTA_PROBE_HISTORY_LIMIT = 100;
const QUOTA_PROBE_HISTORY_FILE = path.join(DATA_DIR, 'quota-probe-history.jsonl');
const DEFAULT_QUOTA_TIMEOUT_MS = QUOTA_TIMEOUT_BACKOFF_MS[0];
const QUOTA_KILL_GRACE_MS = 3000;
const QUOTA_KILL_SETTLE_MS = 250;

// Signal the owned child by PID. Its private process group also contains children it started.
export function runQuotaCommand(cmd, args, { timeout = DEFAULT_QUOTA_TIMEOUT_MS, maxBuffer = 32 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PATH },
    });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, tooLarge = false, settled = false;
    let timer, killGraceTimer, killSettleTimer, killStarted = false, killSignal = null;
    const clearTimers = () => { clearTimeout(timer); clearTimeout(killGraceTimer); clearTimeout(killSettleTimer); };
    const destroyStdio = () => {
      for (const stream of child.stdio || []) {
        try { stream?.destroy(); } catch {}
      }
    };
    const timeoutError = (signal) => {
      const error = new Error(`codexbar timed out after ${Math.round(timeout / 1000)} s`);
      error.killed = true;
      error.signal = signal || killSignal;
      error.killedPid = child.pid || null;
      error.killedPidState = killedPidState();
      error.stdout = stdout;
      error.stderr = stderr;
      return error;
    };
    const tooLargeError = () => {
      const error = new Error('codexbar returned too much output');
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      error.stdout = stdout;
      error.stderr = stderr;
      return error;
    };
    const finishKilled = (signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const error = timedOut ? timeoutError(signal) : tooLargeError();
      destroyStdio();
      reject(error);
    };
    const killAndSettle = () => {
      if (killStarted) return;
      killStarted = true;
      clearTimeout(timer);
      killSignal = timedOut ? 'SIGTERM' : 'SIGKILL';
      killTree(killSignal);
      if (timedOut) {
        killGraceTimer = setTimeout(() => {
          killSignal = 'SIGKILL';
          killTree(killSignal);
          killSettleTimer = setTimeout(() => finishKilled(killSignal), QUOTA_KILL_SETTLE_MS);
        }, QUOTA_KILL_GRACE_MS);
      } else killSettleTimer = setTimeout(() => finishKilled(killSignal), QUOTA_KILL_SETTLE_MS);
    };
    const killedPidState = () => {
      if (!child.pid) return 'unknown';
      // An observed exit is the answer; a pid probe could hit an unrelated process that reused the pid.
      if (child.exitCode !== null || child.signalCode !== null) return 'exited';
      try { process.kill(child.pid, 0); return 'alive'; }
      catch (error) { return error.code === 'ESRCH' ? 'exited' : 'unknown'; }
    };
    const killTree = (signal) => {
      try { child.kill(signal); } catch {}
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); } catch {}
      }
    };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        tooLarge = true;
        killAndSettle();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', (error) => {
      if (settled) return;
      if (killStarted) { finishKilled(killSignal); return; }
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once('exit', (_code, signal) => {
      // A grandchild can keep the pipes open after the timed-out parent exits.
      if (killStarted) {
        // Reap children in the owned group even if they ignored SIGTERM and hold the pipes.
        killTree('SIGKILL');
        finishKilled(signal || killSignal);
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        reject(timeoutError(signal));
      } else if (tooLarge) {
        reject(tooLargeError());
      } else if (code !== 0) {
        const error = new Error('Command failed');
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
    timer = setTimeout(() => {
      timedOut = true;
      killAndSettle();
    }, Math.max(1, timeout));
  });
}

// Replace the generic "Command failed" text with the cause: a timeout or the exit code.
export function codexbarError(err, timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS, provider = null) {
  const name = provider === 'claude' ? 'Claude usage probe' : provider ? `${provider} quota probe` : 'codexbar';
  if (err?.killed || err?.signal) return `${name} timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (Number.isInteger(err?.code)) {
    const line = String(err.stderr || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    return `${name} exited with code ${err.code}${line ? `: ${line}` : ''}`;
  }
  return `${name} failed: ${err?.message || err}`;
}

// A missing usage reader or login makes the reading unknown. The probe did not fail, so this never warns the Boss,
// backs off the provider, or counts as failed quota data. A container factory has no CodexBar on Linux.
const MISSING_READER = /\bENOENT\b|command not found|not found on this machine/i;
const MISSING_LOGIN = /not logged in|not authenticated|no (?:credentials|login)\b|login (?:required|expired|is missing)|sign in\b/i;
export function quotaUnavailableReason(value) {
  const text = String(value?.message || value || '');
  if (MISSING_READER.test(text)) return 'no usage reader in this factory';
  if (MISSING_LOGIN.test(text)) return 'no login for this harness in this factory';
  return null;
}

function partialRows(err) {
  if (err?.killed || err?.signal || !Number.isInteger(err?.code)) return null;
  try {
    const rows = JSON.parse(String(err.stdout || ''));
    return Array.isArray(rows) && rows.length && rows.every((r) => r && typeof r.provider === 'string') ? rows : null;
  } catch { return null; }
}

async function codexbarRows(runner, args, timeoutMs) {
  try {
    const rows = JSON.parse(await runner('codexbar', ['usage', '--format', 'json', ...args], { timeout: timeoutMs }));
    if (!Array.isArray(rows) || !rows.every((row) => row && typeof row.provider === 'string')) throw new Error('codexbar returned invalid quota rows');
    return rows;
  }
  catch (err) {
    // codexbar may exit 1 while still returning the selected provider row.
    const rows = partialRows(err);
    if (!rows) throw err;
    return rows;
  }
}

function quotaProbeOutcome(row, error = null) {
  if (error) return error.killed || error.signal || /timed out/i.test(error.message || '') ? 'timeout' : 'failed';
  if (!row || row.error) {
    const message = typeof row?.error === 'string' ? row.error : row?.error?.message || '';
    return /timed out/i.test(message) ? 'timeout' : 'failed';
  }
  return 'success';
}

// Name the step that ended the probe: our own timer, codexbar (its own timeout, an error row, or its exit), or a missing row.
function quotaProbeEndedStep(row, error) {
  if (error) {
    if (error.killed || error.signal) return 'our-timer';
    if (Number.isInteger(error.code)) return 'codexbar-exit';
    return /row is missing/.test(error.message || '') ? 'row-missing' : 'spawn-error';
  }
  if (row?.error) {
    const message = typeof row.error === 'string' ? row.error : row.error.message || '';
    return /timed out/i.test(message) ? 'codexbar-timeout' : 'codexbar-error';
  }
  return 'completed';
}

function writeQuotaProbeHistory(row, file = QUOTA_PROBE_HISTORY_FILE) {
  let rows = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  rows.push(row);
  rows = rows.slice(-QUOTA_PROBE_HISTORY_LIMIT);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
  } catch {}
}

export async function collectQuotas({ runner = runQuotaCommand, timeouts = DEFAULT_QUOTA_TIMEOUTS_MS, now = () => Date.now(), historyFile = QUOTA_PROBE_HISTORY_FILE, providers = QUOTA_PROVIDERS } = {}) {
  const result = [];
  for (const provider of QUOTA_PROVIDERS) {
    if (!providers.includes(provider)) continue;
    const timeoutMs = Number.isFinite(timeouts?.[provider]) ? timeouts[provider] : DEFAULT_QUOTA_TIMEOUTS_MS[provider];
    let row = null, failure = null;
    const startedAt = Number(now());
    try {
      const rows = await codexbarRows(runner, ['--provider', provider], timeoutMs);
      row = rows.find((item) => item.provider === provider) || null;
      if (!row) failure = new Error(`${provider} quota row is missing`);
    } catch (error) { failure = error; }
    const finishedAt = Number(now());
    const killedPid = Number.isInteger(failure?.killedPid) && failure.killedPid > 0 ? failure.killedPid : null;
    const killedPidState = ['exited', 'alive', 'unknown'].includes(failure?.killedPidState) ? failure.killedPidState : null;
    const rowErrorText = row?.error ? (typeof row.error === 'string' ? row.error : row.error.message || '') : '';
    const unavailable = failure ? quotaUnavailableReason(failure) : quotaUnavailableReason(rowErrorText);
    writeQuotaProbeHistory({
      at: new Date(finishedAt).toISOString(), provider,
      durationMs: Math.max(0, finishedAt - startedAt), timeoutMs, outcome: unavailable ? 'unavailable' : quotaProbeOutcome(row, failure),
      endedStep: quotaProbeEndedStep(row, failure),
      killedPid, killedPidState,
      killSignal: ['SIGTERM', 'SIGKILL'].includes(failure?.signal) ? failure.signal : null,
    }, historyFile);
    if (failure) {
      result.push(unavailable
        ? { provider, unavailable: true, reason: unavailable, error: unavailable }
        : { provider, error: codexbarError(failure, timeoutMs, provider) });
      continue;
    }
    if (row.error) {
      const text = rowErrorText || `${provider} quota probe failed`;
      result.push(unavailable
        ? { provider, unavailable: true, reason: unavailable, error: unavailable }
        : { provider, error: text });
      continue;
    }
    const r = row;
    const u = r.usage || {};
    const labels = r.rateWindowLabels || {};
    const windows = [];
    for (const key of ['primary', 'secondary', 'tertiary']) {
      const w = u[key];
      if (!w) continue;
      const pace = r.pace?.[key];
      windows.push({
        key,
        label: labels[key] || key,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt || null,
        windowMinutes: w.windowMinutes,
        expectedPercent: pace?.expectedUsedPercent ?? null,
        willLast: pace ? pace.willLastToReset : null,
        etaSeconds: pace?.etaSeconds ?? null,
        paceSummary: pace?.summary || null,
      });
    }
    for (const x of u.extraRateWindows || []) {
      windows.push({ key: x.id, label: x.title, usedPercent: x.window.usedPercent, resetsAt: x.window.resetsAt, windowMinutes: x.window.windowMinutes, extra: true });
    }
    const seenCreditKeys = new Map();
    const resetCredits = Array.isArray(u.codexResetCredits?.credits)
      ? u.codexResetCredits.credits.slice(0, 100).flatMap((credit) => {
        if (!credit || typeof credit !== 'object' || Array.isArray(credit)) return [];
        const providerId = [credit.id, credit.credit_id, credit.creditId].find((value) => typeof value === 'string' && value.trim() && value.length <= 128);
        const granted = Date.parse(credit.granted_at);
        const expires = Date.parse(credit.expires_at);
        // Without a provider id, derive a stable id from the grant and expiry times, so a changed list does not rename a credit.
        const timeKey = `${credit.granted_at}|${credit.expires_at}`;
        const occurrence = seenCreditKeys.get(timeKey) || 0;
        seenCreditKeys.set(timeKey, occurrence + 1);
        const fallbackId = `credit-${createHash('sha1').update(timeKey).digest('hex').slice(0, 10)}${occurrence ? `-${occurrence + 1}` : ''}`;
        return [{
          id: providerId || fallbackId,
          status: typeof credit.status === 'string' && credit.status.length <= 40 ? credit.status : 'unknown',
          grantedAt: Number.isFinite(granted) ? new Date(granted).toISOString() : null,
          expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
        }];
      })
      : [];
    result.push({
      provider: r.provider,
      plan: u.loginMethod || u.identity?.loginMethod || null,
      windows,
      credits: r.credits ? { remaining: r.credits.remaining } : null,
      resetCredits: u.codexResetCredits?.availableCount ?? null,
      ...(resetCredits.length ? { codexResetCredits: resetCredits } : {}),
      updatedAt: u.updatedAt || null,
      observedAt: new Date(finishedAt).toISOString(),
    });
  }
  return result;
}

// A provider reading becomes stale after three hours. Keep it after that point for pacing and display.
export const STALE_QUOTA_MS = 3 * 60 * 60 * 1000;

// Replace a failed or missing provider row with its last good row. Preserve the original read time.
export function keepStaleRows(quotas, previous, previousAt, now = Date.now()) {
  const rows = Array.isArray(quotas) ? quotas : [];
  const oldRows = Array.isArray(previous) ? previous : [];
  const seen = new Set(rows.map((row) => row.provider));
  const current = rows.map((q) => {
    if (!q.error) return q;
    const old = oldRows.find((x) => x.provider === q.provider && (!x.error || x.stale));
    if (!old) return q;
    const since = old.stale ? Date.parse(old.staleSince) : Date.parse(old.observedAt) || Date.parse(old.updatedAt) || previousAt;
    if (!Number.isFinite(since)) return q;
    const { stale, staleSince, error, ...data } = old;
    // An unavailable reader keeps its marker, so the row shows unknown and not a failed probe.
    return { ...data, stale: true, staleSince: new Date(since).toISOString(), error: q.error,
      ...(q.unavailable ? { unavailable: true, ...(q.reason ? { reason: q.reason } : {}) } : {}) };
  });
  for (const old of oldRows) {
    if (seen.has(old.provider)) continue;
    const since = old.stale ? Date.parse(old.staleSince) : Date.parse(old.observedAt) || Date.parse(old.updatedAt) || previousAt;
    if (!Number.isFinite(since)) continue;
    const { stale, staleSince, error, ...data } = old;
    current.push({ ...data, stale: true, staleSince: new Date(since).toISOString(), error: error || 'Quota row missing from the latest probe.' });
  }
  return current;
}

// ---------- Machine ----------

export async function collectMachine(dataDir = os.homedir(), { platform = process.platform, runner = run, system = os, ...linuxOptions } = {}) {
  if (platform === 'linux') {
    const sample = await collectLinuxMachine({ system, ...linuxOptions });
    return { ...sample, ...await collectDisk(dataDir) };
  }
  const [mp, swap, idle] = await Promise.all([
    runner('memory_pressure', []).catch(() => ''),
    runner('sysctl', ['-n', 'vm.swapusage']).catch(() => ''),
    runner('ioreg', ['-c', 'IOHIDSystem']).catch(() => ''),
  ]);
  const free = /free percentage:\s*(\d+)%/.exec(mp);
  const sw = /used = ([\d.]+)M/.exec(swap);
  const swTotal = /total = ([\d.]+)M/.exec(swap);
  const ownerIdleMinutes = parseOwnerIdleMinutes(idle);
  const [l1, l5, l15] = system.loadavg();
  return {
    cpus: system.cpus().length,
    ownerIdleMinutes,
    memTotalGB: +(system.totalmem() / 2 ** 30).toFixed(1),
    memFreePercent: free ? Number(free[1]) : null,
    swapUsedMB: sw ? Math.round(Number(sw[1])) : null,
    swapTotalMB: swTotal ? Math.round(Number(swTotal[1])) : null,
    ...await collectDisk(dataDir),
    load: [l1, l5, l15].map((x) => +x.toFixed(2)),
  };
}

async function collectDisk(dataDir) {
  let diskFreeBytes = null, diskTotalBytes = null, diskFreePercent = null;
  try {
    const disk = await fs.promises.statfs(dataDir);
    diskFreeBytes = Number(disk.bavail) * Number(disk.bsize);
    diskTotalBytes = Number(disk.blocks) * Number(disk.bsize);
    if (diskTotalBytes > 0) diskFreePercent = diskFreeBytes / diskTotalBytes * 100;
  } catch {}
  return { diskFreeBytes, diskTotalBytes, diskFreePercent };
}

export async function checkMachineTools({ platform = process.platform, runner = run } = {}) {
  if (platform !== 'linux') return [];
  const checks = [
    ['lsof', ['-v'], 'lsof'],
    ['ps', ['--version'], 'procps'],
  ];
  return (await Promise.all(checks.map(async ([command, args, packageName]) => {
    try {
      const output = await runner(command, args, { timeout: 3000, killSignal: 'SIGKILL' });
      if (packageName !== 'procps' || /procps/i.test(output)) return null;
    } catch {}
    return `Linux machine tools: Install ${packageName}. Process checks need this package.`;
  }))).filter(Boolean);
}

const worktreeCache = new Map();
const WORKTREE_CACHE_MS = 5 * 60 * 1000;
export async function collectWorktreeCounts(panes, { now = Date.now(), runner = run } = {}) {
  const repos = new Map();
  for (const pane of panes || []) {
    if (!pane.orch || pane.label === 'boss' || /^boss$/i.test(pane.workspaceLabel || '') || !pane.cwd || !pane.workspace) continue;
    try {
      const commonPath = path.resolve((await runner('git', ['-C', pane.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3000 })).trim());
      const common = fs.existsSync(commonPath) ? fs.realpathSync(commonPath) : commonPath;
      if (!repos.has(common)) repos.set(common, { cwd: pane.cwd, workspace: pane.workspace });
    } catch {}
  }
  const result = {};
  for (const [common, repo] of repos) {
    let cached = worktreeCache.get(common);
    if (!cached || now - cached.at >= WORKTREE_CACHE_MS) {
      try {
        const out = await runner('git', ['-C', repo.cwd, 'worktree', 'list', '--porcelain'], { timeout: 3000 });
        const entries = out.trim().split(/\n\n+/).filter(Boolean);
        let linked = 0, prunable = 0;
        for (const entry of entries.slice(1)) {
          linked += 1;
          if (/\nprunable(?: |$)/.test(`\n${entry}`)) prunable += 1;
        }
        cached = { at: now, linked, prunable };
        worktreeCache.set(common, cached);
        while (worktreeCache.size > 64) worktreeCache.delete(worktreeCache.keys().next().value);
      } catch { worktreeCache.delete(common); continue; }
    }
    result[repo.workspace] = { linked: cached.linked, prunable: cached.prunable };
  }
  return result;
}

function worktreePaths(output, cwd) {
  return output.split(/\r?\n/).filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(cwd, line.slice('worktree '.length)));
}

function pathContains(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function definitelyMissing(file) {
  try { fs.statSync(file); return false; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

// Return only parent-PID-1 processes that still have a cwd in a missing Git worktree.
export async function collectMissingWorktreeProcesses(panes, processes, { runner = run } = {}) {
  const repos = new Map();
  const seenCwds = new Set();
  for (const pane of panes || []) {
    if (!pane.orch || pane.label === 'boss' || /^boss$/i.test(pane.workspaceLabel || '') || !pane.cwd || !pane.workspace) continue;
    let paneCwd = path.resolve(pane.cwd);
    try { paneCwd = fs.realpathSync(pane.cwd); } catch {}
    if (seenCwds.has(paneCwd)) continue;
    seenCwds.add(paneCwd);
    const commonPath = path.resolve((await runner('git', ['-C', pane.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3000 })).trim());
    let common = commonPath;
    try { common = fs.realpathSync(commonPath); } catch {}
    if (!repos.has(common)) repos.set(common, { cwd: pane.cwd, workspace: pane.workspace });
  }

  const result = [];
  const seen = new Set();
  for (const [common, repo] of repos) {
    const listed = await runner('git', ['-C', repo.cwd, 'worktree', 'list', '--porcelain'], { timeout: 3000 });
    for (const worktree of worktreePaths(listed, repo.cwd)) {
      if (!definitelyMissing(worktree)) continue;
      for (const process of processes || []) {
        if (Number(process.ppid) !== 1 || !process.cwd || !pathContains(worktree, process.cwd)) continue;
        const id = `${common}\0${worktree}\0${Number(process.pid)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
          pid: Number(process.pid),
          ppid: 1,
          command: path.basename(String(process.command || 'unknown')).split(/\s/, 1)[0].slice(0, 80) || 'unknown',
          cwd: process.cwd,
          worktree,
          workspace: repo.workspace,
        });
      }
    }
  }
  return result;
}

export function parseOwnerIdleMinutes(text) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text || '');
  if (!match) return null;
  const ns = Number(match[1]);
  return Number.isSafeInteger(ns) && ns >= 0 ? ns / 60e9 : null;
}

// ---------- Processes / browsers ----------

function parseCwdProcesses(output) {
  const processes = [];
  let current = null;
  const finish = () => { if (current?.cwd) processes.push(current); };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      finish();
      current = { pid: Number(line.slice(1)), ppid: null, command: null, cwd: null };
    } else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && line.startsWith('R')) current.ppid = Number(line.slice(1)) || null;
    else if (current && line.startsWith('n')) current.cwd = line.slice(1);
  }
  finish();
  return processes;
}

export async function collectCwdProcesses() {
  const output = await run('lsof', ['-a', '-d', 'cwd', '-FpcnR']);
  return parseCwdProcesses(output);
}

// Count connected CDP clients from the process table. The browser process and this service process are not agents.
export async function collectBrowserClients(port, { runner = run, servicePid = process.pid, browserPid = null } = {}) {
  if (!Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return null;
  let output;
  try { output = await runner('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:ESTABLISHED', '-Fp'], { timeout: 3000 }); }
  catch (error) {
    // lsof exits 1 with no output when there is no established connection.
    if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return 0;
    throw error;
  }
  const pids = new Set([...String(output).matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])));
  pids.delete(Number(servicePid));
  if (Number.isSafeInteger(Number(browserPid))) pids.delete(Number(browserPid));
  return pids.size;
}

function parseEtime(s) {
  // [[dd-]hh:]mm:ss
  let days = 0;
  if (s.includes('-')) { const [d, rest] = s.split('-'); days = Number(d); s = rest; }
  const parts = s.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export async function collectProcesses() {
  const out = await run('ps', ['-Ao', 'pid=,ppid=,etime=,pcpu=,rss=,command=']);
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), age: parseEtime(m[3]), cpu: Number(m[4]), rssMB: Math.round(Number(m[5]) / 1024), cmd: m[6] });
  }
  return procs;
}

const CHROME_MAIN = /(Google Chrome|Chromium|chrome-headless-shell|Brave Browser|Microsoft Edge)(\.app\/Contents\/MacOS\/[^/]+)?(\s|$)/;
const AUTOMATION = /--(headless|remote-debugging-port|remote-debugging-pipe|enable-automation)\b/;

function classify(p) {
  if (/agent-browser\/.*daemon\.js/.test(p.cmd)) return 'agent-browser-daemon';
  if (/chrome-devtools-mcp/.test(p.cmd) && !/^npm exec/.test(p.cmd) && /node .*chrome-devtools-mcp|^chrome-devtools-mcp/.test(p.cmd)) return 'devtools-mcp';
  if (/@playwright\/mcp|playwright-mcp/.test(p.cmd) && !/^npm exec/.test(p.cmd)) return 'playwright-mcp';
  if (!/--type=/.test(p.cmd) && CHROME_MAIN.test(p.cmd) && AUTOMATION.test(p.cmd)) return 'automation-chrome';
  return null;
}

// Follow the parent chain to the pane shell. Returns pane id or null.
function ownerPane(pid, procs, shellToPane) {
  let cur = procs.get(pid);
  const seen = new Set();
  while (cur && cur.ppid > 1 && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    if (shellToPane.has(cur.pid)) return shellToPane.get(cur.pid);
    cur = procs.get(cur.ppid);
  }
  return cur && shellToPane.has(cur.pid) ? shellToPane.get(cur.pid) : null;
}

function processLabel(cmd) {
  if (/Google Chrome|Chromium|chrome-headless-shell/.test(cmd)) return 'Chrome';
  const titled = /^node \((\w[\w-]*)/.exec(cmd);
  if (titled) return titled[1];
  const [first = '', second = ''] = cmd.split(' ');
  const base = first.split('/').pop();
  if (base === 'node' && second) return second.split('/').pop().replace(/\.m?js$/, '');
  return base;
}

// CPU per Herdr workspace: processes under a pane shell count for that pane's workspace, and a project
// browser counts for its project through the profile directory. The result names the largest process groups.
export function cpuUse(procs, panes, profileProjects = {}) {
  const shellToPane = new Map(panes.filter((p) => p.shellPid).map((p) => [p.shellPid, p.id]));
  const paneWorkspace = new Map(panes.map((p) => [p.id, p.workspace]));
  const use = {};
  for (const p of procs.values()) {
    if (!(p.cpu > 0)) continue;
    let key = null;
    const pane = ownerPane(p.pid, procs, shellToPane);
    if (pane) key = paneWorkspace.get(pane) || null;
    // A browser helper process can lack the profile flag, so look for it up the parent chain too.
    for (let cur = p, hops = 0; !key && cur && hops < 6; cur = procs.get(cur.ppid), hops += 1) {
      const profile = /--user-data-dir=(\S+)/.exec(cur.cmd)?.[1];
      if (profile && profileProjects[profile]) key = profileProjects[profile];
    }
    key ||= 'other';
    const entry = (use[key] ||= { cpu: 0, groups: {} });
    entry.cpu += p.cpu;
    const label = processLabel(p.cmd);
    const group = (entry.groups[label] ||= { label, cpu: 0, count: 0 });
    group.cpu += p.cpu; group.count += 1;
  }
  return Object.fromEntries(Object.entries(use).map(([key, entry]) => [key, {
    cpu: Math.round(entry.cpu),
    top: Object.values(entry.groups).sort((a, b) => b.cpu - a.cpu).slice(0, 3).map((g) => ({ label: g.label, cpu: Math.round(g.cpu), count: g.count })),
  }]));
}

export function findBrowsers(procs, panes, shared = []) {
  const shellToPane = new Map(panes.filter((p) => p.shellPid).map((p) => [p.shellPid, p.id]));
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const treeRss = (pid) => {
    let sum = 0; const stack = [pid];
    while (stack.length) { const x = stack.pop(); const p = procs.get(x); if (!p) continue; sum += p.rssMB; for (const c of children.get(x) || []) stack.push(c.pid); }
    return sum;
  };
  const result = [];
  for (const p of procs.values()) {
    const kind = classify(p);
    if (!kind) continue;
    // A launcher and its node child are one instance. Count the outermost process.
    if (procs.get(p.ppid) && classify(procs.get(p.ppid)) === kind) continue;
    const profile = /--user-data-dir=(\S+)/.exec(p.cmd)?.[1] || null;
    const port = /--remote-debugging-port=(\d+)/.exec(p.cmd)?.[1] || null;
    result.push({
      pid: p.pid,
      kind,
      age: p.age,
      cpu: p.cpu,
      rssMB: kind === 'automation-chrome' ? treeRss(p.pid) : p.rssMB,
      orphan: p.ppid === 1,
      children: (children.get(p.pid) || []).length,
      pane: ownerPane(p.pid, procs, shellToPane),
      profile,
      port,
      headless: /--headless/.test(p.cmd),
      shared: shared.find((s) => (s.port && String(s.port) === port) || (s.profile && s.profile === profile))?.label || null,
    });
  }
  return result.sort((a, b) => b.age - a.age);
}
