# Machine load, lanes, quota, and pacing

Read this file before you choose a lane for a new kind of task, when `herdr-boss lanes` shows a provider that is not open, and when the bulletin shows a machine limit.

## Allocation

- Check your project on the Boss dashboard or in `herdr-boss policy show` when capacity, provider availability, or handover changes. The dashboard's Allocation view is the Owner's control plane; apply its saved worker cap, project share, exclusions, and succession ladder.

## Lane choice

- Use `herdr-boss models` to inspect the configured model options.
- Treat `kit/models.json` as the source of truth for the machine allow-list.
- Choose a low-cost lane for a small, fully specified task with a clear local gate.
- Choose a stronger lane for cross-cutting work, hard diagnosis, or costly rework risk.
- Choose a visual reviewer for work that needs visual judgment.
- Choose a browser-capable lane when the task requires a live browser.
- Do not treat a successful launch as proof that a model is available for the task.
- Probe an unfamiliar lane with a harmless prompt before sending a long brief.
- Limit a shared cheap provider lane to two concurrent workers.
- Retry one provider overload on a different lane. A provider overload includes a free model; the retry goes to a different lane.

## Machine load

- All projects share one machine. A full test suite usually starts one test thread per CPU core.
- Read the Owner state, CPU limit, and 5-minute load backstop in the bulletin before dispatch.
- Stop new workers and full test suites while either active machine limit is exceeded.
- `worker start` enforces both limits, including when `--force` is set.
- Keep the load average visible when its backstop is disabled.
- Do not apply a fixed limit of your own.
- The lock lane guard (`locks.guard`; Settings page, Locks section) is separate from the machine guard (`machine.guardEnabled`). It holds a queued short-lane suite while the 5-minute load is above 231 percent of the cores, swap is above 96 percent, or free memory is below 40 percent. The suite waits until the load drops.

## Test thread flags

- Give every worker brief a thread limit of two for its test runner. The flag depends on the runner version and the configured pool; check it in the project first.
  - Vitest with the threads pool, or Vitest 3 and later: `vitest run --maxWorkers=2`.
  - Vitest 2 with the forks pool: `vitest run --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`. `--maxWorkers=2` fails there with an unhandled error, and no tests run.
  - Record the form that works in the project's instructions.

## Quota and pacing

- Run `herdr-boss lanes` to see each quota provider in one line: open, trickle, ahead of pace, near exhaustion, or exhausted until its reset.
- The line names the window that sets the state. When several windows are exhausted, the lane uses the latest reset.
- A provider is ahead of pace when a live window has a use of at least `paceMinUsePercent` (default 30%) and more than `paceTolerancePoints` (default 5) percentage points above its goal-adjusted expected percentage. A lane inside the tolerance is on pace, and `herdr-boss lanes` shows the tolerance. The Owner sets both values in Settings.
- A quota pacing goal lowers the expected-use curve; an absent goal means 100%.
- A window longer than 7 days can use a trickle lane when it is ahead of pace. The daily allowance is `(100 - used percent) / days left`. Herdr Boss uses at least 1 day for this calculation and rounds the displayed allowance to one decimal place.
- Herdr Boss measures today's use from the first matching quota record after 00:00 UTC. After a reset, it uses the first record after that reset. No record for today means 0% use.
- A short window of 7 days or less that is ahead of pace still closes the lane. An exhausted or near-exhaustion window also closes it.
- `worker start` allows a trickle lane below its daily allowance. At or above the allowance, it refuses until 00:00 UTC. Use `--force` to bypass this refusal.
- Automatic handover can use a trickle lane below its daily allowance.
- The bulletin, `herdr-boss lanes`, and the Overview quota card show the allowance and today's use.
- The lanes output has an always-open unmetered lane. Prefer an unmetered model for bounded, well-specified work while a metered provider is ahead of pace. Reserve metered models for work that needs judgment.
- A worker-start refusal or least-over notice lists your project's unmetered alternatives first.
- Prefer an open provider.
- Ignore quota mode disables pacing below 100% but does not make an exhausted provider usable.
- `worker start` refuses an exhausted provider unless you use the explicit `--force` override.
- When every metered provider is ahead of pace, `worker start` allows the least-over provider without `--force`. Keep that task small.
- A quota window whose reset time has passed shows "reset, not yet measured" until the next reading. Do not use its old percentage as a reason for `--force`.

## Serve leases

- Take a serve port with `herdr-boss lease acquire serve-ports --wait 600`. The command waits up to 10 minutes for a free port. It then fails with a clear message. A `serve-live` helper calls it with `--wait 600` before it fails.
- Bind the lease to the server process with `herdr-boss lease bind serve-ports PORT --pid PID`. You can also pass `--pid PID` to `lease acquire`. Herdr Boss releases a bound lease within one tick after the process ends.
- Run the bind at once when the server starts. A server that listens on a port with no lease is an unleased listener. Herdr Boss shows it as a warning in the Allocation page and tells the orchestrator of the owner after 10 minutes.
- Start the server soon after you take the lease. Herdr Boss reclaims a serve lease whose port has no listener for 20 minutes (`idleMinutes` of the pool). It sends one notice. Take a new port after the notice.
- Pick the client ID by port. When the pool has a value for the port, the lease hands it over in an environment variable, for example `TM_SERVE_LIVE_CLIENT_ID`. `worker start --lease` sets it in the worker pane. `lease acquire --env-file FILE` writes it for the shell to source.
- Never print the value in a pane, a report, or a brief.
