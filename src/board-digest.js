// Divergence digest. A project diverges when cards differ from git (src/board-facts.js). The orchestrator gets one
// line after 30 minutes and then at most once each hour. The Boss gets one notice after 3 hours.
export const DIVERGE_AFTER_MS = 30 * 60000;
export const DIVERGE_EVERY_MS = 60 * 60000;
export const DIVERGE_BOSS_AFTER_MS = 3 * 3600000;
const MAX_IDS = 10;

const clean = (id) => String(id).replace(/[\u0000-\u001f\u007f]/g, " ");
const idList = (all) => { const ids = all.map(clean); return (ids.length > MAX_IDS ? `${ids.slice(0, MAX_IDS).join(', ')} and ${ids.length - MAX_IDS} more` : ids.join(', ')); };
const cards = (count) => `${count} ${count === 1 ? 'card differs' : 'cards differ'}`;

export const isBoardDigest = (alert) => typeof alert?.key === 'string' && alert.key.startsWith('board:diverge:');

// tracker maps a project slug to { since }, the time when the project was first seen with a divergence. The caller
// keeps it in memory. A project without a divergence, and a held project, leave the tracker. held(slug) is true
// for a paused or stood-down project.
export function boardDigestAlerts({ projects, tracker, now, held = () => false }) {
  const alerts = [];
  const seen = new Set();
  for (const project of projects || []) {
    if (!project?.slug || held(project.slug)) continue;
    const ids = Array.isArray(project.boardDivergedIds) ? project.boardDivergedIds : [];
    const count = Number.isFinite(project.boardDiverged) ? project.boardDiverged : ids.length;
    if (!(count > 0)) continue;
    seen.add(project.slug);
    const since = tracker[project.slug]?.since;
    if (!Number.isFinite(since)) { tracker[project.slug] = { since: now }; continue; }
    const age = now - since;
    if (age > DIVERGE_AFTER_MS && project.workspace) {
      alerts.push({
        key: `board:diverge:${project.slug}`, severity: 'warn', scope: project.workspace, repeatMs: DIVERGE_EVERY_MS, noDesktop: true,
        project: project.slug, title: 'Board differs from git',
        text: `${cards(count)} from git: ${idList(ids)}. Publish the status with --sync.`,
      });
    }
    if (age >= DIVERGE_BOSS_AFTER_MS) {
      alerts.push({
        key: `board:diverge-boss:${project.slug}:${since}`, severity: 'warn', scope: 'boss', once: true, noDesktop: true,
        project: project.slug, title: 'Board differs from git',
        text: `${project.slug}: ${cards(count)} from git for 3 hours: ${idList(ids)}. The orchestrator has not published the status.`,
      });
    }
  }
  for (const slug of Object.keys(tracker)) if (!seen.has(slug)) delete tracker[slug];
  return alerts;
}
