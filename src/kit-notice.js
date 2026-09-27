// Kit change notice: after a service restart, tell each project orchestrator which kit commits
// arrived since the last notice. The engine reads git once at start. There are no timers.

export const KIT_PATHS = Object.freeze(['kit', 'src/kit', 'docs/orchestrator-instructions.md']);
const MAX_SUBJECTS = 10;
const MAX_SUBJECT_LENGTH = 90;
const MAX_TEXT_LENGTH = 1199;
const PENDING_MS = 7 * 86400 * 1000;
const TAIL = '. Run herdr-boss check agents, and reinstall the block with herdr-boss kit block if it reports an old block.';

function shortSubject(subject) {
  const text = String(subject || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 3)}...` : text;
}

// commits: [{ hash, subject }], newest first.
export function formatKitNotice(commits) {
  const shown = commits.slice(0, MAX_SUBJECTS).map((c) => shortSubject(c.subject));
  const head = `[herdr-boss] Kit updated (${commits.length} change(s)): `;
  const list = () => [...shown, ...(commits.length > shown.length ? [`and ${commits.length - shown.length} more`] : [])].join('; ');
  while (shown.length > 1 && head.length + list().length + TAIL.length > MAX_TEXT_LENGTH) shown.pop();
  return `${head}${list()}${TAIL}`;
}

function parseLog(stdout) {
  return String(stdout || '').split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return tab < 0 ? { hash: line, subject: '' } : { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

function errorText(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0].slice(0, 200);
}

// Returns { state, alert, event }. state is the new memory.kitNotice value; event is one log line or null.
// git(args) runs `git <args>` and resolves to stdout; it rejects when git exits with a non-zero status.
export async function readKitNotice({ root, stored, git, now }) {
  let head;
  try { head = String(await git(['-C', root, 'rev-parse', 'HEAD'])).trim(); }
  catch (error) { return { state: stored ?? null, alert: null, event: `Kit notice skipped: git rev-parse failed: ${errorText(error)}` }; }
  const reset = (event) => ({ state: { commit: head, at: now }, alert: null, event });
  if (!head) return { state: stored ?? null, alert: null, event: 'Kit notice skipped: git rev-parse printed no commit' };
  if (!stored?.commit) return reset(null);
  if (stored.commit === head) return { state: stored, alert: null, event: null };
  try { await git(['-C', root, 'merge-base', '--is-ancestor', stored.commit, head]); }
  catch { return reset(`Kit notice skipped: the stored commit ${stored.commit.slice(0, 7)} is not an ancestor of HEAD ${head.slice(0, 7)}`); }
  let commits;
  try { commits = parseLog(await git(['-C', root, 'log', '--format=%h%x09%s', `${stored.commit}..HEAD`, '--', ...KIT_PATHS])); }
  catch (error) { return reset(`Kit notice skipped: git log failed: ${errorText(error)}`); }
  if (!commits.length) return reset(null);
  const alert = {
    key: `kit:${head.slice(0, 7)}`, severity: 'info', scope: 'all', once: true,
    title: 'Kit updated', text: formatKitNotice(commits),
  };
  return { state: { commit: head, at: now, alert }, alert, event: null };
}

// The alert stays active until each orchestrator gets it, for at most seven days.
export function pendingKitAlert(state, now) {
  if (!state?.alert || !Number.isFinite(state.at) || now - state.at > PENDING_MS) return null;
  return state.alert;
}

export function isKitAlert(alert) {
  return typeof alert?.key === 'string' && alert.key.startsWith('kit:');
}

// Every project orchestrator gets the notice. The Boss gets kit reports from the HerdrBoss orchestrator.
export function kitNoticeTargets(orchs) {
  return orchs.filter((o) => o.label !== 'boss' && !/^boss$/i.test(o.workspaceLabel || ''));
}
