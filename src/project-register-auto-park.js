import { DATA_DIR } from './config.js';
import { isMailAnswer, isMailboxItem, mailboxAction, messagesById, readMessages } from './messages.js';
import { appendAudit, readRegister } from './project-register.js';

const PARK_INTERVAL_MS = 10 * 60 * 1000;
const OWNER_ACTIONS = new Set(['answer', 'approve', 'decide']);
const PARK_CHECKS = new Set(['workers', 'prompt', 'git', 'locks', 'status', 'memory', 'owner']);
const WORKER_BRANCH_PHASES = new Set(['review', 'finished', 'finished-uncollected']);

function timeOf(record) {
  const times = [record.lastActivityAt, record.lastOpenedAt, record.createdAt].map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function pendingMailboxSlug(slug, messages, byId) {
  return messages.some((item) => item.thread === slug
    && item.from !== 'owner'
    && isMailboxItem(item)
    && OWNER_ACTIONS.has(mailboxAction(item))
    && !item.closedAt && !item.closedBy && !item.dismissed
    && !messages.some((answer) => isMailAnswer(answer, byId) && answer.replyTo === item.id));
}

function failedParkCheck(lines) {
  for (const line of lines) {
    const stopped = /^\s*Park stopped at ([a-z-]+)\./i.exec(line);
    if (stopped) return { failedCheck: stopped[1], reason: stopped[1] };
    const match = /^\s*([a-z-]+)\s+blocked:\s*(.*)$/i.exec(line);
    if (match && PARK_CHECKS.has(match[1])) return { failedCheck: match[1], reason: match[2] || 'The park check did not pass.' };
  }
  return { failedCheck: 'park', reason: 'A park check could not confirm that the project is safe to park.' };
}

function audit(slug, dataDir, now, result, failedCheck, reason) {
  appendAudit(slug, 'auto-park', dataDir, {
    at: new Date(now).toISOString(), by: 'engine', result, failedCheck, reason,
  });
}

export async function runProjectRegisterAutoPark({
  dataDir = DATA_DIR,
  hours = 24,
  now = Date.now(),
  workersByProject = {},
  runLifecycle = async () => 1,
  log = () => {},
} = {}) {
  if (!Number.isSafeInteger(hours) || hours <= 0 || typeof runLifecycle !== 'function') return { considered: 0, parked: 0, skipped: 0 };
  const cutoff = now - hours * 60 * 60 * 1000;
  const messages = readMessages({ dir: dataDir });
  const byId = messagesById(messages);
  let considered = 0;
  let parked = 0;
  let skipped = 0;

  for (const record of readRegister(dataDir).projects) {
    if (record.state === 'parking') {
      considered += 1;
      const reason = 'Project is already parking.';
      audit(record.slug, dataDir, now, 'skipped', 'state', reason);
      log(`Auto-park skipped ${record.slug}: ${reason}`, record.slug);
      skipped += 1;
      continue;
    }
    if (record.state !== 'open' || record.pinned) continue;
    const activityAt = timeOf(record);
    if (activityAt === null || activityAt > cutoff) continue;
    considered += 1;

    const workers = Array.isArray(workersByProject[record.slug]) ? workersByProject[record.slug] : [];
    const reason = workers.some((worker) => worker.phase === 'live')
      ? { failedCheck: 'workers', reason: 'A project worker is still running.' }
      : workers.some((worker) => worker.branch && WORKER_BRANCH_PHASES.has(worker.phase))
        ? { failedCheck: 'worker-branch', reason: 'A worker branch is not merged.' }
        : pendingMailboxSlug(record.slug, messages, byId)
          ? { failedCheck: 'mailbox', reason: 'A project Mailbox item is waiting for the Owner.' }
          : null;

    if (reason) {
      audit(record.slug, dataDir, now, 'skipped', reason.failedCheck, reason.reason);
      log(`Auto-park skipped ${record.slug}: ${reason.reason}`, record.slug);
      skipped += 1;
      continue;
    }

    const dryRunLines = [];
    let dryRunResult;
    try {
      dryRunResult = await runLifecycle('park', [record.slug, '--dry-run'], { log: (line) => dryRunLines.push(String(line)), suppressAudit: true });
    } catch {
      dryRunResult = 1;
      dryRunLines.push('park blocked: the park checks could not run.');
    }
    for (const line of dryRunLines) log(line, record.slug);
    if (dryRunResult !== 0) {
      const failed = failedParkCheck(dryRunLines);
      audit(record.slug, dataDir, now, 'skipped', failed.failedCheck, failed.reason);
      log(`Auto-park skipped ${record.slug}: ${failed.reason}`, record.slug);
      skipped += 1;
      continue;
    }

    const parkLines = [];
    let parkResult;
    try {
      parkResult = await runLifecycle('park', [record.slug], { log: (line) => parkLines.push(String(line)), suppressAudit: true });
    } catch {
      parkResult = 1;
      parkLines.push('park blocked: the park checks could not complete.');
    }
    for (const line of parkLines) log(line, record.slug);
    if (parkResult === 0) {
      audit(record.slug, dataDir, now, 'done', null, `No activity for ${hours} hours.`);
      log(`Auto-parked ${record.slug} after ${hours} hours without activity.`, record.slug);
      parked += 1;
    } else {
      const failed = failedParkCheck(parkLines);
      audit(record.slug, dataDir, now, 'skipped', failed.failedCheck, failed.reason);
      log(`Auto-park skipped ${record.slug}: ${failed.reason}`, record.slug);
      skipped += 1;
    }
  }

  return { considered, parked, skipped, intervalMs: PARK_INTERVAL_MS };
}

export function createProjectRegisterAutoPark(options = {}) {
  return { run: (overrides = {}) => runProjectRegisterAutoPark({ ...options, ...overrides }) };
}
