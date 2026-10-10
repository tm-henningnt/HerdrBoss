const PRIORITY_ORDER = Object.freeze({ high: 0, normal: 1, low: 2 });
const ACTIVITY_UNITS = Object.freeze([
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function activityTime(record) {
  const time = Date.parse(record?.lastActivityAt || '');
  return Number.isFinite(time) ? time : 0;
}

export function projectActivityAge(value, now = Date.now()) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return 'No activity yet';
  const elapsed = Math.max(0, now - at);
  for (const [unit, size] of ACTIVITY_UNITS) {
    const count = Math.floor(elapsed / size);
    if (count > 0) return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  }
  return 'Just now';
}

function activityLabel(record) {
  const age = projectActivityAge(record?.lastActivityAt);
  return age === 'No activity yet' ? age : `Last active ${age}`;
}

function priorityRank(record) {
  return PRIORITY_ORDER[record?.priority] ?? PRIORITY_ORDER.normal;
}

export function filterProjectRegister(projects, filters = {}) {
  const query = String(filters.query ?? '').trim().toLocaleLowerCase();
  const group = String(filters.group ?? 'all');
  const state = String(filters.state ?? 'all');
  const sort = String(filters.sort ?? 'activity');
  const rows = Array.isArray(projects) ? projects : [];
  const result = rows.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    if (group !== 'all' && String(record.group ?? '') !== group) return false;
    if (state !== 'all' && !(state === 'open' ? ['open', 'parking'].includes(String(record.state ?? '')) : String(record.state ?? '') === state)) return false;
    if (!query) return true;
    const haystack = [record.slug, record.title, record.group, record.clientTag, record.nextAction, record.notes]
      .map((value) => String(value ?? '').toLocaleLowerCase()).join('\n');
    return haystack.includes(query);
  });
  return result.sort((left, right) => {
    if (sort === 'priority') return priorityRank(left) - priorityRank(right) || compareText(left.title || left.slug, right.title || right.slug);
    if (sort === 'title') return compareText(left.title || left.slug, right.title || right.slug) || compareText(left.slug, right.slug);
    return activityTime(right) - activityTime(left) || compareText(left.title || left.slug, right.title || right.slug);
  });
}

export function reconcileProjectSelection(projects, filters, selected) {
  const visible = new Set(filterProjectRegister(projects, filters).map((record) => String(record.slug ?? '')));
  return [...new Set((Array.isArray(selected) ? selected : []).map(String))].filter((slug) => visible.has(slug));
}

function countState(records, state) {
  return records.filter((record) => record?.state === state).length;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function registerRow(record, selected, canWrite) {
  const slug = String(record.slug ?? '');
  const href = `/projects/${encodeURIComponent(slug)}`;
  const title = String(record.title || slug);
  const state = String(record.state || 'parked');
  const action = state === 'open' ? 'park' : state === 'parked' ? 'open' : state === 'archived' ? 'unarchive' : null;
  const actionLabel = action === 'park' ? 'Park' : action === 'open' ? 'Open' : action === 'unarchive' ? 'Unarchive' : 'Parking…';
  const actionDisabled = !canWrite || !action;
  const clientTag = record.clientTag ? `<span class="register-client-tag">${escapeHtml(record.clientTag)}</span>` : '';
  const pin = state === 'open'
    ? `<button type="button" class="register-pin" data-register-pin="${escapeHtml(slug)}" aria-pressed="${record.pinned ? 'true' : 'false'}" aria-label="${record.pinned ? 'Unpin' : 'Pin'} ${escapeHtml(title)}"${canWrite ? '' : ' disabled'}>${record.pinned ? 'Pinned' : 'Pin'}</button>`
    : '';
  const activity = escapeHtml(activityLabel(record));
  return `<article class="register-row" data-register-row="${escapeHtml(slug)}" data-register-state="${escapeHtml(state)}">
    <label class="register-select"><input type="checkbox" data-register-select="${escapeHtml(slug)}" aria-label="Select ${escapeHtml(title)}"${selected.has(slug) ? ' checked' : ''}></label>
    <div class="register-project-name"><a href="${escapeHtml(href)}">${escapeHtml(title)}</a><span class="register-slug">${escapeHtml(slug)}</span></div>
    <div class="register-group"><span class="register-area">${escapeHtml(record.group || 'No area')}</span>${clientTag}</div>
    <span class="register-factory">${escapeHtml(record.factory || 'Local factory')}</span>
    <span class="register-priority priority-${escapeHtml(record.priority || 'normal')}">${escapeHtml(record.priority || 'normal')}</span>
    <span class="register-next-action">${escapeHtml(record.nextAction || 'No next action')}</span>
    <time class="register-activity"${record.lastActivityAt ? ` datetime="${escapeHtml(record.lastActivityAt)}"` : ''}>${activity}</time>
    <div class="register-row-actions">${pin}<button type="button" class="quiet"${action ? ` data-register-action="${action}" data-register-slug="${escapeHtml(slug)}"` : ''}${actionDisabled ? ' disabled' : ''}>${actionLabel}</button></div>
  </article>`;
}

function registerRows(records, selected, canWrite) {
  return records.length ? records.map((record) => registerRow(record, selected, canWrite)).join('')
    : '<p class="register-empty">No projects match these filters.</p>';
}

export function renderProjectRegister(projects, {
  filters = {}, selected = [], folds = {}, canWrite = false, feedback = '',
} = {}) {
  const records = Array.isArray(projects) ? projects.filter((record) => record && typeof record === 'object') : [];
  const filtered = filterProjectRegister(records, filters);
  const selectedSet = new Set(selected.map(String));
  const groups = [...new Set(records.map((record) => String(record.group || '')).filter(Boolean))].sort(compareText);
  const selectedCount = selectedSet.size;
  const open = filtered.filter((record) => record.state === 'open' || record.state === 'parking');
  const parked = filtered.filter((record) => record.state === 'parked');
  const archived = filtered.filter((record) => record.state === 'archived');
  const allOpen = records.filter((record) => record.state === 'open');
  const pinned = filterProjectRegister(allOpen.filter((record) => record.pinned), { sort: 'activity' }).slice(0, 3);
  const groupValue = String(filters.group ?? 'all');
  const stateValue = String(filters.state ?? 'all');
  const sortValue = String(filters.sort ?? 'activity');
  const filterControls = `<label>Area<select data-register-group>${option('all', 'All areas', groupValue)}${groups.map((name) => option(name, name, groupValue)).join('')}</select></label>
      <label>State<select data-register-state>${option('all', 'All states', stateValue)}${[['open', 'Open'], ['parked', 'Parked'], ['archived', 'Archived']].map(([value, label]) => option(value, label, stateValue)).join('')}</select></label>
      <label>Sort<select data-register-sort>${[['activity', 'Last activity'], ['priority', 'Priority'], ['title', 'Title']].map(([value, label]) => option(value, label, sortValue)).join('')}</select></label>`;
  const openFold = (name) => folds[name] === true || stateValue === name || Boolean(String(filters.query ?? '').trim() && (name === 'parked' ? parked.length : archived.length));

  return `<section class="project-register" aria-label="Project register">
    <div class="register-toolbar" role="search">
      <label class="register-search">Search projects<input type="search" data-register-search value="${escapeHtml(filters.query ?? '')}" placeholder="Name, area, client, next action"></label>
      <div class="register-desktop-filters">${filterControls}</div>
      <details class="register-filter-sheet"><summary>Filter</summary><div class="register-filter-options">${filterControls}<button type="button" data-register-filter-done>Done</button></div></details>
    </div>
    ${pinned.length ? `<section class="register-focus" aria-label="Pinned projects"><div class="register-section-title"><h2>Pinned projects</h2><span>${pinned.length} of 3</span></div><div class="register-focus-cards">${pinned.map((record) => `<a class="register-focus-card" href="/projects/${encodeURIComponent(record.slug)}"><strong>${escapeHtml(record.title || record.slug)}</strong><span>${escapeHtml(record.group || 'No area')}${record.clientTag ? ` · ${escapeHtml(record.clientTag)}` : ''}</span><small>${escapeHtml(record.nextAction || 'No next action')}</small><time class="register-focus-activity"${record.lastActivityAt ? ` datetime="${escapeHtml(record.lastActivityAt)}"` : ''}>${escapeHtml(activityLabel(record))}</time></a>`).join('')}</div></section>` : ''}
    <div class="register-bulk${selectedCount ? ' is-selected' : ''}" aria-label="Selected project actions">
      <span>${selectedCount ? `${selectedCount} selected` : 'Select projects for bulk actions'}</span>
      ${[['open', 'Open'], ['park', 'Park'], ['archive', 'Archive']].map(([action, label]) => `<button type="button" data-register-bulk="${action}"${canWrite && selectedCount ? '' : ' disabled'}>${label}</button>`).join('')}
    </div>
    <section class="register-state-section" aria-labelledby="register-open-title"><div class="register-section-title"><h2 id="register-open-title">Open projects</h2><span>${countState(records, 'open') + countState(records, 'parking')}</span></div><div class="register-list">${registerRows(open, selectedSet, canWrite)}</div></section>
    <details class="register-fold" data-register-fold="parked"${openFold('parked') ? ' open' : ''}><summary>Parked (${countState(records, 'parked')}) <span>Projects keep their status and work while parked.</span></summary><div class="register-list">${registerRows(parked, selectedSet, canWrite)}</div></details>
    ${countState(records, 'archived') ? `<details class="register-fold" data-register-fold="archived"${openFold('archived') ? ' open' : ''}><summary>Archived (${countState(records, 'archived')})</summary><div class="register-list">${registerRows(archived, selectedSet, canWrite)}</div></details>` : ''}
    ${records.length ? '' : '<p class="register-empty">No projects are registered yet. Import existing projects or add one with the project register command.</p>'}
    <p class="register-feedback" role="status" aria-live="polite">${escapeHtml(feedback)}</p>
  </section>`;
}
