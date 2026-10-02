// The store of hosted review packs. See docs/ideas/review-packs.md, sections Storage, Versioning, and Limits.
// The state lives in the SQLite database of the data dir (migration 2 in src/sqlite-store.js), whatever
// backend the message store uses. The pack files live in <data dir>/review-packs/<slug>/<pack>/v<version>/.
// Each function takes the data dir as `dir` and the time as `now`, so a test never reads the live data dir.
// The module has no route, no CLI, and no Mailbox code. A caller maps a conflict object to HTTP 409.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SLUG } from './projects.js';
import { openSqliteStore, databaseFile } from './sqlite-store.js';
import { validatePack } from './review-pack.js';
import { redactSecrets } from './redact.js';
import { RESULT_SCHEMA, VERDICTS, proposeVerdict, buildResult, boundResult, resultMarkdown } from './review-result.js';

export { RESULT_SCHEMA };
export const REVIEW_DIR = 'review-packs';
export const LIMITS = Object.freeze({
  versionsKept: 3,
  quotaBytes: 2 * 1024 * 1024 * 1024,
  openPacks: 5,
  submittedDays: 30,
  openDays: 60,
  resultDays: 180,
});

const DAY = 24 * 60 * 60 * 1000;
const STAGE_MAX_AGE = 60 * 60 * 1000;
const NOTE_MAX = 2000;
const PINS_MAX = 50;
const DECISIONS = ['accept', 'deny'];
// The built-in answer `skip` (ask later) is not a verdict. The item stays open and moves to the end of the pack.
const SKIP = 'skip';
const DECIDING = ['accept', 'deny', 'choice', 'rating'];
const PATCH_KEYS = new Set(['rev', 'opId', 'keep', 'decision', 'choice', 'rating', 'live', 'viewed', 'note', 'pins', 'checks']);
const MARK_KEEPING = new Set(['rev', 'opId', 'viewed', 'note', 'pins']);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const SHA256 = /^[0-9a-f]{64}$/;

export class ReviewStoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ReviewStoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- Helpers ----------

const invalid = (message) => new ReviewStoreError('invalid', message);

function stamp(now) {
  const date = new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) throw invalid('The time is not valid.');
  return date.toISOString();
}

function checkName(value, code = 'slug', label = 'The project slug') {
  if (typeof value !== 'string' || !SLUG.test(value)) throw new ReviewStoreError(code, `${label} must match [a-z0-9][a-z0-9-]* and have at most 64 characters.`);
  return value;
}

function open(dir) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('The review store needs a data directory.');
  return openSqliteStore({ dir });
}

function transaction(sqlite, fn) {
  const { db } = sqlite;
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn(db);
    db.exec('COMMIT');
    sqlite.secureFiles();
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction is open */ }
    throw error;
  }
}

export function packDirectory(dir, slug, pack, version) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const base = path.join(path.resolve(dir), REVIEW_DIR, slug, pack);
  if (version === undefined) return base;
  if (!Number.isInteger(version) || version < 1) throw invalid('The version must be a whole number of 1 or more.');
  return path.join(base, `v${version}`);
}

// A file system error becomes a ReviewStoreError with the error code and, at most, a relative file name.
// The message never holds the data dir or the pack folder, because a route can show it to a client.
function ioError(error, what, file) {
  if (error instanceof ReviewStoreError) return error;
  const reason = error?.code || error?.message || 'error';
  return new ReviewStoreError(file ? 'copy' : 'io', `Herdr Boss cannot ${what}${file ? ` ${file}` : ''}: ${reason}.`, file ? { file } : {});
}

function privateDirectory(target) {
  try {
    try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.chmodSync(target, 0o700);
  } catch (error) { throw ioError(error, 'create a review folder'); }
}

// Create each folder from the data dir down to `target` with mode 0700.
function privateTree(dir, target) {
  const root = path.resolve(dir);
  privateDirectory(root);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) { current = path.join(current, part); privateDirectory(current); }
}

const removeTree = (target) => fs.rmSync(target, { recursive: true, force: true });

// The rules of the validator for a relative path. A stored name must pass them again.
function safeRelative(rel) {
  const bad = (why) => new ReviewStoreError('path', `The stored path is not allowed: ${why}.`);
  if (typeof rel !== 'string' || !rel) throw bad('it is empty');
  if (rel.length > 256) throw bad('it is too long');
  if (rel.includes('\0')) throw bad('it holds a NUL character');
  if (rel.includes('\\')) throw bad('it holds a backslash');
  if (rel.startsWith('/') || /^[a-z]:/i.test(rel)) throw bad('it is not relative');
  const parts = rel.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw bad('it holds an empty, "." or ".." part');
  if (parts.some((part) => part.startsWith('.'))) throw bad('it names a hidden file');
  return parts;
}

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

// ---------- Derived states ----------

// The earlier verdict of an answer, or null when the answer holds none: a decision, a choice, a rating, or a live check.
const hasVerdict = (fields) => Boolean(fields) && (DECISIONS.includes(fields.decision) || fields.choice != null || fields.rating != null || fields.live != null);

// The state of one item: accepted, denied, answered, note, live, changed, or open.
// A stale answer shows no verdict. It is `changed` when it held a verdict before the content changed, and `open` otherwise.
function itemState(spec, answer) {
  if (!answer) return 'open';
  if (answer.stale) return hasVerdict(answer.previous) ? 'changed' : 'open';
  const ask = spec.ask || [];
  if (answer.decision === 'deny') return 'denied';
  if (answer.decision === 'accept') return 'accepted';
  if (answer.choice !== null || answer.rating !== null) return 'answered';
  if (answer.live === 'pending') return 'live';
  if (answer.live === 'done' && !ask.some((name) => DECIDING.includes(name)) && ask.includes('live')) return 'answered';
  if (ask.length === 1 && ask[0] === 'note' && answer.note.trim()) return 'note';
  return 'open';
}

// The section and pack state over a list of item states: denied, changed, live, accepted, or open.
// A section is computed from its items and never stored.
function groupState(states) {
  if (states.includes('denied')) return 'denied';
  if (states.includes('changed')) return 'changed';
  if (states.includes('live')) return 'live';
  if (states.length && states.every((state) => state !== 'open')) return 'accepted';
  return 'open';
}

// A changed item counts in `changed` and in `open`: it is open work.
function countStates(states) {
  const counts = { items: states.length, accepted: 0, denied: 0, live: 0, noteOnly: 0, open: 0, changed: 0 };
  for (const state of states) {
    if (state === 'accepted' || state === 'answered') counts.accepted += 1;
    else if (state === 'denied') counts.denied += 1;
    else if (state === 'live') counts.live += 1;
    else if (state === 'note') counts.noteOnly += 1;
    else {
      counts.open += 1;
      if (state === 'changed') counts.changed += 1;
    }
  }
  return counts;
}

// The earlier verdict of a stale answer: the stored record, or the verdict fields of the row when an older build stored none.
function previousOf(row) {
  const stored = parseJson(row.previous, null);
  if (hasVerdict(stored)) return stored;
  const own = { decision: row.decision, choice: row.choice, rating: row.rating, live: row.live, hash: row.hash, at: row.updated_at };
  return hasVerdict(own) ? own : null;
}

// A stale answer shows no verdict, no viewed mark, and no checks. It keeps the note and the pins.
// `previous` holds the earlier verdict with its time while the answer is stale, and is null otherwise.
function answerShape(row, currentHash) {
  const stale = row.stale === 1 || (currentHash !== undefined && row.hash !== currentHash);
  return {
    item: row.item,
    decision: stale ? null : row.decision,
    choice: stale ? null : row.choice,
    rating: stale ? null : row.rating,
    live: stale ? null : row.live,
    viewed: stale ? false : row.viewed === 1,
    note: row.note,
    pins: parseJson(row.pins, []),
    checks: stale ? {} : parseJson(row.checks, {}),
    hash: row.hash,
    stale,
    previous: stale ? previousOf(row) : null,
    rev: row.rev,
    updatedAt: row.updated_at,
  };
}

// ---------- Publish ----------

// Copy one source file into the staging folder. The copy checks the hash and the size that the validator
// recorded, so a file that changed after the validation is refused.
function copyFile(root, stage, file, sourcePath = file.path) {
  const parts = safeRelative(file.path);
  const sourceParts = safeRelative(sourcePath);
  const real = fs.realpathSync(path.join(root, ...sourceParts));
  if (!inside(root, real)) throw new Error('the path leaves the pack folder');
  const target = path.join(stage, ...parts);
  if (!inside(stage, path.resolve(target))) throw new Error('the stored path leaves the version folder');
  const fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW);
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== file.bytes) throw new Error('the file changed after the validation');
    buffer = Buffer.alloc(stat.size);
    let got = 0;
    while (got < stat.size) {
      const read = fs.readSync(fd, buffer, got, stat.size - got, got);
      if (read === 0) break;
      got += read;
    }
    if (got !== stat.size) throw new Error('the file changed after the validation');
  } finally { fs.closeSync(fd); }
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== file.sha256) throw new Error('the file changed after the validation');
  for (let depth = 1; depth < parts.length; depth += 1) privateDirectory(path.join(stage, ...parts.slice(0, depth)));
  const out = fs.openSync(target, 'wx', 0o600);
  try { fs.writeSync(out, buffer); } finally { fs.closeSync(out); }
  fs.chmodSync(target, 0o600);
}

const REVIEW_ITEM_FIELDS = ['description', 'steps', 'expected', 'link', 'verifiedBy', 'evidence'];

function reviewFields(item) {
  return Object.fromEntries(REVIEW_ITEM_FIELDS.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
}

function itemSpec(item) {
  const spec = { title: item.title, type: item.type, ask: item.ask };
  if (item.choices) spec.choices = item.choices;
  if (item.rating) spec.rating = item.rating;
  if (item.entries) spec.entries = item.entries;
  Object.assign(spec, reviewFields(item));
  return spec;
}

function usedBytes(db) {
  return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM review_versions').get().bytes;
}

// The oldest closed packs, named in a quota refusal so the caller can suggest a delete.
function oldestClosed(db) {
  return db.prepare(`SELECT p.slug, p.pack, p.closed_at AS closedAt, COALESCE(SUM(v.bytes), 0) AS bytes
    FROM review_packs p LEFT JOIN review_versions v ON v.slug = p.slug AND v.pack = p.pack
    WHERE p.state IN ('submitted', 'expired') GROUP BY p.slug, p.pack ORDER BY p.closed_at LIMIT 5`).all();
}

// The publish prunes the oldest versions of the pack, so their bytes do not count against the quota.
function checkQuota(db, bytes, quotaBytes, slug, pack) {
  const freed = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (SELECT bytes FROM review_versions WHERE slug = ? AND pack = ? ORDER BY version DESC LIMIT -1 OFFSET ?)')
    .get(slug, pack, LIMITS.versionsKept - 1).bytes;
  const used = usedBytes(db) - freed;
  if (used + bytes > quotaBytes) {
    throw new ReviewStoreError('quota', `The review packs use ${used} bytes. This version adds ${bytes} bytes and the limit is ${quotaBytes} bytes.`, { used, bytes, quotaBytes, oldest: oldestClosed(db) });
  }
}

function checkOpenPacks(db, slug, pack, maxOpenPacks) {
  const existing = db.prepare('SELECT 1 AS found FROM review_packs WHERE slug = ? AND pack = ?').get(slug, pack);
  if (existing) return;
  const open = db.prepare("SELECT COUNT(*) AS n FROM review_packs WHERE slug = ? AND state = 'open'").get(slug).n;
  if (open >= maxOpenPacks) throw new ReviewStoreError('open-packs', `The project ${slug} has ${open} open packs. The limit is ${maxOpenPacks}.`, { open, maxOpenPacks });
}

// Publish the folder as the next version of its pack. `validation` is the result of validatePack(); without it
// the function validates the folder. It returns { slug, pack, version, files, bytes, items, changed, added, removed, stale }.
export function publishVersion({ dir, now, slug, folder, publishedBy = null, validation, fileSources = {}, quotaBytes = LIMITS.quotaBytes, maxOpenPacks = LIMITS.openPacks } = {}) {
  checkName(slug);
  const validated = validation ?? validatePack(folder);
  if (!validated?.ok || !validated.manifest) throw new ReviewStoreError('validation', 'The pack folder is not valid.', { errors: validated?.errors ?? [] });
  const { manifest } = validated;
  const pack = checkName(manifest.id, 'slug', 'The pack ID');
  const files = validated.files.map((file) => {
    safeRelative(file.path);
    if (!SHA256.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 0) throw new ReviewStoreError('validation', `The file record for ${file.path} is not valid.`);
    return { path: file.path, sha256: file.sha256, bytes: file.bytes, type: String(file.type || 'binary') };
  });
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const at = stamp(now);
  const sqlite = open(dir);
  const { db } = sqlite;

  // A refusal comes before any copy.
  checkQuota(db, bytes, quotaBytes, slug, pack);
  checkOpenPacks(db, slug, pack, maxOpenPacks);

  const base = packDirectory(dir, slug, pack);
  privateTree(dir, base);
  const stage = path.join(base, `.stage-${crypto.randomBytes(8).toString('hex')}`);
  let final = null;
  try {
    let root;
    try { root = fs.realpathSync(folder ?? ''); } catch (error) { throw ioError(error, 'read the pack folder'); }
    const dataRoot = fs.realpathSync(path.resolve(dir));
    const roots = new Map();
    for (const [file, source] of Object.entries(fileSources)) {
      safeRelative(file);
      let resolved;
      try { resolved = fs.realpathSync(source.root); } catch (error) { throw ioError(error, 'read a carried review folder'); }
      if (!inside(dataRoot, resolved)) throw new ReviewStoreError('path', 'A carried file source is outside the review data folder.');
      roots.set(file, { root: resolved, path: source.path });
    }
    privateDirectory(stage);
    for (const file of files) {
      const source = roots.get(file.path);
      try { copyFile(source?.root ?? root, stage, file, source?.path ?? file.path); }
      catch (error) { throw ioError(error, 'copy', file.path); }
    }
  } catch (error) {
    removeTree(stage);
    throw ioError(error, 'copy the pack folder');
  }

  let published;
  try {
    published = transaction(sqlite, () => {
      checkQuota(db, bytes, quotaBytes, slug, pack);
      checkOpenPacks(db, slug, pack, maxOpenPacks);
      const row = db.prepare('SELECT current_version AS version FROM review_packs WHERE slug = ? AND pack = ?').get(slug, pack);
      const version = (row?.version ?? 0) + 1;
      final = packDirectory(dir, slug, pack, version);
      removeTree(final); // A folder without rows is the leftover of a crashed publish.
      fs.renameSync(stage, final);

      if (row) {
        db.prepare("UPDATE review_packs SET title = ?, current_version = ?, state = 'open', closed_at = NULL, updated_at = ? WHERE slug = ? AND pack = ?").run(manifest.title, version, at, slug, pack);
      } else {
        db.prepare("INSERT INTO review_packs(slug, pack, title, current_version, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)").run(slug, pack, manifest.title, version, at, at);
      }
      db.prepare('INSERT INTO review_versions(slug, pack, version, manifest, bytes, files, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(slug, pack, version, JSON.stringify(manifest), bytes, files.length, at, publishedBy);
      const insertItem = db.prepare('INSERT INTO review_items(slug, pack, version, item, section, hash, position, spec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const hashes = new Map();
      let position = 0;
      for (const section of manifest.sections) {
        for (const item of section.items) {
          insertItem.run(slug, pack, version, item.id, section.id, item.hash, position, JSON.stringify(itemSpec(item)));
          hashes.set(item.id, item.hash);
          position += 1;
        }
      }
      const insertFile = db.prepare('INSERT INTO review_files(slug, pack, version, path, sha256, bytes, type, stored) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const file of files) insertFile.run(slug, pack, version, file.path, file.sha256, file.bytes, file.type, file.path);

      // Compare with the version before.
      const changed = [];
      const added = [];
      const removed = [];
      if (row) {
        const before = new Map(db.prepare('SELECT item, hash FROM review_items WHERE slug = ? AND pack = ? AND version = ?').all(slug, pack, row.version).map((entry) => [entry.item, entry.hash]));
        for (const [id, hash] of hashes) {
          if (!before.has(id)) added.push(id);
          else if (before.get(id) !== hash) changed.push(id);
        }
        for (const id of before.keys()) if (!hashes.has(id)) removed.push(id);
      }

      // Carry the answers over. An unchanged hash keeps the answer. A changed hash marks it stale and keeps the
      // earlier decision. The rev moves on a change, so a client with the old rev gets a conflict.
      const stale = [];
      for (const answer of db.prepare('SELECT * FROM review_answers WHERE slug = ? AND pack = ?').all(slug, pack)) {
        if (!hashes.has(answer.item)) continue;
        if (answer.hash === hashes.get(answer.item)) {
          if (answer.stale) db.prepare('UPDATE review_answers SET stale = 0, rev = rev + 1 WHERE slug = ? AND pack = ? AND item = ?').run(slug, pack, answer.item);
        } else if (!answer.stale) {
          const previous = JSON.stringify({ decision: answer.decision, choice: answer.choice, rating: answer.rating, live: answer.live, hash: answer.hash, at: answer.updated_at });
          db.prepare('UPDATE review_answers SET stale = 1, previous = ?, rev = rev + 1 WHERE slug = ? AND pack = ? AND item = ?').run(previous, slug, pack, answer.item);
          stale.push(answer.item);
        }
      }

      // Keep the newest versions.
      const old = db.prepare('SELECT version FROM review_versions WHERE slug = ? AND pack = ? ORDER BY version DESC LIMIT -1 OFFSET ?').all(slug, pack, LIMITS.versionsKept).map((entry) => entry.version);
      for (const oldVersion of old) db.prepare('DELETE FROM review_versions WHERE slug = ? AND pack = ? AND version = ?').run(slug, pack, oldVersion);
      return { slug, pack, version, files: files.length, bytes, items: hashes.size, changed, added, removed, stale, pruned: old };
    });
  } catch (error) {
    removeTree(stage);
    if (final) removeTree(final);
    throw error;
  }
  for (const version of published.pruned) removeTree(packDirectory(dir, slug, pack, version));
  return published;
}

// ---------- Read ----------

function loadPack(db, slug, pack) {
  return db.prepare('SELECT * FROM review_packs WHERE slug = ? AND pack = ?').get(slug, pack);
}

// One pack at a version (the current one by default), with the answers and the derived states. It returns
// file metadata only, never file content. It returns null when the pack or the version does not exist.
export function getPack({ dir, slug, pack, version } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const { db } = open(dir);
  const row = loadPack(db, slug, pack);
  if (!row) return null;
  const wanted = version ?? row.current_version;
  const versionRow = db.prepare('SELECT * FROM review_versions WHERE slug = ? AND pack = ? AND version = ?').get(slug, pack, wanted);
  if (!versionRow) return null;
  const itemRows = db.prepare('SELECT * FROM review_items WHERE slug = ? AND pack = ? AND version = ? ORDER BY position').all(slug, pack, wanted);
  const answers = new Map(db.prepare('SELECT * FROM review_answers WHERE slug = ? AND pack = ?').all(slug, pack).map((answer) => [answer.item, answer]));
  const reopenRows = db.prepare('SELECT item, active, op_id AS opId FROM review_reopened_items WHERE slug = ? AND pack = ? AND version = ?').all(slug, pack, wanted);
  const reopened = new Set(reopenRows.filter((entry) => entry.active === 1).map((entry) => entry.item));
  const reopenUsed = new Map(reopenRows.filter((entry) => entry.active === 0).map((entry) => [entry.item, entry.opId]));
  const present = new Set(itemRows.map((item) => item.item));

  const items = itemRows.map((entry) => {
    const spec = parseJson(entry.spec, { ask: [] });
    const answer = answers.has(entry.item) ? answerShape(answers.get(entry.item), entry.hash) : null;
    const state = itemState(spec, answer);
    return { id: entry.item, section: entry.section, title: spec.title, type: spec.type, ask: spec.ask, ...reviewFields(spec), hash: entry.hash, position: entry.position, spec, state, skipped: state === 'open' && answer?.decision === SKIP, stale: answer?.stale ?? false, ...(reopened.has(entry.item) ? { reopened: true } : {}), ...(reopenUsed.has(entry.item) ? { reopenUsed: true, ...(reopenUsed.get(entry.item) ? { reopenUsedOpId: reopenUsed.get(entry.item) } : {}) } : {}), answer };
  });
  // A skipped item moves to the end of the pack. The skipped items keep the order in which they were skipped.
  const skippedAt = (item) => item.answer?.updatedAt ?? '';
  items.sort((a, b) => (a.skipped - b.skipped) || (a.skipped ? (skippedAt(a) < skippedAt(b) ? -1 : skippedAt(a) > skippedAt(b) ? 1 : 0) : 0) || a.position - b.position);
  const removed = [...answers.values()].filter((answer) => !present.has(answer.item)).map((answer) => ({ id: answer.item, answer: answerShape(answer) }));
  const manifest = parseJson(versionRow.manifest, {});
  const sections = (manifest.sections || []).map((section) => ({ id: section.id, title: section.title, state: groupState(items.filter((item) => item.section === section.id).map((item) => item.state)) }));
  const states = items.map((item) => item.state);
  const packState = groupState(states);
  const files = db.prepare('SELECT path, sha256, bytes, type, stored FROM review_files WHERE slug = ? AND pack = ? AND version = ? ORDER BY path').all(slug, pack, wanted);
  const submitted = db.prepare('SELECT verdict, submitted_at AS submittedAt, message_id AS messageId FROM review_results WHERE slug = ? AND pack = ? AND version = ?').get(slug, pack, wanted) ?? null;
  return {
    slug,
    pack,
    title: manifest.title ?? row.title,
    version: wanted,
    currentVersion: row.current_version,
    versions: db.prepare('SELECT version FROM review_versions WHERE slug = ? AND pack = ? ORDER BY version').all(slug, pack).map((entry) => entry.version),
    state: row.state,
    mailId: row.mail_id,
    note: row.note,
    noteRev: row.note_rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    verdict: submitted?.verdict ?? null,
    submittedAt: submitted?.submittedAt ?? null,
    resultMessageId: submitted?.messageId ?? null,
    publishedAt: versionRow.published_at,
    publishedBy: versionRow.published_by,
    manifest,
    files,
    items: items.map(({ spec, ...item }) => item),
    removed,
    derived: { sections, pack: packState, counts: countStates(states), proposedVerdict: proposeVerdict(countStates(states)) },
  };
}

// The next later round in the same planner session that contains this item. A carried item has the same id, so the
// Owner can follow it without guessing which pack holds the question.
export function nextPacksForItems({ dir, slug, pack, items = [] } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'string' || !SLUG.test(item))) throw invalid('The item IDs are not valid.');
  const wantedItems = [...new Set(items)];
  if (!wantedItems.length) return {};
  const current = getPack({ dir, slug, pack });
  const session = current?.manifest?.session;
  const round = current?.manifest?.round;
  if (!current || current.state !== 'submitted' || !session || !Number.isInteger(round)) return {};
  const { db } = open(dir);
  const marks = wantedItems.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT p.pack, p.title, v.manifest, v.published_at AS publishedAt, i.item
    FROM review_packs p
    JOIN review_versions v ON v.slug = p.slug AND v.pack = p.pack AND v.version = p.current_version
    JOIN review_items i ON i.slug = p.slug AND i.pack = p.pack AND i.version = v.version
    WHERE p.slug = ? AND p.pack <> ? AND p.state IN ('open', 'submitted') AND i.item IN (${marks})`).all(slug, pack, ...wantedItems);
  const grouped = new Map();
  for (const row of rows) {
    const entry = grouped.get(row.pack) ?? { ...row, manifest: parseJson(row.manifest, {}), items: new Set() };
    entry.items.add(row.item);
    grouped.set(row.pack, entry);
  }
  const candidates = [...grouped.values()]
    .filter((row) => row.manifest.session === session && Number.isInteger(row.manifest.round) && row.manifest.round > round)
    .sort((a, b) => a.manifest.round - b.manifest.round || a.publishedAt.localeCompare(b.publishedAt) || a.pack.localeCompare(b.pack));
  const links = Object.create(null);
  for (const candidate of candidates) {
    for (const item of candidate.items) if (!Object.hasOwn(links, item)) links[item] = { pack: candidate.pack, title: candidate.title };
  }
  return links;
}

export function nextPackForItem({ dir, slug, pack, item } = {}) {
  if (typeof item !== 'string' || !SLUG.test(item)) throw invalid('The item ID is not valid.');
  return nextPacksForItems({ dir, slug, pack, items: [item] })[item] ?? null;
}

// The packs of one state: `open` (default), `done` (submitted or expired), or `all`. It returns no file content.
export function listPacks({ dir, state = 'open', slug } = {}) {
  const { db } = open(dir);
  const filter = state === 'open' ? "state = 'open'" : state === 'done' ? "state IN ('submitted', 'expired')" : state === 'all' ? '1 = 1' : null;
  if (!filter) throw invalid('The state must be open, done, or all.');
  if (slug !== undefined) checkName(slug);
  const rows = db.prepare(`SELECT slug, pack FROM review_packs WHERE ${filter}${slug === undefined ? '' : ' AND slug = ?'} ORDER BY updated_at DESC, slug, pack`).all(...(slug === undefined ? [] : [slug]));
  return rows.map((entry) => {
    const pack = getPack({ dir, slug: entry.slug, pack: entry.pack });
    const result = db.prepare('SELECT verdict FROM review_results WHERE slug = ? AND pack = ? ORDER BY version DESC LIMIT 1').get(entry.slug, entry.pack);
    return {
      slug: pack.slug, pack: pack.pack, title: pack.title, version: pack.version, state: pack.state, mailId: pack.mailId,
      createdAt: pack.createdAt, updatedAt: pack.updatedAt, closedAt: pack.closedAt,
      verdict: pack.state === 'submitted' ? result?.verdict ?? null : null,
      counts: pack.derived.counts, packState: pack.derived.pack, stale: pack.items.filter((item) => item.stale).length,
    };
  });
}

// The current version and the state of each pack, for the live `review` events. It reads no pack content and
// returns [] when the database does not exist, so a poll never creates it.
export function packHeads({ dir, slug, pack } = {}) {
  if (typeof dir !== 'string' || !dir || !fs.existsSync(databaseFile(dir))) return [];
  const { db } = open(dir);
  if (slug !== undefined) {
    checkName(slug);
    checkName(pack, 'slug', 'The pack ID');
    return db.prepare('SELECT slug, pack, current_version AS version, state FROM review_packs WHERE slug = ? AND pack = ?').all(slug, pack);
  }
  return db.prepare('SELECT slug, pack, current_version AS version, state FROM review_packs ORDER BY slug, pack').all();
}

// One stored file of a version, looked up by its manifest path. A route never joins a client path to a folder:
// the client path must equal a row of review_files, and the file on disk comes from the `stored` column.
// It returns { path, sha256, bytes, type, file } with `file` as the absolute path, or null when the row is missing.
export function getFile({ dir, slug, pack, version, file } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  if (!Number.isInteger(version) || version < 1) throw invalid('The version must be a whole number of 1 or more.');
  if (typeof file !== 'string' || !file) return null;
  const row = open(dir).db.prepare('SELECT path, sha256, bytes, type, stored FROM review_files WHERE slug = ? AND pack = ? AND version = ? AND path = ?').get(slug, pack, version, file);
  if (!row) return null;
  const root = packDirectory(dir, slug, pack, version);
  const target = path.join(root, ...safeRelative(row.stored));
  if (!inside(root, target)) throw new ReviewStoreError('path', 'The stored path leaves the version folder.');
  return { path: row.path, sha256: row.sha256, bytes: row.bytes, type: row.type, file: target };
}

// The newest result of a pack, or the result of one version, with its Markdown summary. It returns null when there is none.
// It returns { version, verdict, note, result, markdown, submittedAt, messageId }.
export function getResultRecord({ dir, slug, pack, version } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const { db } = open(dir);
  const row = version === undefined
    ? db.prepare('SELECT * FROM review_results WHERE slug = ? AND pack = ? ORDER BY version DESC LIMIT 1').get(slug, pack)
    : db.prepare('SELECT * FROM review_results WHERE slug = ? AND pack = ? AND version = ?').get(slug, pack, version);
  if (!row) return null;
  const result = parseJson(row.result, null);
  return {
    version: row.version, verdict: row.verdict, note: row.note, result, submittedAt: row.submitted_at, messageId: row.message_id,
    markdown: row.markdown ?? (result ? resultMarkdown(result) : ''),
  };
}

// The newest result of a pack, or the result of one version, as the JSON object. It returns null when there is none.
export function getResult(options = {}) {
  return getResultRecord(options)?.result ?? null;
}

// Link the result message of a version. The message is the Owner record that the Mailbox delivers.
export function setResultMessage({ dir, slug, pack, version, messageId } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const sqlite = open(dir);
  const changes = sqlite.db.prepare('UPDATE review_results SET message_id = ? WHERE slug = ? AND pack = ? AND version = ?').run(messageId ?? null, slug, pack, version).changes;
  if (!changes) throw new ReviewStoreError('not-found', 'The result does not exist.');
  sqlite.secureFiles();
  return { ok: true };
}

// getPack, listPacks, getResult, and deletePack take no clock: they read or delete only.
export function setMailId({ dir, slug, pack, mailId } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const sqlite = open(dir);
  const changes = sqlite.db.prepare('UPDATE review_packs SET mail_id = ? WHERE slug = ? AND pack = ?').run(mailId ?? null, slug, pack).changes;
  if (!changes) throw new ReviewStoreError('not-found', 'The pack does not exist.');
  sqlite.secureFiles();
  return { ok: true };
}

// ---------- Answers ----------

// Reopen one unanswered or changed item of the submitted current version. Other items stay locked.
export function reopenItem({ dir, now, slug, pack, item, session } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  checkName(item, 'invalid', 'The item ID');
  const at = stamp(now);
  return transaction(open(dir), (db) => {
    const row = loadPack(db, slug, pack);
    if (!row) throw new ReviewStoreError('not-found', 'The pack does not exist.');
    if (row.state !== 'submitted') throw new ReviewStoreError('closed', `The pack is ${row.state}. Only a submitted pack has locked items to reopen.`);
    if (session !== undefined) {
      const version = db.prepare('SELECT manifest FROM review_versions WHERE slug = ? AND pack = ? AND version = ?').get(slug, pack, row.current_version);
      if (parseJson(version?.manifest, {}).session !== session) throw new ReviewStoreError('invalid', 'A planner session can reopen only a pack published by that session.');
    }
    const current = db.prepare('SELECT i.hash, i.spec FROM review_items i WHERE i.slug = ? AND i.pack = ? AND i.version = ? AND i.item = ?')
      .get(slug, pack, row.current_version, item);
    if (!current) throw invalid('The item is not in the current version of the pack.');
    const spec = parseJson(current.spec, { ask: [] });
    const answerRow = db.prepare('SELECT * FROM review_answers WHERE slug = ? AND pack = ? AND item = ?').get(slug, pack, item);
    const answer = answerRow ? answerShape(answerRow, current.hash) : null;
    if (!['open', 'changed'].includes(itemState(spec, answer))) throw invalid('Only an open item can be reopened.');
    const existing = db.prepare('SELECT active FROM review_reopened_items WHERE slug = ? AND pack = ? AND version = ? AND item = ?')
      .get(slug, pack, row.current_version, item);
    if (existing?.active === 1) return { ok: true, already: true };
    db.prepare(`INSERT INTO review_reopened_items(slug, pack, version, item, active, opened_at) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(slug, pack, version, item) DO UPDATE SET active = 1, op_id = NULL, opened_at = excluded.opened_at`)
      .run(slug, pack, row.current_version, item, at);
    return { ok: true, already: false };
  });
}

function requireOpenPack(db, slug, pack) {
  const row = loadPack(db, slug, pack);
  if (!row) throw new ReviewStoreError('not-found', 'The pack does not exist.');
  if (row.state !== 'open') throw new ReviewStoreError('closed', `The pack is ${row.state}. Publish a new version to review it again.`);
  return row;
}

function checkNote(value, allowed) {
  if (typeof value !== 'string' || value.length > NOTE_MAX) throw invalid(`A note must be text of at most ${NOTE_MAX} characters.`);
  if (value && !allowed) throw invalid('The item does not ask for a note.');
  return value;
}

function checkPins(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > PINS_MAX) throw invalid(`The pins must be a list of at most ${PINS_MAX} pins.`);
  return value.map((pin) => {
    const fraction = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (!pin || typeof pin !== 'object' || !Number.isInteger(pin.n) || pin.n < 1 || pin.n > 999 || !fraction(pin.x) || !fraction(pin.y)) throw invalid('A pin needs a whole number n and x and y from 0 to 1.');
    const out = { n: pin.n, x: pin.x, y: pin.y };
    for (const key of ['src', 'anchor', 'text']) {
      if (pin[key] === undefined) continue;
      if (typeof pin[key] !== 'string' || pin[key].length > 200) throw invalid(`The pin ${key} must be text of at most 200 characters.`);
      if (redactSecrets(pin[key]) !== pin[key]) throw invalid(`The pin ${key} looks like it holds a secret: a token, a key, or a password. Herdr Boss did not store it.`);
      out[key] = pin[key];
    }
    return out;
  });
}

// Apply the patch to the fields of an answer, checked against the questions of the item.
function applyPatch(fields, patch, spec) {
  const ask = spec.ask || [];
  const has = (name) => Object.hasOwn(patch, name);
  if (has('decision')) {
    if (patch.decision !== null && patch.decision !== SKIP && !DECISIONS.includes(patch.decision)) throw invalid('The decision must be accept, deny, skip, or null.');
    if (patch.decision !== null && patch.decision !== SKIP && !ask.includes(patch.decision)) throw invalid(`The item does not ask for ${patch.decision}.`);
    fields.decision = patch.decision;
  }
  if (has('choice')) {
    if (patch.choice !== null) {
      if (!ask.includes('choice') || !(spec.choices || []).some((choice) => choice.id === patch.choice)) throw invalid('The choice is not one of the choices of the item.');
    }
    fields.choice = patch.choice;
  }
  if (has('rating')) {
    if (patch.rating !== null) {
      const max = spec.rating?.max;
      if (!ask.includes('rating') || !Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > max) throw invalid('The rating is not a whole number from 1 to the maximum of the item.');
    }
    fields.rating = patch.rating;
  }
  if (has('live')) {
    if (patch.live !== null && !['pending', 'done'].includes(patch.live)) throw invalid('The live check must be pending, done, or null.');
    if (patch.live !== null && !ask.includes('live')) throw invalid('The item does not ask for a live check.');
    fields.live = patch.live;
  }
  // A choice, a rating, or a live check answers the item, so it is no longer skipped.
  if (!has('decision') && fields.decision === SKIP && ['choice', 'rating', 'live'].some((name) => has(name) && patch[name] !== null)) fields.decision = null;
  if (has('viewed')) {
    if (typeof patch.viewed !== 'boolean') throw invalid('Viewed must be true or false.');
    fields.viewed = patch.viewed ? 1 : 0;
  }
  if (has('note')) fields.note = checkNote(patch.note, ask.includes('note'));
  if (has('pins')) {
    const pins = checkPins(patch.pins);
    if (pins?.length && !ask.includes('note')) throw invalid('The item does not ask for a note, so it takes no pins.');
    fields.pins = pins === null ? null : JSON.stringify(pins);
  }
  if (has('checks')) {
    if (patch.checks !== null) {
      const ids = new Set((spec.entries || []).map((entry) => entry.id));
      if (!patch.checks || typeof patch.checks !== 'object' || Array.isArray(patch.checks) || Object.entries(patch.checks).some(([id, value]) => !ids.has(id) || typeof value !== 'boolean')) throw invalid('The checks must map entry IDs of the item to true or false.');
    }
    fields.checks = patch.checks === null ? null : JSON.stringify(patch.checks);
  }
}

// Keep: put the earlier verdict of a changed item back. The row still holds the earlier decision, choice, rating,
// live check, viewed mark, and checks. The earlier verdict must fit the changed item, or the call is refused.
function restorePrevious(fields, existing, hash, spec) {
  const changed = existing && (existing.stale === 1 || existing.hash !== hash);
  if (!changed || !hasVerdict(previousOf(existing))) throw invalid('The item has no changed answer to keep.');
  const earlier = { decision: existing.decision, choice: existing.choice, rating: existing.rating, live: existing.live };
  applyPatch({}, Object.fromEntries(Object.entries(earlier).filter(([, value]) => value !== null)), spec);
  Object.assign(fields, earlier, { viewed: existing.viewed, checks: existing.checks });
}

// Change one answer. `patch.rev` is the rev that the client saw (0 for a new answer). A stale rev returns
// { ok: false, conflict: true, current }, which the route maps to 409. Only the given fields change.
// A retried `patch.opId` returns the stored answer and changes nothing.
export function putAnswer({ dir, now, slug, pack, item, patch } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('The change must be an object.');
  for (const key of Object.keys(patch)) if (!PATCH_KEYS.has(key)) throw invalid(`The change holds the unknown field ${key}.`);
  if (!Number.isInteger(patch.rev) || patch.rev < 0) throw invalid('The change needs the rev that the client saw.');
  if (patch.opId !== undefined && (typeof patch.opId !== 'string' || patch.opId.length > 100)) throw invalid('The opId must be text of at most 100 characters.');
  const at = stamp(now);
  const sqlite = open(dir);
  return transaction(sqlite, (db) => {
    const packRow = loadPack(db, slug, pack);
    if (!packRow) throw new ReviewStoreError('not-found', 'The pack does not exist.');
    const current = db.prepare('SELECT i.hash, i.spec FROM review_items i JOIN review_packs p ON p.slug = i.slug AND p.pack = i.pack AND p.current_version = i.version WHERE i.slug = ? AND i.pack = ? AND i.item = ?').get(slug, pack, item);
    if (!current) throw invalid('The item is not in the current version of the pack.');
    const spec = parseJson(current.spec, { ask: [] });
    const existing = db.prepare('SELECT * FROM review_answers WHERE slug = ? AND pack = ? AND item = ?').get(slug, pack, item);
    const reopened = packRow.state === 'submitted'
      ? db.prepare('SELECT active FROM review_reopened_items WHERE slug = ? AND pack = ? AND version = ? AND item = ?').get(slug, pack, packRow.current_version, item)
      : null;
    if (existing && patch.opId !== undefined && existing.op_id === patch.opId && reopened?.active === 0) {
      return { ok: true, duplicate: true, deactivatedReopen: true, answer: answerShape(existing, current.hash) };
    }
    if (packRow.state !== 'open' && !(packRow.state === 'submitted' && reopened?.active === 1)) {
      throw new ReviewStoreError('closed', `The pack is ${packRow.state}. Publish a new version to review it again.`);
    }
    if (existing && patch.opId !== undefined && existing.op_id === patch.opId) return { ok: true, duplicate: true, answer: answerShape(existing, current.hash) };
    if ((existing?.rev ?? 0) !== patch.rev) return { ok: false, conflict: true, current: existing ? answerShape(existing, current.hash) : null };

    // A stale answer keeps its note and pins. The earlier decision, choice, rating, live check, viewed mark, and checks reset.
    const fields = {
      decision: null, choice: null, rating: null, live: null, viewed: 0, note: '', pins: null, checks: null,
    };
    if (existing) {
      Object.assign(fields, { note: existing.note, pins: existing.pins });
      if (!existing.stale && existing.hash === current.hash) Object.assign(fields, { decision: existing.decision, choice: existing.choice, rating: existing.rating, live: existing.live, viewed: existing.viewed, checks: existing.checks });
    }
    if (patch.keep === true) restorePrevious(fields, existing, current.hash, spec);
    else if (patch.keep !== undefined) throw invalid('Keep must be true.');
    // A changed item keeps its mark and its earlier verdict for a patch that holds only viewed, note, or pins.
    // Only a verdict change, Keep, or a change of the checks takes the mark off.
    const keepsMark = Boolean(existing) && (existing.stale === 1 || existing.hash !== current.hash)
      && hasVerdict(previousOf(existing)) && Object.keys(patch).every((key) => MARK_KEEPING.has(key));
    if (keepsMark) Object.assign(fields, { decision: existing.decision, choice: existing.choice, rating: existing.rating, live: existing.live, viewed: existing.viewed, checks: existing.checks });
    applyPatch(fields, patch, spec);
    const stored = keepsMark
      ? { hash: existing.hash, stale: 1, previous: JSON.stringify(previousOf(existing)) }
      : { hash: current.hash, stale: 0, previous: null };
    const rev = (existing?.rev ?? 0) + 1;
    db.prepare(`INSERT INTO review_answers(slug, pack, item, decision, choice, rating, live, viewed, note, pins, checks, hash, stale, previous, rev, op_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, pack, item) DO UPDATE SET decision = excluded.decision, choice = excluded.choice, rating = excluded.rating, live = excluded.live,
        viewed = excluded.viewed, note = excluded.note, pins = excluded.pins, checks = excluded.checks, hash = excluded.hash, stale = excluded.stale, previous = excluded.previous,
        rev = excluded.rev, op_id = excluded.op_id, updated_at = excluded.updated_at`)
      .run(slug, pack, item, fields.decision, fields.choice, fields.rating, fields.live, fields.viewed, fields.note, fields.pins, fields.checks, stored.hash, stored.stale, stored.previous, rev, patch.opId ?? null, at);
    db.prepare('UPDATE review_packs SET updated_at = ? WHERE slug = ? AND pack = ?').run(at, slug, pack);
    const saved = db.prepare('SELECT * FROM review_answers WHERE slug = ? AND pack = ? AND item = ?').get(slug, pack, item);
    if (reopened?.active === 1 && !['open', 'changed'].includes(itemState(spec, answerShape(saved, current.hash)))) {
      db.prepare('UPDATE review_reopened_items SET active = 0, op_id = ? WHERE slug = ? AND pack = ? AND version = ? AND item = ?')
        .run(patch.opId ?? null, slug, pack, packRow.current_version, item);
      return { ok: true, deactivatedReopen: true, answer: answerShape(saved, current.hash) };
    }
    return { ok: true, answer: answerShape(saved, current.hash) };
  });
}

// Change the pack note. `rev` is the note rev that the client saw.
export function putPackNote({ dir, now, slug, pack, note, rev } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  if (!Number.isInteger(rev) || rev < 0) throw invalid('The change needs the rev that the client saw.');
  checkNote(note, true);
  const at = stamp(now);
  return transaction(open(dir), (db) => {
    const row = requireOpenPack(db, slug, pack);
    if (row.note_rev !== rev) return { ok: false, conflict: true, current: { note: row.note, rev: row.note_rev } };
    db.prepare('UPDATE review_packs SET note = ?, note_rev = ?, updated_at = ? WHERE slug = ? AND pack = ?').run(note, rev + 1, at, slug, pack);
    return { ok: true, note, rev: rev + 1 };
  });
}

// ---------- Submit ----------

// Submit the current version. A pack is submitted once for each version. A second submit of the same version returns
// { ok: false, conflict: 'submitted', result }. A new version opens the pack again.
export function submitPack({ dir, now, slug, pack, verdict, note, messageId = null } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  if (!VERDICTS.includes(verdict)) throw invalid(`The verdict must be one of ${VERDICTS.join(', ')}.`);
  if (note !== undefined) checkNote(note, true);
  const at = stamp(now);
  return transaction(open(dir), (db) => {
    const row = loadPack(db, slug, pack);
    if (!row) throw new ReviewStoreError('not-found', 'The pack does not exist.');
    const existing = db.prepare('SELECT result FROM review_results WHERE slug = ? AND pack = ? AND version = ?').get(slug, pack, row.current_version);
    if (existing) return { ok: false, conflict: 'submitted', result: parseJson(existing.result, null) };
    if (row.state !== 'open') throw new ReviewStoreError('closed', `The pack is ${row.state}. Publish a new version to review it again.`);
    const bound = boundResult(buildResult(getPack({ dir, slug, pack }), verdict, note ?? row.note, at));
    const { result } = bound;
    db.prepare('INSERT INTO review_results(slug, pack, version, verdict, note, result, markdown, submitted_at, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(slug, pack, row.current_version, verdict, result.note, bound.json, resultMarkdown(result), at, messageId);
    db.prepare("UPDATE review_packs SET state = 'submitted', closed_at = ?, updated_at = ?, note = ? WHERE slug = ? AND pack = ?").run(at, at, result.note, slug, pack);
    return { ok: true, result };
  });
}

// ---------- Delete and sweep ----------

// Delete a pack: the files, the rows, and the results. It returns { deleted, mailId }.
export function deletePack({ dir, slug, pack } = {}) {
  checkName(slug);
  checkName(pack, 'slug', 'The pack ID');
  const sqlite = open(dir);
  const found = transaction(sqlite, (db) => {
    const row = loadPack(db, slug, pack);
    if (!row) return null;
    db.prepare('DELETE FROM review_results WHERE slug = ? AND pack = ?').run(slug, pack);
    db.prepare('DELETE FROM review_packs WHERE slug = ? AND pack = ?').run(slug, pack);
    return row;
  });
  removeTree(packDirectory(dir, slug, pack));
  return found ? { deleted: true, mailId: found.mail_id } : { deleted: false, mailId: null };
}

// Remove the leftovers of a crashed publish: a `.stage-*` folder older than 1 hour, and a version folder with no
// review_versions row. The scan holds the write lock, so a publish that is renaming its folder finishes first.
// It returns the removed folders as paths relative to the data dir.
function cleanLeftovers(sqlite, dir, time) {
  const root = path.join(path.resolve(dir), REVIEW_DIR);
  const cleaned = [];
  const list = (folder) => { try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; } };
  transaction(sqlite, (db) => {
    const known = db.prepare('SELECT 1 AS found FROM review_versions WHERE slug = ? AND pack = ? AND version = ?');
    for (const slug of list(root)) {
      if (!slug.isDirectory()) continue;
      for (const pack of list(path.join(root, slug.name))) {
        if (!pack.isDirectory()) continue;
        const base = path.join(root, slug.name, pack.name);
        for (const entry of list(base)) {
          const target = path.join(base, entry.name);
          let remove = false;
          if (entry.isDirectory() && entry.name.startsWith('.stage-')) {
            try { remove = time - fs.statSync(target).mtimeMs >= STAGE_MAX_AGE; } catch { remove = false; }
          } else if (entry.isDirectory() && /^v[1-9][0-9]*$/.test(entry.name)) {
            remove = !known.get(slug.name, pack.name, Number(entry.name.slice(1)));
          }
          if (!remove) continue;
          removeTree(target);
          cleaned.push(path.relative(path.resolve(dir), target).split(path.sep).join('/'));
        }
      }
    }
  });
  return cleaned;
}

// The retention sweep. A submitted or expired pack loses its files and rows 30 days after it closed. An open pack with no
// change for 60 days expires. A result stays 180 days. It returns { deleted, expired, purged, cleaned }.
// The caller closes the Mailbox item of an expired pack and sends the notice.
export function sweep({ dir, now } = {}) {
  const at = stamp(now);
  const time = Date.parse(at);
  const sqlite = open(dir);
  const deleted = [];
  const expired = [];
  for (const row of sqlite.db.prepare('SELECT * FROM review_packs').all()) {
    if (row.state === 'open') {
      if (time - Date.parse(row.updated_at) < LIMITS.openDays * DAY) continue;
      transaction(sqlite, (db) => db.prepare("UPDATE review_packs SET state = 'expired', closed_at = ? WHERE slug = ? AND pack = ?").run(at, row.slug, row.pack));
      expired.push({ slug: row.slug, pack: row.pack, title: row.title, mailId: row.mail_id });
    } else if (time - Date.parse(row.closed_at) >= LIMITS.submittedDays * DAY) {
      transaction(sqlite, (db) => db.prepare('DELETE FROM review_packs WHERE slug = ? AND pack = ?').run(row.slug, row.pack));
      removeTree(packDirectory(dir, row.slug, row.pack));
      deleted.push({ slug: row.slug, pack: row.pack, title: row.title, mailId: row.mail_id });
    }
  }
  const cleaned = cleanLeftovers(sqlite, dir, time);
  const cutoff = new Date(time - LIMITS.resultDays * DAY).toISOString();
  const purged = transaction(sqlite, (db) => db.prepare('DELETE FROM review_results WHERE submitted_at < ?').run(cutoff).changes);
  return { deleted, expired, purged, cleaned };
}
