import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isText(value) { return typeof value === 'string' && value.trim().length > 0; }

function stringList(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`);
    return;
  }
  value.forEach((item, index) => {
    if (!isText(item)) errors.push(`${field}[${index}] must be a non-empty string.`);
  });
}

function relativePath(value, field, errors) {
  if (!isText(value)) {
    errors.push(`${field} must be a non-empty repository-relative path.`);
    return;
  }
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) errors.push(`${field} must stay inside the repository: ${value}.`);
}

export function validateAllowedPaths(allowedPaths) {
  const errors = [];
  if (!Array.isArray(allowedPaths)) return ['allowed paths must be an array of repository-relative paths.'];
  allowedPaths.forEach((item, index) => relativePath(item, `allowedPaths[${index}]`, errors));
  return errors;
}

// A worker may never own the .worker directory: it holds briefs and reports, not product files.
// macOS volumes are case-insensitive, so .worker, .WORKER, and .Worker all address it.
function scopeRelativePath(value, field, errors) {
  const before = errors.length;
  relativePath(value, field, errors);
  if (errors.length !== before) return;
  const first = normalize(value).replace(/^\.\/+/, '').split('/')[0];
  if (first.toLowerCase() === '.worker') errors.push(`${field} must not be inside .worker: ${value}.`);
}

// Shared scope rules for `worker allow` paths and their ledger history items.
export function validateScopePaths(paths, { field = 'paths' } = {}) {
  const errors = [];
  if (!Array.isArray(paths) || paths.length === 0) return [`${field} must be a non-empty array of repository-relative paths.`];
  paths.forEach((item, index) => scopeRelativePath(item, `${field}[${index}]`, errors));
  return errors;
}

function scopeExtensions(value, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { errors.push('scopeExtensions must be an array.'); return; }
  value.forEach((entry, index) => {
    const label = `scopeExtensions[${index}]`;
    if (!isObject(entry)) { errors.push(`${label} must be an object.`); return; }
    errors.push(...validateScopePaths(entry.paths, { field: `${label}.paths` }));
    if (!isText(entry.reason)) errors.push(`${label}.reason must be a non-empty string.`);
    if (!isText(entry.at) || !Number.isFinite(Date.parse(entry.at))) errors.push(`${label}.at must be a timestamp string.`);
    if (!isText(entry.by)) errors.push(`${label}.by must be a non-empty caller pane.`);
  });
}

function tiers(value, errors, allowedTiers) {
  const list = Array.isArray(value) ? value : [value];
  let needsAllowedTiers = false;
  if (!list.length) {
    errors.push('evidenceTier must not be empty.');
    needsAllowedTiers = true;
  }
  list.forEach((tier, index) => {
    if (!allowedTiers.includes(tier)) {
      errors.push(`evidenceTier[${index}] is unknown: ${String(tier)}.`);
      needsAllowedTiers = true;
    }
  });
  if (needsAllowedTiers) {
    const accepted = allowedTiers.length
      ? `Accepted evidence tiers:\n${allowedTiers.map((tier) => `- The ${JSON.stringify(tier)} tier is accepted.`).join('\n')}`
      : 'No evidence tiers are configured.';
    errors.push(accepted);
    errors.push("Set the project's tiers in evidenceTiers in .herdr-boss.json at the repository root.");
  }
}

// A worker can write the issue as a numeric string ("204" or "#204"). Turn it into the number and return a
// warning. Any other value stays, so the validator still refuses it.
export function normalizeWorkerReport(report) {
  const warnings = [];
  if (isObject(report) && typeof report.issue === 'string') {
    if (report.issue.trim().toLowerCase() === 'none') {
      warnings.push(`Warning: the report issue is the string ${JSON.stringify(report.issue)}; it is read as null. Write issue as null.`);
      return { report: { ...report, issue: null }, warnings };
    }
    const match = /^#?\s*([1-9][0-9]*)$/.exec(report.issue.trim());
    if (match) {
      warnings.push(`Warning: the report issue is the string ${JSON.stringify(report.issue)}; it is read as the number ${Number(match[1])}. Write issue as a number.`);
      return { report: { ...report, issue: Number(match[1]) }, warnings };
    }
  }
  return { report, warnings };
}

export function validateWorkerReport(report, { evidenceTiers = [] } = {}) {
  const errors = [];
  if (!isObject(report)) return ['record must be a JSON object.'];
  const required = ['issue', 'branch', 'worktree', 'changedPaths', 'commands', 'evidenceTier', 'unverified', 'stoppedEarly'];
  for (const field of required) if (!(field in report)) errors.push(`missing required field: ${field}.`);
  if (report.issue !== null && (!Number.isInteger(report.issue) || report.issue <= 0)) errors.push('issue must be null or a positive integer.');
  for (const field of ['branch', 'worktree']) if (!isText(report[field])) errors.push(`${field} must be a non-empty string.`);
  stringList(report.changedPaths, 'changedPaths', errors);
  if (Array.isArray(report.changedPaths)) report.changedPaths.forEach((item, index) => relativePath(item, `changedPaths[${index}]`, errors));
  if (!Array.isArray(report.commands) || report.commands.length === 0) errors.push('commands must be a non-empty array.');
  else report.commands.forEach((command, index) => {
    const text = typeof command === 'string' ? command : command?.command;
    if (!isText(text)) errors.push(`commands[${index}] needs a command string.`);
  });
  tiers(report.evidenceTier, errors, evidenceTiers);
  stringList(report.unverified, 'unverified', errors);
  if (typeof report.stoppedEarly !== 'boolean') errors.push('stoppedEarly must be boolean.');
  if (report.modelOutcome != null) {
    const outcome = report.modelOutcome;
    if (!isObject(outcome)) errors.push('modelOutcome must be null or an object.');
    else {
      for (const field of ['kind', 'model']) if (!isText(outcome[field])) errors.push(`modelOutcome.${field} must be a non-empty string.`);
      if (!['first-time', 'rework', 'failed'].includes(outcome.result)) errors.push('modelOutcome.result must be first-time, rework, or failed.');
      if (typeof outcome.reason !== 'string') errors.push('modelOutcome.reason must be a string.');
      else if (outcome.reason.length > 200) errors.push('modelOutcome.reason must be at most 200 characters.');
    }
  }
  // toolSuggestion is optional: null, or what was missing in the herdr-boss tools, why, and the smallest command that would help.
  if (report.toolSuggestion != null) {
    const suggestion = report.toolSuggestion;
    if (!isObject(suggestion)) errors.push('toolSuggestion must be null or an object with missing, why, and command.');
    else for (const field of ['missing', 'why', 'command']) if (!isText(suggestion[field])) errors.push(`toolSuggestion.${field} must be a non-empty string.`);
  }
  return errors;
}

export function validateDelegatedRun(run, { evidenceTiers = [] } = {}) {
  const errors = [];
  if (!isObject(run)) return ['record must be a JSON object.'];
  const required = ['issue', 'model', 'surface', 'worktree', 'startedAt', 'endedAt', 'outcome', 'timedOut', 'toolCalls', 'changedPaths', 'independentGate', 'defectsFound', 'rework', 'evidenceTier'];
  for (const field of required) if (!(field in run)) errors.push(`missing required field: ${field}.`);
  if (run.issue !== null && (!Number.isInteger(run.issue) || run.issue <= 0)) errors.push('issue must be null or a positive integer.');
  for (const field of ['model', 'surface', 'worktree', 'startedAt', 'outcome']) if (!isText(run[field])) errors.push(`${field} must be a non-empty string.`);
  if (run.endedAt !== null && !isText(run.endedAt)) errors.push('endedAt must be a timestamp string or null.');
  if (typeof run.timedOut !== 'boolean') errors.push('timedOut must be boolean.');
  if (run.toolCalls !== null && (!Number.isInteger(run.toolCalls) || run.toolCalls < 0)) errors.push('toolCalls must be null (unknown) or a non-negative integer.');
  stringList(run.changedPaths, 'changedPaths', errors);
  if (Array.isArray(run.changedPaths)) run.changedPaths.forEach((item, index) => relativePath(item, `changedPaths[${index}]`, errors));
  for (const field of ['defectsFound', 'rework']) stringList(run[field], field, errors);
  if (!isObject(run.independentGate) || typeof run.independentGate.passed !== 'boolean') errors.push('independentGate must be an object with boolean passed.');
  tiers(run.evidenceTier, errors, evidenceTiers);
  scopeExtensions(run.scopeExtensions, errors);
  return errors;
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Could not read JSON ${file}: ${error.message}`); }
}

export function appendDelegatedRun(file, run, options) {
  const errors = validateDelegatedRun(run, options);
  if (errors.length) throw new Error(`Invalid delegated run:\n- ${errors.join('\n- ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(run)}\n`, 'utf8');
}

export function readDelegatedRuns(file, options) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let run;
    try { run = JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL entry ${index + 1} in ${file}: ${error.message}`); }
    const errors = validateDelegatedRun(run, options);
    if (errors.length) throw new Error(`Invalid delegated run entry ${index + 1}: ${errors.join(' ')}`);
    return run;
  });
}

function normalize(value) { return value.replaceAll('\\', '/').replace(/^\.\//, ''); }
function pathAllowed(item, allowed) {
  const candidate = normalize(item);
  return allowed.some((pattern) => {
    const rule = normalize(pattern);
    if (!rule || rule === '.') return true;
    if (rule.includes('*') || rule.includes('?')) {
      let expression = '';
      for (let index = 0; index < rule.length; index += 1) {
        const char = rule[index];
        if (char === '*' && rule[index + 1] === '*') { expression += '.*'; index += 1; }
        else if (char === '*') expression += '[^/]*';
        else if (char === '?') expression += '[^/]';
        else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
      }
      return new RegExp(`^${expression}$`).test(candidate);
    }
    return candidate === rule.replace(/\/$/, '') || candidate.startsWith(rule.endsWith('/') ? rule : `${rule}/`);
  });
}

export function compareChangedPaths(actualPaths, allowedPaths) {
  return actualPaths.filter((item) => !pathAllowed(item, allowedPaths));
}

export function gitStatusPaths(worktree) {
  const source = execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' });
  const entries = source.split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const item = entry.slice(3);
    paths.push(item);
    if (status.includes('R') || status.includes('C')) {
      const destination = entries[++i];
      if (destination) paths.push(destination);
    }
  }
  return paths;
}

export function gitChangedPaths(worktree, base) {
  const committed = execFileSync('git', ['-C', worktree, 'diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  return [...new Set([...committed, ...gitStatusPaths(worktree)])];
}

// True when the working tree of `item` has the same content as `ref`. A missing ref or a Git error counts as a difference, so the path stays visible.
function pathMatchesRef(worktree, ref, item) {
  try {
    execFileSync('git', ['-C', worktree, 'diff', '--quiet', ref, '--', item], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// The worker's own changes: the non-merge commits on the first-parent line, plus the working tree.
// A worker that merges the base branch brings the base commits in as later parents, so the first-parent walk skips them.
// A merge resolution is the worker's own change; keep it only when it differs from the base branch.
export function gitWorkerChangedPaths(worktree, base, baseBranch = base) {
  const ownCommitted = execFileSync('git', ['-C', worktree, 'log', '--no-merges', '--first-parent', '--no-renames', '--name-only', '-z', '--format=', `${base}..HEAD`], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const own = new Set([...ownCommitted, ...gitStatusPaths(worktree)]);
  const mergedIn = gitChangedPaths(worktree, base).filter((item) => !own.has(item) && !pathMatchesRef(worktree, baseBranch, item));
  return [...new Set([...own, ...mergedIn])];
}

export function gitLog(worktree, base) {
  return execFileSync('git', ['-C', worktree, 'log', '--oneline', '--decorate', `${base}..HEAD`], { encoding: 'utf8' }).trim();
}
