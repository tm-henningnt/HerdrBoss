// `herdr-boss goal set`: put the /goal on a running orchestrator at a moment when the pane can take a command.
// A command that arrives while the pane works is queued as plain text and does not run. The steps wait for an idle pane first.
import { goalSetText, goalVerdict, paneText, sendGoalPrompt } from './goal.js';
import { scrub } from './project-new-api.js';
import { agentReadyVisible } from './kit/workers.js';

export const GOAL_WAIT_MS = 10 * 60 * 1000;
// How long one blocker may last before the wait fails. The Owner may send or clear a draft, or answer a dialog, within 2 minutes.
export const BLOCK_LIMIT_MS = { working: 10 * 60 * 1000, input: 2 * 60 * 1000, dialog: 2 * 60 * 1000 };
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

// Remove the escape sequences of a styled pane read.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;:?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

// The style state of the input line. unknown is set by any sequence that the parser does not fully understand.
const freshStyle = () => ({ dim: false, bold: false, reverse: false, fg: 'default', unknown: false });

// Change the style state for the parameters of one SGR sequence.
// A sequence with a colon sub-parameter, an unknown extended color mode, or a missing color value sets unknown.
function applySgr(state, params) {
  if (params.includes(':')) { state.unknown = true; return; }
  const p = params === '' ? [0] : params.split(';').map((part) => Number(part || 0));
  for (let i = 0; i < p.length; i += 1) {
    const code = p[i];
    if (code === 0) Object.assign(state, freshStyle(), { unknown: state.unknown });
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 22) { state.dim = false; state.bold = false; }
    else if (code === 7) state.reverse = true;
    else if (code === 27) state.reverse = false;
    else if (code === 39) state.fg = 'default';
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = 'other';
    else if (code === 38 || code === 48 || code === 58) {
      // The parameters of an extended color belong to the color. They never set a style.
      if (p[i + 1] === 5 && Number.isInteger(p[i + 2])) { if (code === 38) state.fg = 'other'; i += 2; }
      else if (p[i + 1] === 2 && [2, 3, 4].every((k) => Number.isInteger(p[i + k]))) { if (code === 38) state.fg = 'other'; i += 4; }
      else { state.unknown = true; return; }
    }
  }
}

// True when the input line holds typed text. Fail safe: any doubt counts as typed, so a typed draft is never overwritten.
// Only this style counts as a ghost suggestion: dim (SGR 2) with the default foreground, set after the prompt marker.
// Claude Code 2.1 draws the ghost suggestion as `❯ ESC[0m ESC[2m text ESC[0m` (observed on a live pane).
// The state resets at the marker, so a style before the marker does not count.
// Every character after the marker that is not a space must be ghost, from the first to the last.
// A bold, reverse, colored, or unstyled character, or an unknown sequence, counts as typed.
// The function reads only the style. It never keeps the text.
export function hasTypedText(rawLine) {
  let state = freshStyle();
  let seenMarker = false;
  const source = String(rawLine ?? '');
  for (let i = 0; i < source.length;) {
    if (source[i] === '\x1b') {
      const sgr = /^\x1b\[([0-9;:]*)m/.exec(source.slice(i, i + 60));
      if (sgr) { if (seenMarker) applySgr(state, sgr[1]); i += sgr[0].length; continue; }
      const other = ANSI.exec(source.slice(i));
      ANSI.lastIndex = 0;
      if (other && other.index === 0) { i += other[0].length; continue; }
      if (seenMarker) state.unknown = true;
      i += 1;
      continue;
    }
    const char = source[i];
    i += 1;
    if (!seenMarker) { if (char === '❯') { seenMarker = true; state = freshStyle(); } continue; }
    if (/\s/.test(char)) continue;
    const ghost = state.dim && !state.bold && !state.reverse && state.fg === 'default' && !state.unknown;
    if (!ghost) return true;
  }
  return false;
}

// What on the screen stops the command: a dialog, or typed text in the input line. Null when the prompt is empty and ready.
// The text can carry escape sequences. A ghost suggestion in the input line counts as an empty input line.
export function screenBlocker(kind, text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  const lines = rawLines.map((line) => stripAnsi(line).trim());
  if (kind === 'claude') {
    let at = -1;
    lines.forEach((line, index) => { if (/^❯/.test(line) && !/^❯\s+\d+[.)]/.test(line)) at = index; });
    if (at >= 0 && /^❯\s+\S/.test(lines[at])) {
      if (!hasTypedText(rawLines[at])) lines[at] = '❯';
      else if (lines.some((line) => /(?:auto mode|\? for shortcuts)/i.test(line))) return 'input';
    }
    return agentReadyVisible('claude', lines.join('\n')) ? null : 'dialog';
  }
  const plain = rawLines.map((line) => stripAnsi(line));
  if (!agentReadyVisible(kind, plain.join('\n'))) return 'dialog';
  if (kind === 'codex') {
    const typed = plain.map((line) => /^› (\S.*)$/.exec(line.trimEnd())?.[1]).find(Boolean);
    if (typed && !CODEX_PLACEHOLDER.test(typed)) return 'input';
  }
  return null;
}

// One reason text for each blocker. The wait, the dry run, the result, and the page status all use it.
// The text never holds pane text.
export const BLOCK_TEXT = {
  working: 'the agent works',
  dialog: 'a dialog is on screen',
  input: 'the input box holds unsent text',
  notorch: 'the pane is not an orchestrator',
  gone: 'the pane is gone',
};
export const blockerText = (blocker) => BLOCK_TEXT[blocker] ?? BLOCK_TEXT.dialog;

// One look at the pane: { gone } or { status, text, blocker } where blocker is the screen blocker (dialog, input, or null).
export async function inspectPane({ run, pane, kind }) {
  let info;
  try { const got = await run(['pane', 'get', pane]); info = got?.pane ?? got; } catch { return { gone: true }; }
  if (!info || typeof info !== 'object') return { gone: true };
  const status = info.agent_status ?? info.status;
  let raw = null;
  try { raw = paneText(await run(['pane', 'read', pane, '--source', 'visible', '--lines', '80', '--format', 'ansi'])); } catch { /* An unreadable screen blocks the send. */ }
  const label = typeof info.label === 'string' ? info.label : undefined;
  return { status, label, text: raw === null ? '' : stripAnsi(raw), blocker: raw === null ? 'dialog' : screenBlocker(kind, raw) };
}

// Why the pane cannot take a command now. Null when it can.
export function snapshotBlocker(snapshot) {
  if (snapshot.gone) return 'gone';
  if (snapshot.label !== undefined && snapshot.label !== 'orch') return 'notorch';
  if (!SETTLED.has(snapshot.status)) return snapshot.status === 'blocked' ? 'dialog' : 'working';
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

// Wait until the pane can take a command, the deadline passes, or one blocker lasts longer than its limit.
// The pane is read again at each poll, so the reason in onState is the current one.
// Returns { ok: true, snapshot } or { ok: false, reason, blocker?, cancelled? }.
async function waitForPane({ run, pane, kind, now, sleep, deadline, pollMs, onState, signal, limits }) {
  let current = null;
  let since = now();
  for (;;) {
    if (signal?.aborted) return { ok: false, cancelled: true, reason: 'cancelled' };
    const snapshot = await inspectPane({ run, pane, kind });
    const blocker = snapshotBlocker(snapshot);
    if (!blocker) return { ok: true, snapshot };
    if (blocker === 'gone' || blocker === 'notorch') return { ok: false, blocker, reason: blockerText(blocker) };
    if (blocker !== current) { current = blocker; since = now(); }
    const limit = limits[blocker];
    if (now() >= deadline || (limit !== undefined && now() - since >= limit)) return { ok: false, blocker, reason: blockerText(blocker) };
    onState?.('waiting', blockerText(blocker));
    await sleep(pollMs, signal);
  }
}

// Set the goal of the pane. Result: { outcome: 'active' | 'unverified' | 'busy' | 'cancelled', message, reason?, attempts }.
// The function never sends into a pane that works, shows a dialog, or holds input text.
// One deadline (waitMs from the start) covers the wait and every retry.
// The goal counts as active only when its text is new on the screen after the send and the pane confirms it.
export async function setGoal({ pane, kind, goal, run, now = Date.now, sleep = defaultSleep, waitMs = GOAL_WAIT_MS, pollMs = GOAL_POLL_MS, attempts = GOAL_ATTEMPTS, onState = null, signal = null, limits = BLOCK_LIMIT_MS, notify = null }) {
  const checked = goalSetText(goal);
  if (checked.error) throw new Error(checked.error);
  const text = checked.text;
  const deadline = now() + waitMs;
  let sent = 0;
  let lastError = null;
  let previous = null;
  const result = (outcome, extra = {}) => ({ outcome, message: OUTCOME_TEXT[outcome], attempts: sent, ...extra });
  const stopped = (reason, cancelled, blocker = null) => {
    if (cancelled) return result('cancelled', sent ? { reason: 'cancelled after the goal was sent; it can still be set' } : {});
    if (!sent && blocker) {
      // The Owner gets one Mailbox item for a blocker that the wait could not clear.
      try { notify?.({ blocker, pane }); } catch { /* A failed notice does not change the result. */ }
    }
    return result(sent ? 'unverified' : 'busy', { reason: cleanReason(reason), ...(!sent && blocker ? { blocker } : {}) });
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ready = await waitForPane({ run, pane, kind, now, sleep, deadline, pollMs, onState, signal, limits });
    if (!ready.ok) return stopped(ready.reason, ready.cancelled, ready.blocker);
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
