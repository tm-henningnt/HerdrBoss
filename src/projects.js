// Project status files written by orchestrators. See docs/project-status.md.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { kitRevision } from './kit/agents-check.js';

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
  if (p.kitRevision != null && (typeof p.kitRevision !== 'string' || !KIT_REVISION.test(p.kitRevision))) errs.push('"kitRevision" must be the 12 hex characters of a kit revision');
  if (p.git != null && (typeof p.git !== 'object' || Array.isArray(p.git))) errs.push('"git" must be an object with branch, commit, and dirty');
  return errs;
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

export function listProjects() {
  // currentKitRevision is not part of the status file. The project page compares it with kitRevision.
  const currentKitRevision = kitRevision();
  let files = [];
  try { files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => {
    const slug = f.slice(0, -5);
    const file = path.join(PROJECTS_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const errors = validateProject(data);
      return { slug, ...data, currentKitRevision, updated: data.updated || fs.statSync(file).mtime.toISOString(), errors: errors.length ? errors : undefined };
    } catch (e) {
      return { slug, project: slug, currentKitRevision, errors: [`invalid JSON: ${e.message}`] };
    }
  }).sort((a, b) => a.project.localeCompare(b.project));
}

export function writeProject(slug, data) {
  if (!SLUG.test(slug)) return ['slug must match [a-z0-9][a-z0-9-]*'];
  const errs = validateProject(data);
  if (errs.length) return errs;
  data.updated = new Date().toISOString();
  const file = path.join(PROJECTS_DIR, `${slug}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return [];
}
