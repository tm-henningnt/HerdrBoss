// The Set goal control of an orchestrator: the block on the project page and the Agents page, and the confirm dialog.
// The module has no DOM use, so the Node tests import it directly. app.js holds the event handlers.

export const GOAL_TEXT_MAX = 1000;

// A job is running while it waits, sends, or verifies.
export const goalJobRunning = (job) => Boolean(job) && ['waiting', 'sending', 'verifying'].includes(job.state);

export function goalStatusText(goal, job, clock = (iso) => iso) {
  if (job?.state === 'waiting') return `Waiting for an idle pane${job.reason ? `: ${job.reason}` : ''}.`;
  if (job?.state === 'sending') return 'Sending the command.';
  if (job?.state === 'verifying') return 'Checking that the pane shows the goal.';
  if (job?.state === 'active') return `Goal active.${job.verifiedAt ? ` Checked at ${clock(job.verifiedAt)}.` : ''}`;
  if (job?.state === 'cancelled') return 'Cancelled.';
  if (job?.state === 'interrupted') return 'Interrupted. The service stopped the job. Select Set goal to try again.';
  if (job?.state === 'signin') return 'Sign in again.';
  if (job?.state === 'failed') return `Goal not set: ${job.reason || job.message || 'unknown reason'}.`;
  return goal ? 'Goal in the project status. Not checked in the pane.' : 'No goal in the project status.';
}

// helpers: esc, goalField(label, text, source), clock(iso). enabled is false when the project has no orchestrator pane.
// With showGoal false, the page shows the goal line in another place.
export function goalSetBlockHtml({ slug, goal, job, enabled, esc, goalField, clock, showGoal = true }) {
  const off = !enabled || goalJobRunning(job) ? ' disabled' : '';
  const id = esc(slug);
  return `<div class="goal-set" data-key="goal-set:${id}" data-goal-slug="${id}">${showGoal ? goalField('Goal', goal) : ''}`
    + `<div class="goal-set-row"><button type="button" class="quiet goal-set-button" data-goal-set="${id}"${off}>Set goal<span class="visually-hidden"> for ${id}</span></button>`
    + `<span class="goal-set-status" data-goal-status="${id}" role="status">${esc(goalStatusText(goal, job, clock))}</span>`
    + `<button type="button" class="quiet goal-set-button" data-goal-stop="${id}"${job?.state === 'waiting' ? '' : ' hidden'}>Cancel<span class="visually-hidden"> the goal job for ${id}</span></button></div></div>`;
}

export function goalDialogHtml() {
  return `<h2 id="goal-dialog-title">Set the goal</h2>
    <p id="goal-dialog-target"></p>
    <label class="goal-dialog-field" for="goal-dialog-text">Goal text<textarea id="goal-dialog-text" rows="5" maxlength="${GOAL_TEXT_MAX}"></textarea></label>
    <p class="setting-help">At most ${GOAL_TEXT_MAX} characters. A line break becomes a space. The field starts with the default orchestrator goal from Settings.</p>
    <p class="setting-help">The command waits until the pane of the orchestrator is idle. The wait can take up to 10 minutes. The command sends nothing while the agent works or a dialog is open.</p>
    <p class="goal-dialog-status" id="goal-dialog-status" role="status"></p>
    <div class="goal-dialog-actions"><button type="button" class="quiet" data-goal-cancel>Cancel</button><button type="button" id="goal-dialog-confirm">Set goal</button></div>`;
}

// Poll the status of one job until it ends, the page leaves the project, or the session ends.
// fetchStatus() gives { status, body }. onJob(job) gets the job, or null when the service knows none.
// stillShown() is false after a route change or an unload. believesRunning() is true when the page thinks a job runs.
// wait(ms) is replaceable, so a test needs no real timer. Returns the reason why it stopped.
export async function pollGoalStatus({ fetchStatus, onJob, stillShown, believesRunning, wait, everyMs = 3000 }) {
  for (;;) {
    if (!stillShown()) return 'left';
    let response;
    try { response = await fetchStatus(); } catch { return 'error'; }
    if (!stillShown()) return 'left';
    if (response.status === 401) { onJob({ state: 'signin' }); return 'signin'; }
    if (response.status === 404) { onJob(believesRunning() ? { state: 'interrupted' } : null); return 'missing'; }
    if (response.status !== 200 || !response.body) return 'error';
    onJob(response.body);
    if (!goalJobRunning(response.body)) return 'done';
    await wait(everyMs);
  }
}
