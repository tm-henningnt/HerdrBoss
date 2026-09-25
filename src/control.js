import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'policy.json');
export const POLICY_DEFAULTS = {
  maxWorkers: 8,
  borrowIdle: true,
  idleMinutes: 15,
  reservePercent: 15,
  handoffLeadMinutes: 180,
  autoHandover: false,
  autoHandoverPercent: 98,
  orchestratorLadder: [
    { kind: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    { kind: 'claude', model: 'claude-opus-5-5', effort: null },
    { kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash', effort: null },
  ],
  allowedKinds: ['codex', 'claude', 'opencode', 'pi'],
  excludedModels: [],
  providerModes: { codex: 'managed', claude: 'managed', opencodego: 'managed' },
  preferredModels: {},
  modelProviders: {},
  projects: {},
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS = new Set(POLICY_DEFAULTS.allowedKinds);
const PROVIDERS = new Set(Object.keys(POLICY_DEFAULTS.providerModes));

export function loadPolicy() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ...POLICY_DEFAULTS, ...saved, providerModes: { ...POLICY_DEFAULTS.providerModes, ...saved.providerModes }, preferredModels: saved.preferredModels || {}, modelProviders: saved.modelProviders || {}, projects: saved.projects || {} };
}

function subset(value, set, field, errors) {
  if (!Array.isArray(value) || value.some((x) => !set.has(x)) || new Set(value).size !== value.length) errors.push(`${field} must be a list of unique allowed values.`);
}

export function validatePolicy(value, models) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['policy must be an object.'];
  if (!Number.isInteger(value.maxWorkers) || value.maxWorkers < 1 || value.maxWorkers > 64) errors.push('maxWorkers must be an integer from 1 to 64.');
  if (typeof value.borrowIdle !== 'boolean') errors.push('borrowIdle must be boolean.');
  if (typeof value.autoHandover !== 'boolean') errors.push('autoHandover must be boolean.');
  if (!Number.isInteger(value.autoHandoverPercent) || value.autoHandoverPercent < 90 || value.autoHandoverPercent > 100) errors.push('autoHandoverPercent must be an integer from 90 to 100.');
  for (const [key, max] of [['idleMinutes', 1440], ['reservePercent', 80], ['handoffLeadMinutes', 10080]]) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) errors.push(`${key} must be an integer from 0 to ${max}.`);
  }
  subset(value.allowedKinds, KINDS, 'allowedKinds', errors);
  const allModels = new Set(Object.values(models.kinds).flatMap((k) => k.allowedModels));
  if (!value.preferredModels || typeof value.preferredModels !== 'object' || Array.isArray(value.preferredModels)) errors.push('preferredModels must be an object.');
  else for (const [kind, model] of Object.entries(value.preferredModels)) if (!models.kinds[kind]?.allowedModels.includes(model)) errors.push(`Invalid preferredModels choice for ${kind}.`);
  if (!value.modelProviders || typeof value.modelProviders !== 'object' || Array.isArray(value.modelProviders)) errors.push('modelProviders must be an object.');
  else for (const [model, provider] of Object.entries(value.modelProviders)) if (!allModels.has(model) || (provider !== null && !PROVIDERS.has(provider))) errors.push(`Invalid modelProviders route for ${model}.`);
  subset(value.excludedModels, allModels, 'excludedModels', errors);
  if (!Array.isArray(value.orchestratorLadder) || !value.orchestratorLadder.length || value.orchestratorLadder.length > 20) errors.push('orchestratorLadder must contain 1 to 20 choices.');
  else {
    const seen = new Set();
    for (const [index, rung] of value.orchestratorLadder.entries()) {
      const cfg = models.kinds[rung?.kind];
      if (!cfg?.allowedModels.includes(rung?.model) || (rung?.effort != null && !cfg.allowedEfforts.includes(rung.effort)) || (!cfg.allowedEfforts.length && rung?.effort != null)) errors.push(`Invalid orchestrator choice at rank ${index + 1}.`);
      const key = `${rung?.kind}:${rung?.model}:${rung?.effort || ''}`;
      if (seen.has(key)) errors.push(`Duplicate orchestrator choice at rank ${index + 1}.`);
      seen.add(key);
    }
  }
  if (!value.providerModes || typeof value.providerModes !== 'object' || Array.isArray(value.providerModes)) errors.push('providerModes must be an object.');
  else for (const [provider, mode] of Object.entries(value.providerModes)) if (!PROVIDERS.has(provider) || !['managed', 'ignore'].includes(mode)) errors.push(`invalid provider mode: ${provider}.`);
  if (!value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) errors.push('projects must be an object.');
  else for (const [slug, project] of Object.entries(value.projects)) {
    if (!SLUG.test(slug) || !project || typeof project !== 'object' || Array.isArray(project)) { errors.push(`invalid project: ${slug}.`); continue; }
    if (!Number.isInteger(project.share) || project.share < 0 || project.share > 100) errors.push(`${slug}.share must be 0..100.`);
    if (!['auto', 'active', 'idle', 'paused'].includes(project.mode)) errors.push(`${slug}.mode must be auto, active, idle, or paused.`);
    subset(project.excludedKinds, KINDS, `${slug}.excludedKinds`, errors);
    subset(project.excludedModels, allModels, `${slug}.excludedModels`, errors);
    if (Array.isArray(project.excludedKinds) && project.excludedKinds.some((kind) => !value.allowedKinds?.includes(kind))) errors.push(`${slug}.excludedKinds may only list globally available kinds.`);
    if (Array.isArray(project.excludedModels) && project.excludedModels.some((model) => value.excludedModels?.includes(model) || !value.allowedKinds?.some((kind) => models.kinds[kind]?.allowedModels.includes(model)))) errors.push(`${slug}.excludedModels may only list globally available models.`);
  }
  const total = Object.values(value.projects || {}).reduce((sum, p) => sum + (Number.isInteger(p?.share) ? p.share : 0), 0);
  if (total > 100) errors.push('Project shares must total at most 100%.');
  return errors;
}

export function savePolicy(value, models) {
  const merged = { ...POLICY_DEFAULTS, ...value, providerModes: { ...POLICY_DEFAULTS.providerModes, ...value.providerModes } };
  const errors = validatePolicy(merged, models);
  if (errors.length) return errors;
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return [];
}

export function providerFor(kind, model, policy = null) {
  if (model && policy?.modelProviders && Object.hasOwn(policy.modelProviders, model)) return policy.modelProviders[model];
  if (kind === 'codex' || kind === 'claude') return kind;
  if (model?.startsWith('opencode-go/')) return 'opencodego';
  return null; // free or unmeasured lane
}

export function selectModel(kind, explicitModel, models, policy = null) {
  return explicitModel ?? policy?.preferredModels?.[kind] ?? models.kinds[kind]?.defaultModel;
}

export function pickSuccessor(project, currentKind, currentProvider, policy, control) {
  for (const rung of policy.orchestratorLadder || []) {
    const provider = providerFor(rung.kind, rung.model, policy);
    if (rung.kind === currentKind || (currentProvider && provider === currentProvider) ||
        !control.globalAllowed[rung.kind]?.includes(rung.model) ||
        project.excludedKinds.includes(rung.kind) || project.excludedModels.includes(rung.model) ||
        (provider && control.risks[provider])) continue;
    return { ...rung, provider: provider || 'unmetered' };
  }
  return null;
}

export function workspaceProjects(snap) {
  const byWorkspace = new Map((snap.projects || []).filter((p) => p.workspace).map((p) => [p.workspace, p.slug]));
  return (snap.herdr?.workspaces || []).map((w) => ({
    slug: byWorkspace.get(w.id) || w.label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, ''),
    workspace: w.id,
    label: w.label,
  }));
}

function distribute(slots, weights) {
  const result = Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!total || !slots) return result;
  const ranked = Object.entries(weights).map(([k, v]) => ({ k, raw: slots * v / total }));
  for (const r of ranked) result[r.k] = Math.floor(r.raw);
  let left = slots - Object.values(result).reduce((a, b) => a + b, 0);
  ranked.sort((a, b) => (b.raw % 1) - (a.raw % 1) || a.k.localeCompare(b.k));
  for (const r of ranked) if (left-- > 0) result[r.k]++;
  return result;
}

// A window whose reset time has passed is unmeasured until the next reading, so its old percentage does not count.
const liveWindow = (w, now) => !w.extra && Number.isFinite(w.usedPercent) && !(w.resetsAt && Date.parse(w.resetsAt) <= now);

function quotaRisk(q, policy, now = Date.now()) {
  if (policy.providerModes[q.provider] === 'ignore' || q.error) return null;
  const windows = (q.windows || []).filter((w) => liveWindow(w, now));
  const risk = windows.filter((w) => w.usedPercent >= 100 - policy.reservePercent || (w.willLast === false && w.etaSeconds != null && w.etaSeconds <= policy.handoffLeadMinutes * 60));
  return risk.sort((a, b) => b.usedPercent - a.usedPercent)[0] || null;
}

// How far a window is ahead of pace; without expected use, its usage percentage.
const paceScore = (w) => Number.isFinite(w.expectedPercent) ? w.usedPercent - w.expectedPercent : w.usedPercent;

// Any live window that will not last makes its provider ahead of pace. The lane reports the worst of them.
function quotaPressure(q, policy, now = Date.now()) {
  if (policy.providerModes[q.provider] === 'ignore' || q.error) return null;
  return (q.windows || []).filter((w) => liveWindow(w, now) && w.willLast === false)
    .sort((a, b) => paceScore(b) - paceScore(a))[0] || null;
}

// One state per metered provider: open, pace (ahead of quota pace), reserve (near exhaustion), or unknown.
export function laneStatus(quotas, policy, now = Date.now()) {
  const lanes = {};
  for (const q of quotas || []) {
    const resetWindows = (q.windows || []).filter((w) => !w.extra && w.resetsAt && Date.parse(w.resetsAt) <= now).map((w) => w.label);
    if (q.error) { lanes[q.provider] = { state: 'unknown', reason: String(q.error).slice(0, 200), resetWindows }; continue; }
    if (policy.providerModes[q.provider] === 'ignore') { lanes[q.provider] = { state: 'open', ignored: true, resetWindows }; continue; }
    const risk = quotaRisk(q, policy, now);
    const w = risk || quotaPressure(q, policy, now);
    if (!w) { lanes[q.provider] = { state: 'open', resetWindows }; continue; }
    const overPercent = Number.isFinite(w.expectedPercent) ? w.usedPercent - w.expectedPercent : null;
    const resetAt = Date.parse(w.resetsAt) || Infinity;
    // Expected use grows by 100% per window, so an unused provider catches up at that rate.
    const backOnPaceMs = risk ? resetAt
      : overPercent != null && overPercent > 0 && w.windowMinutes ? Math.min(now + (overPercent / 100) * w.windowMinutes * 60000, resetAt) : resetAt;
    lanes[q.provider] = {
      state: risk ? 'reserve' : 'pace', window: w.label, usedPercent: w.usedPercent, expectedPercent: w.expectedPercent ?? null,
      overPercent, backOnPaceAt: Number.isFinite(backOnPaceMs) ? new Date(backOnPaceMs).toISOString() : null, resetWindows,
    };
  }
  return lanes;
}

// When no metered provider is open, the least-over provider that is only ahead of pace may start without --force.
export function leastOverProvider(lanes) {
  const metered = Object.entries(lanes).filter(([, lane]) => lane.state !== 'unknown');
  if (!metered.length || metered.some(([, lane]) => lane.state === 'open')) return null;
  const pace = metered.filter(([, lane]) => lane.state === 'pace' && lane.overPercent != null).sort((a, b) => a[1].overPercent - b[1].overPercent);
  return pace[0]?.[0] ?? null;
}

export function deriveControl(snap, policy, models, paneSince = {}, now = Date.now()) {
  const projects = workspaceProjects(snap);
  const panes = snap.herdr?.panes || [];
  const settings = {};
  const weights = {};
  const defaultShare = projects.length ? 100 / projects.length : 0;
  for (const p of projects) {
    const saved = policy.projects[p.slug];
    settings[p.slug] = { share: saved?.share ?? defaultShare, mode: saved?.mode ?? 'auto', excludedKinds: saved?.excludedKinds || [], excludedModels: saved?.excludedModels || [] };
    weights[p.slug] = settings[p.slug].share;
  }
  const base = distribute(policy.maxWorkers, weights);
  const result = {};
  const idle = new Set();
  const working = panes.filter((p) => p.agent && !p.orch && p.label !== 'boss' && p.status === 'working');
  for (const p of projects) {
    const orch = panes.find((x) => x.workspace === p.workspace && (x.orch || x.label === 'boss'));
    const workers = working.filter((x) => x.workspace === p.workspace);
    const age = orch ? now - (paneSince[orch.id]?.since || now) : 0;
    const published = (snap.projects || []).find((x) => x.slug === p.slug);
    const mode = settings[p.slug].mode === 'auto' && published?.status === 'paused' ? 'paused' : settings[p.slug].mode;
    const isIdle = mode === 'idle' || mode === 'paused' || (mode === 'auto' && workers.length === 0 && !!orch && ['idle', 'done'].includes(orch.status) && age >= policy.idleMinutes * 60000);
    if (isIdle) idle.add(p.slug);
    result[p.slug] = { ...p, ...settings[p.slug], effectiveMode: mode, baseSlots: base[p.slug] || 0, slots: base[p.slug] || 0, running: workers.length, idle: isIdle, orch: orch ? { pane: orch.id, kind: orch.agent, status: orch.status, sessionId: orch.sessionId } : null };
  }
  if (policy.borrowIdle && idle.size < projects.length) {
    const lent = [...idle].reduce((n, slug) => n + result[slug].slots, 0);
    for (const slug of idle) result[slug].slots = 0;
    const activeWeights = Object.fromEntries(projects.filter((p) => !idle.has(p.slug)).map((p) => [p.slug, weights[p.slug] || 1]));
    const borrowed = distribute(lent, activeWeights);
    for (const [slug, count] of Object.entries(borrowed)) result[slug].slots += count;
  }
  const risks = Object.fromEntries((snap.quotas || []).map((q) => [q.provider, quotaRisk(q, policy, now)]));
  const pressures = Object.fromEntries((snap.quotas || []).map((q) => [q.provider, quotaPressure(q, policy, now)]));
  const globalAllowed = Object.fromEntries(Object.entries(models.kinds).filter(([kind]) => policy.allowedKinds.includes(kind)).map(([kind, cfg]) => [kind, cfg.allowedModels.filter((m) => !policy.excludedModels.includes(m))]));
  const handoffs = [];
  for (const p of Object.values(result)) {
    if (!p.orch) continue;
    const currentKindConfig = models.kinds[p.orch.kind];
    const currentProvider = providerFor(p.orch.kind, policy.preferredModels?.[p.orch.kind] ?? currentKindConfig?.defaultModel, policy);
    const window = risks[currentProvider];
    if (!window) continue;
    const preferred = pickSuccessor(p, p.orch.kind, currentProvider, policy, { globalAllowed, risks });
    handoffs.push({ project: p.slug, workspace: p.workspace, pane: p.orch.pane, fromKind: p.orch.kind, sessionId: p.orch.sessionId, provider: currentProvider, window, target: preferred });
  }
  return { projects: result, runningWorkers: working.length, maxWorkers: policy.maxWorkers, globalAllowed, risks, pressures, handoffs };
}
