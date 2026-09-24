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
| A worker has been idle for more than 2 hours | Prompt the orchestrator of that workspace. |
| An `agent-browser` daemon has no parent and no children and is older than 2 hours | Terminate the daemon. |

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
2. Open http://127.0.0.1:4477.

To remove it, run `bin/herdr-boss uninstall`.

## Commands

| Command | Action |
|---|---|
| `herdr-boss serve` | Run the collector loop and the dashboard server. |
| `herdr-boss tick` | Collect once and print the alerts. It sends nothing and terminates nothing. |
| `herdr-boss publish <slug> <file>` | Validate a project status file and install it. |
| `herdr-boss logs` | Show the last 100 lines of the server log. |

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

Copy [docs/orchestrator-instructions.md](docs/orchestrator-instructions.md) into the CLAUDE.md or AGENTS.md file of each project that has an orchestrator.

## HTTP API

| Method and path | Result |
|---|---|
| `GET /api/state` | The current snapshot. |
| `GET /api/events` | Server-sent events. Each snapshot is an event named `state`. |
| `POST /api/tick` | Collect now and return the snapshot. |
| `GET /api/projects` | All project status files. |
| `PUT /api/projects/<slug>` | Validate and write a project status file. |
| `DELETE /api/projects/<slug>` | Delete a project status file. |
| `GET /bulletin.md` | The current bulletin. |

The server listens on 127.0.0.1 only.
