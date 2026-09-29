# Plan: machine samples and a swap guard

Status: planned on 2026-09-29. Plan only. Build nothing until the Boss says go. Source: the G4 line in `docs/orchestration/memory.md`, the test guard analysis of 2026-09-29, and the lock ledger of G0 (`src/kit/locks.js`).

## Goal

The engine records the state of the machine once a minute. Analytics shows the hours of the day with machine overload beside the hours in which suite requests waited while the CPU was idle. The data then gives thresholds for one swap-based warning and one swap-based refusal. The CPU and load guard stays as it is. It is off.

## What exists now

- `collectMachine()` in `src/collect.js` returns the 1, 5, and 15 minute load, `memFreePercent`, `swapUsedMB`, `swapTotalMB`, and `cpus` on each engine tick. The tick runs every `tickSeconds` (30).
- The engine keeps only the last 240 load and memory points in memory (`this.memory.history`). It stores no history on disk.
- `snap.machine.cpuTotalSample` holds the summed CPU of all processes. `machineLimits()` in `src/control.js` turns it into `cpuPercent`.
- `readMachineLocks()` and `readLockQueue()` in `src/kit/locks.js` give the live holders and the waiters of the `full-suite` lock. The engine already calls both on each tick.
- The lock ledger (`lock-ledger.jsonl`) has one line for each acquire and release, with `waitMs` and `holdMs`.
- `rules.machine` (written by the engine into `rules.json`) is the object that `describeMachine()` and `loadWarning()` in `src/kit/workers.js` read. `worker start` refuses on it.
- Swap has no threshold today. `rules.js` warns only on `memFreePercent`.

## 1. The sample file

### Name and place

`machine-samples.jsonl` in the data directory (`HERDR_BOSS_DIR`). The rotated file is `machine-samples.1.jsonl`. Both files use mode 0600.

### Line format

One JSON object on each line. The keys are short to keep the file small.

```json
{"at":"2026-09-29T14:03:00.000Z","l1":2.4,"l5":3.1,"l15":2.8,"cpus":10,"cpu":41.2,"memFree":18,"memGB":24,"swapMB":3200,"swapTotalMB":4096,"holders":["suite"],"waiters":1,"waiterKinds":["push"]}
```

| Key | Meaning | Source |
| --- | --- | --- |
| `at` | Sample time, UTC ISO string, cut to the whole minute | tick time |
| `l1`, `l5`, `l15` | Load averages | `machine.load` |
| `cpus` | Core count | `machine.cpus` |
| `cpu` | Summed process CPU in percent of all cores, one decimal | `machine.cpuTotalSample / cpus` |
| `memFree` | Free memory in percent (`memory_pressure`) | `machine.memFreePercent` |
| `memGB` | Total memory | `machine.memTotalGB` |
| `swapMB`, `swapTotalMB` | Swap used and swap total | `machine.swapUsedMB`, `machine.swapTotalMB` |
| `holders` | Kinds (`suite`, `push`, `manual`) of live `full-suite` holders | `snap.locks` |
| `waiters` | Number of live tickets in the `full-suite` queue | `readLockQueue()` |
| `waiterKinds` | Kinds of those tickets | `readLockQueue()` |

A field that the collector cannot read is `null`. The line holds no project name, pane id, path, or command. Kinds and counts only.

The swap total on macOS grows with use. A swap total of 2 GB with 1.9 GB used is 95% full and harmless. All swap rules in this plan therefore test the percent of swap and a minimum swap use in GB together.

### Size and rotation

A line has about 230 bytes. One day holds 1440 lines, about 330 KB. Rotate at 3 MB, about 9 days: rename the file to `machine-samples.1.jsonl` and replace an older rotated file. Two files hold about 18 days. The Analytics window is 14 days. Use the same rename pattern as `appendLockLedger()`.

A write failure never stops a tick. Catch the error and go on.

### Where the engine writes it

In `Engine.tick()` in `src/engine.js`, directly after `snap.machine.limits = machineLimits(...)` (about line 735). At that point the machine, the CPU sum, `snap.locks`, and the queue are all known. The queue must be kept in a local variable, because the current code reads it inside a `try` block above.

Rules for the write:

1. Write only when `machine` is not null and `this.act` is true.
2. Write at most one line for each UTC minute. Keep `this.memory.lastSampleMinute`. Write when `Math.floor(now / 60000)` differs from it. The 30 second tick then gives one line each minute, and a slow tick leaves a gap. A gap is not filled.
3. Use `this.lockDataDir` as the folder, as the lock ledger does.
4. Do the write with `fs.appendFileSync`. The line is small and the tick already runs file reads.

## 2. Analytics: hours of overload and hours of idle waiting

### Definitions

- Overload minute: a sample with `swapMB / swapTotalMB > 0.90` and `swapMB >= 1024`, or with `l5 > 3 * cpus`.
- Idle-wait minute: a sample with `waiters > 0` and `cpu < 50`. The queue waited and the CPU was not the reason.
- Hour: the hour of the day, 0 to 23, in the local time zone of the machine.

### Data shape

New endpoint `GET /api/machine-hours?days=14` in `src/server.js`. It returns:

```json
{
  "days": 14,
  "daysWithData": 9,
  "hours": [
    { "hour": 0, "samples": 540, "overloadMin": 0, "idleWaitMin": 0, "swapPeakPct": 41, "memFreeMin": 33 }
  ],
  "totals": { "samples": 12100, "overloadMin": 310, "idleWaitMin": 95 },
  "coverage": 0.62
}
```

- `overloadMin` and `idleWaitMin` are the sample counts, which equal minutes.
- `samples` is the count of samples in that hour of the day over all days. A minute with no sample is missing data, not a quiet minute.
- `coverage` is `samples / (days * 1440)`. Analytics shows a note when it is below 0.5.
- The endpoint reads both files, drops lines older than the window, and skips a line that does not parse.

### Chart

A block "Machine load by hour of day" below `denialsBlock` in `analyticsView()` in `public/app.js`. Use inline SVG with no library.

- X axis: the 24 hours. Y axis: the mean minutes per hour of day, 0 to 60, that is `overloadMin / daysWithData`.
- Two bars for each hour. Bar one: overload minutes. Bar two: idle-wait minutes. Use two colors from the existing palette and a legend.
- A title on each bar shows the hour, the two values, and the sample count.
- An hour with fewer than 10 samples is drawn with a hatched fill.
- A table with the same 24 rows sits in a `<details>` element below the chart. It is the text alternative.
- On a phone (393 px) the chart scrolls sideways inside its block. The page does not scroll sideways.

### The query

The endpoint runs one pass over the samples:

1. Read the lines in the window. Ignore a line without a valid `at`.
2. Compute the local hour of each line.
3. For each line, add 1 to `samples[hour]`. Add 1 to `overloadMin[hour]` for an overload minute. Add 1 to `idleWaitMin[hour]` for an idle-wait minute.
4. Count the distinct local dates to get `daysWithData`.

Cross-check with the lock ledger. The sum of `waitMs` of the acquire lines in the window, divided by 60000, must be at most the number of sample lines with `waiters > 0` plus 15 percent. A test uses a fixture of both files.

## 3. Thresholds from the data

### Method

Memory and swap are the main signal. The CPU and load figures are recorded only to show that they predict less.

A new command `herdr-boss machine thresholds [--days N]` reads the samples and prints a table. It runs offline and writes nothing.

1. Require at least 7 days of data and a coverage of at least 0.5. Otherwise print "not enough data" and the counts.
2. Mark each sample as slow when `waiters > 0` and `cpu < 50`.
3. For each candidate rule, compute two shares: the share of all samples that the rule flags, and the share of slow samples that the rule flags.
4. The candidate rules are swap percent at 60 to 99 in steps of 5 (with the 1 GB floor), `memFree` at 5 to 30 in steps of 5, and `l5 / cpus` at 1 to 4 in steps of 0.5.
5. Propose the warning at the lowest swap percent that flags at most 10% of all samples and at least 50% of the slow samples.
6. Propose the refusal at the lowest swap percent that flags at most 2% of all samples.
7. Print the same table for `memFree` and load, so the Owner can see that they capture less of the slow minutes than swap. If swap does not capture more than load, print "no swap signal" and propose no change.

### Starting values before the data exists

These values ship as the defaults. The command above replaces them with measured values.

| Setting | Default | Meaning |
| --- | --- | --- |
| `machine.swapWarnPercent` | 80 | Warn when swap is at or above this percent for 3 samples in a row |
| `machine.swapRefusePercent` | 95 | Refuse new workers and suites at or above this percent |
| `machine.swapMinUsedGB` | 2 | Both rules need at least this much swap in use |

Set a percent to `null` to switch its rule off. A rule clears when swap is 5 points below its threshold. This gives the rule a hysteresis and stops a flapping notice.

### Warning

`rules.js` adds an alert with key `machine:swap`, severity `warn`. The title is "Swap high: N% used". The text tells the reader to close finished workers and their browsers and to start no new browser or test workers. The alert uses the existing cooldown (`alertCooldownSeconds`) and the existing notice path. It does not depend on `guardEnabled`.

### Refusal

The refusal applies when swap is at or above `swapRefusePercent` and at least `swapMinUsedGB` in use. It does not depend on `guardEnabled`. It has no `--force` bypass, as the CPU limit has none.

- `worker start` refuses, as `loadWarning()` does today.
- `herdr-boss suite` refuses before it takes the lock, unless `--reuse` finds a pass. A reused pass runs no test.
- `herdr-boss push` refuses before it queues when the repository has a pre-push hook that runs a suite. A push without such a hook is not blocked.
- A ticket that is already in the queue is not cancelled.

The refusal message names the swap percent, the swap use, the threshold, and the setting name.

The CLI reads swap from `rules.json`. The engine adds `swapPercent`, `swapUsedGB`, `swapWarnPercent`, `swapRefusePercent`, `swapMinUsedGB`, and `swapRefusing` to `snap.machine.limits`, which is what the rules file already carries as `machine`. `rules.json` is at most 10 minutes old (`rulesWarning`). When the file is older, the refusal does not apply, and the command prints the existing stale-rules warning.

## 4. Build tasks

Write a failing regression test before each behavior change. Run only the changed test files with `--test-concurrency=2`. Run the full suite once in the integration worktree, as `AGENTS.md` says.

| Task | What | Files | Tests | Docs | Size |
| --- | --- | --- | --- | --- | --- |
| G4a | Sample module: `sampleLine()`, `appendMachineSample()` with rotation, `readMachineSamples({ sinceMs })`. No engine change. | `src/machine-samples.js` (new) | `test/machine-samples.test.js`: line format, `null` fields, rotation above 3 MB, a broken line is skipped, a write failure does not throw | none yet | S |
| G4b | Engine writes one line for each minute after `machineLimits()`. Keep the queue in a local variable. | `src/engine.js` | `test/engine-machine-samples.test.js`: two ticks in one minute write one line, a tick with no machine writes none, `act` false writes none, holder and waiter kinds appear | none yet | S |
| G4c | Hourly summary and the endpoint `GET /api/machine-hours`. Include the ledger cross-check in the tests. | `src/machine-samples.js`, `src/server.js` | `test/machine-samples.test.js` (summary), `test/server.test.js` (endpoint, `days` limits, read-only preview allows GET) | `docs/cli.md` is not affected | M |
| G4d | Analytics block with the SVG chart, the `<details>` table, the low-coverage note, and the phone layout. Add `/api/machine-hours` to the state fetch list. | `public/app.js`, `public/style.css` | `test/server.test.js`: page serves; check in the project browser at 1280 and 393 px, light and dark, at most 6 screenshots | `HELP` text for Analytics in `public/app.js`, `docs/user-guide.md` | M |
| G4e | Policy settings `swapWarnPercent`, `swapRefusePercent`, `swapMinUsedGB` in `POLICY_DEFAULTS`, `validatePolicy()`, and `machineLimits()`. Show and edit them in the Machine section of Settings. | `src/control.js`, `public/app.js` | `test/control.test.js`: defaults, range checks (percent 1 to 100 or `null`, GB 0 to 1024), the floor, hysteresis. `test/server.test.js`: `PUT /api/policy` round trip | Settings help in `public/app.js`, `docs/user-guide.md` | M |
| G4f | Swap warning alert `machine:swap` with 3-sample confirmation. | `src/rules.js`, `src/engine.js` (keep the last 3 swap values in `this.memory`) | `test/machine-swap.test.js` (new): no alert on 2 samples, alert on 3, clear at 5 points below, floor blocks a small swap total, `guardEnabled: false` does not stop it | `docs/user-guide.md` | S |
| G4g | Swap refusal in `worker start`, `suite`, and `push`. Shared helper `swapRefusal(rules)` in a new module that both `workers.js` and `suite.js` import, so `suite.js` does not import `workers.js`. | `src/kit/swap-guard.js` (new), `src/kit/workers.js`, `src/kit/suite.js`, `src/kit/locks.js` (`pushWithLock`) | `test/machine-swap.test.js`: `worker start` refuses and `--force` does not bypass, `suite` refuses, `suite --reuse` with a pass still returns 0, `push` refuses only with a suite hook, a stale `rules.json` does not refuse, `null` threshold switches the rule off | `docs/cli.md`, `docs/user-guide.md` | M |
| G4h | `herdr-boss machine thresholds [--days N]` prints the proposal table. | `src/kit/cli.js`, `src/machine-samples.js` (`proposeThresholds()`) | `test/machine-samples.test.js`: not enough data, a fixture where swap flags the slow minutes, a fixture with no swap signal, exact table rows | `docs/cli.md` | M |

### Order

1. G4a, then G4b. Release them first. The file needs several days of data before G4h has a result.
2. G4c and G4d next. They can run while data collects.
3. G4e, G4f, and G4g after that. They do not need data. Keep the default values in the table above.
4. G4h last. Run it after 7 days of samples. Then set the values in `policy.json` from its output, and record the Owner decision in `docs/orchestration/memory.md`.

G4a to G4c are independent of G4e to G4g. Two workers can run them in parallel, because the file sets do not overlap except `public/app.js` (G4d, G4e) and `src/engine.js` (G4b, G4f). Merge G4b before G4f, and G4d before G4e.

### Documentation

- Write in ASD-STE100. Update the docs in the same change as the behavior.
- `docs/user-guide.md`: a section "Machine samples" with the file names, the line fields, the rotation, and the two definitions above. A section "Swap guard" with the three settings, the warning, and the refusal.
- `docs/cli.md`: `herdr-boss machine thresholds`, and the swap refusal for `worker start`, `suite`, and `push`.
- Dashboard help (`HELP` in `public/app.js`): the new Analytics block and the three settings.
- `README.md` stays unchanged.

## 5. Decisions taken in this plan

- The sample runs inside the engine tick with a minute bucket. It adds no timer and no process.
- Overload uses the 5-minute load, not the 1-minute load, because the 1-minute load spikes for a few seconds during a normal test run.
- The swap rules include a floor in GB, because the macOS swap total is not fixed.
- The swap warning and refusal are independent of `guardEnabled`. The CPU and load rules stay under the guard switch.
- The refusal has no `--force` bypass.

## 6. Open points for the Boss

- The default values 80, 95, and 2 GB are a starting guess. G4h replaces them after 7 days.
- On this machine (10 cores, 24 GB) a 2 GB floor is 8% of memory. Change it in G4e when the Owner wants another floor.
- `herdr-boss machine thresholds` prints a proposal only. The Owner or the Boss sets the values.
