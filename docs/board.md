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

## What counts as a commit fact

The service reads `git log` of the base branch of the project. The base branch is `baseBranch` of the project config, `main` by default. It reads at most the newest 1000 commits. A branch name that starts with `-` is refused. The branch follows `--end-of-options` in the git command.

A commit names a task id in one of these forms. The match ignores case. The id is a whole token: no letter or digit directly before or after it.

- A merge commit: the id is a whole token in the merged branch name, for example `Merge branch 'w222-fix'` or `sv-b68`. The target branch of the merge does not count.
- Any other commit: the id in parentheses, for example `(#68)` or `(BD2a)`.
- Any other commit: `Closes`, `Fixes` or `Resolves` before the id, for example `Closes #12`.
- Any other commit, an id that is not only digits: the id as the prefix of the subject, for example `BD2a: card state`.

An id that is only digits needs a `#` in every form. A bare id does not count. `refs #12` and `WIP for #12` do not make a card done.

A commit that names the worker name or the worker branch of a worker with that task id counts for that task, in the same forms. The worker records give the mapping (`worker start --task-id`).

The newest matching commit is the fact of the card.

## Overlay data shape

The service adds these fields to each task of `GET /api/projects/<slug>`. The existing overlay fields (`state`, `stateSource`, `worker`, `publishedStatus`) stay.

| Field | Value |
| --- | --- |
| `computedState` | `todo`, `doing`, `review`, `done` or `stuck`. |
| `publishedState` | The `status` of the published card: `todo`, `doing`, `review`, `blocked` or `done`. |
| `source` | `{ kind, ref, at }` or `null`. |
| `source.kind` | `commit`, `worker` or `issue`. The value `review` is reserved for a later task. |
| `source.ref` | The short commit id, the worker name, or the issue number. |
| `source.at` | The time of the fact as an ISO string, or `null`. |
| `diverges` | `true` when the computed state differs from the published state. |
| `stuck` | `{ reason, ageMin }` when `computedState` is `stuck`, otherwise `null`. |

`source` is `null` when the card has no fact. The computed state then equals the published state.

`state` is the board column. It takes the computed result: `done`, `doing` or `review` from a fact, and `blocked` or `ready` from the dependencies for a `todo` card. A stuck card keeps `state` `doing`, because the page has no Stuck lane yet.

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

## Cache

- Git: the service reads `git log` of each registered project at most once each minute. The read is asynchronous, so no tick and no request waits for git. It runs `git -C <repo> log` with a 5 second timeout and without a shell. It never runs a git command that writes. The overlay uses the last answer.
- Issues: the service runs `gh issue list --state all --json number,state,closedAt` read-only in the repository, at most once each 10 minutes for each project. The run is asynchronous. The overlay uses the last answer.
- A project without a repository path, a repository that git cannot read, or a failed `gh` call gives no fact of that kind. The card keeps the state from the other sources and the published state.

## Decisions

- One `gh issue list` replaces one `gh issue view` for each task. One call for each project is the smaller load and it also finds a reopened issue on a done card.
- The issue number of a card is the number in `tasks[].url` (`.../issues/<n>`). A card without such a URL uses its id when the id is only digits.
- A published `done` card stays `done` against worker facts. Only a live worker started after the done commit, or an open issue, reopens it.
- A commit wins over an open issue. A merged commit that names the task means the work is on the base branch.
- The stuck state is not a divergence, so the digest of BD2b does not send for it.
- Analytics today holds no task counts from the published state. It needs no change in BD2a. The state API and the board counts use `state`, which now holds the computed result.
- The digest to the orchestrator, the notice to the Boss and the kit note belong to BD2b.
