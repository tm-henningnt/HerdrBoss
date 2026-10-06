# Fleet page v2

Status: design note for the Owner. This document changes no source file. Build it after the Owner accepts it.

The page answers one question in 10 seconds: how is each factory doing, and what must the Owner do now? The wireframe is `fleet-page-v2-wireframe.html`. Sample names are invented: `factory-zero`, `win1`, `win2`.

## 1. The first screen

The first screen has three parts, in this order:

1. **Fleet total line.** Workers, spend today, and quota burn. Each value carries a coverage label (section 1.1).
2. **Compact alert strip.** One line for each alert: a severity dot, the alert label with the fix in words, and a `Fix` control. The exact command is behind the control at every width. The control starts collapsed and its `aria-expanded` is accurate.
3. **Compact factory comparison.** One row for each factory.

The detailed cards follow the comparison.

**Acceptance condition (measured):** at 393 by 852 px, the total line, the alert labels, and every comparison row are visible without a scroll, for 3 factories and 5 alerts. At 1280 by 800 px, the first comparison row is visible without a scroll. The browser check fails the task when a row or an urgent alert label is below the first viewport, or when a hidden lane has no visible keyboard-operable control.

### 1.1 Freshness, coverage, and the totals

The summary age is `ageSeconds` on the poller row. The cutoff is **90 s**, the same value that the producer uses for degraded health (`src/fleet-summary.js:52`). Four states:

- **fresh**: a summary exists and `ageSeconds <= 90`.
- **cached**: a summary exists and `ageSeconds > 90`.
- **never-seen**: no summary.
- **unknown reading**: a field is `null`, or a spend row has `usd === null`.

Each total uses fresh values only. A cached or never-seen factory is named in the coverage label and contributes no value. A total with no fresh value reads `unknown`. A never-seen factory reads `unknown`, never `last good`. Every total shows `as of <oldest contributing age> · N of M factories`.

| Total | Input | Rule |
|---|---|---|
| Workers | `workers.running` (G1) | Sum over fresh factories. Name cached and never-seen factories. |
| Spend today | `spend[]` | Select one date for each fresh factory (section 1.2). Sum the known values. A factory with no row for that date, or an unpriced row, is `unknown`, not zero. Name it. |
| Usage limit burn | `quotas[].usedPercent` | Highest over fresh factories. Exclude and name a null reading, a cached factory, and a never-seen factory. |

### 1.2 The selected factory date

`spend[]` holds several named days (`src/fleet-summary.js:59`); the head office requests 7 (`src/server.js:293`); the day is the producer's local calendar (`src/spend.js:36`). Rules:

- With `machine.utcOffsetMinutes` (gap G10), the selected date is the current date of that factory.
- Without G10, the selected date is the factory's latest `spend[].day`, labelled `latest factory day`.
- If the selected date has no row, the factory spend is `unknown`.
- The page never converts absence into zero.

## 2. Factory card

| Field | Source today |
|---|---|
| Name | `summary.name` and the poller record. Present. |
| Kind and role | Kind from G8 (`native` or `container`), never the poller `remote` flag. The local row is the viewing factory (`src/fleet-poller.js:89`). Head office holder and epoch: `fleetRole.view()` (`src/fleet-role.js:50`). Present. Head office candidate: no producer (gap G6). |
| Health (current) | The poller row `status` and `error` (`src/fleet-poller.js:129`). Present. |
| Health (cached facts) | `summary.health.status` with the summary age. Present. |
| Last seen | Poller `lastSeenAt` and `ageSeconds`. Head office local. Present. |
| Load and memory | `summary.machine`. Present. |
| Clock | `summary.health.clockOffsetSeconds` (signed). Present. |
| Disk | **Missing.** Gap G2. The live collector already reads `diskFreePercent`, `diskFreeBytes`, and `diskTotalBytes` (`src/collect.js:437`). Show `unknown` when the reading is null, also when no alert fires. |
| Software and kit | `summary.version` and `summary.kitRevision`, each with a drift flag. Present; the flag is derived. |
| Boss availability (fact) | **Missing.** Gap G4. The producer reads the live pane list (`state.herdr.panes`, `src/collect.js:68`). This is a fact, not a wait. An absent Boss is not an Owner action. |
| Workers running | **Missing.** Gap G1. The producer reads `control.runningWorkers` and `control.maxWorkers` (`src/control.js:1125`, `:1184`). |
| Harness login state | **Missing.** Gap G3. The local check runs `claude auth status` and `codex login status` (`src/factory-wizard.js:10`). |
| Spend today | `summary.spend[]` with the selected date (section 1.2). Present, with gap G10. |
| Quota readings | `summary.quotas[]`. Present. Group one shared account and show its highest reading. Do not add two factories. |
| Last backup | **Missing and deferred.** Gap G11. The host receipt holds a path and a timestamp (`src/factory-recovery.js:141`), so it cannot be forwarded. No timestamp producer ships in the six tasks. Show `unknown`. |

## 3. Projects of a factory

One row for each project: slug, phase, status, board counts (`doing`, `review`, `blocked`, `done7d`), and a stale flag from `statusAgeSeconds`.

The factory-wide Owner count is `summary.ownerItems.needsOwner`, from the Mailbox only. It stays at the factory level.

**The per-project Owner count is missing.** The exchanged rows hold `id`, `kind`, and an optional title, with no project or thread key (`src/fleet-summary.js:33`). The Mailbox record does hold the thread (`src/messages.js:306`), so the producer can add it. This is gap G7: an optional `projectSlug` on each `ownerItems.rows[]` entry. Keep an item with no project at the factory level. Do not count a review pack or a board wait a second time. The page shows no per-project count until G7 exists.

## 4. Actions: native and container

The host tool resolves container records only (`managedFactory` selects `kind === 'container'`, `src/factory-core.js:121`). Factory zero is native, so the container commands do not apply to it. The page shows the action set of the factory kind. The same rule applies to alert fixes.

| Action | Container factory | Native factory zero |
|---|---|---|
| Factory update | Copy `herdr-boss factory update NAME --tier service`. | No page command. Show: run the release steps in `AGENTS.md` (fast-forward `main`, restart the service). |
| Boss start | Copy `herdr-boss factory boss start NAME --resume`. | Not available from this page (gap G8). |
| Attach command | Copy `herdr-boss factory attach NAME`. | Not applicable. Herdr is local. |
| Open dashboard | Open `summary.dashboardUrl`. | Open `summary.dashboardUrl`. |
| Harness login fix | Copy `herdr-boss factory login NAME <harness>` for the expired row. | Sign in the harness in a terminal on this Mac. |
| Disk-low check | Copy `herdr-boss factory status NAME`. | Free disk space on this Mac. Check the data volume with `df -h`. |
| Clock check | Check the clock of the host. | Check Date and Time in System Settings on this Mac. |
| Consumer-older, kit, and software drift | Copy `herdr-boss factory update NAME --tier service`. | Run the release steps in `AGENTS.md`. |

The page never runs a host command. It copies the command and names the Owner terminal.

## 5. The exit code 3 wait state

A host command that waits for the Owner exits with code 3. Two different things are shown:

1. **A factual state.** Boss availability (G4) and login state (G3) are facts. They are not waits. An absent Boss can be a deliberate stop, so it never creates a wait.
2. **A verified Owner wait.** The page shows `Waiting for you: <step>` only for a step that the factory verifies and that needs the Owner.

**The factory-verified wait.** The only step the factory can verify today is `login-<harness>`: the local check returns `expired`. The producer is the factory service. `pending` (G5) is an **array** of `{ step, since }`, so two expired logins show as two steps. A step clears only when its own check passes (`login` becomes `ok`). An `unknown` reading never clears a step. A healthy poll updates the summary age only. It never clears a step.

**Host-only waits are invisible.** `factory configure` writes a host-private flow and instruction file and returns 3 (`src/factory-wizard.js:154`), and its text says only that the Boss **can** post the instruction (`src/factory-wizard.js:75`). `factory connect` writes a host-private journal and returns 3 (`src/factory-connect.js:269`). Neither posts a Mailbox item. By contrast, `factory boss start` posts an item for a missing login and for an unsent prompt (`src/factory-boss.js:496`, `:511`). Rule: a host-only wait shows only as a Mailbox item and its count. If no item exists, the wait is invisible. This is gap G9, deferred. Never publish the private flow, an instruction path, a login output, or a credential.

## 6. Field sources and gaps

Each gap is one optional, add-only addition to fleet-summary contract 1.x.

| Gap | Missing data | Proposed addition | Producer |
|---|---|---|---|
| G1 | Workers | `workers`: `{ running: count \| null, max: count \| null }`. | `src/fleet-summary.js`, from `state.control`. |
| G2 | Disk | `machine.diskFreePercent` (0..100 or null), `machine.diskFreeMb` (number or null). Alert code `machine-disk`. | `src/fleet-summary.js`, from `state.machine.diskFreePercent` and `diskFreeBytes` (`src/collect.js:437`). |
| G3 | Harness login state | `harnesses`: `[{ harness, login: "ok" \| "expired" \| "unknown", checkedAt }]`. Alert code `login-expired`. | `src/fleet-login.js` (new), from `claude auth status` and `codex login status` (`src/factory-wizard.js:10`). |
| G4 | Boss availability (fact) | `boss`: `{ running: boolean \| null, harness: harness \| null }`. | `src/fleet-summary.js`, from the live pane list (`src/collect.js:68`). |
| G5 | Factory-verified Owner waits | `pending`: `[{ step: slug, since: timestamp \| null }]`. | The factory service, from G3. Clear only on a passing check. |
| G6 | Head office candidates | None. The succession list is reserved and has no producer. | None. |
| G7 | Per-project Owner count | `ownerItems.rows[].projectSlug` (optional). | `src/fleet-summary.js`, from the Mailbox thread (`src/messages.js:306`). Items with no project stay factory-level. |
| G8 | Factory kind | `kind`: `"native" \| "container"`. | `src/fleet-summary.js`, or the registry kind selected into the poller record (`src/fleet-poller.js:19`; the registry already holds it). |
| G9 | Host-only wait steps | None safe today. Show the Mailbox count only. | None. Needs an allow-listed publication path through the host boundary. Deferred. |
| G10 | The factory calendar day | `machine.utcOffsetMinutes` (number or null). | `src/fleet-summary.js`, from the machine sample. Until then, use the latest `spend[].day` and label it. |
| G11 | Last backup time | `backup`: `{ lastAt: timestamp \| null }`. | The host tool, through the G9 publication path. The private receipt stays private. Deferred; show `unknown`. |

Rules for each addition: add it as optional; select it in the producer first; add a valid and, where useful, an invalid example; add a producer test and an allow-list test. Never put a path, a token, an account identity, a message text, a login output, or a command output in a new field.

### Alert rules

| Alert | Test | Fix (container) | Fix (native) |
|---|---|---|---|
| Factory not reachable | Poller `status` is `offline` and `error` is `unreachable` or `timeout`. | `herdr-boss factory connect NAME`. | The same check on the native service. |
| Read credential refused | Poller `error` is `auth`. | `herdr-boss factory connect NAME`. | Not applicable. |
| Contract mismatch | Poller `error` is `contract-mismatch`. | `herdr-boss factory update NAME --tier service`. | The service release. |
| Consumer older | Poller `factory.drift` is `head office older`. Read `drift`, not `error` (`src/fleet-contract.js:28`). | Update the head office service or code. A kit-only update is not enough. | The same. |
| Kit or software drift | `summary.kitRevision` or `summary.version` differs from the head office. | `herdr-boss factory update NAME --tier service`. | The release steps. |
| Login expired | `harnesses[].login` is `expired` (G3). | `herdr-boss factory login NAME <harness>` for the expired row. | Sign in the harness in a terminal. |
| Disk low | `machine.diskFreePercent` is below 20% (warning) or 5% (error) (G2). | `herdr-boss factory status NAME`. | Free disk space on this Mac. Check `df -h`. |
| Clock offset | `Math.abs(health.clockOffsetSeconds)` is above 30 s (warning) or 300 s (error). Keep the sign. Null stays unknown (`src/health.js:10`). | Check the clock of the host. | Check Date and Time in System Settings. |
| Status stale | `projects[].statusAgeSeconds` is above 2 h, or the `status-stale` alert code. | Open the project page. The orchestrator publishes. | The same. |

## 7. Phone layout at 393 px

1. Total line. 2. Compact alert strip: the label and the fix in words are visible, and a 44 px `Fix` control reveals the command. 3. Compact factory comparison. Each phone row shows name, health, kind, last seen, workers, worst quota, spend, Owner, and version/kit with the drift flag. 4. Factory cards. 5. A card shows the worst quota lane and a 44 px `N lanes` button with `aria-expanded`; the button opens the full list and is visible at every width. 6. Project rows wrap. 7. Actions wrap; the confirm step is a full-width sheet. 8. Settings and shares stay collapsed.

Rules: each control is at least 44 by 44 px. No horizontal scroll. Long commands wrap. The confirm sheet shows the exact command, the Owner terminal, `Confirm copy`, and `Cancel`. `Confirm copy` shows success only after a successful write. On a refusal or a missing clipboard API, the sheet stays open, selects the exact command, and shows a manual-copy instruction.

## 8. Build plan

Six tasks. Each task owns its files. Two tasks never edit the same file. The order is sequential: T1 → T2 → T3 → T4 → T5 → T6.

| Task | Owns | Depends on | Tests |
|---|---|---|---|
| T1 Contract | `docs/contracts/schema/fleet-summary.v1.schema.json`, `docs/contracts/factories.md`, `docs/contracts/examples/fleet-summary.*.json`, `test/factory/contracts.test.js` | None | Schema, examples, and the allow-list. Refuse an unknown field. Keep add-only compatibility and the title-sharing condition when G7 is added. |
| T2 Producers | `src/fleet-summary.js`, `src/fleet-login.js` (new), `src/fleet-poller.js`, `test/fleet-summary.test.js`, `test/fleet-login.test.js`, `test/fleet-poller.test.js` | T1 | The **T2 summary interface** (section 6). Each field with a real value and a null value, and a temporary `HOME`. Boss availability from the pane list. The poller record carries `kind`. **Raw Mailbox filtering**: a closed item, an information item, and a review pack already in the Mailbox change no count. **Wait transitions**: an expired login sets a `pending` step; `login ok` clears it; a healthy poll with a persistent wait keeps the step; two expired logins give two steps. The summary holds no path, token, or plaintext. |
| T3 Rollup | `src/fleet-rollup.js`, `test/fleet-rollup.test.js` | T2 | The **accepted-summary** counts only. Fresh, cached, never-seen, and unpriced coverage per total. The selected date and the no-current-day-row result. Shared-lane grouping. `drift` without a poll error. A negative clock offset. The freshness cutoff. |
| T4 Route | `src/server.js`, `test/fleet-route.test.js` | T3 | The **T4 response contract**: `/api/fleet` returns `{ pollSeconds, registryError, role, totals, factories }`, and each factory keeps the attach metadata (`src/server.js:522`). A real summary fixture where the Mailbox enters. The preview refusal for nonlocal requests and API writes. The loopback rule and the `fleetRead`/`fleetGuide` credential refusals. |
| T5 Render | `public/fleet.js`, `public/fleet.css`, `test/fleet-view.test.js`, `test/fleet-page.test.js` | T4 | The **T5 DOM and action hooks** (section 8.1). Update the two existing `test/fleet-view.test.js` cases. DOM checks for the compact comparison, the collapsed alert strip, the phone comparison facts, and the unknown backup. A real-browser check at 393 px and desktop, light and dark: no horizontal scroll, controls at least 44 px, every lane visible or reachable from a visible keyboard-operable control on a fresh desktop load, and the first-screen acceptance condition. |
| T6 Actions and docs | `public/app.js`, `public/copy.js`, `test/fleet-actions.test.js`, `docs/help/fleet.md`, `docs/cli.md`, `docs/guide/factory.md` | T5 | Display and the kind-specific command for the card and each alert. Confirm, cancel, and copy outcomes: a successful write, a rejected write, and a missing clipboard API. The docs gate. |

### 8.1 Frozen interfaces

- **T2 summary interface:** the summary JSON fields G1 to G5, G7, and G8, with their exact names and value shapes from section 6.
- **T4 response contract:** `{ pollSeconds, registryError, role, totals, factories }`. `totals` holds `{ workers, spend, quota }`, each `{ value, asOf, coverage }`. Each factory row keeps `{ name, kind, status, error, drift, ageSeconds, lastSeenAt, attach, summary }`.
- **T5 DOM and action hooks:** the `data-fleet-*` attributes, the exported `fleetView` and `fleetComparison` functions, and the `data-action` / `data-copy` attributes that T6 reads.

No task starts before its dependency freezes. T4 and T5 do not run in parallel.

## Decisions

### Round 2 findings

| Finding | Resolution |
|---|---|
| P1-1 factory-side wait facts | Section 5 separates the factual Boss availability (G4) from a verified Owner wait. The wait step is only `login-<harness>`, which the factory verifies. `pending` is an array (G5), so simultaneous waits are represented. A step clears only on its own passing check; an unknown reading never clears it. Host-only waits (wizard, connect, boss start) are gap G9, deferred, and show only as a Mailbox item. |
| P1-2 desktop lanes unreachable | The `N lanes` button is visible at every width (section 7, wireframe). T5 asserts that every lane is visible or reachable from a visible keyboard-operable control on a fresh desktop load. |
| P2-1 comparison loses its purpose | The alert strip starts collapsed at every width and `aria-expanded` is accurate (section 1). The phone comparison row carries kind, last seen, workers, worst quota, spend, Owner, and version/kit with drift (section 7). |
| P2-2 coverage and the factory day | Section 1.1 defines fresh, cached, never-seen, and unknown reading, with the 90 s cutoff, an as-of label, and a per-total rule. Section 1.2 defines the selected factory date and the no-row result. A never-seen factory is `unknown`, never `last good`. |
| P2-3 native alert fix | Section 4 and the alert table apply the kind-specific mapping to alert fixes. Native disk-low uses an Owner-terminal instruction. The login fix uses the expired row's harness. T6 tests both. |
| P2-4 last-backup unknown | Section 2 and the wireframe add the last-backup fact as `unknown`. G11 is deferred; no timestamp producer ships in the six tasks. The receipt and archive paths stay private. |
| P2-5 false copy success | Section 7 defines success only after a successful write. The wireframe keeps the sheet open, selects the command, and shows a manual-copy instruction on a refusal or a missing API. T6 tests both. |
| P2-6 contradictory samples | The wireframe totals are consistent with the rows (5 fresh workers, $14.30 fresh spend). The win1 alert matches its detail (`claude expired`). The clock sample is `-42 s`, above the 30 s warning, with the sign kept. |
| P2-7 build boundaries | Section 8 keeps T4 → T5 sequential and names the T2 summary interface, the T4 response contract, and the T5 DOM and action hooks. Mailbox filtering and wait transitions move to T2. T3 keeps accepted-summary counts. T4 keeps the real summary fixture and the access refusals. T6 keeps display, confirm, cancel, and copy outcomes. G9 and G11 are deferred; T5 renders the unknown backup. |

### Round 1 findings (kept)

| Finding | Resolution |
|---|---|
| P1-1 per-project Owner count | Gap G7. The page shows the factory-wide Mailbox count only. |
| P1-2 native actions | Section 4 splits native and container actions. Gap G8 carries the kind. |
| P1-3 pending producer | Section 5. The factory owns the verified wait. A good poll never clears a step. |
| P1-4 hierarchy | Section 1 and its measured acceptance condition. |
| P1-5 build plan | Section 8 assigns every producer and adds the boundary tests. |
| P2-1 totals | Section 1.1. |
| P2-2 factory-zero identity | Gap G8, not `remote`. |
| P2-3 consumer-older | Read `factory.drift`. |
| P2-4 clock | Absolute offset, signed text, null unknown, named thresholds. |
| P2-5 recovery freshness | Section 2. Software and kit drift together, disk unknown, backup unknown. |
| P2-6 phone states | Section 7. The lane button and the confirm sheet. |

## Out of scope

- A new fleet route that runs a host command.
- A head office candidate list before the succession list has a producer.
- A head office push of host-only wait steps before the G9 publication path exists.
- A last-backup timestamp producer in the six tasks.
