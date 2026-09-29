// Turns a snapshot into alerts and bulletin advice. Pure functions, no side effects.
import { dashboardUrl } from './config.js';
import { formatPacingGoalEnd, goalSummary, hasQuotaData, machineLimits, pacingGoal, pacingGoalEnd, POLICY_DEFAULTS, unmeteredClosedParts, unmeteredSummary, useNowLanes } from './control.js';
import { blockedWorkerAlerts } from './worker-failures.js';
import { kitRevision } from './kit/agents-check.js';
import { leaseBulletinLines } from './leases.js';

const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', opencodego: 'OpenCode Go' };
export const providerName = (p) => PROVIDER_NAMES[p] || p;

export function fmtDuration(sec) {
  if (sec == null) return '?';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
}

// Broadcast alerts go only to orchestrators whose workspace has a working or blocked non-orchestrator agent.
// An idle orchestrator in a quiet project has no work to adjust, and a prompt would only spend its tokens.
export function broadcastTargets(orchs, panes) {
  const busy = new Set((panes || []).filter((p) => p.agent && !p.orch && ['working', 'blocked'].includes(p.status)).map((p) => p.workspace));
  return orchs.filter((o) => busy.has(o.workspace));
}

// A task key component that is safe inside an alert key.
function taskKeyPart(task) {
  const source = String(task?.id || task?.title || '').trim();
  return source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
}

const OPEN_TASK_STATUS = new Set(['todo', 'doing', 'review']);
const FRONTIER_RANK = { current: 0, next: 2 };

// Open work whose blockers are all done in the same status file. An unknown blocker stays unresolved.
// A task in a held group is not actionable.
// The current frontier wins, then work without a frontier value, then the next frontier. File order breaks a tie.
function actionableTask(tasks, groups) {
  const list = Array.isArray(tasks) ? tasks : [];
  const held = new Set((Array.isArray(groups) ? groups : []).filter((group) => group?.held === true).map((group) => group.id));
  const byId = new Map(list.filter((task) => task?.id).map((task) => [task.id, task]));
  let best = null;
  for (const task of list) {
    if (!task || !OPEN_TASK_STATUS.has(task.status) || held.has(task.group)) continue;
    if (!(task.blockedBy || []).every((id) => byId.get(id)?.status === 'done')) continue;
    const rank = FRONTIER_RANK[task.frontier] ?? 1;
    if (!best || rank < best.rank) best = { task, rank };
  }
  return best?.task || null;
}

// One scoped notice per project: an orchestrator that stayed idle while its published status still has ready work.
function idleOrchestratorNudges(snap, paneSince = {}, now = Date.now(), policy = null) {
  const control = snap.control?.projects;
  if (!control) return [];
  const idleMs = (Number.isFinite(policy?.idleMinutes) ? policy.idleMinutes : POLICY_DEFAULTS.idleMinutes) * 60000;
  const panes = snap.herdr?.panes || [];
  const labels = new Map((snap.herdr?.workspaces || []).map((w) => [w.id, w.label]));
  const notices = [];
  for (const entry of Object.values(control)) {
    const mode = entry?.effectiveMode ?? entry?.mode;
    if (mode !== 'auto' && mode !== 'active') continue;
    const workspace = entry.workspace;
    const label = labels.get(workspace) || entry.label || workspace;
    if (!workspace || /^boss$/i.test(label)) continue;
    const published = (snap.projects || []).find((p) => p.slug === entry.slug) || (snap.projects || []).find((p) => p.workspace === workspace);
    if (!published) continue;
    const orch = panes.find((p) => p.workspace === workspace && p.orch && !/^boss$/i.test(p.label || ''));
    if (!orch || (orch.status !== 'idle' && orch.status !== 'done')) continue;
    const since = paneSince[orch.id]?.since;
    if (!Number.isFinite(since) || now - since < idleMs) continue;
    const local = panes.filter((p) => p.workspace === workspace);
    if (local.some((p) => p.agent && !p.orch && ['working', 'blocked', 'failed'].includes(p.status))) continue;
    const task = actionableTask(published.tasks, published.groups);
    if (!task) continue;
    const ready = local.filter((p) => p.agent && !p.orch && ['idle', 'done'].includes(p.status));
    const names = ready.map((p) => p.name || p.agent || p.id);
    const minutes = Math.round((now - since) / 60000);
    const ref = `task ${task.id ? `${task.id} ` : ''}"${task.title}"`;
    const firstLane = entry.slots > entry.running ? useNowLanes(snap.lanes)[0] : null;
    notices.push({
      key: `nudge:idle:${entry.slug || taskKeyPart(label)}:${taskKeyPart(task)}`,
      severity: 'info', scope: workspace,
      title: `Orchestrator idle with ready work in ${label}`,
      text: `The ${label} orchestrator has been idle for ${minutes} minutes while ${ref} is ready. ${firstLane ? `Start ready work on ${firstLane.kind} now.` : names.length ? `Resume an idle or done worker (${names.join(', ')}) or start suitable work.` : 'Start suitable work.'}`,
    });
  }
  return notices;
}

// A working worker counts for the stale status rule for this long.
export const STALE_STATUS_WORK_WINDOW_MS = 2 * 3600 * 1000;

// Published statuses that no longer describe the work. A status is stale when its updated time is older than
// staleStatusMinutes and, after that time, a worker was working in the last 2 hours or new commits landed.
// snap.statusActivity[slug] holds { workedAt, landedAt } in milliseconds. A paused project is never stale.
// prior is the result of the previous tick: an episode keeps its first stale time until a new publish.
export function staleStatuses(snap, cfg, now = Date.now(), prior = {}) {
  const limitMs = (Number.isFinite(cfg?.staleStatusMinutes) ? cfg.staleStatusMinutes : 120) * 60000;
  const result = {};
  for (const project of snap.projects || []) {
    const updatedMs = Date.parse(project?.updated);
    if (!project?.slug || !Number.isFinite(updatedMs) || now - updatedMs <= limitMs) continue;
    const control = snap.control?.projects?.[project.slug];
    if (project.status === 'paused' || (control?.effectiveMode ?? control?.mode) === 'paused') continue;
    const activity = snap.statusActivity?.[project.slug] || {};
    const workers = Number.isFinite(activity.workedAt) && activity.workedAt > updatedMs && now - activity.workedAt <= STALE_STATUS_WORK_WINDOW_MS;
    const commits = Number.isFinite(activity.landedAt) && activity.landedAt > updatedMs;
    if (!workers && !commits) continue;
    const earlier = prior?.[project.slug];
    result[project.slug] = {
      slug: project.slug, workspace: control?.workspace || null, updated: project.updated,
      since: earlier?.updated === project.updated && Number.isFinite(earlier.since) ? earlier.since : now,
      ageSeconds: Math.floor((now - updatedMs) / 1000), workers, commits,
    };
  }
  return result;
}

// One notice per project and stale episode. A new publish changes the updated time, so it starts a new key.
function staleStatusAlerts(stale) {
  return Object.values(stale).filter((item) => item.workspace).map((item) => {
    const reason = [item.workers ? 'workers ran' : null, item.commits ? 'new commits landed' : null].filter(Boolean).join(' and ');
    return {
      key: `status:stale:${item.slug}:${item.updated}`, severity: 'info', once: true, scope: item.workspace,
      title: `${item.slug} published status is stale`,
      text: `Your published status is ${fmtDuration(item.ageSeconds)} old while ${reason}. Run herdr-boss publish ${item.slug} <file> with the current plan and progress.`,
    };
  });
}

// alert: { key, severity: info|warn|critical, scope: 'all' | <workspace id> | 'user', title, text }
export function evaluate(snap, cfg, paneSince, now = Date.now(), policy = null) {
  const alerts = [];
  const advice = [];
  const avoidKinds = new Set();
  alerts.push(...blockedWorkerAlerts(snap, paneSince, now));
  alerts.push(...idleOrchestratorNudges(snap, paneSince, now, policy));
  alerts.push(...staleStatusAlerts(snap.staleStatus || staleStatuses(snap, cfg, now)));

  const orphanedPairs = new Set();
  const workspaceLabels = new Map((snap.herdr?.workspaces || []).map((workspace) => [workspace.id, workspace.label]));
  for (const process of snap.orphanedWorktreeProcesses || []) {
    const workspace = process.workspace;
    const pair = `${process.pid}\0${process.worktree}`;
    if (Number(process.ppid) !== 1 || !workspace || !process.worktree || !process.cwd || orphanedPairs.has(pair)) continue;
    if (/^boss$/i.test(workspaceLabels.get(workspace) || '')) continue;
    const orchestrator = (snap.herdr?.panes || []).some((pane) => pane.workspace === workspace && pane.orch && !/^boss$/i.test(pane.label || ''));
    if (!orchestrator) continue;
    orphanedPairs.add(pair);
    const executable = String(process.command || 'unknown').trim().split(/\s+/, 1)[0];
    const command = executable.split(/[\\/]/).pop() || 'unknown';
    alerts.push({
      key: `worktree:orphan:${process.pid}:${process.worktree}`,
      severity: 'warn', scope: workspace, once: true,
      title: `Process remains in a removed worktree`,
      text: `Process ${command} (pid ${process.pid}, ppid 1) still has cwd ${process.cwd} inside missing worktree ${process.worktree}. Check it before you prune the worktree record.`,
    });
  }

  // ----- Quotas -----
  for (const q of snap.quotas || []) {
    if (!hasQuotaData(q)) continue;
    if (policy?.providerModes?.[q.provider] === 'ignore') continue;
    const name = providerName(q.provider);
    for (const w of q.windows) {
      if (w.extra) continue;
      const reset = fmtTime(w.resetsAt);
      const kinds = q.provider === 'opencodego' ? [] : cfg.providerKinds[q.provider] || [];
      const lane = q.provider === 'opencodego' ? 'OpenCode Go models' : `${kinds.join('/') || name} agents`;
      if (w.usedPercent >= cfg.quota.criticalPercent) {
        kinds.forEach((k) => avoidKinds.add(k));
        alerts.push({
          key: `quota:${q.provider}:${w.key}:critical:${w.resetsAt}`,
          severity: 'critical', scope: 'all', prompt: false,
          title: `${name} ${w.label.toLowerCase()} quota at ${w.usedPercent}%`,
          text: `${name} ${w.label.toLowerCase()} quota is at ${w.usedPercent}% and resets ${reset}. Do not start new ${lane} before then. Send new work to another provider.`,
        });
      } else if (w.usedPercent >= cfg.quota.warnPercent) {
        alerts.push({
          key: `quota:${q.provider}:${w.key}:warn:${w.resetsAt}`,
          severity: 'warn', scope: 'all', prompt: false,
          title: `${name} ${w.label.toLowerCase()} quota at ${w.usedPercent}%`,
          text: `${name} ${w.label.toLowerCase()} quota is at ${w.usedPercent}% and resets ${reset}. Use ${name} only for work that needs it.`,
        });
      } else if (w.usedPercent >= 40 && (w.willLast === false || Number.isFinite(pacingGoalEnd(policy, q.provider, w)))) {
        const goalEnd = pacingGoalEnd(policy, q.provider, w);
        if (Number.isFinite(goalEnd)) {
          const goalPercent = pacingGoal(policy, q.provider, w.key);
          const quotaLeft = 100 - w.usedPercent;
          const goalLeft = goalPercent - w.usedPercent;
          const etaToGoal = Number.isFinite(w.etaSeconds) && quotaLeft > 0 && goalLeft > 0
            ? w.etaSeconds * goalLeft / quotaLeft : null;
          if (etaToGoal != null && etaToGoal * 1000 < goalEnd - now) {
            advice.push(`${name} ${w.label.toLowerCase()}: ${w.usedPercent}% used, ahead of pace (expected ${w.expectedPercent}%). At this rate it reaches ${goalPercent}% in ${fmtDuration(etaToGoal)}, before the goal end ${formatPacingGoalEnd(goalEnd)}. Use lower reasoning effort for mechanical tasks.`);
          }
        } else {
          advice.push(`${name} ${w.label.toLowerCase()}: ${w.usedPercent}% used, ahead of pace (expected ${w.expectedPercent}%). At this rate it runs out in ${fmtDuration(w.etaSeconds)}, before the reset ${reset}. Use lower reasoning effort for mechanical tasks.`);
        }
      }
    }
  }
  if (avoidKinds.size) {
    const ok = Object.entries(cfg.providerKinds)
      .filter(([p]) => !(snap.quotas || []).find((q) => q.provider === p && q.windows?.some((w) => !w.extra && w.usedPercent >= cfg.quota.warnPercent)))
      .flatMap(([, k]) => k);
    advice.unshift(`Do not start new ${[...avoidKinds].join('/')} agents. Preferred agent kinds now: ${ok.join(', ') || 'none, wait for a reset'}.`);
  }

  // ----- Machine -----
  const m = snap.machine;
  if (m) {
    const limits = m.limits || (policy ? machineLimits({ ...m, cpuUse: snap.cpuUse }, policy, now, snap.night) : null);
    const cpuPercent = limits ? Number(limits.cpuPercent.toFixed(1)) : null;
    if (m.memFreePercent != null && m.memFreePercent < cfg.machine.memFreeWarnPercent) {
      alerts.push({
        key: 'machine:mem', severity: m.memFreePercent < cfg.machine.memFreeWarnPercent / 2 ? 'critical' : 'warn', scope: 'all',
        title: `Memory low: ${m.memFreePercent}% free`,
        text: `System memory is ${m.memFreePercent}% free. Do not start new browser or test workers. Close finished workers and their browsers.`,
      });
    }
    if (Number.isFinite(m.diskFreeBytes) && policy?.machine) {
      const freeGB = m.diskFreeBytes / 2 ** 30;
      const critical = freeGB < policy.machine.diskCriticalFreeGB;
      if (critical || freeGB < policy.machine.diskWarnFreeGB) {
        const freePercent = Number.isFinite(m.diskFreePercent) ? `${m.diskFreePercent.toFixed(1)}%` : 'unknown percent';
        for (const [workspace, counts] of Object.entries(snap.worktreeCounts || {})) {
          if (!(counts.linked > 0)) continue;
          const severity = critical ? 'critical' : 'warn';
          alerts.push({ key: `machine:disk:${workspace}:${severity}`, severity, scope: workspace,
            title: `Disk space low: ${freeGB.toFixed(1)} GB free (${freePercent})`,
            text: `The Herdr Boss data filesystem has ${freeGB.toFixed(1)} GB (${freePercent}) free. This project has ${counts.linked} linked worker worktree(s), including ${counts.prunable} missing/prunable. After reviewing merged work, run \`herdr-boss worktree prune --apply\` to remove safe worktrees.` });
        }
      }
    }
    const guardActive = limits ? (limits.guardActive ?? (limits.guardState ? limits.guardState === 'active' : true)) : true;
    const cpuExceeded = guardActive && !!limits && limits.cpuLimit != null && limits.cpuPercent > limits.cpuLimit;
    const loadExceeded = guardActive && (limits ? limits.loadLimit != null && m.load[1] > limits.loadLimit : m.load[1] > m.cpus * cfg.machine.loadWarnFactor);
    if (cpuExceeded || loadExceeded) {
      const advice = 'Start no new worker and no full test suite until it drops. Run one full suite at a time, and limit test runners to two threads (the flag for each runner is in the kit skill, section Machine load).';
      const label = (ws) => snap.herdr?.workspaces?.find((w) => w.id === ws)?.label || ws;
      const top = (use) => use.top.map((g) => `${g.label}${g.count > 1 ? ` ×${g.count}` : ''} ${g.cpu}%`).join(', ');
      // A project that uses at least one core gets its own notice; the others are not woken.
      const sources = Object.entries(snap.cpuUse || {}).filter(([ws, use]) => ws !== 'other' && use.cpu >= 100).sort((a, b) => b[1].cpu - a[1].cpu);
      const summary = sources.map(([ws, use]) => `${label(ws)} ${use.cpu}% (${top(use)})`).join('; ');
      const title = cpuExceeded ? `Machine CPU high: ${cpuPercent}% of capacity (limit ${limits.cpuLimit}%)` : `CPU load high: ${m.load[1]} (5 min) on ${m.cpus} cores`;
      if (sources.length) {
        for (const [ws, use] of sources) alerts.push({
          key: `machine:load:${ws}`, severity: 'warn', scope: ws, title,
          text: limits ? `Machine CPU is ${cpuPercent}% of total capacity (active limit ${limits.cpuLimit ?? 'disabled'}${limits.cpuLimit == null ? '' : '%' }, Owner ${limits.owner}); 5-minute load is ${m.load[1]}${limits.loadLimit == null ? ' (backstop disabled)' : ` (backstop ${limits.loadLimit})`}. Your project uses about ${use.cpu}% CPU (1 core = 100%): ${top(use)}. ${advice}` : `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores. Your project uses about ${use.cpu}% CPU now (1 core = 100%): ${top(use)}. ${advice}`,
        });
        alerts.push({ key: 'machine:load', severity: 'warn', scope: 'user', title, text: limits ? `Owner ${limits.owner}; machine CPU ${cpuPercent}% (active limit ${limits.cpuLimit == null ? 'disabled' : `${limits.cpuLimit}%`}). 5-minute load ${m.load[1]}${limits.loadLimit == null ? ' (backstop disabled)' : ` (backstop ${limits.loadLimit})`}. CPU by project: ${summary}.` : `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores. CPU by project now: ${summary}.${snap.cpuUse?.other?.cpu >= 100 ? ` Other processes: ${top(snap.cpuUse.other)}.` : ''}` });
      } else {
        alerts.push({
          key: 'machine:load', severity: 'warn', scope: 'all', title,
          text: `${limits ? `Owner ${limits.owner}; machine CPU ${cpuPercent}% (active limit ${limits.cpuLimit == null ? 'disabled' : `${limits.cpuLimit}%`}). 5-minute load ${m.load[1]}${limits.loadLimit == null ? ' (backstop disabled)' : ` (backstop ${limits.loadLimit})`}.` : `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores.`}${snap.cpuUse?.other ? ` The largest processes are outside the projects: ${top(snap.cpuUse.other)}.` : ''} ${advice}`,
        });
      }
    }
  }
  // ----- Browsers -----
  const paneById = new Map((snap.herdr?.panes || []).map((p) => [p.id, p]));
  for (const b of snap.browsers || []) {
    if (b.kind !== 'automation-chrome' || b.shared) continue;
    const desc = `Chrome pid ${b.pid}${b.headless ? ' (headless)' : ''}${b.port ? `, port ${b.port}` : ''}${b.profile ? `, profile ${b.profile}` : ''}, age ${fmtDuration(b.age)}, ${b.rssMB} MB`;
    if (b.pane) {
      const p = paneById.get(b.pane);
      const idleFor = p && (p.status === 'idle' || p.status === 'done' || !p.agent) ? (now - (paneSince[b.pane]?.since || now)) / 60000 : 0;
      if (idleFor >= cfg.browsers.staleOwnedMinutes) {
        const who = p.name || p.id;
        alerts.push({
          key: `browser:owned:${b.pid}`, severity: 'info', scope: p.workspace,
          title: `Idle worker ${who} holds a browser`,
          text: `Worker ${who} (${p.id}) is idle and its automation browser still runs: ${desc}. If the task is finished, tell the worker to close the browser or close the pane.`,
        });
      }
    } else if (b.orphan && b.age > 3600) {
      alerts.push({
        key: `browser:orphan:${b.pid}`, severity: 'info', scope: 'all',
        title: `Orphaned automation Chrome (pid ${b.pid})`,
        text: `An automation browser has no owner process: ${desc}. If one of your workers started it and does not need it, close it with \`kill ${b.pid}\`.`,
      });
    }
  }

  for (const s of cfg.sharedBrowsers || []) {
    const up = (snap.browsers || []).some((b) => b.kind === 'automation-chrome' && b.shared === s.label);
    if (!up) alerts.push({
      key: `browser:shared-down:${s.port || s.profile}`, severity: 'warn', scope: 'user',
      title: `${s.label} is not running`,
      text: `${s.label}${s.port ? ` (port ${s.port})` : ''} is not running. Browser workers that need the signed-in session cannot run until the Owner starts it and signs in again.`,
    });
  }

  // ----- Stale workers -----
  const staleByWs = new Map();
  for (const p of snap.herdr?.panes || []) {
    // A former orchestrator pane (orch previous, boss previous) is not a worker.
    if (!p.agent || p.orch || ['boss', 'parked', 'orch previous', 'boss previous'].includes(p.label) || snap.standbyPanes?.includes(p.id)) continue;
    if (p.status !== 'idle' && p.status !== 'done') continue;
    const mins = (now - (paneSince[p.id]?.since || now)) / 60000;
    if (mins < cfg.workers.staleIdleMinutes) continue;
    if (!staleByWs.has(p.workspace)) staleByWs.set(p.workspace, []);
    staleByWs.get(p.workspace).push({ p, mins });
  }
  for (const [ws, list] of staleByWs) {
    const ids = list.map((x) => x.p.id).sort();
    alerts.push({
      key: `workers:stale:${ws}:${ids.join(',')}`, severity: 'info', scope: ws,
      title: `${list.length} idle worker${list.length > 1 ? 's' : ''} in ${ws}`,
      text: `These workers have been idle for more than ${cfg.workers.staleIdleMinutes} minutes: ${list.map((x) => `${x.p.name || x.p.agent} (${x.p.id}, ${fmtDuration(x.mins * 60)})`).join(', ')}. Close the finished ones to release memory.`,
    });
  }

  return { alerts, advice };
}

export function renderBulletin(snap, evaluation, cfg) {
  const L = [];
  L.push(`# Herdr Boss bulletin`, '', `Updated: ${new Date(snap.updatedAt).toISOString()}`, `Kit revision: ${kitRevision() ?? 'unknown'}`, '');
  L.push('Read this file before you start new workers. Obey the rules below.', '');
  L.push('## Rules now', '');
  const serious = evaluation.alerts.filter((a) => a.severity !== 'info');
  const shared = serious.filter((a) => a.scope === 'all' || a.scope === 'user');
  const rules = [...evaluation.advice, ...shared.map((a) => a.text)];
  // Without quota data, pacing is blind. Say so, and never claim that no restriction applies.
  const quotaRows = snap.quotas || [];
  const failed = quotaRows.filter((q) => !hasQuotaData(q)).map((q) => providerName(q.provider));
  const stale = quotaRows.filter((q) => q.error && q.stale);
  rules.unshift(...stale.map((q) => `Quota data for ${providerName(q.provider)} is from ${fmtTime(q.staleSince)}; the last probe failed.`));
  if (!quotaRows.length) rules.unshift('Quota data unavailable: the quota collector failed. Pace work carefully until the data returns.');
  else if (failed.length) rules.unshift(`Quota data unavailable for ${failed.join(', ')}. Pace work on those providers carefully.`);
  // An active night state comes last into the list, so it is the first line. An orchestrator reads the Owner rule first.
  if (snap.night?.active) {
    const end = snap.night.until
      ? new Date(snap.night.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '?';
    rules.unshift(`Night watch until ${end} (Owner away). Work as normal; the Boss handles judgment calls.`);
    if (snap.night.quietHours === true) rules.unshift('Quiet hours: on.');
  }
  if (rules.length) rules.forEach((r) => L.push(`- ${r}`));
  else L.push('- No quota or active machine restrictions.');
  // Rules for one project stay under that project, so an orchestrator reads only its own.
  const byProject = new Map();
  for (const a of serious.filter((x) => x.scope !== 'all' && x.scope !== 'user')) {
    const name = snap.herdr?.workspaces?.find((w) => w.id === a.scope)?.label || a.scope;
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(a.text);
  }
  for (const item of Object.values(snap.staleStatus || {})) {
    const name = snap.herdr?.workspaces?.find((w) => w.id === item.workspace)?.label || item.workspace || item.slug;
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(`Status stale since ${fmtTime(new Date(item.since).toISOString())}.`);
  }
  if (byProject.size) {
    L.push('', '## Project rules', '');
    for (const [name, texts] of byProject) { L.push(`### ${name}`, ''); texts.forEach((t) => L.push(`- ${t}`)); L.push(''); }
  }
  const heldMachineLocks = (snap.locks || []).filter((lock) => lock.scope === 'machine' && lock.state === 'live');
  if (heldMachineLocks.length) {
    L.push('', '## Locks', '');
    for (const lock of heldMachineLocks) {
      const ageSeconds = lock.ageSeconds ?? Math.max(0, Math.floor((Date.parse(snap.updatedAt) - Date.parse(lock.acquiredAt)) / 1000));
      const queue = Array.isArray(lock.queue) ? lock.queue : [];
      const queueText = queue.length
        ? `; queue: ${queue.map((ticket) => `${ticket.position}. ${ticket.project} ${ticket.pane} ${fmtDuration(ticket.waitSeconds)}`).join(', ')}`
        : '';
      L.push(`- ${lock.name} held by ${lock.ownerPane} (${lock.kind}) for ${fmtDuration(ageSeconds)}${queueText}.`);
    }
  }
  // The denial trend is for the Owner, so it has its own section and never enters the project rules.
  if (snap.denials?.rising?.length) {
    L.push('', '## Owner', '');
    for (const c of snap.denials.rising) L.push(`- Denials and permission prompts: ${c.cause} has ${c.recent} events in the last 24 hours against a 6-day mean of ${c.mean} a day.`);
    L.push(`- ${snap.denials.note}`);
  }
  L.push('', '## Quotas', '', '| Provider | Window | Used | Expected | Resets |', '|---|---|---|---|---|');
  for (const q of snap.quotas || []) {
    if (!hasQuotaData(q)) continue;
    const provider = q.stale ? `${providerName(q.provider)} quota from ${fmtTime(q.staleSince)} (probe failed)` : providerName(q.provider);
    for (const w of q.windows) {
      const reset = w.resetsAt && Date.parse(w.resetsAt) <= Date.parse(snap.updatedAt || Date.now());
      L.push(`| ${provider} | ${w.label} | ${reset ? 'reset, not yet measured' : `${w.usedPercent}%`} | ${reset ? '–' : `${w.expectedPercent ?? '–'}${w.expectedPercent != null ? '%' : ''}`} | ${fmtTime(w.resetsAt)} |`);
    }
  }
  if (snap.lanes && Object.keys(snap.lanes).length) {
    L.push('', '## Provider lanes', '');
    const useNow = useNowLanes(snap.lanes);
    L.push(useNow.length
      ? `Use now: ${useNow.map(({ provider, reason }) => `${provider} (${reason})`).join(', ')}`
      : 'Use now: no metered lane; use unmetered models or wait.');
    for (const [provider, lane] of Object.entries(snap.lanes)) {
      if (lane.unmetered) {
        const summary = unmeteredSummary(lane);
        const exhausted = (lane.exhausted || []).map((item) => `${item.model} until ${fmtTime(new Date(item.retryAt).toISOString())}`).sort();
        const exhaustedText = exhausted.length ? ` Exhausted models: ${exhausted.join('; ')}.` : '';
        L.push(lane.state === 'closed' ? `- Unmetered: closed: no unmetered model can start.${exhaustedText}` : `- Unmetered: open${summary ? `: ${summary}` : ''}.${exhaustedText}`);
        for (const part of unmeteredClosedParts(lane, (ms) => fmtTime(new Date(ms).toISOString()))) L.push(`- ${part}`);
        continue;
      }
      const back = lane.backOnPaceAt ? ` Back ${lane.state === 'reserve' ? 'at reset' : 'on pace if unused'} about ${fmtTime(lane.backOnPaceAt)}.` : '';
      const text = lane.state === 'open' ? 'open.' : lane.state === 'unknown' ? 'unknown: no quota data.'
        : lane.state === 'exhausted' ? `exhausted: ${lane.usedPercent}% used in the ${lane.window} window; exhausted until ${lane.resetAt || '?'}.`
          : lane.state === 'trickle' ? `trickle (${lane.window} ${lane.usedPercent}% used, ahead of pace): about ${lane.allowancePercent.toFixed(1)}%/day, ${(lane.usedTodayPercent || 0).toFixed(1)}% used today.`
        : `${lane.state === 'reserve' ? 'near exhaustion' : 'ahead of pace'}: ${lane.usedPercent}% used${lane.expectedPercent != null ? ` against ${lane.expectedPercent}% expected` : ''} in the ${lane.window} window.${back}`;
      const goals = goalSummary(lane.goals);
      L.push(`- ${providerName(provider)}: ${text}${goals ? ` ${goals}.` : ''}${lane.state === 'pace' && snap.leastOverProvider === provider ? ' Every metered provider is over pace; this one is the least over, and worker start allows it.' : ''}`);
    }
  }
  const m = snap.machine;
  if (m) {
    L.push('', '## Machine', '');
    L.push(`- Load: ${m.load.join(' / ')} on ${m.cpus} cores`);
    const disk = Number.isFinite(m.diskFreeBytes) && Number.isFinite(m.diskFreePercent)
      ? `${(m.diskFreeBytes / 2 ** 30).toFixed(1)} GB (${m.diskFreePercent.toFixed(1)}%) free`
      : 'unavailable';
    L.push(`- Disk free: ${disk} on the data volume.`);
    const limits = m.limits;
    if (limits) {
      const guardState = limits.guardState || (limits.guardEnabled === false ? 'off' : 'active');
      const guardText = guardState === 'paused' ? `paused until ${limits.guardPausedUntil}` : guardState;
      const threshold = limits.guardActive === false ? 'configured' : 'active';
      L.push(`- Guard: ${guardText}.`);
      L.push(`- Owner: ${limits.owner}; machine CPU ${Number(limits.cpuPercent.toFixed(1))}% / ${threshold} limit ${limits.cpuLimit == null ? 'disabled' : `${limits.cpuLimit}%`}; 5-minute load ${limits.fiveMinute} / ${threshold} backstop ${limits.loadLimit == null ? 'disabled' : limits.loadLimit}.`);
    }
    if (limits?.guardActive !== false && limits && ((limits.cpuLimit != null && limits.cpuPercent > limits.cpuLimit) || (limits.loadLimit != null && limits.fiveMinute > limits.loadLimit))) L.push('- Machine limit exceeded: stop new workers and full test suites until no active machine limit is exceeded.');
    L.push(`- Memory: ${m.memFreePercent}% free of ${m.memTotalGB} GB; swap used ${m.swapUsedMB} MB`);
    const ab = (snap.browsers || []).filter((b) => b.kind === 'automation-chrome').length;
    L.push(`- Automation browsers: ${ab}`);
  }
  if (snap.managedBrowsers?.length) {
    L.push('', '## Project browsers', '');
    for (const b of snap.managedBrowsers) {
      const running = (snap.browsers || []).some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile);
      const state = !running ? 'offline' : b.responsive === false ? 'not responding' : 'ready';
      const size = b.windowSize || { width: 1280, height: 800 };
      if (state === 'not responding') {
        L.push(`- ${b.project}: not responding (${b.headless ? 'headless' : 'visible'}); CDP http://127.0.0.1:${b.port} does not answer. Do not use it. Ask the Owner to restart it on the Browsers page, or run \`herdr-boss browser restart ${b.project} --${b.headless ? 'headless' : 'visible'}\` for your own project. Do not stop another project's browser.`);
        continue;
      }
      L.push(`- ${b.project}: ${state} (${b.headless ? 'headless' : 'visible'}); next launch ${size.width}×${size.height}; CDP http://127.0.0.1:${b.port}; profile ${b.profile}. Use \`herdr-boss browser tabs ${b.project}\` and \`herdr-boss browser screenshot ${b.project} --tab <id>\` for simple browser work; see \`kit/browser-service.md\` for input commands. Do not stop another project's browser.`);
    }
  }
  const leases = snap.resourceLeases;
  if (leases && (leases.pools?.length || leases.errors?.length)) {
    L.push('', '## Resource leases', '');
    L.push(...leaseBulletinLines(leases, Date.parse(snap.updatedAt)));
  }
  if (snap.control) {
    L.push('', '## Worker allocation', '', `- ${snap.control.runningWorkers}/${snap.control.maxWorkers} working agents globally.`);
    if (snap.night?.active) {
      const laneCaps = Object.entries(cfg.night?.maxWorkersByLane || {})
        .filter(([, cap]) => Number.isInteger(cap))
        .map(([lane, cap]) => `${lane} ${cap}`);
      L.push(`- Night cap ${snap.control.maxWorkers}${laneCaps.length ? ` (${laneCaps.join('; ')})` : ''}.`);
    }
    L.push(`- Automatic orchestrator handover: ${snap.policy?.autoHandover ? `enabled; prepare at reserve, activate at ${snap.policy.autoHandoverPercent}% after successor readiness` : 'off'}.`);
    L.push('- Borrowed slots are real capacity. Start workers up to your effective slots; the global limit still applies.');
    for (const p of Object.values(snap.control.projects)) L.push(`- ${p.label}: ${p.running}/${p.slots} slots (${Math.round(p.share)}% share${p.idle ? ', idle' : ''}${p.borrowed ? `, +${p.borrowed} borrowed` : ''}${p.lent ? `, ${p.lent} lent` : ''}${p.offered ? `, ${p.offered} free for others` : ''}). Allowed kinds: ${Object.keys(snap.control.globalAllowed).filter((k) => !p.excludedKinds.includes(k)).join(', ') || 'none'}.`);
  }
  const info = evaluation.alerts.filter((a) => a.severity === 'info');
  if (info.length) { L.push('', '## Notices', ''); info.forEach((a) => L.push(`- [${a.scope}] ${a.text}`)); }
  L.push('', `Dashboard: ${dashboardUrl(cfg)}`, '');
  return L.join('\n');
}
