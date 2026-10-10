// Pure Mailbox projections. A snoozed item opens when its chosen time passes.
export const TODO_TYPES = Object.freeze(['decide', 'do', 'check', 'grant', 'read']);
export const TODO_PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low']);

export function todoState(item, now = Date.now()) {
  return item.state === 'snoozed' && Date.parse(item.snoozedUntil) <= now ? 'open' : item.state;
}

export function todoView(records, now = Date.now()) {
  const items = records.filter((item) => item.kind === 'todo' && item.to === 'owner').map((item) => ({ ...item, state: todoState(item, now) }));
  const order = (a, b) => TODO_PRIORITIES.indexOf(a.priority) - TODO_PRIORITIES.indexOf(b.priority)
    || Date.parse(a.createdAt || a.at) - Date.parse(b.createdAt || b.at) || a.id.localeCompare(b.id);
  return { todo: items.filter((item) => item.state === 'open').sort(order), todoHistory: items.filter((item) => item.state !== 'open').sort(order) };
}
