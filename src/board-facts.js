// Card state from facts. docs/board.md holds the design.
// The module reads git and the issue tracker read-only and never writes the status file of the orchestrator.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanGhEnv, originRepo } from './gh-labels.js';

const execFileAsync = promisify(execFile);
const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;

export const STUCK_MS = 3 * HOUR_MS;
export const GIT_LOG_LIMIT = 1000;
export const GIT_TIMEOUT_MS = 5000;
export const GH_TIMEOUT_MS = 15000;
export const GIT_INTERVAL_MS = MINUTE_MS;
export const ISSUE_INTERVAL_MS = 10 * MINUTE_MS;

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%cI', '%P', '%s', '%b'].join('%x1f') + '%x1e';
const ALNUM_BEFORE = '(?<![A-Za-z0-9])';
const ALNUM_AFTER = '(?![A-Za-z0-9])';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A pattern that finds the id as a whole token. An id of only digits needs a # in front.
export function idPattern(id) {
  const text = String(id ?? '').trim();
  if (!text) return null;
  const body = /^[0-9]+$/.test(text) ? `#${escapeRegex(text)}` : `#?${escapeRegex(text)}`;
  return new RegExp(`${ALNUM_BEFORE}${body}${ALNUM_AFTER}`, 'i');
}

// The explicit forms in a non-merge subject are a trailing parenthesized id, a closing keyword before the id, or
// a non-digit id as the subject prefix. The body accepts only closing keywords. A bare id never matches.
// The match ignores case.
export function explicitPattern(id) {
  const text = String(id ?? '').trim();
  if (!text) return null;
  const digits = /^[0-9]+$/.test(text);
  const token = escapeRegex(text);
  const hash = digits ? '#' : '#?';
  const forms = [
    `\\(${hash}${token}\\)\\s*$`,
    closingPatternSource(token, hash),
  ];
  if (!digits) forms.push(`^${hash}${token}\\s*:`);
  return new RegExp(forms.join('|'), 'i');
}

function closingPatternSource(token, hash) {
  return `${ALNUM_BEFORE}(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${hash}${token}${ALNUM_AFTER}`;
}

function closingPattern(id) {
  const text = String(id ?? '').trim();
  if (!text) return null;
  const hash = /^[0-9]+$/.test(text) ? '#' : '#?';
  return new RegExp(closingPatternSource(escapeRegex(text), hash), 'i');
}

// The merged branch name of a merge subject, or null when the subject is not a known merge form.
export function mergedBranchName(subject) {
  const text = String(subject ?? '');
  let match = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(text);
  if (match) return match[1];
  match = /^Merge pull request #\d+ from (\S+)/.exec(text);
  if (match) return match[1];
  match = /^Merge (?:branches|branch) (.+?)(?: into \S+)?$/.exec(text);
  return match ? match[1] : null;
}

// A merge matches its merged branch. Other commits use an explicit subject form or a closing keyword in the body.
function matchesCommit(commit, term) {
  if (commit.parents > 1) {
    const branch = mergedBranchName(commit.subject) ?? commit.subject.replace(/ into \S+$/, '');
    return term.merge?.test(branch) ?? false;
  }
  return Boolean(term.plain?.test(commit.subject) || term.body?.test(commit.body ?? ''));
}

// Run git without a shell and without blocking the event loop. The promise rejects on a timeout or an error.
async function defaultGit(repo, args, timeout) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// A branch name that git could read as an option is not a branch.
export const validBranch = (branch) => typeof branch === 'string' && branch.length > 0 && !branch.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(branch);

// The newest commits of the base branch, newest first, or null when git cannot read the repository or the branch.
// The command is read-only and runs without a shell. --end-of-options keeps the branch from becoming an option.
export async function readCommits(repo, { branch = 'main', limit = GIT_LOG_LIMIT, timeout = GIT_TIMEOUT_MS, git = defaultGit } = {}) {
  if (!repo || typeof repo !== 'string' || !validBranch(branch)) return null;
  let out;
  try { out = await git(repo, ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, '--end-of-options', branch, '--'], timeout); } catch { return null; }
  const commits = [];
  for (const row of String(out).split(RECORD)) {
    const [id, short, at, parents, subject = '', ...body] = row.replace(/^\n/, '').split(FIELD);
    if (!id || !short) continue;
    commits.push({ id, short, at, parents: parents ? parents.split(' ').filter(Boolean).length : 0, subject, body: body.join(FIELD).replace(/\n+$/, '') });
  }
  return commits;
}

// The issues of the project repository as a Map of number to { state, closedAt }, or null when gh cannot answer.
// The call is read-only. It runs in the repository and uses the github.com origin as the explicit --repo.
export async function readIssues(repo, { timeout = GH_TIMEOUT_MS, run } = {}) {
  if (!repo || typeof repo !== 'string') return null;
  let slug;
  try { slug = originRepo(repo); } catch { return null; }
  const args = ['issue', 'list', `--repo=${slug}`, '--state', 'all', '--limit', '500', '--json', 'number,state,closedAt'];
  try {
    const stdout = run
      ? await run(args, { cwd: repo, timeout })
      : (await execFileAsync('gh', args, { cwd: repo, env: cleanGhEnv(process.env), encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) return null;
    return new Map(rows.filter((row) => Number.isInteger(row?.number)).map((row) => [row.number, { state: String(row.state).toLowerCase() === 'closed' ? 'closed' : 'open', closedAt: row.closedAt || null }]));
  } catch { return null; }
}

// The issue number of a card: the number in the issue URL, else the id when it is only digits.
export function issueNumber(task) {
  const match = /\/issues\/(\d+)(?:[/?#]|$)/.exec(String(task?.url ?? ''));
  if (match) return Number(match[1]);
  return /^[0-9]+$/.test(String(task?.id ?? '')) ? Number(task.id) : null;
}

const memo = new WeakMap();

// For each task id, the newest commit that names the task id, or a worker name or worker branch of that task.
// A merge commit names it through the merged branch name. Other commits use explicit subject or body forms.
// Returns a Map of task id to { id, short, at, subject, via }.
export function commitIndex(commits, tasks, workers = []) {
  const result = new Map();
  if (!Array.isArray(commits) || !commits.length) return result;
  const terms = new Map();
  for (const task of tasks || []) {
    if (task?.id == null) continue;
    const id = String(task.id);
    if (!terms.has(id)) terms.set(id, [{ via: id, merge: idPattern(id), plain: explicitPattern(id), body: closingPattern(id) }]);
  }
  for (const worker of workers) {
    const list = worker?.taskId != null ? terms.get(String(worker.taskId)) : null;
    if (!list) continue;
    for (const via of [worker.name, worker.branch]) if (via) list.push({ via: String(via), merge: idPattern(via), plain: explicitPattern(via), body: closingPattern(via) });
  }
  const key = [...terms].map(([id, list]) => `${id}:${list.map((term) => term.via).join(',')}`).join('|');
  let byKey = memo.get(commits);
  if (!byKey) memo.set(commits, byKey = new Map());
  if (byKey.has(key)) return byKey.get(key);
  for (const [id, list] of terms) {
    for (const [index, commit] of commits.entries()) {
      const hit = list.find((term) => matchesCommit(commit, term));
      if (hit) { result.set(id, { id: commit.id, short: commit.short, at: commit.at, subject: commit.subject, via: hit.via }); break; }
    }
  }
  byKey.set(key, result);
  return result;
}

const ms = (value) => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; };
const COMPARE = { blocked: 'todo', ready: 'todo', stuck: 'doing' };
const comparable = (state) => COMPARE[state] ?? state;

// Add computedState, publishedState, source, diverges, and stuck to each overlaid task.
// tasks come from overlayTasks(). facts is { commits: array|null, issues: Map|null }.
// The state field takes the computed result. A stuck card keeps the state doing.
export function applyBoardFacts(tasks, workers = [], facts = {}, { now = Date.now(), publishedAt = null } = {}) {
  const index = commitIndex(facts.commits, tasks, workers);
  const issues = facts.issues instanceof Map ? facts.issues : null;
  const publishedMs = ms(publishedAt);
  return (Array.isArray(tasks) ? tasks : []).map((task) => {
    if (!task || typeof task !== 'object' || task.id == null) return task;
    const id = String(task.id);
    const publishedState = task.publishedStatus ?? task.status ?? 'todo';
    const own = workers.filter((worker) => String(worker.taskId) === id);
    const liveWorker = own.some((worker) => worker.phase === 'live');
    const commit = index.get(id) || null;
    const commitMs = commit ? ms(commit.at) : null;
    const reworkStart = own.filter((worker) => worker.phase === 'live').map((worker) => ms(worker.startedAt)).filter((v) => v != null);
    const reworking = commitMs != null && reworkStart.some((start) => start > commitMs);
    const number = issueNumber(task);
    const issue = issues && number != null ? issues.get(number) : null;

    let state = task.state;
    let source = null;
    const workerName = /worker ([^\s)]+)/.exec(task.stateSource || '')?.[1] ?? null;
    if (commit && !reworking) {
      state = 'done';
      source = { kind: 'commit', ref: commit.short, at: commit.at };
    } else if (workerName && !(publishedState === 'blocked' && issue?.state === 'closed')) {
      if (publishedState === 'blocked') state = 'blocked';
      source = { kind: 'worker', ref: workerName, at: task.worker?.startedAt ?? null };
    } else if (issue?.state === 'closed' && publishedState !== 'done') {
      state = 'done';
      source = { kind: 'issue', ref: String(number), at: issue.closedAt };
    } else if (issue?.state === 'open' && publishedState === 'done') {
      state = liveWorker ? 'doing' : 'todo';
      source = { kind: 'issue', ref: String(number), at: null };
    }

    // The board column keeps ready and blocked for a todo card. Dependencies decide between them.
    const keepBlockedWorkerState = publishedState === 'blocked' && source?.kind === 'worker';
    let computedState = state === 'ready' || (state === 'blocked' && !keepBlockedWorkerState) ? 'todo' : state;
    let stuck = null;
    if (computedState === 'doing' && !liveWorker) {
      const times = [ms(task.updated), commitMs, ...own.flatMap((worker) => [worker.startedAt, worker.collectedAt, worker.finishedAt].map(ms))].filter((v) => v != null);
      const reference = times.length ? Math.max(...times) : publishedMs;
      if (reference != null && now - reference >= STUCK_MS) {
        const ageMin = Math.floor((now - reference) / MINUTE_MS);
        stuck = { reason: `no live worker and no commit for ${Math.floor(ageMin / 60)} hours`, ageMin };
        computedState = 'stuck';
      }
    }
    const diverges = source != null && comparable(computedState) !== comparable(publishedState);
    return { ...task, state, computedState, publishedState, source, diverges, stuck };
  });
}

// Counts of diverged and stuck cards and the ids of the diverged cards.
export function boardCounts(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const diverged = list.filter((task) => task?.diverges === true);
  return {
    boardDiverged: diverged.length,
    boardDivergedIds: diverged.map((task) => String(task.id)),
    boardStuck: list.filter((task) => task?.computedState === 'stuck').length,
  };
}

// The cache of the facts of every registered project. Git is read at most every GIT_INTERVAL_MS and issues at most
// every ISSUE_INTERVAL_MS. Both reads are asynchronous, so no read blocks a tick or a request. A read that fails
// keeps no fact. get() never waits.
export class BoardFactsCache {
  constructor({ git = defaultGit, issueRun, gitInterval = GIT_INTERVAL_MS, issueInterval = ISSUE_INTERVAL_MS } = {}) {
    this.git = git;
    this.issueRun = issueRun;
    this.gitInterval = gitInterval;
    this.issueInterval = issueInterval;
    this.entries = new Map();
  }

  // Start the reads that are due for one project. Both reads run in the background. repo may be null: the project
  // then has no facts. The call returns at once.
  refresh(slug, repo, { branch = 'main', now = Date.now() } = {}) {
    const entry = this.entries.get(slug) || { commits: null, issues: null, gitAt: -Infinity, issuesAt: -Infinity, repo: null, loading: new Set() };
    this.entries.set(slug, entry);
    if (entry.repo !== repo) Object.assign(entry, { repo, commits: null, issues: null, gitAt: -Infinity, issuesAt: -Infinity });
    if (!repo) return entry;
    const start = (key, at, interval, read, store) => {
      if (now - entry[at] < interval || entry.loading.has(key)) return;
      entry[at] = now;
      const task = read().then((value) => { if (entry.repo === repo) entry[store] = value; }).catch(() => {}).finally(() => entry.loading.delete(key));
      entry.loading.add(key);
      entry[`${key}Task`] = task;
    };
    start('git', 'gitAt', this.gitInterval, () => readCommits(repo, { branch, git: this.git }), 'commits');
    start('issues', 'issuesAt', this.issueInterval, () => readIssues(repo, { run: this.issueRun }), 'issues');
    return entry;
  }

  get(slug) {
    const entry = this.entries.get(slug);
    return entry ? { commits: entry.commits, issues: entry.issues } : { commits: null, issues: null };
  }

  // Resolve when every running read ends. Tests use this.
  async idle() {
    await Promise.all([...this.entries.values()].flatMap((entry) => [entry.gitTask, entry.issuesTask].filter(Boolean)));
  }
}
