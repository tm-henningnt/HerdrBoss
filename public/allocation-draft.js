// Pure logic of the Allocation form: the draft shares, the save check, and the total line.
// A share that the policy holds is always shown as it is. Only a project without an entry gets a default share.

const clean = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

export function shareTotal(shares, slugs) {
  return slugs.reduce((sum, slug) => sum + (shares[slug] || 0), 0);
}

// Return { shares, defaults, sum }. defaults lists the projects that have no saved share.
// A missing project takes a part of the room that is left (100 minus the saved shares, at least 0).
export function buildDraftShares(slugs, policyProjects = {}) {
  const shares = {};
  const missing = [];
  for (const slug of slugs) {
    const saved = policyProjects[slug]?.share;
    if (clean(saved)) shares[slug] = saved;
    else missing.push(slug);
  }
  const room = Math.max(0, 100 - Object.values(shares).reduce((sum, share) => sum + share, 0));
  missing.forEach((slug, i) => { shares[slug] = Math.floor(room / missing.length) + (i < room % missing.length ? 1 : 0); });
  const ordered = Object.fromEntries(slugs.map((slug) => [slug, shares[slug]]));
  return { shares: ordered, defaults: missing, sum: shareTotal(ordered, slugs) };
}

// A string that changes when the project set or a saved share changes.
export function draftSignature(slugs, policyProjects = {}) {
  return JSON.stringify(slugs.map((slug) => [slug, policyProjects[slug]?.share ?? null]));
}

// Add the remainder to the largest share. The first of equal shares wins. The input stays as it is.
// fixed is the total of the shares that the form does not edit.
export function distributeRemainder(shares, slugs, fixed = 0) {
  const out = { ...shares };
  const remaining = 100 - fixed - shareTotal(out, slugs);
  if (remaining <= 0 || !slugs.length) return out;
  const largest = slugs.reduce((best, slug) => ((out[slug] || 0) > (out[best] || 0) ? slug : best), slugs[0]);
  out[largest] = (out[largest] || 0) + remaining;
  return out;
}

// Move the boundary after project index to position. The projects to its right share the rest (largest remainder method).
// fixed is the total of the shares that the form does not edit. A move while the total is above 100 changes nothing.
export function moveShares(shares, slugs, index, position, fixed = 0) {
  const out = { ...shares };
  const budget = 100 - fixed;
  if (index < 0 || index >= slugs.length - 1 || shareTotal(out, slugs) > budget) return out;
  const left = slugs.slice(0, index).reduce((sum, slug) => sum + out[slug], 0);
  const share = Math.max(0, Math.min(budget - left, Math.round(position) - left));
  const right = slugs.slice(index + 1);
  const remaining = Math.max(0, budget - left - share);
  const total = right.reduce((sum, slug) => sum + out[slug], 0);
  const parts = right.map((slug, order) => ({ slug, order, raw: remaining * (total ? out[slug] / total : 1 / right.length) }));
  out[slugs[index]] = share;
  let spare = remaining;
  for (const part of parts) { out[part.slug] = Math.floor(part.raw); spare -= Math.floor(part.raw); }
  parts.sort((a, b) => (b.raw % 1) - (a.raw % 1) || a.order - b.order);
  for (let i = 0; i < spare; i++) out[parts[i].slug]++;
  return out;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The line next to the bar. The button shows only when the total is below 100.
export function totalHtml(total) {
  const remaining = 100 - total;
  const warning = total > 100 ? ' over' : '';
  const alert = total > 100 ? ' role="alert"' : '';
  const note = total > 100 ? '. The total must be 100 or less. Lower a share before you apply the policy.' : '';
  const button = remaining > 0 ? `<button type="button" class="quiet" data-distribute-remaining>Distribute the remaining ${remaining}</button>` : '';
  return `<span class="allocation-total-text${warning}"${alert}>Total ${total} of 100${escapeHtml(note)}</span>${button}`;
}

// Decide what the save does with the shares in the form.
// loaded is the projects object of the policy from the server. touched lists the projects whose share the user changed.
// boundaries is the number of different boundaries that the user moved. otherChanged is true when the form has a change outside the shares.
// Return { action: 'save' | 'refuse' | 'confirm', message?, rows?, confirmSum? }. A row is { slug, old, next }. old is null for a project without a saved share.
// confirmSum is true when a share changes and the total is not 100. The save then needs a second confirmation and sends allowSum: true.
// The server refuses a change of 3 or more shares without confirmed: true, so the save shows the dialog for it.
// fixed maps the projects that the form shows but does not edit to their share. They count in the total and never change.
export function checkSave({ slugs, loaded = {}, shares, defaults = [], touched = [], boundaries = 0, otherChanged = false, fixed = {} }) {
  if (slugs.some((slug) => !clean(shares[slug]))) return { action: 'refuse', message: 'A share is not a whole number from 0 to 100. Reload the shares.' };
  const total = shareTotal(shares, slugs) + Object.values(fixed).reduce((sum, share) => sum + share, 0);
  if (total > 100) return { action: 'refuse', message: `The shares add up to ${total}. The total must be 100 or less. Lower a share, then apply the policy.` };
  const touchedSet = new Set(touched);
  const untouched = defaults.filter((slug) => !touchedSet.has(slug));
  const oldOf = (slug) => (clean(loaded[slug]?.share) ? loaded[slug].share : null);
  const rows = [...slugs.map((slug) => ({ slug, old: oldOf(slug), next: shares[slug] })), ...Object.entries(fixed).map(([slug, share]) => ({ slug, old: share, next: share }))];
  const changed = rows.filter((row) => row.old !== row.next);
  const sharesChanged = changed.some((row) => !untouched.includes(row.slug));
  if (untouched.length && !sharesChanged && !otherChanged) {
    return { action: 'refuse', message: `${untouched.join(', ')} ${untouched.length === 1 ? 'has' : 'have'} a default share that is not saved. Change a share first, or set the share on purpose.` };
  }
  const oldTotal = rows.reduce((sum, row) => sum + (row.old ?? 0), 0);
  const needsConfirm = untouched.length > 0
    || Math.abs(total - oldTotal) > 5
    || (changed.length > 1 && boundaries > 1)
    || changed.length >= 3;
  const confirmSum = changed.length > 0 && total !== 100;
  return { action: needsConfirm ? 'confirm' : 'save', rows, ...(confirmSum ? { confirmSum: true } : {}) };
}

export function confirmText(rows) {
  const oldTotal = rows.reduce((sum, row) => sum + (row.old ?? 0), 0);
  const newTotal = rows.reduce((sum, row) => sum + row.next, 0);
  const lines = rows.map((row) => `${row.slug}: ${row.old === null ? 'not saved' : `${row.old}%`} -> ${row.next}%`);
  return `Apply these project shares?\n\n${lines.join('\n')}\n\nTotal: ${oldTotal}% -> ${newTotal}%`;
}

// The second confirmation for a total other than 100. The server saves it only with allowSum: true.
export function sumConfirmText(total) {
  return `The project shares add up to ${total}, not 100.\n\nSave this total anyway?`;
}

// The lines under the bar: the total, and the line that offers a reload when the server policy changed.
export function allocationFooterHtml(total, stale) {
  const reload = stale ? '<div class="allocation-stale" role="status"><span>The policy changed on the server. Reload the shares?</span><button type="button" class="quiet" data-reload-shares>Reload the shares</button></div>' : '';
  return `<div class="allocation-total" data-allocation-total>${totalHtml(total)}</div>${reload}`;
}

// A row for a project that the policy holds and the project list does not. The share is read-only.
export function staleRowHtml(slug, share) {
  return `<div class="allocation-row stale" data-stale-row="${escapeHtml(slug)}"><div class="allocation-name"><b>${escapeHtml(slug)}</b><small>not in the project list</small></div><div class="share-values"><span><small>Set</small><strong class="num">${share}%</strong></span></div></div>`;
}
