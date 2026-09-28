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

## Test thread flags

- Give every worker brief a thread limit of two for its test runner. The flag depends on the runner version and the configured pool; check it in the project first.
  - Vitest with the threads pool, or Vitest 3 and later: `vitest run --maxWorkers=2`.
  - Vitest 2 with the forks pool: `vitest run --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`. `--maxWorkers=2` fails there with an unhandled error, and no tests run.
  - Record the form that works in the project's instructions.

## Quota and pacing

- Run `herdr-boss lanes` to see each quota provider in one line: open, ahead of pace, near exhaustion, or exhausted until its reset.
- The line names the window that sets the state. When several windows are exhausted, the lane uses the latest reset.
- A provider is ahead of pace when any live window will not last until its reset, also at low usage, or when its use is above its goal-adjusted expected percentage.
- A quota pacing goal lowers the expected-use curve; an absent goal means 100%.
- The lanes output has an always-open unmetered lane. Prefer an unmetered model for bounded, well-specified work while a metered provider is ahead of pace. Reserve metered models for work that needs judgment.
- A worker-start refusal or least-over notice lists your project's unmetered alternatives first.
- Prefer an open provider.
- Ignore quota mode disables pacing below 100% but does not make an exhausted provider usable.
- `worker start` refuses an exhausted provider unless you use the explicit `--force` override.
- When every metered provider is ahead of pace, `worker start` allows the least-over provider without `--force`. Keep that task small.
- A quota window whose reset time has passed shows "reset, not yet measured" until the next reading. Do not use its old percentage as a reason for `--force`.
