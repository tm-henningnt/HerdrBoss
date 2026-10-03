# Board state from facts

The published status holds the plan: task list, titles, order. The service computes the state of each card from facts. The overlay never writes the status file of the orchestrator.

## Fact sources

The sources are listed from the strongest to the weakest. The first source that applies decides the computed state.

1. **Commits on the base branch.** A commit that names the task id gives `done`. The card shows the short commit id.
2. **Worker records.** A live worker gives `doing`. A collected worker gives `review`. A collected worker whose branch is merged gives `done`.
3. **Issue tracker.** A closed issue gives `done`. An open issue on a card that is published as `done` gives `doing` when a worker is live, and `todo` otherwise.
4. **Review packs.** BD2a does not use review packs. The review pack item has no task link field today. A later task can add this source.
5. **Published status.** A card without a fact keeps its published state.

A live worker that started after the newest commit of the task overrides the commit. The task is in rework and the computed state is `doing`.

A worker fact does not change a published `blocked` card. The card keeps `blocked` in `computedState` and keeps the worker as its source. A commit that names the task ID, or a closed issue, can still set a blocked card to `done`.

## What counts as a commit fact

The service reads `git log` of the base branch of the project. The base branch is `baseBranch` of the project config, `main` by default. It reads at most the newest 1000 commits. A branch name that starts with `-` is refused. The branch follows `--end-of-options` in the git command.

A commit names a task id only in one of these forms. The match ignores case. The id is a whole token. No letter or digit can come directly before or after it.

- A merge commit: the id is a whole token in the merged branch name, for example `Merge branch 'w222-fix'` or `sv-b68`. The target branch of the merge does not count.
- A non-merge commit subject ends with the id in parentheses, for example `Add parser (#68)` or `Finish BD2a (BD2a)`.
- A non-merge commit subject or body has `Closes`, `Fixes` or `Resolves` before the id, for example `Closes #12` or `Fixes G4`.
- A non-merge commit subject starts with the whole id and a colon, for example `BD2a: card state`.

An id that is only digits needs `#` in every form. A bare mention does not count. A word prefix such as `docs:`, `test:`, `chore:` or `Record` does not name a task. `docs: record G4 machine samples` does not make G4 done. `G4a:` does not name G4, and `G4:` does not name G4h. `refs #12` and `WIP for #12` do not make a card done.

A commit that names the worker name or the worker branch of a worker with that task id counts for that task, in the same forms. The worker records give the mapping (`worker start --task-id`).

The newest matching commit is the fact of the card.

## Overlay data shape

The service adds these fields to each task of `GET /api/projects/<slug>`. The existing overlay fields (`state`, `stateSource`, `worker`, `publishedStatus`) stay.

| Field | Value |
| --- | --- |
| `computedState` | `todo`, `doing`, `review`, `done`, `stuck`, or `blocked` when a worker fact applies to a published blocked card. |
| `publishedState` | The `status` of the published card: `todo`, `doing`, `review`, `blocked` or `done`. |
| `source` | `{ kind, ref, at }` or `null`. |
| `source.kind` | `commit`, `worker` or `issue`. The value `review` is reserved for a later task. |
| `source.ref` | The short commit id, the worker name, or the issue number. |
| `source.at` | The time of the fact as an ISO string, or `null`. |
| `diverges` | `true` when the computed state differs from the published state. |
| `stuck` | `{ reason, ageMin }` when `computedState` is `stuck`, otherwise `null`. |

`source` is `null` when the card has no fact. The computed state then equals the published state, except that `blocked` and `ready` compare as `todo`.

`state` is the board column. It takes the computed result: `done`, `doing` or `review` from a fact, and `blocked` or `ready` from the dependencies for a `todo` card. A stuck card keeps `state` `doing`. The page puts a card with `computedState` `stuck` in the Stuck lane.

## Stuck rule

A card is stuck when all of these are true:

1. The computed state is `doing`.
2. No worker with this task id is live.
3. The last activity is 3 hours old or older.

The last activity is the newest of: the `updated` time of the card, the newest commit that names the task, and the start, collect and finish times of the workers of the task. A card with none of these uses the publish time of the project.

The reason text is `no live worker and no commit for N hours`. The age is in whole minutes in `stuck.ageMin`.

## Divergence rule

A card diverges when the computed state differs from the published state and the card has a fact. These pairs compare equal: `blocked` and `todo`, and `stuck` and `doing`. A stuck card does not count as a divergence.

The project list row has `boardDiverged`: the number of diverged cards. `boardStuck` is the number of stuck cards. `GET /api/projects/<slug>` has the same two counts and the ids in `boardDivergedIds`.

## Badges on the cards

The project board and the Board page show these items on a card. Both pages use the same text from `public/board.js` (`cardFacts`).

- A card with a `source` shows an `auto` badge and the fact. The fact is the short commit id, the worker name, or `#` and the issue number. The title of the fact has the long text, for example `merged abc1234 3 hours ago`.
- A card with `diverges` `true` also shows both states and the fact: `published: doing, computed: done, merged abc1234 3 hours ago`. A worker fact reads `worker NAME`. An issue fact reads `issue #12`.
- A card without a `source` shows no badge. A card from a service without the board fields shows no badge.
- The project page shows one line above the board when `boardDiverged` is greater than 0: `N cards differ from git: <ids>. Publish the status with --sync.` The swimlane of the project on the Board page shows the count.
- The counts, the flow columns and the progress bar use the computed state. A stuck card counts as doing in the progress bar.

A card done by a commit counts for the Done column of the Board page from the time of the commit, also when its `updated` time is older or missing.

## Stuck lane

A card with `computedState` `stuck` shows in the Stuck lane. The lane sits between Doing and Review. It shows only while a card is stuck. The card shows the reason and the age: `no live worker and no commit for 3 hours. Last activity 3 h 10 min ago.` The oldest card comes first. On a phone the lane is one more tab in the tab bar. The tab keeps the 48 px height. A saved Stuck tab opens another tab when no card is stuck.

## Digest

The engine checks each project at each tick. It keeps the time when the project first had a divergence. The time restarts when the divergence ends. A paused or stood-down project has no digest and no clock.

1. After more than 30 minutes of divergence, the engine sends the project orchestrator one line: `N cards differ from git: <ids>. Publish the status with --sync.` The line lists at most 10 ids. The line joins the info digest of the pane, so it goes at most once in each 2-hour interval for each project. A working orchestrator receives it when it is idle or done. The engine sends no line when a worker of the project runs and the orchestrator had no turn since the last line.
2. After 3 hours of divergence, the engine sends the Boss one notice for that divergence period.

The engine finds the orchestrator pane in the live Herdr pane list at each tick, by the workspace of the project and the label `orch`. It does not keep a pane id. The once-each-hour record belongs to the project, so a pane id change does not send the line again. The code is in `src/board-digest.js`. The stuck state does not count as a divergence, so it sends no digest.

## Publish with sync

`herdr-boss publish SLUG FILE --sync` reads the same facts as the service: git log of the base branch, the worker records and the issue tracker. It sets `status` of each card that diverges to its computed state before it installs the status. A stuck card gets `doing`. It prints one line with the number of cards that changed. It prints one `sync:` line for each changed card on standard error. A commit fact adds its short id and the first 60 characters of its subject: `sync: G4 doing -> done (abc1234: G4: record samples)`. A card without a fact keeps its status. The `--force` check for a live worker runs after the sync. Without `--sync` the status stays as the file has it. The code is in `src/board-sync.js`.

## Cache

- Git: the service reads `git log` of each registered project at most once each minute. The read is asynchronous, so no tick and no request waits for git. It runs `git -C <repo> log` with a 5 second timeout and without a shell. It never runs a git command that writes. The overlay uses the last answer.
- Issues: the service runs `gh issue list --state all --json number,state,closedAt` read-only in the repository, at most once each 10 minutes for each project. The run is asynchronous. The overlay uses the last answer.
- A project without a repository path, a repository that git cannot read, or a failed `gh` call gives no fact of that kind. The card keeps the state from the other sources and the published state.

## Decisions

- One `gh issue list` replaces one `gh issue view` for each task. One call for each project is the smaller load and it also finds a reopened issue on a done card.
- The issue number of a card is the number in `tasks[].url` (`.../issues/<n>`). A card without such a URL uses its id when the id is only digits.
- A published `done` card stays `done` against worker facts. Only a live worker started after the done commit, or an open issue, reopens it.
- A commit wins over an open issue. A merged commit that names the task means the work is on the base branch.
- The stuck state is not a divergence, so the digest does not send for it.
- Analytics holds no task counts from the published state. The state API and the board counts use `state`, which holds the computed result.
- The digest, the Boss notice and `publish --sync` are in the sections above. The kit text tells orchestrators to publish with `--sync` at task boundaries.
