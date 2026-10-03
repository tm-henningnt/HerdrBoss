// Select each field explicitly. Never forward a snapshot, message, or alert object.
import { fleetQuotas } from './fleet-quotas.js';
import { assertFleetSummary } from './fleet-contract.js';

// Same pattern and length as $defs/slug in common.v1.schema.json.
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const isSlug = (value) => typeof value === 'string' && value.length <= 64 && SLUG.test(value);
const KIT = /^[a-f0-9]{12,64}$/;
const number = (value, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const integer = (value, max) => number(value, max) === null ? null : Math.floor(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const states = ['ready', 'doing', 'review', 'blocked', 'done', 'paused', 'transferred', 'unknown'];
const slug = (value, fallback = 'unknown') => isSlug(value) ? value : fallback;
export function buildFleetSummary({ settings, state = {}, health, ownerItems = [], reviewPacks = [], spend = [], now = Date.now() }) {
  const machine = state.machine || {};
  const kitRevision = KIT.test(health.kitRevision) ? health.kitRevision : state.kit?.current;
  const projects = (state.projects || []).filter((project) => isSlug(project.slug)).map((project) => {
    const tasks = project.tasks || [];
    const taskState = (task) => task.state || task.status;
    const completion = (task) => task.source?.kind === 'commit' ? task.source.at : task.updated;
    const updated = Date.parse(project.publishedAt ?? project.updated ?? project.updatedAt);
    const publishedState = project.computedState || project.state;
    const taskStates = tasks.map(taskState);
    const status = states.includes(publishedState) ? publishedState : taskStates.includes('blocked') ? 'blocked' : taskStates.includes('review') ? 'review' : taskStates.includes('doing') ? 'doing' : tasks.length && taskStates.every((state) => state === 'done') ? 'done' : tasks.length ? 'ready' : 'unknown';
    const phase = typeof project.phase === 'string' ? project.phase.toLowerCase().replace(/\s+/g, '-') : null;
    return { slug: project.slug, phase: slug(phase), status,
      statusAgeSeconds: integer(project.statusAgeSeconds, Number.MAX_SAFE_INTEGER) ?? (Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 1000)) : null),
      kitRevision: KIT.test(project.kitRevision) ? project.kitRevision : kitRevision,
      board: { doing: tasks.filter((task) => taskState(task) === 'doing').length, review: tasks.filter((task) => taskState(task) === 'review').length,
        blocked: tasks.filter((task) => taskState(task) === 'blocked').length,
        done7d: tasks.filter((task) => taskState(task) === 'done' && Date.parse(completion(task)) >= now - 7 * 86400000).length } };
  });
  const rows = ownerItems.filter((item) => isSlug(item.id) && ['decide', 'approve', 'answer'].includes(item.action) && !item.closedAt).map((item) => ({
    id: item.id, kind: item.action,
    ...(settings.shareItemTitles && typeof item.title === 'string' && item.title.trim() ? { title: [...item.title.trim()].slice(0, 160).join('') } : {}),
  }));
  const publicCodes = [['machine:', 'machine-pressure'], ['quota:', 'quota-warning'], ['browser:', 'browser-health'], ['stale:', 'status-stale'], ['worker:', 'worker-attention'], ['handoff:', 'handover-attention']];
  const alerts = (state.alerts || []).map((alert) => ({
    code: publicCodes.find(([prefix]) => typeof alert.key === 'string' && alert.key.startsWith(prefix))?.[1] || 'factory-alert',
    severity: ['critical', 'error'].includes(alert.severity) ? 'error' : alert.severity === 'info' ? 'info' : 'warning',
    ...(projects.some((project) => project.slug === alert.projectSlug) ? { projectSlug: alert.projectSlug } : {}),
  }));
  alerts.push(...projects.filter((project) => project.status === 'blocked').map((project) => ({ code: 'project-blocked', severity: 'warning', projectSlug: project.slug })));
  const tickAgeSeconds = health.tickAgeSeconds ?? null;
  return assertFleetSummary({ schema: 1, contractVersion: '1.0.0', factoryId: settings.factoryId, name: settings.name,
    version: health.version, kitRevision, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), dashboardUrl: settings.dashboardUrl,
    health: { status: health.herdrReachable === false || tickAgeSeconds > 90 ? 'degraded' : health.herdrReachable === true && tickAgeSeconds !== null ? 'healthy' : 'unknown',
      tickAgeSeconds, herdrReachable: health.herdrReachable ?? null, clockOffsetSeconds: health.clockOffsetSeconds ?? null },
    machine: { load1: number(machine.load?.[0]), load5: number(machine.load?.[1]), load15: number(machine.load?.[2]),
      cpus: Number.isInteger(machine.cpus) && machine.cpus > 0 ? machine.cpus : null,
      memoryTotalMb: number(machine.memTotalGB) === null ? null : machine.memTotalGB * 1024,
      memoryFreePercent: number(machine.memFreePercent, 100), swapUsedMb: number(machine.swapUsedMB) },
    projects, quotas: fleetQuotas(state.quotas, settings.accounts, settings.factoryId), spend,
    alerts,
    shareItemTitles: settings.shareItemTitles, ownerItems: { total: count(ownerItems.length), needsOwner: rows.length, rows },
    reviewPacks: reviewPacks.filter((pack) => isSlug(pack.id)).map((pack) => ({ id: pack.id, waitingItems: count(pack.waitingItems) })),
  });
}
export function fleetSpend(summary) {
  return (summary.days || []).flatMap((day) => day.roles.filter((row) => ['boss', 'orchestrator', 'worker'].includes(row.role)).flatMap((row) => Object.entries(row.harnesses || {}).map(([harness, entry]) => ({ day: day.day, role: row.role, harness, usd: entry.unpricedTokens > 0 ? null : number(entry.costUsd) }))));
}
