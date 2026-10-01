// Validation of a review pack folder. See docs/ideas/review-packs.md.
// The module reads only inside the pack folder and writes nothing. It returns all errors at once.
//
// Markdown rules. Item text is shown with renderMarkdown() from public/markdown.js. That renderer
// allows paragraphs, emphasis, code, headings, lists, task lists, quotes, rules, tables, and links
// that pass safeUrl(). It escapes every raw HTML tag as text and has no image tag.
// This validator therefore refuses: script, iframe, object, embed, style, link, meta, base, and form
// tags, an on* event attribute, and a link whose URL fails safeUrl(). It warns about any other raw
// HTML tag and about an inline image, because the viewer shows both as plain text.
// The Markdown scan is one linear pass. Each tag scan looks at 200 characters at most.
//
// Limits. The checks for the file count, the total size, the size of one file, and the item counts
// run before any file content is read. A breach of the count or of the total stops the validation.
// A file that the manifest names twice counts once, is read once, and is hashed once. The same
// image can serve two items.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeUrl } from '../public/markdown.js';
import { SLUG } from './projects.js';
import { scanText } from './secret-scan.js';

export const SCHEMA = 'herdr-boss.review-pack/1';
export const DEFAULT_LIMITS = Object.freeze({
  totalBytes: 128 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  files: 1000,
  textBytes: 2 * 1024 * 1024,
  markdownBytes: 200 * 1024,
  manifestBytes: 1024 * 1024,
  sections: 40,
  items: 400,
  itemsPerSection: 100,
  depth: 8,
  megapixels: 40,
  side: 16384,
});

const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const LABEL_MAX = 200;
const ALT_MAX = 500;
const PATH_MAX = 256;
const HEAD_BYTES = 1024 * 1024;
const MAX_ERRORS = 200;
const TAG_SPAN = 200;
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'form']);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const TYPES = new Set(['image', 'image-pair', 'gallery', 'video', 'markdown', 'table', 'diff', 'file', 'link', 'checklist', 'page', 'custom']);
const ASK = ['accept', 'deny', 'note', 'live', 'choice', 'rating'];
const DEFAULT_ASK = ['accept', 'deny', 'note'];
const VARIANTS = new Set(['theme', 'before-after', 'compare']);
const VERIFIED_BY = new Set(['agent-verified', 'needs-you']);
const DESIGN_RESULTS = new Set(['passed', 'issues', 'not-run']);
const IMAGE_TYPES = new Set(['png', 'jpeg', 'webp', 'gif']);
const VIDEO_TYPES = new Set(['mp4', 'webm']);
const EXTENSION_TYPES = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif', '.mp4': 'mp4', '.webm': 'webm', '.svg': 'svg', '.html': 'html', '.htm': 'html' };
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;

// ---------- Helpers ----------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

// The path fields of a normalized item, in a fixed order.
function itemPaths(item) {
  const paths = [];
  const add = (ref) => { if (ref?.src) paths.push(ref.src); };
  if (item.src) paths.push(item.src);
  if (item.poster) paths.push(item.poster);
  add(item.a); add(item.b);
  for (const image of item.images || []) add(image);
  add(item.body);
  for (const evidence of item.evidence || []) if (typeof evidence === 'string') paths.push(evidence);
  return paths;
}

// The hash of one item: its normalized fields without the ID, and the hashes of its files.
// `fileHashes` maps a pack path to the SHA-256 hex of the file.
export function itemHash(item, fileHashes) {
  const { id, hash, files, ...fields } = item;
  const list = itemPaths(fields).map((file) => `${file}=${fileHashes.get(file) ?? ''}`);
  return `sha256:${sha256(canonical(fields), '\n', list.join('\n'))}`;
}

function limitsFrom(options) { return { ...DEFAULT_LIMITS, ...(options.limits || {}) }; }

// ---------- File type by magic bytes ----------

function isUtf8Text(buffer) {
  if (buffer.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return true; } catch { return false; }
}

// The type of a file from its first bytes: png, jpeg, webp, gif, mp4, webm, svg, html, text, or binary.
export function detectType(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3 && head.subarray(0, 64).includes('webm')) return 'webm';
  const sample = head.length > 8192 ? trimUtf8(head.subarray(0, 8192)) : head;
  if (isUtf8Text(sample)) {
    const start = stripPrologue(sample.subarray(0, 4096).toString('utf8').replace(/^\ufeff/, ''));
    if (/^<svg[\s>]/i.test(start)) return 'svg';
    if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(start)) return 'html';
    return 'text';
  }
  return 'binary';
}

// Remove leading white space, an XML declaration, comments, and an SVG doctype. One pass, no backtracking.
function stripPrologue(text) {
  let rest = text;
  for (let guard = 0; guard < 64; guard += 1) {
    rest = rest.trimStart();
    let end = -1;
    if (rest.startsWith('<?xml')) end = rest.indexOf('?>') + 2;
    else if (rest.startsWith('<!--')) end = rest.indexOf('-->') + 3;
    else if (/^<!doctype svg/i.test(rest)) end = rest.indexOf('>') + 1;
    else break;
    if (end < 3) return '';
    rest = rest.slice(end);
  }
  return rest;
}

// A cut at 8192 bytes can split a multi-byte character. Drop the last bytes of a partial sequence.
function trimUtf8(buffer) {
  let end = buffer.length;
  while (end > 0 && end > buffer.length - 4 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0 && buffer[end - 1] >= 0xc0) end -= 1;
  return buffer.subarray(0, end);
}

// The pixel size from the header, or null when the header is short or damaged.
export function imageSize(head, type) {
  try {
    if (type === 'png') {
      if (head.length < 24 || head.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (type === 'gif') return head.length >= 10 ? { width: head.readUInt16LE(6), height: head.readUInt16LE(8) } : null;
    if (type === 'webp') {
      const kind = head.subarray(12, 16).toString('latin1');
      if (kind === 'VP8X' && head.length >= 30) return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
      if (kind === 'VP8 ' && head.length >= 30) return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L' && head.length >= 25) {
        const bits = head.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (type === 'jpeg') {
      let offset = 2;
      while (offset + 9 < head.length) {
        if (head[offset] !== 0xff) { offset += 1; continue; }
        const marker = head[offset + 1];
        if (marker === 0xff) { offset += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const length = head.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
      return null;
    }
  } catch { return null; }
  return null;
}

// ---------- Markdown scan ----------

// One linear pass over the text. Code spans and code fences are skipped. Returns
// { script, rawHtml, badLink, image }.
export function scanMarkdown(text) {
  const out = { script: false, rawHtml: false, badLink: false, image: false };
  const brackets = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '`' || ch === '~') {
      if (text.startsWith(ch.repeat(3), i)) {
        const end = text.indexOf(ch.repeat(3), i + 3);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (ch === '`') {
        let j = i + 1;
        while (j < n && text[j] !== '`' && text[j] !== '\n') j += 1;
        i = j < n && text[j] === '`' ? j + 1 : i + 1;
        continue;
      }
    } else if (ch === '<') {
      let j = i + 1;
      if (text[j] === '/') j += 1;
      const nameStart = j;
      while (j < n && j - nameStart < 32 && /[a-z0-9-]/i.test(text[j])) j += 1;
      const after = text[j];
      if (j > nameStart && /[a-z]/i.test(text[nameStart]) && (after === undefined || after === '>' || after === '/' || /\s/.test(after))) {
        const name = text.slice(nameStart, j).toLowerCase();
        const limit = Math.min(n, i + TAG_SPAN);
        let k = j;
        while (k < limit && text[k] !== '>') k += 1;
        if (DANGEROUS_TAGS.has(name)) out.script = true;
        if (k < n && text[k] === '>') {
          if (/(^|\s)on[a-z]+\s*=/i.test(text.slice(j, k))) out.script = true;
          else if (!DANGEROUS_TAGS.has(name)) out.rawHtml = true;
          i = k + 1;
          continue;
        }
      }
    } else if (ch === '[') {
      if (brackets.length < 64) brackets.push(i);
    } else if (ch === ']') {
      const start = brackets.pop();
      if (text[i + 1] === '(') {
        const isImage = start !== undefined && start > 0 && text[start - 1] === '!';
        let j = i + 2;
        while (j < n && j < i + 10 && (text[j] === ' ' || text[j] === '\t')) j += 1;
        if (text[j] === '<') j += 1;
        let k = j;
        while (k < n && k - j < 2048 && !/[\s)>]/.test(text[k])) k += 1;
        const url = text.slice(j, k);
        if (isImage) out.image = true;
        else if (url && !safeUrl(url)) out.badLink = true;
        i = k;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// ---------- Validation ----------

// Validate the pack folder. Returns { ok, errors, warnings, manifest, files, totals, limits }.
// An error or a warning is { rule, message, where?, file? }.
// options.limits overrides DEFAULT_LIMITS. options.allowPage allows the `page` item type (the importer).
// The manifest is null when the validation stopped early or when a secret was found.
export function validatePack(folder, options = {}) {
  const limits = limitsFrom(options);
  const errors = [];
  const warnings = [];
  let halted = false;
  const error = (rule, message, extra = {}) => {
    if (errors.length >= MAX_ERRORS) return;
    errors.push({ rule, message, ...extra });
    if (errors.length === MAX_ERRORS) {
      errors.push({ rule: 'too-many-errors', message: `The pack has more than ${MAX_ERRORS} errors. Herdr Boss stopped checking.` });
      halted = true;
    }
  };
  // A breach that ends the validation: no further file is read.
  const stop = (rule, message, extra = {}) => { errors.push({ rule, message, ...extra }); halted = true; };
  const warn = (rule, message, extra = {}) => { if (warnings.length < MAX_ERRORS) warnings.push({ rule, message, ...extra }); };
  const finish = (manifest = null, files = [], totals = { files: 0, bytes: 0, items: 0, sections: 0 }) => ({ ok: errors.length === 0, errors, warnings, manifest, files, totals, limits });

  let root;
  try { root = fs.realpathSync(folder); } catch { error('folder', 'The pack folder does not exist or cannot be read.'); return finish(); }
  try { if (!fs.statSync(root).isDirectory()) throw new Error('not a folder'); } catch { error('folder', 'The pack path is not a folder.'); return finish(); }

  // The manifest. One descriptor, opened without following a link, sized before it is read.
  let raw;
  try {
    const fd = fs.openSync(path.join(root, 'manifest.json'), fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a file');
      if (stat.size > limits.manifestBytes) { error('manifest-size', `manifest.json is larger than ${limits.manifestBytes} bytes.`); return finish(); }
      raw = readBounded(fd, stat.size).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { error('manifest-missing', 'The folder has no readable manifest.json.'); return finish(); }
  let input;
  try { input = JSON.parse(raw); } catch { error('manifest-json', 'manifest.json is not valid JSON.'); return finish(); }
  if (!isObject(input)) { error('manifest-json', 'manifest.json must hold one JSON object.'); return finish(); }
  const manifestBytes = Buffer.byteLength(raw);

  // Secret scan of the manifest: the raw text, then each string, so a finding names the class only.
  const manifestClasses = new Set(scanText('manifest.json', raw));
  (function walkStrings(value) {
    if (isText(value)) for (const name of scanText('manifest.json', value)) manifestClasses.add(name);
    else if (Array.isArray(value)) value.forEach(walkStrings);
    else if (isObject(value)) Object.values(value).forEach(walkStrings);
  })(input);
  for (const name of manifestClasses) error('secret', `manifest.json holds a secret of the class "${name}".`, { file: 'manifest.json' });

  // ---------- File checks ----------
  const fileInfo = new Map(); // relative path -> file record. A path named twice has one record.
  let totalBytes = manifestBytes;

  const pathProblem = (rel) => {
    if (!isText(rel) || !rel) return 'The path must be a non-empty string.';
    if (rel.length > PATH_MAX) return `The path is longer than ${PATH_MAX} characters.`;
    if (rel.includes('\0')) return 'The path holds a NUL character.';
    if (rel.includes('\\')) return 'The path holds a backslash.';
    if (rel.startsWith('/') || /^[a-z]:/i.test(rel)) return 'The path must be relative.';
    const parts = rel.split('/');
    if (parts.some((part) => part === '..')) return 'The path holds a ".." part.';
    if (parts.some((part) => part === '' || part === '.')) return 'The path holds an empty or "." part.';
    if (parts.some((part) => part.startsWith('.'))) return 'The path names a hidden file.';
    return null;
  };

  // Check one referenced file. The first use reads it; a later use reuses the record.
  // Returns the record, or null when a check failed.
  const useFile = (rel, where, kind, itemId) => {
    if (halted) return null;
    const problem = pathProblem(rel);
    if (problem) { error('path', `${where}: ${problem}`, { where }); return null; }
    if (rel.split('/').length - 1 > limits.depth) { error('depth', `${where}: The path is deeper than ${limits.depth} folders.`, { where, file: rel }); return null; }
    let record = fileInfo.get(rel);
    if (!record) {
      if (fileInfo.size + 2 > limits.files) { stop('file-count', `The pack names more than ${limits.files} files.`, { where }); return null; }
      record = inspectFile(rel, where, kind);
      fileInfo.set(rel, record);
    }
    if (!record.ok) return null;
    if (itemId && !record.items.includes(itemId)) record.items.push(itemId);
    return checkKind(record, kind, where) ? record : null;
  };

  // Open the file once, without following a link, and read it from that descriptor once. The size
  // and the totals are checked from the descriptor before the read. The hash, the type, the image
  // size, the secret scan, and the Markdown scan all use that one buffer, and the record keeps no bytes.
  // A local attacker can still swap a folder in the path between the realpath check and the open.
  // O_NOFOLLOW covers only the last name. Herdr Boss reads a pack that its own agents wrote.
  function inspectFile(rel, where, kind) {
    const record = { path: rel, ok: false, items: [] };
    let real;
    try { real = fs.realpathSync(path.join(root, ...rel.split('/'))); } catch {
      error('file-missing', `${where}: The file ${rel} does not exist.`, { where, file: rel });
      return record;
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      error('path', `${where}: The path ${rel} leaves the pack folder.`, { where, file: rel });
      return record;
    }
    let fd;
    let buffer;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { error('file-missing', `${where}: The path ${rel} is not a file.`, { where, file: rel }); return record; }
      if (stat.size > limits.fileBytes) { error('file-size', `${where}: The file ${rel} is larger than ${limits.fileBytes} bytes.`, { where, file: rel }); return record; }
      if ((kind === 'text' || kind === 'html') && stat.size > limits.textBytes) { error('text-size', `${where}: The text file ${rel} is larger than ${limits.textBytes} bytes.`, { where, file: rel }); return record; }
      if (totalBytes + stat.size > limits.totalBytes) { stop('total-size', `The pack is larger than ${limits.totalBytes} bytes.`, { where }); return record; }
      totalBytes += stat.size;
      buffer = readBounded(fd, stat.size);
    } catch {
      error('file-unreadable', `${where}: The file ${rel} cannot be read.`, { where, file: rel });
      return record;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the descriptor is gone */ } }
    }
    let type = detectType(buffer.subarray(0, HEAD_BYTES));
    if ((type === 'text' || type === 'html') && buffer.includes(0)) type = 'binary';
    Object.assign(record, { ok: true, bytes: buffer.length, sha256: sha256(buffer), type });
    if (IMAGE_TYPES.has(type)) {
      const size = imageSize(buffer.subarray(0, HEAD_BYTES), type);
      if (size) Object.assign(record, size);
    } else if ((type === 'text' || type === 'html') && buffer.length <= limits.textBytes) {
      const text = buffer.toString('utf8');
      for (const name of scanText(rel, text)) error('secret', `The file ${rel} holds a secret of the class "${name}".`, { file: rel });
      if (/\.md$/i.test(rel) && buffer.length <= limits.markdownBytes) record.markdown = scanMarkdown(text);
    }
    return record;
  }

  // Check the detected type against what the field needs. `kind` is image, video, text, or html.
  function checkKind(record, kind, where) {
    const rel = record.path;
    const declared = EXTENSION_TYPES[path.extname(rel).toLowerCase()];
    if (record.type === 'svg') { error('svg', `${where}: The file ${rel} is an SVG. Herdr Boss refuses SVG.`, { where, file: rel }); return false; }
    if (record.type === 'html' && kind !== 'html') { error('html', `${where}: The file ${rel} is HTML. HTML is allowed only in a page item.`, { where, file: rel }); return false; }
    if (declared && declared !== record.type && !(declared === 'html' && record.type === 'text')) {
      error('content-type', `${where}: The file ${rel} has the extension of ${declared} but the content of ${record.type}.`, { where, file: rel });
      return false;
    }
    const okType = kind === 'image' ? IMAGE_TYPES.has(record.type)
      : kind === 'video' ? VIDEO_TYPES.has(record.type)
        : kind === 'html' ? record.type === 'html'
          : record.type === 'text';
    if (!okType) {
      error('content-type', `${where}: The file ${rel} is ${record.type}. This field needs ${kind === 'text' ? 'a text file' : kind === 'html' ? 'an HTML file' : `an allowed ${kind} file`}.`, { where, file: rel });
      return false;
    }
    if (kind === 'image') return checkImage(record, where);
    if ((kind === 'text' || kind === 'html') && record.bytes > limits.textBytes) {
      error('text-size', `${where}: The text file ${rel} is larger than ${limits.textBytes} bytes.`, { where, file: rel });
      return false;
    }
    return true;
  }

  function checkImage(record, where) {
    if (!record.width) { error('image-size', `${where}: The header of ${record.path} does not give an image size.`, { where, file: record.path }); return false; }
    const pixels = record.width * record.height;
    if (!record.height || record.width > limits.side || record.height > limits.side || pixels > limits.megapixels * 1_000_000) {
      error('image-size', `${where}: The image ${record.path} is ${record.width} by ${record.height} px. The limit is ${limits.megapixels} megapixels and ${limits.side} px on a side.`, { where, file: record.path });
      return false;
    }
    return true;
  }

  // ---------- Field checks ----------
  const checkText = (value, where, max, { required = false } = {}) => {
    if (value === undefined && !required) return undefined;
    if (!isText(value) || (required && !value.trim())) { error('field', `${where} must be text${required ? ' and not empty' : ''}.`, { where }); return undefined; }
    if (value.length > max) { error('field', `${where} is longer than ${max} characters.`, { where }); return undefined; }
    return value;
  };
  const checkTitle = (value, where) => {
    if (!isText(value) || !value.trim() || value.length > TITLE_MAX) { error('title', `${where} must have 1 to ${TITLE_MAX} characters.`, { where }); return undefined; }
    return value;
  };
  const checkId = (value, where, seen, what) => {
    if (!isText(value) || !SLUG.test(value)) { error('id', `${where} must match [a-z0-9][a-z0-9-]* and have at most 64 characters.`, { where }); return undefined; }
    if (seen) {
      if (seen.has(value)) { error('duplicate-id', `${where}: The ${what} ID ${value} is used twice.`, { where }); return value; }
      seen.add(value);
    }
    return value;
  };
  // The design document (rule 8) allows https, and http for a loopback or .test host. The scheme
  // must pass safeUrl(), so javascript:, data:, and mailto: fail. A URL with a user name or a
  // password fails, because it can carry a credential.
  const checkUrl = (value, where) => {
    if (!isText(value)) { error('url', `${where} must be a URL.`, { where }); return undefined; }
    const safe = safeUrl(value);
    let ok = false;
    if (safe && /^https?:\/\//i.test(safe)) {
      try {
        const url = new URL(safe);
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const local = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.test') || host.endsWith('.localhost');
        ok = (url.protocol === 'https:' || local) && !url.username && !url.password;
      } catch { ok = false; }
    }
    if (!ok) { error('url', `${where} must be an https URL, or an http URL for a loopback or .test host, with no user name or password.`, { where }); return undefined; }
    return safe;
  };

  const reportMarkdown = (result, where) => {
    if (result.script) error('markdown', `${where}: The Markdown holds a script construct or an event attribute.`, { where });
    else if (result.rawHtml) warn('markdown', `${where}: The Markdown holds raw HTML. The viewer shows it as text.`, { where });
    if (result.badLink) error('markdown', `${where}: The Markdown holds a link that Herdr Boss does not allow.`, { where });
    if (result.image) warn('markdown', `${where}: The Markdown holds an inline image. The viewer does not show it. Use an image item.`, { where });
  };
  const checkMarkdown = (text, where) => {
    if (Buffer.byteLength(text) > limits.markdownBytes) { error('text-size', `${where}: The Markdown text is larger than ${limits.markdownBytes} bytes.`, { where }); return; }
    reportMarkdown(scanMarkdown(text), where);
  };

  // A body or summary: a path to a .md file, or inline Markdown text.
  const checkBody = (value, where, itemId) => {
    if (value === undefined) return undefined;
    if (!isText(value)) { error('field', `${where} must be text.`, { where }); return undefined; }
    if (/^[^\s]+\.md$/i.test(value)) {
      const record = useFile(value, where, 'text', itemId);
      if (record?.markdown) reportMarkdown(record.markdown, `${where} (${value})`);
      else if (record) error('text-size', `${where}: The Markdown file ${value} is larger than ${limits.markdownBytes} bytes.`, { where, file: value });
      return { src: value };
    }
    checkMarkdown(value, where);
    return { text: value };
  };

  const checkImageRef = (ref, where, itemId, { label = true, caption = false } = {}) => {
    if (!isObject(ref)) { error('field', `${where} must be an object with src.`, { where }); return undefined; }
    const out = {};
    if (!isText(ref.src)) error('field', `${where}.src is required.`, { where });
    else { useFile(ref.src, `${where}.src`, 'image', itemId); out.src = ref.src; }
    if (label && ref.label !== undefined) out.label = checkText(ref.label, `${where}.label`, LABEL_MAX);
    if (ref.alt !== undefined) out.alt = checkText(ref.alt, `${where}.alt`, ALT_MAX);
    if (caption && ref.caption !== undefined) out.caption = checkText(ref.caption, `${where}.caption`, ALT_MAX);
    return out;
  };

  const checkAsk = (source, where, out) => {
    let ask = source.ask;
    if (ask === undefined) ask = [...DEFAULT_ASK];
    else if (!Array.isArray(ask) || !ask.length) { error('ask', `${where}.ask must be a non-empty list.`, { where }); ask = [...DEFAULT_ASK]; }
    else if (ask.some((value) => !ASK.includes(value))) { error('ask', `${where}.ask holds a value that is not one of ${ASK.join(', ')}.`, { where }); ask = ask.filter((value) => ASK.includes(value)); }
    else if (new Set(ask).size !== ask.length) { error('ask', `${where}.ask lists a value twice.`, { where }); ask = [...new Set(ask)]; }
    out.ask = ask;
    if (ask.includes('choice')) {
      const choices = source.choices;
      if (!Array.isArray(choices) || choices.length < 2 || choices.length > 6) error('choices', `${where}.choices must have 2 to 6 entries when ask holds choice.`, { where });
      else {
        const seen = new Set();
        out.choices = choices.map((choice, index) => {
          const at = `${where}.choices[${index}]`;
          if (!isObject(choice)) { error('choices', `${at} must be an object with id and label.`, { where: at }); return null; }
          return { id: checkId(choice.id, `${at}.id`, seen, 'choice'), label: checkText(choice.label, `${at}.label`, 100, { required: true }) };
        });
      }
    } else if (source.choices !== undefined) warn('ignored', `${where}.choices has no effect without choice in ask.`, { where });
    if (ask.includes('rating')) {
      const max = source.rating === undefined ? 5 : source.rating?.max;
      if (!Number.isInteger(max) || max < 3 || max > 10) error('rating', `${where}.rating.max must be a whole number from 3 to 10.`, { where });
      else out.rating = { max };
    }
    if (ask.includes('live') && source.liveUrl !== undefined) {
      out.liveUrl = checkUrl(source.liveUrl, `${where}.liveUrl`);
      out.external = true;
    } else if (source.liveUrl !== undefined) warn('ignored', `${where}.liveUrl has no effect without live in ask.`, { where });
  };

  let hasUnmarkedItem = false;
  const checkItem = (source, where, ids) => {
    if (!isObject(source)) { error('field', `${where} must be an object.`, { where }); return null; }
    const out = { id: checkId(source.id, `${where}.id`, ids, 'item'), title: checkTitle(source.title, `${where}.title`) };
    if (out.id === 'summary') error('id', `${where}.id must not be summary.`, { where });
    const id = out.id;
    const missing = ['description', 'steps', 'expected', 'link'].filter((field) => source[field] === undefined);
    if (missing.length) warn('item-guidance', 'Item ' + (id || '(unknown)') + ' needs ' + missing.join(', ') + '.', { where });
    if (source.verifiedBy === undefined) hasUnmarkedItem = true;
    else if (!VERIFIED_BY.has(source.verifiedBy)) error('verified-by', where + '.verifiedBy must be agent-verified or needs-you.', { where });
    else out.verifiedBy = source.verifiedBy;

    if (source.description !== undefined) {
      const description = checkText(source.description, where + '.description', TEXT_MAX, { required: true });
      if (description !== undefined) {
        const lines = description.split(/\r?\n/);
        if (lines.length !== 2 || lines.some((line) => !line.trim())) error('description', where + '.description must have two non-empty lines: what it is and why.', { where });
        else out.description = description;
      }
    }
    if (source.steps !== undefined) {
      if (!Array.isArray(source.steps) || source.steps.length < 1 || source.steps.length > 30) {
        error('steps', where + '.steps must be a list of 1 to 30 strings.', { where });
      } else {
        out.steps = source.steps.map((step, index) => checkText(step, where + '.steps[' + index + ']', 500, { required: true }));
      }
    }
    if (source.expected !== undefined) out.expected = checkText(source.expected, where + '.expected', TEXT_MAX, { required: true });
    if (source.link !== undefined) out.link = checkUrl(source.link, where + '.link');
    if (source.evidence !== undefined) {
      if (!Array.isArray(source.evidence) || source.evidence.length > 60) error('evidence', where + '.evidence must be a list of at most 60 image file references.', { where });
      else {
        out.evidence = source.evidence.map((ref, index) => {
          if (!isText(ref)) { error('evidence', where + '.evidence[' + index + '] must be a file reference.', { where }); return undefined; }
          return ref;
        }).filter((ref) => ref !== undefined);
        if (new Set(out.evidence).size !== out.evidence.length) error('evidence', where + '.evidence lists a file reference twice.', { where });
      }
    }
    if (source.verifiedBy === 'agent-verified' && (!Array.isArray(source.evidence) || source.evidence.length === 0)) {
      warn('evidence', 'Agent-verified item ' + (id || '(unknown)') + ' has no evidence.', { where });
    }
    let type = source.type;
    if (!isText(type) || !type) { error('field', `${where}.type is required.`, { where }); type = 'markdown'; }
    if (type === 'page' && !options.allowPage) { error('type', `${where}: The item type page is only for the importer.`, { where }); }
    if (!TYPES.has(type)) {
      warn('unknown-type', `${where}: Herdr Boss has no viewer for ${type.slice(0, 64)}. It shows the text.`, { where });
      out.type = 'markdown'; out.fallbackFrom = type.slice(0, 64);
    } else if (type === 'custom') {
      if (!isText(source.renderer) || !SLUG.test(source.renderer)) error('field', `${where}.renderer must be a slug.`, { where });
      out.type = 'markdown'; out.fallbackFrom = `custom:${String(source.renderer).slice(0, 64)}`;
    } else out.type = type;

    if (out.fallbackFrom) {
      out.body = checkBody(source.body ?? source.text, `${where}.body`, id);
      if (!out.body) warn('empty', `${where} has no body to show.`, { where });
    } else switch (out.type) {
      case 'image':
        Object.assign(out, checkImageRef({ src: source.src, alt: source.alt }, where, id, { label: false }));
        break;
      case 'image-pair':
        if (source.variant !== undefined && !VARIANTS.has(source.variant)) error('field', `${where}.variant must be theme, before-after, or compare.`, { where });
        out.variant = VARIANTS.has(source.variant) ? source.variant : 'compare';
        out.a = checkImageRef(source.a, `${where}.a`, id);
        out.b = checkImageRef(source.b, `${where}.b`, id);
        break;
      case 'gallery':
        if (!Array.isArray(source.images) || source.images.length < 2 || source.images.length > 60) error('field', `${where}.images must have 2 to 60 entries.`, { where });
        else out.images = source.images.map((image, index) => checkImageRef(image, `${where}.images[${index}]`, id, { label: false, caption: true }));
        break;
      case 'video':
        if (!isText(source.src)) error('field', `${where}.src is required.`, { where });
        else { useFile(source.src, `${where}.src`, 'video', id); out.src = source.src; }
        if (source.poster !== undefined) {
          if (!isText(source.poster)) error('field', `${where}.poster must be a path.`, { where });
          else { useFile(source.poster, `${where}.poster`, 'image', id); out.poster = source.poster; }
        }
        break;
      case 'markdown':
        if (source.text !== undefined) {
          if (!isText(source.text)) error('field', `${where}.text must be text.`, { where });
          else { checkMarkdown(source.text, `${where}.text`); out.text = source.text; }
        } else if (source.body === undefined) error('field', `${where} needs text or body.`, { where });
        break;
      case 'table':
        if (source.src !== undefined) {
          if (!isText(source.src)) error('field', `${where}.src must be a path.`, { where });
          else { useFile(source.src, `${where}.src`, 'text', id); out.src = source.src; }
        } else if (!Array.isArray(source.columns) || !Array.isArray(source.rows)) error('field', `${where} needs src, or columns and rows.`, { where });
        else if (!source.columns.length || source.columns.length > 30 || source.rows.length > 5000 || source.columns.some((c) => !isText(c) || c.length > LABEL_MAX)
          || source.rows.some((row) => !Array.isArray(row) || row.length !== source.columns.length || row.some((cell) => !isText(cell) || cell.length > TEXT_MAX))) {
          error('field', `${where}: columns must be 1 to 30 texts, and rows must be lists of texts, one for each column, at most 5000 rows.`, { where });
        } else { out.columns = source.columns; out.rows = source.rows; }
        break;
      case 'diff':
      case 'file':
        if (!isText(source.src)) error('field', `${where}.src is required.`, { where });
        else { useFile(source.src, `${where}.src`, 'text', id); out.src = source.src; }
        if (out.type === 'file' && source.language !== undefined) {
          if (!isText(source.language) || !/^[a-z0-9+#.-]{1,32}$/i.test(source.language)) error('field', `${where}.language must be a short name.`, { where });
          else out.language = source.language;
        }
        break;
      case 'link':
        out.url = checkUrl(source.url, `${where}.url`);
        out.label = checkText(source.label, `${where}.label`, LABEL_MAX, { required: true });
        out.external = true;
        break;
      case 'checklist': {
        if (!Array.isArray(source.entries) || !source.entries.length || source.entries.length > 100) { error('field', `${where}.entries must have 1 to 100 entries.`, { where }); break; }
        const seen = new Set();
        out.entries = source.entries.map((entry, index) => {
          const at = `${where}.entries[${index}]`;
          if (!isObject(entry)) { error('field', `${at} must be an object with id and text.`, { where: at }); return null; }
          return { id: checkId(entry.id, `${at}.id`, seen, 'checklist entry'), text: checkText(entry.text, `${at}.text`, ALT_MAX, { required: true }) };
        });
        break;
      }
      case 'page':
        if (!isText(source.src)) error('field', `${where}.src is required.`, { where });
        else { useFile(source.src, `${where}.src`, 'html', id); out.src = source.src; }
        break;
      default: break;
    }
    if (!out.fallbackFrom && source.body !== undefined) out.body = checkBody(source.body, `${where}.body`, id);
    checkAsk(source, where, out);
    return out;
  };

  // ---------- The manifest ----------
  const manifest = {};
  if (input.schema !== SCHEMA) error('schema', `schema must be ${SCHEMA}.`, { where: 'schema' });
  manifest.schema = SCHEMA;
  manifest.id = checkId(input.id, 'id');
  manifest.title = checkTitle(input.title, 'title');
  if (input.summary !== undefined) manifest.summary = checkBody(input.summary, 'summary');
  if (input.designPass === undefined) warn('design-pass', 'The pack design pass is missing or not-run.', { where: 'designPass' });
  else if (!isObject(input.designPass)) error('design-pass', 'designPass must be an object.', { where: 'designPass' });
  else {
    const reviewer = checkText(input.designPass.reviewer, 'designPass.reviewer', LABEL_MAX, { required: true });
    const result = input.designPass.result;
    if (!DESIGN_RESULTS.has(result)) error('design-pass', 'designPass.result must be passed, issues, or not-run.', { where: 'designPass.result' });
    manifest.designPass = { reviewer, result: DESIGN_RESULTS.has(result) ? result : undefined };
    if (input.designPass.note !== undefined) manifest.designPass.note = checkText(input.designPass.note, 'designPass.note', TEXT_MAX);
    if (result === 'not-run') warn('design-pass', 'The pack design pass is missing or not-run.', { where: 'designPass' });
  }
  if (input.live !== undefined) {
    if (!Array.isArray(input.live) || input.live.length > 10) error('field', 'live must be a list of at most 10 links.', { where: 'live' });
    else manifest.live = input.live.map((link, index) => {
      const at = `live[${index}]`;
      if (!isObject(link)) { error('field', `${at} must be an object with label and url.`, { where: at }); return null; }
      return { label: checkText(link.label, `${at}.label`, LABEL_MAX, { required: true }), url: checkUrl(link.url, `${at}.url`) };
    });
  }

  // The counts are checked before any item is visited, so a hostile manifest reads no file.
  if (!halted) {
    if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > limits.sections) {
      stop('count', `The pack needs 1 to ${limits.sections} sections.`, { where: 'sections' });
    } else {
      let planned = 0;
      for (const section of input.sections) {
        const count = Array.isArray(section?.items) ? section.items.length : 0;
        planned += count;
        if (count > limits.itemsPerSection) { stop('count', `A section has more than ${limits.itemsPerSection} items.`, { where: 'sections' }); break; }
        if (planned > limits.items) { stop('count', `The pack has more than ${limits.items} items.`, { where: 'sections' }); break; }
      }
      if (!halted && planned < 1) stop('count', 'The pack needs at least 1 item.', { where: 'sections' });
    }
  }

  const ids = new Set();
  const sectionIds = new Set();
  manifest.sections = [];
  let itemCount = 0;
  if (!halted) {
    for (const [index, section] of input.sections.entries()) {
      if (halted) break;
      const where = `sections[${index}]`;
      if (!isObject(section)) { error('field', `${where} must be an object.`, { where }); continue; }
      const out = { id: checkId(section.id, `${where}.id`, sectionIds, 'section'), title: checkTitle(section.title, `${where}.title`) };
      if (section.summary !== undefined) out.summary = checkText(section.summary, `${where}.summary`, TEXT_MAX);
      out.items = [];
      if (!Array.isArray(section.items) || section.items.length < 1) error('count', `${where} needs at least 1 item.`, { where });
      else {
        for (const [at, item] of section.items.entries()) {
          if (halted) break;
          itemCount += 1;
          const normalized = checkItem(item, `${where}.items[${at}]`, ids);
          if (normalized) out.items.push(normalized);
        }
      }
      manifest.sections.push(out);
    }
  }
  if (halted) return finish(null, [], { files: fileInfo.size + 1, bytes: totalBytes, items: itemCount, sections: manifest.sections.length });

  const imageItemFiles = new Set();
  for (const section of manifest.sections) for (const item of section.items) {
    const refs = item.type === 'image' ? [item.src]
      : item.type === 'image-pair' ? [item.a?.src, item.b?.src]
        : item.type === 'gallery' ? (item.images || []).map((image) => image.src)
          : [];
    for (const ref of refs) {
      const record = fileInfo.get(ref);
      if (record?.ok && IMAGE_TYPES.has(record.type)) imageItemFiles.add(ref);
    }
  }
  for (const [sectionIndex, section] of manifest.sections.entries()) for (const [itemIndex, item] of section.items.entries()) {
    const where = 'sections[' + sectionIndex + '].items[' + itemIndex + ']';
    for (const ref of item.evidence || []) if (!imageItemFiles.has(ref)) {
      error('evidence', where + '.evidence names ' + ref + ', which is not a file used by an image item.', { where });
    }
  }
  if (hasUnmarkedItem) warn('verified-by', 'The pack has items that lack verifiedBy.', { where: 'sections' });

  // Item hashes, over the normalized fields and the file hashes.
  const hashes = new Map([...fileInfo].filter(([, record]) => record.ok).map(([rel, record]) => [rel, record.sha256]));
  for (const section of manifest.sections) for (const item of section.items) item.hash = itemHash(item, hashes);

  // Files in the folder that no field names. The walk stops at four times the file limit.
  const referenced = new Set([...fileInfo.keys(), 'manifest.json']);
  let seenFiles = 0;
  const walk = (dir, depth) => {
    let handle;
    try { handle = fs.opendirSync(dir); } catch { return; }
    try {
      for (let entry = handle.readSync(); entry && !halted; entry = handle.readSync()) {
        const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) warn('unreferenced', `The hidden folder ${rel} is not copied.`, { file: rel });
          else if (depth + 1 > limits.depth) warn('unreferenced', `The folder ${rel} is deeper than ${limits.depth} folders. Herdr Boss does not copy it.`, { file: rel });
          else walk(path.join(dir, entry.name), depth + 1);
          continue;
        }
        seenFiles += 1;
        if (seenFiles > limits.files * 4) { stop('file-count', `The folder holds more than ${limits.files * 4} files.`); return; }
        if (referenced.has(rel)) continue;
        if (ENV_FILE.test(rel) && !/\.(example|sample|template|dist)$/.test(rel)) error('secret', `The file ${rel} is a .env file. Herdr Boss refuses it.`, { file: rel });
        else warn('unreferenced', `The file ${rel} is not named in manifest.json. Herdr Boss does not copy it.`, { file: rel });
      }
    } finally { handle.closeSync(); }
  };
  walk(root, 0);

  const files = [...fileInfo.values()].filter((record) => record.ok).sort((a, b) => (a.path < b.path ? -1 : 1)).map((record) => {
    const out = { path: record.path, bytes: record.bytes, sha256: record.sha256, type: record.type, items: record.items };
    if (record.width) { out.width = record.width; out.height = record.height; }
    return out;
  });
  const totals = { files: fileInfo.size + 1, bytes: totalBytes, items: itemCount, sections: manifest.sections.length };
  // A manifest that holds a secret is not returned, so a caller cannot print or store it by mistake.
  return finish(errors.some((e) => e.rule === 'secret') || halted ? null : manifest, files, totals);
}

// Read exactly `size` bytes from the descriptor, or fewer when the file shrank.
function readBounded(fd, size) {
  const buffer = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const read = fs.readSync(fd, buffer, got, size - got, got);
    if (read === 0) break;
    got += read;
  }
  return got === size ? buffer : buffer.subarray(0, got);
}
