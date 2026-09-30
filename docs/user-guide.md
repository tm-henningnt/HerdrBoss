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

A read-only preview binds `127.0.0.1` and accepts loopback requests only. The option `--host <address>` sets another bind address. Use it only with `--read-only-preview`. The main service is not affected: it keeps the configured `host`. It has no login page. It never reads, creates, or changes token or session files.

Put seed data only into a temporary data directory. Never write seed data or test data into `~/.herdr-boss`. Run the preview with `--read-only-preview` on its own port. `scripts/seed-preview.js` writes invented Mailbox and Chat messages into `HERDR_BOSS_DIR`. It refuses the live data directory, a directory inside it, and a symlink to it, with the message `Refusing to write test data into the live data dir.` Each seed or fixture helper calls `assertTempDataDir(dir)` from `src/data-dir-guard.js` before it writes. `openMessageStore` takes an options object such as `{ dir }`. It throws a `TypeError` for a string.

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

## New project setup

The command `herdr-boss project new` builds a new project in steps. See `docs/cli.md`, section New project flow.

With `--remote gh`, the step `remote` asks you before it creates a GitHub repository. The question is a decide item in the Mailbox. The default is a private repository. A public repository needs `--visibility public` and an answer that contains the word `public`. The command exits with code 3 and waits. Answer the item, then run the same command with `--resume`. The step never pushes.

The steps `policy`, `register`, and `status` put the new project into Herdr Boss:

1. `policy` gives the project a share of 10 percent. The other projects give up part of their share, so the total stays at most 100. Each project keeps its mode and its exclusions. You see the shares before and after the change.
2. `register` records the project folder in `project-repos.json`. The dashboard and the engine then read the repository of the project.
3. `status` publishes the first status. It holds one task, `Set up the project`. The project appears on the dashboard with this task.

The step `workspace` starts the first orchestrator. It runs only when you give `--start`, because the orchestrator uses model quota:

1. `workspace` creates a Herdr workspace with the label of the slug. The root pane gets the label `orch`.
2. The step starts the agent `<slug>-orch`. It uses `--kind` when you give it. Otherwise it uses the first usable entry of the orchestrator ladder in Settings.
3. The step gives the agent your goal, or the **Default orchestrator goal** from Settings. A Claude agent gets `/goal`. A Codex agent gets the goal in the first prompt.
4. The step sends the first prompt. The agent reads `AGENTS.md`, the project memory, and the kit file. Then it starts the task `Set up the project`.

The step `harness` prepares the machine for the project:

1. It adds the project to the Codex `writable_roots`. It writes a backup of the Codex config first.
2. It prints the Claude autoMode lines that are missing. Add them to `~/.claude/settings.json` yourself. Herdr Boss never edits that file. The step detail says `needs Owner action` when a line is missing.
3. It reserves a browser port for the project. It starts no browser.

Run the command again with `--resume --start` after a failure. The run uses the workspace and the pane that it created. It sends no message twice.

Run `herdr-boss project check <slug>` at any time. It reads the project and prints `ok` or `missing:` for each part: the folder, `AGENTS.md`, the kit, the first commit, the remote, the policy entry, the registration, the status, the workspace, the Codex roots, and the browser reservation. It changes nothing. Each missing part names a fix. Run `herdr-boss project check <slug> --fix STEP` to run that one step again. The command then prints the check again. The exit code is 0 when all parts are present and 4 when a part is missing.

Each step changes nothing when its result already exists. A run that stops at a failed step continues at that step on the next run. After the change, check the shares on the Allocation page.

### New project wizard

The Projects page has the button **New project**. The button opens a panel on a wide screen and a full-screen sheet on a phone. The panel shows one step at a time.

1. **Name.** Enter the slug. Enter a name if it must differ from the slug.
2. **Folder.** Enter a group folder or an exact path. Herdr Boss has no default folder.
3. **Remote.** Choose a new GitHub repository, no remote, or an existing URL. The default is a private GitHub repository. A public repository shows a warning line.
4. **Orchestrator.** Choose the kind, enter an optional goal of at most 1000 characters, and set the tick box **Start the orchestrator**. The tick box is on by default.
5. **Review.** The panel calls the plan route and lists the steps that the run will do. It also lists each error. Select **Create project** to start the run.

Press Enter to go to the next step. Press Escape to close the panel. The panel asks first when the form has content.

The wizard never creates a repository. For a GitHub remote, the flow posts a decision item to the Mailbox and waits. The progress view then shows **waiting for your decision** and a link to the Mailbox item. Answer the item, then select **Resume**.

The progress view reads the status route every 2 seconds. It stops when the run is done, failed, waiting, or interrupted. It also stops on a sign-in error (401) or a refusal (403). After a network error it retries after 2, 4, and 8 seconds. After 10 failures in a row it stops and shows **Resume** and **Check**. Each step shows its state and its detail. **Resume** continues the run. **Check** shows the project check.

The browser saves the form in local storage. The saved draft holds no repository URL. Select **Start a new form** in the progress view to clear the draft.

The read-only preview does not allow a new project. The panel shows a message in place of the form.

### Project setup API

The dashboard wizard uses these routes. They run the same flow as `herdr-boss project new`. There is no second implementation.

The routes are for the Owner. They sit behind the dashboard access control: a loopback request needs no login, and any other address needs the token. The server has no way to tell the Owner from the Boss or a worker on a loopback request. Do not give the dashboard token to an agent.

The read-only preview refuses every route with the message `This read-only preview does not allow changes.` This includes the GET routes, because they show local paths.

- `POST /api/project-new/plan` runs the dry run. The body has `slug`, `name`, `group` or `path`, `remote`, `visibility`, `org`, `kind`, `goal`, and `start`. The response lists each step with a `would ...` text and gives the resolved `path`. The route writes nothing.
- `POST /api/project-new` starts the flow with the same body. The flow runs in a separate process, so the dashboard stays responsive. The response is `202` with the `slug`, the `state` `running`, and the `url` of the status route. The flow sends the first prompt to the model only when the body has `start: true`.
- `GET /api/project-new/<slug>` returns the status. The field `state` is `running`, `waiting`, `failed`, `interrupted`, `done`, or `idle`. Each step has a `name`, a `status`, and a `detail`. The field `exitCode` is `null` while the flow runs, `0` when it is done, `1` when a step failed, `1` also when the run was interrupted, and `3` when it waits for an Owner decision.
- `POST /api/project-new/<slug>/resume` continues the flow at the first step that is not finished. The body can be empty. It can set `remote`, `visibility`, `org`, `kind`, and `start`. Any value that the body leaves out comes from the first request.
- `GET /api/project-new/<slug>/check` returns the read-only project check: `ok` and a list of items with `name`, `ok`, and `detail`.

A flow with `remote: gh` waits at the step `remote`. The status then has `state: waiting` and `waiting: { reason: "waiting for an Owner decision", item: <message id> }`. Answer the decide item in the Mailbox. Then call the resume route.

The routes refuse a request with these status codes:

- `400`: the body is not a JSON object, the content type is not `application/json`, a field is unknown or has the wrong type, or the flow module refuses the inputs. A remote URL with a credential is refused.
- `403`: the preview refuses the request.
- `404`: the slug has no flow state, or the route does not exist.
- `405`: the method does not fit the route.
- `409`: a run of the same slug is running.
- `500`: an unexpected error. The message has no credential and no absolute path, and the server logs the error.
- `413`: the body is larger than 16 KB.
- `429`: 2 runs already run. Try again when one ends.

A run writes the marker file `flows/<slug>.running` and removes it when the run ends. After a restart of the service, a marker without a running flow gives the state `interrupted`. Call the resume route to continue. The server keeps the 20 newest finished runs in memory. The state file answers for older runs.

A response never holds a token, and never holds an absolute path outside the project path of the request. A path outside the project appears as `<path>`. A crash of the flow process sets the first unfinished step to `failed` in the state file `flows/<slug>.json`.

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

Herdr Boss keeps the shared orchestration rules in a kit file in each project repository: `docs/orchestration/herdr-boss.md`. Only Herdr Boss writes this file. Its first line is `<!-- herdr-boss kit v=<revision> -->`. The revision is the first 12 hex characters of the SHA-256 of the relative file names and contents in `kit/templates/`, `kit/skills/herdr-orchestrator/SKILL.md`, its reference files, and `kit/models.json`. Service, dashboard, and website changes do not change this revision. The project `AGENTS.md` holds a short stub between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The stub tells the orchestrator to read the kit file and `docs/orchestration/memory.md` at start and at resume. `herdr-boss kit install` writes the kit file and the stub. `herdr-boss kit update` runs the same install, prints the kit changes since the installed kit revision, and prints the current kit file. The digest names the impact and the summary of each change, oldest first. It reads the installed revision from the version line of the project kit file. When the change log does not know that revision, the digest lists every known change. `--quiet` prints the digest and the summary line only, and prints nothing when the kit is current and no file changes. The install writes a file only when its content changes, so a session start on a current project changes no file. Commit a changed kit file, stub, or hook with the next orchestrator commit. Do not make a separate commit. The command always installs, also when the digest has no change. It also adds a Claude `SessionStart` hook to `.claude/settings.json`. At each session start the hook runs `herdr-boss kit update --quiet`, then prints both files. `herdr-boss worker start`, `herdr-boss publish`, and `herdr-boss handoff plan|prepare` print one line when the project kit is behind for a `required` or `useful` change. The line tells the orchestrator to run `herdr-boss kit update`. `herdr-boss check agents` finds a missing, old, or hand-edited kit file or stub. It also finds stale orchestration text outside the stub, such as fixed pane IDs, dated lines, copied model lists, and text that sends pushes or product decisions to the Boss. `herdr-boss publish` and `herdr-boss worker start` run the same check and warn. The project page shows the counts from the last `publish`. The orchestrator publishes the kit revision that it loaded as `kitRevision`. The project page shows that revision and the current revision, and a warning when they are different. The kit file also holds the working rules for context and cost. An orchestrator uses subagents for diff reviews, long report reads, log searches, and code surveys, and keeps the main thread for decisions. It takes back only findings with file and line evidence and verifies a finding at the source before it acts. It uses a cheaper subagent model where the task allows, and Opus only for hard judgment. After a dispatch the orchestrator ends its turn and waits for the `WORKER REPORT` message. The service warns about a stall, a block, and a missing report. As a backup only, the orchestrator runs at most one check every 20 to 30 minutes while a worker runs with no report. The check is `herdr-boss worker list` and the pane status line. Each worker brief tells the worker to report back through Herdr when done and to send a `WORKER QUESTION` when blocked. `herdr-boss check kit` lists the loaded revision and the state of each project: `current`, `behind (useful only)`, `behind (required)`, or `not published`. Only `behind (required)` and `not published` fail the check. The project page shows a project that is `behind (useful only)` as a muted line. It shows a warning for `behind (required)`. A revision that `kit/CHANGES.md` does not list counts as `behind (required)`. The bulletin shows the current kit revision in its header. The commands are in [cli.md](cli.md).

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
| A window has a use of at least the minimum use, and its use is more than the pace tolerance above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |
| A parent-PID-1 process has its current working directory in a missing worktree | Notice that project's `orch` workspace. Do not notify the Boss workspace. |
| A non-orchestrator worker stays blocked for more than 5 minutes | Notice its project orchestrator with the worker name and pane ID. |
| A worker pane with an unfinished run stays idle or done for 10 minutes without `.worker/report.json` in its worktree | One warning to its project orchestrator for that idle period. |
| An `orch` pane stays `idle` or `done` for the configured idle minutes while its published status has an actionable task | Notice that project with the task ID and title. When the project has a free effective slot, name the first lane from **Use now**. |
| The service starts, and the checked-out branch has new commits that change `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md`, and at least one of those changes has impact `required` | One `Kit updated` digest to each project orchestrator, at most once in `machine.kitDigestMinutes` minutes, with the kit revision and the subjects of the required changes that the pane has not received, newest first. Do not notify the Boss workspace or a project that is paused, held, or stood down. |
| A worker is working, first appears idle or done, or changes into either state | Herdr Boss reads only the last 8 visible pane lines. A known provider error marks the worker failed and sends the orchestrator its name, pane ID, and fixed error label. |
| A worker writes `.worker/report.json` or `.worker/<name>/report.json` after its pane first appears, and its pane shows no `herdr agent prompt` command with `WORKER REPORT <name>` within 2 minutes | One notice per report file path. A rewrite of the same file sends no new notice. A worker that sends its `WORKER REPORT` prompt causes no notice. |
| A managed project browser starts and responds | `browser is ready` notice in the bulletin only. |
| A published project status is stale: it is old while workers ran or commits landed, or an active worker runs a task that is not `doing` | One `info` notice to that project's `orch` pane for each stale status. The bulletin shows `Status stale since <time>.` in the project section. See [Live task state](#live-task-state). |

The no-report watchdog starts its timer when a worker first appears idle or done. A change between these two states does not reset the timer. The warning goes to that project's `orch` pane. Herdr Boss sends it once in the idle period. A working pane resets the period. An existing `report.json` prevents the warning.

The failure labels are `API Error`, `401`, `429`, `Connection lost`, `usage limit`, `rate limit`, `overloaded`, and `Free usage exceeded`. Matching ignores letter case and ignores each line whose trimmed text starts with `Tip:`. The matcher requires error forms for `401` (`401 Unauthorized`, `HTTP 401`, or `status 401`) and `usage limit` (`usage limit reached`, `usage limit exceeded`, or `hit your usage limit`). Herdr Boss stores and sends only the matched label and a parsed retry time. It does not store or forward pane output. Herdr Boss reads a working pane on every engine tick, so a failure is found while the worker still works. A matched worker shows the failed status in the snapshot even when Herdr reports it working. The engine then does not count it as running, so its slot becomes free. A failure found in a working pane clears when a later read shows no known failure. A failure found on an idle or done pane clears when that pane starts working and a later read shows no known failure. Any failed status clears when a different worker uses the pane. A later failure creates a new notice. A valid free-usage retry time exhausts the matching unmetered model until that time. The unmetered lane lists it separately from available models. A `Free usage exceeded` failure of an `opencode` worker with an unmetered model also exhausts the whole `opencode` free lane. This closes every unmetered model of the `opencode` harness. The lane uses the parsed retry time. Without a parsed retry time, the lane closes for 1 hour after the failure, and the lane shows that the reset time is unknown. A later absolute retry time in the same pane extends the exhaustion to that time. Herdr Boss measures a relative retry time from the first observation of the failure.

An idle-orchestrator nudge reads the published project status file. Herdr Boss sends it only when the project mode is `auto` or `active`. It skips the `idle` and `paused` modes and the Boss workspace. The `orch` pane must be `idle` or `done` for at least the configured idle minutes. No other worker in that workspace may be `working`, `blocked`, or `failed`.

A task is actionable when its status is `todo`, `doing`, or `review` and every ID in its `blockedBy` list is `done` in the same project. An unknown blocker stays unresolved. A task with status `blocked` is never actionable. Herdr Boss picks one actionable task: current frontier first, then a task without a frontier value, then next frontier. Status-file order decides a tie.

A task in a group with `"held": true` is not actionable. The nudge then names the next actionable task outside the held group, or sends no notice.

The notice names the task ID and title. Resume an idle or done worker on that task, or start suitable work yourself. Check **Use now** when the project has a free effective slot. If it lists a lane, start ready work on that lane's harness. The notice uses one key per project and task, so the normal notice cooldown limits repeats. A different next task gets a new key and can prompt again.

A notice is a prompt to an `orch` pane. Herdr Boss normally sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. An immediate notice with severity `warn` or `critical` also goes to a `working` orchestrator. Worker failure notices are of this type. An immediate `info` notice, for example a worker report notice, waits until the orchestrator is `idle` or `done`. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`.

Some notices are in the bulletin only and are never sent as a prompt. These are the quota notices at 90% and 98%, the `Quota restriction cleared` notice, and the `browser is ready` notice. The alert source marks each of them with `prompt: false`. Worker failure, blocked-worker, kit, handover, disk, and machine-limit notices are sent as prompts.

Herdr Boss sends the `info` notices of one pane as one digest. All `info` notices of all kinds use the digest. A pane gets at most one digest in 2 hours. Herdr Boss sends no digest while the pane status is `working`. The digest waits until the status is `idle` or `done`. The first digest goes out as soon as the pane is settled. Other `info` notices for that pane wait. The digest sends all waiting `info` notices together, one line each. It shows at most 8 of these lines, then one `and N more` line. The bulletin lists all notices. Kit notices are not part of this digest. See the kit digest below. The 2-hour limit does not apply to `warn` and `critical` notices. They arrive at once. A `warn` or `critical` prompt inside the 2 hours does not include the waiting `info` notices.

Herdr does not show a draft or an open dialog in a pane. Herdr Boss does not detect them. An agent that waits for input has the status `blocked`, and Herdr Boss sends it no prompt except an immediate `warn` or `critical` notice.

The kit notice goes to every project orchestrator, also when the project has no active workers. The Boss workspace and the workspace of a paused, held, or stood-down project do not get it. The kit reminder skips such a project too, and its 2-hour clock starts again when the hold ends. A project is paused when its published `status` is `paused`, or when its allocation mode is `paused`. The kit notice uses the same rule as the handover skip. Herdr Boss finds the workspace of a paused project by the published `workspace` id, by the allocation, by a workspace label that equals the project slug or name, or by an orchestrator pane that runs in the project repository. Each kit notice path uses this one rule. A change that arrived during the hold stays pending. The orchestrator gets it in one digest when the hold ends, if the change is not older than 7 days. Older changes reach the project through the kit reminder. When the engine starts, it reads Git once in the directory that the service runs from. It runs no timers and no model calls. It stores the last notified commit and the current kit revision as `kitNotice` in `memory.json`. On the first start, it stores `HEAD` and sends nothing. When Git fails, or the stored commit is not an ancestor of `HEAD`, it stores `HEAD`, sends nothing, and logs one `kit` event. The engine keeps each required change as pending, also over a restart, until a pane receives it. A pane gets at most one kit digest in the number of minutes in `machine.kitDigestMinutes` (default 120, range 10 to 1440). The first kit digest of a pane goes out at once. A change that arrives inside the interval waits and joins the next digest. The digest lists all pending changes that the pane has not received. Herdr Boss sends no kit digest while the pane is `working`. It sends the digest when the pane is `idle` or `done`. The kit digest has its own interval and does not use the 2-hour interval of the `info` digest. A change stays pending for 7 days. The read-only preview does not read Git and does not send or store the notice.

The engine sends the notice only when at least one new kit change has impact `required`. A change with impact `useful` or `none` sends no notice, and a mixed batch names only the required changes. The impact comes from the `Kit-Impact:` trailer of the commit message. When a commit has no usable trailer, the engine reads the impact from the matching entry in `kit/CHANGES.md`. It uses the entry only when the number of entries after the stored revision equals the number of commits that changed an installed kit asset. Otherwise the change has impact `useful`. Only a trailer or a change log entry sets `required`. A stored notice from an older release has no revision, so its first batch has impact `useful` unless a trailer says otherwise.

Each commit that changes `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md` must carry a `Kit-Impact: required`, `Kit-Impact: useful`, or `Kit-Impact: none` trailer, or must change `kit/CHANGES.md`. Put the trailer in the last block of the commit message. `test/kit-impact-trailer.test.js` reads the Git log and fails for a commit after the base commit `9679bcd` that has neither. Use `required` only when a project must run `herdr-boss kit update` to keep working.

The notice text is `[herdr-boss] Kit revision <revision> (<n> change(s)): <subjects>. Run herdr-boss kit update and continue. The command prints the current kit file.` It names at most 10 subjects, then `and N more`. The revision in the notice is the kit revision of the directory that the service runs from. When you get a kit notice, run `herdr-boss kit update`. The command installs the kit as `herdr-boss kit install` does, prints the digest of the kit changes since the installed kit revision, and prints the current kit file. Do not read the kit file again. Publish the new `kitRevision`. A project that stays `behind (required)` for 2 hours gets one reminder while its orchestrator works. The service starts the 2 hours when it first sees the project behind on a required change. The clock stops when the project catches up or is behind on useful changes only. The reminder text is `[herdr-boss] Your kit is behind on a required change. Run herdr-boss kit update and continue. Kit revision now <revision>.` The reminder shows no desktop notification, and an idle orchestrator does not get it. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). The legacy top-level `alertCooldownSeconds` value in `config.json` is unused.

A published project status is stale when both conditions are true:

- Its `updated` time is more than `staleStatusMinutes` old. The default is 120 minutes. Set it in `config.json`.
- After the `updated` time, a worker of the project was `working` in the last 2 hours, or new commits landed on the project repository.

A paused project is never stale. Herdr Boss finds the repository in `project-repos.json`. A project without a repository record uses only the worker condition. Herdr Boss runs `git -C <repo> rev-parse HEAD` and `git -C <repo> log -1 --format=%cI` at most once every 10 minutes for each project. New commits landed when the HEAD commit time is after `updated`, or when `HEAD` changed after `updated`.

The stale notice text is `Your published status is <age> old while <workers ran | new commits landed>. Run herdr-boss publish <slug> <file> with the current plan and progress.` The notice uses one key for each project and `updated` time. Herdr Boss sends it once, with the idle gate and the 2-hour `info` limit. A new publish ends the stale status. When the new status becomes stale, Herdr Boss sends a new notice.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

### Current guidance

The Overview shows the current guidance in a collapsed section under the page header. The section header shows one summary line, for example `Use now: free models, codex · Claude ahead of pace · 1 warning`. The line holds these parts:

- `Watch on` or `Watch until HH:MM` while a watch runs.
- The Use now lanes, in the order of the bulletin Use now line. `free models` is the open unmetered lane.
- Each metered lane that is ahead of pace, near exhaustion, or exhausted.
- The number of critical rules, warnings, and advice lines.

Select the header to open the section. It shows the watch line, one chip for each quota lane with its state and use, and the same rules as the bulletin. The browser remembers the open or closed state in its local storage. The Analytics page has the activity log.

The Overview shows its sections in this order:

1. The current guidance.
2. **Needs your decision**, when a task waits on the Owner. See [Needs your decision](#needs-your-decision).
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

A state whose `until` time has passed reads as not active. The file stays, so the engine can read its own marks. A missing or unreadable file reads as not active. The read view of an active state is `{ active, since, until, untilCancelled, reportAt, reportDaily, by, quietHours }`. The read view of any other state is `{ active: false }`.

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
| `GET /api/watch` | none | `200` with the watch state. |

`until` is `HH:MM` local time, `YYYY-MM-DD HH:MM` local time, or an ISO time. An `HH:MM` value means the next such time. The end time must be in the future. A watch has no maximum length. A refused time answers `400` and keeps the stored state. A blank value uses the next 07:30. Do not send `until` with `untilCancelled`. The routes need the same access as the other dashboard write routes. The read-only preview refuses them. The start route records `by` as `dashboard`.

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

Herdr Boss gives a trickle lane a daily allowance. With a goal end in the future, it divides the gap to the goal percent by the days left to that end. After the goal end, it divides the unused quota percent by the days left to reset. Without a goal end, it divides the gap to the goal percent by the days left to reset. The goal percent defaults to 100%. It counts today's use from the first quota record after 00:00 UTC. After a reset, it starts from the first record after that reset. With no record for today, it counts 0% use.

The bulletin and `herdr-boss lanes` show the allowance, today's use, and the goal. The Overview quota card shows the goal in each window row. It also shows the goal in the trickle footer. Each goal uses the form `goal: 100% by Thu 8 Oct`. The text shows the time for a one-off end within 48 hours. `worker start` allows a trickle lane below its allowance. At or above the allowance, it refuses until 00:00 UTC. Use `--force` to bypass this refusal. Automatic handover can use a trickle lane below its allowance.

When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage. When several windows are exhausted, the lane shows the one with the latest reset.

The **pace tolerance** is the number of percentage points that a window may be above its expected use and stay on pace. The default is 5. A window is ahead of pace only when its use is more than the tolerance above the expected use. A window at exactly the tolerance is on pace. A tolerance of 0 gives the strict rule. The **minimum use** is the used percent below which a window is never ahead of pace. The default is 30. A minimum use of 0 gives no minimum. A window below the minimum use is never ahead of pace. A window at or above the minimum use that will not last to its reset is ahead of pace at any tolerance, unless a timed goal end is still in the future. Set `paceTolerancePoints` (0 to 50) and `paceMinUsePercent` (0 to 100) in Settings under Provider quotas. The reserve and near-exhaustion rules do not use them.

A **quota pacing goal** is the most percent of a window that you want to use by its end. A goal without a separate end reaches its percent at reset. Herdr Boss scales the measured expected-use pace by `goal / 100` for this form. A timed goal rises from the live window start to its percent at the configured end. The line stays at that percent until reset. An unset goal means 100%, which preserves the normal pace. When a timed goal end passes, Herdr Boss uses the reset forecast to decide if a long window is ahead of pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

Choose a one-off local date and time, or choose a recurring number of whole hours before reset. Herdr Boss stores a one-off time as an ISO timestamp. It deletes that whole goal when the time passes or the quota window resets. It keeps a recurring offset for later windows. A goal end must be after now, after the current window start, and no later than its reset. Runs-out advice compares the current rate with the goal percent and the goal end. The advice names the goal end when the rate reaches the goal percent before that end. `herdr-boss lanes` and the bulletin show the goal and its end while the provider is open or restricted. The Settings page shows the reset of each window in local time, for example `Sat 3 Oct, 06:58`.

The same output has one **unmetered** lane. It lists every permitted unmetered model that can start, by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The lane leaves out three kinds of closed models and reports each one on a separate line with its reason:

- A model with an active free-usage retry. The line shows its retry time.
- A Pi model that Pi cannot use. Herdr Boss runs `pi --list-models` at most once every 15 minutes. Pi lists only the models that it can use. A Pi model is unavailable when the last good result does not list it. When Pi lists no row for the provider of the model, the line states that Pi has no credential for that provider. A failed run, or output without a header row, keeps the last good result. Without a good result, Herdr Boss does not hide a Pi model.
- Every unmetered model of a harness whose free lane is exhausted. The line shows the retry time, and `(reset time unknown)` when Herdr Boss uses the 1-hour default.

The lane is closed when it leaves out a model and no unmetered model remains. The bulletin, `herdr-boss lanes`, and the worker-start refusal text use the same data. They never offer a closed model as an alternative. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

`worker start` refuses a Pi model that the last good `pi --list-models` result does not list. `--force` does not bypass this refusal, because such a worker cannot run. `worker start` also refuses an unmetered model of a harness whose free lane is exhausted. Use `--force` only for an authorized override.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Settings and allocation

### Setting help and page order

Each setting on the Settings page and on the Allocation page has an **i** button. A setting that repeats for each harness, provider, routine, or project has one **i** button on the section or group header. Its rows have no button. The pages show no other explanation text, except one line where a change can lock the Owner out or lose data, and the status and error lines. Select the button, or focus it and press Enter or Space, to open a popup. The popup shows what the setting does, its default, its unit, its range, the effect of a higher and a lower value, and how the change takes effect. On a desktop, hold the pointer over the button to show the same popup. Press Escape to close it. A popup stays open when the page refreshes.

The Help panel of the Settings page has a guide to each group of settings: what the group controls, what it affects, which changes are safe, and if a restart is needed. The text of the popups, the guide, and the settings reference in `docs/cli.md` comes from one file, `public/setting-help.js`. A test fails when a setting has no explanation.

The Settings page lists the most used groups first: Harnesses, Provider quotas, Machine, and Watch routines. The **Advanced** section holds Avatars, Token prices, Service settings, and Harness readiness. It is closed at first. The page remembers in this browser if you opened it.

The Advanced section opens by itself while a harness readiness row is not `ok` or a service settings save shows an error. Its header then shows how many items need attention.

The Settings page has one section for each harness. A harness section holds the harness availability, the preferred model, and one row for each model. Provider quota modes, quota pacing goals, and machine limits are below the harness sections. Settings shows the warning and critical quota percentages from `config.json`. The dashboard uses these values to color quota levels.

The **Service settings** table shows the values that the service uses. Each row shows whether the value comes from `config.json` or a default. The table groups rows under Machine, Quota, Status, Workers, Watch, Browsers, and Service. Set values with inputs, then select **Save** for that group. Herdr Boss writes only those values to `config.json` and applies them at once. Keep the quota warning below the critical value. The `tickSeconds` and `quotaSeconds` rows apply at once. The `tickSeconds` range is 5 to 300 seconds. The `quotaSeconds` range is 30 to 3600 seconds. The `alertCooldownSeconds` row is read-only. It is an unused legacy value. Set the notice cooldown in the Machine group. The `push` row is a switch. Herdr Boss reads `push` at service start, so the row shows `restart required`. The environment variable `HERDR_BOSS_PUSH=0` overrides the saved value. The `port`, `host`, `providerKinds`, and `orchestratorLabel` rows stay read-only. A wrong port or host can lock the Owner out of the dashboard. Provider kinds and the orchestrator label are structural. Change them in `config.json` and restart the service. The table does not show access or Roamgate settings.

### Avatars

The Settings page has an **Avatars** section. It has one row for the Boss and one row for each project. A row shows the avatar, an **Upload image** control, and a **Reset** control. The image is a PNG, JPEG, or WebP file of at most 512 KB. See [Avatars](#avatars) for the rules, the storage, and the routes.

The **Harness readiness** table shows the status of each harness entry that orchestration needs. Each row shows the status, the area, and the item. The status is `ok`, `missing`, or `bad`. The table is read-only. It shows no file path and no setting value. Herdr Boss reads these entries at each service start and then every 10 minutes. Run `herdr-boss harness sync` to see the changes to make.

The model catalog is `kit/models.json`. The local policy can add model strings to one harness. Herdr Boss merges these extra models into the allow-list of that harness in worker start, handoff plan and prepare, the lanes and the bulletin, Settings, Allocation, and `herdr-boss models`. An extra model uses the launch arguments and effort rules of its harness.

Free `opencode/` models run only in the `opencode` harness. The Pi allow-list holds only `opencode-go/` models. Herdr Boss uses the `pi --list-models` result to hide a Pi model that Pi cannot use.

The Machine section saves its settings in `policy.json`. The machine guard is on by default. It is active only when it is on and its pause has expired. When it is off or paused, CPU and load thresholds do not warn or block worker starts. Memory and disk warnings stay on. Herdr Boss still shows measured CPU, load, and free disk space, the configured thresholds, and whether the Owner is present. Disk space uses the filesystem that contains the configured Herdr Boss data directory. GB means 2³⁰ bytes. The default disk warning starts below 20 GB free. The default critical alert starts below 5 GB free. Free percent is information only and displays to one decimal place. Disk worktree counts exclude the `boss` pane and the Boss workspace. Each Git repository is counted once and its notice goes to its project `orch` pane. Notices include linked and prunable worktree counts and the safe prune command. A notice sends when the disk level changes, including after recovery.

Herdr Boss reads Owner idle time from macOS `IOHIDSystem`. The default away time is 10 minutes. Missing or invalid idle data means the Owner is present. CPU is total sampled process CPU, including other processes, divided by core count. The default CPU limits are 70% while present and 95% while away. Set the away CPU limit to blank to disable it. The default 5-minute load backstops are 3 times the core count while present and 8 times while away. Set a load backstop to blank to disable it. The load average stays visible when a backstop is disabled.

Use the switch in Settings or the Overview machine summary to turn the guard on or off. Choose a duration and select **Pause guard** to pause it. The guard becomes active again when the pause expires. Select **Resume guard** to end a pause early. Settings changes stay in a draft until you select **Apply policy**. Overview guard actions save to the current policy at once. They preserve other unsaved Settings changes. `herdr-boss lanes`, the bulletin, and worker-start output show whether the guard is active, off, or paused.

When Herdr Boss loads an older policy without `machine.guardEnabled`, it checks the saved thresholds. It turns the guard off and restores the default thresholds only for the exact old off tuple: present CPU 100, away CPU blank, and both load backstops blank. It keeps the saved Owner-away time and alert cooldown. For every other old policy, it turns the guard on and keeps the saved thresholds.

The swap warning uses three settings in the Machine section: `machine.swapWarnPercent` (default 80), `machine.swapRefusePercent` (default 95), and `machine.swapMinUsedGB` (default 2). A percent is a whole number from 1 to 100, or blank to turn the rule off. The GB value is a number from 0 to 1024. Herdr Boss computes the swap percent as swap used divided by swap total. The swap total on macOS grows with use, so the warning also needs at least `swapMinUsedGB` of swap in use.

The engine raises the alert `machine:swap` with severity `warn` and the title `Swap high: N% used` when the last 3 samples are at or above `swapWarnPercent` and each has at least `swapMinUsedGB` in use. The engine takes one sample at each tick, which is every 30 seconds by default. The alert clears when swap is more than 5 points below `swapWarnPercent`, or below the GB floor. The alert does not depend on the machine guard. It stays on when the guard is off or paused. The alert never blocks a worker start or a suite. The notice cooldown applies to it.

The alert text is advice. It gives the swap percent and the GB in use. It says that macOS swap grows on demand, so a high figure alone does not mean the machine is short of memory. It says whether the swap refusal is on or off. It gives the browser rule: use at most 1 browser worker at a time while swap is above the warning level, and up to 3 otherwise. It says that one worker at a time is fine, and it asks the reader to close finished workers and their browsers. When the machine samples show it, the text ends with one line such as "Swap was above the warning level in hours 14 to 17 on 3 of the last 7 days." The line uses local hours of the day and aggregate counts only. It names an hour only when that hour was high on at least 2 days, or on 1 day when only 1 day has data.

The swap refusal is off by default. Turn it on with the switch "Refuse new work at high swap" in the Machine section. When the switch is on and swap is at or above `swapRefusePercent` with at least `swapMinUsedGB` in use, an orchestrator or a worker cannot run `worker start`, `herdr-boss suite`, or `herdr-boss push` with a pre-push hook. The message shows the swap percent and the GB in use. A blank `swapRefusePercent` switches the refusal off.

Work that the Owner or the Boss starts is never refused. Rules older than 3 minutes never refuse. To override, add `--force-swap` to `worker start`, or set `HERDR_BOSS_FORCE_SWAP=1` for `suite` and `push`. `--force` does not override the refusal. `suite --reuse` returns 0 when it reuses a passing tree.

Policy settings take precedence over legacy `config.json` values. The old `machine.loadWarnFactor` field does not control machine guards. The legacy top-level `alertCooldownSeconds` field is unused. Notice delivery reads `machine.alertCooldownSeconds`.

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

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget in each worker brief. The default is 10 screenshots. The project setting overrides the kit default. Worker start appends any missing budget or copied input details when a project brief template omits those slots. Use `worker start --copy PATH` to copy a regular repository file into the worker's `.worker/inputs/` directory before the agent starts. Repeat `--copy` for each file. The command preserves repository subdirectories and refuses paths outside the repository.

The Analytics page shows a **Model scorecard** chart. Its Details table has one row for each harness and model over the last 30 days. Each row shows the runs, the first-time, rework, and failed counts, the rework rate (rework plus failed, divided by the runs), and the median run duration. The table sorts by runs. The orchestrator records the model outcome at review time with `worker collect --record --model-result first-time|rework|failed` and, for rework or failure, `--model-reason TEXT`. The orchestrator's values win over the report's `modelOutcome`. When neither is given, the result is derived: `failed` when `--outcome failed` or `--gate-failed`, `rework` when `--rework` is more than 0, otherwise `first-time`.

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

Herdr Boss activates a prepared automatic successor when all of these are true:

- The source orchestrator pane is `idle` or `done`. A running worker does not block activation. It keeps the project active.
- The successor pane is `idle` or `done`.
- The project is not held or stood down, and the pane is not the Boss pane.
- The successor model is not weaker than the source model.

An orchestrator that finished its turn and waits at a gate is `idle` or `done`, so it can hand over. A prepared successor from the context trigger does not expire for 24 hours. Other automatic successors expire after 2 hours. While a prepared successor waits, the Overview shows `handover waits:` and the reason. A successor without a ready signal shows `successor not ready:` and the cause: the prepare prompt failed or stalled, the pane is absent, the pane runs another agent, the pane works, the pane has not started its state read, or the 120-second wait is not over. The engine state gives the same reason in `handoverWaits`, by handoff ID.

After activation, Herdr Boss finishes the handover. It waits until the successor answers the activation prompt, or until 15 minutes pass with the old pane idle. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. The rename does not wait for the old pane. Herdr Boss then closes the old pane. The status `done` counts as idle, because a `done` pane finished its turn. Herdr Boss never closes the old pane while that pane works, is blocked, or was settled for less than 60 seconds. A running worker does not keep the old pane open. It also keeps a pane whose label is not `orch previous`. The Owner closes the old Boss pane by hand; this early close applies only to project orchestrators. It retries on each tick, and it sends one line to the Boss when the old pane is still open after 60 minutes. The line names each reason. The Overview shows `closing old orchestrator at HH:MM` on the new orchestrator until the pane is closed. Herdr Boss also closes the tab of a successor that expired or was replaced without activation.

Activation labels the old pane as previous. If the early close did not run, Herdr Boss closes that pane after 120 minutes from activation when the handoff, the previous-role label, and the successor-role label are still confirmed. A newer handover does not cancel this retirement. Herdr Boss marks the older handover as superseded when the new handover starts from its successor pane and has the same role. The engine also marks older records on each active tick. It follows a chain of superseded records to the current successor before it closes a pane. Unavailable pane data defers retirement until a later tick. The current successor gets one notice after retirement.

At activation, Herdr Boss prompts the previous agent first. The prompt tells it that it no longer owns orchestration. It asks for a concise final summary for the successor. It tells the agent to answer each later request only with the successor pane ID. A Boss handover uses Boss and Owner wording. This prompt is best effort. If it fails, the engine sends it again later.

If the Owner closed the source pane before activation, Herdr Boss skips the source label and the previous-agent prompt. The record keeps `activation.sourceMissing: true`. The successor prompt says that the source pane was closed and does not ask for a final summary.

Herdr Boss then prompts the successor. The prompt gives its own pane ID, the previous pane ID, and how Herdr Boss built its session. It tells the successor to read the previous agent's final summary when it is available, to take over the current work, and to use its own pane ID in worker briefs, reports, and messages.

Herdr Boss then prompts each running worker of the project, once for each handoff. A running worker is a worker with a run record that has no `finishedAt` and a live agent pane. The prompt is one line: `Your orchestrator is now <slug>-orch (pane <new pane>). Send WORKER REPORT and WORKER QUESTION there.` Herdr Boss skips a worker whose pane is gone. A failed prompt is logged and does not fail the activation. Herdr Boss makes one attempt for each worker and handoff. It does not prompt a worker again after a failed prompt. The record field `workerPrompts` keeps the result for each worker. Herdr Boss saves the record before it sends each prompt. A Boss handover prompts no worker.

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

The automatic handover has a second trigger, the context size. It runs only when `autoHandover` is on. Set the limit in Settings as **Hand over at context tokens**, or in `policy.json` as `autoHandoverContextTokens`. The default is 300000 tokens. The value is an integer from 50000 to 2000000.

A handover carries the Owner goal to the successor. Set the goal for an orchestrator with no goal in Settings as **Default orchestrator goal**, or in `policy.json` as `defaultOrchestratorGoal`. The value is one line of at most 4000 characters. An empty value turns the default off. The handover record and the project page show the goal as one collapsed line.

A task boundary starts the check. A boundary is one of these events:

- A task in the published project status changes to `done`.
- The orchestrator pane goes from `working` to `idle` or `done` after a new publish.

At a boundary, Herdr Boss reads the context size of the orchestrator. When the size is above the limit, Herdr Boss prepares a fresh successor from `docs/orchestration/memory.md`. The successor has the same harness and the same model as the source. The successor reports ready with `herdr-boss handoff ready`. If the successor does not report, Herdr Boss marks it ready by itself. The successor pane must exist with the recorded agent. Herdr Boss must have seen the pane `working` after the prepare prompt, and the pane must be `idle` or `done` again. The prepare prompt must not have the delivery result `stalled-retry`. The prompt must be at least 120 seconds old. Herdr Boss never marks a working pane ready. The record then shows `readyNote: auto: successor idle`. Herdr Boss then activates the successor when the source pane is `idle` or `done`. If the source pane works, Herdr Boss waits.

Herdr Boss reads the context size only for a Claude orchestrator. It takes the last main-thread assistant message in the session transcript in `~/.claude/projects/`. The size is the sum of `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` of that message. For another harness, or when the transcript is missing, the context size is unavailable. Herdr Boss then logs one line and starts no handover.

Herdr Boss watches a pane from its first tick. A pane that Herdr Boss sees for the first time is unarmed: a task that was already done, or a pane that was already idle, is not a boundary. An idle orchestrator whose project has no running worker and no working agent waits. The check runs after work starts again and the next boundary arrives.

The context trigger uses the same rules as the quota trigger. It skips the Boss, a held project, and a project that does not work. It activates no successor with a weaker or unranked model tier. It prepares no second successor while a record for the same pane is `prepared`, `preparing`, or `needs-inspection`.

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

## Board page

The Board page, `/board`, shows the tasks of all projects on one kanban. It uses the same task states and colors as the board on each project page. See [Live task state](#live-task-state). A project shows on the Board when it publishes at least one task.

### Columns

| Column | Tasks |
|---|---|
| Blocked | A task that waits on a task that is not done, on the Owner, on the Boss, or on an external item. |
| Ready | A task whose dependencies are all done. |
| Doing | A task with a live worker, or a task published as `doing`. The longest-running worker comes first. |
| Review | A task whose worker finished or was collected and whose branch is not merged. |
| Done · 24 h | The tasks with an `updated` time in the last 24 hours, newest first. A done task without a valid `updated` time does not show. |

Blocked, Ready, and Review keep the project order and, in a project, the order of the project board.

### Cards

A card shows the project name and avatar, the task ID, the title, and the worker with its model. A Doing card also shows the elapsed time. A Blocked card shows what the task waits on: the ID and the title of each open blocker, or the Owner, the Boss, or an external item with the `ask`. A card on the critical path of its project shows **path**.

Select a card to open `/projects/SLUG?task=ID`. The project page selects the task, shows its card on the board, and centers it in the dependency graph. Select a blocker to open that task the same way. Select the project name to open the project page. On a phone the project name on a card is not a link. Use the project chips to show one project.

### Summary strip

The strip at the top shows the number of tasks in each column. The counts use the project, kind, and search filters. Select a count to show only that column. Select it again to show all columns. **Needs the Owner** shows the number of open Mailbox items that need the Owner. Select it to open the Mailbox at **Needs you**.

Each project has one bar. The bar shows the tasks of the project in each state, in the column colors, on one scale for all projects. Select a bar to show only that project. Select it again to show all projects.

### Filters and grouping

| Control | Effect |
|---|---|
| Search | Shows the tasks whose project, ID, title, ask, worker name, or model holds each search word. Press `/` to go to the search. |
| Project | Shows one project. |
| Kind | Shows the tasks that wait for the Owner, the tasks with a worker, or the tasks of one worker harness or one model. |
| State | Shows one column. |
| By project | Shows one swimlane for each project. Select the swimlane title to close or open it. |
| One board | Shows all projects in one set of columns. |
| Clear filters | Removes the search and all filters. |

The page stores the grouping, the filters, and the closed swimlanes in the browser, in `localStorage` under `herdr-boss.board`. It does not store the search.

### Refresh

The page updates in place with a keyed patch, the same as the project page. A refresh keeps the scroll position, the focus, and the search text. When a refresh moves a card to another column, the focus moves with the card.

### Phone

On a screen up to 760 px wide, the Board shows one column at a time. A tab bar shows each column with its count. Select a tab or swipe sideways to change the column. The first column with work opens, in the order Doing, Ready, Blocked, Review, Done. A row of project chips replaces the swimlanes and the project filter. Select a chip to show one project. Select **All** to show all projects. The grouping switch, the state filter, and the per-project bars do not show on a phone.

## Analytics page

The Analytics page (`/analytics`) shows figures and charts. It answers these questions:

- What does the fleet cost each day, by role and by harness?
- Does the quota use of each lane stay at or below its expected pace?
- How often is each model right the first time?
- Which causes of denials and permission prompts occur, for which harness?
- When do the machine load and the lock waits slow work down?
- How many notices does each pane get?

### Headline strip

The strip at the top has six tiles. Each tile shows one figure, a detail line, and a change where the data has one.

- **Claude spend a day**: the mean Claude spend of the last 7 days, split by role, with the change on the 7 days before.
- **Quota against pace**: the lane with the most use above its pace line, in percentage points.
- **Denials this week**: the 7-day count. The trend compares the last 24 hours with the 6-day mean.
- **Notices per pane a day**: the 7-day mean for each pane that got a notice, and the value of today.
- **Lock wait and hold**: the median wait and the median hold of the lock acquires in the last 7 days.
- **First-time success**: the first-time runs divided by the judged runs of the last 30 days.

### Charts

Each chart has a title that tells what to read from it, a scope line, a legend, and an axis. Hover, focus, or touch a column, a cell, or a row to read its values in a tooltip. **Details** under each chart opens the table of the same figures. The page remembers the open Details until the page reloads.

- **Spend**: stacked bars for each day of the last 14 days. The switch splits the bars by role or by harness. The source is `/api/spend`. The USD figure is the API-price equivalent. The Owner pays a subscription, not these amounts. When no model in the window has a price, the chart shows tokens.
- **Quota**: one solid line for the use of each lane and one dashed line for its expected pace, in the weekly window, one column for each hour. The source is the quota trend of `/api/usage`.
- **Model scorecard**: one bar for each of the 8 models with the most runs. The bar shows the share of first-time, rework, failed, and not judged runs. The right column shows the runs and the median time. Details also holds the recorded work by project and provider and the recent runs.
- **Denials**: a heat map of the causes by day over the last 7 days. The switch selects one harness or all harnesses. A darker cell has more events.
- **Machine load and lock waits**: lines for the 5-minute load as a percent of the cores, the memory in use, and the swap in use, over the last 24 hours in columns of 10 minutes. A shaded column had a lock holder. The strip under the lines shows the minutes in which a suite request waited.
- **Machine overload and idle waiting by hour**: see [Machine samples](#machine-samples).
- **Notices per pane**: stacked bars for each day of the last 7 days. The five panes with the most notices have their own color. The other panes share one gray.

The charts use one color set for light mode and one for dark mode. The set passes the dataviz palette validator. The charts show no project name, client name, or path. They show harness, model, cause, lock kind, and pane ID only. On a screen up to 1180 px wide the charts are in one column. On a phone each chart scrolls sideways inside its own box.

The route `/api/analytics` gives the notice counts and the machine timeline. It reads the last 2 MB of `events.jsonl` and the machine samples of the last 25 hours. It keeps the result for 60 seconds. The result holds numbers, lock kinds, and pane IDs only.

### Activity log

The last section of the page is the activity log. It lists prompts sent to orchestrators, notices, handovers, errors, and stopped processes, newest first. The first line tells whether Herdr Boss sends notices to orchestrators.

- Filter by kind, project, level, and time range. The level is the severity of a notice, or `error` for an error event.
- Type in the search box to match the text, the kind, the pane, or the project.
- **Details** holds the raw log: all kept events without filters, one line each.

The log shows the events that the state keeps: the last 60. The old address `/logs` opens this section. The old address `/logs#guidance` opens the guidance section of the Overview.

## Project status pages

Orchestrators do not build dashboards. They publish a status file. Herdr Boss shows it on `/projects/SLUG`. The page shows a board of the tasks. With the optional work structure fields, the page also shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

### Page order

The project page puts the sections in the order of use:

1. The header: the name, the Owner goal, the summary, the phases, and the updated time.
2. **Now**: what needs the Owner or can act now.
3. The plan and progress: metrics, overall progress and the frontier, the board, the dependency graph, groups, specs, and human gates and risks.
4. History: all work, notes, and links.
5. **Details**: settings and reference information, in closed cards.

### Now

The first line of the Now section is the orchestrator line. It shows the harness, the pane, and the state of the orchestrator. Select it to open the handover form. When a handover is needed or prepared, the full **Project continuity** section replaces the line.

Below the line, small cards sit in a grid of one, two, or three columns:

- **Needs your decision**: the open tasks that wait on the Owner.
- **Status issues**: status file errors, a stale status (the age, or the reason when a live worker runs a task that is not doing), a stale board, AGENTS.md drift, and a required kit update.
- **Running now**: the used and total worker slots, and each worker with its harness, state, elapsed time, and task.
- **Waiting to merge**: the tasks in Review, and uncommitted changes from the published `git` field. The card also shows `N unpushed commits` and `M unmerged branches` when the count is above 0. Herdr Boss reads both counts from the project repository at most once a minute. Unpushed commits are the commits of the current branch that are not on its upstream. A branch without an upstream has 0. Unmerged branches are the local branches that are not merged into the base branch. The base branch itself does not count. Herdr Boss shows a count only as a number. If git does not answer, the count does not show.
- **Next task**: the first Ready task in board order, the number of other Ready tasks, and the number of blocked tasks.

A card without content does not show. Select a task in a card to select it on the board and in the graph.

### Project details

The **Details** section is the last section of the project page. It holds closed cards: **Files and kit**, **Worker config**, **Agents and panes**, and **Browser and leases**. The card header shows a short summary, for example the kit state or the number of agents. On a desktop the cards sit two to a row. The browser remembers the open or closed state of each card for each project in its local storage.

**Browser and leases** shows the project browser port and state and the resource leases of the project. It is read-only. Use the Browsers page and the Allocation page to change them.

Publish at task boundaries: a task starts, a task ends, a blocker appears, or a blocker clears. `herdr-boss publish` keeps the newest 30 done tasks in the stored status. It counts the older done tasks in `doneCount`. The orchestrator keeps its own file unchanged. The project data holds `doneCount`. The overall progress on the project page adds `doneCount` to the done tasks and to all tasks.

### Live task state

The published status file holds the plan. The worker run records hold what happens. Herdr Boss overlays the run records on the published tasks, so the state of a task does not wait for a publish. The service reads the run records of each registered project every 15 seconds. A worker links to a task through `taskId` in its run record. Start each worker with `worker start --task-id ID`. `--issue N` works as an alias for a numeric task ID. A run without a task ID has no effect on the board, and `worker start` prints a warning.

Each task gets one effective state, `state`:

1. A published `done` task stays `done`.
2. A worker whose branch is merged makes the task `done`. A branch counts as merged, also for a worker that was not collected, when its run record has `mergedAt`. A branch also counts as merged when the run record has `baseCommit`, the branch has at least one commit beyond the base commit and its tip is in the base branch. A branch with no new commit, a deleted branch, and the base branch itself do not count. The orchestrator publishes `done` for such a task.
3. A live worker makes the task `doing`. The source is `live from worker NAME`. A worker is live when its run record has no `finishedAt` and no `collectedAt`, and its pane is in the pane list.
4. A collected worker whose branch is not merged makes the task `review`. `worker collect` sets `collectedAt` only when the worker reported done.
5. A finished worker with no collect record makes the task `review`. The source is `finished, not collected (worker NAME)`. The task stays in Review while it waits for the orchestrator. It does not return to `ready`.
   A worker is finished when all of these are true: its pane is gone, its run record has no `finishedAt` and no `collectedAt`, and `report.json` says the work is done.
   The worker is merged, not finished, when its branch is merged. Herdr Boss checks the merge only for a worker with a done report.
6. A worker whose pane is gone and whose report says `stoppedEarly: true`, or a status or outcome of `blocked`, `failed`, or `partial`, is failed.
   A worker whose pane is gone, without a usable report, `finishedAt`, or `collectedAt`, is abandoned.
   A failed, partial, or abandoned worker gives no state. When the task is published as `doing` and all its workers failed or are gone, the task is open again: it is `ready`, or `blocked` when a dependency is not done. Any other published status applies.
7. A task that is `todo`, `ready`, or `blocked` without `waitingOn` has the state `blocked` while a task in `blockedBy` is not done. `blockers` names these tasks. A `blockedBy` ID that is not in the status counts as not done. A published `waitingOn` also gives `blocked`, and the reason names the Owner, the Boss, a task, or an external item. A dependency never changes a `done` task, a `doing` task, or a `review` task.
8. The same task has the state `ready` when all its dependencies are done.

When more than one worker runs on a task, the latest live worker decides first. Without a live worker, the latest finished, collected, or merged worker decides. Herdr Boss ignores a finished, collected, or abandoned run that is older than 14 days.

The service checks at most 5 branches for a merge in each read of the run records and keeps each answer. A merged answer stays. A not-merged answer is used again for 60 seconds.

The board is stale, `boardStale: true`, when one of these is true:

- An active worker runs a task that is not `doing` in the published status, more than 5 minutes after the worker started. A task that is not in the status also counts. A worker is active when its agent status is `working` or `blocked`, it is not parked, and it has no `report.json`. An idle worker, a parked worker, and a worker that reported done wait for the orchestrator.
- The published status is older than `staleStatusMinutes` (default 120 minutes), a worker worked after the publish and within the last 2 hours, or new commits landed after the publish.

`boardStaleReason` names the cause. Herdr Boss sends one notice to the orchestrator pane for each stale status, the same notice as for an old status. The text adds the worker and the task when a worker does not match the status. A new publish starts a new episode. `herdr-boss publish` refuses a status in which a task has an active worker but is not `doing`. Use `--force` to publish anyway. The commands are in [cli.md](cli.md).

### Board

The board shows each task in one column of the flow. The column comes from the effective state, `state`. A status without `state` gets the same rules in the page.

| Column | Tasks |
|---|---|
| Blocked | A task that waits on a task that is not done, on the Owner, on the Boss, or on an external item. |
| Ready | A task whose dependencies are all done. |
| Doing | A task with a live worker, or a task published as `doing`. |
| Review | A task whose worker finished or was collected and whose branch is not merged. |
| Done | The last 10 done tasks by `updated`. **Show all N done** shows the rest. |

Each card shows the task ID, the title, what the task waits on, and the worker. A Blocked card names each open blocker. The blocker ID is a link that selects that task. A blocker that is not in the status shows as **ID (outside)**. A Blocked card always shows a reason. When `waitingOn` is `task` and no blocker is open, the card says **a task that the status does not name**. When the status gives no reason, the card says **a reason that the status does not state**. A wait on the Owner links to the Mailbox conversation when the task has `mailboxId`. A Doing card shows the worker, the model, the elapsed time, and the source, for example `live from worker NAME`. A Review card shows the worker and the source.

Ready sorts by priority. The tasks on the critical path come first, then the tasks in the published group order, then the tasks in the published order. Doing puts the longest-running worker first.

When `boardStale` is true, the board shows a **stale** mark and `boardStaleReason`.

The next milestone is the first group in `groups[]` that has an open task. The critical path is the longest chain of open tasks that ends in that milestone. Without groups, the chain can end in any open task. When two chains have the same length, the chain whose last task comes first in the status wins. A card on the path shows **critical path**.

The board and the dependency graph use the same states and the same colors. Each state has a label next to its color. The colors pass a check for color-vision separation in the light and the dark theme.

Select a card title to select the task. The card gets a ring. The graph marks the task and its dependency chain: all tasks that it waits on and all tasks that wait on it. The other tasks fade. Select a graph box to select its task and go to its card. Select the selected task again to clear the selection.

The page updates the board and the graph in place. A refresh keeps the selection, the scroll position, the phone column, and the graph zoom. The page matches each card and each graph box by its task ID. When a refresh moves a card to another column, the focus moves with the card.

On a phone, the board shows one column at a time. A tab bar above the board shows each column with its count. Select a tab or swipe sideways to change the column. The first column with work opens, in the order Doing, Ready, Blocked, Review, Done. The board section is open by default.

A link to `/projects/SLUG#board` or `/projects/SLUG#dependencies` opens the page at that section. A link to `/projects/SLUG?task=ID` opens the page with that task selected, shows its card on the board, and centers it in the graph. The page then removes `task` from the address. A link to a published project opens it also when its workspace is closed.

### Files

The **Files and kit** card in Details is read-only. It names three paths:

- The project memory file: `<repository>/docs/orchestration/memory.md`.
- The installed kit file: `<repository>/docs/orchestration/herdr-boss.md`.
- The Boss memory file: `~/.herdr-boss/boss-memory.md`.

The card shows the kit revision in the project status file next to the current kit revision. A required kit update also shows in the Now section. The home folder shows as `~`. The page shows paths only. It never shows the contents of a memory or kit file.

### Worker config

The **Worker config** card in Details is read-only. It shows the non-secret fields that Herdr Boss read from `.herdr-boss.json` in the project repository:

- `slug`, `baseBranch`, `worktreeRoot`, and `worktreeName`.
- `evidenceTiers`, `allowedModels`, `workerPanesPerTab`, and `imageBudget`.
- `setup`, `setupTimeoutSeconds`, `agentStartTimeoutMs`, and `testThreadsFlag`.

A field that the file sets has a **config** tag. The other fields use the default value. The `setup` command shows as `set` or `not set`. A `worktreeRoot` path in the home folder shows as `~`. A project with an invalid `.herdr-boss.json` shows the read error in place of the fields.

The engine reads the config at each service start and every 10 minutes. Change a field in `.herdr-boss.json` in the repository. The card changes after the next read.

### Needs your decision

A task can name the party that holds it with `waitingOn`: `owner`, `boss`, `task`, or `external`. The project page shows a **Needs your decision** card first in the Now section. The group lists each open task that waits on the Owner with its ID, title, ask, and a link to its Mailbox conversation. Each project card shows the count. The Overview shows the total with a link to each group.

A task that waits on other tasks shows **waiting on #ID** in place of the plain **Blocked** label. A task that waits on the Boss or an external party shows that party and the ask. The orchestrator sets `ask` when it waits on the Owner or the Boss, and sets `mailboxId` to the ID of the Mailbox item. See [project-status.md](project-status.md).

### Graph view

The dependency graph draws the open tasks and the done tasks that block them directly. Clear **Open work only** to draw every task. A task without links sits in the first column, after the linked tasks. Each box names its task ID and its state. A box on the critical path says **path**, and an orange line joins the path. Select a box to select its task. The issue link is on the card.

Use the toolbar above the graph:

- **Fit** shows the whole graph in the panel. Until you zoom or pan, the graph fits the panel. A wide graph starts at its left edge at 85% zoom, so the text stays readable.
- **−** and **+** zoom out and in. **100%** shows the graph at its natural size.
- **Full size** fills the window. Select **Close** or press Escape to return.

Press Ctrl or Cmd and turn the mouse wheel to zoom around the pointer. A plain wheel scrolls the page. Drag the background with the mouse to pan. A drag on a task box does not pan. The page remembers the zoom and the pan of each project during the session.

On a phone, the graph has its natural size and scrolls sideways in its own box. Only **Full size** shows in the toolbar.

For a visual check, add `?theme=light` or `?theme=dark` to a dashboard address. The page then uses that theme and ignores the system setting.

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
- A worker report notice (type `push`, title "Worker NAME wrote its report", sent only when the worker sent no `WORKER REPORT` prompt) draws a line from the worker to its orchestrator.

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

The panel reads the thread again every 10 seconds while it is open. The page shows each message and each report as safe Markdown. See [Markdown in messages](#markdown-in-messages).

### Markdown in messages

The message panel, the Mailbox, and the Chat show message text as Markdown. The renderer is `public/markdown.js`. It has no dependencies. The page shows these parts:

- Headings `#` to `######`. A heading shows one level smaller in a message, so `#` shows as a third-level heading.
- Paragraphs. A single line break is a space. Two spaces or `\` at the end of a line make a line break.
- Bold (`**text**`), italic (`*text*`), strikethrough (`~~text~~`), and inline code (`` `code` ``). An underscore inside a word is text, for example `snake_case`.
- Bullet lists, numbered lists, and task lists (`- [ ]` and `- [x]`). Indent a line by 2 or more spaces to nest a list.
- Tables with a header row and an alignment row. A table scrolls sideways in its own box. A column that holds only numbers is right-aligned.
- Fenced code blocks with three backticks or three tildes. A code block scrolls sideways.
- Block quotes with `>`, and horizontal rules with `---`.
- Links `[text](url)`, `<url>`, and bare `https://` addresses. An external link opens in a new tab.

These safety rules apply:

- Raw HTML shows as text. The page runs no script from a message.
- A link must use `http:`, `https:`, `mailto:`, a local path that starts with `/`, or `#`. The page shows other links, for example `javascript:` or `data:`, as text without a link.
- The page removes each element and attribute that is not on the renderer allowlist.
- The renderer reads at most 200 KB of a message. Nesting deeper than 8 levels shows as text.

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

The Mailbox page at `/mailbox` is the inbox of the Owner. It lists replies from `herdr-boss say`, reports from `herdr-boss mail post`, and messages that the Owner sent. The page fills the window. On a phone it is a full-screen app view. See [Phone app view](#phone-app-view).

### Folders

The folders are **Needs you**, **Inbox**, **Reports and updates**, and **Done**. **Sent** is below a divider. On a desktop the folder rail is on the left, with **New message** at the top. On a phone the folders are in the menu drawer. Each folder shows its count. The folder pane shows a read-only line with the limits: the retention and the send limit. The folder pane shows on a desktop. The page keeps the selected folder in the address and in browser storage. When Needs you has open items, it is the default folder. When it has no items and you have selected another folder before, the page restores that folder. Otherwise, Needs you is the default folder.

- **Needs you** shows open items with action `answer`, `approve`, or `decide`, newest first. When this folder is empty, the page shows “Nothing needs you.” and a link to the Inbox.
- **Inbox** shows the open Needs-you items and the unread information items, newest first. The list has two sections: Needs you first, then Reports and updates. A read information item is not in the Inbox. `GET /api/mailbox?folder=inbox` returns the items.
- **Reports and updates** shows unread items with action `read` or no action. The folder key stays `updates`, so `/mailbox?folder=updates` links keep working. Opening an item, or marking it read, sets `readAt` and `closedAt` together, and the item moves to Done. An existing `closedAt` stays. The view also lists an old read information item without `closedAt` as Done. The count shows the unread items. A read `decide`, `approve`, or `answer` item stays in Needs you until you answer or dismiss it.
- **Done** shows read information items, closed or dismissed items, and messages that the Boss relayed.
- **Sent** shows Owner messages. Each row shows the recipient, the delivery state, and the time of a reply, when one exists.

### Rows

The list has one row for each conversation. A conversation is one thread and one `replyTo` chain. The row shows the newest item of the conversation in the folder. On a phone the row has two lines. Line 1 holds the avatar, the project name or `Boss`, the message count when the conversation has more than one item, and the action tag: **Approve**, **Answer**, **Decide**, or **Report**. Line 2 holds the subject and a one-line preview. The time and an unread dot sit on the right. An unread row shows the name, the subject, and the time in bold. On a wide desktop list without an open conversation, each row is one 44 px line. The time is `HH:MM` for today, `Yesterday`, a weekday for the last 6 days, or the day and the month.

Select a row to open its conversation. The conversation shows Owner and agent messages in time order. Each message and each report shows as safe Markdown, with the same renderer as the message panel and the Chat. See [Markdown in messages](#markdown-in-messages). Opening an item sets `readAt` on the record. On a desktop the conversation opens at the right of the list, and the list keeps its position. On a phone the conversation fills the screen. Select the Back arrow to return to the list.

### Answer an item

| Action | Controls | Text sent |
|---|---|---|
| `answer` | A text field and **Send**. | The typed text. |
| `approve` | **Approve**, **Reject**, and an optional note. | `Approved.` or `Rejected.`, then the note. |
| `decide` | A text field and **Send**. Choice buttons when the text has a Markdown list under a `Choices` heading. | `Choice: CHOICE`, then the note. Or the typed text. |

The page asks for a confirmation before each send or dismissal. The answer is an Owner message to the thread of the item, with `replyTo` set to the item ID. It uses the same delivery rules and rate limit as a message from the Agents page. The service then sets `closedAt` on the item, and the item moves to **Done**. A closed item refuses a second answer with HTTP 409.

Select **New message** to start a thread with the Boss or a project that has an `orch` pane. Type a message and confirm the send. The page applies the same send limit and safety gates as other Owner messages. It opens the new thread in **Sent**. Use the reply box at the bottom of a conversation to reply to its last open agent message. When that message is an open answer, approve, or decide item, the item form replaces the reply box. The page asks you to confirm each reply.

Select one or more checkboxes under **Needs you**, then select **Dismiss selected**. On a phone, select **Dismiss N** in the selection bar. A check box selects all items of its conversation. Select **Dismiss** on one item to dismiss it alone. Dismissal sets `closedAt`, `readAt`, and `dismissed: true`. It sends no message. You cannot dismiss an item that is already closed or does not need action.

The choices are the list items under a Markdown heading with the text `Choices`, for example `## Choices`. The list ends at the first line that is not a list item. The page shows at most 10 choices.

### Automatic refresh

The page reads new data every 30 seconds and on each state event. It changes only the parts of the page that changed. Each row, conversation, chat, and bubble has a key (`data-key`), and `public/keyed.js` keeps the DOM node of each key. The page keeps the open conversation, the selection, the typed text, the focus, and the caret. It keeps the scroll position of the list and of the conversation. A new folder or a new conversation starts at the top.

The refresh waits while you type or scroll. It runs 3 seconds after your last input or scroll. The Chat page uses the same rule.

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

## Phone app view

On a screen up to 760 px wide, the Mailbox and the Chat are app views. The page header, the menu bar, and the page padding do not show. The page has the height of the visual viewport. The page itself does not scroll. Only the list, the conversation, or the chat log scrolls.

- The top bar is 52 px high, plus the top safe-area inset. It holds the menu button and the page title with its count. In a conversation it holds the Back arrow, the avatar, and the name.
- The menu button opens a drawer. The drawer holds the Mailbox folders on the Mailbox, the links to all pages with the Needs-you and Chat counts, and **Help**. A dot on the menu button shows unread items on the other page.
- The Mailbox list has a floating **New** button at the bottom right.
- In a Mailbox conversation, the actions of the open item sit in a bar at the bottom edge, above the bottom safe-area inset. The bar holds the item actions from [Answer an item](#answer-an-item):
  - An approval: **Approve**, **Reject**, a note button, and a **Dismiss** button. The note button opens the note field above the buttons.
  - A decision with choices: one button for each choice, then a note button and **Dismiss**. The choice buttons wrap onto more rows, so each choice stays in view. The note button opens a field for another answer or a note, with **Send**.
  - An answer, or a decision without choices: **Dismiss**, the answer field, and **Send** in one row.
- The item that the bar holds is the open item of the last agent message. An older open item keeps its form in its message. A conversation without an open item shows the reply field and **Send** in one row at the same place.
- In **Needs you**, select one or more check boxes to start the selection. A selection bar then replaces the **New** button at the bottom edge. It shows the count, **Clear the selection**, **All**, and **Dismiss N**.
- On a phone the conversation replaces the list. Its title in the top bar is the page heading (`h1`). On a desktop the list title is the `h1` and the conversation title is an `h2`.
- When the phone keyboard opens, the visual viewport gets smaller. The page sets `--app-h` from `visualViewport.height`, so the composer, the reply field, and the action bar stay above the keyboard. The viewport meta has `interactive-widget=resizes-content` for Chrome on Android.
- Buttons and fields keep a touch target of at least 44 px and a font size of 16 px.

A check can force a theme with `?theme=light` or `?theme=dark` in the page address.

## Chat page

The Chat page at `/chat` is the conversation view of the Owner. One chat holds the messages between the Owner and the Boss. One chat holds the messages between the Owner and a project orchestrator. A worker has no chat. Use the Mailbox for items that need an answer, an approval, or a decision. Use the Chat for a normal conversation. Both pages read the same message records.

The page has no large heading. On a desktop the chat list and the open chat are two panes that fill the window below the page header. Above the conversation there is one slim bar. It holds the avatar of the chat, the chat name, and a link to the Mailbox. On a phone the bar also holds the Back arrow. See [Phone app view](#phone-app-view).

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
- A chat list row is 72 px high, with a 52 px avatar. The first line holds the title and the time. The second line holds the last message and the unread badge. An unread row is bold.
- A run of bubbles from one sender forms a group. The inner corners of a group are tight. A short chat sits at the bottom of the log, next to the composer.
- The theme sets the colors. The page keeps its contrast in the light theme and in the dark theme.

### List

Each row shows the chat title and the time on the first line. The second line shows the last message on one line and the unread badge. The last message is cut with an ellipsis. Each row starts with the avatar of that chat. A mail report shows as `Report: TITLE`. The chat with the newest last message comes first. A chat with no message comes after a chat with a message. The menu badge shows the total unread count of all chats. A mail report does not count as chat unread.

The page reads `GET /api/chats`. It follows the `message` event on `GET /api/events`. It never reloads the page.

The automatic refresh keeps the scroll position of the chat list and of the conversation. It waits 3 seconds after your last input or scroll. See [Automatic refresh](#automatic-refresh).

### Conversation

Select a row to open the chat. The conversation shows the messages in time order. An Owner message sits on the right. An agent message sits on the left. The avatar of the agent shows at the first message of each run of messages from that agent. It does not show again inside the same run. Each bubble shows the text as safe Markdown, the sender, and the time. A wide table or code block scrolls sideways inside the bubble. An Owner bubble also shows the delivery state from the record: `queued`, `delivered`, `relayed`, or `failed` with the reason.

Opening a chat calls `POST /api/chats/<thread>/read`. It marks each chat record to the Owner as read. A mail report keeps its own read state. The page stops the count for that chat. A read-only preview refuses the read, so the count stays.

Scroll up to read older messages. The page asks for the page before the oldest message while the service sets `more` to `true`. The page keeps your reading position. The 30-day retention of the store sets the oldest message that the page can show.

A new message goes at the bottom. The page scrolls down only when you already read the newest message. Otherwise the page keeps your position.

While you read older messages, a round arrow-down button shows at the bottom right of the message list, above the composer. Its name is `Jump to the newest message`. A small badge on the button shows the count of new messages. The badge shows `99+` above 99. Select the button, or press Enter on it, to scroll to the newest message. The badge clears. The button hides when the list is at the bottom. When the system setting `prefers-reduced-motion` is on, the page jumps without animation. On a phone, the touch target is 44 px wide.

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

- On a screen up to 760 px wide, the header is one row: the Herdr Boss mark, a menu button with the current page name, the watch symbol, the three top-bar icons, and **Help**. On a screen below 375 px the icons move to a second row. The page name in the menu button shortens before the header wraps. Select an icon to open the Chat or that Mailbox folder. Select the menu button to open the page menu. The menu closes after you choose a page and when you press Escape.
- On a phone the header does not show the update time. A warning line under the header shows that the page lost its connection to the service.
- On a phone, the long sections of a project page start collapsed. Select a section title to open it. The browser remembers each open section for that project in its local storage. The Now section, overall progress, the current frontier, and the board stay open.
- Project cards become compact. They show the name, mode, status line, and task bar.
- Tables show stacked rows with a label for each value. The page does not scroll sideways at 393 px. The project table on the Overview shows one short block for each project, without labels: the name and workers on the first line, the orchestrator and the policy on the second line, and the published status on the third line.
- On a screen up to 760 px wide, a link that acts as a button, such as **Details** or **Project details**, is at least 44 px high.
- On a screen up to 760 px wide, each text field, number field, select, and text area uses a font size of 16 px. This stops iOS Safari from zooming the page when you select a field. Pinch zoom stays on.
- On a screen up to 760 px wide, each button, select, text field, checkbox with its label, and menu link is at least 44 px high.
- The page does not scroll sideways at any width from 320 px. A wide table or code block scrolls inside its own box.
- A fixed bar, such as the **Apply policy** bar, moves up when the on-screen keyboard opens.
- The expanded browser view fills the screen. One compact toolbar holds the controls. The address field and **Go** use the full width of one row. **Back**, **Forward**, and **Home** share the next row. The text field and key controls appear only while **Control browser** is on. The screenshot fills the rest of the height, in portrait and landscape.
- The dashboard sets the home-screen web app meta tags. To add the dashboard to a phone home screen, open it in Safari, open the Share menu, and select **Add to Home Screen**.

### Check the phone layout

The static checks in `test/phone-layout.test.js` run in `npm test`. They check the viewport meta, the 16 px field size, the 44 px target size (also for class rules that set a smaller height), the dynamic viewport units, and the scroll boxes. They do not open a browser.

`npm run check:phone` runs `test/phone-check.mjs`. The script needs the project browser. It starts a read-only preview, opens each page, the Help panel, the menu, the new-message form of the Mailbox, an open message, and an open chat at 320, 375, 390, and 430 px, and fails when a page is wider than the screen or a field has a font size under 16 px. At 375 px and wider it also fails when the header is more than one row high (above 64 px). It prints a warning for each target under 44 px. Add `--strict-targets` to fail on those too. Add `--base URL` to check a running dashboard. A state that needs data, such as an open message, is skipped when the dashboard has none. Add `--only /mailbox,/chat` to check some pages.

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

The Analytics page shows the chart **Denials and permission prompts**: a heat map of the causes by day, for one harness or for all harnesses. Its Details hold these tables:

- A table of the last 7 days by cause and project, with a count for each day.
- A small table of counts by harness, model, and cause. It shows the top 10 rows, then the number of extra rows.
- A total for each harness, on the harness switch.
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

A suite pass matches only when the repository, the tree hash, the command, the Node version, and the hash of each lockfile in the repository root are the same. Herdr Boss hashes `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`, and `go.sum` when they exist. The tree hash covers a tracked lockfile. The lockfile hash also covers an ignored lockfile. A tree with no lockfile has the same key as before.

### Machine samples

The engine writes one machine sample line for each UTC minute into `machine-samples.jsonl` in the data directory. The file uses mode 0600. It is append-only JSONL. The engine writes no line when it cannot read the machine or when actions are off. A tick that comes late leaves a gap. The engine does not fill a gap. A write error never stops or slows a tick.

Each line has these keys:

- `at`: the sample time, cut to the whole minute, as a UTC ISO string.
- `l1`, `l5`, `l15`: the 1, 5, and 15 minute load.
- `cpus`: the core count.
- `cpu`: the summed CPU of all processes, in percent of all cores.
- `memFree`, `memGB`: the free memory in percent, and the total memory.
- `swapMB`, `swapTotalMB`: the swap in use and the swap total.
- `holders`: the kinds (`suite`, `push`, `manual`) of the live `full-suite` lock holders.
- `waiters`, `waiterKinds`: the number and the kinds of the tickets in the `full-suite` queue.

A key has the value `null` when the collector cannot read it. A line holds no project name, pane id, path, or command.

When the file passes 3 MB, the engine renames it to `machine-samples.1.jsonl` and replaces the older rotated file. Two files hold about 18 days.

Two definitions classify a sample:

- An overload minute has swap above 90 percent with at least 1 GB in use, or a 5-minute load above 3 times the cores.
- An idle-wait minute has at least one waiter in the `full-suite` queue while `cpu` is below 50.

`GET /api/machine-hours?days=N` returns the samples of the last N days, grouped by the local hour of the day. `days` is a whole number from 1 to 14. A missing or invalid value gives 14. The route reads both sample files, skips a line that does not parse, and allows GET in the read-only preview.

The response has these keys:

- `days`, `daysWithData`: the window, and the number of local dates that hold a sample.
- `hours`: 24 rows. Each row has `hour` (0 to 23), `samples`, `overloadMin`, `idleWaitMin`, `swapPeakPct`, `memFreeMin`, and `holderKinds`.
- `totals`: `samples`, `overloadMin`, and `idleWaitMin` over all hours.
- `coverage`: `samples` divided by `days` times 1440.

`overloadMin` and `idleWaitMin` count samples, and one sample is one minute. A minute without a sample is missing data. It is not a quiet minute. `swapPeakPct` and `memFreeMin` are the highest swap percent and the lowest free memory of the hour, or `null`. `holderKinds` counts the samples for each holder kind. The response holds no project name, pane id, or path.

The route keeps its result for 60 seconds for each value of `days`. The summary counts a repeated minute once.

The **Analytics** page shows the hours in the block **Machine overload and idle waiting by hour**. The chart has two bars for each local hour of the day. The bars show the mean minutes per day of overload and of idle waiting, from 0 to 60. The chart title gives the two daily means. A tooltip on hover, focus, or touch gives the values of one hour. A hatched bar marks an hour with fewer than 10 samples. A note shows when `coverage` is below 0.5. The details element under the chart holds the same 24 rows as a table. On a phone the chart scrolls sideways inside its own box.

Before it removes a worktree, `herdr-boss worktree prune --apply` checks for processes whose current working directory is inside that worktree. It reports parent-PID-1 processes in missing or prunable worktree paths. Stop those processes before cleanup. Herdr Boss removes no worktrees if it cannot scan process directories. It also keeps worktrees that are dirty, unmerged, primary, used by a live pane, or uninspectable. Herdr Boss sends a notice about a parent-PID-1 process in a removed worktree only to that repository's `orch` workspace.

Before it removes a worktree, `worktree prune --apply` copies the worker reports `report.md`, `report.json`, and `brief.md` to `.orchestration/reports/<worker name>/` in the main checkout. It never overwrites an archived file. If the folder already holds a report, it writes the new reports to `<worker name>-<UTC time>`. If the copy fails, it keeps the worktree. Use `--no-archive` to skip the copy.

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/machine-hours?days=N` | The machine samples of the last N days (1 to 14, default 14) by local hour of day: overload minutes, idle-wait minutes, swap peak, lowest free memory, holder kinds, and coverage. |
| `GET /api/analytics` | The notice counts for each pane and local day of the last 7 days, and the machine timeline of the last 24 hours in columns of 10 minutes. Numbers, lock kinds, and pane IDs only. The service keeps the result for 60 seconds. |
| `GET /api/spend?days=N` | The token use and cost per day, role, and harness for the last N days (1 to 90, default 7), the cost label `API-price equivalent`, the models with `unconfirmed` prices, the harness log status, and the unread log bytes. |
| `GET`, `PUT /api/settings/prices` | Read the price table and the override, or replace the override. See Token use and spend by role. |
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
