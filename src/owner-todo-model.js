// Pure Mailbox projections. A snoozed item opens when its chosen time passes.
export const TODO_TYPES = Object.freeze(['decide', 'do', 'check', 'grant', 'read']);
export const TODO_PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low']);

export function validateTodoDigestSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['ownerTodo must be an object.'];
  const errors = [];
  if (value.digestTime !== null && (typeof value.digestTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.digestTime))) {
    errors.push('ownerTodo.digestTime must be null or a time in HH:MM format.');
  }
  let validZone = typeof value.timeZone === 'string' && value.timeZone.length <= 100;
  if (validZone && value.timeZone !== 'local') {
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { validZone = false; }
  }
  if (!validZone) errors.push('ownerTodo.timeZone must be local or a valid time zone name.');
  if (typeof value.notify !== 'boolean') errors.push('ownerTodo.notify must be boolean.');
  return errors;
}

export function todoState(item, now = Date.now()) {
  return item.state === 'snoozed' && Date.parse(item.snoozedUntil) <= now ? 'open' : item.state;
}

export function todoView(records, now = Date.now()) {
  const items = records.filter((item) => item.kind === 'todo' && item.to === 'owner').map((item) => ({ ...item, state: todoState(item, now) }));
  const order = (a, b) => TODO_PRIORITIES.indexOf(a.priority) - TODO_PRIORITIES.indexOf(b.priority)
    || Date.parse(a.createdAt || a.at) - Date.parse(b.createdAt || b.at) || a.id.localeCompare(b.id);
  return { todo: items.filter((item) => item.state === 'open').sort(order), todoHistory: items.filter((item) => item.state !== 'open').sort(order) };
}
