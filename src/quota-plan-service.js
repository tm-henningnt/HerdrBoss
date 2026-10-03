import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { burstTable, detectedReset, dropExplainsCreditUse, hourlyBurnP90, planQuota, plannedUsageAt, usageGuidance } from './quota-plan.js';
import { newId } from './message-store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 14;
const PLAN_HISTORY_LIMIT = 50;
const EVENT_HISTORY_LIMIT = 250;
const DEFAULT_SETTINGS = Object.freeze({ burstPace: 1, applyThreshold: 95, margin: 0, horizon: 'last-expiry', tolerance: 5, slowFactor: 0.5 });

function time(value, label = 'time') {
  const result = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a valid time.`);
  return result;
}

function iso(value, label = 'time') {
  return new Date(time(value, label)).toISOString();
}

function emptyState() {
  return { schema: 1, announcements: [], observedResets: [], usedCredits: [], plans: [], current: null };
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.schema !== 1 || !Array.isArray(value.announcements) || !Array.isArray(value.observedResets)
      || !Array.isArray(value.usedCredits) || !Array.isArray(value.plans)) {
      throw new Error('quota-plan.json has an unsupported shape.');
    }
    return { ...emptyState(), ...value };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    if (error instanceof SyntaxError) throw new Error('quota-plan.json must contain valid JSON.');
    throw error;
  }
}

function writeState(file, state) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.quota-plan.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readQuotaRows(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    return Array.isArray(state.quotas) ? state.quotas : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function readHistory(file, now) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const start = now - HISTORY_DAYS * DAY;
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line) return [];
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row.at);
      return Number.isFinite(at) && at >= start && at <= now ? [row] : [];
    } catch { return []; }
  });
}

function assertProvider(provider) {
  if (provider !== 'codex') throw new Error(`Only codex is supported now. Provider ${String(provider || '(missing)')} is not available.`);
}

function findWindow(row) {
  const windows = (row?.windows || []).filter((window) => window && !window.extra && Number.isFinite(window.usedPercent)
    && typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt)));
  return windows.toSorted((a, b) => (b.windowMinutes || 0) - (a.windowMinutes || 0))[0]
    || windows.find((window) => window.key === 'primary')
    || null;
}

function normalizedCredits(row, usedCredits, now) {
  const usedIds = new Set(usedCredits.map((credit) => credit.id));
  const records = Array.isArray(row?.codexResetCredits) ? row.codexResetCredits : [];
  return records.flatMap((credit, index) => {
    if (!credit || credit.status !== 'available') return [];
    const id = typeof credit.id === 'string' && credit.id.trim() ? credit.id : `credit-${index + 1}`;
    const expiresAt = credit.expiresAt ?? credit.expires_at;
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now || usedIds.has(id)) return [];
    return [{ id, status: 'available', expires_at: iso(expiresAt, 'credit expiry'), ...(credit.grantedAt || credit.granted_at ? { granted_at: iso(credit.grantedAt ?? credit.granted_at, 'credit grant time') } : {}) }];
  });
}

function creditMailboxItem(item, provider, id) {
  return item?.thread === 'boss' && item.to === 'owner' && item.action === 'approve'
    && item.quotaCreditProvider === provider && item.quotaCreditId === id;
}

function openCreditMailboxItems(messageStore, provider, id) {
  if (!messageStore) return [];
  return messageStore.all().filter((item) => creditMailboxItem(item, provider, id) && !item.closedAt);
}

function closeCreditMailboxItems(messageStore, provider, id, now) {
  const at = new Date(now).toISOString();
  for (const item of openCreditMailboxItems(messageStore, provider, id)) {
    messageStore.update(item.id, { closedAt: at, readAt: item.readAt || at }, { now });
  }
}

function markCreditUsed(state, provider, id, now) {
  if (state.usedCredits.some((credit) => credit.provider === provider && credit.id === id)) return;
  state.usedCredits.push({ provider, id, usedAt: new Date(now).toISOString() });
  state.usedCredits = state.usedCredits.slice(-EVENT_HISTORY_LIMIT);
}

function earliestExpiringCredit(credits) {
  return [...credits].sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at))[0] || null;
}

function signedPoints(value) {
  const points = Math.round(value * 10) / 10;
  return `${points > 0 ? '+' : ''}${points}`;
}

function creditPromptText({ credit, built, view, now }) {
  const creditInput = { ...built.input, credits: [built.input.credits.find((item) => item.id === credit.id)], horizon: view.horizon };
  const waitingPlan = planQuota(creditInput);
  const immediatePlan = planQuota({ ...creditInput, credits: [], announcedResets: [
    ...(creditInput.announcedResets || []), { at: new Date(now).toISOString(), kind: 'full' },
  ] });
  const fastValue = immediatePlan.fast.totalConsumed - waitingPlan.fast.totalConsumed;
  const slowValue = immediatePlan.slow.totalConsumed - waitingPlan.slow.totalConsumed;
  const waitingAt = waitingPlan.credits[0]?.applyAt || 'no planned application time';
  return [
    `Codex reset credit ${credit.id} is ready at ${built.window.usedPercent}% usage.`,
    `Time: ${new Date(now).toISOString()}.`,
    `Value of applying now against waiting for ${waitingAt}: ${signedPoints(fastValue)} quota points in the fast plan and ${signedPoints(slowValue)} in the slow plan by ${view.horizon}.`,
    `Exact expiry: ${credit.expiresAt}.`,
    'Apply the credit in the Codex app. Herdr Boss does not apply credits.',
  ].join('\n');
}

function postDueCreditPrompts(messageStore, provider, built, view, now) {
  if (!messageStore) return;
  const threshold = view.plan.applyThreshold;
  for (const credit of view.credits) {
    const expiry = Date.parse(credit.expiresAt);
    const plannedAt = Date.parse(credit.applyAt);
    const dueByPlan = built.window.usedPercent >= threshold && Number.isFinite(plannedAt) && plannedAt <= now;
    const expiringSoon = expiry > now && expiry - now <= 48 * HOUR;
    if (!dueByPlan && !expiringSoon) continue;
    // The check and the append share one transaction. An item of any state for this ID and expiry suppresses a new one.
    messageStore.mutate((records) => {
      const posted = records.some((item) => creditMailboxItem(item, provider, credit.id)
        && Date.parse(item.quotaCreditExpiresAt) === expiry);
      if (!posted) {
        records.push({
          id: newId(now), at: new Date(now).toISOString(), thread: 'boss', from: 'boss', to: 'owner', kind: 'reply',
          text: creditPromptText({ credit, built, view, now }), action: 'approve', replyTo: null, status: 'new',
          sentAt: null, error: null, relayedAt: null, relayedBy: null,
          quotaCreditProvider: provider, quotaCreditId: credit.id, quotaCreditExpiresAt: credit.expiresAt,
        });
      }
      return { records, result: null };
    }, { now });
  }
}

function quotaCreditExpiryNotices(state, now) {
  const current = state.current;
  if (current?.provider !== 'codex') return [];
  return (current.credits || []).flatMap((credit) => {
    const expiresAt = Date.parse(credit.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > DAY) return [];
    return [{
      key: `quota-plan:expiry:${credit.id}:${credit.expiresAt}`,
      severity: 'warn', scope: 'user', once: true,
      title: 'Codex reset credit expires within 24 hours',
      text: `Codex reset credit ${credit.id} expires at ${credit.expiresAt}. Apply it in the Codex app before then if you want to use it. Herdr Boss does not apply credits.`,
    }];
  });
}

function validSettings(settings) {
  const result = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const ranged = [
    ['burstPace', 0.1, 10], ['applyThreshold', 50, 100], ['margin', 0, 50],
    ['tolerance', 0, 50], ['slowFactor', 0.1, 1],
  ];
  for (const [key, min, max] of ranged) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max) {
      throw new Error(`quotaPlan.${key} must be a number from ${min} to ${max}.`);
    }
  }
  if (result.applyThreshold % 1 !== 0) throw new Error('quotaPlan.applyThreshold must be a whole number from 50 to 100.');
  if (result.horizon !== 'last-expiry') {
    if (typeof result.horizon !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(result.horizon) || !Number.isFinite(Date.parse(result.horizon))) {
      throw new Error('quotaPlan.horizon must be last-expiry or an ISO time.');
    }
  }
  return result;
}

function buildInput({ provider, quotas, now, settings, state, burstPace, horizon, whatIf }) {
  assertProvider(provider);
  const currentTime = time(now, 'now');
  const row = (quotas || []).find((item) => item.provider === provider && !item.error);
  const window = findWindow(row);
  if (!window) throw new Error('No current Codex quota window is available. Run a quota tick and try again.');
  const readings = readHistory(path.join(state.dataDir, 'quota-history.jsonl'), currentTime)
    .filter((reading) => reading.provider === provider && reading.window === window.key);
  const historicalP90 = hourlyBurnP90(readings, { now: currentTime, provider, window: window.key });
  const availableCredits = normalizedCredits(row, state.usedCredits, currentTime);
  const activeAnnouncements = state.announcements.filter((event) => event.provider === provider && Date.parse(event.at) > currentTime);
  const effectiveHorizon = horizon ?? (settings.horizon === 'last-expiry' ? undefined : settings.horizon);
  const effectivePace = burstPace ?? settings.burstPace;
  if (typeof effectivePace !== 'number' || !Number.isFinite(effectivePace) || effectivePace < 0.1 || effectivePace > 10) {
    throw new Error('--burst-pace must be a number from 0.1 to 10.');
  }
  const input = {
    now: currentTime,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowHours: Number.isFinite(window.windowMinutes) && window.windowMinutes > 0 ? window.windowMinutes / 60 : 168,
    credits: availableCredits,
    burstPace: effectivePace,
    slowBurnRate: effectivePace * settings.slowFactor,
    applyThreshold: settings.applyThreshold,
    margin: settings.margin,
    horizon: effectiveHorizon,
    announcedResets: activeAnnouncements.map(({ at, kind, refundPercent }) => ({ at, kind, refundPercent })),
    ...(whatIf ? { whatIf } : {}),
  };
  const digestInput = {
    provider, usedPercent: input.usedPercent, resetsAt: input.resetsAt, windowHours: input.windowHours,
    credits: input.credits, historicalP90, burstPace: input.burstPace, slowBurnRate: input.slowBurnRate,
    applyThreshold: input.applyThreshold, margin: input.margin, horizon: input.horizon ?? 'last-expiry',
    announcedResets: input.announcedResets, whatIf: input.whatIf ?? null,
    usedCredits: state.usedCredits, settings: { tolerance: settings.tolerance },
  };
  const inputsDigest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  return { input, inputsDigest, historicalP90, historyAvailable: readings.length > 0, availableCredits, row, window, currentTime };
}

function addPlan(state, view) {
  state.plans.push({
    at: view.at,
    inputsDigest: view.inputsDigest,
    creditTimes: view.plan.credits.map((credit) => credit.applyAt),
  });
  state.plans = state.plans.slice(-PLAN_HISTORY_LIMIT);
  state.current = view;
}

function calculate(options, built = buildInput(options)) {
  const existing = options.state.current;
  if (existing?.inputsDigest === built.inputsDigest && !options.force && typeof existing.historyAvailable === 'boolean') {
    const plannedUsageNow = plannedUsageAt(existing.plan, built.currentTime);
    return { ...existing, now: new Date(built.currentTime).toISOString(), plannedUsageNow, skipped: true };
  }
  const plan = planQuota(built.input);
  const table = burstTable(built.input);
  const atNow = new Date(built.currentTime).toISOString();
  const view = {
    provider: options.provider,
    at: atNow,
    now: atNow,
    usedPercent: built.window.usedPercent,
    resetsAt: built.window.resetsAt,
    windowHours: built.input.windowHours,
    horizon: plan.horizon,
    inputsDigest: built.inputsDigest,
    historicalP90: built.historicalP90,
    historyAvailable: built.historyAvailable,
    plannedUsageNow: plannedUsageAt(plan, built.currentTime),
    guidance: usageGuidance(plan, built.currentTime, built.window.usedPercent, options.settings.tolerance),
    credits: plan.credits,
    plan,
    burstTable: table,
    announcements: options.state.announcements.filter((item) => item.provider === options.provider),
    observedResets: options.state.observedResets.filter((item) => item.provider === options.provider),
    usedCredits: options.state.usedCredits.filter((item) => item.provider === options.provider),
  };
  return view;
}

function observeReset(state, { provider, row, window, currentTime, dataDir }) {
  const history = readHistory(path.join(dataDir, 'quota-history.jsonl'), currentTime)
    .filter((item) => item.provider === provider && item.window === window.key)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (history.length < 2) return null;
  const before = history.at(-2), after = history.at(-1);
  if (!detectedReset(before, after) || state.observedResets.some((item) => item.provider === provider && item.afterAt === after.at)) return null;
  const cause = dropExplainsCreditUse(before, after) ? 'credit' : 'natural';
  state.observedResets.push({
    id: randomUUID(), provider, window: window.key, at: after.at, afterAt: after.at,
    beforeUsedPercent: before.usedPercent, afterUsedPercent: after.usedPercent,
    dropPercent: before.usedPercent - after.usedPercent, cause,
  });
  state.observedResets = state.observedResets.slice(-EVENT_HISTORY_LIMIT);
  return cause;
}

function validateAnnouncement({ provider, at, kind = 'full', refundPercent = 0, now }) {
  assertProvider(provider);
  const currentTime = time(now, 'now');
  const resetAt = time(at, 'announced reset time');
  if (resetAt <= currentTime) throw new Error('An announced reset time must be in the future.');
  if (resetAt > currentTime + 30 * DAY) throw new Error('An announced reset time must be within 30 days.');
  if (!['full', 'partial'].includes(kind)) throw new Error('Reset kind must be full or partial.');
  if (typeof refundPercent !== 'number' || !Number.isFinite(refundPercent) || refundPercent < 0 || refundPercent > 100) {
    throw new Error('Refund must be a number from 0 to 100.');
  }
  return { id: randomUUID(), provider, at: new Date(resetAt).toISOString(), kind, ...(kind === 'partial' ? { refundPercent } : {}), createdAt: new Date(currentTime).toISOString() };
}

export function createQuotaPlanService({ dataDir = DATA_DIR, settings = DEFAULT_SETTINGS, now: clock = () => Date.now(), messageStore = null } = {}) {
  const directory = path.resolve(dataDir);
  const file = path.join(directory, 'quota-plan.json');
  let normalizedSettings = validSettings(settings);
  const loadQuotas = () => readQuotaRows(directory);
  const loadState = () => readState(file);
  const persistCalculated = ({ provider, quotas, now, burstPace, horizon, whatIf, force = false }, {
    nextState = null, save = true,
  } = {}) => {
    const current = loadState();
    const state = nextState || current;
    const currentTime = time(now ?? clock(), 'now');
    const row = (quotas || loadQuotas()).find((item) => item.provider === provider && !item.error);
    const window = findWindow(row);
    const observedCause = window ? observeReset(state, { provider, row, window, currentTime, dataDir: directory }) : null;
    const changedByObservation = observedCause !== null;
    if (observedCause === 'credit') {
      const credit = earliestExpiringCredit(normalizedCredits(row, state.usedCredits, currentTime));
      if (credit) {
        markCreditUsed(state, provider, credit.id, currentTime);
        closeCreditMailboxItems(messageStore, provider, credit.id, currentTime);
      }
    }
    const calculationOptions = { provider, quotas: quotas || loadQuotas(), now: currentTime, settings: normalizedSettings,
      state: { ...state, dataDir: directory }, burstPace, horizon, whatIf, force: force || changedByObservation };
    const built = buildInput(calculationOptions);
    const view = calculate(calculationOptions, built);
    if (!view.skipped) addPlan(state, view);
    else if (changedByObservation) state.current = { ...view, skipped: undefined };
    if (save && (!view.skipped || changedByObservation || nextState)) writeState(file, state);
    if (save) postDueCreditPrompts(messageStore, provider, built, view, currentTime);
    const summary = { ...view };
    delete summary.skipped;
    return summary;
  };

  return {
    file,
    configure(nextSettings = {}) { normalizedSettings = validSettings(nextSettings); },
    read: () => loadState(),
    readQuotas: loadQuotas,
    replan(options = {}) {
      const provider = options.provider ?? 'codex';
      assertProvider(provider);
      return persistCalculated({ ...options, provider }, { save: true });
    },
    preview(options = {}) {
      const provider = options.provider ?? 'codex';
      assertProvider(provider);
      return persistCalculated({ ...options, provider }, { save: false });
    },
    get({ provider = 'codex', now = clock() } = {}) {
      assertProvider(provider);
      const state = loadState();
      const current = state.current?.provider === provider ? state.current : null;
      if (!current) return { provider, at: null, now: iso(now), usedPercent: null, resetsAt: null, windowHours: null, horizon: null, inputsDigest: null, historicalP90: 0, historyAvailable: false, plannedUsageNow: null, guidance: null, credits: [], plan: null, burstTable: [], announcements: state.announcements.filter((item) => item.provider === provider), observedResets: state.observedResets.filter((item) => item.provider === provider), usedCredits: state.usedCredits.filter((item) => item.provider === provider) };
      const currentTime = time(now, 'now');
      return {
        ...current,
        now: iso(currentTime),
        plannedUsageNow: plannedUsageAt(current.plan, currentTime),
        guidance: usageGuidance(current.plan, currentTime, current.usedPercent, normalizedSettings.tolerance),
      };
    },
    expiryNotices({ now = clock() } = {}) {
      return quotaCreditExpiryNotices(loadState(), time(now, 'now'));
    },
    summary({ provider = 'codex', now = clock() } = {}) {
      const view = this.get({ provider, now });
      const hasPlan = view.historyAvailable || view.historicalP90 > 0 || view.credits.length > 0;
      const nextCreditAt = hasPlan ? view.plan?.credits?.find((credit) => credit.applyAt)?.applyAt ?? null : null;
      return {
        nextCreditAt,
        state: hasPlan && view.guidance ? view.guidance.state : 'unavailable',
        plannedUsageNow: hasPlan ? view.plannedUsageNow : null,
      };
    },
    announce({ provider = 'codex', at, kind = 'full', refundPercent = 0, now = clock(), quotas } = {}) {
      const announcement = validateAnnouncement({ provider, at, kind, refundPercent, now });
      const state = loadState();
      state.announcements.push(announcement);
      state.announcements = state.announcements.slice(-EVENT_HISTORY_LIMIT);
      const view = persistCalculated({ provider, quotas, now, force: true }, { nextState: state, save: true });
      return { ...announcement, plan: view };
    },
    removeAnnouncement({ provider = 'codex', id, now = clock(), quotas } = {}) {
      assertProvider(provider);
      const state = loadState();
      const before = state.announcements.length;
      state.announcements = state.announcements.filter((item) => !(item.provider === provider && item.id === id));
      if (state.announcements.length === before) throw new Error('No announced reset has that ID.');
      const view = persistCalculated({ provider, quotas, now, force: true }, { nextState: state, save: true });
      return view;
    },
    markCreditUsed({ provider = 'codex', id, now = clock(), quotas } = {}) {
      assertProvider(provider);
      if (typeof id !== 'string' || !id.trim()) throw new Error('A credit ID is required.');
      const currentQuotas = quotas || loadQuotas();
      const row = currentQuotas.find((item) => item.provider === provider && !item.error);
      const currentTime = time(now, 'used time');
      const found = normalizedCredits(row, [], currentTime).some((credit) => credit.id === id)
        || openCreditMailboxItems(messageStore, provider, id).length > 0;
      if (!found) throw new Error(`No available credit has ID ${id}.`);
      const state = loadState();
      markCreditUsed(state, provider, id, currentTime);
      closeCreditMailboxItems(messageStore, provider, id, currentTime);
      return persistCalculated({ provider, quotas: currentQuotas, now: currentTime, force: true }, { nextState: state, save: true });
    },
  };
}

export { DEFAULT_SETTINGS as QUOTA_PLAN_DEFAULTS };
