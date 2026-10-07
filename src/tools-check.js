import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { loadProjectConfig } from './kit/config.js';
import { postToolUpdate } from './messages.js';

export const TOOLS_STATE_FILE = 'tools-state.json';
export const TOOLS_STATE_SCHEMA = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS_FILE = path.join(ROOT, 'factory', 'pins.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const TOOL_DEFINITIONS = [
  { id: 'claude', name: 'Claude Code', whereRuns: ['mac', 'factory image'], pinKey: 'claudeCode', command: ['claude', ['--version']], source: { kind: 'npm', package: '@anthropic-ai/claude-code', tag: 'stable', repo: 'anthropics/claude-code' } },
  { id: 'codex', name: 'Codex', whereRuns: ['mac', 'factory image'], pinKey: 'codex', command: ['codex', ['--version']], source: { kind: 'npm', package: '@openai/codex', tag: 'latest', repo: 'openai/codex' } },
  { id: 'opencode', name: 'OpenCode', whereRuns: ['mac', 'factory image'], pinKey: 'opencode', command: ['opencode', ['--version']], source: { kind: 'npm', package: 'opencode-ai', tag: 'latest', repo: 'anomalyco/opencode' } },
  { id: 'pi', name: 'Pi', whereRuns: ['mac'], command: ['pi', ['--version']], source: { kind: 'npm', package: '@earendil-works/pi-coding-agent', tag: 'latest', repo: 'badlogic/pi-mono' } },
  { id: 'herdr', name: 'Herdr', whereRuns: ['mac', 'factory image'], pinKey: 'herdr', command: ['herdr', ['--version']], source: { kind: 'github', repo: 'ogulcancelik/herdr' } },
  { id: 'codexbar', name: 'CodexBar', whereRuns: ['mac', 'factory image'], pinKey: 'codexbar', command: ['codexbar', ['--version']], source: { kind: 'github', repo: 'steipete/CodexBar' } },
  { id: 'gh', name: 'GitHub CLI', whereRuns: ['mac', 'factory image'], pinKey: 'gh', command: ['gh', ['--version']], source: { kind: 'github', repo: 'cli/cli' } },
  { id: 'node', name: 'Node.js', whereRuns: ['mac', 'factory image'], pinKey: 'node', command: ['node', ['--version']], source: { kind: 'github', repo: 'nodejs/node' } },
  { id: 's6-overlay', name: 's6-overlay', whereRuns: ['factory image'], pinKey: 's6Overlay', source: { kind: 'github', repo: 'just-containers/s6-overlay' } },
  { id: 'chromium', name: 'Chromium', whereRuns: ['factory image'], pinKey: 'chromium', source: { kind: 'debian', package: 'chromium' } },
  { id: 'base-image', name: 'Base image', whereRuns: ['factory build'], pinKey: 'base', source: { kind: 'docker', repository: 'library/debian', tag: 'trixie-slim' } },
  { id: 'buildkit', name: 'BuildKit', whereRuns: ['factory build'], pinKey: 'buildkit', source: { kind: 'github', repo: 'moby/buildkit', dockerRepository: 'moby/buildkit', dockerTag: 'buildx-stable-1' } },
];
const TOOL_REGISTRY = Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));

function versionParts(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/^v/i, '');
  const match = /^(\d+(?:\.\d+)*)(?:[-~]([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(clean);
  if (!match) return null;
  return { numbers: match[1].split('.').map(Number), suffix: match[2] ?? '' };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.suffix === b.suffix) return 0;
  if (!a.suffix) return 1;
  if (!b.suffix) return -1;
  return a.suffix.localeCompare(b.suffix, 'en', { numeric: true });
}

function parseDebianVersion(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let rest = value.trim();
  let epoch = '0';
  const epochMatch = /^(\d+):/.exec(rest);
  if (epochMatch) {
    epoch = epochMatch[1];
    rest = rest.slice(epochMatch[0].length);
  }
  const revisionIndex = rest.lastIndexOf('-');
  const upstream = revisionIndex < 0 ? rest : rest.slice(0, revisionIndex);
  const revision = revisionIndex < 0 ? '0' : rest.slice(revisionIndex + 1);
  if (!upstream || !revision) return null;
  return { epoch, upstream, revision };
}

function compareDebianPart(left, right) {
  let a = 0;
  let b = 0;
  while (a < left.length || b < right.length) {
    while ((a < left.length && !/[0-9]/.test(left[a])) || (b < right.length && !/[0-9]/.test(right[b]))) {
      const charA = a < left.length && !/[0-9]/.test(left[a]) ? left[a] : '';
      const charB = b < right.length && !/[0-9]/.test(right[b]) ? right[b] : '';
      const order = (character) => character === '~' ? -1 : !character ? 0 : /[A-Za-z]/.test(character) ? character.charCodeAt(0) : character.charCodeAt(0) + 256;
      const difference = order(charA) - order(charB);
      if (difference) return Math.sign(difference);
      if (charA) a += 1;
      if (charB) b += 1;
    }
    while (left[a] === '0') a += 1;
    while (right[b] === '0') b += 1;
    const startA = a;
    const startB = b;
    while (/[0-9]/.test(left[a] ?? '')) a += 1;
    while (/[0-9]/.test(right[b] ?? '')) b += 1;
    const digitsA = left.slice(startA, a);
    const digitsB = right.slice(startB, b);
    if (digitsA.length !== digitsB.length) return Math.sign(digitsA.length - digitsB.length);
    const difference = digitsA.localeCompare(digitsB);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function compareDebianVersions(left, right) {
  const a = parseDebianVersion(left);
  const b = parseDebianVersion(right);
  if (!a || !b) return null;
  const epochDifference = compareDebianPart(a.epoch, b.epoch);
  if (epochDifference) return epochDifference;
  const upstreamDifference = compareDebianPart(a.upstream, b.upstream);
  return upstreamDifference || compareDebianPart(a.revision, b.revision);
}

function daysSince(value, now) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS));
}

function releaseVersion(tag) {
  return typeof tag === 'string' ? tag.replace(/^v(?=\d)/, '') : null;
}

function pinValue(definition, pins) {
  if (definition.pinKey === 'base') {
    const base = pins.base;
    if (!base || !base.image || !base.tag || !base.digest) return null;
    return `${base.image}:${base.tag}@${base.digest}`;
  }
  if (definition.pinKey === 'buildkit') {
    const buildkit = pins.buildkit;
    if (!buildkit || !buildkit.image || !buildkit.tag) return null;
    return `${buildkit.image}:${buildkit.tag}${buildkit.digest ? `@${buildkit.digest}` : ''}`;
  }
  return definition.pinKey ? (pins[definition.pinKey] ?? null) : null;
}

function defaultFetch(url, options = {}) {
  const parsed = new URL(url);
  const request = { ...options, signal: options.signal ?? AbortSignal.timeout(15_000) };
  if (parsed.hostname === 'api.github.com') {
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.delete('authorization');
    request.headers = headers;
  }
  return globalThis.fetch(url, request);
}

function readInstalledVersion(command, args, { env } = {}) {
  if (!command) return null;
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env });
    const match = /\bv?\d+(?:\.\d+){1,3}(?:[-+~][0-9A-Za-z.-]+)?/i.exec(output);
    return match ? match[0].replace(/^v/i, '') : null;
  } catch {
    return null;
  }
}

function readInstalledVersions() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tools-version-'));
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tempHome,
    TMPDIR: os.tmpdir(),
    XDG_CONFIG_HOME: path.join(tempHome, 'config'),
    XDG_DATA_HOME: path.join(tempHome, 'data'),
    XDG_CACHE_HOME: path.join(tempHome, 'cache'),
    DISABLE_UPDATES: '1',
    DISABLE_AUTOUPDATER: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
  try {
    return Object.fromEntries(TOOL_DEFINITIONS.filter((tool) => tool.command).map((tool) => {
      const [command, args] = tool.command;
      return [tool.id, command === 'node' ? process.version.replace(/^v/, '') : readInstalledVersion(command, args, { env })];
    }));
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function readPins(pinsFile) {
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  if (!pins || typeof pins !== 'object' || ![1, 2].includes(pins.schema)) throw new Error('The factory pin file has an unsupported schema.');
  return pins;
}

function readPreviousState(dataDir) {
  try {
    const file = path.join(dataDir, TOOLS_STATE_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.schemaVersion !== TOOLS_STATE_SCHEMA || !Array.isArray(state.tools)) return null;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function saveState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  if (Number.isInteger(uid)) {
    let directory;
    try {
      directory = fs.lstatSync(dataDir);
    } catch { /* Skip directory changes when ownership or type is unclear. */ }
    if (directory?.isDirectory() && !directory.isSymbolicLink() && directory.uid === uid) fs.chmodSync(dataDir, 0o700);
  }
  const target = path.join(dataDir, TOOLS_STATE_FILE);
  const temporary = path.join(dataDir, `.${TOOLS_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function requestJson(fetch, url) {
  const response = await fetch(url);
  if (!response?.ok) throw new Error('upstream unavailable');
  return response.json();
}

async function requestText(fetch, url) {
  const response = await fetch(url);
  if (!response?.ok) throw new Error('upstream unavailable');
  return response.text();
}

function nearestNewerRelease(releases, installed, latest) {
  if (!installed || !latest || compareVersions(latest, installed) <= 0) return null;
  const candidates = releases
    .map((release) => ({ version: release.version, publishedAt: release.publishedAt }))
    .filter((release) => release.version && release.publishedAt && compareVersions(release.version, installed) > 0 && compareVersions(release.version, latest) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  return candidates[0] ?? null;
}

function nearestNewerDebianRelease(releases, installed, latest) {
  if (!installed || !latest || compareDebianVersions(latest, installed) <= 0) return null;
  const candidates = releases
    .filter((release) => release.version && release.publishedAt && compareDebianVersions(release.version, installed) > 0 && compareDebianVersions(release.version, latest) <= 0)
    .sort((a, b) => compareDebianVersions(a.version, b.version));
  return candidates[0] ?? null;
}

function isSecurityRelease(release) {
  const text = `${release?.name ?? ''}\n${release?.body ?? ''}`;
  return /\bCVE-\d{4}-\d{4,}\b/i.test(text)
    || /https?:\/\/github\.com\/advisories\/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}\b/i.test(text);
}

function versionInRange(version, range) {
  if (!version || typeof range !== 'string' || !range.trim()) return false;
  return range.split(/\s*\|\|\s*/).some((branch) => {
    const checks = branch.split(',').map((part) => part.trim()).filter(Boolean);
    if (!checks.length) return false;
    return checks.every((check) => {
      const match = /^(>=|>|<=|<|=)?\s*(v?\d+(?:\.\d+){1,3}(?:[-~][0-9A-Za-z.-]+)?)$/.exec(check);
      if (!match) return false;
      const comparison = compareVersions(version, match[2]);
      if (comparison === null) return false;
      if (match[1] === '>') return comparison > 0;
      if (match[1] === '>=') return comparison >= 0;
      if (match[1] === '<') return comparison < 0;
      if (match[1] === '<=') return comparison <= 0;
      return comparison === 0;
    });
  });
}

async function npmLatest(source, fetch) {
  const packagePath = source.package.replace('/', '%2f');
  const metadata = await requestJson(fetch, `https://registry.npmjs.org/${packagePath}`);
  const versions = metadata?.time ?? {};
  const latest = metadata?.['dist-tags']?.[source.tag] ?? null;
  const releases = Object.entries(versions)
    .filter(([version, publishedAt]) => versionParts(version) && !version.includes('-') && Number.isFinite(Date.parse(publishedAt)))
    .map(([version, publishedAt]) => ({ version, publishedAt }));
  return { latest, publishedAt: latest ? versions[latest] ?? null : null, releases };
}

async function githubReleases(repo, fetch) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const releases = await requestJson(fetch, url);
  if (!Array.isArray(releases)) throw new Error('upstream unavailable');
  return releases
    .filter((release) => release && !release.draft && !release.prerelease && releaseVersion(release.tag_name) && release.published_at)
    .map((release) => ({
      version: releaseVersion(release.tag_name),
      publishedAt: release.published_at,
      name: typeof release.name === 'string' ? release.name : '',
      body: typeof release.body === 'string' ? release.body : '',
      assets: Array.isArray(release.assets) ? release.assets.map((asset) => asset?.name).filter((name) => typeof name === 'string') : [],
    }));
}

async function githubAdvisories(repo, fetch) {
  const advisories = await requestJson(fetch, `https://api.github.com/repos/${repo}/security-advisories?per_page=100`);
  if (!Array.isArray(advisories)) throw new Error('upstream unavailable');
  return advisories.filter((advisory) => advisory && !advisory.withdrawn_at);
}

function latestGithub(releases, trackedVersion) {
  const validReleases = releases.filter((release) => versionParts(release.version));
  const trackedMajor = versionParts(trackedVersion)?.numbers[0];
  const trackedLine = trackedMajor === undefined
    ? []
    : validReleases.filter((release) => versionParts(release.version)?.numbers[0] === trackedMajor);
  const candidates = trackedLine.length ? trackedLine : validReleases;
  return [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

function cleanTrackerText(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function debianPackageFromTracker(html) {
  const match = /<b>stable-sec:<\/b>[\s\S]*?<\/span>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (!match) return null;
  const latest = cleanTrackerText(match[1]).replace(/\s+/g, '');
  const releases = [];
  const newsPattern = /<span class="news-date">\s*(\d{4}-\d{2}-\d{2})\s*<\/span>[\s\S]*?<span class="news-title">([\s\S]*?)<\/span>/gi;
  for (const news of html.matchAll(newsPattern)) {
    const title = cleanTrackerText(news[2]);
    const release = /^Accepted chromium (.+?) \(source\) into stable-security$/i.exec(title);
    if (release && parseDebianVersion(release[1])) releases.push({ version: release[1], publishedAt: `${news[1]}T00:00:00.000Z` });
  }
  return { latest, publishedAt: releases.find((release) => release.version === latest)?.publishedAt ?? null, releases };
}

function simplePinVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /\d+(?:\.\d+){1,3}(?:[-~][0-9A-Za-z.-]+)?/.exec(value);
  return match?.[0] ?? null;
}

async function inspectUpstream(definition, fetch, trackedVersion) {
  const source = definition.source;
  if (source.kind === 'npm') {
    const npm = await npmLatest(source, fetch);
    const releases = source.repo ? await githubReleases(source.repo, fetch) : [];
    const advisories = source.repo ? await githubAdvisories(source.repo, fetch).catch(() => []) : [];
    const latestRelease = latestGithub(releases, trackedVersion);
    return { latest: npm.latest, publishedAt: npm.publishedAt, releases: npm.releases, releaseNotes: releases, advisories, latestRelease, latestDigest: null };
  }
  if (source.kind === 'github') {
    const releases = await githubReleases(source.repo, fetch);
    const advisories = await githubAdvisories(source.repo, fetch).catch(() => []);
    const latestRelease = latestGithub(releases, trackedVersion);
    let latestDigest = null;
    let registryUpdatedAt = null;
    if (source.dockerRepository) {
      const image = await requestJson(fetch, `https://hub.docker.com/v2/repositories/${source.dockerRepository}/tags/${source.dockerTag}`);
      latestDigest = typeof image?.digest === 'string' ? image.digest : null;
      registryUpdatedAt = image?.last_updated ?? null;
      if (!latestDigest) throw new Error('upstream unavailable');
    }
    return { latest: latestRelease?.version ?? null, publishedAt: latestRelease?.publishedAt ?? null, releases, releaseNotes: releases, advisories, latestRelease, latestDigest, registryUpdatedAt };
  }
  if (source.kind === 'debian') {
    const html = await requestText(fetch, 'https://tracker.debian.org/pkg/chromium');
    const tracker = debianPackageFromTracker(html);
    if (!tracker?.latest) throw new Error('upstream unavailable');
    return { latest: tracker.latest, publishedAt: tracker.publishedAt, releases: tracker.releases, releaseNotes: [], latestRelease: null, latestDigest: null };
  }
  if (source.kind === 'docker') {
    const image = await requestJson(fetch, `https://hub.docker.com/v2/repositories/${source.repository}/tags/${source.tag}`);
    const latest = typeof image?.digest === 'string' ? image.digest : null;
    if (!latest) throw new Error('upstream unavailable');
    return { latest, publishedAt: image?.last_updated ?? null, releases: [], releaseNotes: [], latestRelease: null, latestDigest: latest, registryUpdatedAt: image?.last_updated ?? null };
  }
  throw new Error('Unsupported upstream source.');
}

function previousTool(previous, id) {
  return previous?.tools?.find((tool) => tool?.id === id) ?? null;
}

function trackedVersionFor(definition, pins, installed) {
  const pinned = pinValue(definition, pins);
  const installedMac = definition.whereRuns.includes('mac') ? (installed[definition.id] ?? null) : null;
  return definition.id === 'buildkit' ? pinned
    : definition.id === 'base-image' ? (pins.base?.digest ?? null)
      : definition.source.kind === 'debian' ? pinned
        : pinned ? simplePinVersion(pinned) : installedMac;
}

function makeToolState(definition, { pins, installed, upstream, previous, now }) {
  const pinned = pinValue(definition, pins);
  const installedMac = definition.whereRuns.includes('mac') ? (installed[definition.id] ?? null) : null;
  const trackedVersion = trackedVersionFor(definition, pins, installed);
  const latest = upstream.latest;
  const nearest = definition.source.kind === 'debian'
    ? nearestNewerDebianRelease(upstream.releases ?? [], trackedVersion, latest)
    : nearestNewerRelease(upstream.releases ?? [], trackedVersion, latest);
  const previousDigest = previousTool(previous, definition.id)?.latestDigest;
  const changedRollingDigest = definition.id === 'buildkit' && previousDigest && upstream.latestDigest && previousDigest !== upstream.latestDigest;
  const baseDigestChanged = definition.id === 'base-image' && latest !== pins.base?.digest;
  const ageDays = nearest ? daysSince(nearest.publishedAt, now)
    : changedRollingDigest ? daysSince(upstream.registryUpdatedAt, now)
      : baseDigestChanged ? daysSince(upstream.registryUpdatedAt, now)
        : null;
  const securityRelease = (upstream.releaseNotes ?? []).some((release) => trackedVersion && latest && compareVersions(release.version, trackedVersion) > 0 && compareVersions(release.version, latest) <= 0 && isSecurityRelease(release));
  const securityAdvisory = (upstream.advisories ?? []).some((advisory) => (advisory.vulnerabilities ?? []).some((vulnerability) => versionInRange(trackedVersion, vulnerability?.vulnerable_version_range)));
  const debianComparison = definition.source.kind === 'debian' ? compareDebianVersions(latest, trackedVersion) : null;
  const debianSecurityRelease = definition.source.kind === 'debian' && debianComparison !== null && debianComparison > 0;
  let risk = 'unknown';
  if (securityRelease || securityAdvisory || debianSecurityRelease) risk = 'security';
  else if (definition.id === 'buildkit') {
    if (previousDigest && upstream.latestDigest) risk = previousDigest === upstream.latestDigest ? 'ok' : (ageDays > 14 ? 'late' : 'ok');
  } else if (definition.source.kind === 'docker') {
    risk = latest && latest === pins.base?.digest ? 'ok' : ageDays === null ? 'unknown' : ageDays > 14 ? 'late' : 'ok';
  } else if (definition.source.kind === 'debian') {
    risk = debianComparison !== null ? (debianComparison <= 0 ? 'ok' : 'security') : 'unknown';
  } else if (trackedVersion && latest) {
    const comparison = compareVersions(latest, trackedVersion);
    if (comparison !== null) risk = comparison <= 0 ? 'ok' : ageDays === null ? 'unknown' : ageDays > 14 ? 'late' : 'ok';
  }
  const result = {
    id: definition.id,
    name: definition.name,
    whereRuns: [...definition.whereRuns],
    installed: { mac: installedMac },
    pinned,
    latest,
    trackedVersion,
    latestPublishedAt: upstream.publishedAt ?? null,
    ageDays,
    risk,
    source: sourceLabel(definition.source),
  };
  if (upstream.latestDigest) result.latestDigest = upstream.latestDigest;
  if (upstream.registryUpdatedAt) result.registryUpdatedAt = upstream.registryUpdatedAt;
  if (changedRollingDigest) result.digestChanged = true;
  return result;
}

function sourceLabel(source) {
  if (source.kind === 'npm') return `npm:${source.package}`;
  if (source.kind === 'github') return `github:${source.repo}`;
  if (source.kind === 'debian') return `debian:${source.package}`;
  return `docker:${source.repository}:${source.tag}`;
}

function failedToolState(definition, { pins, installed, previous }) {
  const prior = previousTool(previous, definition.id);
  const pinned = pinValue(definition, pins);
  return {
    id: definition.id,
    name: definition.name,
    whereRuns: [...definition.whereRuns],
    installed: { mac: definition.whereRuns.includes('mac') ? (installed[definition.id] ?? null) : null },
    pinned,
    latest: prior?.latest ?? null,
    trackedVersion: definition.id === 'buildkit' ? pinned
      : definition.id === 'base-image' ? (pins.base?.digest ?? null)
        : definition.source.kind === 'debian' ? pinned
        : pinned ? simplePinVersion(pinned) : (installed[definition.id] ?? null),
    latestPublishedAt: prior?.latestPublishedAt ?? null,
    ageDays: prior?.ageDays ?? null,
    risk: prior?.risk === 'security' ? 'security' : 'unknown',
    source: sourceLabel(definition.source),
    error: 'upstream unavailable',
    ...(prior?.latestDigest ? { latestDigest: prior.latestDigest } : {}),
  };
}

export function readToolsState({ dataDir = DATA_DIR } = {}) {
  const previous = readPreviousState(dataDir);
  return previous;
}

export function toolsDoctorUpdates({ dataDir = DATA_DIR } = {}) {
  const state = readToolsState({ dataDir });
  if (!state) return null;
  const checkedAt = Date.parse(state.checkedAt);
  const staleSecurity = !Number.isFinite(checkedAt) || Date.now() - checkedAt > DAY_MS;
  const securityRows = state.tools.filter((tool) => tool?.risk === 'security');
  const updates = state.tools.filter((tool) => tool?.risk === 'late' || (tool?.risk === 'security' && !staleSecurity)).map((tool) => {
    const level = tool.risk === 'security' ? 'error' : 'note';
    const installed = tool.trackedVersion ?? tool.installed?.mac ?? 'unknown';
    const age = Number.isInteger(tool.ageDays) ? `, ${tool.ageDays} days` : ', age unknown';
    return {
      id: tool.id,
      risk: tool.risk,
      level,
      installed,
      latest: tool.latest ?? 'unknown',
      ageDays: Number.isInteger(tool.ageDays) ? tool.ageDays : null,
      line: `${level}: ${tool.name} update: installed ${installed}, latest ${tool.latest ?? 'unknown'}${age}.`,
    };
  });
  if (staleSecurity && securityRows.length) {
    updates.push({ id: 'tool-check-stale', risk: 'stale', level: 'note', line: 'note: tool check is stale, run herdr-boss tools check.' });
  }
  return updates;
}

export function createToolsCheck({ dataDir = DATA_DIR, pinsFile = PINS_FILE, fetch: injectedFetch = null, installed: installedVersions = null, now = () => new Date(), mailbox = postToolUpdate, output = console.log } = {}) {
  const fetch = injectedFetch ?? defaultFetch;
  return async function checkTools() {
    const checkTime = now();
    if (!(checkTime instanceof Date) || !Number.isFinite(checkTime.getTime())) throw new Error('The tools check time is invalid.');
    const pins = readPins(pinsFile);
    const installed = installedVersions ?? readInstalledVersions();
    const previous = readPreviousState(dataDir);
    const tools = [];
    for (const definition of TOOL_DEFINITIONS) {
      try {
        const upstream = await inspectUpstream(definition, fetch, trackedVersionFor(definition, pins, installed));
        tools.push(makeToolState(definition, { pins, installed, upstream, previous, now: checkTime }));
      } catch {
        tools.push(failedToolState(definition, { pins, installed, previous }));
      }
    }
    const state = { schemaVersion: TOOLS_STATE_SCHEMA, checkedAt: checkTime.toISOString(), tools };
    saveState(dataDir, state);
    for (const tool of tools) {
      if (tool.risk !== 'security' && !(tool.risk === 'late' && Number.isInteger(tool.ageDays) && tool.ageDays > 14)) continue;
      try {
        await mailbox(tool, { dir: dataDir, now: checkTime.getTime() });
      } catch {
        output(`note: could not post ${tool.name} ${tool.latest} to the Mailbox; continuing.`);
      }
    }
    return state;
  };
}

const SHA256_ARTIFACTS = {
  's6-overlay': {
    files: () => ['s6-overlay-noarch.tar.xz', 's6-overlay-aarch64.tar.xz', 's6-overlay-x86_64.tar.xz'],
    checksumUrl: (version, file) => `https://github.com/just-containers/s6-overlay/releases/download/v${version}/${file}.sha256`,
    artifactUrl: (version, file) => `https://github.com/just-containers/s6-overlay/releases/download/v${version}/${file}`,
  },
  node: {
    files: (version) => [`node-v${version}-linux-arm64.tar.xz`, `node-v${version}-linux-x64.tar.xz`],
    checksumUrl: (version) => `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    artifactUrl: (version, file) => `https://nodejs.org/dist/v${version}/${file}`,
  },
  gh: {
    files: (version) => [`gh_${version}_linux_arm64.tar.gz`, `gh_${version}_linux_amd64.tar.gz`],
    checksumUrl: (version) => `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_checksums.txt`,
    artifactUrl: (version, file) => `https://github.com/cli/cli/releases/download/v${version}/${file}`,
  },
  codexbar: {
    files: (version) => [`CodexBarCLI-v${version}-linux-aarch64.tar.gz`, `CodexBarCLI-v${version}-linux-x86_64.tar.gz`],
    checksumUrl: (version, file) => `https://github.com/steipete/CodexBar/releases/download/v${version}/${file}.sha256`,
    artifactUrl: (version, file) => `https://github.com/steipete/CodexBar/releases/download/v${version}/${file}`,
  },
};

function checkedIntegrity(value) {
  return typeof value === 'string' && /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/.test(value.trim())
    ? value.trim()
    : null;
}

function parsePublishedChecksum(text, file) {
  const expectedName = path.posix.basename(file);
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = lines.map((line) => /^([a-f0-9]{64})(?:\s+\*?(.+))?$/i.exec(line)).filter(Boolean);
  const match = matches.find((entry) => entry[2] && path.posix.basename(entry[2]) === expectedName)
    ?? (matches.length === 1 && !matches[0][2] ? matches[0] : null);
  return match?.[1]?.toLowerCase() ?? null;
}

async function requestBytes(fetch, url) {
  const response = await fetch(url);
  if (!response?.ok) throw new Error('upstream unavailable');
  if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer());
  return Buffer.from(await response.text());
}

async function checkedGithubVersion(definition, requested, pins, fetch) {
  const releases = await githubReleases(definition.source.repo, fetch);
  const selected = requested
    ? releases.find((release) => release.version === releaseVersion(requested))
    : latestGithub(releases, simplePinVersion(pinValue(definition, pins)));
  if (!selected) throw new Error(`The requested ${definition.name} release was not found upstream.`);
  return selected;
}

async function checkArtifactHashes(definition, version, fetch) {
  const source = Object.hasOwn(SHA256_ARTIFACTS, definition.id) ? SHA256_ARTIFACTS[definition.id] : null;
  if (!source) throw new Error(`${definition.name} has no checksum source. Herdr Boss did not guess a hash.`);
  const hashes = {};
  for (const file of source.files(version)) {
    const publishedText = await requestText(fetch, source.checksumUrl(version, file));
    const published = parsePublishedChecksum(publishedText, file);
    if (!published) throw new Error(`The published checksum is missing for ${file}. Herdr Boss did not guess a hash.`);
    const artifact = await requestBytes(fetch, source.artifactUrl(version, file));
    const actual = createHash('sha256').update(artifact).digest('hex');
    if (actual !== published) throw new Error(`The downloaded checksum does not match the published value for ${file}.`);
    hashes[file] = published;
  }
  return hashes;
}

function formatDiff(fileName, before, after) {
  if (before === after) return '';
  const left = before.replace(/\n$/, '').split('\n');
  const right = after.replace(/\n$/, '').split('\n');
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      operations.push({ type: ' ', text: left[i] });
      i += 1;
      j += 1;
    } else if (i < left.length && (j === right.length || rows[i + 1][j] >= rows[i][j + 1])) {
      operations.push({ type: '-', text: left[i] });
      i += 1;
    } else {
      operations.push({ type: '+', text: right[j] });
      j += 1;
    }
  }
  const changes = operations.map((operation, index) => operation.type === ' ' ? -1 : index).filter((index) => index >= 0);
  const groups = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last && change - last.last <= 6) last.last = change;
    else groups.push({ first: change, last: change });
  }
  const beforeCount = (index, type) => operations.slice(0, index).filter((operation) => operation.type !== (type === 'old' ? '+' : '-')).length;
  const range = (start, count) => `${start}${count === 1 ? '' : `,${count}`}`;
  const hunks = groups.map(({ first, last }) => {
    const start = Math.max(0, first - 3);
    const end = Math.min(operations.length, last + 4);
    const body = operations.slice(start, end);
    const oldCount = body.filter((operation) => operation.type !== '+').length;
    const newCount = body.filter((operation) => operation.type !== '-').length;
    const oldStart = beforeCount(start, 'old') + (oldCount ? 1 : 0);
    const newStart = beforeCount(start, 'new') + (newCount ? 1 : 0);
    return `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n${body.map((operation) => `${operation.type}${operation.text}`).join('\n')}`;
  });
  return [`--- a/${fileName}`, `+++ b/${fileName}`, ...hunks].join('\n');
}

function atomicWrite(file, contents) {
  const mode = fs.statSync(file).mode & 0o777;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    try {
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* Some file systems do not support syncing a directory. */ }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function runGit(injected, args, cwd) {
  if (injected) return injected(args, { cwd });
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function removeBumpWorktree(git, root, worktreePath, branch, cwd) {
  let failed = false;
  try { runGit(git, ['-C', root, 'worktree', 'remove', '--force', worktreePath], cwd); } catch { failed = true; }
  try { runGit(git, ['-C', root, 'branch', '-D', branch], cwd); } catch { failed = true; }
  if (failed) throw new Error('Herdr Boss could not remove the temporary bump worktree and branch.');
}

function pathExists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function bumpBranchPart(version) {
  return version.replaceAll('+', '_').replace(/\.{2,}/g, '.').replace(/\.+$/, '');
}

function bumpUsage() {
  return 'Usage: tools bump TOOL [--to VERSION] [--dry-run]';
}

async function bumpNpm(definition, requested, pins, fetch, now, output) {
  const metadata = await requestJson(fetch, `https://registry.npmjs.org/${definition.source.package.replace('/', '%2f')}`);
  const target = requested ?? metadata?.['dist-tags']?.[definition.source.tag];
  const version = metadata?.versions?.[target];
  if (!target || !version) throw new Error(`The requested ${definition.name} version was not found in the npm registry.`);
  const integrity = checkedIntegrity(version?.dist?.integrity);
  if (!integrity) throw new Error(`The published integrity is missing for ${definition.name} ${target}.`);
  let security = false;
  let publishedAt = metadata?.time?.[target];
  if (['claude', 'codex', 'opencode'].includes(definition.id)) {
    const releases = await githubReleases(definition.source.repo, fetch);
    const notes = releases.find((release) => release.version === target) ?? null;
    let advisories = [];
    try {
      advisories = await githubAdvisories(definition.source.repo, fetch);
    } catch {
      output(`note: the security advisory check failed for ${definition.name} ${target}. The three-day security exception was not checked.`);
    }
    const pinned = simplePinVersion(pinValue(definition, pins));
    security = isSecurityRelease(notes) || advisories.some((advisory) => (advisory.vulnerabilities ?? []).some((vulnerability) => versionInRange(pinned, vulnerability?.vulnerable_version_range)));
    publishedAt ??= notes?.publishedAt;
    const releaseTime = Date.parse(publishedAt);
    if (!Number.isFinite(releaseTime)) throw new Error(`The release date is missing for ${definition.name} ${target}.`);
    if (!security && now.getTime() - releaseTime < 3 * DAY_MS) throw new Error(`${definition.name} ${target} is less than 3 days old. Wait before bumping it.`);
  }
  return { version: target, integrity, security, releaseNotesUrl: `https://github.com/${definition.source.repo}/releases` };
}

async function bumpDocker(definition, requested, pins, fetch) {
  const source = definition.source;
  const repository = source.kind === 'docker' ? source.repository : source.dockerRepository;
  const tag = source.kind === 'docker' ? source.tag : source.dockerTag;
  const image = await requestJson(fetch, `https://hub.docker.com/v2/repositories/${repository}/tags/${tag}`);
  const digest = image?.digest;
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`The registry digest is missing for ${definition.name}.`);
  let version = digest;
  if (definition.id === 'buildkit') {
    if (requested) throw new Error('BuildKit uses a rolling image tag. Do not pass --to.');
    const release = await checkedGithubVersion(definition, null, pins, fetch);
    version = release.version;
  } else if (requested) throw new Error(`${definition.name} uses a registry digest. Do not pass --to.`);
  return { version, digest, releaseNotesUrl: definition.source.repo ? `https://github.com/${definition.source.repo}/releases` : null };
}

async function bumpDetails(definition, requested, pins, fetch, now, output) {
  if (definition.source.kind === 'npm') return { kind: 'npm', ...(await bumpNpm(definition, requested, pins, fetch, now, output)) };
  if (definition.id === 'base-image' || definition.id === 'buildkit') return { kind: 'docker', ...(await bumpDocker(definition, requested, pins, fetch)) };
  if (!Object.hasOwn(SHA256_ARTIFACTS, definition.id)) throw new Error(`${definition.name} has no checksum source. Herdr Boss did not guess a hash.`);
  const release = await checkedGithubVersion(definition, requested, pins, fetch);
  const hashes = await checkArtifactHashes(definition, release.version, fetch);
  return { kind: 'sha256', version: release.version, hashes, releaseNotesUrl: `https://github.com/${definition.source.repo}/releases/tag/v${release.version}` };
}

function applyBump(pins, definition, details) {
  const next = structuredClone(pins);
  next.schema = 2;
  next.sha256Mark ??= {};
  next.integrity ??= {};
  next.digestMark ??= {};
  for (const name of Object.keys(next.sha256 ?? {})) next.sha256Mark[name] ??= 'published';
  if (next.base?.digest) next.digestMark.base ??= 'published';
  if (next.buildkit?.digest) next.digestMark.buildkit ??= 'published';
  if (details.kind === 'npm') {
    next[definition.pinKey] = details.version;
    next.integrity[definition.pinKey] = { version: details.version, value: details.integrity, mark: 'published' };
  } else if (details.kind === 'sha256') {
    next[definition.pinKey] = details.version;
    Object.assign(next.sha256, details.hashes);
    for (const name of Object.keys(details.hashes)) next.sha256Mark[name] = 'published';
  } else if (definition.id === 'base-image') {
    next.base.digest = details.digest;
    next.digestMark.base = 'published';
  } else {
    next.buildkit.digest = details.digest;
    next.buildkit.version = details.version;
    next.digestMark.buildkit = 'published';
  }
  return next;
}

async function runToolsBump(args, options = {}) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      if (flags['--dry-run']) throw new Error(bumpUsage());
      flags['--dry-run'] = true;
    } else if (arg === '--to') {
      if (flags['--to'] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(bumpUsage());
      flags['--to'] = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--')) throw new Error(bumpUsage());
    else positional.push(arg);
  }
  if (positional.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(positional[0])) throw new Error(bumpUsage());
  if (flags['--to'] && !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(flags['--to'])) throw new Error(bumpUsage());
  if (!Object.hasOwn(TOOL_REGISTRY, positional[0])) throw new Error(`Tool ${positional[0]} has no factory pin to bump.`);
  const definition = TOOL_REGISTRY[positional[0]];
  if (!definition?.pinKey) throw new Error(`Tool ${positional[0]} has no factory pin to bump.`);
  if (definition.id === 'herdr' || definition.id === 'chromium') throw new Error(`${definition.name} has no checksum source. Herdr Boss did not guess a hash.`);
  const root = path.resolve(options.root ?? ROOT);
  const pinsFile = options.pinsFile ?? path.join(root, 'factory', 'pins.json');
  const before = fs.readFileSync(pinsFile, 'utf8');
  const pins = readPins(pinsFile);
  const fetch = options.fetch ?? defaultFetch;
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('The tools bump time is invalid.');
  const output = options.output ?? console.log;
  const details = await bumpDetails(definition, flags['--to'], pins, fetch, now, output);
  const currentVersion = definition.id === 'buildkit' ? pins.buildkit?.version
    : definition.id === 'base-image' ? null : pins[definition.pinKey];
  if (currentVersion && compareVersions(details.version, currentVersion) < 0) {
    throw new Error(`The requested ${definition.name} version is older than its pin. Herdr Boss did not move the pin backwards.`);
  }
  const nextPins = applyBump(pins, definition, details);
  const after = `${JSON.stringify(nextPins, null, 2)}\n`;
  const diff = formatDiff('factory/pins.json', before, after);
  if (!diff) {
    output('The factory pin is already current.');
    return 0;
  }
  if (!flags['--dry-run']) {
    const project = options.projectConfig ?? loadProjectConfig({ cwd: root });
    const worktreeName = `tools-bump-${definition.id}-${details.version}`;
    const worktreePath = project.worktreePath(worktreeName);
    if (pathExists(worktreePath)) throw new Error(`The tools bump worktree already exists: ${worktreePath}.`);
    const worktreeParent = path.dirname(worktreePath);
    const git = options.git ?? null;
    const status = runGit(git, ['status', '--porcelain'], root);
    if (String(status ?? '').trim()) throw new Error('The working tree is not clean. Herdr Boss did not change the factory pin.');
    const branch = `tools/${definition.id}-${bumpBranchPart(details.version)}`;
    let created = false;
    try {
      fs.mkdirSync(worktreeParent, { recursive: true });
      runGit(git, ['-C', root, 'worktree', 'add', '-b', branch, worktreePath, project.baseBranch ?? 'main'], worktreeParent);
      created = true;
      atomicWrite(path.join(worktreePath, 'factory', 'pins.json'), after);
      runGit(git, ['add', '--', 'factory/pins.json'], worktreePath);
      runGit(git, ['commit', '-m', `chore: bump ${definition.id} to ${details.version}`, '-m', 'Kit-Impact: none'], worktreePath);
    } catch (error) {
      if (created) {
        try { removeBumpWorktree(git, root, worktreePath, branch, worktreeParent); }
        catch { error.message += ' Herdr Boss could not remove the temporary bump worktree and branch.'; }
      }
      throw error;
    }
    output(`Worktree: ${worktreePath}`);
    output(`Branch: ${branch}`);
  }
  output(diff);
  if (details.releaseNotesUrl) output(`Release notes: ${details.releaseNotesUrl}`);
  return 0;
}

function formatState(state) {
  const lines = [`Tools checked ${state.checkedAt}`, 'Tool | Runs on | Installed (Mac) | Pinned | Latest | Age | Risk'];
  for (const tool of state.tools) {
    const installed = tool.installed.mac ?? 'n/a';
    const pinned = tool.pinned ?? 'none';
    const age = Number.isInteger(tool.ageDays) ? `${tool.ageDays} d` : '-';
    lines.push(`${tool.name} | ${tool.whereRuns.join(', ')} | ${installed} | ${pinned} | ${tool.latest ?? 'unknown'} | ${age} | ${tool.risk}`);
  }
  return lines.join('\n');
}

export async function toolsCommand(args, options = {}) {
  if (args[0] === 'bump') return runToolsBump(args.slice(1), options);
  if (args[0] !== 'check' || args.length > 2 || args.slice(1).some((flag) => flag !== '--json') || new Set(args.slice(1)).size !== args.length - 1) {
    throw new Error('Usage: tools check [--json] or tools bump TOOL [--to VERSION] [--dry-run]');
  }
  const state = await createToolsCheck(options)();
  const output = options.output ?? console.log;
  output(args.includes('--json') ? JSON.stringify(state, null, 2) : formatState(state));
  return 0;
}
