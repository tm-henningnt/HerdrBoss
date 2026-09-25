# User guide

This guide tells how Herdr Boss works and how to set it up. For commands and options, see [cli.md](cli.md). The dashboard has a **Help** panel on each page.

## How it works

Every 30 seconds, Herdr Boss reads Herdr workspaces and agents, machine load and memory, and automation browsers and their owner panes. Every 5 minutes, it reads subscription quotas with `codexbar usage --format json`.

Then it applies its rules and writes these files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read it before each dispatch. |
| `rules.json` | The same rules for scripts. `worker start` reads it. |
| `state.json` | The full snapshot that the dashboard shows. |
| `events.jsonl` | Prompts, notifications, handovers, and stopped processes. |
| `policy.json` | The resource policy that you set on the Allocation page. |

Herdr Boss is a script. It uses no LLM and no tokens.

## Orchestrators

Herdr Boss finds an orchestrator by its pane label `orch`. Tab names do not matter. An orchestrator can label its own pane:

```sh
herdr pane rename "$HERDR_PANE_ID" orch
```

The label stays when the agent in the pane restarts. The pane with the label `boss` is the Herdr Boss orchestrator itself.

To add the shared rules to a project, follow [orchestrator-instructions.md](orchestrator-instructions.md). The shared process is in [the orchestrator skill](../kit/skills/herdr-orchestrator/SKILL.md).

## Rules and notices

| Condition | Action |
|---|---|
| A quota window is at 98% or more | Critical notice. The bulletin tells orchestrators to avoid that kind. |
| A quota window is at 90% or more | Warning notice. |
| A quota runs out before its reset at the current pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| The 5-minute load is above 2 × the core count | Warning notice to the projects that cause the load, with their top processes. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |

A notice is a prompt to an `orch` pane. Herdr Boss sends it only when that agent is `idle` or `done`, and at most once in 6 hours per alert and pane. It sends it sooner only when the severity increases. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`. You get a desktop notification once for each warning.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it.
- **ahead of pace**: the provider uses its quota faster than the window allows. The lane shows when it is back on pace if it is not used.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Allocation and policy

The Allocation page sets the global worker limit, the available harnesses and models, the quota mode for each provider, the share for each project, and project exclusions. The project share is advisory. `worker start` enforces the global limit and the disabled models. Select **Apply policy** to save a change.

A provider in `ignore` mode has no pacing and no handover alerts.

## Orchestrator handover

When an orchestrator's quota comes near its reserve, Herdr Boss recommends a successor.

1. Plan the handover on the project page, or run `herdr-boss handoff plan`.
2. Prepare the successor. It starts in a new tab and only reads and reports.
3. Inspect the successor's response.
4. Confirm activation. The label moves to the successor, and the old pane becomes `standby`.

Migration moves the conversation history with [session-migrate](https://github.com/xhluca/session-migrate). It does not move credentials, hooks, or runtime settings. A fresh successor starts from the project files and the source pane.

**Automatic handover** is off by default. Turn it on in Allocation, and rank the successor choices under **Orchestrator succession**. Herdr Boss then prepares a successor at the reserve, waits for it to run `herdr-boss handoff ready`, and activates it at the set quota level (98% by default). An automatic successor that was not needed expires two hours after preparation when its source provider is no longer near its limit.

## Project browsers

Each project can have one persistent Chrome profile. Request it with `herdr-boss browser request SLUG`, or open it from the Browsers page. Herdr Boss assigns a port from 9223 to 9299.

- Give each worker its own tab. `browser tab new` opens a tab in its own window, so it stays visible in a headless browser.
- A website or identity provider decides how long a login lasts. Sign in through the dashboard when a login is needed.
- Herdr Boss never stops a browser that it did not start. Port 9222 is kept for an optional legacy shared browser.

Agent commands and tab rules are in [the browser service](../kit/browser-service.md).

## Project status pages

Orchestrators do not build dashboards. They publish a status file, and Herdr Boss shows it on `/projects/SLUG`. With the optional work structure fields, the page shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

## Configuration

Put overrides in `~/.herdr-boss/config.json`, then restart the service.

```json
{
  "port": 4477,
  "host": "0.0.0.0",
  "push": true,
  "access": { "tokenFile": "/Users/you/.herdr-boss/access-token", "sessionDays": 30 },
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "machine": { "memFreeWarnPercent": 15, "loadWarnFactor": 2 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30 },
  "workers": { "staleIdleMinutes": 120 },
  "roamgate": { "port": 8787, "tokenFile": "/Users/you/.config/roamgate/auth-token" },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] }
}
```

## Remote access

The server listens on all local interfaces. Requests from `127.0.0.1` need no login.

1. Open `http://<LAN-or-Tailscale-IP>:4477` on the other device.
2. Enter the token from `~/.herdr-boss/access-token`. Herdr Boss creates this file on first start.

The session lasts 30 days and renews while the device uses the dashboard. It survives a service restart. Set `access.sessionDays` to change the length. The server stores only hashes of session IDs, in `~/.herdr-boss/sessions.json`. A new token signs every device out. The login form lets a password manager, such as the iPhone keychain, save the token. API clients can send `Authorization: Bearer <token>` instead.

- Tailscale encrypts traffic between tailnet devices. LAN access uses plain HTTP; use it only on a trusted network.
- Set `host` to `127.0.0.1` to turn off remote access.
- To change the token, write a new token to the token file and restart the service.

When Roamgate runs and its token file exists, the header shows a **Roamgate** link. Herdr Boss reads that token only when you open the link.

## Usage records

`worker collect --record` records one usage event per worker run. `herdr-boss usage record FILE` adds measured events. The Analytics page shows recorded usage and its coverage. Quota percentages are global per provider. They are not project token counts.

## HTTP API

The dashboard uses these routes. A request from another host needs the access token.

| Method and path | Result |
|---|---|
| `GET /api/state`, `GET /api/events` | The snapshot, and a server-sent event stream of snapshots. |
| `GET`, `PUT /api/policy` | Read or replace the policy. |
| `GET /api/models` | The model allow-list. |
| `GET`, `POST /api/usage` | Read usage, or record an event. |
| `GET /api/projects`, `PUT`, `DELETE /api/projects/SLUG` | Read, write, or delete project status. |
| `GET /api/handoffs`, `GET /api/handoffs/output?id=ID` | Handover records, and a successor's pane output. |
| `POST /api/handoffs/plan`, `/prepare`, `/activate` | The handover steps. Activation needs `confirmed: true`. |
| `GET`, `POST /api/browser-sessions...` | Browser list, request, tabs, screenshot, navigation, input, new tab, close, and restart. Input to an agent tab returns 409 unless the body has `confirmAttached: true`. |
| `POST /api/tick` | Collect now. |
| `GET /bulletin.md` | The current bulletin. |
