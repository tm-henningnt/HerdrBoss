# User guide

Choose the chapter for your task.

Use Chat for ordinary messages. Use the Mailbox to answer, approve, or decide. A reply keeps the same conversation thread.

The dashboard uses one menu on every page. It includes every section, including Fleet and Docs. On a phone, select the Herdr Boss logo to open it. The logo does not go to Overview. Select **Overview** in the menu to open it. The Mailbox menu also shows its folders.

Mailbox counts and lists refresh every second. Open Mailbox conversations, Owner Chat lists and conversations, and Agents lists and open pairs refresh every second. A CLI message appears without a page reload. The top-bar badges, Needs-you heading, and list use one Mailbox count source. The page refreshes its reads when you return online or show it again. A sent message first shows **Sending…**, then **Sent. Waiting for delivery.** It shows **delivered** with a time, or **failed** with the reason. Open the conversation in **Sent** and select **Retry** after a failure. Retry uses the same client ID, so it does not create a duplicate. Select **Clear** to remove the failed message from this browser.

- [I want to see what is happening](guide/see.md)
- [I want to answer a Mailbox question](guide/answer.md)
- [I want to review a pack](guide/review.md)
- [I want to limit the cost](guide/cost.md)
- [I want to use it from my phone](guide/phone.md)
- [I want to add a project](guide/project.md)
- [I want to work on the projects in focus](guide/focus.md)
- [I want to add a factory](guide/factory.md)
- [I want to move the head office](guide/factory.md#move-the-head-office)
- [I want to see the usage limits of a factory](guide/factory.md#sign-in-the-agent-apps-and-start-the-factory-boss)
- [Something went wrong](guide/trouble.md)

## Approve proposed work

An orchestrator may propose work. It starts no unapproved work.

Approved work includes a backlog task, an Owner goal, a fix for a finding of approved work, or a defect fix.

A subagent read or survey inside approved work is allowed. Get the Owner's yes before a survey, review, or audit that is itself new work outside those categories. Get the Owner's yes before a refactor, a new feature, a new test program, or a release outside an Owner request.

Each proposal uses one Mailbox decision card. The card states what, why, cost, and recommendation. Select **Accept** or **Deny** to decide. The Boss's yes does not replace the Owner's yes. See [Owner messages](cli.md#owner-messages) for the command.

## Sign in to a site with a project browser

Project browsers run headless. Use the Browsers page to sign in without opening a Chrome window on the service machine.

On the Browsers page, select **Bookmarks N** to open one project's list. Use **Filter bookmarks** to search by name or address. Select the summary again to close the list. **Open** uses the current tab. **New tab** opens another tab.

1. Open the **Browsers** page in Herdr Boss.
2. For the project, select **Show preview**. Select the project browser screenshot to open the large view.
3. Enter the site's sign-in address. Select **Open sign-in tab**. The page opens in the project profile and turns on **Control browser**.
4. Use the page image to select each field. Type a password or code in the masked field above the image, then select **Send text**. Use the page image to select **Next** or **Sign in**.
5. Finish the sign-in steps in the image. The project browser keeps the login in its profile. A site can ask you to sign in again when the login expires.

Only the Owner can open a sign-in tab or send sign-in input from this view.

The **Show tenant hosts** switch is in Settings, Browsers. It is off by default. Turn it on to show full browser URL hosts on the dashboard for an Owner page that sends a same-origin browser signal. A process on this machine can still forge the headers. Use this setting only on the Owner's own machine. Browser output sent to agents, messages, reports, status files, logs, and published files stays masked.

The Browsers page lists the last 50 independent browser launches. Each row shows the time, browser PID, first observed pane, launcher kind, and project. Herdr Boss keeps this association when a process becomes an orphan. The event log also holds the observed process start identity. A process gets one row for its PID and start identity. The launcher kind is `perf-harness`, `agent-browser`, `playwright`, or `unknown`. Raw arguments, URLs, environment values, and profile paths are not stored in these fields. Run `herdr-boss browser audit [PROJECT]` to read the list at a terminal.

Run `herdr-boss account probe` once at an Owner terminal to check the OpenCode Go login setup. Run it from the project folder while a tool is active. Without the CLI, run `node scripts/account-probe.mjs` from this repository. Both commands work without the service. They print metadata only, write no files, and refuse agent panes. The guard prevents accidents and pane leaks. It does not stop a hostile process of the same user. An `unverified` passive result keeps the wait rule for rotation. See [Account probe](cli.md#account-probe).

## Check tool versions

Run `herdr-boss tools check` to compare versions on this Mac and in the factory pins with public upstream releases. Every run checks upstream. The check saves its result and posts one read Mailbox item for each late or security tool version. An open item for the same tool and version is reused. A repeated check updates only its text. It keeps the item's read state. A failed Mailbox post prints a note and does not stop the other tool updates. A security item starts with `Security:` in the title and `Security release.` in the first body line. This command never upgrades a tool. It uses public HTTPS endpoints and does not use your GitHub CLI login.

The check saves `tools-state.json` in the Herdr Boss data directory. `HERDR_BOSS_DIR` selects the directory. The default is `~/.herdr-boss`. The file has mode `0600` and contains version and risk data, but no login or token data. The command sets the directory mode to `0700` only when the directory is a real directory owned by the current user. Factory values come from the pin file. The command does not query running factories.

For GitHub releases, the check chooses the highest version on the tracked major line when that line has a release. Otherwise, it chooses the highest version overall. The check reports `late` when the first release after the tracked version is more than 14 days old. It reports `security` when a release note has a CVE ID or a GitHub advisory link with a GHSA ID, a public advisory affects the tracked version, or the Debian security version is newer. An advisory request failure does not discard good release data, but it can delay an advisory warning until the next check. A failed release request keeps the last known latest version and a saved `security` risk. Other saved risk values become `unknown`. Run `herdr-boss doctor` to see one line for each late or security release. A late release is a note. A security result older than 24 hours is ignored and doctor prints `note: tool check is stale, run herdr-boss tools check`. A fresh security release makes `doctor` exit 4.

Run `herdr-boss tools bump TOOL` to prepare a pin change for a factory image or build tool. The command checks the published checksum or package integrity first. It refuses a missing checksum, a checksum mismatch, or a tool with no checksum source. It waits three days before a Claude, Codex, or OpenCode release unless a security fix is verified. If the advisory request fails, the command prints a note. It still waits three days unless the release notes show a security fix. The command creates a linked worktree at `<worktreeRoot>/<repo>/tools-bump-<tool>-<version>`. It uses the configured base branch and creates a `tools/` branch for the selected version. It writes `factory/pins.json` atomically and commits that file in the worktree. The commit message ends with `Kit-Impact: none`. The main checkout stays on its current branch and its pin file stays unchanged. The command refuses an existing worktree at the target path. If the write or commit fails, it removes the worktree and branch. The command prints the worktree path, branch, and diff. It prints the release notes link when one is available. It does not install a tool on this Mac or change a running factory. Add `--to VERSION` to select a published version. Add `--dry-run` to print the diff without creating a worktree or branch.

Run `herdr-boss tools promote TOOL` after you merge a pin change. The command builds and updates the `win1` canary first. It reads the worker count with `factory status`. It waits up to five minutes for the factory to drain. It stops if the status cannot prove that no worker is running. It then runs `factory/smoke-test.sh` against the built image and runs `doctor --json` inside the canary. The command waits 24 hours after these checks pass. It then builds and updates each other container factory in name order. It runs `doctor --json` after each update. It updates one factory at a time. It keeps each stage in `tools-promote.json` in the data directory. The file has mode `0600`. Run the same command again to resume after a stop. A failure stops the rollout and posts one read Mailbox item for that stage. If a factory Boss pane is live, the command saves `waiting-owner`, posts one read Mailbox item, prints `herdr-boss factory update NAME --tier image --allow-boss-restart`, and exits with code 3. The Boss or the Owner runs this command. Rerun `herdr-boss tools promote TOOL` after factory status reports the target pins hash and matching image IDs. The command checks the running image and factory readers before it records an update as done. `--dry-run` may run read-only commands. It runs no changing command and writes no rollout state.
## Manage factory project registrations

Run `herdr-boss project unregister <slug>` to remove a project from the registry. The command saves a registry backup first. It removes only the registry row. It leaves the project files, worktrees, and branches in place. It reports an error for an unknown slug.

A factory Boss skips a registered project outside the factory work volume. It does not trust that project or install kit files there. The start command prints a warning. `herdr-boss doctor` prints the same warning inside a factory. Use `project unregister <slug>` to remove the stale registration.
## Disk use

Run `herdr-boss worktree disk` from a project repository to see the size of each worktree, the total, and free space. Add `--json` for a JSON report.

Run `herdr-boss worktree prune --clean-build` to list rebuildable output in worktrees that the prune keeps. Add `--apply` to delete it. The command skips tracked files, `node_modules`, the primary checkout, and worktrees with a live pane or running process. It removes only `dist`, `.vite`, `test-results`, and screenshots older than one day from `.worker/tmp`.

The Doctor disk line reports free space at the Herdr Boss data folder and the configured worktree root. It uses the lower value when they are on different file systems. It gives a note below 15 GB. It gives an error below 5 GiB.

### Worker-start disk floor

Worker start checks the free space on the volume that holds the worker worktree folder and on the volume that holds the Herdr Boss data directory. The lower value must meet `worktrees.minFreeGb`. The floor defaults to 8 GB. Set it from 1 to 500 GB in Settings under Service. If either volume is below the floor, worker start refuses. The refusal names both volumes, their free space, the floor, and the cleanup commands.

The refusal records a timestamped diagnosis in the bulletin and the audit file. It lists the five largest directories and the five newest temporary directories that are at least 50 MiB. It scans only six fixed roots. It reads directory entries and file metadata, not file contents. Each root gets part of a 2.5-second budget. A slow root does not use the later roots' time. The diagnosis lists paths and sizes only. A scan failure does not block the refusal. The bulletin hides the diagnosis when both volumes meet the floor or the record is more than six hours old.

Use `--force --reason TEXT` for an authorized override. Give a reason from 1 to 300 characters. Herdr Boss redacts secrets and writes the override to `action-audit.jsonl`.

When the main checkout has `node_modules` and all detected lock files match the new worker worktree, `worker start` uses a copy-on-write clone on macOS. It uses the setup command or `npm ci` when the lock files differ or the clone fails.

## Collect a worker

The project lead reviews a worker's change and runs its acceptance commands before collection. Run `herdr-boss worker collect NAME --outcome done --gate-passed` to record a completed run.

Add `--defects N` to record a defect count from 0 to 99. Omit it when the count is unknown. The model scorecard shows the total beside the first-time and rework results. It also shows how many runs supplied a count. A dash means no count was recorded.

If the worker lists an unintended path outside its scope, discard the change first. Then run `herdr-boss worker collect NAME --exclude-path PATH --reason "discarded an unintended file" --outcome done --gate-passed`. Separate multiple paths with a comma. Give a reason with 1 to 300 characters.

Herdr Boss refuses the exclusion if the path is still in the branch diff against the recorded base or in the worktree diff or status. The error shows where the path remains. It also refuses an ordinary path inside the allowed scope. Every path under `.impeccable/` counts as outside the scope, even when the allowed paths cover it. Discard an unintended Impeccable change before exclusion. Exclusion records the run, removes the discarded paths from the scope check and ledger, and writes the run name, paths, and redacted reason to `action-audit.jsonl`. The report stays unchanged. Do not use `--no-record` with an exclusion.

Use `--accept-scope` for other extra files that the project lead approved. This option cannot accept `.impeccable/` paths. Report an Impeccable false positive in the worker report. The project lead decides how to handle it. See the [worker commands](cli.md#workers) for the scope rules.

## Handover lock cleanup

A handover removes empty lock directories after it transfers resources. It removes only directories that the transfer touched. It keeps non-empty directories and the data directory’s `locks` root.

## Harness change markers

Run `herdr-boss harness check` or `herdr-boss harness sync` to record changed harness facts. The first run saves a baseline. Later runs add markers for version, model list, or sandbox changes to the Analytics denial chart. Version facts come from the last `herdr-boss tools check`. A missing reading keeps the last known fact. A dry run writes no marker or baseline. Automatic markers contain no paths or setting values. Herdr Boss keeps at most 200 rows and 64 KiB in the marker file. A recording error prints one warning with no path. Check and sync keep their result and exit code. Herdr Boss saves the baseline before it writes markers. A failed marker is not retried.

A CPU-bound command in this class runs without the load guard. Mark only commands that wait on a remote service. Declare a remote-wait command in `networkCommands` in `.herdr-boss.json`. Herdr Boss matches its command after whitespace normalization and uses the network class. The class has its own FIFO queue and slot cap. It does not use or block a `full-suite` slot, and it does not wait for the 5-minute load guard.

## Full-suite lock watchdog

The lock watchdog checks a live `full-suite` lock after it runs longer than the multiplier times its predicted hold time. It sends one notice to the holder pane and the Boss when the process tree stays below the CPU limit in the Locks panel on Settings. The notice names the holder and child processes and tells you to inspect the pane. The Boss or holder pane can run `herdr-boss lock release`; the watchdog never releases the lock.

For persisted record rules, see the [record inventory](architecture-records.md). For supervisor steps and gaps, see the [supervisor contract](reference/supervisor-contract.md). For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).

## Harness sync and release settings

Run `herdr-boss harness sync` after you register projects or change the worktree root. The command adds each enabled project's common Git directory to Codex `writable_roots`. This lets Codex write shared Git metadata for linked worktrees. The command prints each path it adds and saves a backup before it edits the Codex config.

WARNING: The common `.git` directory gives Codex write access to `hooks/`, `config`, `refs/`, `objects/`, `HEAD`, `info/`, and `worktrees/` of the main repository. A changed hook can run code at the next Git command.

Herdr Boss stores pins in `~/.config/herdr-boss/git-pins/`, in the private directory beside the access token. The pins, the record that a project was pinned, and notice dedupe stay outside the data directory and the repository. Each pin file stores its project slug and repository path. Push and suite check the private records even when `project-repos.json` is missing.

Herdr Boss hashes hook names and contents, the whole repo `config`, `config.worktree` for the main checkout, each `worktrees/NAME/config.worktree`, `info/attributes`, and the files in the folder named by `core.hooksPath`. Check names only changed files. Remote URL and push URL changes name only the remote. Check prints no contents or values. Each output name has at most 64 characters. Only letters, digits, `.`, `_`, `@`, and `-` remain. Other characters become `?`. Output lists at most 10 names and the remaining count.

A project with no prior pin can get a baseline through harness check, harness sync, or harness pin. Push and suite do not create baselines. A deleted or unreadable pin for a previously pinned project fails closed. Ask the orchestrator to ask the Boss. A later Git difference fails the check and queues one Boss notice per change set. The private pin stores the last notified ID. Delivery removes the transient notice from the data directory.

Push and suite refuse a pin difference before they take a lock or reuse a pass. The refusal says: `Ask the Boss. Do not run the hook.` After review, the Owner terminal, Boss, or that project lead can run `herdr-boss harness pin PROJECT --reason TEXT`. The reason is required and audited. The Owner terminal needs a TTY on stdin and stdout. If the private directory is not writable, pin refuses before it changes pins or writes an audit line. Only the verified Boss can override push or suite with `--force --reason TEXT`. The reason is required and audited. The Git state cache lasts at most 10 seconds. A deleted or corrupt private trust record fails at once. Harness check reads fresh state.

The caller check is not a security boundary against a same-user process. The protection against a Codex worker is the private pin folder, which the Codex sandbox cannot write. Keep that folder outside Codex writable roots. Caller checks and the Owner TTY requirement prevent routine misuse. They do not stop another process of the same user.

In Settings, open Advanced and Codex shared Git. The project switch sets `projects.SLUG.codexSharedGit` in `policy.json`. The default is on. The shipped HerdrBoss default is off until K60 has live verification. Select Apply policy. Run `harness sync` and restart Codex. Sync removes a disabled project's exact Git root entry. Check reports it as intentionally off. A broader root that still gives access fails the check. The project lead commits HerdrBoss Codex worker changes with `worker commit`.

If the command cannot verify a common Git directory, it tries the repository `.git` path and prints a warning. It skips that project root if neither path is a valid Git directory.

Set `releases.repos` in **Settings → Advanced → Service settings → Releases**. This setting lists the repositories that may request a release or add release assets. Qlik extension rows have a demo-app switch. It defaults on. When on, the release needs one separate `.qvf` asset, and an extension ZIP cannot contain a `.qvf` file. The approval card shows the demo app name, size, and SHA-256. When a repository is not allowed, the refusal names `releases.repos` and points to this Settings page.

Use `herdr-boss release add-asset` to request new files for a draft or published release. The Owner must accept the request before Herdr Boss uploads the files. Herdr Boss keeps the current release body and can append a Demo app notes block after it.

## CLI checks and handover errors

Run `herdr-boss check --help` to see the report, run, worktree, agents, and kit check forms.

When a pane command fails during handover activation, the CLI prints up to 20 lines of redacted stderr.
