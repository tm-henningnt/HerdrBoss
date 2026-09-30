# Dashboard settings audit

This audit lists every setting and resource that Herdr Boss manages. It records where Herdr Boss keeps it, what the dashboard shows, what the dashboard sets, and each gap.

The Owner guideline: every setting and every resource that Herdr Boss manages is visible and settable in the dashboard, unless there is a good reason to keep it outside. Good reasons are a secret, the access token file, and a Claude setting that agents must not edit.

This audit records the current state.

## How to read the table

- **Stored in** names the file, the config key, or the code constant.
- **Shown** says `yes`, `no`, or `partly`, and names the page.
- **Settable** says `yes`, `no`, or `partly`, and names the control.
- **Gap** names the missing view or control. It is empty when none exists.
- **Reason to keep outside** is empty when no good reason applies.

A derived value is a value that Herdr Boss computes. It needs no control. The table marks it `derived`.

Data folder is `~/.herdr-boss/` unless the row says otherwise.

| Area | Item | Stored in | Shown | Settable | Gap | Reason to keep outside |
| --- | --- | --- | --- | --- | --- | --- |
| Machine policy | Machine guard on or off, and its pause | `policy.json` `machine.guardEnabled`, `machine.guardPausedUntil` | yes · Overview machine summary, Settings Machine | yes · Settings switch and Pause/Resume; Overview switch | | |
| Machine policy | CPU limit while present, CPU limit while away | `policy.json` `machine.presentCpuPercent`, `machine.awayCpuPercent` | yes · Settings Machine, Overview card | yes · Settings number fields | | |
| Machine policy | 5-minute load backstops | `policy.json` `machine.presentLoadFactor`, `machine.awayLoadFactor` | yes · Settings Machine, Overview card | yes · Settings number fields | | |
| Machine policy | Owner away minutes | `policy.json` `machine.ownerAwayMinutes` | yes · Settings Machine, Overview card shows present or away | yes · Settings number field | | |
| Machine policy | Disk warning and critical free GB | `policy.json` `machine.diskWarnFreeGB`, `machine.diskCriticalFreeGB` | yes · Settings Machine, Overview disk figure and alerts | yes · Settings number fields | | |
| Machine policy | Notice cooldown seconds | `policy.json` `machine.alertCooldownSeconds` | yes · Settings Machine | yes · Settings number field | | |
| Machine policy | Memory warning free percent | `config.json` `machine.memFreeWarnPercent` | yes · Settings Service settings | yes · Settings number field | | |
| Machine policy | Legacy load warning factor | `config.json` `machine.loadWarnFactor` | no | no | | the policy load backstops replace it; keep the legacy value out of the UI |
| Machine policy | Quota warn and critical percent | `config.json` `quota.warnPercent`, `quota.criticalPercent` | yes · quota bars, alerts, Settings | yes · Settings number fields | | |
| Machine policy | Stale status minutes | `config.json` `staleStatusMinutes` | yes · Settings Service settings | yes · Settings number field | | |
| Machine policy | Tick and quota read seconds | `config.json` `tickSeconds`, `quotaSeconds` | yes · Settings Service settings | yes · Settings number fields, range 5 to 300 and 30 to 3600; applies at once | | |
| Machine policy | Push notices to orchestrators | `config.json` `push`, and `HERDR_BOSS_PUSH` | yes · Settings Service settings, Logs top line | yes · Settings switch; restart required; `HERDR_BOSS_PUSH=0` overrides it | | |
| Machine policy | Legacy notice cooldown | `config.json` `alertCooldownSeconds` | yes · Settings Service settings (read-only) | no | | unused legacy value; set the notice cooldown in the Machine group |
| Machine policy | Idle worker minutes | `config.json` `workers.staleIdleMinutes` | yes · Settings Service settings | yes · Settings number field | | |
| Machine policy | Browser reaping and stale minutes | `config.json` `browsers.reapOrphanDaemons`, `orphanDaemonMinAgeSeconds`, `staleOwnedMinutes`, `sweepCodeSignClones` | yes · Settings Service settings | yes · Settings switches and number fields | | |
| Machine policy | Legacy shared browsers | `config.json` `sharedBrowsers` | partly · a shared browser appears in the machine browser table | no | | an entry names a browser that another project owns; only configured entries are read |
| Machine policy | Provider to harness map | `config.json` `providerKinds` | yes · Settings Service settings (read-only) | no | | the map is structural; a wrong map counts a kind against the wrong quota |
| Machine policy | Orchestrator pane label | `config.json` `orchestratorLabel` | yes · Settings Service settings (read-only) | no | | the label is the contract between Herdr and Herdr Boss; a control can break it |
| Machine policy | Server port and host | `config.json` `port`, `host` | yes · Settings Service settings (read-only) | no | | a wrong port or host locks the Owner out of the dashboard and needs a restart |
| Machine policy | Access token file and session days | `config.json` `access.tokenFile`, `access.sessionDays` | no | no | | the token file is a secret |
| Machine policy | Roamgate port and token file | `config.json` `roamgate.port`, `roamgate.tokenFile` | partly · the Roamgate link when the service answers | no | | the token file is a secret |
| Pacing goals | Quota pacing goals | `policy.json` `pacingGoals` | yes · Settings Pacing goals, quota cards, lanes | yes · Settings goal fields | | |
| Pacing goals | Orchestrator reserve percent | `policy.json` `reservePercent` | yes · Settings, Overview handover advice | yes · Settings number field | | |
| Pacing goals | Handover lead minutes | `policy.json` `handoffLeadMinutes` | yes · Settings, Overview handover advice | yes · Settings number field | | |
| Pacing goals | Automatic handover and activation level | `policy.json` `autoHandover`, `autoHandoverPercent` | yes · Allocation, Settings | yes · Allocation and Settings fields | | |
| Project shares and lending | Maximum working agents | `policy.json` `maxWorkers` | yes · Overview capacity, Allocation | yes · Allocation number field | | |
| Project shares and lending | Borrow idle shares | `policy.json` `borrowIdle` | yes · Allocation, project rows | yes · Allocation switch | | |
| Project shares and lending | Idle after minutes | `policy.json` `idleMinutes` | yes · Allocation | yes · Allocation number field | | |
| Project shares and lending | Project set share | `policy.json` `projects[].share` | yes · Overview bar, Allocation rows | yes · Allocation bar and rows | | |
| Project shares and lending | Project mode | `policy.json` `projects[].mode` | yes · Allocation rows, overview cards | yes · Allocation select | | |
| Project shares and lending | Project kind and model exclusions | `policy.json` `projects[].excludedKinds`, `projects[].excludedModels` | yes · Allocation rows | yes · Allocation checkboxes | | |
| Project shares and lending | Workspace exclusions | `policy.json` `excludedWorkspaces` | yes · Allocation workspace switches | yes · Allocation switch per workspace | | |
| Project shares and lending | Orchestrator succession ladder | `policy.json` `orchestratorLadder` | yes · Allocation | yes · Allocation rows | | |
| Project shares and lending | Effective slots, lent, offered, borrowed | derived from `policy.json` and Herdr panes | yes · Allocation, Overview bar, bulletin | derived | | |
| Lanes and provider modes | Provider mode | `policy.json` `providerModes` | yes · Settings Quota mode, quota cards | yes · Settings select | | |
| Lanes and provider modes | Live lanes and least-over provider | `state.json` `lanes`, `leastOverProvider` | yes · quota cards, Logs guidance, `rules.json` | derived | | |
| Lanes and provider modes | Allowed harnesses | `policy.json` `allowedKinds` | yes · Settings harness Available box | yes · Settings switch | | |
| Lanes and provider modes | Preferred model per harness | `policy.json` `preferredModels` | yes · Settings | yes · Settings select | | |
| Lanes and provider modes | Model provider routes | `policy.json` `harnessRoutes`, `modelProviders` | yes · Settings rows | yes · Settings row select | | |
| Lanes and provider modes | Enabled and disabled models | `policy.json` `excludedModels`, `disabledModels` | yes · Settings rows, Allocation exclusions | yes · Settings boxes, Allocation boxes | | |
| Lanes and provider modes | Local extra models | `policy.json` `extraModels` | yes · Settings rows, `local` tag | yes · Add model and Remove | | |
| Lanes and provider modes | Ignored legacy routes | derived `ignoredRoutes` | yes · Settings warning and row note | yes · choose a provider in the row | | |
| Leases and pools | Resource pools | `config.json` `resourcePools` | yes · Allocation Resource leases | yes · Allocation pool editor | | |
| Leases and pools | Built-in project-browser pool | code `projectBrowserPool()` in `src/leases.js` | yes · Allocation Resource leases | no | | the port range is code; a control can break port leases |
| Leases and pools | Live leases | `leases.json` | yes · Allocation rows, Browsers card port | partly · Release only | no dashboard acquire or change; acquire needs a verified caller | |
| Leases and pools | Invalid pool errors | derived from `config.json` `resourcePools` | yes · Allocation error line, bulletin | derived | | |
| Locks | Machine and repository locks | `locks/` directory, and `state.json` `locks` | yes · Allocation Locks | no | | |
| Locks | Expired lock takeover notices | `locks/machine/notices` | partly · a pane notice and one Logs event | no | | the notice is a delivery record; the pane notice and the Logs event are the view |
| Browsers and bookmarks | Project browser record | `browser-sessions.json` | yes · Browsers page | yes · Open, restart, close, window size | | |
| Browsers and bookmarks | Browser window size | `browser-sessions.json` `windowSize` | yes · Browsers card Manage | yes · Browsers size form | | |
| Browsers and bookmarks | Browser headless mode | `browser-sessions.json` `headless` | yes · Browsers card state | yes · Open visible or headless, restart | | |
| Browsers and bookmarks | Browser profile | `browser-profiles/<slug>` | partly · the card connection and profile panel | no | | the profile holds the signed-in session; keep it outside |
| Browsers and bookmarks | Bookmarks | none | yes · Browsers page | yes · add, rename, move, remove, start page | | |
| Browsers and bookmarks | Shared browser on port 9222 | external process | yes · machine browser table | no | | Herdr Boss never stops a browser that it did not start |
| Handoffs | Handover records | `handoffs.json` | yes · Overview, project page | yes · Plan, Prepare, Activate | | |
| Handoffs | Successor pane output | `handoffs.json` and a pane read | yes · project page Inspect successor | partly · read-only | | the successor is a pane that the orchestrator owns; closing it is an orchestrator action |
| Handoffs | Automatic handover attempts | `memory.json` `autoHandoverAttempts` | partly · a Logs event and an expiry notice | no | | the attempt log is an internal guard; the Logs event and the expiry notice are the view |
| Harness settings | Codex writable roots | `~/.codex/config.toml` | yes · Settings Harness readiness (status only) | no | | the files belong to the harness; the table shows status only |
| Harness settings | Codex forbidden process rules | `~/.codex/rules/herdr.rules` | yes · Settings Harness readiness (status only) | no | | the files belong to the harness; the table shows status only |
| Harness settings | Claude autoMode | `~/.claude/settings.json` | no | no | | a Claude setting that agents must not edit, and the file can hold keys |
| Harness settings | OpenCode worker agent | `~/.config/opencode/opencode.json[c]` | yes · Settings Harness readiness (status only) | no | | the files belong to the harness; the table shows status only |
| Harness settings | Pi guard extension | `~/.pi/agent/extensions/herdr-guard.ts` | yes · Settings Harness readiness (status only) | no | | the files belong to the harness; the table shows status only |
| Harness settings | Harness launch arguments and context window | `kit/models.json` | partly · Settings model lists, migration notes | no | | the catalog is repository content, changed by a release |
| Worker config | Project worker config | `.herdr-boss.json` in each project repository | yes · project page Worker config (read-only) | no | | the file is repository content; edit it in the project repository |
| Worker config | Worker brief template | `kit/templates/worker-brief.md`, and a project override | no | no | | the template is repository content; edit it in the kit repository |
| Kit revision | Kit revision and AGENTS.md stub drift | `kit/templates/project-kit.md`, project `AGENTS.md`, publish `agentsCheck` | yes · project page Kit revision and drift lines | no | | the kit is repository content; a release changes it, not a control |
| Memory pointers | Project memory file | `docs/orchestration/memory.md` in each project | yes · project page | no | | |
| Memory pointers | Boss memory file | `~/.herdr-boss/boss-memory.md` | yes · project page | no | | |
| Memory pointers | Loaded kit file | `docs/orchestration/herdr-boss.md` | yes · project page | no | | |
| Mailbox | Messages | `messages.jsonl` | yes · Mailbox folders and conversations | yes · New message, reply, read, dismiss | | |
| Mailbox | Message retention, send rate, delivery attempts | code constants in `src/messages.js` | yes · Mailbox limits | no | | the numbers are code constants; the page shows them |
| Denials | Denial counts | `denials.json` | yes · Analytics Denials | no | | |
| Denials | Denial scan interval and read budget | code constants in `src/denials.js` | yes · Analytics limits | no | | the numbers are code constants; the page shows them |
| Denials | Denial trend thresholds | code constants `RISE_FACTOR`, `RISE_MIN_EVENTS` | yes · Analytics limits | no | | the numbers are code constants; the page shows them |
| Models | Model catalog | `kit/models.json` | yes · Settings harness rows | partly · local models only | the kit catalog is not editable in the dashboard | |
| Models | Context window per model | `kit/models.json` `contextTokens`, `contextTokensByModel` | partly · migration text on the plan card | no | | the window is catalog content in `kit/models.json`; a release changes it |
| Records | Worker usage records | `usage.jsonl` | yes · Analytics | partly · `POST /api/usage` from collect | no dashboard edit; collection writes them | |
| Records | Quota history | `quota-history.jsonl` | yes · quota card trend spark | no | | the file is a bounded record; retention is a code constant |
| Records | Project status files | `projects/<slug>.json` | yes · Projects and project pages | partly · publish writes them; the API has PUT and DELETE | | `herdr-boss publish` writes the file; a second writer can overwrite the orchestrator status |
| Records | Events and the activity log | `events.jsonl` | yes · Logs | no | only the latest 60 events reach the page | |

## Items outside the dashboard

Each item has a recorded reason in the table. The reasons fall in these classes.

- Secret: the access token file, the Roamgate token file, and the session settings.
- Structural or lock-out value: `port`, `host`, `providerKinds`, `orchestratorLabel`, and the built-in browser port range.
- Repository content: the kit catalog, the context window per model, the worker brief template, and the project worker config. Edit them in their repository.
- Another owner: a Claude setting that agents must not edit, other projects' browsers, harness files, `sharedBrowsers`, and the successor pane.
- Writer elsewhere: `herdr-boss publish` writes the project status file.
- Internal record: the auto-handover attempt log, the expired-lock takeover notices, and the quota history retention.

## Plan

Tasks 1 to 11 shipped: live locks, quota thresholds, service settings, harness readiness, worker config, pools editor, memory pointers, scan and store limits, bookmarks, and the lock release rule. The service settings `tickSeconds`, `quotaSeconds`, and `push` are settable. The top-level `alertCooldownSeconds` is unused and stays read-only: set the notice cooldown in the Machine group. No gap is open.
