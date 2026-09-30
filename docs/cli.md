# CLI reference

Run `herdr-boss` with no arguments to print a short usage list. Commands that change state print JSON or one status line. Errors go to standard error with a non-zero exit code.

Run project commands (`worker`, `worktree`, `ledger`, `check`, `gh`) from inside the project repository. They read `.herdr-boss.json` from the repository root.

## Service

| Command | Action |
|---|---|
| `herdr-boss install` | Install and start the macOS launchd agent `no.tallmaker.herdr-boss`. Run it again after you move the repository. |
| `herdr-boss uninstall` | Stop and remove the launchd agent. |
| `herdr-boss serve` | Run the collector and the dashboard in the foreground. |
| `herdr-boss serve --read-only-preview` | Run a dashboard preview. It accepts local requests only. It allows API reads and blocks API changes, prompts, notifications, process reaping, Chrome clone sweeps, handovers, and browser launches. It never reads, creates, or changes access files. It needs a `HERDR_BOSS_DIR` that the service does not use. |
| `herdr-boss tick [--json]` | Collect once and print alerts. Sends no prompt and stops no process. `--json` prints the full snapshot. |
| `herdr-boss logs` | Print the last 100 lines of the server log. |
| `herdr-boss kit-path` | Print the path of the shared kit (skill, templates, model list). |

Restart the service after a configuration change:

```sh
launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss
```

Start a dashboard preview with temporary data and a separate local port:

```sh
HOME="$(mktemp -d)" HERDR_BOSS_DIR="$(mktemp -d)" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview
```

Choose an unused local port if 4478 is busy.

`HERDR_BOSS_DIR` selects the data directory. The live data directory defaults to `~/.herdr-boss`. Set `HERDR_BOSS_LIVE_DIR` when the service uses another live directory.

A preview collects and evaluates, so it writes `state.json`, `rules.json`, `bulletin.md`, and quota history into its data directory. A preview therefore requires `HERDR_BOSS_DIR` to name a separate directory that the service does not use. The directory does not have to be empty. A directory that holds files from an earlier preview is valid. The command refuses to start when `HERDR_BOSS_DIR` is unset, when it resolves to the live data directory, when it resolves to `~/.herdr-boss`, or when a symlink in the path resolves to either of them. The refusal happens before the command creates or migrates a data directory. Use a separate `HERDR_BOSS_LIVE_DIR` value in the preview process to point the check at another live directory.

When `NODE_TEST_CONTEXT` is set, or the data directory differs from the configured live directory, the Engine disables prompts, notifications, process reaping, and handovers. Set `HERDR_BOSS_ALLOW_ACTIONS=1` only when you intentionally need these actions outside the live service.

## Resources and policy

| Command | Action |
|---|---|
| `herdr-boss lanes` | Show the active Owner state, machine CPU and threshold, 5-minute load and backstop, then one line per quota provider. Show common unmetered models once by harness with project exceptions, followed by exhausted free models and retry times; show only this project's models inside a configured checkout. |
| `herdr-boss models [--kind KIND]` | The allowed harnesses, models, and efforts from `kit/models.json` and the policy `extraModels`. A kind with policy models also has `localModels`. That field lists the models that come from the policy `extraModels` and not from `kit/models.json`. |
| `herdr-boss policy show` | Print the resource policy (`~/.herdr-boss/policy.json`). |
| `herdr-boss policy set FILE` | Validate and replace the policy. The service applies it on the next tick. |
| `herdr-boss usage record FILE` | Add one measured or unmeasured usage event. |
| `herdr-boss usage summary` | Usage per project and provider. |
| `herdr-boss spend [--days N] [--json]` | Token use and estimated cost for the last N days (1 to 90, default 7). It prints one line for each day and role, then one total line for each day. `unpriced` marks tokens of a model without a price. `--json` prints the full summary, with the harness split. The service updates the numbers every 5 minutes. |

## Project status

| Command | Action |
|---|---|
| `herdr-boss publish SLUG FILE [--force]` | Validate a status file and install it for `/projects/SLUG`. Use `-` for standard input. Refuse a status in which a task has a live worker but is not `doing`. `--force` skips this check. Schema: [project-status.md](project-status.md). |

`publish` reads the run records of the project in the Git top level. A worker blocks the publish when all of these are true: its run record has no `finishedAt` and no `collectedAt`, `herdr agent list` shows an agent with the worker name and the status `working` or `blocked`, the worker has no `report.json`, and the worker is not parked. Then, when its task is not `doing` in the status file, `publish` prints one line with the task ID and the worker name. It exits with code 1 and publishes nothing. Set the task to `doing`, or run `publish` again with `--force`. A task ID that is not in the status file counts as not `doing`. An idle or done agent, a parked worker, and a worker that wrote its report wait for the orchestrator, so they never block a `review` or `done` status. When Herdr fails or lists no agent, no worker blocks the publish. A run without a task ID is not checked. See [Live task state](user-guide.md#live-task-state).

`publish` keeps the stored status small. It keeps the newest 30 done tasks, ordered by `updated`, or by file order when `updated` is missing. It removes the older done tasks from the stored file. A done task that a kept task or an open task lists in `blockedBy` stays in the file.

The command records the ID of each removed task in `doneIds`. It sets `doneCount` to the number of unique IDs in `doneIds` plus `doneCountBase`. `doneCountBase` holds counts that have no ID: a `doneCount` from an older stored status, and IDs dropped from a full `doneIds`. A done task without an ID, or with an ID over 200 characters or with control characters, stays in the file and is not counted. `doneIds` holds at most 5000 IDs. The oldest ID leaves first and moves into `doneCountBase`. An ID that is in `tasks` again, for example an open task, leaves `doneIds`.

The orchestrator keeps its own file unchanged. Publishing the same file again leaves `doneCount` unchanged. `publish` prints one line, `moved N done tasks into doneCount`, only when N is more than 0. `publish` prints a warning, and still publishes, when the stored status is larger than 200 KB. `doneCount` and `doneCountBase` must be integers from 0 to 1000000. `doneIds` must be an array of strings.

`publish` also checks `AGENTS.md` at the Git top level of the current directory, when that file exists. It prints each finding to standard error as a warning. It publishes the status in all cases. The published record gets `agentsCheck: { checkedAt, errors, warnings, file }`. The record holds only the counts and the repository-relative file name. The project page shows a warning line when `errors` or `warnings` is more than 0. The status file can also hold `kitRevision`, the kit revision that the orchestrator loaded. The project page compares it with the current kit revision.

The first `publish` of a slug registers the project. It records `{ slug, repo, remote }` in `project-repos.json` in the data folder, with mode 0600, when the Git top level exists. `repo` is the Git top level. `remote` is the `origin` URL without a user name and a password. A later publish keeps the first record. For a new slug, `publish` runs `harness sync --codex-only` and prints its result as `warning: harness sync:` lines.

## Owner messages

The Owner sends messages from the Organization page. The Boss and the orchestrators reply with these commands. The default store is `messages.jsonl` in the data directory. Set `store.messages` to `sqlite` in `config.json` to use `herdr-boss.db`.

| Command | Action |
|---|---|
| `herdr-boss say [--reply-to ID] [--action answer\|approve\|decide\|read] "TEXT"` | Write a reply for the Owner. Run it from the pane labeled `boss` or from a pane labeled `orch`. |
| `herdr-boss messages [THREAD]` | Print the records of one thread as JSON, oldest first. Without `THREAD`, print the records of all threads. `THREAD` is `boss` or a project slug. |
| `herdr-boss messages relay ID... --by boss` | Mark queued Owner messages as relayed by the Boss. Only the pane labeled `boss` can run this command. Herdr Boss never sends a relayed message. |
| `herdr-boss mail post --to owner [--title TEXT] [--action read\|decide\|approve\|answer] FILE` | Post a Markdown report for the Owner in the `boss` thread. Only the pane labeled `boss` can post. |
| `herdr-boss mail close ID... --note TEXT` | Close open Mailbox items as answered through the Boss. Only the pane labeled `boss` can run this command. It sends no message. |
| `herdr-boss store import messages` | Import `messages.jsonl` into an empty SQLite message table. Keep the JSONL file. Print the number of imported records. |
| `herdr-boss store export messages` | Write the SQLite message records to `messages.jsonl`. Print the number of exported records. |

`say`, `mail post`, `mail close`, and `messages relay` verify the caller the same way as `worker allow`:

1. The pane must set `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID`.
2. `herdr pane get` must return the same pane ID and workspace.
3. The pane label must be exactly `boss` or `orch`. `mail post`, `mail close`, and `messages relay` also require the `boss` label.

A worker pane cannot use `say`. The command tells the worker to ask its orchestrator.

The Boss writes to the `boss` thread. An orchestrator writes to the thread of the project that uses its workspace. Herdr Boss finds that project in `state.json`. `--reply-to` must name a message in the same thread.

Each reply and report is an item in the Owner mailbox. Set `--action decide`, `--action approve`, or `--action answer` only when the Owner must act. Everything else is information. Omit `--action` for information.

| Value | Meaning |
|---|---|
| `answer` | The Owner types an answer. |
| `approve` | The Owner approves or declines. |
| `decide` | The Owner makes a choice. Add a Markdown list under a `## Choices` heading to show choice buttons. |
| `read` | Information for the Owner. The commands use this action when you omit `--action`. |

The Mailbox shows action items under **Needs you**. It shows information under **Updates**. The escalation rules make Owner actions rare. The Owner answer comes back as an `[owner] Answer to ID:` prompt.

The `say` text is 1 to 4000 characters. The report file is Markdown, up to 64 KB. The report title defaults to the first Markdown heading, or to `Report`. The `mail close` note is 1 to 500 characters. The close command refuses an unknown or already closed ID and names that ID in its error. The Boss note does not send a reply. These commands refuse text that looks like a token, a key, or a password. The error does not print the text.

Example:

```sh
herdr-boss say --reply-to m-mg3k2x1a-1f2e3d4c "Two tasks are left. The next merge is at 14:00."
herdr-boss mail post --to owner --title "Morning handback" handback.md
herdr-boss mail close m-mg3k2x1a-1f2e3d4c --note "Answered with the Owner through the Boss."
```

## Watch

| Command | Action |
|---|---|
| `herdr-boss watch start [--until 'YYYY-MM-DD HH:MM' \| --until HH:MM \| --until-cancelled] [--quiet-hours] [--report HH:MM] [--retro HH:MM] [--routines ID,ID\|none] [--adhoc TEXT]` | Start the watch. The default end time is the next 07:30 local time. |
| `herdr-boss watch stop` | Stop the watch. Clear the watch state. |
| `herdr-boss watch routines` | Print the next run and the last run of each routine of the running watch. |
| `herdr-boss watch` | Print the current watch state in one line. |

`herdr-boss night` is an alias of `herdr-boss watch`.

Only the pane labeled `boss`, or the Owner in a plain terminal, may start or stop the watch. An orchestrator or a worker gets a refusal with the reason. The command verifies a Herdr caller the same way as `mail close`.

`--until` takes one of these values:

- `HH:MM`: the next such local time.
- `'YYYY-MM-DD HH:MM'`: that local date and time.
- An ISO time with an offset: that instant.

The end time must be in the future. A watch has no maximum length. The command prints a warning when the watch lasts more than 48 hours. Use `--until-cancelled` to run the watch until `watch stop`. Do not use `--until` and `--until-cancelled` together.

`--report` and `--retro` take `HH:MM`, `'YYYY-MM-DD HH:MM'`, or an ISO time. `HH:MM` means the next such local time. A watch until cancelled takes only `--report HH:MM`. That time repeats every day.

`watch start` writes `watch.json` in the data directory. The file holds `active`, `since`, `until`, `reportAt`, `retroAt`, `by`, and `quietHours`. `reportAt` is the end time unless you set `--report`. A watch until cancelled stores `until` as `null` and `untilCancelled` as `true`. It has no `reportAt` unless you set `--report`. A daily report also stores `reportDaily`. `retroAt` is absent unless you set `--retro`. `by` is `boss` when the Boss pane starts the watch, and `owner` when the Owner starts it in a plain terminal. `--quiet-hours` sets `quietHours` to `true`. The default is `false`. Herdr Boss reads an old `night.json` file when `watch.json` is missing.

The service reads the state on every tick. An active state marks the Owner as away, and the Boss acts for the Owner. The watch runs work as normal: pushes, deploys, and gates continue.

At `reportAt`, the service posts a report to the Boss thread in the Mailbox. At `retroAt`, it posts a retro. Each post happens once, even after a service restart. A daily report sets the next `reportAt` to the next `reportDaily` time after each post. A report does not wait for running tasks. It lists tasks completed since the watch started, running tasks and their start times, blocked tasks and what they wait for, worker counts, recorded metered lane use, and notices and alerts from the watch. The service keeps each report to 60 lines.

### Watch routines

`--routines` lists the routine IDs that run in this watch. Every other routine is off. `--routines none` turns all routines off. Without the option, the last choice applies. The first choice is that all routines run. `--adhoc` sets a text for this watch only. The text can hold up to 2000 characters.

`watch.json` then also holds `adhoc` and `routines`. Each item of `routines` holds `id`, `title`, `model`, `every` or `beforeEnd`, `nextAt`, `lastAt`, and, when they apply, `missedAt` and `waitingSince`. The item holds no prompt text.

The Watch box on the Agents page sets the same values through `POST /api/watch/start` with `routines` and `adhoc`. `GET /api/watch/routines` lists the routines. `PUT /api/watch/routines/ID` saves an edit. `DELETE /api/watch/routines/ID` removes the edit.

## Harness settings

| Command | Action |
|---|---|
| `harness check [--live-codex]` | Check the harness settings that orchestration needs. Print one line per entry: `ok`, `missing`, or `bad`, the harness, and the entry. Exit 1 when an entry is `missing` or `bad`. The command prints only paths and entry names. Owner lines that the Claude template does not define are not findings. `--live-codex` also runs one `codex exec -s workspace-write` with the worker shell variables of the caller pane. It passes when the tool shell has `HERDR_ENV` and `HERDR_PANE_ID`, and it prints only `set` or `missing`. The timeout is 180 seconds. Without `--live-codex`, the command calls no model. |
| `harness sync [--dry-run] [--codex-only]` | Back up `~/.codex/config.toml` to `config.toml.bak-<UTC timestamp>`, and add the missing roots to `writable_roots` in `[sandbox_workspace_write]`. The roots are `~/.herdr-boss`, `~/Projects/.herdr-wt`, and `<repo>/.git` for each registered project. Then compare the Claude template with `autoMode` and print only its differences. `--dry-run` prints the roots to add and writes nothing. `--codex-only` skips the Claude check. |

`harness sync` keeps each existing root and each other line of the Codex file. It adds `~/.herdr-boss` and `<repo>/.git` for each registered project, when they are missing. When the Codex section or array is missing or cannot be parsed safely, it changes nothing, prints the roots to add, and exits 1.

The command reads only `autoMode` from `~/.claude/settings.json`. It prints missing lines and changed labeled environment lines. It shows the old line after `now:`. It counts Owner lines that the template does not define, but it does not show their text. If the settings file or the `autoMode` key is missing, it prints the full template and says why. It never edits `~/.claude/settings.json`. The checked entries and the risk of each setting are in [harness-setup.md](harness-setup.md).
| `herdr-boss scratch SLUG` | Create `~/.herdr-boss/scratch/SLUG/` if it does not exist, and print its absolute path. `HERDR_BOSS_DIR` replaces `~/.herdr-boss`. |

## Workers

### `worker start NAME`

Create a branch and worktree, write the brief, add a worker pane, start the agent, and send the brief. Worker panes go in worker tabs in the verified caller workspace. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes.

`worker start` puts a new worktree in `~/Projects/.herdr-wt/<repo>/<name>`. It creates the parent folders when they are missing. Set `worktreeRoot` and `worktreeName` in `.herdr-boss.json` to use another place. The dry-run plan shows the worktree path.

Put task input files in `.orchestration/state/inputs/<worker name>/` in the main checkout. `worker start` copies regular files from that folder into `.worker/inputs/` and keeps their relative paths. It lists the copied paths in the brief. The folder can be empty or missing. Input files and `--copy` files share a 200 MB total limit.

`worker start` counts the live panes of each worker tab in `herdr pane list`. It uses the first worker tab in label order that has fewer than 3 panes. It runs `herdr pane split` from the newest pane in that tab. When all worker tabs are full, it runs `herdr tab create` with the lowest free label, for example `--label 'Workers 2'`. The worker then uses the root pane of the new tab. A listed worker tab with 0 live panes counts as free. Herdr has no pane to split in that tab, so `worker start` creates a new tab with the same label.

If the start fails before the agent starts, `worker start` closes only its own pane. It closes a worker tab only when the same start created that tab. The dry-run plan names the chosen tab, its tab ID, and its pane count, or `new tab`.

Set `workerPanesPerTab` in `.herdr-boss.json` to change the pane limit for each worker tab. The value is an integer from 1 to 6. The default is 3.

`worker start` waits for the shell prompt or a stable shell screen. It sets `DISABLE_UPDATE_PROMPT=true` and `DISABLE_AUTO_UPDATE=true` in new panes. If it finds an interactive question, it stops and tells the orchestrator to answer it in a shell once.

`worker start` sets `HERDR_ENV=1` in a new pane when `--kind` is `codex`. The agent in that pane then runs Herdr commands. Panes for the other kinds keep the pane environment that Herdr gives them. The dry-run plan prints the same `herdr pane split` or `herdr tab create` command.

Each worker gets an absolute `TMPDIR` under its worker folder. When the path is longer than 90 characters, `worker start` prints a warning because a Unix socket path can fail. A Codex brief says to run `setopt NO_BG_NICE` before a background command. A Claude brief says to wait for a background command to exit or use a `herdr-boss wait` command.

A Codex tool shell can run under a shared app-server daemon with another environment. For `--kind codex`, `worker start` therefore adds `-c shell_environment_policy.set.<NAME>="<value>"` to the agent launch arguments. It adds one argument for each of `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `TMPDIR`, and `HERDR_WORKTREE`. The pane, tab, and workspace IDs come from the new pane. The socket and binary paths come from the caller environment. A variable with an unknown value is left out. `worker start` refuses a value with a quote, a backslash, or a control character before it creates the worktree. The dry-run plan shows `<pane-id>` for the new pane, and `<tab-id>` when the start creates a tab.

`worker start` saves the resolved base commit in the run record. Review the worker, then collect it with `--record` before you merge its branch. Collection uses that saved commit so changed paths stay stable after the merge.

| Option | Meaning |
|---|---|
| `--kind KIND` | Required. `codex`, `claude`, `opencode`, or `pi`. |
| `--task TEXT` or `--task-file FILE` | Required. The work order for the brief. |
| `--allow PATH` | A repository path that the worker may change. Repeat for each path. The worker can write its own `.worker/` folder without this option. |
| `--read-only` | Allow changes in the worker's own folder only. Use this option when the task changes no repository file. Do not use it with `--allow`. |
| `--copy PATH` | Copy a regular repository file into `.worker/inputs/` before the agent starts. Repeat for each file. Keep its repository subdirectories. The 200 MB limit also counts automatic task inputs. |
| `--lease POOL` | Lease one item of a resource pool for the worker. Repeat for each pool. See [Resource leases](#resource-leases). A task that names `serve:live` automatically leases `serve-ports` when that pool exists and `--lease` does not name it. |
| `--model MODEL` | A model from `herdr-boss models`. The default is the kind's default model. |
| `--effort EFFORT` | A reasoning effort, where the kind supports it. |
| `--task-id ID` | The task ID from the published status. Herdr Boss saves it as `taskId` in the run record. The project board then shows the task as `doing` while the worker runs. Use letters, digits, `.`, `_`, and `-`, up to 64 characters. Always give this option. Without `--task-id` and `--issue`, `worker start` prints a warning and starts the worker. |
| `--issue N` | The issue number. It is an alias of `--task-id` for a numeric task ID. Do not use it with `--task-id`. |
| `--base BRANCH` | The base branch. The default is `baseBranch` in `.herdr-boss.json`. |
| `--orch PANE` | The verified caller pane for reports. If set, it must match `HERDR_PANE_ID`. |
| `--no-worktree` | Use the current checkout. The worker gets `.worker/NAME/` for its brief and reports. |
| `--dry-run` | Print the plan. Change nothing. |
| `--force` | Override quota, capacity, and paused-project refusals. It cannot enable a disabled model. |

Worker brief templates support two Herdr command slots:

| Slot | Meaning |
|---|---|
| `herdrEnvPrefix` | The caller's `HERDR_ENV=1` setting and, when known, its `HERDR_SOCKET_PATH`. |
| `herdrBin` | The absolute path in `HERDR_BIN_PATH`, or `herdr` when the path is unknown. |

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget. The default is 10. The project setting overrides the kit default. A failed start ends with `START FAILED: <reason>` after cleanup details.

`worker start` refuses a provider that is ahead of pace, near exhaustion, or exhausted. An exhausted lane shows its window and reset time; when several windows are exhausted, it uses the latest reset. `--force` remains the explicit quota override. Ignore quota mode disables pacing and handover warnings below 100%, but it does not make an exhausted provider usable. When every metered provider is ahead of pace, it allows the least-over one with a notice. A refusal or least-over notice lists the current project's unmetered alternatives first, then names the least-over metered provider. It refuses dispatch when the active CPU limit or enabled load backstop is exceeded. `--force` cannot bypass a machine refusal.

The Pi allow-list holds only `opencode-go/` models. Free `opencode/` models run only in the `opencode` harness. `worker start --kind pi` refuses an `opencode/` model.

Policy may set `preferredModels` by harness; `modelProviders` by allowed model; `extraModels` and `disabledModels` by harness; `harnessRoutes` by harness and model; and `pacingGoals` by provider and window key (`primary`, `secondary`, or `tertiary`). `extraModels` adds local model strings to one harness. The models use that harness's launch arguments and effort rules. `disabledModels` disables a model in one harness. A preferred model must be in that harness's allow-list. `harnessRoutes` takes precedence over `modelProviders` for the same harness and model. A provider route must be `codex`, `claude`, `opencodego`, or `null` for an unmetered model. A `harnessRoutes` route for the `codex` harness must be `codex` or `null`. A route for the `claude` harness must be `claude` or `null`. The `opencode` and `pi` harnesses accept every provider. `policy set` refuses an incompatible route and names the harness, the model, and the permitted choices. The rule also applies to a `modelProviders` route that an available `codex` or `claude` harness inherits without a `harnessRoutes` entry. `policy set` refuses such a policy and names the harness, the model, and the permitted choices. An existing policy with such a route still loads. Herdr Boss keeps the raw value, treats the model as unmetered in that harness, and logs one warning. `policy show` lists these routes in the derived `ignoredRoutes` field. `policy set` does not store that field. `policy set` removes stale references to models that the catalog no longer allows, and repeated entries. It prunes `modelProviders`, `harnessRoutes`, `disabledModels`, `extraModels`, `excludedModels`, `preferredModels`, and project `excludedModels`. An `extraModels` entry that repeats the catalog is removed. `policy set` prints one note that names each removed model and the field that held it. It prints no note when nothing is removed. A malformed value, for example a model string with a shell character or a route to an unknown provider, still fails with an error and stores nothing. A pacing goal is a whole percentage from 0 to 100; an absent goal means 100%. `autoHandoverContextTokens` is an integer from 50000 to 2000000 (default 300000). With `autoHandover` on, it starts a handover at a task boundary when the Claude orchestrator context is above this value. Explicit `--model` and handoff `--model` choices take precedence.

```sh
herdr-boss worker start fix-74 --kind claude --task-file brief.md --allow src/parse/ --issue 74
```

### Other worker commands

| Command | Action |
|---|---|
| `worker list` | Unfinished run records with the live agent status. |
| `worker collect NAME` | Read the worker report, check its changed paths against `--allow`, and report configured stale-artifact warnings. It sets `collectedAt` in the run record only when the worker reported done: the report has `stoppedEarly` other than `true`, or `--record` has `--outcome done`. A collect of a running, stopped-early, failed, or partial worker changes nothing in the run record. The project board then shows the task of the worker as `review` until the branch is merged. |
| `worker collect NAME --record --outcome done\|partial\|failed --gate-passed\|--gate-failed [--defects N] [--rework N] [--model-result first-time\|rework\|failed] [--model-reason TEXT]` | Also append the run to the ledger, record usage, and release the leases of the worker. After success, merge the branch, then prune safe worktrees. |
| `worker park NAME --reason TEXT` | Mark a worker that waits on purpose. Idle notices skip it. |
| `worker unpark NAME` | Clear the park mark. |
| `worker allow NAME PATH... --reason TEXT` | Approve extra paths for a running worker after a `WORKER QUESTION`. |

`worker collect` checks changed paths against the paths in the run record. It ignores the worker's `.worker/` folder. It checks artifacts when a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. It compares the newest matching source file with the oldest matching artifact file. It warns when a source is newer or when sources match but no artifacts do. It prints each warning and includes the warnings in the `artifactWarnings` summary field. A warning does not change the independent gate result. The orchestrator decides whether the gate passed.

With `--record`, the command completes every check before it prints the summary. It uses the ledger and run folder in the main checkout, including when you run it from a worker worktree.

When `report.json` has no `modelOutcome` and you do not set `--model-result`, collection records a result from the outcome. It records `failed` when the outcome or gate failed. It records `rework` when `--rework` is greater than 0. Otherwise, it records `first-time`. Collection prints a warning with the result and recommends `--model-result` next time. An explicit `--model-result` takes precedence.

### `wait [WORKER...]`

```sh
herdr-boss wait [WORKER...] [--timeout SECONDS] [--stall SECONDS]
```

Use `wait` only when you must block on a worker. Normally, end the turn after a dispatch. The worker sends a `WORKER REPORT` or `WORKER QUESTION` message.

`wait` blocks until the first event of any listed worker. With no worker name, it waits on all unfinished workers of this project. It prints one line, `<worker> <reason>`, and exits with the code of the reason. On a timeout, it prints the names of all waited workers, separated by commas.

| Reason | Exit code | Event |
|---|---|---|
| `report` | 0 | `report.json` or `report.md` in the worker folder was written after the worker started. |
| `question` | 10 | A new pane line that holds `herdr agent prompt` and `WORKER QUESTION <name>` appeared after `wait` started. This is a heuristic on the echo of the send command. |
| `blocked` | 11 | The pane agent status is `blocked`. |
| `stalled` | 12 | The pane output did not change for the stall time, and the pane agent status is not `working`. |
| `gone` | 13 | The worker is not in `herdr agent list`, or a pane read reports that the agent does not exist. An unreadable agent list is a failed call. `wait` retries it. |
| `timeout` | 75 | `--timeout` seconds passed with no other event. |

Exit code 75 is also the code of a busy lock in the `lock` commands (`EX_TEMPFAIL`). The meaning depends on the command: for `wait` it means timeout, for `lock acquire` it means lock busy.

When two events occur in the same poll, `wait` reports the first in this order: `report`, `question`, `blocked`, `gone`, `stalled`.

A usage error, an unknown worker name, or a project with no unfinished worker exits with code 2.

The stall time is `--stall SECONDS`. Without it, `wait` uses the dashboard setting `workers.staleIdleMinutes`. Without `--timeout`, `wait` has no time limit. Run it as a background command, because a tool call has its own time limit.

`wait` reads the worker run records and the modification times of the report files. It never opens a report file and never prints report contents. It makes at most one Herdr call per second, and it polls once per second. Each Herdr call has a timeout of 10 seconds, or less when the `--timeout` deadline is nearer, so a hung call cannot hold the wait past `--timeout`. Use `worker collect NAME` to read the report.

### Project locks

| Command | Action |
|---|---|
| `lock acquire NAME [--wait SECONDS]` | Acquire a manual lock. `full-suite` is a machine lock. Other names are locks for this Git repository. Wait up to five seconds when another lock or lease change is in progress. A lock change removes a stale guard that a killed command left. `--wait` accepts a whole number of seconds and waits for a held lock in ticket order. The command shows the queue position. If the wait ends first, it exits with code 75. Code 75 means the lock was busy and no test ran. |
| `lock release NAME` | Release a lock owned by this pane, or a stale lock. Wait up to five seconds when another lock or lease change is in progress. |
| `lock list` | List the locks of this Git repository and the machine locks. Show each lock's age, holder pane, kind, scope, and state. Show the time left for a manual `full-suite` lock. Show each queue position, project, pane, kind, and wait time. |
| `push [ARGS...]` | Run `git push ARGS...`. When a pre-push hook exists, take the `full-suite` lock and set `HERDR_BOSS_SUITE_REUSE=1` for the hook. A hook may run `herdr-boss suite` or `herdr-boss suite --reuse`. If that suite runs, it reuses the push lock. Wait in ticket order for up to 1800 seconds by default. Show the queue position while waiting. If the wait ends first, exit with code 75. Code 75 means the lock was busy and no push ran. If release fails, print a warning. Keep the push exit code, or return 1 if the push succeeded. |
| `suite [--wait SECONDS] [--keep NAME]... [--reuse] -- COMMAND...`<br>`suite --list-passes` | Take and release the `full-suite` lock around `COMMAND...`. If the suite runs in a pre-push hook under `herdr-boss push`, reuse the push lock. Run the command with a clean environment. Save a pass when the command succeeds and the tree is clean before and after it. `--reuse` skips the command and lock when a clean tree has a matching pass. A pass matches only when the repository, tree hash, command, Node version, and the hash of each root lockfile are the same (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, and similar files). A changed lockfile never reuses an old pass. A lockfile that changes during the command prevents a pass record. `--list-passes` prints the last 10 records. Wait in ticket order for 1800 seconds by default. `--wait` accepts a whole number of seconds. Show the queue position while waiting. If the wait ends first, exit with code 75. Code 75 means the lock was busy and no test ran. If release fails, print a warning. Keep the command exit code, or return 1 if the command succeeded. |

Lock names are one path-safe token. Every linked worktree of the same Git repository uses the same locks. The `full-suite` lock is machine-wide: all repositories on this machine share it. Waiters take tickets and get the lock in ticket order. Herdr Boss stores lock records in a private `locks` directory under its data directory. It stores machine locks in `locks/machine/`. Each record names the owner pane, PID, kind, safe acquire command, and acquisition time. A `suite` or `push` lock uses the PID of that command. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual `full-suite` lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock. The engine sends the former holder a warning when it sees the takeover. It also shows the queue under each machine lock in the bulletin. A different pane cannot release an active lock. Herdr Boss fails closed if it cannot confirm pane state.

Each lock acquire and each lock release, also of a re-entrant `suite` under a `push`, adds one line to `lock-ledger.jsonl` in the data directory. A line holds the project, lock name, kind (`suite`, `push`, or `manual`), holder pane, and the tree hash when the checkout is clean. An acquire line adds `waitMs`. A release line adds `holdMs`. A line of a re-entrant suite has `reentrant: true`. A busy acquire adds a `busy` line and a wait that ends first adds a `timeout` line, both with `waitMs`. The file rotates to `lock-ledger.1.jsonl` at 5 MB. The Locks panel of the dashboard shows the median hold and the median wait of the last 7 days. The medians skip re-entrant, busy, timeout, and takeover lines.

Only a verified `orch` or `boss` pane can run `lock acquire`, `lock release`, and `lock list`. For the `full-suite` lock, `lock acquire`, `lock release`, and `suite` also accept a worker pane. A worker pane has a live run record in the runs folder of a checkout of the same Git repository. The record names the caller pane and the caller worktree, and it has no `finishedAt`. Herdr Boss verifies the pane with `herdr pane get`. A worker pane cannot take other lock names. A lock of a worker pane becomes stale when the pane closes.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. There is no load threshold.

Use `herdr-boss suite -- npm test` for a full test suite. The command removes `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET` from the environment of the suite. It also removes each name that ends in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, or `_KEY`, in upper or lower case. It keeps all other names, for example `PATH`, `HOME`, and `TMPDIR`. Use `--keep NAME` to keep one removed name. You can use `--keep` more than once. The command prints the number of removed names. It does not print names or values. It releases the lock also when the suite fails or cannot start.

Herdr Boss stores successful passes in `suite-passes.json` in its data directory. It keeps the last 200 passes. The file has mode `0600`. A pass key uses the Git common directory, the tree hash, the exact command, and the Node version. A dirty tree cannot use or create a pass. A changed file runs the suite again.

In a pre-push hook, run the test command through `herdr-boss suite` or `herdr-boss suite --reuse`. When the suite runs under `herdr-boss push`, it reuses the push lock. `herdr-boss push` also sets `HERDR_BOSS_SUITE_REUSE=1`, so the suite can reuse a matching pass. A Viz hook can use the same commands for its Tier B check.

Use `herdr-boss suite --reuse -- <command>` to request reuse outside a pre-push hook. Use `herdr-boss suite --list-passes` to print the last 10 records. Each row shows the time, repository name, short tree hash, and command.

`herdr-boss push` finds a pre-push hook in two ways. A `pre-push` file exists at `git rev-parse --git-path hooks/pre-push`, which respects `core.hooksPath`. Or a husky or lefthook config names `pre-push`. With a hook, it takes `full-suite`, runs `git push`, and releases the lock also when the push fails. With no hook, it runs `git push` and takes no lock. It prints which case it used. Its exit code is the exit code of `git push`. Only a verified `orch` or `boss` pane can run it.

### `worker allow NAME PATH...`

Approve extra scope after a worker asks a question. Only the verified `orch` or `boss` pane may approve. `worker allow` requires `HERDR_ENV=1` and verifies the caller pane with the same checks as `worker start`.

The paths must be repository-relative and inside the worker worktree. It refuses an absolute path, a parent traversal, a path that resolves outside the repository through a symlink, and every path under `.worker/`. It refuses the whole request when any path is invalid, and it refuses a finished run. A valid approval adds the new paths to the run's allowed paths and appends a history item with the paths, the reason, the time, and the verified caller pane.

`worker collect` uses the approved paths. Its summary and ledger entry include the approval history. A prompt or message alone does not change the approved paths.

Collection records the run before merge. After a successful `--record`, merge the branch, then run `herdr-boss worktree prune --apply` to remove worktrees that pass the safe checks. Collection does not prune worktrees.

`worktree prune` checks the current working directory of processes in every existing worktree it could remove. It also reports parent-PID-1 processes that still use a missing or prunable worktree path. It never removes a worktree while a matching process runs. It blocks all removals when it cannot scan processes. It does not remove dirty, unmerged, primary, live-pane, or uninspectable worktrees.

```sh
herdr-boss worker allow fix-74 docs/parse.md --reason "the fix also needs the parser docs"
```

### Resource leases

| Command | Action |
|---|---|
| `lease acquire POOL [--for SLUG\|WORKER] [--prefer ITEM] [--ttl MINUTES]` | Lease one free item of the pool. Print the item on its own line on standard output. |
| `lease release POOL ITEM` | Release a lease of your project. The Boss can release any lease. |
| `lease list [POOL]` | Print each pool item and its lease as JSON. A free item has `"lease": null`. |

Define the pools in `resourcePools` in `~/.herdr-boss/config.json`. See [Resource leases](user-guide.md#resource-leases) in the user guide.

`lease list` also shows the built-in pool `project-browsers`. `lease acquire` and `lease release` refuse this pool. Use `browser request` and `browser release` for it. No pool leases port 9222.

Only a verified `orch` or `boss` pane, or a worker pane with a live run record, can run `lease acquire` and `lease release`. The worker rule is the same as for the `full-suite` lock.

- Without `--for`, the lease belongs to the project of the current checkout. A worker pane leases for its own worker.
- `--for WORKER` records a live worker of the project of the orchestrator.
- `--for SLUG` records a project. Only the Boss pane can use it.
- `--ttl MINUTES` sets the lease time. The default is `ttlMinutes` of the pool.

`lease acquire` chooses an item in this order:

1. The `--prefer` item, when it is free.
2. A free item in the `split` list of the project.
3. A free item that is in no `split` list.
4. A free item in the `split` list of another project. The lease has `"borrowed": true`.

A borrowed lease stays until it is released or reclaimed. When no item is free, `lease acquire` exits with code 3 and lists the holders on standard error.

```sh
PORT="$(herdr-boss lease acquire serve-ports)"
npm run serve -- --port "$PORT"
herdr-boss lease release serve-ports "$PORT"
```

`worker start --lease POOL` leases one item before it creates the worktree or the pane. It sets the variable `env` of the pool in the worker pane, for example `HERDR_SERVE_PORT=8001`. It records the lease in the run record and in the brief. When the pool has no free item, the start fails with exit code 3 and creates nothing. When the start fails later, it releases the lease. `worker collect NAME --record` releases the leases of the worker.

When a task names `serve:live` and the `serve-ports` pool exists, `worker start` leases one port when needed. It prints that it took the lease. It writes the port to `.worker/port`, one line, and tells the worker to use only that port. With `--no-worktree`, the port file is `.worker/NAME/port`.

## Ledger, checks, and worktrees

| Command | Action |
|---|---|
| `ledger append --entry FILE [--file LEDGER]` | Validate and append one run entry. |
| `ledger check [--runs] [--file LEDGER]` | Validate the ledger. `--runs` also fails for each run record without a ledger entry. |
| `check --report FILE` | Validate a worker report (`report.json`). |
| `check --run FILE` | Validate one ledger entry. |
| `check --worktree DIR --allow PATH...` | Check that the worktree changes only allowed paths. |
| `check agents [FILE]` | Check a project `AGENTS.md` and its kit file for kit drift. `FILE` defaults to `AGENTS.md` at the Git top level of the current directory. The kit file is `docs/orchestration/herdr-boss.md` in the directory of `FILE`. The command also scans the orchestration files in that directory. The command prints one line per finding and a summary line. It exits 0 when there is no `error` finding, and 1 otherwise. |
| `check kit` | List each published project with its `kitRevision`, its `agentsCheck` counts, and the revision state: `current`, `behind (useful only)`, `behind (required)`, or `not published`. A project is `behind (useful only)` when every kit change since its revision has the impact `useful` or `none`. A project is `behind (required)` when one change has the impact `required`, when its revision is not in `kit/CHANGES.md`, or when the current revision has no entry there. Check each `orch` agent against `<slug>-orch` and the `boss` agent against `boss`. Print a command for each wrong name. If the Herdr agent list is unavailable, print a warning and skip the name check. The command exits 1 when a project is `behind (required)` or `not published`, or when an agent name is wrong. A project that is `behind (useful only)` does not fail the check. |
| `kit install [--no-hook]` | Install the kit in the Git top level of the current directory. The command writes the kit file, the `AGENTS.md` stub, and the Claude `SessionStart` hook. It prints `wrote FILE` for each file that it changed and `unchanged FILE` for the other files. `--no-hook` does not change `.claude/settings.json`. |
| `kit update [--quiet]` | Install the kit as `kit install` does, print the kit changes since the installed kit revision, and print the current kit file. `--quiet` prints the digest and the summary line only, and prints nothing when the kit is current and no file changes. |
| `kit block` | Print the marked `AGENTS.md` stub with the current hash. Old instructions use this command. Use `kit install` for a new installation. |
| `worktree prune [--apply]` | List worktrees that pass the safe checks and show processes in removal candidates. `--apply` removes only worktrees with no blocking process. |
| `gh issue create\|comment\|edit ... --body-file FILE` | Run a GitHub issue command. An inline `--body` is refused. |

### Kit file, `AGENTS.md` stub, and drift check

`kit install` writes three files in the project repository:

| File | Content |
|---|---|
| `docs/orchestration/herdr-boss.md` | The kit file. The body is `kit/templates/project-kit.md`. Only Herdr Boss writes this file. |
| `AGENTS.md` | The stub between the markers. The stub body is `kit/templates/agents-stub.md`. |
| `.claude/settings.json` | A Claude `SessionStart` hook that runs `herdr-boss kit update --quiet`, then prints the kit file and `docs/orchestration/memory.md`. |

The revision covers `kit/templates/`, `kit/skills/herdr-orchestrator/SKILL.md`, its reference files, and `kit/models.json`. It does not change when service, dashboard, or website files change.

The kit file has this form:

```
<!-- herdr-boss kit v=<revision> -->
Herdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.

<kit body>
```

The stub in `AGENTS.md` has this form:

```
<!-- herdr-boss:begin v=<hash> -->
<stub body>
<!-- herdr-boss:end -->
```

`<revision>` is the first 12 hex characters of the SHA-256 of the kit body. `<hash>` is the same value for the stub body. Both values ignore CRLF line endings and trailing whitespace.

`kit install` replaces the text between the markers, also an old full kit block. When `AGENTS.md` has no markers, the command puts the stub after the first heading. When `AGENTS.md` does not exist, the command creates it. The command refuses a file with more than one block or an incomplete block.

`kit install` merges the hook into `.claude/settings.json` and keeps all other keys and hooks. It adds the hook one time. It replaces an older Herdr Boss hook, which it finds by the text `cat docs/orchestration/herdr-boss.md` in the command. It creates the file when it does not exist. It refuses a file that is not valid JSON. Codex has no equivalent hook.

`kit install` computes all files before it writes. An error writes no file. It writes a file only when the content of that file changes. A run on a current project changes no file and no modification time.

A changed kit file, `AGENTS.md`, or `.claude/settings.json` is an ordinary edit in the working tree. Commit it with the next orchestrator commit. Do not make a separate commit for it.

The hook prints the digest of `kit update --quiet` before the kit file. On a current project the command prints nothing. A failed or missing `herdr-boss` command does not fail the hook. The hook still prints the kit file and the memory file.

`worker start`, `publish`, and `handoff plan|prepare` check the kit revision of the project in the Git top level. When the project kit is behind for at least one `required` or `useful` change, the command prints one line: `Kit update: this project kit is behind by N required and M useful change(s). Run herdr-boss kit update.` `worker start` prints the line to standard output. `publish` and `handoff` print it to standard error. The command prints nothing when the kit is current, when the project has no kit file, or when all changes have the impact `none`.

`kit update` computes its digest from the installed revision before it writes any file. The digest names the impact and the summary of every kit change after the installed revision, oldest first. The installed revision is the version line of the kit file of the project. When the change log does not know that revision, the digest lists every known change and says that the revision is unknown. With no change the digest is one line. `kit update` installs in all cases. Without `--quiet` it prints the digest, the `wrote FILE` and `unchanged FILE` lines, the current kit file, and the final `kit update: kit revision ...` line. Run it after a `Kit updated` notice. The printed kit file replaces the stale copy in the session. With `--quiet` the command prints the digest and the final line only when a kit change exists or a file changed. Otherwise it prints nothing.

`check agents` prints each finding in `AGENTS.md` or the kit file as `LEVEL line N: message`. `LEVEL` is `error` or `warn`.

`check agents` also scans these orchestration files in the directory of `AGENTS.md`, usually the Git top level:

- `docs/agents/**/*.md`
- `.orchestration/*.md`
- `.orchestration/**/*handoff*.md`
- a top-level file whose name matches `*Orchestrator*.md` or `*orchestrator*.md`

The command does not scan `docs/orchestration/memory.md` or `docs/orchestration/herdr-boss.md`. The command does not follow symbolic links.

The command skips these orchestration files:

- a file that matches a glob in `checkAgents.exclude` in `.herdr-boss.json`
- a file below `.orchestration/state/`
- a file whose first line is exactly `<!-- herdr-boss: data -->`

A script that appends lines to a log writes a data file. Put the data marker on the first line of each data file. The summary line gives the count of skipped files, for example `AGENTS.md: 0 errors, 2 warnings; 3 files skipped`. The command does not name the skipped files. An invalid `checkAgents.exclude` value is an `error` finding for `.herdr-boss.json`. The command then scans all files.

A finding in an orchestration file is always a `warn` finding. The command prints it as `warn FILE line N: message`. `FILE` is the path relative to the directory of `AGENTS.md`. The `warn` findings in the table below that apply outside the stub also apply to all lines of an orchestration file.

A file whose name contains `handoff` is a handoff note. A handoff note carries no rules. Each line of a handoff note that starts with `Always`, `Never`, `Do not`, or `Must` is a `warn` finding. Move the rule to `AGENTS.md` or `docs/orchestration/memory.md`.

| Level | Finding |
|---|---|
| `error` | `docs/orchestration/herdr-boss.md` does not exist, has no version line, or has an old revision. Run `herdr-boss kit install`. |
| `error` | The kit file body does not match its version line. The file was edited by hand. Run `herdr-boss kit install`. |
| `error` | `AGENTS.md` has no stub, no begin marker, no end marker, or more than one block. |
| `error` | An old full kit block is between the markers. Run `herdr-boss kit install`. |
| `error` | The stub hash is not the current hash, or the stub body does not match its own hash. Run `herdr-boss kit install`. |
| `warn` | Outside the stub: `herdr agent start`, `herdr pane split`, or `dashboard:update`. |
| `warn` | Outside the stub: port `9222`, or `pgrep -f`, `ps aux`, or `ps -ef` in a command. A line with `do not`, `don't`, or `never` is a safety rule and is not a finding. |
| `warn` | Outside the stub: a fixed pane ID such as `w1:p2`, or a dated line. Move it to `docs/orchestration/memory.md`. A dated line has a date such as `2026-09-20` or a day and a month name such as `26 Sept`. |
| `warn` | Outside the stub: a line that routes a decision, a push, a release, or a product question to the Boss, the Owner, a human, or the user. The line has an ask verb: `ask`, `escalate`, `send`, `report`, `route`, `get approval`, or `wait for`. It also has a target: `the Owner`, `the Boss`, `a human`, or `the user`. `Owner approval` and `Boss approval` also route a decision. A line that only starts with `Decide`, `Push`, or `Release` is not a finding. A line with `do not`, `don't`, `never`, `yourself`, or `nobody` is not a finding. |
| `warn` | Outside the stub: an instruction to notify, tell, message, inform, or prompt another project. |
| `warn` | A model ID that starts with `gpt-`, `claude-`, `opencode/`, `opencode-go/`, `deepseek`, or `muse-spark` and is not in the merged model list. The merged list is the same list that `herdr-boss models` shows. |
| `warn` | Outside the stub: three or more allowed model IDs. This is a copied model list. Use `herdr-boss models` and `herdr-boss lanes`. |

`publish` and `worker start` run the same check on the project `AGENTS.md` and the orchestration files. `publish` stores the counts in `agentsCheck.errors` and `agentsCheck.warnings`. The findings in the orchestration files count as warnings. `worker start` prints one warning line with the counts when there are findings. It starts the worker in all cases.

An unknown tool-call count stays `null`. The ledger accepts `null` as unknown. If an older kit reports a ledger entry with `null` as invalid, install a HerdrBoss kit version that accepts `null`, then run `herdr-boss ledger check` again. This check reads the ledger. Do not replace `null` with `0` or edit the ledger entry.

## Browsers

`herdr-boss browser` is a thin helper for visual checks of a project page. It is not a Playwright or agent-browser replacement. Do not add general page automation or scripting to it.

Each project has one persistent Chrome profile on a port from 9223 to 9299. The port is a lease in the built-in pool `project-browsers`. See [Port leases](user-guide.md#port-leases). Add `--tab ID` to page commands when the browser has several tabs; `browser tabs` lists the IDs.

Herdr Boss decides browser ownership by the Herdr workspace. Any pane in a project's workspace can change that project's browser, also an unlabeled pane and a worker. The Boss pane and every pane in the Boss workspace can change any project browser. This rule covers browser requests, size changes, close, release, restart, tab changes, page navigation and input, and bookmark changes. A refusal names the pane's workspace and the browser's project. A plain terminal outside Herdr skips the check with a warning.

| Command | Action |
|---|---|
| `browser request SLUG [--headless\|--visible] [--reserve]` | Launch the project browser. From a Herdr pane, request the browser of your workspace's project, or use the Boss. `--reserve` assigns the port and profile only. |
| `browser list` | All project browsers, ports, profiles, and state. |
| `browser restart SLUG --headless\|--visible [--no-restore]` | Close and relaunch in the other mode. The current page reopens unless `--no-restore`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser close SLUG` | Close the browser. The profile and the port lease stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser release SLUG` | Remove the port lease of the project. Refuses while the project Chrome runs. The record and the profile stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser size SLUG WIDTH HEIGHT` | Window size for the next launch (320–3840 × 240–2160). From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile]` | Set one tab's real window size. Width is 200–3840, height is 150–2160, and scale is 0.5–4. Scale defaults to 1. The command resizes the tab's own window, so every CDP client sees the size. It falls back to device metrics emulation when a window resize is not possible, and it says so. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID --reset` | Restore the window to the launch size and clear any device metrics emulation. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tabs SLUG` | Tabs with ID, title, URL, visibility, and whether an agent is attached. |
| `browser tab new SLUG [URL]` | Open a tab in its own background window. Prints the ID. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tab close SLUG --tab ID [--force]` | Close a tab. Refuses a tab an agent is attached to unless `--force`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser screenshot SLUG [--tab ID] [--out DIR]` | Save a private JPEG and print its path. Use `$TMPDIR` by default, or select a directory with `--out DIR`. |
| `browser navigate SLUG URL [--tab ID]` | Open an `http` or `https` page. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser click SLUG X% Y% [--tab ID]` | Click at a position relative to the screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser hover SLUG X% Y% [--tab ID]` | Move the mouse to a position relative to the screenshot, with no press, so a hover state or a tooltip shows for the next screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser drag SLUG X1% Y1% X2% Y2% [--tab ID] [--steps N]` | Press at the first position, move to the second, and release. `N` is the number of moves. `N` is 1 to 60 and defaults to 10. The command does not move HTML5 files. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser text SLUG --stdin [--tab ID]` | Type text from standard input. The text is not echoed. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser key SLUG KEY [--tab ID]` | Send `Tab`, `Enter`, `Backspace`, `Delete`, `Escape`, `Home`, `End`, an arrow key, or `SelectAll`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG list` | List the bookmarks and the start page of the project. |
| `browser bookmarks SLUG add NAME URL` | Add one bookmark. The name has at most 60 characters. The URL must use `http` or `https` and must not hold a user name or a password. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG rm INDEX` | Remove the bookmark at `INDEX`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG open INDEX [--new-tab]` | Open the bookmark in the current tab, or in a new tab with `--new-tab`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG start URL\|none` | Set the start page of the next launch, or clear it with `none`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser sweep-clones [--dry-run]` | Delete orphaned Chrome code-sign clones now. Prints the count and the freed GiB. `--dry-run` lists each clone by name and age and deletes nothing. |

```sh
id=$(herdr-boss browser tab new tmprocessmining | jq -r .id)
herdr-boss browser navigate tmprocessmining https://example.com --tab "$id"
herdr-boss browser screenshot tmprocessmining --tab "$id"
```

The screenshot command writes under `$TMPDIR` when it is set. Otherwise, it creates a safe temporary directory. Pass `--out DIR` to choose an output directory. This option overrides `$TMPDIR` and can be used with `--tab`.

The viewport command sets the real window size, so every CDP client sees it. It falls back to emulation and says so. Headless Chrome keeps a window at least 500 px wide. For a narrower size, the command uses emulation, which only herdr-boss sessions see. The size stays active until you run `browser viewport SLUG --tab ID --reset`, close the tab, or restart the browser. `browser screenshot` captures the page at that size. The `browser size` command sets the window size for the next launch.

A project keeps at most 30 bookmarks. A bookmark URL must use `http` or `https` and must not hold a user name or a password. The start page opens in the first tab of the next launch. The bookmarks and the start page stay in the project record in `browser-sessions.json`.

## Orchestrator handover

| Command | Action |
|---|---|
| `handoff plan PANE --to KIND [--model M] [--effort E] [--mode migrate\|fresh]` | Check the target and whether session migration is available. Changes nothing. |
| `handoff prepare PANE --to KIND [...]` | Start a successor in a new `Orchestrator Next` tab. The source keeps control. |
| `handoff activate ID --confirmed` | Label a project successor `orch` and name its agent `<slug>-orch`. Label a Boss successor `boss` and name its agent `boss`. Clear the new name from the source agent first when it uses that name. Label the source pane `orch previous` or `boss previous`. A failed agent rename keeps activation active and prints a command to run by hand. A project handover notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner. If Herdr reports `pane_not_found` for the source pane, activation skips the source label and the source prompt. The successor prompt says that the source pane was closed before activation. |
| `handoff ready ID` | Sent by an automatic successor when it is ready. |
| `handoff list` | All handover records. Status can be `preparing`, `prepared`, `needs-inspection`, `active`, `superseded`, or `expired`. |

`--mode migrate` (the default) converts the session with `session-migrate`. If migration is unavailable or transfer fails, preparation uses fresh mode and records the reason. `--mode fresh` starts the successor without a migrated session. `--force` allows a target provider near exhaustion.

`handoff plan` reports when Claude session migration is unavailable because the active graph has an ancestry cycle. `handoff prepare` then uses fresh mode automatically.

`handoff plan` measures the migrated session before it reports migration as available. After a successful dry run, it runs the same transfer with `--home` set to a new temporary directory under the system temporary directory. It adds the byte sizes of the `.jsonl` files in that directory and then deletes the directory. The estimate is one token for each 4 bytes, rounded up. The migrated session fits when the estimate is at most 60% of the target window. `migration.fit` records `bytes`, `estimatedTokens`, `contextTokens`, `limitTokens`, `fits`, and `sizeKnown`. When the session does not fit, the plan sets `migration.available` to `false` with this error: `Migrated session is too large for the target window: about N tokens against a limit of M.` `handoff prepare` then uses fresh mode and records the same text in `migrationFallbackReason`. The successor prompt at activation includes that reason.

A live source session can change while `session-migrate` reads it. A failed measuring transfer therefore runs one more time. If the second attempt also fails, `migration.fit.sizeKnown` is `false`. Migration stays available, and `migration.warning` says that the size is unknown. Migration also stays available with a warning when the target model has no window in `kit/models.json`.

The target window comes from `kit/models.json`. The optional `contextTokens` field of a kind gives the window in tokens. The optional `contextTokensByModel` object of a kind gives the window for one model and overrides `contextTokens`. Each value must be a positive integer. `claude` and `codex` set `contextTokens` to `200000`.

After activation, the engine finishes the handover on each tick. The successor is confirmed when it works and then settles (it answered the activation prompt), or when 15 minutes pass with the old pane `idle` or `done`. After confirmation, Herdr Boss closes the old pane when it has been `idle` or `done` for 60 seconds. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. Herdr Boss never closes an old pane that works, is blocked, or has been settled for less than 60 seconds. It also keeps the old pane open while the allocation of the previous tick reports a running worker for the project. It renames only the live tab of the successor pane, never a recorded tab id. It merges the `finish` fields into the current `handoffs.json`, so a concurrent CLI write stays. A Boss record gets no `finish` object: the Owner closes the old Boss pane and keeps the tab name by hand, and Herdr Boss closes no unused Boss successor. It retries on each tick. If the old pane is still busy 60 minutes after activation, Herdr Boss sends one line to the pane labeled `boss`. The record field `finish` holds `plannedAt`, `workedAt`, `confirmedAt`, `confirmedBy` (`answered` or `timeout`), `closedAt`, `tabRenamedAt`, and `doneAt`. A successor that expires without activation, or that another successor replaces for the same source, keeps its tab until the next tick. Herdr Boss then closes that tab, or the pane when the tab holds other panes. It never closes a labeled pane. If the early close did not run, Herdr Boss closes the old pane after 120 minutes when the current pane list confirms both pane roles. A later handover can mark the record as superseded. The old pane stays eligible for retirement, and Herdr Boss follows the successor chain to the current active pane. Unavailable pane data defers retirement to a later engine tick. The current successor receives one retirement notice.

Preparation copies the optional top-level `goal` from the latest published project status into `ownerGoal` in the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. A Boss handoff has no project goal. Preparation also stores the goal on the record as `goal`, with `goalSource` set to `status`, `transcript`, or `default`: the published goal, else the last `/goal` command in the tail of the source session transcript, else the `defaultOrchestratorGoal` policy field (orchestrators only). The goal has at most 4000 characters and no control characters. After activation, the engine sends `/goal <text>` to a Claude successor once when it answers, marks `goalSentAt`, and checks the pane text twice. A successor of another harness gets the goal in the activation prompt. The successor reads `AGENTS.md`, the current Herdr Boss bulletin, and the applicable memory file: `docs/orchestration/memory.md` for a project, or `~/.herdr-boss/boss-memory.md` for the Boss. The successor reports if that file is missing. Fresh preparation reads at most 200 recent lines and stores at most 20,000 characters of redacted source-pane text. Both caps include the truncation marker. If the recent read fails, it tries the visible pane. If both reads fail, it records that context is unavailable. The successor prompt marks the snapshot as historical context. The successor only reads and reports until activation.

`handoff prepare` waits up to 90 seconds for the new pane's foreground shell and a prompt or a stable screen before it starts the agent. Ordinary `worker start` keeps its 20-second readiness wait. If agent start reports `agent_pane_busy`, handoff checks shell readiness again and retries once. It stops at an interactive question and tells you to answer it in a shell once, then retry `handoff prepare`. The new tab disables update prompts and automatic updates. Each active engine tick expires `prepared`, `preparing`, and `needs-inspection` records only when a successful current pane list does not contain their successor pane. `handoff prepare` repeats this check before retrying. A failed pane list keeps those records active. Herdr Boss does not close a pane when it expires a record.

When the target kind is `codex`, `handoff prepare` adds one `-c shell_environment_policy.set.NAME="VALUE"` pair to the agent launch arguments for each known value. A migrated session gets the same pairs after its resume arguments. The names are `HERDR_ENV` with the value `1`, and `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` of the successor pane. `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, and `TMPDIR` come from the environment of the caller. The command leaves out each unknown or empty value. A Codex tool shell can run under a shared app-server daemon with a different environment. These pairs let the successor run Herdr commands. The other target kinds get no pairs. If a caller value has a quote, a backslash, or a control character, `handoff prepare` stops before it creates a tab or a record. The error names the variable and does not show its value.

`handoff prepare`, `handoff activate`, and `handoff ready` write to the Herdr Boss data directory. Each command first creates and deletes a probe file in that directory. A sandbox can refuse this write. The command then stops before it calls Herdr or changes a record. It exits with code 77 and prints this message:

```text
Herdr Boss cannot write to <dir> (<code>). A sandbox blocks this write. Run the same command again outside the sandbox (an escalated run).
```

`<code>` is `EPERM`, `EACCES`, or `EROFS`. Run the same command again outside the sandbox. Every other command prints the same message and exits with code 77 when one of these errors occurs on a path in the data directory.

Herdr Boss derives a Herdr-safe agent name from each handoff record ID. Use the record ID with `handoff ready` and `handoff activate`.

If a `needs-inspection` record still has a pane in the current Herdr pane list, repeat `handoff prepare` for the same source pane, target kind, and mode. It waits for readiness and starts the successor in that pane. It keeps the existing handoff record and pane. If the pane does not become ready, the record stays `needs-inspection` and the command reports the readiness error. If a successful current pane list proves that the pane is absent, the record expires and prepare can create a new successor.

## Project settings (`.herdr-boss.json`)

| Key | Default | Meaning |
|---|---|---|
| `slug` | directory name, lower case | The project slug for status and policy. |
| `baseBranch` | `main` | The base for new worker branches. |
| `worktreeRoot` | `~/Projects/.herdr-wt` | The parent folder of the worker worktrees. A leading `~` is the home folder. A relative path is relative to the repository. |
| `worktreeName` | `{repo}/{name}` | The worktree path inside `worktreeRoot`. `{repo}` is the repository folder name. `{name}` is the worker name. Set `worktreeRoot` to `..` and `worktreeName` to `{repo}-wt-{name}` for sibling folders. |
| `evidenceTiers` | `unit, integration, local-browser, hosted, owner` | The tiers that reports and the ledger accept. |
| `ledger` | `.orchestration/delegated-runs.jsonl` | The run ledger. |
| `runsDir` | `.orchestration/runs` | Run records. |
| `briefTemplate` | kit template | A project brief template. |
| `allowedModels` | all | Limit the models this project may use. |
| `setup` | none | A shell command that runs in each new worktree before the agent starts, for example `npm ci --prefer-offline`. |
| `setupTimeoutSeconds` | `900` | The time limit for `setup`. |
| `agentStartTimeoutMs` | `90000` | The time limit for `herdr agent start`, from 1 to 300000 milliseconds. |
| `testThreadsFlag` | none | The flag that limits the test runner to two threads. It goes into every brief. |
| `artifactChecks` | `[]` | Generated artifact and source globs to check during worker collection. |
| `checkAgents.exclude` | none | Orchestration file globs that `check agents` skips. |

Each `artifactChecks` rule has `artifacts` and `sources` repository-relative POSIX globs. `*` matches within one path segment. `**` matches zero or more path segments. Herdr Boss rejects absolute paths, parent traversal, backslashes, empty patterns, and malformed rules.

`checkAgents` is an object with one key, `exclude`. `exclude` is a list of repository-relative POSIX globs, for example `{ "checkAgents": { "exclude": [".orchestration/tenant-*.md"] } }`. The globs have the same rules as `artifactChecks`.
