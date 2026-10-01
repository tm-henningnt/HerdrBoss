function minuteAge(value) {
  return Number.isFinite(value) && value >= 0 ? `${Math.floor(value)} min ago` : 'age unknown';
}

export function unplannedCardView(worker = {}, index = 0) {
  const name = String(worker.name || 'Unnamed worker');
  const startedAt = String(worker.startedAt || 'unknown start');
  const pane = String(worker.pane || index);
  return {
    key: `unplanned:${name}:${startedAt}:${pane}`,
    name,
    kind: String(worker.kind || 'Unknown kind'),
    model: String(worker.model || 'Unknown model'),
    age: minuteAge(worker.ageMin),
  };
}

export function noWorkerBadgeView(task) {
  return task?.noWorker === true ? { text: 'No worker', tone: 'warn' } : null;
}

export function publishedAgeBadgeView(ageMin, staleLevel) {
  return { text: `status published ${minuteAge(ageMin)}`, tone: staleLevel === 'warn' ? 'warn' : 'plain' };
}

export function phaseAgeText(ageMin) {
  return `phase updated ${minuteAge(ageMin)}`;
}

export function summaryAgeText(ageMin) {
  return `summary updated ${minuteAge(ageMin)}`;
}

export function projectSyncLineView(sync) {
  return {
    text: typeof sync?.text === 'string' ? sync.text : '',
    tone: sync?.inSync === false ? 'warn' : 'plain',
  };
}
