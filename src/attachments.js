import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const ATTACHMENT_ID = /^att_[0-9a-f]{32}$/;
export const ATTACHMENT_URL = /^\/attachments\/att_[0-9a-f]{32}$/;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const UPLOAD_LIMIT_PER_MINUTE = 30;
export const ATTACHMENT_TYPES = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
});
const HOUR = 3600000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const invalid = () => fail(415, 'The file is not a supported, valid picture.');

export function pictureType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const end = bytes.readUInt32BE(0);
    if (end < 16 || end > bytes.length || (end - 16) % 4) return null;
    const brands = [bytes.toString('latin1', 8, 12)];
    for (let at = 16; at < end; at += 4) brands.push(bytes.toString('latin1', at, at + 4));
    if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return null;
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand))) return 'image/heic';
    if (brands.some((brand) => ['mif1', 'msf1'].includes(brand))) return 'image/heif';
  }
  return null;
}

function stripJpeg(bytes) {
  const parts = [bytes.subarray(0, 2)];
  let at = 2;
  while (at < bytes.length) {
    const start = at;
    if (bytes[at++] !== 255) invalid();
    while (bytes[at] === 255) at += 1;
    const marker = bytes[at++];
    if (marker === 217) {
      if (at !== bytes.length) invalid();
      parts.push(bytes.subarray(start, at)); return Buffer.concat(parts);
    }
    if (!marker || marker === 216 || marker === undefined) invalid();
    if (marker === 1 || (marker >= 208 && marker <= 215)) { parts.push(bytes.subarray(start, at)); continue; }
    if (at + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) invalid();
    at += length;
    if (marker !== 225 && marker !== 237) parts.push(bytes.subarray(start, at));
    if (marker === 218) {
      const scan = at;
      while (at < bytes.length) {
        if (bytes[at] !== 255) { at += 1; continue; }
        let next = at + 1;
        while (bytes[next] === 255) next += 1;
        if (bytes[next] === 0 || (bytes[next] >= 208 && bytes[next] <= 215)) { at = next + 1; continue; }
        break;
      }
      parts.push(bytes.subarray(scan, at));
    }
  }
  invalid();
}

function stripPng(bytes) {
  const parts = [bytes.subarray(0, 8)]; let at = 8; let image = false; let first = true;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at); const end = at + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (first && (type !== 'IHDR' || length !== 13)) invalid();
    first = false;
    if (type === 'IDAT') image = true;
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) parts.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      if (length || at !== bytes.length || !image) invalid();
      return Buffer.concat(parts);
    }
  }
  invalid();
}

function stripWebp(bytes) {
  if (bytes.readUInt32LE(4) !== bytes.length - 8) invalid();
  const parts = []; let at = 12; let image = false;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(at + 4); const end = at + 8 + length + (length % 2);
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', at, at + 4);
    if (['VP8 ', 'VP8L', 'ANMF'].includes(type)) image = true;
    if (!['EXIF', 'XMP '].includes(type)) {
      const chunk = Buffer.from(bytes.subarray(at, end));
      if (type === 'VP8X') { if (length !== 10) invalid(); chunk[8] &= ~0x0c; }
      parts.push(chunk);
    }
    at = end;
  }
  if (at !== bytes.length || !image) invalid();
  const result = Buffer.concat([bytes.subarray(0, 12), ...parts]);
  result.writeUInt32LE(result.length - 8, 4); return result;
}

function stripGif(bytes) {
  if (bytes.length < 14) invalid();
  let at = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
  if (at >= bytes.length) invalid();
  const parts = [bytes.subarray(0, at)]; let image = false;
  const subBlocks = () => {
    for (;;) {
      if (at >= bytes.length) invalid();
      const count = bytes[at++];
      if (at + count > bytes.length) invalid();
      at += count; if (!count) return;
    }
  };
  while (at < bytes.length) {
    const start = at; const marker = bytes[at++];
    if (marker === 59) {
      if (at !== bytes.length || !image) invalid();
      parts.push(bytes.subarray(start, at)); return Buffer.concat(parts);
    }
    if (marker === 44) {
      if (at + 9 > bytes.length) invalid();
      const packed = bytes[at + 8]; at += 9;
      if (packed & 128) at += 3 * (2 ** ((packed & 7) + 1));
      if (at >= bytes.length) invalid();
      at += 1; subBlocks(); image = true; parts.push(bytes.subarray(start, at));
    } else if (marker === 33) {
      if (at >= bytes.length) invalid();
      const label = bytes[at++];
      // Only the standard animation loop application extension is retained.
      const loop = label === 255 && bytes[at] === 11 && bytes.toString('latin1', at + 1, at + 12) === 'NETSCAPE2.0';
      subBlocks();
      if (label !== 254 && (label !== 255 || loop)) parts.push(bytes.subarray(start, at));
    } else invalid();
  }
  invalid();
}

export function stripPictureMetadata(bytes, type) {
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  if (type === 'image/webp') return stripWebp(bytes);
  if (type === 'image/gif') return stripGif(bytes);
  return bytes;
}

function directory(dir, create = false) {
  const folder = path.join(dir, 'attachments');
  if (create) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(404, 'No attachment is stored here.');
  if (create) fs.chmodSync(folder, 0o700);
  return folder;
}
function privateRead(file, limit = MAX_ATTACHMENT_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.nlink !== 1) fail(404, 'No attachment is stored here.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function safeName(name, ext) {
  if (typeof name !== 'string' || name.length > 120) fail(400, 'X-Filename must be at most 120 characters.');
  const cleaned = name.replace(/[\/\\\u0000-\u001f\u007f-\u009f"<>:|?*\u2028\u2029]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || `photo.${ext}`;
}

export function storeAttachment(bytes, { type = pictureType(bytes), name = '', dir = DATA_DIR, now = Date.now() } = {}) {
  if (!Buffer.isBuffer(bytes)) fail(415, 'Send raw picture bytes.');
  if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, 'The picture exceeds the 10 MB limit.');
  if (!Object.hasOwn(ATTACHMENT_TYPES, type ?? '') || pictureType(bytes) !== type) invalid();
  const ext = ATTACHMENT_TYPES[type]; const sanitized = safeName(name, ext);
  const stripped = stripPictureMetadata(bytes, type);
  const id = `att_${randomBytes(16).toString('hex')}`;
  const metadata = { id, type, size: stripped.length, name: sanitized, createdAt: new Date(now).toISOString(), sha256: createHash('sha256').update(stripped).digest('hex'), metadataStripped: !['image/heic', 'image/heif'].includes(type) };
  let folder;
  try { folder = directory(dir, true); } catch { fail(500, 'Could not store the picture.'); }
  const file = path.join(folder, `${id}.${ext}`);
  try {
    fs.writeFileSync(file, stripped, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
  } catch {
    try { fs.rmSync(file, { force: true }); } catch {}
    fail(500, 'Could not store the picture.');
  }
  const { sha256, ...publicFields } = metadata;
  return { ...publicFields, url: `/attachments/${id}` };
}

export function readAttachment(id, { dir = DATA_DIR } = {}) {
  if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) fail(404, 'Attachment not found.');
  try {
    const folder = directory(dir);
    const metadata = JSON.parse(privateRead(path.join(folder, `${id}.json`), 4096));
    if (metadata.id !== id || !Object.hasOwn(ATTACHMENT_TYPES, metadata.type) || !Number.isInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_ATTACHMENT_BYTES || typeof metadata.name !== 'string' || metadata.name !== safeName(metadata.name, ATTACHMENT_TYPES[metadata.type]) || !Number.isFinite(Date.parse(metadata.createdAt))) fail(404, 'Attachment not found.');
    const file = path.join(folder, `${id}.${ATTACHMENT_TYPES[metadata.type]}`);
    const bytes = privateRead(file);
    if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) fail(404, 'Attachment not found.');
    return { ...metadata, file, bytes };
  } catch { fail(404, 'Attachment not found.'); }
}

export function validateAttachmentIds(ids) {
  if (!Array.isArray(ids) || ids.length > 6 || ids.some((id) => typeof id !== 'string' || !ATTACHMENT_ID.test(id)) || new Set(ids).size !== ids.length) {
    fail(400, 'attachments must contain at most 6 unique attachment ids.');
  }
}

// A private, exclusive link file prevents two processes from claiming the same upload.
// Keep it after the message write so an id can never be linked a second time.
export function claimAttachments(values, messageId, { dir = DATA_DIR, now = Date.now() } = {}) {
  if (!Array.isArray(values)) fail(400, 'attachments must contain at most 6 unique attachment ids.');
  const ids = values.map((value) => typeof value === 'string' ? value : value?.id);
  validateAttachmentIds(ids);
  const claimed = []; const attachments = [];
  const rollback = () => { for (const file of claimed) fs.rmSync(file, { force: true }); };
  try {
    for (const id of ids) {
      const { type, size, name } = readAttachment(id, { dir });
      const file = path.join(directory(dir), `${id}.link`);
      try { fs.writeFileSync(file, JSON.stringify({ messageId, at: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') fail(400, 'An attachment is already linked to a message.'); fail(500, 'Could not link the picture.'); }
      claimed.push(file); attachments.push({ id, type, size, name });
    }
    return { attachments, rollback };
  } catch (error) { rollback(); throw error; }
}

export function deleteAttachment(id, { dir = DATA_DIR } = {}) {
  if (!ATTACHMENT_ID.test(id)) return;
  let folder;
  try { folder = directory(dir); } catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) return; throw error; }
  for (const ext of [...Object.values(ATTACHMENT_TYPES), 'json', 'link']) fs.rmSync(path.join(folder, `${id}.${ext}`), { force: true });
}

export function removeDeletedAttachments(before, after, { dir = DATA_DIR } = {}) {
  const kept = new Map(after.map((record) => [record.id, record]));
  for (const record of before) {
    const next = kept.get(record.id);
    if (!next || (next.dismissed && !record.dismissed)) {
      for (const attachment of record.attachments || []) {
        try { deleteAttachment(attachment.id, { dir }); }
        catch (error) { process.emitWarning(`Could not delete a message picture (${error.code || 'error'}). The retention sweep will retry.`); }
      }
    }
  }
}

export function sweepAttachments({ dir = DATA_DIR, records = [], retentionDays = 30, now = Date.now() } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) fail(400, 'attachments.retentionDays must be an integer from 1 to 365.');
  let folder;
  try { folder = directory(dir); } catch (error) { if (error.code === 'ENOENT') return { deleted: 0 }; throw error; }
  const liveIds = new Set(records.map((record) => record.id));
  const ids = new Set(fs.readdirSync(folder).map((name) => /^(att_[0-9a-f]{32})\.(?:jpg|png|webp|gif|heic|heif|json|link)$/.exec(name)?.[1]).filter(Boolean));
  let deleted = 0;
  for (const id of ids) {
    let createdAt; let link = null;
    try { createdAt = Date.parse(JSON.parse(privateRead(path.join(folder, `${id}.json`), 4096)).createdAt); }
    catch { createdAt = NaN; }
    try { link = JSON.parse(privateRead(path.join(folder, `${id}.link`), 4096)); } catch {}
    let expired = Number.isFinite(createdAt) && createdAt < now - retentionDays * 86400000;
    if (link) expired ||= !liveIds.has(link.messageId) && Date.parse(link.at) < now - HOUR;
    else expired ||= Number.isFinite(createdAt) && createdAt < now - HOUR;
    if (!Number.isFinite(createdAt)) {
      // Recover an interrupted upload without following a symlink or an arbitrary filename.
      const entries = fs.readdirSync(folder).filter((name) => name.startsWith(`${id}.`));
      expired ||= entries.every((name) => fs.lstatSync(path.join(folder, name)).mtimeMs < now - HOUR);
    }
    if (expired) { deleteAttachment(id, { dir }); deleted += 1; }
  }
  return { deleted };
}

export function readLocalPicture(input, { cwd = process.cwd(), tempDir = os.tmpdir() } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0')) fail(400, 'Give a local picture file.');
  let file;
  try { file = fs.realpathSync(path.resolve(cwd, input)); }
  catch { fail(400, 'Cannot read the picture: the file is missing.'); }
  const inside = (folder) => {
    const relative = path.relative(fs.realpathSync(folder), file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { fail(400, 'Cannot read the local picture file.'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail(400, 'The picture must be a regular file.');
    if (!inside(cwd) && !inside(tempDir) && (!path.isAbsolute(input) || stat.uid !== process.getuid())) fail(400, 'Use a picture in the current directory tree or system temp directory, or an absolute regular file owned by you.');
    if (stat.size > MAX_ATTACHMENT_BYTES) fail(413, 'The picture exceeds the 10 MB limit.');
    // Bound the read even if a different process grows the file after fstat.
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break; size += count;
    }
    if (size > MAX_ATTACHMENT_BYTES) fail(413, 'The picture exceeds the 10 MB limit.');
    const content = bytes.subarray(0, size); const type = pictureType(content);
    if (!type) invalid();
    stripPictureMetadata(content, type);
    return { bytes: content, type, name: path.basename(file).slice(0, 120) };
  } finally { fs.closeSync(fd); }
}

export function uploadLocalPictures(files, options = {}) {
  const pictures = files.map((file) => readLocalPicture(file, options));
  const stored = [];
  try {
    for (const picture of pictures) stored.push(storeAttachment(picture.bytes, { ...options, type: picture.type, name: picture.name }));
    return stored;
  } catch (error) { for (const picture of stored) deleteAttachment(picture.id, options); throw error; }
}
