import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFleetRollup } from '../src/fleet-rollup.js';

const now = Date.parse('2026-10-05T01:00:00Z');
const today = '2026-10-05';
const accountKey = 'a'.repeat(64);

function summary(name, overrides = {}) {
  return {
    schema: 1,
    contractVersion: '1.0.0',
    factoryId: name,
    name,
    kind: name === 'factory-zero' ? 'native' : 'container',
    generatedAt: '2026-10-05T00:59:00Z',
    health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: null },
    machine: { diskFreePercent: 50, utcOffsetMinutes: 0 },
    workers: { running: 0, max: 8 },
    harnesses: [],
    pending: [],
    projects: [],
    quotas: [],
    spend: [],
    alerts: [],
    ownerItems: { total: 0, needsOwner: 0, rows: [] },
    reviewPacks: [],
    ...overrides,
  };
}

function factory(name, options = {}) {
  const { summary: body = summary(name), ageSeconds = 20, ...fields } = options;
  return {
    name,
    factoryId: name,
    kind: body?.kind ?? (name === 'factory-zero' ? 'native' : 'container'),
    status: body ? 'healthy' : 'offline',
    error: null,
    drift: null,
    ageSeconds: body ? ageSeconds : null,
    lastSeenAt: body ? '2026-10-05T00:59:00Z' : null,
    summary: body,
    ...fields,
  };
}

function rollup(factories, options = {}) {
  return buildFleetRollup(factories, { now, role: { headOfficeFactoryId: 'factory-zero', epoch: 4 }, ...options });
}

function allAlerts(result) {
  return result.factories.flatMap((row) => row.alerts);
}

function assertUnknownTotals(totals, coverage) {
  for (const metric of ['workers', 'spend', 'quota']) {
    assert.equal(totals[metric].value, 'unknown', `${metric} value`);
    assert.equal(totals[metric].asOf, null, `${metric} asOf`);
    assert.match(totals[metric].coverage, new RegExp(coverage), `${metric} coverage`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('totals use fresh known readings and label cached, unknown, and unpriced coverage', () => {
  const rows = [
    factory('factory-zero', {
      ageSeconds: 15,
      summary: summary('factory-zero', {
        workers: { running: 4, max: 8 },
        spend: [{ day: today, role: 'worker', harness: 'codex', usd: 1.25 }],
        quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 40, status: 'ok' }],
      }),
    }),
    factory('win1', {
      ageSeconds: 120,
      summary: summary('win1', {
        workers: { running: 80, max: 100 },
        spend: [{ day: today, role: 'worker', harness: 'codex', usd: 100 }],
        quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 90, status: 'ok' }],
      }),
    }),
    factory('win2', {
      ageSeconds: 45,
      summary: summary('win2', {
        workers: { running: null, max: 8 },
        spend: [{ day: today, role: 'worker', harness: 'codex', usd: null }],
        quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: null, status: 'unknown' }],
      }),
    }),
  ];

  const { totals } = rollup(rows);
  assert.equal(totals.workers.value, 4);
  assert.equal(totals.workers.asOf, 15);
  assert.match(totals.workers.coverage, /1 of 3 factories reporting/);
  assert.match(totals.workers.coverage, /win1 \(cached\)/);
  assert.match(totals.workers.coverage, /win2 \(workers unknown\)/);
  assert.equal(totals.spend.value, 1.25);
  assert.match(totals.spend.coverage, /1 of 3 factories reporting/);
  assert.match(totals.spend.coverage, /win2 \(unpriced spend for 2026-10-05\)/);
  assert.equal(totals.quota.value, 40);
  assert.equal(totals.quota.asOf, 15);
  assert.match(totals.quota.coverage, /1 of 3 factories reporting/);
  assert.match(totals.quota.coverage, /win2 \(quota unknown: codex\/weekly\)/);
});

test('an empty fleet has unknown totals and no contributing factories', () => {
  const totals = rollup([]).totals;
  assertUnknownTotals(totals, '^0 of 0 factories reporting$');
});

test('cached-only inputs have unknown totals and no contributing factories', () => {
  const row = factory('win1', {
    ageSeconds: 91,
    summary: summary('win1', {
      workers: { running: 7, max: 8 },
      spend: [{ day: today, role: 'worker', harness: 'codex', usd: 12.5 }],
      quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 65, status: 'ok' }],
    }),
  });

  const totals = rollup([row]).totals;
  assertUnknownTotals(totals, '^0 of 1 factories reporting');
  for (const metric of ['workers', 'spend', 'quota']) assert.match(totals[metric].coverage, /win1 \(cached\)/);
});

test('fresh unknown readings have unknown totals and no contributing factories', () => {
  const row = factory('factory-zero', {
    summary: summary('factory-zero', {
      workers: { running: null, max: 8 },
      spend: [{ day: today, role: 'worker', harness: 'codex', usd: null }],
      quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: null, status: 'unknown' }],
    }),
  });

  const totals = rollup([row]).totals;
  assertUnknownTotals(totals, '^0 of 1 factories reporting');
  assert.match(totals.workers.coverage, /factory-zero \(workers unknown\)/);
  assert.match(totals.spend.coverage, /factory-zero \(unpriced spend for 2026-10-05\)/);
  assert.match(totals.quota.coverage, /factory-zero \(quota unknown: codex\/weekly\)/);
});

test('known zero readings stay numeric zero for workers, spend, and quota', () => {
  const row = factory('factory-zero', {
    ageSeconds: 25,
    summary: summary('factory-zero', {
      workers: { running: 0, max: 8 },
      spend: [{ day: today, role: 'worker', harness: 'codex', usd: 0 }],
      quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 0, status: 'ok' }],
    }),
  });

  const totals = rollup([row]).totals;
  for (const metric of ['workers', 'spend', 'quota']) {
    assert.equal(totals[metric].value, 0, `${metric} value`);
    assert.equal(totals[metric].asOf, 25, `${metric} asOf`);
    assert.match(totals[metric].coverage, /^1 of 1 factories reporting/);
  }
});

test('the rollup does not mutate a deeply frozen summary, poller row, or options', () => {
  const row = factory('factory-zero', {
    summary: summary('factory-zero', {
      pending: [{ step: 'login-claude', since: '2026-10-04T08:00:00Z' }],
      projects: [{ slug: 'sample-project', phase: 'build', status: 'doing', statusAgeSeconds: 100, board: { doing: 2, review: 1, blocked: 0, done7d: 3 } }],
      quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 41, status: 'ok' }, { harness: 'codex', accountKey, lane: 'daily', usedPercent: null, status: 'unknown' }],
      spend: [{ day: today, role: 'worker', harness: 'codex', usd: 1.25 }],
      ownerItems: { total: 1, needsOwner: 1, rows: [{ id: 'item-one', kind: 'decide' }] },
      reviewPacks: [{ id: 'pack-one', waitingItems: 3 }],
    }),
  });
  const rows = [row];
  const options = { now, role: { headOfficeFactoryId: 'factory-zero', epoch: 4 } };
  const beforeRows = structuredClone(rows);
  const beforeOptions = structuredClone(options);
  deepFreeze(rows);
  deepFreeze(options);

  const first = buildFleetRollup(rows, options);
  const second = buildFleetRollup(rows, options);
  assert.deepEqual(rows, beforeRows);
  assert.deepEqual(options, beforeOptions);
  assert.deepEqual(second, first);
});

test('spend uses the factory calendar and carries latest factory days into the fleet label', () => {
  const rows = [
    factory('factory-zero', {
      ageSeconds: 30,
      summary: summary('factory-zero', {
        machine: { diskFreePercent: 50, utcOffsetMinutes: -120 },
        spend: [
          { day: '2026-10-04', role: 'worker', harness: 'codex', usd: 2.25 },
          { day: '2026-10-05', role: 'worker', harness: 'codex', usd: 99 },
        ],
      }),
    }),
    factory('win1', {
      ageSeconds: 50,
      summary: summary('win1', {
        machine: { diskFreePercent: 50, utcOffsetMinutes: null },
        spend: [
          { day: '2026-10-02', role: 'worker', harness: 'codex', usd: 10 },
          { day: '2026-10-03', role: 'worker', harness: 'codex', usd: 3.75 },
        ],
      }),
    }),
  ];

  const result = rollup(rows);
  assert.equal(result.factories[0].spend.day, '2026-10-04');
  assert.equal(result.factories[0].spend.label, '2026-10-04');
  assert.equal(result.factories[1].spend.day, '2026-10-03');
  assert.equal(result.factories[1].spend.label, 'latest factory day 2026-10-03');
  assert.equal(result.totals.spend.value, 6);
  assert.match(result.totals.spend.coverage, /factory-zero 2026-10-04/);
  assert.match(result.totals.spend.coverage, /win1 latest factory day 2026-10-03/);
});

test('spend falls back when today has no row and stays unknown when a factory has no rows', () => {
  const rows = [
    factory('factory-zero', {
      summary: summary('factory-zero', {
        spend: [
          { day: '2026-10-03', role: 'worker', harness: 'codex', usd: 100 },
          { day: '2026-10-04', role: 'worker', harness: 'codex', usd: 2 },
        ],
      }),
    }),
    factory('win1', { summary: summary('win1', { spend: [] }) }),
  ];

  const result = rollup(rows);
  assert.equal(result.factories[0].spend.day, '2026-10-04');
  assert.equal(result.factories[0].spend.label, 'latest factory day 2026-10-04');
  assert.equal(result.factories[1].spend.value, null);
  assert.equal(result.factories[1].spend.day, null);
  assert.equal(result.totals.spend.value, 2);
  assert.match(result.totals.spend.coverage, /1 of 2 factories reporting/);
  assert.match(result.totals.spend.coverage, /win1 \(no spend rows\)/);
});

test('the 90 second cutoff is fresh, and a never-seen factory contributes no zero', () => {
  const rows = [
    factory('factory-zero', { ageSeconds: 90, summary: summary('factory-zero', { workers: { running: 3, max: 8 } }) }),
    { name: 'win1', factoryId: 'win1', kind: 'container', status: 'offline', error: 'unreachable', drift: null, summary: null, lastSeenAt: null, ageSeconds: null },
    factory('win2', { ageSeconds: null, lastSeenAt: '2026-10-04T12:00:00Z', summary: summary('win2', { workers: { running: 40, max: 8 } }) }),
  ];

  const result = rollup(rows);
  assert.equal(result.factories[0].freshness, 'fresh');
  assert.equal(result.factories[1].freshness, 'never seen');
  assert.equal(result.factories[2].freshness, 'unknown');
  assert.equal(result.totals.workers.value, 3);
  assert.equal(result.totals.workers.asOf, 90);
  assert.match(result.totals.workers.coverage, /1 of 3 factories reporting/);
  assert.match(result.totals.workers.coverage, /win1 \(never seen\)/);
  assert.match(result.totals.workers.coverage, /win2 \(unknown\)/);
});

test('a fresh zero is a known reading, while clock thresholds are strict', () => {
  const zero = factory('factory-zero', { summary: summary('factory-zero', { workers: { running: 0, max: 8 } }) });
  assert.equal(rollup([zero]).totals.workers.value, 0);
  assert.match(rollup([zero]).totals.workers.coverage, /1 of 1 factories reporting/);

  const cases = [
    [30, null],
    [-30, null],
    [300, 'warning'],
    [-300, 'warning'],
  ];
  for (const [offsetSeconds, expected] of cases) {
    const row = factory('factory-zero', {
      summary: summary('factory-zero', { health: { status: 'healthy', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: offsetSeconds } }),
    });
    const alert = allAlerts(rollup([row])).find((candidate) => candidate.code === 'clock-offset');
    assert.equal(alert?.severity ?? null, expected, `${offsetSeconds} seconds`);
  }
});

test('shared quota lanes keep the highest fresh reading instead of adding factories', () => {
  const rows = [
    factory('factory-zero', {
      ageSeconds: 20,
      summary: summary('factory-zero', { quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 41, status: 'ok' }] }),
    }),
    factory('win1', {
      ageSeconds: 35,
      summary: summary('win1', { quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 64, status: 'ok' }] }),
    }),
  ];

  const result = rollup(rows);
  assert.equal(result.totals.quota.value, 64);
  assert.equal(result.totals.quota.asOf, 35);
  assert.equal(result.factories[0].quota.usedPercent, 41);
  assert.equal(result.factories[1].quota.usedPercent, 64);
});

test('quota coverage names a null lane when another lane contributes', () => {
  const row = factory('factory-zero', {
    summary: summary('factory-zero', {
      quotas: [
        { harness: 'codex', accountKey, lane: 'weekly', usedPercent: 41, status: 'ok' },
        { harness: 'codex', accountKey, lane: 'daily', usedPercent: null, status: 'unknown' },
      ],
    }),
  });

  const quota = rollup([row]).totals.quota;
  assert.equal(quota.value, 41);
  assert.equal(quota.asOf, 20);
  assert.match(quota.coverage, /1 of 1 factories reporting/);
  assert.match(quota.coverage, /unknown.*daily|daily.*unknown/);
});

test('drift remains a separate alert and signed clock offsets keep their value and severity', () => {
  const rows = [
    factory('factory-zero', {
      drift: 'head office older',
      summary: summary('factory-zero', { health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: -42 } }),
    }),
    factory('win1', {
      kind: 'container',
      status: 'offline',
      error: 'timeout',
      summary: summary('win1', { kind: 'container', health: { status: 'healthy', tickAgeSeconds: 10, herdrReachable: true, clockOffsetSeconds: -301 } }),
    }),
    factory('win2', {
      version: '0.1.0',
      kitRevision: 'abcdef012345',
      summary: summary('win2', { version: '9.9.9', kitRevision: 'fedcba654321' }),
    }),
  ];

  const alerts = allAlerts(rollup(rows));
  const drift = alerts.find((alert) => alert.id === 'factory-zero:kit-drift');
  assert.equal(drift.severity, 'warning');
  assert.equal(drift.fix, 'Update the head office service or code.');
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:clock-offset').offsetSeconds, -42);
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:clock-offset').severity, 'warning');
  assert.match(alerts.find((alert) => alert.id === 'factory-zero:clock-offset').label, /-42 s/);
  assert.equal(alerts.find((alert) => alert.id === 'win1:unreachable').fix, 'herdr-boss factory connect win1');
  assert.equal(alerts.find((alert) => alert.id === 'win1:clock-offset').offsetSeconds, -301);
  assert.equal(alerts.find((alert) => alert.id === 'win1:clock-offset').severity, 'error');
  assert.equal(alerts.some((alert) => alert.id === 'win2:kit-drift'), false);
});

test('disk alerts use strict 20 and 5 percent thresholds', () => {
  const cases = [
    [20, null],
    [19.9, 'warning'],
    [5, 'warning'],
    [4.9, 'error'],
  ];

  for (const [freePercent, expected] of cases) {
    const row = factory('factory-zero', { summary: summary('factory-zero', { machine: { diskFreePercent: freePercent, utcOffsetMinutes: 0 } }) });
    const alert = allAlerts(rollup([row])).find((candidate) => candidate.id === 'factory-zero:disk-low');
    assert.equal(alert?.severity ?? null, expected, `${freePercent}% free`);
  }
});

test('login, disk, clock, and stale alerts include kind-specific fixes and stable ids', () => {
  const rows = [
    factory('factory-zero', {
      summary: summary('factory-zero', {
        harnesses: [{ harness: 'claude', login: 'expired', checkedAt: '2026-10-05T00:00:00Z' }],
        machine: { diskFreePercent: 19, utcOffsetMinutes: 0 },
        health: { status: 'healthy', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: 31 },
        projects: [{ slug: 'sample-project', phase: 'build', status: 'doing', statusAgeSeconds: 7201, board: { doing: 1, review: 0, blocked: 0, done7d: 0 } }],
      }),
    }),
    factory('win1', {
      kind: 'container',
      summary: summary('win1', {
        kind: 'container',
        harnesses: [{ harness: 'codex', login: 'expired', checkedAt: '2026-10-05T00:00:00Z' }],
        machine: { diskFreePercent: 4, utcOffsetMinutes: 0 },
        health: { status: 'healthy', tickAgeSeconds: 1, herdrReachable: true, clockOffsetSeconds: 301 },
        projects: [{ slug: 'sample-project', phase: 'build', status: 'doing', statusAgeSeconds: 7200, board: { doing: 1, review: 0, blocked: 0, done7d: 0 } }],
      }),
    }),
  ];

  const result = rollup(rows);
  const alerts = allAlerts(result);
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:login-expired:claude').fix, 'Sign in claude in a terminal on this Mac.');
  assert.equal(alerts.find((alert) => alert.id === 'win1:login-expired:codex').fix, 'herdr-boss factory login win1 codex');
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:disk-low').fix, 'Free disk space on this Mac. Check the data volume with df -h.');
  assert.equal(alerts.find((alert) => alert.id === 'win1:disk-low').fix, 'herdr-boss factory status win1');
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:clock-offset').fix, 'Check Date and Time in System Settings on this Mac.');
  assert.equal(alerts.find((alert) => alert.id === 'win1:clock-offset').fix, 'Check the clock of the host.');
  assert.equal(alerts.find((alert) => alert.id === 'factory-zero:status-stale:sample-project').fix, 'Open the sample-project project page. The orchestrator publishes.');
  assert.equal(alerts.some((alert) => alert.id === 'win1:status-stale:sample-project'), false);

  const changedValue = factory('factory-zero', { summary: summary('factory-zero', { machine: { diskFreePercent: 4, utcOffsetMinutes: 0 } }) });
  assert.equal(allAlerts(rollup([changedValue])).find((alert) => alert.code === 'disk-low').id, 'factory-zero:disk-low');
});

test('factory rows retain waits, projects, health, last seen, role, and only the Mailbox owner count', () => {
  // T2 has already removed closed and information items. It keeps the open Mailbox count separate from review-pack waits.
  const rows = [
    factory('factory-zero', {
      summary: summary('factory-zero', {
        pending: [{ step: 'login-claude', since: '2026-10-04T08:00:00Z' }],
        projects: [{ slug: 'sample-project', phase: 'build', status: 'doing', statusAgeSeconds: 100, board: { doing: 2, review: 1, blocked: 0, done7d: 3 } }],
        ownerItems: { total: 2, needsOwner: 2, rows: [{ id: 'item-one', kind: 'decide' }, { id: 'item-two', kind: 'answer' }] },
        reviewPacks: [{ id: 'pack-one', waitingItems: 4 }],
      }),
    }),
    { name: 'win1', factoryId: 'win1', kind: 'container', status: 'offline', error: 'unreachable', drift: null, summary: null, lastSeenAt: null, ageSeconds: null },
  ];

  const result = rollup(rows);
  const local = result.factories.find((row) => row.name === 'factory-zero');
  const unseen = result.factories.find((row) => row.name === 'win1');
  assert.equal(local.role, 'head-office');
  assert.equal(local.health, 'healthy');
  assert.equal(local.lastSeenAt, '2026-10-05T00:59:00Z');
  assert.equal(local.freshness, 'fresh');
  // The wait is unverified here: no harness row is expired, so the rollup gives no fix.
  assert.deepEqual(local.pending, [{ step: 'login-claude', since: '2026-10-04T08:00:00Z', ageSeconds: 61200, harness: 'claude', fix: null, fixKind: null }]);
  assert.equal(local.projects[0].phase, 'build');
  assert.deepEqual(local.projects[0].board, { doing: 2, review: 1, blocked: 0, done7d: 3 });
  assert.equal(local.ownerItems, 2);
  assert.equal(unseen.role, 'factory');
  assert.equal(unseen.freshness, 'never seen');
  assert.equal(unseen.health, 'offline');
  assert.equal(unseen.lastSeenAt, null);
  assert.equal(unseen.ownerItems, null);
  assert.equal(unseen.workers, null);
});

test('a verified login wait carries a kind-specific fix, a harness, and a readable age', () => {
  const rows = [
    factory('factory-zero', { summary: summary('factory-zero', {
      kind: 'native',
      harnesses: [{ harness: 'claude', login: 'expired' }, { harness: 'codex', login: 'expired' }],
      pending: [{ step: 'login-claude', since: '2026-10-04T01:00:00Z' }, { step: 'login-codex', since: '2026-10-05T00:30:00Z' }],
    }) }),
    factory('win1', { summary: summary('win1', {
      kind: 'container',
      harnesses: [{ harness: 'claude', login: 'expired' }],
      pending: [{ step: 'login-claude', since: '2026-10-04T01:00:00Z' }],
    }) }),
  ];

  const result = rollup(rows);
  const local = result.factories.find((row) => row.name === 'factory-zero');
  const remote = result.factories.find((row) => row.name === 'win1');
  // Two independent waits stay two waits. Each carries its own age and its own fix.
  assert.equal(local.pending.length, 2);
  assert.deepEqual(local.pending[0], { step: 'login-claude', since: '2026-10-04T01:00:00Z', ageSeconds: 86400, harness: 'claude',
    fix: 'Sign in claude in a terminal on this Mac.', fixKind: 'instruction' });
  assert.deepEqual(local.pending[1], { step: 'login-codex', since: '2026-10-05T00:30:00Z', ageSeconds: 1800, harness: 'codex',
    fix: 'Sign in codex in a terminal on this Mac.', fixKind: 'instruction' });
  assert.deepEqual(remote.pending, [{ step: 'login-claude', since: '2026-10-04T01:00:00Z', ageSeconds: 86400, harness: 'claude',
    fix: 'herdr-boss factory login win1 claude', fixKind: 'command' }]);
});

test('an unverified, unsupported, or hostile wait step gets no invented fix', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const rows = [
    factory('win1', { summary: summary('win1', {
      harnesses: [{ harness: 'claude', login: 'ok' }],
      pending: [{ step: 'login-claude', since: '2026-10-05T00:59:00Z' }],
    }) }),
    factory('win2', { summary: summary('win2', {
      harnesses: [{ harness: 'claude', login: 'unknown' }, { harness: hostile, login: 'expired' }],
      pending: [{ step: 'login-claude', since: '2026-10-05T00:59:00Z' }, { step: `login-${hostile}`, since: '2026-10-05T00:59:00Z' },
        { step: 'connect-wizard', since: '2026-10-05T00:59:00Z' }],
    }) }),
    factory('win3', { summary: summary('win3', {
      kind: 'remote-kind',
      harnesses: [{ harness: 'claude', login: 'expired' }],
      pending: [{ step: 'login-claude', since: '2026-10-05T00:59:00Z' }],
    }) }),
  ];

  const result = rollup(rows);
  const [ok, unknown, hostile3] = ['win1', 'win2', 'win3'].map((name) => result.factories.find((row) => row.name === name));
  // A passing or unknown login reading keeps the wait but gives no command.
  assert.equal(ok.pending[0].fix, null);
  assert.equal(ok.pending[0].fixKind, null);
  assert.equal(ok.pending[0].harness, 'claude');
  assert.equal(ok.pending[0].ageSeconds, 60, 'the wait keeps its own age');
  // An unknown reading never clears a wait.
  assert.equal(unknown.pending.length, 3);
  assert.ok(unknown.pending.every((wait) => wait.step), 'each step is kept');
  for (const wait of unknown.pending.slice(1)) {
    assert.equal(wait.fix, null, `no invented fix for ${wait.step}`);
    assert.equal(wait.fixKind, null);
  }
  assert.equal(unknown.pending[1].harness, null, 'a hostile harness name is no harness');
  // An unknown factory kind gets no command and no instruction.
  assert.equal(hostile3.pending[0].fix, null);
  assert.equal(hostile3.pending[0].fixKind, null);
});

test('a missing or invalid since reads as no age and no since', () => {
  const rows = [factory('win1', { summary: summary('win1', {
    harnesses: [{ harness: 'claude', login: 'expired' }, { harness: 'codex', login: 'expired' }],
    pending: [{ step: 'login-claude' }, { step: 'login-codex', since: 'yesterday' }, { step: 'login-claude', since: 7 }],
  }) })];
  const pending = rollup(rows).factories[0].pending;
  assert.equal(pending.length, 3);
  for (const wait of pending) {
    assert.equal(wait.since, null, `no since for ${wait.step}`);
    assert.equal(wait.ageSeconds, null);
    assert.equal(wait.fix, 'herdr-boss factory login win1 ' + wait.harness, 'the fix does not depend on the age');
  }
});

test('an absent Boss and a healthy poll never create a wait', () => {
  const rows = [
    factory('factory-zero', { summary: summary('factory-zero', { kind: 'native', boss: { running: false, harness: null }, harnesses: [{ harness: 'claude', login: 'ok' }] }) }),
    factory('win1', { summary: summary('win1', { boss: { running: false, harness: null }, harnesses: [{ harness: 'claude', login: 'ok' }] }) }),
  ];
  for (const row of rollup(rows).factories) {
    assert.deepEqual(row.pending, [], `${row.name} has no wait`);
    assert.ok(!row.alerts.some((alert) => alert.code === 'boss' || alert.label.includes('Waiting')), 'no Boss wait alert');
  }
});

test('a quota row without an account record stays out of the fleet total but stays on the factory', () => {
  const rows = [
    factory('factory-zero', {
      summary: summary('factory-zero', { quotas: [{ harness: 'codex', accountKey, lane: 'weekly', usedPercent: 41, status: 'ok' }] }),
    }),
    factory('win1', {
      summary: summary('win1', { quotas: [{ harness: 'claude', accountScope: 'this-factory', lane: 'weekly', usedPercent: 99, status: 'ok' }] }),
    }),
  ];

  const result = rollup(rows);
  assert.equal(result.totals.quota.value, 41);
  assert.match(result.totals.quota.coverage, /1 of 2 factories reporting/);
  assert.match(result.totals.quota.coverage, /win1 \(this factory only\)/);
  assert.equal(result.factories[1].quota.usedPercent, 99);
});

test('a factory with a shared and a local reading contributes only the shared reading to the fleet total', () => {
  const row = factory('factory-zero', {
    summary: summary('factory-zero', {
      quotas: [
        { harness: 'codex', accountKey, lane: 'weekly', usedPercent: 30, status: 'ok' },
        { harness: 'claude', accountScope: 'this-factory', lane: 'weekly', usedPercent: 99, status: 'ok' },
      ],
    }),
  });

  const totals = rollup([row]).totals;
  assert.equal(totals.quota.value, 30);
  assert.match(totals.quota.coverage, /^1 of 1 factories reporting/);
});
