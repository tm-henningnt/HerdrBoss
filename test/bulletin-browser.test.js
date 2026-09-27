import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBulletin } from '../src/rules.js';

const cfg = { dashboardUrl: 'http://127.0.0.1:4477/' };
const profile = '/tmp/herdr-boss-test/browser-profiles/alpha';

function bulletin(managed, running = true) {
  const snap = {
    updatedAt: '2026-09-27T00:00:00Z',
    browsers: running ? [{ kind: 'automation-chrome', port: '49999', profile, pid: 4101 }] : [],
    managedBrowsers: [{ project: 'alpha', port: 49999, profile, headless: true, windowSize: { width: 1280, height: 800 }, ...managed }],
  };
  return renderBulletin(snap, { alerts: [], advice: [] }, cfg);
}

test('bulletin marks a matched browser that does not answer CDP as not responding', () => {
  const text = bulletin({ responsive: false });
  assert.match(text, /- alpha: not responding \(headless\); CDP http:\/\/127\.0\.0\.1:49999 does not answer\./);
  assert.match(text, /herdr-boss browser restart alpha --headless/);
  assert.doesNotMatch(text, /- alpha: ready/);
});

test('bulletin marks a matched browser that answers CDP as ready', () => {
  assert.match(bulletin({ responsive: true }), /- alpha: ready \(headless\); next launch 1280×800/);
});

test('bulletin marks a browser without a matched process as offline, whatever the probe says', () => {
  assert.match(bulletin({ responsive: false }, false), /- alpha: offline \(headless\)/);
});
