# User guide

This guide tells how Herdr Boss works and how to set it up. For commands and options, see [cli.md](cli.md). The dashboard has a **Help** panel on each page.

## How it works

Every 30 seconds, Herdr Boss reads Herdr workspaces and agents, machine load and memory, and automation browsers and their owner panes. Every 5 minutes, it reads subscription quotas with `codexbar usage --format json`.

Then it applies its rules and writes these files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read it before each dispatch. |
| `rules.json` | The same rules for scripts. `worker start` reads it. |
| `state.json` | The full snapshot that the dashboard shows. |
| `events.jsonl` | Prompts, notifications, handovers, and stopped processes. |
| `policy.json` | The resource policy that you set on the Settings and Allocation pages. |
| `locks/` | Private project lock records. Each Git repository has a separate directory. |

`herdr-boss scratch <slug>` creates `~/.herdr-boss/scratch/<slug>/` for the orchestrator files of a project. Herdr Boss does not delete this folder.

Herdr Boss is a script. It uses no LLM and no tokens.

## Project memory

Store project memory in `docs/orchestration/memory.md`. Commit this file with the project repository.

Store Boss memory in `~/.herdr-boss/boss-memory.md`. Keep this file private and never commit it.

Use these five sections in this order:

- `## Owner decisions in force`: Record one line per decision. Include the date (YYYY-MM-DD) and the source.
- `## Holds and freezes`: Record one line per hold. Include its start date, scope, and the condition that lifts it. Delete the line when the hold is lifted.
- `## Standing rules`: Record project rules that are not in `AGENTS.md` yet.
- `## Roles and panes`: Record facts that stay true for longer than one session.
- `## Evidence`: Record pointers to files, commits, or reports. Do not copy evidence into the file.

Keep current state only. Delete a line when a decision is superseded. Git keeps history.

Never store secrets, tokens, or credentials. In a public repository, do not store client names, tenant URLs, or details of other projects.

## Kit block in AGENTS.md

Each project `AGENTS.md` holds one Herdr Boss block between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The hash identifies the kit version of the block. `herdr-boss kit block` prints the current block. `herdr-boss check agents` finds an old or hand-edited block. It also finds stale orchestration text outside the block, such as fixed pane IDs, dated lines, and copied model lists. `herdr-boss publish` and `herdr-boss worker start` run the same check and warn. The project page shows the counts from the last `publish`. The commands are in [cli.md](cli.md).

## Orchestrators

Herdr Boss finds an orchestrator by its pane label `orch`. Tab names do not matter. An orchestrator can label its own pane:

```sh
herdr pane rename "$HERDR_PANE_ID" orch
```

The label stays when the agent in the pane restarts. The pane with the label `boss` is the Herdr Boss orchestrator itself.

To add the shared rules to a project, follow [orchestrator-instructions.md](orchestrator-instructions.md). The shared process is in [the orchestrator skill](../kit/skills/herdr-orchestrator/SKILL.md).

## Rules and notices

| Condition | Action |
|---|---|
| A quota window is at 98% or more | Critical notice. The bulletin tells orchestrators to avoid that kind. |
| A quota window is at 90% or more | Warning notice. |
| A live quota window is at 100% or more | The provider lane is exhausted until the latest reset among its exhausted windows. `worker start` refuses it unless you use `--force`. |
| A quota runs out before its reset at the current pace, or its use is above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |
| A parent-PID-1 process has its current working directory in a missing worktree | Notice that project's `orch` workspace. Do not notify the Boss workspace. |
| A non-orchestrator worker stays blocked for more than 5 minutes | Notice its project orchestrator with the worker name and pane ID. |
| An `orch` pane stays `idle` or `done` for the configured idle minutes while its published status has an actionable task | Notice that project with the task ID and title. |
| The service starts, and the checked-out branch has new commits that change `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md` | One `Kit updated` notice to each project orchestrator, with up to 10 commit subjects, newest first. Do not notify the Boss workspace. |
| A worker is working, first appears idle or done, or changes into either state | Herdr Boss reads only the last 8 visible pane lines. A known provider error marks the worker failed and sends the orchestrator its name, pane ID, and fixed error label. |

The failure labels are `API Error`, `401`, `429`, `Connection lost`, `usage limit`, `rate limit`, `overloaded`, and `Free usage exceeded`. Matching ignores letter case and ignores each line whose trimmed text starts with `Tip:`. The matcher requires error forms for `401` (`401 Unauthorized`, `HTTP 401`, or `status 401`) and `usage limit` (`usage limit reached`, `usage limit exceeded`, or `hit your usage limit`). Herdr Boss stores and sends only the matched label and a parsed retry time. It does not store or forward pane output. Herdr Boss reads a working pane on every engine tick, so a failure is found while the worker still works. A matched worker shows the failed status in the snapshot even when Herdr reports it working. The engine then does not count it as running, so its slot becomes free. A failure found in a working pane clears when a later read shows no known failure. A failure found on an idle or done pane clears when that pane starts working and a later read shows no known failure. Any failed status clears when a different worker uses the pane. A later failure creates a new notice. A valid free-usage retry time exhausts the matching unmetered model until that time. The unmetered lane lists it separately from available models. A `Free usage exceeded` failure of an `opencode` worker with an unmetered model also exhausts the whole `opencode` free lane. This closes every unmetered model of the `opencode` harness. The lane uses the parsed retry time. Without a parsed retry time, the lane closes for 1 hour after the failure, and the lane shows that the reset time is unknown. A later absolute retry time in the same pane extends the exhaustion to that time. Herdr Boss measures a relative retry time from the first observation of the failure.

An idle-orchestrator nudge reads the published project status file. Herdr Boss sends it only when the project mode is `auto` or `active`. It skips the `idle` and `paused` modes and the Boss workspace. The `orch` pane must be `idle` or `done` for at least the configured idle minutes. No other worker in that workspace may be `working`, `blocked`, or `failed`.

A task is actionable when its status is `todo`, `doing`, or `review` and every ID in its `blockedBy` list is `done` in the same project. An unknown blocker stays unresolved. A task with status `blocked` is never actionable. Herdr Boss picks one actionable task: current frontier first, then a task without a frontier value, then next frontier. Status-file order decides a tie.

The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work yourself. The notice uses one key per project and task, so the normal notice cooldown limits repeats. A different next task gets a new key and can prompt again.

A notice is a prompt to an `orch` pane. Herdr Boss normally sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. Worker failure notices send immediately, including when the orchestrator is `working`. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`.

The kit notice goes to every project orchestrator, also when the project has no active workers. The Boss workspace does not get it. When the engine starts, it reads Git once in the directory that the service runs from. It runs no timers and no model calls. It stores the last notified commit as `kitNotice` in `memory.json`. On the first start, it stores `HEAD` and sends nothing. When Git fails, or the stored commit is not an ancestor of `HEAD`, it stores `HEAD`, sends nothing, and logs one `kit` event. Each orchestrator gets the notice once, when its pane is `idle` or `done`. The notice stays pending for 7 days. The read-only preview does not read Git and does not send or store the notice. When you get a kit notice, run `herdr-boss check agents`. If it reports an old block, reinstall the block with `herdr-boss kit block`. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). This policy value takes precedence over the legacy top-level `alertCooldownSeconds` value in `config.json`.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it.
- **ahead of pace**: a live window will not last to its reset, or its use is above its goal-adjusted expected use. The lane shows when it is back on pace if it is not used.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.
- **exhausted**: a live window is at 100% or more. The lane shows its label and reset time. Only `--force` can use it.

A provider is open only when every live, measured window is on pace and no live window is exhausted. Extra windows, such as a model-only window, do not count. When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage. When several windows are exhausted, the lane shows the one with the latest reset.

A **quota pacing goal** is the most percent of a window that you want to use by its end. A goal without a separate end reaches its percent at reset. Herdr Boss scales the measured expected-use pace by `goal / 100` for this form. A timed goal rises from the live window start to its percent at the configured end. The line stays at that percent until reset. An unset goal means 100%, which preserves the normal pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

Choose a one-off local date and time, or choose a recurring number of whole hours before reset. Herdr Boss stores a one-off time as an ISO timestamp. It deletes that whole goal when the time passes or the quota window resets. It keeps a recurring offset for later windows. A goal end must be after now, after the current window start, and no later than its reset. `herdr-boss lanes` and the bulletin show the goal and its end while the provider is open or restricted.

The same output has one **unmetered** lane. It lists every permitted unmetered model that can start, by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The lane leaves out three kinds of closed models and reports each one on a separate line with its reason:

- A model with an active free-usage retry. The line shows its retry time.
- A Pi model that Pi cannot use. Herdr Boss runs `pi --list-models` at most once every 15 minutes. Pi lists only the models that it can use. A Pi model is unavailable when the last good result does not list it. When Pi lists no row for the provider of the model, the line states that Pi has no credential for that provider. A failed run, or output without a header row, keeps the last good result. Without a good result, Herdr Boss does not hide a Pi model.
- Every unmetered model of a harness whose free lane is exhausted. The line shows the retry time, and `(reset time unknown)` when Herdr Boss uses the 1-hour default.

The lane is closed when it leaves out a model and no unmetered model remains. The bulletin, `herdr-boss lanes`, and the worker-start refusal text use the same data. They never offer a closed model as an alternative. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

`worker start` refuses a Pi model that the last good `pi --list-models` result does not list. `--force` does not bypass this refusal, because such a worker cannot run. `worker start` also refuses an unmetered model of a harness whose free lane is exhausted. Use `--force` only for an authorized override.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Settings and allocation

The Settings page has one section for each harness. A harness section holds the harness availability, the preferred model, and one row for each model. Provider quota modes, quota pacing goals, and machine limits are below the harness sections.

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

Old policy files can omit all of these fields and `preferredModels` and `pacingGoals`. Herdr Boss keeps `excludedModels` and `modelProviders` values. When you enable a model in one harness and `excludedModels` lists it, Settings removes it from `excludedModels` and adds it to `disabledModels` for each other harness that lists it.

Both pages keep policy edits in a draft. Select **Apply policy** to save the draft. A rejected save shows the server error and keeps the draft.

The Allocation page sets the global worker limit, workspace project status, project shares and exclusions, and orchestrator succession. The project share is advisory. `worker start` enforces the global limit and the disabled harnesses and models.

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget in each worker brief. The default is 10 screenshots. The project setting overrides the kit default. Worker start appends any missing budget or copied input details when a project brief template omits those slots. Use `worker start --copy PATH` to copy a regular repository file into the worker's `.worker/inputs/` directory before the agent starts. Repeat `--copy` for each file. The command preserves repository subdirectories and refuses paths outside the repository.

Set `artifactChecks` in `.herdr-boss.json` to check generated files during worker collection. Each rule has an `artifacts` glob and a `sources` glob. For example, use `docs/gallery/**/*.png` for artifacts and `extensions/**/src/**` for sources. The patterns are repository-relative POSIX paths. `*` matches within one path segment. `**` matches zero or more path segments. Herdr Boss rejects absolute paths, parent traversal, backslashes, empty patterns, and malformed rules.

Use the workspace switches above the project shares to include or exclude a live workspace. An excluded workspace stays visible on Agents with the marker **Not a project**. It does not appear on Projects or Overview. It has no project share or worker slots. Herdr Boss stores excluded workspace labels. It resolves a saved Herdr ID to its current label when possible. A workspace with a pane labelled `boss` is excluded automatically while that pane is present. Herdr Boss removes the legacy `policy.projects.boss` entry and redistributes other project shares in the same proportions.

Each project has two share values:

- The **set share** is the share in the policy draft. The bar widths show the set share. Drag a boundary or use the arrow keys to change it.
- The **effective share** is the number of worker slots that the project has now, divided by the applied maximum of working agents. The **effective slots** are that number of slots. These values come from the applied policy. They change only after you select **Apply policy**.

A bar segment shows its set share and its effective slots, for example `30% · 2`. A narrow segment shows only the set share or no label. Its tooltip shows all values.

An idle project is faded in the bar and in its row. A paused project is faded and striped. When **Borrow idle shares** is on, each idle project lends its slots to the active projects. An idle project can then have 0 effective slots while its set share stays the same.

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

## Project browsers

Each project can have one persistent Chrome profile. Request it with `herdr-boss browser request SLUG`, or open it from the Browsers page. Herdr Boss assigns a port from 9223 to 9299.

- Give each worker its own tab. `browser tab new` opens a tab in its own window, so it stays visible in a headless browser.
- A website or identity provider decides how long a login lasts. Sign in through the dashboard when a login is needed.
- Herdr Boss never stops a browser that it did not start. Port 9222 is kept for an optional legacy shared browser.

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
- No running Google Chrome main process started within 5 seconds of the clone creation time. This rule keeps the clone of each running Chrome, including the Chrome on port 9222.

Herdr Boss reads the process list with `ps -axo pid=,lstart=,comm=`. If the read fails, it deletes nothing. The sweep never sends a signal to a process. Each sweep that deletes clones adds one event with the count and the freed space. The freed space is the change in free disk space, because a clone shares disk blocks with the app. Set `browsers.sweepCodeSignClones` to `false` to stop the sweep. Run `herdr-boss browser sweep-clones --dry-run` to list the orphaned clones.

Herdr Boss uses the clone folder only when `HOME` is the home folder of the account. A process with a temporary `HOME`, such as a test, finds no clone folder.

On the Browsers page, **Show preview** captures a screenshot of the selected tab. The preview shows a still image until the next capture. **Live** refreshes it at the interval that you select.

Select the screenshot to open the large view. The large view shows the last capture as a still image. Turn on **Control browser** to refresh the large view at the selected interval and to send clicks and keys. Turn off **Control browser** to stop that refresh. **Live** continues to refresh while it is on. The status shows **Live** while a refresh repeats and **Captured** at other times. In **All tabs** mode, **Control browser** is not available.

Agent commands and tab rules are in [the browser service](../kit/browser-service.md).

## Project status pages

Orchestrators do not build dashboards. They publish a status file, and Herdr Boss shows it on `/projects/SLUG`. With the optional work structure fields, the page shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

## Organization page

The `/organization` page shows the organization as a read-only chart. The chart has four levels:

1. The **Owner** node shows **At the Mac** or **Away**. The value comes from the machine idle time.
2. The **Boss** node shows the pane labeled `boss`, its harness, state, quota use, and handover state. The workers in the Boss workspace are below it.
3. Each **project** node shows the orchestrator pane, harness, and state. It also shows the current task, the worker slots in use against the slots and share, and the handover state. The nodes use the project order.
4. Each **worker** node shows the agent name, harness, state, and task ID.

Select **Details** on a node to show its recorded values. The page cannot send messages or change resources.

The page uses only the state that the dashboard already loads. These limits apply:

- The page shows **Not reported** when the state does not hold a value.
- Herdr Boss does not receive the model of a running agent. The page does not use a preferred model as the model of an agent.
- The current task is the first published task with status `doing`. The worker task is the open published task whose `worker` field names that agent. The page does not read a task from a pane title.
- Quota use shows only for a Codex or Claude harness, because each of these harnesses uses only its own subscription.
- A **reserve** node shows a prepared successor only when a prepared handoff record names the current orchestrator or Boss pane as its source and the successor pane is live. A recommended successor does not show as a reserve.
- A workspace marked not a project has no project node. The Boss workspace shows as the Boss node.
- The page shows no pane output, message content, or secrets.

## Phone and home screen

The dashboard adapts to a phone and to a home-screen web app.

- On a screen up to 760 px wide, the header shows a menu button with the current page name. Select the button to open the page menu. The menu closes after you choose a page and when you press Escape.
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
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] }
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

## Project locks and worktree cleanup

Use a project lock when one task must finish before another task starts in the same Git repository. Run the commands from a verified `orch` or `boss` pane:

```sh
herdr-boss lock acquire release-review
herdr-boss lock list
herdr-boss lock release release-review
```

All linked worktrees of one repository share its locks. Herdr Boss keeps lock files in a private `locks` directory under its data directory. A lock records its name, owner pane, pane shell PID, safe acquire command, and acquisition time. Release a lock from its owner pane. Another pane can release it only after the owner PID has exited or the owner pane has closed. Herdr Boss marks that lock as stale. Use `--wait SECONDS` to wait for an active lock. Enter a whole non-negative number. Herdr Boss takes over a stale lock and prints its previous pane and PID.

Before it removes a worktree, `herdr-boss worktree prune --apply` checks for processes whose current working directory is inside that worktree. It reports parent-PID-1 processes in missing or prunable worktree paths. Stop those processes before cleanup. Herdr Boss removes no worktrees if it cannot scan process directories. It also keeps worktrees that are dirty, unmerged, primary, used by a live pane, or uninspectable. Herdr Boss sends a notice about a parent-PID-1 process in a removed worktree only to that repository's `orch` workspace.

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/projects`, `PUT`, `DELETE /api/projects/SLUG` | Read, write, or delete project status. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=ID` | Handover records, and a successor's pane output. |
| `POST /api/handoffs/plan`, `/prepare`, `/activate` | The handover steps. Activation needs `confirmed: true`. |
| `GET`, `POST /api/browser-sessions...` | Browser list, request, tabs, screenshot, navigation, input, new tab, close, and restart. Input to an agent tab returns 409 unless the body has `confirmAttached: true`. |
| `POST /api/tick` | Collect now. |
| `GET /bulletin.md` | The current bulletin. |
