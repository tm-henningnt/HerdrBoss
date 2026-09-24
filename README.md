# Herdr Boss

Herdr Boss supervises the orchestrator agents that run in [Herdr](https://herdr.dev). It watches token quotas and machine resources, and it tells orchestrators when they must change how they work. It also serves one shared dashboard for all projects.

Herdr Boss is a script. It does not use an LLM and it uses no tokens.

## What it does

Every 30 seconds, Herdr Boss collects:

- Herdr workspaces, panes, agents, and agent status (`herdr ... list`).
- Machine load, free memory, and swap.
- Automation browsers, browser MCP servers, and `agent-browser` daemons. It finds the owner pane from the process tree.

Every 5 minutes, it collects token quotas with `codexbar usage --format json`.

Then it applies rules and writes three files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read this file before they start workers. |
| `state.json` | The full snapshot. The dashboard shows this data. |
| `events.jsonl` | The log of prompts, notifications, and terminated processes. |

## Rules

| Condition | Action |
|---|---|
| A quota window is at 98% or more | Critical. Prompt all orchestrators, notify the user, and tell orchestrators in the bulletin not to start agents of that kind. |
| A quota window is at 90% or more | Warning. Prompt all orchestrators and notify the user. |
| A quota runs out before its reset at the current pace | Advice in the bulletin. |
| Free memory is less than 15% | Prompt all orchestrators and notify the user. |
| The 5-minute load is more than 2 × the core count | Prompt all orchestrators and notify the user. |
| An idle worker still owns an automation browser after 30 minutes | Prompt the orchestrator of that workspace. |
| An automation browser has no owner and is older than 1 hour | Prompt all orchestrators. Herdr Boss does not terminate browsers. |
| A shared browser (`sharedBrowsers` in the configuration) is not running | Notify the user. |
| A worker has been idle for more than 2 hours | Prompt the orchestrator of that workspace. |
| An `agent-browser` daemon has no parent and no children and is older than 2 hours | Terminate the daemon. Herdr Boss keeps a daemon that started up to 10 minutes before a running automation browser, because that daemon can own the browser. |

Herdr Boss never reports or touches a browser in `sharedBrowsers`. The default is the Chrome on port 9222, which holds the signed-in Qlik tenant session.

Herdr Boss sends a prompt only to a pane with the label `orch`, and only when that agent is `idle` or `done`. It sends the same alert to the same pane at most once in 6 hours. It sends it again sooner only when the severity increases. It sends a user notification once for each alert.

## Label an orchestrator

Herdr Boss finds orchestrators by pane label. Tab names do not matter.

1. Find the pane ID. Run `herdr pane list | jq -r '.result.panes[] | "\(.pane_id) \(.agent) \(.terminal_title_stripped)"'`.
2. Set the label. Run `herdr pane rename <pane-id> orch`.
3. To remove the label, run `herdr pane rename <pane-id> --clear`.

An orchestrator can label its own pane: `herdr pane rename "$HERDR_PANE_ID" orch`.

In the Herdr TUI, you can also rename the pane. The label must be `orch`.

The pane label stays when the agent in the pane restarts. An agent name (`herdr agent rename`) does not stay. Herdr clears it when the agent exits.

## Install

Node 22 or later, `herdr`, and `codexbar` must be in `/opt/homebrew/bin`.

1. Run `bin/herdr-boss install`. This installs the launchd agent `no.tallmaker.herdr-boss` and starts it.
2. Put `bin/herdr-boss` on your `PATH`. For this machine, link it with `ln -s "$(pwd)/bin/herdr-boss" ~/.local/bin/herdr-boss`.
3. Open http://127.0.0.1:4477.

To remove it, run `bin/herdr-boss uninstall`.

## Commands

| Command | Action |
|---|---|
| `herdr-boss serve` | Run the collector loop and the dashboard server. |
| `herdr-boss tick` | Collect once and print the alerts. It sends nothing and terminates nothing. |
| `herdr-boss publish <slug> <file>` | Validate a project status file and install it. |
| `herdr-boss logs` | Show the last 100 lines of the server log. |

## Kit commands

Use Herdr Boss commands to start and track project workers.
Run `herdr-boss kit-path` to find the shared skill, templates, and model policy.
The model list excludes experimental entries that appear in only one project's notes.

1. Add `.herdr-boss.json` to the project root when the project needs custom values.
2. Run `herdr-boss models` to see the allowed agent models.
3. Run `herdr-boss worker start <name> --kind <kind> --task "<task>"` to start a worker.
4. Add `--allow <path>` for each path that the worker may change.
5. Add `--issue <number>` to link the work to an issue.
6. Add `--dry-run` to print the plan without making changes.
7. Run `herdr-boss worker list` to see active worker records.
8. Run `herdr-boss worker collect <name>` to read a worker report and check its scope.
9. Add `--record --outcome done --gate-passed` to append a successful run to the ledger.
10. Run `herdr-boss ledger check` to validate the ledger.
11. Run `herdr-boss check --report <file>` to validate a worker report.
12. Run `herdr-boss check --worktree <directory> --allow <path>` to check changed paths.
13. Run `herdr-boss worktree prune` to list removable worktrees.
14. Add `--apply` only when you want to remove clean, merged worktrees without live panes.

Use `herdr-boss gh issue create`, `comment`, or `edit` with `--body-file` to run a safe GitHub issue command.
Use `herdr-boss tick` to refresh the machine worker rules.

## Configuration

Put overrides in `~/.herdr-boss/config.json`. Restart the service after a change: `launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss`.

```json
{
  "push": true,
  "port": 4477,
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30 },
  "workers": { "staleIdleMinutes": 120 },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode"] }
}
```

`HERDR_BOSS_PUSH=0` turns off prompts to orchestrators for one run.

## Shared project dashboards

Orchestrators do not build their own dashboards. They publish a status file, and Herdr Boss renders it at `/p/<slug>`. See [docs/project-status.md](docs/project-status.md).

Use [docs/orchestrator-instructions.md](docs/orchestrator-instructions.md) to add the shared orchestrator instructions to each project's CLAUDE.md or AGENTS.md.

## Local resource control

The dashboard has a Control plane section. Set the global working-agent cap, available harnesses and models, provider quota modes, project shares, and per-project exclusions there. Sliders rebalance the other open projects so the shares total 100%. Idle projects lend their shares when borrowing is enabled. `auto` means no worker is working and the orchestrator has been idle for the configured interval. `paused` is an explicit stop. The project share is advisory; `worker start` enforces the global cap and disabled models. `--force` can override quota and capacity warnings but cannot enable a globally disabled model.

The policy lives in `~/.herdr-boss/policy.json`. Use `herdr-boss policy show` or `herdr-boss policy set <file>` without the dashboard. Provider modes are `managed` and `ignore`. `ignore` skips pacing and handover alerts for that provider.

When an orchestrator's quota is near its reserve or will run out within the handover lead time, Herdr Boss shows a successor recommendation and sends a notice while the source quota can still serve it. Use `herdr-boss handoff plan <pane> --to codex`. Then use `handoff prepare` to start a successor in a separate tab. Review the successor's report. Use `handoff activate <id> --confirmed` to move the `orch` or `boss` label. The old pane stays as standby. `--mode migrate` uses [session-migrate](https://github.com/xhluca/session-migrate) when a native session can be converted; `--mode fresh` bootstraps from project files and the source pane. Migration moves conversation history. It does not move credentials, hooks, or runtime configuration.

Each project can request a persistent Chrome profile with `herdr-boss browser request <slug>`. Herdr Boss assigns a port from 9223–9299 and records the profile in `~/.herdr-boss/browser-sessions.json`. `browser list` shows the port and verifies the profile. Use `--reserve` to allocate without launching Chrome. Port 9222 remains the protected legacy shared browser.

`worker collect --record` adds one project usage event with the worker's model, provider, duration, outcome, gate, and optional measured tokens. Orchestrators can add measured events with `herdr-boss usage record <file>`. `herdr-boss usage summary` and the dashboard show coverage separately from token totals. CodexBar quota percentages are stored in `~/.herdr-boss/quota-history.jsonl`. These measurements help evaluate allocation rules without pretending that global quota percentages are exact project token counts.

## HTTP API

| Method and path | Result |
|---|---|
| `GET /api/state` | The current snapshot. |
| `GET /api/events` | Server-sent events. Each snapshot is an event named `state`. |
| `GET /api/policy`, `PUT /api/policy` | Read or replace the local resource policy. |
| `GET /api/models` | Harness and model allow-list for the controls. |
| `GET /api/usage`, `POST /api/usage` | Read usage summaries or record a project event. |
| `GET /api/browser-sessions`, `POST /api/browser-sessions/request` | Inspect or request a dedicated browser. |
| `POST /api/tick` | Collect now and return the snapshot. |
| `GET /api/projects` | All project status files. |
| `PUT /api/projects/<slug>` | Validate and write a project status file. |
| `DELETE /api/projects/<slug>` | Delete a project status file. |
| `GET /bulletin.md` | The current bulletin. |

The server listens on 127.0.0.1 only. To use it from another device, put Tailscale Serve in front of the local listener; the server accepts same-origin requests addressed to a `.ts.net` host.
