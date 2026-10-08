# User guide

Choose the chapter for your task.

Use Chat for ordinary messages. Use the Mailbox to answer, approve, or decide. A reply keeps the same conversation thread.

- [I want to see what is happening](guide/see.md)
- [I want to answer a Mailbox question](guide/answer.md)
- [I want to review a pack](guide/review.md)
- [I want to limit the cost](guide/cost.md)
- [I want to use it from my phone](guide/phone.md)
- [I want to add a project](guide/project.md)
- [I want to add a factory](guide/factory.md)
- [I want to move the head office](guide/factory.md#move-the-head-office)
- [I want to see the usage limits of a factory](guide/factory.md#sign-in-the-agent-apps-and-start-the-factory-boss)
- [Something went wrong](guide/trouble.md)

## Sign in to a site with a project browser

Project browsers run headless. Use the Browsers page to sign in without opening a Chrome window on the service machine.

1. Open the **Browsers** page in Herdr Boss.
2. For the project, select **Show preview**. Select the project browser screenshot to open the large view.
3. Enter the site's sign-in address. Select **Open sign-in tab**. The page opens in the project profile and turns on **Control browser**.
4. Use the page image to select each field. Type a password or code in the masked field above the image, then select **Send text**. Use the page image to select **Next** or **Sign in**.
5. Finish the sign-in steps in the image. The project browser keeps the login in its profile. A site can ask you to sign in again when the login expires.

Only the Owner can open a sign-in tab or send sign-in input from this view.

The Browsers page lists the last 50 independent browser launches. Each row shows the time, browser PID, first observed pane, launcher kind, and project. Herdr Boss keeps this association when a process becomes an orphan. The event log also holds the observed process start identity. A process gets one row for its PID and start identity. The launcher kind is `perf-harness`, `agent-browser`, `playwright`, or `unknown`. Raw arguments, URLs, environment values, and profile paths are not stored in these fields. Run `herdr-boss browser audit [PROJECT]` to read the list at a terminal.

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

## Full-suite lock watchdog

The lock watchdog checks a live `full-suite` lock after it runs longer than the multiplier times its predicted hold time. It sends one notice to the holder pane and the Boss when the process tree stays below the CPU limit in the Locks panel on Settings. The notice names the holder and child processes and tells you to inspect the pane. The Boss or holder pane can run `herdr-boss lock release`; the watchdog never releases the lock.

For persisted record rules, see the [record inventory](architecture-records.md). For supervisor steps and gaps, see the [supervisor contract](reference/supervisor-contract.md). For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).
