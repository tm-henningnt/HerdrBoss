# Settings reference

## Rules and notices

| Condition | Action |
|---|---|
| A quota window reaches the critical percentage in `config.json` | Critical notice in the bulletin only. The bulletin tells orchestrators to avoid that kind. |
| A quota window reaches the warning percentage in `config.json` | Warning notice in the bulletin only. |
| A quota window that had a warning resets below the warning percentage in `config.json` | `Quota restriction cleared` notice in the bulletin only. |
| A live quota window is at 100% or more | The provider lane is exhausted until the latest reset among its exhausted windows. `worker start` refuses it unless you use `--force`. |
| A window has a use of at least the minimum use, and its use is more than the pace tolerance above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| A finished worker run stays uncollected for 30 minutes | One notice to the project orchestrator with the `worker collect NAME` command. The timer starts from the report or finish time in the run record when present. Otherwise, it starts when the service first sees the done pane. Change the delay with `workers.uncollectedNoticeMinutes` (1 to 1440 minutes). |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |
| A parent-PID-1 process has its current working directory in a missing worktree | Notice that project's `orch` workspace. Do not notify the Boss workspace. |
| A non-orchestrator worker stays blocked for more than 5 minutes | Notice its project orchestrator with the worker name and pane ID. |
| A worker pane with an unfinished run stays idle or done for 10 minutes without `.worker/report.json` in its worktree | One info item for that idle period. It joins the project's pane digest. A digest goes to an idle or done orchestrator, or to a working orchestrator when an item has been due for more than 3 hours. The pane gets a digest at most once in 2 hours. |
| An `orch` pane stays `idle` or `done` for the configured idle minutes while its published status has an actionable task | Notice that project with the task ID and title. When the project has a free effective slot, name the first lane from **Use now**. |
| The service starts, and the checked-out branch has new commits that change `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md`, and at least one of those changes has impact `required` | One `Kit updated` digest to each project orchestrator, at most once in `machine.kitDigestMinutes` minutes, with the kit revision and the subjects of the required changes that the pane has not received, newest first. Do not notify the Boss workspace or a project that is paused, held, or stood down. |
| A worker is working, first appears idle or done, or changes into either state | Herdr Boss reads only the last 8 visible pane lines. A known provider error marks the worker failed and sends the orchestrator its name, pane ID, and fixed error label. |
| A worker writes `.worker/report.json` or `.worker/<name>/report.json` after its pane first appears, and its pane shows no `herdr agent prompt` command with `WORKER REPORT <name>` within 2 minutes | One notice per report file path. A rewrite of the same file sends no new notice. A worker that sends its `WORKER REPORT` prompt causes no notice. |
| A managed project browser starts and responds | `browser is ready` notice in the bulletin only. |
| A published project status is stale: it is old while workers ran or commits landed, or an active worker runs a task that is not `doing` | One `info` item for each stale status. It joins the project's pane digest. A digest goes to an idle or done orchestrator, or to a working orchestrator when an item has been due for more than 3 hours. The pane gets a digest at most once in 2 hours. The bulletin shows `Status stale since <time>.` in the project section. See [Live task state](dashboard.md#live-task-state). |

The no-report watchdog starts its timer when a worker first appears idle or done. A change between these two states does not reset the timer. The reminder joins the shared info digest for that project's `orch` pane. Herdr Boss sends it once in the idle period. A working pane resets the worker's idle period. If the digest item stays due for more than 3 hours, Herdr Boss can send the digest while the orchestrator works. It still sends no more than one digest in 2 hours. An existing `report.json` prevents the reminder.

The failure labels are `API Error`, `401`, `429`, `Connection lost`, `usage limit`, `rate limit`, `overloaded`, and `Free usage exceeded`. Matching ignores letter case and ignores each line whose trimmed text starts with `Tip:`. The matcher requires error forms for `401` (`401 Unauthorized`, `HTTP 401`, or `status 401`) and `usage limit` (`usage limit reached`, `usage limit exceeded`, or `hit your usage limit`). Herdr Boss stores and sends only the matched label and a parsed retry time. It does not store or forward pane output. Herdr Boss reads a working pane on every engine tick, so a failure is found while the worker still works. A matched worker shows the failed status in the snapshot even when Herdr reports it working. The engine then does not count it as running, so its slot becomes free. A failure found in a working pane clears when a later read shows no known failure. A failure found on an idle or done pane clears when that pane starts working and a later read shows no known failure. Any failed status clears when a different worker uses the pane. A later failure creates a new notice. A valid free-usage retry time marks only the matching model unavailable until that time. Other models in its harness stay available. Without a parsed retry time, the model uses a 60-minute cooldown. A later absolute retry time in the same pane extends the model cooldown. Herdr Boss measures a relative retry time from the first observation of the failure.

An idle-orchestrator nudge reads the published project status file. Herdr Boss sends it only when the project mode is `auto` or `active`. It skips the `idle` and `paused` modes and the Boss workspace. The `orch` pane must be `idle` or `done` for at least the configured idle minutes. No other worker in that workspace may be `working`, `blocked`, or `failed`.

Herdr Boss holds the ready-work nudge back while the project has open work. Open work is an open review pack, a task in status `review`, a `spec` task in status `doing` with no live worker, or a published `phase` or `summary` text that kept the same value for `staleTextMinutes`. A task in a held group and an epic card do not count; the ready-work picker skips them too. A failed review pack read also holds the nudge back, and Herdr Boss logs the reason. The notice then says `Orchestrator idle with open packs` or `Orchestrator idle with a pending status review` instead. That notice is in the bulletin only, so it does not prompt the waiting orchestrator. It names the open items and does not ask for new work.

A task is actionable when its status is `todo`, `doing`, or `review` and every ID in its `blockedBy` list is `done` in the same project. An unknown blocker stays unresolved. A task with status `blocked` is never actionable. Herdr Boss picks one actionable task: current frontier first, then a task without a frontier value, then next frontier. Status-file order decides a tie.

A task in a group with `"held": true` is not actionable. A task with `kind` `epic` and a task that waits on the Owner are not actionable. The nudge then names the next actionable task outside the held group, or sends no notice.

The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work yourself. Check **Use now** when the project has a free effective slot. If it lists a lane, start ready work on that lane's harness. The notice uses one key per project and task, so the normal notice cooldown limits repeats. A different next task gets a new key and can prompt again.

A notice is a prompt to an `orch` pane. Herdr Boss normally sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. An immediate notice with severity `warn` or `critical` also goes to a `working` orchestrator. Worker failure notices are of this type. An immediate `info` notice, for example a worker report notice, waits until the orchestrator is `idle` or `done`. A shared info digest can also reach a working orchestrator when an item has been due for more than 3 hours. The pane gets no more than one info digest in 2 hours. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`.

Some notices are in the bulletin only and are never sent as a prompt. These are the quota notices at 90% and 98%, the `Quota restriction cleared` notice, and the `browser is ready` notice. The alert source marks each of them with `prompt: false`. Worker failure, blocked-worker, kit, handover, disk, and machine-limit notices are sent as prompts.

Herdr Boss sends the `info` notices of one pane as one digest. All `info` notices of all kinds use the digest. A pane gets at most one digest in 2 hours. Herdr Boss sends no digest while the pane status is `working`. The digest waits until the status is `idle` or `done`. The first digest goes out as soon as the pane is settled. Other `info` notices for that pane wait. The digest sends all waiting `info` notices together, one line each. It shows at most 8 of these lines, then one `and N more` line. The bulletin lists all notices. Kit notices are not part of this digest. See the kit digest below. The 2-hour limit does not apply to `warn` and `critical` notices. They arrive at once. A `warn` or `critical` prompt inside the 2 hours does not include the waiting `info` notices.

A notice with severity `warn` and a key that starts with `machine:` or `browser:` joins the digest with the `info` notices. It waits for the same 2-hour interval. It goes out in the same prompt as the `info` notices, one line each. The keys that use this path are `machine:swap`, `machine:mem`, `machine:load`, and `browser:managed-down`. The digest lists each key once, with its newest text. A key that is no longer active is not listed. The notice cooldown still decides when a digest sends the same key again. A notice with severity `critical` keeps its own path and goes out at once. An `immediate` notice keeps its own path, so `browser:managed-unresponsive` goes out at once. A key that starts with `machine:disk:` keeps its own path and goes out at once.

The board digest (`board:diverge:` keys) joins the same digest. Each project orchestrator gets one line for its own project, at most once in each 2-hour interval. The engine sends no board digest when a worker of the project runs and the orchestrator had no turn since the last board digest. The orchestrator waits for the worker report in that case.

Herdr does not show a draft or an open dialog in a pane. Herdr Boss does not detect them. An agent that waits for input has the status `blocked`, and Herdr Boss sends it no prompt except an immediate `warn` or `critical` notice.

The kit notice goes to every project orchestrator, also when the project has no active workers. It skips a pane that Herdr Boss first saw after the kit change was recorded. That pane loaded the changed kit when it started. A pane without a recorded first-seen time receives the notice. The Boss workspace and the workspace of a paused, held, or stood-down project do not get it. The kit reminder skips such a project too, and its 2-hour clock starts again when the hold ends. A project is paused when its published `status` is `paused`, or when its allocation mode is `paused`. The kit notice uses the same rule as the handover skip. Herdr Boss finds the workspace of a paused project by the published `workspace` id, by the allocation, by a workspace label that equals the project slug or name, or by an orchestrator pane that runs in the project repository. Each kit notice path uses this one rule. A change that arrived during the hold stays pending. The orchestrator gets it in one digest when the hold ends, if the change is not older than 7 days. Older changes reach the project through the kit reminder. When the engine starts, it reads Git once in the directory that the service runs from. It runs no timers and no model calls. It stores the last notified commit and the current kit revision as `kitNotice` in `memory.json`. On the first start, it stores `HEAD` and sends nothing. When Git fails, or the stored commit is not an ancestor of `HEAD`, it stores `HEAD`, sends nothing, and logs one `kit` event. The engine keeps each required change as pending, also over a restart, until a pane receives it. A pane gets at most one kit digest in the number of minutes in `machine.kitDigestMinutes` (default 120, range 10 to 1440). The first kit digest of a pane goes out at once. A change that arrives inside the interval waits and joins the next digest. The digest lists all pending changes that the pane has not received. Herdr Boss sends no kit digest while the pane is `working`. It sends the digest when the pane is `idle` or `done`. The kit digest has its own interval and does not use the 2-hour interval of the `info` digest. A change stays pending for 7 days. The read-only preview does not read Git and does not send or store the notice.

The engine sends the notice only when at least one new kit change has impact `required`. A change with impact `useful` or `none` sends no notice, and a mixed batch names only the required changes. The impact comes from the `Kit-Impact:` trailer of the commit message. When a commit has no usable trailer, the engine reads the impact from the matching entry in `kit/CHANGES.md`. It uses the entry only when the number of entries after the stored revision equals the number of commits that changed an installed kit asset. Otherwise the change has impact `useful`. Only a trailer or a change log entry sets `required`. A stored notice from an older release has no revision, so its first batch has impact `useful` unless a trailer says otherwise.

Each commit that changes `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md` must carry a `Kit-Impact: required`, `Kit-Impact: useful`, or `Kit-Impact: none` trailer, or must change `kit/CHANGES.md`. Put the trailer in the last block of the commit message. `test/kit-impact-trailer.test.js` reads the Git log and fails for a commit after the base commit `9679bcd` that has neither. Use `required` only when a project must run `herdr-boss kit update` to keep working.

The notice text is `[herdr-boss] Kit revision <revision> (<n> change(s)): <subjects>. Run herdr-boss kit update, set kitRevision in the status to the v= value of docs/orchestration/herdr-boss.md, and publish. The command prints the current kit file.` It names at most 10 subjects, then `and N more`. The revision in the notice is the kit revision of the directory that the service runs from. When you get a kit notice, run `herdr-boss kit update`. The command installs the kit as `herdr-boss kit install` does, prints the digest of the kit changes since the installed kit revision, and prints the current kit file. Do not read the kit file again. Then set `kitRevision` in the status to the `v=` value of the kit file and publish. A project that stays `behind (required)` for 2 hours gets a reminder. The service starts the 2 hours when it first sees the project behind on a required change. It repeats the reminder every 2 hours while the kit revision does not change. The clock stops when the project catches up or is behind on useful changes only. The reminder text is `[herdr-boss] Your kit is behind on a required change. Run herdr-boss kit update, set kitRevision in the status to the v= value of docs/orchestration/herdr-boss.md, and publish. Kit revision now <revision>.` The reminder goes to the project orchestrator in any state: idle, done, or working. The reminder shows no desktop notification. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). The legacy top-level `alertCooldownSeconds` value in `config.json` is unused.

A published project status is stale when both conditions are true:

- Its `updated` time is more than `staleStatusMinutes` old. The default is 120 minutes. Set it in `config.json`.
- After the `updated` time, a worker of the project was `working` in the last 2 hours, or new commits landed on the project repository.

A paused project is never stale. Herdr Boss finds the repository in `project-repos.json`. A project without a repository record uses only the worker condition. Herdr Boss runs `git -C <repo> rev-parse HEAD` and `git -C <repo> log -1 --format=%cI` at most once every 10 minutes for each project. New commits landed when the HEAD commit time is after `updated`, or when `HEAD` changed after `updated`.

The stale notice text is `Your published status is <age> old while <workers ran | new commits landed>. Run herdr-boss publish <slug> <file> with the current plan and progress.` The notice uses one key for each project and `updated` time. It joins the shared pane digest. The digest normally waits until the orchestrator is idle or done. If an item stays due for more than 3 hours, Herdr Boss can send the digest while the orchestrator works. The pane gets an info digest at most once in 2 hours. A new publish ends the stale status. When the new status becomes stale, Herdr Boss sends a new notice.

A published `phase` or `summary` is stale text when its value stays the same for `staleTextMinutes` (default 360 minutes). Herdr Boss keeps the hash and the first time of each text per project in `memory.json`. It sends one notice for each stale period to the project lead. The notice names the unchanged fields and says `Rewrite it at the next publish`. A field that changes starts a new period. A paused project never gets this notice.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

### Current guidance

The Overview shows the current guidance in a collapsed section under the page header. The section header shows one summary line, for example `Use now: free models, codex · Claude ahead of pace · 1 warning`. The line holds these parts:

- `Watch on` or `Watch until HH:MM` while a watch runs.
- The Use now lanes, in the order of the bulletin Use now line. `free models` is the open unmetered lane.
- Each metered lane that is ahead of pace, near exhaustion, or exhausted, and a Claude lane that holds new Claude work.
- The number of critical rules, warnings, and advice lines.

Select the header to open the section. It shows the watch line, one chip for each quota lane with its state and use, and the same rules as the bulletin. The browser remembers the open or closed state in its local storage. The Analytics page has the activity log.

The Overview shows its sections in this order:

1. The current guidance.
2. **Needs your decision**, when a task waits on the Owner. See [Needs your decision](dashboard.md#needs-your-decision).
3. **Needs attention**: the warnings and critical alerts. **Details** opens the current guidance at its rules. **Adjust policy** opens the Allocation page.
4. **Project continuity**: the prepared handovers that wait for review. When no handover waits, the section is one line under **Needs attention**, and **Needs attention** uses the full width.
5. The projects, the subscriptions, and the machine health.

## Watch

The watch says that the Owner is away. The Boss acts for the Owner until the end time of the watch, or until the Owner cancels it.

The state lives in the file `watch.json` in the data directory. The file is beside `policy.json` and `rules.json`. Its mode is `0600`. Herdr Boss reads the file once per engine tick and writes the result to `snap.night`. Herdr Boss also reads the old file name `night.json` when `watch.json` is missing.

The stored record holds these keys:

| Key | Meaning |
|---|---|
| `active` | The watch runs. |
| `since` | The ISO time at which the watch started. |
| `until` | The ISO time at which the watch ends. It is `null` for a watch until cancelled. |
| `untilCancelled` | The watch runs until the Owner stops it. |
| `reportAt` | The ISO time for the next report. It defaults to `until`. A watch until cancelled has no `reportAt` unless a daily report is set. |
| `reportDaily` | The local `HH:MM` time of a daily report. It applies to a watch until cancelled. |
| `retroAt` | The optional ISO time for the retro. |
| `by` | Who started the watch. |
| `quietHours` | Quiet hours are on. The default is `false`. |
| `noticeStartAt` | The ISO time of the start notice, for each pane that got it. |
| `noticeStopAt` | The ISO time of the end notice, for each pane that got it. |
| `reportSentAt`, `retroSentAt` | The ISO time when each report was posted. |
| `standDown` | The last stand-down of the Owner: `{ at, projects }`. Each project in `projects` is a slug and the policy mode it had before the stand-down. |

A state whose `until` time has passed reads as not active. The file stays, so the engine can read its own marks. A missing or unreadable file reads as not active. The read view of an active state is `{ active, since, until, untilCancelled, reportAt, reportDaily, by, quietHours }`. The read view of any other state is `{ active: false }`. A stored stand-down mark adds a `standDown` key to the read view. See [Stand down](#stand-down).

An active watch state also makes the Owner away. The machine limits are the same away limits as for an idle Owner. The watch changes no machine limit.

Set these worker caps in `config.json`. The old keys `night.maxWorkers`, `night.maxWorkersByLane`, and `night.quietHours` still work. A key under `watch` wins over the same key under `night`.

| Setting | Meaning | Value |
|---|---|---|
| `watch.maxWorkers` | Maximum number of working agents during the watch. | Use `null` to keep the day value. Otherwise, set an integer from 1 to 40. |
| `watch.maxWorkersByLane` | Maximum number of working agents in each provider lane during the watch. | Set `unmetered`, `codex`, `claude`, or `opencodego` to `null` or an integer from 1 to 40. Omit a lane to keep its day value. |

The watch caps apply only while the watch is active. Project shares and idle slot lending still apply under the global cap. The machine CPU and load guard limits still block worker starts during the watch.

The bulletin then shows one line under **Rules now**: `Watch until Wed 08:00 (Owner away). Work as normal; the Boss handles judgment calls.` A watch until cancelled shows `Watch until cancelled`. The time is the local end time. When `quietHours` is true, the bulletin also shows `Quiet hours: on.`

The watch worker caps also appear in the bulletin and in **Settings**. Set them there or edit `config.json`.

Quiet hours are optional and are off by default. Set `watch.quietHours` in `config.json` to choose the default for new watches. Run `herdr-boss watch start --quiet-hours` to turn them on. Run `herdr-boss watch start --no-quiet-hours` to turn them off. A value sent from the dashboard also overrides the default.

Quiet hours hold three service actions:

- Herdr Boss queues desktop notifications. It shows them once when the watch ends.
- Herdr Boss waits to release an expired manual `full-suite` lock. It still takes over a lock with a dead holder.
- Herdr Boss waits to reclaim a lease only when its TTL expires. It still reclaims a lease for a gone pane or a finished worker.

Herdr Boss starts no browser restarts of its own. A person or an agent can still request a browser restart during quiet hours.

Quiet hours do not hold pushes, deploys, gates, quota rules, worker starts, nudges, or reports. Herdr Boss writes every alert and event to `events.jsonl`.

### Watch notices

The engine sends one start notice to each orchestrator pane and to the Boss pane. It sends the notice as a direct prompt, so a working orchestrator also receives it. The notice is not a resource notice. It does not use the idle gate and it does not use the 2-hour `info` limit.

The start notice reads: `[herdr-boss] Watch until Wed 08:00. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.` The time is the local `until` time of the stored state. A watch until cancelled reads `[herdr-boss] Watch until cancelled.` at the start.

The engine sends one end notice when the watch ends. The end notice reads: `[herdr-boss] Watch ended. The Owner rules apply again.` A pane gets the end notice only when it got the start notice.

The engine stores the send time of each notice in the record, under `noticeStartAt` or `noticeStopAt`, with the pane as the key. A restart reads those marks and sends no notice twice. A pane that joins during the watch gets the start notice at the next tick. A mark from before the `since` time belongs to an earlier watch, so it does not keep a notice from going out.

A failed send stores no mark. The next tick sends the notice again. A pane that no longer exists gets no end notice.

A stop clears the file. The engine then keeps the last active record in its own memory and sends the end notice from it.

### Watch in the dashboard

The top bar has a watch symbol, an eye, next to the chat, mail, and needs-action icons. The page has no banner, so the layout does not move when a watch starts.

- With no watch, the symbol is faded.
- While a watch runs, the symbol is clear. On a wide screen it has a small label: `until 08:00`, or `on` for a watch until cancelled. On a phone it is the icon only.
- Select the symbol to open a popover. Press `Esc` to close it. The popover shows the end time and the mode, and it has **Stop**. The page asks you to confirm a stop. A watch until cancelled also has **Stop**. With no watch, the popover links to the Agents page.

The **Agents** page has a **Watch** box at the top. The box header shows the watch state: `No watch runs` or `On watch until 08:00`. When no watch runs, the box is closed. Select the header to open it. While a watch runs, the box is open. The browser remembers the open or closed state in its local storage. The link in the popover and the link on the **Settings** page open the box. When no watch runs, the box has these controls:

- A date and time picker for the end time. The default is the next 07:30: today at 07:30 before 07:30, and tomorrow at 07:30 otherwise.
- The length of the watch in hours, next to the picker. A warning shows above 48 hours.
- **Until I cancel**. The watch then has no end time.
- **Daily report** with a time, by default 07:30. It shows only with **Until I cancel**. A watch until cancelled sends no report unless you select it.
- **Quiet hours**.
- **Start**. The button stays off while the end time is not in the future.

While a watch runs, the box has **Stop the watch**.

The dashboard uses these routes. They use the same functions as `herdr-boss watch start` and `herdr-boss watch stop`, and they keep the same time checks. The old paths `/api/night/start`, `/api/night/stop`, and `/api/night` still work.

| Route | Body | Answer |
|---|---|---|
| `POST /api/watch/start` | `{ "until": "2026-09-30T07:30:00+02:00", "quietHours": false }` or `{ "untilCancelled": true, "report": "07:30" }` | `200` with the new watch state, and a `warning` above 48 hours. |
| `POST /api/watch/stop` | `{}` | `200` with the new watch state. |
| `POST /api/watch/standdown` | `{}` | `200` with `paused` and `skipped`. |
| `POST /api/watch/standdown/undo` | `{}` | `200` with `restored`. |
| `GET /api/watch` | none | `200` with the watch state. |

See [Stand down](#stand-down) for the stand-down routes.

`until` is `HH:MM` local time, `YYYY-MM-DD HH:MM` local time, or an ISO time. An `HH:MM` value means the next such time. The end time must be in the future. A watch has no maximum length. A refused time answers `400` and keeps the stored state. A blank value uses the next 07:30. Do not send `until` with `untilCancelled`. The routes need the same access as the other dashboard write routes. The read-only preview refuses them. The start route records `by` as `dashboard`.

### Stand down

The stand-down parks the idle project orchestrators before the Owner goes offline. A stand-down changes the policy mode of a project to `paused`. It cancels no goal and starts no watch. The goal stays set in the pane, and the project resumes when the mode returns.

A paused project is skipped by the idle-orchestrator nudge, the kit reminder, and slot lending. A paused project lends all its slots.

The **Agents** page has a card **Stand down** under the **Watch** box. It has two buttons:

- **Stand down projects**. The card lists each parked project. It lists each project it left alone with its reason.
- **Resume projects**. The button shows only while a stand-down waits to be undone. The buttons use no confirm dialog. The card shows the last result.

The reasons are `worker running`, `orchestrator working`, and `already paused`. The facts are the same as the idle-orchestrator nudge: the orchestrator pane of the project and the worker panes of its workspace. The Boss workspace is never changed. A project with a reason is not parked. Select **Stand down projects** again later to park it.

The undo returns each project to the mode it had before. It restores only a project that is still paused. A project that the Owner changed in the meantime keeps its own mode. The undo clears the mark, also when it restored nothing.

Every mode change goes through the same save path as the Allocation page. The policy change log records it. See [Policy changes](#policy-changes). A project with no saved share takes a part of the shares that the other projects leave, so the saved shares keep adding up to 100. A stand-down changes no share of the Owner, so it asks for no share confirmation.

The routes are:

| Route | Body | Answer |
|---|---|---|
| `POST /api/watch/standdown` | `{}` | `200` with `{ paused: [slug], skipped: [{ slug, reason }] }`. |
| `POST /api/watch/standdown/undo` | `{}` | `200` with `{ restored: [slug] }`. |

Herdr Boss stores the time of the stand-down and the mode of each changed project in `watch.json`, under `standDown`. A second press keeps the mode of every project of the mark and adds the projects of that press. The route writes the mark after the policy save. A refused write, with the answers `400` and `409`, leaves the mark and the policy as they are. A watch start and a watch stop keep the mark, in the dashboard and in `herdr-boss watch`. The undo clears it. The read-only preview refuses both routes.

### Timed reports

Use `--report HH:MM` to set the report time. The default is the `--until` time. Use `--retro HH:MM` to set an optional retro time. Each time can also be `YYYY-MM-DD HH:MM` or an ISO timestamp. Each time must be in the future.

At each time, the service posts one report to the Owner in the Boss thread. A service restart does not post the same report again. A report does not wait for running tasks to finish.

A watch until cancelled has no report time unless you set one. Use `--report HH:MM` or the **Daily report** control. The service then posts one report every day at that time. The default time in the dashboard is 07:30.

Each report lists the tasks marked done since the watch started. It lists running tasks with their start times, and blocked tasks with the item they wait for. It also lists the worker count, each metered lane's share of recorded work time, and the notices and alerts raised during the watch. The report has at most 60 lines.

The report and its sent time stay in the message store and `watch.json`. The service keeps these records when the end time passes, so a late engine tick can still post the report.

### Watch routines

A routine is a prompt that the service sends to the Boss pane while a watch runs. The service owns the routines. A restart of the Boss pane does not stop them.

The kit holds the default routines as the files `kit/watch/*.md`. Each file starts with a front matter block: `title`, `model` (a model hint), and one schedule. `every: N` runs the routine every N minutes. `beforeEnd: HH:MM` runs it once, that long before the end of the watch. The rest of the file is the prompt text. The defaults are `Hourly check`, `Morning retrospective`, and `Morning summary and report`.

The Owner edits a routine in **Settings**, in the section **Watch routines**. The edit is saved in `watch-routines.json` in the data directory. It is a machine-level override. It never changes the kit file. **Reset to the kit text** removes the override. The Owner can also add a routine of their own.

The Watch box on the Agents page has a box for each routine, its schedule, and a text area for instructions for this watch. The box keeps the last choice of routines and schedules as the default of the next watch.

When a watch starts, the service arms the routines that are on and stores the instructions. A routine that runs before the end has no run in a watch until cancelled.

At each run time the service sends one prompt to the pane labeled `boss`: the routine text, then the instructions. The service sends the prompt only when the Boss pane is idle. If the Boss is busy, the service tries again at each tick until the next run is due. Then it skips the run and logs it. The service sends at most one routine per tick.

The service writes the state of each routine to `watch.json`. A restart repeats no routine. The Agents page shows the next run and the last run of each routine. The log has one line for each sent, waiting, and skipped run.

The start notice to the orchestrators and the Boss carries the instructions in one line.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it. A lane that is above its expected use but inside the pace tolerance shows as `on pace`, with its use, its expected use, and the tolerance.
- **ahead of pace**: a live window has a use of at least the minimum use, and its use is more than the pace tolerance above its goal-adjusted expected use. The lane shows when it is back on pace if it is not used.
- **trickle**: a window longer than 7 days is ahead of pace. The lane shows the daily allowance and today's use. You can start workers while today's use is below the allowance.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.
- **exhausted**: a live window is at 100% or more. The lane shows its label and reset time. Only `--force` can use it.

A provider is open only when every live, measured window is on pace and no live window is exhausted. Extra windows, such as a model-only window, do not count. A short window of 7 days or less still closes a trickle lane when it is ahead of pace. An exhausted or near-exhaustion window also closes the lane.

The bulletin and `herdr-boss lanes` show a **Use now** line before the metered lane details. The line lists open providers below pace first, from most room to least. It lists trickle providers with allowance left next, then other open providers. Each item gives a short reason. If no metered provider can take work, use an unmetered model or wait.

Claude weekly use of 80 percent or more, with more than 12 hours to the weekly reset, holds new Claude work. The bulletin and `herdr-boss lanes` say `hold new Claude work`, and the Use now line leaves Claude out. The line also shows `100 percent at <weekday day month HH:MM>` in local time. The time comes from the burn of the Claude weekly readings of the last 24 hours. The line shows no time when fewer than two readings exist, when the burn is not positive, or when the burn reaches 100 percent after the reset. The hold changes guidance only. The lane state and the worker start rules stay the same.

Codex uses its planned curve for lane guidance when quota history or a reset credit is available. The curve starts at a fixed anchor with the used percent of that time. A new reading never moves the anchor. The anchor moves in four cases: no anchor exists, `quotaPlan.burstPace` changes, the window reset time moves by more than 10 minutes, or use drops by more than 1 point below the anchor (a credit or a manual reset). The setting `quotaPlan.planMode` selects how the curve guides the lane. In `paced` mode, `Hold` means actual use is ahead of the curve by more than `quotaPlan.tolerance` plus `quotaPlan.holdMargin`. A saved `Hold` stays until the lead falls below `quotaPlan.tolerance` minus `quotaPlan.holdMargin`. This hysteresis stops the state from flapping near the tolerance. `On pace` means actual use is above the curve by no more than the tolerance. `Use now` means actual use is at or below the curve. In `burst` mode the curve is advice only and the lane stays `Use now`. The bulletin, `herdr-boss lanes`, the Overview, and the Analytics card show `ahead of plan by N points` or `behind plan by N points` in both modes. The same places show `at this rate: 95 percent about <weekday day month HH:MM>` for the burn of the last 24 hours. They show nothing when the last 24 hours hold fewer than two readings or the burn is not positive. The text says `not before the window reset` when the projected time follows the reset time, and `already at or above 95 percent` when use has reached the threshold. Near-exhaustion, exhausted, and trickle states keep priority over these labels. A Codex lane that is ahead of pace keeps the pace text, is not in the Use now line, and shows the plan label as an aside. With no quota history and no available credit, Codex keeps the linear lane guidance. The bulletin and `herdr-boss lanes` show one `Codex plan` line with the current recommendation and the next planned credit. This plan changes guidance only. It does not change worker admission, the reserve rule, or credit use.

Herdr Boss gives a trickle lane a daily allowance. With a goal end in the future, it divides the gap to the goal percent by the days left to that end. After the goal end, it divides the unused quota percent by the days left to reset. Without a goal end, it divides the gap to the goal percent by the days left to reset. The goal percent defaults to 100%. It counts today's use from the first quota record after 00:00 UTC. After a reset, it starts from the first record after that reset. With no record for today, it counts 0% use.

The bulletin and `herdr-boss lanes` show the allowance, today's use, and the goal. The Overview quota card shows the goal in each window row. It also shows the goal in the trickle footer. Each goal uses the form `goal: 100% by Thu 8 Oct`. The text shows the time for a one-off end within 48 hours. `worker start` allows a trickle lane below its allowance. At or above the allowance, it refuses until 00:00 UTC. Use `--force` to bypass this refusal. Automatic handover can use a trickle lane below its allowance.

When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage. When several windows are exhausted, the lane shows the one with the latest reset.

The **pace tolerance** is the number of percentage points that a window may be above its expected use and stay on pace. The default is 5. A window is ahead of pace only when its use is more than the tolerance above the expected use. A window at exactly the tolerance is on pace. A tolerance of 0 gives the strict rule. The **minimum use** is the used percent below which a window is never ahead of pace. The default is 30. A minimum use of 0 gives no minimum. A window below the minimum use is never ahead of pace. A window at or above the minimum use that will not last to its reset is ahead of pace at any tolerance, unless a timed goal end is still in the future. Set `paceTolerancePoints` (0 to 50) and `paceMinUsePercent` (0 to 100) in Settings under Provider quotas. The reserve and near-exhaustion rules do not use them.

A **quota pacing goal** is the most percent of a window that you want to use by its end. A goal without a separate end reaches its percent at reset. Herdr Boss scales the measured expected-use pace by `goal / 100` for this form. A timed goal rises from the live window start to its percent at the configured end. The line stays at that percent until reset. An unset goal means 100%, which preserves the normal pace. When a timed goal end passes, Herdr Boss uses the reset forecast to decide if a long window is ahead of pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

Choose a one-off local date and time, or choose a recurring number of whole hours before reset. Herdr Boss stores a one-off time as an ISO timestamp. It deletes that whole goal when the time passes or the quota window resets. It keeps a recurring offset for later windows. A goal end must be after now, after the current window start, and no later than its reset. Runs-out advice compares the current rate with the goal percent and the goal end. The advice names the goal end when the rate reaches the goal percent before that end. `herdr-boss lanes` and the bulletin show the goal and its end while the provider is open or restricted. The Settings page shows the reset of each window in local time, for example `Sat 3 Oct, 06:58`.

The same output has one **unmetered** lane. It lists every permitted unmetered model that can start, by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The lane leaves out three kinds of closed models and reports each one on a separate line with its reason:

- A model with an active free-usage retry. The line shows its retry time.
- A Pi model that Pi cannot use. Herdr Boss runs `pi --list-models` at most once every 15 minutes. Pi lists only the models that it can use. A Pi model is unavailable when the last good result does not list it. When Pi lists no row for the provider of the model, the line states that Pi has no credential for that provider. A failed run, or output without a header row, keeps the last good result. Without a good result, Herdr Boss does not hide a Pi model.

The lane is closed when it leaves out a model and no unmetered model remains. The bulletin and `herdr-boss lanes` use the same data. They do not offer an unavailable model as an alternative. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

`worker start` refuses a Pi model that the last good `pi --list-models` result does not list. `--force` does not bypass this refusal, because such a worker cannot run.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Quota reset plan

The Codex quota reset plan estimates when to apply available reset credits. It uses the longest measured Codex quota window, the last 14 days of quota history, and the credit status and expiry times. The plan shows a burst table, planned credit times, and fast and slow scenarios. Its guidance does not change worker starts or dispatch.

Herdr Boss refreshes the plan after a good quota reading. It saves announcements, observed usage drops, used credit IDs, and the last 50 plans in `quota-plan.json`. The service detects a possible reset when usage drops by more than 30 points between readings. A digest of the inputs lets the service skip a write when nothing changed.

Use `herdr-boss quota plan codex` to view the plan, the plan mode, the distance from the plan, and the projection at the recent burn. Use `--what-if TIME` to change the horizon for one calculation. Use `--announce TIME[:full|partial]` to examine a possible reset without saving it. Use `herdr-boss quota announce codex --at TIME` to save a known reset. A saved reset must be in the next 30 days. Only the Owner can save one through the dashboard API.

Herdr Boss never applies a reset credit. The Owner applies it in the Codex app. Use `herdr-boss quota credit used ID` only after the Owner confirms the application.

The service posts one approval item in the Mailbox when usage reaches the effective threshold and the plan says to apply a credit now. It also posts an item when a credit expires within 48 hours. The item shows usage, the current time, the exact expiry, and the point difference between applying now and waiting for the planned time in the fast and slow forecasts. The service does not post another item for a credit ID and expiry that already has an item, open or closed. A changed expiry allows one new item.

The service closes the item when you run `herdr-boss quota credit used ID`. When a quota reading shows a usage drop greater than 30 points before the regular reset time, the service marks the available credit with the earliest expiry as used. It also closes the open item of that credit. A drop at or after the regular reset time is a natural weekly reset and marks no credit. It sends one warning when an available credit enters the 24 hours before expiry. The warning uses the normal notice path.

Read [Quota reset planner](../quota-plan.md) for the calculation and API details.

## Settings and allocation

### Setting help and page order

Each setting on the Settings page and on the Allocation page has an **i** button. A setting that repeats for each harness, provider, routine, or project has one **i** button on the section or group header. Its rows have no button. The pages show no other explanation text, except one line where a change can lock the Owner out or lose data, and the status and error lines. Select the button, or focus it and press Enter or Space, to open a popup. The popup shows what the setting does, its default, its unit, its range, the effect of a higher and a lower value, and how the change takes effect. On a desktop, hold the pointer over the button to show the same popup. Press Escape to close it. A popup stays open when the page refreshes.

The Help panel of the Settings page has a guide to each group of settings: what the group controls, what it affects, which changes are safe, and if a restart is needed. The text of the popups, the guide, and the settings reference in `docs/cli.md` comes from one file, `public/setting-help.js`. A test fails when a setting has no explanation.

The Settings page lists the most used groups first: Harnesses, Provider quotas, Machine, Watch routines, and Resource pools. The **Advanced** section holds Avatars, Token prices, Service settings, Quota plan, Analytics, and Harness readiness. It is closed at first. The page remembers in this browser if you opened it.

The Advanced section opens by itself while a harness readiness row is not `ok` or a service settings save shows an error. Its header then shows how many items need attention.

The Settings page has one section for each harness. A harness section holds the harness availability, the preferred model, and one row for each model. Provider quota modes, quota pacing goals, and machine limits are below the harness sections. Settings shows the warning and critical quota percentages from `config.json`. The dashboard uses these values to color quota levels.

The **Service settings** table shows the values that the service uses. Each row shows whether the value comes from `config.json` or a default. The table groups rows under Paths, Machine, Quota, Quota plan, Status, Workers, Watch, Browsers, and Service. Set values with inputs, then select **Save** for that group. Herdr Boss writes only those values to `config.json` and applies them at once. Keep the quota warning below the critical value. After a save, each field of the group shows the value that the server stored. When a stored value differs from the typed value, the status line next to **Save** names the setting, the stored value, and the typed value. The `tickSeconds` and `quotaSeconds` rows apply at once. The `tickSeconds` range is 5 to 300 seconds. The `quotaSeconds` range is 30 to 3600 seconds. The `alertCooldownSeconds` row is read-only. It is an unused legacy value. Set the notice cooldown in the Machine group. The `push` row is a switch. Herdr Boss reads `push` at service start, so the row shows `restart required`. The environment variable `HERDR_BOSS_PUSH=0` overrides the saved value. The `port`, `host`, `providerKinds`, and `orchestratorLabel` rows stay read-only. A wrong port or host can lock the Owner out of the dashboard. Provider kinds and the orchestrator label are structural. Change them in `config.json` and restart the service. The table does not show access or Roamgate settings.

### Resource pools on the Settings page

The **Resource pools** panel on the Settings page holds the same pools as the Allocation page. Each pool row shows the name, the ports, the split, the idle minutes, the wait seconds, the lease TTL, the environment variable, and the values by port. A line under the row names each variable that holds a value and the ports it covers. The row never shows a value. Select **Edit** to change the pool. Select **Remove**, then confirm the name, to remove it. Select **Add pool** to create a pool. The editor, the save, and the remove dialog are the same as on the Allocation page. See [Port leases](browsers.md#port-leases) for the rules of a pool.

### Avatars

The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. A row shows the avatar, an **Upload image** control, and a **Reset** control. The image is a PNG, JPEG, or WebP file of at most 512 KB. See [Avatars](#avatars) for the rules, the storage, and the routes.

The **Harness readiness** table shows the status of each harness entry that orchestration needs. Each row shows the status, the area, and the item. The status is `ok`, `missing`, or `bad`. The table is read-only. It shows no file path and no setting value. Herdr Boss reads these entries at each service start and then every 10 minutes. Run `herdr-boss harness sync` to see the changes to make.

The model catalog is `kit/models.json`. The local policy can add model strings to one harness. Herdr Boss merges these extra models into the allow-list of that harness in worker start, handoff plan and prepare, the lanes and the bulletin, Settings, Allocation, and `herdr-boss models`. An extra model uses the launch arguments and effort rules of its harness.

Free `opencode/` models run only in the `opencode` harness. The Pi allow-list holds only `opencode-go/` models. Herdr Boss uses the `pi --list-models` result to hide a Pi model that Pi cannot use.

On Linux, the machine guard uses the CPU and memory limits of its cgroup v2 container. It also checks visible parent limits. CPU capacity can be a fraction of one CPU. Memory free is the capacity left below the memory limit. The collector subtracts reclaimable file cache (`inactive_file` and `active_file` in `memory.stat`) from the used memory, as the host path does. Used memory never goes below 0. Without a finite cgroup limit, the collector uses host values. Herdr Boss does not read cgroup v1 hosts. On a cgroup v1 host, the collector uses host values. Host free memory includes memory that the kernel can reclaim. The CPU count has at most 2 decimals. A known limit with unreadable current use shows an unknown use value. Swap uses the cgroup swap limit and current use when available.

CPU use comes from the change in the cgroup CPU counter between two reads. The first read and a counter reset use the process CPU sample. Linux load averages are host values. The load backstop compares them with the effective CPU capacity. Change CPU, load, memory, and swap thresholds in the existing Machine and Locks groups on Settings. Linux detection needs no new setting.

The Linux snapshot includes CPU, memory, and I/O pressure. Pressure is the percent of time that tasks wait for a resource. Read it with `herdr-boss tick --json` or `/api/state`. The collector uses cgroup pressure before host pressure. An unavailable resource or row shows `null`. Pressure adds no guard threshold. Linux does not measure the Owner's desktop idle time. It uses the present limits unless a watch is active. macOS readers keep their existing behavior.

At Linux service start, Herdr Boss checks for `lsof` and the procps `ps` command. A missing tool gives an installation warning in standard error and in the dashboard event log. The service continues. The check runs beside the first tick and does not delay it. The read-only preview skips the check. Install the named package to enable its process checks.

The Machine section saves its settings in `policy.json`. The machine guard is on by default. It is active only when it is on and its pause has expired. When it is off or paused, CPU and load thresholds do not warn or block worker starts. Memory and disk warnings stay on. Herdr Boss still shows measured CPU, load, and free disk space, the configured thresholds, and whether the Owner is present. Disk space uses the filesystem that contains the configured Herdr Boss data directory. GB means 2³⁰ bytes. The disk warning raises at 20 GB free or less and clears at 24 GB free or more. Between the two values the warning keeps its state, so a reading near 20 GB does not repeat the notice. The default critical alert starts below 5 GB free. Free percent is information only and displays to one decimal place. Disk worktree counts exclude the `boss` pane and the Boss workspace. Each Git repository is counted once and its notice goes to its project `orch` pane. Notices include linked and prunable worktree counts and the safe prune command. A notice sends when the disk level changes, including after recovery.

Herdr Boss reads Owner idle time from macOS `IOHIDSystem`. The default away time is 10 minutes. Missing or invalid idle data means the Owner is present. On macOS, CPU is total sampled process CPU, including other processes, divided by core count. The default CPU limits are 70% while present and 95% while away. Set the away CPU limit to blank to disable it. The default 5-minute load backstops are 3 times the core count while present and 8 times while away. Set a load backstop to blank to disable it. The load average stays visible when a backstop is disabled.

Use the switch in Settings or the Overview machine summary to turn the guard on or off. Choose a duration and select **Pause guard** to pause it. The guard becomes active again when the pause expires. Select **Resume guard** to end a pause early. Settings changes stay in a draft until you select **Apply policy**. Overview guard actions save to the current policy at once. They preserve other unsaved Settings changes. `herdr-boss lanes`, the bulletin, and worker-start output show whether the guard is active, off, or paused.

When Herdr Boss loads an older policy without `machine.guardEnabled`, it checks the saved thresholds. It turns the guard off and restores the default thresholds only for the exact old off tuple: present CPU 100, away CPU blank, and both load backstops blank. It keeps the saved Owner-away time and alert cooldown. For every other old policy, it turns the guard on and keeps the saved thresholds.

The swap warning uses three settings in the Machine section: `machine.swapWarnPercent` (default 80), `machine.swapRefusePercent` (default 95), and `machine.swapMinUsedGB` (default 2). A percent is a whole number from 1 to 100, or blank to turn the rule off. The GB value is a number from 0 to 1024. Herdr Boss computes the swap percent as swap used divided by swap total. The swap total on macOS grows with use, so the warning also needs at least `swapMinUsedGB` of swap in use.

The engine raises the alert `machine:swap` with severity `warn` and the title `Swap high: N% used` when the last 3 samples are at or above `swapWarnPercent` and each has at least `swapMinUsedGB` in use. The engine takes one sample at each tick, which is every 30 seconds by default. The alert clears when swap is more than 5 points below `swapWarnPercent`, or below the GB floor. The alert does not depend on the machine guard. It stays on when the guard is off or paused. The alert never blocks a worker start or a suite. The notice cooldown applies to it.

The alert text is advice. It gives the swap percent and the GB in use. It says that macOS swap grows on demand, so a high figure alone does not mean the machine is short of memory. It says whether the swap refusal is on or off. It gives the browser rule: use at most 1 browser worker at a time while swap is above the warning level, and up to 3 otherwise. It says that one worker at a time is fine, and it asks the reader to close finished workers and their browsers. When the machine samples show it, the text ends with one line such as "Swap was above the warning level in hours 14 to 17 on 3 of the last 7 days." The line uses local hours of the day and aggregate counts only. It names an hour only when that hour was high on at least 2 days, or on 1 day when only 1 day has data.

The swap refusal is off by default. Turn it on with the switch "Refuse new work at high swap" in the Machine section. When the switch is on and swap is at or above `swapRefusePercent` with at least `swapMinUsedGB` in use, an orchestrator or a worker cannot run `worker start`, `herdr-boss suite`, or `herdr-boss push` with a pre-push hook. The message shows the swap percent and the GB in use. A blank `swapRefusePercent` switches the refusal off.

Work that the Owner or the Boss starts is never refused. Rules older than 3 minutes never refuse. To override, add `--force-swap` to `worker start`, or set `HERDR_BOSS_FORCE_SWAP=1` for `suite` and `push`. `--force` does not override the refusal. `suite --reuse` returns 0 when it reuses a passing tree.

Policy settings take precedence over legacy `config.json` values. The old `machine.loadWarnFactor` field does not control machine guards. The legacy top-level `alertCooldownSeconds` field is unused. Notice delivery reads `machine.alertCooldownSeconds`.

Clear the **Available** box of a harness to disable that harness for every project. Choose a preferred model for a harness. Worker start and handoff use it when you omit an explicit model. An empty choice uses the harness default.

Choose **Route to a below-pace lane** to let `worker start` prefer a model of a lane that is far below its pace. It does this only when the kind can reach two or more lanes and you give no model. The command prints the reason. It records `modelSource: "pace"` and `modelRoute`. A lane that is ahead of pace or on hold is never chosen.

Each model row has a box and a provider route. Clear the box to disable the model in that harness for every project. A model can be in more than one harness. Each harness keeps its own box and its own route for the model, so a change in one harness does not change another harness.

An active provider cooldown marks a model unavailable and shows its retry time in Settings and `herdr-boss models`. `herdr-boss lanes` shows the model and its lane. A worker pane that reports `Free usage exceeded` puts that model on cooldown for 60 minutes, or until a later retry time that the provider reports. An overload such as `503 service_overloaded` puts that model on a fixed 30-minute cooldown. Other models in the lane stay available. When you omit `--model`, `worker start` chooses the next available model in the same lane. The run record stores `modelSource: "fallback"` and `modelFallback` with the unavailable model, retry time, and reason. An explicit `--model` does not fall back.

An OpenCode pane can refuse a launch flag at launch. The pane shows `Unrecognized flag: FLAG`. Worker start then names the flag, closes the pane, removes the worktree and the branch, and marks no model. A TUI that rejects `--model` and `--agent` gets the model and the worker agent in `opencode.json` in the worker worktree instead. A pane that shows `not available in your country` marks the model unavailable until you re-enable it. A pane that shows `Rate limit exceeded` marks the model for 30 minutes. Worker start closes the pane and does not launch the same model again for these two phrases. The Models page shows the tag **unavailable until re-enabled** and the command `herdr-boss models enable KIND/MODEL`. `herdr-boss models disable KIND/MODEL` sets the same mark by hand.

A model with the **trial** tag is new and has fewer than 5 scorecard results. The tag shows on the Models page and in `herdr-boss lanes`. Record `--model-result` at each `worker collect`. The tag disappears at the fifth result. Verify the full diff of a trial model.

To add a model, type its string in the harness section and select **Add model**. A model string has 1 to 128 characters. It starts with a letter or a digit. It holds only letters, digits, dots (`.`), underscores (`_`), slashes (`/`), and hyphens (`-`). The server refuses whitespace and shell or control characters. A new model shows the **local** tag and starts unmetered. Select **Remove** to delete a local model. Remove also deletes its route, its disabled entry, its preferred-model choice, and its orchestrator succession choices.

Choose **Manage pace** to apply quota pacing for worker dispatch. Choose **Ignore quota** to stop quota pacing and pace warnings for worker dispatch. Handover risk and automatic handover still use live quota windows in every provider mode. A live window at 100% or more still exhausts the provider until its reset. Worker start refuses an exhausted provider unless you use `--force`.

Set a **quota pacing goal** for each measured window. The field shows the provider and the window label, such as `Codex Weekly goal %`. A blank field means 100%. Enter a whole percentage from 0 through 100. Select the end type and enter its value when needed. Use your local date and time for a one-off end. Enter a positive whole number of hours for a recurring end. The page checks the current time and the live window before it saves. An invalid end shows an error and keeps your draft. `pacingGoals` in `policy.json` stores the value by provider and by the window key (`primary`, `secondary`, or `tertiary`). Old integer values stay valid. Clearing the field removes that goal and restores 100%.

Choose a provider to route a model to its quota. Choose **Unmetered** to store `null`.

The provider choices depend on the harness:

| Harness | Provider choices |
| --- | --- |
| `codex` | Codex, Unmetered |
| `claude` | Claude, Unmetered |
| `opencode`, `pi` | Claude, Codex, OpenCode Go, Unmetered |

Codex uses OpenAI subscription models, and Claude uses Anthropic subscription models. The server refuses a `harnessRoutes` entry that sends a Codex model to Claude or OpenCode Go, or a Claude model to Codex or OpenCode Go. The error names the harness, the model, and the permitted choices, for example `harnessRoutes: codex/gpt-6-luna cannot use claude. Choose codex or null (unmetered).` The same rule applies to a legacy `modelProviders` route that a Codex or Claude harness inherits:

- **Load:** an incompatible legacy route never stops a policy from loading. Herdr Boss keeps the raw `modelProviders` value. It treats the model as Unmetered in that harness when no `harnessRoutes` entry overrides the route. Worker start, handoff, lanes, the bulletin, and usage records all use this unmetered result. The service log shows one warning for each such route. `policy show` and the API list these routes in the derived `ignoredRoutes` field. Herdr Boss does not store `ignoredRoutes`.
- **Settings:** the row shows **Ignored** and a note that names the ignored provider. Choose a provider in the row to store a compatible route in `harnessRoutes` for that harness. The page cannot restore the incompatible route.
- **Save:** Apply policy and `policy set` refuse a policy in which an available Codex or Claude harness inherits an incompatible legacy route without an override. The error names the harness, the model, and the permitted choices, for example `modelProviders: codex/gpt-6.1-sol inherits claude. Choose codex or null (unmetered) in harnessRoutes.codex.` A harness that is not available does not block a save. Herdr Boss finds the provider of a model in a harness in this order:

1. The route of that harness and model in `harnessRoutes`.
2. The route of the model in `modelProviders`, for all harnesses.
3. The harness rule: `codex` and `claude` use their own provider quotas.
4. The prefix rule: an `opencode-go/` model uses the OpenCode Go quota.
5. Otherwise, the model is unmetered.

`policy.json` stores the model settings in these fields:

| Field | Shape | Meaning |
| --- | --- | --- |
| `extraModels` | `{ "pi": ["vendor/model"] }` | Local model strings for each harness. |
| `disabledModels` | `{ "opencode": ["vendor/model"] }` | Models that one harness does not use. |
| `harnessRoutes` | `{ "pi": { "vendor/model": null } }` | The provider route of a model in one harness. |
| `excludedModels` | `["vendor/model"]` | Models that no harness uses. |
| `modelProviders` | `{ "vendor/model": "codex" }` | The route of a model in every harness without its own route. |

Apply policy and `policy set` remove references to models that the catalog no longer allows, and repeated entries. They prune `modelProviders`, `harnessRoutes`, `disabledModels`, `extraModels`, `excludedModels`, `preferredModels`, and project `excludedModels`. Settings shows one note after the save. The note names each removed model and the field that held it. A malformed value still stops the save and shows an error.

Old policy files can omit all of these fields and `preferredModels` and `pacingGoals`. Herdr Boss keeps `excludedModels` and `modelProviders` values. When you enable a model in one harness and `excludedModels` lists it, Settings removes it from `excludedModels` and adds it to `disabledModels` for each other harness that lists it.

Both pages keep policy edits in a draft. Select **Apply policy** to save the draft. A rejected save shows the server error and keeps the draft.

The Allocation page sets the global worker limit, workspace project status, project shares and exclusions, and orchestrator succession. The project share is advisory. `worker start` enforces the global limit and the disabled harnesses and models.

### Policy changes

Herdr Boss guards the project shares. A write of the policy that changes 3 or more project shares needs a confirmation. A write that leaves the shares at a total other than 100 needs a second confirmation. A write that changes no share needs neither.

`PUT /api/policy` refuses such a write with status 409. The error names each changed project with its old and new share and tells how to confirm. Add `"confirmed": true` to the request body to confirm a change of 3 or more shares. Add `"allowSum": true` to save a total other than 100. The two flags are separate. The server does not store them in the policy.

The Allocation page shows a dialog before it saves 3 or more changed shares, and sends `confirmed: true` after you confirm. When the total is not 100, it shows a second dialog and sends `allowSum: true` after you confirm. The Settings page saves the whole policy without a share change and needs no flag.

`herdr-boss policy set FILE` applies the same rule. Add `--confirmed` and `--allow-sum` for the two confirmations. The `project new` policy step is an internal write. It keeps the previous total of the shares, so the guard does not block it.

Every write that changes a value adds one line to `policy-changes.jsonl` in the data directory. A line holds the time (`at`), the caller kind (`caller`), and the changed keys (`changes`). A key is the dotted path of a changed value, for example `projects.herdrboss.share` or `machine.swapWarnPercent`. Each change holds the old and the new value. A list or an object shows `changed`. A string has at most 80 characters. The log shows `changed` for a key that has a token, secret, password, credential, API key, or authorization part anywhere in its dotted path. A key has at most 120 characters. A write that changes nothing adds no line.

The caller kind is `page`, `cli`, `project-new`, or `unknown`. The Allocation page and the other pages send the header `x-herdr-boss-caller: page`. The CLI sets `cli`. The `project new` policy step sets `project-new`. A write without a marker, and any other value, has the kind `unknown`. The engine writes the policy when it migrates workspace labels or clears an expired one-off pacing goal. These writes have the kind `unknown`. A client sets the header, so the caller kind is a label and not authentication. The browser sign-in route also reads the header (see the sign-in section of the Browsers page). It does not prove who wrote.

The file keeps the last 500 lines and at most 256 KB. Herdr Boss trims it on each write and creates it with mode `0600`. A reader skips a line that is not valid and never fails. A line that is appended during a trim can be lost. The log is for diagnosis, not for audit. The Analytics page shows the last 100 entries in the section **Policy changes**.

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget in each worker brief. The default is 10 screenshots. The project setting overrides the kit default. Worker start appends any missing budget or copied input details when a project brief template omits those slots. Use `worker start --copy PATH` to copy a regular repository file into the worker's `.worker/inputs/` directory before the agent starts. Repeat `--copy` for each file. The command preserves repository subdirectories and refuses paths outside the repository. A read-only review worker also gets the review target as copied inputs: `--base BRANCH` copies the branch diff and the changed file list, and `--review-worktree PATH` copies the tracked uncommitted changes and the status of an uncommitted worktree. `--review-worktree` needs `--read-only`, and it does not combine with `--base`. The copy refuses the whole review when a tracked changed path is a dotenv, credential, key, token, secret, or OpenCode config file. The paths `.worker/` and `.orchestration/` stay in the review scope and do not refuse the copy. The copied status can list an untracked file name, but the copy never includes its content. The brief tells the worker to read those copies and not another worktree.

The Analytics page shows a **Model scorecard** chart. Its Details table has one row for each harness and model over the last 30 days. Each row shows the runs, the first-time, rework, and failed counts, the rework rate (rework plus failed, divided by the runs), and the median run duration. The table sorts by runs. The orchestrator records the model outcome at review time with `worker collect --model-result first-time|rework|failed` and, for rework or failure, `--model-reason TEXT`. The orchestrator's values win over the report's `modelOutcome`. When neither is given, the result is derived: `failed` when `--outcome failed` or `--gate-failed`, `rework` when `--rework` is more than 0, otherwise `first-time`.

### Token use and spend by role

The service reads the session logs of Claude Code, Codex, Pi, and OpenCode every 5 minutes. It keeps one number for each day: the token use, split by role and by harness. A day is the local calendar day of the machine, the same day as on the machine hours. The roles are `boss`, `orchestrator`, `worker`, and `other`. The Boss and the HerdrBoss orchestrator share one Claude transcript folder, so the session ID decides between them. Read the numbers with `herdr-boss spend [--days N]` or `GET /api/spend?days=N`. The Analytics page does not show them yet.

The service reads only counts: input, output, cache read, and cache write tokens, and the model name. It never reads or keeps message text or commands. The saved scan state keeps only the role, the worker and project names for matching, and one-way hashes of the folder and the session ID. It keeps no path and no raw session ID. The token total of a day is input plus output plus cache read plus cache write. A Codex input count that includes cached input is split, so the cached tokens count once.

The service finds the role of a session in this order:

1. The session ID of a live pane. The pane label `boss` gives `boss`. An orchestrator pane gives `orchestrator`. Any other agent pane gives `worker`.
   The handover records also give `boss`. A record of a Boss handover names the session that the Boss left and the session that took over. Both sessions are `boss`, also after the pane label changed.
2. The working folder inside the worker worktree folder, or inside a `<repo>-wt-<name>` folder. It gives `worker`.
3. A working folder that only Boss panes, or only orchestrator panes, used. It gives that role.
4. The working folder of a registered project repository. It gives `orchestrator`.
5. Otherwise the role is `other`.

The cost uses two sources. Pi and OpenCode log a cost for each message, and Herdr Boss keeps that cost. Claude and Codex logs hold no cost, so Herdr Boss multiplies the tokens by the price of the model.

The cost is in USD and carries the label `API-price equivalent`. The prices are the API list prices. The Owner is on a subscription and is not billed per token, so the number shows what the same tokens cost at API prices. The label appears in `herdr-boss spend`, in `GET /api/spend` (`costLabel`), and in this guide.

The price table is `src/spend-prices.json`, in USD per million tokens. It holds the Codex prices from `kit/models.md` and the Claude API prices for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-fable-5-1`, and the removed models `claude-opus-5` and `claude-sonnet-5`. Each Claude entry has the columns `input`, `output`, `cacheRead`, `cacheWrite` (5 minute), and `cacheWrite1h`, a `source`, and a `date`. A model without a price is `unpriced`. The summary shows its tokens as `unpriced` and leaves them out of the cost. The next summary prices the stored history again.

A Claude transcript can split a cache write into a 5 minute part and a 1 hour part (`cache_creation`). Herdr Boss prices the 1 hour part at `cacheWrite1h`. A cache write with no split is 5 minute. The token totals do not change.

An entry can list `unconfirmed` figures. The cache figures of `claude-opus-5-5` are `unconfirmed`: the cache read of 0.20 does not match 0.1 times the input price (0.40). Herdr Boss uses the listed figure. `herdr-boss spend` names each model with an `unconfirmed` figure that it used, and `GET /api/spend` lists them in `unconfirmedPrices`.

To change a price, write an override file. `GET /api/settings/prices` returns the price table, the default table (`defaults`), the source and date of each entry, and the current override. `PUT /api/settings/prices` replaces the override with `{"models": {"claude/claude-opus-5-5": {"cacheRead": 0.4}}}`. An empty `models` object removes the override. The route accepts only models that the table lists and the fields `input`, `output`, `cacheRead`, `cacheWrite`, and `cacheWrite1h`. Each value is a number from 0 to 1000. The server rejects other input with status 400 and keeps the old file. The file is `spend-prices.override.json` in the data directory. An overridden figure is no longer `unconfirmed`. The **Token prices** section of the Settings page edits the same override. It lists each model with the five price columns, the source and date, and the `unconfirmed` marks. Select **Save prices** to save. The page shows a server error when a value is rejected. Select **Reset to defaults** to remove the override.

A scan reads at most 16 MB of new log bytes, one chunk at a time, and lets the service work between chunks. The saved byte offset of each file lets the next scan continue. A log file older than 35 days is read only when the scan state already knows it, so a resumed old file continues from its offset. A Claude message that the transcript repeats counts once, by message ID and request ID, over the last 128 messages of a file. A line longer than 4 MB is skipped. A broken line is counted and skipped. A file that shrinks is read again from the start. If a harness log has lines but none holds usage counts, the harness status is `unavailable`, and Herdr Boss does not guess. OpenCode counts come from the token columns of its database. Claude subagent transcripts in the `subagents` folders are not read.

A worker run record in `usage.jsonl` has null token fields until a log matches it. The scan matches a record to one worker log by harness, project, worker name, and start time. It takes the log whose first message is closest to the run start, and it never gives one log to two records. It then fills `inputTokens` (input plus cache write), `outputTokens`, `cachedTokens` (cache read), and `cost`, and sets `tokenSource` to `measured`. `cost` stays null when a model has no price. A record with no matching log 24 hours after the run ends gets `tokenSource` `unavailable`. The model scorecard and `usage summary` use the filled values.

Set `artifactChecks` in `.herdr-boss.json` to check generated files during worker collection. Each rule has an `artifacts` glob and a `sources` glob. For example, use `docs/gallery/**/*.png` for artifacts and `extensions/**/src/**` for sources. The patterns are repository-relative POSIX paths. `*` matches within one path segment. `**` matches zero or more path segments. Herdr Boss rejects absolute paths, parent traversal, backslashes, empty patterns, and malformed rules.

Use the workspace switches above the project shares to include or exclude a live workspace. An excluded workspace stays visible on Agents with the marker **Not a project**. It does not appear on Projects or Overview. It has no project share or worker slots. Herdr Boss stores excluded workspace labels. It resolves a saved Herdr ID to its current label when possible. A workspace with a pane labelled `boss` is excluded automatically while that pane is present. Herdr Boss removes the legacy `policy.projects.boss` entry and redistributes other project shares in the same proportions.

Each project has two share values:

- The **set share** is the share in the policy draft. The bar widths show the set share. Drag a boundary or use the arrow keys to change it.
- The **effective share** is the number of worker slots that the project has now, divided by the applied maximum of working agents. The **effective slots** are that number of slots. These values come from the applied policy. They change only after you select **Apply policy**.

The line **Total** next to the bar shows the sum of the set shares, for example `Total 99 of 100`. When the sum is below 100, the button **Distribute the remaining N** adds the remainder to the largest share. Herdr Boss adds it only when you select the button. A sum above 100 shows a warning and blocks **Apply policy**.

A project that the policy holds but the project list does not shows the line `not in the project list` with its saved share. The share is read-only, counts in the total, and no save changes it.

The form always shows the shares that the policy holds, also when their sum is not 100. A project that has no share in the policy shows the marker `default, not saved`. Its default is a part of the room that the saved shares leave. Herdr Boss writes the default only when you change that share or confirm the dialog of **Apply policy**.

**Apply policy** shows a dialog before it saves in these cases:

- The form changes more than one share and you moved more than one boundary.
- The total changes by more than 5 points.
- A project has a default share that you did not change.

The dialog lists the old and the new share of every project. A move of one boundary between two neighbors saves without a dialog.

When the policy changes on the server, for example when `project new` adds a project, the form reloads if it has no unsaved edit. If it has an unsaved edit, the page shows `The policy changed on the server. Reload the shares?` Select **Reload the shares** to discard the edit and load the saved shares.

A bar segment shows its set share and its effective slots, for example `30% · 2`. A narrow segment shows only the set share or no label. Its tooltip shows all values.

An idle project is faded in the bar and in its row. A paused project is faded and striped.

The **base slots** of a project are its set share of the global worker limit. A project always keeps its own base slots unless it is idle or paused. When **Borrow idle shares** (`borrowIdle`) is on, the projects with unused slots give capacity to the projects that use all their slots:

- An idle or paused project lends all its base slots. Its effective slots are 0 plus any borrowed slots.
- Another project keeps all its base slots. It offers its unused slots, the base slots minus its running workers, to the borrowers. The offered slots stay in its own effective slots.
- A project is a borrower when it is not idle and its running workers are equal to or more than its base slots. Herdr Boss adds the lent slots and the offered slots, and gives the sum to the borrowers by share.
- When no project is a borrower, no project lends or offers slots.


The **Locks** panel on the Agents and Allocation pages shows the machine lock lanes. The long lane has one slot. The short lane has `locks.slots - 1` slots. Each lane shows its holders, queue, and predicted durations. A holder row also shows its project, pane, kind, slot, age, time left, and state. A short job that uses the long slot is marked as borrowed. The panel shows the lock lane guard limits. A queued short job that waits for the guard shows `waits: lane guard, 5-minute load 245% exceeds 231%` in its queue row. The job starts when the load drops. A manual lock expires after 60 minutes. A command lock ends when its command ends. A `suite` or `push` lock belongs to the process that holds it, so a handover that removes the old pane keeps a running suite lock; the next admission reclaims the lock when the process is gone. Herdr Boss takes over a stale lock. A history line shows the median hold time, median wait time, and median wait by lane for the last 7 days. Before the first lock change, it shows **No lock history yet.** A re-entrant suite under a push is not part of the medians. You cannot release a lock from this panel.

The `full-suite` machine lock uses one long lane and a short lane. The long lane holds at most one job. The short lane holds up to `slots - 1` jobs. With one slot, all jobs use the long lane. Each lane follows its own ticket order. A short job can use a free long slot only when no long job waits. A long job never uses a short slot. A suite that runs under a push keeps the push lane. A push that reuses a passed tree takes no lock.

Herdr Boss predicts a job from the median hold time of the last 10 releases for the same project, kind, and lock name in the last 14 days. It ignores takeovers, re-entrant lines, and reused pushes. A key with fewer than three releases has an unknown prediction and uses the long lane. A job uses the short lane when its predicted time is at or below the **Short job limit** setting. This setting defaults to 6 minutes. A key that is mostly fast but sometimes slow, such as a push that usually reuses a pass and sometimes runs the full suite, uses the long lane. Without this rule, its slow runs hold the short slot and block the short jobs of other projects. The predicted time is the median when the key has fewer than 10 releases. With 10 releases, it is the 90th percentile, and one slow release among them does not change the lane.

The **Locks** group on Settings sets the machine lock slots, the short job limit, and the machine guard. The default is 2 slots. Before a short job starts beside a long holder, the guard checks the latest machine sample against its load, swap, and free-memory limits. A missing sample or one older than three minutes passes. A short job stays in its queue when a limit fails. The wait line names the failed limit and its measured value. The guard does not delay a long job and does not run when no long job holds. The default limits are 231 percent load, 96 percent swap, and 40 percent free memory. Enter a whole number in each guard field. A blank field is invalid and shows a field error. A typed zero is valid. Select **Apply policy** to apply capacity and guard changes to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification.

Below the policy settings, the **Resource leases** panel shows each resource pool. The head of a pool shows the count of held and free items, the lease TTL, and the reclaim rule. A row for each item shows the state (Held, Idle, or Free), the holder project, the pane or worker, the lease age, the server, the listener, the idle minutes, and the time left. The server is the bound process ID, or `unbound`. The listener is `yes` when the port accepts a connection and `no` when it does not. A lease with no listener is idle and has a muted style. The idle minutes count from the last time that the port had a listener. **borrowed** marks an item of another project's split. The built-in pool `project-browsers` lists only its held ports and the count of free ports. A free item that a process listens on shows a warning row in the state **Unleased**, with the PID and the process name in the pane or worker column, the owner project, and the age. An unleased listener has no Release button: no project holds it. An invalid pool shows an error line. Select **Release** to give a lease back. The page names the pool, the item, the holder project, and the pane or worker, and asks you to confirm. The release removes the lease only while the holder project is still the project that the page shows. Otherwise the page reports that the lease changed, and you reload the page. A release never stops a process. A project browser that runs keeps its lease, so its **Release** button is disabled until you close the browser on the Browsers page.

Select **Add pool** to create a pool. Enter ports, ranges such as `8000-8009`, or items. Separate them with commas or lines. To add ports later, add a range such as `8005-8009`. Enter the project split as JSON. Set the environment variable, lease TTL, reclaim check, grace period, idle minutes, and the wait default. Add a value by port to hand a worker a variable that matches its port, for example a client ID. The value is stored in the private config file on this machine only. The page shows `set`, never the value. Select **Change** to replace a value. An empty value clears it. Keep ports 9222 to 9299 out of custom pools. Select **Edit** to change a config pool. Select **Remove**, then confirm the pool name, to remove it. A held item blocks removal and any update that drops it. A lease that is unbound and has had no listener for the idle minutes does not block: the save releases it. Herdr Boss saves the change to `config.json` and applies it at once. The built-in `project-browsers` pool has no edit or remove controls. The read-only preview refuses pool changes.

The Settings page has the same pools editor. See [Resource pools](#resource-pools-on-the-settings-page).

`worker start` prints one allocation line for the project: the running workers, the effective slots, the borrowed, lent, or free count, the global use, and the 5-minute load. When the project uses all its effective slots, `worker start` also prints an advisory notice. The notice does not stop the start.

