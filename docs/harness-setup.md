# Harness setup

Herdr Boss orchestration needs settings in each agent harness on the machine. This page gives each setting, the reason for it, its file, who applies it, and its risk. The templates are in [`claude-automode.json`](../kit/templates/harness/claude-automode.json), [`codex-herdr.rules`](../kit/templates/harness/codex-herdr.rules), [`codex-sandbox.toml`](../kit/templates/harness/codex-sandbox.toml), [`opencode-worker-agent.json`](../kit/templates/harness/opencode-worker-agent.json), and [`pi-herdr-guard.ts`](../kit/templates/harness/pi-herdr-guard.ts).

`herdr-boss harness check` reads the live settings and reports each missing entry. `herdr-boss harness sync` adds missing Codex writable roots and prints only the Claude lines that differ. The commands are in [cli.md](cli.md#harness-settings).

## Placeholders

The templates use only these placeholders. `harness sync` fills them when it prints a template.

| Placeholder | Value |
|---|---|
| `{{HOME}}` | The home folder of the user. |
| `{{UID}}` | The numeric user ID, as in `id -u`. |
| `{{HERDR_BOSS_REPO}}` | The folder of the Herdr Boss repository. |
| `{{HERDR_BOSS_URL}}` | The dashboard URL, for example `http://127.0.0.1:4477`. |
| `{{PROJECT_LIST}}` | One line of `path (remote)` entries, one entry for each registered project. |

## Registered projects

The first `herdr-boss publish SLUG FILE` for a slug registers the project. The command records `{ slug, repo, remote }` in `project-repos.json` in the data folder, with mode 0600. `repo` is the Git top level of the current folder. `remote` is the `origin` URL. The command removes a user name and a password from an `http` or `https` remote before it saves it. A later publish keeps the first record.

When `publish` registers a new slug, it runs `harness sync --codex-only`. It prints the result as `warning: harness sync:` lines. The publish succeeds also when the sync fails.

### GitHub login for `project new`

The step `remote` of `herdr-boss project new --remote gh` needs a `gh` login on this machine.

1. Run `gh auth login` in a terminal. Herdr Boss never runs it.
2. Run `gh auth status` to check the login.
3. Run the `project new` command again with `--resume`.

Herdr Boss uses the stored login of `gh`. It never reads, prints, or stores the token. The step creates a repository only after you answer the Mailbox item.

## Claude

WARNING: Agents cannot edit `~/.claude/settings.json`. The auto-mode classifier blocks the change. The Owner applies the Claude settings by hand.

| Setting | File | Applied by |
|---|---|---|
| `autoMode.environment` lines | `~/.claude/settings.json` | The Owner. |
| `autoMode.allow`, with `"$defaults"` first | `~/.claude/settings.json` | The Owner. |
| `--permission-mode auto` and `--disallowedTools AskUserQuestion` for workers | `kit/models.json` | Herdr Boss. `worker start` and handoff add them. |
| The `SessionStart` hook | `.claude/settings.json` in each project | `herdr-boss kit install`. |
| `permissions.deny` with `AskUserQuestion` | `.claude/settings.json` in each project | `herdr-boss kit install`. |

The auto-mode classifier reads `autoMode` only from `~/.claude/settings.json`. A project settings file has no effect on `autoMode`.

The `environment` lines tell the classifier about the supervisor, the Boss messages, the project repositories, and the Owner decisions. Without them, the classifier treats a Boss message as third-party input. It also refuses routine work in a project that the `**Herdr Boss projects**` line does not name. The same line names the worker worktree folders: `~/Projects/.herdr-wt/<repo>/<name>`, and the older sibling folders `<project>-wt-<name>`. Template: `claude-automode.json`, key `environment`.

The `allow` lines let an orchestrator push its own repository to its own `origin`, remove its own merged worker worktrees, record Owner decisions, and edit the kit in the Herdr Boss repository. Keep `"$defaults"` as the first entry. Without it, the built-in allow rules stop. Template: `claude-automode.json`, key `allow`.

Do not add a `permissions.allow` rule for `git push`. A hard allow rule skips the classifier, and it also matches a force-push. The prose `allow` rules let the classifier refuse a force-push and a push to another remote.

`--permission-mode auto` starts a worker with the classifier and the Owner's `autoMode` rules. Without it, a worker runs in the default mode and stops on a permission dialog.

Do not use `AskUserQuestion` in a Claude orchestrator or worker. `worker start` and handoff pass `--disallowedTools AskUserQuestion` to Claude. `kit install` adds `AskUserQuestion` to `permissions.deny` in the project settings file. Keep every existing setting and deny entry.

The `SessionStart` hook prints the kit file and the project memory at each session start. `kit install` writes it.

To apply the Claude lines:

1. Run `herdr-boss harness sync`. It compares the filled template with `autoMode` in `~/.claude/settings.json`.
2. Back up an existing file: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
3. Add each `missing` line to its `environment` or `allow` array.
4. Replace each old environment line after `now:` with the new line above it.
5. Keep all other Owner lines. The command counts them and does not show their text.
6. When the file or `autoMode` key is missing, add the full template to an `autoMode` object. The command says when this is the case.
7. Check the file: `python3 -m json.tool ~/.claude/settings.json >/dev/null && echo OK`.
8. Start a new Claude session. A running session can keep the old settings.

| Risk | Effect |
|---|---|
| The `allow` push rule | An orchestrator pushes without an Owner prompt. The classifier still refuses a force-push. |
| A wrong `**Herdr Boss projects**` line | The classifier trusts a folder that is not a project. |
| A parent folder in the `**Herdr Boss projects**` line | The classifier trusts each repository in that folder that holds the marker file. Name only a folder that holds projects. |

## Codex

Use `herdr-boss browser` commands to access the project browser from a Codex worker. Herdr Boss launches Chromium outside the Codex sandbox. The worker warning ignores these commands and the phrase `the project browser`. The warning still tells you to choose another worker kind when the brief asks for Playwright, Puppeteer, gallery work, a screenshot tool, or another Chromium launch.

| Setting | File | Applied by |
|---|---|---|
| `[sandbox_workspace_write]` `writable_roots` | `~/.codex/config.toml` | `herdr-boss harness sync`. |
| `herdr.rules` | `~/.codex/rules/herdr.rules` | The Owner, from `codex-herdr.rules`. |
| `-s workspace-write` | `kit/models.json` | Herdr Boss. |

The Codex sandbox refuses writes outside the worktree. An orchestrator must write the `.git` folder of its main repository to commit, merge, and add a worktree. It must also write `~/.herdr-boss` for locks, scratch folders, and reports. A worker must write its worktree. All worker worktrees are in the parent folder `~/Projects/.herdr-wt`, so that folder is one root. Each project needs one `<repo>/.git` root. Workers commit through the `.git` folder of the main repository. Template: `codex-sandbox.toml`.

WARNING: Keep `~/.config/herdr-boss` out of `writable_roots`. It holds the private token. A parent folder such as `~/.config` also makes it writable.

`writable_roots` does not accept globs. Older sibling worker worktrees (`<project>-wt-<name>`) are not covered. A Codex worker in such a worktree cannot write its files. Remove the worktree with `herdr-boss worktree prune --apply` when its branch is merged.

`herdr.rules` lets `ps`, the restart of the Herdr Boss service, `herdr-boss browser`, and `playwright-cli` run outside the sandbox. It forbids `ps e`, `ps -E`, `ps eww`, `ps auxe`, and `ps auxeww`, because they print the environment of other processes. Template: `codex-herdr.rules`. Replace `{{UID}}` with the output of `id -u`.

`-s workspace-write` sets the sandbox mode for a worker, so the mode does not depend on the trust defaults.

A Codex tool shell can run under a shared app-server daemon with the daemon environment. `worker start --kind codex` adds one `-c shell_environment_policy.set.<NAME>="<value>"` argument for each Herdr variable of the new pane. Do not add these variables to `~/.codex/config.toml`. Run `herdr-boss harness check --live-codex` to check that a Codex tool shell gets them.

To apply the rules:

1. Copy `kit/templates/harness/codex-herdr.rules` to `~/.codex/rules/herdr.rules`.
2. Replace `{{UID}}` with the output of `id -u`.
3. Check the file: `codex execpolicy check --pretty --rules ~/.codex/rules/herdr.rules`.
4. Run `herdr-boss harness sync` for the writable roots. It adds `~/Projects/.herdr-wt`, `~/.herdr-boss`, and each missing `<repo>/.git`.
5. Start a new Codex session.

| Root or rule | Risk |
|---|---|
| `~/.herdr-boss` | An agent can damage the shared Herdr Boss state. |
| `~/Projects/.herdr-wt` | An agent can change the worktrees of other workers and other projects. |
| The caches (`~/.cache`, `~/.npm`, the Playwright cache) | Cache poisoning. The risk is low. |
| Each `<repo>/.git` | Git hooks become writable, so code can run outside the sandbox later. The sandbox gives no other way to commit. |
| The `launchctl` rule | It allows a restart of the Herdr Boss service only. |
| The `ps` allow rule | `ps` can show process arguments. The kit rule forbids a print of full command lines. |

### Background commands in the Codex sandbox

A Codex tool shell is zsh. zsh runs a background job (`command &`) at a lower priority, because its `BG_NICE` option is on by default. The Codex sandbox refuses that priority change, so zsh prints `nice(5) failed: operation not permitted`. The job still starts, and the exit code is 0. The message is not a failure.

To start a server in the background without the message, use one of these forms:

- `setopt NO_BG_NICE; npm run serve:live > .worker/tmp/serve.log 2>&1 &`
- `bash -c 'npm run serve:live > .worker/tmp/serve.log 2>&1 &'`

`nohup` does not remove the message. Check that the server answers before you use it, for example with `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/`. Stop the server before you write the report.

## OpenCode

| Setting | File | Applied by |
|---|---|---|
| The `worker` agent | `~/.config/opencode/opencode.json`, key `agent.worker` | The Owner, from `opencode-worker-agent.json`. |
| `--agent worker` | `kit/models.json` | Herdr Boss. |

The `worker` agent never asks. It allows edits in the worktree and denies each other folder except the temporary folders and `~/.herdr-boss`. It denies `git push`, `git reset --hard`, `git clean`, `git branch -D`, `git worktree remove`, `rm -rf` outside the temporary folders, `sudo`, `launchctl`, the private Herdr Boss folder, and credential files. Without it, an unattended worker stops on a permission dialog.

WARNING: `opencode.json` can hold provider keys. Do not print it. `harness check` reads only the `agent.worker` key and prints no value.

The OpenCode worker profile checks the command string and the tool name. It is not a sandbox. A worker can reach a denied folder through bash, for example with cat or ls, although external_directory denies it. Treat the profile as a guard against mistakes, not as a security boundary.

To apply the agent:

1. Open `~/.config/opencode/opencode.json` in an editor.
2. Add the object from `opencode-worker-agent.json` as `agent.worker`.
3. Start a new OpenCode session.

| Risk | Effect |
|---|---|
| `"bash": { "*": "allow" }` | The worker runs each command that the deny list does not match. |

## Pi

| Setting | File | Applied by |
|---|---|---|
| `herdr-guard.ts` | `~/.pi/agent/extensions/herdr-guard.ts` | The Owner, from `pi-herdr-guard.ts`. |
| `--no-approve` | `kit/models.json` | Herdr Boss. |
| `--no-extensions` and `-e` for each extension | `kit/models.json` | Herdr Boss. |

`herdr-guard.ts` keeps a worker inside its worktree. File tools can use only the worktree, the temporary folders, and `~/.herdr-boss`. The guard blocks the same commands as the OpenCode `worker` agent. It allows `rm -rf` on a path inside the worktree `.worker` folder and on a path inside a temporary folder. It blocks `rm -rf` with a pattern, and `rm -rf` on the worktree or on the `.worker` folder itself. It never asks. A blocked call returns a reason to the worker. Each reason names the form that the worker may use instead, with an example for a blocked `rm -rf`. A blocked `pkill` or `killall` names `kill <pid> of a process that you started, with the PID you saved (pgrep -l NAME shows the PID)`.

`--no-approve` stops Pi from loading project-local settings, resources, and packages. `--no-extensions` stops the automatic extension load. Each `-e` then loads one named extension, so the guard is always loaded.

To apply the guard:

1. Copy `kit/templates/harness/pi-herdr-guard.ts` to `~/.pi/agent/extensions/herdr-guard.ts`.
2. Start a new Pi worker.

| Risk | Effect |
|---|---|
| A bash command that the deny list does not match | The guard lets it run. The guard is a check of the command text, not a sandbox. |

## Check and sync

`harness check` prints one line for each entry: `ok`, `missing`, or `bad`, then the harness and the entry. The last line is a summary. The command exits 1 when an entry is `missing` or `bad`. It prints only paths and entry names, never another setting value.

`harness check` checks these entries:

- Codex: `writable_roots` holds `<repo>/.git` for each registered project, `{{HOME}}/.herdr-boss`, and `{{HOME}}/Projects/.herdr-wt`.
- Codex: no root makes `~/.config/herdr-boss` writable.
- Codex: `herdr.rules` forbids each of the five `ps` forms.
- Claude: the `**Herdr Boss projects**` line in `autoMode.environment` names each registered project, or names a parent folder of the project. See "Parent folder line".
- OpenCode: `agent.worker` exists.
- Pi: `herdr-guard.ts` exists.
- `kit/models.json`: the launch flags on this page.
- Codex live, only with `--live-codex`: one `codex exec` tool shell has `HERDR_ENV` and `HERDR_PANE_ID`. The check uses the default Codex model with `model_reasoning_effort=low` and stops after 180 seconds. It prints `set` or `missing` for each variable, never a value. Without `--live-codex`, `harness check` calls no model.

`harness sync` does these steps:

1. It copies `~/.codex/config.toml` to `config.toml.bak-<UTC timestamp>`.
2. It rewrites the `writable_roots` array in `[sandbox_workspace_write]`. It keeps each entry and adds each missing root at the end. It changes no other line.
3. It reads only the `autoMode` key in `~/.claude/settings.json`. It compares its `environment` and `allow` lines with the filled template.
4. It prints each missing line and each changed labeled environment line. It shows the old line after `now:`. The recommended `**Herdr Boss projects**` line names parent folders. See "Parent folder line".
5. It counts Owner lines that the template does not define. It does not show their text.
6. If the file or the `autoMode` key is missing, it prints the full template and says why.
7. It does not edit `~/.claude/settings.json`.

When the section or the array is missing, or holds a comment or a value that is not a plain string, `harness sync` changes nothing. It prints the lines to add and exits 1. When no root is missing, it makes no backup. `--dry-run` prints the roots to add and writes nothing. `--codex-only` does not print the Claude lines.

`harness check` checks the project line in Claude settings. It ignores other Owner lines.

### Parent folder line

The `**Herdr Boss projects**` line can name parent folders in place of each project. A new project inside a named parent needs no change to the line.

A parent line must do these things:

1. Name one or more parent folders, for example `/work/apps/` and `/work/tools/`.
2. State the marker rule: a folder is a Herdr Boss project when it holds `docs/orchestration/herdr-boss.md`.
3. Name the worker worktree root, `~/Projects/.herdr-wt/<repo>/<name>`.

`harness check` counts a registered project as covered when its repository path lies inside a named parent folder. The line must contain `docs/orchestration/herdr-boss.md`. The output says `covers <repo> (<slug>) through the parent folder <parent>`. A project outside every named parent is `missing` and the check lists it.

`harness check` compares real paths. It resolves symbolic links and `..` segments in the repository path and in each parent folder of the line. A folder such as `/work/apps.old/` does not name `/work/apps`.

The marker file must follow the word `holds`, `contains`, or `has` in the sentence that states the rule. A sentence that says the file is not required does not state the rule.

A line that names each project path still passes. A line that names one project does not cover its sibling projects.

`harness sync` prints the parent folder line as the recommended line. It builds the line from the parent folder of each registered repository:

- It names each distinct parent once, in sorted order.
- It names at most 10 parents.
- It drops a parent that lies inside another named parent.
- It never names `/`, the home folder, or a folder above the home folder. A project directly under such a folder is named by its path.

The Codex `writable_roots` array cannot use folders as patterns. `project new` and `harness sync` add `<repo>/.git` for each project.

Example of a recommended line:

```text
**Herdr Boss projects**: every repository under /work/apps/ or /work/tools/ that contains the file docs/orchestration/herdr-boss.md is a Herdr Boss project, with its own origin remote only. Worker worktrees are in ~/Projects/.herdr-wt/<repo>/<name>. A folder without that file is not a Herdr Boss project.
```

## Denial counts

Herdr Boss counts denials and permission prompts in the harness logs. Each record has the day, harness, cause, project, model, and count. It uses `unknown` when a log has no model. It keeps no message text, command, argument, or path. A cause with text that is not a known class becomes `other`.

| Harness | Log | Cause |
|---|---|---|
| Claude | `~/.claude/projects/*/*.jsonl` and `~/.claude/projects/*/*/subagents/*.jsonl` | `classifier:<Reason>`: a tool result refused by the auto mode classifier. The model comes from the latest assistant message. A reason starts with a letter. It can contain letters, spaces, hyphens, and parentheses. It can have at most 60 characters. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `sandbox:mach-port`, `sandbox:eperm`, `sandbox:not-permitted`, and `sandbox:permission-denied`: count only when the output has a non-zero exit code. A batched exec output holds one block per command. Each block starts with a `Chunk ID:` or `Wall time:` line, has its own exit code line, and holds its own keywords. Herdr Boss checks each block on its own, so a failed command next to a command that passed does not add a count. The model comes from the turn context. A Mach port cause needs `bootstrap_look_up`, `mach-lookup`, or `Mach port` with `denied`, `not permitted`, `failed`, or `1100`. Count one cause per failed output, in this order: `sandbox:mach-port`, `sandbox:eperm`, `sandbox:not-permitted`, `sandbox:permission-denied`. |
| Codex | The same files | `escalation:request`: a `function_call` row, such as `exec_command` or `shell`, whose arguments set `sandbox_permissions` to `require_escalated`. A command that only quotes this text does not count. A command that reads the session logs does not count. Herdr Boss counts each call once, by its call ID, time, and cause, also when a forked session repeats the row. |
| OpenCode | `~/.local/share/opencode/log/*.log` | `permission:asked:<type>`: a `message=asking` line. `permission:unanswered:<type>`: an `asking` line with no `message=replied` line for its `id=` within 10 minutes. `permission:<type>`: a permission evaluation whose final matching rule denies the action for the `worker` agent. The model and agent come from the session log. |
| Pi | `~/.pi/agent/sessions/<folder>/*.jsonl` | `guard:<class>`: a tool result blocked by the Herdr guard. The model comes from the latest model change or assistant message. The classes are `outside-worktree`, `protected-path`, `rm-rf`, `denied-command`, and `other`. |

The project comes from the `cwd` of a Claude record and of a Codex session. OpenCode takes it from the `cwd=` field of another line with the same `run=` value. Pi takes it from the session folder name. The dashboard shows the counts on the Analytics page. See [the Reference](reference/locks.md#denials-and-permission-prompts).

## Known limits

Claude Code keeps one memory folder per working folder. Start the Boss agent in `~/.herdr-boss`, so its memory is separate from the memory of each project orchestrator.


Codex cannot launch Chromium in its sandbox. The seatbelt sandbox refuses the Chromium Mach port (`MachPortRendezvousServer`, permission denied, error 1100). Herdr Boss does not loosen the sandbox for this. Give tasks that launch a browser to a `claude`, `opencode`, or `pi` worker. `worker start --kind codex` prints a warning when the brief mentions browser work.

## CodexBar Claude source

Herdr Boss reads the Claude quota through `codexbar usage --provider claude`.

Set the Claude usage source in CodexBar to **Auto**. Do not set it to **CLI**. The CLI source is slow.

A Claude quota probe that times out at about 30 seconds points to the **CLI** source. With **Auto**, the probe takes about 2 seconds.

Read `endedStep` in `quota-probe-history.jsonl` to see which step ended the probe. The value `codexbar-timeout` means that CodexBar gave up by itself.
