import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareHarnessHome } from '../src/factory-harness-state.js';

const ROOTS = ['/home/factory/herdr-boss', '/home/factory/work', '/home/factory/work/alpha'];

function fixtureHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-factory-state-'));
}

test('a fresh Claude home gets the onboarding, theme, and trusted folders', () => {
  const home = fixtureHome();
  try {
    prepareHarnessHome('claude', ROOTS, home);
    const file = path.join(home, '.claude.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.theme, 'dark');
    for (const folder of ROOTS) {
      assert.equal(state.projects[folder].hasTrustDialogAccepted, true, `the folder ${folder} is trusted`);
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, '.claude', '.credentials.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a second Claude preparation changes nothing', () => {
  const home = fixtureHome();
  try {
    prepareHarnessHome('claude', ROOTS, home);
    const file = path.join(home, '.claude.json');
    const before = fs.readFileSync(file, 'utf8');
    const beforeStat = fs.statSync(file);
    prepareHarnessHome('claude', ROOTS, home);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude preparation merges into an existing user file and keeps its other keys', () => {
  const home = fixtureHome();
  try {
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      theme: 'light',
      oauthAccount: { fixture: 'keep' },
      custom: [1, 2],
      projects: {
        '/home/factory/work/alpha': { allowedTools: ['Read'], hasTrustDialogAccepted: false },
        '/unrelated': { hasTrustDialogAccepted: false },
      },
    }));
    prepareHarnessHome('claude', ['/home/factory/work/alpha'], home);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.theme, 'light');
    assert.deepEqual(state.oauthAccount, { fixture: 'keep' });
    assert.deepEqual(state.custom, [1, 2]);
    assert.deepEqual(state.projects['/home/factory/work/alpha'], { allowedTools: ['Read'], hasTrustDialogAccepted: true });
    assert.deepEqual(state.projects['/unrelated'], { hasTrustDialogAccepted: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
