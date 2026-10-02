// The width of the answer area of a review item (901 px and wider). It follows the sections column of public/review-sidebar.js.
// The module has no DOM use, so the Node tests import it directly. The width is remembered per browser in localStorage.
// Every storage call is inside try/catch.
export const ANSWER_KEY = 'herdr-boss.review-answer';
export const ANSWER_MIN = 280;
export const ANSWER_DEFAULT = 400;
export const ANSWER_STEP = 16;

// The largest width: 60 % of the viewport. A viewport under 467 px keeps the minimum.
export const answerMax = (viewport) => Math.max(ANSWER_MIN, Math.floor((Number(viewport) || 0) * 0.6));

export function clampAnswer(width, viewport) {
  const value = Number.isFinite(Number(width)) && width !== null && width !== '' ? Math.round(Number(width)) : ANSWER_DEFAULT;
  return Math.min(answerMax(viewport), Math.max(ANSWER_MIN, value));
}

// The width after a key on the handle, or null when the key does nothing. The area is at the right, so ArrowLeft widens it.
export function keyAnswer(width, key, viewport) {
  if (key === 'ArrowLeft') return clampAnswer(width + ANSWER_STEP, viewport);
  if (key === 'ArrowRight') return clampAnswer(width - ANSWER_STEP, viewport);
  if (key === 'Home') return clampAnswer(ANSWER_DEFAULT, viewport);
  return null;
}

// The stored width, or the default for a missing, broken, or unreadable value.
export function loadAnswerWidth(storage) {
  try {
    const value = JSON.parse(storage?.getItem(ANSWER_KEY) ?? 'null');
    if (value && Number.isFinite(value.width)) return Math.max(ANSWER_MIN, Math.round(value.width));
  } catch { /* the default stays */ }
  return ANSWER_DEFAULT;
}

function saveAnswerWidth(storage, width) {
  try { storage?.setItem(ANSWER_KEY, JSON.stringify({ width })); } catch { /* the width lasts until the page closes */ }
}

// The controller of the width. `viewport()` gives the window width, and `apply(width)` shows a change.
export function createAnswerWidth({ storage, viewport, apply = () => {} }) {
  let width = loadAnswerWidth(storage);
  const commit = () => { saveAnswerWidth(storage, width); apply(width); };
  return {
    get: () => clampAnswer(width, viewport()),
    // A drag gives the width in pixels. `final` stores it.
    resize(next, final = true) {
      width = clampAnswer(next, viewport());
      if (final) commit(); else apply(width);
    },
    // Returns true when the key changed the width, so the caller prevents the default action.
    key(key) {
      const next = keyAnswer(clampAnswer(width, viewport()), key, viewport());
      if (next === null) return false;
      width = next;
      commit();
      return true;
    },
    reset() { width = ANSWER_DEFAULT; commit(); },
  };
}

// The handle at the left edge of the answer area. It is a focusable separator with the value of the width.
export function answerHandleHtml(width, viewport) {
  return `<div class="review-answer-resize" role="separator" aria-orientation="vertical" tabindex="0" data-review-answer-resize aria-label="Resize the answer area. Arrow keys change the width. Home resets it."`
    + ` aria-valuemin="${ANSWER_MIN}" aria-valuemax="${answerMax(viewport)}" aria-valuenow="${clampAnswer(width, viewport)}"></div>`;
}
