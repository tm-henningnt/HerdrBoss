# Lock wait survey and changes

This note records why the machine-wide `full-suite` lock cost much time on 2026-09-30 (UTC). It lists the causes, the decisions, and the method to measure the result. Project names are replaced by letters.

## Sources

- `lock-ledger.jsonl` in the data directory, read only. One `acquire` line holds `waitMs`. One `release` line holds `holdMs`. A line has `kind`, `project`, `pane`, and `tree`.
- `suite-passes.json` in the data directory, read only. 74 records at the time of the survey.
- `src/kit/suite.js`, `src/kit/locks.js`, and the new `src/kit/suite-passes.js`.

## What the ledger shows

Figures are minutes. The day is 2026-09-30 UTC. The first table is the state at the time of the task brief. The totals of that state: hold 574, wait 180.

| Project | Kind | Runs | Wait | Hold | Note |
| --- | --- | --- | --- | --- | --- |
| A | suite | 14 | - | 206 | About 15 each. Three of them ran inside a push. |
| A | push | 5 | 7 | 50 | About 10 each. The hook ran the suite again. |
| B (paused) | suite | 11 | 40 | 115 | |
| B (paused) | push | 10 | 30 | 12 | 35 more minutes in one timeout. |
| This project | suite | 42 | 48 | 188 | About 4.5 each. |
| C | suite | 6 | 22 | 2 | Short runs that waited long. |

The hold total of 574 counts 50 minutes twice. A re-entrant suite runs inside the hold of its push. The hold without the nested runs is 524.

At the end of the survey (19:44 UTC) the day held these totals: wait 238 (acquire lines) plus 65 in timeouts, hold 557 without nested runs.

## Causes

### 1. A push runs a suite when the tree already passed

The code shows three separate costs.

1. `pushWithLock` took the lock before it looked for a pass. A push with a reusable pass still waited in the queue behind every suite. Project B pushes held the lock for seconds and waited 30 minutes in total.
2. The pass key is the Git common directory, the tree hash, the hash of each root lockfile on disk, the Node version, and the exact command. The key has no worktree path and no commit hash. A merge commit has the same key as the tested tree when the trees are equal. A fast-forward merge keeps the commit. Tests in `test/suite.test.js` prove both cases.
3. A pass exists only for a clean tree. `git status --porcelain` must be empty before and after the run. An untracked scratch file blocks both the pass and the reuse.

Exact miss reasons that the ledger shows:

- Project B (paused): 11 of 11 push lines have no tree hash. The worktree was not clean at each push, so no pass could exist or match. The ledger does not say which file was dirty.
- Project A: 2 of 5 push lines have no tree hash. The other 3 pushes ran the suite again inside the hook (`reentrant` suite lines of 12 to 23 minutes). For those trees no earlier pass exists in `suite-passes.json`. The hook run was the first and only run of the tree. The push did not repeat work. The earlier suite runs of project A were for other trees, because a fix commit came between them.
- A pass of one command never matches another command. The pass file holds three different commands for three repositories.
- This project: 3 of 12 suite lines have no tree hash, for the same reason as project B.
- The pass file has no time limit and holds the last 200 records. Staleness is not a cause. The Node version was the same for all 74 records.

The push cannot know the command of the hook. The new code solves this: a push sets `HERDR_BOSS_PUSH_SUITES` to a temporary file. Each `herdr-boss suite` in the hook adds its command to that file. The push stores the commands in `push-hooks.json` for the repository. The next push looks for a pass of each stored command.

### 2. Suite runs of this project

The 42 runs take 4.5 minutes each. The orchestrator ran a full suite after each merge and again on `main`. A suite that differs from a passed tree only in `.worker/` or `.orchestration/` files repeated the whole run.

### 3. Queue order

The queue is FIFO by ticket number. A waiter that holds a ticket is never passed by a later ticket. No priority exists, so no job starves.

## Decisions

1. A push with a reusable pass takes no lock. It writes a ledger pair of kind `push` with `reused: true`, `waitMs: 0`, and `holdMs: 0`. The pair keeps the ledger complete. Statistics count it in `reusedPushes` only.
2. A push without a reusable pass takes the lock as before. The re-entrant rule, the takeover rules, and the ticket order do not change. The hook suite runs inside the push lock. The push does not take a second lock.
3. The pass key uses a tested hash. It is a hash over `git ls-tree -r HEAD` (mode, object, path) without the files that match `suiteUntested`. The list of globs is part of the hash. A changed list never matches an older pass.
4. The default of `suiteUntested` is `.worker/**` and `.orchestration/**`. A project adds globs in `.herdr-boss.json`. The rule is: list a path only when no test reads it. Documentation in `docs/` is tested, because the settings reference test and the docs tests read it. When in doubt, do not list the path.
5. A changed or untracked file that matches `suiteUntested` does not make the tree dirty.
6. `suite` without `--reuse` still runs a tree that has a pass, so a rerun stays possible. It skips the run when the pass has another tree and the same tested hash.
7. A record from before this change has no tested hash. It matches only its own tree.
8. FIFO rule: a reused push skips the queue. A push without a pass keeps its ticket order among suites. A push that waits does not look again for a pass. This is not built, because the first check removes most cases.

Proposal for the orchestrator (not written to `memory.md`): run one full suite for each batch of merges in the integration worktree, not one for each merge. Run `herdr-boss suite --reuse` on `main` after the fast-forward. Run `herdr-boss push` last. The push then finds the pass of the same tree and takes no lock.

Proposal for this repository: add `README.md`, `PRODUCT.md`, and `.impeccable/**` to `suiteUntested` in `.herdr-boss.json`. No test of this repository reads them. The file is outside the worker edit scope.

## Parallelism of the suite

The measurement was not run. Two tickets were in the lock queue of another project, and swap was 14.9 of 16 GB with a load average of 12 on 10 cores. The brief forbids a measurement while another project waits. The default stays at 2 files at a time.

To measure later, with an empty queue, run each command once from the worktree:

1. `herdr-boss suite -- node --test --test-concurrency=2 test/`
2. `herdr-boss suite -- node --test --test-concurrency=3 test/`
3. `herdr-boss suite -- node --test --test-concurrency=4 test/`

Record `uptime` and `sysctl vm.swapusage` before and after each run, and the wall time. Do not raise the default unless the swap stays flat.

## Expected result

These figures are estimates, not measurements.

- Project B pushes: up to 30 minutes of wait and 12 minutes of hold, when a pass exists for the tree. The first push after a hook change still locks. The 11 dirty trees only count when the dirt was in `.worker/` or `.orchestration/`.
- Project A pushes: no gain unless the suite runs on the tree before the push. With the batch rule the hook suite is a reuse. The possible gain is up to 50 minutes of hold a day.
- This project: the batch rule cuts about half of the 42 runs, about 90 minutes of hold. The untested-path rule removes reruns after report-only commits.

## How to measure the result next week

1. Open Analytics, the card "Lock wait and hold". Read the wait and hold for 2026-10-07 and the six days before it. Compare them with 2026-09-30: wait 180 to 238, hold 524 to 557.
2. Count the pushes that reused a pass: lines with `"reused":true` and `"kind":"push"` in `lock-ledger.jsonl`. The count is also in `reusedPushes` of the lock summary.
3. Count the suite runs of this project for each day. Divide the hold by the runs.
4. Count the `timeout` lines. The day of the survey has two, 30 and 35 minutes.

## Not changed

- The lock queue code, the takeover rules, and the re-entry token.
- The default parallelism of `npm test`.
- `memory.md`.
