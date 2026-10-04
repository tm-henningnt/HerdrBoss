const HOUR = 3600000;
const EPSILON = 1e-9;

function time(value, name) {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || Math.abs(result) > 8.64e15) throw new TypeError(`${name} must be a valid time.`);
  return result;
}

function number(value, name, min, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} is outside its range.`);
  return value;
}

function inputs(input) {
  const now = time(input.now, 'now');
  const windowHours = number(input.windowHours ?? 168, 'windowHours', Number.MIN_VALUE);
  const usedPercent = number(input.usedPercent, 'usedPercent', 0, 100);
  const reset = (time(input.resetsAt, 'resetsAt') - now) / HOUR;
  if (reset < 0) throw new RangeError('resetsAt must not precede now.');
  const credits = (input.credits ?? []).map((credit, index) => ({ ...credit, id: credit.id ?? `credit-${index + 1}` }))
    .filter((credit) => !credit.status || credit.status === 'available' || credit.status === 'banked')
    .map((credit) => ({ id: credit.id, expiry: (time(credit.expires_at ?? credit.expiresAt, 'credit expiry') - now) / HOUR,
      notBefore: credit.notBefore == null ? 0 : Math.max(0, (time(credit.notBefore, 'notBefore') - now) / HOUR) }))
    .filter((credit) => credit.expiry >= 0)
    .sort((a, b) => a.expiry - b.expiry || String(a.id).localeCompare(String(b.id), 'en'));
  if (new Set(credits.map((credit) => credit.id)).size !== credits.length) throw new TypeError('Credit ids must be unique.');
  const horizon = input.horizon == null ? (credits.at(-1)?.expiry ?? windowHours) : (time(input.horizon, 'horizon') - now) / HOUR;
  number(horizon, 'horizon', 0);
  const rate = number(input.burstPace ?? input.maxBurnRate ?? 1, 'burstPace', 0);
  const announced = [...(input.announcedResets ?? []), ...(input.whatIf ? [input.whatIf] : [])].map((reset) => {
    const kind = reset.kind ?? 'full';
    if (!['full', 'partial'].includes(kind)) throw new TypeError('Reset kind must be full or partial.');
    return { at: (time(reset.at, 'reset at') - now) / HOUR, kind,
      refundPercent: kind === 'partial' ? number(reset.refundPercent, 'refundPercent', 0, 100) : 100 };
  }).filter((reset) => reset.at >= 0 && reset.at <= horizon).sort((a, b) => a.at - b.at);
  if (credits.some((credit) => credit.notBefore > credit.expiry)) throw new RangeError('notBefore must not follow expiry.');
  return { now, windowHours, usedPercent, reset, credits, horizon, rate, announced };
}

const iso = (config, hours) => new Date(config.now + hours * HOUR).toISOString();

// Calculate exhaustion events at a constant rate. Do not search credit times.
export function calculateExhaustionPlan(input) {
  const config = inputs(input);
  if (config.announced.length || input.targetPace != null) throw new RangeError('Use planQuota for resets or a target pace.');
  const { horizon, windowHours, rate } = config;
  let t = 0, used = config.usedPercent, next = config.reset, index = 0, total = 0;
  const credits = [], resets = [], windows = [];
  let window;
  const point = () => ({ at: iso(config, t), usedPercent: used, totalConsumed: total });
  const open = (reason) => {
    window = { startAt: iso(config, t), endAt: null, resetsAt: iso(config, next), startReason: reason, points: [point()] };
    windows.push(window);
  };
  open('current');
  while (t < horizon - EPSILON) {
    const exhaustion = rate > 0 ? t + (100 - used) / rate : Infinity;
    const credit = config.credits[index];
    const apply = credit && exhaustion < next - EPSILON && exhaustion <= horizon ? exhaustion : Infinity;
    if (apply < (credit?.notBefore ?? 0)) throw new RangeError('A credit has a hold time. Use planQuota.');
    if (credit && credit.expiry < Math.min(apply, next, horizon) - EPSILON) {
      throw new RangeError('A credit expires before exhaustion. Use planQuota.');
    }
    if (apply > (credit?.expiry ?? Infinity) + EPSILON) {
      if (credit?.expiry <= Math.min(next, horizon)) throw new RangeError('A credit expires before exhaustion. Use planQuota.');
    }
    const end = Math.min(apply, next, horizon);
    const burn = Math.min(100 - used, rate * (end - t));
    // Add an exhaustion point before an idle interval.
    if (exhaustion > t && exhaustion < end) {
      window.points.push({ at: iso(config, exhaustion), usedPercent: 100, totalConsumed: total + 100 - used });
    }
    used += burn; total += burn; t = end;
    window.points.push(point());
    window.endAt = iso(config, t);
    if (end === next) {
      used = 0; next += windowHours;
      resets.push({ at: iso(config, t), kind: 'natural', nextResetAt: iso(config, next) });
      open('natural');
    } else if (end === apply) {
      credits.push({ id: credit.id, expiresAt: iso(config, credit.expiry), applyAt: iso(config, t), usedPercent: used, reason: 'exhaustion' });
      used = 0; next = t + windowHours; index++;
      resets.push({ at: iso(config, t), kind: 'credit', creditId: credit.id, nextResetAt: iso(config, next) });
      open('credit');
    }
  }
  window.endAt = iso(config, horizon);
  return { method: 'exact', burnRate: rate, horizon: iso(config, horizon), credits, resets, windows,
    totalConsumed: total, idleHours: rate > 0 ? Math.max(0, horizon - total / rate) : horizon };
}

// Return two demand scenarios. The caller supplies the current time.
export function planQuota(input) {
  const config = inputs(input);
  const margin = number(input.margin ?? 5, 'margin', 0, 100);
  config.threshold = Math.min(number(input.applyThreshold ?? 100 - margin, 'applyThreshold', 0, 100), 100 - margin);
  const slow = number(input.slowBurnRate ?? config.rate * 0.5, 'slowBurnRate', 0, config.rate);
  config.targetPace = input.targetPace == null ? Infinity : number(input.targetPace, 'targetPace', 0);
  const scenario = (rate) => {
    const cfg = { ...config, rate };
    const baseline = render(cfg, [], 'natural');
    let best = cfg.credits.every((credit) => credit.expiry > cfg.horizon)
      ? { times: [], total: baseline.totalConsumed, method: 'natural' } : null;
    if (!cfg.announced.length && input.targetPace == null && !cfg.credits.some((credit) => credit.notBefore > 0)) {
      try {
        const times = burstTimes(cfg);
        const candidate = { times, total: score(cfg, times), method: 'exact' };
        if (betterSchedule(candidate, best)) best = candidate;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    const searched = search(cfg);
    const candidate = { times: searched, total: score(cfg, searched), method: 'search' };
    if (betterSchedule(candidate, best)) best = candidate;
    const { times, method } = best;
    const plan = render(cfg, times, method);
    const prefix = initial(cfg);
    plan.credits = cfg.credits.map((credit, index) => {
      const bounds = timingBounds(cfg, prefix, credit);
      const applied = plan.credits[index];
      if (applied) { advance(cfg, prefix, times[index]); applyCredit(cfg, prefix); }
      return { id: credit.id, expiresAt: iso(cfg, credit.expiry), applyAt: null, usedPercent: null, reason: null,
        ...applied, ...bounds, bestAt: applied?.applyAt ?? null };
    });
    return { ...plan, baseline, gain: plan.totalConsumed - baseline.totalConsumed };
  };
  const fast = scenario(config.rate), slowPlan = scenario(slow);
  return { ...fast, now: iso(config, 0), horizon: iso(config, config.horizon), applyThreshold: config.threshold, margin,
    burstPace: config.rate, fast, slow: slowPlan };
}

function naturalRate(config, state) {
  return Math.min(config.targetPace, state.next > state.t ? (100 - state.used) / (state.next - state.t) : 100 / config.windowHours);
}

function initial(config, phase = 'burst') {
  const state = { t: 0, used: config.usedPercent, next: config.reset, total: 0, idle: 0, announcedIndex: 0, phase, rate: config.rate };
  if (phase === 'natural') state.rate = naturalRate(config, state);
  return state;
}

// Advance to an event time. Process regular resets before a credit at that time.
function advance(config, state, end, record) {
  if (!record && end < state.next && !(config.announced[state.announcedIndex]?.at <= end)) {
    const burn = Math.min(Math.max(0, (state.phase === 'burst' ? config.threshold : 100) - state.used), state.rate * (end - state.t));
    state.total += burn; state.used += burn; state.t = end;
    return;
  }
  while (state.t < end || state.next <= end || config.announced[state.announcedIndex]?.at <= end) {
    const announced = config.announced[state.announcedIndex];
    const edge = Math.min(end, state.next, announced?.at ?? Infinity);
    const capacity = Math.max(0, (state.phase === 'burst' ? config.threshold : 100) - state.used);
    const duration = edge - state.t;
    const burn = Math.min(capacity, state.rate * duration);
    const before = record ? { ...state } : null;
    if (record) state.idle += state.rate > 0 ? duration - burn / state.rate : duration;
    state.total += burn; state.used += burn; state.t = edge;
    if (record) record('burn', before, state);
    if (edge === state.next) {
      state.used = 0; state.next += config.windowHours;
      if (state.phase === 'natural') state.rate = naturalRate(config, state);
      if (record) record('natural', null, state);
    }
    if (edge === announced?.at) {
      state.announcedIndex++;
      state.used = Math.max(0, state.used - announced.refundPercent);
      if (announced.kind === 'full') state.next = state.t + config.windowHours;
      if (state.phase === 'natural') state.rate = naturalRate(config, state);
      if (record) record(announced.kind, announced, state);
    }
    if (edge === end && state.next > end && !(config.announced[state.announcedIndex]?.at <= end)) break;
  }
}

function applyCredit(config, state) {
  state.used = 0; state.next = state.t + config.windowHours;
}

function eligible(config, state, credit) {
  return state.t >= credit.notBefore - EPSILON && state.t <= credit.expiry + EPSILON &&
    (state.used >= config.threshold - EPSILON || Math.abs(state.t - credit.expiry) <= EPSILON);
}

function laterTimes(times, previous, length = Math.max(times.length, previous.length)) {
  for (let index = 0; index < length; index++) {
    const current = times[index] ?? Infinity, old = previous[index] ?? Infinity;
    if (Math.abs(current - old) > EPSILON) return current > old;
  }
  return false;
}

// Keep optional credits when not applying gives the same consumption.
function betterSchedule(candidate, previous) {
  if (!Number.isFinite(candidate.total)) return false;
  if (!previous || candidate.total > previous.total + EPSILON) return true;
  return Math.abs(candidate.total - previous.total) <= EPSILON && laterTimes(candidate.times, previous.times);
}

function render(config, times, method) {
  const state = initial(config, times.length ? 'burst' : 'natural'), windows = [], credits = [], resets = [];
  const point = (sample = state) => ({ at: iso(config, sample.t), usedPercent: sample.used, totalConsumed: sample.total, phase: sample.phase });
  let window;
  const open = (reason) => {
    window = { startAt: iso(config, state.t), endAt: iso(config, state.t), resetsAt: iso(config, state.next), startReason: reason, points: [point()] };
    windows.push(window);
  };
  open('current');
  const record = (kind, before, after) => {
    if (kind === 'burn') {
      const cap = before.phase === 'burst' ? config.threshold : 100;
      const exhaustion = before.rate > 0 ? before.t + Math.max(0, cap - before.used) / before.rate : Infinity;
      if (exhaustion > before.t && exhaustion < after.t) {
        window.points.push(point({ t: exhaustion, used: Math.max(cap, before.used), total: before.total + Math.max(0, cap - before.used), phase: before.phase }));
      }
      window.points.push(point()); window.endAt = iso(config, state.t);
    } else {
      resets.push({ at: iso(config, state.t), kind, nextResetAt: iso(config, state.next), ...(kind === 'partial' ? { refundPercent: before.refundPercent } : {}) });
      if (kind === 'partial') window.points.push(point());
      else open(kind);
    }
  };
  for (let index = 0; index < times.length; index++) {
    advance(config, state, times[index], record);
    const credit = config.credits[index];
    if (!eligible(config, state, credit)) throw new RangeError('The credit schedule is not valid.');
    credits.push({ id: credit.id, expiresAt: iso(config, credit.expiry), applyAt: iso(config, state.t), usedPercent: state.used,
      reason: state.used < config.threshold - EPSILON ? 'expiry' : state.used >= 100 - EPSILON ? 'exhaustion' : 'threshold' });
    applyCredit(config, state);
    if (index === times.length - 1) { state.phase = 'natural'; state.rate = naturalRate(config, state); }
    resets.push({ at: iso(config, state.t), kind: 'credit', creditId: credit.id, nextResetAt: iso(config, state.next) });
    open('credit');
  }
  advance(config, state, config.horizon, record);
  window.endAt = iso(config, config.horizon);
  return { method, burnRate: config.rate, horizon: iso(config, config.horizon), credits, resets, windows,
    curve: windows.flatMap((window) => window.points), totalConsumed: state.total, idleHours: Math.max(0, state.idle) };
}

// Each credit makes the future state depend only on its application time.
// Keep the prefix with the most consumption for each time on the grid.
function search(config) {
  let frontier = [{ state: initial(config), times: [] }];
  const leaders = [];
  for (let index = 0; index <= config.credits.length; index++) {
    if (!config.credits[index] || config.credits[index].expiry > config.horizon) {
      for (const node of frontier) {
        const end = { ...node.state, phase: 'natural' }; end.rate = naturalRate(config, end); advance(config, end, config.horizon);
        const candidate = { total: end.total, times: node.times };
        keepLeader(leaders, candidate);
      }
    }
    const credit = config.credits[index];
    if (!credit) break;
    const limit = Math.min(credit.expiry, config.horizon);
    const grid = [];
    for (let hour = 0; hour <= limit; hour++) grid.push(hour);
    grid.push(limit, credit.notBefore);
    const base = [...new Set(grid.filter((hour) => hour <= limit))].sort((a, b) => a - b);
    const next = new Map();
    for (const node of frontier) {
      const state = { ...node.state };
      // After the last credit, a constant natural pace makes a plateau time
      // inferior to its threshold event. Keep event candidates for that case.
      const finalConstantPace = index === config.credits.length - 1 && state.announcedIndex === config.announced.length;
      const hours = finalConstantPace ? [] : base;
      let events = criticalTimes(config, state, limit, finalConstantPace && config.targetPace === 0);
      events.push(credit.notBefore);
      events.push(...events.map((event) => event + 1).filter((event) => event <= limit));
      events = events.filter((event) => event <= limit);
      events.sort((a, b) => a - b);
      let hourIndex = lowerBound(hours, Math.max(state.t, credit.notBefore));
      let eventIndex = lowerBound(events, Math.max(state.t, credit.notBefore)), last = -Infinity;
      while (hourIndex < hours.length || eventIndex < events.length) {
        // A below-threshold interval cannot contain an eligible application.
        if (state.used < config.threshold - EPSILON && state.t < limit) {
          const crossing = state.rate > 0 ? state.t + (config.threshold - state.used) / state.rate : Infinity;
          const jump = Math.min(crossing, state.next, config.announced[state.announcedIndex]?.at ?? Infinity, credit.expiry, limit);
          if (jump > state.t + EPSILON) {
            advance(config, state, jump);
            hourIndex = Math.max(hourIndex, lowerBound(hours, jump - EPSILON));
            eventIndex = Math.max(eventIndex, lowerBound(events, jump - EPSILON));
          }
        }
        let candidate = Math.min(hours[hourIndex] ?? Infinity, events[eventIndex] ?? Infinity);
        if (!Number.isFinite(candidate)) break;
        if (candidate === hours[hourIndex]) hourIndex++;
        if (candidate === events[eventIndex]) eventIndex++;
        if (candidate - last <= EPSILON) continue;
        last = candidate;
        if (candidate < state.t - EPSILON || candidate < credit.notBefore) continue;
        candidate = Math.max(candidate, state.t);
        advance(config, state, candidate);
        if (!eligible(config, state, credit)) continue;
        const key = Math.round(candidate / EPSILON);
        const previous = next.get(key);
        if (previous && previous.state.total > state.total + EPSILON) continue;
        if (previous && Math.abs(previous.state.total - state.total) <= EPSILON && !laterTimes(node.times, previous.times, node.times.length)) continue;
        const times = [...node.times, candidate];
        const reset = { ...state }; applyCredit(config, reset);
        next.set(key, { state: reset, times });
      }
    }
    frontier = [...next.values()];
  }
  let best = null;
  for (const leader of leaders) {
    const times = refine(config, leader.times), candidate = { times, total: score(config, times) };
    if (betterSchedule(candidate, best)) best = candidate;
  }
  return best?.times ?? [];
}

function lowerBound(values, minimum) {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < minimum) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Refine the four best retained schedules.
function keepLeader(leaders, candidate) {
  const position = leaders.findIndex((leader) => betterSchedule(candidate, leader));
  if (position === -1) { if (leaders.length < 4) leaders.push(candidate); }
  else leaders.splice(position, 0, candidate);
  if (leaders.length > 4) leaders.pop();
}

function score(config, times) {
  const state = initial(config);
  for (let index = 0; index < times.length; index++) {
    if (times[index] < state.t || times[index] > config.horizon) return -Infinity;
    advance(config, state, times[index]);
    if (!eligible(config, state, config.credits[index])) return -Infinity;
    applyCredit(config, state);
  }
  state.phase = 'natural'; state.rate = naturalRate(config, state);
  advance(config, state, config.horizon);
  return state.total;
}

// Refine near the best grid times. Include exact threshold events.
function refine(config, schedule) {
  let times = schedule.slice(), total = score(config, times);
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < times.length; index++) {
      const prefix = initial(config);
      for (let i = 0; i < index; i++) { advance(config, prefix, times[i]); applyCredit(config, prefix); }
      const credit = config.credits[index];
      const low = Math.max(prefix.t, credit.notBefore, times[index] - 1);
      const high = Math.min(credit.expiry, config.horizon, times[index] + 1, times[index + 1] ?? Infinity);
      const candidates = criticalTimes(config, prefix, high).filter((t) => t >= low);
      for (let minute = Math.ceil(low * 60); minute <= high * 60; minute++) candidates.push(minute / 60);
      for (const candidate of candidates.sort((a, b) => a - b)) {
        const trial = times.slice(); trial[index] = candidate;
        const value = score(config, trial);
        if (betterSchedule({ total: value, times: trial }, { total, times })) { times = trial; total = value; }
      }
    }
  }
  return times;
}

function criticalTimes(config, prefix, limit, beforeResets = true) {
  const state = { ...prefix }, result = [state.t, limit];
  while (state.t < limit) {
    const edge = Math.min(limit, state.next, config.announced[state.announcedIndex]?.at ?? Infinity);
    if (state.rate > 0) {
      const crossing = state.t + Math.max(0, config.threshold - state.used) / state.rate;
      if (crossing <= edge) result.push(crossing);
    }
    if (beforeResets && (edge === state.next || edge === config.announced[state.announcedIndex]?.at)) result.push(Math.max(state.t, edge - 1 / HOUR));
    result.push(edge);
    advance(config, state, edge);
  }
  return result;
}

function burstTimes(config) {
  const state = initial(config), times = [];
  for (const credit of config.credits) {
    while (state.t < config.horizon) {
      const exhaustion = state.rate > 0 ? state.t + Math.max(0, config.threshold - state.used) / state.rate : Infinity;
      if (credit.expiry < Math.min(exhaustion, state.next, config.horizon)) throw new RangeError('Search is needed before expiry.');
      if (exhaustion < state.next && exhaustion <= config.horizon && exhaustion <= credit.expiry) {
        advance(config, state, exhaustion); times.push(exhaustion); applyCredit(config, state); break;
      }
      advance(config, state, Math.min(state.next, config.horizon));
    }
  }
  if (config.credits.slice(times.length).some((credit) => credit.expiry <= config.horizon)) {
    throw new RangeError('Search is needed at expiry.');
  }
  return times;
}

// Read the curve at the given time. At a reset, use the point after the reset.
export function plannedUsageAt(plan, at) {
  const points = plan.curve ?? plan.fast?.curve;
  if (!Array.isArray(points) || !points.length) throw new TypeError('The plan must contain a curve.');
  const requested = time(at, 'time');
  let previous = points[0];
  for (const point of points) {
    const current = time(point.at, 'curve time');
    if (current <= requested) { previous = point; continue; }
    const start = time(previous.at, 'curve time');
    if (requested <= start) return previous.usedPercent;
    return previous.usedPercent + (point.usedPercent - previous.usedPercent) * (requested - start) / (current - start);
  }
  return previous.usedPercent;
}

// The plan gives guidance only. It cannot refuse a worker start.
// The hold state has hysteresis. It enters at the tolerance plus the margin and leaves below the tolerance minus the margin.
// The caller passes the last state in `previous`. Read the `quotaPlan.holdMargin` setting for the margin.
export function usageGuidance(plan, at, usedPercent, tolerance = 5, { margin = 0, previous = null } = {}) {
  number(usedPercent, 'usedPercent', 0, 100);
  number(tolerance, 'tolerance', 0, 100);
  number(margin, 'margin', 0, 100);
  const plannedPercent = plannedUsageAt(plan, at);
  const difference = usedPercent - plannedPercent;
  const enter = tolerance + margin;
  const leave = Math.max(0, tolerance - margin);
  // A saved hold stays until the lead falls below the leave value. A lead below the spend boundary is a spend.
  const state = difference > enter ? 'hold'
    : previous === 'hold' && difference >= leave ? 'hold'
      : difference < -enter ? 'spend' : 'normal';
  return { plannedPercent, difference, state };
}

// Compare burst settings through the last available credit expiry.
export function burstTable(input, paces = [0.8, 1.0, 1.2, 1.5, 2.0]) {
  const config = inputs(input);
  const horizon = iso(config, config.credits.at(-1)?.expiry ?? config.horizon);
  return paces.map((burstPace) => {
    const plan = planQuota({ ...input, horizon, burstPace, slowBurnRate: undefined });
    return { burstPace, totalConsumedByLastExpiry: plan.totalConsumed, gainAgainstNoCredits: plan.gain,
      creditTimes: plan.credits.map((credit) => credit.applyAt).filter(Boolean) };
  });
}

export function detectedReset(before, after) {
  if (!before || !after || before.provider !== after.provider || before.window !== after.window) return false;
  if (!Number.isFinite(before.usedPercent) || !Number.isFinite(after.usedPercent) || before.usedPercent < 0 || before.usedPercent > 100 || after.usedPercent < 0 || after.usedPercent > 100) return false;
  const first = typeof before.at === 'number' ? before.at : Date.parse(before.at);
  const last = typeof after.at === 'number' ? after.at : Date.parse(after.at);
  return Number.isFinite(first) && Number.isFinite(last) && last > first && before.usedPercent - after.usedPercent > 30;
}

// A drop explains a credit use only before the regular reset time of the earlier reading.
// A drop at or after that time, less the tolerance, is a natural weekly reset.
export function dropExplainsCreditUse(before, after, toleranceMinutes = 10) {
  const regularReset = Date.parse(before?.resetsAt);
  if (!Number.isFinite(regularReset)) return true;
  const sampled = typeof after.at === 'number' ? after.at : Date.parse(after.at);
  return sampled < regularReset - toleranceMinutes * 60000;
}

// Calculate rates in UTC hourly buckets. Include measured idle intervals.
export function hourlyBurnP90(readings, { now, provider, window } = {}) {
  const end = time(now, 'now'), start = end - 14 * 24 * HOUR;
  const rows = readings.filter((row) => (provider == null || row.provider === provider) && (window == null || row.window === window))
    .map((row) => ({ ...row, time: typeof row.at === 'number' ? row.at : Date.parse(row.at) }))
    .filter((row) => Number.isFinite(row.time) && row.time <= end && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100)
    .sort((a, b) => a.time - b.time);
  if (new Set(rows.map((row) => JSON.stringify([row.provider, row.window]))).size > 1) throw new TypeError('Select one provider and window.');
  const buckets = new Map();
  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1], after = rows[index];
    const delta = after.usedPercent - before.usedPercent;
    if (after.time <= before.time || after.time <= start || delta < 0) continue;
    if (before.resetsAt != null && after.resetsAt != null && Date.parse(before.resetsAt) !== Date.parse(after.resetsAt)) continue;
    const rate = delta / ((after.time - before.time) / HOUR);
    let cursor = Math.max(start, before.time);
    while (cursor < after.time) {
      const hour = Math.floor(cursor / HOUR), edge = Math.min(after.time, (hour + 1) * HOUR);
      const duration = (edge - cursor) / HOUR;
      const bucket = buckets.get(hour) ?? { increase: 0, duration: 0 };
      bucket.increase += rate * duration; bucket.duration += duration;
      buckets.set(hour, bucket); cursor = edge;
    }
  }
  const rates = [...buckets.values()].map((bucket) => bucket.increase / bucket.duration).sort((a, b) => a - b);
  return rates.length ? rates[Math.ceil(rates.length * 0.9) - 1] : 0;
}

function timingBounds(config, prefix, credit) {
  const limit = Math.min(credit.expiry, config.horizon);
  if (prefix.t > limit) return { earliestAt: null, latestAt: null };
  const candidates = criticalTimes(config, prefix, limit).concat(credit.notBefore).filter((t) => t >= prefix.t && t <= limit).sort((a, b) => a - b);
  const state = { ...prefix };
  let earliest = null, latest = null;
  for (const candidate of candidates) {
    advance(config, state, candidate);
    if (!eligible(config, state, credit)) continue;
    earliest ??= candidate; latest = candidate;
  }
  return { earliestAt: earliest == null ? null : iso(config, earliest), latestAt: latest == null ? null : iso(config, latest) };
}

const rowTime = (row) => (typeof row.at === 'number' ? row.at : Date.parse(row.at));

// Measure the recent real burn from the readings of the last hours. A reset or a new reset time starts a new run.
// Return null with fewer than two readings in the run or without a positive rate.
export function recentBurn(readings, { now, hours = 24 } = {}) {
  const end = time(now, 'now'), start = end - hours * HOUR;
  const rows = (readings || []).map((row) => ({ ...row, time: rowTime(row) }))
    .filter((row) => Number.isFinite(row.time) && row.time >= start && row.time <= end && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100)
    .sort((a, b) => a.time - b.time);
  let first = 0;
  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1], after = rows[index];
    const dropped = detectedReset({ ...before, at: before.time }, { ...after, at: after.time });
    const moved = before.resetsAt != null && after.resetsAt != null && Math.abs(Date.parse(before.resetsAt) - Date.parse(after.resetsAt)) > 10 * 60000;
    if (dropped || moved) first = index;
  }
  const run = rows.slice(first);
  if (run.length < 2) return null;
  const head = run[0], tail = run.at(-1);
  const elapsed = (tail.time - head.time) / HOUR;
  const ratePerHour = elapsed > 0 ? (tail.usedPercent - head.usedPercent) / elapsed : 0;
  if (!(ratePerHour > EPSILON)) return null;
  return { ratePerHour, readings: run.length, from: new Date(head.time).toISOString(), to: new Date(tail.time).toISOString(), usedPercent: tail.usedPercent };
}

// Project the time at which the recent burn reaches the target percent.
// Status `reached`: the last reading is at or above the target. No time is given.
// Status `after-reset`: the projected time follows the window reset. Status `projected`: the time is before the reset.
export function projectedReach(burn, targetPercent, resetsAt) {
  if (!burn || !(burn.ratePerHour > 0)) return null;
  const base = { ratePerHour: burn.ratePerHour, readings: burn.readings, targetPercent };
  if (burn.usedPercent >= targetPercent) return { ...base, status: 'reached' };
  const reading = time(burn.to, 'reading time');
  const at = reading + (targetPercent - burn.usedPercent) / burn.ratePerHour * HOUR;
  const reset = resetsAt == null ? NaN : Date.parse(resetsAt);
  return { ...base, status: Number.isFinite(reset) && at > reset ? 'after-reset' : 'projected', at: new Date(at).toISOString() };
}

// Format a time as weekday, day, month and local time, for example "Sun 4 Oct 03:00".
export function formatLocalTime(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(time(value, 'time'))).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

// Describe the distance of the actual use from the planned curve in points.
export function planDeviationText(difference) {
  if (!Number.isFinite(difference)) return '';
  const points = Math.round(Math.abs(difference) * 10) / 10;
  if (points === 0) return 'on plan';
  return `${difference > 0 ? 'ahead of plan' : 'behind plan'} by ${points} points`;
}

export function projectionText(projection) {
  if (!projection || !Number.isFinite(projection.targetPercent) || !Number.isFinite(projection.ratePerHour)) return '';
  if (projection.status === 'reached') return `already at or above ${projection.targetPercent} percent`;
  if (!Number.isFinite(Date.parse(projection.at))) return '';
  if (projection.status === 'after-reset') return `at this rate: ${projection.targetPercent} percent not before the window reset`;
  return `at this rate: ${projection.targetPercent} percent about ${formatLocalTime(projection.at)}`;
}
