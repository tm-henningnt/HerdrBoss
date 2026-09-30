// The routes of hosted review packs under /api/reviews. See docs/ideas/review-packs.md, section API.
// The server calls handle() after the host check, the same-origin check, the access check, and the read-only preview guard.
// The handlers read and write only through src/review-store.js. A file route never joins a client path to a folder:
// the client path must equal a stored file row, and the file on disk comes from the stored name.
import fs from 'node:fs';
import * as reviewStore from './review-store.js';
import { ReviewStoreError } from './review-store.js';
import { detectType } from './review-pack.js';
import { scrub } from './project-new-api.js';
import { SLUG } from './projects.js';

export const ITEM_BODY_LIMIT = 64 * 1024;
export const NOTE_BODY_LIMIT = 16 * 1024;
export const SUBMIT_BODY_LIMIT = 16 * 1024;
const VERSION = /^[1-9]\d{0,8}$/;
const NAME_MAX = 256;
const HEAD_BYTES = 8192;
const DRAIN_BYTES = 1024 * 1024;
const DESTROY_DELAY_MS = 1000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const FILE_CSP = "default-src 'none'; sandbox";
const STATES = ['open', 'done'];

// The content type of a stored file, by the type that its first bytes give. SVG, HTML, and unknown binary are not served.
const SERVED = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  text: 'text/plain; charset=utf-8',
};
const RANGED = new Set(['mp4', 'webm']);

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...headers });
  res.end(JSON.stringify(body));
}

// The status of a store error. A message never holds an absolute path.
const STORE_STATUS = { slug: 400, invalid: 400, 'not-found': 404, closed: 409 };

function describe(error) {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message, ...Object.fromEntries(Object.entries(error.extra).filter(([key]) => key !== 'drain')) } };
  if (error instanceof ReviewStoreError) {
    const status = STORE_STATUS[error.code] ?? 500;
    return { status, body: { error: scrub(error.message).slice(0, 400), code: error.code } };
  }
  return { status: 500, body: { error: scrub(String(error?.message || 'The review request failed.')).slice(0, 400) } };
}

// Read a JSON object of at most `limit` bytes. A body over the limit gets the 413 at once. The server then reads at most
// DRAIN_BYTES more and drops it, so the client can read the 413. Then it ends the socket and destroys it after a short delay.
// A `Connection: close` header is not used: Node then destroys the socket at once, and the reset can discard the 413 on the client.
function readJson(req, limit) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(new HttpError(400, 'Content-Type must be application/json.'));
  return new Promise((resolve, reject) => {
    let size = 0;
    let refused = false;
    let stopped = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (refused) {
        // Stop reading. End the socket after the 413 is out, and destroy it later: an early destroy can discard the 413 on the client.
        if (size > limit + DRAIN_BYTES && !stopped) {
          stopped = true;
          req.pause();
          req.socket?.end();
          setTimeout(() => req.destroy(), DESTROY_DELAY_MS).unref();
        }
        return;
      }
      if (size > limit) { refused = true; chunks.length = 0; reject(new HttpError(413, `The body is larger than ${limit} bytes.`, { drain: true })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new HttpError(400, 'The body is not valid JSON.')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) reject(new HttpError(400, 'The body must be a JSON object.'));
      else resolve(value);
    });
    req.on('error', reject);
  });
}

function onlyFields(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, `Unknown field: ${key.slice(0, 40)}.`);
}

function slugPart(value, label) {
  if (!SLUG.test(value)) throw new HttpError(400, `${label} must match [a-z0-9][a-z0-9-]* and have at most 64 characters.`);
  return value;
}

// A file name from the route: the parts of a relative path. It has no empty part, no dot part, no separator inside a part, and no NUL.
function fileName(parts) {
  const bad = () => new HttpError(400, 'The file name is not valid.');
  if (!parts.length) throw bad();
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) throw bad();
  }
  const name = parts.join('/');
  if (name.length > NAME_MAX) throw bad();
  return name;
}

// The Range header of a GET or HEAD. It returns null (send the whole file), 'unsatisfiable', or { start, end }.
export function parseRange(header, size) {
  const match = /^bytes=(.+)$/i.exec(header || '');
  if (!match) return null;
  const specs = match[1].split(',');
  if (specs.length !== 1) return null;
  const spec = /^\s*(\d*)-(\d*)\s*$/.exec(specs[0]);
  if (!spec || (spec[1] === '' && spec[2] === '')) return null;
  if (spec[1] === '') {
    const count = Number(spec[2]);
    if (count === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - count), end: size - 1 };
  }
  const start = Number(spec[1]);
  const last = spec[2] === '' ? size - 1 : Number(spec[2]);
  if (start >= size || last < start) return 'unsatisfiable';
  return { start, end: Math.min(last, size - 1) };
}

const etagMatches = (header, etag) => header.split(',').some((part) => part.trim() === '*' || part.trim().replace(/^W\//, '') === etag);

// options: dataDir, store (tests replace it), now (a function that gives the time in ms).
export function createReviewApi({ dataDir, store = reviewStore, now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createReviewApi needs a data directory.');
  const where = (slug, pack) => ({ dir: dataDir, slug, pack });

  function list(url) {
    const state = url.searchParams.get('state') ?? 'open';
    if (!STATES.includes(state)) throw new HttpError(400, 'The state must be open or done.');
    return { status: 200, body: store.listPacks({ dir: dataDir, state }) };
  }

  function getPack(slug, pack, url) {
    const text = url.searchParams.get('version');
    if (text !== null && !VERSION.test(text)) throw new HttpError(400, 'The version must be a whole number of 1 or more.');
    const found = store.getPack({ ...where(slug, pack), version: text === null ? undefined : Number(text) });
    if (!found) throw new HttpError(404, 'The pack or the version does not exist.');
    return { status: 200, body: found };
  }

  async function putItem(req, slug, pack, item) {
    slugPart(item, 'The item ID');
    const patch = await readJson(req, ITEM_BODY_LIMIT);
    const saved = store.putAnswer({ ...where(slug, pack), now: now(), item, patch });
    if (saved.conflict) return { status: 409, body: { error: 'The answer changed on another device. The current answer is in this response.', conflict: true, current: saved.current } };
    return { status: 200, body: saved };
  }

  async function putNote(req, slug, pack) {
    const body = await readJson(req, NOTE_BODY_LIMIT);
    onlyFields(body, ['note', 'rev']);
    const saved = store.putPackNote({ ...where(slug, pack), now: now(), note: body.note, rev: body.rev });
    if (saved.conflict) return { status: 409, body: { error: 'The note changed on another device. The current note is in this response.', conflict: true, current: saved.current } };
    return { status: 200, body: saved };
  }

  async function submit(req, slug, pack) {
    const body = await readJson(req, SUBMIT_BODY_LIMIT);
    onlyFields(body, ['verdict', 'note']);
    const saved = store.submitPack({ ...where(slug, pack), now: now(), verdict: body.verdict, note: body.note });
    if (saved.conflict) return { status: 409, body: { error: 'This version was submitted before. The first result is in this response.', conflict: saved.conflict, result: saved.result } };
    return { status: 200, body: saved };
  }

  // One stored file, with the type from its bytes, an ETag from its sha256, and ranges for video.
  function serveFile(req, res, slug, pack, versionText, parts) {
    if (!VERSION.test(versionText)) throw new HttpError(400, 'The version must be a whole number of 1 or more.');
    const version = Number(versionText);
    const name = fileName(parts);
    const entry = store.getFile({ ...where(slug, pack), version, file: name });
    if (!entry) throw new HttpError(404, 'The file does not exist.');

    // The stored path must resolve inside the version folder, and the last part must not be a symbolic link.
    let real;
    try {
      const root = fs.realpathSync(store.packDirectory(dataDir, slug, pack, version));
      real = fs.realpathSync(entry.file);
      if (real !== root && !real.startsWith(root + '/')) throw new Error('outside');
    } catch { throw new HttpError(404, 'The file does not exist.'); }
    let fd;
    try { fd = fs.openSync(entry.file, fs.constants.O_RDONLY | NOFOLLOW); } catch { throw new HttpError(404, 'The file does not exist.'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== entry.bytes) throw new HttpError(500, 'The stored file changed after the publish.');
      const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
      let got = 0;
      while (got < head.length) {
        const read = fs.readSync(fd, head, got, head.length - got, got);
        if (read === 0) break;
        got += read;
      }
      const type = detectType(head.subarray(0, got));
      const contentType = SERVED[type];
      if (!contentType) throw new HttpError(415, 'The stored file has a type that Herdr Boss does not serve.');
      const etag = `"${entry.sha256}"`;
      const headers = {
        'content-type': contentType,
        etag,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': FILE_CSP,
        'cross-origin-resource-policy': 'same-origin',
        'content-disposition': 'inline',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      };
      const ranged = RANGED.has(type);
      if (ranged) headers['accept-ranges'] = 'bytes';

      if (req.headers['if-none-match'] && etagMatches(req.headers['if-none-match'], etag)) {
        fs.closeSync(fd);
        res.writeHead(304, { etag, 'cache-control': headers['cache-control'] });
        res.end();
        return;
      }
      let range = null;
      if (ranged && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) range = parseRange(req.headers.range, stat.size);
      if (range === 'unsatisfiable') {
        fs.closeSync(fd);
        res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}`, 'content-length': '0' });
        res.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : stat.size - 1;
      const length = stat.size === 0 ? 0 : end - start + 1;
      if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['content-length'] = String(length);
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || length === 0) {
        fs.closeSync(fd);
        res.end();
        return;
      }
      const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      fd = undefined;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the descriptor is closed */ } }
    }
  }

  // Handle one request under /api/reviews. `url` is the parsed request URL.
  async function handle(req, res, url) {
    try {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const parts = url.pathname.split('/').slice(3);
      let rest;
      try { rest = parts.map((part) => decodeURIComponent(part)); } catch { throw new HttpError(400, 'The path is not valid.'); }
      const allow = (...methods) => {
        if (!methods.includes(method)) throw new HttpError(405, `Use ${methods.join(' or ')} for this route.`, { allow: methods.join(', ') });
      };
      let result;
      if (rest.length === 0) {
        allow('GET');
        result = list(url);
      } else {
        const slug = slugPart(rest[0], 'The project slug');
        if (rest.length === 1) throw new HttpError(404, 'The route does not exist.');
        const pack = slugPart(rest[1], 'The pack ID');
        if (rest.length === 2) {
          allow('GET');
          result = getPack(slug, pack, url);
        } else if (rest[2] === 'files' && rest.length >= 5) {
          allow('GET');
          return serveFile(req, res, slug, pack, rest[3], rest.slice(4));
        } else if (rest[2] === 'items' && rest.length === 4) {
          allow('PUT');
          result = await putItem(req, slug, pack, rest[3]);
        } else if (rest[2] === 'note' && rest.length === 3) {
          allow('PUT');
          result = await putNote(req, slug, pack);
        } else if (rest[2] === 'submit' && rest.length === 3) {
          allow('POST');
          result = await submit(req, slug, pack);
        } else {
          throw new HttpError(404, 'The route does not exist.');
        }
      }
      return sendJson(res, result.status, result.body);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return undefined; }
      const { status, body } = describe(error);
      const headers = {};
      if (error instanceof HttpError && error.extra.allow) headers.allow = error.extra.allow;
      return sendJson(res, status, body, headers);
    }
  }

  return { handle };
}
