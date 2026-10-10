import { DATA_DIR } from './config.js';
import { openMessageStore, newId } from './message-store.js';
import { verifyMessageCaller, readControl, REPORT_MAX_BYTES } from './messages.js';
import { requiredProposalSections, proposalSections } from './kit/proposal.js';
import { redactSecrets } from './redact.js';
import { scanText } from './secret-scan.js';
import { redactBrowserSecrets } from './browser-url-mask.js';
import { TODO_TYPES, TODO_PRIORITIES, todoState } from './owner-todo-model.js';

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

export function postTodo(text, options = {}, { env = process.env, herdr, control, dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now() } = {}) {
  let caller;
  try { caller = verifyMessageCaller(env, herdr, 'todo post'); }
  catch { throw new TodoError('Run todo post from a verified Herdr pane labeled boss or orch. The pane ID and workspace must match.', 403); }
  const projects = (control ?? readControl(dir)).projects || {};
  const project = caller.role === 'boss' ? 'boss' : Object.entries(projects).find(([, item]) => item?.workspace === caller.workspaceId)?.[0];
  if (!project) throw new TodoError('No project uses the verified workspace. Publish its status, then try again.', 403);
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

// Slice (b) attaches notice delivery here. The action is already in the store.
export function todoOwnerActionRecorded(_event) {}

export function actOnTodo(body, { dir = DATA_DIR, store = openMessageStore({ dir }), now = Date.now(), onAction = todoOwnerActionRecorded } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') throw new TodoError('Choose a To do item and an action.');
  const { action, decision = null, until = null } = body;
  if (!['done', 'blocked', 'snooze', 'not-now', 'answer', 'reopen'].includes(action)) throw new TodoError('Choose Done, Blocked, Snooze, Not now, Answer, or Reopen.');
  const reason = body.reason === undefined ? '' : typeof body.reason === 'string' ? body.reason.trim() : null;
  if (reason === null || reason.length > 2000 || (['blocked', 'not-now'].includes(action) && !reason)) throw new TodoError('Give a reason of 1 to 2000 characters.');
  publicText(reason);
  if (action === 'answer' && !['accept', 'deny'].includes(decision)) throw new TodoError('Answer must be Accept or Deny.');
  if (action === 'snooze' && (typeof until !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now)) throw new TodoError('Choose a future time for Snooze.');
  const at = new Date(now).toISOString();
  const event = store.mutate((records) => {
    const item = records.find((record) => record.id === body.id && record.kind === 'todo' && record.to === 'owner');
    if (!item) throw new TodoError('This To do item is no longer available.', 404);
    const state = todoState(item, now);
    if (['done', 'cancelled'].includes(state)) throw new TodoError('This To do item is already closed. Refresh the list.', 409);
    if (body.updatedAt !== undefined && body.updatedAt !== item.updatedAt) throw new TodoError('This To do item changed. Refresh it before answering.', 409);
    if (action === 'answer' && item.type !== 'decide') throw new TodoError('Only a decide item takes Accept or Deny.');
    if (action === 'reopen' && !['blocked', 'snoozed'].includes(state)) throw new TodoError('Only a blocked or snoozed item can reopen.', 409);
    const ownerAction = { action, at, reason, decision: action === 'answer' ? decision : null, until: action === 'snooze' ? new Date(until).toISOString() : null };
    item.state = { done: 'done', answer: 'done', blocked: 'blocked', snooze: 'snoozed', 'not-now': 'cancelled', reopen: 'open' }[action];
    item.updatedAt = at;
    item.snoozedUntil = ownerAction.until;
    item.readAt ||= at;
    if (['done', 'cancelled'].includes(item.state)) item.closedAt = at;
    item.ownerActions = [...(item.ownerActions || []), ownerAction];
    return { records, result: { ...ownerAction, id: item.id, project: item.project, poster: item.poster, item } };
  }, { now });
  onAction(event);
  return { ok: true, item: event.item };
}
