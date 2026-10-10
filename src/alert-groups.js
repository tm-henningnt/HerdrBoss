const INFO_ALERT_TTL_MS = 24 * 60 * 60 * 1000;

function alertKey(alert) {
  const key = typeof alert.key === 'string' ? alert.key : '';
  const disk = key.match(/^machine:disk:[^:]+:(?:warn|critical)$/);
  return disk ? 'machine:disk' : key || `${alert.kind || 'alert'}:${alert.subject || 'unknown'}`;
}

function timeValue(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTime(now) {
  return new Date(now).toISOString();
}

function expired(firstAt, now) {
  const first = timeValue(firstAt);
  return first == null || now - first >= INFO_ALERT_TTL_MS;
}

export function aggregateAlerts(alerts, previous = {}, now = Date.now()) {
  const groups = new Map();
  for (const alert of alerts || []) {
    const key = alertKey(alert);
    const group = groups.get(key) || [];
    group.push(alert);
    groups.set(key, group);
  }

  const state = {};
  const rows = [];
  for (const [key, group] of groups) {
    const latest = group.at(-1);
    const old = previous[key];
    if (latest.severity === 'info') {
      if (old?.expired && old.present) {
        state[key] = { ...old, present: true };
        continue;
      }
      const newEpisode = !old || !old.present;
      const firstAt = newEpisode ? isoTime(now) : old.firstAt;
      const record = {
        ...latest,
        key,
        count: (newEpisode ? 0 : old.count || 0) + group.length,
        firstAt,
        lastAt: isoTime(now),
        present: true,
        expired: expired(firstAt, now),
      };
      state[key] = record;
      if (!record.expired) rows.push(record);
      continue;
    }

    const record = {
      ...latest,
      key,
      count: (old?.count || 0) + group.length,
      firstAt: old?.firstAt || isoTime(now),
      lastAt: isoTime(now),
    };
    state[key] = record;
    rows.push(record);
  }

  for (const [key, old] of Object.entries(previous)) {
    if (groups.has(key) || old.severity !== 'info' || expired(old.firstAt, now)) continue;
    state[key] = { ...old, present: false };
    rows.push(state[key]);
  }

  return { alerts: rows, state };
}
