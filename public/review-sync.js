// The autosave queue of the review pages. See docs/ideas/review-packs.md, section Autosave and offline.
// Every answer change and every pack note change goes into one queue for each pack. The queue coalesces the changes of
// one item into one patch, sends one write at a time, and gives each write an opId, so a retry after a lost response
// never applies twice. A failed write (network error, 5xx, 429) stays in the queue and in localStorage, and the queue
// tries again after 2, 4, 8, and 16 seconds, then every 30 seconds, and at once on retryNow() (the page calls it on the
// online event, on focus, and on Retry). A 401 stops the queue until retryNow(). A 400, 403, or 413 drops that patch.
// A 409 gives a conflict: the item asks Keep mine or Use theirs, and the patches that waited offline ask once for the pack.
// Before a flush after a network error or a reload, the queue reads the pack: a closed pack gets no write, and a newer
// version gets a queued patch only when the item hash is the same.
//
// The module has no DOM use. The page passes fetch, the storage, and the timers, so the Node tests use fakes.
// localStorage holds only the patches, the opIds, the revs, and the item hashes, under one key for each pack version.

export const QUEUE_PREFIX = 'herdr-boss.review-queue:';
export const QUEUE_LIMIT_BYTES = 200 * 1024;
export const NOTE_DEBOUNCE_MS = 600;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const OP_ID_MAX = 100;
const CONFLICT_UNLOADED = 'The answer changed on another device, and the page could not load it. Reload the page.';
const TOO_LARGE = 'The waiting changes are too large to keep in this browser. Keep this page open until they save.';
const NO_STORAGE = 'This browser cannot keep the waiting changes. Keep this page open until they save.';

const enc = encodeURIComponent;
export const queueKey = (slug, pack, version) => `${QUEUE_PREFIX}${slug}/${pack}:v${version}`;
const packKey = (slug, pack) => `${slug}/${pack}`;
const opKey = (write) => (write.kind === 'note' ? 'note' : `item:${write.item}`);
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The wait before try `attempt` (1 is the first retry).
export function backoffMs(attempt) {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
}

// Add one write to a list of writes. A write for a key that has an unsent write merges into it: the latest value of each
// field wins, and the merged write takes the new opId. A write that went out once keeps its patch and opId, because the
// server can have applied it; the new write then waits behind it with rev null (it takes the rev that the sent write gets).
// The other entries stay the same objects, so a write in flight keeps its identity.
export function coalesce(ops, op) {
  const out = [...ops];
  const at = out.findLastIndex((entry) => entry.id === op.id);
  const open = at < 0 ? null : out[at];
  if (open && !open.sent) {
    out[at] = { ...open, patch: { ...open.patch, ...op.patch }, opId: op.opId };
    return out;
  }
  out.push({ ...op, rev: open ? null : op.rev });
  return out;
}

// ---------- Status ----------

// kind: saved, saving, offline, retrying, auth, conflict, changed, dropped (with text), or '' (nothing to show).
export function syncStatusText(status) {
  switch (status?.kind) {
    case 'saved': return 'Saved';
    case 'saving': return 'Saving...';
    case 'offline': return 'Offline, will save when back';
    case 'retrying': return 'Not saved';
    case 'auth': return 'Sign in again';
    case 'conflict': return 'Changed on another device';
    case 'changed': return 'Changed in the new version. Not saved.';
    case 'dropped': return `Not saved. ${status.text || ''}`.trim();
    default: return '';
  }
}

const TONE = { saved: 'ok', saving: '', offline: 'warn', retrying: 'crit', auth: 'crit', conflict: 'warn', changed: 'warn', dropped: 'crit', unsaved: 'crit' };
const notSavedText = (n) => `${plural(n, 'change')} ${n === 1 ? 'was' : 'were'} not saved`;

// The status line of one item or of the pack note. Not saved has Retry, and Sign in again links to the login.
export function syncStatusHtml(status, esc) {
  const kind = status?.kind || '';
  const text = syncStatusText(status);
  const alert = ['retrying', 'auth', 'dropped', 'changed'].includes(kind);
  let action = kind === 'retrying' ? ' <button type="button" class="rv-sync-retry" data-rv-sync-retry>Retry</button>'
    : kind === 'auth' ? ' <a class="rv-sync-retry" href="/login">Sign in</a>' : '';
  // A patch that was not saved waits for the Owner: Retry (when a retry can help) or Discard. A new answer also clears it.
  if ((kind === 'dropped' || kind === 'changed') && status.id) {
    const id = esc(status.id);
    if (kind === 'dropped' && !status.final) action += ` <button type="button" class="rv-sync-retry" data-rv-sync-redo="${id}">Retry</button>`;
    action += ` <button type="button" class="rv-sync-retry" data-rv-sync-discard="${id}">Discard</button>`;
  }
  return `<p class="rv-status rv-sync${TONE[kind] ? ` rv-sync-${TONE[kind]}` : ''}" data-sync="${esc(kind)}" role="${alert ? 'alert' : 'status'}">${esc(text)}${action}</p>`;
}

// The pill of the pack above the answer bar and in the foot bar. It keeps its slot when empty, so no button moves.
export function packStatusHtml(status, esc) {
  const kind = status?.kind || '';
  const count = status?.count || 0;
  const parts = [];
  const text = syncStatusText(kind === 'saved' && count ? { kind: 'saving' } : status);
  if (text) parts.push(text);
  if (kind === 'unsaved') parts.length = 0;
  if (count && kind !== 'saved') parts.push(`${plural(count, 'change')} waiting`);
  if (status?.unsaved) parts.push(notSavedText(status.unsaved));
  if (status?.warning) parts.push(status.warning);
  const action = kind === 'retrying' || kind === 'offline' ? '<button type="button" class="rv-sync-retry" data-rv-sync-retry>Retry</button>'
    : kind === 'auth' ? '<a class="rv-sync-retry" href="/login">Sign in</a>' : '';
  const shown = parts.length ? '' : ' rv-sync-empty';
  return `<p class="rv-sync-pill${shown}${TONE[kind] ? ` rv-sync-${TONE[kind]}` : ''}" data-sync="${esc(kind)}" role="status"><span>${esc(parts.join(' · '))}</span>${action}</p>`;
}

// The short status of an item row in the section list. A saved item shows nothing.
export function rowSyncText(status) {
  return { saving: 'Saving...', offline: 'Waiting to save', retrying: 'Not saved', auth: 'Not saved', dropped: 'Not saved', conflict: 'Changed on another device', changed: 'Changed in the new version' }[status?.kind] || '';
}

// The submit waits until the queue is empty, so a submit never races an unsaved change. A change that was not saved
// also keeps the submit disabled until the Owner retries it, discards it, or answers the item again.
export function submitLock(count, unsaved = 0) {
  if (count) return { disabled: true, label: `Waiting for ${plural(count, 'change')} to save` };
  if (unsaved) return { disabled: true, label: notSavedText(unsaved) };
  return { disabled: false, label: 'Submit review' };
}

// ---------- Drafts ----------

// The typed notes wait `ms` after the last input. flush(key) runs one draft at once; flush() runs all of them.
export function createDrafts({ ms = NOTE_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const drafts = new Map();
  function run(key) {
    const draft = drafts.get(key);
    if (!draft) return;
    drafts.delete(key);
    clearTimer(draft.timer);
    draft.fn();
  }
  return {
    set(key, fn) {
      const old = drafts.get(key);
      if (old) clearTimer(old.timer);
      drafts.set(key, { fn, timer: setTimer(() => run(key), ms) });
    },
    flush(key) {
      if (key !== undefined) { run(key); return; }
      for (const name of [...drafts.keys()]) run(name);
    },
    has: (key) => drafts.has(key),
    size: () => drafts.size,
  };
}

// ---------- Persistence ----------

function validOp(op) {
  return plain(op)
    && (op.kind === 'item' ? typeof op.item === 'string' && op.item.length > 0 && op.item.length <= 64 : op.kind === 'note')
    && plain(op.patch)
    && typeof op.opId === 'string' && op.opId.length > 0 && op.opId.length <= OP_ID_MAX
    && (op.rev === null || (Number.isInteger(op.rev) && op.rev >= 0))
    && (op.hash === undefined || typeof op.hash === 'string')
    && typeof op.sent === 'boolean';
}

function parseStored(text) {
  try {
    const value = JSON.parse(text);
    if (!plain(value) || value.v !== 1 || !Array.isArray(value.ops) || !value.ops.every(validOp)) return null;
    return value.ops;
  } catch { return null; }
}

const storedOp = (op) => ({ kind: op.kind, item: op.kind === 'item' ? op.item : undefined, hash: op.hash, patch: op.patch, opId: op.opId, rev: op.rev, sent: op.sent });

// ---------- The queue ----------

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// options: fetch, base (the origin for a test), storage (localStorage or null), setTimer, clearTimer, now, makeId,
// onChange() (render), onSaved({ key, kind, item, answer | note, rev, theirs }) (the page shows the stored answer).
export function createReviewSync({ fetch, base = '', storage = null, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), makeId = newId, onChange = () => {}, onSaved = () => {} } = {}) {
  if (typeof fetch !== 'function') throw new TypeError('createReviewSync needs a fetch function.');
  const packs = new Map();

  function packOf(slug, pack) {
    const key = packKey(slug, pack);
    if (!packs.has(key)) {
      // known: every opId that this tab held. foreign: the count of stored ops of other tabs.
      packs.set(key, { key, slug, pack, version: null, ops: [], conflicts: [], messages: new Map(), saved: new Set(), revs: new Map(), known: new Set(), foreign: 0, failure: '', attempt: 0, timer: null, running: false, needsCheck: false, warning: '', at: 0 });
    }
    return packs.get(key);
  }

  // ----- Storage -----

  function storageKeys(P) {
    const prefix = `${QUEUE_PREFIX}${P.slug}/${P.pack}:v`;
    const keys = [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const name = storage.key(i);
        if (name && name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))) keys.push(name);
      }
    } catch { /* storage is off */ }
    return keys;
  }

  // The stored lists of a pack, by key. A key that cannot be read or parsed is left out.
  function readStored(P) {
    const stored = new Map();
    for (const name of storageKeys(P)) {
      let text = null;
      try { text = storage.getItem(name); } catch { text = null; }
      const ops = text === null ? null : parseStored(text);
      if (ops) stored.set(name, ops);
    }
    return stored;
  }

  // Several tabs of one pack share one key. The rule: a tab owns the ops that it created or restored. Each persist reads
  // the stored list and writes the union of its own ops and the stored ops of other tabs. A stored op whose opId this
  // tab ever held and no longer holds is finished (saved, dropped, resolved, or merged into a newer op), so it goes.
  // A tab never sends the ops of another tab, but counts them as waiting. retryNow() and a reload adopt them: a
  // double send is safe, because an item write carries its opId and a note retry that meets its own text counts as saved.
  function persist(P) {
    if (!storage) { P.warning = P.ops.length ? NO_STORAGE : ''; return; }
    const groups = new Map();
    const add = (name, op) => {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(op);
    };
    for (const op of P.ops) add(queueKey(P.slug, P.pack, op.version), storedOp(op));
    let foreign = 0;
    for (const [name, ops] of readStored(P)) {
      for (const op of ops) {
        if (P.known.has(op.opId)) continue;
        add(name, op);
        foreign += 1;
      }
    }
    P.foreign = foreign;
    P.warning = '';
    for (const name of storageKeys(P)) {
      if (groups.has(name)) continue;
      try { storage.removeItem(name); } catch { /* storage is off */ }
    }
    for (const [name, ops] of groups) {
      const text = JSON.stringify({ v: 1, ops });
      try {
        // A queue over the limit is not kept. An older, smaller copy would restore stale values, so it goes too.
        if (text.length > QUEUE_LIMIT_BYTES) { P.warning = TOO_LARGE; storage.removeItem(name); continue; }
        storage.setItem(name, text);
      } catch {
        P.warning = NO_STORAGE;
        try { storage.removeItem(name); } catch { /* storage is off */ }
      }
    }
  }

  // Restore the waiting changes of a pack after a reload, or adopt the stored ops of another tab. It returns the count.
  // The page then calls retryNow().
  function restore(slug, pack) {
    if (!storage) return 0;
    const P = packOf(slug, pack);
    let count = 0;
    for (const [name, ops] of readStored(P)) {
      const version = Number(name.slice(name.lastIndexOf(':v') + 2));
      for (const op of ops) {
        if (P.known.has(op.opId)) continue;
        P.known.add(op.opId);
        P.ops.push({ ...op, id: opKey(op), version, state: 'offline', waited: true });
        count += 1;
      }
      P.version = Math.max(P.version || 0, version);
    }
    P.foreign = 0;
    if (count) { P.needsCheck = true; P.failure = 'offline'; }
    return count;
  }

  // A `storage` event of another tab: count its waiting ops again. It changes no own op.
  function onStorage(name) {
    if (!storage || (name !== null && name !== undefined && !String(name).startsWith(QUEUE_PREFIX))) return;
    for (const P of packs.values()) {
      let foreign = 0;
      for (const ops of readStored(P).values()) for (const op of ops) if (!P.known.has(op.opId)) foreign += 1;
      P.foreign = foreign;
    }
    onChange();
  }

  // ----- Requests -----

  async function request(url, options) {
    let response;
    try { response = await fetch(base + url, options); } catch { return { network: true, status: 0, body: null }; }
    const body = await response.json().catch(() => null);
    return { network: false, status: response.status, ok: response.ok, body };
  }

  const itemUrl = (P, item) => `/api/reviews/${enc(P.slug)}/${enc(P.pack)}/items/${enc(item)}`;
  const noteUrl = (P) => `/api/reviews/${enc(P.slug)}/${enc(P.pack)}/note`;
  const packUrl = (P) => `/api/reviews/${enc(P.slug)}/${enc(P.pack)}`;
  const errorText = (reply, fallback) => (typeof reply.body?.error === 'string' && reply.body.error.trim() ? reply.body.error.trim().slice(0, 300) : fallback);

  function changed(P) {
    persist(P);
    onChange();
  }

  // A dropped or changed patch stays as a message until the Owner acts: Retry (a dropped patch), Discard, or a new answer.
  // `final` marks a patch that no retry can save, for example on a closed pack.
  const unsaved = (op, kind, text, final = false) => ({ kind, text, final, op: { kind: op.kind, item: op.item, hash: op.hash, version: op.version, patch: { ...(op.patch || op.mine) } } });

  function dropAll(P, text) {
    for (const op of P.ops) P.messages.set(op.id, unsaved(op, 'dropped', text, true));
    for (const conflict of P.conflicts) P.messages.set(conflict.id, unsaved(conflict, 'dropped', text, true));
    P.ops = [];
    P.conflicts = [];
    P.failure = '';
  }

  // A retriable failure: keep every patch and try again later.
  function fail(P, kind) {
    P.failure = kind;
    if (kind === 'offline') P.needsCheck = true;
    for (const op of P.ops) { op.state = kind; op.waited = true; }
    if (kind === 'auth') return;
    P.attempt += 1;
    clearTimer(P.timer);
    P.timer = setTimer(() => { P.timer = null; run(P); }, backoffMs(P.attempt));
  }

  // Read the pack before a flush. A submitted pack accepts only a planner-reopened item. A newer version keeps a patch only for an item with the same hash.
  async function check(P) {
    const reply = await request(packUrl(P));
    if (reply.network || reply.status >= 500 || reply.status === 429) { fail(P, reply.network ? 'offline' : 'retrying'); return false; }
    if (reply.status === 401) { fail(P, 'auth'); return false; }
    if (reply.status === 404) { dropAll(P, 'The pack does not exist any more.'); return false; }
    const data = reply.body;
    if (!reply.ok || !plain(data) || !Number.isInteger(data.version)) { fail(P, 'retrying'); return false; }
    const items = new Map((Array.isArray(data.items) ? data.items : []).map((item) => [item.id, item]));
    if (data.state !== 'open') {
      if (data.state === 'submitted') {
        const keep = [];
        for (const op of P.ops) {
          const item = items.get(op.item);
          const retrySavedAnswer = item?.reopenUsed === true && item.reopenUsedOpId === op.opId;
          if (op.kind === 'item' && (item?.reopened === true || retrySavedAnswer)) keep.push(op);
          else P.messages.set(op.id, unsaved(op, 'dropped', 'This pack is submitted. Ask the planner to reopen the item.', true));
        }
        P.ops = keep;
        if (!keep.length) { P.failure = ''; return false; }
      } else {
        dropAll(P, `The pack is ${String(data.state || 'closed').slice(0, 20)}. The change cannot be saved.`);
        return false;
      }
    }
    P.ops = P.ops.filter((op) => {
      const item = items.get(op.item);
      const retrySavedAnswer = item?.reopenUsed === true && item.reopenUsedOpId === op.opId;
      if (data.state === 'submitted' && !(op.kind === 'item' && (item?.reopened === true || retrySavedAnswer))) return false;
      // A 400 on the same version is a real refusal: drop the patch with the server sentence.
      if (op.recheck && op.version === data.version) { P.messages.set(op.id, unsaved(op, 'dropped', op.recheck)); return false; }
      if (op.version === data.version || op.kind === 'note') { op.version = data.version; return true; }
      if (item && item.hash === op.hash) { op.version = data.version; return true; }
      P.messages.set(op.id, unsaved(op, 'changed', '', false));
      return false;
    });
    P.version = data.version;
    P.needsCheck = false;
    return true;
  }

  // The rev of a write: its own base rev, or the rev that the write before it got.
  const revOf = (P, op) => (op.rev === null ? P.revs.get(op.id) ?? 0 : op.rev);

  async function send(P, op) {
    const rev = revOf(P, op);
    if (op.kind === 'note') return { reply: await request(noteUrl(P), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: op.patch.note, rev }) }), rev };
    return { reply: await request(itemUrl(P, op.item), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...op.patch, rev, opId: op.opId }) }), rev };
  }

  function saved(P, op, rev, detail) {
    P.ops = P.ops.filter((entry) => entry !== op);
    P.revs.set(op.id, rev);
    // The next write of the same key was based on this one.
    const next = P.ops.find((entry) => entry.id === op.id);
    if (next && next.rev === null) next.rev = rev;
    if (!next) P.saved.add(op.id);
    P.attempt = 0;
    onSaved({ key: P.key, kind: op.kind, item: op.item, ...detail });
  }

  // A 409: the other answer wins until the Owner chooses. The later writes of the same key join my side of the conflict.
  async function conflict(P, op, body) {
    let theirs = body?.current;
    if (theirs === undefined && op.kind === 'item') {
      const reply = await request(packUrl(P));
      if (!reply.ok) {
        P.ops = P.ops.filter((entry) => entry.id !== op.id);
        P.messages.set(op.id, unsaved(op, 'dropped', CONFLICT_UNLOADED));
        return;
      }
      theirs = reply.body?.items?.find?.((item) => item.id === op.item)?.answer ?? null;
    }
    let mine = {};
    for (const entry of P.ops) if (entry.id === op.id) mine = { ...mine, ...entry.patch };
    P.ops = P.ops.filter((entry) => entry.id !== op.id);
    P.conflicts = P.conflicts.filter((entry) => entry.id !== op.id);
    P.conflicts.push({ id: op.id, kind: op.kind, item: op.item, hash: op.hash, version: op.version, mine, theirs: theirs ?? null, batch: Boolean(op.waited) });
    P.revs.set(op.id, theirs?.rev ?? 0);
  }

  async function run(P) {
    if (P.running || P.failure === 'auth') return;
    P.running = true;
    try {
      for (;;) {
        if (!P.ops.length) break;
        if (P.needsCheck) {
          const ok = await check(P);
          if (ok) { P.failure = ''; for (const entry of P.ops) entry.state = 'queued'; }
          changed(P);
          if (!ok) break;
          continue;
        }
        const op = P.ops[0];
        op.state = 'saving';
        op.sent = true;
        // A reload after this point must keep the opId: the server can apply the write even when the answer is lost.
        persist(P);
        onChange();
        const { reply, rev } = await send(P, op);
        const body = reply.body;
        if (reply.network) { fail(P, 'offline'); changed(P); break; }
        if (reply.status >= 500 || reply.status === 429) { fail(P, 'retrying'); changed(P); break; }
        if (reply.status === 401) { fail(P, 'auth'); changed(P); break; }
        P.failure = '';
        for (const entry of P.ops) if (entry !== op) entry.state = 'queued';
        if (reply.ok) {
          if (op.kind === 'note') saved(P, op, body?.rev ?? rev + 1, { note: body?.note ?? op.patch.note, rev: body?.rev ?? rev + 1 });
          else saved(P, op, body?.answer?.rev ?? rev + 1, { answer: body?.answer ?? null });
        } else if (reply.status === 409 && body?.code === 'closed') {
          dropAll(P, errorText(reply, 'The pack is closed. The change cannot be saved.'));
        } else if (reply.status === 409 && op.kind === 'note' && body?.current && body.current.note === op.patch.note) {
          // A retry after a lost response: the server has my note already.
          saved(P, op, body.current.rev, { note: body.current.note, rev: body.current.rev });
        } else if (reply.status === 409 && body?.conflict) {
          await conflict(P, op, body);
        } else if (reply.status === 404) {
          dropAll(P, errorText(reply, 'The pack does not exist any more.'));
        } else if (reply.status === 400 && op.kind === 'item' && !op.recheck) {
          // A 400 can mean that a newer version replaced the item. Read the pack once and re-target the patch by its hash.
          op.recheck = errorText(reply, 'The service refused the change.');
          op.state = 'queued';
          P.needsCheck = true;
        } else {
          // 400, 403, 413, and every other refusal: drop this patch with the server sentence. The queue goes on.
          P.ops = P.ops.filter((entry) => entry !== op);
          P.messages.set(op.id, unsaved(op, 'dropped', op.recheck || errorText(reply, reply.status === 413 ? 'The change is too large.' : 'The service refused the change.')));
        }
        changed(P);
      }
    } finally {
      P.running = false;
    }
    onChange();
  }

  function kick(P) {
    clearTimer(P.timer);
    P.timer = null;
    if (P.failure === 'auth') P.failure = '';
    run(P);
  }

  // ----- The page API -----

  // write: slug, pack, version, kind ('item' or 'note'), item, hash, rev (the rev that the page shows), patch.
  function enqueue(write) {
    const P = packOf(write.slug, write.pack);
    const id = opKey(write);
    if (!P.ops.length && P.version === null) P.version = write.version;
    if (write.version !== P.version) P.needsCheck = true;
    const rev = Math.max(write.rev ?? 0, P.revs.get(id) ?? 0);
    P.revs.set(id, rev);
    const opId = makeId();
    P.known.add(opId);
    P.ops = coalesce(P.ops, { id, kind: write.kind, item: write.item, hash: write.hash, version: write.version, patch: { ...write.patch }, opId, rev, sent: false, state: P.failure || 'queued', waited: Boolean(P.failure) });
    P.messages.delete(id);
    P.saved.delete(id);
    changed(P);
    if (!P.failure) run(P);
    return P.key;
  }

  // Try every waiting change at once. With adopt (the Retry button), it also takes over the waiting ops that another
  // tab left in the storage, for example a closed tab. The online event and the focus do not adopt.
  function retryNow({ adopt = false } = {}) {
    for (const P of packs.values()) {
      if (adopt && P.foreign) restore(P.slug, P.pack);
      if (P.ops.length || P.failure) kick(P);
    }
  }

  // The Owner acts on a patch that was not saved: Retry sends it again, and Discard forgets it.
  function redo(key, id) {
    const P = packs.get(key);
    const message = P?.messages.get(id);
    if (!message?.op || message.final) return;
    P.messages.delete(id);
    const { op } = message;
    enqueue({ slug: P.slug, pack: P.pack, version: P.version ?? op.version, kind: op.kind, item: op.item, hash: op.hash, rev: P.revs.get(id) ?? 0, patch: op.patch });
  }

  function discard(key, id) {
    const P = packs.get(key);
    if (!P?.messages.delete(id)) return;
    onChange();
  }

  // The page loaded the pack. A new version or a closed pack makes the queue check before its next write.
  function observe(data) {
    if (!data?.slug || !data?.pack) return;
    const P = packOf(data.slug, data.pack);
    if (!P.ops.length) { P.version = data.version; return; }
    if (data.version !== P.version || data.state !== 'open') { P.needsCheck = true; kick(P); }
  }

  // Show the waiting patches over a loaded pack, so a reload never shows an older answer than the Owner gave.
  function overlay(data) {
    const P = packs.get(packKey(data?.slug, data?.pack));
    if (!P) return data;
    for (const item of data.items || []) {
      const patch = pendingPatch(P.key, item.id);
      if (patch) item.answer = { ...(item.answer || {}), ...patch };
    }
    const note = pendingPatch(P.key, null, 'note');
    if (note) data.note = note.note;
    return data;
  }

  function pendingPatch(key, item, kind = 'item') {
    const P = packs.get(key);
    if (!P) return null;
    const id = kind === 'note' ? 'note' : `item:${item}`;
    let patch = null;
    for (const op of P.ops) if (op.id === id) patch = { ...patch, ...op.patch };
    const open = P.conflicts.find((entry) => entry.id === id);
    if (open) patch = { ...open.mine, ...patch };
    return patch;
  }

  function statusOf(key, id) {
    const P = packs.get(key);
    if (!P) return { kind: '' };
    if (P.conflicts.some((entry) => entry.id === id)) return { kind: 'conflict' };
    const op = P.ops.find((entry) => entry.id === id);
    if (op) {
      if (P.failure === 'auth') return { kind: 'auth' };
      if (op.state === 'offline' || op.state === 'retrying') return { kind: op.state };
      return { kind: 'saving' };
    }
    if (P.messages.has(id)) {
      const message = P.messages.get(id);
      return { kind: message.kind, text: message.text, id, final: message.final };
    }
    return { kind: P.saved.has(id) ? 'saved' : '' };
  }

  const ORDER = ['auth', 'conflict', 'retrying', 'offline', 'saving', 'unsaved', 'saved'];
  function packStatus(key) {
    const P = packs.get(key);
    if (!P) return { kind: '', count: 0, unsaved: 0, warning: '' };
    const kinds = new Set([...P.ops.map((op) => statusOf(key, op.id).kind), ...P.conflicts.map(() => 'conflict')]);
    if (P.failure) kinds.add(P.failure === 'auth' && !P.ops.length ? '' : P.failure);
    if (P.foreign) kinds.add('saving');
    if (unsavedCount(key)) kinds.add('unsaved');
    if (P.saved.size) kinds.add('saved');
    return { kind: ORDER.find((kind) => kinds.has(kind)) || '', count: pendingCount(key), unsaved: unsavedCount(key), warning: P.ops.length ? P.warning : '' };
  }

  // The waiting changes: own ops, open conflicts, and the ops that another tab keeps in the storage.
  function pendingCount(key) {
    const P = packs.get(key);
    return P ? P.ops.length + P.conflicts.length + P.foreign : 0;
  }

  // The changes that were not saved and wait for Retry, Discard, or a new answer.
  function unsavedCount(key) {
    const P = packs.get(key);
    return P ? [...P.messages.values()].filter((message) => message.kind === 'dropped' || message.kind === 'changed').length : 0;
  }

  function pendingFields(key, item) {
    const P = packs.get(key);
    if (!P) return [];
    return [...new Set(P.ops.filter((op) => op.id === `item:${item}`).flatMap((op) => Object.keys(op.patch)))];
  }

  function resolve(key, id, mine) {
    const P = packs.get(key);
    const entry = P?.conflicts.find((conflict) => conflict.id === id);
    if (!entry) return;
    P.conflicts = P.conflicts.filter((conflict) => conflict !== entry);
    if (mine) {
      P.revs.set(id, entry.theirs?.rev ?? 0);
      enqueue({ slug: P.slug, pack: P.pack, version: entry.version ?? P.version, kind: entry.kind, item: entry.item, hash: entry.hash, rev: entry.theirs?.rev ?? 0, patch: entry.mine });
      return;
    }
    if (entry.kind === 'note') onSaved({ key, kind: 'note', note: entry.theirs?.note ?? '', rev: entry.theirs?.rev ?? 0, theirs: true });
    else onSaved({ key, kind: 'item', item: entry.item, answer: entry.theirs, theirs: true });
    changed(P);
  }

  return {
    enqueue,
    restore,
    retryNow,
    onStorage,
    redo,
    discard,
    unsavedCount,
    observe,
    overlay,
    pendingPatch,
    pendingCount,
    pendingFields,
    packStatus,
    itemStatus: (key, item) => statusOf(key, `item:${item}`),
    noteStatus: (key) => statusOf(key, 'note'),
    conflicts: (key) => (packs.get(key)?.conflicts || []).map((entry) => ({ ...entry })),
    keepMine: (key, item) => resolve(key, `item:${item}`, true),
    useTheirs: (key, item) => resolve(key, `item:${item}`, false),
    keepNote: (key) => resolve(key, 'note', true),
    useTheirNote: (key) => resolve(key, 'note', false),
    keepAllMine: (key) => { for (const entry of packs.get(key)?.conflicts || []) resolve(key, entry.id, true); },
    useAllTheirs: (key) => { for (const entry of packs.get(key)?.conflicts || []) resolve(key, entry.id, false); },
    // The time of the next retry, for a test or a status line.
    nextRetry: (key) => packs.get(key)?.timer ?? null,
    now,
  };
}
