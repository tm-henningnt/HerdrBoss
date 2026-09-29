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
const TAIL = '. Run herdr-boss kit update and continue. The command prints the current kit file.';

function shortSubject(subject) {
  const text = String(subject || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 3)}...` : text;
}

// commits: [{ hash, subject }], newest first. revision is the kit revision of HEAD.
export function formatKitNotice(commits, revision = kitRevision()) {
  const shown = commits.slice(0, MAX_SUBJECTS).map((c) => shortSubject(c.subject));
  const head = `[herdr-boss] Kit revision ${revision ?? 'unknown'} (${commits.length} change(s)): `;
  const list = () => [...shown, ...(commits.length > shown.length ? [`and ${commits.length - shown.length} more`] : [])].join('; ');
  while (shown.length > 1 && head.length + list().length + TAIL.length > MAX_TEXT_LENGTH) shown.pop();
  return `${head}${list()}${TAIL}`;
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
// leaves every change at required.
function commitImpacts(commits, assetHashes, entries, stored) {
  const index = entries.findIndex((entry) => entry.revision === stored?.revision);
  const recorded = index >= 0 ? entries.slice(index + 1) : [];
  // Git lists newest first and the change log is chronological, so read the record in reverse.
  const aligned = recorded.length === assetHashes.length ? recorded.slice().reverse() : [];
  return commits.map((commit) => parseKitImpact(commit.message) ?? aligned.shift()?.impact ?? 'required');
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
  const reset = (event) => ({ state: { commit: head, at: now, revision }, alert: null, event });
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
  const required = commits.filter((_, index) => impacts[index] === 'required');
  if (!required.length) return reset(null);
  const alert = {
    key: `kit:${head.slice(0, 7)}`, severity: 'info', scope: 'all', once: true,
    title: 'Kit updated', text: formatKitNotice(required, revision),
  };
  return { state: { commit: head, at: now, revision, alert }, alert, event: null };
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
