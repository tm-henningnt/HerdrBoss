import { safeBrowserStartIdentity } from './browser-audit.js';

const CHROME_EXECUTABLE = /^(?:\/(?:[^/\s]+\/)*(?:Google Chrome(?:\.app\/Contents\/MacOS\/Google Chrome)?|Chromium(?: Browser)?(?:\.app\/Contents\/MacOS\/Chromium)?|Chrome for Testing|chrome-headless-shell|Brave Browser|Microsoft Edge)|Google Chrome|Chromium(?: Browser)?|Chrome for Testing|chrome-headless-shell|Brave Browser|Microsoft Edge)(?=\s|$)/i;
const AUTOMATION_FLAGS = /--remote-debugging-(?:port|pipe)|--enable-automation\b/;

function processRows(processes) {
  if (processes instanceof Map) return [...processes.values()];
  return Array.isArray(processes) ? processes : [];
}

function ownsAutomationChrome(process) {
  return typeof process?.cmd === 'string' && CHROME_EXECUTABLE.test(process.cmd.trimStart())
    && !/--type=/.test(process.cmd) && AUTOMATION_FLAGS.test(process.cmd);
}

function profileArgument(command) {
  return /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean) || null;
}

function portArgument(command) {
  return Number(/--remote-debugging-port=(\d+)/.exec(command)?.[1]) || null;
}

function isHeadless(command) {
  return /--headless(?:=|\s|$)/.test(command);
}

function ownerPane(pid, processes, shellToPane) {
  let current = processes.get(pid);
  const seen = new Set();
  while (current && current.ppid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (shellToPane.has(current.pid)) return shellToPane.get(current.pid);
    current = processes.get(current.ppid);
  }
  return current && shellToPane.has(current.pid) ? shellToPane.get(current.pid) : null;
}

function launchedThroughBrowserCommand(pid, processes) {
  let current = processes.get(pid);
  const seen = new Set();
  while (current && current.ppid > 1 && !seen.has(current.pid)) {
    if (/\bherdr-boss\b.*\bbrowser\b|\bherdr\b.*\bboss\b.*\bbrowser\b|\/src\/cli\.js\s+browser\b/i.test(current.cmd || '')) return true;
    seen.add(current.pid);
    current = processes.get(current.ppid);
  }
  return false;
}

// Inspect only executable and runtime script names. Other arguments cannot select a launcher kind.
function launcherKind(pid, processes) {
  let current = processes.get(processes.get(pid)?.ppid);
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    const tokens = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?/.exec((current.cmd || '').trimStart());
    const executable = tokens?.slice(1, 4).find(Boolean) || '';
    const name = executable.split('/').pop().toLowerCase();
    const script = /^(?:node|nodejs|python[\d.]*)$/.test(name) ? tokens?.slice(4).find(Boolean) || '' : '';
    const scriptName = !/^[a-z][a-z\d+.-]*:/i.test(script) && /\.(?:[cm]?js|py)$/.test(script) ? script : '';
    const names = [name, scriptName.split('/').pop().replace(/\.(?:[cm]?js|py)$/, '')];
    if (names.includes('perf-harness')) return 'perf-harness';
    if (names.includes('agent-browser') || /(?:^|\/)agent-browser\/(?:[^/]+\/)*daemon\.js$/.test(scriptName)) return 'agent-browser';
    if (names.some((item) => /^(?:playwright|playwright-mcp)$/.test(item))
      || /(?:^|\/)(?:playwright(?:-core)?|@playwright)\//.test(scriptName)) return 'playwright';
    current = processes.get(current.ppid);
  }
  return 'unknown';
}

function warning({ project, kind, text, identity }) {
  return { key: `browser:safety:${project}:${kind}:${identity}`, project, kind, text };
}

// Find visible managed browsers and automation browsers launched inside a project pane tree.
// This function reads only the supplied process snapshot and never signals a process.
export function browserSafetyNotices({ processes = new Map(), panes = [], projects = {}, sessions = [], allowVisible = false, associations = {} } = {}) {
  const rows = processRows(processes);
  const processMap = new Map(rows.map((process) => [process.pid, process]));
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const shellToPane = new Map(panes.filter((pane) => Number.isSafeInteger(pane.shellPid)).map((pane) => [pane.shellPid, pane.id]));
  const projectForWorkspace = new Map(Object.entries(projects).map(([slug, project]) => [project.workspace, slug]).filter(([workspace]) => workspace));
  const notices = new Map();

  for (const process of rows) {
    if (!ownsAutomationChrome(process)) continue;
    const command = process.cmd;
    const port = portArgument(command);
    const profile = profileArgument(command);
    const session = sessions.find((item) => port && profile && Number(item.port) === port && item.profile === profile);
    if (!allowVisible && session && !isHeadless(command)) {
      const item = warning({ project: session.project, kind: 'visible-project-browser', identity: `${session.port}`,
        text: `The project browser for ${session.project} is visible. Run herdr-boss browser restart ${session.project} --headless.` });
      notices.set(item.key, item);
    }

    const startIdentity = safeBrowserStartIdentity(process.startIdentity ?? process.start);
    let association = associations[process.pid];
    if (association?.startIdentity !== startIdentity) association = null;
    if (!association) {
      const paneId = ownerPane(process.pid, processMap, shellToPane);
      const pane = paneById.get(paneId);
      const projectLead = pane && (pane.label === 'orch' || (pane.orch === true && pane.label !== 'boss'));
      if (!pane || (!pane.agent && !projectLead) || launchedThroughBrowserCommand(process.pid, processMap)) continue;
      const project = projectForWorkspace.get(pane.workspace);
      if (!project) continue;
      association = { project, pid: process.pid, pane: paneId, startIdentity, launcherKind: launcherKind(process.pid, processMap) };
      associations[process.pid] = association;
    }
    const { project } = association;
    const item = warning({ project, kind: 'independent-browser-launch', identity: `${process.pid}:${startIdentity}`,
      text: `A worker or project lead launched Chrome for ${project} outside herdr-boss browser. Attach with herdr-boss browser request ${project}.` });
    Object.assign(item, association);
    notices.set(item.key, item);
  }

  return [...notices.values()];
}

// Retain active notice keys across service ticks so each problem creates one event and one alert.
export function browserSafetyNoticeDelta(notices = [], previous = {}, seenLaunches = {}) {
  const active = Object.fromEntries(notices.map((item) => [item.key, true]));
  const added = notices.filter((item) => {
    if (item.kind !== 'independent-browser-launch') return !previous[item.key];
    if (seenLaunches[item.pid] === item.startIdentity) return false;
    seenLaunches[item.pid] = item.startIdentity;
    return true;
  });
  return {
    active,
    added,
    removed: Object.keys(previous).filter((key) => !active[key]),
  };
}

export function browserSafetyAlert(notice) {
  return {
    key: notice.key,
    severity: 'warn',
    scope: 'user',
    once: true,
    title: 'Project browser needs attention',
    text: notice.text,
    ...(notice.pid ? { project: notice.project, pid: notice.pid, pane: notice.pane,
      startIdentity: notice.startIdentity, launcherKind: notice.launcherKind } : {}),
  };
}

// A recorded PID proves that Herdr Boss started this browser. Keep an external browser running.
export async function migrateVisibleBrowserSession(session, owner, {
  restart = async () => {}, setHeadlessPreference = async () => {}, alreadyMigrated = false, now = Date.now(),
} = {}) {
  if (!session || session.headless !== false || alreadyMigrated) return null;
  const owned = Number.isSafeInteger(session.pid) && session.pid > 1
    && session.pid === owner?.pid && typeof session.launchedAt === 'string' && !!session.launchedAt;
  if (owned) await restart(session.project);
  else await setHeadlessPreference(session.project, true);
  return {
    project: session.project,
    at: new Date(now).toISOString(),
    action: owned ? 'restarted' : 'preference-only',
    keptRunning: !owned && !!owner,
  };
}
