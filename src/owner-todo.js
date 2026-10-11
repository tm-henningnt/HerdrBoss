import { DATA_DIR } from './config.js';
import { openMessageStore, newId } from './message-store.js';
import { verifyMessageCaller, readControl, REPORT_MAX_BYTES, isMailboxItem, mailboxAction, mailboxTitle } from './messages.js';
import { requiredProposalSections, proposalSections } from './kit/proposal.js';
import { redactSecrets } from './redact.js';
import { scanText } from './secret-scan.js';
import { redactBrowserSecrets, maskBrowserText } from './browser-url-mask.js';
import { TODO_TYPES, TODO_PRIORITIES, todoState, todoView } from './owner-todo-model.js';

export { TODO_TYPES, TODO_PRIORITIES, todoState, todoView } from './owner-todo-model.js';
export const TODO_POST_LIMIT = 10;
const HEADINGS = ['Title', 'Why', 'Steps', 'Expected result', 'How to answer', 'What it blocks', 'Type'];
const FILE_SUFFIX = /\.(?:js|ts|jsx|tsx|css|md|json|html|txt|png|jpg|svg|qvs|qvd|qvf|sh|yml|yaml)$/i;

export class TodoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Refusal messages never repeat a value from the file or an Owner reason.
function publicText(text) {
  let decoded = text;
  for (let i = 0; i < 2; i += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }
  if (redactSecrets(decoded) !== decoded || redactBrowserSecrets(decoded) !== decoded || scanText('todo.md', decoded).length) {
    throw new TodoError('The To do text holds a secret or credential value. Remove it and try again.');
  }
  const placeholder = (host) => /(?:^|\.)(?:example\.(?:com|net|org)|[^.]+\.(?:test|invalid|example))$/i.test(host);
  if (/\blocalhost\b/i.test(decoded)) throw new TodoError('Replace every host with a placeholder such as example.test.');
  for (const match of decoded.matchAll(/(?:\b[a-z][a-z0-9+.-]*:\/\/|(?<![:/\w])\/\/)[^\s<>"'`]+/gi)) {
    let url;
    const value = match[0].startsWith('//') ? `https:${match[0]}` : match[0];
    try { url = new URL(value.replace(/[).,;]+$/, '')); } catch { throw new TodoError('Use a valid URL with a placeholder host.'); }
    if (url.username || url.password) throw new TodoError('A URL must not hold a credential value.');
    if (!['https:', 'http:'].includes(url.protocol) || !placeholder(url.hostname)) throw new TodoError('Replace every host with a placeholder such as example.test.');
  }
  for (const match of decoded.matchAll(/(?<![\w/.-])(?:[a-z0-9][a-z0-9-]*\.)+[a-z0-9-]+(?![\w.-])/gi)) {
    if (!placeholder(match[0]) && !FILE_SUFFIX.test(match[0])) throw new TodoError('Replace every host with a placeholder such as example.test.');
  }
}

function safeLegacyText(value) {
  const text = maskBrowserText(redactSecrets(String(value || '')));
  return scanText('todo.txt', text).length ? '[Private content removed.]' : text;
}

// A stored date makes a restart or a schedule edit safe. Replace only this digest.
export function postTodoDigest(settings = {}, { dir = DATA_DIR, store = openMessageStore({ dir }), clock = Date.now } = {}) {
  if (!settings.digestTime) return null;
  const now = clock();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    ...(settings.timeZone && settings.timeZone !== 'local' ? { timeZone: settings.timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const monday = new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
  if (`${parts.hour}:${parts.minute}` < settings.digestTime) return null;
  return store.mutate((records) => {
    const previous = records.find((item) => item.kind === 'digest' && item.digestSource === 'owner-todo');
    const dates = [...new Set([...(previous?.digestDates || []), previous?.digestDate].filter(Boolean))];
    if (dates.includes(date)) return { records, result: null };
    const { todo: open } = todoView(records, now);
    const line = (item) => `- ${safeLegacyText(item.project)}: ${safeLegacyText(item.title).replace(/\s+/g, ' ')}`;
    const text = [`${open.length} open To do item${open.length === 1 ? '' : 's'}.`, ...open.slice(0, 5).map(line),
      ...(open.length > 5 ? [`${open.length - 5} more items are in To do.`] : []),
      ...(monday ? ['', '## Weekly: oldest open items', ...[...open].sort((a, b) =>
        Date.parse(a.createdAt || a.at) - Date.parse(b.createdAt || b.at) || a.id.localeCompare(b.id)).slice(0, 5).map(line)] : [])].join('\n');
    const record = { id: previous?.id || newId(now), kind: 'digest', digestSource: 'owner-todo', digestDate: date,
      digestDates: [...dates, date].slice(-32),
      thread: 'boss', from: 'boss', to: 'owner', title: 'To do digest', text, action: 'read',
      at: new Date(now).toISOString(), weeklyDate: monday ? date : null,
      status: 'new', readAt: null, closedAt: null, closedBy: null, dismissed: false };
    const kept = records.filter((item) => !(item.kind === 'digest' && item.digestSource === 'owner-todo'));
    kept.push(record);
    return { records: kept, result: record };
  }, { now });
}

export function parseTodoFile(text, { priority, blocks } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > REPORT_MAX_BYTES) throw new TodoError('The To do file must be text of at most 64 KB.');
  publicText(text);
  const sections = proposalSections(text).found;
  if (sections.some((section) => ![...HEADINGS, 'Priority'].includes(section.title))) throw new TodoError('The To do file has an unknown heading. Use only the documented headings.');
  const { values, errors } = requiredProposalSections(text, HEADINGS);
  if (errors.length) throw new TodoError(`The To do file is incomplete:\n- ${errors.join('\n- ')}`);
  if (values.Title.length > 200 || /[\r\n\u0000-\u001f]/.test(values.Title)) throw new TodoError('Title must be one line of 1 to 200 characters.');
  if (!TODO_TYPES.includes(values.Type)) throw new TodoError('Type must be decide, do, check, grant, or read.');
  const optional = requiredProposalSections(text, ['Priority']);
  const hasPriority = sections.some((section) => section.title === 'Priority');
  if (hasPriority && optional.errors.length) throw new TodoError(optional.errors.join('\n'));
  const chosen = priority ?? optional.values.Priority ?? 'normal';
  if (!TODO_PRIORITIES.includes(chosen)) throw new TodoError('Priority must be urgent, high, normal, or low.');
  if (blocks !== undefined && (typeof blocks !== 'string' || !blocks.trim() || blocks.length > 2000)) throw new TodoError('Blocked work must be 1 to 2000 characters.');
  if (blocks !== undefined) publicText(blocks);
  return { title: values.Title, why: values.Why, steps: values.Steps, expectedResult: values['Expected result'], howToAnswer: values['How to answer'], blocks: blocks?.trim() ?? values['What it blocks'], type: values.Type, priority: chosen, text };
}

function todoCaller(command, { env, herdr, control, dir }) {
  let caller;
  try { caller = verifyMessageCaller(env, herdr, command); }
  catch { throw new TodoError(`Run ${command} from a verified Herdr pane labeled boss or orch. The pane ID and workspace must match.`, 403); }
  const projects = (control ?? readControl(dir)).projects || {};
  const project = caller.role === 'boss' ? 'boss' : Object.entries(projects).find(([, item]) => item?.workspace === caller.workspaceId)?.[0];
  if (!project) throw new TodoError('No project uses the verified workspace. Publish its status, then try again.', 403);
  return { caller, project };
}

export function postTodo(text, options = {}, { env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  const { caller, project } = todoCaller('todo post', { env, herdr, control, dir });
  const fields = parseTodoFile(text, options);
  const at = new Date(now).toISOString();
  const key = `${project}:${fields.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const poster = { role: caller.role, pane: caller.paneId, workspace: caller.workspaceId };
  return store.mutate((records) => {
    const posts = records.filter((item) => item.kind === 'todo' && item.project === project).flatMap((item) => item.postedAt || [item.createdAt]);
    if (posts.filter((time) => Date.parse(time) > now - 60000).length >= TODO_POST_LIMIT) throw new TodoError('This project has posted 10 To do items or updates in one minute. Wait, then try again.', 429);
    const existing = records.find((item) => item.kind === 'todo' && item.key === key && todoState(item, now) === 'open');
    if (existing) {
      Object.assign(existing, fields, { poster, updatedAt: at, state: 'open', snoozedUntil: null,
        postedAt: [...(existing.postedAt || [existing.createdAt]).filter((time) => Date.parse(time) > now - 60000), at] });
      return { records, result: existing };
    }
    const record = { id: newId(now), kind: 'todo', thread: project, project, from: caller.role, to: 'owner', key, ...fields, poster, state: 'open', at, createdAt: at, updatedAt: at, postedAt: [at], ownerActions: [] };
    records.push(record);
    return { records, result: record };
  }, { now });
}

export function listTodos({ env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  const { project } = todoCaller('todo list', { env, herdr, control, dir });
  return todoView(store.all(), now).todo
    .filter((item) => item.project === project)
    .map(({ key, type, title, state }) => ({ key, type, title, state }));
}

export function todoStatus(id, { env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  const { project } = todoCaller('todo status', { env, herdr, control, dir });
  if (typeof id !== 'string' || !id.trim()) throw new TodoError('Give a To do item ID.');
  const item = store.all().find((record) => record.kind === 'todo' && record.id === id);
  if (!item) throw new TodoError('This To do item is no longer available.', 404);
  if (item.project !== project) throw new TodoError('Only the verified poster project can read this To do item.', 403);
  const action = [...(item.ownerActions || [])].reverse().find((saved) => saved.action === 'answer');
  const answer = action?.decision ? (action.decision === 'accept' ? 'Accept' : 'Deny') : action?.answer || null;
  return { state: todoState(item, now), answer };
}

export function cancelTodo(key, note = '', { env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  const { project } = todoCaller('todo cancel', { env, herdr, control, dir });
  if (typeof key !== 'string' || !key || typeof note !== 'string' || note.length > 2000) throw new TodoError('Give an item key and an optional note of at most 2000 characters.');
  publicText(note);
  return store.mutate((records) => {
    const items = records.filter((record) => record.kind === 'todo' && record.key === key);
    if (!items.length) throw new TodoError('This To do item is no longer available.', 404);
    if (items.some((item) => item.project !== project)) throw new TodoError('Only the verified poster project can cancel this To do item.', 403);
    const item = items.find((record) => todoState(record, now) === 'open');
    if (!item) throw new TodoError('Only an open To do item can be cancelled.', 409);
    const at = new Date(now).toISOString();
    Object.assign(item, { state: 'cancelled', updatedAt: at, closedAt: at, closedBy: 'poster', cancelNote: note.trim() });
    return { records, result: { ok: true, item } };
  }, { now });
}

export function migrateTodo(_options = {}, { env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  const { caller } = todoCaller('todo migrate', { env, herdr, control, dir });
  if (caller.role !== 'boss') throw new TodoError('Only the Boss can import existing Mailbox asks.', 403);
  const projects = (control ?? readControl(dir)).projects || {};
  const at = new Date(now).toISOString();
  return store.mutate((records) => {
    const answered = new Set(records.filter((record) => record.from === 'owner' && record.replyTo).map((record) => record.replyTo));
    const waiting = records.filter((item) => isMailboxItem(item) && ['answer', 'approve', 'decide'].includes(mailboxAction(item))
      && !item.closedAt && !item.closedBy && !item.dismissed && !answered.has(item.id));
    let imported = 0;
    for (const source of waiting) {
      const project = source.thread;
      const title = safeLegacyText(mailboxTitle(source)) || 'Answer the imported ask';
      const key = `${project}:${title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      let item = records.find((record) => record.kind === 'todo' && record.key === key);
      if (!item) {
        const boss = source.from === 'boss' || project === 'boss';
        const poster = source.poster || (boss ? { role: 'boss', pane: caller.paneId, workspace: caller.workspaceId }
          : { role: 'orch', pane: projects[project]?.orch?.pane || null, workspace: projects[project]?.workspace || null });
        const type = ['approve', 'decide'].includes(mailboxAction(source)) ? 'decide' : 'do';
        item = { id: newId(now), kind: 'todo', thread: project, project, from: source.from, to: 'owner', key, title,
          text: safeLegacyText(source.text), steps: safeLegacyText(source.text), why: 'This open Mailbox item waits for the Owner.',
          expectedResult: 'The Owner action is recorded.', howToAnswer: type === 'decide' ? 'Select Accept or Deny.' : 'Give an answer or select Done.',
          blocks: 'The work named in the original ask.', type, priority: 'normal', poster, state: 'open',
          at: source.at, createdAt: source.at, updatedAt: at, postedAt: [], ownerActions: [], sourceMailboxId: source.id };
        records.push(item);
        imported += 1;
      }
      Object.assign(source, { closedAt: at, readAt: source.readAt || at, closedBy: 'todo', closeNote: 'Moved to To do.', todoId: item.id });
    }
    return { records, result: { ok: true, imported } };
  }, { now });
}

function queueTodoNotice(records, item, action, now) {
  if (!action || action.action === 'reopen') return null;
  if (action.noticeId) return records.find((record) => record.id === action.noticeId) || null;
  const detail = [action.decision, action.until && `until ${action.until}`, action.answer, action.reason].filter(Boolean).map(safeLegacyText).join('; ');
  const notice = { id: newId(now), at: new Date(now).toISOString(), thread: item.project, from: 'owner', to: item.poster?.role || 'orch',
    kind: 'todo-notice', text: `To do: ${safeLegacyText(item.title)} — ${action.action}${detail ? `; ${detail}` : ''}.`, replyTo: item.id,
    todoActionId: action.id, target: item.poster, status: 'queued', attempts: 0 };
  action.noticeId = notice.id;
  records.push(notice);
  return notice;
}

// Queue only the saved action summary. The action keeps its notice ID after message retention.
export function todoOwnerActionRecorded(event, { dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  return store.mutate((records) => {
    const item = records.find((record) => record.kind === 'todo' && record.id === event.id);
    const action = item?.ownerActions?.find((saved) => saved.id === event.actionId);
    return { records, result: queueTodoNotice(records, item, action, now) };
  }, { now });
}

export function actOnTodo(body, { dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now(), onAction = todoOwnerActionRecorded, reply = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') throw new TodoError('Choose a To do item and an action.');
  const { action, decision = null, until = null } = body;
  if (!['done', 'blocked', 'snooze', 'not-now', 'answer', 'reopen'].includes(action)) throw new TodoError('Choose Done, Blocked, Snooze, Not now, Answer, or Reopen.');
  const reason = body.reason === undefined ? '' : typeof body.reason === 'string' ? body.reason.trim() : null;
  if (reason === null || reason.length > 2000 || (['blocked', 'not-now'].includes(action) && !reason)) throw new TodoError('Give a reason of 1 to 2000 characters.');
  publicText(reason);
  const answer = body.answer === undefined ? '' : typeof body.answer === 'string' ? body.answer.trim() : null;
  if (answer === null || answer.length > 2000) throw new TodoError('Answer must be text of at most 2000 characters.');
  publicText(answer);
  if (action === 'answer' && ((decision !== null && !['accept', 'deny'].includes(decision)) || (!decision && !answer))) throw new TodoError('Answer must be Accept, Deny, or nonempty answer text.');
  if (action === 'snooze' && (typeof until !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now)) throw new TodoError('Choose a future time for Snooze.');
  const at = new Date(now).toISOString();
  const event = store.mutate((records) => {
    const item = records.find((record) => record.id === body.id && record.kind === 'todo' && record.to === 'owner');
    if (!item) throw new TodoError('This To do item is no longer available.', 404);
    const state = todoState(item, now);
    if (['done', 'cancelled'].includes(state)) throw new TodoError('This To do item is already closed. Refresh the list.', 409);
    if (body.updatedAt !== undefined && body.updatedAt !== item.updatedAt) throw new TodoError('This To do item changed. Refresh it before answering.', 409);
    if (action === 'answer' && decision && item.type !== 'decide') throw new TodoError('Only a decide item takes Accept or Deny.');
    if (action === 'reopen' && !['blocked', 'snoozed'].includes(state)) throw new TodoError('Only a blocked or snoozed item can reopen.', 409);
    const ownerAction = { id: newId(now), action, at, reason, answer: action === 'answer' ? answer : '', decision: action === 'answer' ? decision : null, until: action === 'snooze' ? new Date(until).toISOString() : null };
    item.state = { done: 'done', answer: 'done', blocked: 'blocked', snooze: 'snoozed', 'not-now': 'cancelled', reopen: 'open' }[action];
    item.updatedAt = new Date(Math.max(now, (Date.parse(item.updatedAt) || 0) + 1)).toISOString();
    item.snoozedUntil = ownerAction.until;
    item.readAt ||= at;
    if (['done', 'cancelled'].includes(item.state)) item.closedAt = at;
    item.ownerActions = [...(item.ownerActions || []), ownerAction];
    const message = reply ? { ...reply, id: newId(now), at, status: 'new' } : null;
    if (message) records.push(message);
    if (onAction === todoOwnerActionRecorded) queueTodoNotice(records, item, ownerAction, now);
    return { records, result: { ...ownerAction, actionId: ownerAction.id, id: item.id, project: item.project, poster: item.poster, item, message } };
  }, { now });
  onAction(event, { dir, store, now });
  return { ok: true, item: event.item, ...(event.message ? { message: event.message } : {}) };
}

// The existing Owner message route supplies validated reply fields.
export function replyToTodo(fields, options = {}) {
  return actOnTodo({ id: fields.replyTo, action: 'answer', answer: fields.text }, { ...options, reply: fields });
}
