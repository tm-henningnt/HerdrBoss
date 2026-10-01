# CLI reference

Run `herdr-boss` with no arguments to print a short usage list. Commands that change state print JSON or one status line. Errors go to standard error with a non-zero exit code.

Run project commands (`worker`, `worktree`, `ledger`, `check`, `gh`) from inside the project repository. They read `.herdr-boss.json` from the repository root.

## Service

| Command | Action |
|---|---|
| `herdr-boss install` | Install and start the macOS launchd agent `no.tallmaker.herdr-boss`. Run it again after you move the repository. |
| `herdr-boss uninstall` | Stop and remove the launchd agent. |
| `herdr-boss serve` | Run the collector and the dashboard in the foreground. |
| `herdr-boss serve --read-only-preview [--host <address>]` | Run a dashboard preview. It binds `127.0.0.1` and accepts local requests only. `--host` sets another bind address, an IP address or a host name, and works only with `--read-only-preview`. The start line prints the bind address. It allows API reads and blocks API changes, prompts, notifications, process reaping, Chrome clone sweeps, handovers, and browser launches. It never reads, creates, or changes access files. It needs a `HERDR_BOSS_DIR` that the service does not use. |
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

Seed invented Mailbox and Chat messages into a temporary data directory before the preview starts:

```sh
HOME="$(mktemp -d)" HERDR_BOSS_DIR="$(mktemp -d)" node scripts/seed-preview.js
```

The script refuses the live data directory, a directory inside it, and a symlink to it. Use the same `HERDR_BOSS_DIR` for the preview.

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
| `herdr-boss policy set FILE [--confirmed] [--allow-sum]` | Validate and replace the policy. The service applies it on the next tick. The command refuses a change of 3 or more project shares unless you add `--confirmed`. It refuses project shares that do not total 100 unless you add `--allow-sum`. The refusal prints each changed project with its old and new share, and the flag to add. A file that changes no share saves without a flag. Each write adds one line with the caller kind `cli` to `policy-changes.jsonl`. See [Policy changes](user-guide.md#policy-changes). |
| `herdr-boss usage record FILE` | Add one measured or unmeasured usage event. |
| `herdr-boss usage summary` | Usage per project and provider. |
| `herdr-boss spend [--days N] [--json]` | Token use and cost for the last N days (1 to 90, default 7). It prints one line for each day and role, then one total line for each day. The cost is in USD and carries the label `API-price equivalent`: the Owner is on a subscription and is not billed per token. `unpriced` marks tokens of a model without a price. A last line lists models with `unconfirmed` price figures. `--json` prints the full summary, with the harness split, `costLabel`, and `unconfirmedPrices`. The service updates the numbers every 5 minutes. |

## Project status

| Command | Action |
|---|---|
| `herdr-boss publish SLUG FILE [--force]` | Validate a status file and install it for `/projects/SLUG`. Use `-` for standard input. Refuse a status in which a task has a live worker but is not `doing`. `--force` skips this check. Schema: [project-status.md](project-status.md). |

`publish` reads the run records of the project in the Git top level. A worker blocks the publish when all of these are true: its run record has no `finishedAt` and no `collectedAt`, `herdr agent list` shows an agent with the worker name and the status `working` or `blocked`, the worker has no `report.json`, and the worker is not parked. Then, when its task is not `doing` in the status file, `publish` prints one line with the task ID and the worker name. It exits with code 1 and publishes nothing. Set the task to `doing`, or run `publish` again with `--force`. A task ID that is not in the status file counts as not `doing`. An idle or done agent, a parked worker, and a worker that wrote its report wait for the orchestrator, so they never block a `review` or `done` status. When Herdr fails or lists no agent, no worker blocks the publish. A run without a task ID is not checked. See [Live task state](user-guide.md#live-task-state).

`publish` also closes the open Mailbox items of the project whose task no longer has `waitingOn: owner`. It prints `Closed N Mailbox items of SLUG: the task no longer waits on the Owner.` A failed Mailbox update prints a warning and does not fail the publish.

`publish` keeps the stored status small. It keeps the newest 30 done tasks, ordered by `updated`, or by file order when `updated` is missing. It removes the older done tasks from the stored file. A done task that a kept task or an open task lists in `blockedBy` stays in the file.

The command records the ID of each removed task in `doneIds`. It sets `doneCount` to the number of unique IDs in `doneIds` plus `doneCountBase`. `doneCountBase` holds counts that have no ID: a `doneCount` from an older stored status, and IDs dropped from a full `doneIds`. A done task without an ID, or with an ID over 200 characters or with control characters, stays in the file and is not counted. `doneIds` holds at most 5000 IDs. The oldest ID leaves first and moves into `doneCountBase`. An ID that is in `tasks` again, for example an open task, leaves `doneIds`.

The orchestrator keeps its own file unchanged. Publishing the same file again leaves `doneCount` unchanged. `publish` prints one line, `moved N done tasks into doneCount`, only when N is more than 0. `publish` prints a warning, and still publishes, when the stored status is larger than 200 KB. `doneCount` and `doneCountBase` must be integers from 0 to 1000000. `doneIds` must be an array of strings.

`publish` also checks `AGENTS.md` at the Git top level of the current directory, when that file exists. It prints each finding to standard error as a warning. It publishes the status in all cases. The published record gets `agentsCheck: { checkedAt, errors, warnings, file }`. The record holds only the counts and the repository-relative file name. The project page shows a warning line when `errors` or `warnings` is more than 0. The status file can also hold `kitRevision`, the kit revision that the orchestrator loaded. The project page compares it with the current kit revision.

The first `publish` of a slug registers the project. It records `{ slug, repo, remote }` in `project-repos.json` in the data folder, with mode 0600, when the Git top level exists. `repo` is the Git top level. `remote` is the `origin` URL without a user name and a password. A later publish keeps the first record. For a new slug, `publish` runs `harness sync --codex-only` and prints its result as `warning: harness sync:` lines.

## New project flow

### Command

```
herdr-boss project new <slug> [--group DIR | --path DIR] [--remote gh|URL|none]
  [--visibility private|public] [--org NAME] [--kind claude|codex] [--goal TEXT]
  [--start] [--dry-run] [--resume]
herdr-boss project check <slug> [--fix STEP [--start]]
```

`project new` calls `runProjectNew` and prints one line for each step, the project path, and the next action. It never prints a token.

| Flag | Meaning |
|---|---|
| `--group DIR` | The group folder. The project folder is `DIR/<slug>`. |
| `--path DIR` | The project folder. Give `--group` or `--path`. There is no default folder. |
| `--remote` | `none` (default), `gh`, or a Git URL. `gh` creates a GitHub repository after an Owner decision. A URL is https, ssh, or git, or `user@host:path`. A URL must not hold a user name or a password. |
| `--visibility` | `private` (default) or `public`. `public` needs a remote that is not `none`. With `--remote gh`, `public` only offers the choice `Create public` to the Owner. |
| `--org NAME` | The organization for `--remote gh`. Without it, the repository belongs to the `gh` login. |
| `--kind` | The harness of the first orchestrator: `claude` or `codex`. It overrides the first usable entry of `orchestratorLadder`. The model comes from the policy for that kind. |
| `--goal TEXT` | One line for the README and the first status. |
| `--start` | Create the Herdr workspace and start the first orchestrator. The orchestrator uses model quota. Off by default. |
| `--dry-run` | Print each step as `would ...`. Change nothing. |
| `--resume` | Continue a saved run. |

Only the steps of `runProjectNew` that are built run. The step `check` prints `not built yet`. The values of `--remote`, `--visibility`, and `--org` control the step `remote`. The values of `--kind` and `--start` control the step `workspace`.

The step `harness` runs the Codex part of `herdr-boss harness sync` and reserves the project browser. It prints the Claude autoMode lines. It never edits `~/.claude/settings.json`. See "Step harness" below.

A step prints one state: `done`, `skipped`, `waiting`, `failed`, `pending`, `not built yet`, or, in a dry run, `would ...`.

### Step harness

The step `harness` does three things for the new project:

1. It adds the missing Codex `writable_roots` to `~/.codex/config.toml`. It writes a backup file first. It adds no root that exists.
2. It prints the Claude autoMode lines that `herdr-boss harness sync` prints. It never edits `~/.claude/settings.json`. When a line is missing, the step detail says `needs Owner action`. Add the printed lines to the file yourself.
3. It reserves the project browser, the same as `herdr-boss browser request <slug> --reserve`. It launches no browser.

A Codex root or a browser port that cannot be set is a warning in the step detail. The step does not fail. A second run changes nothing. A dry run changes and reserves nothing.

The step changes a file under the home folder only for the live data dir. A temporary data dir is not the live data dir: the same test as `assertTempDataDir`, inverted. For a temporary data dir, the step does not change `~/.codex/config.toml`, does not write a backup, and does not reserve a browser. It prints `skipped: not the live data dir` and the Claude autoMode lines. The other steps write only inside the project folder or the data dir, so they need no such rule. The browser command of the step uses the same data dir as the flow.

### Command project check

`project check <slug>` only reads. It writes no file and starts no step. It prints one line for each item. An item line starts with `ok`, or with `missing:` and the reason. A missing item names the fix step, or says `fix by hand`.

The check works for a project that `project new` did not make. It reads the folder, the data dir, and the Codex config. It needs no flow state file. It uses the state file only for the recorded remote and for the question whether the flow ran with `--start`.

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
| `labels` | The item exists only for a private GitHub `origin` when `gh` is installed and logged in. The repository has every label of the `triage` preset with the preset color and description. Otherwise the check omits the item and calls no other command. The check reads the labels with `gh label list` and writes nothing. A missing label prints `run herdr-boss gh label sync --preset triage`. | `labels` |
| `policy` | The policy has an entry for the slug. | `policy` |
| `register` | `project-repos.json` has a row for the slug. | `register` |
| `status` | The published status exists and has a task. | `status` |
| `workspace` | The flow ran with `--start`: Herdr has the workspace. Otherwise the item is `ok`. | `workspace` |
| `orchestrator` | The flow ran with `--start`: the pane `orch` has the agent `<slug>-orch`. Otherwise the item is `ok`. | `workspace` |
| `harness` | The Codex `writable_roots` hold every required path. | `harness` |
| `browser` | `browser-sessions.json` has a reservation for the slug. | `harness` |

`--fix STEP` runs the named flow step and no other step. Then the command prints the check again. The steps that `--fix` accepts are `folder`, `files`, `kit`, `commit`, `remote`, `labels`, `policy`, `register`, `status`, `workspace`, and `harness`. `--fix remote` still posts a decide item to the Owner and waits for the answer. `--fix workspace` needs `--start`, because the step uses model quota. The flag `--fix` may be used once. `--fix` refuses a worker pane, like `project new`. Plain `project check` has no pane check. A step that cannot be fixed by a step, such as invalid JSON in `.herdr-boss.json`, needs a correction by hand.

| Exit code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Usage error or refusal. This includes an unknown flag and a failed step. |
| 2 | Not built. |
| 3 | Waiting for an Owner decision. The step `remote` posted a decide item. |
| 4 | `project check` found a missing item. |

Run `project new` in a plain terminal, in the pane labeled `boss`, or in a pane labeled `orch`. A worker pane is refused before any step runs. The pane check is the check of `herdr-boss say`.

### Module

The module `src/project-new.js` exports `runProjectNew(options)`. The command calls it.

`runProjectNew` runs these steps in order: `validate`, `folder`, `files`, `kit`, `commit`, `remote`, `labels`, `policy`, `register`, `status`, `workspace`, `harness`. The step `check` reports `not built yet`. It changes nothing. A step that returns `waiting` stops the run. The result has `waiting: true`, and the later steps are `pending`.

| Option | Meaning |
|---|---|
| `slug` | Required. Must match `[a-z0-9][a-z0-9-]{0,63}`. |
| `group` | The group folder. The project folder is `<group>/<name>`. |
| `path` | The project folder. Use `group` or `path`, never both. There is no default. |
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

The scan refuses the commit for these classes: a private key block, a GitHub token, an AWS access key, a Slack token, a `password`, `secret`, `token`, or `api_key` assignment with a literal value of 16 or more characters, and a `.env` file. A file that ends in `.example`, `.sample`, `.template`, or `.dist` is not a `.env` file. The scan reads at most the first 200 KB of each line. A file over 2 MB, or a file with a NUL byte, cannot be scanned. The scan refuses it with the class `unscanned large or binary file`, unless its path is in the option `allowUnscanned`. The list is empty by default. The refusal names each file and class and never prints a value. The step then unstages all files and leaves the files unchanged. Remove the secret, then run the flow again with `resume`.

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

The `policy` step adds the project to `policy.json` in the data folder. The new project gets `share` 10, `mode` `auto`, and no exclusions. When the total of all shares would pass 100, the step scales the other shares down: each new share is the old share times (100 minus 10) divided by the old total, rounded down. The step changes only shares. It keeps each mode and each exclusion. It refuses to run when a share is not a whole number of 0 or more. It refuses a change that would lower a share of 1 or more to below 1, and it writes nothing then. It saves the policy through the validation of `herdr-boss policy set`. The step is not blocked by the share guard of `policy set`, because it changes many shares on purpose. It keeps the previous total. The write adds one line with the caller kind `project-new` to `policy-changes.jsonl`. The step prints the shares of all projects before and after the change. When the policy already has an entry for the slug, the step changes nothing.

The `register` step records `{ slug, repo, remote }` for the project in `project-repos.json` in the data folder, with mode 0600. It records the same values as the first `publish`. It does not publish a status. When the slug is already registered to the same folder, the step changes nothing. When it is registered to another folder, the step fails.

The `status` step publishes the first status through the code of `herdr-boss publish`: `writeProject` validates the file with `validateProject`. The status has the summary `New project. Set up the project.`, the current `kitRevision`, and one task `Set up the project` with status `todo` and priority 1. The `goal` field holds the option `goal`. The status has no `goal` field when the option is empty. When `projects/<slug>.json` exists, the step changes nothing.

The `workspace` step runs only with `--start`. It spends model quota. Nothing else starts it. Without `--start`, the step prints `skipped: no --start` and creates nothing. A later run with `--start` does the step.

1. The step picks the harness. With `--kind`, it uses that kind and the model of the policy for that kind. Without `--kind`, it uses the first entry of `orchestratorLadder` that `handoffTarget()` accepts. The step fails before it creates anything when no harness is usable.
2. The step runs `herdr workspace create --cwd PATH --label <slug> --no-focus`. The label equals the slug, so Herdr Boss maps the workspace to the project. The step writes the workspace ID into the field `workspace` of the published status.
3. The step runs `herdr pane rename PANE orch` for the root pane.
4. The step runs `herdr agent start <slug>-orch --kind K --pane PANE -- ARGS`. The arguments come from `handoffTarget()`. A Codex orchestrator also gets the `-c shell_environment_policy.set.*` arguments of a handover.
5. The step watches the pane for a folder trust prompt. See the paragraph after this list.
6. The step delivers the Owner goal. The goal is the text of `--goal`, or else the Settings value **Default orchestrator goal**. `goalDelivery()` in `src/goal.js` decides how, as in a handover. A Claude orchestrator gets `/goal TEXT` as its own prompt. The step then reads the pane and fails when the pane does not show the goal after three checks. A Codex orchestrator gets the goal in the first prompt.
7. The step sends the first prompt with `deliverPrompt()`. The prompt tells the orchestrator to read `AGENTS.md`, `docs/orchestration/memory.md`, and `docs/orchestration/herdr-boss.md`, and to start with the task `Set up the project`.

The Owner accepts the folder trust prompt. Herdr Boss only tells the Owner where it is. Herdr Boss never presses a key in a pane for this.

The trust watch runs only with `--start`, and only for a pane that this run created. A dry run reads no pane. The step runs `herdr pane read <pane id> --source recent-unwrapped --lines 60 --format text` every 2 seconds for 3 minutes from the creation of the pane. It stops earlier when the agent shows its input prompt or has the status `working`. The matchers are in `src/trust-prompts.js`. A matcher strips ANSI escapes and box borders. It requires the whole known dialog: the heading, one line that equals the project folder as an exact string after `realpath`, the known sentence, the option lines, and the footer. A parent, a child, a longer path, a symlink alias, a case difference, and a trailing slash do not match.

When the known dialog matches, the step posts one Mailbox item with the action `answer`. The item holds the pane ID, the harness, the slug, the line `Folder: <project path>`, the instruction to press Enter on the option that trusts the folder, and the path `/agents`. It holds no pane text. The step also appends one event to `events.jsonl` with the type `project-new`, the text `trust prompt detected`, the pane, the folder, and the harness. If no known dialog matched and the agent is neither ready nor working after 3 minutes, the step posts one item that says the pane may wait for input. A rerun repeats neither item.

Known dialogs: Claude Code (checked in 2.1.285) and Codex (checked in 0.159.2). Pi (0.87.1) and OpenCode (1.18.30) show no folder trust prompt, so the step does not watch them.

The state file holds the workspace ID, the pane ID, the chosen kind and model, and one flag for each sent message (`agentStarted`, `goalSent`, `goalVerified`, `promptSent`) in the field `ids`. The fields `trustPane`, `trustSince`, `trustDone`, `trustDetectedItem`, and `trustTimeoutItem` hold the state of the trust watch. A run that finds the workspace ID reuses the workspace. When the ID is gone, the run reuses the one workspace with the label of the slug. The run creates no second workspace or pane. A pane that already runs the agent gets no second start. A message that the flags mark as sent is not sent again. When the step fails, the next run with `--resume --start` continues at the failed point.

A dry run names the steps `remote`, `policy`, `register`, `status`, and `workspace`, and writes and posts nothing. With `--start`, the dry run of `workspace` prints `would create ...` and the chosen harness. It calls no Herdr command.

The state file is `flows/<slug>.json` in the data folder, with mode 0600. The command writes it through a temporary file with a unique name, and never follows a symlink at that name. It holds the inputs and the status of each finished step. The repository holds no state. A run that finds a state file with the same inputs skips the finished steps. It changes nothing when all built steps are finished. A step that fails is recorded as `failed`, and the next run repeats it.

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

The Mailbox shows action items under **Needs you**. It shows information under **Updates**. The escalation rules make Owner actions rare. The Owner answer comes back as an `[owner] Answer to ID (TITLE): ANSWER` prompt. The quoted question follows the answer.

The `say` text is 1 to 4000 characters. The report file is Markdown, up to 64 KB. The report title defaults to the first Markdown heading, or to `Report`. The `mail close` note is 1 to 500 characters. The close command refuses an unknown or already closed ID and names that ID in its error. The Boss note does not send a reply. These commands refuse text that looks like a token, a key, or a password. The error does not print the text.

Example:

```sh
herdr-boss say --reply-to m-mg3k2x1a-1f2e3d4c "Two tasks are left. The next merge is at 14:00."
herdr-boss mail post --to owner --title "Morning handback" handback.md
herdr-boss mail close m-mg3k2x1a-1f2e3d4c --note "Answered with the Owner through the Boss."
```

## Review packs

A review pack is a folder of evidence with one question for each item. The Owner reads it in the Herdr Boss site, answers each item, and submits one result. The format and the reviewer pages are in [the design](ideas/review-packs.md). These commands publish a pack, import HTML pages, and read the result.

| Command | Action |
|---|---|
| `herdr-boss review check FOLDER` | Validate a pack folder. Write nothing. Any pane and any terminal can run it. |
| `herdr-boss review publish SLUG FOLDER [--note TEXT] [--dry-run]` | Validate the folder, store it as the next version of its pack, and post a Mailbox item for the Owner. |
| `herdr-boss review import SLUG FOLDER-OR-FILE [--id ID] [--title TEXT] [--dry-run]` | Turn a folder of HTML files, or one HTML file, into a pack, and publish it. |
| `herdr-boss review result [SLUG] PACK [--version N] [--format json\|md]` | Print the stored result of a submitted review. The default format is Markdown. `--version N` selects a version. The default is the newest submitted version. `--json` means `--format json`. |
| `herdr-boss review delete [SLUG] PACK` | Delete the pack with its files and answers. Close its Mailbox items. |
| `herdr-boss review list [SLUG] [--state open\|done\|all] [--json]` | List the packs. The default state is `open`. |

`PACK` is the pack ID. Write it as `SLUG PACK` or as `SLUG/PACK`. An orch pane can also write only `PACK`. The command then uses the project of its workspace. A plain terminal must name the slug.

### Who can publish

`publish`, `import`, and `delete` check the caller.

1. A plain terminal has no `HERDR_*` variable. It is the Owner. It can name any slug.
2. A pane must pass the same check as `say`: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and a matching `herdr pane get` answer.
3. The pane label must be `boss` or `orch`. A worker pane is refused. A worker builds the folder, runs `review check`, and names the folder in its report.
4. An orch pane can use only the slug of the project that uses its workspace. Herdr Boss finds that project in `state.json`.
5. The pane labeled `boss` can use only the slug `boss`.

`check` reads only and has no caller rule. `result` and `list` use the same scope, and a worker pane is refused:

- A plain terminal reads every project.
- An orch pane reads only the slug of its own workspace. `review list` without a slug lists that project.
- The pane labeled `boss` runs `review list` for every project. It runs `review result` only for the slug `boss`.

### Publish

1. Run `herdr-boss review check FOLDER` and correct each error.
2. Run `herdr-boss review publish SLUG FOLDER`.
3. Read the printed review URL.

The command validates the folder with the rules of the design. The secret scan reads each text file. A finding names the file and the secret class, never the value. The command refuses a text file over 2 MB, an SVG, an HTML file outside a `page` item, and every image above 40 megapixels. It prints one line for each failed rule.

The command stores the files in the data folder and adds a Mailbox item to the thread of the project. The item has the kind `review` and the action `decide`. It has the title `Review: TITLE (vN)` and a link to the pack. `--note` adds text of 1 to 1000 characters to the item. The command refuses a title or a note that looks like a token, a key, or a password, before it writes anything.

A publish with an existing pack ID makes the next version. The command closes the older open Mailbox item of that pack with `closedBy: "review"` and posts a new item. The Owner sees one open item for each pack. An Owner answer to a review item stays in the Mailbox thread of that item.

If the publish fails after the store write, the command prints the pack ID and the version. The pack is stored and has no complete Mailbox item. Run the same `review publish` command again. An open pack with the same content gets no new version. The command only posts or links the missing Mailbox item and prints `Repaired`. The same command on an open pack with an open item for the current version prints `Unchanged` and does nothing. A submitted pack always takes the next version. A `--note` also takes the next version.

`--dry-run` validates the folder and prints what the command would publish. It writes no file, no database row, and no Mailbox item.

A project can have 5 open packs. The publish command refuses a sixth. It also refuses a version that takes the packs over 2 GB, and it names the oldest submitted packs to delete.

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

The Owner answer comes back as an `[owner]` prompt with the verdict, the counts, the denied items with their notes, and a fetch command. The prompt has at most 1500 characters. The command in the prompt is `herdr-boss review result PACK --version N --format json|md`.

`review result` prints the stored Markdown summary. The summary starts with the counts. It lists the denied items and the items that need a live check first, with the Owner's notes quoted. `--format json` prints the result object with the schema `herdr-boss.review-result/1`. The verdict is `accept`, `accept-with-changes`, or `deny`. Exit code 3 means that the pack, the version, or the result does not exist. The Owner has then not submitted that version.

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

## Harness settings

| Command | Action |
|---|---|
| `harness check [--live-codex]` | Check the harness settings that orchestration needs. Print one line per entry: `ok`, `missing`, or `bad`, the harness, and the entry. The Claude `**Herdr Boss projects**` line passes for a project when it names the project path, or names a parent folder of the project and states the marker file `docs/orchestration/herdr-boss.md`. The output names the parent folder of a covered project. Exit 1 when an entry is `missing` or `bad`. The command prints only paths and entry names. Owner lines that the Claude template does not define are not findings. `--live-codex` also runs one `codex exec -s workspace-write` with the worker shell variables of the caller pane. It passes when the tool shell has `HERDR_ENV` and `HERDR_PANE_ID`, and it prints only `set` or `missing`. The timeout is 180 seconds. Without `--live-codex`, the command calls no model. |
| `harness sync [--dry-run] [--codex-only]` | Back up `~/.codex/config.toml` to `config.toml.bak-<UTC timestamp>`, and add the missing roots to `writable_roots` in `[sandbox_workspace_write]`. The roots are `~/.herdr-boss`, `~/Projects/.herdr-wt`, and `<repo>/.git` for each registered project. Then compare the Claude template with `autoMode` and print only its differences. `--dry-run` prints the roots to add and writes nothing. `--codex-only` skips the Claude check. |
| `harness change <harness> <label> [--date YYYY-MM-DD]` | Append one line to `harness-changes.jsonl` in the data directory. The line marks the day of a harness fix on the denial chart of the Analytics page. `<harness>` is `claude`, `codex`, `opencode`, or `pi`. `<label>` has 1 to 80 characters. The default date is today in local time. Only the pane labeled `boss`, a pane labeled `orch`, and a plain terminal can run it. A worker pane is refused. The command validates every field, writes nothing on an error, and exits 1. See [Denials per day](user-guide.md#denials-per-day). |

`harness sync` keeps each existing root and each other line of the Codex file. It adds `~/.herdr-boss` and `<repo>/.git` for each registered project, when they are missing. When the Codex section or array is missing or cannot be parsed safely, it changes nothing, prints the roots to add, and exits 1.

The command reads only `autoMode` from `~/.claude/settings.json`. It prints missing lines and changed labeled environment lines. It shows the old line after `now:`. The recommended `**Herdr Boss projects**` line names the parent folders of the registered project repositories. It names each distinct parent once, at most 10, and never `/`, the home folder, or a folder above it. A project under such a folder is named by its path. The line states the marker file rule and the worker worktree root. It counts Owner lines that the template does not define, but it does not show their text. If the settings file or the `autoMode` key is missing, it prints the full template and says why. It never edits `~/.claude/settings.json`. The checked entries and the risk of each setting are in [harness-setup.md](harness-setup.md).
| `herdr-boss scratch SLUG` | Create `~/.herdr-boss/scratch/SLUG/` if it does not exist, and print its absolute path. `HERDR_BOSS_DIR` replaces `~/.herdr-boss`. |

## Settings reference

The dashboard Settings and Allocation pages show these settings. Each row shows the key in `policy.json` or `config.json`, the default, the unit, the range, and the effect of a higher or lower value. The dashboard shows the same text in the info popup of each setting.

Regenerate the block with `UPDATE_SETTINGS_DOCS=1 node --test test/setting-help.test.js` after you change `public/setting-help.js`.

<!-- settings-reference:begin -->

Do not edit this block. It comes from `public/setting-help.js`.

#### Harnesses

- Controls: Which agent kinds and models workers may use, the preferred model of each kind, and which provider quota each model counts against.
- Effect: Workers and quotas. Worker start and handover choose only from the models that you leave on.
- Safe to change: Safe to change at any time. A running worker keeps its model. A model that you switch off is not chosen again.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Available | `harness.available` | Lets workers use this harness. Clear it to stop all workers from using the harness. | On for every harness | Switch | On or off | Turning it on lets worker start and handover pick the harness. | Turning it off stops new workers on this harness. A running worker keeps working. | Select Apply policy. The change takes effect at the next engine tick. |
| Preferred model | `harness.preferredModel` | The model that worker start and handover use when no model is given. | The harness default | Model name | Any model that the harness allows | Not applicable. Choose another model to change the choice. | An empty choice uses the harness default. | Select Apply policy. The change takes effect at the next engine tick. |
| Model box | `harness.model` | Lets this harness use the model. Clear the box to stop the harness from using the model. | On for a catalog model | Switch | On or off | Turning it on lets workers use the model in this harness. | Turning it off stops new workers on this model in this harness. Other harnesses keep their own box. | Select Apply policy. The change takes effect at the next engine tick. |
| Provider | `harness.provider` | The provider quota that this model counts against. | The route of the catalog, or Unmetered | Provider name | The providers that the harness supports, or Unmetered | Not applicable. Choose a provider to count the model against its quota. | Unmetered means no quota applies. Pacing and quota warnings ignore the model. | Select Apply policy. The change takes effect at the next engine tick. |
| Add model | `harness.addModel` | Adds a local model string to this harness. The string is stored in the local policy, not in kit/models.json. | No local models | Model string | Up to 128 characters: letters, digits, dot, underscore, slash, and hyphen | Not applicable. | Select Remove to delete a local model. | Select Apply policy. The change takes effect at the next engine tick. |

#### Provider quotas

- Controls: How Herdr Boss paces each provider quota, the goal for each quota window, and the warning and critical levels.
- Effect: Quotas and notices. Pacing changes which lanes say Use now and when a worker start is refused. The levels change when a quota notice is sent.
- Safe to change: Safe to change. A goal below 100% makes Herdr Boss save quota. Keep the warning level below the critical level.
- Restart: No restart. Goals and modes need Apply policy. The two levels need Save.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quota mode | `quota.mode` | Sets if Herdr Boss paces a provider. Manage pace uses the quota to decide when to run work. Ignore quota stops pacing and pace warnings for worker dispatch. | Manage pace | Choice | Manage pace or Ignore quota | Not applicable. | Ignore quota lets workers start at any pace. Handover risk and automatic handover still use live quota data. A window at 100% still exhausts the provider. | Select Apply policy. The change takes effect at the next engine tick. |
| Pacing goal and goal end | `quota.goalPercent` | The most percent of a quota window that Herdr Boss plans to use by the end of the goal. The goal end is at the reset, at a local date and time, or a whole number of hours before each reset. | Blank, which means 100% | Percent of the window | 0 to 100. A goal end must be after now, after the window start, and not after the reset | A higher goal lets workers use more of the window. A later end gives the goal more time to use quota. | A lower goal saves quota. The lanes say Use now less often. An earlier end forces the use of quota sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Pace tolerance points | `paceTolerancePoints` | The number of percentage points that the use of a quota window may be above its expected use before the lane is ahead of pace. A lane inside the tolerance is on pace. | 5 | Percentage points | 0 to 50 | A lane stays on pace with a larger lead. Workers start more often. | A lane is ahead of pace sooner. A value of 0 uses no tolerance. | Select Apply policy. The change takes effect at the next engine tick. |
| Minimum use for ahead of pace | `paceMinUsePercent` | The used percent of a quota window below which the lane is never ahead of pace, also when the use is above the expected use. | 30 | Percent used | 0 to 100 | A lane stays on pace to a higher use. A fresh window does not block workers. | A lane can be ahead of pace at a lower use. A value of 0 uses no minimum. | Select Apply policy. The change takes effect at the next engine tick. |
| Quota warning level | `quota.warnPercent` | The used percent of a quota window at which the quota shows a warning. | 90 | Percent used | 50 to 99, below the critical level | A higher value gives the warning later. | A lower value gives the warning earlier. | Select Save in the group. The change takes effect at once. |
| Quota critical level | `quota.criticalPercent` | The used percent of a quota window at which the quota shows a critical alert. | 98 | Percent used | 51 to 100, above the warning level | A higher value gives the critical alert later. | A lower value gives the critical alert earlier. Keep it above the warning level. | Select Save in the group. The change takes effect at once. |

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
| Disk warning below free GB | `machine.diskWarnFreeGB` | The free disk space below which Herdr Boss sends a disk warning. A GB is 2³⁰ bytes. This notice stays on when the guard is off. | 20 | GB free | 0 to 1048576 | A higher value gives the warning earlier. | A lower value gives the warning later. | Select Apply policy. The change takes effect at the next engine tick. |
| Disk critical below free GB | `machine.diskCriticalFreeGB` | The free disk space below which Herdr Boss sends a critical disk alert. | 5 | GB free | 0 to 1048576 | A higher value gives the critical alert earlier. | A lower value gives the critical alert later. Keep it below the warning value. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap warning at % used | `machine.swapWarnPercent` | The swap use at which Herdr Boss raises a swap warning. It needs 3 samples in a row at or above the percent, with at least the minimum GB in use. The warning never blocks work. | 80 | Percent of the swap total | 1 to 100, or blank to turn the warning off | A higher value gives the warning later. | A lower value gives the warning earlier. A blank field turns the warning off. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap refusal at % used | `machine.swapRefusePercent` | The swap use at which the swap refusal blocks new work. It has an effect only when Refuse new work at high swap is on. | 95 | Percent of the swap total | 1 to 100, or blank to turn the refusal off | A higher value blocks new work later. | A lower value blocks new work sooner. A blank field turns the refusal off. | Select Apply policy. The change takes effect at the next engine tick. |
| Swap rules need at least GB used | `machine.swapMinUsedGB` | The least swap in use before the swap warning and the swap refusal apply. The macOS swap total grows with use, so a percent alone can mislead. | 2 | GB | 0 to 1024 | A higher value ignores a small swap use. | A lower value lets a small swap use raise a notice. Zero removes the floor. | Select Apply policy. The change takes effect at the next engine tick. |
| Refuse new work at high swap | `machine.swapRefuseEnabled` | When on, a worker start, a suite, or a push with a pre-push suite fails while swap is at or above the refusal percent. Work that the Owner or the Boss starts is never refused. | Off | Switch | On or off | Turning it on protects a machine that swaps from more load. Use --force-swap, or HERDR_BOSS_FORCE_SWAP=1 for suite and push, to override. | Turning it off lets work start at any swap level. The swap warning still applies. | Select Apply policy. The change takes effect at the next engine tick. |
| Notice cooldown seconds | `machine.alertCooldownSeconds` | The least time before the same machine notice is sent again. | 21600 (6 hours) | Seconds | 0 to 604800 | A higher value sends fewer repeat notices. | A lower value sends repeat notices sooner. Zero sends a notice at each change. | Select Apply policy. The change takes effect at the next engine tick. |
| Kit digest interval minutes | `machine.kitDigestMinutes` | The least time between two kit digests to one orchestrator pane. A digest lists the required kit changes that the pane has not received. Herdr Boss sends no digest while the pane works. It sends the digest when the pane is idle or done. | 120 (2 hours) | Minutes | 10 to 1440 | A higher value sends fewer kit digests. Each digest lists more changes. | A lower value sends kit digests sooner. Each digest lists fewer changes. | Select Apply policy. The change takes effect at the next engine tick. |
| Memory free warning | `machine.memFreeWarnPercent` | The free memory percent below which Herdr Boss shows a memory warning. It stays on when the guard is off. | 15 | Percent free | 1 to 50 | A higher value gives the memory warning earlier. | A lower value gives the memory warning later. | Select Save in the group. The change takes effect at once. |

#### Watch

- Controls: The routines that the Boss pane gets while a watch runs, the worker caps of a watch, and quiet hours.
- Effect: Workers and notices. A cap limits how many workers run while the Owner is away. A routine sends a prompt to the Boss pane.
- Safe to change: Safe to change. A routine change applies at the next prompt of a running watch. A routine that you edit never changes the kit file.
- Restart: No restart. A routine needs Save. A cap needs Save in its group.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Routine title | `watch.routine.title` | The name of a watch routine. The Watch box and the Boss prompt show it. | The kit title | Text | Up to 60 characters | Not applicable. | Not applicable. | The change takes effect at once. |
| Routine model hint | `watch.routine.model` | A hint of the model that the Boss should use for the routine. The Boss pane reads it in the prompt. | default | Text | Up to 40 characters | Not applicable. | Not applicable. | The change takes effect at once. |
| Routine schedule | `watch.routine.schedule` | When a routine runs during a watch: every N minutes, or at a set time before the end of the watch. | Every 60 minutes for a new routine | Minutes, or a time of day | 1 to 1440 minutes, or a time such as 01:00 | More minutes between runs send fewer prompts. | Fewer minutes between runs send more prompts and use more quota. | The change takes effect at once. |
| Routine prompt | `watch.routine.prompt` | The text that the service sends to the Boss pane when the routine runs. | The kit text | Text | Up to 8000 characters | A longer prompt gives more detail and uses more context. | Reset to the kit text removes your change. | The change takes effect at once. |
| Watch worker cap | `watch.maxWorkers` | The most workers that run at the same time while a watch runs. A blank value uses the day value. | Blank (the day value) | Workers | 1 to 40, or blank | A higher cap runs more workers overnight and uses more quota and CPU. | A lower cap runs fewer workers overnight. | Select Save in the group. The change takes effect at once. |
| Watch worker cap by lane | `watch.maxWorkersByLane` | The most workers per lane while a watch runs. The lanes are Unmetered, Codex, Claude, and OpenCode Go. A blank lane uses the day value. | All lanes blank | Workers | 1 to 40 for each lane, or blank | A higher cap lets that lane run more workers. | A lower cap protects the quota of that lane. | Select Save in the group. The change takes effect at once. |
| Quiet hours default | `watch.quietHours` | The default for a new watch: quiet hours on or off. Quiet hours queue desktop notifications until the watch ends. They also delay the release of an expired manual suite lock or lease. | Off | Switch | On or off | Turning it on gives a new watch quiet hours. A watch that you start can override it. | Turning it off gives a new watch normal desktop notifications. | Select Save in the group. The change takes effect at once. |

#### Capacity and handover

- Controls: The number of working agents, idle sharing, the orchestrator reserve, and automatic handover of an orchestrator to a successor. These controls are on the Allocation page.
- Effect: Workers, quotas, and handover. The maximum working agents is a hard cap for worker start. Handover moves an orchestrator to a fresh successor before a quota or context limit.
- Safe to change: Change the maximum working agents with care: a high value adds load. Leave automatic handover off until you have read the handover guide.
- Restart: No restart. Select Apply policy.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Maximum working agents | `maxWorkers` | The most agents that work at the same time. The worker command enforces it for all projects together. | 8 | Agents | 1 to 64 | A higher value runs more work at once and adds CPU and quota use. | A lower value queues new workers until a slot is free. | Select Apply policy. The change takes effect at the next engine tick. |
| Borrow idle shares | `borrowIdle` | Lets a busy project use the unused share of an idle project. | On | Switch | On or off | Turning it on uses the whole capacity when some projects are idle. | Turning it off keeps each project inside its own share. | Select Apply policy. The change takes effect at the next engine tick. |
| Idle after minutes | `idleMinutes` | The time without activity after which a project counts as idle and lends its share. | 15 | Minutes | 0 to 1440 | A project stays active longer before it lends its share. | A project lends its share sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Orchestrator reserve | `reservePercent` | The percent of a provider quota that is kept for orchestrators. Workers cannot use it. | 15 | Percent of the quota | 0 to 80 | A higher reserve keeps orchestrators running longer when quota is short. Workers get less. | A lower reserve gives workers more quota. An orchestrator can run out first. | Select Apply policy. The change takes effect at the next engine tick. |
| Handover lead minutes | `handoffLeadMinutes` | A quota window is at risk when it will run out within this many minutes. Herdr Boss then recommends a handover. | 180 | Minutes | 0 to 10080 | A higher value recommends a handover earlier. | A lower value recommends a handover later. | Select Apply policy. The change takes effect at the next engine tick. |
| Automatic handover | `autoHandover` | Lets Herdr Boss prepare and activate a successor orchestrator without the Owner. It never runs for the Boss. It never runs for a project that no longer works or that is paused or stood down. It never runs for a successor model that is weaker than the source. After activation, Herdr Boss closes the old pane when the successor has answered and the old pane is idle. | Off | Switch | On or off | Turning it on moves an orchestrator to a successor at the reserve limit or the context limit. | Turning it off means only the Owner starts a handover. | Select Apply policy. The change takes effect at the next engine tick. |
| Activate at quota used % | `autoHandoverPercent` | The quota level at which the prepared successor takes control. Boss prepares the successor at the reserve limit. The source stays in control until the successor reports ready and the quota reaches this level. | 98 | Percent of the quota | 90 to 100 | A higher value keeps the source in control for longer. | A lower value hands over sooner. | Select Apply policy. The change takes effect at the next engine tick. |
| Hand over at context tokens | `autoHandoverContextTokens` | The context size above which a Claude orchestrator gets a fresh successor at a task boundary. The successor starts from the project memory file with the same model. Herdr Boss activates it when the orchestrator pane is not working. It reads the context size only for Claude. A pane that it sees for the first time waits for its next boundary. | 300000 | Tokens | 50000 to 2000000 | A higher value keeps a long context for longer. | A lower value hands over sooner and keeps the context short. | Select Apply policy. The change takes effect at the next engine tick. |
| Default orchestrator goal | `defaultOrchestratorGoal` | The /goal text for a new orchestrator that has no goal. A handover copies the goal of the old orchestrator to the successor: the published status goal, else the last /goal command of its session. A Claude successor gets /goal after it answers. Other harnesses get the goal in the activation prompt. The default text ends with a rule: a running worker, a gate, a push, or a lock wait is progress. The rule stops the goal check from looping while the orchestrator waits for a report. The Set goal dialog and `herdr-boss goal set` accept at most 2000 characters. | A standing goal text | Text | One line of at most 4000 characters, or empty for no default | A longer text gives more direction and uses more context. | An empty text gives a new orchestrator no default goal. | Select Apply policy. The change takes effect at the next engine tick. |
| Orchestrator succession | `succession.ladder` | The ordered list of kind, model, and effort choices that automatic handover tries. It skips the current provider, unavailable quotas, and global or project exclusions. | The list in policy.json | List of choices | Up to 20 choices | A longer list gives automatic handover more successors to try. | A shorter list can leave no successor. A choice outside the list is never selected automatically. | Select Apply policy. The change takes effect at the next engine tick. |
| Workspace projects | `workspace.exclusion` | Decides which live workspaces count as projects. Clear a workspace switch to include it as a project. The Boss workspace stays excluded while its pane is labelled boss. | Every workspace is a project, except the Boss workspace | Switch for each workspace | On or off | Switching a workspace on removes it from the projects and from the shares. | Switching a workspace off makes it a project that takes part in the shares. | Select Apply policy. The change takes effect at the next engine tick. |
| Project shares | `project.shares` | The share of the working agents for each project. Drag a boundary in the bar: only the projects to its right rebalance. The labels show the set share and the effective slots. Shares are advisory. The worker command enforces the global cap. Apply policy asks for a confirmation when 3 or more shares change, and asks again when the total is not 100. | The shares in policy.json | Percent of the working agents | 0 to 100, and all shares add up to 100 or less | A larger share gives the project more slots when the machine is busy. | A smaller share gives the project fewer slots. It can borrow idle shares of others when Borrow idle shares is on. | Select Apply policy. The change takes effect at the next engine tick. |

#### Resource pools

- Controls: The ports of a pool, the idle time after which Herdr Boss reclaims a lease, the wait default, and the client values by port. These controls are in the pools editor on the Allocation page.
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

- Controls: The USD price per million tokens of each model.
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

- Controls: The values that the service itself uses: collection intervals, stale limits, browser clean-up, and the network address. Each row shows whether the value comes from config.json or is a default.
- Effect: Workers, notices, browsers, and the machine. A value here changes when a status is stale, when an idle worker is reported, and when an orphan browser is stopped.
- Safe to change: A row with an input is safe to change. A row without an input is read-only. Change it in config.json.
- Restart: A row with an input needs no restart. A read-only row needs a service restart.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stale status minutes | `staleStatusMinutes` | The age after which a published project status is stale while workers run or new commits land. | 120 | Minutes | 5 to 1440 | A higher value gives the stale notice later. | A lower value gives the stale notice sooner. | Select Save in the group. The change takes effect at once. |
| Stale idle worker minutes | `workers.staleIdleMinutes` | The idle time after which Herdr Boss reports a worker as stale. The wait command uses it as its stall time. | 120 | Minutes | 5 to 1440 | A higher value waits longer before it reports an idle worker. | A lower value reports an idle worker sooner. | Select Save in the group. The change takes effect at once. |
| Stop orphan browser daemons | `browsers.reapOrphanDaemons` | Lets Herdr Boss stop an agent-browser daemon that has no parent, no children, and the minimum age. It never stops a browser that it did not start. | On | Switch | On or off | Turning it on frees memory from forgotten daemons. | Turning it off leaves orphan daemons running. | Select Save in the group. The change takes effect at once. |
| Orphan daemon minimum age | `browsers.orphanDaemonMinAgeSeconds` | The age that an orphan browser daemon must reach before Herdr Boss stops it. | 7200 | Seconds | 60 to 86400 | A higher value spares a young daemon for longer. | A lower value stops orphans sooner and risks a daemon that is between two uses. | Select Save in the group. The change takes effect at once. |
| Stale owned browser minutes | `browsers.staleOwnedMinutes` | The idle time of the agent after which Herdr Boss reports its browser as stale. | 30 | Minutes | 5 to 1440 | A higher value reports a stale browser later. | A lower value reports a stale browser sooner. | Select Save in the group. The change takes effect at once. |
| Sweep code-sign clones | `browsers.sweepCodeSignClones` | Lets Herdr Boss delete old code-sign clones of Chrome that no running Chrome process owns. | On | Switch | On or off | Turning it on frees disk space. | Turning it off leaves the clones on disk. | Select Save in the group. The change takes effect at once. |
| Tick seconds | `tickSeconds` | The time between two collection passes of the engine. | 30 | Seconds | A whole number of 5 to 300 | A higher value gives slower updates and less load. | A lower value gives faster updates and more load. | Select Save in the group. The change takes effect at once. |
| Quota seconds | `quotaSeconds` | The time between two reads of the provider quotas. | 300 | Seconds | A whole number of 30 to 3600 | A higher value reads quotas less often. | A lower value reads quotas more often and calls the providers more. | Select Save in the group. The change takes effect at once. |
| Push prompts | `push` | Lets the service send prompts to orchestrator panes. Notices to the Owner are always sent. The environment variable HERDR_BOSS_PUSH=0 overrides the saved value. Restart the service after a change. | On | Switch | On or off | Turning it on lets the service prompt the orchestrators. | Turning it off stops all prompts to orchestrator panes. | Select Save in the group. Restart the service for the change to take effect. |
| Notice cooldown (legacy) | `alertCooldownSeconds` | An unused legacy value. Set the notice cooldown in the Machine group. | 21600 (6 hours) | Seconds | Read-only | No notice reads this value. | No notice reads this value. | Change it in config.json. Restart the service. |
| Provider kinds | `providerKinds` | Maps each quota provider to the agent kinds that use it. | claude to claude, codex to codex, opencodego to opencode and pi | Object of lists | Kind names that exist | Not applicable. | A wrong map counts a kind against the wrong quota. | Change it in config.json. Restart the service. |
| Orchestrator label | `orchestratorLabel` | The pane label that marks the orchestrator of a project. | orch | Text | One pane label | Not applicable. | A wrong label makes Herdr Boss miss the orchestrator panes. | Change it in config.json. Restart the service. |
| Port | `port` | The port of the dashboard and the API. | 4477 | TCP port | 1 to 65535 | Not applicable. | A change also changes the address that other tools use. | Change it in config.json. Restart the service. |
| Host | `host` | The network address that the server listens on. 0.0.0.0 allows remote access with the access token. 127.0.0.1 allows only this machine. | 0.0.0.0 | Address | An IP address of this machine | Not applicable. | Set 127.0.0.1 to turn remote access off. | Change it in config.json. Restart the service. |

#### Harness readiness (Advanced)

- Controls: A read-only table that shows if each harness entry that orchestration needs is present.
- Effect: Nothing. The table only reports.
- Safe to change: Nothing to change. Run herdr-boss harness sync to see what to fix.
- Restart: No restart.

| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Readiness table | `harness.readiness` | Shows for each harness entry if it is ok, missing, or bad. The table shows no path and no value. | Not applicable | Table | Read-only | Not applicable. | Not applicable. | The change takes effect at once. |

<!-- settings-reference:end -->

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
| `--model MODEL` | A model from `herdr-boss models`. Without this option, `worker start` uses the kind's default model in `kit/models.json`. The `preferredModels` policy does not override it. The preferred model is a fallback only when the default cannot start (disabled, or not allowed). The fallback never picks an Opus model without `--force`. `worker start` always passes the model to the harness, so the account default of the harness is never used. A kind without a default model fails and asks for `--model`. The name is case-folded, a bracketed suffix such as `[1m]` is dropped, and `opus`, `claude-opus`, and `opus-5-5` mean `claude-opus-5-5`. The dry-run plan and the run record show `modelSource`: `flag`, `default`, or `policy`. |
| `--effort EFFORT` | A reasoning effort, where the kind supports it. Without this option, `worker start` uses the kit default effort of the kind. The run record shows `effortSource` (`flag` or `default`) when an effort applies. |
| `--task-id ID` | The task ID from the published status. Herdr Boss saves it as `taskId` in the run record. The project board then shows the task as `doing` while the worker runs. Use letters, digits, `.`, `_`, and `-`, up to 64 characters. Always give this option. Without `--task-id` and `--issue`, `worker start` prints a warning and starts the worker. |
| `--issue N` | The issue number. It is an alias of `--task-id` for a numeric task ID. Do not use it with `--task-id`. |
| `--base BRANCH` | The base branch. The default is `baseBranch` in `.herdr-boss.json`. |
| `--orch PANE` | The verified caller pane for reports. If set, it must match `HERDR_PANE_ID`. |
| `--no-worktree` | Use the current checkout. The worker gets `.worker/NAME/` for its brief and reports. |
| `--dry-run` | Print the plan. Change nothing. |
| `--force` | Override quota, capacity, and paused-project refusals. Start `claude-opus-5-5` only with the Owner's approval: without `--force`, `worker start` fails with `claude-opus-5-5 needs the Owner's approval. Ask the Owner, then start with --force.` The refusal also applies to the Opus spellings that `--model` normalizes, and to an Opus fallback from the policy. It happens before a worktree, a pane, or a run record exists. With `--force`, the run record holds `force: true`. It cannot enable a disabled model. It cannot override the swap refusal. |
| `--force-swap` | Override the swap refusal (see below). |

Worker brief templates support two Herdr command slots:

| Slot | Meaning |
|---|---|
| `herdrEnvPrefix` | The caller's `HERDR_ENV=1` setting and, when known, its `HERDR_SOCKET_PATH`. |
| `herdrBin` | The absolute path in `HERDR_BIN_PATH`, or `herdr` when the path is unknown. |

The default brief names the orchestrator by its agent name `<slug>-orch` first, and gives the pane ID as the current address. The agent name stays the same after a handover. The report and question commands use the agent name. The brief tells the worker to send to the pane ID when the agent name fails.

Set `imageBudget` in `.herdr-boss.json` to a positive integer to set the project's screenshot budget. The default is 10. The project setting overrides the kit default. A failed start ends with `START FAILED: <reason>` after cleanup details.

`worker start` refuses a provider that is ahead of pace, near exhaustion, or exhausted. A provider is ahead of pace only when a live window has a use of at least `paceMinUsePercent` (default 30) and more than `paceTolerancePoints` (default 5) percentage points above its expected use. A provider inside the tolerance is on pace: `herdr-boss lanes` shows it as `claude on pace (17% used, expected 16%, tolerance 5 points)`, and `worker start` accepts it. A refusal for a provider that is ahead of pace ends its lane line with `tolerance 5 points`. Set both values in Settings under Provider quotas. An exhausted lane shows its window and reset time; when several windows are exhausted, it uses the latest reset. `--force` remains the explicit quota override. Ignore quota mode disables pacing and handover warnings below 100%, but it does not make an exhausted provider usable. When every metered provider is ahead of pace, it allows the least-over one with a notice. A refusal or least-over notice lists the current project's unmetered alternatives first, then names the least-over metered provider. It refuses dispatch when the active CPU limit or enabled load backstop is exceeded. `--force` cannot bypass a machine refusal.

The `machine` object in `rules.json` also holds `swapPercent`, `swapUsedGB`, `swapWarnPercent`, `swapRefusePercent`, `swapMinUsedGB`, and `swapWarning`. `swapWarning` is `true` while the `machine:swap` alert is raised. `swapRefuseEnabled` is `true` when the Owner turned on the swap refusal.

The swap refusal is off by default. The Owner turns it on with `machine.swapRefuseEnabled` in Settings, Machine. When it is on, `worker start`, `suite`, and `push` refuse if all of these are true:

- `swapPercent` is at or above `swapRefusePercent`. A blank `swapRefusePercent` switches the refusal off.
- `swapUsedGB` is at or above `swapMinUsedGB`.
- `updatedAt` in `rules.json` is not older than 3 minutes. Older rules never refuse.
- The caller is a pane that is not the `boss` pane, and is inside Herdr. A shell outside Herdr and the `boss` pane are never refused.

The refusal message shows the swap percent and the GB in use, and names the override. `worker start` needs `--force-swap`. `--force` does not override it. `suite` and `push` need `HERDR_BOSS_FORCE_SWAP=1` in the environment. `suite` refuses before it takes the lock. `suite --reuse` still returns 0 when it reuses a passing tree, because no test runs. `push` refuses before it takes the lock, and only when a pre-push hook exists. A ticket that is already in the queue stays.

The Pi allow-list holds only `opencode-go/` models. Free `opencode/` models run only in the `opencode` harness. `worker start --kind pi` refuses an `opencode/` model.

Policy may set `preferredModels` by harness; `modelProviders` by allowed model; `extraModels` and `disabledModels` by harness; `harnessRoutes` by harness and model; and `pacingGoals` by provider and window key (`primary`, `secondary`, or `tertiary`). `extraModels` adds local model strings to one harness. The models use that harness's launch arguments and effort rules. `disabledModels` disables a model in one harness. A preferred model must be in that harness's allow-list. `harnessRoutes` takes precedence over `modelProviders` for the same harness and model. A provider route must be `codex`, `claude`, `opencodego`, or `null` for an unmetered model. A `harnessRoutes` route for the `codex` harness must be `codex` or `null`. A route for the `claude` harness must be `claude` or `null`. The `opencode` and `pi` harnesses accept every provider. `policy set` refuses an incompatible route and names the harness, the model, and the permitted choices. The rule also applies to a `modelProviders` route that an available `codex` or `claude` harness inherits without a `harnessRoutes` entry. `policy set` refuses such a policy and names the harness, the model, and the permitted choices. An existing policy with such a route still loads. Herdr Boss keeps the raw value, treats the model as unmetered in that harness, and logs one warning. `policy show` lists these routes in the derived `ignoredRoutes` field. `policy set` does not store that field. `policy set` removes stale references to models that the catalog no longer allows, and repeated entries. It prunes `modelProviders`, `harnessRoutes`, `disabledModels`, `extraModels`, `excludedModels`, `preferredModels`, and project `excludedModels`. An `extraModels` entry that repeats the catalog is removed. `policy set` prints one note that names each removed model and the field that held it. It prints no note when nothing is removed. A malformed value, for example a model string with a shell character or a route to an unknown provider, still fails with an error and stores nothing. A pacing goal is a whole percentage from 0 to 100; an absent goal means 100%. `autoHandoverContextTokens` is an integer from 50000 to 2000000 (default 300000). With `autoHandover` on, it starts a handover at a task boundary when the Claude orchestrator context is above this value. Explicit `--model` and handoff `--model` choices take precedence.

```sh
herdr-boss worker start fix-74 --kind claude --task-file brief.md --allow src/parse/ --issue 74
```

### Other worker commands

| Command | Action |
|---|---|
| `worker list` | Unfinished run records with the live agent status. |
| `worker collect NAME` | Read the worker report, check its changed paths against `--allow`, and report configured stale-artifact warnings. It sets `collectedAt` in the run record only when the worker reported done: the report has `stoppedEarly` other than `true`, or `--record` has `--outcome done`. A collect of a running, stopped-early, failed, or partial worker changes nothing in the run record. Without a collect record, the board shows the task as `review` with the source `finished, not collected` when its pane is gone and `report.json` says done. A report with `stoppedEarly: true` or a status of blocked, failed, or partial gives a failed worker, and the task is open again. The board shows the task as `done` with the source `merged` when the branch is merged into the base branch. |
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

Herdr Boss stores successful passes in `suite-passes.json` in its data directory. It keeps the last 200 passes. The file has mode `0600`. A pass key uses the Git common directory, the tested hash of the tree, the hash of each root lockfile, the exact command, and the Node version. The tested hash covers every file of `HEAD` except the files that match a glob of `suiteUntested`. A dirty tree cannot use or create a pass. A changed, staged, or untracked file that matches `suiteUntested` does not make the tree dirty. A changed file that no glob covers runs the suite again.

`suiteUntested` is a list of repository-relative globs in `.herdr-boss.json`. It names the files that no test reads. The default is `.worker/**` and `.orchestration/**`. The value replaces the default. Only `*` and `**` are valid. Do not list a file that a test reads. A glob is invalid when it starts with `*/`, `**/`, or is `*` or `**`, or when it matches one of these sample paths: `src/x.js`, `test/x.test.js`, `public/app.js`, `kit/CHANGES.md`, `kit/templates/x.md`, `.github/workflows/x.yml`, `package.json`, `package-lock.json`, `.herdr-boss.json`, `docs/cli.md`, `docs/user-guide.md`, `bin/x`. An invalid list is an error in `loadProjectConfig`. The pass key ignores an invalid list as a whole and uses the default. `dir/**` matches the paths below `dir`, not `dir` itself, so a tracked file named `.worker` is tested. Documentation files in `docs/` are read by tests, so they are tested. A changed list never matches an older pass.

Known limits: the key ignores untracked files under `.worker/` and `.orchestration/`, although a test may read run state there. Keep such a test out of the suite, or list no path that it reads.

`suite` without `--reuse` runs again on a tree that has a pass. It skips the run only when a pass has a different tree and the same tested hash: the trees differ by untested files only. The output says `suite: reused the pass of ...`.

In a pre-push hook, run the test command through `herdr-boss suite` or `herdr-boss suite --reuse`. When the suite runs under `herdr-boss push`, it reuses the push lock. `herdr-boss push` also sets `HERDR_BOSS_SUITE_REUSE=1`, so the suite can reuse a matching pass. A Viz hook can use the same commands for its Tier B check.

Use `herdr-boss suite --reuse -- <command>` to request reuse outside a pre-push hook. Use `herdr-boss suite --list-passes` to print the last 10 records. Each row shows the time, repository name, short tree hash, and command.

`herdr-boss push` stores the suite commands that its hook ran in `push-hooks.json` in the data directory. Before it takes the lock, the next push looks for a pass of each stored command on the clean tree. When every command has a pass, the push takes no lock, sets `HERDR_BOSS_SUITE_REUSE=1`, and runs `git push`. It prints `push: a suite pass exists ... Pushing without the full-suite lock.` It writes an `acquire` and a `release` ledger line of kind `push` with `reused: true`, `waitMs: 0`, and `holdMs: 0`. The store also holds the hash of the hook file. A changed hook file is a miss. A hook is reusable only when each line is a comment, a `set`, `cd`, `export`, or `exit` line, or a `herdr-boss suite` call. A hook with a raw test command is never reusable. A push with no stored command, no pass, a dirty tree, or a non-reusable hook takes the lock as before. A reused push never queues. A push that queues keeps its place in ticket order, and every waiter gets its turn in that order.

`herdr-boss push` finds a pre-push hook in two ways. A `pre-push` file exists at `git rev-parse --git-path hooks/pre-push`, which respects `core.hooksPath`. Or a husky or lefthook config names `pre-push`. With a hook, it takes `full-suite`, runs `git push`, and releases the lock also when the push fails. With no hook, it runs `git push` and takes no lock. It prints which case it used. Its exit code is the exit code of `git push`. Only a verified `orch` or `boss` pane can run it.

### `worker allow NAME PATH...`

Approve extra scope after a worker asks a question. Only the verified `orch` or `boss` pane may approve. `worker allow` requires `HERDR_ENV=1` and verifies the caller pane with the same checks as `worker start`.

The paths must be repository-relative and inside the worker worktree. It refuses an absolute path, a parent traversal, a path that resolves outside the repository through a symlink, and every path under `.worker/`. It refuses the whole request when any path is invalid, and it refuses a finished run. A valid approval adds the new paths to the run's allowed paths and appends a history item with the paths, the reason, the time, and the verified caller pane.

`worker collect` uses the approved paths. Its summary and ledger entry include the approval history. A prompt or message alone does not change the approved paths.

Collection records the run before merge. After a successful `--record`, merge the branch, then run `herdr-boss worktree prune --apply` to remove worktrees that pass the safe checks. Collection does not prune worktrees.

`worktree prune` checks the current working directory of processes in every existing worktree it could remove. It also reports parent-PID-1 processes that still use a missing or prunable worktree path. It never removes a worktree while a matching process runs. It blocks all removals when it cannot scan processes. It does not remove dirty, unmerged, primary, live-pane, or uninspectable worktrees.

Before `worktree prune --apply` removes a worktree, it copies `.worker/report.md`, `.worker/report.json`, and `.worker/brief.md` to `.orchestration/reports/<worker name>/` in the main checkout. It copies no other file. It skips a missing file and a file larger than 1 MB, and prints one line for each skipped file, for example `skipped report.md: over 1 MB`. It never overwrites a file. If the archive folder already holds one of the files, the command writes all files to the new folder `<worker name>-<UTC time>`. It adds `-2`, `-3` when that folder also exists. It prints one line for each archive: `archived reports of <name> to <path>`. The `.gitignore` of the project holds `.orchestration/`. If `.worker` or the archive folder is a symlink, or a copy fails, the command prints the error and keeps that worktree. Use `--no-archive` to remove a worktree without the copy.

```sh
herdr-boss worker allow fix-74 docs/parse.md --reason "the fix also needs the parser docs"
```

### Resource leases

| Command | Action |
|---|---|
| `lease acquire POOL [--for SLUG\|WORKER] [--prefer ITEM] [--ttl MINUTES] [--pid PID] [--wait SECONDS] [--env-file FILE]` | Lease one free item of the pool. Print the item on its own line on standard output. |
| `lease bind POOL ITEM --pid PID` | Bind a lease to the server process that uses its port. |
| `lease release POOL ITEM` | Release a lease of your project. The Boss can release any lease. |
| `lease list [POOL]` | Print each pool item and its lease as JSON. A free item has `"lease": null`. Nothing changes. A lease of a ports pool shows `bound`, `listener`, and `pidAlive`. An item with a `portEnv` entry shows `set` or `not set`, never the value. |

Define the pools in `resourcePools` in `~/.herdr-boss/config.json`. See [Resource leases](user-guide.md#resource-leases) in the user guide.

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

A borrowed lease stays until it is released or reclaimed. When no item is free, `lease acquire` exits with code 3 and lists the holders on standard error.

```sh
PORT="$(herdr-boss lease acquire serve-ports --wait 600 --env-file "$TMPDIR/serve.env")"
. "$TMPDIR/serve.env"
npm run serve:live &
herdr-boss lease bind serve-ports "$PORT" --pid $!
herdr-boss lease release serve-ports "$PORT"
```

A lease ends before its TTL in these cases. The bound process is gone: Herdr Boss releases the lease within one tick. The process ID belongs to another process now: the start time differs. The port has no listener for `idleMinutes` of the pool (default 20), also for a lease that no server bound. The holder gets one notice. A `serve-live` helper calls `lease acquire serve-ports --wait 600`, which waits up to 10 minutes for a free port, and binds the lease to its server process.

The client ID of a port: a pool can hold `portEnv` values for each port range, for example `TM_SERVE_LIVE_CLIENT_ID`. A project picks the client ID by port. The lease hands the value over through `worker start --lease` (pane environment) or `lease acquire --env-file`. A port without a value gets no variable. See [Resource leases](user-guide.md#resource-leases).

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
| `worktree prune [--apply] [--no-archive]` | List worktrees that pass the safe checks and show processes in removal candidates. `--apply` removes only worktrees with no blocking process. Before it removes a worktree, `--apply` archives the worker reports. `--no-archive` skips the archive. |
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

The browser command output masks outside hosts in `http`, `https`, `ws`, and `wss` URLs. It replaces the first host label with `<tenant>`, or an IP address with `<ip>`. It keeps the scheme, remaining host labels, port, and path. It removes the query and fragment. It keeps loopback URLs in full, including their query and fragment. It removes user names and passwords from all URLs. It prints `data:` and `javascript:` URLs as `<redacted-url>`. Other URL types stay unchanged.

Add `--full` anywhere in a supported command to print real URLs. Use this flag only when the Owner needs the real address, at a terminal.

Herdr Boss decides browser ownership by the Herdr workspace. Any pane in a project's workspace can change that project's browser, also an unlabeled pane and a worker. The Boss pane and every pane in the Boss workspace can change any project browser. This rule covers browser requests, size changes, close, release, restart, tab changes, page navigation and input, and bookmark changes. A refusal names the pane's workspace and the browser's project. A plain terminal outside Herdr skips the check with a warning.

| Command | Action |
|---|---|
| `browser request SLUG [--headless\|--visible] [--reserve] [--full]` | Launch the project browser. From a Herdr pane, request the browser of your workspace's project, or use the Boss. `--reserve` assigns the port and profile only. |
| `browser list` | All project browsers, ports, profiles, and state. |
| `browser restart SLUG --headless\|--visible [--no-restore]` | Close and relaunch in the chosen mode. Use it for a browser in the state `not responding`; the notice to the orchestrator names the command. The current page reopens unless `--no-restore`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser close SLUG` | Close the browser. The profile and the port lease stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser release SLUG` | Remove the port lease of the project. Refuses while the project Chrome runs. The record and the profile stay. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser size SLUG WIDTH HEIGHT` | Window size for the next launch (320–3840 × 240–2160). From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID WIDTHxHEIGHT [--scale N] [--mobile]` | Set one tab's real window size. Width is 200–3840, height is 150–2160, and scale is 0.5–4. Scale defaults to 1. The command resizes the tab's own window, so every CDP client sees the size. It falls back to device metrics emulation when a window resize is not possible, and it says so. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser viewport SLUG --tab ID --reset` | Restore the window to the launch size and clear any device metrics emulation. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tabs SLUG [--full]` | Tabs with ID, title, URL, visibility, and whether an agent is attached. |
| `browser tab new SLUG [URL] [--full]` | Open a tab in its own background window. Prints the ID. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser tab close SLUG --tab ID [--force]` | Close a tab. Refuses a tab an agent is attached to unless `--force`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser screenshot SLUG [--tab ID] [--out DIR]` | Save a private JPEG and print its path. Use `$TMPDIR` by default, or select a directory with `--out DIR`. |
| `browser navigate SLUG URL [--tab ID] [--full]` | Open an `http` or `https` page. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser click SLUG X% Y% [--tab ID]` | Click at a position relative to the screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser hover SLUG X% Y% [--tab ID]` | Move the mouse to a position relative to the screenshot, with no press, so a hover state or a tooltip shows for the next screenshot. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser drag SLUG X1% Y1% X2% Y2% [--tab ID] [--steps N]` | Press at the first position, move to the second, and release. `N` is the number of moves. `N` is 1 to 60 and defaults to 10. The command does not move HTML5 files. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser text SLUG --stdin [--tab ID]` | Type text from standard input. The text is not echoed. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser key SLUG KEY [--tab ID]` | Send `Tab`, `Enter`, `Backspace`, `Delete`, `Escape`, `Home`, `End`, an arrow key, or `SelectAll`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG list [--full]` | List the bookmarks and the start page of the project. |
| `browser bookmarks SLUG add NAME URL` | Add one bookmark. The name has at most 60 characters. The URL must use `http` or `https` and must not hold a user name or a password. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG rm INDEX` | Remove the bookmark at `INDEX`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG open INDEX [--new-tab] [--full]` | Open the bookmark in the current tab, or in a new tab with `--new-tab`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
| `browser bookmarks SLUG start URL\|none [--full]` | Set the start page of the next launch, or clear it with `none`. From a Herdr pane, only a pane in that project's workspace or the Boss can run this command. |
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
| `handoff activate ID --confirmed` | Label a project successor `orch` and name its agent `<slug>-orch`. Label a Boss successor `boss` and name its agent `boss`. Clear the new name from the source agent first when it uses that name. Label the source pane `orch previous` or `boss previous`. A failed agent rename keeps activation active and prints a command to run by hand. A project handover prompts each running worker once with the line `Your orchestrator is now <slug>-orch (pane <new pane>). Send WORKER REPORT and WORKER QUESTION there.` and records the result in `workerPrompts`. A failed worker prompt is logged and does not fail the activation. Herdr Boss makes one attempt for each worker and handoff, and does not prompt that worker again. A project handover also notifies the project workers and the Boss. A Boss handover notifies the Boss-workspace peers and the Owner. If Herdr reports `pane_not_found` for the source pane, activation skips the source label and the source prompt. The successor prompt says that the source pane was closed before activation. |
| `handoff ready ID` | Sent by an automatic successor when it is ready. |
| `handoff list` | All handover records. Status can be `preparing`, `prepared`, `needs-inspection`, `active`, `superseded`, or `expired`. |

`--mode migrate` (the default) converts the session with `session-migrate`. If migration is unavailable or transfer fails, preparation uses fresh mode and records the reason. `--mode fresh` starts the successor without a migrated session. `--force` allows a target provider near exhaustion.

`handoff plan` reports when Claude session migration is unavailable because the active graph has an ancestry cycle. `handoff prepare` then uses fresh mode automatically.

`handoff plan` measures the migrated session before it reports migration as available. After a successful dry run, it runs the same transfer with `--home` set to a new temporary directory under the system temporary directory. It adds the byte sizes of the `.jsonl` files in that directory and then deletes the directory. The estimate is one token for each 4 bytes, rounded up. The migrated session fits when the estimate is at most 60% of the target window. `migration.fit` records `bytes`, `estimatedTokens`, `contextTokens`, `limitTokens`, `fits`, and `sizeKnown`. When the session does not fit, the plan sets `migration.available` to `false` with this error: `Migrated session is too large for the target window: about N tokens against a limit of M.` `handoff prepare` then uses fresh mode and records the same text in `migrationFallbackReason`. The successor prompt at activation includes that reason.

A live source session can change while `session-migrate` reads it. A failed measuring transfer therefore runs one more time. If the second attempt also fails, `migration.fit.sizeKnown` is `false`. Migration stays available, and `migration.warning` says that the size is unknown. Migration also stays available with a warning when the target model has no window in `kit/models.json`.

The target window comes from `kit/models.json`. The optional `contextTokens` field of a kind gives the window in tokens. The optional `contextTokensByModel` object of a kind gives the window for one model and overrides `contextTokens`. Each value must be a positive integer. `claude` and `codex` set `contextTokens` to `200000`.

After activation, the engine finishes the handover on each tick. The successor is confirmed when it works and then settles (it answered the activation prompt), or when 15 minutes pass with the old pane `idle` or `done`. After confirmation, Herdr Boss closes the old pane when it has been `idle` or `done` for 60 seconds. It then renames the successor tab from `Orchestrator Next` to `Orchestrator`. Herdr Boss never closes an old pane that works, is blocked, or has been settled for less than 60 seconds. It also keeps a pane whose label is not `orch previous`. The Boss note after 60 minutes names each reason. A running worker does not keep the old pane open. It renames only the live tab of the successor pane, never a recorded tab id. It merges the `finish` fields into the current `handoffs.json`, so a concurrent CLI write stays. A Boss record gets no `finish` object: the Owner closes the old Boss pane and keeps the tab name by hand, and Herdr Boss closes no unused Boss successor. It retries on each tick. If the old pane is still busy 60 minutes after activation, Herdr Boss sends one line to the pane labeled `boss`. The record field `finish` holds `plannedAt`, `workedAt`, `confirmedAt`, `confirmedBy` (`answered` or `timeout`), `closedAt`, `tabRenamedAt`, and `doneAt`. A successor that expires without activation, or that another successor replaces for the same source, keeps its tab until the next tick. Herdr Boss then closes that tab, or the pane when the tab holds other panes. It never closes a labeled pane. If the early close did not run, Herdr Boss closes the old pane after 120 minutes when the current pane list confirms both pane roles. A later handover can mark the record as superseded. The old pane stays eligible for retirement, and Herdr Boss follows the successor chain to the current active pane. Unavailable pane data defers retirement to a later engine tick. The current successor receives one retirement notice.

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
2. The command waits until the pane can take a command. One deadline of 10 minutes from the start covers the wait and every retry. The pane can take a command when the agent status is `idle` or `done`, the screen shows the empty input prompt of the harness, and no dialog is on the screen. A ghost suggestion in the input line counts as an empty input line. The command reads the pane with `--format ansi` to see the style. A ghost suggestion is text that is dim (SGR 2) with the default foreground from the first to the last non-space character, and that sets the dim style after the prompt marker. Any other style, an unknown escape sequence, or text without a style counts as typed text. The command polls every 5 seconds and reads the pane again each time. Each blocker has a limit: `the agent works` 10 minutes, `the input box holds unsent text` 2 minutes, `a dialog is on screen` 2 minutes. `the pane is gone` and `the pane is not an orchestrator` fail at once.
3. The command sends the goal as one prompt without `--wait`. A Claude pane gets `/goal TEXT`. A pane of another harness gets the plain sentence `[herdr-boss] The current Owner goal is: TEXT`. `goalDelivery()` in `src/goal.js` decides which.
4. The command reads the screen before the send and again after it. The goal is active when its text is new on the screen and the pane shows the goal confirmation, or the pane is idle with an empty input line. A goal that is typed or queued in the input line, or an old identical `/goal` in the scrollback, does not count. `goalVerdict()` in `src/goal.js` decides. The command checks up to 5 times, 2 seconds apart.
5. If the goal does not show, the command waits for an idle pane again. Before each new send it checks whether the earlier goal rendered late. It sends at most 3 times.

One function gives the blocker reason. The waiting line, the dry run, the result, and the dashboard status all print it in the same words. The reason never holds pane text. The command never clears, edits, or sends into an input line that holds typed text.

When the wait fails because of `the agent works`, `the input box holds unsent text`, or `a dialog is on screen`, the command adds one Mailbox item with the action `answer` for the Owner. The item names the project, the pane ID, and the reason, for example `Goal not set on alpha: the input box of pane wX:p1 holds unsent text. Send or clear it, then press Set goal again.` The command adds at most one item for each project and reason in one hour.

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
