// The local usage estimate of OpenCode Go. OpenCode Go has no usage source, so the estimate is tokens and cost from
// `opencode stats` in this factory. It is never a percent and never a quota.
export const ESTIMATE_LABEL = 'used in this factory (local estimate)';

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function compactTokens(value) {
  if (value >= 999_950_000) return `${(value / 1e9).toFixed(1)}b`;
  if (value >= 999_950) return `${(value / 1e6).toFixed(1)}m`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function usageEstimateText(estimate) {
  if (!estimate || !isCount(estimate.tokens) || !isCount(estimate.days) || !Number.isFinite(estimate.costUsd)) return null;
  if (estimate.tokens === 0 && estimate.costUsd === 0) return `no local use found in the last ${estimate.days} day${estimate.days === 1 ? '' : 's'}`;
  const more = isCount(estimate.omittedModels) && estimate.omittedModels > 0 ? ` (${estimate.omittedModels} more model${estimate.omittedModels === 1 ? '' : 's'} not counted)` : '';
  return `${compactTokens(estimate.tokens)} tokens, $${estimate.costUsd.toFixed(2)} in the last ${estimate.days} day${estimate.days === 1 ? '' : 's'}${more}`;
}

// The detail lines under an unknown usage limit: the reset time that the Owner set by hand and the local estimate.
// `esc` escapes text for HTML. `time` formats an ISO time.
export function unknownQuotaDetailHtml(row, esc, time) {
  const text = usageEstimateText(row?.estimate);
  const reset = typeof row?.resetAt === 'string' && row.resetAt ? `<div class="muted">Resets ${esc(time(row.resetAt))} (set by hand).</div>` : '';
  if (!text && !reset) return '';
  const models = Array.isArray(row.estimate?.models) && row.estimate.models.length
    ? `<div class="muted small">${row.estimate.models.map((m) => `${esc(m.model)} ${esc(compactTokens(m.tokens))}`).join(' · ')}</div>` : '';
  return `${reset}${text ? `<div class="muted" data-usage-estimate><b>${esc(ESTIMATE_LABEL)}:</b> ${esc(text)}.</div>${models}` : ''}`;
}
