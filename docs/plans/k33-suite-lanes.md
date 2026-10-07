# K33: Suite lanes and the length of the HerdrBoss suite

Status: design note. This note changes no code. Each decision for the Owner is in the Decisions table at the end.

## Summary

- The HerdrBoss full suite holds the long lane of the `full-suite` lock for 15 to 25 minutes. This project holds the long lane for 61 percent of the time. The short lane waited 77 minutes in total over 16 acquisitions (Boss retro of 2026-10-07).
- The suite time is spread over many files. The ten slowest files are 66 percent of the measured file time. Each of them builds many git repositories, spawns the CLI, or builds a large engine fixture.
- Skipping a suite for a docs-only tree already exists as `suite --skip-docs`. It is off by default. No documented step in `AGENTS.md` uses it.
- The lock admits a short job only when no guard fails. The guard reads the machine load. A running suite raises the load. This is a likely cause of the short-lane wait. The ledger does not record the reason, so this note cannot prove it.
- Recommendation: first record the wait reason, then make the docs-only skip the default, then speed up the fixtures, then add a long-lane share cap. Do not split the suite into two lock holds until the first four slices show their effect.

## 1. Where the suite time goes

### Method

- Count: `test/` has 286 files named `*.test.js` and 301 files in total.
- Time: each of 61 files ran alone with `node --test --test-concurrency=2 <file>` in a temporary `HOME` and a temporary `HERDR_BOSS_DIR`. The 61 files are the 25 largest files, the 16 files that open a listening server, and 30 files that start a git repository. The set has overlaps.
- The full suite did not run, as the brief requires. The 226 files that were not timed are not in the figures below.
- The sum of the 61 measured file times is 578.6 seconds. The ten slowest files are 383.6 seconds of it.
- The machine was shared with other projects during the run. Use the figures as an order of magnitude.
- Per-test timing: three files ran with `--test-reporter=spec`. The test names and times are in the table of the slowest tests below.

### The ten slowest files

| Rank | File | Seconds | Tests | Notes |
| --- | --- | --- | --- | --- |
| 1 | `test/kit-worker-start-collect.test.js` | 54.0 | 97 | 46 calls to `setupFixture` (`test/helpers/kit-fixture.js:63`). Each call runs `git init`, two `git config`, `git add`, and `git commit` (`kit-fixture.js:52-60`). |
| 2 | `test/engine-context-handover.test.js` | 52.6 | 107 | No git. 0.5 second per test. The cause is not profiled. |
| 3 | `test/review-cli.test.js` | 51.0 | 53 | 6 spawns of `src/cli.js`. |
| 4 | `test/suite.test.js` | 42.3 | 95 | Git repositories, worktrees (`:727`), and real commits during a suite (`:1172`, `:1192`). |
| 5 | `test/handoff-activation-notices.test.js` | 41.5 | 17 | 2.4 seconds per test. The slowest test is 2.7 seconds (`:220`). One git init (`:231`). |
| 6 | `test/engine-handover.test.js` | 37.2 | 39 | No git. About 1 second per test. |
| 7 | `test/handoff-opencode-v2.test.js` | 30.7 | 5 | 6 seconds per test. Git and spawns. |
| 8 | `test/project-new-labels.test.js` | 24.8 | 15 | Git and 5 spawns. |
| 9 | `test/browser-pool.test.js` | 24.4 | 36 | No git, no spawn. The cause is not profiled. |
| 10 | `test/kit-config-worktrees.test.js` | 19.6 | 58 | 13 temporary folders. |

The slowest single tests in the three files that ran with the spec reporter:

| Seconds | Test |
| --- | --- |
| 6.25 | `worker collection warns only for stale or missing artifacts in explicitly done reports` (`kit-worker-start-collect.test.js:676`) |
| 2.70 | `a successive activation leaves earlier previous-role panes out of its worker peers` (`handoff-activation-notices.test.js:220`) |
| 2.70 | `worker collect --record refuses invalid reports and scopes without printing a success summary` |
| 2.01 | `worker collect keeps worktrees that are unmerged, disabled, live, or in use` |

### Files that start a server or a git repository

Counts come from a text search of the test files. A count is a lower bound, because a helper can start a server or a repository.

| Resource | Files | Evidence |
| --- | --- | --- |
| Opens a listening server (`.listen(`, `createServer`, `startServer`) | 16 | For example `test/review-api.test.js`, `test/browser-pool.test.js`, `test/mailbox.test.js`. |
| Runs `git init` or `git worktree add` | 50 | For example `test/suite.test.js`, `test/kit-worker-start-collect.test.js`. |
| Calls a helper that creates a repository (`setupFixture` or `temporaryRepo`) | 20 files, 174 call sites | `test/helpers/kit-fixture.js` is imported by 17 files. |
| Spawns a child process (`spawnSync`, `execFileSync`, `spawn`, `execSync`) | 125 | |
| Spawns `src/cli.js` | 141 call sites | |

Servers are cheap. The 16 server files measured between 0.7 and 10.5 seconds, 2.5 seconds on average, and only `test/browser-pool.test.js` (24.4 seconds) and `test/server.test.js` (10.5 seconds) are large. The git and spawn cost is the larger share.

### Measured cost of one git fixture

Five runs of the `temporaryRepo` steps (`git init`, two `git config`, write, `git add`, `git commit`) took 0.554 seconds in total, 111 ms for each repository. Five `cp -R` copies of a finished repository took 0.085 seconds, 17 ms for each copy. The difference is 94 ms for each fixture on an idle machine. The cost grows on a loaded machine because each step starts a process.

### Five proposed speed-ups

All gains are estimates. The basis is in the Basis column. Each slice ends with a new timing of the same files.

| # | Change | Files | Expected gain | Basis |
| --- | --- | --- | --- | --- |
| S1 | Build the seed repository once for each test process. Copy it with `fs.cpSync` in `temporaryRepo` and `setupFixture`. Keep a git-level test on the real `git init`. | `test/helpers/kit-fixture.js` and its 17 importers | 16 seconds or more on an idle machine; 40 seconds on a loaded machine | 174 call sites times 94 ms is 16 seconds. A call in a loop or in a `for` table runs more than once, so the real gain is higher. |
| S2 | Profile and fix the three slow engine files: `engine-context-handover`, `engine-handover`, `browser-pool`. Reuse one built engine object for tests that only read. | the three files | 20 to 40 seconds | Together they are 114 seconds for 182 tests. A reduction of 20 to 35 percent of the per-test cost is the target. The cause is not yet measured. |
| S3 | Run a command of the CLI in process in the tests that only check the printed result. Keep a real spawn in at most one test for each command group. | `test/review-cli.test.js`, `test/project-new-labels.test.js`, and others | 10 to 20 seconds | 141 spawn call sites. A Node start with the imports costs about 100 to 150 ms on this machine. |
| S4 | Find the 6-second test and the 2.7-second test, and split their set-up from their assertions. | `test/kit-worker-start-collect.test.js:676`, `test/handoff-activation-notices.test.js:220` | 8 to 15 seconds | The two tests are 9 seconds. A target of 3 seconds for both. |
| S5 | Raise the file concurrency of the suite from 2 to 4 when the machine load is low. `scripts/test.js:63` fixes `--test-concurrency=2`. Read the value from a setting, with 2 as the default. | `scripts/test.js` | Not measured. Measure the suite at concurrency 2 and 4 on an idle machine before the Owner decides. | The suite starts one process for each file. A higher value also raises the machine load. The guard of the short lane reads that load (see the wait cause above), so S5 can lengthen the short wait. |

The sum of S1 to S4 is 54 to 115 seconds out of the measured 578 seconds. This is 9 to 20 percent of the measured file time. S5 is the largest single gain. It trades suite time for machine load, so it needs the Owner decision D5.

The suite time of 15 to 25 minutes does not follow from the 578 seconds of the 61 files alone. The 226 untimed files are small. A suite on a loaded machine is slower than a sum of single runs, because two files share the CPU with other projects. This note does not claim a total. Slice 1 adds the real suite wall time per phase to the ledger, so that the next note can.

## 2. Suite runs that can be avoided

### Already in place

| Mechanism | Rule | Evidence |
| --- | --- | --- |
| Reuse of a pass for the same tree | `suite --reuse` and `HERDR_BOSS_SUITE_REUSE=1` reuse a pass with the same repository, tested hash, lockfile hashes, Node version, and command. The check runs before the lock is taken, so a reuse never waits. | `src/kit/suite.js:81-92`, `src/kit/suite-passes.js:64-96` |
| Skip of a changed-untested tree | A run without `--reuse` also skips when the tested hash is equal and only the tree differs. The default untested paths are `.worker/**` and `.orchestration/**`. | `src/kit/suite.js:88-91`, `src/kit/suite-passes.js:14` |
| Docs-only skip | `suite --skip-docs` skips the suite when every path that changed since the last pass is `LICENSE` or a `.md` file outside `src`, `public`, `test`, `tests`, `__tests__`, `spec`, `kit`, `bin`, `scripts`, and `.github`, and no test file or file under `src`, `test`, `public`, or `kit` reads it. It records a pass with `skipped: 'docs'`. | `src/kit/suite.js:96-111`, `src/kit/suite-passes.js:175-254` |
| Worker runs only changed test files | The worker brief limits a worker to changed test files. | worker brief, `AGENTS.md` |

### What does not yet avoid a run

1. `--skip-docs` is off by default. The release steps in `AGENTS.md` run `herdr-boss suite -- npm test` without it. The step 2 suite in the integration worktree therefore runs in full for a docs-only merge.
2. The skip needs an earlier pass for the same repository, lockfiles, Node version, and command. A pass of a different tree is enough (`findDocsOnlyBase`), so a branch after any recent pass qualifies.
3. The docs-only rule does not cover `docs/` files that are not Markdown. The docs folder of this project holds `docs/nav.json` (`docs/nav.json`) and images (`docs/images/`). These paths always start a full suite.
4. The suite lock record does not say that a run was skipped, so the Locks panel cannot count avoided runs. The pass file does (`skipped: 'docs'`).

### Proposed docs-only rule

The existing rule is safe, because it checks that no code reads the path. Keep it. The brief suggests "only files under `docs/` and `kit/CHANGES.md` changed". Do not use this rule as written, for two reasons:

- A test or a module can read a file under `docs/`. The helpers `test/helpers/user-visible-text.js` and `test/helpers/user-guide.js` suggest that some tests read doc text. The existing reader check finds a reader by name and path, so it handles this case.
- `kit/CHANGES.md` is read by `readKitChanges` and `kitChangesSince` (`src/kit/agents-check.js`), and `test/kit-worker-start-collect.test.js` imports them. A change to `kit/CHANGES.md` can change a test result. The existing rule keeps `kit/` out of the doc set for this reason.

Proposed rule, as an extension of the existing rule:

1. Keep `docsOnlyChange` unchanged for the path test.
2. Add `docs/nav.json` and `docs/images/**` to the doc set, but only when the reader check finds no reader. Apply the same reader check as for a Markdown file.
3. Run the skip by default in `herdr-boss suite` when the setting `suite.skipDocsDefault` is on. Keep `--skip-docs` as an explicit switch and add `--no-skip-docs` to force a full run.
4. Write the skip into the lock ledger as an `acquire` line with `reused: true` and `skipped: 'docs'`, so the Locks panel counts it.

The docs gate already exempts the doc paths (`scripts/docs-gate.config.json:1-25`). The gate is a different check. It does not decide whether a suite runs.

### Changed-files test selection for a worker tree

Workers already run only the changed test files. A selection for the integration suite is a different risk: a source change can break a test in another file. Do not add a selection for the integration or the `main` suite. For the worker tree, add one helper, `herdr-boss suite --changed`, that lists the test files that import a changed module. The helper reduces the worker's choice errors. It does not reduce the long lane time, because workers do not hold the long lane. Rank this option last.

## 3. Lock policy options

### Facts of the current lock

- The lock has two lanes. `locks.slots` is 2 by default: one long slot and one short slot. `locks.shortLimitMinutes` is 6 (`docs/cli.md`, section Locks).
- A job goes to the short lane when its predicted hold is at or below the limit. The prediction is the median of fewer than 10 holds, or the 90th percentile of the last 10 holds (`src/kit/lock-lanes.js:113-120`).
- A short job that starts beside a long job passes the machine guard first: load, swap, and free memory (`src/kit/locks.js:1062-1068`, `src/kit/lock-lanes.js:158-186`). The default maximum load is 231 percent of the cores. The default minimum free memory is 40 percent.
- A queue ticket of the long lane and a queue ticket of the short lane are separate FIFO lists (`chooseLockSlot`, `src/kit/lock-lanes.js:132-155`). No lane has an age or a share rule.
- A legacy ticket or holder without a lane sets the capacity to 1 (`lockAdmissionCapacity`, `src/kit/lock-lanes.js:124-127`). One legacy entry stops the short lane for all.
- The ledger line has `waitMs` and `holdMs`, the lane, and the project. It has no field for the reason of a wait (`src/kit/locks.js:785-798`). A wait that came from the guard is therefore not separable from a wait for the one short slot or for a legacy ticket.

### Likely cause of the short-lane wait

The suite of this project runs the CPU at a high load for 15 to 25 minutes. A short job that arrives then meets the guard. A load of 231 percent of the cores, or memory free below 40 percent, pauses it. The short lane waited 77 minutes in 16 acquisitions, 4.8 minutes on average. This is close to the short limit of 6 minutes. A job that is paused by the guard shows `waits: lane guard` in the Locks panel, but the ledger keeps nothing.

This is a hypothesis. Slice 1 turns it into a number. Do not change the lane policy before slice 1 reports its first week.

### Option A: cap on the long-lane share of one project

Rule: a project that held the long lane for more than `locks.longShareCapPercent` of the last `locks.longShareWindowHours` waits behind other projects' long tickets. The cap never blocks the only waiting ticket, so the lock never idles with a ticket in the queue.

| Item | Value |
| --- | --- |
| Effect on the figures | Does not change the suite length. Gives other projects' long jobs a turn after a share of 61 percent. The short lane wait does not change, because a short job is not blocked by a long ticket of another project. |
| Risk | A project that holds the cap waits while the lock is idle only if the rule counts an empty queue. The rule must skip the cap when no other long ticket waits. A cap can also delay an urgent release of this project. |
| Work | 3 slices: ledger read for the window (`readLockLedger`, `src/kit/locks.js:820`); a pure function `longShareExceeded` with tests; the admission change in `chooseLockSlot` with the Locks panel text and the settings table. |

### Option B: wait-age priority for the short lane

Rule: a short ticket that waited longer than `locks.shortMaxWaitMinutes` (default 5) may start without the machine guard of load and memory. The guard of swap stays on. The ticket records `guardOverride: true` in the ledger.

| Item | Value |
| --- | --- |
| Effect on the figures | Limits the short wait to the maximum wait plus the lock check. The average wait was 4.8 minutes, which is already below the default maximum of 5 minutes. A cap of 5 minutes therefore removes only the waits above 5 minutes, and the gain is not predictable from the retro figures. If the one short slot is the cause, the gain is zero. |
| Risk | A short job (under 6 minutes) starts beside a loaded suite. The job and the suite both slow down by the extra load. The suite can fail on a time-sensitive test that passed before. Mitigation: the swap guard stays on, and the maximum wait is a setting. |
| Work | 2 slices: the ledger field for the wait reason (needed first); the admission rule with tests and the settings table. |

### Option C: two lock holds of half the length

Rule: `herdr-boss suite` runs the test files in two groups. It takes the lock, runs group 1, releases, queues again, and runs group 2. The pass is recorded only when both groups pass on the same tree.

| Item | Value |
| --- | --- |
| Effect on the figures | Each hold is 7 to 12 minutes instead of 15 to 25. A hold is near the short limit of 6 minutes only if the suite is split in four parts. The halves therefore still go to the long lane. The long lane share of this project does not fall, because the total time stays the same. The gain is a gap in which the other long and short jobs can start. |
| Risk | The tree can change between the two holds. Both holds must run on the same tree hash and must check it again at the start of the second hold. A test that depends on another test file's side effect, or on a shared resource such as a port, fails in one half only. A pass in two halves is not the same as a pass as a whole: the halves do not catch an interaction between files of different halves. The suite already runs the files in separate processes, so the only shared state is the machine. The second hold can wait a long time in the queue, which makes the finish time of the suite longer. |
| Work | 4 slices: a deterministic file split by name hash; two-phase pass records; the tree check between the holds; the dashboard and docs. |

### Comparison

| Option | Long-lane share | Short wait | Suite finish time | Risk | Slices |
| --- | --- | --- | --- | --- | --- |
| A: share cap | Falls only with other long jobs waiting | No change | Longer for the capped project | Low | 3 |
| B: wait-age priority | No change | Falls if the guard is the cause | No change | Medium (load) | 2 |
| C: two holds | No change | Small | Longer | High (split and tree) | 4 |
| Suite speed-ups S1 to S5 | Falls by 9 to 20 percent, up to about 40 percent with S5 | Falls with the shorter hold | Shorter | Low, except S5 | 5 |
| Docs-only skip as default | Falls by the share of docs-only merges | Falls with it | Zero for the skipped run | Low | 2 |

## 4. Recommendation and slice list

Do the slices in this order. Each slice is small enough for one worker. A slice that changes behavior also changes the docs and the page help in the same branch.

| Slice | Task | Files | Setting or output |
| --- | --- | --- | --- |
| 1 | Record the reason of each wait in the ledger. Add `waitReason` to the `acquire` and `timeout` lines: `slot`, `guard`, `legacy`, or `queue`. Add the count for each reason to `lockLedgerStats` and to the Locks panel. Add the real wall time of the suite command to the `release` line as `holdMs` per phase when the command reports one. | `src/kit/locks.js`, `src/kit/lock-lanes.js`, Locks panel in `public/`, `docs/cli.md` | No setting. The panel shows the wait share per reason for the last 7 days. |
| 2 | Make the docs-only skip the default. Add the setting `suite.skipDocsDefault` and the switch `--no-skip-docs`. Write the skip into the ledger. | `src/kit/suite.js`, `src/kit/cli.js`, `src/kit/suite-passes.js`, `docs/cli.md`, `AGENTS.md` | `suite.skipDocsDefault`: when on, `herdr-boss suite` skips a suite for a tree that differs from the last pass only by docs that no code reads. Default: on. |
| 3 | Speed up S1: one seed repository for each test process, copied for each fixture. | `test/helpers/kit-fixture.js` | None. |
| 4 | Speed up S2 and S4: profile and fix the three engine files and the two slowest tests. | `test/engine-context-handover.test.js`, `test/engine-handover.test.js`, `test/browser-pool.test.js`, `test/kit-worker-start-collect.test.js`, `test/handoff-activation-notices.test.js` | None. |
| 5 | Speed up S3: run CLI commands in process in the tests that check only the output. | `test/review-cli.test.js`, `test/project-new-labels.test.js`, other tests with a spawn of `src/cli.js` | None. |
| 6 | Wait-age priority (Option B), only if slice 1 shows that the guard causes more than half of the short-lane wait. | `src/kit/locks.js`, `src/kit/lock-lanes.js`, `docs/cli.md` | `locks.shortMaxWaitMinutes`: the longest time a short job waits for the machine guard of load and memory. After this time the job starts. The swap guard still applies. Default: 5. Range: 1 to 60. |
| 7 | Long-lane share cap (Option A), only if slice 1 and 2 leave this project above 40 percent of the long lane. | `src/kit/locks.js`, `src/kit/lock-lanes.js`, `docs/cli.md` | `locks.longShareCapPercent`: the largest share of the long lane that one project holds in the window before it waits behind other projects. The cap does not apply when no other long job waits. Default: 50. Range: 10 to 100. `locks.longShareWindowHours`: the length of the window. Default: 24. |
| 8 | Test concurrency from a setting (S5), after the Owner accepts D5. | `scripts/test.js`, `docs/cli.md` | `suite.testConcurrency`: the number of test files that run at the same time. A higher value can end the suite sooner. It also loads the machine more, which can lengthen the wait of a short job. Default: 2. Range: 1 to 8. |

Do not build Option C (two lock holds) now. It has the highest risk and no effect on the share of this project. Reconsider it when slices 1 to 5 are live and the suite is still longer than 15 minutes.

Each setting in the list must be visible and settable in the dashboard, as `AGENTS.md` requires. Each one needs a row in the Locks or Suite table of `docs/cli.md` and an entry in `HELP` in `public/app.js`.

## Unverified and open points

- The total suite time is not measured. The brief forbids a full run in the worker worktree. The 226 untimed files are not in the figures.
- The cause of the short-lane wait is a hypothesis. The ledger has no wait reason (slice 1).
- The costs of the engine files and `browser-pool.test.js` are not profiled.
- The figures of the Boss retro (61 percent, 77 minutes, 16 acquisitions) come from the brief. The worker did not read the live ledger.
- The speed-up gains are estimates with a stated basis.

## Decisions

| ID | Decision | Accept | Deny |
| --- | --- | --- | --- |
| D1 | Make the docs-only skip the default (`suite.skipDocsDefault` on) and add the paths `docs/nav.json` and `docs/images/**` to the skippable set when no code reads them (slice 2). | [ ] Accept | [ ] Deny |
| D2 | Record the wait reason and the suite phase time in the lock ledger first (slice 1), and decide on lane rules after one week of data. | [ ] Accept | [ ] Deny |
| D3 | Run test speed-up slices 3 to 5 in parallel with the lock work. | [ ] Accept | [ ] Deny |
| D4 | Add the wait-age priority for the short lane (`locks.shortMaxWaitMinutes`, default 5) when slice 1 shows the guard as the main cause (slice 6). | [ ] Accept | [ ] Deny |
| D5 | Let the suite run with 4 test files at the same time when the machine load is low, controlled by `suite.testConcurrency` (slice 8). | [ ] Accept | [ ] Deny |
| D6 | Add a long-lane share cap for one project (`locks.longShareCapPercent`, default 50 percent over 24 hours) when this project stays above 40 percent after the other slices (slice 7). | [ ] Accept | [ ] Deny |
| D7 | Do not split the suite into two lock holds now (Option C). | [ ] Accept | [ ] Deny |
