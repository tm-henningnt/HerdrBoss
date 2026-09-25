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
| `policy.json` | The resource policy that you set on the Settings and Allocation pages. |

`herdr-boss scratch <slug>` creates `~/.herdr-boss/scratch/<slug>/` for the orchestrator files of a project. Herdr Boss does not delete this folder.

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
| A quota runs out before its reset at the current pace, or its use is above the goal-adjusted pace | The provider lane is "ahead of pace". `worker start` refuses it. |
| Free memory is below 15% | Warning notice. |
| Active machine CPU limit or enabled 5-minute load backstop is exceeded | Stop new workers and full test suites. `worker start` refuses the dispatch, including with `--force`. |
| An idle worker still owns an automation browser after 30 minutes | Notice to that project. |
| A worker is idle for more than 2 hours | Notice to that project. Parked workers and prepared successors are skipped. |
| An `agent-browser` daemon has no parent, no children, and is older than 2 hours | Herdr Boss stops the daemon. It never stops a browser. |

A notice is a prompt to an `orch` pane. Herdr Boss sends it only when that agent is `idle` or `done`, and no more than the configured cooldown per alert and pane. It sends it sooner only when the severity increases. A notice for all orchestrators goes only to projects with a worker that is `working` or `blocked`. You get a desktop notification once for each warning.

The notice cooldown is saved as `machine.alertCooldownSeconds` in `policy.json`. Its default is 21600 seconds (6 hours). This policy value takes precedence over the legacy top-level `alertCooldownSeconds` value in `config.json`.

`HERDR_BOSS_PUSH=0` turns off prompts for one run.

## Quota lanes

`herdr-boss lanes` and the bulletin section "Provider lanes" show each metered provider:

- **open**: use it.
- **ahead of pace**: a live window will not last to its reset, or its use is above its goal-adjusted expected use. The lane shows when it is back on pace if it is not used.
- **near exhaustion**: the quota is inside the reserve. Only `--force` can use it.

A provider is open only when every live, measured window is on pace. Extra windows, such as a model-only window, do not count. When several windows are ahead of pace, the lane names the worst one: the window with the most use above its goal-adjusted expected use. A window without an expected value ranks by its used percentage.

A **quota pacing goal** is the most percent of a window that you want to use by its reset. Herdr Boss scales the window's expected-use pace by `goal / 100`, so a goal of 80% makes the expected curve reach 80% at the reset. An unset goal means 100%, which preserves the normal pace. A goal does not change the reserve or near-exhaustion rules, which use the actual used percentage. A goal has no effect on a provider in `ignore` mode. A window whose reset time has passed starts fresh; usage does not carry across a reset.

The same output has one **unmetered** lane. It is always open and lists every permitted unmetered model by project and harness, after global and project exclusions. An unmetered model has no metered provider route. The unmetered lane never changes least-over selection, avoid-provider rules, quota warnings, or quota accounting.

When every metered provider is ahead of pace, `worker start` allows the least-over provider. A refusal or warning names the current project's unmetered alternatives first, then the least-over metered provider. A window whose reset time has passed shows "reset, not yet measured" until the next reading.

## Settings and allocation

The Settings page controls the available harnesses and models, preferred models, provider quota modes, quota pacing goals, model-to-provider routes, and machine limits. Herdr Boss takes every harness and model choice from `kit/models.json`.

The Machine section saves its settings in `policy.json`. Herdr Boss reads Owner idle time from macOS `IOHIDSystem`. The default away time is 10 minutes. Missing or invalid idle data means the Owner is present. CPU is total sampled process CPU, including other processes, divided by core count. The default CPU limits are 70% while present and 95% while away. Set the away CPU limit to blank to disable it. The default 5-minute load backstops are 3 times the core count while present and 8 times while away. Set a load backstop to blank to disable it. The load average stays visible when a backstop is disabled.

Policy settings take precedence over legacy `config.json` values. The old `machine.loadWarnFactor` field does not control machine guards. The `machine.alertCooldownSeconds` policy value takes precedence over the legacy top-level `alertCooldownSeconds` field for notice delivery.

Clear a harness or model box to disable it for every project. Choose a preferred model for a harness. Worker start and handoff use it when you omit an explicit model. An empty choice uses the harness default.

Choose **Manage pace** to apply quota pacing and handover alerts. Choose **Ignore quota** to turn them off for that provider. A provider in `ignore` mode has no pacing and no handover alerts.

Set a **quota pacing goal** for each measured window. The field shows the provider and the window label, such as `Codex Weekly goal %`. A blank field means 100%. Enter a whole percentage from 0 through 100. `pacingGoals` in `policy.json` stores the value by provider and by the window key (`primary`, `secondary`, or `tertiary`). Clearing the field removes that goal and restores 100%.

Choose `codex`, `claude`, or `opencodego` to route a model to a provider quota. Choose **Unmetered** to store `null`. If no route is set, Herdr Boss uses the existing harness and model prefix rules. Old policy files can omit `preferredModels`, `modelProviders`, and `pacingGoals`.

Both pages keep policy edits in a draft. Select **Apply policy** to save the draft. A rejected save shows the server error and keeps the draft.

The Allocation page sets the global worker limit, project shares and exclusions, and orchestrator succession. The project share is advisory. `worker start` enforces the global limit and the disabled harnesses and models.

Each project has two share values:

- The **set share** is the share in the policy draft. The bar widths show the set share. Drag a boundary or use the arrow keys to change it.
- The **effective share** is the number of worker slots that the project has now, divided by the applied maximum of working agents. The **effective slots** are that number of slots. These values come from the applied policy. They change only after you select **Apply policy**.

A bar segment shows its set share and its effective slots, for example `30% · 2`. A narrow segment shows only the set share or no label. Its tooltip shows all values.

An idle project is faded in the bar and in its row. A paused project is faded and striped. When **Borrow idle shares** is on, each idle project lends its slots to the active projects. An idle project can then have 0 effective slots while its set share stays the same.

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

On the Browsers page, **Show preview** captures a screenshot of the selected tab. The preview shows a still image until the next capture. **Live** refreshes it at the interval that you select.

Select the screenshot to open the large view. The large view shows the last capture as a still image. Turn on **Control browser** to refresh the large view at the selected interval and to send clicks and keys. Turn off **Control browser** to stop that refresh. **Live** continues to refresh while it is on. The status shows **Live** while a refresh repeats and **Captured** at other times. In **All tabs** mode, **Control browser** is not available.

Agent commands and tab rules are in [the browser service](../kit/browser-service.md).

## Project status pages

Orchestrators do not build dashboards. They publish a status file, and Herdr Boss shows it on `/projects/SLUG`. With the optional work structure fields, the page shows progress, the current frontier, a dependency graph, groups, specs, and all work. See [project-status.md](project-status.md).

## Phone and home screen

The dashboard adapts to a phone and to a home-screen web app.

- On a screen up to 760 px wide, the header shows a menu button with the current page name. Select the button to open the page menu. The menu closes after you choose a page and when you press Escape.
- On a phone, the long sections of a project page start collapsed. Select a section title to open it. The dashboard remembers each open section for that project during the session. Overall progress and the current frontier stay open.
- Project cards become compact. They show the name, mode, status line, and task bar.
- Tables show stacked rows with a label for each value. The page does not scroll sideways at 393 px.
- The expanded browser view fills the screen. One compact toolbar holds the controls. The text field and key controls appear only while **Control browser** is on. The screenshot fills the rest of the height, in portrait and landscape.
- The dashboard sets the home-screen web app meta tags. To add the dashboard to a phone home screen, open it in Safari, open the Share menu, and select **Add to Home Screen**.

## Configuration

Put overrides in `~/.herdr-boss/config.json`, then restart the service.

```json
{
  "port": 4477,
  "host": "0.0.0.0",
  "push": true,
  "access": { "tokenFile": "/Users/you/.config/herdr-boss/access-token", "sessionDays": 30 },
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
2. Enter the token from `~/.config/herdr-boss/access-token`. Herdr Boss creates this file on first start. The directory has mode `0700`. The token and session files have mode `0600`.

The session lasts 30 days and renews while the device uses the dashboard. It survives a service restart. Set `access.sessionDays` to change the length. The server stores only hashes of session IDs and the token fingerprint in `~/.config/herdr-boss/sessions.json`, even when you set a custom `access.tokenFile` path. A new token signs every device out. Herdr Boss moves existing default credential files from `~/.herdr-boss/` on first start. An explicit `access.tokenFile` path remains in use. The login form lets a password manager, such as the iPhone keychain, save the token. API clients can send `Authorization: Bearer <token>` instead.

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
