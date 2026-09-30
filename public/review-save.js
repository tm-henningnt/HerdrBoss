// The answer saves of the review item viewer, the repeat-tap guard, and the Viewed timer.
// See docs/ideas/review-packs.md, section Autosave and offline. The module has no DOM use: the page passes fetch,
// the clock, and the document, so the Node tests run it against a real server. public/app.js calls it through
// saveItemAnswer(). RP8 wraps that function with the autosave queue.
//
// The state is the state of the page: `entry.data` is the loaded pack, and `vui` is the view state of one item
// (rev, status, error, conflict, note, pinText, and pending: the count of running saves for each answer field).
import { reviewErrorText } from './review.js';

export const REPEAT_TAP_MS = 400;
export const ANSWER_EMPTY = Object.freeze({ decision: null, choice: null, rating: null, live: null, viewed: false, note: '', pins: [], checks: {}, rev: 0 });
export const CONFLICT_UNLOADED = 'The answer changed on another device, and the page could not load it. Reload the page.';

const enc = encodeURIComponent;
export const itemAnswerUrl = (route, id) => `/api/reviews/${enc(route.slug)}/${enc(route.pack)}/items/${enc(id)}`;
export const packUrl = (route) => `/api/reviews/${enc(route.slug)}/${enc(route.pack)}`;

// options: fetch, base (the origin for a test; empty in the page), onChange (render), reload (load the pack again).
export function createItemSaver({ fetch, base = '', onChange = () => {}, reload = () => {} } = {}) {
  if (typeof fetch !== 'function') throw new TypeError('createItemSaver needs a fetch function.');
  const chains = new Map();

  // A failed request throws a plain sentence with the status and the body. The network-layer text never shows.
  async function request(url, options) {
    let response;
    try { response = await fetch(base + url, options); } catch { throw Object.assign(new Error(reviewErrorText({ network: true })), { status: 0, body: null }); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(reviewErrorText({ status: response.status, body })), { status: response.status, body });
    return body;
  }

  const find = (entry, id) => entry.data?.items?.find((item) => item.id === id) || null;

  // A 409 names the stored answer of the other device. Without it, the saver loads the pack again: it never sends rev 0 on a guess.
  async function conflict({ route, vui, itemId, patch, body }) {
    let theirs = body.current;
    if (theirs === undefined || theirs === null) {
      try {
        const pack = await request(packUrl(route));
        theirs = pack?.items?.find((item) => item.id === itemId)?.answer ?? null;
      } catch {
        vui.conflict = null;
        vui.status = '';
        vui.error = CONFLICT_UNLOADED;
        return;
      }
    }
    vui.conflict = { mine: { ...vui.conflict?.mine, ...patch }, theirs };
    vui.rev = theirs?.rev ?? 0;
    vui.status = '';
  }

  // Save one change: show it at once, then send it with the rev of the item. The saves of one item run one after the other,
  // so each save sends the rev that the save before it got. A quiet save shows no status and no error.
  function save({ route, entry, vui, itemId, patch, quiet = false }) {
    const shown = find(entry, itemId);
    if (shown) shown.answer = { ...ANSWER_EMPTY, ...shown.answer, ...patch };
    const fields = Object.keys(patch);
    vui.pending ||= {};
    for (const field of fields) vui.pending[field] = (vui.pending[field] || 0) + 1;
    if (!quiet) { vui.status = 'Saving…'; vui.error = ''; }
    onChange();
    const run = async () => {
      const latest = find(entry, itemId);
      const rev = Math.max(vui.rev || 0, latest?.answer?.rev || 0);
      try {
        const saved = await request(itemAnswerUrl(route, itemId), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...patch, rev }) });
        const now = find(entry, itemId);
        if (now) now.answer = saved.answer;
        vui.rev = saved.answer?.rev ?? rev;
        if (!quiet || vui.status) vui.status = 'Saved';
        vui.error = '';
      } catch (error) {
        if (error.status === 409 && error.body?.conflict) await conflict({ route, vui, itemId, patch, body: error.body });
        else if (!quiet) {
          // The typed note and pin notes stay in vui.note and vui.pinText. Only a successful save or Use theirs clears them.
          vui.error = error.message;
          vui.status = '';
        }
      } finally {
        for (const field of fields) if ((vui.pending[field] -= 1) <= 0) delete vui.pending[field];
      }
      reload();
      onChange();
    };
    const key = `${route.slug}/${route.pack}/${itemId}`;
    const next = (chains.get(key) || Promise.resolve()).then(run);
    chains.set(key, next.catch(() => {}));
    return next;
  }

  // Keep mine: send my change again with the rev of the other answer.
  function keepMine({ route, entry, vui, itemId }) {
    if (!vui.conflict) return Promise.resolve();
    const mine = vui.conflict.mine;
    vui.conflict = null;
    return save({ route, entry, vui, itemId, patch: mine });
  }

  // Use theirs: show the other answer and drop my drafts.
  function useTheirs({ entry, vui, itemId }) {
    if (!vui.conflict) return;
    const item = find(entry, itemId);
    if (item) item.answer = vui.conflict.theirs;
    if (vui.conflict.theirs?.rev !== undefined) vui.rev = vui.conflict.theirs.rev;
    Object.assign(vui, { conflict: null, note: null, pinText: {}, status: '', error: '' });
    onChange();
  }

  return { save, keepMine, useTheirs };
}

// A second identical tap within REPEAT_TAP_MS is a repeat: a double tap on Accept must not send accept and then null.
export function createTapGuard({ now = () => Date.now(), ms = REPEAT_TAP_MS } = {}) {
  let last = null;
  return (key) => {
    const at = now();
    const repeat = last !== null && last.key === key && at - last.at < ms;
    last = { key, at };
    return repeat;
  };
}

// The Viewed mark: call onViewed after `ms` of time with the page visible. A hidden page stops the count.
// It returns stop(), which ends the count without the call.
export function startViewedTimer({ doc, ms, onViewed, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let spent = 0;
  let since = 0;
  let timer = null;
  let ended = false;
  const end = () => { ended = true; doc.removeEventListener('visibilitychange', change); };
  const fire = () => { timer = null; end(); onViewed(); };
  const run = () => {
    if (ended || timer !== null || doc.visibilityState !== 'visible') return;
    since = now();
    timer = setTimer(fire, Math.max(0, ms - spent));
  };
  const pause = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
    spent += now() - since;
  };
  function change() { if (doc.visibilityState === 'visible') run(); else pause(); }
  doc.addEventListener('visibilitychange', change);
  run();
  return () => { pause(); end(); };
}
