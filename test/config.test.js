import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeServiceSettings } from '../src/config.js';

function configDir(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-settings-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

function assertSetting(t, key, value, config = {}) {
  const dataDir = configDir(t, config);
  assert.doesNotThrow(() => writeServiceSettings({ [key]: value }, { dataDir }), `${key} accepts ${value}`);
}

function assertRejectedSetting(t, key, value, config = {}) {
  const dataDir = configDir(t, config);
  assert.throws(() => writeServiceSettings({ [key]: value }, { dataDir }), `${key} refuses ${value}`);
}

test('service settings accept each documented range and reject values outside it', (t) => {
  for (const [key, minimum, maximum] of [
    ['machine.memFreeWarnPercent', 1, 50],
    ['staleStatusMinutes', 5, 1440],
    ['workers.staleIdleMinutes', 5, 1440],
    ['browsers.orphanDaemonMinAgeSeconds', 60, 86400],
    ['browsers.staleOwnedMinutes', 5, 1440],
    ['tickSeconds', 5, 300],
    ['quotaSeconds', 30, 3600],
  ]) {
    assertSetting(t, key, minimum);
    assertSetting(t, key, maximum);
    assertRejectedSetting(t, key, minimum - 1);
    assertRejectedSetting(t, key, maximum + 1);
  }

  assertSetting(t, 'quota.warnPercent', 50, { quota: { criticalPercent: 98 } });
  assertSetting(t, 'quota.warnPercent', 99, { quota: { criticalPercent: 100 } });
  assertRejectedSetting(t, 'quota.warnPercent', 49, { quota: { criticalPercent: 98 } });
  assertRejectedSetting(t, 'quota.warnPercent', 100, { quota: { criticalPercent: 100 } });
  assertSetting(t, 'quota.criticalPercent', 51, { quota: { warnPercent: 50 } });
  assertSetting(t, 'quota.criticalPercent', 100, { quota: { warnPercent: 99 } });
  assertRejectedSetting(t, 'quota.criticalPercent', 50, { quota: { warnPercent: 49 } });
  assertRejectedSetting(t, 'quota.criticalPercent', 101, { quota: { warnPercent: 99 } });

  assertSetting(t, 'browsers.reapOrphanDaemons', true);
  assertSetting(t, 'browsers.reapOrphanDaemons', false);
  assertSetting(t, 'browsers.sweepCodeSignClones', true);
  assertSetting(t, 'browsers.sweepCodeSignClones', false);
  assertRejectedSetting(t, 'browsers.reapOrphanDaemons', 'true');
  assertRejectedSetting(t, 'browsers.sweepCodeSignClones', 1);
  assertSetting(t, 'push', true);
  assertSetting(t, 'push', false);
  assertRejectedSetting(t, 'push', 'true');
  assertRejectedSetting(t, 'push', 1);
  for (const key of ['tickSeconds', 'quotaSeconds']) {
    assertRejectedSetting(t, key, 30.5);
    assertRejectedSetting(t, key, '30');
    assertRejectedSetting(t, key, null);
  }
});

test('service settings require quota warning below critical and refuse non-allow-listed keys', (t) => {
  assertRejectedSetting(t, 'quota.warnPercent', 98, { quota: { warnPercent: 90, criticalPercent: 98 } });
  assertRejectedSetting(t, 'quota.criticalPercent', 90, { quota: { warnPercent: 90, criticalPercent: 98 } });
  for (const key of ['host', 'port', 'access', 'roamgate', 'alertCooldownSeconds', 'providerKinds', 'orchestratorLabel', 'unknown.setting']) {
    assertRejectedSetting(t, key, true);
  }
});

test('service settings update only selected keys, retain key order, and keep the config file mode', (t) => {
  const initial = {
    before: { first: 'keep', second: 3 },
    quota: { note: 'keep', warnPercent: 90, criticalPercent: 98, trailing: true },
    after: ['keep'],
    machine: { nested: { untouched: 1 }, memFreeWarnPercent: 15 },
  };
  const dataDir = configDir(t, initial);
  const configFile = path.join(dataDir, 'config.json');
  fs.chmodSync(configFile, 0o640);

  writeServiceSettings({ 'quota.warnPercent': 95, 'machine.memFreeWarnPercent': 20 }, { dataDir });

  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved, {
    ...initial,
    quota: { ...initial.quota, warnPercent: 95 },
    machine: { ...initial.machine, memFreeWarnPercent: 20 },
  });
  assert.deepEqual(Object.keys(saved), Object.keys(initial));
  assert.deepEqual(Object.keys(saved.quota), Object.keys(initial.quota));
  assert.equal(fs.statSync(configFile).mode & 0o7777, 0o640);
});
