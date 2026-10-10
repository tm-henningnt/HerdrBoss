// The release approval commands. An orchestrator requests a release, the Owner answers the Mailbox item,
// and the orchestrator publishes it. The module never runs gh directly: it takes a runner function
// run(args) that returns { status, error, stdout, stderr } for one gh command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { DATA_DIR, loadConfig } from './config.js';
import { openMessageStore } from './message-store.js';
import { scanText } from './secret-scan.js';
import { scanTokenText } from '../scripts/docs-gate.js';
import { redactSecrets } from './redact.js';
import { listBrowserSessions } from './browser-pool.js';
import { getResultRecord } from './review-store.js';

const AUDIT_FILE = path.join('releases', 'audit.jsonl');
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const DEFAULT_ARCHIVE_LIMITS = Object.freeze({ maxInflatedBytes: 200 * 1024 * 1024, maxEntries: 5000, maxDepth: 2 });
const MAX_CANCEL_REASON = 500;
const APPROVED = /^\s*(approved|approve|accepted|accept|yes)\b/i;
const REJECTED = /^\s*(rejected|reject|denied|deny|no)\b/i;

// The fixed texts of a refusal. Each maps to one check in the publish path.
export const REFUSALS = {
  'repo-not-allowed': 'This repository is not in the releases.repos setting. Add it in Settings → Advanced → Service settings → Releases.',
  'no-approval': 'No approval item exists for this repository and tag.',
  'wrong-approval': 'The approval item is for another repository or tag.',
  'closed': 'The approval item is closed. Request a new approval.',
  'no-answer': 'The Owner has not answered this approval item yet.',
  'not-accept': 'The Owner denied this approval item. Request a new approval.',
  'answer-too-old': 'The Owner answer is older than the request. Request a new approval.',
  'checksum-mismatch': 'The draft assets changed after the request. Request a new approval.',
  'scan-failed': 'The secret scan found a problem after the request. Request a new approval.',
  'demo-app-failed': 'The demo app gate failed after the request. Request a new approval.',
  'not-draft': 'The release is no longer a draft.',
  'wrong-operation': 'The approval item is for a different release action.',
  'file-changed': 'The add-asset files changed or cannot be read after the request. Cancel and request again.',
  'asset-name-exists': 'A requested asset name already exists on the release.',
  'body-changed': 'the release body changed since the request; cancel and request again',
};

const refuse = (code, extra = {}) => ({ ok: false, code, reason: REFUSALS[code], published: false, ...extra });
const failureDetail = (result) => (result.error ? redactSecrets(result.error.message) : redactSecrets(`${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 3).join(' ')) || 'no message';

// The hosts that the browser sessions of this machine know. A known host in a release is a tenant host.
export function knownHostsFromSessions(sessions = listBrowserSessions()) {
  const hosts = new Set();
  for (const record of Object.values(sessions || {})) {
    const urls = [...(Array.isArray(record?.bookmarks) ? record.bookmarks.map((entry) => entry?.url) : []), record?.startPage];
    for (const value of urls) {
      if (typeof value !== 'string') continue;
      try { const host = new URL(value).hostname; if (host) hosts.add(host); } catch {}
    }
  }
  return [...hosts];
}

function hostKnown(hostname, knownHosts) {
  const host = String(hostname || '').toLowerCase();
  return !!host && knownHosts.some((known) => {
    const pattern = String(known).toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

// The Qlik Engine writes the path of its own inline table source into an exported .qvf: /home/engine/<uuid>.inline.
// The path belongs to the Engine and holds no user path. Only this exact pattern passes, and only for a .qvf asset.
// The qvf stores the path with a one-byte length prefix. The path is 56 characters, so the prefix byte is '8' (0x38).
// Only that prefix may touch the path; any other word character before it still fails.
const ENGINE_INLINE_PATH = /(?:(?<![A-Za-z0-9._/-])|(?<=8))\/home\/engine\/[0-9a-fA-F-]{36}\.inline(?![A-Za-z0-9._/-])/g;

// The classes of secret in one text, and the allowed paths that the scan counted. A class name never holds the value.
export function scanReleaseDetailed(text, { knownHosts = [], file = 'text' } = {}) {
  const classes = new Set([...scanText(file, text), ...scanTokenText(text)]);
  const allowed = [];
  let pathText = text;
  if (/\.qvf$/i.test(String(file))) {
    const count = (text.match(ENGINE_INLINE_PATH) ?? []).length;
    if (count) { allowed.push(`qvf engine inline paths: ${count}, allowed`); pathText = text.replace(ENGINE_INLINE_PATH, ''); }
  }
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(pathText)) classes.add('private path');
  for (const match of text.match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? []) {
    try { if (hostKnown(new URL(match).hostname, knownHosts)) classes.add('tenant host'); } catch {}
  }
  return { classes: [...classes], allowed };
}

export function scanRelease(text, options = {}) {
  return scanReleaseDetailed(text, options).classes;
}

export function repoConfig(repo, config) {
  return (config?.releases?.repos ?? []).find((entry) => entry.name === repo) ?? null;
}

// Read a release through gh. Each asset has { name, size, digest }.
function readRelease(run, repo, tag) {
  const result = run(['release', 'view', tag, '--repo', repo, '--json', 'name,tagName,isDraft,body,assets,targetCommitish,url']);
  if (result.error || result.status !== 0) throw new Error(`gh release view failed: ${failureDetail(result)}`);
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('gh release view returned text that is not JSON.'); }
  if (!data || typeof data !== 'object') throw new Error('gh release view returned no release.');
  return {
    name: data.name ?? null, tag: data.tagName ?? tag, draft: data.isDraft !== false, body: data.body ?? '',
    commit: data.targetCommitish ?? null, url: data.url ?? null,
    assets: (data.assets ?? []).map((asset) => ({ name: asset.name, size: asset.size ?? 0, digest: String(asset.digest ?? '').replace(/^sha256:/, '') || null })),
  };
}

function archiveByteLimit(limit) {
  const mib = 1024 * 1024;
  const size = limit > 0 && limit % mib === 0 ? `${limit / mib} MB` : `${limit} bytes`;
  return new Error(`Qlik extension archive inspection exceeded the total inflated-byte limit (${size}).`);
}

function archiveEntryLimit(limit) {
  return new Error(`Qlik extension archive inspection exceeded the total archive entry limit (${limit}).`);
}

function archiveBudget(limits = {}) {
  const selected = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  if (!Number.isSafeInteger(selected.maxInflatedBytes) || selected.maxInflatedBytes < 0
    || !Number.isSafeInteger(selected.maxEntries) || selected.maxEntries < 0
    || !Number.isSafeInteger(selected.maxDepth) || selected.maxDepth < 0) {
    throw new Error('Qlik extension archive inspection limits must be non-negative safe integers.');
  }
  return {
    ...selected,
    inflatedBytes: 0,
    entries: 0,
    addBytes(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > selected.maxInflatedBytes - this.inflatedBytes) throw archiveByteLimit(selected.maxInflatedBytes);
      this.inflatedBytes += bytes;
    },
    addEntries(count = 1) {
      if (!Number.isSafeInteger(count) || count < 0 || count > selected.maxEntries - this.entries) throw archiveEntryLimit(selected.maxEntries);
      this.entries += count;
    },
  };
}

function archiveLikeName(name) {
  return /\.(?:zipx?|tgz|tar(?:\.[a-z0-9][a-z0-9._-]*)?|tbz2?|txz|gz|gzip|bz2|bzip2|xz|zst|zstd|7z|rar\d*|lz|lzma|lzo|lz4|sz|br|z|cab|arj|ace|lha|lzh|cpio|iso|dmg|jar|war|ear|apk|deb|rpm|xar|sitx?|zoo|pak|archive)$/i.test(String(name));
}

function archiveKind(name) {
  if (/\.zip$/i.test(name)) return 'zip';
  if (/\.tar$/i.test(name)) return 'tar';
  if (/\.(?:tgz|tar\.gz)$/i.test(name)) return 'tgz';
  return null;
}

function archiveMagicKind(content) {
  if (!Buffer.isBuffer(content)) return null;
  if (content.length >= 4 && ['PK\x03\x04', 'PK\x05\x06', 'PK\x07\x08'].includes(content.subarray(0, 4).toString('latin1'))) return 'zip';
  if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) return 'gzip';
  if (content.length >= 6 && content.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (content.length >= 6 && content.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07') return 'rar';
  if (content.length >= 3 && content.subarray(0, 3).toString('ascii') === 'BZh') return 'bzip2';
  if (content.length >= 6 && content.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
  if (content.length >= 4 && content.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  if (content.length >= 262 && content.subarray(257, 262).toString('ascii') === 'ustar') return 'tar';
  return null;
}

function archiveSuffix(name) {
  return /(\.tar\.[a-z0-9][a-z0-9._-]*|\.(?:zipx?|tgz|tbz2?|txz|gz|gzip|bz2|bzip2|xz|zst|zstd|7z|rar\d*|lz|lzma|lzo|lz4|sz|br|z|cab|arj|ace|lha|lzh|cpio|iso|dmg|jar|war|ear|apk|deb|rpm|xar|sitx?|zoo|pak|archive))$/i.exec(String(name))?.[1] || path.extname(String(name)) || '(unknown)';
}

function cannotInspectArchive(name) {
  return new Error(`A Qlik extension archive type ${archiveSuffix(name)} cannot be inspected for a .qvf demo app.`);
}

function archiveInspectionError() {
  return new Error('A Qlik extension archive could not be checked for a nested .qvf file.');
}

function zipEntries(content, budget, visit) {
  const first = Math.max(0, content.length - 65_557);
  let end = -1;
  for (let offset = content.length - 22; offset >= first; offset -= 1) {
    if (content.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + content.readUInt16LE(offset + 20) === content.length) { end = offset; break; }
  }
  if (end < 0) throw archiveInspectionError();
  const entryCount = content.readUInt16LE(end + 10);
  const directorySize = content.readUInt32LE(end + 12);
  const directoryOffset = content.readUInt32LE(end + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || directoryOffset + directorySize > end) {
    throw archiveInspectionError();
  }
  budget.addEntries(entryCount);
  let offset = directoryOffset;
  let hiddenQvf = null;
  let omittedLocalQvf = false;
  const localOffsets = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || content.readUInt32LE(offset) !== 0x02014b50) {
      throw archiveInspectionError();
    }
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw archiveInspectionError();
    const name = content.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const method = content.readUInt16LE(offset + 10);
    const compressedSize = content.readUInt32LE(offset + 20);
    const uncompressedSize = content.readUInt32LE(offset + 24);
    const localOffset = content.readUInt32LE(offset + 42);
    if (localOffset + 30 > directoryOffset || content.readUInt32LE(localOffset) !== 0x04034b50) {
      throw archiveInspectionError();
    }
    const localNameLength = content.readUInt16LE(localOffset + 26);
    const localExtraLength = content.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    if (!localNameLength || localNameEnd + localExtraLength > directoryOffset) {
      throw archiveInspectionError();
    }
    const localName = content.subarray(localOffset + 30, localNameEnd).toString('utf8');
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) throw archiveInspectionError();
    if (name !== localName && !/\.qvf$/i.test(name) && !/\.qvf$/i.test(localName)) {
      throw archiveInspectionError();
    }
    const qvfName = /\.qvf$/i.test(name) || /\.qvf$/i.test(localName);
    const candidateArchive = archiveLikeName(name) || archiveLikeName(localName);
    if (qvfName || candidateArchive) {
      budget.addBytes(uncompressedSize);
      let data;
      try {
        const compressed = content.subarray(dataStart, dataEnd);
        if (method === 0) data = compressed;
        else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
        else throw new Error('unsupported compression');
      } catch (error) {
        if (/total inflated-byte limit/.test(error.message)) throw error;
        throw archiveInspectionError();
      }
      if (data.length !== uncompressedSize) throw archiveInspectionError();
      if (qvfName) hiddenQvf ||= /\.qvf$/i.test(name) ? name : localName;
      visit({ name: /\.qvf$/i.test(name) ? name : localName, localName, data });
    }
    localOffsets.add(localOffset);
    offset = next;
  }
  if (offset !== directoryOffset + directorySize) throw archiveInspectionError();

  // Also find a local QVF header that an incomplete central directory omits.
  const localSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  for (let candidate = content.indexOf(localSignature); candidate >= 0 && candidate < directoryOffset; candidate = content.indexOf(localSignature, candidate + 4)) {
    if (localOffsets.has(candidate) || candidate + 30 > directoryOffset || content.readUInt16LE(candidate + 4) > 63) continue;
    const candidateNameLength = content.readUInt16LE(candidate + 26);
    const candidateExtraLength = content.readUInt16LE(candidate + 28);
    const candidateNameEnd = candidate + 30 + candidateNameLength;
    if (!candidateNameLength || candidateNameLength > 4096 || candidateNameEnd + candidateExtraLength > directoryOffset) continue;
    const candidateName = content.subarray(candidate + 30, candidateNameEnd).toString('utf8');
    if (/\.qvf$/i.test(candidateName)) {
      hiddenQvf ||= candidateName;
      omittedLocalQvf = true;
    }
  }
  if (omittedLocalQvf) budget.addEntries(1);
  return { hiddenQvf };
}

function paxValues(data) {
  const values = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error('A Qlik extension archive could not be checked for a nested .qvf file.');
    const length = Number.parseInt(data.toString('ascii', offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10) {
      throw new Error('A Qlik extension archive could not be checked for a nested .qvf file.');
    }
    const field = data.toString('utf8', space + 1, offset + length - 1);
    const equals = field.indexOf('=');
    if (equals > 0) values[field.slice(0, equals)] = field.slice(equals + 1);
    offset += length;
  }
  return values;
}

function tarEntries(tar, budget, visit, { alreadyInflated = false } = {}) {
  let globalPath = null;
  let nextPath = null;
  let nextLongName = null;
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw archiveInspectionError();
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    budget.addEntries(1);
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const headerName = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    if (sizeText && !/^[0-7]+$/.test(sizeText)) throw archiveInspectionError();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end > tar.length) throw archiveInspectionError();
    const data = tar.subarray(start, end);
    const type = header[156];
    if (type === 120) nextPath = paxValues(data).path ?? null;
    else if (type === 103) globalPath = paxValues(data).path ?? globalPath;
    else if (type === 76) nextLongName = data.toString('utf8').replace(/\0.*$/, '').replace(/\n$/, '');
    else if (type !== 75) {
      const name = nextPath ?? nextLongName ?? globalPath ?? headerName;
      if (/\.qvf$/i.test(name) || archiveLikeName(name)) {
        if (!alreadyInflated) budget.addBytes(data.length);
        visit({ name, data });
      }
      nextPath = null;
      nextLongName = null;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
}

function tarGzipEntries(content, budget) {
  let tar;
  const remaining = budget.maxInflatedBytes - budget.inflatedBytes;
  try { tar = gunzipSync(content, { maxOutputLength: Math.max(1, remaining) }); }
  catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(error?.message ?? '')) throw archiveByteLimit(budget.maxInflatedBytes);
    throw archiveInspectionError();
  }
  budget.addBytes(tar.length);
  return tar;
}

function archiveQvfPath(name, content, depth, requireDemoApp, budget) {
  if (/\.qvf$/i.test(name)) return name;
  const kind = archiveKind(name);
  if (!kind) {
    if (requireDemoApp && (archiveLikeName(name) || archiveMagicKind(content))) throw cannotInspectArchive(name);
    return null;
  }
  if (depth > budget.maxDepth) throw new Error(`A Qlik extension archive is nested beyond the maximum inspection depth of ${budget.maxDepth} for a .qvf demo app.`);

  let qvfPath = null;
  const visit = (entry) => {
    if (/\.qvf$/i.test(entry.name)) {
      qvfPath ||= entry.name;
      return;
    }
    if (!archiveLikeName(entry.name)) return;
    const nested = archiveQvfPath(entry.name, entry.data, depth + 1, requireDemoApp, budget);
    if (nested) qvfPath ||= `${entry.name}!${nested}`;
  };

  if (kind === 'zip') {
    const result = zipEntries(content, budget, visit);
    if (result.hiddenQvf) qvfPath ||= result.hiddenQvf;
  } else if (kind === 'tgz') {
    const tar = tarGzipEntries(content, budget);
    tarEntries(tar, budget, visit, { alreadyInflated: true });
  } else {
    tarEntries(content, budget, visit);
  }
  return qvfPath;
}

// Download each asset into a temporary folder, hash it, and scan its text.
// Returns [{ name, size, sha256, listedSha256, classes }]. A scan class never holds a value.
function inspectAssets(run, repo, tag, release, knownHosts, { inspectQlikExtensionZips = false, requireDemoApp = true, archiveLimits = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-'));
  try {
    const budget = archiveBudget(archiveLimits);
    const files = new Map();
    for (const asset of release.assets) {
      const result = run(['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', tmp, '--clobber']);
      const file = path.join(tmp, asset.name);
      if (result.error || result.status !== 0 || !fs.existsSync(file)) throw new Error(`gh release download ${asset.name} failed: ${failureDetail(result)}`);
      files.set(asset.name, file);
    }
    return release.assets.map((asset) => {
      const file = files.get(asset.name);
      const content = fs.readFileSync(file);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const classes = [];
      let allowed = [];
      if (content.length > MAX_SCAN_BYTES) classes.push('too large to scan');
      else {
        const scan = scanReleaseDetailed(content.toString('latin1'), { knownHosts, file: asset.name });
        classes.push(...scan.classes);
        allowed = scan.allowed;
      }
      const shouldInspectArchive = inspectQlikExtensionZips && (archiveKind(asset.name) || (requireDemoApp && (archiveLikeName(asset.name) || archiveMagicKind(content))));
      const qvfPath = shouldInspectArchive ? archiveQvfPath(asset.name, content, 0, requireDemoApp, budget) : null;
      const sidecar = files.get(`${asset.name}.sha256`);
      const listed = asset.digest ?? (sidecar ? fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase() : null);
      if (listed && listed !== sha256) classes.push('checksum differs from the listed checksum');
      return { name: asset.name, size: content.length, sha256, listedSha256: listed, classes, allowed, containsQvf: qvfPath !== null, qvfPath };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const scanFindings = (notes, assets) => [
  ...(notes.length ? [{ file: 'notes', classes: notes }] : []),
  ...assets.filter((asset) => asset.classes.length).map((asset) => ({ file: asset.name, classes: asset.classes })),
];

const records = (dir) => openMessageStore({ dir }).all();
// An Owner answer through the dashboard sets closedAt only, so that close still counts as an open request.
const settled = (record) => record.closedBy === 'project' || record.closeNote === 'published' || record.closeNote === 'denied by the Owner' || record.closeNote === 'superseded';
const isRelease = (record) => record.kind === 'report' && record.release && record.action === 'approve';
const isAddAsset = (record) => isRelease(record) && record.release.operation === 'add-asset';
const isPublishRequest = (record) => isRelease(record) && !isAddAsset(record);
const sameTarget = (record, repo, tag) => record.release.repo === repo && record.release.tag === tag;

function readNotes(notesFile) {
  if (!notesFile) return '';
  try { return fs.readFileSync(notesFile, 'utf8'); } catch { throw new Error(`Cannot read notes file: ${notesFile}`); }
}

function sameReleaseAssets(stored, current) {
  if (!Array.isArray(stored) || stored.length !== current.length) return false;
  const shape = (assets) => assets.map(({ name, size, sha256 }) => ({ name, size, sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(shape(stored)) === JSON.stringify(shape(current));
}

// The Owner answers an approve item with a message that has replyTo set. The newest answer counts.
function ownerAnswer(all, approval) {
  const answers = all.filter((record) => record.from === 'owner' && record.kind === 'message' && record.replyTo === approval.id);
  const latest = answers[answers.length - 1];
  if (!latest) return null;
  const verdict = APPROVED.test(latest.text) ? 'accept' : REJECTED.test(latest.text) ? 'deny' : 'other';
  return { verdict, at: latest.at };
}

function packCoverage({ dir, slug, pack }) {
  if (!pack) return 'No review pack named. Use --pack to name one.';
  try {
    const result = getResultRecord({ dir, slug, pack });
    if (!result) return `Pack ${pack}: no Owner answer yet.`;
    return `Pack ${pack} version ${result.version}: ${result.verdict ?? 'answered'}${result.submittedAt ? ` at ${result.submittedAt}` : ''}.`;
  } catch {
    return `Pack ${pack}: the review store has no record.`;
  }
}

function cardText({ repo, tag, release, notes, assets, demoApp, findings, latest, coverage }) {
  const lines = [
    '# Release approval request', '',
    `Repository: ${repo}`, `Tag: ${tag}`, `Draft: ${release.url ?? release.name ?? tag}`, '',
    '## Changelog', redactSecrets(notes || release.body || '(no changelog)'), '',
    '## Assets',
  ];
  if (assets.length) for (const asset of assets) lines.push(`- ${asset.name}: ${asset.size} bytes, sha256 ${asset.sha256}`);
  else lines.push('(no assets)');
  lines.push('', '## Demo app');
  if (demoApp) lines.push(`- ${demoApp.name}: ${demoApp.size} bytes, sha256 ${demoApp.sha256}`);
  else lines.push('(not required)');
  lines.push('', '## Scan result');
  if (findings.length) { lines.push('Fail:'); for (const finding of findings) lines.push(`- ${finding.file}: ${finding.classes.join(', ')}`); }
  else lines.push('Pass: no secrets found.');
  for (const asset of assets) for (const note of asset.allowed ?? []) lines.push(`- ${asset.name}: ${note}`);
  lines.push('', '## Build commit', release.commit ?? '(not available)', '', '## Review coverage', coverage, '', '## Effect',
    `Approve makes the release public${latest ? ' and marks it as the latest release' : ' and does not mark it as the latest release'}.`);
  return lines.join('\n');
}

function demoAppAsset(entry, assets) {
  if (entry?.kind !== 'qlik-extension') return null;
  const embeddedQvf = assets.find((asset) => asset.containsQvf);
  if (embeddedQvf) {
    if (/\.zip$/i.test(embeddedQvf.name) && !embeddedQvf.qvfPath.includes('!')) {
      throw new Error('A Qlik extension zip contains a .qvf file; ship the demo app as a separate asset.');
    }
    if (embeddedQvf.qvfPath.includes('!')) {
      throw new Error(`A Qlik extension nested archive contains a .qvf file at ${embeddedQvf.name}!${embeddedQvf.qvfPath}; ship the demo app as a separate asset.`);
    }
    throw new Error(`A Qlik extension archive ${embeddedQvf.name} contains a .qvf file; ship the demo app as a separate asset.`);
  }
  const qvfs = assets.filter((asset) => /\.qvf$/i.test(asset.name));
  const required = entry.requireDemoApp ?? true;
  if (required && qvfs.length !== 1) throw new Error('A Qlik extension release requires one separate .qvf demo app asset.');
  if (qvfs.length > 1) throw new Error('A Qlik extension release can list only one separate .qvf demo app asset.');
  const asset = qvfs[0];
  return asset ? { name: asset.name, size: asset.size, sha256: asset.sha256 } : null;
}

// Request a release approval. Posts one Mailbox item of action approve.
// Returns { id, repo, tag, alreadyOpen, scanOk }.
export function requestRelease({ repo, tag, notesFile = null, pack = null, latest = true, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, requesterPane = null, config = null, archiveLimits = {} }) {
  if (!repo || !tag) throw new Error('Usage: release request REPO TAG [--notes FILE] [--pack PACK] [--not-latest]');
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const entry = config ? repoConfig(repo, config) : { project: 'boss' };
  if (!entry) throw new Error(REFUSALS['repo-not-allowed']);

  const targetOpen = records(dir).find((record) => isRelease(record) && !settled(record) && sameTarget(record, repo, tag));
  if (targetOpen && isAddAsset(targetOpen)) throw new Error(`An add-asset request is already open for ${repo} ${tag}. Cancel it before requesting publication.`);
  const open = targetOpen;

  const hosts = knownHosts ?? knownHostsFromSessions();
  let release;
  let currentAssets = null;
  try {
    release = readRelease(run, repo, tag);
    if (open) currentAssets = inspectAssets(run, repo, tag, release, hosts, { inspectQlikExtensionZips: entry?.kind === 'qlik-extension', requireDemoApp: entry?.requireDemoApp ?? true, archiveLimits });
  } catch (error) {
    if (open) return { id: open.id, repo, tag, alreadyOpen: true, scanOk: null };
    throw error;
  }
  if (open) {
    demoAppAsset(entry, currentAssets);
    const notes = readNotes(notesFile);
    const changelog = notes || release.body || '';
    const notesSourceMatches = typeof open.release.notesFromFile === 'boolean'
      && open.release.notesFromFile === Boolean(notesFile);
    const notesDiffer = notesSourceMatches && typeof open.release.notesSha256 === 'string'
      && open.release.notesSha256 !== crypto.createHash('sha256').update(changelog).digest('hex');
    const assetsDiffer = !sameReleaseAssets(open.release.assets, currentAssets);
    return { id: open.id, repo, tag, alreadyOpen: true, stale: notesDiffer || assetsDiffer, scanOk: null };
  }
  if (!release.draft) throw new Error(REFUSALS['not-draft']);
  const notes = readNotes(notesFile);
  const assets = inspectAssets(run, repo, tag, release, hosts, { inspectQlikExtensionZips: entry?.kind === 'qlik-extension', requireDemoApp: entry?.requireDemoApp ?? true, archiveLimits });
  const demoApp = demoAppAsset(entry, assets);
  const findings = scanFindings(scanRelease(`${notes}\n${release.body}`, { knownHosts: hosts, file: 'notes' }), assets);
  const text = cardText({ repo, tag, release, notes, assets, demoApp, findings, latest, coverage: packCoverage({ dir, slug: entry.project, pack }) });

  const record = openMessageStore({ dir }).append({
    thread: entry.project, from: 'orch', to: 'owner', kind: 'report', title: `Release approval: ${repo} ${tag}`, text, action: 'approve',
    status: 'new', requesterPane,
    release: {
      repo, tag, latest, commit: release.commit, notesFromFile: Boolean(notesFile),
      notesSha256: crypto.createHash('sha256').update(notes || release.body || '').digest('hex'),
      demoApp,
      assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    },
  }, { now });
  return { id: record.id, repo, tag, alreadyOpen: false, scanOk: findings.length === 0 };
}

function readAddAssetFile(filePath, knownHosts = []) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('An asset file is required.');
  const name = path.basename(filePath);
  if (name.includes('#')) throw new Error('Asset file names cannot contain #.');
  let fileStat;
  try { fileStat = fs.lstatSync(filePath); } catch { throw new Error(`Cannot read asset file ${name || '(unnamed)'}.`); }
  if (fileStat.isSymbolicLink()) throw new Error(`Asset file ${name} is a symlink.`);
  if (!fileStat.isFile()) throw new Error(`Asset file ${name} is not a regular file.`);
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch { throw new Error(`Cannot read asset file ${name || '(unnamed)'}.`); }
  if (!content.length) throw new Error(`Asset file ${name} is empty.`);
  const classes = [];
  let allowed = [];
  if (content.length > MAX_SCAN_BYTES) classes.push('too large to scan');
  else {
    const scan = scanReleaseDetailed(content.toString('latin1'), { knownHosts, file: name });
    classes.push(...scan.classes);
    allowed = scan.allowed;
  }
  return {
    name, path: path.resolve(filePath), size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), classes, allowed, content,
  };
}

function readAppendNotesFile(notesFile) {
  if (!notesFile) return null;
  try { return fs.readFileSync(notesFile, 'utf8'); } catch { throw new Error('Cannot read the Demo app notes file.'); }
}

function addAssetCardText({ repo, tag, release, reason, files, findings, notesBlock, noteFindings }) {
  const lines = [
    '# Add release assets approval', '',
    `Repository: ${repo}`, `Tag: ${tag}`, `Release: ${release.url ?? release.name ?? tag}`, `Reason: ${redactSecrets(reason)}`, '',
    '## Assets',
  ];
  for (const file of files) lines.push(`- ${file.name}: ${file.size} bytes, sha256 ${file.sha256}`);
  lines.push('', '## Scan result');
  if (findings.length) {
    lines.push('Fail:');
    for (const finding of findings) lines.push(`- ${finding.file}: ${finding.classes.join(', ')}`);
  } else lines.push('Pass: no secrets found.');
  for (const file of files) for (const note of file.allowed ?? []) lines.push(`- ${file.name}: ${note}`);
  if (notesBlock !== null) {
    lines.push('', '## Demo app', '');
    if (noteFindings.length) lines.push(`[Hidden because the notes scan found: ${noteFindings.join(', ')}]`);
    else lines.push(redactSecrets(notesBlock.replace(/^## Demo app\n\n/, '')));
  }
  lines.push('', '## Effect', 'After the Owner accepts, add the listed files to this release. Append the Demo app notes block when one is shown.');
  return lines.join('\n');
}

// Request approval to add assets to an existing draft or published release.
// Returns { id, repo, tag, alreadyOpen, scanOk }.
export function requestAddAsset({ repo, tag, files = [], reason = '', appendNotesFile = null, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, requesterPane = null, config = null }) {
  if (!repo || !tag || !Array.isArray(files) || files.length === 0) {
    throw new Error('Usage: release add-asset REPO TAG FILE... --reason TEXT [--append-notes FILE]');
  }
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const entry = config ? repoConfig(repo, config) : { project: 'boss' };
  if (!entry) throw new Error(REFUSALS['repo-not-allowed']);
  const safeReason = redactSecrets(String(reason).trim());
  if (!safeReason || safeReason.length > 300) throw new Error('A reason is required and must contain 1 to 300 characters.');

  const release = readRelease(run, repo, tag);
  const hosts = knownHosts ?? knownHostsFromSessions();
  const addFiles = files.map((file) => readAddAssetFile(file, hosts));
  const names = new Set();
  for (const file of addFiles) {
    if (names.has(file.name)) throw new Error('Each add-asset file must have a unique base name.');
    names.add(file.name);
    if (release.assets.some((asset) => asset.name === file.name)) throw new Error(`Asset ${file.name} already exists on the release.`);
  }
  const notesText = readAppendNotesFile(appendNotesFile);
  const notesBlock = notesText === null ? null : `## Demo app\n\n${notesText}`;
  const noteFindings = notesText === null ? [] : scanRelease(notesText, { knownHosts: hosts, file: 'notes' });
  const scannedFiles = addFiles;
  const findings = scanFindings(noteFindings, scannedFiles);
  const bodyHash = crypto.createHash('sha256').update(release.body).digest('hex');
  const notesSha256 = notesText === null ? null : crypto.createHash('sha256').update(notesText).digest('hex');
  const targetOpen = records(dir).find((record) => isRelease(record) && !settled(record) && sameTarget(record, repo, tag));
  if (targetOpen && !isAddAsset(targetOpen)) throw new Error(`A release approval is already open for ${repo} ${tag}. Cancel it before requesting asset changes.`);
  const open = targetOpen;
  if (open) {
    const oldFiles = (open.release.files ?? []).map(({ name, path: sourcePath, size, sha256 }) => ({ name, path: sourcePath, size, sha256 }));
    const newFiles = addFiles.map(({ name, path: sourcePath, size, sha256 }) => ({ name, path: sourcePath, size, sha256 }));
    const identical = open.release.bodyHash === bodyHash
      && open.release.reason === safeReason
      && open.release.notesSha256 === notesSha256
      && JSON.stringify(oldFiles) === JSON.stringify(newFiles);
    if (!identical) throw new Error(`An add-asset request is already open for ${repo} ${tag}. Cancel it before making a different request.`);
    return { id: open.id, repo, tag, alreadyOpen: true, scanOk: null };
  }

  const text = addAssetCardText({ repo, tag, release, reason: safeReason, files: scannedFiles, findings, notesBlock, noteFindings });
  const record = openMessageStore({ dir }).append({
    thread: entry.project, from: 'orch', to: 'owner', kind: 'report', title: `Add release assets: ${repo} ${tag}`, text, action: 'approve',
    status: 'new', requesterPane,
    release: {
      operation: 'add-asset', repo, tag, bodyHash, reason: safeReason,
      files: addFiles.map(({ name, path: sourcePath, size, sha256 }) => ({ name, path: sourcePath, size, sha256 })),
      notesSha256, notesBlock,
    },
  }, { now });
  return { id: record.id, repo, tag, alreadyOpen: false, scanOk: findings.length === 0 };
}

function writeAudit({ dir, approvalId, who, repo, tag, now, action = 'publish', reason = undefined, files = undefined }) {
  const file = path.join(dir, AUDIT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entry = { at: new Date(now).toISOString(), approvalId, who, repo, tag, action };
  if (reason !== undefined) entry.reason = reason;
  if (files !== undefined) entry.files = files;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function closeItem(id, note, { dir, now }) {
  const at = new Date(now).toISOString();
  return openMessageStore({ dir }).mutate((all) => {
    const item = all.find((record) => record.id === id);
    if (item && !settled(item)) Object.assign(item, { closedAt: item.closedAt || at, closedBy: 'project', closeNote: note, readAt: item.readAt || at });
    return { records: all, result: item ?? null };
  }, { now });
}

// Settle a request when its requester needs to replace it. The caller is checked again here so the
// command cannot cancel another orchestrator's request.
export function cancelRelease({ repo, tag, reason = '', dir = DATA_DIR, now = Date.now(), who = null, role = null }) {
  if (!repo || !tag) throw new Error('Usage: release cancel REPO TAG [--reason TEXT]');
  if (!['boss', 'orch'].includes(role) || !who) {
    return { ok: false, reason: 'Only the requesting orchestrator pane or the Boss can cancel this release request.' };
  }
  const all = records(dir);
  const approval = all.find((record) => isRelease(record) && !settled(record) && sameTarget(record, repo, tag));
  if (!approval) return { ok: false, reason: `No open release request exists for ${repo} ${tag}.` };
  if (role !== 'boss' && approval.requesterPane !== who) {
    return { ok: false, reason: 'Only the requesting orchestrator pane or the Boss can cancel this release request.' };
  }
  if (ownerAnswer(all, approval)?.verdict === 'accept') {
    const next = isAddAsset(approval)
      ? `Run release apply-asset ${repo} ${tag} --approval ${approval.id} or wait for an Owner denial to settle this request.`
      : 'Run release publish or wait for an Owner denial to settle this request.';
    return { ok: false, reason: `The Owner has answered Approve. ${next}` };
  }
  const boundedReason = redactSecrets(String(reason).trim()).slice(0, MAX_CANCEL_REASON);
  openMessageStore({ dir }).update(approval.id, { supersededReason: boundedReason }, { now });
  closeItem(approval.id, 'superseded', { dir, now });
  writeAudit({ dir, approvalId: approval.id, who, repo, tag, now, action: 'cancel', reason: boundedReason });
  return { ok: true, approvalId: approval.id, repo, tag };
}

const refuseAddAsset = (code, extra = {}) => ({ ok: false, code, reason: REFUSALS[code], applied: false, ...extra });

// Add the approved assets to the release. Recheck every request input before the first gh write.
export function applyAddAsset({ repo, tag, approvalId, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, who = null, config = null }) {
  if (!repo || !tag || !approvalId) throw new Error('Usage: release apply-asset REPO TAG --approval ID');
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  if (config && !repoConfig(repo, config)) return refuseAddAsset('repo-not-allowed');

  const all = records(dir);
  const approval = all.find((record) => record.id === approvalId && isRelease(record));
  if (!approval) return refuseAddAsset('no-approval');
  if (!sameTarget(approval, repo, tag)) return refuseAddAsset('wrong-approval');
  if (!isAddAsset(approval)) return refuseAddAsset('wrong-operation');
  if (settled(approval)) return refuseAddAsset('closed');
  const answer = ownerAnswer(all, approval);
  if (!answer || answer.verdict === 'other') return refuseAddAsset('no-answer', { waiting: true });
  if (answer.verdict === 'deny') {
    closeItem(approvalId, 'denied by the Owner', { dir, now });
    return refuseAddAsset('not-accept');
  }
  if (Date.parse(answer.at) <= Date.parse(approval.at)) return refuseAddAsset('answer-too-old');

  const release = readRelease(run, repo, tag);
  const bodyHash = crypto.createHash('sha256').update(release.body).digest('hex');
  if (bodyHash !== approval.release.bodyHash) return refuseAddAsset('body-changed');
  const expected = approval.release.files ?? [];
  if (!expected.length) return refuseAddAsset('file-changed');
  if (expected.some((file) => release.assets.some((asset) => asset.name === file.name))) return refuseAddAsset('asset-name-exists');

  const hosts = knownHosts ?? knownHostsFromSessions();
  let current;
  try { current = expected.map((file) => readAddAssetFile(file.path, hosts)); } catch { return refuseAddAsset('file-changed'); }
  const storedShape = expected.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  const currentShape = current.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  if (JSON.stringify(storedShape) !== JSON.stringify(currentShape)) return refuseAddAsset('file-changed');

  const notesBlock = approval.release.notesBlock ?? null;
  const notesText = notesBlock === null ? null : notesBlock.replace(/^## Demo app\n\n/, '');
  const notesSha256 = notesText === null ? null : crypto.createHash('sha256').update(notesText).digest('hex');
  if (notesSha256 !== (approval.release.notesSha256 ?? null)) return refuseAddAsset('file-changed');
  const noteFindings = notesText === null ? [] : scanRelease(notesText, { knownHosts: hosts, file: 'notes' });
  const findings = scanFindings(noteFindings, current);
  if (findings.length) return refuseAddAsset('scan-failed');

  const latest = ownerAnswer(records(dir), approval);
  if (!latest || latest.verdict === 'other') return refuseAddAsset('no-answer', { waiting: true });
  if (latest.verdict === 'deny') {
    closeItem(approvalId, 'denied by the Owner', { dir, now });
    return refuseAddAsset('not-accept');
  }
  if (Date.parse(latest.at) <= Date.parse(approval.at)) return refuseAddAsset('answer-too-old');

  const uploadedNames = current.map((file) => file.name);
  const partialFailure = (reason, files = uploadedNames) => ({
    ok: false, code: 'partial-failure', reason: redactSecrets(reason), applied: false, partial: true, uploadedFiles: files,
  });
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-add-'));
  try {
    fs.chmodSync(uploadDir, 0o700);
    const uploadPaths = current.map((file) => {
      const stagedPath = path.join(uploadDir, file.name);
      fs.writeFileSync(stagedPath, file.content, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(stagedPath, 0o600);
      return stagedPath;
    });

    let upload;
    try { upload = run(['release', 'upload', tag, '--repo', repo, ...uploadPaths]); } catch (error) {
      let found = [];
      try {
        const afterUpload = readRelease(run, repo, tag);
        found = uploadedNames.filter((name) => afterUpload.assets.some((asset) => asset.name === name));
      } catch {}
      const detail = `gh release upload failed: ${redactSecrets(error.message)}`;
      return found.length ? partialFailure(detail, found) : { ok: false, code: 'upload-failed', reason: detail, applied: false };
    }
    if (upload.error || upload.status !== 0) {
      const detail = `gh release upload failed: ${failureDetail(upload)}`;
      let found = [];
      try {
        const afterUpload = readRelease(run, repo, tag);
        found = uploadedNames.filter((name) => afterUpload.assets.some((asset) => asset.name === name));
      } catch {}
      return found.length ? partialFailure(detail, found) : { ok: false, code: 'upload-failed', reason: redactSecrets(detail), applied: false };
    }

    try {
      let newBody = release.body;
      if (notesBlock !== null) {
        const freshRelease = readRelease(run, repo, tag);
        const freshBody = freshRelease.body;
        const freshBodyHash = crypto.createHash('sha256').update(freshBody).digest('hex');
        if (freshBodyHash !== approval.release.bodyHash) {
          return partialFailure('The release body changed after upload.');
        }
        newBody = `${freshBody}\n\n${notesBlock}`;
        if (!newBody.startsWith(freshBody)) return partialFailure('The new release body does not start with the freshly read body.');
        const edit = run(['release', 'edit', tag, '--repo', repo, '--notes', newBody]);
        if (edit.error || edit.status !== 0) throw new Error(`gh release edit failed: ${failureDetail(edit)}`);
      }

      const after = readRelease(run, repo, tag);
      const expectedNames = [...release.assets.map((asset) => asset.name), ...uploadedNames].sort().join('\n');
      const actualNames = after.assets.map((asset) => asset.name).sort().join('\n');
      if (actualNames !== expectedNames) throw new Error('The release does not have the expected asset names after gh release upload.');
      if (notesBlock !== null && after.body !== newBody) throw new Error('The release notes did not match the approved Demo app block after gh release edit.');

      writeAudit({ dir, approvalId, who, repo, tag, now, action: 'add-asset', files: uploadedNames });
      closeItem(approvalId, 'assets added', { dir, now });
      return { ok: true, code: null, reason: null, applied: true };
    } catch (error) {
      return partialFailure(error.message);
    }
  } finally {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

// Publish a release. Every check must pass before gh release edit runs.
// Returns { ok, code, reason, published, waiting }.
export function publishRelease({ repo, tag, approvalId, run, dir = DATA_DIR, now = Date.now(), knownHosts = null, who = null, config = null }) {
  if (!repo || !tag || !approvalId) throw new Error('Usage: release publish REPO TAG --approval ID');
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const effectiveConfig = config ?? loadConfig();
  if (!repoConfig(repo, effectiveConfig)) return refuse('repo-not-allowed');

  const all = records(dir);
  const approval = all.find((record) => record.id === approvalId && isRelease(record));
  if (!approval) return refuse('no-approval');
  if (!sameTarget(approval, repo, tag)) return refuse('wrong-approval');
  if (!isPublishRequest(approval)) return refuse('wrong-operation');
  if (settled(approval)) return refuse('closed');
  const answer = ownerAnswer(all, approval);
  if (!answer || answer.verdict === 'other') return refuse('no-answer', { waiting: true });
  if (answer.verdict === 'deny') { closeItem(approvalId, 'denied by the Owner', { dir, now }); return refuse('not-accept'); }
  if (Date.parse(answer.at) <= Date.parse(approval.at)) return refuse('answer-too-old');

  const release = readRelease(run, repo, tag);
  if (!release.draft) return refuse('not-draft');
  const hosts = knownHosts ?? knownHostsFromSessions();
  const entry = repoConfig(repo, effectiveConfig);
  let assets;
  let demoApp;
  try { assets = inspectAssets(run, repo, tag, release, hosts, { inspectQlikExtensionZips: entry?.kind === 'qlik-extension', requireDemoApp: entry?.requireDemoApp ?? true }); }
  catch (error) {
    if (entry?.kind === 'qlik-extension' && /Qlik extension|demo app|\.qvf/i.test(error.message)) {
      return refuse('demo-app-failed', { reason: `Demo app gate failed: ${redactSecrets(error.message)}` });
    }
    throw error;
  }
  try { demoApp = demoAppAsset(entry, assets); }
  catch (error) {
    if (entry?.kind === 'qlik-extension') return refuse('demo-app-failed', { reason: `Demo app gate failed: ${redactSecrets(error.message)}` });
    return refuse('scan-failed');
  }
  if (entry?.kind === 'qlik-extension' && (entry.requireDemoApp ?? true) && !approval.release.demoApp) {
    return refuse('demo-app-failed', { reason: 'Demo app gate failed: the approval does not name a separate .qvf asset.' });
  }
  if (JSON.stringify(approval.release.demoApp ?? null) !== JSON.stringify(demoApp)) {
    if (entry?.kind === 'qlik-extension') return refuse('demo-app-failed', { reason: 'Demo app gate failed: the separate .qvf asset changed after approval.' });
    return refuse('checksum-mismatch');
  }
  const card = approval.release.assets ?? [];
  const same = card.length === assets.length && card.every((entry) => assets.some((asset) => asset.name === entry.name && asset.sha256 === entry.sha256 && asset.size === entry.size));
  if (!same) return refuse('checksum-mismatch');
  if (scanFindings(scanRelease(release.body, { knownHosts: hosts, file: 'notes' }), assets).length) return refuse('scan-failed');

  const edit = run(['release', 'edit', tag, '--repo', repo, '--draft=false', approval.release.latest === false ? '--latest=false' : '--latest']);
  if (edit.error || edit.status !== 0) throw new Error(`gh release edit failed: ${failureDetail(edit)}`);
  const after = readRelease(run, repo, tag);
  const names = after.assets.map((asset) => asset.name).sort().join('\n');
  if (after.draft) throw new Error('The release is still a draft after gh release edit.');
  if (names !== card.map((entry) => entry.name).sort().join('\n')) throw new Error('The published release has other assets than the card.');

  writeAudit({ dir, approvalId, who, repo, tag, now });
  closeItem(approvalId, 'published', { dir, now });
  return { ok: true, code: null, reason: null, published: true };
}

// The drafts and the last published release of the allowed repositories, and the open requests.
export function releaseStatus({ repo = null, run, dir = DATA_DIR, config = null }) {
  if (typeof run !== 'function') throw new Error('A gh runner is required.');
  const names = repo ? [repo] : (config?.releases?.repos ?? []).map((entry) => entry.name);
  const rows = [];
  for (const name of names) {
    const result = run(['release', 'list', '--repo', name, '--json', 'tagName,name,isDraft,isLatest,publishedAt', '--limit', '30']);
    let list = [];
    if (!result.error && result.status === 0) { try { list = JSON.parse(result.stdout) ?? []; } catch {} }
    const published = list.filter((entry) => !entry.isDraft).sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))[0] ?? null;
    rows.push({ repo: name, drafts: list.filter((entry) => entry.isDraft).map((entry) => entry.tagName), lastPublished: published ? { tag: published.tagName, publishedAt: published.publishedAt ?? null } : null, readable: !result.error && result.status === 0 });
  }
  const openRequests = records(dir).filter((record) => isRelease(record) && !settled(record) && (!repo || record.release.repo === repo))
    .map((record) => ({ id: record.id, repo: record.release.repo, tag: record.release.tag, at: record.at }));
  return { repos: rows, openRequests };
}

// When the Owner answers a release approval, tell the requesting pane once. A deny closes the item.
// `record` is the new Owner message. Nothing polls: the message store calls this on each append.
export function noticeReleaseAnswer(record, { dir = DATA_DIR, herdr, now = Date.now() } = {}) {
  if (record?.from !== 'owner' || record.kind !== 'message' || !record.replyTo) return null;
  const store = openMessageStore({ dir });
  const approval = store.all().find((item) => item.id === record.replyTo && isRelease(item));
  if (!approval || settled(approval) || approval.answerNoticeAt) return null;
  const verdict = APPROVED.test(record.text) ? 'accepted' : REJECTED.test(record.text) ? 'denied' : null;
  if (!verdict) return null;
  store.update(approval.id, { answerNoticeAt: new Date(now).toISOString() }, { now });
  if (verdict === 'denied') closeItem(approval.id, 'denied by the Owner', { dir, now });
  const { repo, tag } = approval.release;
  if (approval.requesterPane && typeof herdr === 'function') {
    const command = isAddAsset(approval)
      ? `herdr-boss release apply-asset ${repo} ${tag} --approval ${approval.id}`
      : `herdr-boss release publish ${repo} ${tag} --approval ${approval.id}`;
    const next = verdict === 'accepted' ? `Run: ${command}` : 'Request a new approval after you change the release.';
    try { herdr(['agent', 'prompt', approval.requesterPane, `[herdr-boss] The Owner ${verdict} the release ${repo} ${tag}. ${next}`]); } catch {}
  }
  return { id: approval.id, verdict };
}

// Watch the message store for Owner answers. Returns the function that stops the watch.
export function watchReleaseAnswers(store, options = {}) {
  return store.onChange((event) => {
    if (event.type === 'append') { try { noticeReleaseAnswer(event.record, options); } catch {} }
  });
}

const USAGE = 'Usage: release request REPO TAG [--notes FILE] [--pack PACK] [--not-latest] | release add-asset REPO TAG FILE... --reason TEXT [--append-notes FILE] | release apply-asset REPO TAG --approval ID | release cancel REPO TAG [--reason TEXT] | release publish REPO TAG --approval ID | release status [REPO]';

function parseArgs(args, valueFlags, boolFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (valueFlags.includes(token)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} needs a value. ${USAGE}`);
      flags[token] = value;
    } else if (boolFlags.includes(token)) flags[token] = true;
    else if (token.startsWith('--')) throw new Error(`Unknown option: ${token}. ${USAGE}`);
    else positional.push(token);
  }
  return { flags, positional };
}

// The handler of `herdr-boss release ...`. It returns the exit code: 0 done, 1 refused, 3 waiting for the Owner.
export async function releaseCommand(args, { env = process.env, dataDir = DATA_DIR, config = {}, run = null, herdr = null, out = console.log, err = console.error } = {}) {
  const [action, ...rest] = args;
  if (!['request', 'add-asset', 'apply-asset', 'cancel', 'publish', 'status'].includes(action)) throw new Error(USAGE);
  try {
    if (action === 'status') {
      if (!run) { const { ghRunner } = await import('./gh-labels.js'); run = ghRunner({ env }); }
      const { positional } = parseArgs(rest, []);
      if (positional.length > 1) throw new Error(USAGE);
      out(JSON.stringify(releaseStatus({ repo: positional[0] ?? null, run, dir: dataDir, config }), null, 2));
      return 0;
    }
    if (action === 'cancel') {
      const { flags, positional } = parseArgs(rest, ['--reason']);
      if (positional.length !== 2) throw new Error(USAGE);
      const [{ verifyMessageCaller }, { createHerdrRunner }] = await Promise.all([import('./messages.js'), import('./kit/workers.js')]);
      const caller = verifyMessageCaller(env, herdr ?? createHerdrRunner(), 'release cancel');
      const [repo, tag] = positional;
      const result = cancelRelease({ repo, tag, reason: flags['--reason'] ?? '', dir: dataDir, now: Date.now(), who: caller.paneId, role: caller.role });
      if (result.ok) { out(`Cancelled release request ${result.approvalId} for ${repo} ${tag}.`); return 0; }
      err(`Refused: ${result.reason}`);
      return 1;
    }
    if (!run) { const { ghRunner } = await import('./gh-labels.js'); run = ghRunner({ env }); }
    if (action === 'request') {
      const { flags, positional } = parseArgs(rest, ['--notes', '--pack'], ['--not-latest']);
      if (positional.length !== 2) throw new Error(USAGE);
      const [repo, tag] = positional;
      const result = requestRelease({ repo, tag, notesFile: flags['--notes'] ?? null, pack: flags['--pack'] ?? null, latest: !flags['--not-latest'], run, dir: dataDir, config, requesterPane: env.HERDR_PANE_ID ?? null });
      if (result.stale) out(`The open request ${result.id} shows older notes; run release cancel ${repo} ${tag}, then request again.`);
      else out(result.alreadyOpen ? `An open request exists for ${repo} ${tag}: ${result.id}` : `Posted approval ${result.id} for ${repo} ${tag}.`);
      if (result.scanOk === false) out('The secret scan failed. The card shows the classes. Publish will refuse until the draft is clean and a new request exists.');
      return 0;
    }
    if (action === 'add-asset') {
      const { flags, positional } = parseArgs(rest, ['--reason', '--append-notes']);
      if (positional.length < 3) throw new Error(USAGE);
      if (!flags['--reason']?.trim()) throw new Error('--reason is required and must contain 1 to 300 characters.');
      const [repo, tag, ...files] = positional;
      const result = requestAddAsset({ repo, tag, files, reason: flags['--reason'], appendNotesFile: flags['--append-notes'] ?? null, run, dir: dataDir, config, requesterPane: env.HERDR_PANE_ID ?? null });
      out(result.alreadyOpen ? `An open add-asset request exists for ${repo} ${tag}: ${result.id}` : `Posted add-asset approval ${result.id} for ${repo} ${tag}.`);
      if (result.scanOk === false) out('The secret scan failed. The card shows the classes. Apply will refuse until the files and notes are clean.');
      return 0;
    }
    if (action === 'apply-asset') {
      const { flags, positional } = parseArgs(rest, ['--approval']);
      if (positional.length !== 2 || !flags['--approval']) throw new Error(USAGE);
      const [repo, tag] = positional;
      const result = applyAddAsset({ repo, tag, approvalId: flags['--approval'], run, dir: dataDir, config, who: env.HERDR_PANE_ID ?? null });
      if (result.applied) { out(`Added approved assets to ${repo} ${tag}.`); return 0; }
      if (result.partial) {
        err(`Partial failure after upload. Uploaded assets: ${result.uploadedFiles.join(', ')}. cancel the request and request again; the uploaded assets stay. ${result.reason}`);
        return 1;
      }
      err(`${result.waiting ? 'Waiting for the Owner' : 'Refused'}: ${result.reason}`);
      return result.waiting ? 3 : 1;
    }
    const { flags, positional } = parseArgs(rest, ['--approval']);
    if (positional.length !== 2 || !flags['--approval']) throw new Error(USAGE);
    const [repo, tag] = positional;
    const result = publishRelease({ repo, tag, approvalId: flags['--approval'], run, dir: dataDir, config, who: env.HERDR_PANE_ID ?? null });
    if (result.published) { out(`Published ${repo} ${tag}.`); return 0; }
    err(`${result.waiting ? 'Waiting for the Owner' : 'Refused'}: ${result.reason}`);
    return result.waiting ? 3 : 1;
  } catch (error) {
    err(`Refused: ${redactSecrets(error.message)}`);
    return 1;
  }
}
