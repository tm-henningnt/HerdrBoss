// Readable workers for the Agents page. The module turns run records and pane text into plain rows.
// A row holds a title, a state, one "now" line, and for a finished run the report summary and the result.
// The brief text never goes into a row. The brief endpoint serves it on request, masked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './redact.js';
import { workerFactFromRun } from './task-state.js';

export const BRIEF_KEEP_MS = 30 * 86400000;
export const BRIEF_MAX_CHARS = 256 * 1024;
export const ACTION_REFRESH_MS = 30000;
const TITLE_MAX = 140;
const LINE_MAX = 140;
const SUMMARY_MAX = 400;
const SCREEN_LINES = 60;
const GENERIC_HEADINGS = new Set(['worker brief']);

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// Mask secrets and the home folder. Every text that reaches the browser passes through this function.
export function maskText(value) {
  const text = String(value ?? '');
  const home = os.homedir();
  return redactSecrets(home && home !== '/' ? text.split(home).join('~') : text);
}

// ---------- Pane text ----------

export function cleanScreen(text) {
  return String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

function shortPath(value) {
  let text = String(value ?? '').trim().replace(/\s+\([+-]\d+.*\)$/, '').replace(/^["'`]|["'`,.:]+$/g, '');
  if (text.startsWith('/')) {
    const parts = text.split('/').filter(Boolean);
    if (parts.length > 3) text = `…/${parts.slice(-3).join('/')}`;
  }
  return clip(text, 80);
}

const TEST_COMMAND = /\b(?:node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test|npm\s+(?:run\s+)?test|npx\s+(?:vitest|jest)|vitest|jest|pytest|go\s+test|cargo\s+test|playwright\s+test|mocha)\b/;

function testScope(command) {
  const target = command.split(/\s+/).find((part) => !part.startsWith('-') && /\//.test(part) && !/^(?:https?:|\/dev\/)/.test(part));
  if (!target) return 'Running tests';
  const clean = target.replace(/^["'`]|["'`;]+$/g, '');
  return `Running tests in ${shortPath(/\.[A-Za-z0-9]+$/.test(path.basename(clean)) ? path.dirname(clean) : clean)}`;
}

function describeCommand(raw) {
  const command = String(raw ?? '').trim();
  if (!command) return null;
  if (/\bherdr\s+agent\s+prompt\b.*WORKER\s+REPORT/i.test(command)) return 'Sending the report to the orchestrator';
  if (/\bherdr\s+agent\s+prompt\b.*WORKER\s+QUESTION/i.test(command)) return 'Asking the orchestrator a question';
  if (/herdr-boss\s+(?:suite|push|lock)\b/.test(command)) return 'Waiting for the lock or running the suite';
  if (/herdr-boss\s+browser\b/.test(command)) return 'Checking the page in the browser';
  if (/\.worker\/report\.(?:md|json)/.test(command) && /(?:>|tee)/.test(command)) return 'Writing the report';
  if (TEST_COMMAND.test(command)) return testScope(command);
  if (/\bnode\s+--check\b/.test(command)) return 'Checking the syntax';
  const git = /^git\s+(?:-C\s+\S+\s+)?([a-z-]+)/.exec(command);
  if (git) return `Running git ${git[1]}`;
  return `Running ${clip(command.replace(/\s+/g, ' '), 60)}`;
}

function describeTool(tool, arg) {
  const name = String(tool).toLowerCase();
  if (name === 'bash' || name === '$' || name === 'ran' || name === 'running') return describeCommand(arg);
  if (['update', 'edit', 'multiedit', 'write', 'edited', 'added', 'updated', 'wrote'].includes(name)) {
    return /\.worker\/report\.(?:md|json)/.test(arg) ? 'Writing the report' : `Editing ${shortPath(arg)}`;
  }
  if (['read', 'reading'].includes(name)) return `Reading ${shortPath(arg)}`;
  if (['grep', 'glob', 'search', 'explored', 'searched', 'list'].includes(name)) return 'Searching the code';
  if (['task', 'agent'].includes(name)) return 'Running a subagent';
  if (['webfetch', 'websearch'].includes(name)) return 'Reading the web';
  return null;
}

const CLAUDE_TOOL = /^[●⏺]\s*([A-Za-z]+)\((.*?)\)?$/;
const CODEX_TOOL = /^[•]\s*(Ran|Running|Edited|Added|Updated|Wrote|Read|Explored|Searched)\b\s*(.*)$/;
const OTHER_TOOL = /^[→←✱⚙]\s*(Read|Edit|Write|Grep|Glob|Bash|List)\b\s*(.*)$/;
const SHELL_PROMPT = /^\$\s+(.+)$/;
const LOCK_WAIT = /waiting\s+for\s+(?:the\s+)?(?:[\w-]+\s+)?lock/i;

// The last meaningful action on a pane screen, as one plain line. Returns null when the screen shows none.
export function paneAction(text) {
  const lines = cleanScreen(text).split('\n').map((line) => line.replace(/^[\s│┃]+/, '').trimEnd()).filter(Boolean).slice(-SCREEN_LINES);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (LOCK_WAIT.test(line)) return 'Waiting for the lock';
    const claude = CLAUDE_TOOL.exec(line);
    const codex = !claude && CODEX_TOOL.exec(line);
    const other = !claude && !codex && OTHER_TOOL.exec(line);
    const shell = !claude && !codex && !other && SHELL_PROMPT.exec(line);
    const match = claude ? [claude[1], claude[2]] : codex ? [codex[1], codex[2]] : other ? [other[1], other[2]] : shell ? ['$', shell[1]] : null;
    if (!match) continue;
    const described = describeTool(match[0], maskText(match[1]));
    if (described) return clip(maskText(described), LINE_MAX);
  }
  return null;
}

// Whole minutes since the screen last changed. An entry is { changedAt }.
export function noOutputMinutes(entry, now) {
  return Number.isFinite(entry?.changedAt) ? Math.max(0, Math.floor((now - entry.changedAt) / 60000)) : 0;
}

// ---------- Text from the brief and the report ----------

export function titleFromTask(task) {
  const line = String(task ?? '').split('\n').map((item) => item.trim()).find(Boolean);
  if (!line) return null;
  return clip(maskText(line.replace(/^#{1,6}\s+/, '').trim()), TITLE_MAX) || null;
}

// The first heading that is not the generic "Worker brief" heading.
export function titleFromBrief(markdown) {
  for (const line of String(markdown ?? '').split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading && !GENERIC_HEADINGS.has(heading[1].trim().toLowerCase())) return clip(maskText(heading[1].trim()), TITLE_MAX);
  }
  return null;
}

// The first block of prose in a report, joined to one line.
export function firstParagraph(markdown) {
  const blocks = String(markdown ?? '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines[0].startsWith('#') || lines[0].startsWith('```')) continue;
    const text = lines.join(' ').replace(/^[-*]\s+/, '').replace(/[*_`]/g, '');
    return clip(maskText(text), SUMMARY_MAX);
  }
  return null;
}

// ---------- The brief copy in the run record ----------

// The copy holds the masked text, bounded, and the hash of that masked text.
export function briefCopy(text, now = Date.now()) {
  const masked = maskText(text).slice(0, BRIEF_MAX_CHARS);
  return { hash: crypto.createHash('sha256').update(masked).digest('hex'), savedAt: new Date(now).toISOString(), text: masked };
}

const keepFrom = (record) => Date.parse(record?.finishedAt || record?.startedAt || '');

function copyExpired(record, now) {
  const from = keepFrom(record);
  return Number.isFinite(from) && now - from > BRIEF_KEEP_MS;
}

export function briefCopyText(record, now = Date.now()) {
  const copy = record?.briefCopy;
  if (typeof copy?.text !== 'string' || copyExpired(record, now)) return null;
  return copy.text;
}

// Read a regular file. When root is given, the real path of the file must stay inside the real path of root.
function readBounded(file, root = null) {
  try {
    let target = file;
    if (root) {
      target = fs.realpathSync(file);
      const base = fs.realpathSync(root);
      if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    return fs.readFileSync(target, 'utf8').slice(0, BRIEF_MAX_CHARS);
  } catch { return null; }
}

const workerFile = (record, name) => (record?.worktree && path.isAbsolute(record.worktree) ? path.join(record.worktree, record.workerDir || '.worker', name) : null);

// The brief for the panel: the copy in the record first, then the file in the worktree. Always masked.
export function workerBrief(record, now = Date.now()) {
  const copy = briefCopyText(record, now);
  if (copy != null) return { source: 'copy', hash: record.briefCopy.hash || null, savedAt: record.briefCopy.savedAt || null, text: maskText(copy) };
  const file = workerFile(record, 'brief.md');
  const live = file ? readBounded(file, record.worktree) : null;
  if (live == null) return null;
  const text = maskText(live);
  return { source: 'worktree', hash: crypto.createHash('sha256').update(text).digest('hex'), savedAt: null, text };
}

// Remove the text of every copy older than 30 days. The hash stays. Returns the number of records changed.
// A record that changes between the read and the rename belongs to a concurrent writer (worker collect). The prune skips it.
export function pruneBriefCopies(runsPath, now = Date.now(), { beforeRename = null } = {}) {
  let pruned = 0;
  let files = [];
  try { files = fs.readdirSync(runsPath).filter((name) => name.endsWith('.json')); } catch { return 0; }
  for (const name of files) {
    const file = path.join(runsPath, name);
    const temp = `${file}.tmp`;
    try {
      const before = fs.statSync(file).mtimeMs;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof record?.briefCopy?.text !== 'string' || !copyExpired(record, now)) continue;
      delete record.briefCopy.text;
      fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
      if (beforeRename) beforeRename(file);
      if (fs.statSync(file).mtimeMs !== before) { fs.rmSync(temp, { force: true }); continue; }
      fs.renameSync(temp, file);
      pruned += 1;
    } catch { fs.rmSync(temp, { force: true }); }
  }
  return pruned;
}

export const FINISHED_ROW_LIMIT = 50;

// Keep every live row and the newest finished rows.
export function capFinished(rows, limit = FINISHED_ROW_LIMIT) {
  const time = (row) => Date.parse(row.finishedAt || row.startedAt) || 0;
  const finished = rows.filter((row) => row.group === 'finished').sort((a, b) => time(b) - time(a)).slice(0, limit);
  return [...rows.filter((row) => row.group !== 'finished'), ...finished];
}

// ---------- Rows ----------

const RESULT = { merged: 'Merged', review: 'Collected, not merged', finished: 'Collected, not merged', failed: 'Needs rework', abandoned: 'Abandoned' };

function liveNow(status, action, idleMs, now) {
  if (status === 'working') {
    if (action?.text) return action.text;
    const minutes = noOutputMinutes(action, now);
    return minutes >= 1 ? `Working (no output for ${minutes} minute${minutes === 1 ? '' : 's'})` : 'Working';
  }
  if (status === 'blocked') return action?.text ? `Blocked after: ${action.text}` : 'Blocked: waiting for an approval or an answer';
  if (status === 'idle' || status === 'done') {
    const minutes = Number.isFinite(idleMs) ? Math.floor(idleMs / 60000) : 0;
    return minutes >= 1 ? `Idle for ${minutes} minute${minutes === 1 ? '' : 's'}` : 'Idle';
  }
  return 'Status unknown';
}

// Rows for the run records of one project.
// panes: Map pane id -> { status }, or null when Herdr gave no pane list. actions: Map pane id -> { text, changedAt }.
export function readWorkerRows(runsPath, { project, now = Date.now(), panes = null, actions = new Map(), paneSince = {}, isMerged = () => false } = {}) {
  let files = [];
  try { files = fs.readdirSync(runsPath).filter((name) => name.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const file of files) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runsPath, file), 'utf8')); } catch { continue; }
    if (!record?.name || record.startFailed) continue;
    const fact = workerFactFromRun(record, {
      isLive: (run) => !panes || panes.has(run.pane),
      agentStatus: (run) => panes?.get(run.pane)?.status ?? null,
      isMerged,
      now,
    });
    if (!fact) continue;
    const live = fact.phase === 'live';
    const status = live ? (panes?.get(record.pane)?.status || 'unknown') : fact.phase;
    const briefFile = workerFile(record, 'brief.md');
    const copyText = briefCopyText(record, now);
    // A finished row reads no file. A stored title and a stored copy also spare the read for a live row.
    const title = record.title
      || titleFromBrief(copyText ?? (live && briefFile ? readBounded(briefFile, record.worktree) : null))
      || (fact.taskId ? `Task ${fact.taskId}` : record.name);
    const since = paneSince?.[record.pane]?.since;
    const row = {
      key: `${project}/${record.name}`,
      project, name: record.name, kind: record.kind ?? null, model: record.model ?? null, pane: record.pane ?? null,
      taskId: fact.taskId, title,
      state: status,
      group: !live ? 'finished' : status === 'working' ? 'working' : 'waiting',
      startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? record.collectedAt ?? null,
      now: live ? liveNow(status, actions.get(record.pane), Number.isFinite(since) ? now - since : null, now) : null,
      summary: null, result: null,
      hasBrief: copyText != null || !!record.briefCopy?.hash || (live && !!briefFile && fs.existsSync(briefFile)),
      scope: Array.isArray(record.allowedPaths) ? record.allowedPaths.map((item) => maskText(item)) : [],
      reportPath: `${record.workerDir || '.worker'}/report.md`,
    };
    if (!live) {
      row.result = RESULT[fact.phase] || null;
      row.summary = record.reportSummary ? maskText(record.reportSummary) : null;
    }
    rows.push(row);
  }
  return rows.sort((a, b) => (a.group === 'finished') - (b.group === 'finished')
    || (Date.parse(b.finishedAt || b.startedAt) || 0) - (Date.parse(a.finishedAt || a.startedAt) || 0));
}
