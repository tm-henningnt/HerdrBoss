# Fleet page v2

Status: design note for the Owner. This document changes no source file. Build it after the Owner accepts it.

This page answers one question in 10 seconds: how is each factory doing, and what must the Owner do now? The page has a total line, an alerts strip, one card for each factory, and per-factory project rows. The wireframe is `fleet-page-v2-wireframe.html`.

## 1. Fleet total line

The line is at the top of the page. It shows three totals for the whole fleet:

| Total | Rule | Source today |
|---|---|---|
| Workers | Sum of the running workers of all factories. | **Missing.** The factory state has `control.runningWorkers` and `control.maxWorkers`. The summary does not carry them. Gap G1. |
| Spend today | Sum of the `spend[].usd` rows whose `day` is today. A `null` row makes the total unknown, not zero. | `summary.spend[]`. Present. |
| Quota burn | Highest `usedPercent` of every shared account lane. | `summary.quotas[]`. Present. |

The page uses the browser date for "today". A factory on another time zone can report a different day. The page writes the factory day next to the total.

## 2. Alerts strip

The strip is one row under the total line. Each alert names the fix command. The page derives the strip at the head office with the data below. A known alert code shows a fixed sentence and a fixed command. An unknown code shows the code as it is.

| Alert | Test | Fix command |
|---|---|---|
| Factory not reachable | Poller `factory.error` is `unreachable` or `timeout`. | `herdr-boss factory connect NAME`, then `herdr-boss factory connect --check NAME`. |
| Read credential refused | Poller `factory.error` is `auth`. | `herdr-boss factory connect NAME` again. |
| Contract mismatch | Poller `factory.error` is `contract-mismatch`. | `herdr-boss factory update NAME --tier service`. |
| Head office older | Poller `factory.error` is `head office older`. | `herdr-boss kit update` on the head office. |
| Kit drift | `summary.kitRevision` differs from the kit revision of the head office. | `herdr-boss factory update NAME --tier service`. |
| Login expired | The new `harnesses[].login` is `expired`. Gap G3. | `herdr-boss factory login NAME claude` (or `codex`). |
| Disk low | The new `machine.diskFreePercent` is below the threshold. Gap G2. | `herdr-boss factory status NAME`, then free disk on the host. |
| Clock offset | `summary.health.clockOffsetSeconds` is above the threshold. | `herdr-boss factory status NAME`, then sync the clock of the host. |
| Status stale | A project has an old `statusAgeSeconds`, or the `status-stale` alert code. | Open the project page. The orchestrator publishes. |

The summary holds public alert codes only, by design. It holds no fix text. The page owns the code-to-command table. A new code needs one row in this table.

## 3. Factory card

One card for each factory. The card shows these fields:

| Field | Source today |
|---|---|
| Name | `summary.name` and the poller record. Present. |
| Role | Factory zero: the poller row with `remote: false`. Head office holder: `fleetRole.view()` with `headOfficeFactoryId` and `epoch`. Present. Head office candidate: the reserved succession list has no producer. Gap G6. |
| Health | `summary.health.status` (`healthy`, `degraded`, `offline`, `unknown`). Present. |
| Last seen | Poller `lastSeenAt` and `ageSeconds`. This is head office local data. It is not exchanged. Present. |
| Load and memory | `summary.machine` (`load1`, `load5`, `load15`, `cpus`, `memoryTotalMb`, `memoryFreePercent`, `swapUsedMb`). Present. |
| Kit revision and drift flag | `summary.kitRevision`. The drift flag compares this value with the head office kit revision. Present; the flag is derived. |
| Boss pane state | **Missing.** The factory state has `control.bossHandoff` and the Herdr pane list. The summary does not carry them. Gap G4. |
| Workers running | **Missing.** The factory state has `control.runningWorkers` and `control.maxWorkers`. Gap G1. |
| Harness login state | **Missing.** No route and no summary field. Gap G3. |
| Spend today | `summary.spend[]`. Present. |
| Quota readings | `summary.quotas[]` (`harness`, `accountKey`, `lane`, `usedPercent`, `resetAt`, `status`). Present. |

The card shows one row for each quota lane. The page groups the rows of one shared account. It shows the highest reading of that account. It does not add readings from two factories.

## 4. Projects of a factory

Under the factory card, one row for each project:

| Field | Source today |
|---|---|
| Project | `summary.projects[].slug`. Present. |
| Phase | `summary.projects[].phase`. Present. |
| Status | `summary.projects[].status`. Present. |
| Board counts | `summary.projects[].board` (`doing`, `review`, `blocked`, `done7d`). Present. |
| Stale flag | `summary.projects[].statusAgeSeconds`, and the `status-stale` alert code. Present. |
| Open Owner items | `summary.ownerItems.needsOwner` for the count, `summary.ownerItems.rows` for the items. The producer reads the Mailbox only. Present. Titles appear only when `shareItemTitles` is true. |
| Review packs | `summary.reviewPacks[]` (`id`, `waitingItems`). Present. |

Each Owner item links to `summary.dashboardUrl` + `/mailbox?item=ID`. The link opens the factory that owns the item.

## 5. Actions and the exit code 3 wait state

The card has four actions:

| Action | Confirm step | Result |
|---|---|---|
| Factory update, service tier | Yes. The dialog names the service restart and the code fast-forward. | Copy `herdr-boss factory update NAME --tier service`. |
| Boss start | Yes. The dialog names the new Boss pane. | Copy `herdr-boss factory boss start NAME --resume`. |
| Copy the attach command | No. | Copy `herdr-boss factory attach NAME`. |
| Open the remote dashboard | No. | Open `summary.dashboardUrl` in a new tab. |

**Decision:** the page never runs a host command. The host tool runs outside a container on the Owner's Mac. The head office can run in a container, so it cannot run the host tool. The page copies the command and names the terminal. This rule stops the page from needing write access to a host.

The wait state: a host command that waits for the Owner exits with code 3. The factory card shows `Waiting for you` in plain text, the waiting step, and the command that the person must run. Example: `Waiting for you: sign in Claude. Run: herdr-boss factory login win1 claude`. The state comes from the new `pending` field (gap G5). The page clears the state after the next good poll.

## 6. Field sources and gaps

Every field above has a source. The table below lists the fields that no source can provide today. Each gap is one proposed addition to the fleet summary contract, version 1.x, add-only.

| Gap | Missing data | Proposed contract addition | Producer |
|---|---|---|---|
| G1 | Workers running and the worker limit. | `workers` object: `{ running: count \| null, max: count \| null }`. | `src/fleet-summary.js`, from `state.control`. |
| G2 | Disk free. | `machine.diskFreePercent` (number 0..100 or null) and `machine.diskFreeMb` (number or null). New alert code `machine-disk`. | The machine sample reader. |
| G3 | Harness login state. | `harnesses` array: `{ harness, login: "ok" \| "expired" \| "unknown", checkedAt: timestamp \| null }`. New alert code `login-expired`. | The factory login check. |
| G4 | Boss pane state. | `boss` object: `{ running: boolean \| null, harness: harness \| null }`. | `src/fleet-summary.js`, from `state.control.bossHandoff`. |
| G5 | The exit code 3 wait state. | `pending` object: `{ step: slug, since: timestamp \| null }`. The page maps `step` to a command. An unknown `step` shows a generic message. | The factory wizard flow record. |
| G6 | Head office candidates. | None now. The succession list is a reserved contract. It has no producer. The page shows the holder only. Do not invent a candidate list. | None. |

Rules for each addition:

- Add the field as optional. Do not change an existing field.
- Select the field in `src/fleet-summary.js` and put it on the producer allow-list first.
- Add one valid example and, where useful, one invalid example.
- Add one test for the producer and one test for the allow-list.
- Never put a path, a token, an account identity, a message text, or a command output in a new field.

## 7. Phone layout at 393 px

The page is one column. The order is the order of the desktop page:

1. Fleet total line.
2. Alerts strip. It stays visible and wraps. An alert that the Owner must fix is never hidden on the phone.
3. Factory cards. One card for each factory.
4. A factory card shows the worst quota lane and an `N lanes` count. Touch opens the full lane list.
5. The project list shows one row for each project. The rows wrap.
6. The actions sit at the bottom of the card. `Factory update` and `Boss start` keep the confirm dialog. The confirm dialog is a full-width sheet.
7. Fleet settings and Factory shares stay in a collapsed `Details` block.

Rules:

- Each button, link button, and copy control is at least 44 by 44 px.
- No horizontal scroll. Tables become stacked rows. Long keys, slugs, and commands use `overflow-wrap: anywhere` and their own scroll box only when a command is longer than the screen.
- The page keeps the header on the phone. The Owner can reach the alerts and the first factory without a scroll.

## 8. Build plan

Six tasks. Each task owns its files. Two tasks never edit the same file.

| Task | Owns these files | Depends on | Test |
|---|---|---|---|
| T1 Contract and producer | `docs/contracts/schema/fleet-summary.v1.schema.json`, `docs/contracts/factories.md`, `docs/contracts/examples/fleet-summary.*.json`, `src/fleet-summary.js`, `test/factory/contracts.test.js`, `test/fleet-summary.test.js` | None | The contract test, the producer test, and the allow-list test. |
| T2 Fleet rollup | `src/fleet-rollup.js`, `test/fleet-rollup.test.js` | T1 | Invented snapshots give the totals, the alert strip, and the drift flag. |
| T3 Fleet page render | `public/fleet.js`, `public/fleet.css`, `test/fleet-page.test.js` | T2 | A DOM test renders a fixture and checks the four sections and the phone order. |
| T4 Actions and wait state | `public/app.js`, `public/copy.js`, `test/fleet-actions.test.js` | T3 | A DOM test checks the confirm step, the copy text, the dashboard link, and the wait state. |
| T5 Route wiring | `src/server.js`, `test/fleet-route.test.js` | T2 | An HTTP test reads `/api/fleet` and checks the rollup fields and the role. |
| T6 Docs and page help | `docs/help/fleet.md`, `docs/cli.md`, `docs/guide/factory.md` | T3, T4 | `node scripts/docs-gate.js --base main`. |

Order:

1. T1 first. The contract is the base of every other task.
2. T2 after T1.
3. T3 and T5 in parallel after T2.
4. T4 after T3, because it uses the new DOM hooks.
5. T6 last, with the final labels.

Each worker runs only its own test file with `--test-concurrency=2`. The orchestrator runs the full suite after the merges.

## Decisions

- The page is read-only for every factory. It shows commands. It does not run them.
- The head office derives the total line and the alert strip. The factory summary carries facts, not view rules.
- The alert fixes live in one table on the page. The summary keeps public codes only.
- The page shows the last good summary with its age during an outage. It does not clear the card.
- The page never shows a path, a token, an account identity, or a message text.

## Out of scope

- A new fleet route that runs a host command.
- A head office candidate list before the succession list has a producer.
- A chart or a graph on the Fleet page.
- A change to the poll interval (30 seconds) or to the tailnet access rules.
