# Plan: lock classes

Status: planned on 2026-09-30. Plan only. Build nothing until the Boss says go. Source: the G3 line in `docs/orchestration/memory.md`, the lock ledger of G0, and the lock code in `src/kit/locks.js` and `src/kit/suite.js`.

## Goal

One long job at a time holds the machine. Short jobs, such as a browser check or a small test run, wait behind it in the same queue. This plan adds a second lock class for short jobs. A short job may run beside one long job. A parallelism cap limits the total load.

## What exists now

- The `full-suite` lock is machine-wide. Every full test suite and every push with a pre-push suite hook takes it (`suite`, `push`, and `manual` kinds).
- Waiters take tickets in `locks/machine/queue/full-suite/` and get the lock in ticket order.
- A `push` holder sets a re-entry token (V112). A `suite` that the pre-push hook starts reuses the push lock and takes no second lock.
- The ledger `lock-ledger.jsonl` has one line for each acquire, release, busy result, and timeout. `lockStats` on `/api/state` gives the counts and the medians of the last 7 days.
- Nothing limits a browser check or a small test run. Each one runs at once, also when a suite runs.

## 1. The data

The figures below come from `lockStats` in `GET /api/state`. They cover 7 days. The ledger file was not read directly. No project name, path, or raw line appears here.

| Figure | All locks | `full-suite` |
| --- | --- | --- |
| Acquires | 41 | 36 |
| Releases | 39 | 34 |
| Busy results | 0 | 0 |
| Timeouts | 1 | 1 |
| Re-entrant acquires | 2 | 2 |
| Takeovers | 0 | 0 |
| Median wait | 53 ms | 80 ms |
| Median hold | 222 s | 230 s |

What the figures show:

1. A full suite holds the lock for about 4 minutes at the median.
2. The median wait is under 1 second. Most acquires find a free lock.
3. One wait ended in a timeout. The data does not show how long the longest waits were.
4. `lockStats` has no wait percentile and no median for each kind. It cannot show whether short jobs wait behind long jobs.
5. The other lock name in the ledger belongs to a single project. It has a median hold of 14 s. It is not a machine lock.

The data shows that the queue is short at the median. It does not show the tail. The plan therefore starts with a measurement task (L0). L0 decides whether to build the rest.

## 2. Design

### Classes

| Class | Members | Slots |
| --- | --- | --- |
| `long` | `suite`, `push` with a suite hook, `manual` `full-suite` lock | 1 |
| `short` | browser check, small test run, other job that a caller marks short | `shortSlots` |

The `full-suite` lock stays the long class. Its name, its queue, its ticket format, and its re-entrant rule do not change. A new machine lock name `short-check` is the short class. It has its own queue directory and its own holder records.

### Admission rule

The engine of the lock code admits a job in this order:

1. A long job is admitted when no long job holds the lock and it is at the head of the long queue. It waits for running short jobs to end (drain). It does not stop them.
2. A short job is admitted when all of these are true:
   1. The count of live short holders is below `shortSlots`.
   2. The count of live holders of both classes is below `maxParallel`.
   3. No long job waits at the head of its queue while no long job holds. The waiting long job drains the short jobs first.
3. A short job may run beside a live long holder.
4. Short jobs are admitted in ticket order among themselves.

The rule has no priority inversion for long jobs: a short job never starts while a long job waits for a free machine. A long job waits for at most the running short jobs, which are short by definition.

### Policy keys and defaults

| Key | Default | Meaning |
| --- | --- | --- |
| `locks.classesEnabled` | `false` | Switch for the short class. Off means `short-check` takes the `full-suite` lock, as today. |
| `locks.shortSlots` | 2 | Most short holders at one time |
| `locks.maxParallel` | 3 | Most holders of both classes at one time |
| `locks.shortTtlMinutes` | 15 | A short holder expires after this time |
| `locks.shortWaitSeconds` | 300 | Default wait of a short acquire |

Range checks in `validatePolicy()`: `shortSlots` 1 to 8, `maxParallel` 1 to 16, `shortSlots` at most `maxParallel`, `shortTtlMinutes` 1 to 120, `shortWaitSeconds` 1 to 3600. `maxParallel` of 1 gives today's behavior for long jobs and lets no short job run beside one.

The default is off. G4 (swap guard) and the CPU guard stay separate. Both classes obey the swap refusal of G4g when it exists.

### Commands

| Command | Action |
| --- | --- |
| `herdr-boss lock acquire short-check [--wait SECONDS]` | Take a short slot. |
| `herdr-boss lock release short-check` | Release the short slot of this pane. |
| `herdr-boss short [--wait SECONDS] -- COMMAND...` | Take a short slot, run `COMMAND...`, release the slot also when the command fails. Exit code 75 when the wait ends first. |

Worker panes may take `short-check`, as they may take `full-suite`. The rule of the live run record is the same. `suite` and `push` do not change.

With `locks.classesEnabled` off, `short` runs the command under the `full-suite` lock. With it on, `short` uses the slots.

### Records

A short holder record is a file in `locks/machine/` with the name `short-check.<id>.json`. It holds the same fields as a `full-suite` record: owner pane, PID, kind, safe acquire command, and acquisition time. It adds `class: "short"` and `slot` (a number from 1). A holder that ended is stale by the same test as today: the PID is dead or the pane is closed.

The existing single-file record of `full-suite` stays valid. A record without `class` is `long`.

## 3. Ledger and Locks panel

### Ledger

Each acquire and release line adds these keys:

| Key | Value |
| --- | --- |
| `class` | `long` or `short`. A line without it is `long`. |
| `longHolders` | Live long holders at the time, 0 or 1 (acquire lines only) |
| `shortHolders` | Live short holders at the time, without this job (acquire lines only) |
| `beside` | `true` when a short job ran while a long job held (release lines of a short job) |

The keys hold counts and words only. The privacy rule of the ledger does not change.

### Statistics

`lockStats` in `src/kit/locks.js` gains:

- A block for each class: acquires, timeouts, median wait, 90th percentile of the wait, median hold.
- A median and a 90th percentile of the wait for each kind (`suite`, `push`, `manual`).
- `besideShare`: the share of short holds that ran beside a long hold.

L0 adds the wait percentiles and the kind medians before any class exists. They already apply to the current ledger.

### Locks panel

- The panel shows one row for each holder. A short holder row has the class `short` and its slot.
- The queue view shows the long queue and the short queue in two groups.
- The history line shows median and 90th percentile of the wait for each class.
- A line shows `Parallel now: N of M` when `classesEnabled` is on.
- Settings shows the five policy keys in a Locks section. The switch is off by default.
- `HELP` text in `public/app.js` explains both classes in the same change.

## 4. Failure cases

| Case | Behavior |
| --- | --- |
| A short holder crashes | The PID is dead. The next acquire or the engine tick marks the record stale and frees the slot. |
| A short holder pane closes | The pane check marks the record stale. The slot is free. |
| A short holder runs past `shortTtlMinutes` | The record expires. The next acquire takes the slot over. The engine sends the former holder a warning, as it does for a manual `full-suite` lock. |
| A long holder crashes | Today's rule applies: the record is stale and the head ticket takes over. Short holders keep running. |
| A stale short ticket | A ticket whose pane or PID is gone is skipped, as in `ticketIsLive()`. A broken ticket file is skipped with one warning (T1). |
| A long ticket waits and short jobs keep arriving | Rule 2.3 stops new short admissions. The long job waits for the running short jobs only. |
| Every short slot is held by jobs that never end | The TTL frees them. A long job is not blocked longer than `shortTtlMinutes`. |
| Re-entrant lock (V112) | A `push` holder passes its token to the hook. A `suite` in the hook reuses the push lock and takes no long slot. A `short` command in the same hook takes a short slot. It does not use the token, because the token applies to the `full-suite` lock only. The ledger writes lines with `reentrant: true` for the suite, as today. |
| `short` inside a long holder of the same pane | Allowed. The pane holds one long slot and may hold short slots. |
| `short` inside a `short` | Refused with a message. A nested short job would hold two slots and can deadlock at `maxParallel`. |
| `classesEnabled` switched off while short holders run | Live short holders finish. New `short` commands take the `full-suite` lock. |
| Two panes race for the last short slot | The slot count is checked inside the mutation guard (`MUTATION_GUARD_WAIT_MS`). One pane wins. The other gets the next slot or waits. |
| Ledger write fails | The lock change goes on. The ledger never blocks a lock change. |
| The swap refusal (G4g) applies | Both classes are refused before the lock is taken. A queued ticket is not cancelled. |

## 5. Build tasks

Write a failing regression test before each behavior change. Run only the changed test files with `--test-concurrency=2`. Run the full suite once in the integration worktree, as `AGENTS.md` says.

| Task | What | Files | Tests | Docs | Size |
| --- | --- | --- | --- | --- | --- |
| L0 | Add the 90th percentile of the wait and the median of the wait and the hold for each kind to `lockStats`. Show them on the Locks panel history line. No new lock behavior. | `src/kit/locks.js`, `public/app.js` | `test/locks.test.js`: percentile on an odd and an even count, one kind only, a window edge, skipped re-entrant lines | `docs/cli.md`, `docs/user-guide.md`, `HELP` in `public/app.js` | S |
| L1 | Policy keys under `locks.*` with defaults and range checks. Settings section. The switch is off. | `src/control.js`, `public/app.js` | `test/control.test.js`: defaults, ranges, `shortSlots` above `maxParallel` rejected. `test/server.test.js`: `PUT /api/policy` round trip | `docs/user-guide.md`, `HELP` | S |
| L2 | Slot module: read short holders, admit by the rule of section 2, write and free a slot record, mark stale, expire by TTL. No command yet. | `src/kit/lock-classes.js` (new), `src/kit/locks.js` (export helpers) | `test/lock-classes.test.js` (new): cap, `maxParallel`, drain when a long job waits, TTL expiry, dead PID, two racing acquires, a broken record | none yet | M |
| L3 | Commands `lock acquire short-check`, `lock release short-check`, and `short`. Fallback to `full-suite` when the switch is off. Reject a nested short job. Worker panes are allowed. | `src/kit/cli.js`, `src/kit/locks.js`, `src/kit/suite.js` | `test/lock-classes.test.js`: `short` runs beside a fake long holder, exit code 75, release on command failure, fallback with the switch off, nested refusal, worker pane rule. `test/suite.test.js`: V112 push token still reuses the push lock while a short holder runs | `docs/cli.md` | M |
| L4 | Ledger keys `class`, `longHolders`, `shortHolders`, `beside`, and the class statistics in `lockStats`. Old lines read as `long`. | `src/kit/locks.js` | `test/locks.test.js`: new keys on acquire and release, old lines, the medians skip re-entrant lines, `besideShare` | `docs/cli.md`, `docs/user-guide.md` (ledger section) | S |
| L5 | Locks panel: holder rows with class and slot, two queue groups, `Parallel now`, history line for each class. Engine reads both classes and adds them to `snap.locks`. | `src/engine.js`, `public/app.js`, `public/style.css` | `test/engine-locks.test.js`: `snap.locks` holds both classes. Project browser at 1280 and 393 px, light and dark, at most 6 screenshots | `docs/user-guide.md`, `HELP` | M |
| L6 | Kit text: browser checks and small tests use `herdr-boss short`. Full suites and pushes keep `suite` and `push`. Turn the switch on only after the Boss agrees. | `kit/` files through `herdr-boss kit install` | kit render test for the new lines | kit file | S |

### Order

1. L0 first. It needs no design decision and it shows the tail of the wait. Read its output after 7 more days of use.
2. Go or no go. Build L1 to L6 only when L0 shows that the 90th percentile of the wait for a short job kind is above 60 seconds, or that timeouts recur. If the tail is short, keep the plan and stop.
3. L1 and L2 next. They do not depend on each other. Merge L1 before L5, because both edit Settings or the panel in `public/app.js`.
4. L3 after L2. L4 after L3.
5. L5 after L3 and L4.
6. L6 last. The switch stays off until the Boss and the Owner agree.

L2 and L4 both edit `src/kit/locks.js`. Merge L2 before L4, or assign both to one worker.

## 6. Documentation

- Write in ASD-STE100. Update the docs in the same change as the behavior.
- `docs/cli.md`: the `short` command, `lock acquire short-check`, the admission rule in one paragraph, and the new ledger keys.
- `docs/user-guide.md`: a section "Lock classes" with the two classes, the five keys, and the failure rules. Update the Locks panel section and the ledger section.
- `HELP` in `public/app.js`: the Locks panel and the Locks settings.
- `README.md` stays unchanged.

## 7. Decisions taken in this plan

- The `full-suite` lock and its queue do not change. The short class is a separate lock name.
- A long job drains running short jobs and blocks new short admissions. Long jobs do not starve.
- One long job runs at a time. There is no second long slot.
- The class switch is off by default.
- L0 comes first, because the data of 7 days shows a short median wait and no tail.

## 8. Open points for the Boss

- Defaults `shortSlots` 2 and `maxParallel` 3 are a starting guess for a 10 core, 24 GB machine. Change them when L0 or the G4 samples show a different limit.
- Which jobs count as short is a convention in the kit text (L6). The lock code does not measure the load of a job.
- The Boss decides whether L0 alone is enough now.
