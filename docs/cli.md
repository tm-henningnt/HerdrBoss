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

## Project status

| Command | Action |
|---|---|
| `herdr-boss publish SLUG FILE` | Validate a status file and install it for `/projects/SLUG`. Use `-` for standard input. Schema: [project-status.md](project-status.md). |

`publish` also checks `AGENTS.md` at the Git top level of the current directory, when that file exists. It prints each finding to standard error as a warning. It publishes the status in all cases. The published record gets `agentsCheck: { checkedAt, errors, warnings, file }`. The record holds only the counts and the repository-relative file name. The project page shows a warning line when `errors` or `warnings` is more than 0. The status file can also hold `kitRevision`, the kit revision that the orchestrator loaded. The project page compares it with the current kit revision.

The first `publish` of a slug registers the project. It records `{ slug, repo, remote }` in `project-repos.json` in the data folder, with mode 0600, when the Git top level exists. `repo` is the Git top level. `remote` is the `origin` URL without a user name and a password. A later publish keeps the first record. For a new slug, `publish` runs `harness sync --codex-only` and prints its result as `warning: harness sync:` lines.

## Owner messages

The Owner sends messages from the Organization page. The Boss and the orchestrators reply with these commands. The store is `messages.jsonl` in the data directory.

| Command | Action |
|---|---|
| `herdr-boss say [--reply-to ID] [--action answer\|approve\|decide\|read] "TEXT"` | Write a reply for the Owner. Run it from the pane labeled `boss` or from a pane labeled `orch`. |
| `herdr-boss messages [THREAD]` | Print the records of one thread as JSON, oldest first. Without `THREAD`, print the records of all threads. `THREAD` is `boss` or a project slug. |
| `herdr-boss messages relay ID... --by boss` | Mark queued Owner messages as relayed by the Boss. Only the pane labeled `boss` can run this command. Herdr Boss never sends a relayed message. |
| `herdr-boss mail post --to owner [--title TEXT] [--action read\|decide\|approve\|answer] FILE` | Post a Markdown report for the Owner in the `boss` thread. Only the pane labeled `boss` can post. |
| `herdr-boss mail close ID... --note TEXT` | Close open Mailbox items as answered through the Boss. Only the pane labeled `boss` can run this command. It sends no message. |

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

`worker start` counts the live panes of each worker tab in `herdr pane list`. It uses the first worker tab in label order that has fewer than 3 panes. It runs `herdr pane split` from the newest pane in that tab. When all worker tabs are full, it runs `herdr tab create` with the lowest free label, for example `--label 'Workers 2'`. The worker then uses the root pane of the new tab. A listed worker tab with 0 live panes counts as free. Herdr has no pane to split in that tab, so `worker start` creates a new tab with the same label.

If the start fails before the agent starts, `worker start` closes only its own pane. It closes a worker tab only when the same start created that tab. The dry-run plan names the chosen tab, its tab ID, and its pane count, or `new tab`.

Set `workerPanesPerTab` in `.herdr-boss.json` to change the pane limit for each worker tab. The value is an integer from 1 to 6. The default is 3.

`worker start` waits for the shell prompt or a stable shell screen. It sets `DISABLE_UPDATE_PROMPT=true` and `DISABLE_AUTO_UPDATE=true` in new panes. If it finds an interactive question, it stops and tells the orchestrator to answer it in a shell once.

`worker start` sets `HERDR_ENV=1` in a new pane when `--kind` is `codex`. The agent in that pane then runs Herdr commands. Panes for the other kinds keep the pane environment that Herdr gives them. The dry-run plan prints the same `herdr pane split` or `herdr tab create` command.

A Codex tool shell can run under a shared app-server daemon with another environment. For `--kind codex`, `worker start` therefore adds `-c shell_environment_policy.set.<NAME>="<value>"` to the agent launch arguments. It adds one argument for each of `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `TMPDIR`, and `HERDR_WORKTREE`. The pane, tab, and workspace IDs come from the new pane. The socket and binary paths come from the caller environment. A variable with an unknown value is left out. `worker start` refuses a value with a quote, a backslash, or a control character before it creates the worktree. The dry-run plan shows `<pane-id>` for the new pane, and `<tab-id>` when the start creates a tab.

`worker start` saves the resolved base commit in the run record. Review the worker, then collect it with `--record` before you merge its branch. Collection uses that saved commit so changed paths stay stable after the merge.

| Option | Meaning |
|---|---|
| `--kind KIND` | Required. `codex`, `claude`, `opencode`, or `pi`. |
| `--task TEXT` or `--task-file FILE` | Required. The work order for the brief. |
| `--allow PATH` | A path that the worker may change. Repeat for each path. |
| `--copy PATH` | Copy a regular repository file into `.worker/inputs/` before the agent starts. Repeat for each file. Keep its repository subdirectories. |
| `--lease POOL` | Lease one item of a resource pool for the worker. Repeat for each pool. See [Resource leases](#resource-leases). |
| `--model MODEL` | A model from `herdr-boss models`. The default is the kind's default model. |
| `--effort EFFORT` | A reasoning effort, where the kind supports it. |
| `--issue N` | The issue number. |
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

Policy may set `preferredModels` by harness; `modelProviders` by allowed model; `extraModels` and `disabledModels` by harness; `harnessRoutes` by harness and model; and `pacingGoals` by provider and window key (`primary`, `secondary`, or `tertiary`). `extraModels` adds local model strings to one harness. The models use that harness's launch arguments and effort rules. `disabledModels` disables a model in one harness. A preferred model must be in that harness's allow-list. `harnessRoutes` takes precedence over `modelProviders` for the same harness and model. A provider route must be `codex`, `claude`, `opencodego`, or `null` for an unmetered model. A `harnessRoutes` route for the `codex` harness must be `codex` or `null`. A route for the `claude` harness must be `claude` or `null`. The `opencode` and `pi` harnesses accept every provider. `policy set` refuses an incompatible route and names the harness, the model, and the permitted choices. The rule also applies to a `modelProviders` route that an available `codex` or `claude` harness inherits without a `harnessRoutes` entry. `policy set` refuses such a policy and names the harness, the model, and the permitted choices. An existing policy with such a route still loads. Herdr Boss keeps the raw value, treats the model as unmetered in that harness, and logs one warning. `policy show` lists these routes in the derived `ignoredRoutes` field. `policy set` does not store that field. A pacing goal is a whole percentage from 0 to 100; an absent goal means 100%. Explicit `--model` and handoff `--model` choices take precedence.

```sh
herdr-boss worker start fix-74 --kind claude --task-file brief.md --allow src/parse/ --issue 74
```

### Other worker commands

| Command | Action |
|---|---|
| `worker list` | Unfinished run records with the live agent status. |
| `worker collect NAME` | Read the worker report, check its changed paths against `--allow`, and report configured stale-artifact warnings. |
| `worker collect NAME --record --outcome done\|partial\|failed --gate-passed\|--gate-failed [--defects N] [--rework N]` | Also append the run to the ledger, record usage, and release the leases of the worker. After success, merge the branch, then prune safe worktrees. |
| `worker park NAME --reason TEXT` | Mark a worker that waits on purpose. Idle notices skip it. |
| `worker unpark NAME` | Clear the park mark. |
| `worker allow NAME PATH... --reason TEXT` | Approve extra paths for a running worker after a `WORKER QUESTION`. |

`worker collect` checks artifacts when a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. It compares the newest matching source file with the oldest matching artifact file. It warns when a source is newer or when sources match but no artifacts do. It prints each warning and includes the warnings in the `artifactWarnings` summary field. A warning does not change the independent gate result. The orchestrator decides whether the gate passed.

### Project locks

| Command | Action |
|---|---|
| `lock acquire NAME [--wait SECONDS]` | Acquire a manual lock. `full-suite` is a machine lock. Other names are locks for this Git repository. Wait up to five seconds when another lock or lease change is in progress. A lock change removes a stale guard that a killed command left. `--wait` accepts a whole number of seconds and waits for a held lock. |
| `lock release NAME` | Release a lock owned by this pane, or a stale lock. Wait up to five seconds when another lock or lease change is in progress. |
| `lock list` | List the locks of this Git repository and the machine locks. Show each lock's age, holder pane, kind, scope, and state. Show the time left for a manual `full-suite` lock. |
| `push [ARGS...]` | Run `git push ARGS...`. When a pre-push hook exists, take and release the `full-suite` lock around the push. The default wait for a held lock is 1800 seconds. Wait up to five seconds for another lock or lease change. If release fails, print a warning. Keep the push exit code, or return 1 if the push succeeded. |
| `suite [--wait SECONDS] [--keep NAME]... -- COMMAND...` | Take and release the `full-suite` lock around `COMMAND...`. Run the command with a clean environment. The default wait for a held lock is 1800 seconds. Wait up to five seconds for another lock or lease change. If release fails, print a warning. Keep the command exit code, or return 1 if the command succeeded. |

Lock names are one path-safe token. Every linked worktree of the same Git repository uses the same locks. The `full-suite` lock is machine-wide: all repositories on this machine share it. Herdr Boss stores lock records in a private `locks` directory under its data directory. It stores machine locks in `locks/machine/`. Each record names the owner pane, PID, kind, safe acquire command, and acquisition time. A `suite` or `push` lock uses the PID of that command. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual `full-suite` lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock. The engine sends the former holder a warning when it sees the takeover. It also shows held machine locks in the bulletin. A different pane cannot release an active lock. Herdr Boss fails closed if it cannot confirm pane state.

Only a verified `orch` or `boss` pane can run `lock acquire`, `lock release`, and `lock list`. For the `full-suite` lock, `lock acquire`, `lock release`, and `suite` also accept a worker pane. A worker pane has a live run record in the runs folder of a checkout of the same Git repository. The record names the caller pane and the caller worktree, and it has no `finishedAt`. Herdr Boss verifies the pane with `herdr pane get`. A worker pane cannot take other lock names. A lock of a worker pane becomes stale when the pane closes.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. There is no load threshold.

Use `herdr-boss suite -- npm test` for a full test suite. The command removes `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET` from the environment of the suite. It also removes each name that ends in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, or `_KEY`, in upper or lower case. It keeps all other names, for example `PATH`, `HOME`, and `TMPDIR`. Use `--keep NAME` to keep one removed name. You can use `--keep` more than once. The command prints the number of removed names. It does not print names or values. It releases the lock also when the suite fails or cannot start.

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

## Ledger, checks, and worktrees

| Command | Action |
|---|---|
| `ledger append --entry FILE [--file LEDGER]` | Validate and append one run entry. |
| `ledger check [--runs] [--file LEDGER]` | Validate the ledger. `--runs` also fails for each run record without a ledger entry. |
| `check --report FILE` | Validate a worker report (`report.json`). |
| `check --run FILE` | Validate one ledger entry. |
| `check --worktree DIR --allow PATH...` | Check that the worktree changes only allowed paths. |
| `check agents [FILE]` | Check a project `AGENTS.md` and its kit file for kit drift. `FILE` defaults to `AGENTS.md` at the Git top level of the current directory. The kit file is `docs/orchestration/herdr-boss.md` in the directory of `FILE`. The command also scans the orchestration files in that directory. The command prints one line per finding and a summary line. It exits 0 when there is no `error` finding, and 1 otherwise. |
| `check kit` | List each published project with its `kitRevision`, its `agentsCheck` counts, and the revision state: `current`, `old`, or `not published`. The last line is a summary with the current kit revision. The command exits 1 when a project is not current. |
| `kit install [--no-hook]` | Install the kit in the Git top level of the current directory. The command writes the kit file, the `AGENTS.md` stub, and the Claude `SessionStart` hook. It prints `wrote FILE` for each file that it changed and `unchanged FILE` for the other files. `--no-hook` does not change `.claude/settings.json`. |
| `kit block` | Print the marked `AGENTS.md` stub with the current hash. Old instructions use this command. Use `kit install` for a new installation. |
| `worktree prune [--apply]` | List worktrees that pass the safe checks and show processes in removal candidates. `--apply` removes only worktrees with no blocking process. |
| `gh issue create\|comment\|edit ... --body-file FILE` | Run a GitHub issue command. An inline `--body` is refused. |

### Kit file, `AGENTS.md` stub, and drift check

`kit install` writes three files in the project repository:

| File | Content |
|---|---|
| `docs/orchestration/herdr-boss.md` | The kit file. The body is `kit/templates/project-kit.md`. Only Herdr Boss writes this file. |
| `AGENTS.md` | The stub between the markers. The stub body is `kit/templates/agents-stub.md`. |
| `.claude/settings.json` | A Claude `SessionStart` hook that prints the kit file and `docs/orchestration/memory.md`. |

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

`kit install` computes all files before it writes. An error writes no file.

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

Each project has one persistent Chrome profile on a port from 9223 to 9299. The port is a lease in the built-in pool `project-browsers`. See [Port leases](user-guide.md#port-leases). Add `--tab ID` to page commands when the browser has several tabs; `browser tabs` lists the IDs.

| Command | Action |
|---|---|
| `browser request SLUG [--headless\|--visible] [--reserve]` | Launch the project browser. `--reserve` assigns the port and profile only. |
| `browser list` | All project browsers, ports, profiles, and state. |
| `browser restart SLUG --headless\|--visible [--no-restore]` | Close and relaunch in the other mode. The current page reopens unless `--no-restore`. |
| `browser close SLUG` | Close the browser. The profile and the port lease stay. |
| `browser release SLUG` | Remove the port lease of the project. Refuses while the project Chrome runs. The record and the profile stay. |
| `browser size SLUG WIDTH HEIGHT` | Window size for the next launch (320–3840 × 240–2160). |
| `browser tabs SLUG` | Tabs with ID, title, URL, visibility, and whether an agent is attached. |
| `browser tab new SLUG [URL]` | Open a tab in its own background window. Prints the ID. |
| `browser tab close SLUG --tab ID [--force]` | Close a tab. Refuses a tab an agent is attached to unless `--force`. |
| `browser screenshot SLUG [--tab ID] [--out DIR]` | Save a private JPEG and print its path. Use `$TMPDIR` by default, or select a directory with `--out DIR`. |
| `browser navigate SLUG URL [--tab ID]` | Open an `http` or `https` page. |
| `browser click SLUG X% Y% [--tab ID]` | Click at a position relative to the screenshot. |
| `browser text SLUG --stdin [--tab ID]` | Type text from standard input. The text is not echoed. |
| `browser key SLUG KEY [--tab ID]` | Send `Tab`, `Enter`, `Backspace`, `Delete`, `Escape`, `Home`, `End`, an arrow key, or `SelectAll`. |
| `browser bookmarks SLUG list` | List the bookmarks and the start page of the project. |
| `browser bookmarks SLUG add NAME URL` | Add one bookmark. The name has at most 60 characters. The URL must use `http` or `https` and must not hold a user name or a password. |
| `browser bookmarks SLUG rm INDEX` | Remove the bookmark at `INDEX`. |
| `browser bookmarks SLUG open INDEX [--new-tab]` | Open the bookmark in the current tab, or in a new tab with `--new-tab`. |
| `browser bookmarks SLUG start URL\|none` | Set the start page of the next launch, or clear it with `none`. |
| `browser sweep-clones [--dry-run]` | Delete orphaned Chrome code-sign clones now. Prints the count and the freed GiB. `--dry-run` lists each clone by name and age and deletes nothing. |

```sh
id=$(herdr-boss browser tab new tmprocessmining | jq -r .id)
herdr-boss browser navigate tmprocessmining https://example.com --tab "$id"
herdr-boss browser screenshot tmprocessmining --tab "$id"
```

The screenshot command writes under `$TMPDIR` when it is set. Otherwise, it creates a safe temporary directory. Pass `--out DIR` to choose an output directory. This option overrides `$TMPDIR` and can be used with `--tab`.

A project keeps at most 30 bookmarks. A bookmark URL must use `http` or `https` and must not hold a user name or a password. The start page opens in the first tab of the next launch. The bookmarks and the start page stay in the project record in `browser-sessions.json`.

## Orchestrator handover

| Command | Action |
|---|---|
| `handoff plan PANE --to KIND [--model M] [--effort E] [--mode migrate\|fresh]` | Check the target and whether session migration is available. Changes nothing. |
| `handoff prepare PANE --to KIND [...]` | Start a successor in a new `Orchestrator Next` tab. The source keeps control. |
| `handoff activate ID --confirmed` | Label a project successor `orch` and the source pane `orch previous`. Label a Boss successor `boss` and the source pane `boss previous`. A project handover notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner. If Herdr reports `pane_not_found` for the source pane, activation skips the source label and the source prompt. The successor prompt says that the source pane was closed before activation. |
| `handoff ready ID` | Sent by an automatic successor when it is ready. |
| `handoff list` | All handover records. Status can be `preparing`, `prepared`, `needs-inspection`, `active`, `superseded`, or `expired`. |

`--mode migrate` (the default) converts the session with `session-migrate`. If migration is unavailable or transfer fails, preparation uses fresh mode and records the reason. `--mode fresh` starts the successor without a migrated session. `--force` allows a target provider near exhaustion.

`handoff plan` reports when Claude session migration is unavailable because the active graph has an ancestry cycle. `handoff prepare` then uses fresh mode automatically.

`handoff plan` measures the migrated session before it reports migration as available. After a successful dry run, it runs the same transfer with `--home` set to a new temporary directory under the system temporary directory. It adds the byte sizes of the `.jsonl` files in that directory and then deletes the directory. The estimate is one token for each 4 bytes, rounded up. The migrated session fits when the estimate is at most 60% of the target window. `migration.fit` records `bytes`, `estimatedTokens`, `contextTokens`, `limitTokens`, `fits`, and `sizeKnown`. When the session does not fit, the plan sets `migration.available` to `false` with this error: `Migrated session is too large for the target window: about N tokens against a limit of M.` `handoff prepare` then uses fresh mode and records the same text in `migrationFallbackReason`. The successor prompt at activation includes that reason.

A live source session can change while `session-migrate` reads it. A failed measuring transfer therefore runs one more time. If the second attempt also fails, `migration.fit.sizeKnown` is `false`. Migration stays available, and `migration.warning` says that the size is unknown. Migration also stays available with a warning when the target model has no window in `kit/models.json`.

The target window comes from `kit/models.json`. The optional `contextTokens` field of a kind gives the window in tokens. The optional `contextTokensByModel` object of a kind gives the window for one model and overrides `contextTokens`. Each value must be a positive integer. `claude` and `codex` set `contextTokens` to `200000`.

After activation, Herdr Boss closes the old pane after 120 minutes when the current pane list confirms both pane roles. A later handover can mark the record as superseded. The old pane stays eligible for retirement, and Herdr Boss follows the successor chain to the current active pane. Unavailable pane data defers retirement to a later engine tick. The current successor receives one retirement notice.

Preparation copies the optional top-level `goal` from the latest published project status into `ownerGoal` in the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. A Boss handoff has no project goal. The successor reads `AGENTS.md`, the current Herdr Boss bulletin, and the applicable memory file: `docs/orchestration/memory.md` for a project, or `~/.herdr-boss/boss-memory.md` for the Boss. The successor reports if that file is missing. Fresh preparation reads at most 200 recent lines and stores at most 20,000 characters of redacted source-pane text. Both caps include the truncation marker. If the recent read fails, it tries the visible pane. If both reads fail, it records that context is unavailable. The successor prompt marks the snapshot as historical context. The successor only reads and reports until activation.

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
