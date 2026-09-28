# Design: night watch mode

**Status:** Design. This document is not a specification. The Owner answered the two open questions on 2026-09-28.

## Problem

The Boss sets up each night by hand. It writes an Owner-away decision in several memory files, sends the same message to each orchestrator, and creates session-only cron jobs. In the morning it undoes all of it. The steps are easy to forget, and the cron jobs die with the Boss pane.

## 1. State

Add two commands.

```
herdr-boss night start [--until TIME] [--report TIME] [--retro TIME] [--quiet]
herdr-boss night stop
```

`TIME` is `HH:MM` local time. `--until` defaults to the next 07:30.

Store the state in `night.json` in the data folder, beside `policy.json` and `rules.json`. The file holds `active`, `startedAt`, `until`, `reportAt`, `retroAt`, `quietHours`, `noticeStartAt`, and `noticeStopAt`.

**Owner away.** `machineLimits()` in `src/control.js:118` sets the Owner state from `machine.ownerIdleMinutes`. Night watch adds a second source: the Owner is away when `night.active` is true. Both sources use the away CPU limit and the away load factor. Night watch changes no machine limit.

**Reads.** The engine reads `night.json` once per tick and writes `snap.night`. The dashboard reads `snap.night` from the same state push. The bulletin adds one line under `## Rules now`. The Boss's memory file refers to the bulletin and copies nothing.

## 2. Notices

The engine sends one start notice and one end notice to every orchestrator pane. It uses the direct prompt of the lock-takeover notice in `src/engine.js:1025`, not the alert queue, so a working orchestrator receives it too.

The start notice reads: `Owner away until 07:30. The Boss acts for the Owner. Escalate to the Boss.`

The end notice reads: `Owner is back. The Boss no longer acts for the Owner.`

The engine records each send in `memory.pushes` under `night:start@<pane>` and `night:end@<pane>`. It never sends a notice twice for the same night. A failed send stays unsent, so the next tick tries again. Orchestrators do not copy the notice into `memory.md`.

## 3. Service-side checks

The service runs `evaluate()` in `src/rules.js` every tick. Night watch adds no new check.

The service handles these itself: stale workers (`workers:stale`), a stale or expired lock, an idle or dead lease, a stale project status, a stale kit revision, a quota `warn` or `critical`, an offline managed browser, and a failed worker start in `src/worker-failures.js`.

The service wakes the Boss pane for a judgment call: a worker question or an escalation, a denial spike in `src/denials.js`, a project that stays stale 90 minutes after its first nudge, and a critical machine alert for memory, disk, or the guard. A night nudge keeps the `info` severity, so it stays inside the one-hour info pace.

## 4. Timed reports

The service owns two deadlines, re-armed each tick next to the loop timer in `src/server.js:605`. The jobs survive a Boss restart, because the service holds them.

The times come from `--report` and `--retro`, then from `night.defaultReportTime` and `night.defaultRetroTime` in `config.json`. The defaults are 07:30 and 07:00. Without a report time, the service uses the `--until` time.

At `retroAt` the service prompts the Boss pane once with a fixed task: write the retrospective. At `reportAt` it prompts it once with a fixed task: write the morning report. The Boss runs `herdr-boss mail post --to owner <file>`. The service does not write the report text.

`night stop` runs at the end time. It sends the end notice, clears `night.json`, and posts the night summary to the Owner mailbox. The service calls the message module directly, because `herdr-boss mail post` needs the boss pane.

## 5. Worker cap

Night watch raises the cap and never lowers it. `config.json` gets two keys:

```
night.capFree: 2
night.capMetered: 0
```

`capFree` counts the unmetered lanes and the quota-ignored lanes, such as the local models. `capMetered` counts the paid lanes. The cap is `policy.maxWorkers + capFree + capMetered`. A value of 0 means no raise for that lane class.

The machine limits still apply. `src/kit/workers.js:886` refuses a start on the load backstop, and `--force` cannot pass it. The new cap bypasses neither the backstop nor the memory and disk floors.

The allocation rules still apply. `deriveControl()` in `src/control.js:740` spreads the cap over the project shares, and `borrowIdle` still lends and borrows slots. One cap value serves the CLI, the dashboard, and the worker start check.

## 6. Quiet hours

`--quiet` and `night.quietHours` in `config.json` are off by default.

With quiet hours on, the service holds back these actions: a desktop notification, a restart of a managed browser or a shared browser, the expiry release of a manual `full-suite` lock, and a lease reclaim.

Quiet hours never holds back a push, a deploy, a gate, a quota rule, a worker start, a nudge, or a report. The service still writes every alert to `events.jsonl`.

## 7. Dashboard

Show a banner at the top of Overview, in the page join at `public/app.js:1004`. The banner shows the end time, the lane in use, and the effective cap. It has a `Stop` button.

The `Stop` button calls `POST /api/night/stop`. The server answers `200` with the new state. The banner hides after the state clears. Add the same text to the Machine settings block and to `HELP` in `public/app.js:3265`.

## 8. Task split

1. **Night state, read only.** `src/night.js` (new), `src/engine.js`, `src/control.js:118`, `test/night.test.js`. **S.** Read and save `night.json`, add `snap.night` and the bulletin line.
2. **Commands.** `src/cli.js`, `src/night.js`, `test/night.test.js`. **S.** Add `night start` and `night stop`, validate the times.
3. **Notices.** `src/engine.js:1025`, `test/notice-noise.test.js`. **S.** Send each notice once per pane.
4. **Cap.** `src/control.js:740`, `src/kit/workers.js:914`, `src/config.js:115`, `test/control.test.js`. **M.** Add the two keys, the cap sum, the clamp.
5. **Reports.** `src/engine.js`, `src/messages.js`, `test/night.test.js`. **M.** Arm the deadlines, fire each once, post the summary.
6. **Quiet hours.** `src/leases.js:116`, `src/kit/locks.js:91`, `src/engine.js:1040`, `test/night.test.js`. **M.** Gate the four held actions.
7. **Dashboard.** `public/app.js`, `public/style.css`, `src/server.js`, `test/server.test.js`. **M.** Add the banner, the stop route, the help text.

## Risks

- A notice reaches a pane that cannot take it. The send fails, and the next tick tries again.
- A higher cap fills the machine. The load backstop still refuses a start, and a cap key can go to 0.
- Quiet hours hides a fault. `events.jsonl` and the dashboard keep every alert.

## Open questions

- Should the night cap be per project, or only global?
- Should the report wait for a task that still runs at the end time?
