// The Needs you filter of a review pack page: it shows only the items that the agent could not verify.
// The module has no DOM use, so the Node tests import it directly. The state is kept per pack in localStorage.
// Every storage call is inside try/catch. A missing or broken value gives off.
export const FILTER_KEY = 'herdr-boss.review-needs-you';

export const needsYouCount = (items) => (items || []).filter((item) => item.verifiedBy === 'needs-you').length;

// The items that the page shows. With the filter on, only needs-you items stay, and the open item stays so its pager still works.
export function visibleItems(items, on, currentId) {
  const list = items || [];
  return on ? list.filter((item) => item.verifiedBy === 'needs-you' || item.id === currentId) : list;
}

export function loadFilter(storage, key) {
  try {
    const map = JSON.parse(storage?.getItem(FILTER_KEY) ?? 'null');
    return Boolean(map && typeof map === 'object' && map[key] === true);
  } catch { return false; }
}

export function saveFilter(storage, key, on) {
  try {
    let map = {};
    try { const stored = JSON.parse(storage?.getItem(FILTER_KEY) ?? 'null'); if (stored && typeof stored === 'object') map = stored; } catch { /* a broken value restarts */ }
    if (on) map[key] = true; else delete map[key];
    storage?.setItem(FILTER_KEY, JSON.stringify(map));
  } catch { /* the choice lasts until the page closes */ }
}
