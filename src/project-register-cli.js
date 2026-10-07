// The command line of `herdr-boss project register`: list, add, edit, sync, and import.
// A register subcommand needs the Owner or a pane labeled boss or orch. The check runs before the parse.
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { verifyMessageCaller } from './messages.js';
import { readProjectRepos, stripRemoteCredentials } from './harness.js';
import {
  SLUG,
  STATE,
  PRIORITY,
  EDIT_FIELDS,
  checkRecord,
  readRegister,
  writeRegister,
  appendAudit,
  normalizeRepoPath,
  withRegisterLock,
  localFactory,
  collectImportCandidates,
  buildCandidateRecord,
  parseFlags,
  remoteProblem,
} from './project-register.js';

const LIST_USAGE = 'Usage: project register list [--state open|parked|archived] [--group NAME] [--json]';
const ADD_USAGE = 'Usage: project register add SLUG [--title TEXT] [--group NAME] [--repo PATH] [--remote OWNER/REPO|URL] [--factory NAME] [--priority high|normal|low] [--next-action TEXT] [--notes TEXT] [--pinned on|off] [--auto-open on|off] [--issue-repo OWNER/REPO] [--issue-label TEXT] [--dry-run]';
const EDIT_USAGE = 'Usage: project register edit SLUG [--title TEXT] [--group NAME] [--repo PATH] [--remote OWNER/REPO|URL] [--factory NAME] [--priority high|normal|low] [--next-action TEXT] [--notes TEXT] [--pinned on|off] [--auto-open on|off] [--issue-repo OWNER/REPO] [--issue-label TEXT] [--issue-clear] [--dry-run]';
const IMPORT_USAGE = 'Usage: project register import [--dry-run]';
const SYNC_USAGE = 'Usage: project register sync [--dry-run]';

export const SUB_USAGE = {
  list: LIST_USAGE,
  add: ADD_USAGE,
  edit: EDIT_USAGE,
  import: IMPORT_USAGE,
  sync: SYNC_USAGE,
};

export const REGISTER_USAGE = [LIST_USAGE, ADD_USAGE, EDIT_USAGE, IMPORT_USAGE, SYNC_USAGE].join('\n');

const VALUE_FLAGS = ['--title', '--group', '--repo', '--remote', '--factory', '--priority', '--next-action', '--notes', '--pinned', '--auto-open', '--issue-repo', '--issue-label'];
const FLAG_FIELDS = {
  '--title': 'title',
  '--group': 'group',
  '--repo': 'repo',
  '--remote': 'remote',
  '--factory': 'factory',
  '--priority': 'priority',
  '--next-action': 'nextAction',
  '--notes': 'notes',
};
const ON_OFF = ['on', 'off'];
const SLUG_MESSAGE = 'The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters.';
const WORKER_SUFFIX = ' A worker does not message the Owner: ask your orchestrator with a WORKER QUESTION.';
const LEAD_SUFFIX = ' A worker runs no register command: ask its project lead.';

// A plain terminal is the Owner. A pane must be labeled boss or orch. A worker pane is refused
// with a message that names its project lead.
export function verifyRegisterCaller(env, herdr, command) {
  if (env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID) return { role: 'owner' };
  try {
    return verifyMessageCaller(env, herdr, command);
  } catch (error) {
    throw new Error(error.message.replace(WORKER_SUFFIX, LEAD_SUFFIX));
  }
}

function checkChoiceFlags(flags) {
  if (flags['--pinned'] !== undefined && !ON_OFF.includes(flags['--pinned'])) throw new Error('--pinned must be on or off.');
  if (flags['--auto-open'] !== undefined && !ON_OFF.includes(flags['--auto-open'])) throw new Error('--auto-open must be on or off.');
  if (flags['--priority'] !== undefined && !PRIORITY.includes(flags['--priority'])) throw new Error('--priority must be high, normal, or low.');
}

function checkIssueFlags(flags, { allowClear }) {
  if (allowClear && flags['--issue-clear'] && flags['--issue-repo'] !== undefined) {
    throw new Error('Give --issue-clear or the issue pair, not both.');
  }
  if ((flags['--issue-repo'] === undefined) !== (flags['--issue-label'] === undefined)) {
    throw new Error('Give --issue-repo and --issue-label together.');
  }
}

function bySlug(a, b) {
  return Buffer.compare(Buffer.from(a.slug), Buffer.from(b.slug));
}

function listCommand(rest, { dataDir, log }) {
  const usage = SUB_USAGE.list;
  const { flags, positional } = parseFlags(rest, { values: ['--state', '--group'], booleans: ['--json'], usage });
  const state = flags['--state'];
  if (state !== undefined && !STATE.includes(state)) throw new Error(`--state must be ${STATE.slice(0, -1).join(', ')}, or ${STATE.at(-1)}.`);
  if (positional.length > 0) throw new Error(`Give no other argument. ${usage}`);
  const register = readRegister(dataDir);
  const group = flags['--group'];
  const rows = register.projects
    .filter((entry) => (state === undefined || entry.state === state) && (group === undefined || entry.group === group))
    .sort(bySlug);
  if (flags['--json']) {
    log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    log('No projects in the register.');
    return 0;
  }
  for (const entry of rows) {
    log(`${entry.slug.padEnd(16)}${entry.state.padEnd(9)}${(entry.group || '-').padEnd(16)}${entry.title}`);
  }
  return 0;
}

function addCommand(rest, { dataDir, log }) {
  const usage = SUB_USAGE.add;
  const { flags, positional } = parseFlags(rest, { values: VALUE_FLAGS, booleans: ['--dry-run'], usage });
  if (positional.length !== 1) throw new Error(`Give exactly one slug. ${usage}`);
  const slug = positional[0];
  if (!SLUG.test(slug)) throw new Error(SLUG_MESSAGE);
  checkChoiceFlags(flags);
  checkIssueFlags(flags, { allowClear: false });
  const record = {
    slug,
    title: flags['--title'] ?? slug,
    group: flags['--group'] ?? '',
    repo: normalizeRepoPath(flags['--repo'] ?? ''),
    remote: flags['--remote'] ?? '',
    factory: flags['--factory'] ?? localFactory(dataDir),
    state: 'parked',
    pinned: flags['--pinned'] === 'on',
    priority: flags['--priority'] ?? 'normal',
    issueSource: flags['--issue-repo'] !== undefined
      ? { repo: flags['--issue-repo'], label: flags['--issue-label'] }
      : null,
    autoOpen: flags['--auto-open'] ?? 'off',
    lastOpenedAt: '',
    lastActivityAt: '',
    nextAction: flags['--next-action'] ?? '',
    notes: flags['--notes'] ?? '',
    createdAt: new Date().toISOString(),
  };
  checkRecord(record);
  const add = () => {
    const register = readRegister(dataDir);
    if (register.projects.some((entry) => entry.slug === slug)) throw new Error(`${slug} is already in the register.`);
    if (flags['--dry-run']) {
      log(`Dry run: would add ${slug} to the register.`);
      return 0;
    }
    register.projects.push(record);
    writeRegister(register, dataDir);
    appendAudit(slug, 'register-add', dataDir);
    log(`Added ${slug} to the register.`);
    return 0;
  };
  return flags['--dry-run'] ? add() : withRegisterLock(dataDir, add);
}

function editCommand(rest, { dataDir, log }) {
  const usage = SUB_USAGE.edit;
  const { flags, positional } = parseFlags(rest, { values: VALUE_FLAGS, booleans: ['--issue-clear', '--dry-run'], usage });
  if (positional.length !== 1) throw new Error(`Give exactly one slug. ${usage}`);
  const slug = positional[0];
  if (!SLUG.test(slug)) throw new Error(SLUG_MESSAGE);
  checkIssueFlags(flags, { allowClear: true });
  checkChoiceFlags(flags);
  const changes = {};
  for (const [flag, field] of Object.entries(FLAG_FIELDS)) {
    if (flags[flag] !== undefined) changes[field] = flags[flag];
  }
  if (flags['--pinned'] !== undefined) changes.pinned = flags['--pinned'] === 'on';
  if (flags['--auto-open'] !== undefined) changes.autoOpen = flags['--auto-open'];
  if (changes.repo !== undefined) changes.repo = normalizeRepoPath(changes.repo);
  if (flags['--issue-repo'] !== undefined) changes.issueSource = { repo: flags['--issue-repo'], label: flags['--issue-label'] };
  if (flags['--issue-clear']) changes.issueSource = null;
  if (Object.keys(changes).length === 0) throw new Error(`Give at least one field. ${usage}`);
  const edit = () => {
    const register = readRegister(dataDir);
    const index = register.projects.findIndex((entry) => entry.slug === slug);
    if (index === -1) throw new Error(`${slug} is not in the register.`);
    const before = register.projects[index];
    const merged = { ...before, ...changes };
    checkRecord(merged);
    const changed = EDIT_FIELDS.filter((field) => JSON.stringify(merged[field]) !== JSON.stringify(before[field]));
    if (changed.length === 0) {
      log(`No change for ${slug}.`);
      return 0;
    }
    if (flags['--dry-run']) {
      log(`Dry run: would edit ${slug}: ${changed.join(', ')}`);
      return 0;
    }
    register.projects[index] = merged;
    writeRegister(register, dataDir);
    appendAudit(slug, 'register-edit', dataDir);
    log(`Edited ${slug}: ${changed.join(', ')}`);
    return 0;
  };
  return flags['--dry-run'] ? edit() : withRegisterLock(dataDir, edit);
}

function syncCommand(rest, { dataDir, log }) {
  const usage = SUB_USAGE.sync;
  const { flags, positional } = parseFlags(rest, { booleans: ['--dry-run'], usage });
  if (positional.length > 0) throw new Error(`Give no other argument. ${usage}`);
  const sync = () => {
    const register = readRegister(dataDir);
    const known = new Map(register.projects.map((entry) => [entry.slug, entry]));
    const changed = [];
    for (const row of readProjectRepos(dataDir)) {
      const current = known.get(row.slug);
      if (!current) continue;
      const next = { ...current };
      const fields = [];
      const repo = normalizeRepoPath(row.repo);
      if (typeof repo === 'string' && repo !== '' && path.isAbsolute(repo) && repo !== current.repo) {
        next.repo = repo;
        fields.push('repo');
      }
      if (typeof row.remote === 'string') {
        const sourceRemote = row.remote.trim() === '' ? '' : stripRemoteCredentials(row.remote);
        const sourceRemoteIsSafe = (sourceRemote === '' && row.remote.trim() === '')
          || (sourceRemote !== '' && remoteProblem(sourceRemote) === null);
        if (sourceRemoteIsSafe && sourceRemote !== current.remote) {
          next.remote = sourceRemote;
          fields.push('remote');
        }
      }
      if (fields.length === 0) continue;
      checkRecord(next);
      changed.push({ slug: row.slug, record: next, fields });
    }
    if (changed.length > 0 && !flags['--dry-run']) {
      for (const entry of changed) {
        const index = register.projects.findIndex((record) => record.slug === entry.slug);
        register.projects[index] = entry.record;
      }
      writeRegister(register, dataDir);
      for (const entry of changed) appendAudit(entry.slug, 'register-edit', dataDir);
    }
    for (const entry of changed) log(`sync ${entry.slug}: ${entry.fields.join(', ')}`);
    log(`${changed.length} records changed.`);
    return 0;
  };
  return flags['--dry-run'] ? sync() : withRegisterLock(dataDir, sync);
}

function importCommand(rest, { dataDir, herdr, log }) {
  const usage = SUB_USAGE.import;
  const { flags, positional } = parseFlags(rest, { booleans: ['--dry-run'], usage });
  if (positional.length > 0) throw new Error(`Give no other argument. ${usage}`);
  const importRecords = () => {
    const register = readRegister(dataDir);
    const existing = new Set(register.projects.map((entry) => entry.slug));
    const { candidates, warning, invalidRepoSlugs } = collectImportCandidates({ dataDir, herdr });
    if (invalidRepoSlugs > 0) {
      console.error(`Warning: skipped ${invalidRepoSlugs} project-repos.json row${invalidRepoSlugs === 1 ? '' : 's'} with an invalid slug.`);
    }
    if (warning) console.error(warning);
    const records = [];
    for (const candidate of candidates) {
      if (existing.has(candidate.slug)) continue;
      records.push(buildCandidateRecord(candidate, dataDir));
    }
    if (records.length > 0 && !flags['--dry-run']) {
      register.projects.push(...records);
      writeRegister(register, dataDir);
      for (const record of records) appendAudit(record.slug, 'register-add', dataDir);
    }
    for (const record of records) log(`new ${record.slug} (${record.state})`);
    log(`${records.length} new records.`);
    return 0;
  };
  return flags['--dry-run'] ? importRecords() : withRegisterLock(dataDir, importRecords);
}

const COMMANDS = {
  list: listCommand,
  add: addCommand,
  edit: editCommand,
  sync: syncCommand,
  import: importCommand,
};

// Runs one `project register` subcommand and returns the exit code. An error throws.
// The caller check runs before the parse, and a bare or unknown subcommand gives the usage first.
export function projectRegisterCommand(args, { env = process.env, herdr, dataDir = DATA_DIR, log = console.log } = {}) {
  const [sub, ...rest] = args;
  if (!Object.hasOwn(SUB_USAGE, sub)) throw new Error(REGISTER_USAGE);
  verifyRegisterCaller(env, herdr, `project register ${sub}`);
  return COMMANDS[sub](rest, { dataDir, herdr, log });
}
