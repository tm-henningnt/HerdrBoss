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

function warning({ project, kind, text, identity }) {
  return { key: `browser:safety:${project}:${kind}:${identity}`, project, kind, text };
}

// Find visible managed browsers and automation browsers launched inside a project pane tree.
// This function reads only the supplied process snapshot and never signals a process.
export function browserSafetyNotices({ processes = new Map(), panes = [], projects = {}, sessions = [], allowVisible = false } = {}) {
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

    const paneId = ownerPane(process.pid, processMap, shellToPane);
    const pane = paneById.get(paneId);
    const projectLead = pane && (pane.label === 'orch' || (pane.orch === true && pane.label !== 'boss'));
    if (!pane || (!pane.agent && !projectLead) || launchedThroughBrowserCommand(process.pid, processMap)) continue;
    const project = projectForWorkspace.get(pane.workspace);
    if (!project) continue;
    const item = warning({ project, kind: 'independent-browser-launch', identity: `${process.pid}`,
      text: `A worker or project lead launched Chrome for ${project} outside herdr-boss browser. Attach with herdr-boss browser request ${project}.` });
    notices.set(item.key, item);
  }

  return [...notices.values()];
}

// Retain active notice keys across service ticks so each problem creates one event and one alert.
export function browserSafetyNoticeDelta(notices = [], previous = {}) {
  const active = Object.fromEntries(notices.map((item) => [item.key, true]));
  return {
    active,
    added: notices.filter((item) => !previous[item.key]),
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
