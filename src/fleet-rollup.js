const FRESH_SECONDS = 90;
const STATUS_STALE_SECONDS = 2 * 60 * 60;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN_WAIT_STEP = /^login-([a-z][a-z0-9-]{0,31})$/;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isReading = (value) => isNumber(value) && value >= 0;

function validDay(value) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function freshness(row) {
  if (!row?.summary || typeof row.summary !== 'object') return row?.lastSeenAt ? 'unknown' : 'never seen';
  if (!isNumber(row.ageSeconds) || row.ageSeconds < 0) return 'unknown';
  return row.ageSeconds <= FRESH_SECONDS ? 'fresh' : 'cached';
}

function factorySpend(summary, now) {
  if (!summary) return { value: null, day: null, label: null, reason: 'no summary' };
  const rows = Array.isArray(summary.spend) ? summary.spend.filter((row) => row && validDay(row.day)) : [];
  if (!rows.length) return { value: null, day: null, label: null, reason: 'no spend rows' };

  const offset = summary.machine?.utcOffsetMinutes;
  let currentDay = null;
  if (isNumber(offset)) {
    const date = new Date(now + offset * 60_000);
    if (Number.isFinite(date.getTime())) currentDay = date.toISOString().slice(0, 10);
  }

  let dayRows = currentDay ? rows.filter((row) => row.day === currentDay) : [];
  let fallback = !currentDay;
  if (!dayRows.length) {
    const latestDay = rows.reduce((latest, row) => row.day > latest ? row.day : latest, rows[0].day);
    dayRows = rows.filter((row) => row.day === latestDay);
    fallback = true;
  }

  const day = dayRows[0].day;
  const label = fallback ? `latest factory day ${day}` : day;
  const unpriced = dayRows.some((row) => !isReading(row.usd));
  return {
    value: unpriced ? null : dayRows.reduce((total, row) => total + row.usd, 0),
    day,
    label,
    reason: unpriced ? `unpriced spend for ${day}` : null,
  };
}

function factoryQuota(summary) {
  const readings = Array.isArray(summary?.quotas) ? summary.quotas.filter((row) => isNumber(row?.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100) : [];
  if (!readings.length) return null;
  const best = readings.reduce((current, row) => row.usedPercent > current.usedPercent ? row : current);
  return { harness: best.harness, lane: best.lane, usedPercent: best.usedPercent, resetAt: best.resetAt ?? null };
}

// A row with an accountKey belongs to a shared account and may join the fleet dedupe.
// A row with the closed marker is the reading of this factory only and stays out of that total.
function sharedQuotaReadings(summary) {
  return (Array.isArray(summary?.quotas) ? summary.quotas : [])
    .filter((row) => isNumber(row?.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100 && typeof row.accountKey === 'string');
}

function localQuotaReadings(summary) {
  return (Array.isArray(summary?.quotas) ? summary.quotas : [])
    .filter((row) => isNumber(row?.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100 && typeof row.accountKey !== 'string');
}

function unknownQuotaLanes(row) {
  const readings = Array.isArray(row.summary?.quotas) ? row.summary.quotas : [];
  return readings
    .filter((reading) => !isNumber(reading?.usedPercent) || reading.usedPercent < 0 || reading.usedPercent > 100)
    .map((reading) => `${reading.harness ?? 'unknown harness'}/${reading.lane ?? 'unknown lane'}`);
}

function coverageReason(row, metric) {
  if (row.freshness !== 'fresh') return row.freshness;
  if (metric === 'workers') return isReading(row.summary?.workers?.running) ? null : 'workers unknown';
  if (metric === 'spend') return row.spend.reason;
  if (metric === 'quota') {
    if (row.hasQuota) return null;
    const lanes = unknownQuotaLanes(row);
    if (lanes.length) return `quota unknown: ${lanes.join(', ')}`;
    return localQuotaReadings(row.summary).length ? 'this factory only' : 'quota unknown';
  }
  return 'unknown';
}

function coverageLabel(known, rows, metric, dateLabels = []) {
  const unavailable = rows
    .map((row) => ({ name: row.name, reason: coverageReason(row, metric) }))
    .filter((entry) => entry.reason)
    .map((entry) => `${entry.name} (${entry.reason})`);
  const unknownLanes = metric === 'quota'
    ? rows.flatMap((row) => {
      if (row.freshness === 'fresh' && !row.hasQuota) return [];
      return unknownQuotaLanes(row).map((lane) => `${row.name} ${lane}`);
    })
    : [];
  const dates = dateLabels.length ? `; selected spend days: ${dateLabels.join(', ')}` : '';
  const unknown = unknownLanes.length ? `; unknown quota lanes: ${unknownLanes.join(', ')}` : '';
  return `${known.length} of ${rows.length} factories reporting${unavailable.length ? `; unavailable: ${unavailable.join(', ')}` : ''}${unknown}${dates}`;
}

function total(known, rows, metric, value, dateLabels = []) {
  return {
    value: known.length ? value(known) : 'unknown',
    asOf: known.length ? Math.max(...known.map((row) => row.ageSeconds)) : null,
    coverage: coverageLabel(known, rows, metric, dateLabels),
  };
}

// A verified login wait gets the same kind-specific fix as the login alert. An unverified step,
// an unsupported step, or an unknown factory kind gets no fix. The rollup never invents a command.
function waitFix(kind, name, step, harnesses) {
  const match = typeof step === 'string' ? LOGIN_WAIT_STEP.exec(step) : null;
  if (!match) return { harness: null, fix: null, fixKind: null };
  const harness = match[1];
  const expired = (Array.isArray(harnesses) ? harnesses : []).some((login) => login?.harness === harness && login.login === 'expired');
  if (!expired) return { harness, fix: null, fixKind: null };
  if (kind === 'container') return { harness, fix: `herdr-boss factory login ${name} ${harness}`, fixKind: 'command' };
  if (kind === 'native') return { harness, fix: `Sign in ${harness} in a terminal on this Mac.`, fixKind: 'instruction' };
  return { harness, fix: null, fixKind: null };
}

// The wait age comes from the injected now. A missing, invalid, or future since has no age.
function waitSince(since, now) {
  const stamp = typeof since === 'string' ? Date.parse(since) : Number.NaN;
  const valid = Number.isFinite(stamp);
  return { since: valid ? since : null, ageSeconds: valid && now >= stamp ? Math.floor((now - stamp) / 1000) : null };
}

function factoryWaits(row, kind, summary, now) {
  const waits = Array.isArray(summary?.pending) ? summary.pending : [];
  return waits.map((wait) => ({ step: wait?.step ?? null, ...waitSince(wait?.since, now), ...waitFix(kind, row.name, wait?.step, summary?.harnesses) }));
}

function factoryRole(row, role) {
  if (!role || typeof role.headOfficeFactoryId !== 'string') return null;
  const factoryId = row.summary?.factoryId ?? row.factoryId;
  return factoryId === role.headOfficeFactoryId ? 'head-office' : 'factory';
}

function factoryRow(row, role, now) {
  const summary = row.summary && typeof row.summary === 'object' ? row.summary : null;
  const state = freshness(row);
  const spend = factorySpend(summary, now);
  const quota = factoryQuota(summary);
  const needsOwner = summary?.ownerItems?.needsOwner;
  const kind = row.kind ?? summary?.kind ?? null;
  return {
    ...row,
    kind,
    role: factoryRole(row, role),
    health: typeof row.status === 'string' ? row.status : summary?.health?.status ?? 'unknown',
    summaryHealth: summary?.health?.status ?? 'unknown',
    lastSeenAt: row.lastSeenAt ?? null,
    freshness: state,
    workers: isReading(summary?.workers?.running) ? summary.workers.running : null,
    quota,
    spend,
    pending: factoryWaits(row, kind, summary, now),
    projects: Array.isArray(summary?.projects) ? summary.projects.map((project) => ({ ...project, ...(project.board ? { board: { ...project.board } } : {}) })) : [],
    ownerItems: Number.isSafeInteger(needsOwner) && needsOwner >= 0 ? needsOwner : null,
    hasQuota: sharedQuotaReadings(summary).length > 0,
    alerts: [],
  };
}

function alertId(row, suffix) {
  return `${row.summary?.factoryId ?? row.factoryId ?? row.name}:${suffix}`;
}

function addAlert(alerts, row, { suffix, code, severity = 'warning', label, fix, ...details }) {
  alerts.push({ id: alertId(row, suffix), code, severity, factory: row.name, label, fix, ...details });
}

function factoryAlerts(row, alerts) {
  const summary = row.summary;
  const kind = row.kind ?? summary?.kind;
  if (row.status === 'offline' && ['unreachable', 'timeout'].includes(row.error)) {
    addAlert(alerts, row, {
      suffix: 'unreachable', code: 'unreachable', severity: 'error',
      label: `${row.name} is unreachable`,
      fix: kind === 'container' ? `herdr-boss factory connect ${row.name}` : 'Check the native service.',
    });
  } else if (row.error === 'auth') {
    addAlert(alerts, row, {
      suffix: 'read-credential', code: 'read-credential-refused', severity: 'error',
      label: `${row.name} refused the read credential`,
      fix: kind === 'container' ? `herdr-boss factory connect ${row.name}` : 'Check the native service read credential.',
    });
  } else if (row.error === 'contract-mismatch') {
    addAlert(alerts, row, {
      suffix: 'contract-mismatch', code: 'contract-mismatch', severity: 'error',
      label: `${row.name} has a contract mismatch`,
      fix: kind === 'container' ? `herdr-boss factory update ${row.name} --tier service` : 'Run the native service release steps.',
    });
  }

  if (typeof row.drift === 'string' && row.drift.trim()) {
    const fix = row.drift === 'head office older'
      ? 'Update the head office service or code.'
      : kind === 'container'
        ? `herdr-boss factory update ${row.name} --tier service`
        : 'Run the release steps in AGENTS.md.';
    addAlert(alerts, row, {
      suffix: 'kit-drift', code: 'kit-drift', severity: 'warning',
      label: `Factory drift: ${row.drift}`, fix, drift: row.drift,
    });
  }

  for (const login of summary?.harnesses || []) {
    if (login?.login !== 'expired' || typeof login.harness !== 'string') continue;
    addAlert(alerts, row, {
      suffix: `login-expired:${login.harness}`, code: 'login-expired', severity: 'warning',
      label: `${login.harness} login expired on ${row.name}`,
      fix: kind === 'container' ? `herdr-boss factory login ${row.name} ${login.harness}` : `Sign in ${login.harness} in a terminal on this Mac.`,
      harness: login.harness,
    });
  }

  const diskFreePercent = summary?.machine?.diskFreePercent;
  if (isNumber(diskFreePercent) && diskFreePercent < 20) {
    addAlert(alerts, row, {
      suffix: 'disk-low', code: 'disk-low', severity: diskFreePercent < 5 ? 'error' : 'warning',
      label: `Disk space is low on ${row.name} (${diskFreePercent}%)`,
      fix: kind === 'container' ? `herdr-boss factory status ${row.name}` : 'Free disk space on this Mac. Check the data volume with df -h.',
      freePercent: diskFreePercent,
    });
  }

  const offsetSeconds = summary?.health?.clockOffsetSeconds;
  if (isNumber(offsetSeconds) && Math.abs(offsetSeconds) > 30) {
    addAlert(alerts, row, {
      suffix: 'clock-offset', code: 'clock-offset', severity: Math.abs(offsetSeconds) > 300 ? 'error' : 'warning',
      label: `Clock offset ${offsetSeconds} s on ${row.name}`,
      fix: kind === 'container' ? 'Check the clock of the host.' : 'Check Date and Time in System Settings on this Mac.',
      offsetSeconds,
    });
  }

  const projects = Array.isArray(summary?.projects) ? summary.projects : [];
  const staleSlugs = new Set(projects.filter((project) => isNumber(project.statusAgeSeconds) && project.statusAgeSeconds > STATUS_STALE_SECONDS).map((project) => project.slug));
  for (const item of summary?.alerts || []) {
    if (item?.code === 'status-stale' && typeof item.projectSlug === 'string') staleSlugs.add(item.projectSlug);
  }
  for (const projectSlug of staleSlugs) {
    addAlert(alerts, row, {
      suffix: `status-stale:${projectSlug}`, code: 'status-stale', severity: 'warning',
      label: `Status is stale for ${projectSlug}`,
      fix: `Open the ${projectSlug} project page. The orchestrator publishes.`,
      projectSlug,
    });
  }
  const hasFactoryStaleAlert = (summary?.alerts || []).some((item) => item?.code === 'status-stale' && !item.projectSlug);
  if (hasFactoryStaleAlert && staleSlugs.size === 0) {
    addAlert(alerts, row, {
      suffix: 'status-stale:factory', code: 'status-stale', severity: 'warning',
      label: `Project status is stale on ${row.name}`,
      fix: 'Open the project page. The orchestrator publishes.',
    });
  }

}

export function buildFleetRollup(factories, { now, role = null } = {}) {
  const at = typeof now === 'function' ? now() : now;
  if (!isNumber(at)) throw new TypeError('Give the fleet rollup a finite injected now value.');
  const input = Array.isArray(factories) ? factories : [];
  const rows = input.map((row) => factoryRow(row, role, at));

  const knownWorkers = rows.filter((row) => row.freshness === 'fresh' && isReading(row.summary?.workers?.running));
  const knownSpend = rows.filter((row) => row.freshness === 'fresh' && row.spend.value !== null);
  const knownQuotas = rows.filter((row) => row.freshness === 'fresh' && row.hasQuota);
  const spendDateLabels = rows
    .filter((row) => row.freshness === 'fresh' && row.spend.day)
    .map((row) => `${row.name} ${row.spend.label}`);

  const severityOrder = { error: 0, warning: 1, info: 2 };
  for (const row of rows) {
    factoryAlerts(row, row.alerts);
    row.alerts.sort((left, right) => (severityOrder[left.severity] ?? 3) - (severityOrder[right.severity] ?? 3) || left.id.localeCompare(right.id));
  }

  const quotaLanes = new Map();
  for (const row of knownQuotas) {
    for (const reading of row.summary.quotas) {
      if (!isNumber(reading?.usedPercent) || reading.usedPercent < 0 || reading.usedPercent > 100) continue;
      if (typeof reading.accountKey !== 'string') continue;
      const key = `${reading.harness ?? ''}\0${reading.accountKey}\0${reading.lane ?? ''}`;
      const previous = quotaLanes.get(key);
      if (!previous || reading.usedPercent > previous.usedPercent) quotaLanes.set(key, reading);
    }
  }

  return {
    totals: {
      workers: total(knownWorkers, rows, 'workers', (known) => known.reduce((sum, row) => sum + row.workers, 0)),
      spend: total(knownSpend, rows, 'spend', (known) => known.reduce((sum, row) => sum + row.spend.value, 0), spendDateLabels),
      quota: total(knownQuotas, rows, 'quota', () => Math.max(...[...quotaLanes.values()].map((reading) => reading.usedPercent))),
    },
    factories: rows.map(({ hasQuota, ...row }) => row),
  };
}
