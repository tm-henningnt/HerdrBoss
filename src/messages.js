import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';

// Owner messages, agent replies, and Boss reports. One JSON record per line in messages.jsonl.
export const RETENTION_MS = 30 * 86400 * 1000;
export const THREAD_LIMIT = 200;
export const OWNER_TEXT_MAX = 2000;
export const SAY_TEXT_MAX = 4000;
export const REPORT_MAX_BYTES = 64 * 1024;
export const TITLE_MAX = 200;
export const SEND_LIMIT_PER_MINUTE = 10;
// One first attempt and 3 retries on later ticks.
export const MAX_DELIVERY_ATTEMPTS = 4;
export const NUDGES = ['Continue.', 'Use your free worker slots.', 'Pause after the current task.'];
export const STATUS_REQUEST_TEXT = 'Send a short status report with herdr-boss say, and publish your status file.';
export const ACTIONS = ['answer', 'approve', 'decide', 'read'];
const NEEDS_YOU_ACTIONS = new Set(['answer', 'approve', 'decide']);
export const READ_IDS_MAX = 200;
export const CHOICES_MAX = 10;
export const CHOICE_TEXT_MAX = 200;
const OWNER_KINDS = ['message', 'nudge', 'status-request'];
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;

export const messagesFile = (dir = DATA_DIR) => path.join(dir, 'messages.jsonl');
export const validThread = (thread) => thread === 'boss' || (typeof thread === 'string' && SLUG.test(thread));

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// The service, `say`, and `mail post` write the same file. A short lock file keeps a rewrite from losing an append.
function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = `${messagesFile(dir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`The message store is locked (${lock}). Try again.`);
      pause(20);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

export function readMessages({ dir = DATA_DIR } = {}) {
  let text;
  try { text = fs.readFileSync(messagesFile(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const record = JSON.parse(line); if (record && typeof record.id === 'string') records.push(record); } catch {}
  }
  return records;
}

const fresh = (records, now) => records.filter((record) => !(Date.parse(record.at) < now - RETENTION_MS));

function rewrite(dir, records) {
  const file = messagesFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function newId(now) {
  return `m-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

// Append with one write. A record older than 30 days makes the append a rewrite that deletes it.
export function appendMessage(fields, { dir = DATA_DIR, now = Date.now() } = {}) {
  const record = {
    id: newId(now), at: new Date(now).toISOString(), thread: null, from: null, to: null, kind: null, text: '',
    action: null, replyTo: null, status: null, sentAt: null, error: null, relayedAt: null, relayedBy: null, ...fields,
  };
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const kept = fresh(records, now);
    if (kept.length !== records.length) rewrite(dir, [...kept, record]);
    else {
      fs.appendFileSync(messagesFile(dir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fs.chmodSync(messagesFile(dir), 0o600);
    }
    return record;
  });
}

export function updateMessage(id, patch, { dir = DATA_DIR, now = Date.now() } = {}) {
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    records[index] = { ...records[index], ...patch, id };
    const updated = records[index];
    rewrite(dir, fresh(records, now));
    return updated;
  });
}

export function listThread(thread, { dir = DATA_DIR, limit = THREAD_LIMIT } = {}) {
  return readMessages({ dir }).filter((record) => record.thread === thread).slice(-limit);
}

// ---------- Owner sends ----------

// Returns { status, error } for a refused send, or { fields } for a record to queue.
export function validateOwnerSend(body, { knownThreads, records = [], now = Date.now() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with thread, kind, and text.' };
  const { thread, kind } = body;
  if (!validThread(thread)) return { status: 400, error: 'The thread must be boss or a project slug.' };
  if (!OWNER_KINDS.includes(kind)) return { status: 400, error: `The kind must be one of ${OWNER_KINDS.join(', ')}.` };
  let text;
  if (kind === 'message') {
    text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 1 || text.length > OWNER_TEXT_MAX) return { status: 400, error: `The message text must be 1 to ${OWNER_TEXT_MAX} characters.` };
  } else if (kind === 'nudge') {
    if (!NUDGES.includes(body.text)) return { status: 400, error: `A nudge must be one of: ${NUDGES.join(' ')}` };
    text = body.text;
  } else text = STATUS_REQUEST_TEXT;
  if (!knownThreads.has(thread)) return { status: 404, error: `No open project uses the thread ${thread}.` };
  const replyTo = body.replyTo ?? null;
  if (replyTo !== null) {
    if (typeof replyTo !== 'string') return { status: 400, error: 'replyTo must be a mailbox item ID.' };
    if (kind !== 'message') return { status: 400, error: 'Only a message can answer a mailbox item.' };
    const item = records.find((record) => record.id === replyTo && record.thread === thread && isMailboxItem(record));
    if (!item) return { status: 404, error: `No mailbox item ${replyTo} is in the ${thread} thread.` };
    if (item.closedAt) return { status: 409, error: 'This mailbox item is closed. Send a new message instead.' };
  }
  const recent = records.filter((record) => record.from === 'owner' && Date.parse(record.at) > now - 60000).length;
  if (recent >= SEND_LIMIT_PER_MINUTE) return { status: 429, error: `Herdr Boss accepts at most ${SEND_LIMIT_PER_MINUTE} Owner messages a minute. Wait, then send again.` };
  return { fields: { thread, from: 'owner', to: thread === 'boss' ? 'boss' : 'orch', kind, text, action: null, replyTo, status: 'queued', attempts: 0 } };
}

export function ownerPromptText(record) {
  const answer = record.replyTo ? `Answer to ${record.replyTo}: ` : '';
  return `[owner] ${answer}${record.text} (Reply with: herdr-boss say --reply-to ${record.id} "<answer>")`;
}

// ---------- Owner mailbox ----------

// Every agent reply and Boss report to the Owner is a mailbox item. An item without a known action is information.
export const isMailboxItem = (record) => !!record && record.to === 'owner' && (record.kind === 'reply' || record.kind === 'report');
export const mailboxAction = (record) => (ACTIONS.includes(record?.action) ? record.action : 'read');
const needsOwnerAction = (record) => NEEDS_YOU_ACTIONS.has(mailboxAction(record));

// The choices are the Markdown list items under a heading named Choices, up to the first other line.
export function parseChoices(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+choices\s*:?\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const choices = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line) || /^\s*(?:[-*+]|\d+[.)])\s*$/.exec(line);
    if (!item) break;
    const choice = String(item[1] ?? '').trim().slice(0, CHOICE_TEXT_MAX);
    if (choice && !choices.includes(choice)) choices.push(choice);
    if (choices.length >= CHOICES_MAX) break;
  }
  return choices;
}

export function mailboxCounts(records) {
  const items = records.filter(isMailboxItem);
  const needsYou = items.filter((item) => needsOwnerAction(item) && !item.closedAt);
  const needsYouUnread = needsYou.filter((item) => !item.readAt).length;
  const updates = items.filter((item) => !needsOwnerAction(item) && item.closedBy !== 'boss').length;
  return { needsYou: needsYou.length, needsYouUnread, updates, unread: needsYouUnread, open: needsYou.length };
}

function replyTimes(records) {
  const times = new Map();
  for (const record of records) {
    if (record.kind === 'reply' && record.to === 'owner' && record.replyTo && !times.has(record.replyTo)) times.set(record.replyTo, record.at);
  }
  return times;
}

function deliveryView(record, replies) {
  return {
    id: record.id,
    at: record.at,
    text: record.text,
    status: record.status,
    sentAt: record.sentAt ?? null,
    error: record.error ?? null,
    relayedAt: record.relayedAt ?? null,
    relayedBy: record.relayedBy ?? null,
    repliedAt: replies.get(record.id) ?? null,
  };
}

// Add reply timestamps to Owner records for thread and mailbox clients.
export function messagesWithReplyState(records, allRecords = records) {
  const replies = replyTimes(allRecords);
  return records.map((record) => record.from === 'owner' ? { ...record, repliedAt: replies.get(record.id) ?? null } : record);
}

// Needs-you items, updates, and closed items, newest first. A closed item carries the Owner send or Boss note that closed it.
export function mailboxView(records) {
  const answers = new Map();
  const owners = new Map();
  const replies = replyTimes(records);
  for (const record of records) {
    if (record.from === 'owner') owners.set(record.id, record);
    if (record.from === 'owner' && record.replyTo) answers.set(record.replyTo, record);
  }
  const items = records.filter(isMailboxItem).reverse().map((record) => {
    const answer = answers.get(record.id);
    return {
      ...record,
      action: mailboxAction(record),
      choices: parseChoices(record.text),
      ownerMessage: owners.has(record.replyTo) ? deliveryView(owners.get(record.replyTo), replies) : null,
      answer: answer ? deliveryView(answer, replies) : null,
    };
  });
  return {
    needsYou: items.filter((item) => needsOwnerAction(item) && !item.closedAt),
    updates: items.filter((item) => !needsOwnerAction(item) && item.closedBy !== 'boss'),
    done: items.filter((item) => (needsOwnerAction(item) && item.closedAt) || item.closedBy === 'boss'),
  };
}

export function closeMailboxItem(id, { dir = DATA_DIR, now = Date.now() } = {}) {
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const item = records.find((record) => record.id === id && isMailboxItem(record));
    if (!item) return null;
    const at = new Date(now).toISOString();
    item.closedAt ||= at;
    item.readAt ||= at;
    rewrite(dir, fresh(records, now));
    return item;
  });
}

// Record that the Boss handled one or more open Owner mailbox items without sending a reply.
export function closeMailboxItems(ids, note, { by, dir = DATA_DIR, now = Date.now() } = {}) {
  if (by !== 'boss') return { status: 403, error: 'Only the Boss can close Owner mailbox items.' };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `Give 1 to ${READ_IDS_MAX} mailbox item IDs to close.` };
  }
  if (new Set(ids).size !== ids.length) return { status: 400, error: 'Give each mailbox item ID only once.' };
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < 1 || text.length > 500) return { status: 400, error: 'The close note must be 1 to 500 characters.' };
  try { refuseSecret(text, 'note'); }
  catch (error) { return { status: 400, error: error.message }; }
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { status: 404, error: `No open mailbox item has the ID ${missing}.` };
    const closed = items.find((item) => item.closedAt);
    if (closed) return { status: 409, error: `Mailbox item ${closed.id} is already closed.` };
    const at = new Date(now).toISOString();
    for (const item of items) {
      item.closedAt = at;
      item.readAt ||= at;
      item.closedBy = 'boss';
      item.closeNote = text;
    }
    rewrite(dir, fresh(records, now));
    return { ok: true, closed: items.length };
  });
}

// Sets readAt on each item once. `close: true` also closes items whose action is read.
// Returns { status, error } for a refused request, or { ok, updated }.
export function markMailboxRead(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids, close = false } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  if (typeof close !== 'boolean') return { status: 400, error: 'close must be true or false.' };
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { status: 404, error: `No mailbox item has the ID ${missing}.` };
    if (close && items.some((item) => mailboxAction(item) !== 'read')) {
      return { status: 409, error: 'Only an item with the action read closes on Mark read. Answer the other items.' };
    }
    const at = new Date(now).toISOString();
    let updated = 0;
    for (const item of items) {
      let changed = false;
      if (!item.readAt) { item.readAt = at; changed = true; }
      if (close && !item.closedAt) { item.closedAt = at; changed = true; }
      if (changed) updated += 1;
    }
    rewrite(dir, fresh(records, now));
    return { ok: true, updated };
  });
}

// Dismiss open Needs-you items without sending an answer to an agent.
export function dismissMailboxItems(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { status: 404, error: `No mailbox item has the ID ${missing}.` };
    if (items.some((item) => !needsOwnerAction(item) || item.closedAt)) {
      return { status: 409, error: 'Only open Needs-you items can be dismissed.' };
    }
    const at = new Date(now).toISOString();
    for (const item of items) {
      item.readAt ||= at;
      item.closedAt ||= at;
      item.dismissed = true;
    }
    rewrite(dir, fresh(records, now));
    return { ok: true, dismissed: items.length };
  });
}

// Mark queued Owner messages as relayed. The CLI verifies that the caller is the Boss pane.
export function relayOwnerMessages(ids, { by, dir = DATA_DIR, now = Date.now() } = {}) {
  if (by !== 'boss') return { status: 403, error: 'Only the Boss can relay Owner messages.' };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `Give 1 to ${READ_IDS_MAX} Owner message IDs to relay.` };
  }
  return withLock(dir, () => {
    const records = readMessages({ dir });
    const items = ids.map((id) => records.find((record) => record.id === id && record.from === 'owner'));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { status: 404, error: `No queued Owner message has the ID ${missing}.` };
    if (items.some((item) => item.status !== 'queued')) return { status: 409, error: 'Only queued Owner messages can be relayed.' };
    const relayedAt = new Date(now).toISOString();
    for (const item of items) {
      item.status = 'relayed';
      item.relayedAt = relayedAt;
      item.relayedBy = 'boss';
    }
    rewrite(dir, fresh(records, now));
    return { ok: true, relayed: items.length };
  });
}

// ---------- Delivery ----------

function targetPane(thread, panes, projects) {
  if (thread === 'boss') return panes.find((pane) => pane.label === 'boss' && pane.agent) || null;
  const id = projects?.[thread]?.orch?.pane;
  return (id && panes.find((pane) => pane.id === id && pane.label === 'orch' && pane.agent)) || null;
}

// A command error can repeat the prompt text. Keep one short line and remove the text.
function shortError(error, record) {
  const stderr = String(error?.stderr || '').trim().split('\n')[0];
  const message = String(error?.message || '');
  let text = stderr || (message && !message.startsWith('Command failed') ? message.split('\n')[0] : 'Herdr could not send the prompt.');
  for (const part of [ownerPromptText(record), record.text]) if (part) text = text.split(part).join('[message]');
  return text.slice(0, 160);
}

// Sends queued Owner messages to boss and orch panes that are not blocked. `busy` holds panes that got a prompt in this tick.
export async function deliverQueued({ panes = [], projects = {}, prompt, log = () => {}, dir = DATA_DIR, now = Date.now(), busy = new Set() }) {
  const used = new Set(busy);
  const pending = readMessages({ dir }).filter((record) => record.from === 'owner'
    && (record.status === 'queued' || (record.status === 'failed' && (record.attempts || 0) < MAX_DELIVERY_ATTEMPTS)));
  for (const record of pending) {
    const pane = targetPane(record.thread, panes, projects);
    if (!pane || used.has(pane.id) || !['idle', 'done', 'working'].includes(pane.status)) continue;
    used.add(pane.id);
    const attempts = (record.attempts || 0) + 1;
    const meta = { id: record.id, thread: record.thread, kind: record.kind, pane: pane.id };
    try {
      await prompt(pane.id, ownerPromptText(record));
      updateMessage(record.id, { status: 'sent', sentAt: new Date(now).toISOString(), error: null, attempts }, { dir, now });
      log('message', `Delivered Owner ${record.kind} ${record.id} to ${record.thread}`, meta);
    } catch (error) {
      const reason = shortError(error, record);
      updateMessage(record.id, { status: 'failed', error: reason, attempts }, { dir, now });
      const retry = attempts < MAX_DELIVERY_ATTEMPTS ? 'will retry' : 'no more retries';
      log('message', `Owner ${record.kind} ${record.id} to ${record.thread} failed (attempt ${attempts}, ${retry}): ${reason}`, { ...meta, failed: true });
    }
  }
}

// ---------- Agent replies and reports ----------

// The same patterns as the handover context redaction in handoff.js.
function redactSecrets(value) {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{3,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,}|AIza[a-zA-Z0-9_-]{12,}|xox[baprs]-[a-zA-Z0-9-]{8,})\b/g, '[REDACTED]')
    .replace(/("(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)"\s*[:=]\s*")(?:(?:\\.)|[^"\\\r\n])*"/gi, '$1[REDACTED]"')
    .replace(/\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;]+)/gi, '$1[REDACTED]');
}

function refuseSecret(text, what) {
  if (redactSecrets(text) !== text) throw new Error(`The ${what} looks like it holds a secret: a token, a key, or a password. Herdr Boss did not store it. Remove the secret and try again.`);
}

// The same checks as `worker allow`: HERDR_ENV, the pane ID and workspace from Herdr, and an exact label.
export function verifyMessageCaller(env, herdr, command) {
  if (env.HERDR_ENV !== '1') throw new Error(`Run herdr-boss ${command} from a Herdr-managed pane (HERDR_ENV=1).`);
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!paneId) throw new Error('Cannot verify the caller pane: HERDR_PANE_ID is required.');
  if (!workspaceId) throw new Error('Cannot verify the caller pane: HERDR_WORKSPACE_ID is required.');
  let response;
  try { response = herdr(['pane', 'get', paneId]); }
  catch (error) { throw new Error(`Cannot verify the caller pane: Herdr could not read pane ${paneId}: ${error.message}`); }
  const pane = response?.pane ?? response ?? {};
  const returnedId = pane.pane_id ?? pane.paneId ?? pane.id ?? null;
  if (returnedId !== paneId) throw new Error(`Cannot verify the caller pane: the returned pane ID (${returnedId ?? '(missing)'}) differs from HERDR_PANE_ID (${paneId}).`);
  if (!['boss', 'orch'].includes(pane.label)) {
    throw new Error(`Only the pane labeled boss or a pane labeled orch can run herdr-boss ${command}. This pane is labeled ${pane.label ?? '(none)'}. A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.`);
  }
  const paneWorkspace = pane.workspace_id ?? pane.workspaceId ?? pane.workspace ?? null;
  if (paneWorkspace !== workspaceId) throw new Error(`Cannot verify the caller pane: HERDR_WORKSPACE_ID (${workspaceId}) differs from the pane workspace (${paneWorkspace ?? '(missing)'}).`);
  return { paneId, workspaceId, role: pane.label };
}

export function readControl(dir = DATA_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))?.control || {}; }
  catch { return {}; }
}

function checkAction(action) {
  if (action != null && !ACTIONS.includes(action)) throw new Error(`--action must be one of ${ACTIONS.join(', ')}.`);
  return action ?? null;
}

export function sayMessage(text, { replyTo = null, action = null } = {}, { env = process.env, herdr, control, dir = DATA_DIR, now = Date.now() } = {}) {
  const caller = verifyMessageCaller(env, herdr, 'say');
  const body = typeof text === 'string' ? text.trim() : '';
  if (body.length < 1 || body.length > SAY_TEXT_MAX) throw new Error(`The text must be 1 to ${SAY_TEXT_MAX} characters.`);
  const chosen = checkAction(action);
  refuseSecret(body, 'text');
  let thread = 'boss';
  if (caller.role === 'orch') {
    const projects = (control ?? readControl(dir)).projects || {};
    thread = Object.values(projects).find((project) => project?.workspace === caller.workspaceId)?.slug ?? null;
    if (!thread) throw new Error(`No project uses workspace ${caller.workspaceId}. Publish the project status, then wait for the next Herdr Boss tick.`);
  }
  if (replyTo != null && !readMessages({ dir }).some((record) => record.id === replyTo && record.thread === thread)) {
    throw new Error(`--reply-to ${replyTo} does not name a message in the ${thread} thread.`);
  }
  return appendMessage({ thread, from: caller.role, to: 'owner', kind: 'reply', text: body, action: chosen, replyTo: replyTo ?? null, status: 'new' }, { dir, now });
}

export function postReport(file, { to = null, title = null, action = null } = {}, { env = process.env, herdr, dir = DATA_DIR, now = Date.now() } = {}) {
  const caller = verifyMessageCaller(env, herdr, 'mail post');
  if (caller.role !== 'boss') throw new Error('Only the pane labeled boss can run herdr-boss mail post.');
  if (to !== 'owner') throw new Error('Use --to owner. The Owner is the only report recipient.');
  const chosen = checkAction(action);
  const size = fs.statSync(file).size;
  if (size > REPORT_MAX_BYTES) throw new Error(`The report is ${size} bytes. The limit is 64 KB (${REPORT_MAX_BYTES} bytes).`);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error('The report file is empty.');
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim();
  const name = String(title ?? heading ?? 'Report').trim();
  if (!name || name.length > TITLE_MAX) throw new Error(`The title must be 1 to ${TITLE_MAX} characters.`);
  refuseSecret(name, 'title');
  refuseSecret(text, 'report');
  return appendMessage({ thread: 'boss', from: 'boss', to: 'owner', kind: 'report', title: name, text, action: chosen, replyTo: null, status: 'new' }, { dir, now });
}
