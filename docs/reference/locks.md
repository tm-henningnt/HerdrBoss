# Locks and leases reference

## Denials and permission prompts

Every 15 minutes, the service reads the Claude, Codex, OpenCode, and Pi logs for denials. The scan runs beside the engine tick, only when the engine acts. Two scans never run at the same time. The dashboard preview does not scan. One scan reads at most 20 MB in total. It continues from the saved byte offset of each file. A file with a new inode or a smaller size starts again at byte 0. The offsets are in `memory.json` under `denialScan`. The scan also reads Claude subagent sessions in `<session>/subagents/`. A Codex escalation is a `function_call` row, such as `exec_command`, that sets `sandbox_permissions` to `require_escalated`. The scan counts each call once by its call ID, time, and cause. The saved list of counted IDs is also under `denialScan`. A command that only quotes the escalation text, or that reads the session logs, is not an escalation.

Herdr Boss keeps only counts in `denials.json` in the data folder, with mode 0600. Each record has the UTC day, the harness, the cause, the project, the model, and the count. The model comes from session metadata. Herdr Boss uses `unknown` when the model is missing. The file keeps 30 days. It holds no message text, command, argument, or path. What each harness counts is in [the harness setup](../harness-setup.md#denial-counts).

Herdr Boss maps each record to a project by its working folder. A folder inside a registered repository belongs to that project. A worker worktree inside `~/Projects/.herdr-wt/<repo>/` or inside a sibling `<repo>-wt-<name>` also belongs to that project. The registered repositories are in `project-repos.json`. All other folders count as `other`.

The Analytics page shows the chart **Denials and permission prompts**: one stacked bar for each day, for one harness or for all harnesses. See [Denials per day](#denials-per-day). Its Details hold these tables:

- A table of the days in the chart, with the refused and approved counts, the total, and the harness changes in the window.
- A table of the last 7 days by cause and project, with the outcome of each cause and a count for each day.
- A small table of counts by harness, model, and cause. It shows the top 10 rows, then the number of extra rows.
- A total for each harness, on the harness switch.
- A trend arrow. It compares the last 24 hours with the mean of the 6 days before them.
- A read-only line with the limits: the scan interval, the bytes for one scan, the days kept, and the rise rule.

The last 24 hours are the count of today (UTC) and the part of yesterday inside the window. A cause rises when its last 24 hours are above 2 times its 6-day mean and above 10 events. Then the page and the Owner section of the bulletin show "Discuss this trend with the Boss." Herdr Boss sends no pane prompt and adds no project rule for a denial trend.

The first scans read the older logs at 20 MB for each scan. While more than 1 MB of logs is unread, the counts of older days are not complete. Then the page shows the unread size, and neither the page nor the bulletin shows the note.

### Denials per day

The chart shows the events for each day. A day is a UTC day, the same day as in `denials.json`. Each bar has two parts. The legend gives the total of each part for the range.

- **Blocked or refused** (solid): a classifier refusal (`classifier:`), a sandbox error (`sandbox:`), a Herdr guard block (`guard:`), an OpenCode permission denial (`permission:<type>`), and an OpenCode prompt that got no answer in 10 minutes (`permission:unanswered:`).
- **Escalation approved by a rule** (outlined, lighter fill, same color): a Codex escalation request (`escalation:request`). An approved escalation is friction, not a failure.

The scan does not keep the reply to an OpenCode prompt that was answered (`permission:asked:`). A cause with no known outcome counts as refused. The Details of the chart show the number of such events.

The range is 3 days by default. The buttons on the chart select 7 or 30 days. The browser remembers the choice in its local storage. The server sends the last 30 days in `/api/analytics`, and the page cuts the range.

#### Harness change markers

A marker shows the day on which a harness fix went in. It is a thin vertical line with a small flag at the top. Hover, focus, or touch the flag to read the date, the harness, and the label. The arrow keys move between the bars and the flags. The Details of the chart list each marker. When the switch selects one harness, the chart shows only the markers of that harness.

The markers come from `harness-changes.jsonl` in the data directory. Each line is one JSON object with these fields:

| Field | Meaning |
|---|---|
| `date` | Required. A real day in the form `YYYY-MM-DD`. |
| `harness` | Required. One of `claude`, `codex`, `opencode`, `pi`. |
| `label` | Required. Text of 1 to 80 characters, with no control character and no bidi or zero-width format character. |

Example line: `{"date":"2026-01-05","harness":"codex","label":"Escalation rule added"}`.

Add a line with `herdr-boss harness change <harness> <label> [--date YYYY-MM-DD]`. Only the pane labeled `boss`, a pane labeled `orch`, and a plain terminal can run the command. A worker pane is refused. The default date is today in local time. The reader skips a line that is not valid JSON or has a bad field. It reads the last 64 KB of the file and keeps the last 200 lines. It never stops the page. The chart shows the markers that fall inside the last 30 days.

## Resource leases

A resource pool is a set of scarce items that several projects share, for example local serve ports. A project leases one item, uses it, and releases it. Herdr Boss keeps the leases in `leases.json` in its data directory, with mode `0600`. Each change holds the mutation lock of the machine locks.

Lease a shared resource with `herdr-boss lease acquire POOL` or `worker start --lease POOL`. Never pick a port from a pool by hand. The commands are in [Resource leases](../cli.md#resource-leases).

Define each pool in `resourcePools` in `~/.herdr-boss/config.json`:

| Key | Meaning |
|---|---|
| `name` | Required. A slug of lowercase letters, digits, and hyphens. |
| `items` or `range` | Required. Use exactly one. `items` is an array of strings. `range` is `"LOW-HIGH"`, a single number, or a comma-separated list of both, for example `"8000-8004,8010"`. |
| `split` | Optional. Project slugs to item lists. Each item must be in the pool and in one list only. A project takes its own items first. |
| `env` | Required. The variable that `worker start --lease` sets in the worker pane. |
| `ttlMinutes` | The lease time. The default is 240. |
| `check` | `"tcp"` or `null`. `"tcp"` means that each item is a local port. The default is `null`. |
| `graceMinutes` | Kept for older configs. It has no effect on reclaims. |
| `idleMinutes` | The minutes that a leased port can have no listener before Herdr Boss reclaims the lease. A whole number from 1 to 240. The default is 20. |
| `waitSeconds` | The seconds that `lease acquire` waits for a free item when `--wait` is not set. A whole number from 0 to 3600. The default is 0, which means no wait. |
| `portEnv` | Optional. Environment variables with a value for each port: `{ "VARIABLE": { "8005-8009": "value" } }`. A key is a port, a range, or a list of both, and each port must be in the pool. A value is a string of 1 to 200 characters with no whitespace. A lease hands the worker the value of its port. A port without an entry gets no variable. Keep this key in the private config file only. |

A pool is a ports pool when all items are numbers and the pool has `check: "tcp"` or a port from 1024 up. A ports pool holds at most 100 ports from 1024 to 65535 with no duplicate. It cannot hold the dashboard port. The idle rule and the `portEnv` values apply to a ports pool.

The pool `project-browsers` is built in. Herdr Boss adds it to the config pools. Do not define a config pool with this name: it is an error. See [Port leases](browsers.md#port-leases).

Herdr Boss validates the pools when it loads the config. An invalid pool list gives no config pools. The built-in pool stays. The lease commands then fail and name each error, and the bulletin shows each error. Do not put a secret in a pool. An unknown key is an error.

Herdr Boss reclaims a lease on each service tick and before each `lease acquire` or `lease release`. It reclaims a lease when one of these conditions is true:

- The pane of the lease is not in a successful Herdr pane list.
- The run record of the worker has `finishedAt`.
- The time `expiresAt` of the lease is in the past.
- The pool is `project-browsers`, and no matching Chrome process runs on two ticks in a row. This rule is the only rule for this pool.

A lease of a ports pool also ends in these cases:

- The lease has a bound server process (`--pid` or `lease bind`), and that process is gone. Herdr Boss releases the lease within one tick. A process with a different start time than the bound one counts as gone, so a reused process ID does not keep a lease.
- The port has no listener for `idleMinutes` (default 20). Herdr Boss probes `127.0.0.1` on the port with a connect timeout of 300 ms. A refused connection means no listener. The idle time starts at the first tick that finds no listener. A listener resets it. This rule covers an unbound lease that no server ever binds, and a bound server that lives but does not answer.

The grace time `workers.leaseGraceMinutes` (default 30) bounds the idle rule of a pool. A lease of a pool with an idle rule that has no bound process and no listener ends after the grace time, also when the idle time of the pool is longer. A pool without an idle rule, a lease of a missing pool, a live worker pane, and a project lease are never reclaimed by the grace time.

`worker collect` and `worker park` give back every lease that names the worker, in every pool. This release includes a lease that the worker took after its start. The release keeps a lease of another worker and a lease of the project.

A port with a listener and a living bound process is never reclaimed by the idle rule. The holder of an idle lease gets one notice: `Your lease of port N in pool serve-ports was reclaimed after 20 minutes without a listener. Start serve-live again to take a port.` A holder that takes a lease keeps it until its TTL only while its server answers on the port. `lease acquire` never gives out an item that a live holder has.

Take a port before the server starts, start the server, then bind the lease to the server process with `lease bind POOL PORT --pid PID`. A caller that knows the PID at once uses `lease acquire POOL --pid PID`. See [Resource leases](../cli.md#resource-leases).

A port can also be in use without any lease. Each tick probes every free item of a pool with an idle rule. A listener on a free item is an unleased listener. It has no lease, so no project holds it and the idle reclaim does not apply. The Allocation page shows one warning row for it with the port, the PID, the process name, the owner project, and the age. The head of the pool counts them as `listening with no lease`. Herdr Boss finds the owner from the working directory of the process and the project registry, and reads no command line and no environment. The registry path and the worktree folder of a project both count, so a server in a worker worktree has an owner. When two paths hold the directory, the longer path wins.

An unleased listener with a known owner gives one notice to the orchestrator of that project after 10 minutes. The notice tells the orchestrator to take the lease and to bind the PID of the server. Herdr Boss never takes the lease itself. An unleased listener with an unknown owner gives no notice, because no project can act on it. Resolve it by hand: find the process with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, then either bind the lease of that project or stop the process.

`lease acquire` gives out a port that nothing listens on before a port with a listener and no lease. The list comes from the last tick, so it can be a tick old. `--prefer PORT` gives out that port even when a process listens on it.

A pool can hand a value to each port, for example a client ID, in `portEnv`. `worker start --lease` sets the variable in the worker pane. `lease acquire --env-file FILE` writes it to a file that the shell sources. No command, log, event, report, API answer, or page shows the value. `lease list` shows `set` or `not set`. Herdr Boss logs one `lease` event for each reclaimed lease, with the pool, the item, the project, and the reason. When the holder pane is still alive, for example after the TTL, the engine sends it one notice. The bulletin has a `Resource leases` section with one line for each pool. The line shows each item with its holder, its age, and `borrowed`, or `free`. The line of `project-browsers` shows only the leased ports and the number of free ports.

## Project locks and worktree cleanup

Use a project lock when one task must finish before another task starts in the same Git repository. Run the commands from a verified `orch` or `boss` pane:

```sh
herdr-boss lock acquire release-review
herdr-boss lock list
herdr-boss lock release release-review
```

All linked worktrees of one repository share its locks. The `full-suite` lock is machine-wide. All repositories on this machine share it, and `lock list` shows its scope as `machine`. Herdr Boss keeps lock files in a private `locks` directory under its data directory. A lock records its name, owner pane, PID, kind, safe acquire command, and acquisition time. A `suite` or `push` lock uses that command's PID. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual `full-suite` lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock, and the engine warns the former holder. Release a lock from its owner pane. When exactly one live record belongs to the pane, no selector is needed. With several live records in that pane, use `lock release NAME --slot N` for a short slot or `lock release NAME --slot long` for the long slot. Automatic suite and push cleanup selects the exact record that the command acquired. A token-based push re-entry release is a no-op, including with either slot selector. The outer push owner can still release its exact acquired record. Another pane can release it only after the owner PID has exited, the owner pane has closed, or a manual `full-suite` lock has expired. Use `--wait SECONDS` to wait for an active lock. Enter a whole non-negative number. Herdr Boss takes over a stale lock and prints its previous pane and PID.

Herdr Boss writes the lock ledger, `lock-ledger.jsonl`, in its data directory. The file is append-only JSONL. Each acquire adds one `acquire` line. It holds the time, lock name, project, kind (`suite`, `push`, or `manual`), holder pane, tree hash when the checkout is clean, and `waitMs`. Each release adds one `release` line with the same fields and `holdMs`. A takeover of a stale lock adds a `release` line with `takeover: true`. A busy acquire adds a `busy` line, and an acquire whose wait ends first (exit code 75) adds a `timeout` line. Both have `waitMs`. A re-entrant suite under a push adds lines with `reentrant: true`. Its release line holds the time that the suite ran. The medians skip re-entrant lines, `busy` lines, `timeout` lines, and the hold time of takeover lines. When the file passes 5 MB, Herdr Boss renames it to `lock-ledger.1.jsonl` and replaces the older rotated file. It starts a new `lock-ledger.jsonl`. The dashboard reads only the current file. The ledger never blocks a lock change.

At startup, the process can use legacy defaults for a missing, invalid, or partial policy. On a retry, a missing, invalid, or partial policy cannot widen admission. The waiting process keeps its last validated settings. It waits until a complete valid lock policy returns, even if a slot becomes free. A complete lock policy has slot capacity, the short job limit, and all guard fields.

A capacity or guard change applies at each admission attempt, including a queued job. A queued ticket keeps its prediction, short-limit classification, and sequence. A short-limit change classifies new tickets. With one slot, all tickets use the exclusive long lane. After a capacity reduction, every existing holder still counts. New jobs wait until total capacity and slot capacity allow admission. The guard identifies a long job by its lane. A short job that borrows the long slot does not activate the guard. The guard reads the newest sample at or before the current time. A future sample cannot hide a current sample. A missing usable sample or one older than three minutes passes.

A new manual queue ticket uses the PID of the waiting CLI process. The acquired manual holder uses the pane shell PID. A canceled new waiter becomes stale when its CLI process exits.

The Locks panel and `lock list` queue data show effective admission capacity separately from saved capacity. During legacy exclusivity, effective capacity is one slot and queue positions follow global FIFO order. The short lane has no admission capacity until the eligible legacy records drain.

A holder or queue ticket without a `lane` field is a legacy record. A legacy ticket constrains admission only while its PID and pane are live and it is younger than 30 minutes. The constant `LEGACY_TICKET_TTL_MS` sets this limit. Herdr Boss excludes an older ticket from the queue display. The next admission removes it. This limit releases a canceled old manual waiter whose shell PID stays live. A live legacy holder still requires exclusive admission as before. While a live legacy holder or an eligible legacy ticket exists, admission uses one exclusive long slot and one global FIFO queue. No short second job starts. Existing holders finish before another job starts. Normal lane admission returns after the eligible legacy records drain. A suite hook can re-enter a legacy push with its live token. Old code cannot read a new short-slot record. An old hook cannot re-enter a push in that short slot. This old-code limit is accepted. Do not treat the long record filename as full protocol compatibility.

Herdr Boss publishes the queue sequence with an atomic rename. If a legacy writer left an invalid sequence, the next guarded write starts above the highest live ticket sequence. A valid sequence also remains a lower bound.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. A short job can wait in the short lane when the machine guard reaches a configured limit.

```sh
herdr-boss suite -- npm test
herdr-boss push origin main
```

`herdr-boss push` takes the lock only when a pre-push hook exists and no suite pass covers the tree. When the last hook run of the repository has a pass for the clean tree, the push takes no lock and skips the queue. It releases the lock also when the push fails, and it returns the exit code of `git push`.

To skip a suite after a change to docs only, run `herdr-boss suite --skip-docs -- <command>`. The run skips when the tree is clean and every file that changed since the last pass of the same command is a doc that no code reads. A doc is `LICENSE` or a `.md` file outside `src/`, `public/`, `test/`, `kit/`, and the other code folders. A JSON file or another file under `docs/` is never a doc. A symbolic link is never a doc. Code reads a doc when a test file, or a file under `src/`, `test/`, `public/`, or `kit/`, contains its path or its name without the extension, or reads its folder. The command prints `suite: skipped, only docs changed` and records the skip as a pass. Any other change runs the suite.

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

## Memory by class

The engine reads the process table every 5 minutes while actions are on. It adds the resident memory of the processes of each class and writes one line to `memory-samples.jsonl` in the data directory. The file uses mode 0600. It is append-only JSONL. The engine takes no sample while the action state is off. A sample that cannot be read waits for the next 5 minutes. A write error never stops or slows a tick.

Each line has these keys:

- `at`: the sample time, cut to the whole 5 minutes, as a UTC ISO string.
- `mb`: the resident memory in megabytes of each class: `claude`, `codex`, `browsers`, `mcp`, `vitest`, and `other`.

A line holds no command line, no path, no pane ID, and no project name. The engine reads the process table with one `ps` call for the resident size and the command of each process, under `LC_ALL=C`, with a timeout of 10 seconds. It adds each size to a class and keeps only the totals. The call runs without await, so a slow or hung `ps` never delays a tick. The engine runs one call at a time and starts the next one only when the call before it has ended. A call that fails or times out writes nothing and waits for the next 5 minutes.

One definition assigns each process to a class. A class matches the program that runs, either the executable or the script of an interpreter. An argument and a folder name never make a match on their own. The engine tests the classes in this order and stops at the first match:

1. `browsers`: the command names a browser, such as Google Chrome, Chromium, or chrome-headless-shell.
2. `mcp`: the command names a model context protocol server, such as chrome-devtools-mcp, node_repl, cua_repl, or a name that starts with `mcp-server-`. A file or an option with the word mcp is no server name.
3. `claude`: the program is `claude` or `claude-code`. A folder called `claude-x` is no match.
4. `codex`: the program is `codex`. A folder called `codex-tools` is no match.
5. `vitest`: node runs a vitest program, or the program itself is vitest.
6. `other`: every other process, including Herdr Boss itself.

When the file passes 3 MB, the engine renames it to `memory-samples.1.jsonl` and replaces the older rotated file. Two files hold about 20 days at one sample each 5 minutes.

`GET /api/analytics` returns the samples in the field `memoryByClass`. The field has these keys:

- `hours`, `bucketMin`: the window of 24 hours, in buckets of 60 minutes.
- `classes`: the class keys, in the order above.
- `points`: 24 buckets, oldest first. Each bucket has `at`, `samples`, `mb`, and `total`. `mb` holds the mean memory of each class over the samples of the bucket, rounded to whole megabytes, and `total` holds the sum of the classes. A bucket with no sample holds zero for each class.
- `peak`: the higher of the highest bucket mean and the highest single sample of each class in the window.
- `latest`: the newest sample of the window, with `at`, `mb`, and `total`, or `null` when the window holds no sample.

The route keeps its result for 60 seconds. It skips a line that does not parse. The response holds no project name, pane ID, path, or command.

The **Analytics** page shows the buckets in the block **Memory by class**. The chart has one stacked bar for each hour of the last 24 hours. A bar is the mean of the samples of that hour, so the top of a bar reads the memory of all processes at that hour. An hour without a sample has no bar. The chart title gives the highest total of the window and the total of the newest sample. Details lists each class with its latest sample and its highest mean.

### Worker startup and pane cleanup

The CLI and service set one lifecycle port at startup. The lock module uses it for Herdr calls and caller checks. The worker module uses it for lease operations. This keeps static imports one way. Lock ownership, lease records, worker commands, and API responses stay the same.

OpenCode starts share a machine-wide lock through brief delivery. Another start waits up to 300 seconds, including the time in the mutation guard. The lock checks the owner PID and process start time. It replaces a stale, unreadable, or invalid owner record. Startup sends the brief only after the TUI is idle or done and accepts interactive input. It can relaunch a failed TUI twice in the same pane. It leaves a busy or reassigned agent alone. The run record shows the number of launch attempts in `startAttempts`.

After a final start failure, startup closes the failed pane only when ownership and a safe agent state are confirmed. It archives the brief, available reports, and run record in `.orchestration/reports/<worker name>/` in the main checkout. It removes the active run record after the archive succeeds. It removes the worktree and branch only when the worktree has no changes and no commits beyond the start base. The worker name can then be reused. The error states why it kept any resource.

After a successful `worker collect`, the service closes the worker pane with `herdr pane close`. The default delay is 2 minutes. Set **Worker pane close delay** in Settings to change it. Use `--keep-pane` to keep the pane open. The service checks the run and agent before it closes the pane. It waits while the agent is working or blocked. `worker park` keeps the pane and its session open. Use `worker unpark` to resume that session.

Before it removes a worktree, `herdr-boss worktree prune --apply` checks for processes whose current working directory is inside that worktree. It reports parent-PID-1 processes in missing or prunable worktree paths. Stop those processes before cleanup. Herdr Boss removes no worktrees if it cannot scan process directories. It also keeps worktrees that are dirty, unmerged, primary, used by a live pane, or uninspectable. A pane is live while it exists in the current pane list and its agent is not `done`. A parked pane stays live until it closes. An unknown agent state stays live. A done pane still needs to pass the process checks. Herdr Boss sends a notice about a parent-PID-1 process in a removed worktree only to that repository's `orch` workspace.

Before it removes a worktree, `worktree prune --apply` copies the worker reports `report.md`, `report.json`, and `brief.md` to `.orchestration/reports/<worker name>/` in the main checkout. It never overwrites an archived file. If the folder already holds a report, it writes the new reports to `<worker name>-<UTC time>`. If the copy fails, it keeps the worktree. Use `--no-archive` to skip the copy.

