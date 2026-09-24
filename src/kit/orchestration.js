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

function tiers(value, errors, allowedTiers) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) errors.push('evidenceTier must not be empty.');
  list.forEach((tier, index) => {
    if (!allowedTiers.includes(tier)) errors.push(`evidenceTier[${index}] is unknown: ${String(tier)}. Allowed tiers: ${allowedTiers.join(', ') || '(none)'}. Set the project's tiers in evidenceTiers in .herdr-boss.json at the repository root.`);
  });
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

export function gitLog(worktree, base) {
  return execFileSync('git', ['-C', worktree, 'log', '--oneline', '--decorate', `${base}..HEAD`], { encoding: 'utf8' }).trim();
}
