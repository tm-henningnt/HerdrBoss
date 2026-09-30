import fs from 'node:fs';

// The swap refusal is an option that is off by default (policy machine.swapRefuseEnabled).
// It never applies to a shell outside Herdr or to the boss pane. rules.json older than this never refuses.
export const SWAP_RULES_MAX_AGE_MS = 3 * 60 * 1000;
export const SWAP_FORCE_ENV = 'HERDR_BOSS_FORCE_SWAP';

function clock(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

// Returns the refusal text, or null when nothing refuses. `override` names the way to override for the calling command.
export function swapRefusal(rules, { now = Date.now(), override = '' } = {}) {
  const machine = rules?.machine;
  if (!machine || machine.swapRefuseEnabled !== true) return null;
  const { swapPercent, swapUsedGB, swapRefusePercent } = machine;
  if (!Number.isFinite(swapRefusePercent) || !Number.isFinite(swapPercent) || !Number.isFinite(swapUsedGB)) return null;
  const updated = Date.parse(rules.updatedAt ?? '');
  if (!Number.isFinite(updated) || clock(now) - updated > SWAP_RULES_MAX_AGE_MS) return null;
  const minUsedGB = Number.isFinite(machine.swapMinUsedGB) ? machine.swapMinUsedGB : 0;
  if (swapPercent < swapRefusePercent || swapUsedGB < minUsedGB) return null;
  return `Swap refusal: swap is at ${Math.round(swapPercent)}% (${swapUsedGB.toFixed(1)} GB used). The refusal starts at ${swapRefusePercent}% with at least ${minUsedGB} GB used. Close finished workers and their browsers, or turn off "Refuse new work at high swap" in Settings, Machine (machine.swapRefuseEnabled). ${override}`.trim();
}

// A shell outside Herdr is Owner work. The boss pane is Boss work. A pane that Herdr cannot read does not refuse.
export function swapExempt(env, herdr) {
  if (env?.[SWAP_FORCE_ENV] === '1') return true;
  const paneId = env?.HERDR_PANE_ID;
  if (!paneId) return true;
  try {
    const response = herdr(['pane', 'get', paneId]);
    return (response?.pane ?? response)?.label === 'boss';
  } catch {
    return true;
  }
}

// Used by suite and push, which read rules.json themselves.
export function swapGuardFor(rulesFile, { env, herdr, now, override }) {
  if (!rulesFile) return null;
  let rules;
  try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch { return null; }
  const text = swapRefusal(rules, { now, override });
  return text && !swapExempt(env, herdr) ? text : null;
}
