import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';
import { openMessageStore, RETENTION_MS, messagesFile } from './message-store.js';

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
  return openMessageStore({ dir }).update(id, patch, { now });
}

export function listThread(thread, { dir = DATA_DIR, limit = THREAD_LIMIT } = {}) {
  return openMessageStore({ dir }).thread(thread, { limit });
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
  const source = item?.kind === 'report' && item.title ? String(item.title) : String(item?.text ?? '').split(LINE_BREAKS).find((part) => part.trim()) ?? '';
  const plain = source.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`]+/g, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return cutCodePoints(plain, TITLE_MAX).text.trim();
}

// The prompt for the agent. An answer to a mailbox item names the item and quotes the question, so the agent does not need the Mailbox.
// Every line of the quote starts with "> ", so a line in the question cannot look like a new prompt.
export function ownerPromptText(record, question = null) {
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
export const isMailboxItem = (record) => !!record && record.to === 'owner' && (record.kind === 'reply' || record.kind === 'report');
export const mailboxAction = (record) => (ACTIONS.includes(record?.action) ? record.action : 'read');
const needsOwnerAction = (record) => NEEDS_YOU_ACTIONS.has(mailboxAction(record));
// An information item is done when it is closed, closed by the Boss, or read. Old read items have no closedAt.
const isDone = (record) => !!record.closedAt || record.closedBy === 'boss' || (!needsOwnerAction(record) && !!record.readAt);

// The channel rule. A report is mail. A reply with an action for the Owner is in both channels. Every other record is a chat message.
export function messageChannel(record) {
  if (!record) return 'chat';
  if (record.kind === 'report') return 'mail';
  if (record.kind === 'reply' && NEEDS_YOU_ACTIONS.has(mailboxAction(record))) return 'both';
  return 'chat';
}

// An Owner answer to a mail item belongs to the Mailbox thread of that item. The record has replyTo set, and its parent is a record of the same thread on the mail channel (isMailRecord).
// A reply to a plain chat reply stays in the Chat. An answer whose parent is no longer in the store also stays in the Chat.
// The view decides this by replyTo, not by the thread name, so an answer that an older version filed as chat is also a mail answer.
export const messagesById = (records) => new Map(records.map((record) => [record.id, record]));
export function isMailAnswer(record, byId) {
  if (!record || record.from !== 'owner' || !record.replyTo) return false;
  const parent = byId.get(record.replyTo);
  return !!parent && parent.thread === record.thread && isMailRecord(parent);
}

// The records that the Chat shows. A Mailbox answer stays in the Mailbox.
export function chatRecords(records) {
  const byId = messagesById(records);
  return records.filter((record) => !isMailAnswer(record, byId));
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
    const answer = isMailRecord(record) && answers.get(record.id);
    return answer ? { ...record, answer: { id: answer.id, text: answer.text, at: answer.at } } : record;
  });
}

// The Mailbox lists only mail records. A plain chat reply never shows in Updates.
export const isMailRecord = (record) => isMailboxItem(record) && messageChannel(record) !== 'chat';

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
  const items = records.filter(isMailRecord);
  const needsYou = items.filter((item) => needsOwnerAction(item) && !item.closedAt);
  const needsYouUnread = needsYou.filter((item) => !item.readAt).length;
  const updates = items.filter((item) => !needsOwnerAction(item) && !isDone(item)).length;
  const chatUnread = records.filter((record) => record.to === 'owner' && !record.readAt && messageChannel(record) !== 'mail').length;
  const mailUnread = items.filter((item) => messageChannel(item) === 'mail' && !item.readAt).length;
  return { needsYou: needsYou.length, needsYouUnread, updates, unread: needsYouUnread, open: needsYou.length, chatUnread, mailUnread, needsAction: needsYou.length };
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
  const conversations = new Map(groupMessagesByConversation(records).flatMap((group) => group.records.map((record) => [record.id, group.id])));
  for (const record of records) {
    if (record.from === 'owner') owners.set(record.id, record);
    if (record.from === 'owner' && record.replyTo) answers.set(record.replyTo, record);
  }
  const items = records.filter(isMailRecord).reverse().map((record) => {
    const answer = answers.get(record.id);
    return {
      ...record,
      ...(!record.closedAt && isDone(record) && record.closedBy !== 'boss' ? { closedAt: record.readAt } : {}),
      action: mailboxAction(record),
      channel: messageChannel(record),
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
export function dismissMailboxItems(body, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'Send a JSON object with ids.' };
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX || !ids.every((id) => typeof id === 'string')) {
    return { status: 400, error: `ids must be a list of 1 to ${READ_IDS_MAX} mailbox item IDs.` };
  }
  return openMessageStore({ dir }).mutate((records) => {
    const items = ids.map((id) => records.find((record) => record.id === id && isMailboxItem(record)));
    const missing = ids.find((id, index) => !items[index]);
    if (missing) return { records, result: { status: 404, error: `No mailbox item has the ID ${missing}.` } };
    if (items.some((item) => !needsOwnerAction(item) || item.closedAt)) {
      return { records, result: { status: 409, error: 'Only open Needs-you items can be dismissed.' } };
    }
    const at = new Date(now).toISOString();
    for (const item of items) {
      item.readAt ||= at;
      item.closedAt ||= at;
      item.dismissed = true;
    }
    return { records, result: { ok: true, dismissed: items.length } };
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

function targetPane(thread, panes, projects) {
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
    const pane = targetPane(record.thread, panes, projects);
    if (!pane || used.has(pane.id) || !['idle', 'done', 'working'].includes(pane.status)) continue;
    used.add(pane.id);
    const attempts = (record.attempts || 0) + 1;
    const meta = { id: record.id, thread: record.thread, kind: record.kind, pane: pane.id };
    try {
      await prompt(pane.id, ownerPromptText(record, questions.get(record.replyTo)));
      updateMessage(record.id, { status: 'sent', sentAt: new Date(now).toISOString(), error: null, attempts }, { dir, now });
      log('message', `Delivered Owner ${record.kind} ${record.id} to ${record.thread}`, meta);
    } catch (error) {
      const reason = shortError(error, record, questions.get(record.replyTo));
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
