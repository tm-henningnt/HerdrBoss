# Fleet page v2

Status: design note for the Owner. This document changes no source file. Build it after the Owner accepts it.

The page answers one question in 10 seconds: how is each factory doing, and what must the Owner do now? The wireframe is `fleet-page-v2-wireframe.html`. Sample names are invented: `factory-zero`, `win1`, `win2`.

## 1. The first screen

The first screen shows three parts, in this order:

1. **Fleet total line.** Workers, spend today, and quota burn. Each value carries a coverage label. A value that includes a factory with no fresh summary reads `last good`, not `now`.
2. **Compact alert strip.** One line for each alert: a severity dot and the alert label. The fix command sits behind a `Fix` control. The urgent labels stay visible.
3. **Compact factory comparison.** One row for each factory: name, factory zero or container, health, last seen, workers, worst quota lane, spend today, Owner items, and version plus kit drift.

The detailed cards follow the comparison.

**Acceptance condition (measured):** at 393 by 852 px, the total line, the alert labels, and every comparison row are visible without a scroll, for 3 factories and 5 alerts. The browser check fails the task when a comparison row or an urgent alert label is below the first viewport.

## 2. Factory card

The card holds the fields below. The comparison row repeats the key facts.

| Field | Source today |
|---|---|
| Name | `summary.name` and the poller record. Present. |
| Role | Factory zero: the new factory-kind field (gap G8). Never the poller `remote` flag, because the local row is the viewing factory, not factory zero. Head office holder and epoch: `fleetRole.view()`. Present. Head office candidate: the succession list has no producer (gap G6). |
| Health (current) | The poller row `status` and `error`. Present. Never the cached `summary.health.status` for current reachability. |
| Health (cached facts) | `summary.health.status`, with the summary age. Present. |
| Last seen | Poller `lastSeenAt` and `ageSeconds`. Head office local. Not exchanged. Present. |
| Load and memory | `summary.machine`. Present. |
| Disk | **Missing.** Gap G2. Show `unknown` when the reading is null, also when no alert fires. |
| Software and kit | `summary.version` and `summary.kitRevision`, each with a drift flag. Present; the drift flag is derived. |
| Boss pane state | **Missing.** Gap G4. The producer reads the live pane list, not `control.bossHandoff`, because `bossHandoff` is a handover candidate and exists when no Boss pane has an agent. |
| Workers running | **Missing.** Gap G1. |
| Harness login state | **Missing.** Gap G3. |
| Spend today | `summary.spend[]`, filtered by the factory day. Present, with a day-boundary gap (G10). |
| Quota readings | `summary.quotas[]`. Present. Group one shared account and show its highest reading. Do not add two factories. |

## 3. Projects of a factory

One row for each project: slug, phase, status, board counts (`doing`, `review`, `blocked`, `done7d`), and a stale flag from `statusAgeSeconds`.

The factory-wide Owner count is `summary.ownerItems.needsOwner`, from the Mailbox only. It stays at the factory level.

**The per-project Owner count is missing.** The exchanged rows hold `id`, `kind`, and an optional title, with no project or thread key. The head office cannot split two items between two projects. This is gap G7: an optional `projectSlug` on each `ownerItems.rows[]` entry, derived from the Mailbox open actionable items. Keep an item with no project at the factory level. Do not count a review pack or a board wait a second time. The page shows no per-project count until G7 exists.

## 4. Actions: native and container

The host tool resolves container records only (`managedFactory` selects `kind === 'container'`). Factory zero is native, so the container commands do not apply to it. The page shows the action set of the factory kind.

| Action | Container factory | Native factory zero |
|---|---|---|
| Factory update | Copy `herdr-boss factory update NAME --tier service`. | No page command. Show: run the release steps in `AGENTS.md` (fast-forward `main`, restart the service). |
| Boss start | Copy `herdr-boss factory boss start NAME --resume`. | Not available from this page (gap G8). |
| Attach command | Copy `herdr-boss factory attach NAME`. | Not applicable. Herdr is local. |
| Open dashboard | Open `summary.dashboardUrl`. | Open `summary.dashboardUrl`. |
| Harness login fix | Copy `herdr-boss factory login NAME claude` (or `codex`). | Sign in the harness in a terminal on this Mac. No host-tool command. |

The page never runs a host command. It copies the command and names the Owner terminal. The head office can run in a container, so it cannot run the host tool.

## 5. The exit code 3 wait state

A host command that waits for the Owner exits with code 3. The page shows the wait as one plain line: `Waiting for you: <step>`. The step names the action and the command or terminal.

The factory owns the wait state. The page derives it from facts the factory verifies:

- Boss pane is not live, from the live pane list → step `boss-start`.
- A harness login is `expired` → step `login-<harness>`.

The producer is the factory service, in the summary builder, from the pane list (G4) and the login check (G3). It does not read the host wizard flow. Never publish the flow, an instruction path, a login output, or a credential.

**Clear rule:** clear a step only when the check that set it passes, for example the Boss pane is live or the login is `ok`. A successful poll updates the summary age only. It never clears a step.

A host-only wait with no factory-side check shows as the Mailbox item count, not as a step. This is gap G9: the factory has no safe source for a host-only step. Do not invent one.

## 6. Field sources and gaps

Each gap is one optional, add-only addition to fleet-summary contract 1.x.

| Gap | Missing data | Proposed addition | Producer |
|---|---|---|---|
| G1 | Workers | `workers`: `{ running: count \| null, max: count \| null }`. | `src/fleet-summary.js`, from `state.control`. |
| G2 | Disk | `machine.diskFreePercent` (0..100 or null), `machine.diskFreeMb` (number or null). Alert code `machine-disk`. | The machine sample reader; `collect.js` already reads the values. |
| G3 | Harness login state | `harnesses`: `[{ harness, login: "ok" \| "expired" \| "unknown", checkedAt }]`. Alert code `login-expired`. | The factory login check. |
| G4 | Boss pane state | `boss`: `{ running: boolean \| null, harness: harness \| null }`. | The live pane list (`label === "boss" && agent`), not `bossHandoff`. |
| G5 | Owner waits | `pending`: `{ step: slug, since: timestamp \| null }`. | The factory service, from G3 and G4. Clear only on a passing check. |
| G6 | Head office candidates | None. The succession list is reserved and has no producer. | None. |
| G7 | Per-project Owner count | `ownerItems.rows[].projectSlug` (optional). | The Mailbox producer. Items with no project stay factory-level. |
| G8 | Factory kind | `kind`: `"native" \| "container"`. | The summary producer, or the registry selected into the poller record. |
| G9 | Host-only wait steps | None safe today. Show the Mailbox count. | None. Needs an allow-listed publication path through the host boundary. |
| G10 | The factory calendar day | `machine.utcOffsetMinutes` (number or null). | The machine sample reader. Until then, use each `spend[].day` and label it `by factory day`. |
| G11 | Last backup time | `backup`: `{ lastAt: timestamp \| null }`. | The host tool, through the G9 publication path. The private receipt stays private. Show `unknown` until then. |

Rules for each addition: add it as optional; select it in the producer first; add a valid and (where useful) an invalid example; add a producer test and an allow-list test. Never put a path, a token, an account identity, a message text, a login output, or a command output in a new field.

### Alert rules

| Alert | Test | Fix |
|---|---|---|
| Factory not reachable | Poller `status` is `offline` and `error` is `unreachable` or `timeout`. | `herdr-boss factory connect NAME`. |
| Read credential refused | Poller `error` is `auth`. | `herdr-boss factory connect NAME`. |
| Contract mismatch | Poller `error` is `contract-mismatch`. | `herdr-boss factory update NAME --tier service` for a container; the service release for native. |
| Consumer older | Poller `factory.drift` is `head office older`. Read `drift`, not `error`. | Update the head office service or code. Updating the kit alone is not enough. |
| Kit drift | `summary.kitRevision` differs from the head office kit revision. | Container: `herdr-boss factory update NAME --tier service`. Native: the release steps. |
| Software drift | `summary.version` differs from the head office version. | The same as kit drift. |
| Login expired | `harnesses[].login` is `expired` (G3). | Container: `herdr-boss factory login NAME claude`. Native: sign in at the terminal. |
| Disk low | `machine.diskFreePercent` is below 20% (warning) or 5% (error) (G2). | `herdr-boss factory status NAME`, then free disk. |
| Clock offset | `Math.abs(health.clockOffsetSeconds)` is above 30 s (warning) or 300 s (error). Keep the sign in the text. Null stays unknown. | Check the clock of the host. |
| Status stale | `projects[].statusAgeSeconds` is above 2 h, or the `status-stale` alert code. | Open the project page. The orchestrator publishes. |

## 7. Phone layout at 393 px

1. Total line. 2. Compact alert strip: the label is visible, and a 44 px `Fix` control reveals the command. 3. Compact factory comparison. 4. Factory cards. 5. A card shows the worst quota lane and a 44 px `N lanes` button with `aria-expanded`; the button opens the full list. 6. Project rows wrap. 7. Actions wrap; the confirm step is a full-width sheet. 8. Settings and shares stay collapsed.

Rules: each control is at least 44 by 44 px. No horizontal scroll. Long commands wrap. The confirm sheet shows the exact command, the Owner terminal, `Confirm copy`, and `Cancel`.

## 8. Build plan

Six tasks. Each task owns its files. Two tasks never edit the same file. Freeze the data interface (T2) and the DOM hooks (T5) before the next task starts.

| Task | Owns | Depends on | Tests |
|---|---|---|---|
| T1 Contract | `docs/contracts/schema/fleet-summary.v1.schema.json`, `docs/contracts/factories.md`, `docs/contracts/examples/fleet-summary.*.json`, `test/factory/contracts.test.js` | None | Schema, examples, and the allow-list. Refuse an unknown field. |
| T2 Producers | `src/fleet-summary.js`, `src/fleet-login.js` (new), `src/machine-samples.js`, `src/fleet-poller.js`, `test/fleet-summary.test.js`, `test/fleet-login.test.js`, `test/fleet-poller.test.js` | T1 | Each new field with a real value, a null value, and a temporary `HOME` fixture. Boss liveness from the pane list. The summary holds no path, token, or plaintext. The poller record carries `kind`. |
| T3 Rollup | `src/fleet-rollup.js`, `test/fleet-rollup.test.js` | T2 | Totals for missing, offline, null, and shared-lane data. `drift` without a poll error. A negative clock offset. Freshness and coverage labels. Owner items: a closed item, an information item, and a review pack already in the Mailbox change no count. |
| T4 Route | `src/server.js`, `test/fleet-route.test.js` | T3 | `/api/fleet` returns the rollup and role. Keep the preview refusal for nonlocal requests and API writes. Keep the loopback rule and the `fleetRead`/`fleetGuide` credential refusals. |
| T5 Render | `public/fleet.js`, `public/fleet.css`, `test/fleet-view.test.js`, `test/fleet-page.test.js` | T4 | Update the two existing `test/fleet-view.test.js` cases. DOM checks for the compact comparison, the alert strip, and the phone order. A real-browser check at 393 px and desktop, light and dark: no horizontal scroll, controls at least 44 px, the `N lanes` button expands, and the first-screen acceptance condition. |
| T6 Actions and docs | `public/app.js`, `public/copy.js`, `test/fleet-actions.test.js`, `docs/help/fleet.md`, `docs/cli.md`, `docs/guide/factory.md` | T5 | Confirm, cancel, and copy. Native and container action sets. The wait state clears only on a passing check. `node scripts/docs-gate.js --base main`. |

Order: T1 → T2 → T3 → T4 → T5 → T6. T4 may run beside T5 when T3 is frozen.

## Decisions

- **D1 (P1-1):** the per-project Owner count is a gap (G7). The page shows the factory-wide count only, until the contract has a safe project association. Review packs and board waits never add a second count.
- **D2 (P1-2):** the factory-kind field (G8) selects the action set. Factory zero is native. Container commands never appear on the native card. Native actions with no verified flow show as unavailable and name the release steps or the terminal.
- **D3 (P1-3):** the wait state lives on the factory side. The producer is the factory service, from the login check and the live pane list. It does not read the host flow. A step clears only when its check passes; a good poll updates freshness only. Host-only waits show as a Mailbox count (G9).
- **D4 (P1-4):** the first screen is the total line, the compact alert strip, and the compact factory comparison. The measured acceptance condition is in section 1.
- **D5 (P1-5):** every new producer is owned by T2, with `kind` in the poller record. The build plan adds the real-browser check, the credential and preview boundary tests, the existing `test/fleet-view.test.js` cases, the null and offline rollup cases, and the confirm and cancel tests.
- **D6 (P2-1):** a total with a missing or stale part reads `last good` with an as-of age. Current reachability uses the poller `status` and `error`. Spend uses each `spend[].day` and is labelled `by factory day`; G10 adds the offset.
- **D7 (P2-2):** factory zero uses `kind === "native"` (G8), never `remote: false`. The head office holder and epoch stay in the role view.
- **D8 (P2-3):** the consumer-older alert reads `factory.drift`. The fix updates the head office service or code, not the kit alone.
- **D9 (P2-4):** the clock rule uses the absolute offset, keeps the sign, and keeps null unknown. Disk and stale-status thresholds have named values.
- **D10 (P2-5):** the card shows software and kit drift together, and shows disk with an explicit unknown state. Last backup is gap G11 and shows `unknown`; the private receipt never leaves the host.
- **D11 (P2-6):** the wireframe adds a 44 px lane-expansion button, a confirm sheet with the exact command and a cancel path, and labels the placeholder links.

## Out of scope

- A new fleet route that runs a host command.
- A head office candidate list before the succession list has a producer.
- A head office push of host-only wait steps before the G9 publication path exists.
