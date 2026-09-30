// `herdr-boss goal set`: put the /goal on a running orchestrator at a moment when the pane can take a command.
// A command that arrives while the pane works is queued as plain text and does not run. The steps wait for an idle pane first.
import { goalSetText, goalVerdict, paneText, sendGoalPrompt } from './goal.js';
import { scrub } from './project-new-api.js';
import { agentReadyVisible } from './kit/workers.js';

export const GOAL_WAIT_MS = 10 * 60 * 1000;
export const GOAL_POLL_MS = 5000;
export const GOAL_ATTEMPTS = 3;
const VERIFY_CHECKS = 5;
const VERIFY_WAIT_MS = 2000;
const SETTLED = new Set(['idle', 'done']);
// Text that Codex shows in an empty input line.
const CODEX_PLACEHOLDER = /^(Ask Codex|Explain this|Summarize|Find and fix|Write tests|Improve documentation|Use \/skills|Implement \{|Run \/review)/i;

export const OUTCOME_TEXT = {
  active: 'goal set and active',
  unverified: 'sent but not shown',
  busy: 'the pane stayed busy',
  cancelled: 'cancelled',
};
export const EXIT_CODES = { active: 0, usage: 1, busy: 2, unverified: 3, cancelled: 130 };

// What on the screen stops the command: a dialog, or text in the input line. Null when the prompt is empty and ready.
export function screenBlocker(kind, text) {
  const raw = String(text ?? '').split(/\r?\n/);
  const lines = raw.map((line) => line.trim());
  if (kind === 'claude') {
    const typed = lines.find((line) => /^❯\s+\S/.test(line) && !/^❯\s+\d+[.)]/.test(line));
    if (typed && lines.some((line) => /(?:auto mode|\? for shortcuts)/i.test(line))) return 'input';
    return agentReadyVisible('claude', lines.join('\n')) ? null : 'dialog';
  }
  if (!agentReadyVisible(kind, raw.join('\n'))) return 'dialog';
  if (kind === 'codex') {
    const typed = raw.map((line) => /^› (\S.*)$/.exec(line.trimEnd())?.[1]).find(Boolean);
    if (typed && !CODEX_PLACEHOLDER.test(typed)) return 'input';
  }
  return null;
}

const BLOCK_TEXT = {
  working: 'the agent works',
  blocked: 'the agent is blocked',
  dialog: 'a dialog or another screen is on the pane',
  input: 'the input line holds text',
  gone: 'the pane does not exist',
};

// One look at the pane: { gone } or { status, text, blocker } where blocker is the screen blocker (dialog, input, or null).
export async function inspectPane({ run, pane, kind }) {
  let info;
  try { const got = await run(['pane', 'get', pane]); info = got?.pane ?? got; } catch { return { gone: true }; }
  if (!info || typeof info !== 'object') return { gone: true };
  const status = info.agent_status ?? info.status;
  let text = null;
  try { text = paneText(await run(['pane', 'read', pane, '--source', 'visible', '--lines', '80', '--format', 'text'])); } catch { /* An unreadable screen blocks the send. */ }
  return { status, text: text ?? '', blocker: text === null ? 'dialog' : screenBlocker(kind, text) };
}

// Why the pane cannot take a command now. Null when it can.
export function snapshotBlocker(snapshot) {
  if (snapshot.gone) return 'gone';
  if (!SETTLED.has(snapshot.status)) return snapshot.status === 'blocked' ? 'blocked' : 'working';
  return snapshot.blocker;
}

// One look at the pane. Returns null when it can take a command, else the reason.
export async function paneBlocker(options) {
  return snapshotBlocker(await inspectPane(options));
}

// The reason text of a result: no absolute path, no credential, at most 200 characters.
export function cleanReason(value) {
  return scrub(String(value ?? ''), null).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// Wait until the pane can take a command or the deadline passes. Returns { ok: true, snapshot } or { ok: false, reason, cancelled? }.
async function waitForPane({ run, pane, kind, now, sleep, deadline, pollMs, onState, signal }) {
  for (;;) {
    if (signal?.aborted) return { ok: false, cancelled: true, reason: 'cancelled' };
    const snapshot = await inspectPane({ run, pane, kind });
    const blocker = snapshotBlocker(snapshot);
    if (!blocker) return { ok: true, snapshot };
    if (blocker === 'gone') return { ok: false, reason: BLOCK_TEXT.gone };
    if (now() >= deadline) return { ok: false, reason: BLOCK_TEXT[blocker] };
    onState?.('waiting', BLOCK_TEXT[blocker]);
    await sleep(pollMs, signal);
  }
}

// Set the goal of the pane. Result: { outcome: 'active' | 'unverified' | 'busy' | 'cancelled', message, reason?, attempts }.
// The function never sends into a pane that works, shows a dialog, or holds input text.
// One deadline (waitMs from the start) covers the wait and every retry.
// The goal counts as active only when its text is new on the screen after the send and the pane confirms it.
export async function setGoal({ pane, kind, goal, run, now = Date.now, sleep = defaultSleep, waitMs = GOAL_WAIT_MS, pollMs = GOAL_POLL_MS, attempts = GOAL_ATTEMPTS, onState = null, signal = null }) {
  const checked = goalSetText(goal);
  if (checked.error) throw new Error(checked.error);
  const text = checked.text;
  const deadline = now() + waitMs;
  let sent = 0;
  let lastError = null;
  let previous = null;
  const result = (outcome, extra = {}) => ({ outcome, message: OUTCOME_TEXT[outcome], attempts: sent, ...extra });
  const stopped = (reason, cancelled) => {
    if (cancelled) return result('cancelled', sent ? { reason: 'cancelled after the goal was sent; it can still be set' } : {});
    return result(sent ? 'unverified' : 'busy', { reason: cleanReason(reason) });
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ready = await waitForPane({ run, pane, kind, now, sleep, deadline, pollMs, onState, signal });
    if (!ready.ok) return stopped(ready.reason, ready.cancelled);
    // A goal that rendered late after the last send counts. It is never sent twice.
    if (previous !== null && goalVerdict({ before: previous, snapshot: ready.snapshot, goal: text }) === 'active') return result('active', { text });
    const before = ready.snapshot.text;
    onState?.('sending');
    sent += 1;
    try { await sendGoalPrompt({ run, pane, goal: text, kind }); }
    catch (error) { lastError = cleanReason(error.stderr || error.message); previous = before; continue; }
    previous = before;
    onState?.('verifying');
    for (let check = 1; check <= VERIFY_CHECKS; check += 1) {
      if (signal?.aborted) return stopped('cancelled', true);
      const snapshot = await inspectPane({ run, pane, kind });
      if (snapshot.gone) return stopped(BLOCK_TEXT.gone, false);
      if (goalVerdict({ before, snapshot, goal: text }) === 'active') return result('active', { text });
      if (check < VERIFY_CHECKS) await sleep(VERIFY_WAIT_MS, signal);
    }
    if (now() >= deadline) break;
  }
  return result('unverified', lastError ? { reason: lastError } : {});
}

export class GoalError extends Error {
  constructor(message, code = EXIT_CODES.usage) { super(message); this.code = code; }
}

const PANE_ID = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const rows = (response, key) => (Array.isArray(response) ? response : response?.[key] ?? response?.result?.[key] ?? []);
const paneRow = (pane) => ({
  id: pane.pane_id ?? pane.id ?? null,
  workspace: pane.workspace_id ?? pane.workspace ?? null,
  label: pane.label ?? null,
  agent: pane.agent ?? null,
});

// Find the orchestrator pane. A project slug gives the orch pane of the workspace of that project.
// A pane id is accepted only when the pane is labeled orch: a worker, the Boss, and a pane without an agent are refused.
// control is the control object of the state file. Returns { pane, workspace, kind, slug }.
export async function resolveGoalTarget(target, { run, control = {} }) {
  if (typeof target !== 'string' || !target) throw new GoalError('Give a project slug or an orchestrator pane id.');
  let slug = null;
  let row;
  if (PANE_ID.test(target)) {
    try { const got = await run(['pane', 'get', target]); row = paneRow(got?.pane ?? got ?? {}); }
    catch { throw new GoalError(`Herdr has no pane ${target}.`, EXIT_CODES.busy); }
    if (row.id !== target) throw new GoalError(`Herdr has no pane ${target}.`, EXIT_CODES.busy);
    const project = Object.values(control.projects || {}).find((item) => item?.workspace === row.workspace);
    slug = project?.slug ?? null;
  } else {
    const project = control.projects?.[target];
    if (!project?.workspace) throw new GoalError(`No project ${target} has a workspace. Publish the project status first.`);
    const panes = rows(await run(['pane', 'list']), 'panes').map(paneRow).filter((pane) => pane.workspace === project.workspace && pane.label === 'orch');
    if (panes.length !== 1) throw new GoalError(`The workspace of ${target} has ${panes.length} panes labeled orch. Use the pane id.`, EXIT_CODES.busy);
    row = panes[0];
    slug = target;
  }
  if (row.label === 'boss') throw new GoalError(`Pane ${row.id} is the Boss pane, not an orchestrator pane.`, EXIT_CODES.busy);
  if (row.label !== 'orch') throw new GoalError(`Pane ${row.id} is labeled ${row.label ?? '(none)'}, not orch. A worker pane does not take a goal.`, EXIT_CODES.busy);
  if (!row.agent) throw new GoalError(`Pane ${row.id} has no agent.`, EXIT_CODES.busy);
  return { pane: row.id, workspace: row.workspace, kind: row.agent, slug };
}
