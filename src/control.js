import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { loadModels } from './kit/config.js';

const FILE = path.join(DATA_DIR, 'policy.json');
export const POLICY_DEFAULTS = {
  machine: { guardEnabled: true, guardPausedUntil: null, ownerAwayMinutes: 10, presentCpuPercent: 70, awayCpuPercent: 95, presentLoadFactor: 3, awayLoadFactor: 8, diskWarnFreeGB: 20, diskCriticalFreeGB: 5, alertCooldownSeconds: 21600 },
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
  // A legacy route by model. A route in harnessRoutes for the same harness takes precedence.
  modelProviders: {},
  // Local model strings that the Owner adds to one harness, beside the kit/models.json catalog.
  extraModels: {},
  // Models that one harness does not use. excludedModels still disables a model for every harness.
  disabledModels: {},
  // The provider quota for a model in one harness. A null route is unmetered.
  harnessRoutes: {},
  // A pacing goal is the most percent of a live quota window the Owner wants to use by its end.
  // It is keyed by provider and by the stable window key from quota collection. An absent goal means 100%.
  pacingGoals: {},
  // Stable Herdr workspace labels that do not represent projects.
  excludedWorkspaces: [],
  projects: {},
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS = new Set(POLICY_DEFAULTS.allowedKinds);
const PROVIDERS = new Set(Object.keys(POLICY_DEFAULTS.providerModes));
const WINDOW_KEYS = new Set(['primary', 'secondary', 'tertiary']);
// A model string holds letters, digits, dots, underscores, slashes, and hyphens. It starts with a letter or digit.
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// The kit catalog plus the valid local extra models of each harness. Extras keep the harness launch arguments and efforts.
export function mergeModels(models, policy = null) {
  const extra = isObject(policy?.extraModels) ? policy.extraModels : {};
  return { ...models, kinds: Object.fromEntries(Object.entries(models.kinds).map(([kind, cfg]) => {
    const added = [...new Set((Array.isArray(extra[kind]) ? extra[kind] : []).filter((model) => typeof model === 'string' && MODEL_ID.test(model) && !cfg.allowedModels.includes(model)))];
    return [kind, added.length ? { ...cfg, allowedModels: [...cfg.allowedModels, ...added] } : cfg];
  })) };
}

// Codex and Claude run only their own subscription models, so a route there is that provider or unmetered (null).
// Open harnesses can route a model to any provider.
export function harnessProviders(kind) {
  return kind === 'codex' || kind === 'claude' ? [kind, null] : [...[...PROVIDERS].sort(), null];
}

// A model is enabled for a harness unless the global list or the list of that harness disables it.
export function modelEnabled(kind, model, policy = null) {
  if ((policy?.excludedModels || []).includes(model)) return false;
  const disabled = policy?.disabledModels?.[kind];
  return !(Array.isArray(disabled) && disabled.includes(model));
}

// Legacy modelProviders routes that a Codex or Claude harness cannot use and that no harnessRoutes entry overrides.
// The result maps a harness to its models, and the provider of each conflict is in modelProviders.
export function legacyRouteConflicts(policy, models, kinds = ['codex', 'claude']) {
  const catalog = mergeModels(models, policy);
  const conflicts = {};
  for (const kind of kinds) {
    const allowed = harnessProviders(kind);
    const routes = isObject(policy?.harnessRoutes?.[kind]) ? policy.harnessRoutes[kind] : {};
    for (const model of catalog.kinds[kind]?.allowedModels || []) {
      if (!isObject(policy?.modelProviders) || !Object.hasOwn(policy.modelProviders, model) || Object.hasOwn(routes, model)) continue;
      if (!allowed.includes(policy.modelProviders[model])) (conflicts[kind] ||= []).push(model);
    }
  }
  return conflicts;
}

const warnedRoutes = new Set();

// A saved policy always loads. An incompatible legacy route is kept in modelProviders for Settings,
// and ignoredRoutes makes providerFor treat it as unmetered for that harness. Each conflict warns once per process.
export function loadPolicy({ file = FILE, models = null, warn = (text) => console.warn(text) } = {}) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const { ignoredRoutes: _derived, ...stored } = saved;
  const savedMachine = isObject(stored.machine) ? stored.machine : {};
  const machine = { ...POLICY_DEFAULTS.machine, ...savedMachine };
  if (!Object.hasOwn(savedMachine, 'guardEnabled')) {
    const legacyOff = savedMachine.presentCpuPercent === 100 && savedMachine.awayCpuPercent === null &&
      savedMachine.presentLoadFactor === null && savedMachine.awayLoadFactor === null;
    machine.guardEnabled = !legacyOff;
    if (legacyOff) Object.assign(machine, {
      presentCpuPercent: 95, awayCpuPercent: 95, presentLoadFactor: 3, awayLoadFactor: 8,
    });
  }
  const policy = { ...POLICY_DEFAULTS, ...stored, machine, providerModes: { ...POLICY_DEFAULTS.providerModes, ...stored.providerModes }, preferredModels: stored.preferredModels || {}, modelProviders: stored.modelProviders || {}, extraModels: stored.extraModels || {}, disabledModels: stored.disabledModels || {}, harnessRoutes: stored.harnessRoutes || {}, pacingGoals: stored.pacingGoals || {}, excludedWorkspaces: Array.isArray(stored.excludedWorkspaces) ? stored.excludedWorkspaces : [], projects: stored.projects || {} };
  policy.ignoredRoutes = legacyRouteConflicts(policy, models ?? loadModels());
  for (const [kind, list] of Object.entries(policy.ignoredRoutes)) for (const model of list) {
    const key = `${file}:${kind}/${model}:${policy.modelProviders[model]}`;
    if (warnedRoutes.has(key)) continue;
    warnedRoutes.add(key);
    warn(`herdr-boss: policy route ${kind}/${model} -> ${policy.modelProviders[model]} is incompatible with ${kind}. Herdr Boss treats it as Unmetered. Choose a provider for this row in Settings.`);
  }
  return policy;
}

export function machineLimits(machine, policy, now = Date.now()) {
  const away = Number.isFinite(machine.ownerIdleMinutes) && machine.ownerIdleMinutes >= policy.machine.ownerAwayMinutes;
  const cpu = Number.isFinite(machine.cpuTotalSample) ? machine.cpuTotalSample : Object.values(machine.cpuUse || {}).reduce((sum, value) => sum + (Number(value.cpu) || 0), 0);
  const cores = machine.cpus || 1;
  const factor = away ? policy.machine.awayLoadFactor : policy.machine.presentLoadFactor;
  const guardEnabled = policy.machine.guardEnabled === true;
  const guardPausedUntil = policy.machine.guardPausedUntil ?? null;
  const pauseAt = guardPausedUntil == null ? NaN : Date.parse(guardPausedUntil);
  const guardState = !guardEnabled ? 'off' : Number.isFinite(pauseAt) && pauseAt > now ? 'paused' : 'active';
  return { owner: away ? 'away' : 'present', cpuPercent: cpu / cores, cpuLimit: away ? policy.machine.awayCpuPercent : policy.machine.presentCpuPercent,
    fiveMinute: machine.load?.[1] ?? null, loadLimit: factor == null ? null : cores * factor,
    guardEnabled, guardPausedUntil, guardState, guardActive: guardState === 'active' };
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
  if (!value.machine || typeof value.machine !== 'object' || Array.isArray(value.machine)) errors.push('machine must be an object.');
  else {
    if (typeof value.machine.guardEnabled !== 'boolean') errors.push('machine.guardEnabled must be boolean.');
    const pause = value.machine.guardPausedUntil;
    if (pause !== null && (typeof pause !== 'string' || !Number.isFinite(Date.parse(pause)) || new Date(pause).toISOString() !== pause)) errors.push('machine.guardPausedUntil must be null or a valid ISO timestamp.');
    if (!Number.isInteger(value.machine.alertCooldownSeconds) || value.machine.alertCooldownSeconds < 0 || value.machine.alertCooldownSeconds > 604800) errors.push('machine.alertCooldownSeconds must be an integer from 0 to 604800.');
    for (const key of ['ownerAwayMinutes', 'presentCpuPercent']) if (!Number.isInteger(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > (key === 'ownerAwayMinutes' ? 1440 : 100)) errors.push(`machine.${key} is out of range.`);
    if (value.machine.awayCpuPercent !== null && (!Number.isInteger(value.machine.awayCpuPercent) || value.machine.awayCpuPercent < 0 || value.machine.awayCpuPercent > 100)) errors.push('machine.awayCpuPercent must be null or an integer from 0 to 100.');
    for (const key of ['presentLoadFactor', 'awayLoadFactor']) if (value.machine[key] !== null && (!Number.isFinite(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > 128)) errors.push(`machine.${key} must be null or a number from 0 to 128.`);
    for (const [key, max] of [['diskWarnFreeGB', 1048576], ['diskCriticalFreeGB', 1048576]]) if (!Number.isFinite(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > max) errors.push(`machine.${key} must be a number from 0 to ${max}.`);
  }
  if (!Number.isInteger(value.autoHandoverPercent) || value.autoHandoverPercent < 90 || value.autoHandoverPercent > 100) errors.push('autoHandoverPercent must be an integer from 90 to 100.');
  for (const [key, max] of [['idleMinutes', 1440], ['reservePercent', 80], ['handoffLeadMinutes', 10080]]) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) errors.push(`${key} must be an integer from 0 to ${max}.`);
  }
  subset(value.allowedKinds, KINDS, 'allowedKinds', errors);
  if (!Array.isArray(value.excludedWorkspaces) || value.excludedWorkspaces.some((label) => typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 256) || new Set(value.excludedWorkspaces).size !== value.excludedWorkspaces.length) {
    errors.push('excludedWorkspaces must be a list of unique non-empty workspace labels.');
  }
  const extraModels = value.extraModels ?? {};
  if (!isObject(extraModels)) errors.push('extraModels must be an object.');
  else for (const [kind, list] of Object.entries(extraModels)) {
    if (!models.kinds[kind] || !Array.isArray(list)) { errors.push(`Invalid extraModels entry for ${kind}.`); continue; }
    for (const model of list) if (typeof model !== 'string' || !MODEL_ID.test(model)) errors.push(`Invalid extraModels string for ${kind}: ${JSON.stringify(model)?.slice(0, 80)}.`);
    if (new Set(list).size !== list.length || list.some((model) => models.kinds[kind].allowedModels.includes(model))) errors.push(`extraModels for ${kind} must be unique and not repeat the catalog.`);
  }
  const catalog = mergeModels(models, value);
  const allModels = new Set(Object.values(catalog.kinds).flatMap((k) => k.allowedModels));
  const disabledModels = value.disabledModels ?? {};
  if (!isObject(disabledModels)) errors.push('disabledModels must be an object.');
  else for (const [kind, list] of Object.entries(disabledModels)) subset(list, new Set(catalog.kinds[kind]?.allowedModels || []), `disabledModels.${kind}`, errors);
  const harnessRoutes = value.harnessRoutes ?? {};
  if (!isObject(harnessRoutes)) errors.push('harnessRoutes must be an object.');
  else for (const [kind, routes] of Object.entries(harnessRoutes)) {
    if (!catalog.kinds[kind] || !isObject(routes)) { errors.push(`Invalid harnessRoutes entry for ${kind}.`); continue; }
    const allowed = harnessProviders(kind);
    for (const [model, provider] of Object.entries(routes)) {
      if (!catalog.kinds[kind].allowedModels.includes(model) || (provider !== null && !PROVIDERS.has(provider))) errors.push(`Invalid harnessRoutes route for ${kind}/${model}.`);
      else if (!allowed.includes(provider)) errors.push(`harnessRoutes: ${kind}/${model} cannot use ${provider}. Choose ${allowed.map((x) => x ?? 'null (unmetered)').join(' or ')}.`);
    }
  }
  const enabledKinds = ['codex', 'claude'].filter((kind) => Array.isArray(value.allowedKinds) && value.allowedKinds.includes(kind));
  if (isObject(value.modelProviders) && isObject(harnessRoutes)) for (const [kind, list] of Object.entries(legacyRouteConflicts(value, models, enabledKinds))) {
    const allowed = harnessProviders(kind).map((x) => x ?? 'null (unmetered)').join(' or ');
    for (const model of list) errors.push(`modelProviders: ${kind}/${model} inherits ${value.modelProviders[model]}. Choose ${allowed} in harnessRoutes.${kind}.`);
  }
  models = catalog;
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
  if (!value.pacingGoals || typeof value.pacingGoals !== 'object' || Array.isArray(value.pacingGoals)) errors.push('pacingGoals must be an object.');
  else for (const [provider, windows] of Object.entries(value.pacingGoals)) {
    if (!PROVIDERS.has(provider) || !windows || typeof windows !== 'object' || Array.isArray(windows)) { errors.push(`invalid pacingGoals entry for ${provider}.`); continue; }
    for (const [key, goal] of Object.entries(windows)) {
      const percent = isObject(goal) ? goal.percent : goal;
      if (!WINDOW_KEYS.has(key) || !Number.isInteger(percent) || percent < 0 || percent > 100) errors.push(`pacingGoals.${provider}.${key} must be a whole percentage from 0 to 100.`);
      if (!isObject(goal)) continue;
      if (Object.keys(goal).some((field) => !['percent', 'end'].includes(field))) errors.push(`pacingGoals.${provider}.${key} has an unknown field.`);
      const end = goal.end;
      if (end === undefined) continue;
      if (!isObject(end) || (end.type === 'at' && (typeof end.at !== 'string' || !Number.isFinite(Date.parse(end.at)) || new Date(end.at).toISOString() !== end.at || Object.keys(end).some((field) => !['type', 'at', 'resetAt'].includes(field)) || (end.resetAt !== undefined && (typeof end.resetAt !== 'string' || !Number.isFinite(Date.parse(end.resetAt)) || new Date(end.resetAt).toISOString() !== end.resetAt)))) || (end.type === 'hoursBeforeReset' && (!Number.isSafeInteger(end.hours) || end.hours < 1 || Object.keys(end).some((field) => !['type', 'hours'].includes(field)))) || !['at', 'hoursBeforeReset'].includes(end.type)) errors.push(`pacingGoals.${provider}.${key}.end must be an ISO time or a positive whole number of hours before reset.`);
    }
  }
  if (!value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) errors.push('projects must be an object.');
  else for (const [slug, project] of Object.entries(value.projects)) {
    if (!SLUG.test(slug) || !project || typeof project !== 'object' || Array.isArray(project)) { errors.push(`invalid project: ${slug}.`); continue; }
    if (!Number.isInteger(project.share) || project.share < 0 || project.share > 100) errors.push(`${slug}.share must be 0..100.`);
    if (!['auto', 'active', 'idle', 'paused'].includes(project.mode)) errors.push(`${slug}.mode must be auto, active, idle, or paused.`);
    subset(project.excludedKinds, KINDS, `${slug}.excludedKinds`, errors);
    subset(project.excludedModels, allModels, `${slug}.excludedModels`, errors);
    if (Array.isArray(project.excludedKinds) && project.excludedKinds.some((kind) => !value.allowedKinds?.includes(kind))) errors.push(`${slug}.excludedKinds may only list globally available kinds.`);
    if (Array.isArray(project.excludedModels) && project.excludedModels.some((model) => !value.allowedKinds?.some((kind) => models.kinds[kind]?.allowedModels.includes(model) && modelEnabled(kind, model, value)))) errors.push(`${slug}.excludedModels may only list globally available models.`);
  }
  const total = Object.values(value.projects || {}).reduce((sum, p) => sum + (Number.isInteger(p?.share) ? p.share : 0), 0);
  if (total > 100) errors.push('Project shares must total at most 100%.');
  return errors;
}

function writePolicy(value, file) {
  const { ignoredRoutes: _derived, ...stored } = value;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Resolve saved workspace IDs to stable labels and migrate the legacy Boss project entry
// only when Herdr confirms a pane with the special "boss" label.
export function migrateWorkspacePolicy(value, snap, { file = null } = {}) {
  const ignoredRoutes = value?.ignoredRoutes;
  const { ignoredRoutes: _derived, ...stored } = value || {};
  const next = {
    ...stored,
    excludedWorkspaces: Array.isArray(stored.excludedWorkspaces) ? stored.excludedWorkspaces : [],
    projects: isObject(stored.projects) ? Object.fromEntries(Object.entries(stored.projects).map(([slug, project]) => [slug, isObject(project) ? { ...project } : project])) : {},
  };
  const labelsById = new Map((snap?.herdr?.workspaces || []).filter((workspace) => workspace.id && workspace.label).map((workspace) => [workspace.id, workspace.label]));
  next.excludedWorkspaces = [...new Set(next.excludedWorkspaces.map((entry) => labelsById.get(entry) || entry))];

  const bossPane = (snap?.herdr?.panes || []).find((pane) => pane.label === 'boss');
  const bossWorkspace = labelsById.get(bossPane?.workspace);
  if (bossPane && bossWorkspace) {
    next.excludedWorkspaces = [...new Set([...next.excludedWorkspaces, bossWorkspace])];
    if (Object.hasOwn(next.projects, 'boss')) {
      delete next.projects.boss;
      const entries = Object.entries(next.projects);
      const shares = entries.map(([slug, project]) => ({ slug, project, share: project?.share }));
      const total = shares.reduce((sum, item) => sum + (Number.isInteger(item.share) && item.share >= 0 && item.share <= 100 ? item.share : 0), 0);
      if (total > 0 && shares.every((item) => Number.isInteger(item.share) && item.share >= 0 && item.share <= 100)) {
        const normalized = shares.map((item) => ({ ...item, exact: item.share * 100 / total }));
        for (const item of normalized) item.project.share = Math.floor(item.exact);
        let left = 100 - normalized.reduce((sum, item) => sum + item.project.share, 0);
        normalized.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.slug.localeCompare(b.slug));
        for (const item of normalized) if (left-- > 0) item.project.share++;
      }
    }
  }

  // Compare only persisted fields. ignoredRoutes is derived by loadPolicy and must not trigger a write each tick.
  const changed = JSON.stringify(stored) !== JSON.stringify(next);
  if (changed && file) writePolicy(next, file);
  return ignoredRoutes === undefined ? next : { ...next, ignoredRoutes };
}

export function savePolicy(value, models, { file = FILE, quotas = null, now = Date.now() } = {}) {
  // ignoredRoutes is derived at load time, so a draft that carries it back does not store it.
  const { ignoredRoutes: _derived, ...stored } = value || {};
  const merged = { ...POLICY_DEFAULTS, ...stored, machine: { ...POLICY_DEFAULTS.machine, ...stored.machine }, providerModes: { ...POLICY_DEFAULTS.providerModes, ...stored.providerModes } };
  const errors = validatePolicy(merged, models);
  if (quotas) errors.push(...validatePacingGoalEnds(merged, quotas, now));
  if (errors.length) return errors;
  if (quotas) for (const [provider, windows] of Object.entries(merged.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (goal?.end?.type !== 'at') continue;
    const window = quotas.find((q) => q.provider === provider && !q.error)?.windows?.find((w) => w.key === key && !w.extra);
    goal.end.resetAt = new Date(window.resetsAt).toISOString();
  }
  writePolicy(merged, file);
  return [];
}

export function validatePacingGoalEnds(policy, quotas, now = Date.now()) {
  const errors = [];
  for (const [provider, windows] of Object.entries(policy.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (!isObject(goal?.end)) continue;
    const window = (quotas || []).find((q) => q.provider === provider && !q.error)?.windows?.find((w) => w.key === key && !w.extra);
    const reset = Date.parse(window?.resetsAt);
    const start = reset - window?.windowMinutes * 60000;
    const end = pacingGoalEnd(policy, provider, window);
    const name = `${provider} ${window?.label || key}`;
    if (!Number.isFinite(reset) || !Number.isFinite(start)) errors.push(`${name}: wait for a measured quota window before setting an end.`);
    else if (goal.end.type === 'at' && goal.end.resetAt && Date.parse(goal.end.resetAt) !== reset) errors.push(`${name}: the quota window reset. Refresh the policy before saving.`);
    else if (!Number.isFinite(end) || end <= now) errors.push(`${name}: the goal end must be after now.`);
    else if (end > reset) errors.push(`${name}: the goal end must be at or before reset.`);
    else if (end <= start) errors.push(`${name}: the goal end must be after the window start.`);
  }
  return errors;
}

// Remove a one-off goal when its time passes or the collector moves to another window reset.
export function clearExpiredOneOffGoals(policy, quotas, now = Date.now(), { file = FILE, log = () => {} } = {}) {
  const cleared = [];
  for (const [provider, windows] of Object.entries(policy.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (goal?.end?.type !== 'at') continue;
    const window = (quotas || []).find((q) => q.provider === provider && !q.error)?.windows?.find((w) => w.key === key && !w.extra);
    const resetChanged = goal.end.resetAt && window?.resetsAt && Date.parse(goal.end.resetAt) !== Date.parse(window.resetsAt);
    if (Date.parse(goal.end.at) > now && !resetChanged) continue;
    delete windows[key];
    if (!Object.keys(windows).length) delete policy.pacingGoals[provider];
    cleared.push(`${provider}/${key}`);
  }
  if (cleared.length) {
    writePolicy(policy, file);
    for (const name of cleared) log(`Cleared one-off pacing goal ${name}.`);
  }
  return cleared;
}

export function providerFor(kind, model, policy = null) {
  const routes = policy?.harnessRoutes?.[kind];
  if (model && isObject(routes) && Object.hasOwn(routes, model)) return routes[model];
  if (model && Array.isArray(policy?.ignoredRoutes?.[kind]) && policy.ignoredRoutes[kind].includes(model)) return null;
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
        (provider && (control.risks[provider] || control.exhausted?.[provider]))) continue;
    return { ...rung, provider: provider || 'unmetered' };
  }
  return null;
}

export function workspaceProjects(snap, policy = POLICY_DEFAULTS) {
  const byWorkspace = new Map((snap.projects || []).filter((p) => p.workspace).map((p) => [p.workspace, p.slug]));
  const excluded = new Set(policy?.excludedWorkspaces || []);
  const bossWorkspaces = new Set((snap.herdr?.panes || []).filter((pane) => pane.label === 'boss').map((pane) => pane.workspace));
  return (snap.herdr?.workspaces || []).map((w) => ({
    slug: byWorkspace.get(w.id) || w.label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, ''),
    workspace: w.id,
    label: w.label,
    excluded: bossWorkspaces.has(w.id) || excluded.has(w.label) || excluded.has(w.id),
    boss: bossWorkspaces.has(w.id),
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

function quotaExhaustion(q, now = Date.now()) {
  if (q.error) return null;
  return (q.windows || []).filter((w) => liveWindow(w, now) && w.usedPercent >= 100)
    .sort((a, b) => (Date.parse(b.resetsAt) || 0) - (Date.parse(a.resetsAt) || 0))[0] || null;
}

// A goal below 100 lowers the expected-use curve, so the window reaches the goal at its reset instead of full quota.
export function pacingGoal(policy, provider, key) {
  const value = policy?.pacingGoals?.[provider]?.[key];
  const percent = isObject(value) ? value.percent : value;
  return Number.isInteger(percent) ? percent : 100;
}

export function pacingGoalEnd(policy, provider, window) {
  const end = policy?.pacingGoals?.[provider]?.[window?.key]?.end;
  if (!end || !Number.isFinite(Date.parse(window?.resetsAt))) return null;
  const reset = Date.parse(window.resetsAt);
  return end.type === 'at' ? Date.parse(end.at) : end.type === 'hoursBeforeReset' ? reset - end.hours * 3600000 : null;
}

export function goalSummary(goals) {
  return (goals || []).map(({ label, percent, end, resolvedEnd }) => {
    const time = Number.isFinite(resolvedEnd) ? new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(resolvedEnd) : null;
    const finish = !end ? 'by reset' : end.type === 'hoursBeforeReset' ? `${end.hours} h before reset${time ? ` (${time})` : ''}` : `by ${time || end.at}`;
    return `${String(label).toLowerCase()}: goal ${percent}% ${finish}`;
  }).join('; ');
}

// The expected-use percentage at the current time, scaled by the goal. Null when no pace forecast exists.
export function adjustedExpectedPercent(policy, provider, window, now = Date.now()) {
  const end = pacingGoalEnd(policy, provider, window);
  const reset = Date.parse(window?.resetsAt);
  const start = reset - window?.windowMinutes * 60000;
  if (Number.isFinite(end) && Number.isFinite(start) && end > start) {
    return pacingGoal(policy, provider, window.key) * Math.min(1, Math.max(0, (now - start) / (end - start)));
  }
  if (!Number.isFinite(window?.expectedPercent)) return null;
  return window.expectedPercent * pacingGoal(policy, provider, window.key) / 100;
}

// A live window is ahead of pace when it will not last to reset, or when its use is above the goal-adjusted expected use.
export function aheadOfQuotaPace(policy, provider, window, now = Date.now()) {
  if (!window) return false;
  const expected = adjustedExpectedPercent(policy, provider, window, now);
  return (pacingGoalEnd(policy, provider, window) == null && window.willLast === false) || (expected != null && window.usedPercent > expected);
}

// How far a window is ahead of pace; without expected use, its usage percentage.
const paceScore = (w, expected) => expected != null ? w.usedPercent - expected : w.usedPercent;

// Any live window that is ahead of pace makes its provider ahead of pace. The lane reports the worst of them.
function quotaPressure(q, policy, now = Date.now()) {
  if (policy.providerModes[q.provider] === 'ignore' || q.error) return null;
  return (q.windows || []).filter((w) => liveWindow(w, now) && aheadOfQuotaPace(policy, q.provider, w, now))
    .sort((a, b) => paceScore(b, adjustedExpectedPercent(policy, q.provider, b, now)) - paceScore(a, adjustedExpectedPercent(policy, q.provider, a, now)))[0] || null;
}

// One state per metered provider: open, pace (ahead of quota pace), reserve (near exhaustion), or unknown.
export function laneStatus(quotas, policy, now = Date.now()) {
  const lanes = {};
  for (const q of quotas || []) {
    const goals = (q.windows || []).filter((w) => !w.extra && Object.hasOwn(policy.pacingGoals?.[q.provider] || {}, w.key)).map((w) => ({
      label: w.label, percent: pacingGoal(policy, q.provider, w.key), end: policy.pacingGoals[q.provider][w.key]?.end || null,
      resolvedEnd: pacingGoalEnd(policy, q.provider, w),
    }));
    const resetWindows = (q.windows || []).filter((w) => !w.extra && w.resetsAt && Date.parse(w.resetsAt) <= now).map((w) => w.label);
    if (q.error) { lanes[q.provider] = { state: 'unknown', reason: String(q.error).slice(0, 200), resetWindows, goals }; continue; }
    const exhausted = quotaExhaustion(q, now);
    if (exhausted) {
      lanes[q.provider] = { state: 'exhausted', window: exhausted.label, usedPercent: exhausted.usedPercent, resetAt: exhausted.resetsAt || null, resetWindows, goals };
      continue;
    }
    if (policy.providerModes[q.provider] === 'ignore') { lanes[q.provider] = { state: 'open', ignored: true, resetWindows, goals }; continue; }
    const risk = quotaRisk(q, policy, now);
    const w = risk || quotaPressure(q, policy, now);
    if (!w) { lanes[q.provider] = { state: 'open', resetWindows, goals }; continue; }
    const expectedPercent = adjustedExpectedPercent(policy, q.provider, w, now);
    const overPercent = expectedPercent != null ? w.usedPercent - expectedPercent : null;
    const resetAt = Date.parse(w.resetsAt) || Infinity;
    // An unused provider catches up along the configured goal line. A zero goal never catches up.
    const goal = pacingGoal(policy, q.provider, w.key);
    const end = pacingGoalEnd(policy, q.provider, w);
    const start = resetAt - w.windowMinutes * 60000;
    const backOnPaceMs = risk ? resetAt
      : overPercent != null && overPercent > 0 && goal > 0 && Number.isFinite(end) && Number.isFinite(start) && w.usedPercent <= goal
        ? Math.min(start + w.usedPercent / goal * (end - start), resetAt)
        : overPercent != null && overPercent > 0 && w.windowMinutes && goal > 0 && !Number.isFinite(end) ? Math.min(now + (overPercent / goal) * w.windowMinutes * 60000, resetAt) : resetAt;
    lanes[q.provider] = {
      state: risk ? 'reserve' : 'pace', window: w.label, usedPercent: w.usedPercent, expectedPercent,
      overPercent, backOnPaceAt: Number.isFinite(backOnPaceMs) ? new Date(backOnPaceMs).toISOString() : null, resetWindows, goals,
    };
  }
  return lanes;
}

// When no metered provider is open, the least-over provider that is only ahead of pace may start without --force.
// The unmetered lane is not a metered provider, so it never changes this choice.
export function leastOverProvider(lanes) {
  const metered = Object.entries(lanes).filter(([, lane]) => !lane.unmetered && lane.state !== 'unknown' && lane.state !== 'exhausted');
  if (!metered.length || metered.some(([, lane]) => lane.state === 'open')) return null;
  const pace = metered.filter(([, lane]) => lane.state === 'pace' && lane.overPercent != null).sort((a, b) => a[1].overPercent - b[1].overPercent);
  return pace[0]?.[0] ?? null;
}

// One always-open lane that lists every permitted unmetered model, grouped by project and harness.
// A model is unmetered when the configured route and the provider rules give it no metered provider.
export function unmeteredLane(baseModels, policy, projects = {}, exhaustedModels = {}) {
  const models = mergeModels(baseModels, policy);
  const byProject = {};
  const applicable = new Map();
  const projectModes = {};
  for (const [slug, project] of Object.entries(projects)) {
    const mode = project.effectiveMode || project.mode || 'auto';
    if (mode === 'paused') continue;
    const kinds = {};
    for (const kind of policy.allowedKinds || []) {
      const config = models.kinds[kind];
      if (!config || (project.excludedKinds || []).includes(kind)) continue;
      const permitted = (config.allowedModels || []).filter((model) =>
        modelEnabled(kind, model, policy)
        && !(project.excludedModels || []).includes(model)
        && providerFor(kind, model, policy) === null);
      const available = permitted.filter((model) => {
        const exhaustion = exhaustedModels[model];
        if (!exhaustion) return true;
        const entry = applicable.get(model) || { model, retryAt: exhaustion.retryAt, projects: [], kinds: [] };
        entry.retryAt = Math.max(entry.retryAt || 0, exhaustion.retryAt || 0);
        if (!entry.projects.includes(slug)) entry.projects.push(slug);
        if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
        applicable.set(model, entry);
        return false;
      });
      if (available.length) kinds[kind] = available;
    }
    byProject[slug] = kinds;
    projectModes[slug] = mode;
  }
  const exhausted = [...applicable.values()].sort((a, b) => a.model.localeCompare(b.model));
  for (const entry of exhausted) { entry.projects.sort(); entry.kinds.sort(); }
  return { state: 'open', unmetered: true, byProject, projectModes, exhausted };
}

// A short one-line description of the unmetered lane for the CLI and the bulletin.
export function unmeteredSummary(lane, project = null) {
  const byProject = lane?.byProject || {};
  const slugs = Object.keys(byProject).filter((slug) => !project || slug === project).filter((slug) => lane?.projectModes?.[slug] !== 'paused').sort();
  if (!slugs.length) return null;
  const kinds = [...new Set(slugs.flatMap((slug) => Object.keys(byProject[slug] || {})))].sort();
  const common = {};
  for (const kind of kinds) {
    const sets = slugs.map((slug) => [...(byProject[slug][kind] || [])].map(displayUnmeteredModel).sort());
    if (sets.some((set) => set.length)) {
      const counts = new Map();
      for (const set of sets) { const key = JSON.stringify(set); counts.set(key, (counts.get(key) || 0) + 1); }
      const selected = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      common[kind] = JSON.parse(selected[0]);
    }
  }
  const format = (sets) => Object.keys(sets).sort().filter((kind) => sets[kind]?.length).map((kind) => `${kind}: ${sets[kind].map(displayUnmeteredModel).sort().join(', ')}`).join('; ');
  if (project) return format(byProject[project] || {});
  const commonText = format(common);
  const exceptions = slugs.map((slug) => {
    const deltas = {};
    for (const kind of kinds) {
      const baseline = common[kind] || [];
      const actual = [...(byProject[slug][kind] || [])].map(displayUnmeteredModel).sort();
      const baselineSet = new Set(baseline), actualSet = new Set(actual);
      const changes = [
        ...baseline.filter((model) => !actualSet.has(model)).map((model) => `-${model}`),
        ...actual.filter((model) => !baselineSet.has(model)).map((model) => `+${model}`),
      ];
      if (changes.length) deltas[kind] = actual.length ? changes : ['none'];
    }
    return Object.keys(deltas).length ? `${slug} (${Object.keys(deltas).sort().map((kind) => `${kind}: ${deltas[kind].join(', ')}`).join('; ')})` : null;
  }).filter(Boolean);
  const exceptionText = exceptions.join('; ');
  return `${commonText || 'no unmetered models'}${exceptionText ? `; exceptions: ${exceptionText}` : ''}`;
}

function displayUnmeteredModel(model) {
  return model.startsWith('opencode/') ? model.slice('opencode/'.length) : model;
}

export function deriveControl(snap, policy, baseModels, paneSince = {}, now = Date.now()) {
  const models = mergeModels(baseModels, policy);
  const workspaces = workspaceProjects(snap, policy);
  const projects = workspaces.filter((workspace) => !workspace.excluded);
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
  const exhausted = Object.fromEntries((snap.quotas || []).map((q) => [q.provider, quotaExhaustion(q, now)]));
  const pressures = Object.fromEntries((snap.quotas || []).map((q) => [q.provider, quotaPressure(q, policy, now)]));
  const globalAllowed = Object.fromEntries(Object.entries(models.kinds).filter(([kind]) => policy.allowedKinds.includes(kind)).map(([kind, cfg]) => [kind, cfg.allowedModels.filter((m) => modelEnabled(kind, m, policy))]));
  const handoffs = [];
  for (const p of Object.values(result)) {
    if (!p.orch) continue;
    const currentKindConfig = models.kinds[p.orch.kind];
    const currentProvider = providerFor(p.orch.kind, policy.preferredModels?.[p.orch.kind] ?? currentKindConfig?.defaultModel, policy);
    const window = risks[currentProvider];
    if (!window) continue;
    const preferred = pickSuccessor(p, p.orch.kind, currentProvider, policy, { globalAllowed, risks, exhausted });
    handoffs.push({ project: p.slug, workspace: p.workspace, pane: p.orch.pane, fromKind: p.orch.kind, sessionId: p.orch.sessionId, provider: currentProvider, window, target: preferred });
  }
  let bossHandoff = null;
  const bossPane = panes.find((pane) => pane.label === 'boss');
  if (bossPane) {
    const kindConfig = models.kinds[bossPane.agent];
    const currentProvider = kindConfig && providerFor(bossPane.agent, policy.preferredModels?.[bossPane.agent] ?? kindConfig.defaultModel, policy);
    const window = risks[currentProvider] || null;
    const bossProject = { excludedKinds: [], excludedModels: [] };
    const target = kindConfig ? pickSuccessor(bossProject, bossPane.agent, currentProvider, policy, { globalAllowed, risks, exhausted }) : null;
    bossHandoff = {
      project: 'Boss', label: 'Boss', boss: true, workspace: bossPane.workspace, pane: bossPane.id,
      fromKind: bossPane.agent || null, sessionId: bossPane.agent ? bossPane.sessionId || (bossPane.agent_session?.kind === 'id' ? bossPane.agent_session.value : null) : null,
      provider: currentProvider, window, target,
      ...(!bossPane.agent ? { defaultMode: 'fresh' } : {}),
    };
  }
  return { projects: result, workspaces, runningWorkers: working.length, maxWorkers: policy.maxWorkers, globalAllowed, risks, exhausted, pressures, handoffs, bossHandoff };
}
