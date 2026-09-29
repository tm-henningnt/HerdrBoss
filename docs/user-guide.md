# User guide

This guide tells how Herdr Boss works and how to set it up. For commands and options, see [cli.md](cli.md). The dashboard has a **Help** panel on each page.

## Requirements

Use Node.js 26.10 or later. Herdr Boss uses the built-in `node:sqlite` module.

## How it works

Every 30 seconds, Herdr Boss reads Herdr workspaces and agents, machine load and memory, and automation browsers and their owner panes. Every 5 minutes, it reads subscription quotas with `codexbar usage --format json`.

The quota read runs beside the 30-second cycle. A slow `codexbar` does not delay the other reads. A later cycle applies the result. Only one quota read runs at a time. Herdr Boss stops `codexbar` after 240 seconds.

When a quota read fails, Herdr Boss keeps the last good quotas. The dashboard shows the error only when no quotas are younger than 15 minutes. The error text tells the cause:

- `codexbar timed out after 240 s`: the read took longer than 240 seconds.
- `codexbar exited with code N`: `codexbar` failed. The text adds the first line of its error output when there is one.

`codexbar` returns one row for each provider. When the probe for one provider fails, `codexbar` exits with code 1 but still returns the good rows. Herdr Boss keeps these rows. Then it reads each failed provider again one time with `codexbar usage --format json --provider NAME`. This retry also stops after 240 seconds. Herdr Boss uses the retry row when it has no error.

When the retry also fails, Herdr Boss keeps the last good row of that provider for 60 minutes. It marks this row as stale and adds the new error. The bulletin quota table shows the row as "Claude quota from HH:MM (probe failed)". The rules line is "Quota data for Claude is from HH:MM; the last probe failed." The dashboard shows the same text on the provider card. Pacing, quota notices, and provider lanes use a stale row as data. Automatic handover does not use a stale row. After 60 minutes, Herdr Boss removes the row and keeps only the error. The bulletin then says "Quota data unavailable for Claude".

At start, Herdr Boss loads the saved quotas from `state.json` when they are younger than 15 minutes. The dashboard shows "Quotas from HH:MM" for these saved quotas until the first new read succeeds. Automatic handover does not use saved quotas.

Then it applies its rules and writes these files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read it before each dispatch. |
| `rules.json` | The same rules for scripts. `worker start` reads it. |
| `state.json` | The full snapshot that the dashboard shows. |
| `events.jsonl` | Prompts, notifications, handovers, and stopped processes. |
| `policy.json` | The resource policy that you set on the Settings and Allocation pages. |
| `locks/` | Private project lock records. Each Git repository has a separate directory. |
| `lock-ledger.jsonl` | The lock ledger. One line for each lock acquire, release, and failed acquire. Rotates at 5 MB to `lock-ledger.1.jsonl`. |

`herdr-boss scratch <slug>` creates `~/.herdr-boss/scratch/<slug>/` for the orchestrator files of a project. Herdr Boss does not delete this folder.

Herdr Boss is a script. It uses no LLM and no tokens.

## Dashboard preview

A read-only preview accepts loopback requests only. It has no login page. It never reads, creates, or changes token or session files.

## Chat API

Use `GET /api/chats` to list the Boss chat and project chats with an orchestrator pane. The response gives each chat a title, a last message, and an unread count. A chat without messages has a `null` last message. The last message and each chat record have a `channel` field. The unread count leaves out a mail report.

Use `GET /api/chats/<thread>?limit=<n>&before=<id>` to read a chat. Set `limit` to an integer from 1 to 100. The default is 50. Set `before` to a message ID to read older messages. The response sets `more` to `true` when older messages remain. Each record has a `channel` field of `chat`, `both`, or `mail`.

Use `POST /api/chats/<thread>/read` to mark the unread chat records to the Owner as read. It does not mark a mail report read. The read-only preview refuses this request.

Use `POST /api/messages` to send an Owner message. Read `GET /api/events` to receive each message change as a `message` event.

## What the dashboard manages

Every setting and every resource that Herdr Boss manages is visible and settable in the dashboard, unless a good reason keeps it outside. These are the good reasons:

- A secret, such as a token or a credential.
- The access token file, and a session file.
- A Claude setting that agents must not edit.
- A code contract that must not move, such as the `orch` pane label or the built-in browser port range.
- A resource that another project or process owns, such as a shared browser that Herdr Boss did not start.
- A repository file that a release changes, such as the kit catalog or the kit template.

When a value stays outside, the dashboard names it and the reason. The audit and its gap list are in [gui-settings-audit.md](ideas/gui-settings-audit.md).

## Project memory

Store project memory in `docs/orchestration/memory.md`. Commit this file with the project repository.

Store Boss memory in `~/.herdr-boss/boss-memory.md`. Keep this file private and never commit it.

Start the Boss agent with `~/.herdr-boss` as its working folder, not a project repository. Claude Code keeps one memory folder per working folder. A Boss that starts in the HerdrBoss repository shares its Claude memory with the HerdrBoss orchestrator, so each one reads the other's notes.

Use these five sections in this order:

- `## Owner decisions in force`: Record one line per decision. Include the date (YYYY-MM-DD) and the source.
- `## Holds and freezes`: Record one line per hold. Include its start date, scope, and the condition that lifts it. Delete the line when the hold is lifted.
- `## Standing rules`: Record project rules that are not in `AGENTS.md` yet.
- `## Roles and panes`: Record facts that stay true for longer than one session.
- `## Evidence`: Record pointers to files, commits, or reports. Do not copy evidence into the file.

Keep current state only. Delete a line when a decision is superseded. Git keeps history.

Never store secrets, tokens, or credentials. In a public repository, do not store client names, tenant URLs, or details of other projects.

## Kit block in AGENTS.md

Herdr Boss keeps the shared orchestration rules in a kit file in each project repository: `docs/orchestration/herdr-boss.md`. Only Herdr Boss writes this file. Its first line is `<!-- herdr-boss kit v=<revision> -->`. The revision is the first 12 hex characters of the SHA-256 of the relative file names and contents in `kit/templates/`, `kit/skills/herdr-orchestrator/SKILL.md`, its reference files, and `kit/models.json`. Service, dashboard, and website changes do not change this revision. The project `AGENTS.md` holds a short stub between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The stub tells the orchestrator to read the kit file and `docs/orchestration/memory.md` at start, at resume, and on each `Kit updated` notice. `herdr-boss kit install` writes the kit file and the stub. `herdr-boss kit update` prints the kit changes since the installed kit revision, then runs the same install. The digest names the impact and the summary of each change, oldest first. It reads the installed revision from the version line of the project kit file. When the change log does not know that revision, the digest lists every known change. `--quiet` keeps the digest and the summary line, and hides the `wrote FILE` and `unchanged FILE` lines. The command always installs, also when the digest has no change. It also adds a Claude `SessionStart` hook to `.claude/settings.json`. At each session start the hook runs `herdr-boss kit update --quiet`, then prints both files. `herdr-boss worker start`, `herdr-boss publish`, and `herdr-boss handoff plan|prepare` print one line when the project kit is behind for a `required` or `useful` change. The line tells the orchestrator to run `herdr-boss kit update`. `herdr-boss check agents` finds a missing, old, or hand-edited kit file or stub. It also finds stale orchestration text outside the stub, such as fixed pane IDs, dated lines, copied model lists, and text that sends pushes or product decisions to the Boss. `herdr-boss publish` and `herdr-boss worker start` run the same check and warn. The project page shows the counts from the last `publish`. The orchestrator publishes the kit revision that it loaded as `kitRevision`. The project page shows that revision and the current revision, and a warning when they are different. `herdr-boss check kit` lists the loaded revision and the state of each project: `current`, `behind (useful only)`, `behind (required)`, or `not published`. Only `behind (required)` and `not published` fail the check. The project page shows a project that is `behind (useful only)` as a muted line. It shows a warning for `behind (required)`. A revision that `kit/CHANGES.md` does not list counts as `behind (required)`. The bulletin shows the current kit revision in its header. The commands are in [cli.md](cli.md).

## Orchestrators

Herdr Boss finds an orchestrator by its pane label `orch`. Tab names do not matter. An orchestrator can label its own pane:

```sh
herdr pane rename "$HERDR_PANE_ID" orch
```

The label stays when the agent in the pane restarts. The pane with the label `boss` is the Herdr Boss orchestrator itself.

`herdr-boss worker start` puts each worker in a pane of a worker tab in the workspace of the orchestrator. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes, so each pane stays wide enough to read. A new worker uses the first worker tab with a free slot and splits from the newest pane in that tab. When all worker tabs are full, the worker creates the tab with the lowest free label and uses its root pane. Set `workerPanesPerTab` in `.herdr-boss.json` to an integer from 1 to 6 to change the limit. Each worker gets a worktree in `~/Projects/.herdr-wt/<repo>/<name>`. A project can set another place in `.herdr-boss.json`. Herdr Boss does not move an existing worktree. An older worktree in a sibling folder `<repo>-wt-<name>` stays in use until `worktree prune` removes it. Read a worker dialog with `herdr agent read <name> --source recent-unwrapped`. This source joins wrapped lines, so a narrow pane still shows the complete dialog.

Orchestration needs settings in each agent harness: Claude `autoMode`, Codex `writable_roots` and rules, the OpenCode `worker` agent, and the Pi guard. [harness-setup.md](harness-setup.md) gives each setting and its risk. The first `publish` of a slug registers the project repository and adds its `.git` to the Codex writable roots. The parent folder `~/Projects/.herdr-wt` of all worker worktrees is one more Codex writable root. `herdr-boss harness sync` adds it. Run `herdr-boss harness check` when a harness refuses routine work.

To add the shared rules to a project, follow [orchestrator-instructions.md](orchestrator-instructions.md). The shared process is in [the orchestrator skill](../kit/skills/herdr-orchestrator/SKILL.md).

## Rules and notices

| Condition | Action |
|---|---|
| A quota window reaches the critical percentage in `config.json` | Critical notice in the bulletin only. The bulletin tells orchestrators to avoid that kind. |
| A quota window reaches the warning percentage in `config.json` | Warning notice in the bulletin only. |
| A quota window that had a warning resets below the warning percentage in `config.json` | `Quota restriction cleared` notice in the bulletin only. |
| A live quota window is at 100% or more | The provider lane is exhausted until the latest reset among its exhausted windows. `worker start` refuses it unless you use `--force`. |
| A quota runs out before its reset at the current pace, or its use is above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |
| A parent-PID-1 process has its current working directory in a missing worktree | Notice that project's `orch` workspace. Do not notify the Boss workspace. |
| A non-orchestrator worker stays blocked for more than 5 minutes | Notice its project orchestrator with the worker name and pane ID. |
| A worker pane with an unfinished run stays idle or done for 10 minutes without `.worker/report.json` in its worktree | One warning to its project orchestrator for that idle period. |
| An `orch` pane stays `idle` or `done` for the configured idle minutes while its published status has an actionable task | Notice that project with the task ID and title. When the project has a free effective slot, name the first lane from **Use now**. |
| The service starts, and the checked-out branch has new commits that change `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md`, and at least one of those changes has impact `required` | One `Kit updated` notice to each project orchestrator, with the kit revision and the subjects of the required changes only, newest first. Do not notify the Boss workspace. |
| A worker is working, first appears idle or done, or changes into either state | Herdr Boss reads only the last 8 visible pane lines. A known provider error marks the worker failed and sends the orchestrator its name, pane ID, and fixed error label. |
| A worker writes `.worker/report.json` or `.worker/<name>/report.json` after its pane first appears | One notice per report file path. A rewrite of the same file sends no new notice. |
| A managed project browser starts and responds | `browser is ready` notice in the bulletin only. |
| A published project status is stale | One `info` notice to that project's `orch` pane for each stale status. The bulletin shows `Status stale since <time>.` in the project section. |

The no-report watchdog starts its timer when a worker first appears idle or done. A change between these two states does not reset the timer. The warning goes to that project's `orch` pane. Herdr Boss sends it once in the idle period. A working pane resets the period. An existing `report.json` prevents the warning.

The failure labels are `API Error`, `401`, `429`, `Connection lost`, `usage limit`, `rate limit`, `overloaded`, and `Free usage exceeded`. Matching ignores letter case and ignores each line whose trimmed text starts with `Tip:`. The matcher requires error forms for `401` (`401 Unauthorized`, `HTTP 401`, or `status 401`) and `usage limit` (`usage limit reached`, `usage limit exceeded`, or `hit your usage limit`). Herdr Boss stores and sends only the matched label and a parsed retry time. It does not store or forward pane output. Herdr Boss reads a working pane on every engine tick, so a failure is found while the worker still works. A matched worker shows the failed status in the snapshot even when Herdr reports it working. The engine then does not count it as running, so its slot becomes free. A failure found in a working pane clears when a later read shows no known failure. A failure found on an idle or done pane clears when that pane starts working and a later read shows no known failure. Any failed status clears when a different worker uses the pane. A later failure creates a new notice. A valid free-usage retry time exhausts the matching unmetered model until that time. The unmetered lane lists it separately from available models. A `Free usage exceeded` failure of an `opencode` worker with an unmetered model also exhausts the whole `opencode` free lane. This closes every unmetered model of the `opencode` harness. The lane uses the parsed retry time. Without a parsed retry time, the lane closes for 1 hour after the failure, and the lane shows that the reset time is unknown. A later absolute retry time in the same pane extends the exhaustion to that time. Herdr Boss measures a relative retry time from the first observation of the failure.

An idle-orchestrator nudge reads the published project status file. Herdr Boss sends it only when the project mode is `auto` or `active`. It skips the `idle` and `paused` modes and the Boss workspace. The `orch` pane must be `idle` or `done` for at least the configured idle minutes. No other worker in that workspace may be `working`, `blocked`, or `failed`.

A task is actionable when its status is `todo`, `doing`, or `review` and every ID in its `blockedBy` list is `done` in the same project. An unknown blocker stays unresolved. A task with status `blocked` is never actionable. Herdr Boss picks one actionable task: current frontier first, then a task without a frontier value, then next frontier. Status-file order decides a tie.

A task in a group with `"held": true` is not actionable. The nudge then names the next actionable task outside the held group, or sends no notice.

The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work yourself. Check **Use now** when the project has a free effective slot. If it lists a lane, start ready work on that lane's harness. The notice uses one key per project and task, so the normal notice cooldown limits repeats. A different next task gets a new key and can prompt again.

A notice is a prompt to an `orch` pane. Herdr Boss normally sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. An immediate notice with severity `warn` or `critical` also goes to a `working` orchestrator. Worker failure notices are of this type. An immediate `info` notice, for example a worker report notice, waits until the orchestrator is `idle` or `done`. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`.

Some notices are in the bulletin only and are never sent as a prompt. These are the quota notices at 90% and 98%, the `Quota restriction cleared` notice, and the `browser is ready` notice. The alert source marks each of them with `prompt: false`. Worker failure, blocked-worker, kit, handover, disk, and machine-limit notices are sent as prompts.

Herdr Boss sends the `info` notices of one pane as one digest. All `info` notices of all kinds use the digest. A pane gets at most one digest in 2 hours. Herdr Boss sends no digest while the pane status is `working`. The digest waits until the status is `idle` or `done`. The first digest goes out as soon as the pane is settled. Other `info` notices for that pane wait. The digest sends all waiting `info` notices together, one line each. It shows at most 8 of these lines, then one `and N more` line. The bulletin lists all notices. The 2-hour limit does not apply to `warn` and `critical` notices. They arrive at once. A `warn` or `critical` prompt inside the 2 hours does not include the waiting `info` notices.

Herdr does not show a draft or an open dialog in a pane. Herdr Boss does not detect them. An agent that waits for input has the status `blocked`, and Herdr Boss sends it no prompt except an immediate `warn` or `critical` notice.

The kit notice goes to every project orchestrator, also when the project has no active workers. The Boss workspace does not get it. When the engine starts, it reads Git once in the directory that the service runs from. It runs no timers and no model calls. It stores the last notified commit and the current kit revision as `kitNotice` in `memory.json`. On the first start, it stores `HEAD` and sends nothing. When Git fails, or the stored commit is not an ancestor of `HEAD`, it stores `HEAD`, sends nothing, and logs one `kit` event. Each orchestrator gets the notice once, when its pane is `idle` or `done`. The notice stays pending for 7 days. The read-only preview does not read Git and does not send or store the notice.

The engine sends the notice only when at least one new kit change has impact `required`. A change with impact `useful` or `none` sends no notice, and a mixed batch names only the required changes. The impact comes from the `Kit-Impact:` trailer of the commit message. When a commit has no usable trailer, the engine reads the impact from the matching entry in `kit/CHANGES.md`. It uses the entry only when the number of entries after the stored revision equals the number of commits that changed an installed kit asset. Otherwise the change stays `required`. A stored notice from an older release has no revision, so its first batch stays `required`.

The notice text is `[herdr-boss] Kit revision <revision> (<n> change(s)): <subjects>. Run herdr-boss kit update, then re-read docs/orchestration/herdr-boss.md now; your loaded copy is stale.` It names at most 10 subjects, then `and N more`. The revision in the notice is the kit revision of the directory that the service runs from. When you get a kit notice, run `herdr-boss kit update`. The command first prints the digest of the kit changes since the installed kit revision, then installs the kit as `herdr-boss kit install` does. Then re-read `docs/orchestration/herdr-boss.md` and publish the new `kitRevision`. A project that stays `behind (required)` for 2 hours gets one reminder while its orchestrator works. The service starts the 2 hours when it first sees the project behind on a required change. The clock stops when the project catches up or is behind on useful changes only. The reminder text is `[herdr-boss] Your kit is behind on a required change. Run herdr-boss kit update, then re-read docs/orchestration/herdr-boss.md. Kit revision now <revision>.` The reminder shows no desktop notification, and an idle orchestrator does not get it. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). This policy value takes precedence over the legacy top-level `alertCooldownSeconds` value in `config.json`.

A published project status is stale when both conditions are true:

- Its `updated` time is more than `staleStatusMinutes` old. The default is 120 minutes. Set it in `config.json`.
- After the `updated` time, a worker of the project was `working` in the last 2 hours, or new commits landed on the project repository.

A paused project is never stale. Herdr Boss finds the repository in `project-repos.json`. A project without a repository record uses only the worker condition. Herdr Boss runs `git -C <repo> rev-parse HEAD` and `git -C <repo> log -1 --format=%cI` at most once every 10 minutes for each project. New commits landed when the HEAD commit time is after `updated`, or when `HEAD` changed after `updated`.

The stale notice text is `Your published status is <age> old while <workers ran | new commits landed>. Run herdr-boss publish <slug> <file> with the current plan and progress.` The notice uses one key for each project and `updated` time. Herdr Boss sends it once, with the idle gate and the 2-hour `info` limit. A new publish ends the stale status. When the new status becomes stale, Herdr Boss sends a new notice.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

## Night watch

Night watch says that the Owner is away. The Boss acts for the Owner until the end time of the night.

The state lives in the file `night.json` in the data directory. The file is beside `policy.json` and `rules.json`. Its mode is `0600`. Herdr Boss reads the file once per engine tick and writes the result to `snap.night`.

The stored record holds these keys:

| Key | Meaning |
|---|---|
| `active` | The night runs. |
| `since` | The ISO time at which the night started. |
| `until` | The ISO time at which the night ends. |
| `reportAt` | The ISO time for the morning report. It defaults to `until`. |
| `retroAt` | The optional ISO time for the retro. |
| `by` | Who started the night. |
| `quietHours` | Quiet hours are on. The default is `false`. |
| `noticeStartAt` | The ISO time of the start notice, for each pane that got it. |
| `noticeStopAt` | The ISO time of the end notice, for each pane that got it. |
| `reportSentAt`, `retroSentAt` | The ISO time when each report was posted. |

A state whose `until` time has passed reads as not active. The file stays, so a later task can read its own marks. A missing or unreadable file reads as not active. The read view of an active state is `{ active, since, until, by, quietHours }`. The read view of any other state is `{ active: false }`.

An active night state also makes the Owner away. The machine limits are the same away limits as for an idle Owner. Night watch changes no machine limit.

Set these worker caps in `config.json`:

| Setting | Meaning | Value |
|---|---|---|
| `night.maxWorkers` | Maximum number of working agents during night watch. | Use `null` to keep the day value. Otherwise, set an integer from 1 to 40. |
| `night.maxWorkersByLane` | Maximum number of working agents in each provider lane during night watch. | Set `unmetered`, `codex`, `claude`, or `opencodego` to `null` or an integer from 1 to 40. Omit a lane to keep its day value. |

Night caps apply only while night watch is active. Project shares and idle slot lending still apply under the global cap. The machine CPU and load guard limits still block worker starts during night watch.

The bulletin then shows one line under **Rules now**: `Night watch until 07:30 (Owner away). Work as normal; the Boss handles judgment calls.` The time is the local end time. When `quietHours` is true, the bulletin also shows `Quiet hours: on.`

The night worker caps also appear in the bulletin and in **Settings**. Set them there or edit `config.json`.

Quiet hours are optional and are off by default. Set `night.quietHours` in `config.json` to choose the default for new nights. Run `herdr-boss night start --quiet-hours` to turn them on. Run `herdr-boss night start --no-quiet-hours` to turn them off. A value sent from the dashboard also overrides the default.

Quiet hours hold three service actions:

- Herdr Boss queues desktop notifications. It shows them once when night watch ends.
- Herdr Boss waits to release an expired manual `full-suite` lock. It still takes over a lock with a dead holder.
- Herdr Boss waits to reclaim a lease only when its TTL expires. It still reclaims a lease for a gone pane or a finished worker.

Herdr Boss starts no browser restarts of its own. A person or an agent can still request a browser restart during quiet hours.

Quiet hours do not hold pushes, deploys, gates, quota rules, worker starts, nudges, or reports. Herdr Boss writes every alert and event to `events.jsonl`.

### Night watch notices

The engine sends one start notice to each orchestrator pane and to the Boss pane. It sends the notice as a direct prompt, so a working orchestrator also receives it. The notice is not a resource notice. It does not use the idle gate and it does not use the 2-hour `info` limit.

The start notice reads: `[herdr-boss] Night watch until 07:30. The Owner is away; the Boss acts for the Owner. Work as normal. Escalate to the Boss.` The time is the local `until` time of the stored state.

The engine sends one end notice when the night ends. The end notice reads: `[herdr-boss] Night watch ended. The Owner rules apply again.` A pane gets the end notice only when it got the start notice.

The engine stores the send time of each notice in the record, under `noticeStartAt` or `noticeStopAt`, with the pane as the key. A restart reads those marks and sends no notice twice. A pane that joins during the night gets the start notice at the next tick. A mark from before the `since` time belongs to an earlier night, so it does not keep a notice from going out.

A failed send stores no mark. The next tick sends the notice again. A pane that no longer exists gets no end notice.

A stop clears the file. The engine then keeps the last active record in its own memory and sends the end notice from it.

### Night watch in the dashboard

While a night runs, every page shows a slim banner under the top bar. The banner names the local end time, says that the Boss acts for the Owner, and shows `Quiet hours on` when `quietHours` is true. The banner uses a calm color. On a phone it uses at most two lines, and its **Stop** button is at least 44 px high. Without a night, the page shows no banner.

The **Settings** page has a **Night watch** section. It shows the stored state. When no night runs, the section has an end-time field, a **Quiet hours** check, and **Start night watch**. While a night runs, the section has **Stop night watch**.

The dashboard uses these routes. They use the same functions as `herdr-boss night start` and `herdr-boss night stop`, and they keep the same time checks.

| Route | Body | Answer |
|---|---|---|
| `POST /api/night/start` | `{ "until": "07:30", "quietHours": false }` | `200` with the new night state. |
| `POST /api/night/stop` | `{}` | `200` with the new night state. |
| `GET /api/night` | none | `200` with the night state. |

`until` is `HH:MM` local time or an ISO time. An `HH:MM` value means the next such time. The end time must be in the future and no more than 24 hours ahead. A refused time answers `400` and keeps the stored state. A blank value uses the next 07:30. The routes need the same access as the other dashboard write routes. The read-only preview refuses them. The start route records `by` as `dashboard`.

### Timed reports

Use `--report HH:MM` to set the morning report time. The default is the `--until` time. Use `--retro HH:MM` to set an optional retro time. Each time can also use an ISO timestamp. Each time must be in the future and no more than 24 hours ahead.

At each time, the service posts one report to the Owner in the Boss thread. A service restart does not post the same report again. A report does not wait for running tasks to finish.

Each report lists the tasks marked done since the night started. It lists running tasks with their start times, and blocked tasks with the item they wait for. It also lists the worker count, each metered lane's share of recorded work time, and the notices and alerts raised during the night. The report has at most 60 lines.

The report and its sent time stay in the message store and `night.json`. The service keeps these records when the end time passes, so a late engine tick can still post the report.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it.
- **ahead of pace**: a live window will not last to its reset, or its use is above its goal-adjusted expected use. The lane shows when it is back on pace if it is not used.
- **trickle**: a window longer than 7 days is ahead of pace. The lane shows the daily allowance and today's use. You can start workers while today's use is below the allowance.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.
- **exhausted**: a live window is at 100% or more. The lane shows its label and reset time. Only `--force` can use it.

A provider is open only when every live, measured window is on pace and no live window is exhausted. Extra windows, such as a model-only window, do not count. A short window of 7 days or less still closes a trickle lane when it is ahead of pace. An exhausted or near-exhaustion window also closes the lane.

The bulletin and `herdr-boss lanes` show a **Use now** line before the metered lane details. The line lists open providers below pace first, from most room to least. It lists trickle providers with allowance left next, then other open providers. Each item gives a short reason. If no metered provider can take work, use an unmetered model or wait.

Herdr Boss gives a trickle lane a daily allowance. With a goal end in the future, it divides the gap to the goal percent by the days left to that end. After the goal end, it divides the unused quota percent by the days left to reset. Without a goal end, it divides the gap to the goal percent by the days left to reset. The goal percent defaults to 100%. It counts today's use from the first quota record after 00:00 UTC. After a reset, it starts from the first record after that reset. With no record for today, it counts 0% use.

The bulletin and `herdr-boss lanes` show the allowance, today's use, and the goal. The Overview quota card shows the goal in each window row. It also shows the goal in the trickle footer. Each goal uses the form `goal: 100% by Thu 8 Oct`. The text shows the time for a one-off end within 48 hours. `worker start` allows a trickle lane below its allowance. At or above the allowance, it refuses until 00:00 UTC. Use `--force` to bypass this refusal. Automatic handover can use a trickle lane below its allowance.

When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage. When several windows are exhausted, the lane shows the one with the latest reset.

A **quota pacing goal** is the most percent of a window that you want to use by its end. A goal without a separate end reaches its percent at reset. Herdr Boss scales the measured expected-use pace by `goal / 100` for this form. A timed goal rises from the live window start to its percent at the configured end. The line stays at that percent until reset. An unset goal means 100%, which preserves the normal pace. When a timed goal end passes, Herdr Boss uses the reset forecast to decide if a long window is ahead of pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

Choose a one-off local date and time, or choose a recurring number of whole hours before reset. Herdr Boss stores a one-off time as an ISO timestamp. It deletes that whole goal when the time passes or the quota window resets. It keeps a recurring offset for later windows. A goal end must be after now, after the current window start, and no later than its reset. Runs-out advice compares the current rate with the goal percent and the goal end. The advice names the goal end when the rate reaches the goal percent before that end. `herdr-boss lanes` and the bulletin show the goal and its end while the provider is open or restricted.

The same output has one **unmetered** lane. It lists every permitted unmetered model that can start, by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The lane leaves out three kinds of closed models and reports each one on a separate line with its reason:

- A model with an active free-usage retry. The line shows its retry time.
- A Pi model that Pi cannot use. Herdr Boss runs `pi --list-models` at most once every 15 minutes. Pi lists only the models that it can use. A Pi model is unavailable when the last good result does not list it. When Pi lists no row for the provider of the model, the line states that Pi has no credential for that provider. A failed run, or output without a header row, keeps the last good result. Without a good result, Herdr Boss does not hide a Pi model.
- Every unmetered model of a harness whose free lane is exhausted. The line shows the retry time, and `(reset time unknown)` when Herdr Boss uses the 1-hour default.

The lane is closed when it leaves out a model and no unmetered model remains. The bulletin, `herdr-boss lanes`, and the worker-start refusal text use the same data. They never offer a closed model as an alternative. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

`worker start` refuses a Pi model that the last good `pi --list-models` result does not list. `--force` does not bypass this refusal, because such a worker cannot run. `worker start` also refuses an unmetered model of a harness whose free lane is exhausted. Use `--force` only for an authorized override.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Settings and allocation

The Settings page has one section for each harness. A harness section holds the harness availability, the preferred model, and one row for each model. Provider quota modes, quota pacing goals, and machine limits are below the harness sections. Settings shows the warning and critical quota percentages from `config.json`. The dashboard uses these values to color quota levels.

The **Service settings** table shows the values that the service uses. Each row shows whether the value comes from `config.json` or a default. The table groups rows under Machine, Quota, Status, Workers, Browsers, and Service. Set values with inputs, then select **Save** for that group. Herdr Boss writes only those values to `config.json` and applies them at once. Keep the quota warning below the critical value. Rows without inputs stay read-only. Change in `config.json` and restart the service. The table does not show access or Roamgate settings.

### Avatars

The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. A row shows the avatar, an **Upload image** control, and a **Reset** control. The image is a PNG, JPEG, or WebP file of at most 512 KB. See [Avatars](#avatars) for the rules, the storage, and the routes.

The **Harness readiness** table shows the status of each harness entry that orchestration needs. Each row shows the status, the area, and the item. The status is `ok`, `missing`, or `bad`. The table is read-only. It shows no file path and no setting value. Herdr Boss reads these entries at each service start and then every 10 minutes. Run `herdr-boss harness sync` to see the changes to make.

The model catalog is `kit/models.json`. The local policy can add model strings to one harness. Herdr Boss merges these extra models into the allow-list of that harness in worker start, handoff plan and prepare, the lanes and the bulletin, Settings, Allocation, and `herdr-boss models`. An extra model uses the launch arguments and effort rules of its harness.

Free `opencode/` models run only in the `opencode` harness. The Pi allow-list holds only `opencode-go/` models. Herdr Boss uses the `pi --list-models` result to hide a Pi model that Pi cannot use.

The Machine section saves its settings in `policy.json`. The machine guard is on by default. It is active only when it is on and its pause has expired. When it is off or paused, CPU and load thresholds do not warn or block worker starts. Memory and disk warnings stay on. Herdr Boss still shows measured CPU, load, and free disk space, the configured thresholds, and whether the Owner is present. Disk space uses the filesystem that contains the configured Herdr Boss data directory. GB means 2³⁰ bytes. The default disk warning starts below 20 GB free. The default critical alert starts below 5 GB free. Free percent is information only and displays to one decimal place. Disk worktree counts exclude the `boss` pane and the Boss workspace. Each Git repository is counted once and its notice goes to its project `orch` pane. Notices include linked and prunable worktree counts and the safe prune command. A notice sends when the disk level changes, including after recovery.

Herdr Boss reads Owner idle time from macOS `IOHIDSystem`. The default away time is 10 minutes. Missing or invalid idle data means the Owner is present. CPU is total sampled process CPU, including other processes, divided by core count. The default CPU limits are 70% while present and 95% while away. Set the away CPU limit to blank to disable it. The default 5-minute load backstops are 3 times the core count while present and 8 times while away. Set a load backstop to blank to disable it. The load average stays visible when a backstop is disabled.

Use the switch in Settings or the Overview machine summary to turn the guard on or off. Choose a duration and select **Pause guard** to pause it. The guard becomes active again when the pause expires. Select **Resume guard** to end a pause early. Settings changes stay in a draft until you select **Apply policy**. Overview guard actions save to the current policy at once. They preserve other unsaved Settings changes. `herdr-boss lanes`, the bulletin, and worker-start output show whether the guard is active, off, or paused.

When Herdr Boss loads an older policy without `machine.guardEnabled`, it checks the saved thresholds. It turns the guard off and restores the default thresholds only for the exact old off tuple: present CPU 100, away CPU blank, and both load backstops blank. It keeps the saved Owner-away time and alert cooldown. For every other old policy, it turns the guard on and keeps the saved thresholds.

Policy settings take precedence over legacy `config.json` values. The old `machine.loadWarnFactor` field does not control machine guards. The `machine.alertCooldownSeconds` policy value takes precedence over the legacy top-level `alertCooldownSeconds` field for notice delivery.

Clear the **Available** box of a harness to disable that harness for every project. Choose a preferred model for a harness. Worker start and handoff use it when you omit an explicit model. An empty choice uses the harness default.

Each model row has a box and a provider route. Clear the box to disable the model in that harness for every project. A model can be in more than one harness. Each harness keeps its own box and its own route for the model, so a change in one harness does not change another harness.

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
- **Save:** Apply policy and `policy set` refuse a policy in which an available Codex or Claude harness inherits an incompatible legacy route without an override. The error names the harness, the model, and the permitted choices, for example `modelProviders: codex/gpt-6-sol inherits claude. Choose codex or null (unmetered) in harnessRoutes.codex.` A harness that is not available does not block a save. Herdr Boss finds the provider of a model in a harness in this order:

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

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget in each worker brief. The default is 10 screenshots. The project setting overrides the kit default. Worker start appends any missing budget or copied input details when a project brief template omits those slots. Use `worker start --copy PATH` to copy a regular repository file into the worker's `.worker/inputs/` directory before the agent starts. Repeat `--copy` for each file. The command preserves repository subdirectories and refuses paths outside the repository.

The Analytics page shows a **Model scorecard** table with one row for each harness and model over the last 30 days. Each row shows the runs, the first-time, rework, and failed counts, the rework rate (rework plus failed, divided by the runs), and the median run duration. The table sorts by runs. The orchestrator records the model outcome at review time with `worker collect --record --model-result first-time|rework|failed` and, for rework or failure, `--model-reason TEXT`. The orchestrator's values win over the report's `modelOutcome`. When neither is given, the result is derived: `failed` when `--outcome failed` or `--gate-failed`, `rework` when `--rework` is more than 0, otherwise `first-time`.

Set `artifactChecks` in `.herdr-boss.json` to check generated files during worker collection. Each rule has an `artifacts` glob and a `sources` glob. For example, use `docs/gallery/**/*.png` for artifacts and `extensions/**/src/**` for sources. The patterns are repository-relative POSIX paths. `*` matches within one path segment. `**` matches zero or more path segments. Herdr Boss rejects absolute paths, parent traversal, backslashes, empty patterns, and malformed rules.

Use the workspace switches above the project shares to include or exclude a live workspace. An excluded workspace stays visible on Agents with the marker **Not a project**. It does not appear on Projects or Overview. It has no project share or worker slots. Herdr Boss stores excluded workspace labels. It resolves a saved Herdr ID to its current label when possible. A workspace with a pane labelled `boss` is excluded automatically while that pane is present. Herdr Boss removes the legacy `policy.projects.boss` entry and redistributes other project shares in the same proportions.

Each project has two share values:

- The **set share** is the share in the policy draft. The bar widths show the set share. Drag a boundary or use the arrow keys to change it.
- The **effective share** is the number of worker slots that the project has now, divided by the applied maximum of working agents. The **effective slots** are that number of slots. These values come from the applied policy. They change only after you select **Apply policy**.

A bar segment shows its set share and its effective slots, for example `30% · 2`. A narrow segment shows only the set share or no label. Its tooltip shows all values.

An idle project is faded in the bar and in its row. A paused project is faded and striped.

The **base slots** of a project are its set share of the global worker limit. A project always keeps its own base slots unless it is idle or paused. When **Borrow idle shares** (`borrowIdle`) is on, the projects with unused slots give capacity to the projects that use all their slots:

- An idle or paused project lends all its base slots. Its effective slots are 0 plus any borrowed slots.
- Another project keeps all its base slots. It offers its unused slots, the base slots minus its running workers, to the borrowers. The offered slots stay in its own effective slots.
- A project is a borrower when it is not idle and its running workers are equal to or more than its base slots. Herdr Boss adds the lent slots and the offered slots, and gives the sum to the borrowers by share.
- When no project is a borrower, no project lends or offers slots.


The **Locks** panel lists machine locks. Each row shows the lock name, holder project and pane, kind, age, time left, and state. When no lock exists, the panel shows **No machine locks are held.** A manual lock expires after 60 minutes. A command lock ends when its command ends. Herdr Boss takes over a stale lock. A history line above the table shows the median hold time and the median wait time of the last 7 days, for all locks and for each lock name. Before the first lock change, it shows **No lock history yet.** A re-entrant suite under a push is not part of the medians. You cannot release a lock from this panel.

Below the policy settings, the **Resource leases** panel shows each resource pool. The head of a pool shows the count of held and free items, the lease TTL, and the reclaim rule. A row for each item shows the state (Held or Free), the holder project, the pane or worker, the lease age, and the time left. **borrowed** marks an item of another project's split. The built-in pool `project-browsers` lists only its held ports and the count of free ports. An invalid pool shows an error line. Select **Release** to give a lease back. The page names the pool, the item, the holder project, and the pane or worker, and asks you to confirm. The release removes the lease only while the holder project is still the project that the page shows. Otherwise the page reports that the lease changed, and you reload the page. A release never stops a process. A project browser that runs keeps its lease, so its **Release** button is disabled until you close the browser on the Browsers page.

Select **Add pool** to create a pool. Enter one item per line or separate items with commas. Enter the project split as JSON. Set the environment variable, lease TTL, reclaim check, and grace period. Keep ports 9222 to 9299 out of custom pools. Select **Edit** to change a config pool. Select **Remove**, then confirm the pool name, to remove it. A held item blocks removal and any update that drops it. Herdr Boss saves the change to `config.json` and applies it at once. The built-in `project-browsers` pool has no edit or remove controls. The read-only preview refuses pool changes.

`worker start` prints one allocation line for the project: the running workers, the effective slots, the borrowed, lent, or free count, the global use, and the 5-minute load. When the project uses all its effective slots, `worker start` also prints an advisory notice. The notice does not stop the start.

## Orchestrator handover

When an orchestrator's quota comes near its reserve, Herdr Boss recommends a successor. The Boss pane uses the same handover path by its `boss` label. Its quota notice goes to the Owner. The Boss workspace stays out of project shares and project notices.

1. Plan the handover on the project page, or run `herdr-boss handoff plan`.
2. Prepare the successor. It starts in a new tab and only reads and reports.
3. Inspect the successor's response.
4. Confirm activation. For a project, the successor pane gets the label `orch`, and the old pane gets `orch previous`. For the Boss, the successor pane gets `boss`, and the old pane gets `boss previous`.

Activation checks that the successor agent is settled and ready. The handoff record keeps the activation time, the source pane ID, and the successor pane ID.

Activation labels the old pane as previous. Herdr Boss closes that pane after 120 minutes from activation when the handoff, the previous-role label, and the successor-role label are still confirmed. A newer handover does not cancel this retirement. Herdr Boss marks the older handover as superseded when the new handover starts from its successor pane and has the same role. The engine also marks older records on each active tick. It follows a chain of superseded records to the current successor before it closes a pane. Unavailable pane data defers retirement until a later tick. The current successor gets one notice after retirement.

At activation, Herdr Boss prompts the previous agent first. The prompt tells it that it no longer owns orchestration. It asks for a concise final summary for the successor. It tells the agent to answer each later request only with the successor pane ID. A Boss handover uses Boss and Owner wording. This prompt is best effort. If it fails, the engine sends it again later.

If the Owner closed the source pane before activation, Herdr Boss skips the source label and the previous-agent prompt. The record keeps `activation.sourceMissing: true`. The successor prompt says that the source pane was closed and does not ask for a final summary.

Herdr Boss then prompts the successor. The prompt gives its own pane ID, the previous pane ID, and how Herdr Boss built its session. It tells the successor to read the previous agent's final summary when it is available, to take over the current work, and to use its own pane ID in worker briefs, reports, and messages.

After activation, the engine sends handover notices:

- A project handover notifies each agent worker in the project workspace and the active pane labeled `boss` in any workspace.
- A Boss handover notifies each agent in the Boss workspace and sends the Owner a Herdr notification with the new Boss pane ID.

Agent prompts need push to be on. A prompt goes only to an idle or done agent pane. A successful notice is recorded and is not sent again. A recipient that is unavailable or fails stays eligible, and the engine tries it again after one minute.

Herdr Boss sends handover notices only for active records. A superseded record sends no new notice. Herdr Boss records the Boss notice once for each handover. A change to the Boss pane does not send the notice again. Herdr Boss also treats an earlier notice key for a Boss pane as delivered.

Preparation waits up to 90 seconds for the new pane's foreground shell and a prompt or a stable screen before Herdr Boss starts the agent. Ordinary `worker start` keeps its 20-second readiness wait. If agent start reports `agent_pane_busy`, Herdr Boss checks shell readiness again and retries once. If the pane shows an interactive question, answer it in a shell once, then retry `handoff prepare`. The new tab disables update prompts and automatic updates. Each active engine tick expires a `prepared`, `preparing`, or `needs-inspection` record only when a successful current pane list does not contain its successor pane. `handoff prepare` repeats this check before retrying. A failed pane list keeps the record active. Expiring a record does not close a pane.

If a `needs-inspection` record still has a pane in the current Herdr pane list, repeat `handoff prepare` for the same source pane, target kind, and mode. Herdr Boss waits for that pane to become ready and starts the successor there. It keeps the existing handoff record and pane. If the pane does not become ready, the record stays `needs-inspection` and the command reports the readiness error. If a successful current pane list proves that the pane is absent, the record expires and prepare can create a new successor.

Migration moves the conversation history with [session-migrate](https://github.com/xhluca/session-migrate). It does not move credentials, hooks, or runtime settings. If migration is unavailable or transfer fails, Herdr Boss prepares a fresh successor and records the reason.

A migrated session must fit the context window of the target model. The plan converts the session into a temporary directory, measures its `.jsonl` files, and deletes the directory. It estimates one token for each 4 bytes. The session fits when the estimate is at most 60% of the target window. The limit leaves space for the successor's own work. When the session does not fit, the plan marks migration as unavailable and names the estimate and the limit. The project page then shows `Migration unavailable:` with that text. Preparation uses fresh mode and records the same text as the reason. The successor prompt at activation includes the reason. When the measurement fails twice, or when the target model has no window, migration stays available and the plan shows a warning.

The window of a model is in `kit/models.json`. The `contextTokens` field of a kind gives the window in tokens for all models of that kind. The `contextTokensByModel` object gives the window for one model and overrides `contextTokens`. Both fields are optional. Each value must be a positive integer.

Herdr Boss copies the optional Owner goal from the latest published project status into the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. It does not assign a project goal to a Boss handoff. For a fresh successor, Herdr Boss captures at most 200 recent lines and stores at most 20,000 characters from the source pane. Both caps include the truncation marker. It redacts likely credentials. If the recent read fails, it tries the visible pane. If both reads fail, the record says that context is unavailable. The prompt labels this snapshot as historical context. The successor only reads and reports until activation.

**Automatic handover** is off by default. Turn it on in Allocation, and rank the successor choices under **Orchestrator succession**. Herdr Boss then prepares a successor at the reserve, waits for it to run `herdr-boss handoff ready`, and activates it at the set quota level (98% by default). An automatic successor that was not needed expires two hours after preparation when its source provider is no longer near its limit.

Herdr Boss recommends the first succession choice that can start. The dashboard and the automatic handover use the same choice. Herdr Boss skips a choice in these conditions:

- The choice uses the harness or the provider of the current orchestrator.
- The harness or the model is not allowed, or the project excludes it.
- The metered provider of the model is near its limit or exhausted.
- The unmetered model is exhausted until its retry time.
- The harness free lane is exhausted, and the model is unmetered. The choice becomes available again at the retry time of the lane.
- The choice is a Pi model that the last good `pi --list-models` result does not list. Without a good result, Herdr Boss does not skip a Pi model.

When no choice can start, Herdr Boss recommends no successor. The automatic handover then logs that no alternative provider is eligible.

The automatic handover never touches the Boss. It prepares and activates no Boss successor, and it activates no prepared Boss record. The Owner does each Boss handover by hand. The Boss project page keeps its successor recommendation.

The Overview lists only handover records in the state `prepared`, `preparing`, or `needs-inspection`. It lists a record only when the source pane and the successor pane are still in Herdr. It shows no recommendation without a record, and no Boss recommendation. Plan a handover without a record on the project page.

The automatic handover prepares a successor only for a project that works now. A project qualifies when its allocation reports a running worker, or when a pane in its workspace runs an agent in a `working` state. A workspace with no working agent and no running worker waits. A stopped orchestrator in a workspace with a working worker stays eligible.

The automatic handover also skips a project that the Owner holds. A project is held when its published status is `paused`, `stood down`, or `on hold`, or when its published summary says that it is paused or stood down. A status or summary in another case, spacing, or hyphen variant counts as the same word. A summary that reports the state of another project, or of one task, does not hold its own project. An allocation mode of `paused` holds the project.

The automatic handover activates a prepared successor only when the successor model is not weaker than the source model. The tiers follow the cost order in `kit/models.md`, from the free models up to Codex Astra. A model the kit does not rank has no tier. When either model has no tier, or the successor is weaker, Herdr Boss leaves the record prepared and logs one line that names the reason. The Owner then runs `herdr-boss handoff activate ID --confirmed` when the weaker model is the right choice.

## Project browsers

Each project can have one persistent Chrome profile. Request it with `herdr-boss browser request SLUG`, or open it from the Browsers page. Herdr Boss assigns a port from 9223 to 9299.

- Give each worker its own tab. `browser tab new` opens a tab in its own window, so it stays visible in a headless browser.
- A website or identity provider decides how long a login lasts. Sign in through the dashboard when a login is needed.
- Herdr Boss never stops a browser that it did not start. Each project uses only its own browser.

### Port leases

Each project browser port is a lease in the built-in resource pool `project-browsers`. The pool has the ports 9223 to 9299. Port 9222 is not in the pool, and no pool leases it.

- The holder of the lease is the project. The lease has no pane, no worker, and no TTL.
- `browser request` leases the recorded port of the project. When the project has no record, it leases the lowest free port. It skips a port that the record of another project uses and a port that has a listener.
- When another project holds the recorded port, `browser request` leases a new port and writes it to the record.
- `browser close` keeps the lease.
- `herdr-boss browser release SLUG` removes the lease. It refuses while the project Chrome runs. The record stays.
- `browser-sessions.json` keeps the profile, the window size, the headless mode, the PID, the code-sign clone, the bookmarks, and the start page of each project. The lease keeps only the port.

Herdr Boss reclaims a project browser lease when no Chrome process has the port flag and the profile path of the project on two service ticks in a row. A "not responding" browser still has its process, so Herdr Boss does not reclaim its lease. When the process list fails on a tick, that tick does not count. A reclaim closes no browser and changes no record. The next `browser request` leases the recorded port again when it is free.

The Browsers page shows the leased port and the CDP address `http://127.0.0.1:PORT` on each browser card, with a link to the lease row on the Allocation page. The card shows the lease even when the leased port differs from the recorded port. Release the lease on the Allocation page. A project browser that runs keeps its lease until you close the browser.

At its first acting tick, the service writes one lease for each browser record, with the recorded port. It logs one `lease` event for each project. It does this one time for each data directory, and it changes no port.

### Browser states

Herdr Boss shows one state for each project browser:

| State | Meaning |
|---|---|
| ready | Chrome runs with the project port and profile. `GET /json/version` on the port returns HTTP 200 with JSON within 2 seconds. |
| not responding | Chrome runs with the project port and profile, and the port accepts connections. `GET /json/version` does not answer within 2 seconds. |
| offline | No Chrome process runs with the project port and profile. |
| port conflict | Another process uses the port. Herdr Boss does not touch it. |

A "not responding" browser shows **Restart** and **Close browser** under **Manage**. It has no preview. The bulletin shows the same state for agents.

To recover a "not responding" browser, use **Restart** or **Close browser** on the Browsers page. The CLI commands are `herdr-boss browser restart SLUG --headless|--visible` and `herdr-boss browser close SLUG`. A restart of a "not responding" browser does not reopen the current page.

Close works as follows:

1. Herdr Boss sends the CDP command `Browser.close` to a responsive browser.
2. If the browser is not responding, or `Browser.close` fails, Herdr Boss sends SIGTERM to the Chrome main process. This process has both `--remote-debugging-port=PORT` and `--user-data-dir=PROFILE` and no `--type=` flag.
3. Herdr Boss waits up to 8 seconds for the process to exit.
4. If the process does not exit, the close fails with a "did not exit" error. Herdr Boss never sends SIGKILL. Inspect the process before you relaunch the browser.
5. After a SIGTERM close, Herdr Boss deletes the code-sign clone of that launch. The next section describes the clone.

Herdr Boss never sends a signal to a process that does not match both the port and the profile.

### Chrome code-sign clones

Google Chrome on macOS copies its app bundle to a code-sign clone of about 720 MB at each launch. The clones are in `$(getconf DARWIN_USER_TEMP_DIR)/../X/com.google.Chrome.code_sign_clone/`. Each clone is a folder `code_sign_clone.XXXXXX`. Chrome deletes its clone only at a clean shutdown with the CDP command `Browser.close`. A signal, a crash, or `playwright-cli close` leaves the clone on the disk.

- At a launch, Herdr Boss records the new clone folder in the session as `codeSignClone`. It records `null` when no new clone or more than one new clone appears.
- After a SIGTERM close, Herdr Boss deletes the recorded clone. After a `Browser.close`, Chrome deletes the clone.
- Every 10 minutes, the service deletes orphaned clones. The dashboard preview does not delete clones.

A clone is orphaned when all these conditions are true:

- It is a real folder, not a symbolic link, directly in the clone folder. Its name matches `code_sign_clone.` followed by letters and digits.
- It was created more than 1 hour ago.
- No running Google Chrome main process started within 5 seconds of the clone creation time. This rule keeps the clone of each running Chrome.

Herdr Boss reads the process list with `ps -axo pid=,lstart=,comm=`. If the read fails, it deletes nothing. The sweep never sends a signal to a process. Each sweep that deletes clones adds one event with the count and the freed space. The freed space is the change in free disk space, because a clone shares disk blocks with the app. Set `browsers.sweepCodeSignClones` to `false` to stop the sweep. Run `herdr-boss browser sweep-clones --dry-run` to list the orphaned clones.

Herdr Boss uses the clone folder only when `HOME` is the home folder of the account. A process with a temporary `HOME`, such as a test, finds no clone folder.

On the Browsers page, **Show preview** captures a screenshot of the selected tab. The preview shows a still image until the next capture. **Live** refreshes it at the interval that you select.

Select the screenshot to open the large view. The large view shows the last capture as a still image. Turn on **Control browser** to refresh the large view at the selected interval and to send clicks and keys. Turn off **Control browser** to stop that refresh. **Live** continues to refresh while it is on. The status shows **Live** while a refresh repeats and **Captured** at other times. In **All tabs** mode, **Control browser** is not available.

### Address box and tab close

The first focus of the address box selects all its text. The first click and the first tap also select all its text. A second click places a normal cursor. The box uses one flag for each focus, so it does not select all again while it keeps the focus.

Each tab row in the one-tab list and each tile in the All tabs grid has a **Close tab** control. The control removes one tab. It never stops the browser process, and the browser keeps running.

Before it closes a tab that an agent holds, the page asks the Owner to confirm: "Tab <title> belongs to <agent>. Close it anyway?" Only after Yes does the page send `force: true`. Before it closes the last tab, the page warns the Owner that the browser keeps running with no page.

The page uses `POST /api/browser-sessions/tab-close` with the body `{ project, tabId }`, and the optional field `force`. The route refuses an unknown project and a missing tab. The read-only preview refuses every change. The CLI command is `herdr-boss browser tab close SLUG --tab ID`.

### Bookmarks and the start page

Each browser card has a **Bookmarks** list. The list holds at most 30 bookmarks for the project. A bookmark name has at most 60 characters. A bookmark URL must use `http` or `https`. It must not hold a user name or a password. Herdr Boss refuses such a URL with "Bookmarks must not hold credentials."

- **Add current page** saves the URL and title of the selected tab. When the browser has one tab, it uses that tab.
- **Open** loads the bookmark in the current tab. **New tab** opens the bookmark in a new tab of its own window.
- **Rename** shows a small form in the row. The arrows move the bookmark up or down. **Delete** asks the Owner to confirm.
- **Start page** is the page that opens in the first tab of the next launch. **Save** stores it. A blank value clears it. A running browser does not change.

The page uses `GET /api/browser-sessions/bookmarks?project=SLUG` and `POST /api/browser-sessions/bookmarks` with `{ project, action }`. The action is `add`, `rename`, `move`, `remove`, or `start`. The route refuses an unknown open project, a bad URL, and a bad index. The read-only preview refuses every change. The CLI commands are `herdr-boss browser bookmarks SLUG list|add NAME URL|rm INDEX|open INDEX [--new-tab]|start URL|none`.

The bookmarks and the start page stay in the project record in `browser-sessions.json`. Herdr Boss never stores them in a repository.

Agent commands and tab rules are in [the browser service](../kit/browser-service.md).

## Project status pages

Orchestrators do not build dashboards. They publish a status file, and Herdr Boss shows it on `/projects/SLUG`. With the optional work structure fields, the page shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

### Files

The project page shows a read-only **Files** panel. It names three paths:

- The project memory file: `<repository>/docs/orchestration/memory.md`.
- The installed kit file: `<repository>/docs/orchestration/herdr-boss.md`.
- The Boss memory file: `~/.herdr-boss/boss-memory.md`.

The panel shows the kit revision in the project status file next to the current kit revision. The home folder shows as `~`. The page shows paths only. It never shows the contents of a memory or kit file.

### Worker config

The project page shows a read-only **Worker config** panel. It shows the non-secret fields that Herdr Boss read from `.herdr-boss.json` in the project repository:

- `slug`, `baseBranch`, `worktreeRoot`, and `worktreeName`.
- `evidenceTiers`, `allowedModels`, `workerPanesPerTab`, and `imageBudget`.
- `setup`, `setupTimeoutSeconds`, `agentStartTimeoutMs`, and `testThreadsFlag`.

A field that the file sets has a **config** tag. The other fields use the default value. The `setup` command shows as `set` or `not set`. A `worktreeRoot` path in the home folder shows as `~`. A project with an invalid `.herdr-boss.json` shows the read error in place of the fields.

The engine reads the config at each service start and every 10 minutes. Change a field in `.herdr-boss.json` in the repository. The panel changes after the next read.

### Needs your decision

A task can name the party that holds it with `waitingOn`: `owner`, `boss`, `task`, or `external`. The project page shows a **Needs your decision** group above the task list. The group lists each open task that waits on the Owner with its ID, title, ask, and a link to its Mailbox conversation. Each project card shows the count. The Overview shows the total with a link to each group.

A task that waits on other tasks shows **waiting on #ID** in place of the plain **Blocked** label. A task that waits on the Boss or an external party shows that party and the ask. The orchestrator sets `ask` when it waits on the Owner or the Boss, and sets `mailboxId` to the ID of the Mailbox item. See [project-status.md](project-status.md).

### Graph view

The dependency graph draws every task. A task without links sits in the first column, after the linked tasks. Select a box to open the issue.

Use the toolbar above the graph:

- **Fit** shows the whole graph in the panel.
- **−** and **+** zoom out and in. **100%** shows the graph at its natural size.
- **Full size** fills the window. Select **Close** or press Escape to return.

Press Ctrl or Cmd and turn the mouse wheel to zoom around the pointer. A plain wheel scrolls the page. Drag the background with the mouse or one finger to pan. A drag on a task box selects the task; it does not pan. The page remembers the zoom and the pan of each project during the session.

When the published status is stale, the project page and the Projects list show `Status stale: <age>` next to the updated time. The mark stays until the orchestrator publishes again. See [Rules and notices](#rules-and-notices) for the stale rule.

## Agents page

The `/agents` page has two views. The switch at the top of the page selects the **Chart** view or the **List** view. Chart is the default. The URL holds the view as `?view=chart` or `?view=list`. The browser keeps the last choice in its local storage. If the browser cannot store the choice, the page opens Chart at the next load. A link to the old `/organization` route opens the Chart view.

### Chart view

The Chart view shows the organization as a chart. The chart has four levels:

1. The **Owner** node shows **At the Mac** or **Away**. The value comes from the machine idle time.
2. The **Boss** node shows the pane labeled `boss`, its harness, state, quota use, and handover state. It also shows the avatar of the Boss. The workers in the Boss workspace are below it.
3. Each **project** node shows the orchestrator pane, harness, and state. It also shows the avatar of the project, the current task, the worker slots in use against the slots and share, and the handover state. The nodes use the project order.
4. Each **worker** node shows the agent name, harness, state, and task ID.

Select **Details** on a node to show its recorded values. Select **Messages** on the Boss node or on a project node to open its thread. The page cannot change resources. See [Owner messages](#owner-messages).

### Chart style

The switch at the top of the page selects the **Plain** or the **Cards** style. Plain is the default. The browser keeps the choice in its local storage. If the browser cannot store the choice, the page uses Plain at the next load.

In the Cards style, each agent node is a card with a harness mark: Claude, Codex, OpenCode, Pi, or a question mark for an unknown harness. A Codex or Claude node shows a thin bar with the quota use. The card border shows the state:

- **working**: a slow pulse on the border.
- **blocked**: the warning color and a warning icon.
- **failed**: the error color.
- **idle** or **done**: a dimmed card.

In the Cards style, a new event draws a short line with a moving dot between two nodes for about 1 second:

- An Owner message event (type `message`) draws a line from the Owner to the Boss or to the project orchestrator.
- A worker report notice (type `push`, title "Worker NAME wrote its report") draws a line from the worker to its orchestrator.

The page reads only the events that the state already holds. It does not poll for more. At the first view of the page, it shows no old events. When the system asks for reduced motion (`prefers-reduced-motion: reduce`), the page shows a 1-second highlight on the two nodes and no movement.

### Phone layout

At phone width, the chart has one column in both styles. Each worker list shows a count button, for example **Show 3 workers**. Select it to expand the workers. Select **Hide 3 workers** to collapse them. The buttons on the page and in the Messages panel are at least 44 px high. The Messages panel fills the screen.

The page uses only the state that the dashboard already loads. These limits apply:

- The page shows **Not reported** when the state does not hold a value.
- Herdr Boss does not receive the model of a running agent. The page does not use a preferred model as the model of an agent.
- The current task is the first published task with status `doing`. The worker task is the open published task whose `worker` field names that agent. The page does not read a task from a pane title.
- Quota use shows only for a Codex or Claude harness, because each of these harnesses uses only its own subscription.
- A **reserve** node shows a prepared successor only when a prepared handoff record names the current orchestrator or Boss pane as its source and the successor pane is live. A recommended successor does not show as a reserve.
- A workspace marked not a project has no project node. The Boss workspace shows as the Boss node.
- The chart shows no pane output and no secrets. Message text shows only in the Messages panel.

### List view

The List view shows every Herdr workspace with its orchestrator and workers, live from Herdr.

A status dot shows working, blocked, failed, idle, or done. Failed means that the last visible worker output matched a known provider error, including **Free usage exceeded**. Herdr Boss reads only the last eight visible lines: on every tick while a worker is working, and when a worker first appears idle or done or changes into either state. A worker can show failed while Herdr still reports it working; the engine then does not count it as a running worker. The failed status clears when a later read shows no known failure, or when a different worker uses the pane. Herdr Boss sends the matched error label, worker name, and pane ID to the project orchestrator. Blocked workers get a notice after five minutes. Idle and done agents are ready for input; they have not always finished their task. Rows with the **orch** or **boss** label are orchestrators.

An orchestrator that stays idle gets a nudge when its published status still has an actionable task: status **todo**, **doing**, or **review** with every task in its **blocked by** list done. The project must be in **auto** or **active** mode, no other worker in that workspace may work, be blocked, or have failed, and the idle period must reach the configured idle minutes. The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work. One key per project and task keeps the normal notice cooldown in charge; a different next task prompts again.

## Owner messages

The Owner can send a message to the Boss or to a project orchestrator from the Agents page. The Boss and the orchestrators reply with `herdr-boss say`. Workers get no messages from the Owner. Send a worker request to its orchestrator.

### Threads

Each node has one thread. The thread `boss` holds the messages between the Owner and the Boss. The thread of a project has the project slug as its name. A thread holds the messages in both directions, oldest first. Messages to an orchestrator go directly to it. The Boss can read each thread with `herdr-boss messages THREAD`.

### Send a message

1. Open the Agents page.
2. Select **Messages** on the Boss node or on a project node.
3. Type a message of 1 to 2000 characters, and select **Send**. Or select a nudge button or **Ask for status**.
4. Confirm the send in the browser dialog.

The nudge buttons send one of these fixed texts: "Continue.", "Use your free worker slots.", or "Pause after the current task." **Ask for status** sends "Send a short status report with herdr-boss say, and publish your status file."

The panel reads the thread again every 10 seconds while it is open. The page shows message text as plain text. It shows a report as Markdown: headings, lists, code, bold, and italic. It shows raw HTML as text.

### Delivery

A new Owner message has the status `queued`. The service sends queued messages on its acting ticks. These rules apply:

- The service sends only to the pane labeled `boss` for the `boss` thread, or to the `orch` pane of the project.
- The service sends when the agent is `working`, `idle`, or `done`.
- A blocked, unknown, or missing pane keeps the message queued. A message waits if the pane has no agent or its label does not match.
- The service sends at most one message to a pane in one tick. A pane that got a resource notice in the same tick waits for the next tick.
- The prompt is `[owner] TEXT (Reply with: herdr-boss say --reply-to ID "<answer>")`. An answer to a mailbox item starts with `Answer to ITEM-ID:` after `[owner]`.
- After delivery, the status is `sent` and `sentAt` holds the time. The thread shows `delivered HH:MM`.
- After a Herdr error, the status is `failed` with a short error. The service tries again on later ticks, up to 3 more times.
- The thread and Mailbox show `queued`, `delivered HH:MM`, `failed: REASON`, or `relayed by the Boss HH:MM`.
- They add `replied HH:MM` when a reply names the Owner message ID in `replyTo`.
- The Boss can mark queued messages as relayed with `herdr-boss messages relay ID... --by boss`. Only the `boss` pane can run this command. It sets `status` to `relayed`, and records `relayedAt` and `relayedBy`. The service never sends a relayed message.
- The service writes one `message` event to `events.jsonl` for each send or failure. The event holds the message ID, the thread, the kind, and the pane. It does not hold the text.

A read-only preview shows the threads. It refuses a send with HTTP 403 and delivers nothing.

### Replies and reports

An orchestrator or the Boss replies with `herdr-boss say --reply-to ID "TEXT"`. The Boss can post a longer Markdown report with `herdr-boss mail post --to owner FILE`, for example a morning handback. The Boss can close open Mailbox items as answered through the Boss with `herdr-boss mail close ID... --note TEXT`. It records the note and sends no message. A reply and a report have the status `new`. Set `--action answer`, `--action approve`, or `--action decide` only when the Owner must act. Everything else is information; omit `--action`. See [the CLI reference](cli.md#owner-messages) for the caller checks and the limits.

### Store

By default, the service keeps messages in `messages.jsonl` in the data directory. The default backend is `json`. To use SQLite, set this value in `config.json`:

```json
{
  "store": {
    "messages": "sqlite"
  }
}
```

When the SQLite message table is empty, Herdr Boss imports records from `messages.jsonl`. It keeps that file. The database is `herdr-boss.db`. It uses write-ahead logging and mode 0600 for the database and its WAL files. With SQLite, Herdr Boss checks the database when it starts. If the check fails, restore a backup or import the JSON file again. Use `herdr-boss store import messages` to import once. Use `herdr-boss store export messages` to write JSONL for a downgrade. Each command prints the number of records.

Each line in `messages.jsonl` is one JSON record with these fields:

| Field | Value |
|---|---|
| `id` | The message ID, for example `m-mg3k2x1a-1f2e3d4c`. |
| `at` | The time of the record. |
| `thread` | `boss` or a project slug. |
| `from`, `to` | `owner`, `boss`, or `orch`. |
| `kind` | `message`, `nudge`, `status-request`, `reply`, or `report`. |
| `text` | The message text. A report holds the Markdown text. |
| `title` | The report title. Only a report has it. |
| `action` | `answer`, `approve`, `decide`, `read`, or `null`. |
| `replyTo` | The ID of the message that a reply answers, or `null`. |
| `status` | `queued`, `sent`, `failed`, or `relayed` for an Owner message. `new` for a reply or a report. |
| `sentAt`, `error`, `attempts` | The delivery time, the last delivery error, and the number of send attempts of an Owner message. |
| `relayedAt`, `relayedBy` | The relay time and the role that relayed the message. Both fields are set by the Boss relay command. |
| `readAt` | The time that the Owner opened a mailbox item. A new item does not have this field. |
| `closedAt`, `dismissed` | The close time and whether the Owner dismissed the item without an answer. |
| `closedBy`, `closeNote` | The role that closed an item through the Boss, and the Boss's note. |
| `repliedAt` | The API view adds the time of the first reply that names this Owner message ID. It is not stored on the message. |

The JSON backend appends each new record as one line. It rewrites a changed file through a temporary file and a rename. Each write deletes records that are older than 30 days. A lock file `messages.jsonl.lock` keeps writers from writing at the same time. The SQLite backend stores each record as JSON text in one database row. It uses a transaction for each change and keeps the same 30-day retention and message order.

### Limits and safety

- Only a loopback request or an authenticated remote session can send. The same-origin check of the other `POST` routes applies.
- The service accepts at most 10 Owner messages a minute across all threads. It refuses more with HTTP 429.
- `say`, `mail post`, and `mail close` refuse text that looks like a token, a key, or a password.

## Mailbox

The Mailbox page at `/mailbox` is the inbox of the Owner. It lists replies from `herdr-boss say`, reports from `herdr-boss mail post`, and messages that the Owner sent. The page works at phone width.

### Items

Use the folder list on the left to open **Needs you**, **Updates**, **Sent**, or **Done**. Each folder shows its item count. Each row starts with the avatar of the Boss or of the project that sent the item. The folder pane shows a read-only line with the limits: the retention and the send limit. The page keeps the selected folder in the address and in browser storage. When Needs you has open items, it is the default folder. When it has no items and you have selected another folder before, the page restores that folder. Otherwise, Needs you is the default folder.

- **Needs you** shows open items with action `answer`, `approve`, or `decide`, newest first. When this folder is empty, the page shows “Nothing needs you.” and a link to Updates.
- **Updates** shows open items with action `read` or no action. Opening an item sets `readAt`. The phone mail icon shows the unread Updates count.
- **Sent** shows Owner messages. Each message shows its delivery state and the time of a reply, when one exists.
- **Done** shows closed or dismissed items and messages that the Boss relayed.

The page groups messages by their project or the Boss, and by the `replyTo` chain. Select an item to open its conversation. The conversation shows Owner and agent messages in time order. A report shows as Markdown, with the same renderer as the message panel. A reply shows as plain text. Opening an item sets `readAt` on the record. On a phone, the conversation fills the page. Select **Back** to return to the folder and message list.

### Answer an item

| Action | Controls | Text sent |
|---|---|---|
| `answer` | A text field and **Send**. | The typed text. |
| `approve` | **Approve**, **Decline**, and an optional note. | `Approved.` or `Declined.`, then the note. |
| `decide` | A text field and **Send**. Choice buttons when the text has a Markdown list under a `Choices` heading. | `Choice: CHOICE`, then the note. Or the typed text. |

The page asks for a confirmation before each send or dismissal. The answer is an Owner message to the thread of the item, with `replyTo` set to the item ID. It uses the same delivery rules and rate limit as a message from the Agents page. The service then sets `closedAt` on the item, and the item moves to **Done**. A closed item refuses a second answer with HTTP 409.

Select **New message** to start a thread with the Boss or a project that has an `orch` pane. Type a message and confirm the send. The page applies the same send limit and safety gates as other Owner messages. It opens the new thread in **Sent**. Use the reply box at the bottom of a conversation to reply to its last open agent message. The page asks you to confirm each reply.

Select one or more checkboxes under **Needs you**, then select **Dismiss selected**. Select **Dismiss** on one item to dismiss it alone. Dismissal sets `closedAt`, `readAt`, and `dismissed: true`. It sends no message. You cannot dismiss an item that is already closed or does not need action.

The choices are the list items under a Markdown heading with the text `Choices`, for example `## Choices`. The list ends at the first line that is not a list item. The page shows at most 10 choices.

### Unread count and the top-bar icons

The desktop Mailbox badge shows open Needs-you items that the Owner has not opened. The number comes from `needsYouUnread` in the `mailbox` field in `/api/state`.

The top bar shows three icons on a desktop and on a phone. Each icon has a count.

| Icon | Count | Field in `mailbox` | Link |
|---|---|---|---|
| Chat | chat records to the Owner with no `readAt` | `chatUnread` | `/chat` |
| Mail | unread mail records | `mailUnread` | `/mailbox?folder=updates` |
| Needs action | open action items | `needsAction` | `/mailbox?folder=needs-you` |

An icon with nothing to show is faded. It has opacity 0.35 and no badge. An icon with something to show has opacity 1 and a badge with the count. Its `aria-label` holds the count. The Needs-action icon uses the warning color. It is the most visible of the three.

### API

| Route | Action |
|---|---|
| `GET /api/messages?thread=THREAD` | Return the thread. Owner messages include delivery fields and `repliedAt`. |
| `GET /api/mailbox` | Return `{ needsYou, updates, done, mailbox }`. Each item has the record fields, `action`, `choices`, `ownerMessage`, and `answer`. |
| `GET /api/mailbox?folder=FOLDER` | Return the folder lists, unread Updates count, delivery state, and mailbox counts. `FOLDER` is `needs-you`, `updates`, `sent`, or `done`. |
| `GET /api/mailbox?thread=THREAD` | Return the conversations in a Boss or project thread. |
| `GET /api/mailbox?thread=THREAD&conversation=ID` | Return the messages in one conversation, oldest first. |
| `POST /api/messages/read` | Set `readAt` on the items in `{ "ids": [...] }`, 1 to 200 IDs. Add `"close": true` to close items with the action `read`. |
| `POST /api/messages/dismiss` | Dismiss 1 to 200 open Needs-you items in `{ "ids": [...] }`. It sends no Owner message. |
| `POST /api/messages` with `replyTo` | Send an answer to an open item of the same thread, and close the item. |

Both mailbox `POST` routes have the same gates as `POST /api/messages`: a loopback request or an authenticated remote session, and a same-origin request. A read-only preview refuses them with HTTP 403. The 30-day retention of the store applies to the mailbox items.

## Avatars

The Boss and each project have an avatar. The page shows the avatar in the Chat list, in the Chat header, next to the first message of each run of messages from the other party, in each Mailbox row, and on the orchestrator cards of the Agents chart. The avatar is decoration. It is `aria-hidden`, and the name of the party stays as text.

### Generated avatar

`avatarSvg(slug, { title, size })` in `public/app.js` builds the avatar as an inline SVG. The page uses the sizes 20, 28, and 36 px.

- A hash of the slug picks one hue of a fixed palette of 12 hues. The same slug always gets the same hue. The palette has no pure white and no pure black.
- The initials come from the project display name, the same name that Settings shows. The chat title and then the slug are the fallbacks. The page takes the first two letters of the first two words. A camel-case name starts a new word, so `AlphaBeta` gives `AB` and `HerdrBoss` gives `HB`. Every page uses this one title, so one project has one avatar in the Chat, the Mailbox, the Agents chart, and Settings.
- The initials take white or a dark color, whichever has the better contrast on the circle. Every hue of the palette reaches the WCAG AA contrast of 4.5 with that color.
- The slug `boss` gets a fixed crown in the accent color, not initials.

### Image of the Owner

The Owner can use an own image for the Boss and for each project. The page uses the image when one is stored, and the generated avatar otherwise.

- The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. **Upload image** stores an image. **Reset** removes it.
- An image is a PNG, JPEG, or WebP file of at most 512 KB. The service checks the magic bytes, not only the content type. It refuses SVG and every other format. An SVG file can carry a script.
- The service stores the file as `<data dir>/avatars/<slug>.<ext>` with mode `0600`. A new image replaces the file of that slug. A removed image puts the generated avatar back.
- The write routes are dashboard write routes. A read-only preview refuses an upload and a remove with HTTP 403.
- Herdr Boss calls no image API. It stores no key.

## Chat page

The Chat page at `/chat` is the conversation view of the Owner. One chat holds the messages between the Owner and the Boss. One chat holds the messages between the Owner and a project orchestrator. A worker has no chat. Use the Mailbox for items that need an answer, an approval, or a decision. Use the Chat for a normal conversation. Both pages read the same message records.

The page has no large heading. Above the conversation there is one slim header. It holds the avatar of the chat and the chat name. On a phone the header also holds the **Back** control.

The initials come from the project display name. The slug is the fallback. Every page uses that one name, so one project has the same avatar in the Chat list, the Chat header, the bubbles, the Mailbox, the Agents chart, and Settings.

### Channels

`messageChannel(record)` in `src/messages.js` gives each record one channel.

| Channel | Records | Where it shows |
|---|---|---|
| `chat` | a `say` reply with the action `read` or with no action, and every Owner message, nudge, and status request | Chat only |
| `both` | a `say` reply with the action `answer`, `approve`, or `decide` | Chat, and Mailbox **Needs you** while the item is open |
| `mail` | a report from `herdr-boss mail post` | Mailbox **Updates**, and one short line in Chat |

`mailboxView()`, `mailboxFolders()`, and `mailboxCounts()` use only `mail` and `both` records. A plain chat reply never shows in Mailbox Updates.

A chat message that needs an action shows in Chat with its card or its link. Its action item shows in Mailbox **Needs you**. A mail report shows in Chat as one short line: `Report: TITLE · Open in Mailbox`.

### Layout

The Chat is compact, in the style of a phone messenger.

- A bubble has 6 to 8 px of padding and a width of at most 75%. It has no card frame. The time is 11 px and sits in the corner of the bubble.
- The composer is one line. It grows to 6 lines. The send button is a round button of 36 px. Its touch area is 44 px on a phone. The composer hides the scroll bar until the text is longer than 6 lines.
- A chat list row is 52 px high. The first line holds the title and the time. The second line holds the last message and the unread badge.
- The theme sets the colors. The page keeps its contrast in the light theme and in the dark theme.

### List

Each row shows the chat title and the time on the first line. The second line shows the last message on one line and the unread badge. The last message is cut with an ellipsis. Each row starts with the avatar of that chat. A mail report shows as `Report: TITLE`. The chat with the newest last message comes first. A chat with no message comes after a chat with a message. The menu badge shows the total unread count of all chats. A mail report does not count as chat unread.

The page reads `GET /api/chats`. It follows the `message` event on `GET /api/events`. It never reloads the page.

### Conversation

Select a row to open the chat. The conversation shows the messages in time order. An Owner message sits on the right. An agent message sits on the left. The avatar of the agent shows at the first message of each run of messages from that agent. It does not show again inside the same run. Each bubble shows the text, the sender, and the time. An Owner bubble also shows the delivery state from the record: `queued`, `delivered`, `relayed`, or `failed` with the reason.

Opening a chat calls `POST /api/chats/<thread>/read`. It marks each chat record to the Owner as read. A mail report keeps its own read state. The page stops the count for that chat. A read-only preview refuses the read, so the count stays.

Scroll up to read older messages. The page asks for the page before the oldest message while the service sets `more` to `true`. The page keeps your reading position. The 30-day retention of the store sets the oldest message that the page can show.

A new message goes at the bottom. The page scrolls down only when you already read the newest message. Otherwise the page shows a **new messages** pill. Select the pill to go to the newest message.

### Composer

Select the round send button or press Enter to send the message. Select Shift and press Enter to make a new line. The text area grows with the text, up to 6 lines. The composer hides the scroll bar until the text is longer than 6 lines. A message holds at most 2000 characters. The service accepts at most 10 Owner messages a minute. The focus stays in the text area after a send.

The page adds a `queued` bubble at once. The stored record replaces the bubble. A refused send marks the bubble `failed` and shows **Retry**. Select **Retry** to send the same text again. `POST /api/messages` is the only write path of the page.

### Action cards

A message from an agent that asks the Owner for a decision shows as a normal bubble with one small button per option. The card has no frame of its own. The bubble holds a short question line, and the page drops the choice list from the text because the buttons hold the choices.

The page shows a card for a real choice only:

- An approval shows **Approve** and **Reject**. It also shows **Later**.
- A decision shows one button for each choice. A decision with the choices `Yes` and `No` shows those two buttons.
- An answer shows a one-line text field and a small **Send** button.

**Later** only collapses the card. The page writes nothing. The Mailbox item stays open.

A decision without a Markdown list under a `Choices` heading is not a real choice. It shows as a plain bubble with the **Open in Mailbox** link. A message with the action `read` also shows as a plain bubble.

The page finds the choices with the same rule as the Mailbox.

The card uses the same send route as the Mailbox. It calls `POST /api/messages` with `replyTo` set to the item ID. The server closes the item. The bubble then shows the result, for example `Approved 22:05`. A closed item shows as a normal bubble with the result of the answer that closed it. The message event then refreshes the chat and the Mailbox.

Every card keeps an **Open in Mailbox** link. A read-only preview refuses the send and shows the reason in the card.

### Keyboard and screen readers

- The chat list holds one button per chat. The arrow keys, **Home**, and **End** move the focus between the rows. Enter opens a chat.
- The focus goes to the message field when a chat opens. The focus goes to the list row of the open chat when you select **Back** or press Escape.
- Escape returns from an open chat to the list.
- The message list has `role="log"` and `aria-live="polite"`. A screen reader reads each new message once.
- Each bubble has a name with the sender, the time, the text, and the state.
- The text of the chat view reaches the WCAG AA contrast in the light theme and in the dark theme.

### Phone

On a phone, the list fills the page. Select a chat to open it full screen. Select **Back** to return to the list. The chat thread stays in the page address, so the browser Back button also returns to the list. The buttons are at least 44 px high.

## Phone and home screen

The dashboard adapts to a phone and to a home-screen web app.

- On a screen up to 760 px wide, the header shows a menu button with the current page name and the three top-bar icons. Select an icon to open the Chat or that Mailbox folder. Select the menu button to open the page menu. The menu closes after you choose a page and when you press Escape.
- On a phone, the long sections of a project page start collapsed. Select a section title to open it. The dashboard remembers each open section for that project during the session. Overall progress and the current frontier stay open.
- Project cards become compact. They show the name, mode, status line, and task bar.
- Tables show stacked rows with a label for each value. The page does not scroll sideways at 393 px.
- The expanded browser view fills the screen. One compact toolbar holds the controls. The text field and key controls appear only while **Control browser** is on. The screenshot fills the rest of the height, in portrait and landscape.
- The dashboard sets the home-screen web app meta tags. To add the dashboard to a phone home screen, open it in Safari, open the Share menu, and select **Add to Home Screen**.

## Configuration

Put overrides in `~/.herdr-boss/config.json`, then restart the service.

```json
{
  "port": 4477,
  "host": "0.0.0.0",
  "push": true,
  "access": { "tokenFile": "/Users/you/.config/herdr-boss/access-token", "sessionDays": 30 },
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "machine": { "memFreeWarnPercent": 15, "loadWarnFactor": 2 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30, "sweepCodeSignClones": true },
  "workers": { "staleIdleMinutes": 120 },
  "roamgate": { "port": 8787, "tokenFile": "/Users/you/.config/roamgate/auth-token" },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] },
  "resourcePools": [
    { "name": "serve-ports", "range": "8000-8004", "split": { "herdrboss": ["8000", "8001"] }, "env": "HERDR_SERVE_PORT", "ttlMinutes": 240, "check": "tcp", "graceMinutes": 10 }
  ]
}
```

## Remote access

The server listens on all local interfaces. Requests from `127.0.0.1` need no login.

1. Open `http://<LAN-or-Tailscale-IP>:4477` on the other device.
2. Enter the token from `~/.config/herdr-boss/access-token`. Herdr Boss creates this file on first start. The directory has mode `0700`. The token and session files have mode `0600`.

The session lasts 30 days and renews while the device uses the dashboard. It survives a service restart. Set `access.sessionDays` to change the length. The server stores only hashes of session IDs and the token fingerprint in `~/.config/herdr-boss/sessions.json`, even when you set a custom `access.tokenFile` path. A new token signs every device out. Herdr Boss moves existing default credential files from `~/.herdr-boss/` on first start. An explicit `access.tokenFile` path remains in use. The login form lets a password manager, such as the iPhone keychain, save the token. API clients can send `Authorization: Bearer <token>` instead.

- Tailscale encrypts traffic between tailnet devices. LAN access uses plain HTTP; use it only on a trusted network.
- Set `host` to `127.0.0.1` to turn off remote access.
- To change the token, write a new token to the token file and restart the service.

When Roamgate runs and its token file exists, the header shows a **Roamgate** link. Herdr Boss reads that token only when you open the link.

## Usage records

When a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line, collection checks each configured artifact rule. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. Collection warns when the newest source file is newer than the oldest artifact file, or when matching sources have no matching artifacts. It prints each warning and includes it in the `artifactWarnings` summary field. The warning does not change the independent gate result. The orchestrator decides whether the gate passed.

`worker collect --record` records one usage event per worker run before merge. An unknown tool-call count stays `null`, and the ledger accepts `null` as unknown. If an older kit reports a ledger entry with `null` as invalid, install a HerdrBoss kit version that accepts `null`, then run `herdr-boss ledger check` again. This check reads the ledger. Do not replace `null` with `0` or edit the ledger entry. After a successful collection, Herdr Boss prints a reminder to merge the branch and then run `herdr-boss worktree prune --apply`. Collection does not remove a worktree. `herdr-boss usage record FILE` adds measured events. The Analytics page shows recorded usage and its coverage. Quota percentages are global per provider. They are not project token counts.

## Denials and permission prompts

Every 15 minutes, the service reads the Claude, Codex, OpenCode, and Pi logs for denials. The scan runs beside the engine tick, only when the engine acts. Two scans never run at the same time. The dashboard preview does not scan. One scan reads at most 20 MB in total. It continues from the saved byte offset of each file. A file with a new inode or a smaller size starts again at byte 0. The offsets are in `memory.json` under `denialScan`.

Herdr Boss keeps only counts in `denials.json` in the data folder, with mode 0600. Each record has the UTC day, the harness, the cause, the project, the model, and the count. The model comes from session metadata. Herdr Boss uses `unknown` when the model is missing. The file keeps 30 days. It holds no message text, command, argument, or path. What each harness counts is in [the harness setup](harness-setup.md#denial-counts).

Herdr Boss maps each record to a project by its working folder. A folder inside a registered repository belongs to that project. A worker worktree inside `~/Projects/.herdr-wt/<repo>/` or inside a sibling `<repo>-wt-<name>` also belongs to that project. The registered repositories are in `project-repos.json`. All other folders count as `other`.

The Analytics page shows the section **Denials and permission prompts**:

- A table of the last 7 days by cause and project, with a count for each day.
- A small table of counts by harness, model, and cause. It shows the top 10 rows, then the number of extra rows.
- A total for each harness.
- A trend arrow. It compares the last 24 hours with the mean of the 6 days before them.
- A read-only line with the limits: the scan interval, the bytes for one scan, the days kept, and the rise rule.

The last 24 hours are the count of today (UTC) and the part of yesterday inside the window. A cause rises when its last 24 hours are above 2 times its 6-day mean and above 10 events. Then the page and the Owner section of the bulletin show "Discuss this trend with the Boss." Herdr Boss sends no pane prompt and adds no project rule for a denial trend.

The first scans read the older logs at 20 MB for each scan. While more than 1 MB of logs is unread, the counts of older days are not complete. Then the page shows the unread size, and neither the page nor the bulletin shows the note.

## Resource leases

A resource pool is a set of scarce items that several projects share, for example local serve ports. A project leases one item, uses it, and releases it. Herdr Boss keeps the leases in `leases.json` in its data directory, with mode `0600`. Each change holds the mutation lock of the machine locks.

Lease a shared resource with `herdr-boss lease acquire POOL` or `worker start --lease POOL`. Never pick a port from a pool by hand. The commands are in [Resource leases](cli.md#resource-leases).

Define each pool in `resourcePools` in `~/.herdr-boss/config.json`:

| Key | Meaning |
|---|---|
| `name` | Required. A slug of lowercase letters, digits, and hyphens. |
| `items` or `range` | Required. Use exactly one. `items` is an array of strings. `range` is `"LOW-HIGH"` and gives each integer from LOW to HIGH. |
| `split` | Optional. Project slugs to item lists. Each item must be in the pool and in one list only. A project takes its own items first. |
| `env` | Required. The variable that `worker start --lease` sets in the worker pane. |
| `ttlMinutes` | The lease time. The default is 240. |
| `check` | `"tcp"` or `null`. `"tcp"` means that each item is a local port. The default is `null`. |
| `graceMinutes` | Kept for older configs. It has no effect on reclaims: a port without a listener is never reclaimed. |

The pool `project-browsers` is built in. Herdr Boss adds it to the config pools. Do not define a config pool with this name: it is an error. See [Port leases](#port-leases).

Herdr Boss validates the pools when it loads the config. An invalid pool list gives no config pools. The built-in pool stays. The lease commands then fail and name each error, and the bulletin shows each error. Do not put a secret in a pool. An unknown key is an error.

Herdr Boss reclaims a lease on each service tick and before each `lease acquire` or `lease release`. It reclaims a lease when one of these conditions is true:

- The pane of the lease is not in a successful Herdr pane list.
- The run record of the worker has `finishedAt`.
- The time `expiresAt` of the lease is in the past.
- The pool is `project-browsers`, and no matching Chrome process runs on two ticks in a row. This rule is the only rule for this pool.

A port without a listener is never a reason to reclaim. A holder that is alive keeps its lease until its TTL, also before it serves on the port. `lease acquire` never gives out an item that a live holder has. Herdr Boss logs one `lease` event for each reclaimed lease, with the pool, the item, the project, and the reason. When the holder pane is still alive, for example after the TTL, the engine sends it one notice. The bulletin has a `Resource leases` section with one line for each pool. The line shows each item with its holder, its age, and `borrowed`, or `free`. The line of `project-browsers` shows only the leased ports and the number of free ports.

## Project locks and worktree cleanup

Use a project lock when one task must finish before another task starts in the same Git repository. Run the commands from a verified `orch` or `boss` pane:

```sh
herdr-boss lock acquire release-review
herdr-boss lock list
herdr-boss lock release release-review
```

All linked worktrees of one repository share its locks. The `full-suite` lock is machine-wide. All repositories on this machine share it, and `lock list` shows its scope as `machine`. Herdr Boss keeps lock files in a private `locks` directory under its data directory. A lock records its name, owner pane, PID, kind, safe acquire command, and acquisition time. A `suite` or `push` lock uses that command's PID. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual `full-suite` lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock, and the engine warns the former holder. Release a lock from its owner pane. Another pane can release it only after the owner PID has exited, the owner pane has closed, or a manual `full-suite` lock has expired. Use `--wait SECONDS` to wait for an active lock. Enter a whole non-negative number. Herdr Boss takes over a stale lock and prints its previous pane and PID.

Herdr Boss writes the lock ledger, `lock-ledger.jsonl`, in its data directory. The file is append-only JSONL. Each acquire adds one `acquire` line. It holds the time, lock name, project, kind (`suite`, `push`, or `manual`), holder pane, tree hash when the checkout is clean, and `waitMs`. Each release adds one `release` line with the same fields and `holdMs`. A takeover of a stale lock adds a `release` line with `takeover: true`. A busy acquire adds a `busy` line, and an acquire whose wait ends first (exit code 75) adds a `timeout` line. Both have `waitMs`. A re-entrant suite under a push adds lines with `reentrant: true`. Its release line holds the time that the suite ran. The medians skip re-entrant lines, `busy` lines, `timeout` lines, and the hold time of takeover lines. When the file passes 5 MB, Herdr Boss renames it to `lock-ledger.1.jsonl` and replaces the older rotated file. It starts a new `lock-ledger.jsonl`. The dashboard reads only the current file. The ledger never blocks a lock change.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. There is no load threshold.

```sh
herdr-boss suite -- npm test
herdr-boss push origin main
```

`herdr-boss push` takes the lock only when a pre-push hook exists. It releases the lock also when the push fails, and it returns the exit code of `git push`.

Before it removes a worktree, `herdr-boss worktree prune --apply` checks for processes whose current working directory is inside that worktree. It reports parent-PID-1 processes in missing or prunable worktree paths. Stop those processes before cleanup. Herdr Boss removes no worktrees if it cannot scan process directories. It also keeps worktrees that are dirty, unmerged, primary, used by a live pane, or uninspectable. Herdr Boss sends a notice about a parent-PID-1 process in a removed worktree only to that repository's `orch` workspace.

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/denials` | The denial counts of the last 7 days by harness, model, and cause, the harness totals, and the trend of each cause. |
| `GET /api/projects`, `PUT`, `DELETE /api/projects/SLUG` | Read, write, or delete project status. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=ID` | Handover records, and a successor's pane output. |
| `POST /api/handoffs/plan`, `/prepare`, `/activate` | The handover steps. Activation needs `confirmed: true`. |
| `GET`, `POST /api/browser-sessions...` | Browser list, request, tabs, screenshot, navigation, input, new tab, tab close, close, restart, and bookmarks. Input to an agent tab returns 409 unless the body has `confirmAttached: true`. Tab close returns 409 for a tab that an agent holds unless the body has `force: true`. `GET /api/browser-sessions/bookmarks?project=SLUG` reads the bookmarks and the start page. `POST /api/browser-sessions/bookmarks` changes them with `{ project, action }`. |
| `POST /api/leases/release` | Release a lease: `{ pool, item, project }`. Returns 409 when the lease changed. |
| `GET /api/messages?thread=THREAD` | The records of one thread, oldest first, at most 200. |
| `POST /api/messages` | Queue an Owner message: `{ thread, kind, text }`. `kind` is `message`, `nudge`, or `status-request`. Returns 400 for invalid input, 404 for an unknown thread, and 429 above 10 sends a minute. |
| `POST /api/tick` | Collect now. |
| `GET`, `POST`, `DELETE /api/avatars/SLUG` | Read, store, or remove the image of one avatar. The slug is `boss` or a project slug. `POST` takes the image as the body, at most 512 KB, and accepts only a PNG, JPEG, or WebP file. It returns 415 for any other format and 413 for a larger body. A read-only preview refuses the two write routes. |
| `GET /bulletin.md` | The current bulletin. |
