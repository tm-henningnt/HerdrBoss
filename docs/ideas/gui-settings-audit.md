# Dashboard settings audit

This audit lists every setting and resource that Herdr Boss manages. It records where Herdr Boss keeps it, what the dashboard shows, what the dashboard sets, and each gap.

The Owner guideline: every setting and every resource that Herdr Boss manages is visible and settable in the dashboard, unless there is a good reason to keep it outside. Good reasons are a secret, the access token file, and a Claude setting that agents must not edit.

This is an audit and a plan. It changes no code.

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
| Machine policy | Memory warning free percent | `config.json` `machine.memFreeWarnPercent` | partly · only the alert text when memory is below it | no | the effective value is hidden and has no control | |
| Machine policy | Legacy load warning factor | `config.json` `machine.loadWarnFactor` | no | no | | the policy load backstops replace it; keep the legacy value out of the UI |
| Machine policy | Quota warn and critical percent | `config.json` `quota.warnPercent`, `quota.criticalPercent` | partly · the quota bars and alerts use fixed 90 and 98, not these values | no | the thresholds are hidden and the dashboard does not follow them | |
| Machine policy | Stale status minutes | `config.json` `staleStatusMinutes` | partly · the project page shows the stale mark, not the limit | no | the limit is hidden and has no control | |
| Machine policy | Tick and quota read seconds | `config.json` `tickSeconds`, `quotaSeconds` | no | no | the cadence is hidden and has no control | |
| Machine policy | Push notices to orchestrators | `config.json` `push`, and `HERDR_BOSS_PUSH` | yes · the Logs page top line | no | the switch is hidden and has no control | |
| Machine policy | Idle worker minutes | `config.json` `workers.staleIdleMinutes` | partly · the help text names a configured value, not the number | no | the value is hidden and has no control | |
| Machine policy | Browser reaping and stale minutes | `config.json` `browsers.reapOrphanDaemons`, `orphanDaemonMinAgeSeconds`, `staleOwnedMinutes`, `sweepCodeSignClones` | no | no | the browser housekeeping values are hidden and have no control | |
| Machine policy | Legacy shared browsers | `config.json` `sharedBrowsers` | partly · a shared browser appears in the machine browser table | no | the list is hidden and has no control; only configured entries are read | |
| Machine policy | Provider to harness map | `config.json` `providerKinds` | no | no | the map is hidden and has no control | |
| Machine policy | Orchestrator pane label | `config.json` `orchestratorLabel` | partly · Agents shows the `orch` label | no | | the label is the contract between Herdr and Herdr Boss; a control can break it |
| Machine policy | Server port and host | `config.json` `port`, `host` | partly · the page address | no | | a wrong bind value locks the Owner out and needs a restart |
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
| Leases and pools | Resource pools | `config.json` `resourcePools` | yes · Allocation Resource leases | no | the pool list is read-only in the dashboard; the CLI reads the config file | |
| Leases and pools | Built-in project-browser pool | code `projectBrowserPool()` in `src/leases.js` | yes · Allocation Resource leases | no | | the port range is code; a control can break port leases |
| Leases and pools | Live leases | `leases.json` | yes · Allocation rows, Browsers card port | partly · Release only | no dashboard acquire or change; acquire needs a verified caller | |
| Leases and pools | Invalid pool errors | derived from `config.json` `resourcePools` | yes · Allocation error line, bulletin | derived | | |
| Locks | Machine and repository locks | `locks/` directory, and `state.json` `locks` | no | no | the state carries `locks`, but no page renders it | |
| Locks | Expired lock takeover notices | `locks/machine/notices` | partly · a pane notice and one Logs event | no | the notice list is invisible and has no control | |
| Browsers and bookmarks | Project browser record | `browser-sessions.json` | yes · Browsers page | yes · Open, restart, close, window size | | |
| Browsers and bookmarks | Browser window size | `browser-sessions.json` `windowSize` | yes · Browsers card Manage | yes · Browsers size form | | |
| Browsers and bookmarks | Browser headless mode | `browser-sessions.json` `headless` | yes · Browsers card state | yes · Open visible or headless, restart | | |
| Browsers and bookmarks | Browser profile | `browser-profiles/<slug>` | partly · the card connection and profile panel | no | | the profile holds the signed-in session; keep it outside |
| Browsers and bookmarks | Bookmarks | none | no | no | no bookmark feature or store exists | |
| Browsers and bookmarks | Shared browser on port 9222 | external process | yes · machine browser table | no | | Herdr Boss never stops a browser that it did not start |
| Handoffs | Handover records | `handoffs.json` | yes · Overview, project page | yes · Plan, Prepare, Activate | | |
| Handoffs | Successor pane output | `handoffs.json` and a pane read | yes · project page Inspect successor | partly · read-only | no dashboard close of a stuck successor | |
| Handoffs | Automatic handover attempts | `memory.json` `autoHandoverAttempts` | partly · a Logs event and an expiry notice | no | the attempt log is invisible | |
| Harness settings | Codex writable roots | `~/.codex/config.toml` | no | no | no readiness view in the dashboard | |
| Harness settings | Codex forbidden process rules | `~/.codex/rules/herdr.rules` | no | no | no readiness view in the dashboard | |
| Harness settings | Claude autoMode | `~/.claude/settings.json` | no | no | | a Claude setting that agents must not edit, and the file can hold keys |
| Harness settings | OpenCode worker agent | `~/.config/opencode/opencode.json[c]` | no | no | no readiness view in the dashboard | |
| Harness settings | Pi guard extension | `~/.pi/agent/extensions/herdr-guard.ts` | no | no | no readiness view in the dashboard | |
| Harness settings | Harness launch arguments and context window | `kit/models.json` | partly · Settings model lists, migration notes | no | | the catalog is repository content, changed by a release |
| Worker config | Project worker config | `.herdr-boss.json` in each project repository | no | no | the service does not read or show it | |
| Worker config | Worker brief template | `kit/templates/worker-brief.md`, and a project override | no | no | the template is invisible in the dashboard | |
| Kit revision | Kit revision and AGENTS.md stub drift | `kit/templates/project-kit.md`, project `AGENTS.md`, publish `agentsCheck` | yes · project page Kit revision and drift lines | no | | the kit is repository content; a release changes it, not a control |
| Memory pointers | Project memory file | `docs/orchestration/memory.md` in each project | no | no | the path is not shown; the help panel names it in text only | |
| Memory pointers | Boss memory file | `~/.herdr-boss/boss-memory.md` | no | no | the path is not shown | |
| Memory pointers | Loaded kit file | `docs/orchestration/herdr-boss.md` | partly · the project page shows the revision, not the path | no | the path is not shown | |
| Mailbox | Messages | `messages.jsonl` | yes · Mailbox folders and conversations | yes · New message, reply, read, dismiss | | |
| Mailbox | Message retention, send rate, delivery attempts | code constants in `src/messages.js` | yes · Mailbox help text | no | the numbers are hidden and have no control | |
| Denials | Denial counts | `denials.json` | yes · Analytics Denials | no | | |
| Denials | Denial scan interval and read budget | code constants in `src/denials.js` | partly · the help text names 15 minutes and 20 MB | no | the cadence is hidden and has no control | |
| Denials | Denial trend thresholds | code constants `RISE_FACTOR`, `RISE_MIN_EVENTS` | partly · the help text names both rules | no | the values are hidden and have no control | |
| Models | Model catalog | `kit/models.json` | yes · Settings harness rows | partly · local models only | the kit catalog is not editable in the dashboard | |
| Models | Context window per model | `kit/models.json` `contextTokens`, `contextTokensByModel` | partly · migration text on the plan card | no | the window is hidden and has no control | |
| Records | Worker usage records | `usage.jsonl` | yes · Analytics | partly · `POST /api/usage` from collect | no dashboard edit; collection writes them | |
| Records | Quota history | `quota-history.jsonl` | yes · quota card trend spark | no | the retention and window are hidden | |
| Records | Project status files | `projects/<slug>.json` | yes · Projects and project pages | partly · publish writes them; the API has PUT and DELETE | no dashboard edit control | |
| Records | Events and the activity log | `events.jsonl` | yes · Logs | no | only the latest 60 events reach the page | |

## Gaps with no task

These gaps stay open by design. The table above gives the reason in its last column.

- Secrets: the access token file, the Roamgate token file, and the session settings.
- A Claude setting that agents must not edit.
- Code contracts that must not move: the `orch` label, the built-in browser port range, the server bind setting.
- Profiles and browsers that other projects own.
- Legacy values that the policy replaces.

## Plan

Each task is one line. The tasks are ordered by value to the Owner. `S`, `M`, and `L` give the size.

1. **M — Show live locks.** Render `state.locks` in a read-only panel on Allocation, and show expired takeover notices. Files: `public/app.js`, `public/style.css`, `docs/user-guide.md`, `test/server.test.js`.
2. **S — Follow the quota thresholds.** Send `quota.warnPercent` and `quota.criticalPercent` in the state, use them for the quota bar colors, and show the values in the Settings quota panel. Files: `src/engine.js`, `public/app.js`, `docs/user-guide.md`, `test/server.test.js`.
3. **M — Show the effective service settings.** Add one sanitized `settings` object to `/api/state` with the effective `config.json` values and no secret or token path, and show it in a read-only Service settings section on Settings. Files: `src/engine.js`, `public/app.js`, `public/style.css`, `docs/user-guide.md`, `test/server.test.js`.
4. **L — Set the service settings.** Add a validated `PUT /api/settings` route that writes `config.json`, starting with the quota thresholds, the memory warning percent, the stale status minutes, the idle worker minutes, and the browser housekeeping values. Files: `src/config.js`, `src/server.js`, `public/app.js`, `docs/cli.md`, `docs/user-guide.md`, `test/server.test.js`.
5. **M — Show harness readiness.** Expose the `checkHarness()` findings as status words and area names only, never a value, with a read-only Harness readiness panel on Settings. Files: `src/server.js`, `public/app.js`, `docs/user-guide.md`, `test/harness.test.js`.
6. **M — Show the project worker config.** Read `.herdr-boss.json` for each open project and show its non-secret fields on the project page. Files: `src/engine.js`, `src/kit/config.js`, `public/app.js`, `docs/user-guide.md`, `test/server.test.js`.
7. **L — Edit the resource pools.** Add pool create, change, and remove controls on Allocation with the same validation as load time. Files: `src/config.js`, `src/server.js`, `src/leases.js`, `public/app.js`, `docs/user-guide.md`, `test/`.
8. **S — Show the memory pointers.** Show the project memory path, the Boss memory path, and the loaded kit file path on the project page and in the help panel. Files: `public/app.js`, `docs/user-guide.md`, `test/server.test.js`.
9. **S — Show the scan and store limits.** Show the denial scan cadence, budget, and trend thresholds on Analytics, and the message retention and send limit on Mailbox, from the state. Files: `src/engine.js`, `public/app.js`, `docs/user-guide.md`, `test/server.test.js`.
10. **S — Decide on browser bookmarks.** Ask the Owner whether a per-project bookmark list is wanted. If yes, store it in `browser-sessions.json` and show it on the Browsers page. Files: `src/browser-pool.js`, `src/server.js`, `public/app.js`, `docs/user-guide.md`.
11. **S — Decide on a dashboard lock release.** Keep the release on the owner pane, or add an Owner-only release for a stale lock. Record the choice in the user guide. Files: `src/kit/locks.js`, `src/server.js`, `public/app.js`, `docs/user-guide.md`.
