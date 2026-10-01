# Project status files

Herdr Boss shows one dashboard for all projects. Do not build a project dashboard. Publish a status file. The Boss dashboard renders it at `http://127.0.0.1:4477/projects/<slug>`.

## Publish a status file

Use one of these methods. All three give the same result.

1. Write the file directly to `~/.herdr-boss/projects/<slug>.json`.
2. Run `herdr-boss publish <slug> <file>`. The command validates the file before it installs it.
3. Send `PUT http://127.0.0.1:4477/api/projects/<slug>` with the JSON as the body.

The slug must match `[a-z0-9][a-z0-9-]*`. Use the project directory name in lower case, for example `example-app`.

The dashboard updates less than one second after the file changes. Update the file when a task changes status. Do not update it on a timer.

Method 3 returns HTTP 400 and a list of errors when the file is not valid. Method 1 does not validate. The dashboard shows the errors on the project card.

## Schema

Only `project` is required. Omit the fields that you do not use.

```json
{
  "project": "ExampleApp",
  "workspace": "w9",
  "summary": "One sentence that tells what the project does now.",
  "goal": "The durable Owner direction for this project.",
  "status": "on-track",
  "phase": "Build",
  "phases": ["Plan", "Build", "Review", "Release"],
  "tasks": [
    { "id": "74", "title": "Parse event log", "status": "doing", "worker": "pm-74", "note": "Tests pass, docs remain." },
    { "id": "73", "title": "Render graph", "status": "review", "worker": "pm-73" },
    { "id": "75", "title": "Export to PNG", "status": "todo" },
    { "id": "76", "title": "Choose the export format", "status": "blocked", "waitingOn": "owner", "ask": "PNG or SVG?", "mailboxId": "m1727" }
  ],
  "metrics": [
    { "label": "Tests", "value": "412/415", "detail": "3 skipped" },
    { "label": "Open PRs", "value": "2" }
  ],
  "links": [
    { "label": "PR #12", "url": "https://github.com/org/repo/pull/12" }
  ],
  "notes": ["Blocked on API key for staging. Asked the user."]
}
```

| Field | Type | Meaning |
|---|---|---|
| `project` | string | The display name. Required. |
| `workspace` | string | The Herdr workspace ID or label. The project page then shows the live agents of that workspace. |
| `summary` | string | One sentence. |
| `goal` | string | Optional durable Owner direction. Use a non-empty string of at most 1000 characters. Each status publication must keep the current value until the Owner changes or clears it. Omit the field to clear it. The next H26 handover slice will include this value in the successor record and startup prompt. |
| `status` | string | Free text, for example `on-track`, `at-risk`, `blocked`, `done`. |
| `phase` | string | The current phase. When `phases` contains this value, the page shows a phase bar. |
| `phases` | string[] | All phases in order. |
| `tasks[].id` | string | A short ID, for example an issue number. |
| `tasks[].title` | string | Required for each task. |
| `tasks[].status` | string | One of `todo`, `doing`, `review`, `blocked`, `done`. The default is `todo`. |
| `tasks[].worker` | string | The Herdr agent name of the worker. The page shows the live status of that agent. |
| `tasks[].note` | string | One line of detail. |
| `tasks[].waitingOn` | string | Optional. One of `owner`, `boss`, `task`, `external`. It names the party that holds the task. The project page shows a wait label and, for the Owner, a decision group. |
| `tasks[].ask` | string | Optional. The short question or need, at most 200 characters. It is required when `waitingOn` is `owner` or `boss`. |
| `tasks[].mailboxId` | string | Optional. The ID of the Mailbox message for this wait. The decision group links to its conversation. When a publish keeps the task and the task no longer has `waitingOn: owner`, Herdr Boss closes the open Mailbox item with this ID. A publish that removes the task, or has no `tasks`, closes nothing. |
| `metrics[]` | object | `label`, `value`, and an optional `detail`. |
| `links[]` | object | `label` and `url`. |
| `notes[]` | string | Short notes. Backticks show as code. |

## Work structure: dependencies, groups, and specs

These fields are optional. With them, the project page shows overall progress, the current and next frontier, a dependency graph, progress per group and per spec, and a sortable list of all work, open and completed.

Publish every tracked issue as a task, including closed issues with `"status": "done"`. The page limits the Done column of the board to the latest 10 tasks until the viewer selects **Show completed**.

```json
{
  "groups": [
    { "id": "1.0", "title": "Release 1.0", "note": "Core map and export.", "refs": [{ "label": "docs/ReleasePlan.md" }] },
    { "id": "2.0", "title": "Release 2.0", "held": true }
  ],
  "tasks": [
    { "id": "70", "title": "Event log spec", "status": "done", "kind": "spec", "group": "1.0", "url": "https://github.com/org/repo/issues/70" },
    { "id": "74", "title": "Parse event log", "status": "doing", "group": "1.0", "parent": "70", "blockedBy": ["70"], "labels": ["ready-for-agent"], "updated": "2026-09-25T08:00:00Z" },
    { "id": "75", "title": "Render graph", "status": "todo", "group": "1.0", "parent": "70", "blockedBy": ["74"] }
  ],
  "gates": [{ "id": "G1", "title": "Owner visual review", "needs": "Owner looks at the hosted sheet", "evidence": "owner", "status": "waiting" }],
  "risks": ["The hosted tenant quota can block the gate."],
  "git": { "branch": "main", "commit": "4f1c2ab", "dirty": false },
  "kitRevision": "8298d02eb500"
}
```

| Field | Type | Meaning |
|---|---|---|
| `tasks[].blockedBy` | string[] | IDs of the tasks that must be done first. Use the GitHub native issue dependencies or the "blocked by" links in the issues. The graph draws an arrow from each blocker to the task. |
| `doneCount` | integer | Written by `herdr-boss publish`. The number of done tasks that left `tasks[]`. It equals `doneCountBase` plus the number of IDs in `doneIds`. The value is from 0 to 1000000. Do not set it by hand. |
| `doneIds` | string[] | Written by `herdr-boss publish`. The IDs of the done tasks that `doneCount` counts. At most 5000 IDs. |
| `doneCountBase` | integer | Written by `herdr-boss publish`. The part of `doneCount` that has no ID. The value is from 0 to 1000000. |
| `tasks[].parent` | string | The ID of the parent task. The specs section counts the work under each spec by this field. |
| `tasks[].kind` | string | A task class, for example `spec`, `impl`, `bug`, or `gate`. Tasks with `spec` show in the specs section. |
| `tasks[].group` | string | The `id` of a group in `groups[]`. |
| `tasks[].frontier` | string | `current` or `next`. Set it when the project defines its frontier itself. When no task has this field, the Boss derives it: current work is open and has no open blocker; next work waits only on current work. |
| `tasks[].url` | string | An `http` or `https` link to the issue. |
| `tasks[].labels` | string[] | Issue labels. |
| `tasks[].assignee` | string | The person or agent assigned to the issue. |
| `tasks[].updated` | string | The ISO time of the last change. The list can sort by it. |
| `groups[]` | object | `id` and `title` are required. `note` is one line. `refs[]` holds `label` and an optional `http(s)` `url`, for example a roadmap section. Publish groups in their delivery order. |
| `groups[].held` | boolean | Optional. `true` holds the group. The idle-orchestrator nudge does not name a task in a held group. The default is `false`. |
| `gates[]` | object | A human gate: `title` is required; `id`, `needs`, `evidence`, and `status` are optional. |
| `risks[]` | string[] | Open risks. |
| `git` | object | `branch`, `commit`, and `dirty` (boolean). |
| `kitRevision` | string | Optional. The kit revision that the orchestrator loaded: the `v=` value in the first line of `docs/orchestration/herdr-boss.md`. It has 12 lowercase hex characters. `herdr-boss publish` sets it from the kit file on disk, after it refreshes a behind kit. The project page shows the published revision, the revision on disk, and the current revision. It shows a warning with the number of required changes when the published revision is behind. |

`herdr-boss publish` keeps at most the newest 30 done tasks in the stored status. It orders them by `updated`, or by file order when `updated` is missing. A done task that another task lists in `blockedBy` stays. The command records the IDs of the removed tasks in `doneIds` and counts them in `doneCount`. It prints one line when it counts new tasks. The orchestrator keeps its own file unchanged. Publishing the same file again leaves `doneCount` unchanged. The command warns when the stored status is larger than 200 KB.

The project data holds `doneCount`. The server does not compute a progress total. The client adds `doneCount` to the number of done tasks and to the number of all tasks.

Task IDs must be unique. A `blockedBy` ID that is not in `tasks[]` counts as external: the graph notes it on the task and does not draw it. Links in `links[]`, `tasks[].url`, and `groups[].refs[].url` must start with `http://` or `https://`.

Use `waitingOn` to separate a wait for a person from a wait for other tasks. Set `waitingOn: owner` only when the task needs an Owner decision. Set `ask` to the short question. Post a Mailbox item for the Owner, and set `mailboxId` to its ID. Use `blockedBy` for a wait on other tasks. A `done` task must not have `waitingOn`. Clear `waitingOn` and `ask`, or finish the task, when the Owner has answered in any place. Then publish the status. Removing the task does not close the item. The publish closes the Mailbox item of `mailboxId` with the note `resolved by the project`. Only a publish for the same project closes its items.

`herdr-boss publish` refuses a status in which a task has an active worker (working or blocked, with no report) but is not `doing`. Run it with `--force` to skip this check.

`herdr-boss publish` warns on standard error, but still publishes, when a `blocked` task has no `blockedBy` and no `waitingOn`, or when a task with `waitingOn: owner` has no `mailboxId`.

Herdr Boss sets `updated` when you publish with method 2 or 3. With method 1, the dashboard uses the file modification time.

## Live task state

Herdr Boss derives the effective state of each task from the published status and from the worker run records. The state API adds these fields to each task and keeps every published field. `GET /api/projects` and the state that the dashboard receives hold the same fields.

| Field | Type | Meaning |
|---|---|---|
| `tasks[].state` | string | The effective state: `blocked`, `ready`, `doing`, `review`, or `done`. |
| `tasks[].stateSource` | string | Where the state comes from: `published`, `live from worker NAME`, `collected from worker NAME`, `merged from worker NAME`, or `derived from dependencies`. |
| `tasks[].publishedStatus` | string | The `status` that the orchestrator published. `status` keeps the same value. |
| `tasks[].worker` | object or null | `name`, `kind`, `model`, and `startedAt` of the worker that decides the state. |
| `tasks[].blockers` | string[] | The IDs of the dependencies that are not done. It is empty unless `state` is `blocked`. |
| `tasks[].blockedReason` | string or null | The reason, for example `waits on task 70, task 71` or `waits on the owner`. |
| `boardStale` | boolean | `true` when the published status no longer describes the work. |
| `boardStaleReason` | string or null | The reason for `boardStale`. |

The rules are in [Live task state](user-guide.md#live-task-state).

## Remove a project

Delete the file, or send `DELETE http://127.0.0.1:4477/api/projects/<slug>`.
