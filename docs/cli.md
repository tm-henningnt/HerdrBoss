# CLI reference

Run `herdr-boss` with no arguments to print a short usage list. Commands that change state print JSON or one status line. Errors go to standard error with a non-zero exit code.

Run project commands (`worker`, `worktree`, `ledger`, `check`, `gh`) from inside the project repository. They read `.herdr-boss.json` from the repository root.

## Service

`serve` stops before it writes a file when the data directory and the live data directory differ. The live data directory is always `~/.herdr-boss`. `HERDR_BOSS_DIR` selects the data directory. The two paths must match after path normalization. Two different paths to the same directory do not pass the check. This is the same rule that enables engine actions. Use `--read-only-preview` with a separate temporary data directory for a preview.

Set `worktreeRoot` and `projectRoot` in `config.json`, or in **Settings → Advanced → Service settings → Paths**. Select **Save**. Use an absolute path or a path that starts with `~`. A root must not contain a `..` segment and must not be `/`. Herdr Boss saves the normalized absolute path. The defaults are `~/Projects/.herdr-wt` and `~/Projects`. A project `worktreeRoot` in `.herdr-boss.json` takes precedence for its workers. The new root applies to new workers, leases, harness checks, and log attribution. Run `herdr-boss harness sync` after a worktree root change. Existing worktrees stay in place.

`projectRoot` supplies the suggested group folder for **New project** in the dashboard. An entered group or exact path takes precedence. The CLI still requires `--group` or `--path`.

`chromePath` is the Chrome executable that `herdr-boss browser request` and the dashboard start for a project browser. Set it in `config.json` or in **Settings → Advanced → Service settings → Browsers**. The default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. The path follows the root rules: absolute or starting with `~`, and no `..` segment. A running browser keeps its executable until it restarts. The profile folder `browser-profiles/SLUG` does not depend on `chromePath`.

| Command | Action |
|---|---|
| `herdr-boss doctor [--json] [--factory-host]` | Check the onboarding items. Print a fix for each red item and any active Codex lane block. Exit 0 when all items are green. Exit 4 when an item needs a fix. |
| `herdr-boss tools check [--json]` | Read Mac versions, factory pins, and upstream versions. Save the check. Post a read Mailbox item for each late or security tool version. Print a note and continue when a Mailbox post fails. Do not upgrade a tool. |
| `herdr-boss tools bump TOOL [--to VERSION] [--dry-run]` | Verify the published checksum or registry integrity. Create a branch and worktree under the configured worker worktree root. Write and commit the `pins.json` change there. Keep the main checkout unchanged. `--dry-run` prints the diff and creates no worktree or branch. |
| `herdr-boss tools promote TOOL [--dry-run]` | Build and update `win1` first. Read worker counts with `factory status` and wait up to five minutes for a factory to drain. Run the image smoke test and factory doctor reader checks on `win1`. Wait 24 hours, then build and update each other container factory in name order. Compare the running container image ID with the tag image ID when status reports both. Run a doctor reader check after each update and before marking it done. Save each stage in `tools-promote.json` with mode `0600`. Rerun the command to resume. Stop on the first failure. Post one read Mailbox item for each failure stage. If a factory Boss pane is live, save `waiting-owner`, post one read Mailbox item, print `herdr-boss factory update NAME --tier image --allow-boss-restart`, and exit 3. The Boss or the Owner runs this command. Rerun `tools promote` after factory status reports the target pins hash and matching image IDs. `--dry-run` may run read-only commands. It runs no changing command and writes no rollout state. |
| `herdr-boss setup [--resume] [--dry-run] [--pacing paced\|unpaced]` | Run the first-hour steps. Save progress. Exit 3 when a step waits for you. |
| `herdr-boss install` | Install and start the service of the platform. On macOS it writes the launchd agent `no.tallmaker.herdr-boss`. On Linux it writes the systemd user service `herdr-boss.service`. Run it again after you move the repository. |
| `herdr-boss uninstall` | Stop and remove the service of the platform. |
| `herdr-boss serve` | Run the collector and the dashboard in the foreground. |
| `herdr-boss serve --read-only-preview [--host <address>]` | Run a dashboard preview. It binds `127.0.0.1` and accepts local requests only. `--host` sets another bind address, an IP address or a host name, and works only with `--read-only-preview`. The start line prints the bind address. It allows API reads and blocks API changes, prompts, notifications, process reaping, Chrome clone sweeps, handovers, and browser launches. It never reads, creates, or changes access files. It needs a `HERDR_BOSS_DIR` that the service does not use. |
| `herdr-boss tick [--json]` | Collect once and print alerts. Sends no prompt and stops no process. `--json` prints the full snapshot. |
| `herdr-boss logs` | Print the last 100 lines of the server log. It reads `service.log` in the data directory when that file exists, and `server.log` otherwise. |
| `herdr-boss kit-path` | Print the path of the shared kit (skill, templates, model list). |
| `herdr-boss secret set NAME [--provider P --label L --expires ISO]` | Store a value from stdin. Run it in an Owner terminal. |
| `herdr-boss secret list` | Print secret names and metadata. It also works in an agent pane. |
| `herdr-boss secret remove NAME` | Ask for the name again, then remove the sealed values. Run it in an Owner terminal. |
| `herdr-boss secret check [NAME]` | Check each value and print `ok` or `failed`. Run it in an Owner terminal. |
| `herdr-boss redact` | Read command output from stdin, redact it, and write it to stdout. |
| `herdr-boss redact add CLASS` | Read one private literal from stdin. Store it without output. |
| `herdr-boss redact list` | Print only the number of stored literals in each class. |
| `herdr-boss redact --check [FILE...]` | Scan tracked files. Print finding locations, classes, and counts. |
| `herdr-boss account probe` | Read login structure and configuration field names at an Owner terminal. Print no values. Write no files. |

### Account probe

Run `herdr-boss account probe` once at an Owner terminal, from the project folder. If the CLI is not installed, run `node scripts/account-probe.mjs` from this repository. The standalone copy needs only Node. Both commands print the same JSON report and work without the service. They accept no options or values in arguments.

The report checks `~/.local/share/opencode/auth.json` and `~/.pi/agent/auth.json`. For each file, it prints existence, mode, owner-only access, readability, JSON validity, and key names. Owner-only means the current user owns the file and group and other users have no access bits. It names each top-level provider key and each entry key. It checks whether each entry value is a string or an object. It lists the candidate identity key names `id`, `account`, `accountId`, `account_id`, `email`, `user`, `name`, `org`, and `sub` when present. It prints no login value. An unreadable or missing file has `unverified` checks. A file over 1 MiB or a symbolic link is not read. The report shows it as `symlink: yes` with the mode `unverified`.

The report lists other files directly in `~/.pi/agent` with their paths and modes. It reads no contents from those files, except the named configuration files. It lists environment variable names that match `OPENCODE`, `_API_KEY`, `XDG_DATA_HOME`, or `PI_`, with `set` or `unset`. Empty variables count as set. It includes known candidate names when they are unset. It never prints environment values.

The configuration checks report `apiKey` and `api_key` field names by file path. They check `opencode.json` and `opencode.jsonc` under `~/.config/opencode` and in the current project folder. They also check `settings.json` and `models.json` under `~/.pi/agent`. They check nested fields. JSONC comments and string values do not count as fields. No configuration value is printed. The effect and precedence of overrides stay `unverified`.

The process check prints only current-user tool counts and PIDs. It checks the executable names `opencode` and `pi`. It also uses a PID-only match for direct tool paths and known Node launchers. The pi match covers `node /path/pi` and the `pi-coding-agent/dist/cli.js` entry under `@earendil-works` or `@mariozechner`. It prints no arguments and reads no process environment. A custom wrapper can remain unidentified. A process-reader failure keeps known PIDs and gives `verified: no`. It does not prove a zero count.

Run the probe while a tool is active for the passive check. After its content reads, the probe records each login file's access time and modification time. It waits 10 seconds. It then checks those times again without reading file contents. The report prints only whether each time changed. An unchanged access time means `cannot tell`. A changed access time shows access, but cannot identify its source. The re-read fact stays `unverified`. The design keeps the rule that rotation waits for running processes. The probe starts and stops no tool. It writes no file. Its content reads can cause the file system to update access time.

The CLI reuses `verifyNightCaller`, as `factory token` does. It requires the Owner role and TTYs on stdin and stdout. It refuses the Boss and every agent pane before login reads. The guard also refuses any present `HERDR_ENV`, `HERDR_PANE`, `HERDR_PANE_*`, `HERDR_WORKSPACE_ID`, or `HERDR_WORKTREE` variable, even if empty. The standalone copy uses the same variable and TTY checks without Herdr. This prevents accidents and pane leaks. It does not stop a hostile process of the same OS user.

Exit 0 means the report finished. It does not mean every check passed. Exit 1 means usage, TTY, or probe failure. Exit 3 means caller refusal. A failure prints fixed text with no raw file, parser, or process diagnostics.

### Redact command output

Pipe command output that could hold an identifier through `herdr-boss redact`. For example, use `some-command | herdr-boss redact`. The command reads stdin and writes only the redacted text to stdout. This form writes no config or data file.

The filter applies these rules in order:

1. Replace whole GUIDs with `<uuid>`.
2. Replace private literals with `<host>`, `<app-id>`, `<ext-id>`, or `<space-id>`.
3. Replace hex strings of 24 or more characters with `<hex>`.
4. Replace configured tenant hosts and matching Qlik Cloud host names with `<host>`. Keep the rest of each URL for the next rules.
5. Replace bearer values, JWTs, common token prefixes, and private-key blocks with `<token>` or `<key>`.
6. Keep secret field names and replace their values with `<secret>`.
7. Keep app, space, and user ID field names and replace their values with `<id>`.
8. Replace Qlik object IDs with `<qlik-id>`. The shape has 24 letters and digits. It must contain a letter and a digit. An adjacent letter, digit, underscore, or hyphen prevents a match.
9. Replace extension IDs with `<ext-id>`. The shape has two or three groups of ASCII letters and digits. Each group has 5 to 17 characters. One hyphen separates each group. The total length is 32 characters, including the hyphens. Each group must contain a letter and a digit. An adjacent letter, digit, or hyphen prevents a match.

The shape rules accept uppercase and lowercase letters. They preserve words that contain only letters. Short git commit IDs stay unchanged. A hex string of at least 24 characters uses the earlier `<hex>` rule. ID and secret fields keep a complete tag from an earlier rule, including inside quotes.

An extension ID with a group that contains only letters or only digits does not match the shape rule. Add it as a private literal if it needs redaction.

To set tenant hosts, add a `redact.tenantHosts` array of host names to `~/.config/herdr-boss/config.json`. The command reads this file each time it runs. Do not put tenant hosts in a command, a report, a fixture, or a repository file. If the list is missing, the filter still replaces host names that match the Qlik Cloud pattern.

To add a private literal, pipe it to `herdr-boss redact add CLASS`. Select `host`, `app-id`, `ext-id`, or `space-id` for `CLASS`. Supply the value from a private file or a command that reads it safely. Do not put the value in a command argument. The command refuses terminal input because a terminal can echo it. It accepts one final LF or CRLF. It refuses whitespace, control characters, invalid UTF-8, and values longer than 4096 characters. It reads at most 4098 bytes.

The command stores arrays under `redact.literals` in the same private config. Each array uses its class name. The config file has mode `0600`. The command preserves other config fields. An existing literal is stored only once per class. Run `herdr-boss redact list` to print the counts. This list does not include the separate `redact.tenantHosts` array. Neither command prints a stored value.

Private literals match exactly, including case. A letter, digit, underscore, period, or hyphen next to a literal prevents a match. URL separators can surround a literal. If the same literal occurs in more than one class, the first class wins in this order: `host`, `app-id`, `ext-id`, `space-id`.

Run `herdr-boss redact --check FILE...` from the repository to scan the current contents of tracked files. Paths are relative to the current directory. Omit the paths to scan all tracked files. The command ignores untracked files in this form. An explicit untracked path causes a failure. A missing file, a symbolic link, or a file outside the repository also causes a failure.

The check prints each finding as `file:line class: count`. It then prints the total for each class. It redacts file names before it prints them. It prints no matching text. A wrapped value uses the line where the value starts. The check shares the filter rules and the private config with the stdin command. It prints no findings if a file cannot be scanned safely.

The stdin command and the check preserve clean lines and their line endings. They join a line with the next indented line only when the join reveals one sensitive value split by terminal wrapping. They keep at most 65,536 characters for an input line.

The stdin command exits 0 when it finishes and 1 when it cannot redact the input safely. The add and list commands exit 0 on success. The add command exits 1 when it cannot store the literal safely. The check exits 0 when clean, 1 when it finds a match, and 2 when it cannot scan safely. An invalid command exits 2.

### Secret commands

`secret set` reads the value from stdin only. When stdin is a terminal, it prompts without echo. Backspace and Delete remove the last character. Enter or Ctrl-D ends the value. Ctrl-C cancels the command and exits 130. A pipe may end with one LF or CRLF; the command strips that final newline. It refuses an empty value, a value over 4096 bytes, and any other whitespace. It reads at most 4097 bytes from stdin. Do not put a value in an argument. The command refuses an extra argument and says to use stdin. It accepts `--provider` and `--label` as lower case slugs. It accepts `--expires` as an ISO date and time. On success, it prints the secret name and secrets-directory path.

`secret list` prints each name with its provider, label, and expiry. It does not decrypt a value. It works in an agent pane.

`secret remove` asks you to type the name again. It overwrites and deletes the sealed value and its previous copy. It calls a named hook for the secret journal. The journal is not in use yet.

`secret check` decrypts each selected value in memory. It checks authenticated decryption, a size of 1 to 4096 bytes, valid UTF-8, no control characters, and no whitespace. A later provider validator can check a verified provider format. The validator table is empty today. The command prints only the name and `ok` or `failed`.

Each secret command appends one JSON object to `audit.jsonl` in the secrets directory, except a command refused in an agent pane or a `secret set` cancelled with Ctrl-C. The file has mode `0600`. Each line holds the name, action, and time. It holds no value, key, or value length.

`secret set`, `secret remove`, and `secret check` refuse in a Herdr agent pane. The command prints `Run this command at a terminal. It is not available in an agent pane.` and exits 3. This guard prevents accidents. It is not a security boundary because an agent can unset the environment variables. `secret list` is available in a pane.

| Exit code | Meaning |
|---|---|
| 0 | The command finished. |
| 1 | The input is invalid, a check failed, or the command failed. |
| 3 | The command refused to run in an agent pane. |
| 130 | You cancelled `secret set` with Ctrl-C. |

On Linux, `serve` checks for `lsof` and the procps `ps` command at start. A missing tool gives an installation warning in standard error and in the dashboard event log. The service continues. The check runs beside the first tick and does not delay it. The read-only preview skips the check. Install the named package to enable its process checks.

### Linux service install

Run `herdr-boss install` as your normal user. Do not use `sudo`. The command writes one unit file in `~/.config/systemd/user/herdr-boss.service`. The command then runs these commands, in this order:

```sh
systemctl --user daemon-reload
systemctl --user enable herdr-boss.service
systemctl --user restart herdr-boss.service
```

The restart applies a new repository folder or data directory to a service that already runs. A failed command stops the install and prints the error. The unit file stays for a repair run.

The unit file starts `node`, the `src/cli.js` of the repository, and `serve`. It sets `WorkingDirectory` to the repository folder. It sets `PATH`, `StandardOutput`, and `StandardError`. Both log lines write to `server.log` in the data directory. It restarts the service after the process exits. A manual `systemctl stop` keeps the service stopped. The unit file holds no secret.

The unit sets `HERDR_BOSS_DIR` when the configured data directory is not `~/.herdr-boss`. The unit sets `HERDR_BOSS_LIVE_DIR` to the same folder. The service keeps the configured data directory. The service never uses the data directory of another factory.

The unit file is systemd text, not shell text. The installer encodes each directive by its own rule. It quotes the values of `ExecStart` and `Environment`. A double quote and a backslash get a backslash. In `ExecStart`, a dollar sign becomes two dollar signs, because systemd expands a dollar sign. It writes the path of `WorkingDirectory` and of the `append:` log lines without quotes. In every directive, a percent sign becomes two percent signs, because systemd expands a percent sign. A path with a newline or another control character cannot be written safely. The installer refuses it and names the value. Move the repository or the data directory to a clean path, and run the command again.

A systemd user service starts with your session. The service runs only while you are signed in. The installer does not use a system service, `sudo`, `loginctl enable-linger`, or a package manager. The installer does not check that the service runs. Run `herdr-boss doctor` after the install.

Run `herdr-boss uninstall` to stop the service. The command runs this command first:

```sh
systemctl --user disable --now herdr-boss.service
```

If this command fails, the uninstall stops with the error and keeps the unit file. If no unit file exists, the uninstall ignores the failure. Otherwise the command removes the unit file it wrote and runs `systemctl --user daemon-reload`.

The uninstall removes only `herdr-boss.service`. It leaves every other unit file.

An operating system that is not macOS and not Linux fails with a clear message. The command writes no file, creates no data directory, and runs no command on such a system. Windows users run the Linux path inside Ubuntu under WSL2.

This install path is verified with tests and a fake `systemctl`. The tests do not run a real Linux service. Verify the result on a Linux machine with `herdr-boss doctor` and `systemctl --user status herdr-boss.service`.

### First-hour setup

Run `bin/herdr-boss setup` from the downloaded repository.
The wizard uses the [shared onboarding steps](onboarding.md#the-shared-step-names).
It checks one step at a time with `doctor`.
It skips a step when its checks pass.
It checks each step again after an action.

The wizard prints each install command before it asks for your yes in the terminal.
Type `no` to refuse the command.
Without a terminal, it prints the action and stops.
Run the command yourself, or resume setup in your terminal.
Only you sign in and add the Claude settings in your editor.
Never type a password, a key, or a token into the wizard or a chat.

Choose `paced` or `unpaced` when the wizard asks about Claude.
You can also run `herdr-boss setup --resume --pacing paced` or `herdr-boss setup --resume --pacing unpaced`.
`paced` sets the Claude provider mode to `managed` in the policy.
`unpaced` sets it to `ignore`.
The other provider modes keep their values.

Name your first project with `herdr-boss project new <slug> --group <folder> --start`.
Then run `herdr-boss setup --resume`.
The wizard checks the project registration and the Git repository.
It accepts a Git worktree with a valid `.git` file.
It then opens the local dashboard.
Answer your first Mailbox question and submit your first review pack there.
Resume setup in your terminal after each action.
Confirm each action with `yes` when the wizard asks.
If no question or pack exists, ask the Boss in Chat.

Progress is in `setup.json` in the data directory.
The file holds step names, states, the pacing choice, and your confirmations.
It also holds an integer revision that increases by one at each save.
It holds no secret.
Setup refuses a progress, policy, or policy-log file that links outside the data folder.
Its file readers and writers do not follow symbolic links.
Setup assumes that the data directory is not replaced while it runs.
Setup does not lock the data directory.
If two runs use the same progress file, setup refuses a run at the first save that conflicts.
Before each save, setup reads the revision again.
If another run changed it, setup writes nothing and exits 1 with `Another setup run changed the progress. Run setup --resume.`
A missing or corrupt progress file has revision 0.
After a crash, resume setup to continue the saved progress.
Each run checks the computer again.
`--resume` continues the saved progress.
A plain rerun also continues it.
`--dry-run` prints the full plan and changes nothing.

Exit code 0 means that all steps pass, or that a dry run ends.
Exit code 1 means a usage error, a refusal, or a failed action.
Exit code 3 means that a step waits for you.
The last lines name that step and give the next action.
On Linux, follow the printed tool and service instructions yourself.
The wizard does not run the service install on Linux.
Run `herdr-boss install` yourself. It writes a systemd user service.

### Service checks

`GET /api/health` returns the health body: `schema`, `contractVersion`, `version`, `kitRevision`, `tickAgeSeconds`, `herdrReachable`, and `clockOffsetSeconds`. Use `curl -fsS http://127.0.0.1:4477/api/health` on the machine of the service. The body holds no path and no secret. The route answers HTTP 503 with `{"error":"kit revision unknown"}` when the kit revision cannot be read. `/api/health` stays behind the access check. A prober on another machine sends the read token. See the Health route section of the user guide.

Set `allowedHosts` to accept more `Host` names, for example `["*.localhost", "factory-two"]`. The default is an empty list. Set `log.maxMegabytes` and `log.keepFiles` to control the rotation of `service.log` in the data directory. The Settings reference lists each setting.

Restart the service after a configuration change:

```sh
launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss
```

Start a dashboard preview with temporary data and a separate local port:

```sh
HOME="$(mktemp -d)" HERDR_BOSS_DIR="$(mktemp -d)" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview
```

Seed invented Mailbox and Chat messages into a temporary data directory before the preview starts:

```sh
HOME="$(mktemp -d)" HERDR_BOSS_DIR="$(mktemp -d)" node scripts/seed-preview.js
```

The script refuses the live data directory, a directory inside it, and a symlink to it. Use the same `HERDR_BOSS_DIR` for the preview.

Choose an unused local port if 4478 is busy.

A read-only preview keeps the saved project register. It does not import projects at start or after a project status or policy change. It does not call Herdr to import projects or read the live setup state.

`HERDR_BOSS_DIR` selects the data directory. The live data directory is always `~/.herdr-boss`.

A preview collects and evaluates, so it writes `state.json`, `rules.json`, `bulletin.md`, and quota history into its data directory. A preview therefore requires `HERDR_BOSS_DIR` to name a separate directory that the service does not use. The directory does not have to be empty. A directory that holds files from an earlier preview is valid. The command refuses to start when `HERDR_BOSS_DIR` is unset. It also refuses when the path resolves to the live data directory or to `~/.herdr-boss`. A symlink in the path gives the same refusal. The refusal happens before the command creates or migrates a data directory.

When `NODE_TEST_CONTEXT` is set, or the data directory differs from the configured live directory, the Engine disables prompts, notifications, process reaping, handovers, and push prompts. Set `HERDR_BOSS_ALLOW_ACTIONS=1` only when you intentionally need these actions outside the live service.

## Doctor

Run `bin/herdr-boss doctor` from the downloaded Herdr Boss folder.
Use `herdr-boss doctor` when the command is on `PATH`.
The command checks the items in [Onboarding](onboarding.md#the-shared-step-names).
It writes no Herdr Boss data, project file, or setting.
It creates no data folder.
It starts no agent session and runs no installation command.
It runs checks through the installed tools.
`opencode auth list`, `pi --list-models`, `claude auth status`, and `codexbar usage` can update their own state or refresh a token.
The other tool commands can also update their own state.
The command does not prevent those tool updates.

You should see one line for each item.
Most lines start with `green:` or `red:`.
A `red:` line gives the fix.
The disk line prints free space for the Herdr Boss data folder and worker worktree root.
It uses the lower free-space value when the folders are on different file systems.
It starts with `note:` below 15 GB and `error:` below 5 GiB.
The note does not change the exit code.
The existing doctor check returns exit code 4 below 5 GiB.
Do the fix, then run the command again.
Only you sign in and add the Claude settings lines.
Keep passwords, keys, and tokens out of chat.

Homebrew can replace the node binary of the launchd job.
The job then stays down and shows exit code 78.
The `Herdr Boss service` item of `doctor` is red.
Its fix reads `Homebrew replaced node: run herdr-boss install`.
Run `herdr-boss install`, then run the command again.
On macOS, each other `herdr-boss` command prints the same line once on standard error before its own output.
It prints the line when the dashboard port does not answer and the job shows the problem.
That check skips `doctor`, `install`, `uninstall`, `logs`, and `serve`.
It stops each probe after one second.
A failed probe prints nothing and never changes an exit code.

Add `--json` for an agent.
The result has `schema: "herdr-boss.doctor/1"`, `ok`, `exitCode`, and `items`.
Each item has `id`, `stepId`, `name`, `status`, `message`, and `fix`.
The disk item also has `severity` and `freeBytes` when the space check succeeds.
The status is `green` or `red`.
The fix is `null` for a green item.
The exit code is 0 when all items are green.
The exit code is 4 when an item is red.
An incorrect option exits with code 1.

On Linux, the `pacing` step replaces the CodexBar usage reading with four checks of the factory usage readers: `codex-usage` (`codex login status` shows a login), `codex-version` (`codex --version` shows a version), `claude-usage-file` (the newest file in `claude-rate-limits/` in the data folder is not older than 3 hours), and `claude-version` (`claude --version` shows a version). The checks of `claude-usage-file` read only the modification time of the files, never their content. A red line gives a plain fix, for example `Start a Claude session in the factory`. The check for CodexBar stays in the `tools` step. On Linux, its fix says that CodexBar is not needed.

Inside a factory, `doctor` also prints one `warning:` line for each registered project outside the work volume. The warning says that the project is not trusted. It does not change the doctor result or exit code. The JSON report lists these lines in `warnings`.

The shared step IDs stay the same as the onboarding table.
Each check also has its own item ID.

| Step ID | Item IDs |
|---|---|
| `check` | `os`, `disk`, `memory` |
| `tools` | `node`, `git`, `git-name`, `herdr`, `claude-installed`, `codex-installed`, `opencode-installed`, `pi-installed`, `gh`, `codexbar` |
| `signin` | `claude-signed-in`, `codex-signed-in`, `opencode-signed-in`, `pi-signed-in` |
| `settings` | `claude-settings`, `codex-settings`, `codex-rules`, `opencode-settings` |
| `service` | `service`, `data-folder` |
| `pacing` | `usage-reading` |
| `dashboard` | `service-answers` |

The command checks all four agent apps.
A missing add-on gives a red item.
Codex, OpenCode, and Pi remain optional for your first project.
The Pi sign-in check reads the available model table.
It checks for a configured provider, without a model request.
It does not test whether the provider accepts the login.

Node must be version 26.10 or later.
The home disk must have at least 5 GiB free.
The computer must have at least 8 GiB of memory.
Each check has a five-second time limit.
A check that times out gives a red item.
The remaining checks continue.
The checks run one after another.
Allow up to 125 seconds for the 25 checks.
With `--factory-host`, allow up to 135 seconds for the 27 checks.
Command startup and report output add time to these limits.
On macOS and Linux, a timeout stops the process group of that probe.
This includes helpers that stay in the same group.
The CLI flushes the report and exits with its result code.

Add `--factory-host` only on a host that runs factories.
This option adds `docker` and `docker-contexts` under the `tools` step.
The first check runs `docker context inspect`.
The second check runs `docker context ls`.
Both checks read saved context metadata.
They send no request to a Docker service, including a remote context.
They do not check whether a Docker service is running or reachable.

The data folder check reads directory metadata and access rights.
It reads no file in `~/.herdr-boss` or `~/.config/herdr-boss`.
The settings checks read only the named Claude, Codex, and OpenCode settings files.
The checks accept a symbolic link to a regular file or directory, such as one in a dotfiles folder.
The settings checks refuse links into Herdr Boss data and access folders.
They also refuse links into the protected credential and session folders of other tools.
The data folder check accepts a directory link outside those other protected folders.
OpenCode accepts `opencode.json` or `opencode.jsonc`.
`XDG_CONFIG_HOME` selects the OpenCode settings folder when set.
The service check reads its local health reply.
`HERDR_BOSS_PORT` selects the service port.
`HERDR_BOSS_DIR` selects the data folder to check.
Output shows the home folder as `~`.
It includes no tool output, setting values, host name, address, key, or private path.

Run `doctor` as your normal user.
Do not run it with `sudo`.
On macOS, `sudo` makes the service check target `gui/0`, the root user's service domain.
The service fix tells you to run the command without `sudo`.

On Linux, the service check uses the systemd user service.
CodexBar and its usage reading stay red when CodexBar is absent.
The native Linux setup and Linux usage reader are separate onboarding tasks.

## Tool versions

Run `herdr-boss tools check` to compare the installed Mac versions and factory pins with public upstream releases.
The command always checks upstream.
Add `--json` to print the saved state as JSON.
The command uses public HTTPS endpoints and does not use your GitHub CLI login.

The command saves `tools-state.json` in the data directory.
`HERDR_BOSS_DIR` selects this directory.
The default is `~/.herdr-boss`.
The file has mode `0600`.
It contains version and risk data, but no login or token data.
The command sets the directory mode to `0700` only when the directory is a real directory owned by the current user.
The command reads the factory pin file.
It does not query a running factory.

For GitHub releases, the command chooses the highest version on the tracked major line when that line has a release.
Otherwise, it chooses the highest version overall.
The age is the number of days since the first release after the tracked version.
`late` means the age is more than 14 days.
`security` means a release note has a CVE ID or a GitHub advisory link with a GHSA ID, a public advisory affects the tracked version, or the Debian security version is newer.
An advisory request failure does not discard good release data.
It can delay an advisory warning until the next check.
An upstream release request failure keeps the last known latest version.
It keeps a saved `security` risk and marks other risk values `unknown`.

`doctor` prints one line for each late or security row.
A late row is a note and keeps exit code 0.
A security row from a check older than 24 hours is ignored.
`doctor` prints `note: tool check is stale, run herdr-boss tools check` for that row.
A fresh security row is an error and sets exit code 4.

When a Mailbox post fails, the command prints one note for that tool.
It continues with the other tool updates.

Run `herdr-boss tools bump TOOL` to prepare a pin change.
The command checks the published checksum or package integrity first.
It refuses a missing checksum, a checksum mismatch, or a tool with no checksum source.
It waits three days before a Claude, Codex, or OpenCode release unless a security fix is verified.

The command creates a linked worktree at `<worktreeRoot>/<repo>/tools-bump-<tool>-<version>`.
It uses the project's configured base branch.
It creates a `tools/` branch for the selected version in that worktree.
It writes `factory/pins.json` atomically and commits the file in the worktree.
The commit message ends with `Kit-Impact: none`.
The main checkout and its pin file stay unchanged.
The command refuses an existing worktree at the target path.
If the atomic write or commit fails, it removes the worktree and branch.
After a successful commit, review the branch through the normal project process.
Add `--to VERSION` to select a published version.
Add `--dry-run` to print the diff without creating a worktree or branch.
When an advisory request fails, the command prints a note that the three-day security exception was not checked.
It still waits three days unless the release notes show a security fix.

## Quota reset plan

Use `herdr-boss quota plan codex` to calculate Codex reset credit guidance. The command prints the current use, reset time, history p90, planned credit times, total use by the horizon, gain against a plan without credits, five burst rates, and fast and slow scenarios. The command also prints the plan mode, the planned use now with the points that actual use is ahead of or behind the plan, and the recent burn with the line `at this rate: 95 percent about <weekday day month HH:MM>` in local time. The command prints the burn line only when the last 24 hours hold at least two readings of the current window and the burn is positive. The line says `not before the window reset` when the projected time follows the reset time, and `already at or above 95 percent` when use has reached the threshold. The percent in the line is `quotaPlan.applyThreshold`. Add `--json` to print the full plan. The anchor of the planned curve moves in four cases: no anchor exists, the burst pace changes, the reset time moves by more than 10 minutes, or use drops by more than 1 point below the anchor. The JSON holds `anchor`, `planMode`, `projection`, and `guidance.difference`.

The Analytics page uses matching history for the selected Codex window. It plots actual use, fast and slow plans, and the range between them. It marks quota windows, credit apply times, and expiries. The card shows an empty state when the window has no history. Use the reset form to save a full or partial reset announcement. Only the Owner can save an announcement.

Set `--burst-pace N` to compare another burst pace. Use `--what-if TIME` to set the calculation horizon. Use `--announce TIME[:full|partial]` to include a hypothetical reset in this calculation. These options do not save a plan or an event. The default horizon is the last available credit expiry. Herdr Boss supports only `codex` for this command.

Use `herdr-boss quota announce codex --at TIME [--kind full|partial] [--refund N]` to save a known reset and re-plan. The time must be in the future and within 30 days. A partial reset needs a refund from 0 to 100 points. List saved events with `herdr-boss quota announce --list`. Remove one with `herdr-boss quota announce --remove ID`.

Use `herdr-boss quota credit used ID` after the Owner confirms that they applied a credit. Herdr Boss never applies a reset credit. The Codex plan line in `herdr-boss lanes` and the bulletin shows the current guidance and next planned credit. A plan is guidance only. It does not change worker admission or dispatch.

The service posts one `approve` Mailbox item for a credit when usage reaches the effective threshold and its planned time has arrived, or when the credit expires within 48 hours. The item states the measured usage, current time, exact expiry, and the fast and slow point difference between applying now and waiting for the planned time. Each open item blocks another item for the same credit. The `quota credit used` command closes the item. A usage drop greater than 30 points also closes the open credit item with the earliest expiry and marks that credit used.

The service adds one `warn` notice when an available credit enters its 24-hour expiry period. The notice uses the normal delivery path and appears once for that credit and expiry. Herdr Boss never applies the credit. The Owner applies it in the Codex app.

The service refreshes the plan after each good quota reading. It skips a write when the inputs have not changed. It reads the current Codex quota, the sanitized reset credit fields, and the last 14 days of `quota-history.jsonl`. It stores events, used credit IDs, and up to 50 plan records in `quota-plan.json` in the data directory. The service writes this file atomically.

`GET /api/quota-plan/codex` returns the plan, burst table, credits, announcements, observed resets, and the selected window key. It also returns up to 14 days of matching history for the Analytics chart. `POST /api/quota-plan/codex/announce` accepts an announced reset with the same time and refund rules. Only the Owner can use this route. `/api/state` includes a small `quotaPlanSummary` object for dashboard use.

## Resources and policy

| Command | Action |
|---|---|
| `herdr-boss lanes` | Show the active Owner state, machine CPU and threshold, 5-minute load and backstop, then one line per quota provider. Codex guidance uses its planned curve when quota history or a reset credit is available. The command shows the next credit in one `Codex plan` line. A Claude lane at 80 percent weekly use or more, with more than 12 hours to the weekly reset, shows `claude hold new Claude work (80% weekly used; 100 percent at Sun 4 Oct 03:00)` and leaves the Use now line. The time is the local time at which the Claude weekly burn of the last 24 hours reaches 100 percent. The text shows no time without a positive burn or with fewer than two readings. The hold does not change `worker start`. Show common unmetered models once by harness with project exceptions, followed by exhausted free models and retry times; show active model cooldowns with their lane and retry time; show each trial model with its number of scorecard results. A record that lasts until re-enabled shows `until re-enabled`. Show only this project's models inside a configured checkout. |
| `herdr-boss models enable KIND/MODEL` | Remove the launch record of a model that is unavailable until it is re-enabled. The command prints `Enabled KIND/MODEL.` or reports that no record exists. |
| `herdr-boss models disable KIND/MODEL [--reason TEXT]` | Mark a model unavailable until it is re-enabled. `worker start` skips it without `--model` and refuses it with `--model`. |
| `herdr-boss models [--kind KIND]` | The allowed harnesses, models, and efforts from `kit/models.json` and the policy `extraModels`. A kind with policy models also has `localModels`. That field lists the models that come from the policy `extraModels` and not from `kit/models.json`. An active model cooldown or launch record appears in `unavailableModels` with its lane and retry time. A record that lasts until re-enabled has `untilReenabled: true`. |
| `herdr-boss policy show` | Print the resource policy (`~/.herdr-boss/policy.json`). |
| `herdr-boss policy set FILE [--confirmed] [--allow-sum]` | Validate and replace the policy. The service applies it on the next tick. The command refuses a change of 3 or more project shares unless you add `--confirmed`. It refuses project shares that do not total 100 unless you add `--allow-sum`. The refusal prints each changed project with its old and new share, and the flag to add. A file that changes no share saves without a flag. Each write adds one line with the caller kind `cli` to `policy-changes.jsonl`. See [Policy changes](reference/settings.md#policy-changes). |
| `herdr-boss usage record FILE` | Add one measured or unmeasured usage event. |
| `herdr-boss usage summary` | Usage per project and provider. |
| `herdr-boss spend [--days N] [--json]` | Token use and cost for the last N days (1 to 90, default 7). It prints one line for each day and role, then one total line for each day. The count includes the Claude subagent transcripts, in the `subagents` folder of each session. Their usage belongs to the role of the parent session. When a day has subagent tokens, an `of which subagents` line follows the total line. It shows the part of the total that came from subagents, in USD with the label `API-price equivalent`. The cost is in USD and carries the label `API-price equivalent`: the Owner is on a subscription and is not billed per token. `unpriced` marks tokens of a model without a price. A last line lists models with `unconfirmed` price figures. `--json` prints the full summary, with the harness split, the `subagents` part of each total and role row, `costLabel`, and `unconfirmedPrices`. The service updates the numbers every 5 minutes. |

A worker pane that reports `Free usage exceeded` puts that model on cooldown for 60 minutes, or until a later retry time that the provider reports. An overload such as `503 service_overloaded` puts that model on a fixed 30-minute cooldown. When you omit `--model`, `worker start` chooses the next available model in the same lane and records the fallback in the run record. An explicit `--model` does not fall back.

A worker run that ends with the error text `Model is unavailable` counts one failure for its model. Three such failures within 24 hours mark the model unavailable for 6 hours. `worker start` then refuses an explicit `--model` with a message that names the model, the failure count, and the time the model returns. The unmetered lane leaves the model out. A successful `worker collect` of the model clears its count. `--force --reason TEXT` overrides the refusal and writes an audit line. The counters are in `unavailable-models.json` in the Herdr Boss data directory, bounded to 50 models.

Start a Claude Haiku worker with `worker start NAME --kind claude --model claude-haiku-5-5 --effort medium --task TEXT`. The allowed efforts are `low`, `medium`, `high`, `xhigh`, and `max`. Haiku workers use `medium` when you omit `--effort`. Other Claude models do not have an effort setting. Haiku is an extra model. Sonnet stays the default Claude model.

For kind `pi`, `worker start` runs `pi --list-models` once for each process before it starts the pane. The limit is 10 seconds. The command ignores `Warning:` lines. It refuses a `--model` that the listing lacks, and `--force` does not bypass the refusal. The message names the missing model, the provider that lists a model of the same name, and up to five listed models of the chosen provider. If `pi --list-models` fails, times out, or lists no model, the command prints a warning and starts the worker. The listing does not show an upstream outage. A listed model that ends with `Model is unavailable` is counted by the repeated-failure rule above.

At launch, `worker start` reads the pane text of an OpenCode worker. It looks for `Unrecognized flag: FLAG`, `not available in your country`, and `Rate limit exceeded`, in any letter case. The command does not print other pane text.

Some OpenCode TUI versions accept `--model` and `--agent`. Other versions reject them. At the first OpenCode start in a process, `worker start` runs `opencode --help` once and caches the answer. For a TUI that accepts the flags, the command passes `--model MODEL` and `--agent worker` at the launch. For a TUI that rejects the flags, the command writes `opencode.json` in the worker worktree. That file sets `model` to the chosen model and `default_agent` to `worker`. The command adds `/opencode.json` to the worktree git exclude, so the file stays out of the worker commit. The file holds no secret. Only one OpenCode TUI starts at a time on the machine.

A pane that shows `Unrecognized flag: FLAG` fails the start. The message names the flag. The command answers nothing, closes the pane, removes the worktree and the branch, and marks no model. The installed TUI does not support the launch flag.

`not available in your country` and `Rate limit exceeded` are launch blocks. The command answers nothing, closes the pane, and does not launch the same model again. The start attempt fails with the matched phrase in the message. `not available in your country` marks the model unavailable until you run `herdr-boss models enable KIND/MODEL`. `Rate limit exceeded` marks the model for 30 minutes. The records are in `unavailable-models.json` in the Herdr Boss data directory. Without `--model`, `worker start` then starts the next available model of the same lane. With `--model`, the start fails. A start with `--model` also fails for a model that is unavailable until it is re-enabled.

A model in `trialModels` of `kit/models.json` has the `trial` tag on the Models page and in `herdr-boss lanes` until its scorecard has 5 results. A result is a usage record with a model outcome. Pass `--model-result` to `worker collect` to record it.

Each quota lane shows the last good reading and its age. Herdr Boss keeps that reading after a probe fails. It marks the reading stale after three hours. Pacing advances the expected percent with the window time. It keeps the measured used percent.

Herdr Boss reads providers in sequence once per quota interval. The Claude probe starts with a 60-second timeout. After a failed reading, the next Claude probe uses 90 seconds. A good reading resets its timeout to 60 seconds. Codex and OpenCode Go keep the 20, 45, then 90-second timeout sequence. A good reading resets their timeout to 20 seconds.

On timeout, Herdr Boss sends SIGTERM to the probe child by PID and to its own process group. If the child remains after three seconds, Herdr Boss sends SIGKILL. It also stops children in that group when the probe child exits. It never selects a process by name. Herdr Boss does not retry a timed-out probe at once. If the Claude probe fails for over 60 minutes, Herdr Boss sends one warning to the Boss. It sends no orchestrator prompt.

After the Claude probe times out twice in a row, Herdr Boss probes Claude every 20 minutes. After a good reading, it probes at the normal quota interval of 5 minutes again. Codex and OpenCode Go keep the normal interval. The policy keys are `quotaProbe.backoffAfterTimeouts` (default 2) and `quotaProbe.backoffMinutes` (default 20). See [Harness setup](harness-setup.md) for a Claude probe that times out at about 30 seconds.

A missing usage reader or login is not a probe failure. The reading shows as unknown with the reason, for example `no usage reader in this factory` or `no login for this harness in this factory`. The bulletin says `Usage limits are unknown for Claude (no usage reader in this factory). Not a probe failure.` Herdr Boss raises no Boss warning, no provider back-off, and no fleet alert for this state. A factory reads each usage limit with CodexBar first, the same code path as the Mac. Herdr Boss falls back to the own readers only when CodexBar is missing. In a factory, the own Codex reader uses `codex app-server`, which uses the Codex login of the factory. In a factory, Herdr Boss reads the Claude usage limit from the files of `herdr-boss claude-statusline`. The Claude reader gives an unknown reading with one of these reasons: `no Claude session has reported usage yet`, `the last Claude usage report is past its reset`, or `the last Claude usage report is older than 3 hours and past its reset`. OpenCode Go reads the local cost history from CodexBar. The account windows need an OpenCode API key: until the key exists, the reason text is `account windows need an API key`. The row adds the reset time that you set by hand in **OpenCode Go reset time** (`quota.opencodeGoResetAt`). It also adds a local estimate. Herdr Boss runs `opencode stats --models --days N` and keeps the tokens, the cost, and the model names of the `opencode-go/` rows. N is **OpenCode Go estimate days** (`quota.opencodeStatsDays`, default 7). The label of the estimate is `used in this factory (local estimate)`. The estimate counts the sessions of this factory only. It is never a percent and never a quota. Herdr Boss runs no login command and reads no web page for it. The Codex reader gives an unknown reading with one of these reasons: `codex is not installed in this factory`, `no login for this harness in this factory`, or `Codex reports no usage limit for this login (an API key login has none)`. These Codex results are probe failures, not unknown readings: `Codex usage read timed out after N s`, `Codex usage read failed: <text>`, `Codex usage read ended: the app server exited before it answered`, `Codex usage read returned no rate limits`, and `codex app-server protocol changed`. After a probe failure, Herdr Boss keeps the last good reading as a stale reading. A Mac process keeps `no usage reader in this factory` when CodexBar is missing.

The service keeps the last 100 probe attempts in `quota-probe-history.jsonl`. Each row records the provider, duration, timeout, and outcome. The outcome is `success`, `timeout`, `failed`, or `unavailable`. A missing usage reader or login records `unavailable`. It also records `endedStep`, `killedPid`, `killedPidState`, and `killSignal`. `endedStep` names the step that ended the probe: `completed`, `our-timer`, `codexbar-timeout`, `codexbar-error`, `codexbar-exit`, `row-missing`, or `spawn-error`. The PID state is `exited`, `alive`, or `unknown` after a kill attempt. The kill fields are `null` when no kill was attempted. The file does not store probe error text.

## Project status

| Command | Action |
|---|---|
| `herdr-boss publish SLUG FILE [--force] [--sync]` | Validate a status file and install it for `/projects/SLUG`. Use `-` for standard input. Refuse a status in which a task has a live worker but is not `doing`. `--force` skips this check. `--sync` sets each card state from git, workers and issues before the install and prints how many cards changed. Schema: [project-status.md](project-status.md). |

Run `publish --sync` at each task boundary. It reads facts from the project in the Git top level. See [Publish with sync](board.md#publish-with-sync). For a GitHub repository, GitHub controls completion. An issue must have `state: closed` and `state_reason: completed` before the sync can set its card to `done`. An open issue stays `doing` or `todo`. A failed GitHub read keeps each card as it is and prints the reason.

A commit supplies completion evidence only with `Closes #N`, `Fixes #N`, `Resolves #N`, or a separate `Task: N` trailer line. The issue must belong to this repository. The author time must be after the issue creation time. The commit must be reachable from the GitHub default branch. Bare numbers, branch names, and merge subjects supply no completion evidence. A card with `partlyDone: true` never moves to `done` through the sync.

The command prints `synced N cards from git and workers`. Each changed card gets a `sync: ID from -> to` line on standard error. A valid commit adds its short ID and the first 60 characters of its subject. When GitHub keeps an issue open, the command prints `kept open: GitHub open` with the short ID of an ignored commit, if one is present. The live-worker check below runs after the sync.

`publish` reads the run records of the project in the Git top level. A worker blocks the publish when all of these are true:

- its run record has no `finishedAt` and no `collectedAt`;
- `herdr agent list` shows an agent with the worker name and the status `working` or `blocked`;
- the worker has no `report.json`;
- the worker is not parked. Then, when its task is not `doing` in the status file, `publish` prints one line with the task ID and the worker name. It exits with code 1 and publishes nothing. Set the task to `doing`, or run `publish` again with `--force`. A task ID that is not in the status file counts as not `doing`. An idle or done agent, a parked worker, and a worker that wrote its report wait for the orchestrator, so they never block a `review` or `done` status. When Herdr fails or lists no agent, no worker blocks the publish. A run without a task ID is not checked. See [Live task state](reference/dashboard.md#live-task-state).

`publish` closes an open Mailbox item only through its linked task (`mailboxId`). It closes the item when that task is done or no longer waits on the Owner. It also closes the item when that task was in the previous status and is absent from the new status. The new status must have at least one task. A status with no tasks closes no items. An item that no task links to never closes, at no age. Each item that the Boss posts stays open until the Owner answers or someone closes it. `publish` does not close review items, Boss-thread items, items from the Boss, or items that are already closed. It prints `Closed N Mailbox items of SLUG: the task no longer waits on the Owner.` A failed Mailbox update prints a warning and does not fail the publish.

`publish` keeps the stored status small. It keeps the newest 30 done tasks, ordered by `updated`, or by file order when `updated` is missing. It removes the older done tasks from the stored file. A done task that a kept task or an open task lists in `blockedBy` stays in the file.

The command records the ID of each removed task in `doneIds`. It sets `doneCount` to the number of unique IDs in `doneIds` plus `doneCountBase`. `doneCountBase` holds counts that have no ID: a `doneCount` from an older stored status, and IDs dropped from a full `doneIds`. A done task without an ID, or with an ID over 200 characters or with control characters, stays in the file and is not counted. `doneIds` holds at most 5000 IDs. The oldest ID leaves first and moves into `doneCountBase`. An ID that is in `tasks` again, for example an open task, leaves `doneIds`.

The orchestrator keeps its own file unchanged. Publishing the same file again leaves `doneCount` unchanged. `publish` prints one line, `moved N done tasks into doneCount`, only when N is more than 0. `publish` prints a warning, and still publishes, when the stored status is larger than 200 KB. `doneCount` and `doneCountBase` must be integers from 0 to 1000000. `doneIds` must be an array of strings.

`publish` also checks `AGENTS.md` at the Git top level of the current directory, when that file exists. It prints each finding to standard error as a warning. It publishes the status in all cases. The published record gets `agentsCheck: { checkedAt, errors, warnings, file }`. The record holds only the counts and the repository-relative file name. The project page shows a warning line when `errors` or `warnings` is more than 0. `publish` refreshes a behind kit and sets `kitRevision` in the stored status from the kit file on disk. The project page compares `kitRevision` with the kit revision on disk and with the current kit revision.

The first `publish` of a slug registers the project. It records `{ slug, repo, remote }` in `project-repos.json` in the data folder, with mode 0600, when the Git top level exists. `repo` is the Git top level. `remote` is the `origin` URL without a user name and a password. A later publish keeps the first record. For a new slug, `publish` runs `harness sync --codex-only` and prints its result as `warning: harness sync:` lines.

### Board state routes

`GET /api/projects/SLUG` returns the status of one project with the live overlay. It answers 404 when no project has the slug. `GET /api/projects` and `GET /api/state` return the same fields for each project.

Each task has these fields. The fields `state`, `stateSource`, `publishedStatus` and `worker` stay.

- `computedState`: `todo`, `doing`, `review`, `done` or `stuck`. The service computes it from git, worker records and the issue tracker.
- `publishedState`: the `status` that the orchestrator published.
- `source`: `{ kind, ref, at }`, or `null` when no fact applies. `kind` is `commit`, `worker`, `issue` or `review`. `ref` is the short commit id, the worker name or the issue number.
- `diverges`: `true` when `computedState` differs from `publishedState`.
- `stuck`: `{ reason, ageMin }` when `computedState` is `stuck`, otherwise `null`.

`state` is the board column. It uses the computed result. A stuck card keeps `state` `doing`. The page shows a card with `computedState` `stuck` in the Stuck lane.

Each project has `boardDiverged` (the number of cards that diverge), `boardDivergedIds` and `boardStuck`. The project list row has the same counts. The overlay never writes the status file. See [board.md](board.md).

## New project flow

### Command

```
herdr-boss project new <slug> [--group DIR | --path DIR] [--remote gh|URL|none]
  [--visibility private|public] [--org NAME] [--kind claude|codex] [--goal TEXT]
  [--start] [--dry-run] [--resume]
herdr-boss project check <slug> [--fix STEP [--start]]
herdr-boss project type check FOLDER
herdr-boss project open <slug> [--start] [--force --reason TEXT] [--dry-run]
herdr-boss project park <slug> [--prepare] [--dry-run]
herdr-boss project archive|unarchive <slug> [--dry-run]
herdr-boss project transfer plan|start|switch|cancel <slug> --to <factory>
herdr-boss project paths [--json]
herdr-boss project unregister <slug>
```

`project new` calls `runProjectNew` and prints one line for each step, the project path, and the next action. It never prints a token.

Run `herdr-boss project type check FOLDER` to validate one type folder or a catalog folder. A type folder contains `manifest.json`. The command checks the schema, rejects unknown fields and unsafe paths, checks every file named by the manifest, and rejects an unknown setup operation. A catalog folder contains the type folders. The command checks all of them and requires one default type and unique type IDs. This command reads files and changes nothing.

| Flag | Meaning |
|---|---|
| `--group DIR` | The group folder. The project folder is `DIR/<slug>`. |
| `--path DIR` | The project folder. Give `--group` or `--path`. A normal install has no default folder. In a factory, the default group is `/home/factory/work`. The command creates it. |
| `--remote` | `none` (default), `gh`, or a Git URL. `gh` creates a GitHub repository after an Owner decision. A URL is https, ssh, or git, or `user@host:path`. A URL must not hold a user name or a password. A GitHub remote adds the CI workflow templates. |
| `--visibility` | `private` (default) or `public`. `public` needs a remote that is not `none`. With `--remote gh`, `public` only offers the choice `Create public` to the Owner. |
| `--org NAME` | The organization for `--remote gh`. Without it, the repository belongs to the `gh` login. |
| `--kind` | The harness of the first orchestrator: `claude` or `codex`. It overrides the first usable entry of `orchestratorLadder`. The model comes from the policy for that kind. |
| `--goal TEXT` | One line for the README and the first status. |
| `--start` | Create the Herdr workspace and start the first orchestrator. The orchestrator uses model quota. Off by default. |
| `--dry-run` | Print each step as `would ...`. Change nothing. |
| `--resume` | Continue a saved run. |

Only the steps of `runProjectNew` that are built run. The step `check` prints `not built yet`. The values of `--remote`, `--visibility`, and `--org` control the step `remote`. The values of `--kind` and `--start` control the step `workspace`.

For a GitHub remote, the `files` step copies these files from `kit/templates/workflows/` into `.github/workflows/`:

- `quick.yml` runs a quick check on each pull request.
- `verify-changed.yml` runs a changed-files verify on pushes to `main`.
- `full-gate.yml` runs by manual request or on a published release.

Each file has a placeholder `run:` command. Replace it with a command for the project. Keep the concurrency setting and the path filters. Do not run the full gate for each push to `main`.

The step `harness` runs the Codex part of `herdr-boss harness sync` and reserves the project browser. It prints the Claude autoMode lines. It never edits `~/.claude/settings.json`. See "Step harness" below.

A step prints one state: `done`, `skipped`, `waiting`, `failed`, `pending`, `not built yet`, or, in a dry run, `would ...`.

### Step harness

The step `harness` does three things for the new project:

1. It adds the missing Codex `writable_roots` to `~/.codex/config.toml`. It writes a backup file first. It adds no root that exists.
2. It prints the Claude autoMode lines that `herdr-boss harness sync` prints. It never edits `~/.claude/settings.json`. When a line is missing, the step detail says `needs Owner action`. Add the printed lines to the file yourself.
3. It reserves the project browser, the same as `herdr-boss browser request <slug> --reserve`. It launches no browser.

A Codex root or a browser port that cannot be set is a warning in the step detail. The step does not fail. A second run changes nothing. A dry run changes and reserves nothing.

The step changes a file under the home folder only for the live data dir. A temporary data dir is not the live data dir: the same test as `assertTempDataDir`, inverted. For a temporary data dir, the step does not change `~/.codex/config.toml`, does not write a backup, and does not reserve a browser. It prints `skipped: not the live data dir` and the Claude autoMode lines. The other steps write only inside the project folder or the data dir, so they need no such rule. The browser command of the step uses the same data dir as the flow.

### Commands project open and park

Run these commands from an Owner terminal or the pane labeled `boss`. A pane labeled `orch` can run a command only for the project that owns its workspace. A project lead cannot park its own workspace. Only the Boss or Owner can act on another project or park a project. A worker pane cannot run these commands. The command uses only the register of the local factory. Run it on the factory named in the project record.

`project open <slug>` changes a parked project to open. It checks the project and runs each missing fix step once, in this order: `folder`, `kit`, `policy`, `register`, `workspace`, and `harness`. It writes `state: open` and `lastOpenedAt` after the checks pass. It prints the project's next action. A failed step leaves the project parked and records the failed check in `project-audit.jsonl`.

| Flag | Meaning |
|---|---|
| `--start` | Create or reuse the Herdr workspace and start the project lead. The command uses the workspace step of `project new`. It uses model quota. |
| `--force` | Open the project when the default cap of 3 open projects is full. Use it with `--reason TEXT`. Herdr Boss redacts the reason and writes an action audit row when this flag bypasses the cap. |
| `--reason TEXT` | Required with `--force`. Give 1 to 300 characters. |
| `--dry-run` | Print every check and step. Change no state, take no lock, and write no audit line. |

An archived project must be unarchived before it can open. A project with an active transfer is refused. The default cap is 3 open projects. Pinned open projects do not count toward the cap. Set the cap and pinned-project rule in **Settings → Project register**. The cap limits a new open and automatic opens. It does not block import or a project that already has a live project lead. A forced open writes to `action-audit.jsonl` only when it bypasses the cap. The `--start` flag starts the project lead. Without it, the command skips the workspace start.

`project park <slug>` changes an open project to parked after all checks pass. It checks workers, input prompts, Git state, locks and leases, published status, project memory, and blocking Owner mailbox items. It refuses a workspace that contains an unrecognized pane. It checks the pane list again just before it closes the saved Herdr workspace by its ID. It closes the workspace before it releases the browser reservation. It never closes a browser. It keeps the repository, status, policy, Mailbox items, review packs, and data files. It clears the pin when park finishes.

| Flag | Meaning |
|---|---|
| `--prepare` | When Git, status, or memory blocks park, ask an idle project lead to commit and push, update memory, and publish status. Wait up to 10 minutes, then run every check again. The command sends no prompt when a worker is active or a pane waits for input. |
| `--dry-run` | Print every check and change no state, send no prompt, release no browser reservation, close no workspace, take no lock, and write no audit line. |

If a check fails, the project stays open. Park writes the state `parking` before it closes the workspace. If a later step fails, the register and audit name the failed step, and park keeps the browser reservation. Fix the cause, then run `project park` again. Park writes `parked` only after it closes the workspace and releases the reservation. The state `parking` means that park is in progress.

`project archive <slug>` changes a parked project to archived. `project unarchive <slug>` changes an archived project to parked. These commands change only the register state. Each command accepts `--dry-run`.

Each non-dry-run open and park attempt writes an audit record. A park that starts closing resources writes a second record when it finishes. Archive and unarchive write one record per state change. Audit records hold the slug, action, caller, result, failed check, and dry-run flag. They hold no repository path or remote.

### Command project check

`project check <slug>` only reads. It writes no file and starts no step. It prints one line for each item. An item line starts with `ok`, or with `missing:` and the reason. A missing item names the fix step, or says `fix by hand`.

The check works for a project that `project new` did not make. It reads the project folder, the data dir, and the Codex config. It needs no flow state file. It uses the state file for the recorded remote, repository visibility, and the question whether the flow ran with `--start`. The `ci` item reads workflow files from the project. It uses no network.

| Item | Present when | Fix step |
|---|---|---|
| `folder` | The folder exists, has a Git repository, and is on `main`. | `folder` |
| `agents` | `AGENTS.md` exists and `herdr-boss check agents` reports no error for it. | `files`, `kit` |
| `memory` | `docs/orchestration/memory.md` exists. | `files` |
| `kit` | `docs/orchestration/herdr-boss.md` has the current kit revision, and `.claude/settings.json` has the SessionStart hook. | `kit` |
| `config` | `.herdr-boss.json` is valid JSON with the slug of the project. | `files` |
| `gitignore` | `.gitignore` exists. | `files` |
| `commit` | The repository has a first commit. | `commit` |
| `remote` | `origin` is set, or the state records that the step `remote` was skipped. | `remote` |
| `ci` | The project has workflow files in `.github/workflows`. Herdr Boss prints warnings for workflow rules that it finds. | `ci` |
| `labels` | The item exists only for a private GitHub `origin` when `gh` is installed and logged in. The repository has every label of the `triage` preset with the preset color and description. Otherwise the check omits the item and calls no other command. The check reads the labels with `gh label list` and writes nothing. A missing label prints `run herdr-boss gh label sync --preset triage`. | `labels` |
| `policy` | The policy has an entry for the slug. | `policy` |
| `register` | `project-repos.json` has a row for the slug. | `register` |
| `status` | The published status exists and has a task. | `status` |
| `workspace` | The flow ran with `--start`: Herdr has the workspace. Otherwise the item is `ok`. | `workspace` |
| `orchestrator` | The flow ran with `--start`: the pane `orch` has the agent `<slug>-orch`. Otherwise the item is `ok`. | `workspace` |
| `harness` | The Codex `writable_roots` hold every required path. | `harness` |
| `browser` | `browser-sessions.json` has a reservation for the slug. | `harness` |

The `ci` item is present only when the project has workflow files. A project without workflow files prints no CI line. These warnings do not change the exit code. `--fix ci` copies each missing workflow template into `.github/workflows/`. It keeps every existing workflow file. The command prints each file that it copies or skips, then it prints the project check again.

| Warning id | Herdr Boss reports it when | Hint |
|---|---|---|
| `push-main-full` | A workflow runs on each push to `main` or `master`, or has no branch filter, and no job or file name marks it as a quick, changed-files, affected-files, or lint check. | Use a pull request quick check and run the full gate by hand or on release. |
| `schedule-private` | A private repository has a scheduled workflow. | Remove the schedule and run the full gate by hand or on release. |
| `no-concurrency` | A workflow does not set `cancel-in-progress: true` in a concurrency block. | Add a concurrency group and set `cancel-in-progress` to `true`. |
| `no-paths-ignore` | A push or pull request workflow has no path filter for `docs/` and `.orchestration/`. | Add `paths-ignore` for `docs/**` and `.orchestration/**`. |
| `matrix-or-non-linux` | A workflow uses a matrix or a runner other than `ubuntu-*`. | Use one Ubuntu runner without a matrix. |

`--fix STEP` runs the named step and no other step. Then the command prints the check again. The steps that `--fix` accepts are `folder`, `files`, `kit`, `commit`, `remote`, `labels`, `policy`, `register`, `status`, `workspace`, `harness`, and `ci`. `--fix remote` still posts a decide item to the Owner and waits for the answer. `--fix workspace` needs `--start`, because the step uses model quota. The flag `--fix` may be used once. A `--fix` step that changes the project refuses a worker pane, like `project new`. Plain `project check` has no pane check. A step that cannot be fixed by a step, such as invalid JSON in `.herdr-boss.json`, needs a correction by hand.

| Exit code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Usage error or refusal. This includes an unknown flag and a failed step. |
| 2 | Not built. |
| 3 | Waiting for an Owner decision. The step `remote` posted a decide item. |
| 4 | `project check` found a missing item. |

Run `project new` in a plain terminal, in the pane labeled `boss`, or in a pane labeled `orch`. A worker pane is refused before any step runs. The pane check is the check of `herdr-boss say`.

### Project transfer

```
herdr-boss project transfer plan|start|switch|cancel <slug> --to <factory>
```

Use `plan` to check the target factory, the kit revision, and the GitHub remote. The plan changes nothing. The remote must be reachable.

The target dashboard must use HTTPS or loopback HTTP. If the connection is unsafe, create the HTTPS Serve route. Then run `herdr-boss factory connect NAME` and retry the transfer. See the Windows host runbook below.

Use `start` to freeze a project for transfer. It lists a dirty tree, unpushed commits, an unpushed branch, or a running worker and stops when it finds one. It refuses while the source project lead is working or waiting for input. When the checks pass, Herdr Boss locks the project on both factories. It closes an idle project lead on the source, clones the repository on the target, installs the kit, creates the project record, and starts a fresh project lead. The new lead reads `docs/orchestration/memory.md`. The command posts a decision to the source Mailbox and exits with code 3.

Before cloning, the target selects the lead kind from its policy and checks the harness for that kind. A failed check refuses the import. Run the exact repair command in the message: `herdr-boss factory configure NAME`. Then run the same transfer command again.

A failed import names its step: clone, workspace, kit, harness, or lead start. The message gives a safe cause. It contains no secrets or bare HTTP 500. A lead start failure keeps the half import and its lock. Run the same command again to resume the saved clone and workspace checkpoints.

The target accepts `start` with HTTP 202 and a job ID. It runs the import outside the HTTP service thread. The source checks the job each second for at most 300 seconds. If this limit expires, the command exits with code 1 and prints `The target is still working. Run the same command again.` The target continues the import. Run the same `start` command to check or resume that transfer. The retry keeps the transfer ID and the locks. It uses the existing clone and project lead. It replaces an incomplete clone only when that transfer owns it. A finished target import returns its result again. A connection failure prints `The target factory could not be reached`.

The request limit for `plan`, `switch`, and `cancel` is 30 seconds. The target refuses `switch` and `cancel` while its import job runs. Retry after the job finishes.

After you answer the Mailbox item, run `switch`. It waits with code 3 until it finds a clear answer. `Accept the switch` marks the source project as transferred and unlocks both factories. `Deny the switch` removes the target project and restarts the source project lead.

Use `cancel` before the switch to remove the target project and clone, close the Mailbox decision, unlock both factories, and restart the source project lead. Cancel is refused after the switch.

Herdr Boss transfers the repository through GitHub. It does not copy secrets, login state, Mailbox items, review packs, or message text. Both factories write an audit record. The transfer API requires the fleet guide credential for `POST /api/fleet/transfer` and `GET /api/fleet/transfer?slug=SLUG&jobId=ID`. The GET request returns HTTP 202 while the job runs. It returns the result when the job finishes. The job response holds no repository path or remote address.

### Module

The module `src/project-new.js` exports `runProjectNew(options)`. The command calls it.

`runProjectNew` runs these steps in order: `validate`, `folder`, `files`, `kit`, `commit`, `remote`, `labels`, `policy`, `register`, `status`, `workspace`, `harness`. The step `check` reports `not built yet`. It changes nothing. A step that returns `waiting` stops the run. The result has `waiting: true`, and the later steps are `pending`.

| Option | Meaning |
|---|---|
| `slug` | Required. Must match `[a-z0-9][a-z0-9-]{0,63}`. |
| `group` | The group folder. The project folder is `<group>/<name>`. |
| `path` | The project folder. Use `group` or `path`, never both. A normal install has no default. In a factory, the default group is `/home/factory/work`. |
| `name` | The project name. The default is the slug. |
| `goal` | One line for the README. |
| `remote` | `none` (default), `gh`, or a Git URL. `runProjectNew` refuses a URL that is not valid or that holds credentials, before any change. |
| `visibility` | `private` (default) or `public`. |
| `org` | The organization for `gh`. It must match `[A-Za-z0-9][A-Za-z0-9-]{0,38}`. `runProjectNew` refuses another value before any change. |
| `start` | Run the step `workspace`. Without it, the step prints `skipped: no --start` and creates nothing. |
| `kind` | `claude` or `codex`. Overrides the orchestrator ladder. |
| `home` | The home folder for the step `harness`. The default is the account home. The step uses it only for the live data dir. |

The module `src/project-new-check.js` exports `checkProject(slug, options)` and `formatCheck(check)`. `runProjectStep(name, options)` in `src/project-new.js` runs one step for `--fix`.
| `herdr` | The Herdr runner that the step `workspace` uses. The default is `createHerdrRunner()`. Tests pass a fake. |
| `dryRun` | Return each step with the action it would run. Change nothing. |
| `allowUnscanned` | Paths of large or binary files that the commit scan skips. The default is none. |
| `resume` | Continue a saved run. Refuse when no state file exists. |

`runProjectNew` refuses these inputs before it changes anything:

- A bad slug, or a slug in `project-repos.json` or in `projects/`.
- With `group`, a `name` that has a slash, a backslash, `..`, or a leading dot. The real path of the project folder must stay inside the real path of the group.
- A project folder that is a symlink.
- A path inside the Herdr Boss repository, the data folder, or the live data folder. The check compares real paths, so a symlink in a parent folder does not bypass it.
- A folder that is not empty, or that holds `.git`.
- A path inside another Git repository. `project new` makes only new top-level projects. The check walks up from the nearest existing parent folder and refuses when a parent holds `.git`.

The `folder` step runs `mkdir -p` and `git init -b main`. The `files` step writes `AGENTS.md`, `docs/orchestration/memory.md`, `.herdr-boss.json`, `.gitignore`, `README.md`, and `docs/ideas/.gitkeep`. `AGENTS.md` holds a project part from `kit/templates/agents-project.md` and the Herdr Boss stub. The step never overwrites a file that exists.

The `kit` step calls the installer of `herdr-boss kit install` for the project folder. It writes `docs/orchestration/herdr-boss.md`, the stub in `AGENTS.md`, and the SessionStart hook in `.claude/settings.json` of the project. It writes no file outside the project folder. It does not change the user-level Claude settings. A second run changes nothing.

The `commit` step stages all files of the project and scans the staged files for secrets. Then it makes the first commit with the message `Set up the project with Herdr Boss` and no trailer. The commit uses the identity from `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`, which honor the environment. When Git cannot build an identity, the step fails and sets no identity. When the project already has a commit, the step makes no second commit.

The scan refuses the commit for these classes:

- a private key block;
- a GitHub token;
- an AWS access key;
- a Slack token;
- a `password`, `secret`, `token`, or `api_key` assignment with a literal value of 16 or more characters;
- a `.env` file. A file that ends in `.example`, `.sample`, `.template`, or `.dist` is not a `.env` file. The scan reads at most the first 200 KB of each line. A file over 2 MB, or a file with a NUL byte, cannot be scanned. The scan refuses it with the class `unscanned large or binary file`, unless its path is in the option `allowUnscanned`. The list is empty by default. The refusal names each file and class and never prints a value. The step then unstages all files and leaves the files unchanged. Remove the secret, then run the flow again with `resume`.

The `remote` step (`src/project-new-remote.js`) sets the Git remote `origin`. Creating a repository is an Owner decision. The step never pushes.

1. With `--remote none`, the step prints `skipped: --remote none`.
2. With `--remote URL`, the step refuses a URL with credentials, runs `git remote add origin URL`, and checks it with `git ls-remote origin`. When the check fails, the step removes `origin` again and fails. It creates nothing.
3. With `--remote gh`, the step posts a decide item to the Mailbox as `boss`, in the `boss` thread, and exits with code 3. It calls `gh` only after the answer. The item names the repository (`<org>/<slug>`, or `<gh login>/<slug>` without `--org`), the visibility, and the choices `Create private`, `Create public` (only with `--visibility public`), and `Do not create`. The repository name is the slug. The command line always posts the item, also with `--visibility`, because an orchestrator can be the caller. The command line has no option for a decision.
4. Run `project new ... --resume` after the Owner answers. The step reads only the newest Owner reply to the item. A reply that does not clearly pick a choice keeps the flow waiting, and the step does not use an older reply. A negation (`not`, `isn't`, `no`, `never`, `without`, `don't`) or a hedge (`wait`, `maybe`, `not sure`) in a reply that is not a plain decline keeps the flow waiting. `yes` picks `Create private`, unless the item offered `Create public`. `Create public` needs the word `public` in the answer. `Do not create` sets the step to `skipped: Owner declined`, and the flow continues without a remote.
5. After a clear answer, the step runs `gh auth status`. When `gh` has no login, the step does not log in. It posts an `answer` item that tells the Owner to run `gh auth login`, and it fails. Run the flow again with `--resume` after the login.
6. With a login, the step runs `gh repo create <owner>/<slug> --private|--public --source <folder> --remote origin`, with no `--push`. Then it runs `git ls-remote origin`. A name that is already in use fails the step with the message of `gh`. The step does not retry.

The dashboard wizard can send a decision (`visibility`, `source: wizard`, and `confirmPublic: true` for `public`) to the routes `POST /api/project-new` and `POST /api/project-new/plan`. With a decision, the step creates the repository as in item 6 and posts no item. The state records `ids.remoteDecision` with `visibility`, `source`, and `at`. A resumed flow that has `remoteDecision` posts no item. When the flow had posted an item, the step closes it with the note `answered in the wizard` and uses the decision. The routes refuse `public` without `confirmPublic: true` with status 400. The command line ignores a decision.

The step never runs `gh auth token`. It never reads, prints, or stores a token. It removes tokens and URL credentials from each line of `gh` and `git` output before it prints or records the line. The state file holds the Mailbox item ID and the created repository name in `ids`, in the fields `remoteAsk`, `remoteDecision`, `remoteLoginItem`, and `remoteCreated`. A rerun asks no second question and creates no second repository. When `origin` exists and matches, the step changes nothing. When `origin` points to another repository, the step fails.

The `labels` step (`src/project-new-labels.js`) runs after `remote` and before `policy`. It sets the `triage` labels with the same sync as `herdr-boss gh label sync --preset triage`. It creates or edits a label and never deletes one.

1. The step runs only when `origin` is a `github.com` repository, and it acts on that repository only (see Safe `gh` commands). Without `origin`, it prints `skipped: no remote`. With another host, it prints `skipped: the origin is not a GitHub repository`.
2. The step runs only for a private repository. It reads the visibility from the decision of the wizard in the flow state (`remoteDecision`), but only when `remoteCreated` names the repository of `origin`. Otherwise it runs `gh repo view --json visibility`. A public or internal repository prints `skipped: the repository is public, not private`.
3. When `gh` is not installed or not logged in, the step prints a `skipped:` line. It never runs `gh auth login`.
4. A failed `gh` call fails the step. The message has tokens and URL credentials removed. Run the flow again with `--resume` to repeat the step. A rerun changes no label that already matches.

The `policy` step adds the project to `policy.json` in the data folder. The new project gets `share` 10, `mode` `auto`, and no exclusions. When the total of all shares would pass 100, the step scales the other shares down. Each new share is the old share times (100 minus 10) divided by the old total, rounded down. The step changes only shares. It keeps each mode and each exclusion. It refuses to run when a share is not a whole number of 0 or more. It refuses a change that would lower a share of 1 or more to below 1, and it writes nothing then. It saves the policy through the validation of `herdr-boss policy set`. The step is not blocked by the share guard of `policy set`, because it changes many shares on purpose. It keeps the previous total. The write adds one line with the caller kind `project-new` to `policy-changes.jsonl`. The step prints the shares of all projects before and after the change. When the policy already has an entry for the slug, the step changes nothing.

The `register` step records `{ slug, repo, remote }` for the project in `project-repos.json` in the data folder, with mode 0600. It records the same values as the first `publish`. It does not publish a status. When the slug is already registered to the same folder, the step changes nothing. When it is registered to another folder, the step fails.

The `status` step publishes the first status through the code of `herdr-boss publish`: `writeProject` validates the file with `validateProject`. The status has the summary `New project. Set up the project.`, the current `kitRevision`, and one task `Set up the project` with status `todo` and priority 1. The `goal` field holds the option `goal`. The status has no `goal` field when the option is empty. When `projects/<slug>.json` exists, the step changes nothing.

The `workspace` step runs only with `--start`. It spends model quota. Nothing else starts it. Without `--start`, the step prints `skipped: no --start` and creates nothing. A later run with `--start` does the step.

1. The step picks the harness. With `--kind`, it uses that kind and the model of the policy for that kind. Without `--kind`, it uses the first entry of `orchestratorLadder` that `handoffTarget()` accepts. The step fails before it creates anything when no harness is usable.
2. The step runs `herdr workspace create --cwd PATH --label <slug> --no-focus`. The label equals the slug, so Herdr Boss maps the workspace to the project. The step writes the workspace ID into the field `workspace` of the published status.
3. The step runs `herdr pane rename PANE orch` for the root pane.
4. The step runs `herdr agent start <slug>-orch --kind K --pane PANE -- ARGS`. The arguments come from `handoffTarget()`. A Codex orchestrator also gets the `-c shell_environment_policy.set.*` arguments of a handover.
5. In a factory, the step first marks the project folder as trusted for Claude and Codex in the home of the factory user. It uses the same helper as `factory login`. The agent then starts without a trust dialog. The step watches the pane for a folder trust prompt. See the paragraph after this list.
6. The step delivers the Owner goal. The goal is the text of `--goal`, or else the Settings value **Default orchestrator goal**. By default, Claude and Codex get the goal as plain text in the first prompt. Turn on `goals.autoCommand` to send `/goal TEXT` to Claude instead. When this setting is on, the step reads the pane and fails when the goal does not show after three checks.
7. The step sends the first prompt with `deliverPrompt()`. The prompt tells the orchestrator to read `AGENTS.md`, `docs/orchestration/memory.md`, and `docs/orchestration/herdr-boss.md`, and to start with the task `Set up the project`.

The Owner accepts the folder trust prompt. Herdr Boss only tells the Owner where it is. Herdr Boss never presses a key in a pane for this.

The trust watch runs only with `--start`, and only for a pane that this run created. A dry run reads no pane. The step runs `herdr pane read <pane id> --source recent-unwrapped --lines 60 --format text` every 2 seconds for 3 minutes from the creation of the pane. It stops earlier when the agent shows its input prompt or has the status `working`. The matchers are in `src/trust-prompts.js`. A matcher strips ANSI escapes and box borders. It requires the whole known dialog: the heading; one line that equals the project folder as an exact string after `realpath`; the known sentence; the option lines; the footer. A parent, a child, a longer path, a symlink alias, a case difference, and a trailing slash do not match.

When the known dialog matches, the step posts one Mailbox item with the action `answer`. The item holds the pane ID, the harness, and the slug. It also holds the line `Folder: <project path>`. The item asks the Owner to press Enter on the option that trusts the folder, and it names the path `/agents`. It holds no pane text. The step also appends one event to `events.jsonl` with the type `project-new`, the text `trust prompt detected`, the pane, the folder, and the harness. If no known dialog matched and the agent is neither ready nor working after 3 minutes, the step posts one item that says the pane may wait for input. A rerun repeats neither item.

Known dialogs: Claude Code (checked in 2.1.285) and Codex (checked in 0.159.2). Pi (0.87.1) and OpenCode (1.18.30) show no folder trust prompt, so the step does not watch them.

The state file holds the workspace ID, the pane ID, and the chosen kind and model. It holds one flag for each sent message (`agentStarted`, `goalSent`, `goalVerified`, `promptSent`) in the field `ids`. The fields `trustPane`, `trustSince`, `trustDone`, `trustDetectedItem`, and `trustTimeoutItem` hold the state of the trust watch. A run that finds the workspace ID reuses the workspace. When the ID is gone, the run reuses the one workspace with the label of the slug. The run creates no second workspace or pane. A pane that already runs the agent gets no second start. A message that the flags mark as sent is not sent again. When the step fails, the next run with `--resume --start` continues at the failed point.

A dry run names the steps `remote`, `policy`, `register`, `status`, and `workspace`, and writes and posts nothing. With `--start`, the dry run of `workspace` prints `would create ...` and the chosen harness. It calls no Herdr command.

The state file is `flows/<slug>.json` in the data folder, with mode 0600. The command writes it through a temporary file with a unique name, and never follows a symlink at that name. It holds the inputs and the status of each finished step. The repository holds no state. A run that finds a state file with the same inputs skips the finished steps. It changes nothing when all built steps are finished. A step that fails is recorded as `failed`, and the next run repeats it.

### Command project paths

Run `project paths` to print one line with the slug and path of each registered project. The text form separates each `slug=path` entry with a space. Use `--json` when a path can contain spaces. The command sorts the projects by slug. It leaves out the current project when you run it from its checkout or a linked worktree. It reads only the project registry. It does not open a project repository.

Use `project paths --json` to print an array of objects. Each object has `slug` and `path` fields. The command exits 0 and prints an empty line when no other project is registered. The JSON form prints an empty array in this case.

### Command project unregister

Run `project unregister <slug>` to remove one project from the registry. The Owner, Boss, or that project's lead can run it. A worker cannot run it. The command writes a backup of `project-repos.json` first. It removes the registry row, the Git pin, and the project browser reservation. The saved browser profile and settings stay in place. The command stops no browser. It does not delete project files, worktrees, or branches. An unknown slug exits with an error.

## Project register

The project register lists every project of this factory. Herdr Boss stores the register in the file `project-register.json` in the data folder. The file has mode 0600. The register never lands in a Git repository. Each record holds the 17 fields `slug`, `title`, `group`, `clientTag`, `repo`, `remote`, `factory`, `state`, `pinned`, `priority`, `issueSource`, `autoOpen`, `lastOpenedAt`, `lastActivityAt`, `nextAction`, `notes`, and `createdAt`. Use `group` for an area and `clientTag` for the client label.

| `herdr-boss` command | Effect |
| --- | --- |
| `project register list [--state STATE] [--group NAME] [--json]` | Print the records sorted by slug. `--state` takes `open`, `parked`, or `archived`. Only this subcommand accepts `--json`. |
| `project register add SLUG [FIELD ...] [--dry-run]` | Add one record. Use `--group AREA` and `--client-tag TEXT` to group by area and show a client tag. A GitHub `--remote` sets the issue source by default. Add `--issue-repo OWNER/REPO` to set another issue source. Add `--issue-label LABEL` with a GitHub `--remote` or `--issue-repo` to override the default triage label. Add `--auto-open on` only when automatic opening is intended. The record starts parked in this data folder's factory. |
| `project register edit SLUG [FIELD ...] [--dry-run]` | Change Owner fields of one record. Use `--group AREA` and `--client-tag TEXT` to set its area and client tag. Add `--issue-repo OWNER/REPO` to set an issue source. Add `--issue-label LABEL` to set or change the label for the existing issue source, or use `--issue-clear` to remove the source. Add `--auto-open on` only when automatic opening is intended. The command prints changed field names, never values. |
| `project register sync [--dry-run]` | Copy the repo and the remote from `project-repos.json` into the matching record. |
| `project register import [--dry-run]` | Add missing records from the project sources. Refresh state and last activity. Keep Owner fields. |
| `project scan DIR [--depth N] [--add] [--dry-run]` | List repositories and propose records. `--add` registers new records. |

Run `herdr-boss project register add pine-api --title "Pine API" --group platform --client-tag "Example Client"` to add one project. Run `herdr-boss project register edit pine-api --group web --client-tag "Sample Studio"` to change its area and client tag. Run `herdr-boss project register list --state open` to list the open projects. A bare `herdr-boss project register` prints the usage of every subcommand.

Each `project register` subcommand runs a caller check before it reads an option. A plain terminal is the Owner and passes the check. A Herdr pane must carry the label `boss` or `orch`. A worker pane is refused, and the refusal tells the worker to ask its project lead. `project scan` writes nothing, so it runs from every pane.

Every subcommand that writes the register accepts `--dry-run`. A dry run prints the same result lines as the real run. It writes no register file and no audit line. A refused command prints a reason and writes nothing. A refusal names the class of a value that matches the secret scan, never the value itself. A remote must be `owner/name` or a URL without credentials, a query string, or a fragment. An SSH remote may have a user name without a password.

The **Project register** settings control the open project cap, auto-park, and issue triage. The cap starts at three and does not count pinned projects. Auto-park starts at 24 hours without activity. It parks an open, unpinned project after the same checks as `project park`. A running worker, an unmerged worker branch, or a pending Mailbox item keeps the project open. Set `register.autoParkHours` to `0` to turn it off. Commits, worker completion, and Owner Mailbox answers refresh activity. Triage starts off. When enabled, it checks the default label on each registered issue repository at the configured interval. A project can set its own label. A ready issue on a parked project creates a Mailbox proposal with **Accept** and **Deny** actions. Accept opens the project. Deny waits 24 hours before another proposal for that project. Set a project's `autoOpen` field to `on` only when the service may open it without Mailbox acceptance.

`project register import` reads three sources: the rows of `project-repos.json`, the project keys of `policy.json`, and the published status files in the folder `projects/`. It also reads Herdr workspaces, panes, and agents. It matches workspace labels and names to project slugs without case or punctuation. A project with a live `orch` pane and agent gets the state `open`. A known project without a live project lead gets the state `parked`. It adds missing records and refreshes only derived state and published last activity on existing records. It keeps Owner fields. A second import changes nothing when the sources have not changed. The service imports at start and after a policy or project status change. If Herdr does not return a complete list, the import warns and keeps the current states.

The open project cap limits new opens and automatic opens. It does not block import. It does not block a project that already has a live orchestrator. The Overview, Board, Allocation, and Projects pages use the register state and policy. The Projects page shows a policy-only project with an **Add** action. It shows a missing workspace or project lead for a half-onboarded project.

On **Allocation**, **Remove from policy** saves a backup before it deletes a project entry. It adjusts the other shares to total 100%. Run `herdr-boss project open SLUG` to add a policy entry again. Select **Show parked** to show parked or archived projects with a zero share.

`project register sync` reads the rows of `project-repos.json`. A row is the source of truth for the repo and the remote of its record. An empty remote in a row clears the remote of the record. The sync stores a remote without its credentials.

`project scan DIR` walks DIR and prints one line for each Git repository. It prints `skip` for a folder name that is no project slug, `registered` for a slug that the register holds, and `propose` for a new slug with its path and its remote. The scan prints each remote without credentials, query strings, or fragments. `--depth N` sets the depth of the walk. The depth is a whole number from 0 to 10, and 2 is the default. The scan follows no symlink, skips each hidden folder, and ignores a `.git` symlink. Folder names and paths have no control characters in the output. Without `--add`, the scan changes no file and has no caller check. Add `--add` to register each new repository through `project register add`. The register command checks the caller, validates the record, takes the register lock, and writes the audit line. Add `--dry-run` with `--add` to print each record that the scan would register without writing it.

A command that writes the register appends one line per written record to the file `project-audit.jsonl` in the data folder. The audit file has mode 0600. Each line holds the fields `at`, `slug`, `action`, `by`, `result`, `failedCheck`, and `dryRun`. An auto-park line can also hold `reason`. A normal register write uses `register-add` or `register-edit`, `owner-cli`, `done`, a null `failedCheck`, and false for `dryRun`. A line holds no path, no remote, and no value of a record. A dry run appends no line.

## Release approval

An orchestrator publishes a GitHub release only after the Owner approves it in the Mailbox. The Owner taps Approve and types no command. The commands use the existing `gh` login of the Owner and never print a token.

WARNING: Never run `gh release edit`, `gh release delete`, or `gh release create` with `--draft=false` for a release of a listed repository. Use `herdr-boss release publish`.

Use `release add-asset` to add files to an existing draft or published release. The command uploads files only after the Owner accepts the Mailbox request. It may append a Demo app notes block after the existing release body.

The setting `releases.repos` in `config.json` lists the repositories that the commands accept. Set it in **Settings → Advanced → Service settings → Releases**. Each entry has `name` (`OWNER/REPO`), `project` (the project slug, which names the Mailbox thread), `kind`, and `requireDemoApp`. `requireDemoApp` defaults to `true` for `kind: qlik-extension` and `false` for other kinds. The Settings page shows this switch for Qlik extension repositories. A repository that is not in the list is refused with exit code 1. The refusal names `releases.repos` and points to this Settings page.

| Command | Action |
|---|---|
| `herdr-boss release request REPO TAG [--notes FILE] [--pack PACK] [--not-latest]` | Read the draft release with `gh`, hash each asset from a fresh download, scan the notes and the assets, and post one Mailbox item of action `approve`. For a Qlik extension repo with `requireDemoApp`, require exactly one separate `.qvf` asset. Refuse an extension archive that contains a `.qvf` file. Inspect ZIP, TAR, and gzip TAR archives through two nested levels. Inflate only `.qvf` entries and archive entries. Refuse an archive-like asset or nested entry that the gate cannot inspect. Print the approval ID. |
| `herdr-boss release add-asset REPO TAG FILE... --reason TEXT [--append-notes FILE]` | Hash and scan each file and the optional notes. Post one Mailbox item of action `approve`. The release may be a draft or published. |
| `herdr-boss release apply-asset REPO TAG --approval ID` | Check the Owner's approval, the files, the scan, and the release body. Then upload the files and append the approved Demo app notes block. |
| `herdr-boss release cancel REPO TAG [--reason TEXT]` | Settle an open unapproved request as superseded. Only the pane that requested it or the Boss pane can run this command. |
| `herdr-boss release cancel REPO TAG --force --reason TEXT` | Cancel an approved publication request while its release is still a draft. Only the verified Boss pane can run this form. Give a reason with 1 to 300 characters. Herdr Boss redacts the reason and writes one release audit line. |
| `herdr-boss release publish REPO TAG --approval ID` | Check the approval, then run `gh release edit TAG --repo REPO --draft=false --latest`. |
| `herdr-boss release status [REPO]` | Print JSON with the drafts and the last published release of each listed repository, and the open requests. |

The item shows the repository, the tag, the draft link, the changelog, the assets with size and SHA-256, the demo app asset with its name, size, and SHA-256, the scan result, the build commit, the answer of the review pack named with `--pack`, and the effect. The approval ID is the ID of the item. Only one request can be open for each repository and tag. A second request prints the open ID when the release data still matches. The command compares notes when the request has a notes hash. It compares the asset names, sizes, and SHA-256 values. If the data changed, the command says that the request is stale. Run `release cancel` before you request again.

An approval created before the demo app gate can publish only when its recorded assets contain exactly one `.qvf` and the matching `.qvf.sha256` companion, every fresh asset name, size, and SHA-256 matches the recorded list, the scan and archive checks pass, and no extension archive contains a `.qvf`. The publish audit line names the pre-gate rule, the demo app asset, and its SHA-256. For an unapproved request, run `herdr-boss release cancel REPO TAG`, then run `herdr-boss release request` again. For an approved request, ask the Boss to run `herdr-boss release cancel REPO TAG --force --reason TEXT`.

For a required demo app, the archive inspection has one 200 MB inflated-byte limit and one 5,000-entry limit across all assets and nested archives. It checks up to two nested archive levels. It refuses `.tar.xz`, `.tar.bz2`, `.tbz2`, `.gz`, `.xz`, `.rar`, `.7z`, `.zst`, and unknown archive extensions.

The add-asset item shows the repository, tag, reason, each new file with its size and SHA-256, and the scan result. When you give `--append-notes`, the item shows the Demo app block. Only one release approval can be open for a repository and tag. A repeated identical add-asset request prints the open ID. Cancel an open request before you change its files, reason, notes, or target release.

Each file must be readable, non-empty, and a regular file. The command refuses symlinks and file names that contain `#`.

The request reads the notes from `--notes FILE` when you give it. The add-asset command reads each file and the optional notes file. The scan finds tokens, private keys, inline license blobs, private paths, and hosts of the browser sessions of this machine. A public verification key is allowed. A finding shows only its class. When a scan fails, the item shows the failure and `release publish` or `release apply-asset` refuses. A `.qvf` asset may hold the Qlik Engine inline table path `/home/engine/<uuid>.inline`. The scan counts these paths, the card names the count as allowed, and no other path class passes. The `.qvf` format stores the path after a one-byte length prefix. The scan accepts that prefix only when it equals the path length (56, the character `8`).

`release publish` runs `gh release edit` only when all of these checks pass:

1. The item exists for exactly this repository and tag, and it is open.
2. The latest answer of the Owner is Approve, and it is newer than the request.
3. The assets have the same names, sizes, and SHA-256 hashes as the card.
4. A required Qlik demo app still matches the card, and no Qlik extension archive contains a `.qvf` file. A pre-gate approval must record one `.qvf` and its `.qvf.sha256` companion; fresh asset hashes, scan, and archive checks must pass. A failed demo app gate reports its cause and the applicable cancel command.
5. The scan of the changelog and the assets passes.
6. The release is still a draft.

After `gh release edit`, the command reads the release again. It checks that the release is published with the assets of the card. Then it writes one line to `releases/audit.jsonl` in the data directory (time, approval ID, pane, repository, tag) and closes the item with the note `published`. The command never deletes a release or a tag, and never edits the assets of a published release. `--not-latest` on the request makes the card, and the publish, use `--latest=false`.

`release apply-asset` runs only when all of these checks pass:

1. The item is an open add-asset request for this repository and tag.
2. The latest Owner answer is Approve, and it is newer than the request.
3. Each file still has the size and SHA-256 value shown on the card.
4. The scan of the files and notes passes.
5. The release body has the same SHA-256 value as it had at request time.
6. None of the new file names is already on the release.

The command runs `gh release upload` without `--clobber`. If the item has a Demo app block, the command reads the body again before it runs `gh release edit --notes`. It refuses the edit if the body changed after the request. The new body starts with the freshly read body, then a blank line, then the block. It reads the release again and checks the asset names and the new body. Then it writes one line to `releases/audit.jsonl` with the time, approval ID, pane, repository, tag, action, and file names. It closes the item with the note `assets added`. If a later step fails after upload, the command prints the uploaded names and says `cancel the request and request again; the uploaded assets stay`.

`release cancel` closes the Mailbox card with the note `superseded`. It stores up to 500 characters of the reason, if you give one, and writes one line to the release audit file. It refuses a request that the Owner approved. Run `release publish` for an approved publication request. Run `release apply-asset` for an approved asset request. Only the verified Boss pane can cancel an approved publication request with `--force --reason TEXT`. The reason must contain 1 to 300 characters. Herdr Boss redacts the reason and refuses when the release is already published. An Owner denial settles the request.

When the Owner answers the item, Herdr Boss sends one notice to the pane that ran the request. For Approve, the notice names `release publish` or `release apply-asset`, as needed. For Reject, Herdr Boss closes the item, and the notice says that a new request is needed. Nobody polls. After any change to the draft, run `release request` again. Cancel the old request first if the command says that it is stale.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. The request is posted or open, the status printed, the release published, or the assets added. |
| 1 | Refused. The message names the reason: the repository is not listed, the Owner rejected it, the release or files changed, the scan failed, the release is not a draft, a request cannot be cancelled, or a `gh` command failed. |
| 3 | `release publish` or `release apply-asset` waits for the Owner. The item has no answer yet. |

Example:

```sh
herdr-boss release request example-org/example-app v1.0.0 --notes notes.md --pack landing
herdr-boss release add-asset example-org/example-app v1.0.0 demo.zip --reason "Add the sample app" --append-notes demo-app.md
herdr-boss release apply-asset example-org/example-app v1.0.0 --approval m-demo
herdr-boss release status example-org/example-app
herdr-boss release cancel example-org/example-app v1.0.0 --reason "Updated notes"
herdr-boss release cancel example-org/example-app v1.0.0 --force --reason "Replace the approved draft"
herdr-boss release publish example-org/example-app v1.0.0 --approval m-example
```

## Owner messages

The Owner sends messages from the Organization page. The Boss and the project leads reply with these commands. The default store is `messages.jsonl` in the data directory. Set `store.messages` to `sqlite` in `config.json` to use `herdr-boss.db`.

| Command | Action |
|---|---|
| `herdr-boss say [--reply-to ID] [--action answer\|approve\|decide\|read] [--image FILE] "TEXT"` | Send a message to the Owner. Run it from the pane labeled `boss` or from a pane labeled `orch`. |
| `herdr-boss messages [THREAD]` | Print the records of one thread as JSON, oldest first. Without `THREAD`, print the records of all threads. `THREAD` is `boss` or a project slug. |
| `herdr-boss messages relay ID... --by boss` | Mark queued Owner chat messages as relayed by the Boss. Only the pane labeled `boss` can run this command. Herdr Boss never sends a relayed message. |
| `herdr-boss mail post --to owner [--title TEXT] [--action read\|decide\|approve\|answer] FILE` | Post a Markdown report for the Owner in the Mailbox. Only the pane labeled `boss` can post. |
| `herdr-boss mail close ID... --note TEXT` | Close open Mailbox items as answered through the Boss. Only the pane labeled `boss` can run this command. It sends no message. |
| `herdr-boss store import messages` | Import `messages.jsonl` into an empty SQLite message table. Keep the JSONL file. Print the number of imported records. |
| `herdr-boss store export messages` | Write the SQLite message records to `messages.jsonl`. Print the number of exported records. |

`say`, `mail post`, `mail close`, and `messages relay` verify the caller the same way as `worker allow`:

1. The pane must set `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID`.
2. `herdr pane get` must return the same pane ID and workspace.
3. The pane label must be exactly `boss` or `orch`. `mail post`, `mail close`, and `messages relay` also require the `boss` label.

A worker pane cannot use `say`. The command tells the worker to ask the project lead.

The Boss writes to the `boss` thread. A project lead writes to the thread assigned to its workspace. Herdr Boss finds that project in `state.json`. `--reply-to` must name a message in the same thread. A reply follows the channel of that message.

An action of `answer`, `approve`, or `decide` puts the item in both the Mailbox and Chat. A report with action `read` goes to the Mailbox. A `say` message stays in Chat unless it asks the Owner to answer, approve, or decide. Omit `--action` for a plain message.

| Value | Meaning |
|---|---|
| `answer` | The Owner types an answer. |
| `approve` | The Owner approves or declines. |
| `decide` | The Owner makes a choice. Add a Markdown list under a `## Choices` heading to show choice buttons. |
| `read` | Information for the Owner. The commands use this action when you omit `--action`. |

The Mailbox shows action items under **Needs you**. It shows information under **Updates**. The escalation rules make Owner actions rare. The Owner answer comes back as an `[owner] Answer to ID (TITLE): ANSWER` prompt. The quoted question follows the answer.

Start only approved work: a backlog task, an Owner goal, a fix for a finding of approved work, or a defect fix. A subagent read or survey inside approved work is allowed. Get the Owner's yes before a survey, review, or audit that is itself new work outside those categories. Get the Owner's yes before a refactor, a new feature, a new test program, or a release outside an Owner request.

Only the Boss runs `mail post` to post a proposal card. Write one Markdown file with these exact headings. Add both a lane and a size under `## Cost`. List exactly `Accept` and `Deny` under `## Choices`.

Run `herdr-boss proposal check FILE` and fix every error. Then tell the Boss the absolute file path and the card type `decide`. For a `proposal.md` file in the current directory, run:

```sh
cat > proposal.md <<'EOF'
## What
Add a report export.

## Why
Owners need a file to share with their team.

## Cost
Lane: codex
Size: small

## Recommendation
Accept this proposal.

## Choices
- Accept
- Deny
EOF
herdr-boss proposal check proposal.md
herdr-boss tell boss "Proposal file: $PWD/proposal.md; card type: decide."
```

The proposal check reports missing headings, cost fields, or choices. The `tell` command sends the Boss the file path and the `decide` card type. The Boss puts the file in a To do decide file and posts it with `herdr-boss todo post FILE` as one To do decide item. The item states what, why, cost, and recommendation. The Boss's yes does not replace the Owner's yes.

The command output names the destination. For example, `say` prints `Message ID sent in chat.` An action prints `Message ID posted as a Mailbox item (decide).` A reply to an item prints `Message ID sent as an answer to ID.` `mail post` names the Mailbox item. `mail close` names the Mailbox. `messages relay` names the chat message.

The `say` text is 1 to 4000 characters. The report file is Markdown, up to 64 KB. The report title defaults to the first Markdown heading, or to `Report`. The `mail close` note is 1 to 500 characters. The close command refuses an unknown or already closed ID and names that ID in its error. The Boss note does not send a reply. These commands refuse text that looks like a token, a key, or a password. The error does not print the text.

## Owner to-do list

Run `herdr-boss todo post FILE [--priority P] [--blocks TEXT]` from the Boss pane or an orchestrator pane. The service must be running. It verifies the pane with Herdr. It uses the project of the verified workspace. The Boss posts for `boss`. A worker or plain terminal cannot post. The file cannot select a project.

Run `herdr-boss todo list` from the Boss or an orchestrator pane to list open items for that project. Each row shows the key, type, title, and current state. The command does not list items from another project.

Run `herdr-boss todo status ID` to read one item's state and its latest answer, if it has one. Use the item ID that `todo post` prints. The service verifies the caller pane and project for both commands.

Run `herdr-boss todo --help` or `herdr-boss todo post --help` to print the command usage and the exact file headings. Read commands use GET routes and work in a read-only preview.

Write a regular Markdown file of at most 64 KB. Use these headings once each. Give each section content.

```md
## Title
Check the preview
## Why
Check the page before release.
## Steps
- Open https://example.test/preview.
- Check the labels.
## Expected result
The labels are clear.
## How to answer
Select Done or Blocked with a reason.
## What it blocks
The next release.
## Type
check
## Priority
normal
```

Use type `decide`, `do`, `check`, `grant`, or `read`. Use priority `urgent`, `high`, `normal`, or `low`. Priority defaults to `normal`. The Priority section is optional. `--priority` overrides it. `--blocks` overrides What it blocks. Use only the documented headings. Put a review pack link in Steps when needed.

Use a reserved example host, such as `example.test`, for each host. Refuse credential values. A grant item names the permission or credential that the Owner must grant. It never holds the value.

The key combines the project with the title. Title case and repeated spaces do not change the key. A duplicate updates an open item and keeps its id and original age. Each project can post at most 10 items or updates per minute. An over-limit request stores nothing.

The Mailbox To do view shows open items from all projects and the Boss. Its badge counts open items. It sorts urgent items first, then high, normal and low items. Within a priority, the oldest item comes first.

Done closes an item. Mark read closes a read item. Answer accepts or denies a decide item. It can also save an answer text for any item. Blocked requires a reason. Snooze requires a future time. The item becomes open at that time. Not now requires a reason and cancels the item. Inspect saved actions under Blocked, snoozed and closed. Reopen makes a blocked or snoozed item open again. Unresolved items survive message retention. Closed items stay for 30 days after closure.

The service sends the poster pane a short notice for Done, Blocked, Snooze, Not now, or Answer. The notice gives the title, action, and reason or answer. A Snooze notice gives the time too. It never includes the full ask or a secret. A missing poster pane leaves the notice pending. The message queue tries it when that pane returns. A failed prompt gets one retry on a later tick. A saved action sends only one notice, including after a replay or service restart.

Run `herdr-boss todo cancel KEY [--note TEXT]` from the poster project pane to cancel an open item. The post command prints the key. Quote a key that contains spaces, for example `"alpha:check the preview"`. The service verifies the caller project. A foreign project cannot cancel the item. The Owner sees the cancelled state and note. The command does not send an Owner action notice.

Run `herdr-boss say --reply-to ITEMID "TEXT"` from an Owner terminal outside an agent pane to answer a To do item. This command uses the same service reply path as a Mailbox answer. It closes the item, saves the answer, and queues the action notice. It accepts text only. Use the GUI for Accept or Deny. A normal agent `say` reply keeps its existing caller check.

Run `herdr-boss todo migrate` once from the Boss pane to import open Mailbox asks that wait for the Owner. The command prints the imported count. A repeat run prints zero for the same asks. It uses the project and title key. It does not overwrite an existing item or reopen a closed item. Each imported ask keeps its original age. The old Mailbox item closes with a reference to its To do item. The import masks private legacy content. It excludes read items, closed items, and items with an Owner reply. The Boss posts asks from memory files later with `todo post`.

`POST /api/todo/post` accepts `text`, `caller`, and optional `priority` and `blocks`. The caller holds only `HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_WORKSPACE_ID`. The service verifies them. `GET /api/todo/list` returns the verified caller project's open items. `GET /api/todo/status?id=ID` returns the state and latest answer for an item in that project. Both GET routes take caller values in `x-herdr-env`, `x-herdr-pane-id` and `x-herdr-workspace-id` headers. `POST /api/todo/cancel` accepts `key`, `caller`, and optional `note`. `POST /api/todo/migrate` accepts the Boss `caller`. `POST /api/todo/action` accepts an item `id` and `action`, with `reason`, `until`, `decision`, or `answer` when required. The optional `updatedAt` refuses an answer to a changed item. `POST /api/messages` accepts a To do item id in `replyTo`. It saves one answer on a repeat request with the same `clientId`. `GET /api/mailbox?folder=todo` returns the open list, inactive items, and `mailbox.todoOpen`. The dashboard access and same-origin checks apply. A read-only preview refuses each POST route.

Post every ask to the Owner with `herdr-boss todo post FILE`. Pane text is not delivery. When an orchestrator waits for the Owner, it names the To do item key. A worker sends its Owner ask to the orchestrator for posting. `herdr-boss check agents` warns when the project's live orchestrator says it waits for the Owner and the project has no open To do item. It reads at most 30 recent pane lines. It returns counts and guidance only. It shows no pane text or read error text. The live check needs the project's published workspace.

Set `ownerTodo` in `policy.json` or in Settings, To do digest:

```json
{ "ownerTodo": { "digestTime": "08:00", "timeZone": "local", "notify": false } }
```

The default `digestTime` is `null` (off). An empty Settings time saves `null`. A time must use 24-hour `HH:MM` format. `timeZone` defaults to `local`, the service time zone. A valid time zone name such as `Europe/Oslo` follows daylight saving changes. `notify` is a boolean and defaults to false. Select Apply policy after an edit.

The first acting tick at or after the time posts one Mailbox item of kind `digest`. It lists the open count and at most five project names and titles, in To do order. A new date replaces the previous digest and makes it unread. It keeps the same id. A repeated tick or restart adds no second digest for that date. A late tick posts the current date only. A read-only preview posts nothing. Digests stay out of Chat.

Each Monday in the chosen zone adds a weekly summary of the five oldest open items. It gives the project and title only. With `notify: true`, the existing desktop alert path sends the open count and a Mailbox hint. Quiet hours hold the notice. They do not delay the digest. Desktop delivery is best effort. See the [design note](specs/owner-todo.md).

## Agent messages

| Command | Action |
|---|---|
| `herdr-boss tell TARGET TEXT [--file FILE] [--kind nudge\|reminder\|reply] [--reply-to ID]` | Store an agent message and send it to a pane, agent, or project lead. |

`TARGET` can be a pane ID, an agent name, or a project slug. A project slug sends the message to that project's lead pane.

The command stores the message before it sends the prompt. The stored text masks secrets. The prompt keeps the text that you gave the command. A failed prompt keeps the message with status `failed`. The command warns if it cannot save the metadata delivery status.

The caller's pane label sets the sender role. Herdr Boss checks a worker run record for a worker name, task ID, and run ID. It uses `unknown` when no role is known.

Use `--file FILE` to read a regular file instead of TEXT. The file limit is 64 KB. Use `--kind nudge`, `--kind reminder`, or `--kind reply` to set the message kind. The default kind is `task`. Use `--reply-to ID` to link a reply.

The prompt process has a 25-second limit. Set **Agent prompt timeout** in Settings to change it from 1 to 120 seconds. The policy key is `agentMessages.promptTimeoutSeconds`. Select **Apply policy**. Recovery reads and keys each have a limit of at most 2.5 seconds. A worker start keeps its existing 20-second Herdr wait limit when that limit is shorter.

| Exit code | Result |
|---|---|
| `0` | The prompt was delivered. |
| `75` | The pane could not take the prompt. No matching unsubmitted input was found. |
| `76` | The prompt was typed but not submitted. The error says whether its input was cleared or left unchanged. |
| `1` | The command failed for another reason. |
| `2` | The command options were invalid. |

After a timeout or stalled prompt, `tell` reads the complete pane input. It retries Enter once only when the input equals the sent text. It reads the input again before it clears that text. It leaves a different draft, an unreadable input, or an unknown harness unchanged. Claude uses two Escape keys. Codex uses one Ctrl+U for each input line. If its own text remains, Codex gets one Ctrl+C. These keys are best-known defaults. A final pane read checks the clear result. No second cancel key is sent.

An empty input with agent status `working` or `blocked` after a timeout counts as delivered. An empty input after the Enter retry also counts as delivered. The agent may have already completed a fast reply. These checks prevent a caller from sending the same prompt again.

Before each recovery key command, `tell` resolves the agent by name. It checks the pane ID and the original label. It leaves the draft alone if either changed. Each clear command also requires agent status `idle`. A working, blocked, unknown, or unavailable agent gets no clear key. This includes the Codex Ctrl+C fallback.

The visible input read trims trailing spaces and joins displayed rows with line breaks. A long prompt that wraps in the terminal may not match the sent text. A cropped input may also fail the match. The command leaves that input alone. Use the short file-path prompt pattern below.

For a long prompt, write the text to a file in the worktree or scratch folder. Send one short line that names the absolute file path. The recipient must be able to read that path. This pattern keeps the terminal input short. `--file` reads the file and sends its full text, so it does not shorten the terminal input.

```sh
cat > "$HERDR_WORKTREE/.worker/follow-up.md" <<'EOF'
Read the task sources. Run the scoped checks. Write the worker report.
EOF
herdr-boss tell demo-orch "Read $HERDR_WORKTREE/.worker/follow-up.md and execute it."
```

Agent messages stay out of Owner Chat and Mailbox. Worker reports create one recorded agent message for each run and report-file version. Workers keep the `.worker/report.md`, `.worker/report.json`, and `WORKER REPORT` path.

The service records each delivered notice with sender role `service`. A prompt for an idle orchestrator with ready work has kind `nudge`. Status, kit, idle-worker, resource, and handover notices have kind `reminder`. A watch routine has kind `task`. Each notice in a digest has one row. A failed service prompt creates no row. The normal notice cooldown still applies. The text masks secrets and uses the agent text retention setting.

The engine checks responses on each tick. It uses a fresh pane snapshot and delivered `tell` metadata. The first transition to idle or done, or the first delivered `tell` from the target, sets `respondedAt`. An agent that was idle at delivery must become active before idle counts as a response. A response is recorded once. After 24 hours, an unanswered row keeps `respondedAt: null`. `responseMs` is the elapsed time in milliseconds. It is `null` without a response. The pane check has the time resolution of an engine tick.

Set `agentMessages.retentionDays` to keep message text for 1 to 90 days. The default is 14 days. Set `agentMessages.metaRetentionDays` to keep metadata rows for 7 to 730 days. The default is 180 days. Metadata rows contain no message text. Select **Apply policy** to save either setting. The hourly retention sweep removes expired text and metadata.

| Route | Contract |
|---|---|
| `GET /api/agent-messages?project=SLUG&pair=KEY&q=TEXT&limit=N&before=ID` | Read newest-first agent messages. `project` is optional. Without it, read messages from all projects. Use `before` to read the next older page. The response includes each message's pair key. |
| `GET /api/agent-pairs[?project=SLUG]` | Read the message count and last message time for each pair. `project` is optional. Without it, read pairs from all projects. |
| `GET /api/agent-meta?project=SLUG&since=ISO&until=ISO&limit=N` | Read newest-first metadata rows. `project` is optional. Without it, read rows from all projects. A row holds sender, receiver, project, kind, character count, task ID, run ID, delivery status, `respondedAt`, and `responseMs`. A worker target holds its kind and model when known. It has no text. |
| `GET /api/analytics` | Read Analytics figures. `actionsMinutes` shows weekly Actions minutes for registered GitHub repositories. The figures are estimated from run times. `actionsMinutes.truncated` warns when older weeks may be missing. The service uses its GitHub token. It refreshes Actions minutes at most every 6 hours. It skips repositories that the token cannot read. `agentCommunication` counts messages by project, day, and kind for the last 7 local days. It counts nudges per task. It reports response medians and p90 values by orchestrator, worker kind, and model. It reports the reminder share. Failed deliveries add no traffic. |

These routes use the dashboard login rule. They are read-only. They do not change or delete messages.

Example:

```sh
herdr-boss say --reply-to m-mg3k2x1a-1f2e3d4c "Two tasks are left. The next merge is at 14:00."
herdr-boss mail post --to owner --title "Morning handback" handback.md
herdr-boss mail close m-mg3k2x1a-1f2e3d4c --note "Answered with the Owner through the Boss."
```

## Picture attachments

Use `herdr-boss say --image FILE "TEXT"` to send a picture. Repeat `--image` for up to 3 pictures. The command reads a local regular file. Each file must be at most 10 MB. The file bytes must identify JPEG, PNG, WebP, GIF, HEIC or HEIF. The command uses the same private storage as the upload route.

In a `mail post` report, write `![View](photo.png)` to include a local picture. The path starts from the current directory. The command uploads the picture and changes the target to `/attachments/att_<32 hex>`. A report accepts up to 6 pictures. A missing file, an unsupported picture or a file over 10 MB stops the report. Repeated targets use one upload. Code spans and fenced code blocks stay as text.

Use files in the current directory tree or the system temporary directory. An outside file needs an absolute path and must be a regular file owned by the caller. Herdr Boss resolves symbolic links before it checks the directory and the owner. A relative path that escapes both allowed trees is refused.

An image with an `http:`, `https:`, `data:` or other URL scheme stays in the report as text. Herdr Boss never fetches it. The renderer shows only its alt text. Only an exact `/attachments/att_<32 lower-case hex>` target becomes an image. It gets `loading="lazy"` and the class `md-attachment`.

An Owner picture arrives in one agent prompt with this line:

```text
Attachment: <absolute private file path> (image/jpeg, 120 KB) — read this file with your image tool.
```

### Routes

The upload and file routes use the normal dashboard access checks. Loopback needs no login. A remote request needs a login cookie or the access token. A foreign Origin gets `403`. The read-only preview refuses uploads.

| Route | Contract |
|---|---|
| `POST /api/attachments` | Send raw bytes. Set `Content-Type` to `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic` or `image/heif`. Set optional `X-Filename` to a URL-encoded name of at most 120 decoded characters. Herdr Boss sanitizes the name. The body limit is 10 MB. |
| `GET /attachments/<id>` | Read a stored file. The id must match `att_[0-9a-f]{32}`. Invalid ids and traversal paths get `404`. The route serves only the private attachment directory. |
| `POST /api/messages` | Set `attachments` to up to 6 unique attachment ids. Each must exist and be unlinked. A picture message may have an empty caption. |

A successful upload gets `200` with `id`, `type`, `size`, `name`, `url`, `createdAt` and `metadataStripped`. The type comes from the magic bytes. The size describes the stored bytes. A bad name gets `400`. An unsupported type, a truncated supported container or a type mismatch gets `415`. A body over 10 MB gets `413`. The service allows 30 authenticated upload attempts a minute. The next gets `429`. The limit applies across callers of this service.

The file route sends the stored `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600` and `Content-Security-Policy: default-src 'none'; sandbox`. JPEG, PNG, WebP and GIF use `Content-Disposition: inline`. HEIC and HEIF use `Content-Disposition: attachment; filename="<sanitized name>"`.

A linked message stores `attachments: [{ id, type, size, name }]`. Message, Chat and Mailbox reads return these fields. They hold no private file path. An invalid id, a duplicate id, more than 6 ids or an already linked id gets `400`. A missing upload gets `404`.

### Privacy and retention

Herdr Boss stores each picture as `<dataDir>/attachments/<id>.<ext>`. The directory has mode `0700`. Picture, metadata and link files have mode `0600`. The metadata holds the type, size, name, creation time and SHA-256. An exclusive `<id>.link` file records the message id. It prevents two processes from linking the same picture.

JPEG uploads lose APP1 and APP13 segments. APP2 ICC profiles stay. PNG uploads lose `eXIf`, `tEXt`, `iTXt` and `zTXt` chunks. WebP uploads lose EXIF and XMP chunks. GIF uploads lose comments and application extensions except the NETSCAPE animation loop. These formats return `metadataStripped: true`. HEIC and HEIF stay unchanged and return `metadataStripped: false`.

Set `attachments.retentionDays` in the policy or under **Pictures** on Settings. The default is 30 days. The range is 1 to 365 whole days. Select **Apply policy**. The engine sweeps at most once an hour. It deletes expired pictures and uploads left unlinked for more than one hour. It also removes orphan files after one hour. Deleting, dismissing or expiring a message deletes its pictures. Closing an item as answered keeps its pictures until retention removes them.

## Review packs

A review pack is a folder of evidence with one question for each item. The Owner reads it in the Herdr Boss site, answers each item, and submits one result. The pack note belongs to one version: a new version starts with an empty note, and `review result --version N` prints the note of that version. The format and the reviewer pages are in [the design](ideas/review-packs.md). These commands publish a pack, import HTML pages, and read the result.

| Command | Action |
|---|---|
| `herdr-boss review check FOLDER` | Validate a pack folder. Write nothing. Any pane and any terminal can run it. |
| `herdr-boss review publish SLUG FOLDER [--note TEXT] --judge-pass TEXT [--round N] [--dry-run] [--carry-open]` | Validate the folder, store it as the next version of its pack, and post a Mailbox item for the Owner. |
| `herdr-boss review import SLUG FOLDER-OR-FILE [--id ID] [--title TEXT] [--dry-run]` | Turn a folder of HTML files, or one HTML file, into a pack, and publish it. |
| `herdr-boss review result [SLUG] PACK [--version N] [--format json\|md]` | Print the stored result of a submitted review. The default format is Markdown. `--version N` selects a version. The default is the newest submitted version. `--json` means `--format json`. |
| `herdr-boss review delete [SLUG] PACK` | Delete the pack with its files and answers. Close its Mailbox items. |
| `herdr-boss review list [SLUG] [--state open\|done\|all] [--json]` | List the packs. The default state is `open`. The line shows `N of M answered`. A changed item counts as open, and a pack with changed items adds `, N changed`. A new version marks an item whose content changed as changed and removes its verdict until the Owner answers again or selects Keep. |

`PACK` is the pack ID. Write it as `SLUG PACK` or as `SLUG/PACK`. An orch pane can also write only `PACK`. The command then uses the project of its workspace. A plain terminal must name the slug.

### Who can publish

`publish`, `import`, and `delete` check the caller.

1. A plain terminal has no `HERDR_*` variable. It is the Owner. It can name any slug.
2. A pane must pass the same check as `say`: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and a matching `herdr pane get` answer.
3. The pane label must be `boss` or `orch`. A worker pane is refused. A worker builds the folder, runs `review check`, and names the folder in its report.
4. An orch pane can use only the slug of the project that uses its workspace. Herdr Boss finds that project in `state.json`.
5. The pane labeled `boss` can use only the slug `boss`.

A pane that has a planner session can run `publish` for its own project. See [Planner sessions](#planner-sessions). It cannot run `import`, `result`, `list`, or `delete`.

`check` reads only and has no caller rule. Any pane and any terminal can run it, also a worker pane and a planner pane. `result` and `list` use the same scope, and a worker pane is refused:

- A plain terminal reads every project.
- An orch pane reads only the slug of its own workspace. `review list` without a slug lists that project.
- The pane labeled `boss` runs `review list` for every project. It runs `review result` only for the slug `boss`.

### Planner sessions

A planner session lets a worker pane publish review packs for its project and receive the results. Use it when an agent plans with the Owner in rounds: the agent publishes options, the Owner answers, and the answers go back to that agent.

| Command | Action |
|---|---|
| `herdr-boss plan start KIND PROJECT --input PATH --pane PANE` | Create a session record and label the pane `planner`. `KIND` is the harness kind of the agent, for example `claude` or `codex`. `PATH` is the document that the agent plans from. |
| `herdr-boss plan list [PROJECT] [--all] [--json]` | List the active sessions. `--all` adds ended sessions. |
| `herdr-boss plan end ID` | End the session and clear the pane label. |
| `herdr-boss worker start NAME --planner ...` | Start a worker and create the session for its new pane. The kind is the worker kind. The input is the brief of the worker. |

The registry is the file `planner-sessions.json` in the data folder, with mode 0600. A record has the fields `id`, `project`, `pane`, `kind`, `input`, `startedAt`, `round`, and `endedAt`. A pane has at most one active session.

`plan start` and `plan end` use the caller rules of `publish`: a plain terminal, an orch pane for its own project, or the pane labeled `boss` for the slug `boss`. A worker pane is refused. `plan start` reads the target pane with `herdr pane get`. The pane must be in the workspace of the caller. A plain terminal uses the workspace of the project from `state.json`. The command refuses a pane labeled `boss` or `orch`. `plan list` uses the scope of `review list`. `worker collect` ends the session of the collected pane.

`plan end` exits with code 3 when the session does not exist. The other refusals exit with code 1.

A pane labeled `planner` with an active session has these rights:

- `review publish SLUG FOLDER` works only for the project of the session. Another slug is refused.
- `review reopen SLUG PACK ITEM` opens one unanswered item of a submitted pack from the session.
- `review check FOLDER` works as for every pane.
- `review import`, `review result`, `review list`, and `review delete` are refused.

Only a planner pane can publish a pack with `session` or `round`. Any other publisher gets a refusal when the manifest has either field. The publish from a planner pane sets both and replaces a value that the manifest holds. `round` counts per pack. A new pack takes the next round of the session: 1, 2, 3, and so on. A republish of a pack of the same session keeps the round of that pack. `--round N` (1 to 9999) sets another round, and only a planner pane can pass it. The session keeps the highest round. A `--dry-run` and a refused repeat of the same version do not change the round. The Mailbox item of the pack names the session and the pane.

### Publish

1. Run `herdr-boss review check FOLDER` and correct each error.
2. Run `herdr-boss review publish SLUG FOLDER --judge-pass TEXT`. TEXT names the model and the date of the independent judge pass that ran on the pack.
3. Read the printed review URL.

The command validates the folder with the rules of the design. The secret scan reads each text file. A finding names the file and the secret class, never the value. The command refuses a text file over 2 MB, an SVG, an HTML file outside a `page` item, and every image above 40 megapixels. It prints one line for each failed rule.

`review check` and `review publish` also print one warning per item that misses description, steps, expected, or link. They print one item warning with the rule `ask` when an agent-verified item lacks `accept` or `deny` in `ask`. Herdr Boss adds them. They print one pack warning when any item has no `verifiedBy`, one item warning when an `agent-verified` item has no evidence, and one pack warning when `designPass` is missing or has result `not-run`. These warnings do not change the exit code. An invalid value is an error.

`--judge-pass TEXT` records the independent judge pass that ran on the pack, as one line of 1 to 200 characters. Write the model and the date, for example `claude-opus-5-5, 2026-10-04`. The command stores the text on the manifest of the version, so the pack page shows it. The command refuses a text with a line break or a text that looks like a token, a key, or a password. Every `review publish` needs this record. A publish without the flag is refused with exit code 1 and writes nothing. The message names the missing record and the flag. `review import` does not need the record.

The command stores the files in the data folder and adds a Mailbox item to the thread of the project. The item has the kind `review` and the action `decide`. It has the title `Review: TITLE (vN)` and a link to the pack. `--note` adds text of 1 to 1000 characters to the item. The command refuses a title or a note that looks like a token, a key, or a password, before it writes anything.

A publish with an existing pack ID makes the next version. The command closes the older open Mailbox item of that pack with `closedBy: "review"` and posts a new item. The Owner sees one open item for each pack. An Owner answer to a review item stays in the Mailbox thread of that item.

If the publish fails after the store write, the command prints the pack ID and the version. The pack is stored and has no complete Mailbox item. Run the same `review publish` command again. An open pack with the same content gets no new version. The command only posts or links the missing Mailbox item and prints `Repaired`. A second publish of the same version is refused while its linked Mailbox item is open. The command prints `Refused` with the pack ID and the version. When the linked item was closed or missing, the command posts the item again and prints `Repaired`. A `--note` alone does not make a new version. A changed `--judge-pass` or a changed pack folder makes a new version. A submitted pack always takes the next version.

`--dry-run` validates the folder and prints what the command would publish. It writes no file, no database row, and no Mailbox item.

A project can have 5 open packs. The publish command refuses a sixth. It also refuses a version that takes the packs over 2 GB, and it names the oldest submitted packs to delete.

Add `--carry-open` to a planner publish to copy the open items from an earlier submitted pack in the same session. Herdr Boss excludes the pack being published, then chooses the most recently submitted pack for the project and session. If two packs have the same submit time, it chooses the pack ID that comes first in sort order. The copy keeps each item ID, its full item text, links, files, saved note, and pins. If an item ID is already in the new folder, Herdr Boss keeps the new folder's item and does not add a duplicate. The command prints the number of items it copied. Without an earlier submitted pack, it copies no items.

### Reopen an item

Run `herdr-boss review reopen SLUG PACK ITEM` to unlock one unanswered or changed item in the current submitted version. A planner pane can reopen only a pack whose `manifest.session` matches its session. The project orchestrator pane and a plain terminal can also reopen an item. A Boss pane can reopen only a pack in the `boss` thread. Worker panes and panes from another project get a refusal. Only that item accepts an answer. Other items stay locked. The item locks again when the Owner saves an answer. Herdr Boss queues a short message with the pack, item ID, and saved answer for the planner session pane.

### Import

`review import` reads a folder of HTML files, or one HTML file, and writes a temporary pack folder. It never fetches a URL.

1. It makes one section for each HTML file. The order is `index.html`, the pages that `index.html` links to in link order, then the other pages by name.
2. Each section has one `page` item that shows the whole page in a sandboxed frame.
3. Each local `<img>` becomes one `image` item, with the `alt` text as the title. A file that two pages use makes one item.
4. The command prints the external URLs that the pages use, without query string or fragment. The frame blocks them.
5. The command prints each local file that it did not import, with the reason: an SVG, a missing file, a path outside the folder, a local script or style sheet, or a file of another type. A page item holds only one HTML file.

The importer reads each page in one pass with fixed limits: 20000 tags for each page, 200 KB of CSS for each page, and 400 items for each pack. It skips each image after the item limit. Each name, URL, and title that the command prints is one line without control characters and has at most 200 characters. The command lists at most 100 external URLs and 100 skipped files.

`--id` sets the pack ID. The default is the name of the folder or the file. `--title` sets the pack title. The default is the title of the first page. `--dry-run` prints the same lists and publishes nothing. The importer removes its temporary folder.

### Result

The Owner answer comes back as an `[owner]` prompt with the verdict, the flag `(no change text)` when it applies, the counts, the denied items with their notes, and a fetch command. The prompt has at most 1500 characters. The command in the prompt is `herdr-boss review result PACK --version N --format json|md`.

When a planner pane published the pack, the prompt goes to that pane and not to the orch pane. It lists the pack note, each choice with its label and note, each denied item, each item with a note, and each skipped item. It has at most 4000 characters and ends with `… N more` when it is cut. It has no fetch command, because a planner pane cannot run `review result`. The message follows the rules of every result message: one message for each pack and version, the same retries, and no secret. When the session has ended, the message goes to the orch pane. While the session is active and its pane is absent, the message waits.

The result JSON has `session` and `round` when the manifest has them. It also has `openItems`, a list of the IDs of each unanswered, Ask later, or changed item. A choice has `choiceLabel`. A skipped item has `state: "open"` and `skipped: true`. The Markdown result and the message to the planner list the open item IDs too.

`review result` prints the stored Markdown summary. The summary starts with the counts. It lists the denied items and the items that need a live check first, with the Owner's notes quoted. `--format json` prints the result object with the schema `herdr-boss.review-result/1`. The verdict is `accept`, `accept-with-changes`, or `deny`. The service computes it: `accept` needs every item accepted and no note text. The JSON also holds `computedVerdict` and `changeText`. When the verdict is `accept-with-changes` and `changeText` is `false`, the Markdown shows the flag `no change text`. Exit code 3 means that the pack, the version, or the result does not exist. The Owner has then not submitted that version.

The command changes no task. Read the result, record an Owner decision in `docs/orchestration/memory.md`, and publish the project status.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The command finished. |
| 1 | Usage error, or a refusal: the caller, a secret in a title or a note, the open pack limit, or the quota. |
| 2 | The pack folder is not valid. The command printed each failed rule. |
| 3 | The pack does not exist, or it has no result yet. |

Example:

```sh
herdr-boss review check .worker/review-pack
herdr-boss review publish shop .worker/review-pack --note "Start with the dark cart."
herdr-boss review import shop ./site-export --id landing-redesign --dry-run
herdr-boss review result shop checkout-redesign --json
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

The card **Stand down** on the Agents page uses `POST /api/watch/standdown` and `POST /api/watch/standdown/undo`. The first route sets the policy mode of each idle project to `paused`. The second route gives each project its own mode back. See [Stand down](reference/settings.md#stand-down).

## Harness settings

| Command | Action |
|---|---|
| `harness check [--live-codex]` | Check the harness settings that orchestration needs. Print one line per entry: `ok`, `missing`, or `bad`, the harness, and the entry. When `herdr.rules` holds no active exact `stop-own` allow rule, one `missing` line names the rules file and prints the line to add: `prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")`. The rule lets a Codex worker stop its own process by PID through `herdr-boss worker stop-own` without an escalation. Only an active exact rule with `decision="allow"` counts. A commented, malformed, prompt, or broader line does not count. An exact forbidden rule for the same command, or an allow rule next to a forbidden rule, gives one `bad` line that names the file and the conflict, and the check claims no permission. Run `herdr-boss harness sync` to add the rule. `harness check` never adds it. The Claude `**Herdr Boss projects**` line passes for a project when it names the project path, or names a parent folder of the project and states the marker file `docs/orchestration/herdr-boss.md`. The output names the parent folder of a covered project. Exit 1 when an entry is `missing` or `bad`. The command prints only paths and entry names. Owner lines that the Claude template does not define are not findings. `--live-codex` also runs one `codex exec -s workspace-write` with the worker shell variables of the caller pane. It passes when the tool shell has `HERDR_ENV` and `HERDR_PANE_ID`, and it prints only `set` or `missing`. The timeout is 180 seconds. Without `--live-codex`, the command calls no model. |
| `harness sync [--dry-run] [--codex-only]` | Back up `~/.codex/config.toml` to `config.toml.bak-<UTC timestamp>`, and add the missing roots to `writable_roots` in `[sandbox_workspace_write]`. The roots are `~/.herdr-boss`, the service worktree root (default `~/Projects/.herdr-wt`), and the common Git directory for each registered project with `codexSharedGit` on. A common Git directory lets Codex write shared Git metadata for linked worktrees. The command prints each root it adds. Back up `~/.codex/rules/herdr.rules` to `herdr.rules.bak-<UTC timestamp>` and add the missing `stop-own` rule before the first forbidden rule. When the rules file is missing, print the rule to add and write nothing. When an exact forbidden `stop-own` rule exists, or an allow rule and a forbidden rule exist together, print the conflict, write nothing to the rules file, and exit 1. Then compare the Claude template with `autoMode` and print only its differences. `--dry-run` prints the roots and the rule to add and writes nothing. `--codex-only` skips the Claude check. |
| `harness pin [PROJECT] --reason TEXT` | Record or refresh the shared Git pins after review. The reason is required. The Owner terminal and the Boss can pin any registered project. A project lead can pin only its own project. Without `PROJECT`, the Owner and Boss pin all registered projects. A project lead pins its own project. The Owner terminal needs a TTY on stdin and stdout. The command audits the reason in `action-audit.jsonl`. If the private directory is not writable, the command refuses before it changes pins or writes an audit line. |
| `harness pin --forget SLUG --reason TEXT` | Remove the selected pin and its private index row. Use this command for a removed project or an old slug after a manual rename. The repository can be missing. Only the Owner terminal or the Boss can run it. The Owner terminal needs a TTY on stdin and stdout. The command refuses a worker, a project lead, an unknown pin, or a missing reason. It writes the masked reason to `action-audit.jsonl`. |
| `harness change <harness> <label> [--date YYYY-MM-DD]` | Append one line to `harness-changes.jsonl` in the data directory. The line marks the day of a harness fix on the denial chart of the Analytics page. `<harness>` is `claude`, `codex`, `opencode`, or `pi`. `<label>` has 1 to 80 characters. The default date is today in local time. Only the pane labeled `boss`, a pane labeled `orch`, and a plain terminal can run it. A worker pane is refused. The command validates every field, writes nothing on an error, and exits 1. See [Denials per day](reference/locks.md#denials-per-day). |

`harness check` accepts single Codex release rules and a combined rule with a list of alternatives in one pattern element. For example, `prefix_rule(pattern=["herdr-boss","release",["request","publish","status"]], decision="allow")` permits both required release commands. A matching forbidden rule still gives a conflict. A malformed list does not count.

`harness check` reports a stale pin when its slug is no longer registered, its registered repository path changed, or its Git directory is missing. Each stale finding prints `herdr-boss harness pin --forget SLUG --reason TEXT` with the saved slug. Ask the Boss or Owner to run it. Replace `TEXT` with the cleanup reason. The check keeps the pin until it is explicitly removed.

`harness check` and `harness sync` compare harness facts with `harness-facts.json` in the data directory. The first run records a baseline. A later change adds one marker per changed fact to `harness-changes.jsonl`. The facts are the installed version from the last `tools check`, the model list with local additions and exclusions, and sandbox settings and launch arguments. Run `tools check` to refresh the version facts. A missing reading keeps the last known fact. `harness sync --dry-run` changes neither file. The baseline stores hashes only. Automatic labels contain no paths, model names, setting values, or secrets. Each marker write keeps at most 200 rows and 64 KiB on disk. A recording error prints one warning with no path. Check and sync keep their result and exit code. Herdr Boss saves the baseline before it writes markers. A failed marker is not retried.

`harness sync` keeps each other line of the Codex file. It keeps each existing root except a disabled project Git root. It adds `~/.herdr-boss` and each enabled project common Git directory when they are missing. It prints the paths it adds and backs up the config before it writes. When the Codex section or array is missing or cannot be parsed safely, it changes nothing, prints the roots to add, and exits 1. For `~/.codex/rules/herdr.rules` it keeps every other line. A missing rules file is a report line. An exact forbidden `stop-own` rule or a deny-plus-allow pair is a conflict: the command prints it and exits 1, and it never replaces an explicit deny.

WARNING: The common `.git` directory gives Codex write access to `hooks/`, `config`, `refs/`, `objects/`, `HEAD`, `info/`, and `worktrees/` of the main repository. A changed hook can run code at the next Git command.

Set `projects.SLUG.codexSharedGit` to `true` or `false` in `policy.json`. The default is `true`. The shipped default for `herdrboss` is `false` until K60 has live verification. In Settings, open Advanced and Codex shared Git. Change the project switch and select Apply policy. Run `harness sync`, then restart Codex. Sync omits disabled Git roots and removes their exact existing entries. Check reports `codexSharedGit intentionally off`. A broader writable root that still covers a disabled Git directory fails the check. Remove that broader root yourself. The project lead commits HerdrBoss Codex worker changes with `worker commit`.

Herdr Boss stores pins in `~/.config/herdr-boss/git-pins/`, in the same private config directory as the access token. A temporary `HOME` selects a test directory. The pins are not in `HERDR_BOSS_DIR` or the repository. Each pin file stores the project slug, repository path, hashes, and the last notified change-set ID. A private index records which projects were pinned. Push and suite use these private records. They do not need `project-repos.json`.

The pins contain SHA-256 hashes of sorted hook names and contents, including sample files, file modes, and linked file contents. They hash the whole repo `config`, `config.worktree` for the main checkout, each `worktrees/NAME/config.worktree`, `info/attributes`, and the files in the folder named by `core.hooksPath`. Check reports file names only. Remote URL and push URL hashes report the remote name only. It never prints contents, config values, or URLs. Names use letters, digits, `.`, `_`, `@`, and `-`. Other characters become `?`. Each name has at most 64 characters. Output lists at most 10 names and the remaining count.

A project with no prior pin can get a baseline through harness check, harness sync, or harness pin. Push and suite never create a baseline. A missing or unreadable pin for a previously pinned project fails closed. Ask the orchestrator to ask the Boss. A pin difference fails the check. It queues one Boss notice per change set. The private pin stores the dedupe ID. Delivery removes the transient notice from the data directory. Sync does not accept an unrelated Git edit. Review the change before you run `harness pin PROJECT --reason TEXT`.

The caller check is not a security boundary against a same-user process. The protection against a Codex worker is the private pin folder, which the Codex sandbox cannot write. Keep that folder outside Codex writable roots. Caller checks and the Owner TTY requirement prevent routine misuse. They do not stop another process of the same user.

`push` and `suite` check the pins before they take a lock or reuse a suite pass. A difference refuses the command with: `Ask the Boss. Do not run the hook.` The guard reads the pinned files and uses one Git config call. It caches the Git state for at most 10 seconds in the command process. It always reads the private trust record. Deletion or corruption of that record fails at once. `harness check` always reads fresh Git state. Only the verified Boss pane can override with `--force --reason TEXT`. The reason must have 1 to 300 characters. The command audits the reason. A push carries the reviewed reason to a suite in its hook. That suite verifies the Boss again and audits its override. Herdr Boss consumes the override options. Other Git push arguments pass through. Use `--force-with-lease` for a Git ref update that requires it.

If the command cannot verify a common Git directory, it tries the repository `.git` path and prints a warning. It skips that project root if neither path is a valid Git directory.

The template comparison reads `autoMode` from `~/.claude/settings.json`. It prints missing lines and changed labeled environment lines. It shows the old line after `now:`. The recommended `**Herdr Boss projects**` line names the parent folders of the registered project repositories. It names each distinct parent once, at most 10, and never `/`, the home folder, or a folder above it. A project under such a folder is named by its path. The line states the marker file rule and the worker worktree root. It counts Owner lines that the template does not define, but it does not show their text. If the settings file or the `autoMode` key is missing, it prints the full template and says why. It never edits `~/.claude/settings.json`. The checked entries and the risk of each setting are in [harness-setup.md](harness-setup.md).
| `herdr-boss scratch SLUG` | Create `~/.herdr-boss/scratch/SLUG/` if it does not exist, and print its absolute path. `HERDR_BOSS_DIR` replaces `~/.herdr-boss`. |

## Settings reference

The dashboard Settings and Allocation pages show these settings. Each row shows the key in `policy.json` or `config.json`, the default, the unit, the range, and the effect of a higher or lower value. The dashboard shows the same text in the info popup of each setting.

Regenerate the block with `UPDATE_SETTINGS_DOCS=1 node --test test/setting-help.test.js` after you change `public/setting-help.js`.

<!-- settings-reference:begin -->

Do not edit this block. It comes from `public/setting-help.js`.

#### Agent apps

- Controls: Which agent kinds and models workers may use, the preferred model of each kind, and which provider usage limit each model counts against.
- Effect: Workers and usage limits. Worker start and handover choose only from the models that you leave on.
- Safe to change: Safe to change at any time. A running worker keeps its model. A model that you switch off is not chosen again.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Available | `harness.available` | Lets workers use this agent app. Clear it to stop all workers from using the agent app. | On for every agent app | Switch | On or off | Turning it on lets worker start and handover pick the agent app. | Turning it off stops new workers on this agent app. A running worker keeps working. | Select Apply policy. The change takes effect at the next engine tick. |
| Preferred model | `harness.preferredModel` | The model that worker start and handover use when no model is given. On a narrow field, a long name ends with an ellipsis. The choice arrow stays visible. | The agent app default | Model name | Any model that the agent app allows | Not applicable. Choose another model to change the choice. | An empty choice uses the agent app default. | Select Apply policy. The change takes effect at the next engine tick. |
| Model box | `harness.model` | Lets this agent app use the model. Clear the box to stop the agent app from using the model. | On for a catalog model | Switch | On or off | Turning it on lets workers use the model in this agent app. | Turning it off stops new workers on this model in this agent app. Other agent apps keep their own box. | Select Apply policy. The change takes effect at the next engine tick. |
| Provider | `harness.provider` | The provider usage limit that this model counts against. | The route of the catalog, or Unmetered | Provider name | The providers that the agent app supports, or Unmetered | Not applicable. Choose a provider to count the model against its usage limit. | Unmetered means no usage limit applies. Pacing and usage limit warnings ignore the model. | Select Apply policy. The change takes effect at the next engine tick. |
| Add model | `harness.addModel` | Adds a local model string to this agent app. The string is stored in the local policy, not in kit/models.json. | No local models | Model string | Up to 128 characters: letters, digits, dot, underscore, slash, and hyphen | Not applicable. | Select Remove to delete a local model. | Select Apply policy. The change takes effect at the next engine tick. |

#### Provider usage limits

- Controls: How Herdr Boss paces each provider usage limit, the goal for each usage limit window, and the warning and critical levels.
- Effect: Usage limits and notices. Pacing changes which lanes say Use now and when a worker start is refused. The levels change when a usage limit notice is sent.
- Safe to change: Safe to change. A goal below 100% makes Herdr Boss save usage limit. Keep the warning level below the critical level.
- Restart: No restart. Goals and modes need Apply policy. The two levels need Save.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Usage limit mode | `quota.mode` | Sets if Herdr Boss paces a provider. Manage pace uses the usage limit to decide when to run work. Ignore usage limit stops pacing and pace warnings for worker dispatch. | Manage pace | Choice | Manage pace or Ignore usage limit | Not applicable. | Ignore usage limit lets workers start at any pace. Handover risk and automatic handover still use live usage limit data. A window at 100% still exhausts the provider. | Select Apply policy. The change takes effect at the next engine tick. |
| Pacing goal and goal end | `quota.goalPercent` | The most percent of a usage limit window that Herdr Boss plans to use by the end of the goal. The goal end is at the reset, at a local date and time, or a whole number of hours before each reset. | Blank, which means 100% | Percent of the window | 0 to 100. A goal end must be after now, after the window start, and not after the reset | A higher goal lets workers use more of the window. A later end gives the goal more time to use usage limit. | A lower goal saves usage limit. The lanes say Use now less often. An earlier end forces the use of usage limit sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Pace tolerance points | `paceTolerancePoints` | The most percentage points that the use may be above the expected use of a usage limit window. Above this, the lane is ahead of pace. A lane inside the tolerance is on pace. | 5 | Percentage points | 0 to 50 | A lane stays on pace with a larger lead. Workers start more often. | A lane is ahead of pace sooner. A value of 0 uses no tolerance. | Select Apply policy. The change takes effect at the next engine tick. |
| Haiku pace tolerance points | `paceHaikuTolerancePoints` | The most percentage points Claude may be above its expected use when you start claude-haiku-5-5. Other Claude models use paceTolerancePoints. | 15 | Percentage points | 0 to 100 | Haiku workers can start with a larger lead over pace. | Haiku workers are refused sooner. A value of 0 allows no lead over pace. | Select Apply policy. The change takes effect at the next engine tick. |
| Minimum use for ahead of pace | `paceMinUsePercent` | The lane is never ahead of pace below this used percent of a usage limit window. This holds also when the use is above the expected use. | 30 | Percent used | 0 to 100 | A lane stays on pace to a higher use. A fresh window does not block workers. | A lane can be ahead of pace at a lower use. A value of 0 uses no minimum. | Select Apply policy. The change takes effect at the next engine tick. |
| Route to a below-pace lane | `paceRouting` | Chooses a model of a lane that is far below its pace when you give no model. A lane is far below its pace when every live window is more than the tolerance below its expected use. The choice keeps the agent app and never overrides --kind or --model. | On | Switch | On or off | Turning it on uses the usage limit of a lane that is behind its pace. | Turning it off keeps the default model of the agent app. | Select Apply policy. The change takes effect at the next engine tick. |
| Claude timeouts before back-off | `quotaProbe.backoffAfterTimeouts` | The number of Claude usage limit probe timeouts in a row after which Herdr Boss probes Claude at the back-off interval. A good reading resets the count. A timed-out probe is not retried at once. A missing usage reader or login is an unknown reading and does not count as a timeout. | 2 | Timeouts | 1 to 10 | A higher value keeps the normal probe interval for more timeouts. | A lower value starts the back-off sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Claude back-off minutes | `quotaProbe.backoffMinutes` | The time between Claude usage limit probes after the timeouts in a row reach the limit. Codex and OpenCode Go keep the normal interval. The last good Claude reading stays on screen with its age. | 20 | Minutes | 1 to 1440 | A higher value probes Claude less often during a failure. | A lower value probes Claude more often during a failure and adds load. | Select Apply policy. The change takes effect at the next engine tick. |
| Usage limit warning level | `quota.warnPercent` | The used percent of a usage limit window at which the usage limit shows a warning. | 90 | Percent used | 50 to 99, below the critical level | A higher value gives the warning later. | A lower value gives the warning earlier. | Select Save in the group. The change takes effect at once. |
| Usage limit critical level | `quota.criticalPercent` | The used percent of a usage limit window at which the usage limit shows a critical alert. | 98 | Percent used | 51 to 100, above the warning level | A higher value gives the critical alert later. | A lower value gives the critical alert earlier. Keep it above the warning level. | Select Save in the group. The change takes effect at once. |
| OpenCode Go reset time | `quota.opencodeGoResetAt` | The time at which the OpenCode Go subscription period resets. OpenCode Go has no usage source that Herdr Boss can read, so you set the time by hand. The Fleet page and the usage limit card show it next to the unknown reading. It gives a reset time and no percent. | Blank | Time | Blank, or an ISO time such as 2026-10-09T10:00:00Z | A later time shows a later reset. | A blank value shows no reset time. The OpenCode Go reading stays unknown. | Select Save in the group. The change takes effect at once. |
| OpenCode Go estimate days | `quota.opencodeStatsDays` | The number of days that the local estimate of OpenCode Go use covers. The estimate comes from opencode stats, which counts the sessions in this factory only. It shows tokens and cost, labeled used in this factory (local estimate). It is never a percent and never a usage limit. | 7 | Days | A whole number of 1 to 90 | A higher value counts more days of local use. | A lower value counts fewer days of local use. | Select Save in the group. The change takes effect at once. |

#### Machine

- Controls: The machine guard, the CPU and load limits, the disk and swap thresholds, and the notice cooldown.
- Effect: The machine and notices. An active guard blocks new workers when the machine is busy. Disk and swap thresholds raise notices. The swap refusal can block worker starts.
- Safe to change: Safe to change. A high limit lets more work run at once. A low limit protects the machine but slows work. Disk and swap notices stay on when the guard is off.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Machine guard | `machine.guardEnabled` | Turns the CPU and load limits on or off. An active guard warns and blocks worker starts when the machine is busy. | On | Switch | On or off | Turning it on protects the machine from too many workers. | Turning it off stops CPU and load warnings and blocks. Memory, disk, and swap notices stay on. | Select Apply policy. The change takes effect at the next engine tick. |
| Pause guard | `machine.guardPause` | Turns the machine guard off for a set time. The guard turns on again when the time ends. | 1 hour in the list | Hours | 1, 2, 4, 8, 12, or 24 hours | A longer pause lets more work run for longer. | A shorter pause returns the protection sooner. Select Resume guard to end a pause early. | Select Apply policy. The change takes effect at the next engine tick. |
| Owner away after minutes | `machine.ownerAwayMinutes` | The idle time after which Herdr Boss treats the Owner as away. It chooses the away limits below. | 10 | Minutes | 0 to 1440 | The Owner counts as present for longer, so the lower present limits apply for longer. | The Owner counts as away sooner, so the higher away limits apply sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| CPU limit while present | `machine.presentCpuPercent` | The CPU use at which the guard blocks worker starts while the Owner is present. CPU is a percent of the total machine capacity. | 70 | Percent | 0 to 100 | A higher limit lets workers start on a busier machine. | A lower limit keeps the machine free for the Owner. | Select Apply policy. The change takes effect at the next engine tick. |
| CPU limit while away | `machine.awayCpuPercent` | The CPU use at which the guard blocks worker starts while the Owner is away. | 95 | Percent | 0 to 100, or blank to turn the limit off | A higher limit lets workers use more of the machine. | A lower limit leaves more headroom. A blank field turns the limit off. | Select Apply policy. The change takes effect at the next engine tick. |
| Present load backstop | `machine.presentLoadFactor` | A backstop on the 5-minute load average while the Owner is present. The limit is this factor times the core count. | 3 | Times the core count | 0 to 128, or blank to turn the backstop off | A higher factor allows more load before the guard acts. | A lower factor acts sooner. A blank field turns the backstop off. | Select Apply policy. The change takes effect at the next engine tick. |
| Away load backstop | `machine.awayLoadFactor` | A backstop on the 5-minute load average while the Owner is away. The limit is this factor times the core count. | 8 | Times the core count | 0 to 128, or blank to turn the backstop off | A higher factor allows more load before the guard acts. | A lower factor acts sooner. A blank field turns the backstop off. | Select Apply policy. The change takes effect at the next engine tick. |
| Disk warning at free GB or less | `machine.diskWarnFreeGB` | The free disk space at or below which Herdr Boss raises the disk warning. A GB is 2³⁰ bytes. This notice stays on when the guard is off. | 20 | GB free | 0 to 1048576 | A higher value gives the warning earlier. | A lower value gives the warning later. | Select Apply policy. The change takes effect at the next engine tick. |
| Disk warning clears at free GB | `machine.diskClearFreeGB` | The free disk space at or above which the disk warning clears. The warning raises at the warning value or less and stays active until the free space reaches this value. A GB is 2³⁰ bytes. | 24 | GB free | 0 to 1048576, at least the warning value | A higher value keeps the warning active longer and gives fewer repeat notices when the free space moves around the warning value. | A lower value clears the warning sooner. A value near the warning value allows repeat notices. | Select Apply policy. The change takes effect at the next engine tick. |
| Disk critical below free GB | `machine.diskCriticalFreeGB` | The free disk space below which Herdr Boss sends a critical disk alert. | 5 | GB free | 0 to 1048576 | A higher value gives the critical alert earlier. | A lower value gives the critical alert later. Keep it below the warning value. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap warning at % used | `machine.swapWarnPercent` | The swap use at which Herdr Boss raises a swap warning. It needs 3 samples in a row at or above the percent, with at least the minimum GB in use. The warning never blocks work. | 80 | Percent of the swap total | 1 to 100, or blank to turn the warning off | A higher value gives the warning later. | A lower value gives the warning earlier. A blank field turns the warning off. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap refusal at % used | `machine.swapRefusePercent` | The swap use at which the swap refusal blocks new work. It has an effect only when Refuse new work at high swap is on. | 95 | Percent of the swap total | 1 to 100, or blank to turn the refusal off | A higher value blocks new work later. | A lower value blocks new work sooner. A blank field turns the refusal off. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap rules need at least GB used | `machine.swapMinUsedGB` | The least swap in use before the swap warning and the swap refusal apply. The macOS swap total grows with use, so a percent alone can mislead. | 2 | GB | 0 to 1024 | A higher value ignores a small swap use. | A lower value lets a small swap use raise a notice. Zero removes the floor. | Select Apply policy. The change takes effect at the next engine tick. |
| Refuse new work at high swap | `machine.swapRefuseEnabled` | When on, a worker start, a suite, or a push with a pre-push suite fails while swap is at or above the refusal percent. Work that the Owner or the Boss starts is never refused. | Off | Switch | On or off | Turning it on protects a machine that swaps from more load. Use --force-swap --reason TEXT for worker start, or HERDR_BOSS_FORCE_SWAP=1 for suite and push, to override. | Turning it off lets work start at any swap level. The swap warning still applies. | Select Apply policy. The change takes effect at the next engine tick. |
| Notice cooldown seconds | `machine.alertCooldownSeconds` | The least time before the same machine notice is sent again. | 21600 (6 hours) | Seconds | 0 to 604800 | A higher value sends fewer repeat notices. | A lower value sends repeat notices sooner. Zero sends a notice at each change. | Select Apply policy. The change takes effect at the next engine tick. |
| Kit digest interval minutes | `machine.kitDigestMinutes` | The least time between two kit digests to one project lead pane. A digest lists the required kit changes that the pane has not received. Herdr Boss sends no digest while the pane works. It sends the digest when the pane is idle or done. | 120 (2 hours) | Minutes | 10 to 1440 | A higher value sends fewer kit digests. Each digest lists more changes. | A lower value sends kit digests sooner. Each digest lists fewer changes. | Select Apply policy. The change takes effect at the next engine tick. |
| Memory free warning | `machine.memFreeWarnPercent` | The free memory percent below which Herdr Boss shows a memory warning. It stays on when the guard is off. | 15 | Percent free | 1 to 50 | A higher value gives the memory warning earlier. | A lower value gives the memory warning later. | Select Save in the group. The change takes effect at once. |

#### Locks

- Controls: Machine lock capacity, the short job limit, and the lock watchdog. The machine guard checks a short job that starts beside a long job.
- Effect: All projects that use a machine lock. The long lane always holds at most one job.
- Safe to change: Unknown jobs use the long lane. A lower limit sends more jobs to the long lane.
- Restart: No restart. Select Apply policy. Capacity and guard changes apply to the next lock admission. The watchdog uses changes at the next engine tick.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Network lock slots | `locks.network.slots` | A CPU-bound command in this class runs without the load guard. Mark only commands that wait on a remote service. This setting sets the maximum number of network-bound commands that can run at the same time. Network runs do not use a full-suite slot. | 2 | Slots | 1 to 8 | A higher value lets more network-bound commands run at once. | A lower value limits new network-bound commands. Existing holders finish before admission fits the lower capacity. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Machine lock slots | `locks.slots` | The total number of holders for a machine lock. One holder uses the long lane. The other slots hold short jobs. | 2 | Slots | 1 to 4 | A higher value lets more short jobs run beside one long job. | A lower value limits short jobs. Existing holders finish before admission fits the lower capacity. A value of 1 keeps one exclusive lane. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Short job limit | `locks.shortLimitMinutes` | The hold time at or below which a job uses the short lane. Herdr Boss compares it with the median of fewer than 10 holds, or with the 90th percentile of the last 10 holds. | 6 | Minutes | 1 to 60 | A higher value sends more jobs to the short lane. | A lower value sends more jobs to the long lane. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Lock watchdog multiplier | `locks.watchdogMultiplier` | The number of predicted holds that a full-suite lock must exceed before the watchdog checks its CPU use. It uses a 10-minute minimum prediction until the ledger has five holds of the same kind. | 3 | Times predicted hold | 1 to 20 | A higher value waits longer before the watchdog sends a notice. | A lower value sends a notice sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Lock watchdog CPU limit | `locks.watchdogCpuPercent` | The maximum CPU use of the full-suite holder and its child processes in each of the last two process samples. The watchdog sends a notice only below this value. | 1 | Percent | 1 to 100 | A higher value sends notices when a busier holder runs. | A lower value sends notices only when the holder uses less CPU. | Select Apply policy. The change takes effect at the next engine tick. |
| Guard for short jobs | `locks.guard.enabled` | Checks machine load, swap use, and free memory before a short job starts beside a long job. | On | Switch | On or off | Turning it on pauses a short job when a machine limit fails. | Turning it off lets a short job start beside a long job without a machine check. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Maximum load for a short job | `locks.guard.maxLoadPercent` | The 5-minute load average as a percent of the machine core count. The guard pauses above this value. A queued short job shows `waits: lane guard` and the load in the Locks panel. | 231 | Percent of cores | 0 to 1000; a blank field is invalid | A higher value lets a short job start at a higher load. | A lower value pauses short jobs at a lower load. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Maximum swap for a short job | `locks.guard.maxSwapPercent` | The swap use as a percent of the swap total. The guard pauses above this value. | 96 | Percent of swap | 0 to 100; a blank field is invalid | A higher value lets a short job start with more swap in use. | A lower value pauses short jobs with less swap in use. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |
| Minimum free memory | `locks.guard.minFreeMemPercent` | The free memory percent below which the guard pauses a short job. | 40 | Percent free | 0 to 100; a blank field is invalid | A higher value leaves more memory free before a short job starts. | A lower value lets a short job start with less free memory. | Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification. |

#### Pictures

- Controls: How many days Herdr Boss keeps pictures and agent messages. The time limit for a Herdr agent prompt process.
- Effect: Stored pictures, agent-message text, agent-message metadata, and prompt delivery.
- Safe to change: A shorter period deletes older pictures, message text, or metadata at the hourly sweep.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Picture retention days | `attachments.retentionDays` | How long Herdr Boss keeps a linked picture. An hourly sweep removes expired pictures. An upload left unlinked for one hour is deleted. Deleting or dismissing a message deletes its pictures. | 30 | Days | 1 to 365 | A higher value keeps linked pictures longer. | A lower value deletes older pictures at the next sweep. Deleted pictures cannot be recovered. | Select Apply policy. The change takes effect at the next engine tick. |
| Agent message text retention days | `agentMessages.retentionDays` | How long Herdr Boss keeps agent-message text. An hourly sweep removes older text. | 14 | Days | 1 to 90 | A higher value keeps agent-message text longer. | A lower value removes older text at the next sweep. Metadata rows use a separate retention setting. | Select Apply policy. The change takes effect at the next engine tick. |
| Agent message metadata retention days | `agentMessages.metaRetentionDays` | How long Herdr Boss keeps agent-message metadata after it removes the message text. A row has no message text. | 180 | Days | 7 to 730 | A higher value keeps message metadata longer. | A lower value removes older metadata at the next sweep. | Select Apply policy. The change takes effect at the next engine tick. |
| Agent prompt timeout | `agentMessages.promptTimeoutSeconds` | The time limit for one Herdr agent prompt process. On a timeout, tell reads the pane input. If it equals the sent text, tell retries submit once. It clears only its own unsubmitted input while the agent is idle. Then it reads the pane again. | 25 | Seconds | 1 to 120 | A higher value gives Herdr more time to send a prompt. A blocked prompt delays the caller longer. | A lower value ends a blocked prompt sooner. A slow delivery can time out. | Select Apply policy. The change takes effect at the next engine tick. |

#### To do digest

- Controls: The daily digest time, its time zone, and its desktop notification.
- Effect: One Mailbox digest of open To do items. Each Monday includes the five oldest open items.
- Safe to change: The default is off. A new digest replaces the previous digest. The service posts at most once per date in the chosen time zone.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Daily digest time | `ownerTodo.digestTime` | The time for a short list of open To do items in the Mailbox. Leave it empty to turn the digest off. The first tick at or after this time posts the digest. Monday includes the five oldest open items by age. | Off | Time | 00:00 to 23:59 in HH:MM format, or empty | A later time posts the digest later in the day. | An earlier time posts the digest earlier in the day. | Select Apply policy. The change takes effect at the next engine tick. |
| Digest time zone | `ownerTodo.timeZone` | The time zone for the daily digest date and time. Use local for the service time zone. Use a time zone name such as Europe/Oslo for a fixed zone. The service follows daylight saving changes. | local | Time zone | local or a valid time zone name | A zone ahead of UTC reaches the chosen time earlier. | A zone behind UTC reaches the chosen time later. | Select Apply policy. The change takes effect at the next engine tick. |
| Desktop digest notification | `ownerTodo.notify` | Send a desktop notice when the service saves a daily digest. The notice gives the open count. Quiet hours hold it until they end. The Mailbox digest does not wait for the notice. | Off | Switch | On or off | Turning it on sends a desktop notice with each new digest. | Turning it off keeps delivery in the Mailbox. | Select Apply policy. The change takes effect at the next engine tick. |

#### Watch

- Controls: The routines that the Boss pane gets while a watch runs, the worker caps of a watch, and quiet hours.
- Effect: Workers and notices. A cap limits how many workers run while the Owner is away. A routine sends a prompt to the Boss pane.
- Safe to change: Safe to change. A routine change applies at the next prompt of a running watch. A routine that you edit never changes the kit file.
- Restart: No restart. A routine needs Save. A cap needs Save in its group.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Routine title | `watch.routine.title` | The name of a watch routine. The Watch box and the Boss prompt show it. | The kit title | Text | Up to 60 characters | Not applicable. | Not applicable. | The change takes effect at once. |
| Routine model hint | `watch.routine.model` | A hint of the model that the Boss should use for the routine. The Boss pane reads it in the prompt. | default | Text | Up to 40 characters | Not applicable. | Not applicable. | The change takes effect at once. |
| Routine schedule | `watch.routine.schedule` | When a routine runs during a watch: every N minutes, or at a set time before the end of the watch. | Every 60 minutes for a new routine | Minutes, or a time of day | 1 to 1440 minutes, or a time such as 01:00 | More minutes between runs send fewer prompts. | Fewer minutes between runs send more prompts and use more usage limit. | The change takes effect at once. |
| Routine prompt | `watch.routine.prompt` | The text that the service sends to the Boss pane when the routine runs. | The kit text | Text | Up to 8000 characters | A longer prompt gives more detail and uses more context. | Reset to the kit text removes your change. | The change takes effect at once. |
| Watch worker cap | `watch.maxWorkers` | The most workers that run at the same time while a watch runs. A blank value uses the day value. | Blank (the day value) | Workers | 1 to 40, or blank | A higher cap runs more workers overnight and uses more usage limit and CPU. | A lower cap runs fewer workers overnight. | Select Save in the group. The change takes effect at once. |
| Watch worker cap by lane | `watch.maxWorkersByLane` | The most workers per lane while a watch runs. The lanes are Unmetered, Codex, Claude, and OpenCode Go. A blank lane uses the day value. | All lanes blank | Workers | 1 to 40 for each lane, or blank | A higher cap lets that lane run more workers. | A lower cap protects the usage limit of that lane. | Select Save in the group. The change takes effect at once. |
| Quiet hours default | `watch.quietHours` | The default for a new watch: quiet hours on or off. Quiet hours queue desktop notifications until the watch ends. They also delay the release of an expired manual suite lock or lease. | Off | Switch | On or off | Turning it on gives a new watch quiet hours. A watch that you start can override it. | Turning it off gives a new watch normal desktop notifications. | Select Save in the group. The change takes effect at once. |

#### Capacity and handover

- Controls: The number of working agents, idle sharing, the project lead reserve, and automatic handover of a project lead to a successor. These controls are on the Allocation page.
- Effect: Workers, usage limits, and handover. The maximum working agents is a hard cap for worker start. Handover moves a project lead to a fresh successor before a usage limit or context limit.
- Safe to change: Change the maximum working agents with care: a high value adds load. Leave automatic handover off until you have read the handover guide.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Maximum working agents | `maxWorkers` | The most agents that work at the same time. The worker command enforces it for all projects together. | 8 | Agents | 1 to 64 | A higher value runs more work at once and adds CPU and usage limit use. | A lower value queues new workers until a slot is free. | Select Apply policy. The change takes effect at the next engine tick. |
| Borrow idle shares | `borrowIdle` | Lets a busy project use the unused share of an idle project. | On | Switch | On or off | Turning it on uses the whole capacity when some projects are idle. | Turning it off keeps each project inside its own share. | Select Apply policy. The change takes effect at the next engine tick. |
| Idle after minutes | `idleMinutes` | The time without activity after which a project counts as idle and lends its share. | 15 | Minutes | 0 to 1440 | A project stays active longer before it lends its share. | A project lends its share sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Project lead reserve | `reservePercent` | The percent of a provider usage limit that is kept for project leads. Workers cannot use it. | 15 | Percent of the usage limit | 0 to 80 | A higher reserve keeps project leads running longer when usage limit is short. Workers get less. | A lower reserve gives workers more usage limit. A project lead can run out first. | Select Apply policy. The change takes effect at the next engine tick. |
| Handover lead minutes | `handoffLeadMinutes` | A usage limit window is at risk when it will run out within this many minutes. Herdr Boss then recommends a handover. | 180 | Minutes | 0 to 10080 | A higher value recommends a handover earlier. | A lower value recommends a handover later. | Select Apply policy. The change takes effect at the next engine tick. |
| Automatic handover | `autoHandover` | Lets Herdr Boss prepare and activate a successor project lead without the Owner. It never runs for the Boss. It never runs for a project that no longer works or that is paused or stood down. It never runs for a successor model that is weaker than the source. After activation, Herdr Boss closes the old pane when the successor has answered and the old pane is idle. | Off | Switch | On or off | Turning it on moves a project lead to a successor at the reserve limit or the context limit. | Turning it off means only the Owner starts a handover. | Select Apply policy. The change takes effect at the next engine tick. |
| Activate at usage limit used % | `autoHandoverPercent` | The usage limit level at which the prepared successor takes control. Boss prepares the successor at the reserve limit. The source stays in control until the successor reports ready and the usage limit reaches this level. | 98 | Percent of the usage limit | 90 to 100 | A higher value keeps the source in control for longer. | A lower value hands over sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Successor cooldown hours | `handoff.autoCooldownHours` | The time that automatic handover skips an agent app and model after its automatic successor expired, was cancelled, never became ready, or stayed in preparing. The stored reason of the choice names each skipped kind. A successor that was ready and went unused does not count. A successor of a weaker or unranked model tier than the source is never chosen, whatever this value is. | 6 | Hours | 1 to 72 | A higher value keeps a failed kind out of the choice for longer. | A lower value lets a failed kind return sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Hand over at context tokens | `autoHandoverContextTokens` | The context size above which a Claude project lead gets a fresh successor at a task boundary. The successor starts from the project memory file with the same model. Herdr Boss activates it when the project lead pane is not working. It reads the context size only for Claude. It compares a token count with this value, not a percent of the model window. A pane that it sees for the first time waits for its next boundary. | 300000 | Tokens | 50000 to 2000000 | A higher value keeps a long context for longer. | A lower value hands over sooner and keeps the context short. | Select Apply policy. The change takes effect at the next engine tick. |
| Force handover at context tokens | `autoHandoverForceContextTokens` | The context size above which Herdr Boss asks a Claude project lead to update and commit project memory before it prepares a fresh successor. It prepares the successor after the commit or after 20 minutes. After a timeout, it cannot activate until it verifies a later memory commit. The successor uses the same model. Herdr Boss activates it when the project lead pane is idle or done. This value must be higher than Hand over at context tokens. | 400000 | Tokens | 50000 to 2000000 | A higher value gives the source more time before a forced handover. | A lower value asks for a memory update sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Automatic Claude goal command | `goals.autoCommand` | Lets Herdr Boss send /goal automatically when it gives an Owner goal to a Claude agent. When this is off, Herdr Boss sends the goal as plain text. Manual herdr-boss goal set still sends /goal. | Off | Switch | On or off | Turning it on lets a Claude agent set the Owner goal as an active goal. | Turning it off sends the Owner goal as plain text. | Select Apply policy. The change takes effect at the next engine tick. |
| Allow Opus without --force | `opus.allowWithoutForce` | Lets `herdr-boss worker start` start a Claude Opus worker without `--force --reason TEXT`. Turn it on only when the Owner approves Opus for workers. Otherwise each forced start needs `--force --reason TEXT`. The Boss gets an alert for each Opus start. A refused start names this setting. | Off | Switch | On or off | Turning it on lets each Opus start pass while the number of running Opus workers is below the limit. | Turning it off means each Opus start needs `--force --reason TEXT` and the Owner's approval. | Select Apply policy. The change takes effect at the next engine tick. |
| Running Opus workers at most | `opus.maxConcurrent` | The most Opus workers that can run at the same time when Opus starts without `--force`. A start at the limit is refused and names this setting. `--force --reason TEXT` skips the limit. | 2 | Workers | 1 to 8 | A higher value allows more Opus workers at the same time and uses the Opus usage limit faster. | A lower value refuses an Opus start sooner. Running Opus workers continue. | Select Apply policy. The change takes effect at the next engine tick. |
| Default project lead goal | `defaultOrchestratorGoal` | The goal text for a new project lead that has no goal. A handover copies the goal of the old project lead to the successor: the published status goal, else the last /goal command of its session. Claude gets plain text by default. Turn on Automatic Claude goal command to send /goal after activation. The default text ends with a rule: a running worker, a gate, a push, or a lock wait is progress. The rule stops the goal check from looping while the project lead waits for a report. The Set goal dialog and `herdr-boss goal set` accept at most 2000 characters. The field grows as you type. It scrolls after it reaches half of the screen height. | A standing goal text | Text | One line of at most 4000 characters, or empty for no default | A longer text gives more direction and uses more context. | An empty text gives a new project lead no default goal. | Select Apply policy. The change takes effect at the next engine tick. |
| Boss rules | `bossRules` | The standing rules that Herdr Boss gives to every successor in the handover bootstrap prompt. The text is the Boss rules section of that prompt. Each prepared successor reads the section, so the Boss does not send the rules again. The other two generated sections are the pane map and the open items. The open items section keeps only the memory lines of the last 48 hours whose text names the Owner or the Boss. Every value in the sections is rendered on one line, so a value cannot forge a section heading. An empty text leaves the section out. The field grows as you type. It scrolls after it reaches half of the screen height. | The standing rules of the fleet | Text | One line of at most 1200 characters, or empty for no rules | A longer text gives the successor more rules and uses more of the prompt. | A shorter text leaves out the rules that you remove, and a text over 1200 characters is refused. | Select Apply policy. The change takes effect at the next engine tick. |
| Project lead succession | `succession.ladder` | The ordered list of kind, model, and effort choices that automatic handover tries. The selectors offer choices allowed by policy and current usage limits. A saved choice that is no longer allowed stays visible with an unavailable mark. Automatic handover skips the current provider and global or project exclusions. | The list in policy.json | List of choices | Up to 20 choices | A longer list gives automatic handover more successors to try. | A shorter list can leave no successor. A choice outside the list is never selected automatically. | Select Apply policy. The change takes effect at the next engine tick. |
| Workspace projects | `workspace.exclusion` | Decides which live workspaces count as projects. Clear a workspace switch to include it as a project. The Boss workspace stays excluded while its pane is labelled boss. | Every workspace is a project, except the Boss workspace | Switch for each workspace | On or off | Switching a workspace on removes it from the projects and from the shares. | Switching a workspace off makes it a project that takes part in the shares. | Select Apply policy. The change takes effect at the next engine tick. |
| Project shares | `project.shares` | The share of the working agents for each project. Drag a boundary in the bar: only the projects to its right rebalance. The labels show the set share and the effective slots. Shares are advisory. The worker command enforces the global cap. Apply policy asks for a confirmation when 3 or more shares change, and asks again when the total is not 100. | The shares in policy.json | Percent of the working agents | 0 to 100, and all shares add up to 100 or less | A larger share gives the project more slots when the machine is busy. | A smaller share gives the project fewer slots. It can borrow idle shares of others when Borrow idle shares is on. | Select Apply policy. The change takes effect at the next engine tick. |

#### Resource pools

- Controls: The ports of a pool, the split between projects, the wait default, and the client values by port. The idle time decides when Herdr Boss reclaims a lease. These controls are in the pools editor on the Settings page and on the Allocation page.
- Effect: Projects and workers that lease a port. A port that has no listener for the idle time goes back to the pool.
- Safe to change: Safe to change. A save never drops a port that a holder uses. A client value is stored in the private config file only.
- Restart: No restart. A save takes effect at once.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ports of a pool | `pool.ports` | The ports or items of the pool. Enter single ports, ranges such as 8000-8009, or a list of both. | None | Ports | 1024 to 65535, at most 100 ports, no duplicate, not the dashboard port or a browser port | A new range adds ports at once. No code change is needed. | A port that a holder uses stays in the pool. Release the lease first, or wait for the idle time. | The change takes effect at once. |
| Idle minutes of a pool | `pool.idleMinutes` | The minutes that a leased port can have no listener before Herdr Boss reclaims the lease. A holder gets one notice. | 20 | Minutes | 1 to 240 | A longer time gives a holder more time to start a server. | A shorter time frees unused ports sooner. | The change takes effect at once. |
| Wait for a free item | `pool.waitSeconds` | The seconds that lease acquire waits for a free item when the pool is full. The command --wait option overrides it. | 0 | Seconds | 0 to 3600 | A longer wait lets a caller queue for a free port. The queue serves callers in order. | A shorter wait fails sooner when no item is free. Zero means no wait. | The change takes effect at once. |
| Values by port | `pool.portEnv` | An environment variable with a value for each port range, for example a client ID. A lease hands the worker the value that matches its port. | None | Text | Up to 200 characters, no whitespace | Add a row to hand a value to the ports of a range. | Enter an empty value to clear a stored value. A port without a value gets no variable. | The change takes effect at once. |

#### Token prices (Advanced)

- Controls: The USD price per million tokens of each model. A model with no published price shows empty fields. It stays unpriced until you set its input and output.
- Effect: Only the cost figures on the Analytics page. No price changes how workers run.
- Safe to change: Safe to change. Reset to defaults removes all your changes.
- Restart: No restart. Select Save prices.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Input price | `prices.input` | The price of input tokens. The cost that Herdr Boss shows is an API-price equivalent, because a subscription is not billed per token. | The catalog price | USD per million tokens | 0 to 1000, or blank for the default | A higher price raises the cost figures. | A lower price lowers the cost figures. | The change takes effect at once. |
| Output price | `prices.output` | The price of output tokens. | The catalog price | USD per million tokens | 0 to 1000, or blank for the default | A higher price raises the cost figures. | A lower price lowers the cost figures. | The change takes effect at once. |
| Cache read price | `prices.cacheRead` | The price of tokens that the provider reads from its cache. | The catalog price | USD per million tokens | 0 to 1000, or blank for the default | A higher price raises the cost figures. | A lower price lowers the cost figures. | The change takes effect at once. |
| Cache write price, 5 minutes | `prices.cacheWrite` | The price of tokens that the provider writes to a cache with a 5-minute life. | The catalog price | USD per million tokens | 0 to 1000, or blank for the default | A higher price raises the cost figures. | A lower price lowers the cost figures. | The change takes effect at once. |
| Cache write price, 1 hour | `prices.cacheWrite1h` | The price of tokens that the provider writes to a cache with a 1-hour life. | The catalog price | USD per million tokens | 0 to 1000, or blank for the default | A higher price raises the cost figures. | A lower price lowers the cost figures. | The change takes effect at once. |

#### Avatars (Advanced)

- Controls: The image of the Boss and of each project in the Chat, the Mailbox, and the Agents chart.
- Effect: Only how the pages look.
- Safe to change: Safe to change.
- Restart: No restart. An upload or a reset takes effect at once.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Avatar image and reset | `avatar.upload` | Sets your own image for the Boss or for a project. The Reset button removes your image and returns to the generated avatar. | A generated avatar | Image file | PNG, JPEG, or WebP, at most 512 KB. Each row holds the avatar of the Boss or of a project. Herdr Boss keeps no other format | Not applicable. | Not applicable. | The change takes effect at once. |

#### Service settings (Advanced)

- Controls: The values that the service uses: collection intervals, worker clean-up, browser clean-up, release repositories, and the network address. Each row shows its source.
- Effect: Workers, notices, browsers, release approval, and the machine. A value here changes when a worker pane closes, a done worker is reported, or an idle browser closes.
- Safe to change: A row with an input is safe to change. A row without an input is read-only. Change it in config.json.
- Restart: The push row needs a service restart. Other rows with inputs apply after Save. A read-only row needs a service restart.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Worktree root | `worktreeRoot` | The parent folder for new worker worktrees. A project worktreeRoot in .herdr-boss.json takes precedence. Existing worktrees stay in place. | ~/Projects/.herdr-wt | Path | An absolute path or a path that starts with ~. No .. segment, not / | Set another folder for new worker worktrees. Run herdr-boss harness sync to check agent app access. | The value does not move or delete existing worktrees. | Select Save in the group. The change takes effect at once. |
| Project root | `projectRoot` | The suggested group folder for New project in the dashboard. An entered group or exact path takes precedence. | ~/Projects | Path | An absolute path or a path that starts with ~. No .. segment, not / | Set another suggested group folder. The CLI still requires --group or --path. | The value does not move or delete existing projects. | Select Save in the group. The change takes effect at once. |
| Stale status minutes | `staleStatusMinutes` | The age after which a published project status is stale while workers run or new commits land. | 120 | Minutes | 5 to 1440 | A higher value gives the stale notice later. | A lower value gives the stale notice sooner. | Select Save in the group. The change takes effect at once. |
| Stale text minutes | `staleTextMinutes` | The time that a published phase or summary can keep the same text before the project lead gets a stale text notice. The project lead must rewrite the text at each publish. | 360 | Minutes | 5 to 10080 | A higher value sends the stale text notice later. | A lower value sends the stale text notice sooner. | Select Save in the group. The change takes effect at once. |
| Stale idle worker minutes | `workers.staleIdleMinutes` | The idle time after which Herdr Boss reports a worker as stale. The wait command uses it as its stall time. | 120 | Minutes | 5 to 1440 | A higher value waits longer before it reports an idle worker. | A lower value reports an idle worker sooner. | Select Save in the group. The change takes effect at once. |
| Worker pane close delay | `workers.paneCloseDelayMinutes` | The time after collection before Herdr Boss closes the worker pane. The service closes it after the command exits. | 2 | Minutes | 0 to 60 | A higher value leaves the pane open longer. | A lower value closes the pane sooner. Zero closes it on the next service tick. | Select Save in the group. The change takes effect at once. |
| Prune merged worktree at collect | `worktrees.pruneAtCollect` | When on, worker collect archives the reports. It removes a worker worktree and branch only when the branch is merged. The generated kit file must not be staged. It must match the current kit or a version in the base branch history. The worktree must have no other dirty path, live pane, or blocking process. | On | Switch | On or off | Turning it on removes safe, merged worktrees after collection. | Turning it off keeps worktrees for herdr-boss worktree prune. | Select Save in the group. The change takes effect at once. |
| Minimum free worktree space | `worktrees.minFreeGb` | The minimum free space in GB required on both the worker worktree volume and the Herdr Boss data-directory volume. Worker start refuses when either volume is below this value unless you use --force with --reason TEXT. | 8 | GB | 1 to 500 | A higher value refuses worker starts sooner when free space falls. | A lower value lets worker starts use the disk longer. | Select Save in the group. The change takes effect at once. |
| Uncollected worker notice minutes | `workers.uncollectedNoticeMinutes` | The time that a worker can stay done without collection before the service tells its project lead. | 30 | Minutes | 1 to 1440 | A higher value sends the notice later. | A lower value sends the notice sooner. | Select Save in the group. The change takes effect at once. |
| Auto-close finished review workers | `workers.autoCloseReview` | Closes the pane of a finished review worker ten minutes after it records its report. A review worker writes a report but no product change, so it is not collected. | On | Switch | On or off | Turning it on closes a finished review pane without a collection. | Turning it off leaves a finished review pane open. | Select Save in the group. The change takes effect at once. |
| Lease grace minutes | `workers.leaseGraceMinutes` | The time that a lease of a pool with an idle rule can have no bound process and no listener. The service reclaims the lease after this time, also when the idle time of the pool is longer. A lease of a pool without an idle rule is not reclaimed by this time. A worker gives back its leases at collect and at park in any pool. | 30 | Minutes | 1 to 1440 | A higher value lets an unused lease stay longer. | A lower value gives an unused lease back sooner. | Select Save in the group. The change takes effect at once. |
| Stop orphan browser daemons | `browsers.reapOrphanDaemons` | Lets Herdr Boss stop an agent-browser daemon that has no parent, no children, and the minimum age. It never stops a browser that it did not start. | On | Switch | On or off | Turning it on frees memory from forgotten daemons. | Turning it off leaves orphan daemons running. | Select Save in the group. The change takes effect at once. |
| Orphan daemon minimum age | `browsers.orphanDaemonMinAgeSeconds` | The age that an orphan browser daemon must reach before Herdr Boss stops it. | 7200 | Seconds | 60 to 86400 | A higher value spares a young daemon for longer. | A lower value stops orphans sooner and risks a daemon that is between two uses. | Select Save in the group. The change takes effect at once. |
| Stale owned browser minutes | `browsers.staleOwnedMinutes` | The idle time of the agent after which Herdr Boss reports its browser as stale. | 30 | Minutes | 5 to 1440 | A higher value reports a stale browser later. | A lower value reports a stale browser sooner. | Select Save in the group. The change takes effect at once. |
| Project browser idle close minutes | `browser.idleCloseMinutes` | The time with no other CDP client or open agent tab before Herdr Boss closes a project browser that it started. | 20 | Minutes | 0 to 1440 | A higher value leaves an unused browser open longer. | A lower value closes an unused browser sooner. Zero turns this rule off. | Select Save in the group. The change takes effect at once. |
| Allow visible project browsers | `browser.allowVisible` | Allows Herdr Boss to start a project browser with a visible window. It is off by default. New project browsers stay headless while this switch is off. | Off | Switch | On or off | Turning it on allows `browser request --visible` and `browser restart --visible`. | Turning it off refuses visible browser launches and restarts. | Select Save in the group. The change takes effect at once. |
| Show tenant hosts | `browser.showTenantHosts` | Shows full outside hosts in project browser URLs on this dashboard for an Owner page that sends a same-origin browser signal. A process on this machine can forge the headers. Use this setting only on the Owner's own machine. It does not change masking in agent, CLI, message, report, status, log, or published output. | Off | Switch | On or off | Turn it on to show the real host in browser URLs on the dashboard. | Turn it off to mask outside hosts in browser URLs. | Select Save in the group. The change takes effect at once. |
| Chrome path | `chromePath` | The Chrome executable that Herdr Boss starts for a project browser. A running browser keeps its executable until it restarts. | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | Path | An absolute path or a path that starts with ~. No .. segment, not / | Set the path of another Chrome or Chromium, for example the Linux path of a container. | The profile folder of each project stays the same. A saved login stays in the profile. | Select Save in the group. The change takes effect at once. |
| Sweep code-sign clones | `browsers.sweepCodeSignClones` | Lets Herdr Boss delete old code-sign clones of Chrome that no running Chrome process owns. | On | Switch | On or off | Turning it on frees disk space. | Turning it off leaves the clones on disk. | Select Save in the group. The change takes effect at once. |
| Claude usage helper in factories | `factories.claudeUsageHelper` | Lets a factory container show the Claude usage limit. The helper is the command herdr-boss claude-statusline. It is the status line of the factory user in Claude Code. It writes the two usage windows and the time to a private file in the factory data folder. It writes no other field of the status line input. The setting never changes the Claude settings on this Mac. The switch is read in the data folder of the factory. Set it in the Settings or the config.json of that factory. The value on this Mac does not reach a factory. | On | Switch | On or off | Turning it on shows the Claude usage limit of a factory while a Claude session runs there. | Turning it off removes the status line entry of the factory user. The Claude usage limit of a factory then shows as unknown. | Select Save in the group. Each factory container applies the change at its next start. |
| Tick seconds | `tickSeconds` | The time between two collection passes of the engine. | 30 | Seconds | A whole number of 5 to 300 | A higher value gives slower updates and less load. | A lower value gives faster updates and more load. | Select Save in the group. The change takes effect at once. |
| Usage limit seconds | `quotaSeconds` | The time between two reads of the provider usage limits. | 300 | Seconds | A whole number of 30 to 3600 | A higher value reads usage limits less often. | A lower value reads usage limits more often and calls the providers more. | Select Save in the group. The change takes effect at once. |
| Push prompts | `push` | Lets the service send prompts to project lead panes. Notices to the Owner are always sent. The environment variable HERDR_BOSS_PUSH=0 overrides the saved value. Restart the service after a change. | On | Switch | On or off | Turning it on lets the service prompt the project leads. | Turning it off stops all prompts to project lead panes. | Select Save in the group. Restart the service for the change to take effect. |
| Notice cooldown (legacy) | `alertCooldownSeconds` | An unused legacy value. Set the notice cooldown in the Machine group. | 21600 (6 hours) | Seconds | Read-only | No notice reads this value. | No notice reads this value. | Change it in config.json. Restart the service. |
| Provider kinds | `providerKinds` | Maps each usage limit provider to the agent kinds that use it. | claude to claude, codex to codex, opencodego to opencode and pi | Object of lists | Kind names that exist | Not applicable. | A wrong map counts a kind against the wrong usage limit. | Change it in config.json. Restart the service. |
| Project lead label | `orchestratorLabel` | The pane label that marks the project lead of a project. | orch | Text | One pane label | Not applicable. | A wrong label makes Herdr Boss miss the project lead panes. | Change it in config.json. Restart the service. |
| Port | `port` | The port of the dashboard and the API. | 4477 | TCP port | 1 to 65535 | Not applicable. | A change also changes the address that other tools use. | Change it in config.json. Restart the service. |
| Host | `host` | The network address that the server listens on. 0.0.0.0 allows remote access with the access token. 127.0.0.1 allows only this machine. | 0.0.0.0 | Address | An IP address of this machine | Not applicable. | Set 127.0.0.1 to turn remote access off. | Change it in config.json. Restart the service. |
| Allowed hosts | `allowedHosts` | Host names that the server accepts in addition to localhost, this machine, and names that end in .ts.net. Enter a name such as factory-two, *.localhost for each name below localhost, or *.example.test for each name below example.test. A wildcard needs two labels after *., except *.localhost. A port, an address, and a bare * are not allowed. | Empty list | List of host names | Up to 50 names | A request that names a listed host passes the host check. A request from another machine still needs the access token. | Remove a name to refuse requests that use it. | Select Save in the group. The change takes effect at once. |
| Log size limit | `log.maxMegabytes` | The size at which the server log file service.log rotates. The server also writes the log to standard output. | 10 | Megabytes | 1 to 1000 | The log file holds more history and uses more disk space. | The log file rotates sooner and holds less history. | Select Save in the group. The change takes effect at once. |
| Old log files | `log.keepFiles` | The number of rotated log files that Herdr Boss keeps, as service.log.1 and service.log.2. | 2 | Files | 1 to 2 | More history stays on disk. | Herdr Boss deletes the older file at the next rotation. | Select Save in the group. The change takes effect at once. |
| Allowed release repositories | `releases.repos` | Limits release request and release publish to the repositories in this list. Each row gives the GitHub repository name, project slug, and release kind. The Owner must approve each request in the Mailbox before publish. | Empty list | List of repositories | Unique GitHub repository names with a project slug and release kind | Add a repository when a project lead needs to request a release. | Remove a repository to refuse its release requests and publications. | Select Save in the group. The change takes effect at once. |

#### Usage limit plan (Advanced)

- Controls: The Codex reset credit plan, Owner prompts, expiry notices, and usage curve.
- Effect: Usage limit plan guidance, Mailbox items, and expiry notices. It does not change worker starts or apply a credit.
- Safe to change: Safe to change. Herdr Boss shows estimates and never applies a reset credit.
- Restart: No restart. Select Save in Usage limit plan settings.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Burst pace | `quotaPlan.burstPace` | The points per hour that a burst may use before the plan schedules a reset credit. | 1 | Percentage points per hour | 0.1 to 10 | A higher pace reaches the apply threshold sooner when demand stays the same. | A lower pace reaches the apply threshold later. | Select Save in the group. The change takes effect at once. |
| Credit apply threshold | `quotaPlan.applyThreshold` | The used percent at which the plan may schedule a reset credit and ask the Owner to apply it. | 95 | Percent used | 50 to 100 | A higher threshold saves more usage limit before the planned reset. | A lower threshold schedules the reset sooner. | Select Save in the group. The change takes effect at once. |
| Reserve margin | `quotaPlan.margin` | The percent points that the plan keeps below full usage limit use. | 0 | Percentage points | 0 to 50 | A higher margin lowers the effective credit apply threshold. | A lower margin permits a higher apply threshold. | Select Save in the group. The change takes effect at once. |
| Planning horizon | `quotaPlan.horizon` | The time at which the plan stops. Use the last credit expiry or enter an ISO time. | last-expiry | End time | last-expiry or an ISO time | A later time includes more planned usage limit use. | An earlier time limits the plan to a shorter period. | Select Save in the group. The change takes effect at once. |
| Plan guidance tolerance | `quotaPlan.tolerance` | The points above the planned curve that keep Codex out of hold guidance. | 5 | Percentage points | 0 to 50 | A higher tolerance lets actual use stay above the curve before the lane says hold. | A lower tolerance makes the lane say hold after a smaller gap. | Select Save in the group. The change takes effect at once. |
| Hold margin | `quotaPlan.holdMargin` | The points that the hold state adds to the plan guidance tolerance, and subtracts from it to leave the hold. | 1 | Percentage points | 0 to 50 | A higher margin makes the hold enter later and leave later. | A lower margin makes the hold follow the tolerance more closely. | Select Save in the group. The change takes effect at once. |
| Plan mode | `quotaPlan.planMode` | How the planned curve guides the Codex lane. Paced holds the lane when use is ahead of the curve by more than the tolerance. Burst gives the curve as advice only and keeps the lane at Use now. | paced | Mode | paced or burst | Burst stops the hold guidance. The lane shows the points ahead of the plan and the time at which the recent burn reaches the credit threshold. | Paced enforces the curve in the guidance text and in the lane. Worker start rules do not change. | Select Save in the group. The change takes effect at once. |
| Slow scenario factor | `quotaPlan.slowFactor` | The fraction of the burst pace that the slow scenario uses. | 0.5 | Factor | 0.1 to 1 | A higher factor makes the slow scenario closer to the fast scenario. | A lower factor gives the slow scenario a smaller burst pace. | Select Save in the group. The change takes effect at once. |

#### Analytics (Advanced)

- Controls: Whether the service reads GitHub Actions minutes for registered repositories.
- Effect: Only the GitHub Actions minutes card on the Analytics page.
- Safe to change: Safe to change. Turn it off to stop GitHub API calls.
- Restart: No restart. Select Save in the group.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub Actions minutes | `analytics.actionsMinutes` | Lets the service read Actions run times for registered GitHub repositories. Minutes are estimated from run times. | On | Switch | On or off | The service uses its GitHub token. It skips repositories that the token cannot read. | Turn it off to stop GitHub API calls. The Analytics page hides the card. | Select Save in the group. The change takes effect at once. |

#### Project register (Advanced)

- Controls: The open project cap, auto-park idle time, and GitHub issue triage for the local project register.
- Effect: The Projects page and project lifecycle. Auto-park closes idle projects after the park checks. Triage reads issues with the selected label and asks before it opens a parked project.
- Safe to change: Auto-park starts at 24 hours. Set it to 0 to turn it off. Triage starts off. Turn it on only when the register has repository sources for projects on this factory.
- Restart: No restart. Select Save in the group.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Open project cap | `register.cap` | Limits the number of open projects. The open button refuses a new project when the cap is full. | 3 | Projects | 1 to 20 | A higher cap lets more projects stay open at once. | A lower cap keeps the Projects page smaller. | Select Save in the group. The change takes effect at once. |
| Pinned projects count toward cap | `register.capCountsPinned` | Counts pinned projects when the service checks the open project cap. | Off | Switch | On or off | Turning it on uses a cap slot for each pinned project. | Turning it off keeps pinned projects outside the cap. | Select Save in the group. The change takes effect at once. |
| Auto-park idle projects | `register.autoParkHours` | After 24 hours without activity, parks an open, unpinned project. The setting can change the idle time. Auto-park runs the project park checks first. | 24 | Hours | 0 to 8760; 0 turns auto-park off | A higher value keeps projects open for longer. | A lower value parks idle projects sooner. A project with a running worker, an unmerged worker branch, or a pending Mailbox item stays open. | Select Save in the group. The change takes effect at once. |
| Auto-open from triage | `register.triage.enabled` | Lets the service read ready issues for parked projects and create Mailbox proposals to open them. | Off | Switch | On or off | Turning it on lets GitHub issues create one Mailbox proposal when an open slot is free. | Turning it off stops issue reads and new proposals. Existing Mailbox items stay available. | Select Save in the group. The change takes effect at once. |
| Triage label | `register.triage.label` | The default GitHub issue label for project sources without a label override. | ready-for-agent | GitHub label | 1 to 100 characters without control characters | Use the label that the Owner applies to ready issues. A project can set its own label. | Changing this label affects only project sources that use the default. | Select Save in the group. The change takes effect at once. |
| Triage poll minutes | `register.triage.pollMinutes` | The time between reads of GitHub issues for parked projects. | 30 | Minutes | 5 to 1440 | A higher value reads GitHub less often. | A lower value finds ready issues sooner and makes more GitHub calls. | Select Save in the group. The change takes effect at once. |

#### Agent app readiness (Advanced)

- Controls: A read-only table that shows if each agent app entry that orchestration needs is present. A project switch controls Codex access to each registered project's common Git directory.
- Effect: The table only reports. The switch changes Codex writable roots and the Git pin checks that push and suite use.
- Safe to change: Nothing to change in the table. Turn the switch off to remove its root on the next herdr-boss harness sync.
- Restart: No restart for the service. Select Apply policy. Run herdr-boss harness sync, then restart Codex.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Readiness table | `harness.readiness` | Shows for each agent app entry if it is ok, missing, or bad. The table shows no path and no value. | Not applicable | Table | Read-only | Not applicable. | Not applicable. | The change takes effect at once. |
| Codex shared Git | `projects.SLUG.codexSharedGit` | Adds the project's common Git directory to Codex writable roots. Codex can write hooks, config, refs, objects, HEAD, info, and worktrees. Push and suite refuse changed pins. | On; off for HerdrBoss until live verification | Switch for each registered project in Advanced | On or off | Turning it on lets Codex workers write shared Git metadata. Pin checks can stop push and suite. | Turning it off omits its Git root and removes that exact entry on herdr-boss harness sync. | Select Apply policy. The change takes effect at the next engine tick. |

<!-- settings-reference:end -->

## Linux machine samples

On Linux, the collector reads `/proc/meminfo`, `/proc/loadavg`, and `/proc/pressure`. It finds the process group from `/proc/self/cgroup` and its cgroup v2 mount from `/proc/self/mountinfo`. CPU capacity uses the smallest CPU quota, effective CPU set, or host CPU count. A quota can give a fraction of one CPU. Memory capacity and free memory use the cgroup memory limit and current use. The collector subtracts `inactive_file` and `active_file` from `memory.stat` from the current use, never below 0. The CPU count has at most 2 decimals. The collector does not read cgroup v1 hosts and uses host values on them. Visible parent limits also apply. Swap uses a finite cgroup swap limit and current use when available. Unlimited or unreadable limits keep the host values. A known memory or swap limit with unreadable current use gives an unknown use value.

The collector measures cgroup CPU use between two reads of `cpu.stat`. The first read, a counter reset, or an unreadable counter uses the process CPU sample. Load averages are host values. The guard compares them with the effective CPU capacity. Use the existing Machine and Locks settings to change the guard thresholds. No new setting is required.

`tick --json` and `/api/state` include Linux pressure under `machine.pressure`. Each resource has `some` and `full` rows when available. Each row holds `avg10`, `avg60`, and `avg300` stalled-time percentages, and `total` stalled microseconds. The collector uses cgroup pressure files before host pressure files. A missing row is `null`. Pressure is information only. It adds no guard threshold.

## Workers

### `worker start NAME`

Create a branch and worktree, write the brief, add a worker pane, start the agent, and send the brief. Worker panes go in worker tabs in the verified caller workspace. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes.

After it starts a Codex agent, `worker start` checks the pane for a hook review dialog for up to 20 seconds. If Codex needs hook review, the command closes the pane and records a blocked run. The doctor and bulletin show the Codex lane block. Run `codex` once in a terminal and review the changed hook. A later Codex start without the dialog clears the block. The block expires after six hours.

OpenCode starts share one machine-wide start lock. The lock stays held until the brief is delivered or startup fails. Another OpenCode start waits up to 300 seconds, including the time in the mutation guard. The lock checks the owner PID and process start time. If the process start time is unavailable, the lock uses the owner PID, lock token, and owner file modification time. A signal-0 check tests if the PID is alive. A permission error keeps the PID alive for this check. The fallback keeps a live owner record for up to 300 seconds from its modification time. A waiting process does not update this time. An unreadable process start time does not prove that the owner is dead. A readable, matching process start time keeps a live owner record without this age limit. The lock replaces a record with a dead PID or a different process start time. It also replaces an expired fallback record or an unreadable or invalid owner file. A new owner stores a null process start time when the value is unavailable. Release removes the owner file only when both its PID and token match the releasing process. An OpenCode 1.x launch waits up to 45 seconds for an idle or done TUI with interactive input. Then it sends the brief. If that TUI exits or brief delivery fails, startup can relaunch it twice in the same pane. It does not relaunch a working, blocked, unknown, or reassigned agent. An OpenCode 2.x launch sends the brief in the `run` message. The run record shows `startAttempts`. A dry run takes no start lock.

Before it starts an OpenCode worker, `worker start` reads `opencode --version`, `opencode --help`, and `opencode run --help`. It records the installed version in the worker run record. OpenCode 1.x keeps the interactive TUI path and its existing launch flags. OpenCode 2.x runs `opencode run` in the Herdr pane. It passes the selected model with `--model` and the `worker` agent when `run` accepts an agent flag. It sends `Read .worker/brief.md in your working directory and execute it.` as the run message. When `run` has no agent flag, `worker start` writes `opencode.json` with the selected model and the `worker` default agent only if the file does not exist. If the file exists, it keeps the file and passes the model with `--model`. It adds a new config file to Git exclude. If `opencode --version` gives no version, `worker start` uses the legacy 1.x TUI flags. When the help does not list `opencode run --model`, `worker start` stops before it creates the worktree. The error names the unsupported flag.

After a final start failure, startup closes the failed pane only when it can confirm ownership and a safe agent state. It archives the brief, available reports, and run record in `.orchestration/reports/<worker name>/` in the main checkout. It keeps the run record with state `failed` and a reason after the archive succeeds. It removes the worktree and branch only when the worktree has no changes and no commits beyond the start base. You can then reuse the worker name. The error states why it kept a pane, worktree, or branch. Inspect a retained pane before you retry.

`worker start` puts a new worktree in `<worktreeRoot>/<repo>/<name>`. The service default is `~/Projects/.herdr-wt`. It creates the parent folders when they are missing. Set `worktreeRoot` and `worktreeName` in `.herdr-boss.json` to use another place for one project. The dry-run plan shows the worktree path.

When the main checkout has `node_modules` and a detected root lock file, `worker start` compares the lock file hashes in the main checkout and new worktree. On macOS, equal hashes let it clone `node_modules` with `cp -cR`. It prints `Dependencies: clone was used.` A changed lock file or a failed clone runs the configured setup command, or `npm ci` when no install command is configured. It prints `Dependencies: install was used.` The clone reads from the main checkout and writes only to the new worktree. A project without `node_modules` keeps its current setup behavior.

Put task input files in `.orchestration/state/inputs/<worker name>/` in the main checkout. `worker start` copies regular files from that folder into `.worker/inputs/` and keeps their relative paths. It lists the copied paths in the brief. The folder can be empty or missing. Input files and `--copy` files share a 200 MB total limit.

A read-only worker with `--base BRANCH` also copies the diff of `BRANCH` against the project base branch, and the changed file list, into `.worker/inputs/`. `--review-worktree PATH` needs `--read-only`. It copies the tracked uncommitted changes of that worktree, from `HEAD`, and its `git status`. The copy refuses the whole review when a tracked changed path is a dotenv, credential, key, token, secret, or OpenCode config file. The refusal names the path. The paths `.worker/` and `.orchestration/` stay in the review scope and do not refuse the copy. The copied status can list an untracked file name. The copy never includes the content of an untracked file. The brief tells the worker to read those copies and not another worktree. Give `--base` or `--review-worktree`, not both.

`--read-only --review-worktree PATH` selects the worktree review instructions. `--read-only --base BRANCH` selects the branch review instructions only when `BRANCH` differs from the project base branch. A read-only task without a review target is a map or audit. This includes `--base` equal to the project base branch. Its brief says: "Stay inside the stated scope. Do not review other code." The task text does not select a review.

`worker start` also copies `.orchestration/local/` from the main checkout into a new worker worktree. It copies folders and regular files recursively. It skips symbolic links and files that already exist in the worker worktree. It skips files over 5 MB and prints one warning with their count. It skips unreadable files and prints one warning with their count. It keeps file and folder modes. It prints only the count of files copied. It does not copy `.worker/` or `.git/`. When `.orchestration/local/` is missing, it prints nothing about this copy.

`worker start` counts the live panes of each worker tab in `herdr pane list`. It uses the first worker tab in label order that has fewer than 3 panes. It runs `herdr pane split` from the newest pane in that tab. When all worker tabs are full, it runs `herdr tab create` with the lowest free label, for example `--label 'Workers 2'`. The worker then uses the root pane of the new tab. A listed worker tab with 0 live panes counts as free. Herdr has no pane to split in that tab, so `worker start` creates a new tab with the same label.

If the start fails before the agent starts, `worker start` closes only its own pane. It closes a worker tab only when the same start created that tab. The dry-run plan names the chosen tab, its tab ID, and its pane count, or `new tab`.

`worker start` writes the run record with state `starting` before it creates the worktree or starts the harness. It records the pane and shell PID before the harness launch. After the brief is sent, the state changes to `running`. A failed or interrupted start keeps the run record with state `failed` and a reason. Cleanup archives the evidence. It keeps the failed run record even when it removes the clean worktree and branch. A new start can reuse the worker name after safe cleanup. The archived record stays available.

SIGINT and SIGTERM record the interruption before the CLI exits. If cleanup did not finish, inspect the worker pane and worktree before a retry. The CLI keeps their recorded identities. SIGKILL cannot run the interruption handler.

For a Codex worker, `worker start` watches the folder trust prompt for up to 45 seconds. It presses Enter once only when the selected choice is **Trust and continue** and the folder line equals the worker worktree path after realpath. It refuses a parent path, sibling path, different choice, or unknown dialog. It sends no brief until the prompt is ready. If `herdr agent start` reports `agent_not_ready`, the same watch can continue only for the registered Codex worker in the created pane. Project open continues to ask the Owner to answer its trust prompt.

If `worker collect` or `worker stop-own` has no run record, the message names the worker and its expected worktree. It gives the cleanup steps. Run `herdr-boss worktree prune` to list worktrees. Inspect the listed worktree. Run `herdr-boss worktree prune --apply` to remove worktrees that pass the safe checks. The list includes worktrees with failed or missing run records. A dirty worktree, an unmerged branch, a live pane, or a blocking process prevents removal. See `herdr-boss help`.

Set `workerPanesPerTab` in `.herdr-boss.json` to change the pane limit for each worker tab. The value is an integer from 1 to 6. The default is 3.

`worker start` waits for the shell prompt or a stable shell screen. It sets `DISABLE_UPDATE_PROMPT=true` and `DISABLE_AUTO_UPDATE=true` in new panes. If it finds an interactive question, it stops and tells the orchestrator to answer it in a shell once.

`worker start` sets `HERDR_ENV=1` in a new pane when `--kind` is `codex`. The agent in that pane then runs Herdr commands. Panes for the other kinds keep the pane environment that Herdr gives them. The dry-run plan prints the same `herdr pane split` or `herdr tab create` command.

Each worker gets an absolute `TMPDIR` under its worker folder. When the path is longer than 90 characters, `worker start` prints a warning because a Unix socket path can fail. A Codex brief says to run `setopt NO_BG_NICE` before a background command. A Claude brief says to wait for a background command to exit or use a `herdr-boss wait` command.

A Codex tool shell can run under a shared app-server daemon with another environment. For `--kind codex`, `worker start` therefore adds `-c shell_environment_policy.set.<NAME>="<value>"` to the agent launch arguments. It adds one argument for each of `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `TMPDIR`, and `HERDR_WORKTREE`. The pane, tab, and workspace IDs come from the new pane. The socket and binary paths come from the caller environment. A variable with an unknown value is left out. `worker start` refuses a value with a quote, a backslash, or a control character before it creates the worktree. The dry-run plan shows `<pane-id>` for the new pane, and `<tab-id>` when the start creates a tab.

For `--kind codex`, Chrome DevTools MCP uses the project browser. The launch adds `-c 'mcp_servers.chrome-devtools.args=["chrome-devtools-mcp@latest","--browserUrl=http://127.0.0.1:<port>"]'`. The port comes from the browser pool. If the recorded browser is stopped, the launch requests it through the same pool as `browser request`.

If the project has no browser record, the launch disables DevTools MCP. A failed request or an unresponsive browser has the same result. The launch adds `-c mcp_servers.chrome-devtools.enabled=false`. It prints one line. The lookup stops after 15 seconds. These arguments apply only to this launch. They do not change the user config file, `node_repl`, or `cua_repl`.

Codex handover and `project new --start` use the same browser arguments. A worker dry run checks the recorded browser but starts no browser. Its printed browser arguments can change at the actual start.

`worker start` saves the resolved base commit as `baseCommit` in the run record. It also saves the worker's initial `HEAD` as `startCommit` before it starts the agent. With `--no-worktree`, `startCommit` is the current checkout's `HEAD`. Commit and collection use `startCommit`. Commits that were present at start do not count as worker changes. Review the worker, then collect it before you merge its branch. Collection records the run by default. The saved start commit keeps changed paths stable after the merge.

Run `herdr-boss worker start --help` or `-h` to print its complete usage and option list. The command prints the same usage when you omit the worker name. Run `herdr-boss worker collect --help` or `-h`, and `herdr-boss worker commit --help` or `-h`, to print those usage lists. Help exits with code 0.

| Option | Meaning |
|---|---|
| `--kind KIND` | Required. `codex`, `claude`, `opencode`, or `pi`. |
| `--task TEXT` or `--task-file FILE` | Required. The work order for the brief. Write the first line as a plain title: what the worker does and for which ticket. The Agents page shows the first line as the title of the worker. Herdr Boss saves the title as `title` and a masked copy of the brief as `briefCopy` in the run record. The copy keeps its text for 30 days after the run ends. |
| `--allow PATH` | A repository path that the worker may change. Repeat for each path. The worker can write its own `.worker/` folder without this option. |
| `--planner` | Create a planner session for the new worker pane and label the pane `planner`. See [Planner sessions](#planner-sessions). |
| `--read-only` | Allow changes in the worker's own folder only. Use this option when the task changes no repository file. Do not use it with `--allow`. The brief bans `git stash`, `git reset`, and `git checkout` of any path or branch. It names `git show`, `git diff`, and `git log` as the only read commands. |
| `--copy PATH` | Copy a regular repository file into `.worker/inputs/` before the agent starts. Repeat for each file. Keep its repository subdirectories. The 200 MB limit also counts automatic task inputs. |
| `--review-worktree PATH` | Needs `--read-only`. Copy all tracked uncommitted changes (`git diff HEAD`) and `git status` of another Git worktree into `.worker/inputs/` for an uncommitted review target. Do not use it with `--base`. A tracked changed secret or config path refuses the whole copy and names the path. `.worker/` and `.orchestration/` do not refuse the copy. The copied status can list an untracked name, but the copy never includes its content. The brief tells the worker to read the copies and not another worktree. |
| `--lease POOL` | Lease one item of a resource pool for the worker. Repeat for each pool. See [Resource leases](#resource-leases). A task that names `serve:live` automatically leases `serve-ports` when that pool exists and `--lease` does not name it. |
| `--model MODEL` | A model from `herdr-boss models`. Without this option, `worker start` first prefers a model of a lane that is far below its pace (setting `paceRouting`, default on), when the kind can reach two or more lanes. A lane is far below its pace when every live window is more than `paceTolerancePoints` below its expected use. The command prints one line with the reason, for example `routed to opencodego: 33% used against 90% expected`, and records `modelSource: pace` and `modelRoute`. A lane that is ahead of pace or on hold is never chosen. An explicit `--model` never routes. Otherwise `worker start` uses the kind's default model in `kit/models.json`. The `preferredModels` policy does not override it. If that default has an active provider cooldown, worker start chooses the next available model in the same lane. It reports `modelSource: fallback` and records `modelFallback` with the unavailable model, retry time, and reason. An explicit `--model` never falls back. The preferred model is a fallback only when the default cannot start (disabled, or not allowed). The fallback never picks an Opus model without `--force --reason TEXT`. `worker start` always selects the model, so the account default of the harness is never used. It selects the model with flags that the installed harness accepts. OpenCode 2.x uses the `run` subcommand. When `run` has no agent flag, `worker start` writes the model and default agent to `opencode.json` if the file does not exist. If the file exists, it keeps the file and passes the model with `--model`. A kind without a default model fails and asks for `--model`. The name is case-folded, a bracketed suffix such as `[1m]` is dropped, and `opus`, `claude-opus`, and `opus-5-5` mean `claude-opus-5-5`. |
| `--effort EFFORT` | A reasoning effort, where the kind supports it. Without this option, `worker start` uses the kit default effort of the kind. The run record shows `effortSource` (`flag` or `default`) when an effort applies. |
| `--task-id ID` | The task ID from the published status. Herdr Boss saves it as `taskId` in the run record. The project board then shows the task as `doing` while the worker runs. Use letters, digits, `.`, `_`, and `-`, up to 64 characters. Without `--task-id` and `--issue`, `worker start` prints `No --task-id: the project board shows this worker as Unplanned work.` and starts the worker. It suggests one task when at least two lower-case words match the task ID or title, or when the task text contains an exact task ID. With `--task-file`, it matches the file name. A dry run prints the same warning and suggestion. |
| `--issue N` | The issue number. It is an alias of `--task-id` for a numeric task ID. Do not use it with `--task-id`. |
| `--base BRANCH` | The base branch. The default is `baseBranch` in `.herdr-boss.json`. A read-only worker also gets the diff of `BRANCH` against `baseBranch`, and the changed file list, in `.worker/inputs/`. A tracked changed secret or config path refuses the copy. `.worker/` and `.orchestration/` do not refuse. Do not use it with `--review-worktree`. |
| `--orch PANE` | The verified caller pane for reports. If set, it must match `HERDR_PANE_ID`. |
| `--no-worktree` | Use the current checkout. The worker gets `.worker/NAME/` for its brief and reports. |
| `--dry-run` | Print the plan. Change nothing. |
| `--force` | Override quota, capacity, pause, pace, disk-space, and approved model refusals. Give `--reason TEXT` with every forced start. Herdr Boss redacts the reason and writes one row to `action-audit.jsonl`. Start `claude-opus-5-5` only with the Owner's approval or with `--force --reason TEXT`. With neither, `worker start` fails with `claude-opus-5-5 needs the Owner's approval. Ask the Owner to turn on the setting opus.allowWithoutForce.` The refusal also applies to the Opus spellings that `--model` normalizes, and to an Opus fallback from the policy. A refusal of a `claude` worker writes a `worker-opus-refused` event. It happens before a worktree, a pane, or a run record exists. The policy settings `opus.allowWithoutForce` (default off) and `opus.maxConcurrent` (default 2, from 1 to 8) let the Owner allow Opus starts without `--force`. With `opus.allowWithoutForce` on, `worker start` starts Opus while fewer than `opus.maxConcurrent` Opus workers work. At the limit, the start fails with `claude-opus-5-5 is at the limit of N running Opus workers (setting opus.maxConcurrent). Wait for an Opus worker to finish, or raise the setting opus.maxConcurrent.` `--force --reason TEXT` skips the limit. A refusal without the setting names `opus.allowWithoutForce`. An allowed start prints and sends the Boss `Opus worker: NAME runs claude-opus-5-5 (allowed by opus.allowWithoutForce).` A forced Claude Opus start prints and sends the Boss `Opus worker: NAME runs claude-opus-5-5 (forced).` and writes a `worker-opus` event. With `--force`, the run record holds `force: true`. It cannot enable a disabled model. It cannot override the swap refusal. |
| `--reason TEXT` | Required with `--force` or `--force-swap`. Give 1 to 300 characters. Herdr Boss redacts secrets in the reason. This rule covers worker start, project open, handoff plan, and handoff prepare when they override quota, capacity, pause, pace, swap, disk, Opus approval, or avoided-kind refusals. It does not cover `publish`, `browser tab close`, `handoff cancel`, or `hub promote`. |
| `--force-swap` | Override the worker-start swap refusal. Add `--reason TEXT`. |

### Worker worktree disk guard

Before a worker start creates a worktree or pane, it checks free space on the volume that holds the configured worker worktree folder and on the volume that holds the Herdr Boss data directory. The lower free-space value must meet the `worktrees.minFreeGb` floor. This setting defaults to 8 GB and accepts whole numbers from 1 to 500. Change it in Settings under Service. Below the floor, worker start names both volumes, their free space, the floor, the setting, and the cleanup commands `herdr-boss worktree prune --apply` and `herdr-boss worktree disk`. An authorized override needs `--force --reason TEXT`.

A worker start refusal runs the scan. The engine also runs the scan once per hour while a volume stays below the floor. Herdr Boss scans these six roots in this order: the system temporary root, `~/Library/Caches`, `~/Library/Application Support`, `~/.local/share`, `~/Projects`, and the Herdr Boss data directory. It gives each root its own share of the 2.5-second scan budget, so a slow root does not use the later roots' time. It reads directory entries and file metadata. It does not open file contents or follow symbolic links. It records the five largest child directories and the five newest temporary child directories that are at least 50 MiB. A scan or write failure does not break the tick or hide the refusal. Herdr Boss keeps the ten newest diagnoses in `disk-guard-diagnosis.json`, newest last. Each diagnosis holds its time, the free space of both volumes, the floor, and the scan result. Herdr Boss reads the newest diagnosis for the bulletin and for the worker start refusal. It writes the diagnosis to the bulletin and includes it in the disk refusal row in `action-audit.jsonl` when the audit write succeeds. The engine writes a `disk-low-scan` row to `action-audit.jsonl` for each scan it runs. Each directory entry contains only a path and size. The bulletin hides the diagnosis after both volumes meet the floor or after six hours.

`action-audit.jsonl` is bounded to 500 rows and 256 KiB. It records the time, command, project, worker name, refusal kind, and redacted reason. Forced worker starts also write a row when no refusal needed an override. Handoff writes a row when `--force --reason TEXT` bypasses Opus approval or provider risk.

Worker brief templates support two Herdr command slots:

| Slot | Meaning |
|---|---|
| `herdrEnvPrefix` | The caller's `HERDR_ENV=1` setting and, when known, its `HERDR_SOCKET_PATH`. |
| `herdrBin` | The absolute path in `HERDR_BIN_PATH`, or `herdr` when the path is unknown. |

The default brief names the orchestrator by its agent name `<slug>-orch` first, and gives the pane ID as the current address. The agent name stays the same after a handover. The report and question commands use the agent name. The brief tells the worker to send to the pane ID when the agent name fails.

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget. The default is 10. The project setting overrides the kit default. A failed start ends with `START FAILED: <reason>` after cleanup details.

`worker start` refuses a provider that is ahead of pace, near exhaustion, or exhausted. A provider is ahead of pace only when a live window has a use of at least `paceMinUsePercent` (default 30) and more than `paceTolerancePoints` (default 5) percentage points above its expected use. A provider inside the tolerance is on pace: `herdr-boss lanes` shows it as `claude on pace (17% used, expected 16%, tolerance 5 points)`, and `worker start` accepts it. A refusal for a provider that is ahead of pace ends its lane line with `tolerance 5 points`. Set these values in Settings under Provider quotas. The `claude-haiku-5-5` model can start up to `paceHaikuTolerancePoints` (default 15, range 0 to 100) points ahead of pace. Herdr Boss refuses Haiku above that limit and names the model, lead, and setting in the refusal. Sonnet, Opus, and every other model keep the general tolerance. An exhausted lane shows its window and reset time; when several windows are exhausted, it uses the latest reset. Use `--force --reason TEXT` for an authorized quota override. Ignore quota mode disables pacing and handover warnings below 100%, but it does not make an exhausted provider usable. When every metered provider is ahead of pace, it allows the least-over one with a notice, except Haiku above its limit. A refusal or least-over notice lists the current project's unmetered alternatives first, then names the least-over metered provider. It refuses dispatch when the active CPU limit or enabled load backstop is exceeded. `--force` cannot bypass a machine refusal.

The `machine` object in `rules.json` also holds `swapPercent`, `swapUsedGB`, `swapWarnPercent`, `swapRefusePercent`, `swapMinUsedGB`, and `swapWarning`. `swapWarning` is `true` while the `machine:swap` alert is raised. `swapRefuseEnabled` is `true` when the Owner turned on the swap refusal.

The swap refusal is off by default. The Owner turns it on with `machine.swapRefuseEnabled` in Settings, Machine. When it is on, `worker start`, `suite`, and `push` refuse if all of these are true:

- `swapPercent` is at or above `swapRefusePercent`. A blank `swapRefusePercent` switches the refusal off.
- `swapUsedGB` is at or above `swapMinUsedGB`.
- `updatedAt` in `rules.json` is not older than 3 minutes. Older rules never refuse.
- The caller is a pane that is not the `boss` pane, and is inside Herdr. A shell outside Herdr and the `boss` pane are never refused.

The refusal message shows the swap percent and the GB in use, and names the override. `worker start` needs `--force-swap --reason TEXT`. `--force --reason TEXT` does not override it. `suite` and `push` need `HERDR_BOSS_FORCE_SWAP=1` in the environment. `suite` refuses before it takes the lock. `suite --reuse` still returns 0 when it reuses a passing tree, because no test runs. `push` refuses before it takes the lock, and only when a pre-push hook exists. A ticket that is already in the queue stays.

The Pi allow-list holds only `opencode-go/` models. Free `opencode/` models run only in the `opencode` harness. `worker start --kind pi` refuses an `opencode/` model.

Policy may set `preferredModels` by harness; `modelProviders` by allowed model; `extraModels` and `disabledModels` by harness; `harnessRoutes` by harness and model; and `pacingGoals` by provider and window key (`primary`, `secondary`, or `tertiary`). `extraModels` adds local model strings to one harness. The models use that harness's launch arguments and effort rules. `disabledModels` disables a model in one harness. A preferred model must be in that harness's allow-list. `harnessRoutes` takes precedence over `modelProviders` for the same harness and model. A provider route must be `codex`, `claude`, `opencodego`, or `null` for an unmetered model. A `harnessRoutes` route for the `codex` harness must be `codex` or `null`. A route for the `claude` harness must be `claude` or `null`. The `opencode` and `pi` harnesses accept every provider. `policy set` refuses an incompatible route and names the harness, the model, and the permitted choices. The rule also applies to a `modelProviders` route that an available `codex` or `claude` harness inherits without a `harnessRoutes` entry. `policy set` refuses such a policy and names the harness, the model, and the permitted choices. An existing policy with such a route still loads. Herdr Boss keeps the raw value, treats the model as unmetered in that harness, and logs one warning. `policy show` lists these routes in the derived `ignoredRoutes` field. `policy set` does not store that field. `policy set` removes stale references to models that the catalog no longer allows, and repeated entries. It prunes `modelProviders`, `harnessRoutes`, `disabledModels`, `extraModels`, `excludedModels`, `preferredModels`, and project `excludedModels`. An `extraModels` entry that repeats the catalog is removed. `policy set` prints one note that names each removed model and the field that held it. It prints no note when nothing is removed. A malformed value, for example a model string with a shell character or a route to an unknown provider, still fails with an error and stores nothing. A pacing goal is a whole percentage from 0 to 100; an absent goal means 100%. `autoHandoverContextTokens` is an integer from 50000 to 2000000 (default 300000). With `autoHandover` on, it starts a handover at a task boundary when the Claude orchestrator context is above this value. `autoHandoverForceContextTokens` is an integer from 50000 to 2000000 (default 400000), and it must be higher than `autoHandoverContextTokens`. A legacy policy with no force limit and a normal limit of 400000 or more gets the next 10000-token force limit when loaded. If the legacy normal limit is 2000000, Herdr Boss lowers it to 1990000 and sets the force limit to 2000000. Above this value, Herdr Boss asks for a commit to `docs/orchestration/memory.md`, waits for that commit up to 20 minutes, and then prepares a fresh successor even when the Claude orchestrator works. If there is no commit after 20 minutes, it prepares the successor with `memoryUpdateStatus: "not-updated"` and keeps it blocked. It checks for a later commit and records it when found. It activates the successor only after it verifies the commit and the source pane is idle or done. Explicit `--model` and handoff `--model` choices take precedence.

```sh
herdr-boss worker start fix-74 --kind claude --task-file brief.md --allow src/parse/ --issue 74
```

### Other worker commands

| Command | Action |
|---|---|
| `worker list` | Unfinished run records with the live agent status. |
| `worker collect NAME [--keep-pane] [--allow PATH]... [--accept-scope FILE[,FILE] --reason TEXT] [--outcome done\|partial\|failed --gate-passed\|--gate-failed] [--defects N] [--rework N] [--model-result first-time\|rework\|failed] [--model-reason TEXT]` | Check the worker report and its changed paths, report configured stale-artifact warnings, append the run to the ledger, record usage, and give back every lease that names the worker. Recording needs the outcome, one gate result, and any supplied defect or rework counts. It sets `collectedAt` and `finishedAt` after a successful collect, and it saves the first paragraph of `report.md` as `reportSummary`. A successful collect schedules the pane to close after `workers.paneCloseDelayMinutes` (2 minutes by default). `--keep-pane` skips that close. `--accept-scope` and `--reason` accept files outside the allowed scope. See the scope exception rules below. A refused collect closes nothing. The `--record` flag is accepted for compatibility. When `worktrees.pruneAtCollect` is on, collect archives the reports and removes the worktree and branch if the branch is already merged and the worktree passes the safe prune checks. |
| `worker collect NAME --no-record` | Read and print the report summary. Do not write a ledger entry, close the run record, or schedule the pane to close. Use this option when you only need to inspect the report. Do not combine it with `--record`: the command refuses both flags. |
| `worker commit NAME -m MESSAGE [--baseline COMMIT --reason TEXT]` | Stage the changed paths of a worker that lie inside its allowed scope and commit them on the worker branch. Refuse every changed path outside the scope. Refuse a secret-bearing path (a `.env` file, a `.pem` or `.key` file, an `id_rsa` key, a path with `token` or `secret` in its name, a `credentials` file, or `opencode.json`) and every path under `.worker/` or `.orchestration/`. The error names each refused path. Strip control characters from `MESSAGE` and limit it to 2000 characters. Use it after review for a Codex worker, because a Codex worker cannot write the shared Git metadata. See the baseline rules below. |
| `worker baseline NAME [--commit COMMIT]` | Save `startCommit` in the run record. Without `--commit`, use the current merge-base of the worker's `HEAD` and its recorded base branch. If the record has no base branch, use its saved base commit. Refuse a commit that is not an ancestor of the worker's `HEAD`. |
| `worker stop-own NAME --pid PID` | Stop one process that a worker started. The command refuses a PID unless it is a descendant of the worker pane shell or its current directory is inside the worker worktree. It also refuses the worker pane shell, the shared Codex app-server, and the caller's own process tree. It prints only the PID and the command name. |
| `worker park NAME --reason TEXT` | Mark a worker that waits on purpose. Idle notices skip it. The command gives back every lease that names the worker. |
| `worker unpark NAME` | Clear the park mark. |
| `worker allow NAME PATH... --reason TEXT` | Approve extra paths for a running worker after a `WORKER QUESTION`. |
| `worker scope add NAME PATH... --reason TEXT` | Approve and record extra paths for a running worker after a `WORKER QUESTION`. |

Collection reads process facts from the live loopback service first. It uses local `ps` and `lsof` only when the service cannot be reached. An unknown process check prints a notice and does not block collection.

Collection checks the recorded worker pane shell and its descendants. It ignores the caller's process tree, including tools that use the worktree as their current directory. If a record has no shell PID, collection uses the old current-directory rule for a worktree. For a no-worktree run with no shell PID, it does not block on processes that use the project root. A refusal lists each blocking PID, its ancestor command name, and the reason. For a worker descendant, it gives the worker stop-own command.

Use `worker collect NAME --defects N` to record an integer defect count from 0 to 99. The count is optional. Without this option, the ledger and usage record have no `defects` field. Existing `defectsFound` lists stay supported. The model scorecard shows the total and the number of runs with a count beside the first-time and rework results. A dash means no count was recorded.

#### Worker baseline

Commit and collection refuse a run record that has no `startCommit`. The error names the repair command. Run `herdr-boss worker baseline NAME` to save the default baseline. For an old `--no-worktree` continuation, give `--commit COMMIT` with the checkout's `HEAD` at worker start.

Use `--baseline COMMIT --reason TEXT` on `worker commit` or `worker collect` to set a baseline for one command. On `worker commit`, `--base COMMIT` is an alias for `--baseline COMMIT`. Do not give both options. Each rule below applies.

1. Give a reason with 1 to 300 characters.
2. `COMMIT` must name a commit. It must be an ancestor of the worker's current `HEAD`.
3. The changed paths must stay inside the recorded allowed paths and approved scope extensions. Collection checks the report paths too. A baseline override cannot use `--allow` or `--accept-scope` to accept an outside path.
4. Each accepted override writes the worker name, resolved commit, masked reason, command, and time to `action-audit.jsonl`. This rule also applies with `worker collect --no-record`. A failed audit write stops the command.
5. The override does not change `startCommit` in the run record.

```sh
herdr-boss worker baseline fix-74 --commit COMMIT
herdr-boss worker commit fix-74 -m "Fix the defect" --baseline COMMIT --reason "Use the verified start commit"
herdr-boss worker collect fix-74 --no-record --baseline COMMIT --reason "Use the verified start commit"
```

`worker collect` checks changed paths against the paths in the run record. It ignores the worker's `.worker/` folder. It also ignores `docs/orchestration/herdr-boss.md`, `AGENTS.md`, and `.claude/settings.json`, because the kit writes these files in a worker worktree. It counts a path as the worker's change when the worker's own first-parent, non-merge commits or the working tree changed it. A path that arrived only because the worker merged the base branch into its branch does not count. A Codex worker cannot write the shared Git metadata, so it leaves its change in the working tree. Collection accepts that state, prints the uncommitted paths, sets `uncommitted` in the summary, and the orchestrator commits them with `worker commit` after review. Collection keeps a merge resolution only when it differs from the base branch. It checks artifacts when a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. It compares the newest matching source file with the oldest matching artifact file. It warns when a source is newer or when sources match but no artifacts do. It prints each warning and includes the warnings in the `artifactWarnings` summary field. A warning does not change the independent gate result. The orchestrator decides whether the gate passed.

Collection treats every changed path under `.impeccable/` as outside the allowed scope. This rule applies even when `allowedPaths`, `scopeExtensions`, or `--allow` covers the path. `--accept-scope` cannot accept these paths. Discard the change first. Then use `--exclude-path PATH --reason TEXT` to clear the discarded path.

Workers never run impeccable ignores or edit .impeccable/config.json. A hook finding does not authorize an ignore command or a config edit. Report a false positive in the worker report; the orchestrator decides.

`worker collect NAME --accept-scope FILE[,FILE] --reason TEXT` accepts other changed files that lie outside the allowed scope. Use it when the orchestrator approved the extra files by message. It works with `--record` and with `--no-record`. `FILE` is a repository-relative path. Separate paths with a comma. Each rule below applies.

1. The reason is required. The command refuses an empty or blank reason.
2. `--accept-scope` without a value is an error. `--reason` needs `--accept-scope`, `--exclude-path`, or `--baseline`. No bare override flag exists.
3. Each listed file must be changed and must lie outside the allowed scope. The command refuses a listed file that is inside the scope or that did not change. The error names the file.
4. A changed file outside the scope that is not listed still refuses. The error names the unlisted files. For each unlisted file, the error names the nearest allowed path: an allowed entry that shares the longest directory prefix with the unlisted file. When no allowed entry shares a directory, the error names the first allowed entry. The error also lists the changed files inside the allowed scope, under the label `Inside the allowed scope:`. That list holds at most 20 files and ends with `and N more` when it is longer. The error also shows the exact allowed command form: `herdr-boss worker collect NAME --accept-scope FILE[,FILE] --reason TEXT`. It gives an example that lists every unlisted file, comma separated, and shell-quotes the `--accept-scope` value: `herdr-boss worker collect NAME --accept-scope 'FILE[,FILE]' --reason "approved by the orchestrator"`.
5. The accepted files and the reason go into the run record as `scopeException`. The run record is written only with `--record`.
6. The printed report shows a `Scope exception` block with the files and the reason, and the summary has a `scopeException` field. The command masks secrets in the reason.

`worker collect NAME --exclude-path PATH[,PATH] --reason TEXT` excludes discarded paths outside the allowed scope. Use this command when a report or an earlier commit still lists a path that you removed from the change. Separate paths with a comma.

1. Supply a reason with 1 to 300 characters. The command refuses a missing or blank reason.
2. Supply repository-relative paths. The command refuses an absolute path, a parent traversal, a path under `.worker/`, or a path that resolves outside the repository. It also refuses a path that names the repository root, such as `.` or `./`.
3. Each path must be outside the allowed scope. The command checks the net branch diff against the recorded base and the worktree diff or status. A folder includes its child paths.
4. If a path is still changed, the command refuses. The error names the path and shows whether it is in the branch diff, the worktree, or both. An untracked file, a staged change, a deletion, or either path of a rename blocks the exclusion.
5. Exclusion does not approve extra scope. Other paths outside the scope still block collection. Use `--accept-scope` for files that the orchestrator approved.
6. Supply the outcome and independent gate result. Exclusion records the run. Do not combine it with `--no-record`.
7. The summary and run record store the excluded paths and redacted reason as `scopeExclusions`. The ledger omits the excluded paths. The original report stays unchanged.
8. The command writes one line to `action-audit.jsonl` in the data directory. The line holds the run name, paths, and reason. It uses the same secret filter as a `--force` reason. The audit keeps at most 20 paths. It replaces path control characters with `?` and limits each path to 1000 characters. These audit limits do not reduce the paths that collection checks.

For example, after you discard an unintended file, run `herdr-boss worker collect NAME --exclude-path 'docs/discarded.md' --reason "discarded an unintended file" --outcome done --gate-passed`.

Collection checks paths in both `allowedPaths` and `scopeExtensions`. If `report.json` omits changed paths that are inside the approved scope, collection prints `report.json omits N changed path(s); recorded the diff paths`. It uses the Git diff paths in the ledger. It still refuses a changed path outside the approved scope. Use `--allow PATH` to approve a path for one collect only. Repeat `--allow` for each path. Use `worker scope add` to save an approval in the run record. The string `"none"` in the report's `issue` field becomes null, and collection prints a warning.

Collection ignores the caller's own process tree when it checks worktree processes. If the caller shell has its current directory in the worktree, collection prints `cd <main checkout>` and continues. A separate background shell with its current directory in the worktree blocks collection. A process that still runs in the worktree also blocks collection. The error prints only each process name and PID. It gives a `herdr-boss worker stop-own NAME --pid PID` command for each process that this command can stop. If the worker pane has a different shell PID from the run record, close the finished pane with `herdr pane close PANE`, then collect again.

The command completes every check before it writes the ledger and closes the run. It uses the ledger and run folder in the main checkout, including when you run it from a worker worktree. If the recording flags are missing, it prints the missing flag list and says to use `--no-record` for a dry read.

The service stores each close job in the data directory, so it can continue after a service restart. Before it closes a pane, it checks the saved run ID and the current pane name and agent. It closes the pane with `herdr pane close`, only when that agent is `done` or `idle`. It keeps the job when the agent is working or blocked. A failed run lookup or close command retries on the next tick. After 5 failed attempts, the service drops the job and writes one error log event. It skips a pane that is gone or now runs another agent. Set `workers.paneCloseDelayMinutes` from 0 to 60; 0 means the next service tick. Set `workers.uncollectedNoticeMinutes` from 1 to 1440 to change when the project orchestrator gets one notice for a finished worker that has not been collected. The notice timer starts from the report or finish time in the run record, when it has one. Otherwise, it starts when the service first sees the done pane. The uncollected notice goes to a build worker only. Set `workers.autoCloseReview` to on (the default) to close the pane of a finished review worker ten minutes after it records its report. A review worker writes a report but no product change, so it is never collected. It gets no uncollected notice, and its pane close keeps the running-process and permission-prompt guard. Turn the setting off to leave the pane open.

`worker park` keeps the pane and its agent session open. It gives back every lease that names the worker, because the worker does not use the leases while it is parked. `worker unpark` takes no lease again. Use `worker unpark` to resume the worker. A parked pane keeps its worktree live until the pane closes.

Run `herdr-boss worker ledger repair NAME --reason TEXT` to close a stale parked run after its pane is gone. The Owner, Boss, or project lead can run it. A worker cannot run it. The command refuses an unknown name, a finished run, or a run that is not parked. It also refuses a live pane or agent. If Herdr or Git cannot prove the state, the command writes nothing.

The repair counts commits after the run's recorded base commit. It records `abandoned` when there are no commits. It records `failed` when there is at least one commit. It clears the parked state and writes the finish time and ledger entry. It writes the masked reason to `action-audit.jsonl`. The branch and worktree stay in place. The ledger records `independentGate.passed: false`. Acceptance stays unverified.

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

A CPU-bound command in this class runs without the load guard. Mark only commands that wait on a remote service. Add exact command strings to `networkCommands` in a project's `.herdr-boss.json`. Herdr Boss compares the command after it joins the arguments with spaces and normalizes whitespace. For example, the `example` project can declare `npm run verify:remote` in its config. A matching `suite -- COMMAND...` run uses the machine-wide `network` class. It has a separate FIFO queue and does not take or block the `full-suite` lock. It also does not wait for the 5-minute machine load guard. A push keeps its existing `full-suite` behavior.

Set `locks.network.slots` in Settings under Locks to set the network class cap. The default is 2. The range is 1 to 8. A capacity change applies to the next admission attempt. Existing network holders finish before new runs fit a lower cap.

| Command | Action |
|---|---|
| `lock acquire NAME [--wait SECONDS]` | Acquire a manual lock. `full-suite` and `network` are machine locks. A manual `lock acquire network` is machine-scoped and uses its own FIFO queue with `--wait`. Other names are locks for this Git repository. Wait up to five seconds when another lock or lease change is in progress. A lock change removes a stale guard that a killed command left. `--wait` accepts a whole number of seconds and waits for a held lock in ticket order. The command shows the queue position. If the wait ends first, it exits with code 75. Code 75 means the lock was busy and no test ran. |
| `lock release NAME [--slot long\|N]` | Release a lock owned by this pane, or a stale lock. With several live records in this pane, select a numbered slot with `--slot N` or the long slot with `--slot long`. A network lock uses numbered slots. Automatic suite and push cleanup selects the exact acquired record. A suite or push process releases its own record by PID and lock token, without a pane check; only a manual release checks the caller pane. A token-based push re-entry release is a no-op, including with either slot selector. The outer push owner can still release its exact acquired record. Wait up to five seconds when another lock or lease change is in progress. |
| `lock list` | List the locks of this Git repository and the machine locks. Show each holder's age, pane, kind, scope, class, state, lane, slot, and predicted duration. Show the time left for a manual machine lock. Show each ticket's queue position, project, pane, kind, class, lane, slot use, predicted duration, and wait time. |
| `push [ARGS...]` | Run `git push ARGS...`. When a pre-push hook exists, take the `full-suite` lock and set `HERDR_BOSS_SUITE_REUSE=1` for the hook. A hook may run `herdr-boss suite` or `herdr-boss suite --reuse`. If that suite runs, it reuses the push lock. Before the push, print `ci: this push changes only docs and the CI runs on a main push; use [skip ci] or batch the push.` when a `main` or `master` push has a push workflow and its commits change only `.md` files, files under `docs/` or `.orchestration/`, or `LICENSE`. The reminder does not stop the push. Wait in ticket order for up to 1800 seconds by default. Show the queue position while waiting. If the wait ends first, exit with code 75. Code 75 means the lock was busy and no push ran. If release fails, print a warning. Keep the push exit code, or return 1 if the push succeeded. |
| `suite [--wait SECONDS] [--keep NAME]... [--reuse] [--skip-docs] [--no-notify] -- COMMAND...`<br>`suite --list-passes` | Use `network` for a command that matches the project's `networkCommands` list; otherwise use `full-suite`. If the suite runs in a pre-push hook under `herdr-boss push`, reuse the push lock. Run the command with a clean environment. Save a pass when the command succeeds and the tree is clean before and after it. `--reuse` skips the command and lock when a clean tree has a matching pass. A pass matches only when the repository, tree hash, command, Node version, and the hash of each root lockfile are the same (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, and similar files). A changed lockfile never reuses an old pass. A lockfile that changes during the command prevents a pass record. `suite --skip-docs` skips the command and the lock when the tree is clean and the last pass of the same repository, command, Node version, and lockfiles differs from the tree only by docs that no code reads. It prints `suite: skipped, only docs changed` and adds a pass record with `skipped: docs`. The next skip compares against that record. A path is a doc only when it is `LICENSE` or ends with `.md`. A path under `src/`, `public/`, `test/`, `tests/`, `kit/`, `bin/`, `scripts/`, or `.github/` is never a doc. A file with another extension is never a doc, also under `docs/` or `tickets/`. A package file is never a doc. A changed path that is a symbolic link or a submodule is never a doc. A doc counts as read by code when any test file, or any tracked file under `src/`, `test/`, `public/`, or `kit/`, contains its path or its name without the extension, or when a test file reads a folder of the path with `readdir`, `glob`, or `walk`. In each other case, with no earlier pass, with a missing tree object, with a dirty tree, or with too many files to check, the suite runs. `suite --list-passes` marks a skip record. `--list-passes` prints the last 10 records, then the current machine lock holders and queues, as `lock list` does. Wait in ticket order for 1800 seconds by default. `--wait` accepts a whole number of seconds. Show the queue position while waiting. If the wait ends first, exit with code 75. Code 75 means the lock was busy and no test ran. If release fails, print a warning and keep the command exit code; a passing suite exits 0 and still records its pass. When the command runs and ends, `suite` sends `suite finished: exit N` to the calling pane (`HERDR_PANE_ID`) when that pane is idle or done. A `--reuse` or `--skip-docs` run sends no notice. A working, blocked, or unknown pane gets no prompt. `--no-notify` turns the notice off. The notice never changes the suite exit code. |

Lock names are one path-safe token. Every linked worktree of the same Git repository uses the same locks. The `full-suite` and `network` locks are machine-wide: all repositories on this machine share them. Waiters take tickets in FIFO order. Herdr Boss stores lock records in a private `locks` directory under its data directory. It stores machine locks in `locks/machine/`. The long lane uses `<name>.json`. Numbered slots use `<name>.short.<n>.json`. Each record names the owner pane, PID, kind, class, lane, predicted duration, safe acquire command, acquisition time, and an owner token. A `suite` or `push` lock uses the PID of that command and releases its own record by PID and token. Herdr Boss marks it stale when that process exits, even if its pane stays open. A manual machine lock uses the pane shell PID and expires after 60 minutes. The next acquire takes over an expired lock. The engine sends the former holder a warning when it sees the takeover. It also shows each queue under its machine lock in the bulletin. A different pane cannot release an active lock. Herdr Boss fails closed if it cannot confirm pane state.

For the `full-suite` lock, `locks.slots` sets the total capacity. The long lane has one slot. The short lane has `slots - 1` slots. With one slot, all jobs use the long lane. Herdr Boss predicts a job from the median hold time of the last 10 releases for the same project, kind, and lock name in the last 14 days. It ignores takeovers, re-entrant lines, and reused pushes. A key with fewer than three releases has an unknown prediction and uses the long lane. With fewer than 10 releases, the lane uses the median. With 10 releases, the lane uses the 90th percentile (nearest rank), which is the ninth value. A job uses the short lane when that value is at or below `locks.shortLimitMinutes`. With 10 releases, one slow release does not change the lane. Two or more slow releases send the job to the long lane. The predicted duration that `lock list` shows is still the median. A short job can use a free long slot only when no long ticket waits. A long job never uses a short slot. A suite that runs under a push keeps the push lane. A push that reuses a passed tree takes no lock.

For the `network` lock, `locks.network.slots` sets the capacity from 1 to 8. Its default is 2. Every matching command uses a numbered slot in its own FIFO queue and does not use the full-suite lock or its load guard. Reducing the capacity does not stop a current holder. New holders wait until they fit the new capacity.

Each wait line shows the waiting lane and its queue position. It shows each holder's project, pane, lane, start time, age, and predicted end. It also shows the total queue length and the number of tickets in the waiting lane. The line repeats at most once every 60 seconds, also when the position does not change. A guard or policy pause adds its reason to this line. A ticket at position `1 of 1` is the only waiter in its lane. It can still wait for a holder to release a slot.

The predicted end is the holder start time plus the median of the last 10 completed holds of the same lock and lane. This estimate reads at most the last 512 KB of each ledger file. It skips an incomplete first line. It uses all projects and kinds within those file sections. It ignores takeovers, re-entrant holds, and reused pushes. With no completed hold in those sections, the end is `unknown`. This estimate does not change lane admission. A legacy holder without a lane uses `long`.

When the holder age is more than twice this estimate, the line adds `holder is slow`. It also shows the holder PID and its process state: `alive`, `zombie`, or `unknown`. An unavailable process-state read gives `unknown`. The state helps investigate the next long wait. An `alive` state cannot show whether the process is idle. The service sends one notice to the agent named `boss` for that acquisition. A successful prompt stores its delivered marker without the mutation guard. Other waiters and service restarts do not send another notice after that marker is stored. A missing Boss pane or a failed delivery keeps the notice for a retry. A slow holder keeps its slot.

The lock watchdog checks each live `full-suite` holder on every engine tick. It compares the age with the median hold for the same kind in the last 14 days. It uses a 10-minute floor when the ledger has fewer than five holds of that kind. It sends one notice when the age exceeds the predicted hold times `locks.watchdogMultiplier` and the holder process tree uses less than `locks.watchdogCpuPercent` in each of the last two process samples. The notice goes to the holder pane and the Boss. It names the lock, kind, project, holder pane, PID, age, predicted hold, and up to 10 child process names and PIDs. Inspect the pane. The Boss or owner pane can run `herdr-boss lock release`. The watchdog never kills or releases a lock. A finished holder clears its notice marker.

The cause of the reported 45-minute wait is unverified. A zombie holder is a hypothesis. No runtime trace establishes that cause, so the zombie regression is not proof of a fix for that incident. A zombie has exited but its parent has not collected its exit status. Its PID can still respond to the PID probe. The stale-lock check detects it only when the record has `pidStart` and process state is available. A record without `pidStart` keeps the legacy PID and pane checks. A killed test child releases its suite slot when the suite wrapper collects the exit. A live suite wrapper with a matching process start keeps its slot. A long age alone cannot prove that a wrapper is idle. The message `Removed a stale lock guard` refers to the short guard for a record change. It does not release a held suite slot.

Before a short job starts beside a long holder, the machine guard checks the latest sample against the configured load, swap, and free-memory limits. A missing sample or one older than three minutes passes. A sample over a load or swap limit, or below the memory floor, keeps the short job in its queue. The wait line names the failed limit and its measured value. The lock queue in the dashboard and in the bulletin shows the same pause for each queued short job, for example `waits: lane guard, 5-minute load 245% exceeds 231%`. The machine guard (`machine.guardEnabled`) is a separate setting. The guard does not delay a long job and does not run when no long job holds. The default guard limits are 231 percent load, 96 percent swap, and 40 percent free memory. The Settings page has the **Locks** group. A blank guard field is invalid and shows a field error. A typed zero is valid. Select **Apply policy** to apply capacity and guard changes to the next admission attempt, including queued jobs.

Each lock acquire and each lock release, also of a re-entrant `suite` under a `push`, adds one line to `lock-ledger.jsonl` in the data directory. A line holds the project, lock name, kind (`suite`, `push`, or `manual`), holder pane, lane, predicted duration, and the tree hash when the checkout is clean. An acquire line adds `waitMs`. A release line adds `holdMs`. A line of a re-entrant suite has `reentrant: true`. A busy acquire adds a `busy` line and a wait that ends first adds a `timeout` line, both with `waitMs`. The file rotates to `lock-ledger.1.jsonl` at 5 MB. The dashboard shows the median wait by lane and the median hold. The Analytics page shows wait by lane, the median wait by lane, and hold time for the last 7 days. It also shows saved full-suite slot capacity and machine-wide slot use from the latest usable machine sample. Use is unknown after three minutes. The project filter changes the prediction table but not the scope of slot use. Predicted hold per project and kind uses the same 14-day release history as admission, including the rotated ledger. The medians skip re-entrant, busy, timeout, and takeover lines.

The running service adds one line to `memory-samples.jsonl` in the data directory every 5 minutes. The line holds the time and the resident memory in megabytes of each process class: `claude`, `codex`, `browsers`, `mcp`, `vitest`, and `other`. The file rotates to `memory-samples.1.jsonl` at 3 MB. A line holds no command line, no path, and no pane ID. The Analytics page shows the mean of the samples of each hour of the last 24 hours. No CLI command reads this file. See [Memory by class](reference/locks.md#memory-by-class).

Only a verified `orch` or `boss` pane can run `lock acquire`, `lock release`, and `lock list`. For the `full-suite` lock, `lock acquire`, `lock release`, and `suite` also accept a worker pane. A worker pane has a live run record in the runs folder of a checkout of the same Git repository. The record names the caller pane and the caller worktree, and it has no `finishedAt`. Herdr Boss verifies the pane with `herdr pane get`. A worker pane cannot take other lock names. A lock of a worker pane becomes stale when the pane closes. A `suite` or `push` lock belongs to the process that holds it, not to its pane. A handover that removes the old pane keeps a running suite lock; the next admission reclaims the lock when the process is gone. At activation, Herdr Boss re-owns the locks, leases, and waiting suite runs of the old pane to the new pane in the same project workspace.

At startup, the process can use legacy defaults for a missing, invalid, or partial policy. On a retry, a missing, invalid, or partial policy cannot widen admission. The waiting process keeps its last validated settings. It waits until a complete valid lock policy returns, even if a slot becomes free. A complete lock policy has slot capacity, the short job limit, and all guard fields.

A capacity or guard change applies at each admission attempt, including a queued job. A queued ticket keeps its prediction, short-limit classification, and sequence. A short-limit change classifies new tickets. With one slot, all tickets use the exclusive long lane. After a capacity reduction, every existing holder still counts. New jobs wait until total capacity and slot capacity allow admission. The guard identifies a long job by its lane. A short job that borrows the long slot does not activate the guard. The guard reads the newest sample at or before the current time. A future sample cannot hide a current sample. A missing usable sample or one older than three minutes passes.

A new manual queue ticket uses the PID of the waiting CLI process. The acquired manual holder uses the pane shell PID. A canceled new waiter becomes stale when its CLI process exits.

Each new lock holder record stores the process start time when Herdr Boss can read it. Each new queue ticket stores the same value. If a PID is alive but its start time has changed, Herdr Boss treats the record as stale. Herdr Boss removes it in the same way as a record with a dead PID. If Herdr Boss cannot read the start time, it uses the existing PID and pane checks. A record without a start time keeps the old rules.

During a wait, a missing or unreadable policy gives the reason `policy file is unreadable`. A policy without enough information to choose a lane gives the reason `lock lane is unknown`. Herdr Boss prints a notice for the ticket at most once every 60 seconds. The notice does not name the waiting ticket as a blocker.

The Locks panel and `lock list` queue data show effective admission capacity separately from saved capacity. During legacy exclusivity, effective capacity is one slot and queue positions follow global FIFO order. The short lane has no admission capacity until the eligible legacy records drain.

A holder or queue ticket without a `lane` field is a legacy record. A legacy ticket constrains admission only while its PID and pane are live and it is younger than 30 minutes. The constant `LEGACY_TICKET_TTL_MS` sets this limit. Herdr Boss excludes an older ticket from the queue display. The next admission removes it. This limit releases a canceled old manual waiter whose shell PID stays live. A live legacy holder still requires exclusive admission as before. While a live legacy holder or an eligible legacy ticket exists, admission uses one exclusive long slot and one global FIFO queue. No short second job starts. Existing holders finish before another job starts. Normal lane admission returns after the eligible legacy records drain. A suite hook can re-enter a legacy push with its live token. Old code cannot read a new short-slot record. An old hook cannot re-enter a push in that short slot. This old-code limit is accepted. Do not treat the long record filename as full protocol compatibility.

Herdr Boss publishes the queue sequence with an atomic rename. If a legacy writer left an invalid sequence, the next guarded write starts above the highest live ticket sequence. A valid sequence also remains a lower bound.

Before `push` or `suite`, Herdr Boss compares the registered project's Git pins. A difference refuses the command before it takes a lock. Ask the Boss. Do not run the hook. Only the verified Boss can add `--force --reason TEXT`. The reason is required and audited. See [Harness settings](#harness-settings) for the pin command and cache limit.

Run a full test suite with `herdr-boss suite -- <command>`, and push with `herdr-boss push <args>`. Never take the full-suite lock with a bare lock acquire for a suite. Use `lock acquire` and `lock release` for other lock names. A short job can wait in the short lane when the machine guard reaches a configured limit.

Use `herdr-boss suite -- npm test` for a full test suite. The command removes `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET` from the environment of the suite. It also removes each name that ends in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, or `_KEY`, in upper or lower case. It keeps all other names, for example `PATH`, `HOME`, and `TMPDIR`. Use `--keep NAME` to keep one removed name. You can use `--keep` more than once. The command prints the number of removed names. It does not print names or values. It releases the lock also when the suite fails or cannot start.

Start a suite with the background option of your harness, so the harness wakes your turn when the suite ends. Or rely on the finished notice. `suite` sends one line, `suite finished: exit N`, to the calling pane (`HERDR_PANE_ID`) when the command runs and ends and that pane is idle or done. A `--reuse` or `--skip-docs` run sends no notice. A working, blocked, or unknown pane gets no prompt, and the run retries no notice. A failed notice never changes the suite exit code, so a detached suite always ends on its own. Use `--no-notify` to turn the notice off. Never end a turn while a detached suite runs.

Run `npm test` to run tests with a temporary `HOME`, `HERDR_BOSS_DIR`, and `HERDR_BOSS_LIVE_DIR`. The command removes the temporary folder when the tests finish. In a new test file that statically loads a data-directory module, import `./helpers/test-env.js` before all other imports.

The test runner starts no more than two test files at once. Each file has a 300-second limit. Set `HERDR_BOSS_TEST_TIMEOUT_MS` to a positive whole number of milliseconds to change the limit. After a timeout, the runner reports the file and its elapsed time, then starts the next file. It exits non-zero.

The test runner guards the live data directory. It loads `scripts/live-write-guard.js` into every test process. A write to `~/.herdr-boss`, or a launch of a Chrome or Chromium binary, makes that test fail and writes a line to the guard report. The runner prints the report and exits non-zero. The guard uses the real account home, so the temporary `HOME` of the test run cannot hide the live directory. An explicit `HERDR_BOSS_LIVE_DIR` names the guarded directory instead. A test must use a temporary `HERDR_BOSS_DIR` and a fake probe. The runner also records the size and the mtime of `events.jsonl` and `state.json` before and after the run. The live service writes those files on every tick, so the runner prints that change as evidence and does not fail on it.

The runner also guards the tracked kit files of the repository: `docs/orchestration/herdr-boss.md`, `AGENTS.md`, and `.claude/settings.json`. The guard refuses a write to them from a test process. The runner also compares the content hash of each file before and after the run. A changed file makes the run exit non-zero. A test that runs `publish`, `kit install`, or `kit update` must use a temporary Git repository as its working directory.

Herdr Boss stores successful passes in `suite-passes.json` in its data directory. It keeps the last 200 passes. The file has mode `0600`. A pass key uses the Git common directory, the tested hash of the tree, the hash of each root lockfile, the exact command, and the Node version. The tested hash covers every file of `HEAD` except the files that match a glob of `suiteUntested`. A dirty tree cannot use or create a pass. A changed, staged, or untracked file that matches `suiteUntested` does not make the tree dirty. A changed file that no glob covers runs the suite again.

`suiteUntested` is a list of repository-relative globs in `.herdr-boss.json`. It names the files that no test reads. The default is `.worker/**` and `.orchestration/**`. The value replaces the default. Only `*` and `**` are valid. Do not list a file that a test reads. A glob is invalid in these cases:

- it starts with `*/` or `**/`;
- it is `*` or `**`;
- it matches one of these sample paths: `src/x.js`, `test/x.test.js`, `public/app.js`, `kit/CHANGES.md`, `kit/templates/x.md`, `.github/workflows/x.yml`, `package.json`, `package-lock.json`, `.herdr-boss.json`, `docs/cli.md`, `docs/user-guide.md`, `bin/x`. An invalid list is an error in `loadProjectConfig`. The pass key ignores an invalid list as a whole and uses the default. `dir/**` matches the paths below `dir`, not `dir` itself, so a tracked file named `.worker` is tested. Documentation files in `docs/` are read by tests, so they are tested. A changed list never matches an older pass.

Known limits: the key ignores untracked files under `.worker/` and `.orchestration/`, although a test may read run state there. Keep such a test out of the suite, or list no path that it reads.

`suite` without `--reuse` runs again on a tree that has a pass. It skips the run only when a pass has a different tree and the same tested hash: the trees differ by untested files only. The output says `suite: reused the pass of ...`.

In a pre-push hook, run the test command through `herdr-boss suite` or `herdr-boss suite --reuse`. When the suite runs under `herdr-boss push`, it reuses the push lock. `herdr-boss push` also sets `HERDR_BOSS_SUITE_REUSE=1`, so the suite can reuse a matching pass. A Viz hook can use the same commands for its Tier B check.

Use `herdr-boss suite --reuse -- <command>` to request reuse outside a pre-push hook. Use `herdr-boss suite --list-passes` to print the last 10 records. Each row shows the time, repository name, short tree hash, and command.

`herdr-boss push` stores the suite commands that its hook ran in `push-hooks.json` in the data directory. Before it takes the lock, the next push looks for a pass of each stored command on the clean tree. When every command has a pass, the push takes no lock, sets `HERDR_BOSS_SUITE_REUSE=1`, and runs `git push`. It prints `push: a suite pass exists ... Pushing without the full-suite lock.` It writes an `acquire` and a `release` ledger line of kind `push` with `reused: true`, `waitMs: 0`, and `holdMs: 0`. The store also holds the hash of the hook file. A changed hook file is a miss. A hook is reusable only when each line is a comment, a `set`, `cd`, `export`, or `exit` line, or a `herdr-boss suite` call. A hook with a raw test command is never reusable. A push with no stored command, no pass, a dirty tree, or a non-reusable hook takes the lock as before. A reused push never queues. A push that queues keeps its place in ticket order, and every waiter gets its turn in that order.

`herdr-boss push` finds a pre-push hook in two ways. A `pre-push` file exists at `git rev-parse --git-path hooks/pre-push`, which respects `core.hooksPath`. Or a husky or lefthook config names `pre-push`. With a hook, it takes `full-suite`, runs `git push`, and releases the lock also when the push fails. With no hook, it runs `git push` and takes no lock. It prints which case it used. Its exit code is the exit code of `git push`. Only a verified `orch` or `boss` pane can run it.

### `worker scope add NAME PATH...` and `worker allow NAME PATH...`

Approve extra scope after a worker asks a question. Only the verified `orch` or `boss` pane may approve. The command requires `HERDR_ENV=1` and verifies the caller pane with the same checks as `worker start`.

Use `herdr-boss worker scope add NAME PATH... --reason TEXT`. The older `worker allow NAME PATH... --reason TEXT` command is an alias.

The paths must be repository-relative and inside the worker worktree. The command refuses an absolute path, a parent traversal, a path that resolves outside the repository through a symlink, and every path under `.worker/`. It refuses the whole request when any path is invalid, and it refuses a finished run. A valid approval adds the paths to `allowedPaths` and records the paths, reason, time, and verified caller pane in `scopeExtensions`.

`worker collect` uses the approved paths. Its summary and ledger entry include the approval history. A prompt or message alone does not change the approved paths.

Collection records the run before it prunes. Collect removes a worktree only when its branch is already merged and it passes the safe checks. A branch that is not merged stays in its worktree. Merge it, then run `herdr-boss worktree prune --apply`. Turn off `worktrees.pruneAtCollect` in Settings to keep worktrees after collection.

`worktree prune` reads process facts from the live loopback service first. It uses local `ps` and `lsof` only when the service cannot be reached. An unknown process check keeps that worktree. The command continues with the other worktrees.

`worktree prune` checks the current working directory of processes in every existing worktree it could remove. It also reports parent-PID-1 processes that still use a missing or prunable worktree path. It never removes a worktree while a matching process runs. It keeps a worktree when it cannot scan its processes. It skips build cleanup for that worktree. It does not remove worktrees with other dirty project paths, unmerged branches, primary checkouts, live panes, or uninspectable state.

Use `worktree prune --clean-build` to list rebuildable output in worktrees that the prune keeps. The list gives the path and size of each file and the total size. It includes files under `dist`, `.vite`, and `test-results`, plus screenshots older than one day under `.worker/tmp`. It never deletes tracked files or `node_modules`. It skips a worktree with a live pane or a running process. Add `--apply` to delete the listed files. The command then prints the total size deleted. It does not clean the primary checkout.

Use `worktree disk` to print the size of each existing worktree in the current project, sorted from largest to smallest. The report includes the total size and free space at the configured worktree root. Add `--json` for a JSON report. The command reads worktree sizes with `du` and changes no files.

The generated file `docs/orchestration/herdr-boss.md` may be dirty after a kit update. The file must not have a staged change. Its content must match the current kit output or a version in the base branch history. A hand edit or staged change keeps the worktree. When this file is the only dirty project file, and the only other dirty paths are the untracked worker files `.worker/`, `opencode.json`, and `.orchestration/`, the prune treats the worktree as clean. A dry run says `would restore the generated kit file`. With `--apply`, the command restores that file from the index, archives the reports, and removes the worktree. Any other dirty project path keeps the worktree.

A worktree has a live pane only when the current pane list contains a pane in that worktree and its agent is not `done`. A parked pane stays live, including when its agent is `done`. A pane with an unknown agent state stays live. A done pane still needs to pass the process checks before removal.

Before `worktree prune --apply` removes a worktree, it copies `.worker/report.md`, `.worker/report.json`, and `.worker/brief.md` to `.orchestration/reports/<worker name>/` in the main checkout. It copies no other file. It skips a missing file and a file larger than 1 MB, and prints one line for each skipped file, for example `skipped report.md: over 1 MB`. It never overwrites a file. If the archive folder already holds one of the files, the command writes all files to the new folder `<worker name>-<UTC time>`. It adds `-2`, `-3` when that folder also exists. It prints one line for each archive: `archived reports of <name> to <path>`. The `.gitignore` of the project holds `.orchestration/`. If `.worker` or the archive folder is a symlink, or a copy fails, the command prints the error and keeps that worktree. Use `--no-archive` to remove a worktree without the copy.

```sh
herdr-boss worker scope add fix-74 docs/parse.md --reason "the fix also needs the parser docs"
```

### Resource leases

| Command | Action |
|---|---|
| `lease acquire POOL [--for SLUG\|WORKER] [--prefer ITEM] [--ttl MINUTES] [--pid PID] [--wait SECONDS] [--env-file FILE]` | Lease one free item of the pool. Print the item on its own line on standard output. |
| `lease bind POOL ITEM --pid PID` | Bind a lease to the server process that uses its port. |
| `lease release POOL ITEM` | Release a lease of your project. The Boss can release any lease. |
| `lease list [POOL]` | Print each pool item and its lease as JSON. A free item has `"lease": null`. Nothing changes. A lease of a ports pool shows `bound`, `listener`, and `pidAlive`. An item with a `portEnv` entry shows `set` or `not set`, never the value. |

Define the pools in `resourcePools` in `~/.herdr-boss/config.json`. See [Resource leases](reference/locks.md#resource-leases) in the user guide.

`lease list` also shows the built-in pool `project-browsers`. `lease acquire` and `lease release` refuse this pool. Use `browser request` and `browser release` for it. No pool leases port 9222.

Only a verified `orch` or `boss` pane, or a worker pane with a live run record, can run `lease acquire` and `lease release`. The worker rule is the same as for the `full-suite` lock.

- Without `--for`, the lease belongs to the project of the current checkout. A worker pane leases for its own worker.
- `--for WORKER` records a live worker of the project of the orchestrator.
- `--for SLUG` records a project. Only the Boss pane can use it.
- `--ttl MINUTES` sets the lease time. The default is `ttlMinutes` of the pool.
- `--pid PID` binds the lease to the server process with that ID. The command fails when the process does not run. Herdr Boss stores the start time of the process with the ID. The PID must be a live process of your own server: a foreign long-lived PID keeps the lease until the idle rule applies.
- `--wait SECONDS` waits for a free item. The default is `waitSeconds` of the pool. The waiting callers form a FIFO queue. The command prints `waiting for a free port in pool NAME, position N` on standard error and again when the position changes. After the timeout the command exits with code 3 and lists the holders. A call without `--wait` does not take an item that a queued caller waits for.
- `--env-file FILE` writes `export VARIABLE='value'` lines to the file with mode `0600`: the variable of the pool and each `portEnv` variable that has a value for the port. Source the file in the shell of the server. Use a path in `$TMPDIR`, outside the repository. The command prints `VARIABLE for port N: set` or `not set` on standard error, never the value.

`lease acquire` chooses an item in this order:

1. The `--prefer` item, when it is free.
2. A free item in the `split` list of the project.
3. A free item that is in no `split` list.
4. A free item in the `split` list of another project. The lease has `"borrowed": true`.

Within steps 2 to 4, an item that no process listens on comes before an item with a listener and no lease. The list comes from the last tick of the engine, so it can be a tick old. Step 1 wins before the list: `--prefer PORT` gives that port out even when a process listens on it.

A borrowed lease stays until it is released or reclaimed. When no item is free, `lease acquire` exits with code 3 and lists the holders on standard error.

```sh
PORT="$(herdr-boss lease acquire serve-ports --wait 600 --env-file "$TMPDIR/serve.env")"
. "$TMPDIR/serve.env"
npm run serve:live &
herdr-boss lease bind serve-ports "$PORT" --pid $!
herdr-boss lease release serve-ports "$PORT"
```

A lease ends before its TTL in these cases. The bound process is gone: Herdr Boss releases the lease within one tick. The process ID belongs to another process now: the start time differs. The port has no listener for `idleMinutes` of the pool (default 20), also for a lease that no server bound. Herdr Boss probes `127.0.0.1` and `::1`. A listener on either address counts. The port has no listener only when both addresses refuse the connection. An address that gives no answer, for example `::1` on a machine without IPv6, does not make the probe unknown. The holder gets one notice. The grace time `workers.leaseGraceMinutes` (default 30) bounds the idle rule of a pool: a lease of a pool with an idle rule that has no bound process and no listener ends after the grace time, also when the idle time of the pool is longer. A lease of a pool without an idle rule is never reclaimed by the grace time. `worker collect` and `worker park` give back every lease that names the worker. A `serve-live` helper calls `lease acquire serve-ports --wait 600`, which waits up to 10 minutes for a free port, and binds the lease to its server process.

A server must bind its PID at start. Take the lease, start the server, then run `lease bind POOL PORT --pid PID` at once. A caller that knows the PID before the lease runs `lease acquire POOL --pid PID`.

The engine probes every free item of a pool with an idle rule on each tick. When a process listens on such an item and no lease holds it, the port is an unleased listener. The state API lists it in `resourceLeases.unleased` with the pool, the item, the PID, the process name, the first tick that saw it, its age in minutes, and the owner project. The PID comes from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp`, the process name from `ps -o comm= -p <pid>`, and the owner from the working directory of the process against the project registry. The registry path and the worktree folder of a project both count, so a server in a worker worktree has an owner. When two paths hold the directory, the longer path wins. Herdr Boss reads no command line and no environment.

An unleased listener with a known owner gives one notice to the orchestrator pane of that project after 10 minutes. The notice names the port, the PID, and the process, and gives these commands:

```sh
herdr-boss lease acquire serve-ports --for SLUG --prefer PORT --pid PID
herdr-boss lease bind serve-ports PORT --pid PID
```

An unleased listener with an unknown owner gives no notice. The Allocation page shows a warning row for each one. Herdr Boss never takes the lease itself.

The client ID of a port: a pool can hold `portEnv` values for each port range, for example `TM_SERVE_LIVE_CLIENT_ID`. A project picks the client ID by port. The lease hands the value over through `worker start --lease` (pane environment) or `lease acquire --env-file`. A port without a value gets no variable. See [Resource leases](reference/locks.md#resource-leases).

`worker start --lease POOL` leases one item before it creates the worktree or the pane. It sets the variable `env` of the pool in the worker pane, for example `HERDR_SERVE_PORT=8001`. It records the lease in the run record and in the brief. When the pool has no free item, the start fails with exit code 3 and creates nothing. When the start fails later, it releases the lease. `worker collect NAME` and `worker park NAME` give back every lease that names the worker, also a lease that the worker took after its start.

When a task names `serve:live` and the `serve-ports` pool exists, `worker start` leases one port when needed. It prints that it took the lease. It writes the port to `.worker/port`, one line, and tells the worker to use only that port. With `--no-worktree`, the port file is `.worker/NAME/port`.

## Ledger, checks, and worktrees

| Command | Action |
|---|---|
| `ledger append --entry FILE [--file LEDGER]` | Validate and append one run entry. |
| `ledger check [--runs] [--file LEDGER]` | Validate the ledger. `--runs` also fails for each run record without a ledger entry. |
| `node scripts/docs-gate.js [--base REF] [--head REF] [--root DIR] [--include-worktree]` | Check docs for behavior changes and scan changed files for token-shaped strings. The scan includes test files and fixture folders. Record a documented synthetic sample in `scripts/docs-gate-allowlist.json` by path, class, reason, and exact-string SHA-256. Do not store the matched string. |
| `check --report FILE` | Validate a worker report (`report.json`). |
| `check --run FILE` | Validate one ledger entry. |
| `check --worktree DIR --allow PATH...` | Check that the worktree changes only allowed paths. |
| `check --help` | Print the report, run, worktree, agents, and kit check forms. Exit 0. |
| `check agents [FILE]` | Check a project `AGENTS.md` and its kit file for kit drift. `FILE` defaults to `AGENTS.md` at the Git top level of the current directory. The kit file is `docs/orchestration/herdr-boss.md` in the directory of `FILE`. The command also checks that the kit file carries each required kit rule, and scans the orchestration files in that directory. The command prints one line per finding and a summary line. It exits 0 when there is no `error` finding, and 1 otherwise. |
| `check kit` | List each published project with its `kitRevision`, the number of `required` changes that it is behind, the kit revision on disk in its registered repository (`installed`, or `none`), its `agentsCheck` counts, and the revision state: `current`, `behind (useful only)`, `behind (required)`, or `not published`. A project is `behind (useful only)` when every kit change since its revision has the impact `useful` or `none`. A project is `behind (required)` when one change has the impact `required`, when its revision is not in `kit/CHANGES.md`, or when the current revision has no entry there. Check each `orch` agent against `<slug>-orch` and the `boss` agent against `boss`. Print a command for each wrong name. If the Herdr agent list is unavailable, print a warning and skip the name check. The command exits 1 when a project is `behind (required)` or `not published`, or when an agent name is wrong. A project that is `behind (useful only)` does not fail the check. |
| `kit install [--no-hook]` | Install the kit in the Git top level of the current directory. The command writes the kit file, the `AGENTS.md` stub, and the Claude `SessionStart` hook. It prints `wrote FILE` for each file that it changed and `unchanged FILE` for the other files. `--no-hook` does not change `.claude/settings.json`. |
| `kit update [--quiet]` | Install the kit as `kit install` does, print the kit changes since the installed kit revision, and print the current kit file. `--quiet` prints the digest and the summary line only, and prints nothing when the kit is current and no file changes. |
| `kit block` | Print the marked `AGENTS.md` stub with the current hash. Use `kit install` for a new installation. |
| `worktree prune [--apply] [--no-archive] [--clean-build]` | List worktrees that pass the safe checks and show processes in removal candidates. `--apply` removes only worktrees with no blocking process. Before it removes a worktree, `--apply` archives the worker reports. `--no-archive` skips the archive. `--clean-build` lists or removes rebuildable output in kept worktrees. |
| `worktree disk [--json]` | Print sizes for each existing worktree in the current project, sorted largest first, the total size, and free space at the configured worktree root. The command changes no files. |
| `gh issue create\|comment\|edit ... --body-file FILE` | Run a GitHub issue command. An inline `--body` is refused. |
| `gh label create NAME --color RRGGBB [--description TEXT]` | Create a GitHub label. |
| `gh label edit NAME [--color RRGGBB] [--description TEXT] [--new-name NAME]` | Change a GitHub label. The command needs at least one option. |
| `gh label list` | List the labels of the repository. |
| `gh label sync --preset NAME [--dry-run]` | Create or edit the labels of a preset. The command reads `gh label list --json` first. It creates a missing label, edits a label whose color or description differs, and leaves an equal label. It never deletes a label. It prints one line for each label: `ok`, `create`, or `update`. `--dry-run` prints `would create` and `would update` and runs no write command. The only preset is `triage`. |
| `gh milestone create TITLE [--description TEXT] [--due YYYY-MM-DD]` | Create a GitHub milestone. The command runs `gh api`, because `gh` has no milestone command. |
| `gh milestone list` | List the open milestones. |

### Safe `gh` commands

Every `gh` command runs in the project root. Herdr Boss passes each value as one argument and starts no shell. It checks every value before it calls `gh`.

- A label name has 1 to 50 characters. A label description has at most 100 characters. A label color has 6 hex digits, without `#`.
- A milestone title has 1 to 255 characters. A milestone description has at most 1000 characters. A due date is a real date in the form `YYYY-MM-DD`.
- A value has no control character. A name, title, description, or option value does not start with `-`.
- A value that holds a secret is refused. The check is the secret scan of `src/secret-scan.js`. The message names the class of secret and never prints the value.
- `label delete`, `milestone delete`, and every other action are refused.
- A label command and a milestone command act on the repository of `origin`. The command reads `remote.origin.url` from Git, and it refuses a missing origin or an origin that is not a `github.com` URL. It passes `--repo OWNER/REPO` (or the path `repos/OWNER/REPO/milestones`) to `gh`. It removes `GH_REPO` from the environment of `gh` and sets `GH_HOST` to `github.com`. An `upstream` remote or a default repository of `gh` does not change the target.
- Herdr Boss compares label names without regard to case. A sync does not rename a label whose name differs from the preset only in case.

The label presets are data in `kit/label-presets.json`: a preset name and a list of `name`, `color`, and `description`. The preset `triage` holds `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. The file `kit/templates/triage-labels.md` is the template for the role table of these labels.

### Kit change impact

The kit revision includes `kit/models.md` when that file is present. An older kit root without this file keeps a valid revision. A change to model guidance follows the same notice impact rules as other kit assets.

A commit that changes `kit/`, `src/kit/`, or `docs/orchestrator-instructions.md` needs a `Kit-Impact: required`, `Kit-Impact: useful`, or `Kit-Impact: none` trailer, or a change of `kit/CHANGES.md`. A kit change with neither has impact `useful` and sends no `Kit updated` notice. A paused or stood-down project gets no kit notice. A pane gets at most one kit digest in `machine.kitDigestMinutes` minutes (default 120), and none while it works. `test/kit-impact-trailer.test.js` checks the Git log.

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

`worker start` and `publish` refresh the kit files of the project before they check the kit revision. The refresh runs when the disk copy of the kit file is behind on a `required` change, or has a revision that `kit/CHANGES.md` does not list. The refresh writes the same files as `kit install` and commits nothing. Commit the written files with your next commit. The refresh does not run with `worker start --dry-run`. The refresh changes `.claude/settings.json` only in the hook entry and the `AskUserQuestion` denial, and keeps all other keys and hooks. When that file is not valid JSON or has a shape that the merge cannot keep, the refresh writes no file and prints a warning. Any other error in the refresh prints a warning and never fails `worker start` or `publish`. The refresh does not overwrite a file that has hand edits. A kit file has hand edits when its note line is missing or when its text differs from the text that the last `kit install`, `kit update`, or refresh wrote. `kit install` records the hash of that text in the Git directory of the project (`herdr-boss-kit.json`). A project with no record uses the committed copy instead. A kit file that an earlier refresh wrote and nobody committed has no hand edits. An `AGENTS.md` stub has hand edits when its text does not match its `v=` hash. In that case the command prints `Warning: kit files not refreshed: <file> has hand edits. Run herdr-boss kit update.` and goes on. After a refresh the command prints `Kit refreshed: wrote <files> (kit revision <old> to <new>). Commit the files with your next commit.`

`publish` refreshes the kit in the repository that is registered for the slug. When the slug has no registered repository, it uses the Git top level of the current directory. `publish` also sets `kitRevision` in the status that it stores. The value is the `v=` revision of the kit file on disk, read after the refresh. A `kitRevision` in the status file is replaced. When the project has no kit file, `publish` keeps the `kitRevision` of the status file.

`worker start`, `publish`, and `handoff plan|prepare` check the kit revision of the project in the Git top level. When the project kit is behind for at least one `required` or `useful` change, the command prints one line. A project that is behind on a required change gets: `Kit update: this project kit is behind by N required and M useful change(s). Run herdr-boss kit update.` A project that is behind on useful changes only gets: `Kit update: this project kit is behind by N useful change(s). The update is optional to act on now. Run herdr-boss kit update at the next task boundary.` `worker start` prints the line to standard output. `publish` and `handoff` print it to standard error. The command prints nothing when the kit is current, when the project has no kit file, when all changes have the impact `none`, or when the refresh made the kit current.

`kit update` computes its digest from the installed revision before it writes any file. The digest names the impact and the summary of every kit change after the installed revision, oldest first. The installed revision is the version line of the kit file of the project. When the change log does not know that revision, the digest lists every known change and says that the revision is unknown. With no change the digest is one line. `kit update` installs in all cases. Without `--quiet` it prints the digest, the `wrote FILE` and `unchanged FILE` lines, the current kit file, and the final `kit update: kit revision ...` line. Run it after a `Kit updated` notice. The printed kit file replaces the stale copy in the session. With `--quiet` the command prints the digest and the final line only when a kit change exists or a file changed. Otherwise it prints nothing.

`check agents` prints each finding in `AGENTS.md` or the kit file as `LEVEL line N: message`. `LEVEL` is `error` or `warn`.

`check agents` also checks the required kit rules. A kit file that lacks a rule gives an error that names the rule and the fix, for example `docs/orchestration/herdr-boss.md has no rule that a license is never inline; run herdr-boss kit install`. The rule is the rule that a license is never inline: no release, bundle, demo, fixture, or test app holds license text, a license token, key text, or a licensed state. The Owner issues the license in a license extension for the tenant. A public verification key in code stays allowed. The token check does not scan binary archives.

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

An unknown tool-call count stays `null`. The ledger accepts `null` as unknown. This check reads the ledger. Do not replace `null` with `0`. Do not edit the ledger entry.

## Process facts in a sandbox

The OpenCode start lock, worker collection, worktree pruning, and browser client check use the live service for process facts.
The service verifies the caller pane before it reads a process.
Use a pane labeled `boss` or `orch` with its correct `HERDR_PANE_ID` and `HERDR_WORKSPACE_ID`.
The request uses loopback on `HERDR_BOSS_PORT`, or port 4477 by default.
Local `ps` and `lsof` are the fallback when the service cannot be reached.
A service refusal does not permit a local fallback.
The probes for each query share a two-second deadline.
A timeout after connection does not permit a local fallback.
The answer contains process IDs and command names only, plus the facts required for the check.
It contains no command arguments or environment values.
See [Process facts API](specs/process-facts.md).

The OpenCode start lock stays held when the owner identity is unknown.
The age of the lock file does not release an unknown owner.
Retry after the service can verify that owner.
Worker collection continues after an unknown check.
Worktree pruning keeps the worktree after an unknown check and continues with the others.
Browser restart prints the exact `--allow-unknown-clients` command for an unknown CDP client check.

## Browsers

`herdr-boss browser` is a thin helper for visual checks of a project page. It is not a Playwright or agent-browser replacement. Do not add general page automation or scripting to it.

Each project has one persistent Chrome profile on a port from 9223 to 9299. The port is a lease in the built-in pool `project-browsers`. See [Port leases](reference/browsers.md#port-leases). Add `--tab ID` to page commands when the browser has several tabs; `browser tabs` lists the IDs.

Run `herdr-boss browser audit [PROJECT]` to list the last 50 independent browser launches. The command reads the event log and changes no file. It lists the time, browser PID, pane, launcher kind, and project, newest first. Add a project slug to filter the rows before the limit. The command keeps at most 50 rows and reads the log in 64 KB parts. It skips a malformed row or a row larger than 4 KB. Each new notice and audit row also holds the observed process start identity. Herdr Boss reads this identity from the process start time. It keeps the first pane and launcher association when a process becomes an orphan. A process with the same PID and start identity gets one audit row, including after it disappears and returns. A reused PID with a new start identity gets a new row. The launcher kind is `perf-harness`, `agent-browser`, `playwright`, or `unknown`. Herdr Boss checks ancestor executable and runtime script names only. A generic runtime with no known script name has kind `unknown`. These fields hold no raw arguments, URLs, environment values, or profile paths. Older rows can show `-` for a missing PID or pane and `unknown` for the launcher kind. The Browsers page shows the same list for all projects.

For a browser task, create your own tab with `browser tab new`. Record its tab ID. Use only that tab. Close it when the task ends. Never use or change another tab. Never print cookies, storage, or tokens. Never run an evaluate command that reads `document.cookie` or `localStorage`. Use `herdr-boss browser screenshot` for each screenshot.
New project browser requests and reservations use headless mode. Set `browser.allowVisible` to on to allow `browser request --visible` and `browser restart --visible`. It is off by default. The service changes a legacy visible session to headless on its next tick. It restarts Chrome only when the recorded process ID proves that Herdr Boss started it. It keeps an external browser running and saves headless mode for its next launch.

The service closes a project browser after `browser.idleCloseMinutes` with no other CDP client or open agent tab. The default is 20 minutes. Set it from 1 to 1440 minutes, or set it to 0 to turn off idle close. It closes only a browser that Herdr Boss started and matched to the project's port and profile. It keeps the Chrome profile. A later browser request can launch the browser again.

A failed health check does not count while a browser command runs. It also does not count during the next 20 seconds. Two failed checks in a row during a quiet period cause a health notice. A successful check clears the state. A connected CDP client doubles each step limit to 6 seconds and the total limit to 16 seconds.

For one week after the first health notice, the service writes one `browser-health` row to `events.jsonl` for each new health notice. The row holds the probe reason, the failure count, the process state, the process ID, and command activity. It also holds the count of other CDP clients. The process state is `running`, `missing`, or `unknown`. The row contains no page URL, title, or process command line. The service keeps the start of this period across service restarts.

Restart blocks new browser commands while it waits and relaunches. Tab reads, page input, navigation, and screenshots use the activity tracker. A queued screenshot also counts as a command in flight. These records cover Herdr Boss browser commands. Restart also waits for other CDP clients to disconnect. It refuses when the client count is unknown. The refusal names the failed CDP client check. Add `--allow-unknown-clients` to `browser restart` to override an unknown check. This option does not bypass a known connected client or a command in flight. A connected client can be idle, so this check can refuse an idle client. This protects commands from drivers that do not use the tracker.

The private session file keeps the last known tab addresses. A tab read, a successful page command, or a health probe that lists tabs updates these addresses. Restart uses the current tab list when it is available. Otherwise, it uses the saved addresses. It keeps each duplicate address as a separate tab. A saved address can be older than the current page if another CDP client changed that page after the last probe. Only web pages and blank tabs are saved. Restore drops query strings and fragments when it saves an address and when it reopens a tab. A page that needs them reopens at its path. Restore skips login and callback pages. It checks each path segment by its token prefix, without its file extension. Login, logon, sign-in, sign-on, OAuth, authorization, callback, SSO, SAML, OIDC, OpenID, connect, consent, and token prefixes prevent restore. It drops path parameters from every segment. It decodes the path up to three times for this check. It skips a path if decoding fails or leaves another encoded layer. It also skips sign-in hosts whose first label is `login`, `accounts`, `sso`, `auth`, `id`, `idp`, `signin`, or `adfs`. It also skips an address with a user name or password. Read the tab list again after a restart. The tab IDs change. The output reports `restoredTabs` and `restoredPage`. A failed tab restore gives a message with no page address. An old browser with no saved tab list cannot restore pages when its tab list is unavailable.

Browser command output masks outside hosts in URLs, tab titles, and bookmark names. It replaces the first host label with `<tenant>`, or an outside IP address with `<ip>`. It keeps loopback hosts in full. It keeps the scheme, port, and path. It removes query strings and fragments from every printed URL, including a URL inside a title. It removes URL user names and passwords. It prints `data:` and `javascript:` URLs as `<redacted-url>`.

The final output filter applies to text and JSON. It replaces values after `code=`, `state=`, `session_state=`, `access_token=`, `id_token=`, `refresh_token=`, `token=`, `key=`, and `Bearer ` with `<redacted>`. It also replaces JWT strings. The filter applies to bookmark names and errors. The browser API, dashboard state, and new event log records use the same rules.

The filter also applies to every command error. A usage error, an uncaught exception, and a child process error pass through it. It masks a UUID that follows `--app`, `--app-id`, `--id`, `/apps/`, or `app/`, and it prints that UUID as `<uuid>`. It keeps a bare UUID. A command that is not `browser` keeps a plain file name, such as `src/cli.js`, and masks a host inside a URL. It masks a bare host on a `Command failed:` line only, because that line holds the argument vector of the child. A `browser` error keeps the browser rules. Add `--full` as the Owner at a terminal to keep the outside host and the app UUID.

The filter decodes browser text once before it checks for secrets. Key names can have a prefix, such as `api_key` or `my_token`. A key can use `=`, `%3D`, or `:` before its value. The filter ignores letter case. It also removes bearer values after a tab or a non-breaking space. A JWT replacement includes its padding.

Add `--full` to a supported command to show hosts in full. This flag still removes query strings and fragments. It still removes credentials. Use this flag only when the Owner needs the host, at a terminal.

The dashboard opens a bookmark by its stored index. **Add current page** reads the selected tab on the server. These actions use the stored address without returning it. Enter a complete address to navigate or change a start page. A masked address cannot be used for navigation.

Herdr Boss decides browser ownership by the Herdr workspace. Any pane in a project's workspace can change that project's browser, also an unlabeled pane and a worker. The Boss pane and every pane in the Boss workspace can change any project browser. This rule covers browser requests, size changes, close, release, restart, tab changes, page navigation and input, and bookmark changes. A refusal names the pane's workspace and the browser's project. A plain terminal outside Herdr skips the check with a warning.

| Command | Action |
|---|---|
| `browser request SLUG [--headless\|--visible] [--reserve] [--full]` | Launch the project browser in headless mode. Visible mode needs `browser.allowVisible` on. From a Herdr pane, request the browser of your workspace's project, or use the Boss. `--reserve` assigns the port and profile only. |
| `browser list` | All project browsers, ports, profiles, and state. |
| `browser restart SLUG --headless\|--visible [--no-restore] [--allow-unknown-clients]` | Close and relaunch in the chosen mode. Visible mode needs `browser.allowVisible` on. Use it for a browser in the state `not responding`; the notice to the project lead names the command. Saved web pages and blank tabs reopen unless `--no-restore`. Restore drops query strings and fragments. It skips login and callback pages. Each tab has its own window. The command waits up to 30 seconds for a browser command to finish. It refuses with exit code 3 if a command still runs. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser close SLUG` | Close the browser. The profile and the port lease stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser release SLUG` | Remove the port lease of the project. Refuses while the project Chrome runs. The record and the profile stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser size SLUG WIDTH HEIGHT` | Window size for the next launch (320–3840 × 240–2160). From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile]` | Set one tab's real window size. Width is 200–3840, height is 150–2160, and scale is 0.5–4. Scale defaults to 1. The command resizes the tab's own window, so every CDP client sees the size. It falls back to device metrics emulation when a window resize is not possible, and it says so. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID --reset` | Restore the window to the launch size and clear any device metrics emulation. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tabs SLUG [--full]` | Tabs with ID, title, URL, visibility, and whether an agent is attached. |
| `browser tab new SLUG [URL] [--full]` | Open a tab in its own background window. Prints the ID. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tab close SLUG --tab ID [--force]` | Close a tab. Refuses a tab an agent is attached to unless `--force`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser screenshot SLUG [--tab ID] [--out DIR]` | Save a private JPEG and print its path. Use `$TMPDIR` by default, or select a directory with `--out DIR`. |
| `browser measure SLUG [--tab ID] [--selector CSS ...]` | Print page measurements as one JSON object. Give at most 10 selectors. Each selector has at most 200 characters. Each selector returns at most 20 element rectangles. The rectangle has position, size, font size, text color, background color, and visibility. The object holds the viewport, the document overflow, the visible text length, and the masked page URL. The object is at most 20 KB. When the object is larger, the command cuts the item lists and sets `truncated` to true. The command prints no page text. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser console SLUG [--tab ID] [--level error\|warn\|info\|log\|debug ...] [--last N] [--wait-ms N] [--json]` | Read console messages from one project tab. It returns the last 20 messages by default and accepts 1 to 100. It waits 1000 ms by default and accepts 0 to 10000 ms. Repeat `--level` to filter messages. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser navigate SLUG URL [--tab ID] [--full]` | Open an `http` or `https` page. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser click SLUG X% Y% [--tab ID]` | Click at a position relative to the screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser hover SLUG X% Y% [--tab ID]` | Move the mouse to a position relative to the screenshot, with no press, so a hover state or a tooltip shows for the next screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser drag SLUG X1% Y1% X2% Y2% [--tab ID] [--steps N]` | Press at the first position, move to the second, and release. `N` is the number of moves. `N` is 1 to 60 and defaults to 10. The command does not move HTML5 files. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser text SLUG --stdin [--tab ID]` | Type text from standard input. The text is not echoed. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser key SLUG KEY [--tab ID]` | Send `Tab`, `Enter`, `Backspace`, `Delete`, `Escape`, `Home`, `End`, an arrow key, or `SelectAll`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG list [--full]` | List the bookmarks and the start page of the project. A worker gets the index and the name of each bookmark only. The Owner at a plain terminal gets the full list. |
| `browser bookmarks SLUG add NAME URL` | Add one bookmark. The name has at most 60 characters. The URL must use `http` or `https` and must not hold a user name or a password. The command refuses a URL whose host part holds a scheme word, a backslash, a space, or a control character, for example `https://https://host`, and prints no URL. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG rm INDEX` | Remove the bookmark at `INDEX`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG open INDEX [--new-tab] [--full]` | Open the bookmark in the current tab, or in a new tab with `--new-tab`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG start URL\|none [--full]` | Set the start page of the next launch, or clear it with `none`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser sweep-clones [--dry-run]` | Delete orphaned Chrome code-sign clones now. Prints the count and the freed GiB. `--dry-run` lists each clone by name and age and deletes nothing. |
| `browser audit [PROJECT]` | List the last 50 independent browser launches, newest first. Add a project slug to filter the list. Read only. |

```sh
id=$(herdr-boss browser tab new example-app | jq -r .id)
herdr-boss browser navigate example-app https://example.com --tab "$id"
herdr-boss browser screenshot example-app --tab "$id"
```

The screenshot command writes under `$TMPDIR` when it is set. Otherwise, it creates a safe temporary directory. Pass `--out DIR` to choose an output directory. This option overrides `$TMPDIR` and can be used with `--tab`.

`browser measure` runs one fixed measurement script in the selected tab. The command passes the selectors as JSON data. It never concatenates a selector into the script. The command prints no page text, cookies, storage, or attribute values. The visible text length is a number only. An invalid selector returns `{ selector, error: "invalid selector" }`. A selector with no match returns `count: 0` and no items. The `count` holds every matched element. The command lists the first 20 matches as `items`. A rectangle field that is not a finite number becomes `null`. A style value that is not plain text becomes `null`. When the page cannot be measured, the command prints `The page could not be measured.` The output is at most 20 KB. When the output is larger, the command cuts the item lists first and sets `truncated` to true.

`browser console` enables the Runtime and Log domains for one tab, then reads messages for the wait window. It includes buffered Log entries when Chrome sends them. Each message has a level, timestamp, masked text, and source path with a line number. Text is at most 500 characters. The command masks bearer values, cookies, credentials, tokens, keys, long opaque strings, URL hosts, and URL queries. It prints no console object values and does not evaluate page code. Use `--json` to print the messages as JSON.

The viewport command sets the real window size, so every CDP client sees it. It falls back to emulation and says so. Headless Chrome keeps a window at least 500 px wide. For a narrower size, the command uses emulation, which only herdr-boss sessions see. The size stays active until you run `browser viewport SLUG --tab ID --reset`, close the tab, or restart the browser. `browser screenshot` captures the page at that size. The `browser size` command sets the window size for the next launch.

A project keeps at most 30 bookmarks. A bookmark URL must use `http` or `https` and must not hold a user name or a password. The start page opens in the first tab of the next launch. The bookmarks and the start page stay in the project record in `browser-sessions.json`. The output filter also masks a URL with a repeated, malformed, encoded, or missing scheme, and the host of an `ftp` or `file` URL, and any text that equals a host stored in a bookmark or start page. Store a host without a scheme in a local config.

A caller is a worker when one of `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, or `HERDR_WORKTREE` is set. For a worker, `bookmarks list`, `add`, `rm`, and `start` print the index and the name of each bookmark only. `--full` does not widen this output or a browser error message for a worker. This rule guards against accidents. It is not a security boundary, because a worker can unset the variables.

`bookmarks SLUG open INDEX --new-tab` prints one JSON object with `id` (the new tab ID), `title`, and `url`. The title and the URL are masked. The object is the same for a worker and for the Owner, and it holds no bookmark list. `--full` does not widen it for a worker. If a step fails after the command created the tab, the command closes that tab, prints a message with no URL, and exits with a non-zero code. `bookmarks SLUG open INDEX` without `--new-tab` prints one JSON object with the masked `url`.

## Orchestrator handover

| Command | Action |
|---|---|
| `handoff plan PANE --to KIND [--model M] [--effort E] [--mode migrate\|fresh] [--force --reason TEXT]` | Check the target and whether session migration is available. Write an action audit row only when `--force --reason TEXT` bypasses Opus approval or provider risk. |
| `handoff prepare PANE --to KIND [--model M] [--effort E] [--mode migrate\|fresh] [--force --reason TEXT]` | Start a successor in a new `Orchestrator Next` tab. The source keeps control. |
| `handoff cancel ID [--force]` | Expire a prepared handoff. Close its pane only when it is not the source pane, its agent matches the target kind, and its label is not `orch` or `boss`. The agent must be idle or done unless you pass `--force`. |
| `handoff activate ID --confirmed` | Label a project successor `orch` and name its agent `<slug>-orch`. Label a Boss successor `boss` and name its agent `boss`. Clear the new name from the source agent first when it uses that name. Label the source pane `orch previous` or `boss previous`. A failed pane step prints up to 20 lines of redacted stderr. A failed agent rename keeps activation active and prints a command to run by hand. Codex, Pi, and OpenCode get the goal in the successor prompt, so activation does not check or send it again. For Claude, activation checks whether the successor shows the prepared goal. It uses `goal set` with a 90-second wait and two attempts when the goal is missing. If the goal was already sent by the engine, activation only checks the screen and records a warning when the goal is missing. Exit code 2 or 3 records a warning, leaves the engine free to try the send, and does not stop activation. Handover notices wait up to five minutes for this check, then proceed. They include a saved goal warning only while the goal remains unverified. A project handover prompts each running worker once with the line `Your orchestrator is now <slug>-orch (pane <new pane>). Send WORKER REPORT and WORKER QUESTION there.` and records the result in `workerPrompts`. A failed worker prompt is logged and does not fail the activation. Herdr Boss makes one attempt for each worker and handoff, and does not prompt that worker again. A project handover also notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner. If Herdr reports `pane_not_found` for the source pane, activation skips the source label and the source prompt. The successor prompt says that the source pane was closed before activation. |
| `handoff ready ID` | Sent by an automatic successor when it is ready. The command also accepts an automatic record in `preparing` when its successor pane runs the target kind and is idle or done; it then promotes the record to `prepared` and sets `readyAt`. |
| `handoff repair ID [--dry-run]` | Inspect one `preparing` or `prepared` record. Promote a `preparing` record to `prepared` when its successor pane runs the target kind and is idle or done. It never sets `readyAt`, prompts nobody, and activates nobody. An already `prepared` record is a successful no-op, and the command does not read the pane. It does nothing for another status. A dry run prints the result, names what it would do, performs no writable-data probe, and writes nothing. The exit status is 0 for a repair, an eligible dry run, and an already prepared no-op. It is 1 for a refused status, a successor pane that is absent, runs another agent, or is not idle or done, a concurrent change during the repair, and a refused dry run. |
| `handoff list` | All handover records. Status can be `preparing`, `prepared`, `needs-inspection`, `active`, `superseded`, or `expired`. A prepared project record without `readyAt` expires 30 minutes after preparation. This rule applies to manual and automatic handovers. Herdr Boss sends one prompt to the Boss. This expiry creates no Owner Mailbox item. It closes the successor pane only when it runs the expected agent, is idle, and is not the source pane or in use by another handover. |

After resource transfer, a handover removes each empty repository or machine lock directory that it touched. It uses `rmdir` only. It keeps a non-empty directory, an untouched directory, and the data directory’s `locks` root.

The engine checks readiness for every prepared successor, even when automatic handover is off. The successor must be idle or done at least 120 seconds after its prompt, with evidence that it started its state read. A Claude pane must show its input prompt. Real unsent input blocks readiness. The engine sends Enter once for that input. It then waits at least 20 seconds for new start evidence. After each wait it reads the screen again. When the input still holds typed text, it sends Enter again, at most 3 retries after the first Enter. After the last retry it waits 20 seconds and reads the screen. When the input still holds typed text, the engine sends the Boss one notice with the pane and the command `herdr agent read PANE`. When the input is cleared, the engine sends no notice. Typed text includes a long prompt that wraps over many lines, a prompt whose first line scrolled off the pane, and a dim `[Pasted text #N]` placeholder. A dialog with numbered choices and a blank pane get no Enter. Readiness sets `readyAt` only. A manual successor still needs `handoff activate ID --confirmed`.

The engine also promotes a record in `preparing` to `prepared` when its successor pane runs the target kind and is idle or done. A `done` pane finished its turn with its input ready, so it is as ready as an idle pane. An interrupted preparation leaves such a record. The promotion uses the same guard as `handoff ready` and `handoff repair`. It never sets `readyAt` and never activates. The engine logs one reason for each record that stays preparing, and repeats the reason only when it changes. A project record that is still `preparing` 10 minutes after preparation gets one Boss notice. The notice names the accurate reason first. The reason is `the successor pane is absent`, `the successor pane does not run the target agent`, or `the successor pane is not idle or done yet`. The notice gives `herdr agent read PANE` only when the pane exists. The notice says that the engine promotes the record on its own once the pane runs the target kind and is idle or done. It gives `herdr-boss handoff repair ID --dry-run` to inspect the record, and `herdr-boss handoff repair ID` only after that. It gives `herdr-boss handoff cancel ID` as an optional way to drop the record. If the Boss pane is absent or the prompt fails, Herdr Boss retries every 5 minutes, up to 3 failures. It logs one error when it stops retrying.

An automatic handover selects the successor kind from the succession ladder with the weekly usage of each lane. Herdr Boss refuses a Codex successor above 85 percent weekly use. It refuses a Claude successor only at 100 percent weekly use. It prefers the eligible lane with the lowest weekly use, and a lane without a weekly reading counts as unused. An explicit `--to` from a person stays the target; the quota limits apply to the automatic choice only. The plan output and the handoff record carry `weeklyUsePercent` and `successorReason`.

The automatic choice never picks a model of a weaker tier than the source orchestrator. The tiers are the ranks in `kit/models.md`. An unknown tier is never equal or stronger. A model that the kit does not rank is never chosen, and a source model that the kit does not rank gives no automatic successor. An equal tier is allowed. When no equal or stronger choice is usable, Herdr Boss prepares no successor. It posts one Mailbox item in the Boss thread. The item is titled `No automatic successor for LABEL` and names the reason for each skipped choice. The source orchestrator keeps control. A person who passes `--to` still gets the target.

The automatic choice also skips a harness and model for `handoff.autoCooldownHours` hours (default 6, range 1 to 72). A kind is in cooldown when an automatic record of that kind expired or was cancelled with no `readyAt` in that time. A record that had `readyAt` and went unused does not count. A record that an activated successor replaced does not count. A kind is also in cooldown when such a record is `prepared` with no `readyAt` for more than 30 minutes. A record that is `preparing` with no `promptAt` for more than 30 minutes counts as expired. The engine passes the skipped kinds to `handoff prepare` with the internal option `--choice-reason TEXT` together with `--auto`. The command appends the text to `successorReason` in the record, for example `skipped codex gpt-6-astra: its automatic successor expired 3 hours ago`.

The bootstrap prompt of a prepared successor caps its discovery read. It tells the successor to read only three sources: the memory file, the published project status, and the open items in that status. It does not ask the successor to read the Herdr Boss bulletin, the repository, or any history during the bootstrap. The prompt holds three generated sections after that read: **Boss rules** from the `bossRules` policy field, **Pane map** from the agent roster and the project registry, and **Open items** with the open Mailbox items of the project, the published tasks that wait on a Mailbox item, and the Owner decisions of the last 48 hours in the memory file. Each section has its own character limit. The three sources stay the sources of truth. See [Handover](reference/handover.md).

An idle or done project successor that stays unready 10 minutes after its prompt gets one Boss notice. This notice covers project records only. A record with a failed prepare prompt gets no notice. The notice gives `herdr agent read PANE` and `herdr-boss handoff activate ID --confirmed`. If the Boss pane is absent or the prompt fails, Herdr Boss retries every 5 minutes, up to 3 failures. It logs one error when it stops retrying.

At 30 minutes after preparation, an unready project successor expires. The Boss notice names the ID, pane, and project and says `expired after 30 minutes unready`. A recorded Mailbox notice from an earlier version counts as delivered. Herdr Boss also skips the notice for a record that expired more than 1 hour ago. The pane-close checks still run for those records. A failed expiry notice or pane close retries every 5 minutes, up to 3 failures.

Without `--model`, plan and prepare use the target kind's default model from `kit/models.json`. The policy field `preferredModels` does not replace this default. The result has `modelSource: "default"`; a model passed with `--model` has `modelSource: "flag"`.

The model `claude-opus-5-5` and the aliases `opus`, `opus-5-5`, and `claude-opus` need the Owner's approval. Handoff uses the same case folding and bracket-suffix removal as worker start. After approval, run plan or prepare with `--force --reason TEXT`. The reason must have 1 to 300 characters. Herdr Boss redacts it and writes an action audit row when the command bypasses Opus approval or provider risk. A forced Opus prepare sends the Boss the same one-line alert as a forced Opus worker start.

`--mode migrate` (the default) converts the session with `session-migrate`. If migration is unavailable or transfer fails, preparation uses fresh mode and records the reason. `--mode fresh` starts the successor without a migrated session.

`handoff cancel` accepts a `preparing`, `prepared`, or `needs-inspection` record. It marks the record `expired` with reason `cancelled` and prints one line. It leaves the pane open when the pane is the source, its agent does not match `toKind`, or its label is `orch` or `boss`. It closes an eligible successor only when its agent is idle or done, unless you pass `--force`. It re-reads the record before saving so a concurrent activation or expiry is not overwritten. It refuses an active or expired record. A cancelled record does not get the 30-minute expiry Mailbox item.

Automatic handover prefers an eligible non-Opus rung over an Opus rung. If Opus is the only eligible choice, the engine skips automatic preparation and sends the Boss one approval notice for that handover key. The notice gives the `handoff prepare` command with `--force --reason TEXT` for the Owner to run after approval.

`handoff plan` reports when Claude session migration is unavailable because the active graph has an ancestry cycle. `handoff prepare` then uses fresh mode automatically.

`handoff plan` measures the migrated session before it reports migration as available. After a successful dry run, it runs the same transfer with `--home` set to a new temporary directory under the system temporary directory. It adds the byte sizes of the `.jsonl` files in that directory and then deletes the directory. The estimate is one token for each 4 bytes, rounded up. The migrated session fits when the estimate is at most 60% of the target window. `migration.fit` records `bytes`, `estimatedTokens`, `contextTokens`, `limitTokens`, `fits`, and `sizeKnown`. When the session does not fit, the plan sets `migration.available` to `false` with this error: `Migrated session is too large for the target window: about N tokens against a limit of M.` `handoff prepare` then uses fresh mode and records the same text in `migrationFallbackReason`. The successor prompt at activation includes that reason.

A live source session can change while `session-migrate` reads it. A failed measuring transfer therefore runs one more time. If the second attempt also fails, `migration.fit.sizeKnown` is `false`. Migration stays available, and `migration.warning` says that the size is unknown. Migration also stays available with a warning when the target model has no window in `kit/models.json`.

The target window comes from `kit/models.json`. The optional `contextTokens` field of a kind gives the window in tokens. The optional `contextTokensByModel` object of a kind gives the window for one model and overrides `contextTokens`. Each value must be a positive integer. `claude` and `codex` set `contextTokens` to `200000`.

After activation, the engine finishes the handover on each tick. The successor is confirmed when it works and then settles (it answered the activation prompt), or when 15 minutes pass with the old pane `idle` or `done`. After confirmation, Herdr Boss closes the old pane when it has been `idle` or `done` for 60 seconds. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. Herdr Boss never closes an old pane that works, is blocked, or has been settled for less than 60 seconds. It also keeps a pane whose label is not `orch previous`. The Boss note after 60 minutes names each reason. A running worker does not keep the old pane open. It renames only the live tab of the successor pane, never a recorded tab id. It merges the `finish` fields into the current `handoffs.json`, so a concurrent CLI write stays. A Boss record gets no `finish` object: the Owner closes the old Boss pane and keeps the tab name by hand, and Herdr Boss closes no unused Boss successor. It retries on each tick. If the old pane is still busy 60 minutes after activation, Herdr Boss sends one line to the pane labeled `boss`. The record field `finish` holds `plannedAt`, `workedAt`, `confirmedAt`, `confirmedBy` (`answered` or `timeout`), `closedAt`, `tabRenamedAt`, and `doneAt`. A successor that expires without activation, or that another successor replaces for the same source, keeps its tab until the next tick. Herdr Boss then closes that tab, or the pane when the tab holds other panes. It never closes a labeled pane. If the early close did not run, Herdr Boss closes the old pane after 120 minutes when the current pane list confirms both pane roles. A later handover can mark the record as superseded. The old pane stays eligible for retirement, and Herdr Boss follows the successor chain to the current active pane. Unavailable pane data defers retirement to a later engine tick. The current successor receives one retirement notice.

Preparation copies the optional top-level `goal` from the latest published project status into `ownerGoal` in the handoff record and successor prompt. The goal must be a non-empty string of at most 1000 characters. An invalid published goal is omitted, and preparation continues without it. A Boss handoff has no project goal. Preparation also stores the goal on the record as `goal`. The field `goalSource` is `status`, `transcript`, or `default`. Use the published goal, else the last `/goal` command in the tail of the source session transcript, else the `defaultOrchestratorGoal` policy field (orchestrators only). The goal has at most 4000 characters and no control characters. A prepared successor prompt carries the goal as plain text. It never starts a `/goal` command. After activation, Claude gets the goal as plain text by default. When `goals.autoCommand` is on, the engine sends `/goal <text>` to a Claude successor once when it answers, marks `goalSentAt`, and checks the pane text twice. A successor of another harness always gets the goal as plain text in the activation prompt. The successor reads the applicable memory file first: `docs/orchestration/memory.md` for a project, or `~/.herdr-boss/boss-memory.md` for the Boss. After the memory file it reads only the published project status and the open items in it. The successor reports if the memory file is missing. Fresh preparation reads at most 200 recent lines and stores at most 20,000 characters of redacted source-pane text. Both caps include the truncation marker. If the recent read fails, it tries the visible pane. If both reads fail, it records that context is unavailable. The successor prompt marks the snapshot as historical context. The successor only reads and reports until activation.

`handoff prepare` waits up to 90 seconds for the new pane's foreground shell and a prompt or a stable screen before it starts the agent. Ordinary `worker start` keeps its 20-second readiness wait. If agent start reports `agent_pane_busy`, handoff checks shell readiness again and retries once. It stops at an interactive question and tells you to answer it in a shell once, then retry `handoff prepare`. The new tab disables update prompts and automatic updates. Each active engine tick expires `prepared`, `preparing`, and `needs-inspection` records when a successful current pane list does not contain their successor pane. `handoff prepare` repeats this check before retrying. A failed pane list keeps those records active. A missing successor pane is not closed. The 30-minute timeout for a project successor that is not ready uses the rule in the handover guide.

When the target kind is `codex`, `handoff prepare` adds one `-c shell_environment_policy.set.NAME="VALUE"` pair to the agent launch arguments for each known value. A migrated session gets the same pairs after its resume arguments. The names are `HERDR_ENV` with the value `1`, and `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` of the successor pane. `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, and `TMPDIR` come from the environment of the caller. The command leaves out each unknown or empty value. A Codex tool shell can run under a shared app-server daemon with a different environment. These pairs let the successor run Herdr commands. The other target kinds get no pairs. If a caller value has a quote, a backslash, or a control character, `handoff prepare` stops before it creates a tab or a record. The error names the variable and does not show its value.

When the target kind is `opencode`, `handoff prepare` checks the installed TUI once, in the same way as `worker start`. A TUI that accepts `--model` and `--agent` gets those launch arguments. A TUI that rejects them gets no launch arguments. For a TUI that rejects them, the successor needs a project config. When the successor working folder already holds `opencode.json`, the command refuses before it creates the tab. The error names the file and says to move it aside or to start the successor with another `--to kind`. The command never overwrites the file. When the folder holds no file, the command writes `opencode.json` there. That file sets `model` to the chosen model and `default_agent` to `worker`. The command adds `/opencode.json` to the Git exclude, so the file stays out of the commit. The file holds no secret. When the handoff fails to start, the command removes the file that it wrote. After the agent start, the command polls the successor pane for up to 5 seconds. A pane that shows `Unrecognized flag: FLAG` fails the command. The message names the flag. The record stays `needs-inspection`, and the command marks no model unavailable.

`handoff prepare`, `handoff activate`, `handoff ready`, and `handoff repair` write to the Herdr Boss data directory. `handoff repair --dry-run` writes nothing. Each writing command first creates and deletes a probe file in that directory. A sandbox can refuse this write. The command then stops before it calls Herdr or changes a record. It exits with code 77 and prints this message:

```text
Herdr Boss cannot write to <dir> (<code>). A sandbox blocks this write. Run the same command again outside the sandbox (an escalated run).
```

`<code>` is `EPERM`, `EACCES`, or `EROFS`. Run the same command again outside the sandbox. Every other command prints the same message and exits with code 77 when one of these errors occurs on a path in the data directory.

Herdr Boss derives a Herdr-safe agent name from each handoff record ID. Use the record ID with `handoff ready` and `handoff activate`.

If a `needs-inspection` record still has a pane in the current Herdr pane list, repeat `handoff prepare` for the same source pane, target kind, and mode. It waits for readiness and starts the successor in that pane. It keeps the existing handoff record and pane. If the pane does not become ready, the record stays `needs-inspection` and the command reports the readiness error. If a successful current pane list proves that the pane is absent, the record expires and prepare can create a new successor.

## Factory hosts

Warning: the registry holds the address, the user, and the key file path of each host. Do not paste them into a chat, a report, or a commit.

### Commands

```
herdr-boss factory host add NAME --address ADDR --user USER --key-file PATH [--from-file FILE|-] [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]
herdr-boss factory host add NAME --docker-context CONTEXT [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]
herdr-boss factory host add NAME [--runtime RUNTIME] [--personal-only true|false] [--codex-sandbox user-namespaces|unavailable]
herdr-boss factory host list
herdr-boss factory host remove NAME
herdr-boss factory ssh HOST -- COMMAND...
herdr-boss factory docker HOST -- ARGS...
```

`factory host add` stores the name, the address, the user, and the key file path in `registry.json`. It also stores the host runtime, the personal-only flag, and the Codex sandbox setting. The folder is `~/.herdr-factories`. Set `HERDR_FACTORIES_DIR` to use another folder. Herdr Boss creates the folder with mode 700 and the file with mode 600. The key file path is a path only. Herdr Boss never reads the key file. Only `ssh -i` reads it.

To keep the address out of the shell history, give the fields as JSON with `--from-file FILE`, with `--from-file -`, or on stdin. The connection fields are `address`, `user`, and `keyFile`. The optional settings are `runtime`, `personalOnly`, and `codexSandbox`. A flag overrides the same field in the JSON. The name uses lower case letters, digits, and hyphens.

`factory host list` prints the name and the user of each host. It never prints the address or the key file path. It does not list the `local` entry that holds the local builder name. The registry commands change `registry.json` under a lock file. A lock is stale when its owner process is gone or the file is older than 60 seconds. The tool removes a stale lock. `factory host remove NAME` deletes the host.

`--docker-context` stores a Docker context name in the private connection record. With this option, `host add` updates an existing record and keeps its SSH fields. Runtime, personal-only, and Codex sandbox settings can also be updated on an existing host. A new context record needs no key path. `factory docker` uses `docker --context` when this field exists. It keeps the earlier SSH method when the field is absent. The first word after `--` must not start with `-`. The command refuses `--context other` and similar options. A command has a 30-minute limit. Output masks the context name, `ts.net` names, endpoint URLs, and the `Name:` line. Docker runs with `--context`, and the tool removes `DOCKER_HOST` and `DOCKER_CONTEXT` from the child environment. The local host uses `--context orbstack`.

## Container factories

`factory configure NAME` sets up the harness files inside the factory at the service step. `factory update NAME --tier service` runs the same setup after `kit install`. Setup adds the Codex writable roots and fills the Codex rules with the numeric user ID of the factory user. It adds the Claude autoMode lines and the Pi guard extension from the kit templates. It keeps other Codex settings and Claude settings. It refuses conflicting Codex rules. It runs `harness sync` inside the factory. Output gives the count and names of changed items. It shows no file content. Harness logins still require the Owner terminal.

Run `herdr-boss claude-statusline` only as the Claude Code status line of a factory user. The factory container start script sets it. Do not set it in the Claude settings on the Mac. The command reads the status line JSON on stdin, up to 256 KiB. It keeps `rate_limits.five_hour` and `rate_limits.seven_day` (the used percentage and the reset time) and the time of the report. It writes them with mode 0600 and an atomic rename to `claude-rate-limits/<session id>.json` in the data folder. It removes reading files older than seven days. It writes nothing when the input has no usable usage window. It prints an empty line and always exits 0, so a failure never breaks the Claude session. The setting `factories.claudeUsageHelper` (default on) controls whether the helper is installed. The container start script, `herdr-boss factory configure NAME`, and `herdr-boss factory update NAME --tier service` run `herdr-boss claude-helper --apply` in the container as the factory user. The command refuses to run outside a factory container: it prints one line, changes nothing, and exits with code 1. The host step runs it inside the container. The command installs or repairs the `statusLine` entry in `~/.claude/settings.json` of the factory user. An entry counts as the entry of the helper when its command runs `herdr-boss claude-statusline`, with any path prefix and any extra key. The command repairs an older entry of the helper to the current command. It changes no other key. It prints one state word: `installed`, `unchanged`, `removed`, `off`, `foreign`, or `unreadable`. A second run prints `unchanged` and writes nothing. The command never replaces a `statusLine` that the factory user set and makes no backup of it. In that case the word is `foreign`. When the setting is off, the command installs nothing and removes only the entry of the helper. The host tool prints one line, for example `Claude usage helper: installed.` A failure prints `Claude usage helper: not applied, REASON.` The failure never changes the exit code of the configure step or the service update. The step never reads or writes a Claude file on the Mac. The container reads the setting from its own `config.json`. Set it in the Settings or the `config.json` of the factory. The value on the Mac does not reach a factory.

`herdr-boss codexbar-install --apply` installs or repairs the pinned CodexBar CLI in `~/.local/bin/codexbar` of the factory user. `herdr-boss factory configure NAME` and `herdr-boss factory update NAME --tier service` run it in the container as the factory user. The command refuses to run outside a factory container: it prints one line, changes nothing, and exits with code 1. The command checks the installed version against the pin in `factory/pins.json`. When the version differs, it downloads the tarball of the architecture from the pinned release, verifies its SHA-256, and refuses on a mismatch. It writes `~/.config/codexbar/config.json` with mode 0600 and the providers `codex`, `claude`, and `opencodego`, each with the source `auto`. It keeps an `apiKey` that the file already holds. It prints one state word: `installed`, `unchanged`, `download-failed`, `hash-mismatch`, `unsupported-architecture`, or `no-network`. A second run prints `unchanged` and writes nothing. The host tool prints one line, for example `CodexBar: installed 0.72.0.` A failure prints `CodexBar: not installed, REASON.` and never changes the exit code of the configure step or the service update. The command reads no login file and prints no file content.

Run the host tool outside a container. The minimum factory version is `0.1.0`. The fleet value `minimumFactoryVersion` can raise this floor. It cannot lower it. The first release creates personal factories only. It refuses client factories on a personal-use runtime.

The dashboard page **Add a host** (`/fleet/add-host`, under Fleet) walks through the preparation of a host. It has a list of steps for Windows with WSL2, Linux, and Mac with OrbStack. The step names of the Windows list are the step names of [the Windows host runbook](windows-host.md). The page saves its progress in `host-guide/LABEL.json` in the Herdr Boss data directory, with mode 600. It holds the values that you type and never a secret. The button **Test from this machine** runs the host checks through `factory ssh` and `factory docker` for the host `LABEL` in the registry. The routes are `GET /api/host-guide`, `GET|PUT|DELETE /api/host-guide/LABEL`, `POST /api/host-guide/LABEL/check`, and `POST /api/host-guide/LABEL/action`. Every route needs the Owner session, also a read, because a guide holds the tailnet name and account names. A session with a token only gets 403. The read-only preview refuses all of these routes. When a `factory` command fails because the host does not answer, SSH or Docker does not start, or the host has no record, the command prints one more line that names the page.

Each host stores its Codex sandbox setting. `user-namespaces` selects the tested custom seccomp profile with `systempaths=unconfined`. `unavailable` keeps Docker's default seccomp profile and excludes Codex from that factory. A remote host with no setting defaults to `unavailable`. Set `user-namespaces` only after a sandbox check passes on that host.

After it creates a factory, `factory new` prints a Tailscale tag, policy lines, and a command for the host. Paste the lines into the tailnet policy file. Run the printed command on the host and approve the tag when the factory joins. The command does not change the tailnet. Port 443 is the HTTPS port of Tailscale Serve. A personal-only host has no client-factory grant.

The output also gives an alternative for one shared `tag:factory` with `acls`. That block includes ports 22, 443, 4477, and 4478 in its rule and its `tests` line. Use one policy form. Merge its entries into the existing policy. Keep the other rules. See the Windows host runbook below for the shared tag form.

```sh
herdr-boss factory new NAME [--host HOST] [--profile personal] [--image TAG] [--dashboard-port PORT] [--ssh-port PORT]
herdr-boss factory build NAME [--host HOST] [--image TAG]
herdr-boss factory start NAME
herdr-boss factory stop NAME [--now]
herdr-boss factory update NAME --tier service|image [--dry-run] [--accept-data-loss] [--allow-boss-restart]
herdr-boss factory backup NAME [--file FILE] [--include-home]
herdr-boss factory restore FILE [--host HOST]
herdr-boss factory destroy NAME
herdr-boss factory shell NAME [-- COMMAND...]
herdr-boss factory logs NAME [--tail COUNT]
herdr-boss factory freeze NAME [--off]
herdr-boss factory status NAME [--json]
herdr-boss factory list [--json]
herdr-boss factory configure NAME [--resume] [--step STEP]
herdr-boss factory login NAME claude|codex|opencode
herdr-boss factory boss start NAME [--harness claude|codex] [--resume] [--dry-run]
herdr-boss factory connect NAME
herdr-boss factory connect --check NAME
herdr-boss factory connect --undo NAME
herdr-boss factory attach NAME
herdr-boss factory attach NAME --undo
```

If `NAME` names a private host connection, `new` uses that host. Otherwise it uses local Docker. Use `--host` to select a host explicitly. The local host needs no connection record.

`new` creates four named volumes, creates the container, starts it, and checks through the service step. Each created resource has the factory label and the worker label. The dashboard and SSH ports bind to loopback only. The first dashboard port is 4478. The first SSH port is 2222. The tool assigns different ports to factories on the same host. Each factory has the hostname `NAME.localhost`.

The local factory has a 4 GB memory limit. A remote factory has an 8 GB limit. Both have four CPUs, a process limit of 512, 1 GB of shared memory, and bounded Docker logs. No host folder or Docker socket is mounted. No capability is added.

The default image tag is `herdr-boss-factory:<pins hash>`. The tool reuses that image when it exists. Otherwise it builds the pinned image in a temporary folder. The seed checkout comes from `HEAD`. Uncommitted source changes do not enter the image. `factory build NAME --image TAG` refuses a tag that exists and has no factory build metadata. Each host has a dedicated builder and a labeled BuildKit container. The BuildKit container has CPU, memory, and process limits, and its image comes from `factory/pins.json`. The builder uses the remote driver with `docker-container://`. Its name stays in the private connection store. The tool does not change the current Docker context or the selected builder. It leaves the builder container intact.

The private connection file is `registry.json`. The fleet file is `fleet.json`. Each factory has `factory.json` and `flow.json` in its own folder. The tool writes files with mode 600. The fleet file holds a connection reference, with no address, key path, or Docker context name. `factory list --json` prints only the contract fields of each host, also for an old inline record. It skips invalid factory rows and prints each row's field diagnostic to stderr. It does not rewrite the file. `new` checks the container settings before each start, also when it resumes. Do not put these runtime files in a repository.

`status` shows the container state, health, service schema, kit revision, factory version, running service commit, checkout `HEAD`, image build date, pins hash, running container image ID, tag image ID, live Boss pane state, active worker count, and disk use. The service commit was read when the service started. `checkoutHead` is the current Git `HEAD`. A difference means the checkout changed after the service started. The two image IDs show whether the running container uses its recorded image tag. An unavailable reading is `null`. A remote timeout reports `host-unreachable`. This state differs from a stopped or unhealthy container. Normal remote Docker calls have a 15-second limit. Builds have a longer limit. A service check retries only while it fails.

`configure` checks `container`, `volumes`, `herdr`, and `service` in order. It checks finished steps again before it skips their work. `--resume` retains the flow record. `--step service` stops after the service check and exits 0. The container check rejects host mounts, host devices, a host PID, network, IPC, or user namespace, an unconfined AppArmor profile, added capabilities, a privileged container, and a missing Codex security profile. A failed safety check disables Codex in that factory policy.

The service check measures `/api/health` through container loopback. It also checks the factory hostname. A hostname response of 401 means the host rule accepts the name and requires a login. The wizard keeps that login requirement.

`connect` makes a registered container factory available to Fleet. Run it first for one factory. Check the result before you connect the next factory. The command gets the stable factory ID from the factory. It sets the dashboard base URL and imports a read credential through the private fleet command. The credential files have mode 600. The command prints no credential, address, key path, or Docker context name.

The command uses `tailscale serve` in the WSL distribution. It forwards to the container loopback dashboard port. It reuses a matching HTTPS route. It replaces a matching plain HTTP route with HTTPS on port 443. It refuses a listener that belongs to another Serve route. It registers only the HTTPS dashboard address. It runs Serve as the factory SSH user. It never runs a command with root rights.

If Serve refuses the change with an access denied message, `connect` prints the exact masked error and exits 3. The connection waits for the Owner. Run these two commands in the WSL Owner terminal:

```sh
sudo tailscale serve --http=PORT off
sudo tailscale serve --bg PORT
```

Replace `PORT` with the registered loopback dashboard port. Enable HTTPS certificates in the tailnet settings. The first command removes the old HTTP listener. The second command creates the HTTPS listener on port 443. To let the host user configure Serve, run `sudo tailscale set --operator=USER`. Replace `USER` with the registered host user. Retry `factory connect NAME` after the HTTPS route exists. An existing HTTPS forward needs no operator right for this check.

`connect` saves a private progress record. Run the same command again after a failed step. It keeps one factory registration. It reuses the current private credential export in the factory. It creates a new credential only when that export is missing or no longer current. The factory retains this private export for a later resume. A new credential keeps the previous credential valid for ten minutes. Dashboard requests still need Owner access. The read credential permits only GET summary and health.

The command checks that the tailnet health route requires Owner access before it imports a credential. It enables **Poll registered factories** through the local dashboard API. It does not restart factory zero. It restarts the remote supervised service only when its allowed host list changes. `connect --check NAME` sends one summary request. It prints one line: name, state, and summary age. An unknown age prints `unknown`. Exit code 0 means that the factory answered with a valid summary. Exit code 1 means that a check or connection step failed. Exit code 3 means that the Owner must enable Serve or configure a forward. Another Serve failure, such as a stopped Tailscale daemon or a missing login, exits 1 with the code `serve-failed` and the masked error. The command does not wait for the Owner in that case. Private connection settings remain outside the dashboard because they hold connection fields.

`connect --undo NAME` reverses what `connect` created. It turns off the HTTPS listener only when `connect` created it. A connection record from an older release removes its HTTP listener instead. An HTTPS route that the Owner created stays. Undo never runs `serve reset`. It removes the allowed host entry that `connect` added, and restarts the remote supervised service. It removes the imported read credential of that factory. It turns off **Poll registered factories** when no other factory stays registered. It removes the registration from `fleet.json` as the last step. The private token export file in the factory stays. Run the command again after a failed step. A second run prints that nothing is left to undo.

`attach` connects Herdr on this Mac to a registered container factory. Run it on the Mac, after `connect` or on its own. Herdr takes an SSH target, so the command uses plain OpenSSH. It does not publish a new port.

The command does these steps. Each step has a check.

1. It checks the host record. A space, a quote, a backslash, a newline, or a NUL character in the key file path, or a bad address or user, stops the command with a plain message and writes nothing. It writes the SSH include file `~/.ssh/herdr-boss.d/hf-NAME.conf` with mode 600. Two blocks are in the file. The jump block `hfj-NAME` holds the real host. The alias block `hf-NAME` reaches the loopback SSH port of the factory as the user `factory` through `ProxyJump hfj-NAME`. The alias block sets `HostKeyAlias hf-NAME`, so each factory has its own line in `known_hosts`. The first contact uses `StrictHostKeyChecking accept-new`. The jump block keeps the real host key. Attach rewrites the include file at each run, so an old file gets the new form. Attach never edits `known_hosts`.
2. It adds the line `Include ~/.ssh/herdr-boss.d/*.conf` at the top of `~/.ssh/config`. It follows a symlink and keeps the link. It prints the line first. It saves the old file as `~/.ssh/config.herdr-boss.bak`, or as `.bak.1`, `.bak.2` when a backup exists. It never overwrites a backup. It writes an ownership marker before the change. It counts only an unindented Include line before the first `Host` or `Match` line. It adds nothing when that line exists. An unreadable config stops the command.
3. It reads the public key of the key file in the host record with `ssh-keygen -y -P ''`. A key with a passphrase fails at once. It adds that key to `/home/factory/.ssh/authorized_keys` in the container only when no line holds the same key blob. A line with options counts. A failed read of the file is an error. A missing file counts as empty. Attach records that it added the key.
4. It runs `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new hf-NAME true`. This first contact records the host key line of the alias. It then reads `herdr machine list --json`. A failed or unreadable list is an error. It reuses a machine that has the target `hf-NAME`. Otherwise it runs `herdr machine add --label NAME hf-NAME` and reads the list again. It fails when it cannot find the machine id. A saved machine with the label `NAME` and another target stops the command. Two machines with the same label stop it too. Attach records whether it created the machine.
5. It runs `herdr machine status ID --json`. It then runs `herdr --machine ID workspace list`. The second command is the required API check. It works inside a Herdr pane.
6. Outside a Herdr pane, it also runs `TERM=xterm-256color herdr --remote hf-NAME` with an 8-second limit. The command stops the process group at the limit. This check is optional. A failure does not change the exit code. A run that reaches the limit is reported as inconclusive. Inside a Herdr pane the check is skipped, because a nested Herdr is off by default.

Exit code 0 means that all checks passed. Exit code 1 means that a step failed. The message names the step (`ssh check`, `machine list`, `add`, `status`, `api check`, or `remove`) and shows the masked output of the failing command. It holds no address, host name, user, port, key path, or key content. The label of an existing machine is shown only when it equals the factory name. When ssh reports a changed host key, the message says: `The host key of hf-NAME changed. If you rebuilt the factory, remove the old line with: ssh-keygen -R hf-NAME`. Run the command again after you fix the cause. It keeps one include file and one machine.

The output has the alias, the sidebar label, and the detach command. Herdr shows the factory in the sidebar under the label `NAME`.

`attach NAME --undo` reads the attach record of the factory. The factory does not need to stay in the fleet registry. It removes the Herdr machine only when attach created it. A machine that attach reused stays. It removes the Mac key line only when attach added it, and says plainly when the key stays. It removes the include file. It removes the Include line only when the ownership marker exists and no other factory include file stays. It removes an empty `~/.ssh/config` only when attach created that file. It never changes another SSH entry or another Herdr machine. A failed machine list stops the undo and keeps the record. A second run prints that nothing is left to undo.

The Fleet page shows `Attach: attached` or `Attach: not attached` under each remote factory name. A copy button copies `herdr-boss factory attach NAME`. Each alert shows its fix behind a `Fix` control. A fix can be a command or an instruction in words. The copy button copies the displayed fix. A login fix of a container factory is the exact command. A native login fix is an instruction in words. A host action, for example Factory update, shows the exact command in a confirm sheet with `Confirm copy` and `Cancel`. The page shows no host detail and runs no command.

A verified Owner wait shows `Waiting for you: login-HARNESS` in the factory card of the waiting factory. The factory adds the step only after its own login check reads `expired`. The line shows the wait age. A container factory shows `herdr-boss factory login NAME HARNESS` with a copy button. A native factory shows `Sign in HARNESS in a terminal on this Mac.`. The page runs no wait command. An absent Boss never creates a wait. A healthy poll never clears a wait. A wait with no known fix shows the step without a fix. When the wait age is not available, the line shows `waiting time unknown`.

The `configure` wizard checks the container, volumes, Herdr server, and service. It exits 3 and writes one Owner instruction file when those checks pass. Run `herdr-boss factory login NAME claude` or `herdr-boss factory login NAME codex` in an Owner terminal to sign in. The command runs the harness login in the labeled factory container with the terminal attached. It then checks login with a harmless command. It prepares the first-run state for that harness. It trusts the Boss folder, the work folder, and the registered project folders. It prints only `ok` or `failed` after these checks. It never captures a token.

Run `herdr-boss factory login NAME opencode` in an Owner terminal. The command runs `opencode auth login` in the labeled factory container with the terminal attached. It then checks the login with `opencode auth list`. With one or more credentials it prints `OpenCode: logged in in factory NAME (N credentials)` and exits 0. Without a credential it prints the line `OpenCode: not logged in in factory NAME.` and the Owner command `herdr-boss factory login NAME opencode`, and exits 3. It prints only the credential count. It never prints a provider name, a token, or any other value from the login or the list. The `configure` wizard prints the same `not logged in` line before its exit 3 when the factory has no OpenCode credential. `factory status` prints no harness login lines.

For Claude, the command sets `hasCompletedOnboarding` and `hasTrustDialogAccepted` for the Boss folder, the work folder, and each registered project folder in `~/.claude.json`. It adds the `dark` theme only when no theme is set. For Codex, it sets each folder's `trust_level` to `trusted` in `~/.codex/config.toml`. It also sets `notice.hide_full_access_warning` to `true`. The command merges these values into the existing files as the factory user. It keeps other keys and writes with mode `0600`. It does not read or change credential files. A state file that cannot be merged makes the command fail. Use TOML tables for the Codex project and notice settings; inline tables are not supported.

Run `herdr-boss factory boss start NAME` to start the Boss session in a factory. Claude is the default agent app. The command checks the chosen login and prepares its first-run state before it starts the Boss. It installs the Herdr Boss kit when needed. It checks Herdr and creates or reuses the Boss workspace and pane. It starts the agent app with the factory Boss prompt and checks the pane for the prompt marker, `You are the Boss of this factory.` The prompt tells the Boss to write its run notes to `~/work/boss-notes/memory.md` and not to `docs/orchestration/memory.md` in the repository. `--resume` continues when the idle Boss pane has an agent for the selected agent app. A live pane with the marker gets no second prompt. When an idle Claude pane shows an empty input prompt and no marker, the command sends the role prompt and waits for the marker. It prints `prompt delivered` when the marker appears. It exits with `prompt not delivered` when the marker does not appear. An unknown pane without a usable capture does not count as a successful start. The command also sets the Git identity of the factory user: `user.name` is `Herdr Factory` and `user.email` is `factory@localhost.invalid`. It sets each value only when the value is missing. `factory login` sets the same values after it prepares the first-run state. The first commit of `project new` needs this identity. `--dry-run` prints the call plan and changes nothing. If login is missing, the command exits 3 and posts one Mailbox item with the `factory login` command. Do not send a code or token to a pane or a Mailbox answer. An unsent Boss prompt also exits 3 and posts one Mailbox item with the resume command.

The command skips each registered project outside `/home/factory/work`. It prints a warning. It does not trust the project or install kit files in that path. Run `herdr-boss project unregister <slug>` to remove only its registry row. The command writes a backup first. It does not delete project files, worktrees, or branches.

The command reads the Boss pane with `herdr pane read --source detection`. If that read fails, it reads the pane again without `--source`. If both reads fail, the command cannot check for a dialog. It then trusts the result of the prompt script: it fails only when the script reports no ready or unsent prompt.

If a startup dialog remains, the command fails and names the dialog and pane ID. The dialog name is `theme`, `trust`, `login`, `update`, or `unknown`. The error includes captured pane text and the prompt script's stderr. It masks tokens, home paths, host names, and addresses. Inspect that pane before you retry. The command does not send Enter to a detected startup dialog.

`factory ssh HOST -- COMMAND...` refuses a name that is not in the registry. It runs `ssh -i KEY -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new USER@ADDRESS COMMAND...`. It starts ssh with an argument list and no local shell. The remote shell reads the command words as ssh joins them. The command prints the stdout and the stderr of ssh and exits with the exit code of ssh. An ssh failure has the exit code 255. The command masks the address, the host name, every IP address, and the key file path in each output line and each error as `<host>` and `<key>`. It masks the full address before the key file name. It also masks each token that ends in `.ts.net`. The masking covers the warning lines of ssh.

`factory docker HOST -- ARGS...` uses the registered Docker context when one exists. Otherwise it runs Docker through SSH and quotes each argument for the remote shell. It has no terminal, so `docker run -it` and `docker exec -it` do not work.

A Docker context over SSH stores the address in the Docker context store. To list names only, use `docker context ls --format '{{.Name}}'`. Do not print endpoints. `factory docker` is the supported agent route.

An IPv6 token must have `::` or eight hex groups. Clock times remain visible.

Use [the Windows host runbook](windows-host.md) to set up WSL2, systemd, Docker Engine, key login, Tailscale, and the Windows boot task. The image spike uses an approved Docker context. List only its name with `docker context ls --format '{{.Name}}'`. Keep the real name outside reports and the repository.

### Windows host runbook

Use placeholders only. Replace `DISTRO`, `HOST`, `CONTEXT`, `USER`, `NAME`, `PORT`, `SLUG`, and `FACTORY_ID` with your private values. `PORT` is the factory's loopback dashboard port. The first port is 4478. Keep connection values outside the repository and reports.

1. Prepare WSL2 with systemd, Docker Engine, SSH key login, and Tailscale. Follow [the Windows host steps](windows-host.md). Keep the startup task and its five-minute repeating trigger. In WSL, check `systemctl is-active docker ssh tailscaled`. Each service must show `active`.
2. Set the Tailscale tag and policy. For one shared tag, merge this block into the policy. Keep all existing rules. The source must include the Owner device and the head office. Add the head office tag to `src` when that device is tagged.

   ```json
   {
     "tagOwners": { "tag:factory": ["autogroup:admin"] },
     "acls": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:factory:22,443,4477,4478"] }
     ],
     "tests": [
       { "src": "autogroup:member", "accept": ["tag:factory:22,443,4477,4478"] }
     ]
   }
   ```

   Save the policy only after its tests pass. In the WSL Owner terminal, run `sudo tailscale up --advertise-tags=tag:factory`. Approve that tag in the Tailscale admin console. Port 22 permits host SSH. Port 443 permits HTTPS Serve. Ports 4477 and 4478 cover the dashboard ports in the shared policy. Docker must still bind the dashboard to loopback.
3. Register the private Docker context from the host tool machine. Then create the factory.

   ```sh
   herdr-boss factory host add HOST --docker-context CONTEXT --runtime docker-engine-wsl2 --personal-only true --codex-sandbox unavailable
   herdr-boss factory new NAME --host HOST --dashboard-port PORT
   herdr-boss factory status NAME
   ```

   Use `user-namespaces` only after the Codex sandbox check passes. Check service health before you continue. Run each agent app login at an Owner terminal when it is needed.
4. Enable HTTPS certificates in the tailnet settings. In the WSL Owner terminal, repair an old HTTP listener with these two commands:

   ```sh
   sudo tailscale serve --http=PORT off
   sudo tailscale serve --bg PORT
   ```

   The HTTPS listener uses port 443. It forwards to the loopback dashboard port. If the HTTP listener is absent, create the HTTPS listener with the second command. Use `sudo tailscale set --operator=USER` when the host user must manage Serve. Check the route with `tailscale serve status` at the Owner terminal. Keep its output private. The [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve) describes these listener options.
5. Connect from the host tool machine.

   ```sh
   herdr-boss factory connect NAME
   herdr-boss factory connect --check NAME
   ```

   The check must show a healthy factory. If it reports `dashboard-unreachable`, check port 443 in the rule and its tests. If it exits 3, run the printed WSL commands. Retry connect after the HTTPS route exists.
6. Update the service when the factory has no working worker, suite, push, or handover.

   ```sh
   herdr-boss factory update NAME --tier service --dry-run
   herdr-boss factory update NAME --tier service
   herdr-boss factory status NAME
   ```

   The update prints `Commit: before -> after`. Status shows `commit` for the running service and `checkoutHead` for the checkout. Check that they agree after the restart. Use the image tier only for an image change.
7. Prepare a project transfer. Register the target guidance credential through the private provisioning channel. Run `fleet guide-token rotate --out-file PRIVATE_EXPORT` in the target factory. Import it at the source with `fleet guide-token set FACTORY_ID --from-file PRIVATE_EXPORT`. Use the CLI credential procedure below. Keep the export out of reports and repositories.

   ```sh
   herdr-boss project transfer plan SLUG --to NAME
   herdr-boss project transfer start SLUG --to NAME
   ```

   Push project work and finish workers before start. The start command asks for the switch in the source Mailbox. Answer that item. Then run `herdr-boss project transfer switch SLUG --to NAME`. Use `cancel` before the switch to keep the project at the source. Check the fresh project lead at the target after an accepted switch.
8. Run a small service and Herdr smoke test. Use a new `smoke-setup` name. Create its folder under the factory work root only.

   ```sh
   herdr-boss factory shell NAME -- curl -fsS http://127.0.0.1:4477/api/health
   herdr-boss factory shell NAME -- herdr status server
   herdr-boss factory shell NAME -- mkdir /home/factory/work/smoke-setup
   herdr-boss factory shell NAME -- herdr workspace create --cwd /home/factory/work/smoke-setup --label smoke-setup --no-focus
   herdr-boss factory clean-smoke NAME --dry-run
   herdr-boss factory clean-smoke NAME
   ```

   Health must return 200. Herdr must answer. The new workspace must appear. Read the cleanup names before you confirm. Type `clean-smoke NAME` on stdin. Run the dry-run again to check that no smoke resource remains. This test does not run the image test or a full suite.

### Clean smoke resources

```
herdr-boss factory clean-smoke NAME [--dry-run] [--yes]
```

A smoke run uses the `smoke-` prefix for its Herdr workspace label, project slug, and project folder name. Put each smoke folder directly under `/home/factory/work`. The command lists matching workspace labels, folder names, and project slugs with counts. It prints no folder path. It closes only matching workspace IDs. It removes only matching folders under that work root. It unregisters matching project records and removes their git pins. It also removes stale records whose smoke folders were already deleted.

Without `--yes`, type the exact phrase `clean-smoke NAME` on stdin. A wrong or absent answer stops cleanup. `--yes` skips confirmation. `--dry-run` lists and checks the resources without confirmation or removal. The command refuses symbolic links in the work root, matching folders, or their contents. It refuses a path that resolves outside the work root. It refuses a smoke registration outside that root. It checks folders and records before it closes a workspace. A non-smoke name stays. A regular file directly in the work root stays. Run it again after a failure to finish the remaining cleanup.

### Update a factory

Use the service tier to fast-forward the `code` volume. It restarts only the Herdr Boss service. Existing panes stay available.

Before the merge, the service tier saves local changes in tracked documentation inside the factory. It puts timestamped patches in `~/work/boss-notes/update-patches/`. Each patch has mode 0600. It saves staged edits and working-file edits in separate patches when both exist. A staged patch ends in `-index.patch`. It saves the files before the backup, so a data-migration rollback keeps them. It restores the tracked files only after the backup and the fresh idle check.

The service tier appends added note lines from `docs/orchestration/memory.md` to `~/work/boss-notes/memory.md` instead of a patch. It keeps the existing factory notes. It prints each saved path. It then restores the documentation in the index and the working tree from `HEAD`. A repeated successful update copies only new local changes. A clean checkout creates no notes or patches. Untracked files stay in the checkout.

Documentation includes `.md`, `.markdown`, `.rst`, `.adoc`, and `.txt` files, and the root files `README`, `LICENSE`, and `COPYING`. A script in `docs/` is not documentation. If another tracked file has a local change, the update stops before it saves or restores any local file. The error names each file and prints an exact patch command to run inside the factory.

The generated kit files remain an exception: `docs/orchestration/herdr-boss.md`, `AGENTS.md`, and `.claude/settings.json`. The service tier saves documentation changes in these files before it restores them. It restores the generated `.claude/settings.json` without a patch. It runs `herdr-boss kit install` in the checkout after the merge.

Review a saved patch before you apply it in the factory checkout. Apply a staged patch first with `git apply --index PATCH`. Then apply its working-file patch with `git apply PATCH`. Keep factory notes in `~/work/boss-notes/memory.md`, outside the checkout.

The service tier also sets the Git identity of the factory user when it is missing, with the same values as `factory boss start`. It keeps an identity that exists.

Use the image tier to replace the labeled container on the same four volumes. Build the pinned image first with `herdr-boss factory build NAME`. The update backs up data, work, and home.

It starts fresh sessions only for active project orchestrators. A paused project stays paused. The update refuses a live Boss pane unless you add `--allow-boss-restart`. The update never starts a Boss session. When the flag allows replacement, it prints: The Boss pane is gone. Run 'herdr-boss factory boss start NAME' to start the Boss in the factory.

```sh
herdr-boss factory update NAME --tier service [--dry-run]
herdr-boss factory update NAME --tier image [--dry-run] [--allow-boss-restart]
```

The service tier installs or repairs the Claude usage helper after the service restart. See `herdr-boss claude-statusline`.

After a successful update, the command prints the short checkout commit before and after the update.

The service tier runs git as the user `factory`. If the `code` volume repository has no `origin` remote, the command adds the public Herdr Boss repository URL without credentials. It refuses a non-HTTPS URL. It refuses an existing `origin` that names another repository. An error names the failing step: `git rev-parse`, `git remote add`, `git fetch`, `git status`, `save local documentation`, `git restore`, `git merge`, `git identity`, or `restart`.

An update is refused while a worker works, a suite or push holds the full-suite lock, or a handover is prepared or in progress. `--dry-run` checks the factory and prints the selected tier without changing Docker resources.

After the backup, the tool takes a fresh work snapshot before it merges code or replaces the container. A snapshot must be no more than 15 seconds old. The tool checks for new work again. The image tier also checks for a live Boss pane. If a check fails, it resumes the factory and prints `herdr-boss factory configure NAME --resume` as the check and retry path.

The tool checks that `/api/state` returns 200 and that one clean service tick passes within 30 seconds. It rolls back a failed update when the schema has not increased.

The update stops the factory service before it backs up the factory. After a failure at any later step, including a failed stop, pause, or backup, the tool starts the service again. It then waits until the service answers `/api/health`, within the same update timeout. This check also runs after a resume or a rollback. A service that stays down is a failure.

If the service still does not answer, the error message prints the commands that start it and check it, once. The start command depends on the host of the factory. For the local host it is a plain Docker command: `docker --context orbstack exec hf-NAME /command/s6-svc -u /run/service/herdr-boss-serve`. For a registered host it is `herdr-boss factory docker HOST -- exec hf-NAME /command/s6-svc -u /run/service/herdr-boss-serve`. `HOST` is the registered host name, not the factory name. `NAME` is the factory name. The check command is `herdr-boss factory status NAME`. Retry the update only after the service writes a new state file. An old state file stops the next update with `The factory cannot prove that work is idle.` The error message prints no commands when the service answers.

If the backup helper cannot be removed, the tool keeps the container paused. The error message then prints the `docker unpause hf-NAME` command and the start command, each in the form of the host.

The service tier rolls back to the previous commit when a step after the merge fails. The rollback starts the previous service. The image tier has no rollback for a step that fails before the container changes. The tool starts the stopped service in both tiers.

If the schema increased or cannot be read after the new container starts, the tool keeps a private pending record. Review the failure, then repeat the same command with `--accept-data-loss` to restore the backup and the previous code or image. This rollback can discard data written after the backup. If the new container never starts, the tool rolls back without restoring data or asking for this flag.

### Backup and recovery

Run `factory backup NAME` before you remove a factory.
The default destination is the private connection store's `backups` folder.
Use `--file FILE` to select an absolute destination.
Use a private folder with mode 700.
Keep the folder outside every repository and cloud folder.
The command refuses a repository, a known cloud folder, and a symlink into either one.
It does not change an existing folder's permissions.
The `.hfb` file has mode 600.
The command refuses an existing file.
It prints the factory name only.
The private `backup.json` receipt records the destination and checksum.
Keep that receipt out of a repository.

The backup holds the data files and the `work` volume.
Each SQLite database in the data volume uses `VACUUM INTO`.
The helper uses a 2 GiB temporary file system for the database snapshots.
A snapshot that exceeds this limit fails the backup.
The backup excludes database journal sidecars and runtime sockets.
Add `--include-home` to include harness logins and SSH host keys.
Without that option, sign in again after a restore.
The private host connection store and the `code` volume are excluded.
Keep the matching factory image available for restore.
A restore seeds `code` from that image.
Apply later service updates again after the restore.

The backup stops a running factory for a consistent snapshot.
It removes the labeled archive helper by its exact name before it restarts that factory.
It also checks for that helper after a Docker timeout.
If helper cleanup fails, recovery stops and keeps the source stopped.
It keeps a stopped factory stopped.
It restores a paused factory to the paused state.
The command needs Docker and the factory volumes.
It does not need the Herdr Boss service.

Run `factory restore FILE [--host HOST]` at an Owner terminal.
Type the exact factory name when the command asks.
The command uses the name and ports from the backup.
It refuses an existing factory, an existing target volume, a registered port conflict, and a different image.
It validates the whole archive before it creates resources.
It restores the files, starts the factory, and checks the service.
A failed restore checks the target container and four volume names after a lost create reply.
It removes only resources with matching factory and worker labels.
It removes its archive helper before it rolls back volumes.
A different label keeps that resource unchanged.
If a helper cannot be removed, no volume rollback runs.
If a resource has different labels or the host cannot answer, the pending factory record stays available for repair.

Run `factory destroy NAME` at an Owner terminal.
Type the exact factory name when the command asks.
The command needs the recorded backup from the last 24 hours.
That backup must include home.
If it does not, back up again with `--include-home`.
It checks the archive identity and checksum again.
It checks both the factory label and the worker label on all four volumes and the container.
It stops and removes that container.
It removes only those four volumes.
It keeps the backup, image, builder, and host connection.
It runs no prune command.
If removal fails, run destroy again with typed confirmation.
It checks the labels of all remaining resources before it removes one.
A command argument cannot replace typed confirmation.

### Read or rotate a factory dashboard token

```sh
herdr-boss factory token NAME
herdr-boss factory token NAME --rotate
```

Run the command on the host tool machine in an Owner terminal.
The command requires TTYs on stdin and stdout.
It refuses `--json` and other output options.
Type the exact factory name when the command asks.
The command reads the configured `access.tokenFile` inside the factory.
The default is `/home/factory/.config/herdr-boss/access-token`.
It prints one token line at the Owner terminal.
Copy that text into the dashboard sign-in form.
Keep it out of panes, chats, logs, and reports.
The command has no clipboard option.

`--rotate` writes a new token with mode `0600` through a temporary file and rename.
Run rotation only when the factory and dashboard service are running.
Resume a paused factory first.
It removes the factory session file.
It restarts only `herdr-boss-serve`.
It waits up to 30 seconds for the new service process and `/api/health`.
It prints the token only after that check passes.
Rotation signs out all devices.

The verified Boss pane may use `--rotate` after typed confirmation.
It receives only the factory name, the time, and `signed out all devices`.
The Boss cannot read a token.
Other Herdr panes are refused.
A plain shell with no Herdr variables is the Owner terminal.
These caller checks prevent accidents and pane leaks.
A process of the same user can already read the token file.

The factory audit file is `/home/factory/.config/herdr-boss/factory-token-audit.jsonl`.
It has mode `0600`.
Each line holds the time, factory name, action, caller role, and result.
It holds no token or token hash.
A failed attempt audit stops rotation before the token changes.
If rotation stops after a write, the error prints recovery steps without a token.
Follow [the recovery steps](guide/factory.md#recover-an-incomplete-token-rotation).

### Repair a dead service

Use these commands when the service cannot answer:

```sh
herdr-boss factory logs NAME --tail 200
herdr-boss factory shell NAME
herdr-boss factory shell NAME -- COMMAND ARGUMENT...
herdr-boss factory freeze NAME
herdr-boss factory freeze NAME --off
herdr-boss factory stop NAME --now
```

`logs` reads the last 200 container log lines by default.
Use `--tail` for 1 to 10000 lines.
The output masks connection fields and recognized secret values.
`shell` opens Bash as the factory user at an Owner terminal.
Use `-- COMMAND...` for a command without an interactive terminal.
A login command needs a terminal, so `shell NAME -- COMMAND...` refuses a command that contains `auth login`, `login`, or `/login`, for example `opencode auth login`, `claude /login`, `codex login`, or `pi /login`. It refuses before it contacts the container. It prints `No terminal here. Use "herdr-boss factory shell NAME" for an interactive command.` and exits 2. Use `herdr-boss factory login NAME HARNESS` for a login.
`freeze` pauses every process in the container.
A stopped factory is already frozen.
Use `--off` to resume a paused container.
These commands bypass the service version gate.
They still check container ownership and safety.
A failed factory update prints the command that starts the service.
Run that command when the service does not answer.
Docker must be reachable.
Do not print a login file or token from a shell.

## Set the goal of an orchestrator

### Command

```
herdr-boss goal set <project|pane> [--text TEXT] [--dry-run]
```

`goal set` puts the `/goal` on a running orchestrator. A `/goal` that Herdr Boss sends to a pane that works is queued as plain text and does not run. The command therefore waits until the pane can take it.

| Argument | Meaning |
|---|---|
| `<project>` | A project slug. The command uses the pane labeled `orch` in the workspace of the project. |
| `<pane>` | A pane ID, for example `wX:p1`. The pane must be labeled `orch`. The command refuses a worker pane, the Boss pane, and a pane without an agent. |
| `--text TEXT` | The goal text. Without it, the command uses the Settings value **Default orchestrator goal**. |
| `--dry-run` | Resolve the pane, print the text and the state of the pane, and send nothing. |

The text has at most 2000 characters. A line break becomes a space. Any other control character is an error. The text `clear` is an error, because `/goal clear` removes a goal.

### Steps

1. The command checks the caller and the pane. It prints the target pane and the text.
2. The command waits until the pane can take a command. One deadline of 10 minutes from the start covers the wait and every retry. The pane can take a command in these cases: the agent status is `idle` or `done`; the screen shows the empty input prompt of the harness; no dialog is on the screen. A ghost suggestion in the input line counts as an empty input line. The command reads the pane with `--format ansi` to see the style. A ghost suggestion is text that is dim (SGR 2) with the default foreground. The style runs from the first to the last non-space character, and it sets the dim style after the prompt marker. Any other style, an unknown escape sequence, or text without a style counts as typed text. The command polls every 5 seconds and reads the pane again each time. Each blocker has a limit: `the agent works` 10 minutes, `the input box holds unsent text` 2 minutes, `a dialog is on screen` 2 minutes. `the pane is gone` and `the pane is not an orchestrator` fail at once.
3. The command sends the goal as one prompt without `--wait`. A Claude pane gets `/goal TEXT`. A pane of another harness gets the plain sentence `[herdr-boss] The current Owner goal is: TEXT`. `goals.autoCommand` does not change this manual command.
4. The command reads the screen before the send and again after it. The goal is active when its text is new on the screen. The pane must also show the goal confirmation, or the pane must be idle with an empty input line. A goal that is typed or queued in the input line, or an old identical `/goal` in the scrollback, does not count. `goalVerdict()` in `src/goal.js` decides. The command checks up to 5 times, 2 seconds apart.
5. If the goal does not show, the command waits for an idle pane again. Before each new send it checks whether the earlier goal rendered late. It sends at most 3 times.

One function gives the blocker reason. The waiting line, the dry run, the result, and the dashboard status all print it in the same words. The reason never holds pane text. The command never clears, edits, or sends into an input line that holds typed text.

When the wait fails because of `the agent works`, `the input box holds unsent text`, or `a dialog is on screen`, the command adds one Mailbox item with the action `answer` for the Owner. The item names the project, the pane ID, and the reason. For example, the item reads `Goal not set on alpha: the input box of pane wX:p1 holds unsent text. Send or clear it, then press Set goal again.` The command adds at most one item for each project and reason in one hour.

The command never sends into a pane that works, is blocked, shows a dialog, or holds typed text in its input line. The handover uses `sendGoalPrompt()` and `goalOnScreen()` from `src/goal.js`, the same functions as steps 3 and 4. The engine spreads its waits over its ticks.

### Result and exit codes

The last line states the result in plain words. A reason in parentheses can follow it.

| Exit code | Last line | Meaning |
|---|---|---|
| 0 | `goal set and active` | The pane shows the goal. A dry run also exits with 0. |
| 1 | (an error message) | Usage error, a bad text, or a refused caller. |
| 2 | `the pane stayed busy` | A blocker lasted longer than its limit, or the pane is gone or is not an orchestrator pane. The reason in parentheses names the blocker. |
| 3 | `sent but not shown` | The command sent the goal and the pane did not show it, or the deadline passed. |
| 130 | `cancelled` | SIGINT stopped the wait. If the goal was already sent, it can still be set. |

### Caller rules

A plain terminal, the Boss pane, and the orchestrator of the project may run the command. The check is the same as for `project new`. An orchestrator sets only the goal of its own workspace. A worker pane is refused.

### Dashboard route

The dashboard uses the same steps in the service.

| Route | Meaning |
|---|---|
| `POST /api/goal/set` | The body has `project` and the optional `text`. The route checks the project and the text, starts the job in the background, and returns 202 with `url` `/api/goal/status/<slug>`. At most 2 jobs run at the same time (429 above that). A second job for one project gives 409. |
| `POST /api/goal/cancel` | The body has `project`. The route stops a running job. It gives 409 when no job runs. |
| `GET /api/goal/status/<slug>` | The state of the last job of the project: `waiting`, `sending`, `verifying`, `active`, `failed`, `cancelled`, or `interrupted`. The service saves each job in `goal-jobs/<slug>.json` in the data directory (mode 0600, no pane text). A file that says running, with no job in memory, reports `interrupted`. Each `reason` has no absolute path and at most 200 characters. A `failed` job has a `reason`. The command is allowed for a paused or stood down project. A project without a job gives 404. |

The routes need the dashboard login and a same-origin request, as the project-new routes do. The read-only preview refuses the POST routes. Its status route gives 404 because the preview has no job.

## Project settings (`.herdr-boss.json`)

| Key | Default | Meaning |
|---|---|---|
| `slug` | directory name, lower case | The project slug for status and policy. |
| `baseBranch` | `main` | The base for new worker branches. |
| `worktreeRoot` | The service setting, default `~/Projects/.herdr-wt` | The parent folder of the worker worktrees. A leading `~` is the home folder. A relative path is relative to the repository. |
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

### Evidence tiers

Set `evidenceTiers` in `.herdr-boss.json` to choose which names reports and ledger entries accept. The worker brief and a collect refusal show the accepted names. This repository accepts these tiers:

- `unit`: Report a focused test or build check from the worker's final tree.
- `local-browser`: Report a browser check of a build served on this machine.
- `live-service`: Report a check of the running HerdrBoss service.
- `owner`: Report acceptance from the Owner.

## Read-only fleet

Run `herdr-boss fleet settings` to read the local factory ID and fleet settings.
Open **Fleet** in the dashboard to change the factory name, dashboard base URL, title sharing, polling, and account scopes.
A change applies to the next poll.
The poll interval is 30 seconds.
The head office reads factory records from `fleet.json` in `HERDR_FACTORIES_DIR`.
The default directory is `~/.herdr-factories`.
It does not read the private host connection file `registry.json`.

Before the first service start, run `herdr-boss fleet init --from-file FILE` with a JSON object.
Use `factoryId`, `name`, `dashboardUrl`, `headOffice`, `shareItemTitles`, and `accounts`.
Use the same `factoryId` as the factory registry record.
Set `headOffice` to `true` on factory zero.
Set it to `false` on a container factory.
A factory keeps its ID in `factory-identity.json` in its data directory.
The command refuses a different ID after initialization.
Do not copy that identity file to another factory.

Run private provisioning at an Owner terminal.
Run the `herdr-boss fleet account` command only as the Owner. The orchestrator never runs it.
Do not put an identity or a credential in a command argument, pane, report, or repository.
The `--from-file -` option reads JSON from standard input.

- `herdr-boss fleet account --from-file FILE`: Read `harness`, `identity`, `hmacKey`, and `scope`. Use at least 32 bytes for `hmacKey`. Use the same identity spelling and HMAC key on factories that share an account. `scope` is a list of factory IDs. The command stores only the HMAC digest and scope. It does not store the identity or HMAC key.
- `herdr-boss fleet read-token rotate --out-file FILE`: Create a read credential. Save it as a JSON string in a new file inside the private Herdr Boss configuration folder. The file has mode 0600. The command prints no credential. The previous credential stays valid for 10 minutes.
- `herdr-boss fleet read-token set FACTORY --from-file FILE`: Import that JSON string into the head office's private credential store. `FACTORY` is the registered factory ID. Transfer the export file through a private provisioning channel. Delete the export file on the source factory after the transfer. When `FILE` is inside the private Herdr Boss configuration folder, the command deletes `FILE` after the import. The command never deletes a file outside that folder.
- `herdr-boss fleet guide-token rotate --out-file FILE`: Create a separate guidance credential. Use a new file in the private configuration folder. The file has mode 0600. The previous credential stays valid for 10 minutes. Rotation resets the stored guidance epoch and head office holder, except on the factory that holds the head office role. It clears the nudge IDs of the old term and keeps the last accepted shares. The command prints no credential.
- `herdr-boss fleet guide-token set FACTORY --from-file FILE`: Import the guidance credential at the head office. Use the same private transfer procedure as for the read credential. The command removes an export file only when that file is in the private configuration folder.

The read credential permits only `GET /api/fleet/summary` and `GET /api/health`.
It returns 403 for every other route or method.
This restriction also applies on loopback.
Use the `Authorization: Bearer` header.
Do not put a credential in a URL.
Credentials have no dashboard field because they are secrets.

`GET /api/fleet/summary` returns contract 1.1.0 from the local factory.
`GET /api/fleet` returns the head office's last good summaries and their ages.
It adds the field `rollup` with the fleet totals and the per-factory alerts.
A failed rollup returns `rollup: null` and a short `rollupError`.
`GET /api/fleet/settings` reads the local settings and account digests.
`PUT /api/fleet/settings` replaces `name`, `dashboardUrl`, `headOffice`, `shareItemTitles`, and `accounts`.
Each account has `harness`, `accountKey`, and `scope`.
These three dashboard routes use normal Owner access.
A read-only preview refuses changes and makes no remote fleet requests.

The summary uses the existing local quota collector.
CodexBar uses the same JSON interface on Linux.
An absent reader or partial reading gives `null` and `unknown`.
An account without a provisioned identity has no shared account row. The factory still reports its own reading for that harness, with the marker `accountScope: "this-factory"`, no `accountKey`, and the card label `this factory only`. That row stays out of the fleet shared total. Provision the account with `herdr-boss fleet account --from-file FILE` to share it across factories.
Pi has no confirmed Linux quota reader in this slice.
### Factory shares and guidance

Open **Fleet** at the head office.
Set one factory share for each factory in an account scope.
Use whole percentages from 0 to 100.
The shares of one account must total at most 100.
The page and the server refuse a higher total.
Select **Save factory shares** to save the plan and send it to each factory.
A pending factory keeps its last accepted share.
The next successful summary poll retries its share delivery.
New account plans divide 100 equally across the scope.
Until the first guidance arrives, the local profile ceiling is 100.
A factory outside the account scope has a ceiling of zero.

The local pacing goal cannot exceed the factory share.
Project shares still divide the local project allocation.
Guidance does not replace project policy.
At the factory ceiling, new workers for that account stop.
Ignore quota mode, the least-over allowance, and `--force` cannot bypass this ceiling.
The factory stores its accepted shares in `fleet-guidance.json`.
It keeps them through a restart or a head office outage.
If a fleet share file is invalid, the pacing view shows the problem and the service logs one warning.
The local policy still loads with factory shares unset.
A metered worker start refuses a failed share check.
Unmetered worker starts do not read factory shares.
Repair the fleet files to clear the problem.
Quota readings are account readings.
They do not measure the use of one factory or project.

- `GET /api/fleet/shares`: Read the account scopes, share plan, and delivery state with Owner access.
- `PUT /api/fleet/shares`: Replace the complete plan with Owner access. Send an `accounts` array. Each row has `accountKey` and `shares`. Each share has `factoryId` and `share`. Include each account and each factory in its scope once.
- `POST /api/fleet/nudge`: Send a nudge with Owner access at the head office. Use `factoryId`, `nudgeId`, and `text`. Use 1 to 500 characters. The factory must be in an account scope. Reuse the same ID and text when you retry.
- `POST /api/fleet/guidance`: Accept only the `fleetGuide` bearer credential, also on loopback. Use contract 1.0.0: `schema`, `contractVersion`, `headOfficeFactoryId`, `senderEpoch`, `sentAt`, `shares`, and `nudges`. Each share has `accountKey` and `share`. Each nudge has `nudgeId` and `text`. Use a UTC `sentAt` without fractional seconds. Both arrays are required.

Send the guidance credential only over HTTPS.
HTTP is permitted only for a loopback target.
The sender refuses other HTTP targets before it sends the credential.

The factory refuses a lower sender epoch with 409.
It also refuses an epoch more than 1000 above the highest stored guidance or role epoch.
It refuses a different head office holder at the same accepted epoch.
The current role record also sets the minimum epoch.
The first head office term uses epoch 1.
To recover from an incorrect stored epoch or holder, rotate the guide credential at the receiving factory.
Rotation resets both stored epochs and holders.
It clears the nudge IDs of the old term and keeps the last accepted shares.
Import the new credential at the head office through the private provisioning procedure.
The factory checks each account against its own scope.
A nudge uses the existing service agent message path to the pane labeled `boss`.
The message and the stored text use the existing secret masking.
A repeated nudge ID at the same epoch does not send twice.
Each guidance body has at most 100 shares and 100 nudges.
One head office term accepts at most 2000 nudge IDs.
The factory refuses an additional ID when it reaches this limit.
A failed Boss delivery stays pending and retries when guidance arrives again.
If the remote request fails, select **Send nudge** again with the same text.

The guidance credential permits only `POST /api/fleet/guidance`, `POST /api/fleet/role`, `GET /api/fleet/role`, and `GET /api/fleet/handover`.
It gets 403 for policy changes, worker start or stop, message reads, and every other route or method.
The read credential gets 403 on the guidance route.
A missing guidance credential gets 401.
An invalid guidance credential gets 403.
Owner access cannot submit directly to the guidance route.
Use the head office share and nudge routes instead.
A read-only preview refuses all three write routes.

### Head office role

Each factory stores the head office factory ID and the epoch in one role record.
The file is `head-office-role.json` in the Herdr Boss data folder.
The file has mode 0600.
A factory that has head office polling on and no role record holds the role at epoch 1.
Keep head office polling off on a factory until it takes the role with `hub promote`.
Such a factory answers `hub promote` with "already holds the role" and changes nothing.

- `herdr-boss hub promote`: Take the head office role on this factory. The new epoch is the highest epoch that any registered factory reports, plus one. The command takes a lock first. A second promotion on the same factory stops with a message while the first runs. The command checks each registered factory. It refuses to start when a factory cannot be reached or has no guide credential, and it names that factory with a reason code. It refuses when a factory reports an epoch more than 1000 above the local epoch or above the median of the other reports. It refuses when the next epoch passes 9007199254740991. In each refusal it changes nothing.
- The command then writes the role record, sends it to each factory with `POST /api/fleet/role`, and turns on head office polling on this factory. If a factory answers 409, another holder exists at that epoch. The command gives the role back, probes the factories again, prints what they report, and exits with code 1. Run the command again to take a higher epoch.
- `herdr-boss hub promote --force`: Continue when a factory cannot be reached. The command lists that factory as not told. The service of the new holder sends the record to that factory after each successful poll. It stops after 20 attempts or 24 hours. The Fleet page then lists the factory as never told. Turn off head office polling on that factory.

A factory that already holds the role prints that fact and changes nothing.
The new holder needs the guide credential of each registered factory.
Import each one with `herdr-boss fleet guide-token set FACTORY --from-file FILE` before the promotion.

The registry and the factory shares move with the role.
The new holder asks the former holder for them with `GET /api/fleet/handover`.
The former holder sends only factory identities (ID, name, host ID, profile, dashboard URL, version, kit revision) and the factory share plan.
It never sends a host address, a Docker context, a connection reference, a port, or a container name.
The new holder adds each factory that its own registry lacks as a `native` record on a host that its own registry has.
A factory on a host that the new holder lacks stays out, and the command lists the host IDs.
The new holder keeps its own record when both registries have the same ID.
It writes the factory shares first, the registry second, and the role record last.
If the former holder cannot be reached, sends an invalid body, or sends a registry that conflicts with the own registry, the new holder keeps its own copy.
The result line gives the reason.

- `GET /api/fleet/role`: Read the holder, the epoch, the time of the record, whether this factory holds the role, and the factories that were never told. Only the `fleetGuide` credential is accepted. Owner access and the read credential get 401 and 403.
- `POST /api/fleet/role`: Accept a role record with the `fleetGuide` credential. Use the head office role contract 1.0.0: `schema`, `contractVersion`, `headOfficeFactoryId`, `epoch`, and `updatedAt`. The holder must be a registered factory or this factory when the registry has factories. A factory with an empty registry accepts any valid holder ID. The factory accepts a higher epoch and an exact repeat. It refuses an unregistered holder (with a non-empty registry), a lower epoch, another holder at the same epoch, and an epoch more than 1000 above the stored epoch, with 409. It refuses an invalid body with 400. A missing credential gets 401.
- `GET /api/fleet/handover`: Return the factory identities and the factory shares with the `fleetGuide` credential. Only the holder answers. Another factory gets 409.

A factory that sees a higher epoch stops polling the fleet and refuses to send guidance.
Newer head office guidance also updates the role record.
Rotation of the guide credential keeps the role record and the stored epoch on the factory that holds the role.
On another factory, rotation deletes the role record and resets the stored epoch and holder.
`GET /api/fleet` returns the same data as `role`.
The file `head-office-handover.json` lists the factories that are not yet told. It has mode 0600.
