import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeServiceSettings, serviceSettingsView } from '../src/config.js';

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

test('project and worktree roots are visible path settings with the current defaults', (t) => {
  const defaults = serviceSettingsView({});
  for (const [setting, leaf] of [['projectRoot', 'Projects'], ['worktreeRoot', 'Projects/.herdr-wt']]) {
    assert.deepEqual(defaults.find((item) => item.setting === setting), {
      group: 'Paths', setting, value: path.join(os.homedir(), leaf), source: 'default',
    });
    const dataDir = configDir(t, { untouched: true });
    const target = path.join(dataDir, 'custom root');
    writeServiceSettings({ [setting]: target }, { dataDir });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), { untouched: true, [setting]: target });
    for (const value of ['', 'relative/path', 1, null, '/tmp/root\nother', '/tmp/root\0other']) assertRejectedSetting(t, setting, value);
    assertSetting(t, setting, '~/custom roots');
  }
});

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

test('quota plan settings have defaults, documented ranges, and a bounded horizon form', (t) => {
  const defaults = serviceSettingsView({});
  const expected = {
    'quotaPlan.burstPace': 1,
    'quotaPlan.applyThreshold': 95,
    'quotaPlan.margin': 0,
    'quotaPlan.horizon': 'last-expiry',
    'quotaPlan.tolerance': 5,
    'quotaPlan.holdMargin': 1,
    'quotaPlan.slowFactor': 0.5,
    'quotaPlan.planMode': 'paced',
  };
  for (const [setting, value] of Object.entries(expected)) {
    assert.deepEqual(defaults.find((item) => item.setting === setting), {
      group: 'Quota plan', setting, value, source: 'default',
    });
  }
  for (const [key, value] of [
    ['quotaPlan.burstPace', 0.1], ['quotaPlan.burstPace', 10],
    ['quotaPlan.applyThreshold', 50], ['quotaPlan.applyThreshold', 100],
    ['quotaPlan.margin', 0], ['quotaPlan.margin', 50],
    ['quotaPlan.tolerance', 0], ['quotaPlan.tolerance', 50],
    ['quotaPlan.holdMargin', 0], ['quotaPlan.holdMargin', 50],
    ['quotaPlan.slowFactor', 0.1], ['quotaPlan.slowFactor', 1],
    ['quotaPlan.horizon', 'last-expiry'], ['quotaPlan.horizon', '2032-04-01T00:00:00.000Z'],
    ['quotaPlan.planMode', 'paced'], ['quotaPlan.planMode', 'burst'],
  ]) assertSetting(t, key, value);
  for (const [key, value] of [
    ['quotaPlan.burstPace', 0.09], ['quotaPlan.burstPace', 10.01],
    ['quotaPlan.applyThreshold', 49], ['quotaPlan.applyThreshold', 100.1],
    ['quotaPlan.margin', -0.1], ['quotaPlan.margin', 50.1],
    ['quotaPlan.tolerance', -0.1], ['quotaPlan.tolerance', 50.1],
    ['quotaPlan.holdMargin', -0.1], ['quotaPlan.holdMargin', 50.1],
    ['quotaPlan.slowFactor', 0.09], ['quotaPlan.slowFactor', 1.01],
    ['quotaPlan.horizon', 'tomorrow'], ['quotaPlan.horizon', '2032-04-01'], ['quotaPlan.planMode', 'fast'],
  ]) assertRejectedSetting(t, key, value);
});

test('service settings require quota warning below critical and refuse non-allow-listed keys', (t) => {
  assertRejectedSetting(t, 'quota.warnPercent', 98, { quota: { warnPercent: 90, criticalPercent: 98 } });
  assertRejectedSetting(t, 'quota.criticalPercent', 90, { quota: { warnPercent: 90, criticalPercent: 98 } });
  for (const key of ['host', 'port', 'access', 'roamgate', 'alertCooldownSeconds', 'providerKinds', 'orchestratorLabel', 'unknown.setting']) {
    assertRejectedSetting(t, key, true);
  }
});

test('GitHub Actions minutes is an on-by-default boolean service setting', (t) => {
  const dataDir = configDir(t);
  assertSetting(t, 'analytics.actionsMinutes', true);
  assertSetting(t, 'analytics.actionsMinutes', false);
  assertRejectedSetting(t, 'analytics.actionsMinutes', 'true');
  assert.deepEqual(serviceSettingsView({}).find(({ setting }) => setting === 'analytics.actionsMinutes'), {
    group: 'Analytics', setting: 'analytics.actionsMinutes', value: true, source: 'default',
  });
  writeServiceSettings({ 'analytics.actionsMinutes': false }, { dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).analytics, { actionsMinutes: false });
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

test('loadConfig uses the quota plan defaults when the stored value is not an object', (t) => {
  for (const stored of [null, 5, 'x', []]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-quotaplan-load-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ quotaPlan: stored }));
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "import { loadConfig } from './src/config.js'; console.log(loadConfig().quotaPlan.burstPace)"], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, HOME: root, HERDR_BOSS_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '1');
  }
});
