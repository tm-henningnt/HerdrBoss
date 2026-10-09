import { run } from './collect.js';
import { DATA_DIR } from './config.js';
import { appendMessage, readMessages, updateMessage, isMailboxItem } from './messages.js';
import { localFactory, readRegister } from './project-register.js';

const HOUR = 60 * 60 * 1000;
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

async function runGh(args) {
  try {
    return { status: 0, stdout: await run('gh', args, { timeout: 15000 }), stderr: '' };
  } catch (error) {
    return { status: 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || '') };
  }
}

function pendingProposal(records, slug) {
  return records.some((record) => isMailboxItem(record)
    && record.triage?.type === 'project-open'
    && record.triage.slug === slug
    && !record.closedAt);
}

function deniedRecently(records, slug, now) {
  return records.some((record) => record.triage?.type === 'project-open'
    && record.triage.slug === slug
    && record.triage.decision === 'deny'
    && Date.parse(record.triage.suppressedUntil) > now);
}

function authItemPending(records) {
  return records.some((record) => isMailboxItem(record)
    && record.triage?.type === 'github-auth'
    && !record.closedAt);
}

function issueRows(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (!Array.isArray(value)) return [];
    return value.filter((issue) => Number.isSafeInteger(issue?.number)
      && typeof issue.createdAt === 'string'
      && Number.isFinite(Date.parse(issue.createdAt)));
  } catch {
    return [];
  }
}

function appendAuthItem(now, dir) {
  return appendMessage({
    thread: 'boss', from: 'boss', to: 'owner', kind: 'report', title: 'Connect GitHub for project triage',
    text: 'Herdr Boss could not read GitHub issues. Run `gh auth login`, then answer this Mailbox item to retry project triage.',
    action: 'answer', replyTo: null, status: 'new',
    triage: { type: 'github-auth' },
  }, { dir, now });
}

function issueListArgs(repo, label) {
  return [
    'issue', 'list', '--repo', repo, '--label', label, '--state', 'open',
    '--sort', 'created', '--order', 'asc', '--json', 'number,title,createdAt', '--limit', '100',
  ];
}

function proposalText(project, count) {
  const quantity = count === 100 ? '100 or more ready issues' : `${count} ready ${count === 1 ? 'issue' : 'issues'}`;
  return `Open project ${project.slug}? ${quantity}.`;
}

function readyProjects(register, factory) {
  return register.projects.filter((project) => project.factory === factory
    && project.state === 'parked'
    && project.issueSource?.repo
    && project.issueSource.repo.trim());
}

function withinCap(register, cap, capCountsPinned) {
  const count = register.projects.filter((project) => ['open', 'parking'].includes(project.state)
    && (capCountsPinned || !project.pinned)).length;
  return count < cap;
}

function sortCandidates(candidates) {
  return candidates.sort((left, right) => PRIORITY_ORDER[left.project.priority] - PRIORITY_ORDER[right.project.priority]
    || left.oldestAt - right.oldestAt
    || left.project.slug.localeCompare(right.project.slug));
}

export function createProjectRegisterTriage({
  dataDir = DATA_DIR,
  now = Date.now,
  runGh: runGhCommand = runGh,
  runLifecycle = async () => 1,
  readMessages: readMessagesFn = readMessages,
  appendMessage: appendMessageFn = appendMessage,
  localFactory: localFactoryFn = localFactory,
  readRegister: readRegisterFn = readRegister,
} = {}) {
  return {
    async poll({ settings = {}, cap = 3, capCountsPinned = false, factory = localFactoryFn(dataDir) } = {}) {
      if (settings.enabled !== true) return { created: 0, checked: 0, skipped: 'disabled' };
      const label = typeof settings.label === 'string' && settings.label.trim() ? settings.label.trim() : 'ready-for-agent';
      const at = now();
      const register = readRegisterFn(dataDir);
      if (!withinCap(register, cap, capCountsPinned)) return { created: 0, checked: 0, skipped: 'cap' };
      const records = readMessagesFn({ dir: dataDir });
      if (authItemPending(records)) return { created: 0, checked: 0, skipped: 'auth-waiting' };
      const candidates = [];
      let checked = 0;
      for (const project of readyProjects(register, factory)) {
        if (pendingProposal(records, project.slug) || deniedRecently(records, project.slug, at)) continue;
        const projectLabel = typeof project.issueSource.label === 'string' && project.issueSource.label.trim()
          ? project.issueSource.label.trim()
          : label;
        const result = await runGhCommand(issueListArgs(project.issueSource.repo, projectLabel));
        checked += 1;
        if (result?.status !== 0) {
          if (/\b(authentication|not logged in|no authentication|gh auth login)\b/i.test(String(result?.stderr || ''))
            && !authItemPending(records)) {
            appendAuthItem(at, dataDir);
            return { created: 0, checked, skipped: 'auth-required' };
          }
          return { created: 0, checked, skipped: 'gh-error' };
        }
        const issues = issueRows(result.stdout);
        if (issues.length) {
          candidates.push({
            project,
            readyCount: issues.length,
            oldestAt: Math.min(...issues.map((issue) => Date.parse(issue.createdAt))),
          });
        }
      }
      if (!candidates.length) return { created: 0, checked };
      const [selected] = sortCandidates(candidates);
      if (selected.project.autoOpen === 'on') {
        let result;
        try { result = await runLifecycle('open', [selected.project.slug, '--start']); }
        catch { return { created: 0, checked, skipped: 'open-failed' }; }
        return result === 0
          ? { created: 0, checked, opened: selected.project.slug }
          : { created: 0, checked, skipped: 'open-failed' };
      }
      const message = appendMessageFn({
        thread: 'boss', from: 'boss', to: 'owner', kind: 'report', action: 'approve',
        title: proposalText(selected.project, selected.readyCount),
        text: proposalText(selected.project, selected.readyCount),
        replyTo: null, status: 'new',
        triage: { type: 'project-open', slug: selected.project.slug, readyCount: selected.readyCount },
      }, { dir: dataDir, now: at });
      return { created: 1, checked, itemId: message.id, slug: selected.project.slug };
    },
  };
}

export async function decideProjectRegisterTriage({
  dataDir = DATA_DIR,
  itemId,
  decision,
  now = Date.now,
  runLifecycle = async () => 1,
  readMessages: readMessagesFn = readMessages,
  updateMessage: updateMessageFn = updateMessage,
  readRegister: readRegisterFn = readRegister,
} = {}) {
  if (decision !== 'accept' && decision !== 'deny') return { status: 400, error: 'Choose Accept or Deny.' };
  if (typeof itemId !== 'string' || !itemId) return { status: 400, error: 'Choose a triage proposal.' };
  const item = readMessagesFn({ dir: dataDir }).find((record) => record.id === itemId && isMailboxItem(record));
  if (!item || item.triage?.type !== 'project-open' || typeof item.triage.slug !== 'string') {
    return { status: 404, error: 'The project triage proposal was not found.' };
  }
  if (item.closedAt) return { status: 409, error: 'This project triage proposal is already closed.' };
  const at = now();
  const project = readRegisterFn(dataDir).projects.find((record) => record.slug === item.triage.slug);
  if (!project) return { status: 409, error: 'The project is no longer in the register.' };
  if (decision === 'accept') {
    if (project.state !== 'parked') return { status: 409, error: 'The project is no longer parked.' };
    let result;
    try { result = await runLifecycle('open', [project.slug, '--start']); }
    catch { return { status: 409, error: 'The project could not be opened. The proposal stays open.' }; }
    if (result !== 0) return { status: 409, error: 'The project could not be opened. The proposal stays open.' };
  }
  const closedAt = new Date(at).toISOString();
  updateMessageFn(item.id, {
    closedAt,
    readAt: item.readAt || closedAt,
    closedBy: 'owner',
    triage: {
      ...item.triage,
      decision,
      ...(decision === 'deny' ? { suppressedUntil: new Date(at + 24 * HOUR).toISOString() } : {}),
    },
  }, { dir: dataDir, now: at });
  return { status: 200, decision, slug: project.slug };
}

export { issueListArgs };
