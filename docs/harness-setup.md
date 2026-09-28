# Harness setup

Herdr Boss orchestration needs settings in each agent harness on the machine. This page gives each setting, the reason for it, its file, who applies it, and its risk. The templates are in [`kit/templates/harness/`](../kit/templates/harness/).

`herdr-boss harness check` reads the live settings and reports each missing entry. `herdr-boss harness sync` adds the missing Codex writable roots and prints the Claude lines for the Owner. The commands are in [cli.md](cli.md#harness-settings).

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

## Claude

WARNING: Agents cannot edit `~/.claude/settings.json`. The auto-mode classifier blocks the change. The Owner applies the Claude settings by hand.

| Setting | File | Applied by |
|---|---|---|
| `autoMode.environment` lines | `~/.claude/settings.json` | The Owner. |
| `autoMode.allow`, with `"$defaults"` first | `~/.claude/settings.json` | The Owner. |
| `--permission-mode auto` for workers | `kit/models.json` | Herdr Boss. `worker start` adds it. |
| The `SessionStart` hook | `.claude/settings.json` in each project | `herdr-boss kit install`. |

The auto-mode classifier reads `autoMode` only from `~/.claude/settings.json`. A project settings file has no effect on `autoMode`.

The `environment` lines tell the classifier about the supervisor, the Boss messages, the project repositories, and the Owner decisions. Without them, the classifier treats a Boss message as third-party input. It also refuses routine work in a project that the `**Herdr Boss projects**` line does not name. Template: `claude-automode.json`, key `environment`.

The `allow` lines let an orchestrator push its own repository to its own `origin`, remove its own merged worker worktrees, record Owner decisions, and edit the kit in the Herdr Boss repository. Keep `"$defaults"` as the first entry. Without it, the built-in allow rules stop. Template: `claude-automode.json`, key `allow`.

Do not add a `permissions.allow` rule for `git push`. A hard allow rule skips the classifier, and it also matches a force-push. The prose `allow` rules let the classifier refuse a force-push and a push to another remote.

`--permission-mode auto` starts a worker with the classifier and the Owner's `autoMode` rules. Without it, a worker runs in the default mode and stops on a permission dialog.

The `SessionStart` hook prints the kit file and the project memory at each session start. `kit install` writes it.

To apply the lines:

1. Run `herdr-boss harness sync`. It prints the filled `claude-automode.json`.
2. Back up the file: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
3. Merge the printed `environment` lines into `autoMode.environment`.
4. Merge the printed `allow` lines into `autoMode.allow`. Keep `"$defaults"` first.
5. Check the file: `python3 -m json.tool ~/.claude/settings.json >/dev/null && echo OK`.
6. Start a new Claude session. A running session can keep the old settings.

| Risk | Effect |
|---|---|
| The `allow` push rule | An orchestrator pushes without an Owner prompt. The classifier still refuses a force-push. |
| A wrong `**Herdr Boss projects**` line | The classifier trusts a folder that is not a project. |

## Codex

| Setting | File | Applied by |
|---|---|---|
| `[sandbox_workspace_write]` `writable_roots` | `~/.codex/config.toml` | `herdr-boss harness sync`. |
| `herdr.rules` | `~/.codex/rules/herdr.rules` | The Owner, from `codex-herdr.rules`. |
| `-s workspace-write` | `kit/models.json` | Herdr Boss. |

The Codex sandbox refuses writes outside the worktree. An orchestrator must write the `.git` folder of its main repository to commit, merge, and add a worktree. It must also write `~/.herdr-boss` for locks, scratch folders, and reports. Each project needs one `<repo>/.git` root. Template: `codex-sandbox.toml`.

WARNING: Keep `~/.config/herdr-boss` out of `writable_roots`. It holds the private token. A parent folder such as `~/.config` also makes it writable.

`writable_roots` does not accept globs. Sibling worker worktrees (`<project>-wt-<name>`) are not covered.

`herdr.rules` lets `ps`, the restart of the Herdr Boss service, `herdr-boss browser`, and `playwright-cli` run outside the sandbox. It forbids `ps e`, `ps -E`, `ps eww`, `ps auxe`, and `ps auxeww`, because they print the environment of other processes. Template: `codex-herdr.rules`. Replace `{{UID}}` with the output of `id -u`.

`-s workspace-write` sets the sandbox mode for a worker, so the mode does not depend on the trust defaults.

To apply the rules:

1. Copy `kit/templates/harness/codex-herdr.rules` to `~/.codex/rules/herdr.rules`.
2. Replace `{{UID}}` with the output of `id -u`.
3. Check the file: `codex execpolicy check --pretty --rules ~/.codex/rules/herdr.rules`.
4. Run `herdr-boss harness sync` for the writable roots.
5. Start a new Codex session.

| Root or rule | Risk |
|---|---|
| `~/.herdr-boss` | An agent can damage the shared Herdr Boss state. |
| The caches (`~/.cache`, `~/.npm`, the Playwright cache) | Cache poisoning. The risk is low. |
| Each `<repo>/.git` | Git hooks become writable, so code can run outside the sandbox later. The sandbox gives no other way to commit. |
| The `launchctl` rule | It allows a restart of the Herdr Boss service only. |
| The `ps` allow rule | `ps` can show process arguments. The kit rule forbids a print of full command lines. |

## OpenCode

| Setting | File | Applied by |
|---|---|---|
| The `worker` agent | `~/.config/opencode/opencode.json`, key `agent.worker` | The Owner, from `opencode-worker-agent.json`. |
| `--agent worker` | `kit/models.json` | Herdr Boss. |

The `worker` agent never asks. It allows edits in the worktree and denies each other folder except the temporary folders and `~/.herdr-boss`. It denies `git push`, `git reset --hard`, `git clean`, `git branch -D`, `git worktree remove`, `rm -rf` outside the temporary folders, `sudo`, `launchctl`, the private Herdr Boss folder, and credential files. Without it, an unattended worker stops on a permission dialog.

WARNING: `opencode.json` can hold provider keys. Do not print it. `harness check` reads only the `agent.worker` key and prints no value.

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

`herdr-guard.ts` keeps a worker inside its worktree. File tools can use only the worktree, the temporary folders, and `~/.herdr-boss`. The guard blocks the same commands as the OpenCode `worker` agent. It never asks. A blocked call returns a reason to the worker.

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

- Codex: `writable_roots` holds `<repo>/.git` for each registered project, and `{{HOME}}/.herdr-boss`.
- Codex: no root makes `~/.config/herdr-boss` writable.
- Codex: `herdr.rules` forbids each of the five `ps` forms.
- Claude: the `**Herdr Boss projects**` line in `autoMode.environment` names each registered project.
- OpenCode: `agent.worker` exists.
- Pi: `herdr-guard.ts` exists.
- `kit/models.json`: the launch flags on this page.

`harness sync` does these steps:

1. It copies `~/.codex/config.toml` to `config.toml.bak-<UTC timestamp>`.
2. It rewrites the `writable_roots` array in `[sandbox_workspace_write]`. It keeps each entry and adds each missing root at the end. It changes no other line.
3. It prints the filled Claude `autoMode` lines. It does not edit `~/.claude/settings.json`.

When the section or the array is missing, or holds a comment or a value that is not a plain string, `harness sync` changes nothing. It prints the lines to add and exits 1. When no root is missing, it makes no backup. `--dry-run` prints the roots to add and writes nothing. `--codex-only` does not print the Claude lines.

## Denial counts

Herdr Boss counts denials and permission prompts in the harness logs. It keeps only the day, the harness, the cause, the project, and the count. It keeps no message text, command, argument, or path. A cause with text that is not a known class becomes `other`.

| Harness | Log | Cause |
|---|---|---|
| Claude | `~/.claude/projects/*/*.jsonl` | `classifier:<Reason>`: a tool result refused by the auto mode classifier. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `sandbox:eperm`, `sandbox:not-permitted`, and `sandbox:permission-denied`: a tool output with `EPERM`, `Operation not permitted`, or `Permission denied`. Each output counts once for each cause. |
| Codex | The same files | `escalation:request`: a tool call with `sandbox_permissions` set to `require_escalated`. |
| OpenCode | `~/.local/share/opencode/log/opencode.log` | `permission:asked:<type>`: a `message=asking` line. `permission:unanswered:<type>`: an `asking` line with no `message=replied` line for its `id=` within 10 minutes. |
| Pi | `~/.pi/agent/sessions/<folder>/*.jsonl` | `guard:<class>`: a tool result blocked by the Herdr guard. The classes are `outside-worktree`, `protected-path`, `rm-rf`, `denied-command`, and `other`. |

The project comes from the `cwd` of a Claude record and of a Codex session. OpenCode takes it from the `cwd=` field of another line with the same `run=` value. Pi takes it from the session folder name. The dashboard shows the counts on the Analytics page. See [the user guide](user-guide.md#denials-and-permission-prompts).

## Known limits

Codex cannot launch Chromium in its sandbox. The seatbelt sandbox refuses the Chromium Mach port (`MachPortRendezvousServer`, permission denied, error 1100). Herdr Boss does not loosen the sandbox for this. Give tasks that launch a browser to a `claude`, `opencode`, or `pi` worker. `worker start --kind codex` prints a warning when the brief mentions browser work.
