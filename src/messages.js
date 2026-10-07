import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';
import { openMessageStore, RETENTION_MS, messagesFile, newId } from './message-store.js';
import { redactSecrets } from './redact.js';
import { promptText, plannerPromptText, reviewAnswerPromptText } from './review-result.js';
import { getSession } from './planner-sessions.js';
import { uploadReportPictures } from './attachment-markdown.js';
import { validateAttachmentIds, readAttachment, uploadLocalPictures, deleteAttachment } from './attachments.js';

export { RETENTION_MS, messagesFile };

// Owner messages, agent replies, and Boss reports.
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
export const CLOSE_NOTE_PROJECT = 'resolved by the project';

export const CLOSE_NOTE_ELSEWHERE = 'answered elsewhere';
export const CHOICES_MAX = 10;
export const CHOICE_TEXT_MAX = 200;
const OWNER_KINDS = ['message', 'nudge', 'status-request'];

export const validThread = (thread) => thread === 'boss' || (typeof thread === 'string' && SLUG.test(thread));

export function readMessages({ dir = DATA_DIR } = {}) {
  return openMessageStore({ dir }).all();
}

// Keep this wrapper while callers move to the message store interface.
export function appendMessage(fields, { dir = DATA_DIR, now = Date.now() } = {}) {
  return openMessageStore({ dir }).append(fields, { now });
}

export function updateMessage(id, patch, { dir = DATA_DIR, now = Date.now() } = {}) {
  // A stored message kind is immutable; an older record without a kind may get its first value.
  return openMessageStore({ dir }).update(id, patch, { now });
}

export function listThread(thread, { dir = DATA_DIR, limit = THREAD_LIMIT } = {}) {
  return openMessageStore({ dir }).thread(thread, { limit }).filter((record) => record.kind !== 'agent');
}

// ---------- Owner sends ----------

// Returns { status, error } for a refused send, or { fields } for a record to queue.
export function validateOwnerSend(body, { knownThreads, records = [], now = Date.now() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with thread, kind, and text.' };
  const { thread, kind } = body;
  try { validateAttachmentIds(body.attachments === undefined ? [] : body.attachments); }
  catch (error) { return { status: error.statusCode, error: error.message }; }
  if (!validThread(thread)) return { status: 400, error: 'The thread must be boss or a project slug.' };
  if (!OWNER_KINDS.includes(kind)) return { status: 400, error: `The kind must be one of ${OWNER_KINDS.join(', ')}.` };
  let text;
  if (kind === 'message') {
    text = typeof body.text === 'string' ? body.text.trim() : '';
    if ((!text.length && !body.attachments?.length) || text.length > OWNER_TEXT_MAX) return { status: 400, error: `The message text must be 1 to ${OWNER_TEXT_MAX} characters.` };
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
  return { fields: { thread, from: 'owner', to: thread === 'boss' ? 'boss' : 'orch', kind, text, action: null, replyTo, status: 'queued', attempts: 0, ...(body.attachments !== undefined ? { attachments: body.attachments } : {}) } };
}

const PROMPT_QUOTE_MAX = 400;
const LINE_BREAKS = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

// Cut on a code point boundary, so a surrogate pair stays whole.
const cutCodePoints = (text, max) => {
  const points = Array.from(text.slice(0, max * 2));
  return { text: points.slice(0, max).join(''), cut: points.length > max || text.length > max * 2 };
};

// The title of a mailbox item: the report title, or the first line of the text without Markdown marks. It holds no control character.
export function mailboxTitle(item) {
  const source = (item?.kind === 'report' || item?.kind === 'review') && item.title ? String(item.title) : String(item?.text ?? '').split(LINE_BREAKS).find((part) => part.trim()) ?? '';
  const plain = source.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`]+/g, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return cutCodePoints(plain, TITLE_MAX).text.trim();
}

// The prompt for the agent. An answer to a mailbox item names the item and quotes the question, so the agent does not need the Mailbox.
// Every line of the quote starts with "> ", so a line in the question cannot look like a new prompt.
export function ownerPromptText(record, question = null) {
  // The text of a review result is the finished prompt: one header line, the denied items, and the fetch command.
  if (record.kind === 'review-result') return record.text;
  if (record.kind === 'review-answer') return `[owner] ${record.text}`;
  const hint = `(Reply with: herdr-boss say --reply-to ${record.id} "<answer>")`;
  if (!record.replyTo) return `[owner] ${record.text} ${hint}`;
  if (!question) return `[owner] Answer to ${record.replyTo}: ${record.text} ${hint}`;
  const title = mailboxTitle(question);
  const source = String(question.text ?? '').replace(LINE_BREAKS, '\n').replace(CONTROLS, '');
  const { text, cut } = cutCodePoints(source, PROMPT_QUOTE_MAX);
  const quote = `${text}${cut ? '…' : ''}`.split('\n').map((line) => `> ${line}`).join('\n');
  return `[owner] Answer to ${record.replyTo}${title ? ` (${title})` : ''}: ${record.text}\n${quote}\n${hint}`;
}

// ---------- Owner mailbox ----------

// Every agent reply and Boss report to the Owner is a mailbox item. An item without a known action is information.
export const isMailboxItem = (record) => !!record && record.to === 'owner' && (record.kind === 'reply' || record.kind === 'report' || record.kind === 'review');
export const mailboxAction = (record) => (ACTIONS.includes(record?.action) ? record.action : 'read');
const needsOwnerAction = (record) => NEEDS_YOU_ACTIONS.has(mailboxAction(record));
// An information item is done when it is closed, closed by the Boss, or read. Old read items have no closedAt.
const isDone = (record) => !!record.closedAt || record.closedBy === 'boss' || (!needsOwnerAction(record) && !!record.readAt);

const MESSAGE_CHANNEL_RULES = [
  { kind: 'agent', action: '*', channel: 'agent' },
  { kind: '*', action: 'needs-you', mailboxItem: true, channel: 'both' },
  { kind: '*', action: 'reply-to', channel: 'parent' },
  { kind: 'report', action: '*', channel: 'mail' },
  { kind: 'review', action: '*', channel: 'mail' },
  { kind: '*', action: '*', channel: 'chat' },
];

// One ordered table decides each channel. A reply follows its parent only inside the same thread.
export function messageChannel(record, byId = new Map()) {
  const resolve = (current, seen) => {
    if (!current) return 'chat';
    for (const rule of MESSAGE_CHANNEL_RULES) {
      if (rule.kind !== '*' && rule.kind !== current.kind) continue;
      if (rule.mailboxItem && !isMailboxItem(current)) continue;
      if (rule.action === 'needs-you' && !NEEDS_YOU_ACTIONS.has(mailboxAction(current))) continue;
      if (rule.action === 'reply-to') {
        if (!current.replyTo || typeof byId?.get !== 'function') continue;
        const parent = byId.get(current.replyTo);
        if (!parent || parent.thread !== current.thread || seen.has(parent.id)) continue;
        return resolve(parent, new Set([...seen, current.id]));
      }
      return rule.channel;
    }
    return 'chat';
  };
  return resolve(record, new Set());
}

// An Owner answer to a mail item belongs to the Mailbox thread of that item. The record has replyTo set, and its parent is a record of the same thread on the mail channel (isMailRecord).
// A reply to a plain chat reply stays in the Chat. An answer whose parent is no longer in the store also stays in the Chat.
// The view decides this by replyTo, not by the thread name, so an answer that an older version filed as chat is also a mail answer.
export const messagesById = (records) => new Map(records.map((record) => [record.id, record]));
export function isMailAnswer(record, byId) {
  if (!record || record.from !== 'owner' || !record.replyTo) return false;
  const parent = byId.get(record.replyTo);
  return !!parent && parent.thread === record.thread && isMailRecord(parent, byId);
}

// The records that the Chat shows. A Mailbox answer stays in the Mailbox.
export function chatRecords(records) {
  const byId = messagesById(records);
  return records.filter((record) => record.kind !== 'agent' && !isMailAnswer(record, byId));
}

// One summary for each thread from the chat records: the last record, the count, and the unread records to the Owner.
export function chatSummaries(records) {
  const chats = new Map();
  for (const record of chatRecords(records)) {
    if (!chats.has(record.thread)) chats.set(record.thread, { thread: record.thread, last: record, count: 0, unreadForOwner: 0 });
    const chat = chats.get(record.thread);
    chat.last = record;
    chat.count += 1;
    if (record.to === 'owner' && !record.readAt) chat.unreadForOwner += 1;
  }
  return [...chats.values()].sort((left, right) => messageOrder(right.last, left.last));
}

// A page of a chat thread, oldest first. before is the ID of the oldest message that the client holds.
export function chatThreadPage(records, thread, { limit = THREAD_LIMIT, before = null } = {}) {
  const list = chatRecords(records).filter((record) => record.thread === thread);
  let end = list.length;
  if (before !== null) {
    const cursor = list.findIndex((record) => record.id === before);
    if (cursor < 0) return [];
    end = cursor;
  }
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return count ? list.slice(Math.max(0, end - count), end) : [];
}

// A mailbox item in a chat thread carries the answer, so its card shows the result without the answer record.
export function withMailAnswers(page, records) {
  const byId = messagesById(records);
  const answers = new Map();
  for (const record of records) if (isMailAnswer(record, byId) && !answers.has(record.replyTo)) answers.set(record.replyTo, record);
  return page.map((record) => {
    const answer = isMailRecord(record, byId) && answers.get(record.id);
    return answer ? { ...record, answer: { id: answer.id, text: answer.text, at: answer.at } } : record;
  });
}

// The Mailbox lists only mail records. A plain chat reply never shows in Updates.
export const isMailRecord = (record, byId = new Map()) => isMailboxItem(record) && messageChannel(record, byId) !== 'chat';

// Name the place where the CLI put a record.
export function placeText(record) {
  if (!isMailboxItem(record)) return 'sent in chat';
  const action = mailboxAction(record);
  if (NEEDS_YOU_ACTIONS.has(action)) return `posted as a Mailbox item (${action})`;
  if (record.kind === 'report' || record.kind === 'review') return 'posted as a Mailbox item (read)';
  return 'sent in chat';
}

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

// The three numbers of the top bar. chatUnread counts the chat records to the Owner, mailUnread the unread mail records, and needsAction the open action items.
export function mailboxCounts(records) {
  const byId = messagesById(records);
  const items = records.filter((record) => isMailRecord(record, byId));
  const needsYou = items.filter((item) => needsOwnerAction(item) && !item.closedAt);
  const needsYouUnread = needsYou.filter((item) => !item.readAt).length;
  const updates = items.filter((item) => !needsOwnerAction(item) && !isDone(item)).length;
  const chatUnread = records.filter((record) => record.kind !== 'agent' && record.to === 'owner' && !record.readAt && messageChannel(record, byId) !== 'mail').length;
  const mailUnread = items.filter((item) => messageChannel(item, byId) === 'mail' && !item.readAt).length;
  return { needsYou: needsYou.length, needsYouUnread, updates, unread: needsYouUnread, open: needsYou.length, chatUnread, mailUnread, needsAction: needsYou.length };
}

// An open Needs-you item gets the suggestion to close it when the Owner wrote on its thread after the item, and did not answer this item.
// Keep open stores closeSuggestionDismissedAt on the item, so the suggestion stays away on every device.
export function closeSuggested(item, records) {
  if (!needsOwnerAction(item) || item.kind === 'review' || item.closedAt || item.closeSuggestionDismissedAt || item.from === 'owner') return false;
  const since = Date.parse(item.at);
  return records.some((record) => record.from === 'owner' && record.kind === 'message' && record.thread === item.thread
    && record.replyTo !== item.id && Date.parse(record.at) > since);
}

const messageOrder = (left, right) => Date.parse(left.at) - Date.parse(right.at);

// A thread is a project or Boss. replyTo links records into conversations within that thread.
export function groupMessagesByConversation(records) {
  const byThreadAndId = new Map(records.map((record) => [`${record.thread}\0${record.id}`, record]));
  const rootById = new Map();
  const findRoot = (record) => {
    if (rootById.has(record.id)) return rootById.get(record.id);
    const chain = [];
    const seen = new Map();
    let cursor = record;
    let root = cursor.id;
    while (cursor) {
      if (seen.has(cursor.id)) {
        root = chain.slice(seen.get(cursor.id)).sort(messageOrder)[0].id;
        break;
      }
      seen.set(cursor.id, chain.length);
      chain.push(cursor);
      const parent = cursor.replyTo && byThreadAndId.get(`${cursor.thread}\0${cursor.replyTo}`);
      if (!parent) { root = cursor.id; break; }
      cursor = parent;
    }
    for (const item of chain) rootById.set(item.id, root);
    return root;
  };
  const groups = new Map();
  for (const record of records) {
    const id = findRoot(record);
    if (!groups.has(id)) groups.set(id, { id, thread: record.thread, records: [] });
    groups.get(id).records.push(record);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, records: group.records.sort(messageOrder), latestAt: group.records[group.records.length - 1]?.at ?? null }))
    .sort((left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt));
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
    ...(record.attachments ? { attachments: record.attachments } : {}),
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
  const byId = messagesById(records);
  const replies = replyTimes(records);
  const conversations = new Map(groupMessagesByConversation(records).flatMap((group) => group.records.map((record) => [record.id, group.id])));
  for (const record of records) {
    if (record.from === 'owner') owners.set(record.id, record);
    if (record.from === 'owner' && record.replyTo) answers.set(record.replyTo, record);
  }
  const items = records.filter((record) => isMailRecord(record, byId)).reverse().map((record) => {
    const answer = answers.get(record.id);
    return {
      ...record,
      closeSuggestion: closeSuggested(record, records),
      ...(!record.closedAt && isDone(record) && record.closedBy !== 'boss' ? { closedAt: record.readAt } : {}),
      action: mailboxAction(record),
      channel: messageChannel(record, byId),
      choices: parseChoices(record.text),
      conversationId: conversations.get(record.id) ?? record.id,
      ownerMessage: owners.has(record.replyTo) ? deliveryView(owners.get(record.replyTo), replies) : null,
      answer: answer ? deliveryView(answer, replies) : null,
    };
  });
  return {
    needsYou: items.filter((item) => needsOwnerAction(item) && !item.closedAt),
    updates: items.filter((item) => !needsOwnerAction(item) && !isDone(item)),
    done: items.filter(isDone),
  };
}

// Inbox holds the open Needs-you items and the unread information items, newest first. Sent holds every Owner message. Done also lists messages that the Boss relayed.
export function mailboxFolders(records) {
  const view = mailboxView(records);
  const conversations = new Map(groupMessagesByConversation(records).flatMap((group) => group.records.map((record) => [record.id, group.id])));
  const sent = messagesWithReplyState(records.filter((record) => record.from === 'owner' && record.to !== 'owner').slice().reverse(), records)
    .map((record) => ({ ...record, conversationId: conversations.get(record.id) ?? record.id }));
  const relayed = sent.filter((record) => record.status === 'relayed');
  const inbox = [...view.needsYou, ...view.updates].sort((left, right) => messageOrder(right, left));
  return { ...view, inbox, sent, updatesUnread: view.updates.filter((record) => !record.readAt).length, done: [...view.done, ...relayed].sort((left, right) => messageOrder(right, left)) };
}

export function closeMailboxItem(id, { dir = DATA_DIR, now = Date.now() } = {}) {
  return openMessageStore({ dir }).mutate((records) => {
    const item = records.find((record) => record.id === id && isMailboxItem(record));
    if (!item) return { records, result: null };
    const at = new Date(now).toISOString();
    item.closedAt ||= at;
    item.readAt ||= at;
    return { records, result: item };
  }, { now });
}

// The project that owns an item closes it when its task no longer waits on the Owner. The Owner closes it as answered elsewhere.
// The close never changes an existing closedAt. An item that no task links to never closes by time.
const taskList = (status) => (Array.isArray(status?.tasks) ? status.tasks.filter((task) => task && typeof task === 'object') : []);

// Close open Needs-you items that the project resolved in its published status.
// Only a linked item closes. A removed task needs the previous status.
export function closeResolvedMailboxItems(slug, next, { dir = DATA_DIR, now = Date.now(), previous = null } = {}) {
  if (!validThread(slug) || slug === 'boss') return { closed: 0 };
  const tasks = taskList(next);
  if (!tasks.length) return { closed: 0 };
  const linkedIds = new Set(tasks.filter((task) => typeof task.mailboxId === 'string' && task.mailboxId).map((task) => task.mailboxId));
  const waitingIds = new Set(tasks.filter((task) => task.waitingOn === 'owner' && typeof task.mailboxId === 'string' && task.mailboxId).map((task) => task.mailboxId));
  const resolvedIds = new Set([...linkedIds].filter((id) => !waitingIds.has(id)));
  const currentTaskIds = new Set(tasks.filter((task) => typeof task.id === 'string' && task.id).map((task) => task.id));
  const removedIds = new Set(taskList(previous)
    .filter((task) => typeof task.id === 'string' && task.id && !currentTaskIds.has(task.id) && typeof task.mailboxId === 'string' && task.mailboxId)
    .map((task) => task.mailboxId));
  const store = openMessageStore({ dir });
  const open = (record) => record.thread === slug && record.from !== 'boss' && isMailboxItem(record) && record.kind !== 'review' && needsOwnerAction(record) && !record.closedAt && !record.closedBy && !record.dismissed;
  const noteFor = (record) => {
    if (!open(record)) return null;
    if (resolvedIds.has(record.id)) return CLOSE_NOTE_PROJECT;
    if (linkedIds.has(record.id)) return null;
    return removedIds.has(record.id) ? CLOSE_NOTE_PROJECT : null;
  };
  // Read first. A publish with no open item to close does not rewrite the store.
  const all = store.all();
  const notes = new Map(all.map((record) => [record.id, noteFor(record)]).filter(([, note]) => note));
  if (!notes.size) return { closed: 0 };
  return store.mutate((records) => {
    const at = new Date(now).toISOString();
    let closed = 0;
    for (const item of records) {
      const note = notes.get(item.id);
      if (!note || !open(item)) continue;
      item.closedAt = at;
      item.readAt ||= at;
      item.closedBy = 'project';
      item.closeNote = note;
      closed += 1;
    }
    return { records, result: { closed } };
  }, { now });
}

// The publish path calls this one. A failed mailbox update never fails the publish.
export function closeResolvedOnPublish(slug, next, { log = () => {}, warn = log, ...options } = {}) {
  try {
    const result = closeResolvedMailboxItems(slug, next, options);
    if (result.closed) log(`Closed ${result.closed} Mailbox ${result.closed === 1 ? 'item' : 'items'} of ${slug}: the task no longer waits on the Owner.`);
    return result;
  } catch (error) {
    warn(`The Mailbox update after the publish of ${slug} failed: ${error.message}`);
    return { closed: 0, error: error.message };
  }
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
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No open mailbox item has the ID ${missing}.` } };
    const closed = items.find((item) => item.closedAt);
    if (closed) return { records, result: { status: 409, error: `Mailbox item ${closed.id} is already closed.` } };
    const at = new Date(now).toISOString();
    for (const item of items) {
      item.closedAt = at;
      item.readAt ||= at;
      item.closedBy = 'boss';
      item.closeNote = text;
    }
    return { records, result: { ok: true, closed: items.length } };
  }, { now });
}

// Sets readAt on each item once. An item whose action is read also gets closedAt, so a read information item is Done.
// `close: true` stays accepted and has the same effect for those items.
// Returns { status, error } for a refused request, or { ok, updated }.
export function markMailboxRead(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids, close = false } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  if (typeof close !== 'boolean') return { status: 400, error: 'close must be true or false.' };
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No mailbox item has the ID ${missing}.` } };
    if (close && items.some((item) => mailboxAction(item) !== 'read')) {
      return { records, result: { status: 409, error: 'Only an item with the action read closes on Mark read. Answer the other items.' } };
    }
    const at = new Date(now).toISOString();
    let updated = 0;
    for (const item of items) {
      let changed = false;
      if (!item.readAt) { item.readAt = at; changed = true; }
      if ((close || mailboxAction(item) === 'read') && !item.closedAt) { item.closedAt = at; changed = true; }
      if (changed) updated += 1;
    }
    return { records, result: { ok: true, updated } };
  }, { now });
}

// Dismiss open Needs-you items without sending an answer to an agent.
// With answeredElsewhere: true the items close as answered elsewhere: closedBy is owner and the note says so. They are not dismissed.
export function dismissMailboxItems(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids, answeredElsewhere = false } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  if (typeof answeredElsewhere !== 'boolean') return { status: 400, error: 'answeredElsewhere must be true or false.' };
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No mailbox item has the ID ${missing}.` } };
    if (items.some((item) => !needsOwnerAction(item) || item.closedAt)) {
      return { records, result: { status: 409, error: `Only open Needs-you items can be ${answeredElsewhere ? 'closed' : 'dismissed'}.` } };
    }
    if (answeredElsewhere && items.some((item) => item.kind === 'review')) {
      return { records, result: { status: 409, error: 'A review item closes when you submit the review.' } };
    }
    const at = new Date(now).toISOString();
    for (const item of items) {
      item.readAt ||= at;
      item.closedAt ||= at;
      if (answeredElsewhere) { item.closedBy = 'owner'; item.closeNote = CLOSE_NOTE_ELSEWHERE; }
      else item.dismissed = true;
    }
    return { records, result: answeredElsewhere ? { ok: true, closed: items.length } : { ok: true, dismissed: items.length } };
  }, { now });
}

// The Owner keeps an item open after the close suggestion. The dismissal is stored on the item.
export function keepMailboxItemsOpen(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No mailbox item has the ID ${missing}.` } };
    if (items.some((item) => !needsOwnerAction(item) || item.kind === 'review' || item.closedAt)) {
      return { records, result: { status: 409, error: 'Only an open Needs-you item has a close suggestion.' } };
    }
    const at = new Date(now).toISOString();
    for (const item of items) item.closeSuggestionDismissedAt ||= at;
    return { records, result: { ok: true, kept: items.length } };
  }, { now });
}

// Mark queued Owner messages as relayed. The CLI verifies that the caller is the Boss pane.
export function relayOwnerMessages(ids, { by, dir = DATA_DIR, now = Date.now() } = {}) {
  if (by !== 'boss') return { status: 403, error: 'Only the Boss can relay Owner messages.' };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `Give 1 to ${READ_IDS_MAX} Owner message IDs to relay.` };
  }
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && record.from === 'owner'));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No queued Owner message has the ID ${missing}.` } };
    if (items.some((item) => item.status !== 'queued')) return { records, result: { status: 409, error: 'Only queued Owner messages can be relayed.' } };
    const relayedAt = new Date(now).toISOString();
    for (const item of items) {
      item.status = 'relayed';
      item.relayedAt = relayedAt;
      item.relayedBy = 'boss';
    }
    return { records, result: { ok: true, relayed: items.length } };
  }, { now });
}

// ---------- Delivery ----------

// A result message of a planner pack goes to the pane of the active planner session. When the session has ended or is unknown, the
// message goes to the orch pane. While the session is active and its pane is absent, the message waits.
function targetPane(thread, panes, projects, record = null, dir = DATA_DIR) {
  if (record?.planner?.session) {
    const session = getSession({ dir, id: record.planner.session });
    if (session && !session.endedAt) return panes.find((pane) => pane.id === session.pane && pane.agent) || null;
  }
  if (thread === 'boss') return panes.find((pane) => pane.label === 'boss' && pane.agent) || null;
  const id = projects?.[thread]?.orch?.pane;
  return (id && panes.find((pane) => pane.id === id && pane.label === 'orch' && pane.agent)) || null;
}

// A command error can repeat the prompt text. Keep one short line and remove the text.
function shortError(error, record, question = null) {
  const stderr = String(error?.stderr || '').trim().split('\n')[0];
  const message = String(error?.message || '');
  let text = stderr || (message && !message.startsWith('Command failed') ? message.split('\n')[0] : 'Herdr could not send the prompt.');
  for (const part of [ownerPromptText(record, question), ownerPromptText(record), record.text]) if (part) text = text.split(part).join('[message]');
  return text.slice(0, 160);
}

// Sends queued Owner messages to boss and orch panes that are not blocked. `busy` holds panes that got a prompt in this tick.
export async function deliverQueued({ panes = [], projects = {}, prompt, log = () => {}, dir = DATA_DIR, now = Date.now(), busy = new Set() }) {
  const used = new Set(busy);
  const all = readMessages({ dir });
  const questions = new Map(all.filter(isMailboxItem).map((record) => [record.id, record]));
  const pending = all.filter((record) => record.from === 'owner'
    && (record.status === 'queued' || (record.status === 'failed' && (record.attempts || 0) < MAX_DELIVERY_ATTEMPTS)));
  for (const record of pending) {
    const pane = targetPane(record.thread, panes, projects, record, dir);
    if (!pane || used.has(pane.id) || !['idle', 'done', 'working'].includes(pane.status)) continue;
    used.add(pane.id);
    const attempts = (record.attempts || 0) + 1;
    const meta = { id: record.id, thread: record.thread, kind: record.kind, pane: pane.id };
    try {
      const attachmentLines = (record.attachments || []).map(({ id }) => {
        const attachment = readAttachment(id, { dir });
        // Escape any controls in a configured directory; filenames contain only an id and a fixed extension.
        const file = path.resolve(attachment.file).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
        return `Attachment: ${file} (${attachment.type}, ${Math.max(1, Math.ceil(attachment.size / 1024))} KB) — read this file with your image tool.`;
      });
      await prompt(pane.id, [ownerPromptText(record, questions.get(record.replyTo)), ...attachmentLines].join('\n'));
      updateMessage(record.id, { status: 'sent', sentAt: new Date(now).toISOString(), error: null, attempts }, { dir, now });
      log('message', `Delivered Owner ${record.kind} ${record.id} to ${record.thread}`, meta);
    } catch (error) {
      const reason = record.attachments?.length ? 'Herdr could not deliver the message with its pictures.' : shortError(error, record, questions.get(record.replyTo));
      updateMessage(record.id, { status: 'failed', error: reason, attempts }, { dir, now });
      const retry = attempts < MAX_DELIVERY_ATTEMPTS ? 'will retry' : 'no more retries';
      log('message', `Owner ${record.kind} ${record.id} to ${record.thread} failed (attempt ${attempts}, ${retry}): ${reason}`, { ...meta, failed: true });
    }
  }
}

// ---------- Agent replies and reports ----------

export function refuseSecret(text, what) {
  if (redactSecrets(text) !== text) throw new Error(`The ${what} looks like it holds a secret: a token, a key, or a password. Herdr Boss did not store it. Remove the secret and try again.`);
}

// The same checks as `worker allow`: HERDR_ENV, the pane ID and workspace from Herdr, and an exact label.
// `labels` names the pane labels that may call. The default is boss and orch.
export function verifyMessageCaller(env, herdr, command, { labels = ['boss', 'orch'] } = {}) {
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
  if (!labels.includes(pane.label)) {
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

export function sayMessage(text, { replyTo = null, action = null, images = [] } = {}, { env = process.env, herdr, control, dir = DATA_DIR, now = Date.now() } = {}) {
  const caller = verifyMessageCaller(env, herdr, 'say');
  if (!Array.isArray(images) || images.length > 3) throw new Error('say accepts at most 3 pictures.');
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
  const attachments = uploadLocalPictures(images, { dir, now });
  try {
    return appendMessage({ thread, from: caller.role, to: 'owner', kind: 'reply', text: body, action: chosen, replyTo: replyTo ?? null, status: 'new', ...(attachments.length ? { attachments: attachments.map(({ id }) => id) } : {}) }, { dir, now });
  } catch (error) { for (const { id } of attachments) deleteAttachment(id, { dir }); throw error; }
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
  const pictures = uploadReportPictures(text, { dir, now });
  try {
    return writeOwnerReport({ title: name, text: pictures.text, action: chosen, ...(pictures.attachments.length ? { attachments: pictures.attachments } : {}) }, { dir, now });
  } catch (error) { pictures.rollback(); throw error; }
}

function writeOwnerReport(fields, { dir = DATA_DIR, now = Date.now(), key = null, messageStore = null } = {}) {
  const report = { thread: 'boss', from: 'boss', to: 'owner', kind: 'report', replyTo: null, status: 'new', ...fields };
  if (key == null) return appendMessage(report, { dir, now });
  const store = messageStore ?? openMessageStore({ dir });
  return store.mutate((records) => {
    const index = records.findIndex((record) => record.to === 'owner' && record.kind === 'report' && record.key === key && !record.closedAt);
    if (index >= 0) {
      const updated = { ...records[index], text: report.text };
      records[index] = updated;
      return { records, result: updated };
    }
    const record = { id: newId(now), at: new Date(now).toISOString(), action: null, sentAt: null, error: null, relayedAt: null, relayedBy: null, ...report, key };
    records.push(record);
    return { records, result: record };
  }, { now });
}

export function postToolUpdate(tool, { dir = DATA_DIR, now = Date.now(), messageStore = null } = {}) {
  if (!tool || !/^[a-z][a-z0-9-]*$/.test(tool.id ?? '') || typeof tool.name !== 'string' || typeof tool.latest !== 'string') {
    throw new Error('The tool update is incomplete.');
  }
  if (tool.risk !== 'late' && tool.risk !== 'security') throw new Error('Only late or security tool rows can make a Mailbox item.');
  const name = `${tool.name} ${tool.latest}`;
  const title = tool.risk === 'security' ? `Security: ${name}` : `Update: ${name}`;
  const pinned = tool.pinned ?? 'none';
  const text = tool.risk === 'security'
    ? `Security release.\n\n${name} has a security release.\n\nPinned: ${pinned}\nLatest: ${tool.latest}.`
    : `${name} is more than 14 days late.\n\nPinned: ${pinned}\nLatest: ${tool.latest}\nAge: ${Number.isInteger(tool.ageDays) ? `${tool.ageDays} days` : 'unknown'}.`;
  refuseSecret(title, 'title');
  refuseSecret(text, 'report');
  return writeOwnerReport({ title, text, action: 'read' }, { dir, now, key: `tools:${tool.id}:${tool.latest}`, messageStore });
}

// ---------- Review pack items ----------

const REVIEW_TITLE_PREFIX = 'Review: ';

// Close the open review items of one pack in a record list. `except` names an item ID that stays open.
function closeReviewRecords(records, { slug, pack, except = null }, at) {
  let closed = 0;
  for (const record of records) {
    if (record.kind !== 'review' || record.id === except || record.closedAt) continue;
    if (record.review?.slug !== slug || record.review?.pack !== pack) continue;
    record.closedAt = at;
    record.readAt ||= at;
    record.closedBy = 'review';
    closed += 1;
  }
  return closed;
}

// Close every open review item of one pack. Returns { closed }. The closed item carries closedBy: 'review'.
export function closeReviewItems({ slug, pack, except = null }, { dir = DATA_DIR, now = Date.now() } = {}) {
  return openMessageStore({ dir }).mutate((records) => ({ records, result: { closed: closeReviewRecords(records, { slug, pack, except }, new Date(now).toISOString()) } }), { now });
}

// Append the decide item of a published review pack and close the older items of the same pack in one store write,
// so a crash never leaves two open items for one pack.
// `text` is the summary line of the pack. The record adds the link to the review page. The caller has verified the role.
// `planner` ({ session, pane }) names the planner session of the publisher. The result of the pack then goes to that pane.
export function postReview({ slug, pack, title, version, text, role = 'orch', planner = null } = {}, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!validThread(slug)) throw new Error('The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters.');
  if (!['orch', 'boss'].includes(role)) throw new Error(`The role of a review item must be orch or boss, not ${role}.`);
  const suffix = ` (v${version})`;
  const name = cutCodePoints(String(title ?? '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim(), TITLE_MAX - REVIEW_TITLE_PREFIX.length - suffix.length).text.trim();
  if (!name) throw new Error('The review pack needs a title.');
  const body = `${String(text ?? '').trim()}\n\n[Open review](/reviews/${slug}/${pack})`.trim();
  refuseSecret(name, 'title');
  refuseSecret(body, 'text');
  const at = new Date(now).toISOString();
  const record = {
    id: newId(now), at, thread: slug, from: role, to: 'owner', kind: 'review', text: body, action: 'decide', replyTo: null, status: 'new',
    sentAt: null, error: null, relayedAt: null, relayedBy: null,
    title: `${REVIEW_TITLE_PREFIX}${name}${suffix}`, review: { slug, pack, version },
    ...(planner?.session && planner?.pane ? { planner: { session: String(planner.session), pane: String(planner.pane) } } : {}),
  };
  return openMessageStore({ dir }).mutate((records) => {
    closeReviewRecords(records, { slug, pack }, at);
    records.push(record);
    return { records, result: record };
  }, { now });
}

// ---------- Review result ----------

const sameReview = (record, { slug, pack, version }) => record.review?.slug === slug && record.review?.pack === pack && record.review?.version === version;

// Queue the result of a submitted review as one Owner message to the project thread. The message is keyed by the pack and the version:
// a second call returns the first message and adds none, so a retried submit never sends a second prompt.
// The existing delivery (deliverQueued) sends it with its retries. `replyTo` is the ID of the Mailbox item of the pack.
export function postReviewResult({ result, replyTo = null } = {}, { dir = DATA_DIR, now = Date.now() } = {}) {
  const ref = { slug: result?.slug, pack: result?.pack, version: result?.version };
  if (!validThread(ref.slug) || ref.slug === 'boss') throw new Error('The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters.');
  if (!Number.isInteger(ref.version) || ref.version < 1) throw new Error('The review result needs a version.');
  const at = new Date(now).toISOString();
  return openMessageStore({ dir }).mutate((records) => {
    const existing = records.find((record) => record.kind === 'review-result' && sameReview(record, ref));
    if (existing) return { records, result: existing };
    // The review item of the pack version names the planner session of the publisher. The result goes to that pane.
    const planner = records.find((record) => record.id === replyTo && record.kind === 'review' && sameReview(record, ref))?.planner ?? null;
    const text = planner ? plannerPromptText(result) : promptText(result);
    const record = {
      id: newId(now), at, thread: ref.slug, from: 'owner', to: 'orch', kind: 'review-result', text, action: null, replyTo, status: 'queued',
      sentAt: null, error: null, attempts: 0, review: ref, ...(planner ? { planner } : {}),
    };
    records.push(record);
    return { records, result: record };
  }, { now });
}

// Queue the answer to an item reopened after submit. It uses the same delivery queue and planner-pane routing as a result prompt.
export function postReviewAnswer({ slug, pack, version, item, answer, replyTo = null } = {}, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!validThread(slug) || slug === 'boss' || typeof pack !== 'string' || !SLUG.test(pack) || typeof item !== 'string' || !SLUG.test(item)) {
    throw new Error('The review answer needs a valid project, pack, and item.');
  }
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(answer?.rev) || answer.rev < 1) throw new Error('The review answer needs a version and saved revision.');
  const ref = { slug, pack, version };
  const at = new Date(now).toISOString();
  return openMessageStore({ dir }).mutate((records) => {
    const existing = records.find((record) => record.kind === 'review-answer' && sameReview(record, ref)
      && record.reviewAnswer?.item === item && record.reviewAnswer?.rev === answer.rev);
    if (existing) return { records, result: existing };
    const source = records.find((record) => record.kind === 'review' && sameReview(record, ref) && (replyTo == null || record.id === replyTo));
    const record = {
      id: newId(now), at, thread: slug, from: 'owner', to: 'orch', kind: 'review-answer',
      text: reviewAnswerPromptText({ pack, item, answer }), action: null, replyTo: replyTo ?? null,
      status: 'queued', sentAt: null, error: null, attempts: 0, review: ref, reviewAnswer: { item, rev: answer.rev },
      ...(source?.planner ? { planner: source.planner } : {}),
    };
    records.push(record);
    return { records, result: record };
  }, { now });
}

// The delivery state of the result message of one pack version: queued, sent, or failed. `retry` is true while a failed message
// has attempts left. It returns null when the version has no message.
export function reviewResultDelivery(ref, { dir = DATA_DIR } = {}) {
  const record = readMessages({ dir }).find((entry) => entry.kind === 'review-result' && sameReview(entry, ref));
  if (!record) return null;
  const attempts = record.attempts || 0;
  return {
    id: record.id, status: record.status, attempts, sentAt: record.sentAt ?? null, error: record.error ?? null,
    retry: record.status === 'failed' && attempts < MAX_DELIVERY_ATTEMPTS, maxAttempts: MAX_DELIVERY_ATTEMPTS,
  };
}

// The submit closes the review item of that pack version as the Owner. A second call closes nothing. It returns { closed }.
export function closeSubmittedReview({ slug, pack, version }, { dir = DATA_DIR, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  return openMessageStore({ dir }).mutate((records) => {
    let closed = 0;
    for (const record of records) {
      if (record.kind !== 'review' || record.closedAt || !sameReview(record, { slug, pack, version })) continue;
      record.closedAt = at;
      record.readAt ||= at;
      record.closedBy = 'owner';
      record.closeNote = 'review submitted';
      closed += 1;
    }
    return { records, result: { closed } };
  }, { now });
}
