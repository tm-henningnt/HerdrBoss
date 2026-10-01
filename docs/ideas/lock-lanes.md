# Plan: lock lanes by predicted duration

Status: decided on 2026-10-01 by the Owner, through the Boss. Build task LK2. This plan replaces the admission rule of `lock-classes.md`: the lane of a job comes from its predicted duration, not from its command.

## Problem

The `full-suite` lock admits one holder. Short jobs wait behind long jobs. Measured in the lock ledger over 48 hours:

| Job | Hold (median) | Wait (median or total) |
| --- | --- | --- |
| Stacked-variance suites | 0.4 min | wait median 5.7 min, total 231 min, longest 39.6 min |
| This project, suites | 4.2 min | wait total 217 min |
| Process-mining pushes | 0.6 min | wait total 127 min |
| Visualization suites | 20 min (longest 40) | - |
| Visualization pushes | 12.5 min | - |

A 0.4 min job waits 5.7 min at the median. The wait comes from 20 min jobs of another project. The machine had spare CPU during most of these waits (see `machine-samples.md`).

## Options that we rejected

1. **Raise the capacity to 2 for every job.** Two 20 min suites at once raise the load and the swap use. The Viz measurement (2 against 4 test files) showed an average load of 9.0 at 4 files with swap at 2.5 GB. Two long jobs together would pass the limits.
2. **A priority queue only (short jobs first).** The head of the queue still waits for a 20 to 40 min holder. The wait of a short job falls only when a holder ends.
3. **Stop or pause a long holder for a short job.** A suite that stops in the middle gives no result and may leave state behind. The lock never stops a holder that lives.
4. **One lock for each project.** The scarce resource is the CPU and the memory of the machine. A lock per project does not protect them.
5. **Classes by command (`suite` is long, `push` is short).** A process-mining push holds 0.6 min. A visualization push holds 12.5 min. The command does not predict the time. The project and the kind do.
6. **The caller states the duration.** A caller that estimates wrongly blocks the short lane. The ledger holds the truth.
7. **The earlier plan `lock-classes.md`** (short class for browser checks, `short-check` lock). It leaves suites and pushes in one queue. It does not remove the measured waits.

## Design

### Lanes and slots

- The setting `locks.slots` is the capacity of a machine lock. Default 2. Range 1 to 4.
- With `slots` 1, the lock works as today: one lane, one holder.
- With `slots` of 2 or more, the lock has a **long lane** with 1 holder and a **short lane** with `slots - 1` holders.
- Long jobs run one at a time among themselves. Short jobs may run beside one long job.
- A short job may take the long lane when it is free and no long job waits. A long job that arrives then waits for that short job, which ends within the short limit.
- The same code path serves every machine lock name (`MACHINE_LOCKS` in `src/kit/locks.js`: `full-suite`, and a build lock that uses it). A named project lock keeps one holder.

### Prediction and classification

- The key of a job is project, kind (`suite`, `push`, `manual`), and lock name.
- The predicted duration is the median `holdMs` of the last 10 releases for the key. The prediction ignores takeovers, re-entrant lines, and reused pushes. It uses only the last 14 days.
- A key with fewer than 3 samples has the lane `long` and the predicted duration `unknown`.
- A job is **short** when the predicted duration is at most `locks.shortLimitMinutes`. Default 6. Range 1 to 60.
- The record and the queue ticket keep `lane` and `predictedMs`. A record without `lane` is a long record.

### Queue order

- Each lane is a FIFO queue by ticket sequence. A short ticket never overtakes a long ticket in the long lane.
- A push of a tree that has a recorded pass takes no lock (reuse). This rule does not change, so such a push keeps priority over every waiting job.
- A suite that a push hook starts keeps the lane of the push (re-entrant rule, no second lock).

### Machine guard for the second job

- A short job that starts while a long job holds is a second job. The guard checks the latest machine samples: the 5-minute load as a percent of the cores, the swap in use as a percent of the swap total, and the free memory as a percent.
- The settings are `locks.guard.enabled` (default on), `locks.guard.maxLoadPercent`, `locks.guard.maxSwapPercent`, and `locks.guard.minFreeMemPercent`. The build task sets the defaults from the 7-day machine samples and records the values and the reason in the doc (the swap on this machine stays at a high percent without growth, so a swap limit must use a level above the normal level).
- When a limit is exceeded, the short job stays in its queue and the wait line says `short lane paused: <reason>`. It starts when the samples pass again.
- The guard does not apply when no long job holds. It never delays a long job.
- A stale sample (older than 3 minutes) or no sample counts as a pass.

The default limits come from the seven days of machine samples read on 2026-10-01. The script printed only percentiles.

| Setting | Default | Sample basis |
| --- | ---: | --- |
| `locks.guard.maxLoadPercent` | 231% | The 90th percentile of 5-minute load as a percent of cores was 230.5%. The limit rounds up. |
| `locks.guard.maxSwapPercent` | 96% | The median was 89.3% and the 90th percentile was 94%. The limit stays above the steady use and the measured 90th percentile. |
| `locks.guard.minFreeMemPercent` | 40% | The 10th percentile of free memory was 40%. The guard pauses only below this floor. |

### Display

- `lock list` prints for each holder and each ticket the lane, the slots in use, and the predicted duration.
- `lockStats` in `/api/state` adds the counts by lane and the median wait by lane.
- The Locks panel of the Agents page shows the two lanes with their holders, the queue of each lane, the predicted duration, and the guard state.
- Analytics: the chart of lock wait and hold shows wait and median wait by lane. The card shows saved slot capacity, slot use from the latest usable machine sample, and predicted hold per project and kind from the admission history. Each view states its scope. The historical short-job baseline is a follow-up.

### Settings, tests, and docs

- The Settings page gets a group **Locks** with the five settings above, with help text (`public/setting-help.js`) and the generated reference in `docs/cli.md`. The policy validator rejects out-of-range values.
- Tests use fake durations: injected `now`, ledger lines with `holdMs`, and machine sample lines. They cover classification, FIFO per lane, a short job beside a long job, two long jobs in sequence, the guard pause and release, the work-conserving rule, stale records, re-entry, push reuse, and `slots` 1.
- Docs and HELP change in the same change.

## Decisions

1. Default `slots` is 2, as the Owner decided.
2. The default short limit is 6 minutes: the median of this project's suites is 4.2 minutes and the Viz suites are 20 minutes.
3. An unknown key is long. This is the safe choice: an unknown job never runs beside a long job.
4. The earlier plan stays in the repository as a record. The build follows this plan.


## LK3 admission corrections

A capacity or guard change applies at each admission attempt, including a queued job. A queued ticket keeps its prediction, short-limit classification, and sequence. A short-limit change classifies new tickets. With one slot, all tickets use the exclusive long lane. After a capacity reduction, every existing holder still counts. New jobs wait until total capacity and slot capacity allow admission. The guard identifies a long job by its lane. A short job that borrows the long slot does not activate the guard. The guard reads the newest sample at or before the current time. A future sample cannot hide a current sample. A missing usable sample or one older than three minutes passes.

A live holder or queue ticket without a `lane` field is a legacy record. While any live legacy record exists, admission uses one exclusive long slot and one global FIFO queue. No short second job starts. Existing holders finish before another job starts. Normal lane admission returns after the legacy records drain. A suite hook can re-enter a legacy push with its live token. Old code cannot read a new short-slot record. An old hook cannot re-enter a push in that short slot. This old-code limit is accepted. Do not treat the long record filename as full protocol compatibility.

Release a lock from its owner pane. When exactly one live record belongs to the pane, no selector is needed. With several live records in that pane, use `lock release NAME --slot N` for a short slot or `lock release NAME --slot long` for the long slot. Automatic suite and push cleanup selects the exact record that the command acquired.

Herdr Boss publishes the queue sequence with an atomic rename. If a legacy writer left an invalid sequence, the next guarded write starts above the highest live ticket sequence. A valid sequence also remains a lower bound.

A blank guard field is invalid and shows a field error. A typed zero is valid. Process start identity and PID reuse remain a follow-up (R9).
