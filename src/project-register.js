// The project register: one JSON file in the data folder, mode 0600, never a repository.
// The store validates every record on read and on write, and the audit file takes one line per write.
import fs from 'node:fs';
import path from 'node:path';

import { readDataFile, writeDataFile } from './data-file-safety.js';
import { scanText } from './secret-scan.js';
import { DATA_DIR, ISO_TIME } from './config.js';
import { stripRemoteCredentials, readProjectRepos } from './harness.js';
import { withMutationLock } from './kit/locks.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FACTORY = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const STATE = ['open', 'parked', 'parking', 'archived'];
export const PRIORITY = ['high', 'normal', 'low'];

export const FIELDS = [
  'slug',
  'title',
  'group',
  'clientTag',
  'repo',
  'remote',
  'factory',
  'state',
  'pinned',
  'priority',
  'issueSource',
  'autoOpen',
  'lastOpenedAt',
  'lastActivityAt',
  'nextAction',
  'notes',
  'createdAt',
];

// The order of the field names in the output of `project register edit`.
export const EDIT_FIELDS = [
  'title',
  'group',
  'clientTag',
  'repo',
  'remote',
  'factory',
  'pinned',
  'priority',
  'issueSource',
  'autoOpen',
  'nextAction',
  'notes',
];

function recordError(message) {
  return new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string';
}

// The classes of secret that one value looks like. An empty list is false.
export function secretClasses(value) {
  const found = scanText('', value);
  return Array.isArray(found) && found.length > 0 ? found : null;
}

function enumPhrase(allowed) {
  return `${allowed.slice(0, -1).join(', ')}, or ${allowed.at(-1)}`;
}

// The problem of a remote value: null, 'shape', or 'credentials'.
export function remoteProblem(value) {
  if (value === '') return null;
  if (!isText(value)) return 'shape';
  if (/\s/.test(value)) return 'shape';
  if (value.includes('?') || value.includes('#')) return 'credentials';
  if (/%(3f|23|3b|40)|;/i.test(value)) return 'credentials';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1].toLowerCase();
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    let url;
    try { url = new URL(value); }
    catch {
      const rest = value.slice(value.indexOf('://') + 3);
      const at = rest.indexOf('@');
      if (at !== -1 && rest.slice(0, at).includes(':')) return 'credentials';
      return /^https?$/.test(scheme) && rest.includes('@') ? 'credentials' : 'shape';
    }
    if (!url.hostname) return authority.includes('@') ? 'credentials' : 'shape';
    if (url.password !== '') return 'credentials';
    if (/^https?$/.test(scheme) && (url.username !== '' || authority.includes('@'))) return 'credentials';
    return null;
  }
  const ownerName = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
  if (ownerName) return ownerName[1] === '.' || ownerName[1] === '..' || ownerName[2] === '.' || ownerName[2] === '..' ? 'shape' : null;
  const scp = /^([^@/:\s]+)(?::([^@/\s]*))?@([^@/:\s]+):([^\s?#]+)$/.exec(value);
  if (!scp) return 'shape';
  return value.slice(0, value.lastIndexOf('@')).includes(':') ? 'credentials' : null;
}

// Return an OWNER/REPO source only when the remote identifies a GitHub repository.
export function githubRepoFromRemote(value) {
  if (!isText(value) || value === '' || remoteProblem(value) !== null) return null;

  let owner;
  let repo;
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (shorthand) {
    [, owner, repo] = shorthand;
  } else {
    const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
    if (scp) {
      [, owner, repo] = scp;
    } else {
      let url;
      try { url = new URL(value); }
      catch { return null; }
      if (url.hostname.toLowerCase() !== 'github.com' || url.port !== '' || !['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      if (url.protocol === 'ssh:' && url.username !== 'git') return null;
      if (url.protocol !== 'ssh:' && url.username !== '') return null;
      const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (segments.length !== 2) return null;
      [owner, repo] = segments;
      repo = repo.replace(/\.git$/i, '');
      if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    }
  }
  repo = repo?.replace(/\.git$/i, '');
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}

export function normalizeRepoPath(value) {
  return isText(value) && value !== '' && path.isAbsolute(value) ? path.normalize(value) : value;
}

export function validIso(value, { allowEmpty = true } = {}) {
  if (value === '') return allowEmpty;
  if (!isText(value) || !ISO_TIME.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function checkIssueSource(value, slug) {
  if (value === null) return value;
  const fields = 'The issueSource of the record must hold only the fields repo and label as text.';
  if (!isObject(value)) throw recordError(fields);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('repo') || !keys.includes('label')) throw recordError(fields);
  if (!isText(value.repo) || !isText(value.label)) throw recordError(fields);
  if (value.repo === '') throw recordError(fields);
  return value;
}

function fieldRules(record, slug) {
  if (!isText(record.title) || [...record.title].length < 1 || [...record.title].length > 80) {
    throw recordError(`The title of ${slug} must hold 1 to 80 characters.`);
  }
  if (!isText(record.group) || [...record.group].length > 40) {
    throw recordError(`The group of ${slug} must hold at most 40 characters.`);
  }
  if (record.clientTag !== undefined && (!isText(record.clientTag) || [...record.clientTag].length > 80)) {
    throw recordError(`The client tag of ${slug} must hold at most 80 characters.`);
  }
  if (!isText(record.repo) || (record.repo !== '' && !path.isAbsolute(record.repo))) {
    throw recordError(`The repo of ${slug} must be an absolute path or be empty.`);
  }
  const remote = remoteProblem(record.remote);
  if (remote === 'shape') throw recordError(`The remote of ${slug} must be owner/name or a URL without spaces.`);
  if (remote === 'credentials') {
    throw recordError(`The remote of ${slug} must not hold credentials, a query string, or a fragment.`);
  }
  if (!isText(record.factory) || !FACTORY.test(record.factory)) {
    throw recordError(`The factory of ${slug} must match [a-z0-9][a-z0-9-]* and have at most 40 characters.`);
  }
  if (!STATE.includes(record.state)) throw recordError(`The state of ${slug} must be ${enumPhrase(STATE)}.`);
  if (typeof record.pinned !== 'boolean') throw recordError(`The pinned of ${slug} must be true or false.`);
  if (record.pinned && !['open', 'parking'].includes(record.state)) throw recordError(`Only an open project can be pinned.`);
  if (!PRIORITY.includes(record.priority)) throw recordError(`The priority of ${slug} must be ${enumPhrase(PRIORITY)}.`);
  checkIssueSource(record.issueSource, slug);
  if (record.autoOpen !== 'on' && record.autoOpen !== 'off') throw recordError(`The autoOpen of ${slug} must be off or on.`);
  if (!validIso(record.lastOpenedAt)) throw recordError(`The lastOpenedAt of ${slug} must be an ISO time or be empty.`);
  if (!validIso(record.lastActivityAt)) throw recordError(`The lastActivityAt of ${slug} must be an ISO time or be empty.`);
  if (!isText(record.nextAction) || [...record.nextAction].length > 200) {
    throw recordError(`The nextAction of ${slug} must hold at most 200 characters.`);
  }
  if (!isText(record.notes) || [...record.notes].length > 2000) {
    throw recordError(`The notes of ${slug} must hold at most 2000 characters.`);
  }
  if (!validIso(record.createdAt, { allowEmpty: false })) throw recordError(`The createdAt of ${slug} must be an ISO time.`);
}

function secretRule(value, field) {
  if (!isText(value)) return;
  const classes = secretClasses(value);
  if (classes) throw recordError(`The ${field} matches the secret scan (${classes}). Herdr Boss did not store it.`);
}

// The rules of one record of the register. The order of the checks is the order of the fields.
export function checkRecord(record) {
  if (!isObject(record)) throw recordError('project-register.json holds a record that is not an object.');
  for (const name of Object.keys(record)) {
    if (FIELDS.includes(name)) continue;
    if (secretClasses(name)) throw recordError('project-register.json holds an unknown field that matches the secret scan.');
    throw recordError(`project-register.json holds an unknown field: ${name}.`);
  }
  if (!isText(record.slug) || !SLUG.test(record.slug)) {
    throw recordError('The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters.');
  }
  const slug = record.slug;
  fieldRules(record, slug);
  for (const name of FIELDS) {
    const value = record[name];
    if (name === 'issueSource' && isObject(value)) {
      secretRule(value.repo, `issueSource.repo of ${slug}`);
      secretRule(value.label, `issueSource.label of ${slug}`);
    } else {
      secretRule(value, `${name} of ${slug}`);
    }
  }
  return record;
}

function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw recordError(`${file} is not valid JSON.`);
  }
}

// Reads the register. A missing file gives an empty register and writes nothing.
export function readRegister(dataDir = DATA_DIR) {
  const file = path.join(dataDir, 'project-register.json');
  let text;
  try {
    text = readDataFile(file, dataDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1, projects: [] };
    throw error;
  }
  const parsed = parseJson(text, 'project-register.json');
  if (!isObject(parsed)) throw recordError('project-register.json must hold an object.');
  if (parsed.version !== 1) throw recordError('project-register.json must hold the version 1.');
  if (!Array.isArray(parsed.projects)) throw recordError('project-register.json must hold the list projects.');
  const seen = new Set();
  for (const record of parsed.projects) {
    checkRecord(record);
    if (seen.has(record.slug)) throw recordError(`The register holds ${record.slug} twice.`);
    seen.add(record.slug);
  }
  return { version: 1, projects: parsed.projects };
}

export function writeRegister(register, dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const projects = register.projects.map((record) => ({ ...record, repo: normalizeRepoPath(record.repo) }));
  const body = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
  writeDataFile(path.join(dataDir, 'project-register.json'), body, dataDir);
}

// Move a project's activity time forward without replacing a newer event.
export function recordProjectActivity(slug, at, { dataDir = DATA_DIR } = {}) {
  let timestamp;
  try { timestamp = at instanceof Date ? at.toISOString() : typeof at === 'number' ? new Date(at).toISOString() : at; }
  catch { return false; }
  if (!SLUG.test(slug) || !validIso(timestamp, { allowEmpty: false })) return false;
  return withRegisterLock(dataDir, () => {
    const register = readRegister(dataDir);
    const record = register.projects.find((project) => project.slug === slug);
    if (!record || (record.lastActivityAt && Date.parse(record.lastActivityAt) >= Date.parse(timestamp))) return false;
    record.lastActivityAt = timestamp;
    writeRegister(register, dataDir);
    return true;
  });
}

export function withRegisterLock(dataDir, operation) {
  const directory = path.join(dataDir, 'locks', 'project-register');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withMutationLock(directory, operation, { busyMessage: 'The project register is busy. Retry when it finishes.' });
}

// Appends one audit line with mode 0600. A dry run calls this never.
export function appendAudit(slug, action, dataDir = DATA_DIR, fields = {}) {
  if (fields.dryRun) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'project-audit.jsonl');
    const line = `${JSON.stringify({ at: fields.at ?? new Date().toISOString(), slug, action, by: fields.by ?? 'owner-cli', result: fields.result ?? 'done', failedCheck: fields.failedCheck ?? null, dryRun: false, ...(fields.reason === undefined ? {} : { reason: fields.reason }) })}\n`;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw recordError('The register changed, but its audit line could not be written.');
  }
}

// The factory of this data folder. A missing or unreadable settings file gives factory-zero.
export function localFactory(dataDir = DATA_DIR) {
  let parsed;
  try {
    parsed = parseJson(readDataFile(path.join(dataDir, 'fleet-settings.json'), dataDir), 'fleet-settings.json');
  } catch {
    return 'factory-zero';
  }
  if (isObject(parsed) && isText(parsed.name) && FACTORY.test(parsed.name)) return parsed.name;
  return 'factory-zero';
}

// The keys of policy.json that name a project.
function readPolicyProjects(dataDir) {
  let text;
  try {
    text = readDataFile(path.join(dataDir, 'policy.json'), dataDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const parsed = parseJson(text, 'policy.json');
  if (!isObject(parsed) || !isObject(parsed.projects)) return [];
  return Object.keys(parsed.projects).filter((key) => SLUG.test(key));
}

// Compare workspace names with project slugs while ignoring case and punctuation.
export function normalizeProjectName(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function rows(result, key) {
  return Array.isArray(result?.[key]) ? result[key] : Array.isArray(result) ? result : null;
}

const workspaceId = (workspace) => workspace?.workspace_id ?? workspace?.workspaceId ?? workspace?.id ?? null;
const paneId = (pane) => pane?.pane_id ?? pane?.paneId ?? pane?.id ?? null;
const paneWorkspaceId = (pane) => pane?.workspace_id ?? pane?.workspaceId ?? pane?.workspace ?? null;
const agentPaneId = (agent) => agent?.pane_id ?? agent?.paneId ?? agent?.pane ?? null;

// Return live project states from one Herdr snapshot. A workspace is open only when it has a live orch pane and agent.
export function collectLiveProjectStates(herdr) {
  try {
    const workspaces = rows(herdr(['workspace', 'list']), 'workspaces');
    const panes = rows(herdr(['pane', 'list']), 'panes');
    const agents = rows(herdr(['agent', 'list']), 'agents');
    if (!workspaces || !panes || !agents) throw new Error('Herdr returned an incomplete project list.');
    const agentPanes = new Set(agents.map(agentPaneId).filter(Boolean));
    const projects = new Map();
    for (const workspace of workspaces.filter(isObject)) {
      const names = [...new Set([workspace.label, workspace.name].filter(isText))];
      if (!names.length) continue;
      const id = workspaceId(workspace);
      const hasOrchestrator = panes.some((pane) => pane?.label === 'orch'
        && paneWorkspaceId(pane) === id
        && (agentPanes.has(paneId(pane)) || (isText(pane.agent) && pane.agent.length > 0)));
      for (const name of names) {
        const key = normalizeProjectName(name);
        if (key) projects.set(key, { name, id, state: hasOrchestrator ? 'open' : 'parked', hasOrchestrator });
      }
    }
    return { projects, known: true, warning: null };
  } catch {
    return {
      projects: new Map(),
      known: false,
      warning: 'Warning: Herdr did not list its workspaces and project leads. Existing register states stay unchanged.',
    };
  }
}

function slugFromWorkspaceName(value) {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return SLUG.test(slug) ? slug : '';
}

function listStatusFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// A status file that reads and parses gives its object. Every other file gives null.
function readStatusFile(dir, name) {
  try {
    const parsed = parseJson(readDataFile(path.join(dir, name), dir), name);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Gathers one candidate record per source: the rows of project-repos.json, the keys of policy.json,
// and the published status files. A candidate holds only slug, title, repo, remote, lastActivityAt, and state.
export function collectImportCandidates({ dataDir = DATA_DIR, herdr } = {}) {
  const candidates = new Map();
  let invalidRepoSlugs = 0;
  const ensure = (slug) => {
    if (!candidates.has(slug)) candidates.set(slug, { slug, state: 'parked' });
    return candidates.get(slug);
  };

  for (const row of readProjectRepos(dataDir)) {
    if (!SLUG.test(row.slug)) {
      invalidRepoSlugs += 1;
      continue;
    }
    const candidate = ensure(row.slug);
    if (row.repo) candidate.repo = row.repo;
    const remote = stripRemoteCredentials(row.remote);
    if (remote && remoteProblem(remote) === null) candidate.remote = remote;
  }

  for (const key of readPolicyProjects(dataDir)) ensure(key);

  const statusDir = path.join(dataDir, 'projects');
  const statuses = listStatusFiles(statusDir)
    .map((name) => ({ name, status: readStatusFile(statusDir, name) }))
    .filter((entry) => entry.status !== null);

  const live = collectLiveProjectStates(herdr);
  const warning = live.warning;

  for (const { name, status } of statuses) {
    // The file name holds the slug. A slug field in the file does not change it.
    const slug = name.slice(0, -'.json'.length);
    if (!SLUG.test(slug)) continue;
    const candidate = ensure(slug);
    if (isText(status.project)) candidate.title = status.project;
    if (validIso(status.updated) && status.updated !== '') candidate.lastActivityAt = status.updated;
  }

  for (const [key, workspace] of live.projects) {
    if (!workspace.hasOrchestrator || key === normalizeProjectName('boss')) continue;
    const matched = [...candidates.values()].find((candidate) => normalizeProjectName(candidate.slug) === key);
    if (!matched) {
      const slug = slugFromWorkspaceName(workspace.name);
      if (slug) ensure(slug);
    }
  }

  for (const candidate of candidates.values()) {
    candidate.state = live.projects.get(normalizeProjectName(candidate.slug))?.state === 'open' ? 'open' : 'parked';
  }

  return { candidates: [...candidates.values()], warning, invalidRepoSlugs, presenceKnown: live.known };
}

function safeText(value, max, fallback) {
  if (!isText(value)) return fallback;
  const text = value.trim().slice(0, max);
  if (!text || secretClasses(text)) return fallback;
  return text;
}

// Builds a valid register record from a candidate. A value that fails the scan falls back to the default.
export function buildCandidateRecord(candidate, dataDir = DATA_DIR) {
  const slug = candidate.slug;
  const issueRepo = githubRepoFromRemote(candidate.remote);
  const record = {
    slug,
    title: safeText(candidate.title, 80, slug),
    group: '',
    clientTag: '',
    repo: isText(candidate.repo) && candidate.repo !== '' && path.isAbsolute(candidate.repo) && !secretClasses(candidate.repo)
      ? normalizeRepoPath(candidate.repo)
      : '',
    remote: isText(candidate.remote) && remoteProblem(candidate.remote) === null && !secretClasses(candidate.remote)
      ? candidate.remote
      : '',
    factory: localFactory(dataDir),
    state: candidate.state === 'open' ? 'open' : 'parked',
    pinned: false,
    priority: 'normal',
    issueSource: issueRepo ? { repo: issueRepo, label: '' } : null,
    autoOpen: 'off',
    lastOpenedAt: '',
    lastActivityAt: validIso(candidate.lastActivityAt) ? candidate.lastActivityAt : '',
    nextAction: '',
    notes: '',
    createdAt: new Date().toISOString(),
  };
  checkRecord(record);
  return record;
}

// Import project sources and refresh only fields derived from current Herdr and published status data.
export function importProjectRegister({ dataDir = DATA_DIR, herdr, dryRun = false, log = () => {}, warn = (text) => console.error(text) } = {}) {
  const importRecords = () => {
    const register = readRegister(dataDir);
    const existing = new Map(register.projects.map((entry) => [entry.slug, entry]));
    const { candidates, warning, invalidRepoSlugs, presenceKnown } = collectImportCandidates({ dataDir, herdr });
    if (invalidRepoSlugs > 0) warn(`Warning: skipped ${invalidRepoSlugs} project-repos.json row${invalidRepoSlugs === 1 ? '' : 's'} with an invalid slug.`);
    if (warning) warn(warning);
    const added = [];
    const updated = [];
    for (const candidate of candidates) {
      const record = existing.get(candidate.slug);
      if (!record) {
        const next = buildCandidateRecord(candidate, dataDir);
        register.projects.push(next);
        added.push(next);
        continue;
      }
      const next = { ...record };
      if (presenceKnown) {
        const derivedState = candidate.state;
        if (derivedState === 'open' || !['archived', 'parking'].includes(record.state)) next.state = derivedState;
      }
      if (candidate.lastActivityAt && candidate.lastActivityAt !== record.lastActivityAt) next.lastActivityAt = candidate.lastActivityAt;
      if (JSON.stringify(next) !== JSON.stringify(record)) {
        checkRecord(next);
        const index = register.projects.findIndex((entry) => entry.slug === record.slug);
        register.projects[index] = next;
        updated.push({ before: record, record: next });
      }
    }
    if (!dryRun && (added.length || updated.length)) {
      writeRegister(register, dataDir);
      for (const record of added) appendAudit(record.slug, 'register-add', dataDir);
      for (const { record } of updated) appendAudit(record.slug, 'register-import', dataDir);
    }
    for (const record of added) log(`new ${record.slug} (${record.state})`);
    for (const { record } of updated) log(`updated ${record.slug} (${record.state})`);
    log(`${added.length} new records.`);
    if (updated.length) log(`${updated.length} records updated.`);
    return { added: added.length, updated: updated.length, warning, invalidRepoSlugs };
  };
  return dryRun ? importRecords() : withRegisterLock(dataDir, importRecords);
}

// Parses the options of one register subcommand. Positional arguments come back in `positional`.
// A bad option carries the usage line of the subcommand.
export function parseFlags(args, { values = [], booleans = [], usage = '' } = {}) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!isText(token) || !token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const cut = token.indexOf('=');
    const name = cut === -1 ? token : token.slice(0, cut);
    if (booleans.includes(name)) {
      if (Object.hasOwn(flags, name)) throw recordError(`${name} may be used only once. ${usage}`);
      flags[name] = true;
      continue;
    }
    if (values.includes(name)) {
      let value;
      if (cut !== -1) {
        value = token.slice(cut + 1);
      } else {
        value = args[index + 1];
        if (value === undefined || value.startsWith('--')) throw recordError(`${name} needs a value. ${usage}`);
        index += 1;
      }
      if (Object.hasOwn(flags, name)) throw recordError(`${name} may be used only once. ${usage}`);
      flags[name] = value;
      continue;
    }
    throw recordError(`Unknown option: ${name}. ${usage}`);
  }
  return { flags, positional };
}
