// Turns a snapshot into alerts and bulletin advice. Pure functions, no side effects.

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

// alert: { key, severity: info|warn|critical, scope: 'all' | <workspace id> | 'user', title, text }
export function evaluate(snap, cfg, paneSince, now = Date.now(), policy = null) {
  const alerts = [];
  const advice = [];
  const avoidKinds = new Set();

  // ----- Quotas -----
  for (const q of snap.quotas || []) {
    if (q.error) continue;
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
          severity: 'critical', scope: 'all',
          title: `${name} ${w.label.toLowerCase()} quota at ${w.usedPercent}%`,
          text: `${name} ${w.label.toLowerCase()} quota is at ${w.usedPercent}% and resets ${reset}. Do not start new ${lane} before then. Send new work to another provider.`,
        });
      } else if (w.usedPercent >= cfg.quota.warnPercent) {
        alerts.push({
          key: `quota:${q.provider}:${w.key}:warn:${w.resetsAt}`,
          severity: 'warn', scope: 'all',
          title: `${name} ${w.label.toLowerCase()} quota at ${w.usedPercent}%`,
          text: `${name} ${w.label.toLowerCase()} quota is at ${w.usedPercent}% and resets ${reset}. Use ${name} only for work that needs it.`,
        });
      } else if (w.willLast === false && w.usedPercent >= 40) {
        advice.push(`${name} ${w.label.toLowerCase()}: ${w.usedPercent}% used, ahead of pace (expected ${w.expectedPercent}%). At this rate it runs out in ${fmtDuration(w.etaSeconds)}, before the reset ${reset}. Use lower reasoning effort for mechanical tasks.`);
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
    if (m.memFreePercent != null && m.memFreePercent < cfg.machine.memFreeWarnPercent) {
      alerts.push({
        key: 'machine:mem', severity: m.memFreePercent < cfg.machine.memFreeWarnPercent / 2 ? 'critical' : 'warn', scope: 'all',
        title: `Memory low: ${m.memFreePercent}% free`,
        text: `System memory is ${m.memFreePercent}% free. Do not start new browser or test workers. Close finished workers and their browsers.`,
      });
    }
    if (m.load[1] > m.cpus * cfg.machine.loadWarnFactor) {
      const advice = 'Start no new worker and no full test suite until it drops. Run one full suite at a time, and limit test runners to two threads (the flag for each runner is in the kit skill, section Machine load).';
      const label = (ws) => snap.herdr?.workspaces?.find((w) => w.id === ws)?.label || ws;
      const top = (use) => use.top.map((g) => `${g.label}${g.count > 1 ? ` ×${g.count}` : ''} ${g.cpu}%`).join(', ');
      // A project that uses at least one core gets its own notice; the others are not woken.
      const sources = Object.entries(snap.cpuUse || {}).filter(([ws, use]) => ws !== 'other' && use.cpu >= 100).sort((a, b) => b[1].cpu - a[1].cpu);
      const summary = sources.map(([ws, use]) => `${label(ws)} ${use.cpu}% (${top(use)})`).join('; ');
      const title = `CPU load high: ${m.load[1]} (5 min) on ${m.cpus} cores`;
      if (sources.length) {
        for (const [ws, use] of sources) alerts.push({
          key: `machine:load:${ws}`, severity: 'warn', scope: ws, title,
          text: `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores. Your project uses about ${use.cpu}% CPU now (1 core = 100%): ${top(use)}. ${advice}`,
        });
        alerts.push({ key: 'machine:load', severity: 'warn', scope: 'user', title, text: `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores. CPU by project now: ${summary}.${snap.cpuUse?.other?.cpu >= 100 ? ` Other processes: ${top(snap.cpuUse.other)}.` : ''}` });
      } else {
        alerts.push({
          key: 'machine:load', severity: 'warn', scope: 'all', title,
          text: `The 5-minute load average is ${m.load[1]} on ${m.cpus} cores.${snap.cpuUse?.other ? ` The largest processes are outside the projects: ${top(snap.cpuUse.other)}.` : ''} ${advice}`,
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
    if (!p.agent || p.orch || p.label === 'boss' || p.label === 'parked' || snap.standbyPanes?.includes(p.id)) continue;
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
  L.push(`# Herdr Boss bulletin`, '', `Updated: ${new Date(snap.updatedAt).toISOString()}`, '');
  L.push('Read this file before you start new workers. Obey the rules below.', '');
  L.push('## Rules now', '');
  const serious = evaluation.alerts.filter((a) => a.severity !== 'info');
  const shared = serious.filter((a) => a.scope === 'all' || a.scope === 'user');
  const rules = [...evaluation.advice, ...shared.map((a) => a.text)];
  if (rules.length) rules.forEach((r) => L.push(`- ${r}`));
  else L.push('- No restrictions. All providers and machine resources are within limits.');
  // Rules for one project stay under that project, so an orchestrator reads only its own.
  const byProject = new Map();
  for (const a of serious.filter((x) => x.scope !== 'all' && x.scope !== 'user')) {
    const name = snap.herdr?.workspaces?.find((w) => w.id === a.scope)?.label || a.scope;
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(a.text);
  }
  if (byProject.size) {
    L.push('', '## Project rules', '');
    for (const [name, texts] of byProject) { L.push(`### ${name}`, ''); texts.forEach((t) => L.push(`- ${t}`)); L.push(''); }
  }
  L.push('', '## Quotas', '', '| Provider | Window | Used | Expected | Resets |', '|---|---|---|---|---|');
  for (const q of snap.quotas || []) {
    if (q.error) continue;
    for (const w of q.windows) {
      const reset = w.resetsAt && Date.parse(w.resetsAt) <= Date.parse(snap.updatedAt || Date.now());
      L.push(`| ${providerName(q.provider)} | ${w.label} | ${reset ? 'reset, not yet measured' : `${w.usedPercent}%`} | ${reset ? '–' : `${w.expectedPercent ?? '–'}${w.expectedPercent != null ? '%' : ''}`} | ${fmtTime(w.resetsAt)} |`);
    }
  }
  if (snap.lanes && Object.keys(snap.lanes).length) {
    L.push('', '## Provider lanes', '');
    for (const [provider, lane] of Object.entries(snap.lanes)) {
      const back = lane.backOnPaceAt ? ` Back ${lane.state === 'reserve' ? 'at reset' : 'on pace if unused'} about ${fmtTime(lane.backOnPaceAt)}.` : '';
      const text = lane.state === 'open' ? 'open.' : lane.state === 'unknown' ? 'unknown: no quota data.'
        : `${lane.state === 'reserve' ? 'near exhaustion' : 'ahead of pace'}: ${lane.usedPercent}% used${lane.expectedPercent != null ? ` against ${lane.expectedPercent}% expected` : ''} in the ${lane.window} window.${back}`;
      L.push(`- ${providerName(provider)}: ${text}${lane.state === 'pace' && snap.leastOverProvider === provider ? ' Every metered provider is over pace; this one is the least over, and worker start allows it.' : ''}`);
    }
  }
  const m = snap.machine;
  if (m) {
    L.push('', '## Machine', '');
    L.push(`- Load: ${m.load.join(' / ')} on ${m.cpus} cores`);
    L.push(`- Memory: ${m.memFreePercent}% free of ${m.memTotalGB} GB; swap used ${m.swapUsedMB} MB`);
    const ab = (snap.browsers || []).filter((b) => b.kind === 'automation-chrome').length;
    L.push(`- Automation browsers: ${ab}`);
  }
  if (snap.managedBrowsers?.length) {
    L.push('', '## Project browsers', '');
    for (const b of snap.managedBrowsers) {
      const ready = (snap.browsers || []).some((x) => x.kind === 'automation-chrome' && x.port === String(b.port) && x.profile === b.profile);
      const size = b.windowSize || { width: 1280, height: 800 };
      L.push(`- ${b.project}: ${ready ? 'ready' : 'offline'} (${b.headless ? 'headless' : 'visible'}); next launch ${size.width}×${size.height}; CDP http://127.0.0.1:${b.port}; profile ${b.profile}. Use \`herdr-boss browser tabs ${b.project}\` and \`herdr-boss browser screenshot ${b.project} --tab <id>\` for simple browser work; see \`kit/browser-service.md\` for input commands. Do not stop another project's browser.`);
    }
  }
  if (snap.control) {
    L.push('', '## Worker allocation', '', `- ${snap.control.runningWorkers}/${snap.control.maxWorkers} working agents globally.`);
    L.push(`- Automatic orchestrator handover: ${snap.policy?.autoHandover ? `enabled; prepare at reserve, activate at ${snap.policy.autoHandoverPercent}% after successor readiness` : 'off'}.`);
    for (const p of Object.values(snap.control.projects)) L.push(`- ${p.label}: ${p.running}/${p.slots} slots (${Math.round(p.share)}% share${p.idle ? ', idle' : ''}). Allowed kinds: ${Object.keys(snap.control.globalAllowed).filter((k) => !p.excludedKinds.includes(k)).join(', ') || 'none'}.`);
  }
  const info = evaluation.alerts.filter((a) => a.severity === 'info');
  if (info.length) { L.push('', '## Notices', ''); info.forEach((a) => L.push(`- [${a.scope}] ${a.text}`)); }
  L.push('', `Dashboard: http://${cfg.host}:${cfg.port}`, '');
  return L.join('\n');
}
