import './helpers/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { POLICY_DEFAULTS } from '../src/control.js';
import { evaluate } from '../src/rules.js';

// K34: the idle-orchestrator notice must name the reason for open work. These tests use the same
// snapshot shape as the idle tests in control.test.js: published projects, a control entry, and panes.
const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3600000;
const SINCE = { 'w1:p1': { since: NOW - 20 * 60000 } };
const CFG = { quota: { warnPercent: 90, criticalPercent: 98 }, machine: { memFreeWarnPercent: 15, loadWarnFactor: 2 }, providerKinds: {}, browsers: { staleOwnedMinutes: 30 }, workers: { staleIdleMinutes: 120 }, sharedBrowsers: [] };
const policy = (patch = {}) => ({ ...structuredClone(POLICY_DEFAULTS), ...patch });

function fixture({ tasks = [], groups = [], reviewPacks = [], staleText = null, taskWorkers = {} } = {}) {
  const slug = 'herdrboss';
  const workspace = 'w1';
  return {
    projects: [{ slug, workspace, project: 'HerdrBoss', tasks, groups }],
    control: { projects: { [slug]: { slug, workspace, label: 'HerdrBoss', mode: 'auto', effectiveMode: 'auto', orch: { pane: `${workspace}:p1`, status: 'idle' } } } },
    herdr: {
      workspaces: [{ id: workspace, label: 'HerdrBoss' }],
      panes: [{ id: `${workspace}:p1`, workspace, orch: true, label: 'orch', agent: 'claude', status: 'idle', sessionId: 's1' }],
    },
    quotas: [],
    browsers: [],
    reviewPacks,
    taskWorkers,
    ...(staleText ? { staleText } : {}),
  };
}

const alerts = (snap, now = NOW) =>
  evaluate(snap, CFG, SINCE, now, policy({ idleMinutes: 15 })).alerts.filter((a) => a.key.startsWith('nudge:'));

const openNotices = (snap, now = NOW) => alerts(snap, now).filter((a) => a.key.startsWith('nudge:idle-open:'));
const readyNotices = (snap, now = NOW) => alerts(snap, now).filter((a) => a.key.startsWith('nudge:idle:'));
const looksStale = (snap, now = NOW) => alerts(snap, now).some((a) => /looks stale/.test(a.text));

// An open card that git already finished: the published status is open, the computed state is review or done.
const openDoneCard = (over = {}) => ({
  id: '112', title: 'Parse event log', status: 'doing', publishedStatus: 'doing', state: 'done', computedState: 'done',
  diverges: true, source: { kind: 'commit', ref: 'abc1234', at: new Date(NOW - 7 * HOUR).toISOString() },
  ...over,
});

test('an open card whose git state is done and that did not change for more than six hours looks stale', () => {
  const snap = fixture({ tasks: [openDoneCard()] });
  assert.deepEqual(readyNotices(snap), [], 'a stale card holds the ready-work notice back');
  const [notice] = openNotices(snap);
  assert.ok(notice, 'the idle-with-open-work notice fires');
  assert.match(notice.text, /task 112 looks stale: close or update the card/);
  assert.equal(notice.prompt, false, 'the open-work notice never prompts the waiting orchestrator');
});

test('an open card whose git state is review and that did not change for more than six hours looks stale', () => {
  const snap = fixture({ tasks: [openDoneCard({
    id: '113', title: 'Merge the release', state: 'review', computedState: 'review',
    source: { kind: 'worker', ref: 'k113', at: new Date(NOW - 8 * HOUR).toISOString() },
  })] });
  const [notice] = openNotices(snap);
  assert.ok(notice);
  assert.match(notice.text, /task 113 looks stale: close or update the card/);
});

test('an open card that changed five hours ago is not stale', () => {
  const snap = fixture({ tasks: [openDoneCard({ source: { kind: 'commit', ref: 'abc1234', at: new Date(NOW - 5 * HOUR).toISOString() } })] });
  assert.equal(looksStale(snap), false);
});

test('an open card with no source and no change time falls back to the card updated time', () => {
  const fresh = fixture({ tasks: [openDoneCard({ source: null, updated: new Date(NOW - 5 * HOUR).toISOString() })] });
  assert.equal(looksStale(fresh), false);
  const old = fixture({ tasks: [openDoneCard({ id: '114', source: null, updated: new Date(NOW - 7 * HOUR).toISOString() })] });
  assert.equal(looksStale(old), true);
});

test('a card that a live worker holds is not stale', () => {
  const snap = fixture({
    tasks: [openDoneCard()],
    taskWorkers: { herdrboss: [{ name: 'k112', taskId: '112', phase: 'live', kind: 'opencode' }] },
  });
  assert.equal(looksStale(snap), false, 'a live worker keeps the card current');
});

test('a published done card is not open work and gives no notice', () => {
  const snap = fixture({ tasks: [{
    id: '112', title: 'Draft release', status: 'done', publishedStatus: 'done', state: 'done', computedState: 'done',
    updated: new Date(NOW - 7 * HOUR).toISOString(),
  }] });
  assert.deepEqual(alerts(snap), [], 'an old published done card holds nothing back and starts no notice');
});

test('a published review card keeps the existing review text', () => {
  const snap = fixture({ tasks: [{
    id: '112', title: 'Draft release', status: 'review', publishedStatus: 'review', state: 'review', computedState: 'review',
    updated: new Date(NOW - 7 * HOUR).toISOString(),
  }] });
  const [notice] = openNotices(snap);
  assert.ok(notice);
  assert.match(notice.text, /task 112 "Draft release" is in review/);
  assert.doesNotMatch(notice.text, /looks stale/);
});

test('a card with a mailboxId waits for the Owner and holds the ready-work notice back', () => {
  const snap = fixture({ tasks: [
    { id: '76', title: 'Choose the export format', status: 'todo', ask: 'PNG or SVG?', mailboxId: 'm1727' },
    { id: '74', title: 'Parse event log', status: 'todo' },
  ] });
  assert.deepEqual(readyNotices(snap), [], 'no ready-work notice for a project that waits for the Owner');
  const [notice] = openNotices(snap);
  assert.ok(notice, 'the open-work notice names the Owner wait');
  assert.match(notice.text, /waiting for the Owner: Choose the export format/);
  assert.equal(notice.prompt, false);
});

test('a card with waitingOn owner waits for the Owner', () => {
  const snap = fixture({ tasks: [
    { id: '76', title: 'Choose the export format', status: 'blocked', waitingOn: 'owner', ask: 'PNG or SVG?', mailboxId: 'm1727' },
  ] });
  assert.deepEqual(readyNotices(snap), []);
  const [notice] = openNotices(snap);
  assert.ok(notice);
  assert.match(notice.text, /waiting for the Owner: Choose the export format/);
});

test('the unchanged open-work text stays for an open review pack and a fresh review card', () => {
  const packs = fixture({ tasks: [{ id: '112', title: 'Draft release', status: 'review' }], reviewPacks: [{ slug: 'herdrboss', pack: 'suite-1-2', version: 3, state: 'open' }] });
  const [packNotice] = openNotices(packs);
  assert.match(packNotice.title, /idle with open packs/i);
  assert.match(packNotice.text, /suite-1-2/);

  const review = fixture({ tasks: [{ id: '112', title: 'Draft release', status: 'review' }] });
  assert.match(openNotices(review)[0].text, /task 112 "Draft release" is in review/);
});

test('a ready task with no open work keeps the ready-work notice', () => {
  const snap = fixture({ tasks: [{ id: '74', title: 'Parse event log', status: 'todo' }] });
  assert.deepEqual(openNotices(snap), []);
  const [notice] = readyNotices(snap);
  assert.ok(notice);
  assert.match(notice.text, /task 74 "Parse event log"/);
});
