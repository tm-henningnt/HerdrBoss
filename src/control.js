import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readFactoryShares, FACTORY_SHARE_ERROR } from './fleet-pacing.js';
import { loadModels } from './kit/config.js';
import { goalTextError } from './goal.js';
import { formatLocalTime, planDeviationText, projectedReach, recentBurn } from './quota-plan.js';
import { appendPolicyChange, callerKind, diffPolicy } from './policy-log.js';
import { assertDataFile, readDataFile, writeDataFile } from './data-file-safety.js';

const FILE = path.join(DATA_DIR, 'policy.json');
export const POLICY_DEFAULTS = {
  attachments: { retentionDays: 30 },
  agentMessages: { retentionDays: 14, metaRetentionDays: 180, promptTimeoutSeconds: 25 },
  opus: { allowWithoutForce: false, maxConcurrent: 2 },
  machine: { guardEnabled: true, guardPausedUntil: null, ownerAwayMinutes: 10, presentCpuPercent: 70, awayCpuPercent: 95, presentLoadFactor: 3, awayLoadFactor: 8, diskWarnFreeGB: 20, diskClearFreeGB: 24, diskCriticalFreeGB: 5, alertCooldownSeconds: 21600, swapWarnPercent: 80, swapRefusePercent: 95, swapMinUsedGB: 2, swapRefuseEnabled: false, kitDigestMinutes: 120 },
  locks: { slots: 2, shortLimitMinutes: 6, guard: { enabled: true, maxLoadPercent: 231, maxSwapPercent: 96, minFreeMemPercent: 40 } },
  maxWorkers: 8,
  borrowIdle: true,
  idleMinutes: 15,
  reservePercent: 15,
  // A lane is ahead of pace only when its use is more than paceTolerancePoints above the expected use and at least paceMinUsePercent.
  paceTolerancePoints: 5,
  paceMinUsePercent: 30,
  // Prefer a model of a lane that is far below its pace when no model is given. It never overrides --kind or --model.
  paceRouting: true,
  handoffLeadMinutes: 180,
  autoHandover: false,
  autoHandoverPercent: 98,
  autoHandoverContextTokens: 300000,
  autoHandoverForceContextTokens: 400000,
  // The /goal text for a new orchestrator that has no goal. A handover copies it to the successor. An empty string turns it off.
  defaultOrchestratorGoal: 'Keep the build moving end to end. Work through the published plan in priority order, and start the next ready task as soon as a slot is free, on a Use now lane with the free models first. Decide product, design and technical details yourself with good judgment and taste: check docs/orchestration/memory.md for a recorded Owner decision first, choose the simpler and more robust option, and record each decision. Respect herdr-boss messages, the kit and the Boss. When something is unclear, risky or needs a second opinion, ask the Boss, who decides with you. Stop only when no task can progress without a human. Then escalate through the Boss with one mail or chat item that names the decision, the options and your recommendation. Keep your main thread small: use subagents for reviews and reading, end your turn after a dispatch, and wait for worker reports. Before you stop, leave memory.md, the published status and the next task current. A running worker, a gate, a push or a lock wait is progress: dispatch, end the turn, wait for the report, and treat the goal as met for that turn.',
  goals: { autoCommand: false },
  // After backoffAfterTimeouts Claude quota probe timeouts in a row, probe every backoffMinutes.
  quotaProbe: { backoffAfterTimeouts: 2, backoffMinutes: 20 },
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
const warnedFactoryShares = new Set();

// A saved policy always loads. An incompatible legacy route is kept in modelProviders for Settings,
// and ignoredRoutes makes providerFor treat it as unmetered for that harness. Each conflict warns once per process.
export function loadPolicy({ file = FILE, models = null, warn = (text) => console.warn(text) } = {}) {
  let saved = {};
  try { saved = JSON.parse(readDataFile(file, path.dirname(file))); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const { ignoredRoutes: _derived, factoryShares: _shares, factoryShareError: _shareError, ...stored } = saved;
  const savedMachine = isObject(stored.machine) ? stored.machine : {};
  const machine = { ...POLICY_DEFAULTS.machine, ...savedMachine };
  // A saved warning value above the default clear value keeps the saved policy valid.
  if (!Object.hasOwn(savedMachine, 'diskClearFreeGB') && Number.isFinite(machine.diskWarnFreeGB)) machine.diskClearFreeGB = Math.max(POLICY_DEFAULTS.machine.diskClearFreeGB, machine.diskWarnFreeGB);
  const savedLocks = isObject(stored.locks) ? stored.locks : {};
  const locks = {
    ...POLICY_DEFAULTS.locks,
    ...savedLocks,
    guard: { ...POLICY_DEFAULTS.locks.guard, ...(isObject(savedLocks.guard) ? savedLocks.guard : {}) },
  };
  if (!Object.hasOwn(savedMachine, 'guardEnabled')) {
    const legacyOff = savedMachine.presentCpuPercent === 100 && savedMachine.awayCpuPercent === null &&
      savedMachine.presentLoadFactor === null && savedMachine.awayLoadFactor === null;
    machine.guardEnabled = !legacyOff;
    if (legacyOff) Object.assign(machine, {
      presentCpuPercent: 95, awayCpuPercent: 95, presentLoadFactor: 3, awayLoadFactor: 8,
    });
  }
  const policy = { ...POLICY_DEFAULTS, ...stored, machine, locks, attachments: { ...POLICY_DEFAULTS.attachments, ...(isObject(stored.attachments) ? stored.attachments : {}) }, agentMessages: { ...POLICY_DEFAULTS.agentMessages, ...(isObject(stored.agentMessages) ? stored.agentMessages : {}) }, opus: { ...POLICY_DEFAULTS.opus, ...(isObject(stored.opus) ? stored.opus : {}) }, goals: { ...POLICY_DEFAULTS.goals, ...(isObject(stored.goals) ? stored.goals : {}) }, quotaProbe: { ...POLICY_DEFAULTS.quotaProbe, ...(isObject(stored.quotaProbe) ? stored.quotaProbe : {}) }, providerModes: { ...POLICY_DEFAULTS.providerModes, ...stored.providerModes }, preferredModels: stored.preferredModels || {}, modelProviders: stored.modelProviders || {}, extraModels: stored.extraModels || {}, disabledModels: stored.disabledModels || {}, harnessRoutes: stored.harnessRoutes || {}, pacingGoals: stored.pacingGoals || {}, excludedWorkspaces: Array.isArray(stored.excludedWorkspaces) ? stored.excludedWorkspaces : [], projects: stored.projects || {} };
  if (!Object.hasOwn(stored, 'autoHandoverForceContextTokens')) {
    const maxContextTokens = 2000000;
    const contextStep = 10000;
    if (Number.isInteger(policy.autoHandoverContextTokens)
      && policy.autoHandoverContextTokens >= POLICY_DEFAULTS.autoHandoverForceContextTokens
      && policy.autoHandoverContextTokens <= maxContextTokens) {
      if (policy.autoHandoverContextTokens === maxContextTokens) policy.autoHandoverContextTokens -= contextStep;
      policy.autoHandoverForceContextTokens = Math.min(maxContextTokens,
        Math.ceil((policy.autoHandoverContextTokens + 1) / contextStep) * contextStep);
    }
  }
  policy.ignoredRoutes = legacyRouteConflicts(policy, models ?? loadModels());
  try {
    const factoryShares = readFactoryShares(path.dirname(file));
    if (Object.keys(factoryShares).length) policy.factoryShares = factoryShares;
    warnedFactoryShares.delete(file);
  } catch {
    policy.factoryShareError = FACTORY_SHARE_ERROR;
    if (!warnedFactoryShares.has(file)) {
      warnedFactoryShares.add(file);
      warn(`herdr-boss: ${FACTORY_SHARE_ERROR}`);
    }
  }
  for (const [kind, list] of Object.entries(policy.ignoredRoutes)) for (const model of list) {
    const key = `${file}:${kind}/${model}:${policy.modelProviders[model]}`;
    if (warnedRoutes.has(key)) continue;
    warnedRoutes.add(key);
    warn(`herdr-boss: policy route ${kind}/${model} -> ${policy.modelProviders[model]} is incompatible with ${kind}. Herdr Boss treats it as Unmetered. Choose a provider for this row in Settings.`);
  }
  return policy;
}

// The Owner is away when the machine measured an idle Owner, or when a watch is active. An active watch state
// uses the same away limits as an idle Owner. It changes no machine limit.
export function machineLimits(machine, policy, now = Date.now(), night = null) {
  const idle = Number.isFinite(machine.ownerIdleMinutes) && machine.ownerIdleMinutes >= policy.machine.ownerAwayMinutes;
  const away = idle || night?.active === true;
  const cpu = Number.isFinite(machine.cpuTotalSample) ? machine.cpuTotalSample : Object.values(machine.cpuUse || {}).reduce((sum, value) => sum + (Number(value.cpu) || 0), 0);
  const cores = machine.cpus || 1;
  const factor = away ? policy.machine.awayLoadFactor : policy.machine.presentLoadFactor;
  const guardEnabled = policy.machine.guardEnabled === true;
  const guardPausedUntil = policy.machine.guardPausedUntil ?? null;
  const pauseAt = guardPausedUntil == null ? NaN : Date.parse(guardPausedUntil);
  const guardState = !guardEnabled ? 'off' : Number.isFinite(pauseAt) && pauseAt > now ? 'paused' : 'active';
  const swapUsed = Number.isFinite(machine.swapUsedMB) ? machine.swapUsedMB : null;
  const swapTotal = Number.isFinite(machine.swapTotalMB) && machine.swapTotalMB > 0 ? machine.swapTotalMB : null;
  const swapPercent = swapUsed != null && swapTotal != null ? swapUsed / swapTotal * 100 : null;
  return { owner: away ? 'away' : 'present', cpuPercent: cpu / cores, cpuLimit: away ? policy.machine.awayCpuPercent : policy.machine.presentCpuPercent,
    fiveMinute: machine.load?.[1] ?? null, loadLimit: factor == null ? null : cores * factor,
    guardEnabled, guardPausedUntil, guardState, guardActive: guardState === 'active',
    swapPercent, swapUsedGB: swapUsed == null ? null : swapUsed / 1024,
    swapWarnPercent: policy.machine.swapWarnPercent ?? null, swapRefusePercent: policy.machine.swapRefusePercent ?? null, swapMinUsedGB: policy.machine.swapMinUsedGB ?? 0, swapRefuseEnabled: policy.machine.swapRefuseEnabled === true };
}

function subset(value, set, field, errors) {
  if (!Array.isArray(value) || value.some((x) => !set.has(x)) || new Set(value).size !== value.length) errors.push(`${field} must be a list of unique allowed values.`);
}

export function validatePolicy(value, models) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['policy must be an object.'];
  if (!Number.isInteger(value.maxWorkers) || value.maxWorkers < 1 || value.maxWorkers > 64) errors.push('maxWorkers must be an integer from 1 to 64.');
  if (typeof value.borrowIdle !== 'boolean') errors.push('borrowIdle must be boolean.');
  if (typeof value.paceRouting !== 'boolean') errors.push('paceRouting must be boolean.');
  if (typeof value.autoHandover !== 'boolean') errors.push('autoHandover must be boolean.');
  if (!isObject(value.goals)) errors.push('goals must be an object.');
  else if (typeof value.goals.autoCommand !== 'boolean') errors.push('goals.autoCommand must be boolean.');
  if (!isObject(value.quotaProbe)) errors.push('quotaProbe must be an object.');
  else {
    for (const [key, min, max] of [['backoffAfterTimeouts', 1, 10], ['backoffMinutes', 1, 1440]]) {
      if (!Number.isInteger(value.quotaProbe[key]) || value.quotaProbe[key] < min || value.quotaProbe[key] > max) errors.push(`quotaProbe.${key} must be an integer from ${min} to ${max}.`);
    }
  }
  if (!value.machine || typeof value.machine !== 'object' || Array.isArray(value.machine)) errors.push('machine must be an object.');
  else {
    if (typeof value.machine.guardEnabled !== 'boolean') errors.push('machine.guardEnabled must be boolean.');
    const pause = value.machine.guardPausedUntil;
    if (pause !== null && (typeof pause !== 'string' || !Number.isFinite(Date.parse(pause)) || new Date(pause).toISOString() !== pause)) errors.push('machine.guardPausedUntil must be null or a valid ISO timestamp.');
    if (!Number.isInteger(value.machine.alertCooldownSeconds) || value.machine.alertCooldownSeconds < 0 || value.machine.alertCooldownSeconds > 604800) errors.push('machine.alertCooldownSeconds must be an integer from 0 to 604800.');
    for (const key of ['ownerAwayMinutes', 'presentCpuPercent']) if (!Number.isInteger(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > (key === 'ownerAwayMinutes' ? 1440 : 100)) errors.push(`machine.${key} is out of range.`);
    if (value.machine.awayCpuPercent !== null && (!Number.isInteger(value.machine.awayCpuPercent) || value.machine.awayCpuPercent < 0 || value.machine.awayCpuPercent > 100)) errors.push('machine.awayCpuPercent must be null or an integer from 0 to 100.');
    for (const key of ['presentLoadFactor', 'awayLoadFactor']) if (value.machine[key] !== null && (!Number.isFinite(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > 128)) errors.push(`machine.${key} must be null or a number from 0 to 128.`);
    for (const key of ['swapWarnPercent', 'swapRefusePercent']) if (value.machine[key] !== null && (!Number.isInteger(value.machine[key]) || value.machine[key] < 1 || value.machine[key] > 100)) errors.push(`machine.${key} must be null or an integer from 1 to 100.`);
    if (!Number.isInteger(value.machine.kitDigestMinutes) || value.machine.kitDigestMinutes < 10 || value.machine.kitDigestMinutes > 1440) errors.push('machine.kitDigestMinutes must be an integer from 10 to 1440.');
    if (typeof value.machine.swapRefuseEnabled !== 'boolean') errors.push('machine.swapRefuseEnabled must be boolean.');
    if (!Number.isFinite(value.machine.swapMinUsedGB) || value.machine.swapMinUsedGB < 0 || value.machine.swapMinUsedGB > 1024) errors.push('machine.swapMinUsedGB must be a number from 0 to 1024.');
    for (const [key, max] of [['diskWarnFreeGB', 1048576], ['diskClearFreeGB', 1048576], ['diskCriticalFreeGB', 1048576]]) if (!Number.isFinite(value.machine[key]) || value.machine[key] < 0 || value.machine[key] > max) errors.push(`machine.${key} must be a number from 0 to ${max}.`);
    if (Number.isFinite(value.machine.diskClearFreeGB) && Number.isFinite(value.machine.diskWarnFreeGB) && value.machine.diskClearFreeGB < value.machine.diskWarnFreeGB) errors.push('machine.diskClearFreeGB must be at least machine.diskWarnFreeGB.');
  }
  if (!isObject(value.attachments)) errors.push('attachments must be an object.');
  else if (!Number.isInteger(value.attachments.retentionDays) || value.attachments.retentionDays < 1 || value.attachments.retentionDays > 365) errors.push('attachments.retentionDays must be an integer from 1 to 365.');
  if (!isObject(value.agentMessages)) errors.push('agentMessages must be an object.');
  else {
    if (!Number.isInteger(value.agentMessages.retentionDays) || value.agentMessages.retentionDays < 1 || value.agentMessages.retentionDays > 90) errors.push('agentMessages.retentionDays must be an integer from 1 to 90.');
    if (!Number.isInteger(value.agentMessages.metaRetentionDays) || value.agentMessages.metaRetentionDays < 7 || value.agentMessages.metaRetentionDays > 730) errors.push('agentMessages.metaRetentionDays must be an integer from 7 to 730.');
    if (!Number.isInteger(value.agentMessages.promptTimeoutSeconds) || value.agentMessages.promptTimeoutSeconds < 1 || value.agentMessages.promptTimeoutSeconds > 120) errors.push('agentMessages.promptTimeoutSeconds must be an integer from 1 to 120.');
  }
  if (!isObject(value.opus)) errors.push('opus must be an object.');
  else {
    if (typeof value.opus.allowWithoutForce !== 'boolean') errors.push('opus.allowWithoutForce must be boolean.');
    if (!Number.isInteger(value.opus.maxConcurrent) || value.opus.maxConcurrent < 1 || value.opus.maxConcurrent > 8) errors.push('opus.maxConcurrent must be an integer from 1 to 8.');
  }
  if (!isObject(value.locks)) errors.push('locks must be an object.');
  else {
    if (!Number.isInteger(value.locks.slots) || value.locks.slots < 1 || value.locks.slots > 4) errors.push('locks.slots must be an integer from 1 to 4.');
    if (!Number.isInteger(value.locks.shortLimitMinutes) || value.locks.shortLimitMinutes < 1 || value.locks.shortLimitMinutes > 60) errors.push('locks.shortLimitMinutes must be an integer from 1 to 60.');
    if (!isObject(value.locks.guard)) errors.push('locks.guard must be an object.');
    else {
      if (typeof value.locks.guard.enabled !== 'boolean') errors.push('locks.guard.enabled must be boolean.');
      if (!Number.isInteger(value.locks.guard.maxLoadPercent) || value.locks.guard.maxLoadPercent < 0 || value.locks.guard.maxLoadPercent > 1000) errors.push('locks.guard.maxLoadPercent must be an integer from 0 to 1000.');
      for (const key of ['maxSwapPercent', 'minFreeMemPercent']) if (!Number.isInteger(value.locks.guard[key]) || value.locks.guard[key] < 0 || value.locks.guard[key] > 100) errors.push(`locks.guard.${key} must be an integer from 0 to 100.`);
    }
  }
  if (!Number.isInteger(value.autoHandoverPercent) || value.autoHandoverPercent < 90 || value.autoHandoverPercent > 100) errors.push('autoHandoverPercent must be an integer from 90 to 100.');
  if (!Number.isInteger(value.autoHandoverContextTokens) || value.autoHandoverContextTokens < 50000 || value.autoHandoverContextTokens > 2000000) errors.push('autoHandoverContextTokens must be an integer from 50000 to 2000000.');
  if (!Number.isInteger(value.autoHandoverForceContextTokens) || value.autoHandoverForceContextTokens < 50000 || value.autoHandoverForceContextTokens > 2000000) errors.push('autoHandoverForceContextTokens must be an integer from 50000 to 2000000.');
  else if (Number.isInteger(value.autoHandoverContextTokens) && value.autoHandoverForceContextTokens <= value.autoHandoverContextTokens) errors.push('autoHandoverForceContextTokens must be greater than autoHandoverContextTokens.');
  { const goalError = goalTextError(value.defaultOrchestratorGoal); if (goalError) errors.push(`defaultOrchestratorGoal ${goalError}`); }
  for (const [key, max] of [['idleMinutes', 1440], ['reservePercent', 80], ['handoffLeadMinutes', 10080], ['paceTolerancePoints', 50], ['paceMinUsePercent', 100]]) {
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

// The one function that writes policy.json. It appends one line to policy-changes.jsonl for a write that changes a value.
// caller is a label (page, cli, project-new, unknown). A missing or other marker logs as unknown.
export function writePolicy(value, { caller = 'unknown', dir = null, file = null, strictLog = false } = {}) {
  const target = file || path.join(dir || DATA_DIR, 'policy.json');
  const logDir = dir || path.dirname(target);
  assertDataFile(target, logDir);
  assertDataFile(path.join(logDir, 'policy-changes.jsonl'), logDir);
  assertDataFile(path.join(logDir, 'policy-changes.jsonl.lock'), logDir);
  const { ignoredRoutes: _derived, factoryShares: _shares, factoryShareError: _shareError, ...stored } = value;
  let before = {};
  let text;
  try { text = readDataFile(target, logDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { before = JSON.parse(text); } catch {}
  writeDataFile(target, `${JSON.stringify(stored, null, 2)}\n`, logDir);
  appendPolicyChange(logDir, { caller: callerKind(caller), changes: diffPolicy(before, stored), strict: strictLog });
}

// The share guard of a policy write from the page or the CLI. Compare the project shares of the new policy with the saved one.
// Return null to allow the write, or { status: 409, error, changed, sum } to refuse it. A request that changes no share always passes.
// A change of 3 or more shares needs confirmed. A total other than 100 needs allowSum. via is 'api' or 'cli' and sets the wording of the way out.
export function policyShareGuard(saved, next, { confirmed = false, allowSum = false, via = 'api' } = {}) {
  const before = isObject(saved?.projects) ? saved.projects : {};
  const after = isObject(next?.projects) ? next.projects : {};
  const share = (projects, slug) => (Number.isInteger(projects[slug]?.share) ? projects[slug].share : null);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((slug) => ({ slug, old: share(before, slug), new: share(after, slug) }))
    .filter((item) => item.old !== item.new);
  if (!changed.length) return null;
  const sum = Object.keys(after).reduce((total, slug) => total + (share(after, slug) ?? 0), 0);
  const lines = changed.map((item) => `${String(item.slug).slice(0, 120)} ${item.old ?? 'none'} -> ${item.new ?? 'none'}`).join(', ');
  const confirmWay = via === 'cli' ? 'Run the command again with --confirmed' : 'Send "confirmed": true in the request body';
  const sumWay = via === 'cli' ? 'Run the command again with --allow-sum' : 'Send "allowSum": true in the request body';
  const problems = [];
  if (changed.length >= 3 && !confirmed) problems.push(`This write changes ${changed.length} project shares: ${lines}. ${confirmWay} to apply it.`);
  if (sum !== 100 && !allowSum) problems.push(`The project shares add up to ${sum}, not 100${changed.length < 3 || confirmed ? `. Changed: ${lines}` : ''}. ${sumWay} to save this total.`);
  return problems.length ? { status: 409, error: problems.join(' '), changed, sum } : null;
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
  if (changed && file) writePolicy(next, { file });
  return ignoredRoutes === undefined ? next : { ...next, ignoredRoutes };
}

// Remove references to models that the catalog no longer allows, and duplicate entries.
// Only well-formed values are pruned. A malformed field stays and fails validation.
// The result holds the pruned copy and one note. The note is null when nothing changed.
export function prunePolicy(value, models) {
  if (!isObject(value)) return { policy: value, note: null };
  const policy = { ...value };
  const removed = new Map();
  const drop = (model, field) => {
    if (!removed.has(model)) removed.set(model, new Set());
    removed.get(model).add(field);
  };
  const unique = (list, field) => {
    const seen = new Set();
    return list.filter((model) => {
      if (typeof model !== 'string' || !seen.has(model)) { seen.add(model); return true; }
      drop(model, field);
      return false;
    });
  };
  if (isObject(policy.extraModels)) {
    policy.extraModels = Object.fromEntries(Object.entries(policy.extraModels).map(([kind, list]) => {
      if (!models.kinds[kind] || !Array.isArray(list)) return [kind, list];
      const kept = unique(list, `extraModels.${kind}`).filter((model) => {
        if (typeof model !== 'string' || !models.kinds[kind].allowedModels.includes(model)) return true;
        drop(model, `extraModels.${kind}`);
        return false;
      });
      return [kind, kept];
    }).filter(([, list]) => !Array.isArray(list) || list.length));
  }
  const catalog = mergeModels(models, policy);
  const known = (kind) => new Set(catalog.kinds[kind]?.allowedModels || []);
  const all = new Set(Object.values(catalog.kinds).flatMap((cfg) => cfg.allowedModels));
  const prune = (list, field, allowed) => unique(list, field).filter((model) => {
    if (typeof model !== 'string' || allowed.has(model)) return true;
    drop(model, field);
    return false;
  });
  if (isObject(policy.disabledModels)) {
    policy.disabledModels = Object.fromEntries(Object.entries(policy.disabledModels).map(([kind, list]) => [kind, catalog.kinds[kind] && Array.isArray(list) ? prune(list, `disabledModels.${kind}`, known(kind)) : list])
      .filter(([, list]) => !Array.isArray(list) || list.length));
  }
  if (isObject(policy.harnessRoutes)) {
    policy.harnessRoutes = Object.fromEntries(Object.entries(policy.harnessRoutes).map(([kind, routes]) => {
      if (!catalog.kinds[kind] || !isObject(routes)) return [kind, routes];
      return [kind, Object.fromEntries(Object.entries(routes).filter(([model]) => {
        if (known(kind).has(model)) return true;
        drop(model, `harnessRoutes.${kind}`);
        return false;
      }))];
    }));
  }
  if (isObject(policy.modelProviders)) {
    policy.modelProviders = Object.fromEntries(Object.entries(policy.modelProviders).filter(([model]) => {
      if (all.has(model)) return true;
      drop(model, 'modelProviders');
      return false;
    }));
  }
  if (Array.isArray(policy.excludedModels)) policy.excludedModels = prune(policy.excludedModels, 'excludedModels', all);
  if (isObject(policy.preferredModels)) {
    policy.preferredModels = Object.fromEntries(Object.entries(policy.preferredModels).filter(([kind, model]) => {
      if (!catalog.kinds[kind] || typeof model !== 'string' || known(kind).has(model)) return true;
      drop(model, `preferredModels.${kind}`);
      return false;
    }));
  }
  if (isObject(policy.projects)) {
    policy.projects = Object.fromEntries(Object.entries(policy.projects).map(([slug, project]) => [slug,
      isObject(project) && Array.isArray(project.excludedModels) ? { ...project, excludedModels: prune(project.excludedModels, `projects.${slug}.excludedModels`, all) } : project]));
  }
  if (!removed.size) return { policy: value, note: null };
  const parts = [...removed].map(([model, fields]) => `${model} (${[...fields].join(', ')})`);
  const shown = parts.slice(0, 4).join('; ');
  return { policy, note: `Removed stale model references: ${shown}${parts.length > 4 ? `; and ${parts.length - 4} more` : ''}.` };
}

// Pass a notes array to receive a note for each automatic prune of stale model references.
export function savePolicy(value, models, { file = FILE, quotas = null, now = Date.now(), notes = null, caller = 'unknown', dryRun = false, strictLog = false } = {}) {
  // ignoredRoutes is derived at load time, so a draft that carries it back does not store it.
  const { ignoredRoutes: _derived, factoryShares: _shares, factoryShareError: _shareError, ...draft } = value || {};
  const { policy: stored, note } = prunePolicy(draft, models);
  const savedLocks = stored.locks;
  const locks = savedLocks === undefined
    ? structuredClone(POLICY_DEFAULTS.locks)
    : isObject(savedLocks) ? {
      ...POLICY_DEFAULTS.locks,
      ...savedLocks,
      guard: savedLocks.guard === undefined ? structuredClone(POLICY_DEFAULTS.locks.guard)
        : isObject(savedLocks.guard) ? { ...POLICY_DEFAULTS.locks.guard, ...savedLocks.guard } : savedLocks.guard,
    } : savedLocks;
  const merged = {
    ...POLICY_DEFAULTS,
    ...stored,
    machine: { ...POLICY_DEFAULTS.machine, ...stored.machine },
    goals: { ...POLICY_DEFAULTS.goals, ...stored.goals },
    locks,
    providerModes: { ...POLICY_DEFAULTS.providerModes, ...stored.providerModes },
  };
  const errors = validatePolicy(merged, models);
  if (quotas) errors.push(...validatePacingGoalEnds(merged, quotas, now));
  if (errors.length) return errors;
  if (quotas) for (const [provider, windows] of Object.entries(merged.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (goal?.end?.type !== 'at') continue;
    const window = quotas.find((q) => q.provider === provider && hasQuotaData(q))?.windows?.find((w) => w.key === key && !w.extra);
    goal.end.resetAt = new Date(window.resetsAt).toISOString();
  }
  if (dryRun) return [];
  writePolicy(merged, { file, caller, strictLog });
  if (note && notes) notes.push(note);
  return [];
}

export function validatePacingGoalEnds(policy, quotas, now = Date.now()) {
  const errors = [];
  for (const [provider, windows] of Object.entries(policy.pacingGoals || {})) for (const [key, goal] of Object.entries(windows || {})) {
    if (!isObject(goal?.end)) continue;
    const window = (quotas || []).find((q) => q.provider === provider && hasQuotaData(q))?.windows?.find((w) => w.key === key && !w.extra);
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
    const window = (quotas || []).find((q) => q.provider === provider && hasQuotaData(q))?.windows?.find((w) => w.key === key && !w.extra);
    const resetChanged = goal.end.resetAt && window?.resetsAt && Date.parse(goal.end.resetAt) !== Date.parse(window.resetsAt);
    if (Date.parse(goal.end.at) > now && !resetChanged) continue;
    delete windows[key];
    if (!Object.keys(windows).length) delete policy.pacingGoals[provider];
    cleared.push(`${provider}/${key}`);
  }
  if (cleared.length) {
    writePolicy(policy, { file });
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

const WEEKLY_WINDOW_MINUTES = 10080;
const CODEX_SUCCESSOR_WEEKLY_LIMIT_PERCENT = 85;

// The most percent that each provider has used of its weekly window. Only a live window of at least
// one week counts. An extra window or a window that already reset does not count. A provider without
// such a window stays absent, so an unknown quota never blocks a successor.
export function weeklyUseByProvider(quotas = [], now = Date.now()) {
  const result = {};
  for (const quota of quotas || []) {
    if (!quota || quota.error || typeof quota.provider !== 'string') continue;
    for (const window of quota.windows || []) {
      if (!window || window.extra || !(Number(window.windowMinutes) >= WEEKLY_WINDOW_MINUTES) || !Number.isFinite(window.usedPercent)) continue;
      if (window.resetsAt && !(Date.parse(window.resetsAt) > now)) continue;
      result[quota.provider] = Math.max(result[quota.provider] ?? 0, window.usedPercent);
    }
  }
  return result;
}

// Why the automatic successor selection refuses a target because of the weekly quota. A Codex
// successor is refused above 85 percent weekly use. A Claude successor is refused only at 100 percent.
// The function returns null when the lane stays eligible or when there is no weekly reading.
export function successorQuotaRefusal(provider, weeklyUse) {
  const used = weeklyUse?.[provider];
  if (!Number.isFinite(used)) return null;
  if (provider === 'codex' && used > CODEX_SUCCESSOR_WEEKLY_LIMIT_PERCENT) return `the codex weekly quota is at ${used}%, above the ${CODEX_SUCCESSOR_WEEKLY_LIMIT_PERCENT}% successor limit`;
  if (provider === 'claude' && used >= 100) return `the claude weekly quota is at ${used}%, so no Claude successor can start`;
  return null;
}

// A lane with no weekly reading counts as unused, so a metered lane never wins over an unread one.
function weeklyScore(candidate, weeklyUse) {
  const used = weeklyUse[candidate.provider];
  return Number.isFinite(used) ? used : 0;
}

// The eligible rung with the lowest weekly use, or the first eligible Opus rung when no non-Opus choice
// can start. A rung is skipped when its model is exhausted or the last good Pi result does not list it,
// and when the weekly quota refuses the lane. A provider that weekly use cannot compare keeps the order
// of the ladder, because a stable sort keeps the first rung of a tie.
export function pickSuccessor(project, currentKind, currentProvider, policy, control, now = Date.now()) {
  const weeklyUse = control.weeklyUse || {};
  let opus = null;
  const eligible = [];
  for (const rung of policy.orchestratorLadder || []) {
    const provider = providerFor(rung.kind, rung.model, policy);
    const lane = provider && control.lanes?.[provider];
    const trickleAtLimit = lane?.state === 'trickle' && lane.usedTodayPercent >= lane.allowancePercent;
    if (rung.kind === currentKind || (currentProvider && provider === currentProvider) ||
        !control.globalAllowed[rung.kind]?.includes(rung.model) ||
        project.excludedKinds.includes(rung.kind) || project.excludedModels.includes(rung.model) ||
        (!provider && Number.isFinite(control.exhaustedFreeModels?.[rung.model]?.retryAt) && control.exhaustedFreeModels[rung.model].retryAt > now) ||
        (rung.kind === 'pi' && unavailablePiModels([rung.model], control.piModels).length) ||
        (provider && (control.risks[provider] || control.exhausted?.[provider])) || trickleAtLimit ||
        successorQuotaRefusal(provider, weeklyUse)) continue;
    const candidate = { ...rung, provider: provider || 'unmetered', weeklyUsePercent: weeklyUse[provider] ?? null };
    if (/(^|[-/])opus($|[-.\d]|\[)/i.test(String(rung.model))) {
      opus ||= candidate;
      continue;
    }
    eligible.push(candidate);
  }
  const [best] = eligible.sort((a, b) => weeklyScore(a, weeklyUse) - weeklyScore(b, weeklyUse));
  return best || opus || null;
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

// A stale row is the last good row of a provider whose latest probe failed. Pacing and lanes use it as data.
export const hasQuotaData = (q) => !q?.error || q.stale === true;

// A window whose reset time has passed is unmeasured until the next reading, so its old percentage does not count.
const liveWindow = (w, now) => !w.extra && Number.isFinite(w.usedPercent) && !(w.resetsAt && Date.parse(w.resetsAt) <= now);

function quotaRisk(q, policy, now = Date.now()) {
  if (!hasQuotaData(q)) return null;
  const windows = (q.windows || []).filter((w) => liveWindow(w, now));
  const risk = windows.filter((w) => w.usedPercent >= 100 - policy.reservePercent || (w.willLast === false && w.etaSeconds != null && w.etaSeconds <= policy.handoffLeadMinutes * 60));
  return risk.sort((a, b) => b.usedPercent - a.usedPercent)[0] || null;
}

function quotaExhaustion(q, now = Date.now()) {
  if (!hasQuotaData(q)) return null;
  return (q.windows || []).filter((w) => liveWindow(w, now) && w.usedPercent >= 100)
    .sort((a, b) => (Date.parse(b.resetsAt) || 0) - (Date.parse(a.resetsAt) || 0))[0] || null;
}

// A goal below 100 lowers the expected-use curve, so the window reaches the goal at its reset instead of full quota.
export function pacingGoal(policy, provider, key) {
  const value = policy?.pacingGoals?.[provider]?.[key];
  const percent = isObject(value) ? value.percent : value;
  return Math.min(Number.isInteger(percent) ? percent : 100, policy?.factoryShares?.[provider] ?? 100);
}

export function pacingGoalEnd(policy, provider, window) {
  const end = policy?.pacingGoals?.[provider]?.[window?.key]?.end;
  if (!end || !Number.isFinite(Date.parse(window?.resetsAt))) return null;
  const reset = Date.parse(window.resetsAt);
  return end.type === 'at' ? Date.parse(end.at) : end.type === 'hoursBeforeReset' ? reset - end.hours * 3600000 : null;
}

function formatGoalEnd(end, includeTime = false) {
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(end).replace(',', '');
  if (!includeTime) return date;
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(end);
  return `${date} ${time}`;
}

export function pacingGoalText(goal, now = Date.now()) {
  const end = goal?.resolvedEnd;
  const includeTime = goal?.end?.type === 'at' && Number.isFinite(end) && end > now && end - now <= 48 * 60 * 60 * 1000;
  const by = Number.isFinite(end) ? formatGoalEnd(end, includeTime) : 'reset';
  return `goal: ${goal?.percent ?? 100}% by ${by}`;
}

export function formatPacingGoalEnd(end) {
  return Number.isFinite(end) ? formatGoalEnd(end, true) : 'an unknown time';
}

export function goalSummary(goals, now = Date.now()) {
  return (goals || []).map((goal) => `${String(goal.label).toLowerCase()}: ${goal.text || pacingGoalText(goal, now)}`).join('; ');
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

// The pace tolerance in percentage points and the use below which no window is ahead of pace. Old policy files have neither key.
export const paceTolerancePoints = (policy) => Number.isFinite(policy?.paceTolerancePoints) ? policy.paceTolerancePoints : POLICY_DEFAULTS.paceTolerancePoints;
export const paceMinUsePercent = (policy) => Number.isFinite(policy?.paceMinUsePercent) ? policy.paceMinUsePercent : POLICY_DEFAULTS.paceMinUsePercent;

// A live window below the minimum use is never ahead of pace. A window that will not last to reset is ahead of pace
// when it has no future timed goal end, whatever the tolerance. Otherwise its use must be more than the tolerance
// above the goal-adjusted expected use.
export function aheadOfQuotaPace(policy, provider, window, now = Date.now()) {
  if (!window || window.usedPercent < paceMinUsePercent(policy)) return false;
  const end = pacingGoalEnd(policy, provider, window);
  if ((end == null || end <= now) && window.willLast === false) return true;
  const expected = adjustedExpectedPercent(policy, provider, window, now);
  return expected != null && window.usedPercent > expected + paceTolerancePoints(policy);
}

// How far a window is ahead of pace; without expected use, its usage percentage.
const paceScore = (w, expected) => expected != null ? w.usedPercent - expected : w.usedPercent;

// Any live window that is ahead of pace makes its provider ahead of pace. The lane reports the worst of them.
function quotaPressure(q, policy, now = Date.now()) {
  if (policy.providerModes[q.provider] === 'ignore' || !hasQuotaData(q)) return null;
  return (q.windows || []).filter((w) => liveWindow(w, now) && aheadOfQuotaPace(policy, q.provider, w, now))
    .sort((a, b) => paceScore(b, adjustedExpectedPercent(policy, q.provider, b, now)) - paceScore(a, adjustedExpectedPercent(policy, q.provider, a, now)))[0] || null;
}

const LONG_WINDOW_MINUTES = 7 * 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTA_READING_STALE_MS = 3 * 60 * 60 * 1000;
function quotaObservedAt(quota, readingAt) {
  for (const value of [quota.staleSince, quota.observedAt, quota.updatedAt]) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  const fallback = Number(readingAt);
  return readingAt != null && Number.isFinite(fallback) ? fallback : NaN;
}
const isLongQuotaWindow = (window) => (Number.isFinite(window.windowMinutes) && window.windowMinutes > LONG_WINDOW_MINUTES)
  || /^monthly$/i.test(String(window.label || '').trim());

// One state per metered provider: open, trickle, pace, reserve, exhausted, or unknown.
export function laneStatus(quotas, policy, now = Date.now(), { todayUse = {}, readingAt = null, readings = [] } = {}) {
  const lanes = {};
  for (const source of quotas || []) {
    const measuredAt = quotaObservedAt(source, readingAt);
    const elapsed = source.stale && Number.isFinite(measuredAt) ? Math.max(0, now - measuredAt) : 0;
    const q = source.stale ? {
      ...source,
      windows: (source.windows || []).map((window) => {
        if (window.extra) return window;
        const duration = Number(window.windowMinutes) * 60000;
        const reset = Date.parse(window.resetsAt);
        const start = reset - duration;
        const baseline = Number.isFinite(window.expectedPercent)
          ? window.expectedPercent
          : Number.isFinite(start) && Number.isFinite(measuredAt) && duration > 0
            ? Math.max(0, Math.min(100, (measuredAt - start) / duration * 100))
            : null;
        const expectedPercent = baseline != null && duration > 0
          ? Math.max(0, Math.min(100, baseline + elapsed / duration * 100))
          : baseline;
        return { ...window, expectedPercent, willLast: null, etaSeconds: null, paceSummary: null };
      }),
    } : source;
    const goals = (q.windows || []).filter((w) => !w.extra && Object.hasOwn(policy.pacingGoals?.[q.provider] || {}, w.key)).map((w) => {
      const goal = {
        key: w.key, label: w.label, percent: pacingGoal(policy, q.provider, w.key), end: policy.pacingGoals[q.provider][w.key]?.end || null,
        resolvedEnd: pacingGoalEnd(policy, q.provider, w) ?? Date.parse(w.resetsAt),
      };
      return { ...goal, text: pacingGoalText(goal, now) };
    });
    const resetWindows = (q.windows || []).filter((w) => !w.extra && w.resetsAt && Date.parse(w.resetsAt) <= now).map((w) => w.label);
    if (!hasQuotaData(q)) { lanes[q.provider] = { state: 'unknown', reason: String(q.error).slice(0, 200), resetWindows, goals }; continue; }
    const exhausted = quotaExhaustion(q, now);
    if (exhausted) {
      lanes[q.provider] = { state: 'exhausted', window: exhausted.label, usedPercent: exhausted.usedPercent, resetAt: exhausted.resetsAt || null, resetWindows, goals };
      continue;
    }
    if (policy.providerModes[q.provider] === 'ignore') { lanes[q.provider] = { state: 'open', ignored: true, resetWindows, goals }; continue; }
    const risk = quotaRisk(q, policy, now);
    const liveWindows = (q.windows || []).filter((window) => liveWindow(window, now));
    const pressured = liveWindows.filter((window) => aheadOfQuotaPace(policy, q.provider, window, now));
    const byPressure = (a, b) => paceScore(b, adjustedExpectedPercent(policy, q.provider, b, now))
      - paceScore(a, adjustedExpectedPercent(policy, q.provider, a, now));
    const pressure = pressured.sort(byPressure)[0] || null;
    const shortPressure = pressured.filter((window) => !isLongQuotaWindow(window)).sort(byPressure)[0] || null;
    const longPressure = pressured.filter(isLongQuotaWindow).sort(byPressure)[0] || null;
    const w = risk || pressure;
    if (!w) {
      const rooms = liveWindows.map((window) => {
        const expected = adjustedExpectedPercent(policy, q.provider, window, now);
        return expected == null ? null : { window, expected, room: expected - window.usedPercent };
      }).filter(Boolean);
      const room = rooms.map((entry) => entry.room);
      const tightestRoom = room.length ? Math.min(...room) : null;
      // A window above its expected use but inside the tolerance is on pace. The lanes line shows it.
      const tolerated = rooms.filter((entry) => entry.room < 0).sort((a, b) => a.room - b.room)[0];
      lanes[q.provider] = { state: 'open', roomPercent: tightestRoom == null ? null : Math.max(0, tightestRoom), resetWindows, goals };
      if (tolerated) lanes[q.provider].onPace = { window: tolerated.window.label, usedPercent: tolerated.window.usedPercent, expectedPercent: tolerated.expected, tolerancePoints: paceTolerancePoints(policy) };
      // Every live window below its expected use by more than the tolerance: the lane is far below its pace.
      const below = tightestRoom != null && tightestRoom > paceTolerancePoints(policy)
        ? rooms.slice().sort((a, b) => b.room - a.room)[0] : null;
      if (below) lanes[q.provider].belowPace = { window: below.window.label, usedPercent: below.window.usedPercent, expectedPercent: below.expected, roomPercent: below.room, tolerancePoints: paceTolerancePoints(policy) };
      continue;
    }
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
    if (!risk && !shortPressure && longPressure && Number.isFinite(Date.parse(longPressure.resetsAt))) {
      const resetsAt = Date.parse(w.resetsAt);
      const daysLeft = Math.max(1, (resetsAt - now) / DAY_MS);
      const goalEnd = pacingGoalEnd(policy, q.provider, w);
      const goalPercent = pacingGoal(policy, q.provider, w.key);
      const beforeGoalEnd = Number.isFinite(goalEnd) && goalEnd > now;
      const daysToUse = beforeGoalEnd ? Math.max(1, (goalEnd - now) / DAY_MS) : daysLeft;
      const targetPercent = beforeGoalEnd || goalEnd == null ? goalPercent : 100;
      const allowancePercent = Math.max(0, (targetPercent - w.usedPercent) / daysToUse);
      lanes[q.provider] = {
        state: 'trickle', window: w.label, windowKey: w.key, usedPercent: w.usedPercent, expectedPercent, overPercent,
        allowancePercent, usedTodayPercent: todayUse[q.provider]?.[w.key] ?? 0,
        resetAt: w.resetsAt || null, resetWindows, goals,
      };
      continue;
    }
    lanes[q.provider] = {
      state: risk ? 'reserve' : 'pace', window: w.label, usedPercent: w.usedPercent, expectedPercent,
      overPercent, tolerancePoints: paceTolerancePoints(policy),
      backOnPaceAt: Number.isFinite(backOnPaceMs) ? new Date(backOnPaceMs).toISOString() : null, resetWindows, goals,
    };
  }
  for (const source of quotas || []) {
    const lane = lanes[source.provider];
    if (!lane) continue;
    const factoryShare = policy.factoryShares?.[source.provider];
    if (factoryShare !== undefined) {
      lane.factoryShare = factoryShare;
      lane.factoryShareUsedPercent = Math.max(0, ...(source.windows || []).filter((window) => liveWindow(window, now)).map((window) => window.usedPercent));
      lane.factoryShareBlocked = factoryShare === 0 || lane.factoryShareUsedPercent >= factoryShare;
      if (lane.factoryShareBlocked && lane.state !== 'exhausted') lane.state = 'reserve';
    }
    const hold = source.provider === 'claude' ? claudePaceHold(source, lane, readings, now) : null;
    if (hold) lane.paceHold = hold;
    const window = (source.windows || []).find((item) => item.key === 'primary' && !item.extra)
      || (source.windows || []).find((item) => !item.extra);
    const measuredAt = quotaObservedAt(source, readingAt);
    const ageMs = Number.isFinite(measuredAt) ? Math.max(0, now - measuredAt) : null;
    lane.reading = window ? {
      window: window.label,
      usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
      ageMinutes: ageMs == null ? null : Math.floor(ageMs / 60000),
      stale: ageMs != null && ageMs >= QUOTA_READING_STALE_MS,
      probeFailed: !!source.error,
      observedAt: Number.isFinite(measuredAt) ? new Date(measuredAt).toISOString() : null,
    } : null;
  }
  for (const [provider, share] of Object.entries(policy.factoryShares || {})) if (!lanes[provider]) {
    lanes[provider] = { state: share === 0 ? 'reserve' : 'unknown', factoryShare: share, factoryShareBlocked: share === 0,
      reason: 'No quota reading is available.', resetWindows: [], goals: [] };
  }
  if (policy.factoryShareError) for (const provider of ['codex', 'claude', 'opencodego']) {
    lanes[provider] ||= { state: 'unknown', reason: 'No quota reading is available.', resetWindows: [], goals: [] };
    lanes[provider].factoryShareError = policy.factoryShareError;
  }
  return lanes;
}

const CLAUDE_HOLD_PERCENT = 80;
const CLAUDE_HOLD_MIN_HOURS = 12;

// Claude pace guidance: from 80 percent weekly use with more than 12 hours to the reset, hold new Claude work.
// The guidance changes the lanes line and the bulletin only. The lane state and worker admission stay unchanged.
// projectedAt is the time at which the recent burn reaches 100 percent, or null without a positive burn or after the reset.
function claudePaceHold(source, lane, readings, now) {
  if (lane.state === 'unknown' || lane.state === 'exhausted' || lane.ignored) return null;
  const window = (source.windows || []).find((w) => !w.extra && Number(w.windowMinutes) >= 10080 && liveWindow(w, now));
  const hoursToReset = window ? (Date.parse(window.resetsAt) - now) / 3600000 : NaN;
  if (!window || window.usedPercent < CLAUDE_HOLD_PERCENT || !(hoursToReset > CLAUDE_HOLD_MIN_HOURS)) return null;
  const burn = recentBurn((readings || []).filter((row) => row.provider === 'claude' && row.window === window.key), { now });
  const projection = projectedReach(burn, 100, window.resetsAt);
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    projectedAt: projection?.status === 'projected' ? projection.at : null,
  };
}

// The text of the hold, for the lanes line and the bulletin.
export function claudePaceHoldText(hold) {
  if (!hold || !Number.isFinite(hold.usedPercent)) return '';
  const projection = hold.projectedAt && Number.isFinite(Date.parse(hold.projectedAt)) ? `; 100 percent at ${formatLocalTime(hold.projectedAt)}` : '';
  return `hold new Claude work (${planPercent(hold.usedPercent)}% weekly used${projection})`;
}

const USE_NOW_KINDS = { claude: 'claude', codex: 'codex', opencodego: 'opencode' };

// List the lanes that can take work now: the unmetered lane first, then the metered lanes with the most headroom first.
export function useNowLanes(lanes) {
  const belowPace = [];
  const trickle = [];
  const open = [];
  const ignored = [];
  const free = [];
  for (const [provider, lane] of Object.entries(lanes || {})) {
    if (!lane) continue;
    const entry = { provider, kind: USE_NOW_KINDS[provider] || provider };
    // An ignored lane has no pacing limit, and the unmetered lane costs no quota, so both can take work.
    if (lane.unmetered) {
      if (lane.state === 'open') free.push({ ...entry, reason: 'free models' });
      continue;
    }
    if (lane.ignored) {
      if (lane.state === 'open') ignored.push({ ...entry, reason: 'open, quota ignored' });
      continue;
    }
    if (lane.paceHold) continue;
    if (provider === 'codex' && validPlanGuidance(lane.planGuidance) && lane.state === 'open') {
      if (lane.planGuidance.laneState !== 'Use now') continue;
      const roomPercent = Math.max(0, lane.planGuidance.plannedPercent - lane.planGuidance.usedPercent);
      belowPace.push({ ...entry, roomPercent: Number.isFinite(roomPercent) ? roomPercent : 0, reason: 'below plan' });
      continue;
    }
    if (lane.state === 'open' && Number.isFinite(lane.roomPercent) && lane.roomPercent > 0) {
      belowPace.push({ ...entry, roomPercent: lane.roomPercent, reason: 'below pace' });
    } else if (lane.state === 'trickle') {
      const remaining = lane.allowancePercent - (lane.usedTodayPercent ?? 0);
      if (Number.isFinite(remaining) && remaining > 0) {
        trickle.push({ ...entry, reason: `trickle ${remaining.toFixed(1)}%/day left today` });
      }
    } else if (lane.state === 'open') {
      open.push({ ...entry, reason: 'open' });
    }
  }
  belowPace.sort((a, b) => b.roomPercent - a.roomPercent || a.provider.localeCompare(b.provider));
  return [...free, ...belowPace, ...ignored, ...trickle, ...open].map(({ provider, kind, reason }) => ({ provider, kind, reason }));
}

function creditLabel(index) {
  let value = index + 1, label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

// The plan changes Codex guidance only. Keep laneStatus and worker admission rules unchanged.
export function codexPlanGuidance(plan, tolerance = 5, planMode = 'paced', holdMargin = 0) {
  if (!plan || (!plan.historyAvailable && !(plan.historicalP90 > 0) && !plan.credits?.length)
    || !Number.isFinite(plan.usedPercent) || !Number.isFinite(plan.plannedUsageNow)) return null;
  const difference = plan.usedPercent - plan.plannedUsageNow;
  const mode = planMode === 'burst' ? 'burst' : 'paced';
  // A burst plan is advice only: the lane stays Use now. A paced plan holds when the use is ahead of the curve by more than the tolerance. The hold has hysteresis: the saved guidance state keeps it until the lead falls below the tolerance minus the margin. Use at or below the curve is Use now.
  const enter = tolerance + holdMargin;
  const leave = Math.max(0, tolerance - holdMargin);
  const savedHold = plan.guidance?.state === 'hold';
  const laneState = mode === 'burst' ? 'Use now' : difference > enter || (savedHold && difference >= leave) ? 'hold' : difference > 0 ? 'on pace' : 'Use now';
  const scheduledIndex = (plan.plan?.credits || []).findIndex((credit) => credit.applyAt);
  const scheduledCredit = scheduledIndex >= 0 ? plan.plan.credits[scheduledIndex] : null;
  return {
    laneState,
    planMode: mode,
    usageGuidance: plan.guidance?.state ?? 'unavailable',
    usedPercent: plan.usedPercent,
    plannedPercent: plan.plannedUsageNow,
    differencePoints: difference,
    deviationText: planDeviationText(difference),
    tolerancePoints: tolerance,
    projection: plan.projection ?? null,
    nextCredit: scheduledCredit ? {
      label: creditLabel(scheduledIndex),
      applyAt: scheduledCredit.applyAt,
      usedPercent: scheduledCredit.usedPercent,
    } : null,
  };
}

// A guidance object without a laneState text is no plan.
export function validPlanGuidance(guidance) {
  return guidance && typeof guidance === 'object' && typeof guidance.laneState === 'string' && guidance.laneState ? guidance : null;
}

// Format a percent value for plan text. A value that is not a finite number gives an empty string.
export function planPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(1)).toString();
}

export function quotaPlanLaneText(guidance) {
  if (!validPlanGuidance(guidance)) return '';
  const used = planPercent(guidance.usedPercent);
  const planned = planPercent(guidance.plannedPercent);
  const tolerance = planPercent(guidance.tolerancePoints);
  const parts = [used && `${used}% used`, planned && `${planned}% planned`, guidance.deviationText, tolerance && `tolerance ${tolerance} points`].filter(Boolean);
  return parts.length ? `${guidance.laneState} (${parts.join(', ')})` : guidance.laneState;
}

// When no metered provider is open or under its trickle allowance, the least-over provider that is only ahead of pace may start.
// The unmetered lane is not a metered provider, so it never changes this choice.
export function leastOverProvider(lanes) {
  const metered = Object.entries(lanes).filter(([, lane]) => !lane.unmetered && !lane.factoryShareBlocked && lane.state !== 'unknown' && lane.state !== 'exhausted');
  const usable = (lane) => lane.state === 'open'
    || (lane.state === 'trickle' && lane.usedTodayPercent < lane.allowancePercent);
  if (!metered.length || metered.some(([, lane]) => usable(lane))) return null;
  const pace = metered.filter(([, lane]) => lane.state === 'pace' && lane.overPercent != null).sort((a, b) => a[1].overPercent - b[1].overPercent);
  return pace[0]?.[0] ?? null;
}

// The Pi models that the last good `pi --list-models` result does not list. An unknown result (null) hides nothing.
// The reason is no-credential when Pi lists no row of that provider, and not-listed otherwise.
export function unavailablePiModels(piAllowedModels, piModels) {
  if (!Array.isArray(piModels?.models)) return [];
  const listed = new Set(piModels.models);
  const providers = new Set(piModels.models.map((model) => model.split('/')[0]));
  return (piAllowedModels || []).filter((model) => !listed.has(model)).map((model) => {
    const provider = model.includes('/') ? model.split('/')[0] : null;
    return { model, provider, reason: provider && !providers.has(provider) ? 'no-credential' : 'not-listed' };
  });
}

// One lane that lists every permitted unmetered model that can start, grouped by project and harness.
// A model is unmetered when the configured route and the provider rules give it no metered provider.
// An exhausted model and an unavailable Pi model are left out and reported.
export function unmeteredLane(baseModels, policy, projects = {}, exhaustedModels = {}, { unavailablePiModels: unavailablePi = [], now = Date.now() } = {}) {
  const models = mergeModels(baseModels, policy);
  const byProject = {};
  const applicable = new Map();
  const unavailableEntries = new Map();
  const unavailableByModel = new Map((unavailablePi || []).map((item) => [item.model, item]));
  const projectModes = {};
  const note = (map, key, create, slug) => {
    const entry = map.get(key) || create();
    if (!entry.projects.includes(slug)) entry.projects.push(slug);
    map.set(key, entry);
    return entry;
  };
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
        const missing = kind === 'pi' && unavailableByModel.get(model);
        if (missing) {
          note(unavailableEntries, model, () => ({ kind, model, provider: missing.provider, reason: missing.reason, projects: [] }), slug);
          return false;
        }
        const exhaustion = exhaustedModels[model];
        if (!exhaustion) return true;
        const entry = note(applicable, model, () => ({ model, retryAt: exhaustion.retryAt, projects: [], kinds: [] }), slug);
        entry.retryAt = Math.max(entry.retryAt || 0, exhaustion.retryAt || 0);
        if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
        return false;
      });
      if (available.length) kinds[kind] = available;
    }
    byProject[slug] = kinds;
    projectModes[slug] = mode;
  }
  const exhausted = [...applicable.values()].sort((a, b) => a.model.localeCompare(b.model));
  for (const entry of exhausted) { entry.projects.sort(); entry.kinds.sort(); }
  const unavailable = [...unavailableEntries.values()].sort((a, b) => a.model.localeCompare(b.model));
  for (const entry of unavailable) entry.projects.sort();
  // The lane closes only when models are unavailable and none can start for any project.
  const anyOpen = Object.values(byProject).some((kinds) => Object.keys(kinds).length);
  const state = !anyOpen && (exhausted.length || unavailable.length) ? 'closed' : 'open';
  return { state, unmetered: true, byProject, projectModes, exhausted, unavailable };
}

// One sentence per group of unavailable Pi models.
// A project filter keeps only the parts that apply to that project.
export function unmeteredClosedParts(lane, project = null) {
  const applies = (item) => !project || (item.projects || []).includes(project);
  const parts = [];
  const groups = new Map();
  for (const item of (lane?.unavailable || []).filter(applies)) {
    const key = item.reason === 'no-credential' ? `${item.kind}:${item.provider}` : `${item.kind}:not-listed`;
    const group = groups.get(key) || { ...item, models: [] };
    group.models.push(item.model);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort((a, b) => `${a.kind}:${a.provider}`.localeCompare(`${b.kind}:${b.provider}`))) {
    if (group.reason === 'no-credential') parts.push(`Unmetered ${group.kind} ${group.provider}/ models: unavailable. Pi has no credential for the ${group.provider} provider.`);
    else parts.push(`Unmetered ${group.kind} ${group.models.sort().join(', ')}: unavailable. \`pi --list-models\` does not list ${group.models.length === 1 ? 'it' : 'them'}.`);
  }
  return parts;
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

export function deriveControl(snap, policy, baseModels, paneSince = {}, now = Date.now(), exhaustedFreeModels = {}, {
  piModels = null, lanes = {}, nightMaxWorkers = null,
} = {}) {
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
  const maxWorkers = snap.night?.active === true && nightMaxWorkers != null ? nightMaxWorkers : policy.maxWorkers;
  const base = distribute(maxWorkers, weights);
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
    result[p.slug] = { ...p, ...settings[p.slug], effectiveMode: mode, baseSlots: base[p.slug] || 0, slots: base[p.slug] || 0, lent: 0, offered: 0, borrowed: 0, running: workers.length, idle: isIdle, orch: orch ? { pane: orch.id, kind: orch.agent, status: orch.status, sessionId: orch.sessionId } : null };
  }
  // An idle or paused project lends all its slots. Another project keeps its full base and offers its unused slots without losing them.
  if (policy.borrowIdle) {
    const spare = (p) => (idle.has(p.slug) ? p.baseSlots : Math.max(0, p.baseSlots - p.running));
    const borrowers = Object.values(result).filter((p) => !idle.has(p.slug) && p.running >= p.baseSlots);
    const pool = Object.values(result).reduce((n, p) => n + spare(p), 0);
    if (borrowers.length && pool) {
      const borrowed = distribute(pool, Object.fromEntries(borrowers.map((p) => [p.slug, weights[p.slug] || 1])));
      for (const p of Object.values(result)) {
        if (idle.has(p.slug)) p.lent = p.baseSlots;
        else p.offered = spare(p);
        p.borrowed = borrowed[p.slug] || 0;
        p.slots = p.baseSlots - p.lent + p.borrowed;
      }
    }
  }
  const risks = Object.fromEntries((snap.quotas || []).map((q) => [q.provider, quotaRisk(q, policy, now)]));
  const weeklyUse = weeklyUseByProvider(snap.quotas || [], now);
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
    const preferred = pickSuccessor(p, p.orch.kind, currentProvider, policy, { globalAllowed, risks, exhausted, exhaustedFreeModels, piModels, lanes, weeklyUse }, now);
    handoffs.push({ project: p.slug, workspace: p.workspace, pane: p.orch.pane, fromKind: p.orch.kind, sessionId: p.orch.sessionId, provider: currentProvider, window, target: preferred });
  }
  let bossHandoff = null;
  const bossPane = panes.find((pane) => pane.label === 'boss');
  if (bossPane) {
    const kindConfig = models.kinds[bossPane.agent];
    const currentProvider = kindConfig && providerFor(bossPane.agent, policy.preferredModels?.[bossPane.agent] ?? kindConfig.defaultModel, policy);
    const window = risks[currentProvider] || null;
    const bossProject = { excludedKinds: [], excludedModels: [] };
    const target = kindConfig ? pickSuccessor(bossProject, bossPane.agent, currentProvider, policy, { globalAllowed, risks, exhausted, exhaustedFreeModels, piModels, lanes, weeklyUse }, now) : null;
    bossHandoff = {
      project: 'Boss', label: 'Boss', boss: true, workspace: bossPane.workspace, pane: bossPane.id,
      fromKind: bossPane.agent || null, sessionId: bossPane.agent ? bossPane.sessionId || (bossPane.agent_session?.kind === 'id' ? bossPane.agent_session.value : null) : null,
      provider: currentProvider, window, target,
      ...(!bossPane.agent ? { defaultMode: 'fresh' } : {}),
    };
  }
  return { projects: result, workspaces, runningWorkers: working.length, maxWorkers, globalAllowed, risks, exhausted, pressures, weeklyUse, handoffs, bossHandoff };
}
