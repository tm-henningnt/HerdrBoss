// The width and the collapse state of the sections column of a review pack page (900 px and wider).
// The module has no DOM use, so the Node tests import it directly. public/app.js connects it to the page.
// The state is remembered per browser in localStorage. Every storage call is inside try/catch.
export const SIDEBAR_KEY = 'herdr-boss.review-sidebar';
export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_STEP = 16;
export const SIDEBAR_RAIL = 44;

// The largest width: half of the viewport. A viewport under 400 px keeps the minimum.
export const sidebarMax = (viewport) => Math.max(SIDEBAR_MIN, Math.floor((Number(viewport) || 0) / 2));

export function clampWidth(width, viewport) {
  const value = Number.isFinite(Number(width)) ? Math.round(Number(width)) : SIDEBAR_DEFAULT;
  return Math.min(sidebarMax(viewport), Math.max(SIDEBAR_MIN, value));
}

// The width after a key on the handle, or null when the key does nothing. ArrowLeft and ArrowRight move by 16 px. Home resets.
export function keyWidth(width, key, viewport) {
  if (key === 'ArrowLeft') return clampWidth(width - SIDEBAR_STEP, viewport);
  if (key === 'ArrowRight') return clampWidth(width + SIDEBAR_STEP, viewport);
  if (key === 'Home') return clampWidth(SIDEBAR_DEFAULT, viewport);
  return null;
}

// { width, collapsed } from the storage. A missing, broken, or unreadable value gives the default.
export function loadSidebar(storage) {
  const state = { width: SIDEBAR_DEFAULT, collapsed: false };
  try {
    const value = JSON.parse(storage?.getItem(SIDEBAR_KEY) ?? 'null');
    if (value && typeof value === 'object') {
      if (Number.isFinite(value.width)) state.width = Math.max(SIDEBAR_MIN, Math.round(value.width));
      if (value.collapsed === true) state.collapsed = true;
    }
  } catch { /* the default stays */ }
  return state;
}

export function saveSidebar(storage, state) {
  try { storage?.setItem(SIDEBAR_KEY, JSON.stringify({ width: state.width, collapsed: state.collapsed })); } catch { /* the width lasts until the page closes */ }
}

// The controller of the column. `viewport()` gives the window width, and `apply(state)` shows a change.
export function createSidebar({ storage, viewport, apply = () => {} }) {
  const state = loadSidebar(storage);
  const commit = () => { saveSidebar(storage, state); apply({ ...state }); };
  return {
    get: () => ({ ...state, width: clampWidth(state.width, viewport()) }),
    // A drag gives the width in pixels. `final` stores it.
    resize(width, final = true) {
      state.width = clampWidth(width, viewport());
      if (final) commit(); else apply({ ...state });
    },
    // Returns true when the key changed the width, so the caller prevents the default action.
    key(key) {
      const next = keyWidth(clampWidth(state.width, viewport()), key, viewport());
      if (next === null) return false;
      state.width = next;
      commit();
      return true;
    },
    collapse(collapsed) { state.collapsed = Boolean(collapsed); commit(); },
  };
}

// The handle between the column and the main pane. It is a focusable separator with the value of the width.
export function sidebarHandleHtml(width, viewport) {
  const max = sidebarMax(viewport);
  return `<div class="review-resize" role="separator" aria-orientation="vertical" tabindex="0" data-review-resize aria-label="Resize the sections column. Arrow keys change the width. Home resets it."`
    + ` aria-valuemin="${SIDEBAR_MIN}" aria-valuemax="${max}" aria-valuenow="${clampWidth(width, viewport)}"></div>`;
}
