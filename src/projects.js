// Project status files written by orchestrators. See docs/project-status.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { readProjectRepos } from './harness.js';
import { installedKitRevision, kitRevision } from './kit/agents-check.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_STATUS = new Set(['todo', 'doing', 'review', 'blocked', 'done']);
const WAITING_ON = new Set(['owner', 'boss', 'task', 'external']);
const FRONTIER = new Set(['current', 'next']);
const WEB_URL = /^https?:\/\//i;
const KIT_REVISION = /^[0-9a-f]{12}$/;

export function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['body must be a JSON object'];
  if (typeof p.project !== 'string' || !p.project) errs.push('"project" (string) is required');
  if (Object.hasOwn(p, 'goal') && (typeof p.goal !== 'string' || !p.goal.trim() || p.goal.length > 1000)) errs.push('"goal" must be a non-empty string of at most 1000 characters');
  if (p.tasks != null && !Array.isArray(p.tasks)) errs.push('"tasks" must be an array');
  for (const [i, t] of (p.tasks || []).entries()) {
    if (!t || typeof t.title !== 'string') errs.push(`tasks[${i}].title (string) is required`);
    if (t && t.status && !TASK_STATUS.has(t.status)) errs.push(`tasks[${i}].status must be one of ${[...TASK_STATUS].join('|')}`);
  }
  for (const [i, t] of (p.tasks || []).entries()) {
    if (!t) continue;
    if (t.blockedBy != null && (!Array.isArray(t.blockedBy) || t.blockedBy.some((id) => typeof id !== 'string'))) errs.push(`tasks[${i}].blockedBy must be an array of task IDs (strings)`);
    if (t.labels != null && (!Array.isArray(t.labels) || t.labels.some((label) => typeof label !== 'string'))) errs.push(`tasks[${i}].labels must be an array of strings`);
    for (const key of ['id', 'parent', 'group', 'kind', 'url', 'assignee', 'updated', 'note', 'worker']) if (t[key] != null && typeof t[key] !== 'string') errs.push(`tasks[${i}].${key} must be a string`);
    if (t.frontier != null && !FRONTIER.has(t.frontier)) errs.push(`tasks[${i}].frontier must be current or next`);
    if (t.waitingOn != null && !WAITING_ON.has(t.waitingOn)) errs.push(`tasks[${i}].waitingOn must be one of ${[...WAITING_ON].join('|')}`);
    if (t.ask != null && (typeof t.ask !== 'string' || !t.ask.trim() || t.ask.length > 200)) errs.push(`tasks[${i}].ask must be a non-empty string of at most 200 characters`);
    if ((t.waitingOn === 'owner' || t.waitingOn === 'boss') && (typeof t.ask !== 'string' || !t.ask.trim() || t.ask.length > 200)) errs.push(`tasks[${i}].ask is required when waitingOn is ${t.waitingOn}`);
    if (t.mailboxId != null && typeof t.mailboxId !== 'string') errs.push(`tasks[${i}].mailboxId must be a string`);
    if ((t.status || 'todo') === 'done' && t.waitingOn != null) errs.push(`tasks[${i}] is done and must not have waitingOn`);
    if (t.url != null && !WEB_URL.test(t.url)) errs.push(`tasks[${i}].url must start with http:// or https://`);
  }
  const ids = (p.tasks || []).map((t) => t?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errs.push('task IDs must be unique');
  for (const k of ['metrics', 'links', 'notes', 'phases', 'groups', 'gates', 'risks']) if (p[k] != null && !Array.isArray(p[k])) errs.push(`"${k}" must be an array`);
  for (const [i, g] of (Array.isArray(p.groups) ? p.groups : []).entries()) {
    if (!g || typeof g.id !== 'string' || typeof g.title !== 'string') errs.push(`groups[${i}] needs id and title (strings)`);
    if (g?.held != null && typeof g.held !== 'boolean') errs.push(`groups[${i}].held must be true or false`);
    for (const [j, r] of (Array.isArray(g?.refs) ? g.refs : []).entries()) if (!r || typeof r.label !== 'string' || (r.url != null && !WEB_URL.test(r.url))) errs.push(`groups[${i}].refs[${j}] needs a label and an optional http(s) url`);
  }
  for (const [i, g] of (Array.isArray(p.gates) ? p.gates : []).entries()) if (!g || typeof g.title !== 'string') errs.push(`gates[${i}].title (string) is required`);
  for (const [i, r] of (Array.isArray(p.risks) ? p.risks : []).entries()) if (typeof r !== 'string') errs.push(`risks[${i}] must be a string`);
  for (const [i, l] of (Array.isArray(p.links) ? p.links : []).entries()) if (!l || typeof l.url !== 'string' || !WEB_URL.test(l.url)) errs.push(`links[${i}].url must start with http:// or https://`);
  if (p.agentsCheck != null) {
    const c = p.agentsCheck;
    if (typeof c !== 'object' || Array.isArray(c) || !Number.isInteger(c.errors) || c.errors < 0 || !Number.isInteger(c.warnings) || c.warnings < 0) errs.push('"agentsCheck" must be an object with errors and warnings (non-negative integers)');
  }
  for (const key of ['doneCount', 'doneCountBase']) if (p[key] != null && (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > DONE_COUNT_MAX)) errs.push(`"${key}" must be an integer from 0 to ${DONE_COUNT_MAX}`);
  if (p.doneIds != null && (!Array.isArray(p.doneIds) || p.doneIds.length > DONE_IDS_MAX || p.doneIds.some((id) => typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)))) errs.push(`"doneIds" must be an array of at most ${DONE_IDS_MAX} strings of 1 to 200 characters without control characters`);
  if (p.kitRevision != null && (typeof p.kitRevision !== 'string' || !KIT_REVISION.test(p.kitRevision))) errs.push('"kitRevision" must be the 12 hex characters of a kit revision');
  if (p.git != null && (typeof p.git !== 'object' || Array.isArray(p.git))) errs.push('"git" must be an object with branch, commit, and dirty');
  return errs;
}

export const DONE_KEEP = 30;
export const DONE_IDS_MAX = 5000;
export const DONE_COUNT_MAX = 1000000;
export const STATUS_WARN_BYTES = 200 * 1024;

// Keep the newest DONE_KEEP done tasks and remove the older ones from data.tasks. A done task that an
// open or kept task lists in blockedBy stays. The IDs of the removed tasks go into data.doneIds, so a
// republish of the same tasks does not count them again. An ID that is in data.tasks again leaves
// doneIds. doneCountBase holds counts that have no ID: an earlier doneCount and IDs dropped from a full doneIds. doneCount = doneIds.length + doneCountBase.
// stored is the status file that is installed now, or null. Returns the number of IDs added to doneIds.
export function capDoneTasks(data, stored = null, keep = DONE_KEEP) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return 0;
  // An invalid field is left for validateProject to report.
  if (validateProject({ project: 'x', doneCount: data.doneCount, doneCountBase: data.doneCountBase, doneIds: data.doneIds }).length) return 0;
  const sources = [data, stored && typeof stored === 'object' ? stored : {}].filter((source) => !validateProject({ project: 'x', doneCount: source.doneCount, doneCountBase: source.doneCountBase, doneIds: source.doneIds }).length);
  let base = Math.max(0, ...sources.map((source) => source.doneCountBase ?? (Array.isArray(source.doneIds) ? 0 : source.doneCount ?? 0)));
  const ids = [];
  for (const source of sources) for (const id of source.doneIds || []) if (!ids.includes(id)) ids.push(id);
  const isTask = (t) => t && typeof t === 'object';
  const isDone = (t) => isTask(t) && (t.status || 'todo') === 'done';
  const time = (t) => { const ms = Date.parse(t.updated); return Number.isFinite(ms) ? ms : -Infinity; };
  const doneIndexes = data.tasks.flatMap((t, i) => (isDone(t) ? [i] : []));
  const newest = new Set([...doneIndexes].sort((a, b) => (time(data.tasks[b]) - time(data.tasks[a])) || (b - a)).slice(0, keep));
  const stay = new Set(data.tasks.flatMap((t, i) => (!isDone(t) || newest.has(i) ? [i] : [])));
  const blockers = new Set();
  for (const i of stay) for (const id of Array.isArray(data.tasks[i]?.blockedBy) ? data.tasks[i].blockedBy : []) blockers.add(String(id));
  // A done task without a usable ID cannot be counted once, so it stays in the file.
  const trackable = (t) => t.id != null && String(t.id).length <= 200 && !/[\u0000-\u001f\u007f]/.test(String(t.id));
  const removedTasks = data.tasks.filter((t, i) => !stay.has(i) && trackable(t) && !blockers.has(String(t.id)));
  data.tasks = data.tasks.filter((t) => !removedTasks.includes(t));
  // A task that is in the file is counted by the file. This covers a task that is open again.
  const present = new Set(data.tasks.filter((t) => isTask(t) && t.id != null).map((t) => String(t.id)));
  const kept = ids.filter((id) => !present.has(id));
  let added = 0;
  for (const t of removedTasks) {
    const id = String(t.id);
    if (!kept.includes(id)) { kept.push(id); added += 1; }
  }
  if (kept.length > DONE_IDS_MAX) base += kept.splice(0, kept.length - DONE_IDS_MAX).length;
  delete data.doneIds; delete data.doneCountBase; delete data.doneCount;
  if (kept.length) data.doneIds = kept;
  if (base > 0) data.doneCountBase = base;
  if (kept.length + base > 0) data.doneCount = kept.length + base;
  return added;
}

export function statusWarnings(p) {
  const warnings = [];
  if (!p || typeof p !== 'object' || !Array.isArray(p.tasks)) return warnings;
  for (const t of p.tasks) {
    if (!t || typeof t !== 'object') continue;
    const id = t.id || t.title || '?';
    if (t.status === 'blocked' && !(Array.isArray(t.blockedBy) && t.blockedBy.length) && t.waitingOn == null) {
      warnings.push(`task ${id} is blocked but names no blocker. Set blockedBy or waitingOn.`);
    }
    if (t.waitingOn === 'owner' && !t.mailboxId) {
      warnings.push(`task ${id} waits on the Owner but has no Mailbox item. Post one with herdr-boss mail post and set mailboxId.`);
    }
  }
  return warnings;
}

// Show the home folder as ~ in a displayed path. Keep another absolute path as it is.
function tildePath(value, home) {
  if (!value) return null;
  if (value === home) return '~';
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

export function listProjects() {
  // currentKitRevision and installedKitRevision are not part of the status file. The project page compares them with kitRevision.
  const currentKitRevision = kitRevision();
  const home = os.homedir();
  const repos = readProjectRepos();
  let files = [];
  try { files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => {
    const slug = f.slice(0, -5);
    const file = path.join(PROJECTS_DIR, f);
    const registered = repos.find((row) => row.slug === slug)?.repo;
    const repo = tildePath(registered, home);
    // The disk copy of the kit file in the registered repository. null when there is no repository or no kit file.
    const installedKit = registered ? installedKitRevision(registered) : null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const errors = validateProject(data);
      const publishedAt = data.updated || fs.statSync(file).mtime.toISOString();
      return { slug, ...data, currentKitRevision, installedKitRevision: installedKit, repo, updated: publishedAt, publishedAt, errors: errors.length ? errors : undefined };
    } catch (e) {
      return { slug, project: slug, currentKitRevision, installedKitRevision: installedKit, repo, errors: [`invalid JSON: ${e.message}`] };
    }
  }).sort((a, b) => a.project.localeCompare(b.project));
}

// dir: the projects folder. The default is the projects folder of the data dir.
export function writeProject(slug, data, { dir = PROJECTS_DIR } = {}) {
  if (!SLUG.test(slug)) return ['slug must match [a-z0-9][a-z0-9-]*'];
  const errs = validateProject(data);
  if (errs.length) return errs;
  data.updated = new Date().toISOString();
  const file = path.join(dir, `${slug}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return [];
}
