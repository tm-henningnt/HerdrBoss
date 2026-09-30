// The raw route of legacy HTML pages in a review pack. See docs/ideas/review-packs.md, section Legacy HTML packs.
// The dashboard gets a token from POST /api/reviews/:slug/:pack/raw-token and puts the token in the URL of a sandboxed
// iframe: GET /review-raw/<token>/<path>. The frame has an opaque origin and sends no cookie, so the token is the credential.
// The server calls handle() before the same-origin check, and issue() after the normal access checks.
// The token store is in memory only. A refusal of the raw route always has the same 404 body.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reviewStore from './review-store.js';
import { detectType } from './review-pack.js';
import { parseRange } from './review-api.js';
import { SLUG } from './projects.js';

export const TOKEN_TTL_MS = 30 * 60 * 1000;
export const TOKEN_MAX = 200;
export const BRIDGE_NAME = '__hb-bridge.js';
const BRIDGE_FILE = fileURLToPath(new URL('../public/review-bridge.js', import.meta.url));
const TOKEN = /^[0-9a-f]{64}$/;
const VERSION = /^[1-9]\d{0,8}$/;
const NAME_MAX = 256;
const HEAD_BYTES = 8192;
const HTML_MAX_BYTES = 16 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// One line. The sandbox directive also applies when a person opens the raw URL in a tab.
export const RAW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  'img-src \'self\' data: blob:',
  "media-src 'self'",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const RAW_HEADERS = {
  'content-security-policy': RAW_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const BINARY_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
const RANGED = new Set(['mp4', 'webm']);
const TEXT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const NOT_FOUND_BODY = 'Not found\n';

// The token store. A token names one pack version. lookup() returns { slug, pack, version }, or null for an unknown,
// malformed, or expired token. At the cap, issue() drops the oldest token.
export function createRawTokens({ now = () => Date.now(), ttlMs = TOKEN_TTL_MS, max = TOKEN_MAX } = {}) {
  const live = new Map();
  const purge = () => {
    const time = now();
    for (const [token, entry] of live) if (entry.expiresAt <= time) live.delete(token);
  };
  return {
    issue({ slug, pack, version }) {
      purge();
      while (live.size >= max) live.delete(live.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + ttlMs;
      live.set(token, { slug, pack, version, expiresAt });
      return { token, expiresAt };
    },
    lookup(token) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return null;
      const entry = live.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { live.delete(token); return null; }
      return { slug: entry.slug, pack: entry.pack, version: entry.version };
    },
    size() { purge(); return live.size; },
  };
}

// The parts of a file path in the raw URL, or null. Each part is decoded once. A part that is empty, a dot part,
// or holds a separator, a backslash, or NUL makes the path invalid.
function pathParts(encoded) {
  if (!encoded.length) return null;
  const parts = [];
  for (const piece of encoded) {
    let part;
    try { part = decodeURIComponent(piece); } catch { return null; }
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) return null;
    parts.push(part);
  }
  const name = parts.join('/');
  return name.length > NAME_MAX ? null : name;
}

function readHead(fd, size) {
  const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
  let got = 0;
  while (got < head.length) {
    const read = fs.readSync(fd, head, got, head.length - got, got);
    if (read === 0) break;
    got += read;
  }
  return head.subarray(0, got);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

// options: dataDir, hostAllowed(req) (the host list of the server), tokens (a token store), store (tests replace it).
export function createRawRoute({ dataDir, hostAllowed, tokens = createRawTokens(), store = reviewStore } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createRawRoute needs a data directory.');

  const refuse = (res, status = 404, extra = {}) => {
    const body = status === 404 ? NOT_FOUND_BODY : 'Method not allowed\n';
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), ...RAW_HEADERS, ...extra });
    res.end(body);
  };

  // bytes: a whole body in memory. stream: a file stream for the byte range, or null for an empty file.
  function send(req, res, { type, bytes, size, range, stream, ranged }) {
    const headers = { ...RAW_HEADERS, 'content-type': type };
    if (ranged) headers['accept-ranges'] = 'bytes';
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
    const length = bytes !== undefined ? bytes.length : size === 0 ? 0 : range ? range.end - range.start + 1 : size;
    headers['content-length'] = String(length);
    res.writeHead(range ? 206 : 200, headers);
    if (bytes !== undefined && req.method !== 'HEAD') { res.end(bytes); return; }
    if (req.method === 'HEAD' || !stream) { stream?.destroy(); res.end(); return; }
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  function serveFile(req, res, entry, version, slug, pack, token) {
    // The stored path must resolve inside the version folder, and the last part must not be a symbolic link.
    let root;
    try {
      root = fs.realpathSync(store.packDirectory(dataDir, slug, pack, version));
      const real = fs.realpathSync(entry.file);
      if (!real.startsWith(root + path.sep)) return refuse(res);
    } catch { return refuse(res); }
    let fd;
    try { fd = fs.openSync(entry.file, fs.constants.O_RDONLY | NOFOLLOW); } catch { return refuse(res); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== entry.bytes) return refuse(res);
      const head = readHead(fd, stat.size);
      const kind = detectType(head);
      const extension = path.extname(entry.path).toLowerCase();
      const html = kind === 'html' || (kind === 'text' && (extension === '.html' || extension === '.htm'));
      if (html) {
        if (stat.size > HTML_MAX_BYTES) return refuse(res);
        const page = Buffer.alloc(stat.size);
        let got = 0;
        while (got < stat.size) {
          const read = fs.readSync(fd, page, got, stat.size - got, got);
          if (read === 0) break;
          got += read;
        }
        if (got !== stat.size) return refuse(res);
        const tag = Buffer.from(`<script src="/review-raw/${token}/${BRIDGE_NAME}"></script>`, 'utf8');
        return send(req, res, { type: 'text/html; charset=utf-8', bytes: Buffer.concat([page, tag]) });
      }
      const type = BINARY_TYPES[kind] ?? (kind === 'text' ? (TEXT_TYPES[extension] ?? 'text/plain; charset=utf-8') : null);
      if (!type) return refuse(res);
      let range = null;
      if (RANGED.has(kind) && req.headers.range) {
        range = parseRange(req.headers.range, stat.size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { ...RAW_HEADERS, 'content-range': `bytes */${stat.size}`, 'content-length': '0' });
          res.end();
          return undefined;
        }
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : stat.size - 1;
      if (stat.size === 0) return send(req, res, { type, size: 0, range: null, stream: null, ranged: RANGED.has(kind) });
      const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
      send(req, res, { type, size: stat.size, range, stream, ranged: RANGED.has(kind) });
      fd = undefined;
      return undefined;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the descriptor is closed */ } }
    }
  }

  // GET or HEAD /review-raw/<token>/<path>. Each refusal has the same 404 body, so a caller learns nothing.
  function handle(req, res) {
    if (!hostAllowed(req)) return refuse(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, { allow: 'GET, HEAD' });
    const target = String(req.url || '').split(/[?#]/)[0];
    if (!target.startsWith('/review-raw/')) return refuse(res);
    const pieces = target.slice('/review-raw/'.length).split('/');
    const token = pieces[0];
    const found = tokens.lookup(token);
    if (!found) return refuse(res);
    if (pieces.length === 2 && pieces[1] === BRIDGE_NAME) {
      let bytes;
      try { bytes = fs.readFileSync(BRIDGE_FILE); } catch { return refuse(res); }
      return send(req, res, { type: 'text/javascript; charset=utf-8', bytes });
    }
    const name = pathParts(pieces.slice(1));
    if (!name) return refuse(res);
    let entry;
    try { entry = store.getFile({ dir: dataDir, slug: found.slug, pack: found.pack, version: found.version, file: name }); } catch { return refuse(res); }
    if (!entry) return refuse(res);
    return serveFile(req, res, entry, found.version, found.slug, found.pack, token);
  }

  // POST /api/reviews/:slug/:pack/raw-token[?version=N]. The server has run the access checks. The token names
  // the current version, or the version in the query.
  function issue(req, res, slug, pack, url) {
    req.resume();
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return sendJson(res, 405, { error: 'Use POST for this route.' }); }
    if (!SLUG.test(slug) || !SLUG.test(pack)) return sendJson(res, 400, { error: 'The project slug and the pack ID must match [a-z0-9][a-z0-9-]* and have at most 64 characters.' });
    const text = url.searchParams.get('version');
    if (text !== null && !VERSION.test(text)) return sendJson(res, 400, { error: 'The version must be a whole number of 1 or more.' });
    let found;
    try { found = store.getPack({ dir: dataDir, slug, pack, version: text === null ? undefined : Number(text) }); } catch { found = null; }
    if (!found) return sendJson(res, 404, { error: 'The pack or the version does not exist.' });
    return sendJson(res, 200, tokens.issue({ slug, pack, version: found.version }));
  }

  return { handle, issue, tokens };
}
