// publish --sync: reconcile card states with repository facts before the status is installed.
// docs/board.md holds the rules. A card without a fact keeps its state.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyBoardFacts, issueNumber, readCommits, validBranch, GH_TIMEOUT_MS } from './board-facts.js';
import { cleanGhEnv, originRepo } from './gh-labels.js';
import { overlayTasks } from './task-state.js';

const execFileAsync = promisify(execFile);

async function defaultGithub(args, { cwd, timeout }) {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout, env: cleanGhEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// github is the read-only external reader seam. The issue API supplies state_reason and created_at.
// Only the GitHub default branch supplies commit evidence. No GitHub answer means no completion.
export async function readSyncFacts(repo, { branch = 'main', github = defaultGithub, git, timeout = GH_TIMEOUT_MS } = {}) {
  let githubRepo;
  try { githubRepo = originRepo(repo); } catch {
    return { githubRepo: null, commits: await readCommits(repo, { branch, git }), issues: null };
  }
  const facts = { githubRepo, commits: null, issues: null };
  let defaultBranch;
  try {
    defaultBranch = JSON.parse(await github(['api', `repos/${githubRepo}`], { cwd: repo, timeout })).default_branch;
    if (!validBranch(defaultBranch)) throw new Error('Invalid branch');
  } catch {
    return { ...facts, githubError: 'GitHub default branch unavailable' };
  }
  facts.commits = await readCommits(repo, { branch: defaultBranch, git, includeAuthorTime: true });
  try {
    const pages = JSON.parse(await github(['api', '--paginate', '--slurp', `repos/${githubRepo}/issues?state=all&per_page=100`], { cwd: repo, timeout }));
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('Invalid issue pages');
    facts.issues = new Map(pages.flat().filter((row) => Number.isInteger(row?.number) && !row.pull_request && ['open', 'closed'].includes(row.state)).map((row) => [row.number, {
      state: row.state, stateReason: row.state_reason ?? null, createdAt: row.created_at ?? null, closedAt: row.closed_at ?? null,
    }]));
  } catch {
    facts.githubError = 'GitHub issues unavailable';
  }
  return facts;
}

// The status of a card for a computed state. A stuck card is doing.
const statusOf = (computedState) => (computedState === 'stuck' ? 'doing' : computedState);

const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// A local #number, a qualified repository reference, or a GitHub issue URL after a closing keyword.
function closesIssue(text, number, repo) {
  const pattern = /(?:^|[\s(])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:#(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+))(?![A-Za-z0-9/])/gi;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const refRepo = match[2] || match[4];
    const refNumber = Number(match[1] || match[3] || match[5]);
    if (refNumber === number && (!refRepo || refRepo.toLowerCase() === repo?.toLowerCase())) return true;
  }
  return false;
}

function completionCommit(commits, number, issue, repo) {
  const created = time(issue?.createdAt);
  if (created == null) return null;
  return (commits || []).find((commit) => {
    const authored = time(commit.authoredAt);
    if (authored == null || authored <= created) return false;
    const subject = commit.parents > 1 || /^Merge\b/i.test(commit.subject) ? '' : commit.subject;
    return closesIssue(subject, number, repo) || closesIssue(commit.body, number, repo)
      || new RegExp(`^Task:[ \\t]+${number}[ \\t]*$`, 'mi').test(commit.body || '');
  }) || null;
}

function mentionedCommit(commits, number) {
  if (number == null) return null;
  const pattern = new RegExp(`(?<![0-9])${number}(?![0-9])`);
  return (commits || []).find((commit) => pattern.test(`${commit.subject}\n${commit.body || ''}`)) || null;
}

function issueBelongsToRepo(task, repo) {
  if (!task.url) return true;
  try {
    const url = new URL(task.url);
    const match = /^\/([^/]+\/[^/]+)\/issues\/[0-9]+\/?$/.exec(url.pathname);
    return url.hostname === 'github.com' && Boolean(match) && Boolean(repo) && match[1].toLowerCase() === repo.toLowerCase();
  } catch { return false; }
}

// Change data.tasks in place. facts comes from readSyncFacts(); GitHub completion overrides the service overlay.
// Returns the changed cards as [{ id, from, to, commit? }]. A commit fact includes the short id and subject.
export function syncStatuses(data, { workers = [], facts = {}, now = Date.now(), log = () => {} } = {}) {
  if (!Array.isArray(data?.tasks)) return [];
  const computed = applyBoardFacts(overlayTasks(data.tasks, workers), workers, facts, { now });
  const changed = [];
  data.tasks.forEach((task, index) => {
    const result = computed[index];
    if (!task || typeof task !== 'object') return;
    const from = task.status || 'todo';
    let to = statusOf(result?.computedState);
    let match = result?.source?.kind === 'commit'
      ? facts.commits?.find((commit) => commit.short === result.source.ref)
      : null;
    const number = issueNumber(task);
    // Only a task with an issue number has a tracker entry. A task without one keeps the computed state.
    if (number != null) {
      const issue = facts.issues instanceof Map && issueBelongsToRepo(task, facts.githubRepo) ? facts.issues.get(number) : null;
      match = completionCommit(facts.commits, number, issue, facts.githubRepo);
      const ignored = match || mentionedCommit(facts.commits, number);
      const evidence = ignored ? ` (${ignored.short})` : '';
      if (!issue) {
        log(`sync: ${task.id} kept unchanged: ${facts.githubError || 'GitHub issue unavailable'}${evidence}`);
        return;
      }
      if (issue.state === 'open' || (issue.state === 'closed' && ['not_planned', 'reopened'].includes(issue.stateReason))) {
        to = from === 'doing' || workers.some((worker) => String(worker.taskId) === String(task.id) && worker.phase === 'live') ? 'doing' : 'todo';
        log(`sync: ${task.id} kept open: ${issue.state === 'open' ? 'GitHub open' : 'GitHub issue is not completed'}${evidence}`);
        match = null;
      } else if (issue.state === 'closed' && issue.stateReason === 'completed') {
        to = 'done';
      } else {
        log(`sync: ${task.id} kept unchanged: GitHub completion reason unavailable${evidence}`);
        return;
      }
    } else if (result?.diverges !== true) return;
    if (to === 'done' && task.partlyDone === true) {
      log(`sync: ${task.id} kept open: partly done${match ? ` (${match.short})` : ''}`);
      return;
    }
    if (to === from) return;
    task.status = to;
    changed.push({
      id: String(task.id), from, to,
      ...(match ? { commit: { short: match.short, subject: match.subject } } : {}),
    });
  });
  return changed;
}
