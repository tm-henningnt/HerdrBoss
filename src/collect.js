import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH].join(':');

export function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PATH } }, (err, stdout, stderr) => {
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
  return lines.slice(header + 1).map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 2 && cells[0] && cells[1])
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

const QUOTA_TIMEOUT_MS = 240000;

// Replace the generic "Command failed" text with the cause: a timeout or the exit code.
export function codexbarError(err, timeoutMs = QUOTA_TIMEOUT_MS) {
  if (err?.killed || err?.signal) return `codexbar timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (Number.isInteger(err?.code)) {
    const line = String(err.stderr || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    return `codexbar exited with code ${err.code}${line ? `: ${line}` : ''}`;
  }
  return `codexbar failed: ${err?.message || err}`;
}

export async function collectQuotas({ runner = run } = {}) {
  let out;
  try { out = await runner('codexbar', ['usage', '--format', 'json'], { timeout: QUOTA_TIMEOUT_MS }); }
  catch (err) { throw new Error(codexbarError(err)); }
  const rows = JSON.parse(out);
  return rows.map((r) => {
    if (r.error) return { provider: r.provider, error: r.error.message };
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
    return {
      provider: r.provider,
      plan: u.loginMethod || u.identity?.loginMethod || null,
      windows,
      credits: r.credits ? { remaining: r.credits.remaining } : null,
      resetCredits: u.codexResetCredits?.availableCount ?? null,
      updatedAt: u.updatedAt || null,
    };
  });
}

// ---------- Machine ----------

export async function collectMachine(dataDir = os.homedir()) {
  const [mp, swap, idle] = await Promise.all([
    run('memory_pressure', []).catch(() => ''),
    run('sysctl', ['-n', 'vm.swapusage']).catch(() => ''),
    run('ioreg', ['-c', 'IOHIDSystem']).catch(() => ''),
  ]);
  const free = /free percentage:\s*(\d+)%/.exec(mp);
  const sw = /used = ([\d.]+)M/.exec(swap);
  const swTotal = /total = ([\d.]+)M/.exec(swap);
  const ownerIdleMinutes = parseOwnerIdleMinutes(idle);
  const [l1, l5, l15] = os.loadavg();
  let diskFreeBytes = null, diskTotalBytes = null, diskFreePercent = null;
  try {
    const disk = await fs.promises.statfs(dataDir);
    diskFreeBytes = Number(disk.bavail) * Number(disk.bsize);
    diskTotalBytes = Number(disk.blocks) * Number(disk.bsize);
    if (diskTotalBytes > 0) diskFreePercent = diskFreeBytes / diskTotalBytes * 100;
  } catch {}
  return {
    cpus: os.cpus().length,
    ownerIdleMinutes,
    memTotalGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    memFreePercent: free ? Number(free[1]) : null,
    swapUsedMB: sw ? Math.round(Number(sw[1])) : null,
    swapTotalMB: swTotal ? Math.round(Number(swTotal[1])) : null,
    diskFreeBytes, diskTotalBytes, diskFreePercent,
    load: [l1, l5, l15].map((x) => +x.toFixed(2)),
  };
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
