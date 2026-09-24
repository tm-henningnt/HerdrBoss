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

Herdr Boss never terminates a configured shared browser. It reports one as missing only when listed in `sharedBrowsers`. Port 9222 is reserved for an optional legacy shared browser; new installations have no shared-browser alert by default.

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

Herdr Boss runs locally with Node 22 or later. The `install` command sets up a macOS launchd user service; `herdr-boss serve` can run directly on other systems.

| Software | Needed for |
|---|---|
| Node 22+ | Dashboard server, collector, and CLI. |
| [Herdr](https://herdr.dev) CLI | Workspace and pane inventory, orchestrator notices, worker launch, and handover. |
| CodexBar CLI | Subscription quota collection and quota based guidance. Without it, those readings are unavailable. |
| Git | Worker worktrees and repository checks in the shared kit. |
| Codex, Claude, OpenCode, or Pi CLI | Launching agents of that harness; install only the harnesses you make available. |
| `session-migrate` (optional) | Resume a Codex or Claude conversation during handover. Fresh bootstrap works without it. |
| Roamgate (optional) | A link to its local web client in the dashboard. Its own service and token file must be present. |
| Google Chrome (optional) | Dedicated persistent project browsers. |
| GitHub CLI `gh` (optional) | The kit's GitHub issue commands. |
| Tailscale (optional) | Reach the dashboard from other tailnet devices by its Tailscale IP; Tailscale Serve can add an HTTPS tailnet URL. |

The launchd service searches the usual Homebrew and system locations for Herdr and CodexBar. Herdr Boss also searches `~/.local/bin` for Roamgate and `session-migrate`.

1. Run `bin/herdr-boss install`. This installs the launchd agent `no.tallmaker.herdr-boss` and starts it.
2. Put `bin/herdr-boss` on your `PATH`. For a user installation, link it with `ln -s "$(pwd)/bin/herdr-boss" ~/.local/bin/herdr-boss` and add `~/.local/bin` to your shell's `PATH`. Run `command -v herdr-boss` to check the current shell. Existing shells may need to be restarted or have their `PATH` refreshed; the repository's absolute `bin/herdr-boss` path works immediately.
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
  "host": "0.0.0.0",
  "access": { "tokenFile": "/Users/you/.herdr-boss/access-token" },
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30 },
  "workers": { "staleIdleMinutes": 120 },
  "roamgate": { "port": 8787, "tokenFile": "/Users/you/.config/roamgate/auth-token" },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] }
}
```

`HERDR_BOSS_PUSH=0` turns off prompts to orchestrators for one run.

The server binds all local interfaces by default, including the current LAN and Tailscale addresses. On first start it creates a random remote access token at `~/.herdr-boss/access-token` with private file permissions. Loopback requests remain available without login for local tools. Open the dashboard from another device at `http://<LAN-or-Tailscale-IP>:4477`; enter that token on the login page. The browser keeps an HTTP-only, same-site session cookie. Active dashboard requests renew it before the 12-hour expiry, so a page left open stays signed in; a browser inactive for 12 hours needs the token again. Remote API clients may instead send the token in an `Authorization: Bearer` header. Set `access.tokenFile` to another private file to supply or rotate the token, then restart the service; existing browser sessions expire on restart. Set `host` to `127.0.0.1` to disable direct remote access.

Tailscale links encrypt traffic between tailnet devices. Direct LAN access uses HTTP, so use it only on a trusted LAN or put an HTTPS reverse proxy in front of the service. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) can provide an HTTPS tailnet URL while the local service stays bound to loopback.

Roamgate is optional. When `roamgate service status` reports a running service and the private token file exists, the header shows **Roamgate ↗**. Herdr Boss opens Roamgate on port 8787 at the same hostname used for its dashboard. It reads the token file only when you open the link; the token is not stored in this repository or returned by the status API. Override `roamgate.tokenFile` in the local configuration if Roamgate uses another path. Keep that file private.

## Shared project dashboards

Orchestrators do not build their own dashboards. They publish a status file, and Herdr Boss renders it on `/projects/<slug>`. See [docs/project-status.md](docs/project-status.md).

Use [docs/orchestrator-instructions.md](docs/orchestrator-instructions.md) to add or update the shared orchestrator instructions in each project's CLAUDE.md or AGENTS.md. The [orchestrator skill](kit/skills/herdr-orchestrator/SKILL.md) and [browser service](kit/browser-service.md) stay here so projects can refer to one maintained toolkit.

## Local resource control

The dashboard opens on an Overview with resource alerts, pending handovers, project status, and compact subscription and machine bars. Open the subscription bar to see all provider quota windows, or open machine health for processes and history. Use Allocation (`/allocation`) to set the global working-agent cap, available harnesses and models, provider quota modes, project shares, and per-project exclusions. One 0–100% bar shows the open projects as segments. Drag a boundary, or focus it and use the arrow keys, to change a share; projects to its left stay fixed and the remaining share is distributed proportionally across projects to its right. The last project receives the remainder. Idle projects lend their shares when borrowing is enabled. `auto` means no worker is working and the orchestrator has been idle for the configured interval. `paused` is an explicit stop. The project share is advisory; `worker start` enforces the global cap and disabled models. `--force` can override quota and capacity warnings but cannot enable a globally disabled model. Agents (`/agents`) shows live Herdr workspaces; Analytics (`/analytics`) shows recorded worker usage; Logs (`/logs`) shows current guidance and activity.

The policy lives in `~/.herdr-boss/policy.json`. Use `herdr-boss policy show` or `herdr-boss policy set <file>` without the dashboard. Provider modes are `managed` and `ignore`. `ignore` skips pacing and handover alerts for that provider.

When an orchestrator's quota is near its reserve or will run out within the handover lead time, Herdr Boss shows a successor recommendation and sends a notice while the source quota can still serve it. Every open project's detail page also offers a handover before an alert is suggested. Choose a successor harness, model, and start mode; Plan checks whether migration is available, Prepare starts a successor in a separate tab, and Inspect successor shows its response. Review that response and confirm activation to move the `orch` or `boss` label. The old pane stays as standby. The same flow is available through `herdr-boss handoff plan <pane> --to codex`, `handoff prepare`, and `handoff activate <id> --confirmed`. `--mode migrate` uses [session-migrate](https://github.com/xhluca/session-migrate) when a native session can be converted; `--mode fresh` bootstraps from project files and the source pane. Migration moves conversation history. It does not move credentials, hooks, or runtime configuration.

Allocation can enable automatic handover, which is off by default. Set **Orchestrator succession** there to rank harness, model, and reasoning effort choices; change the order with the up/down buttons and apply the policy. For example, rank Claude Opus first, Codex Luna at xhigh second, and Pi DeepSeek v4.1 Flash third. Boss tries those choices in order, skipping the current provider, providers near quota exhaustion, and global or project exclusions. Unlisted choices are never automatic successors. The initial order favors Codex, then Claude, then Pi until changed. Boss prepares a successor when the current orchestrator's provider reaches its reserve or projected handover window. It prefers session migration when available, otherwise starts a fresh bootstrap. The successor must call `herdr-boss handoff ready <id>` after reviewing its state. Boss activates only after that signal, an idle successor, fresh quota data, and the configured usage percentage (98% by default). If there is no eligible alternative or preparation fails, Boss leaves the current orchestrator in control and records the failure in Logs. Disabling automatic handover stops pending automatic activation.

If an orchestrator agent has already stopped at the quota limit but its labeled pane remains, Boss uses the last recorded harness and prepares a fresh successor from the project files and source pane. Recovery from a deleted pane still requires manual intervention.

At activation, the successor receives the current workspace agent pane roster. Boss then sends the former orchestrator and existing worker agents a one time handover notice when each pane is idle or done, so running tasks are not interrupted. Peers that close before becoming idle need no notice.

Each project can request a persistent Chrome profile with `herdr-boss browser request <slug>`. Add `--headless` or `--visible` to choose the launch mode; the dashboard offers both. Herdr Boss assigns a port from 9223–9299 and records the profile in `~/.herdr-boss/browser-sessions.json`. `browser list` shows the port and verifies the profile. The current browser details are published in the bulletin and machine readable rules; a newly launched browser also triggers a one time notice to its project's idle orchestrator. Use `herdr-boss browser restart <slug> --headless` or `--visible` to close Chrome gracefully and relaunch with the same profile and current page. Add `--no-restore` to start blank. `herdr-boss browser close <slug>` asks it to stop while keeping its profile. If Chrome's control endpoint is unavailable, Herdr Boss leaves the process alone and reports the problem. Closing a visible window alone may leave Chrome running in the background. The profile persists across launches, though a website or identity provider may require a fresh login. Use `--reserve` to allocate without launching Chrome. Port 9222 remains protected for optional legacy shared use.

For simple agent browser work, `browser tabs`, `screenshot`, `navigate`, `click`, `text --stdin`, and `key` work on the recorded project browser. See [the project browser service](kit/browser-service.md) for command examples and tab ownership rules.

The Browsers page gives each running browser a wide preview. Open **Manage** for restart, close, connection details, and window size (320–3840 × 240–2160 pixels); `herdr-boss browser size <slug> <width> <height>` does the same from the CLI. The saved size applies on the next launch. **Live** refreshes the thumbnail while the page is visible. Choose a per-browser interval of 1.5, 3, 5, 10, or 30 seconds; the choice is saved in this dashboard browser. Opening the large view also refreshes it at that interval. The frame counter and capture time show when a fresh image arrives. Select a browser page, use Back or Forward in its history, or choose Home to open a blank page. The address field shows the selected page's URL; enter a full URL or hostname and press Go to navigate. Both the card and large view have these controls. In the large view, enable **Control browser** to send clicks and keyboard input to the selected page; paste longer text or a password into the masked field. Screenshots are sent directly to the dashboard and are not stored on disk.

`worker collect --record` adds one project usage event with the worker's model, provider, duration, outcome, gate, and optional measured tokens. Orchestrators can add measured events with `herdr-boss usage record <file>`. `herdr-boss usage summary` and the dashboard show coverage separately from token totals. CodexBar quota percentages are stored in `~/.herdr-boss/quota-history.jsonl`. These measurements help evaluate allocation rules without pretending that global quota percentages are exact project token counts.

## HTTP API

| Method and path | Result |
|---|---|
| `GET /api/state` | The current snapshot. |
| `GET /api/events` | Server-sent events. Each snapshot is an event named `state`. |
| `GET /api/policy`, `PUT /api/policy` | Read or replace the local resource policy. |
| `GET /api/models` | Harness and model allow-list for the controls. |
| `GET /api/roamgate`, `GET /roamgate` | Check whether Roamgate is available, then open it through a local redirect. |
| `GET /api/usage`, `POST /api/usage` | Read usage summaries or record a project event. |
| `GET /api/browser-sessions`, `POST /api/browser-sessions/request` | Inspect or request a dedicated browser. |
| `GET /api/browser-sessions/tabs`, `GET /api/browser-sessions/screenshot`, `GET /api/browser-sessions/navigation` | List pages, capture a JPEG, and read the selected page's URL and history availability. |
| `POST /api/browser-sessions/window-size`, `POST /api/browser-sessions/navigate`, `POST /api/browser-sessions/history` | Save the next launch size, open a URL, or go Back, Forward, or Home. |
| `POST /api/browser-sessions/input` | Send an opt-in click, text, or key command to a managed page. |
| `POST /api/browser-sessions/close`, `POST /api/browser-sessions/restart` | Gracefully stop or switch modes for a managed browser. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=<id>` | List handovers or read a successor pane. |
| `POST /api/handoffs/plan`, `POST /api/handoffs/prepare` | Plan or start a successor with `project`, `pane`, `to`, `model`, `mode`, and optional `effort`. |
| `POST /api/handoffs/activate` | Activate a prepared handover with `id` and `confirmed: true`. |
| `POST /api/tick` | Collect now and return the snapshot. |
| `GET /api/projects` | All project status files. |
| `PUT /api/projects/<slug>` | Validate and write a project status file. |
| `DELETE /api/projects/<slug>` | Delete a project status file. |
| `GET /bulletin.md` | The current bulletin. |

The server accepts same-origin requests addressed to localhost, a local interface IP, or a `.ts.net` host. Non-loopback requests require remote access authentication before any dashboard, API, event stream, or browser control route is served.
