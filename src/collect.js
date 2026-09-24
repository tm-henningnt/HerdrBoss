import { execFile } from 'node:child_process';
import os from 'node:os';

const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH].join(':');

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
  return {
    workspaces: ws.workspaces.map((w) => ({ id: w.workspace_id, label: w.label, status: w.agent_status, panes: w.pane_count, tabs: w.tab_count })),
    panes: panes.panes.map((p) => ({
      id: p.pane_id,
      workspace: p.workspace_id,
      tab: p.tab_id,
      tabLabel: tabLabel[p.tab_id] || null,
      label: p.label || null,
      orch: p.label === orchLabel,
      agent: p.agent || null,
      name: agentName[p.pane_id] || null,
      status: p.agent ? p.agent_status : null,
      cwd: p.foreground_cwd || p.cwd,
      title: p.terminal_title_stripped || '',
      shellPid: shellPidCache.get(p.pane_id) || null,
    })),
  };
}

// ---------- Quotas ----------

export async function collectQuotas() {
  const out = await run('codexbar', ['usage', '--format', 'json'], { timeout: 90000 });
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

export async function collectMachine() {
  const [mp, swap] = await Promise.all([
    run('memory_pressure', []).catch(() => ''),
    run('sysctl', ['-n', 'vm.swapusage']).catch(() => ''),
  ]);
  const free = /free percentage:\s*(\d+)%/.exec(mp);
  const sw = /used = ([\d.]+)M/.exec(swap);
  const swTotal = /total = ([\d.]+)M/.exec(swap);
  const [l1, l5, l15] = os.loadavg();
  return {
    cpus: os.cpus().length,
    memTotalGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    memFreePercent: free ? Number(free[1]) : null,
    swapUsedMB: sw ? Math.round(Number(sw[1])) : null,
    swapTotalMB: swTotal ? Math.round(Number(swTotal[1])) : null,
    load: [l1, l5, l15].map((x) => +x.toFixed(2)),
  };
}

// ---------- Processes / browsers ----------

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
