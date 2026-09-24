// Project status files written by orchestrators. See docs/project-status.md.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_STATUS = new Set(['todo', 'doing', 'review', 'blocked', 'done']);

export function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['body must be a JSON object'];
  if (typeof p.project !== 'string' || !p.project) errs.push('"project" (string) is required');
  if (p.tasks != null && !Array.isArray(p.tasks)) errs.push('"tasks" must be an array');
  for (const [i, t] of (p.tasks || []).entries()) {
    if (!t || typeof t.title !== 'string') errs.push(`tasks[${i}].title (string) is required`);
    if (t && t.status && !TASK_STATUS.has(t.status)) errs.push(`tasks[${i}].status must be one of ${[...TASK_STATUS].join('|')}`);
  }
  for (const k of ['metrics', 'links', 'notes', 'phases']) if (p[k] != null && !Array.isArray(p[k])) errs.push(`"${k}" must be an array`);
  return errs;
}

export function listProjects() {
  let files = [];
  try { files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => {
    const slug = f.slice(0, -5);
    const file = path.join(PROJECTS_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const errors = validateProject(data);
      return { slug, ...data, updated: data.updated || fs.statSync(file).mtime.toISOString(), errors: errors.length ? errors : undefined };
    } catch (e) {
      return { slug, project: slug, errors: [`invalid JSON: ${e.message}`] };
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
