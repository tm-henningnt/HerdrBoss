import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { goalSetBlockHtml, goalStatusText, goalDialogHtml, pollGoalStatus, GOAL_TEXT_MAX } from '../public/goal-set.js';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const goalField = (label, text) => (text ? `<details class="goal-field"><summary><b>${esc(label)}</b><span class="goal-line">${esc(text)}</span></summary></details>` : '');
const clock = () => '12:00';
const render = (extra = {}) => goalSetBlockHtml({ slug: 'alpha', goal: 'Ship it', job: null, enabled: true, esc, goalField, clock, ...extra });

test('the goal block has a Set goal button, the collapsed goal line, and a status line', () => {
  const html = render();
  assert.match(html, /<button type="button" class="quiet goal-set-button" data-goal-set="alpha">Set goal<span class="visually-hidden"> for alpha<\/span><\/button>/);
  assert.match(html, /<details class="goal-field">/);
  assert.match(html, /data-goal-status="alpha" role="status">Goal in the project status\. Not checked in the pane\./);
  assert.match(html, /data-key="goal-set:alpha"/);
});

test('the goal block escapes the slug, the goal, and the job text', () => {
  const html = render({ slug: 'a"><img src=x>', goal: '<script>alert(1)</script>', job: { state: 'failed', reason: '<b>bad</b>' } });
  assert.doesNotMatch(html, /<script>|<img|<b>bad/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});

test('the button is disabled without an orchestrator pane and while a job runs', () => {
  assert.match(render({ enabled: false }), /data-goal-set="alpha" disabled/);
  assert.match(render({ job: { state: 'waiting' } }), /data-goal-set="alpha" disabled/);
  assert.match(render({ job: { state: 'active' } }), /data-goal-set="alpha">/);
});

test('the status text names each job state in plain words', () => {
  assert.equal(goalStatusText('x', null), 'Goal in the project status. Not checked in the pane.');
  assert.equal(goalStatusText('', null), 'No goal in the project status.');
  assert.match(goalStatusText('x', { state: 'waiting', reason: 'the agent works' }), /^Waiting for an idle pane: the agent works/);
  assert.equal(goalStatusText('x', { state: 'sending' }), 'Sending the command.');
  assert.equal(goalStatusText('x', { state: 'verifying' }), 'Checking that the pane shows the goal.');
  assert.equal(goalStatusText('x', { state: 'active', verifiedAt: '2026-09-30T12:00:00Z' }, clock), 'Goal active. Checked at 12:00.');
  assert.equal(goalStatusText('x', { state: 'failed', reason: 'the agent works' }), 'Goal not set: the agent works.');
});

test('the confirm dialog shows the text field, the limit, and the wait warning', () => {
  const html = goalDialogHtml();
  assert.match(html, new RegExp(`maxlength="${GOAL_TEXT_MAX}"`));
  assert.match(html, /waits until the pane of the orchestrator is idle/);
  assert.match(html, /<button type="button" class="quiet" data-goal-cancel>Cancel<\/button>/);
  assert.match(html, /id="goal-dialog-confirm"/);
  assert.equal(GOAL_TEXT_MAX, 2000);
});

test('app.js shows the goal block on the project page and on both Agents views, and the touch target is 44 px', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /from '\.\/goal-set\.js'/);
  assert.equal((app.match(/goalSetBlock\(/g) || []).length >= 3, true);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.goal-set-button\s*\{[^}]*min-height:\s*44px/);
});

test('the Cancel button shows only while a job waits, and the status names cancelled, interrupted, and sign in', () => {
  assert.match(render({ job: { state: 'waiting' } }), /data-goal-stop="alpha">Cancel/);
  assert.match(render({ job: { state: 'active' } }), /data-goal-stop="alpha" hidden>/);
  assert.match(render(), /data-goal-stop="alpha" hidden>/);
  assert.equal(goalStatusText('x', { state: 'cancelled' }), 'Cancelled.');
  assert.match(goalStatusText('x', { state: 'interrupted' }), /^Interrupted\./);
  assert.equal(goalStatusText('x', { state: 'signin' }), 'Sign in again.');
});

// A fake page: each wait moves a fake clock and the script of responses.
function poller(responses, { shown = () => true, running = false } = {}) {
  const jobs = [];
  const waits = [];
  let index = 0;
  const run = () => pollGoalStatus({
    fetchStatus: async () => responses[Math.min(index++, responses.length - 1)],
    onJob: (job) => jobs.push(job),
    stillShown: () => shown(waits.length),
    believesRunning: () => running,
    wait: async (ms) => { waits.push(ms); },
  });
  return { run, jobs, waits };
}

test('the poll stops when the job ends, and waits 3 s between looks', async () => {
  const p = poller([{ status: 200, body: { state: 'waiting' } }, { status: 200, body: { state: 'verifying' } }, { status: 200, body: { state: 'active' } }]);
  assert.equal(await p.run(), 'done');
  assert.deepEqual(p.waits, [3000, 3000]);
});

test('the poll stops when the route changes or the page unloads', async () => {
  const p = poller([{ status: 200, body: { state: 'waiting' } }], { shown: (waits) => waits < 2 });
  assert.equal(await p.run(), 'left');
  assert.equal(p.waits.length, 2);
  const gone = poller([{ status: 200, body: { state: 'waiting' } }], { shown: () => false });
  assert.equal(await gone.run(), 'left');
  assert.deepEqual(gone.jobs, []);
});

test('a 401 shows Sign in again, and a 404 for a job the page believes running shows interrupted', async () => {
  const auth = poller([{ status: 401, body: { error: 'Access token required.' } }]);
  assert.equal(await auth.run(), 'signin');
  assert.deepEqual(auth.jobs, [{ state: 'signin' }]);
  const lost = poller([{ status: 404, body: null }], { running: true });
  assert.equal(await lost.run(), 'missing');
  assert.deepEqual(lost.jobs, [{ state: 'interrupted' }]);
  const none = poller([{ status: 404, body: null }]);
  await none.run();
  assert.deepEqual(none.jobs, [null]);
  const restarted = poller([{ status: 200, body: { state: 'interrupted' } }]);
  assert.equal(await restarted.run(), 'done');
});
