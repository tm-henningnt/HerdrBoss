// Kit change notice: after a service restart, tell each project orchestrator which required kit
// commits arrived since the last notice. The engine reads git once at start. There are no timers.
import { CHANGES_FILE, kitRevision, parseKitImpact, readKitChanges } from './kit/agents-check.js';

// 'kit' includes kit/templates/project-kit.md and kit/templates/agents-stub.md.
export const KIT_PATHS = Object.freeze(['kit', 'src/kit', 'docs/orchestrator-instructions.md']);
// The installed kit assets that kitRevision() hashes. A commit that changes one of them is a kit
// release. Keep this list in step with the revision inputs in src/kit/agents-check.js.
export const KIT_REVISION_PATHS = Object.freeze([
  'kit/templates',
  'kit/skills/herdr-orchestrator/SKILL.md',
  'kit/skills/herdr-orchestrator/reference',
  'kit/models.json',
  'kit/watch',
]);
// One log record: hash, subject, and the whole message. The unit separator keeps a subject that
// holds a newline from splitting a record, and the null byte ends it.
const LOG_FORMAT = '%h%x1f%s%x1f%B%x00';
const MAX_SUBJECTS = 10;
const MAX_SUBJECT_LENGTH = 90;
const MAX_TEXT_LENGTH = 1199;
const PENDING_MS = 7 * 86400 * 1000;
const MAX_PENDING = 50;
// The steps that finish a kit adoption. The reminder in src/engine.js uses the same sentence.
export const KIT_ADOPT_STEPS = 'Run herdr-boss kit update, set kitRevision in the status to the v= value of docs/orchestration/herdr-boss.md, and publish.';
const TAIL = `. ${KIT_ADOPT_STEPS} The command prints the current kit file.`;
// A batch of useful changes only needs an update at the next task boundary, so it takes a short line.
// Any required entry keeps the full adopt steps.
const USEFUL_TAIL = '. Run herdr-boss kit update at the next task boundary.';

function shortSubject(subject) {
  const text = String(subject || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 3)}...` : text;
}

// commits: [{ hash, subject, impact? }], newest first. revision is the kit revision of HEAD.
// A batch whose entries all have impact 'useful' takes the short line; any other impact keeps the adopt steps.
export function formatKitNotice(commits, revision = kitRevision()) {
  const tail = commits.length && commits.every((c) => c.impact === 'useful') ? USEFUL_TAIL : TAIL;
  const shown = commits.slice(0, MAX_SUBJECTS).map((c) => shortSubject(c.subject));
  const head = `[herdr-boss] Kit revision ${revision ?? 'unknown'} (${commits.length} change(s)): `;
  const list = () => [...shown, ...(commits.length > shown.length ? [`and ${commits.length - shown.length} more`] : [])].join('; ');
  while (shown.length > 1 && head.length + list().length + tail.length > MAX_TEXT_LENGTH) shown.pop();
  return `${head}${list()}${tail}`;
}

function parseLog(stdout) {
  // Git ends each record with the format string and then a newline, so the newline starts the next record.
  return String(stdout || '').split('\0').map((record) => record.replace(/^\n+/, '')).filter(Boolean).map((record) => {
    const first = record.indexOf('\x1f');
    if (first < 0) return { hash: record, subject: '', message: '' };
    const second = record.indexOf('\x1f', first + 1);
    if (second < 0) return { hash: record.slice(0, first), subject: record.slice(first + 1), message: '' };
    return { hash: record.slice(0, first), subject: record.slice(first + 1, second), message: record.slice(second + 1) };
  });
}

// The impact of each commit, in the order of commits, which is newest first. A commit that carries
// no usable Kit-Impact: trailer takes the impact of the change log entry that lines up with it. A
// batch that does not line up with the change log, or a stored cursor without a known revision,
// leaves every change at useful. Only a trailer or a change log entry sets required.
function commitImpacts(commits, assetHashes, entries, stored) {
  const index = entries.findIndex((entry) => entry.revision === stored?.revision);
  const recorded = index >= 0 ? entries.slice(index + 1) : [];
  // Git lists newest first and the change log is chronological, so read the record in reverse.
  const aligned = recorded.length === assetHashes.length ? recorded.slice().reverse() : [];
  return commits.map((commit) => parseKitImpact(commit.message) ?? aligned.shift()?.impact ?? 'useful');
}

// The required commits that no pane has received yet, newest first. Older than seven days or over
// the cap, an entry leaves the list.
function mergePending(previous, added, now) {
  const seen = new Set();
  const merged = [...added.map((c) => ({ hash: c.hash, subject: c.subject, at: now, ...(c.impact ? { impact: c.impact } : {}) })), ...(Array.isArray(previous) ? previous : [])];
  const live = merged.filter((e) => e?.hash && Number.isFinite(e.at) && now - e.at <= PENDING_MS && !seen.has(e.hash) && seen.add(e.hash));
  const expired = (Array.isArray(previous) ? previous : []).filter((e) => !(Number.isFinite(e?.at) && now - e.at <= PENDING_MS)).length;
  return { list: live.slice(0, MAX_PENDING), expired, capped: Math.max(0, live.length - MAX_PENDING) };
}

// One log line, with counts only, when pending changes leave the list unsent.
function dropEvent(expired, capped) {
  if (!expired && !capped) return null;
  return `Kit notice dropped unsent pending changes: ${expired} expired after 7 days, ${capped} over the ${MAX_PENDING} entry cap`;
}

function kitAlert(head, pending, revision) {
  return {
    key: `kit:${head.slice(0, 7)}`, severity: 'info', scope: 'all', once: true,
    title: 'Kit updated', text: formatKitNotice(pending, revision),
  };
}

function errorText(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0].slice(0, 200);
}

// Returns { state, alert, event }. state is the new memory.kitNotice value; event is one log line or null.
// git(args) runs `git <args>` and resolves to stdout; it rejects when git exits with a non-zero status.
export async function readKitNotice({ root, stored, git, now, changesFile = CHANGES_FILE }) {
  let head;
  try { head = String(await git(['-C', root, 'rev-parse', 'HEAD'])).trim(); }
  catch (error) { return { state: stored ?? null, alert: null, event: `Kit notice skipped: git rev-parse failed: ${errorText(error)}` }; }
  // The revision comes from the project root that the caller supplies, not from the default kit root.
  const revision = kitRevision(root);
  // Required changes that no pane has received yet stay in the state, also when HEAD moves without a new kit commit.
  const { list: carried, expired } = mergePending(stored?.pending, [], now);
  const reset = (event) => ({ state: { commit: head, at: now, revision, ...(carried.length ? { pending: carried, alert: kitAlert(head, carried, revision) } : {}) }, alert: null, event, dropEvent: dropEvent(expired, 0) });
  if (!head) return { state: stored ?? null, alert: null, event: 'Kit notice skipped: git rev-parse printed no commit' };
  if (!stored?.commit) return reset(null);
  if (stored.commit === head) return { state: stored, alert: null, event: null };
  try { await git(['-C', root, 'merge-base', '--is-ancestor', stored.commit, head]); }
  catch { return reset(`Kit notice skipped: the stored commit ${stored.commit.slice(0, 7)} is not an ancestor of HEAD ${head.slice(0, 7)}`); }
  let commits;
  try { commits = parseLog(await git(['-C', root, 'log', `--format=${LOG_FORMAT}`, `${stored.commit}..HEAD`, '--', ...KIT_PATHS])); }
  catch (error) { return reset(`Kit notice skipped: git log failed: ${errorText(error)}`); }
  if (!commits.length) return reset(null);
  let assetHashes = [];
  try { assetHashes = parseLog(await git(['-C', root, 'log', '--format=%h%x00', `${stored.commit}..HEAD`, '--', ...KIT_REVISION_PATHS])).map((c) => c.hash); }
  catch { assetHashes = []; }
  const impacts = commitImpacts(commits, assetHashes, readKitChanges(changesFile), stored);
  const required = commits.filter((_, index) => impacts[index] === 'required').map((commit) => ({ ...commit, impact: 'required' }));
  if (!required.length) return reset(null);
  const { list: pending, capped } = mergePending(stored?.pending, required, now);
  const alert = kitAlert(head, pending, revision);
  return { state: { commit: head, at: now, revision, pending, alert }, alert, event: null, dropEvent: dropEvent(expired, capped) };
}

// The alert stays active until each orchestrator gets it, for at most seven days.
export function pendingKitAlert(state, now) {
  if (!state?.alert || !Number.isFinite(state.at) || now - state.at > PENDING_MS) return null;
  return state.alert;
}

export function isKitAlert(alert) {
  return typeof alert?.key === 'string' && alert.key.startsWith('kit:');
}

// Every project orchestrator gets the notice, except the orchestrator of a held project (paused,
// held, or stood down). held is a Set of workspace ids. The Boss gets kit reports from the HerdrBoss orchestrator.
export function kitNoticeTargets(orchs, held = new Set()) {
  return orchs.filter((o) => o.label !== 'boss' && !/^boss$/i.test(o.workspaceLabel || '') && !held.has(o.workspace));
}

// The pending changes that one pane has not received. sent is the list of commit hashes that the pane got.
// firstSeen is the time when the engine first saw the pane. A pane that started after a change
// loaded the change with its kit at start, so the pane does not get a notice for that change.
export function unsentKitChanges(state, sent = [], firstSeen = null) {
  const got = new Set(sent);
  return (state?.pending || []).filter((change) => !got.has(change.hash) && !(Number.isFinite(firstSeen) && firstSeen > change.at));
}
