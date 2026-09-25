# Project status files

Herdr Boss shows one dashboard for all projects. Do not build a project dashboard. Publish a status file. The Boss dashboard renders it at `http://127.0.0.1:4477/projects/<slug>`.

## Publish a status file

Use one of these methods. All three give the same result.

1. Write the file directly to `~/.herdr-boss/projects/<slug>.json`.
2. Run `herdr-boss publish <slug> <file>`. The command validates the file before it installs it.
3. Send `PUT http://127.0.0.1:4477/api/projects/<slug>` with the JSON as the body.

The slug must match `[a-z0-9][a-z0-9-]*`. Use the project directory name in lower case, for example `tmprocessmining`.

The dashboard updates less than one second after the file changes. Update the file when a task changes status. Do not update it on a timer.

Method 3 returns HTTP 400 and a list of errors when the file is not valid. Method 1 does not validate. The dashboard shows the errors on the project card.

## Schema

Only `project` is required. Omit the fields that you do not use.

```json
{
  "project": "TmProcessMining",
  "workspace": "w9",
  "summary": "One sentence that tells what the project does now.",
  "status": "on-track",
  "phase": "Build",
  "phases": ["Plan", "Build", "Review", "Release"],
  "tasks": [
    { "id": "74", "title": "Parse event log", "status": "doing", "worker": "pm-74", "note": "Tests pass, docs remain." },
    { "id": "73", "title": "Render graph", "status": "review", "worker": "pm-73" },
    { "id": "75", "title": "Export to PNG", "status": "todo" }
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
| `status` | string | Free text, for example `on-track`, `at-risk`, `blocked`, `done`. |
| `phase` | string | The current phase. When `phases` contains this value, the page shows a phase bar. |
| `phases` | string[] | All phases in order. |
| `tasks[].id` | string | A short ID, for example an issue number. |
| `tasks[].title` | string | Required for each task. |
| `tasks[].status` | string | One of `todo`, `doing`, `review`, `blocked`, `done`. The default is `todo`. |
| `tasks[].worker` | string | The Herdr agent name of the worker. The page shows the live status of that agent. |
| `tasks[].note` | string | One line of detail. |
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
    { "id": "2.0", "title": "Release 2.0" }
  ],
  "tasks": [
    { "id": "70", "title": "Event log spec", "status": "done", "kind": "spec", "group": "1.0", "url": "https://github.com/org/repo/issues/70" },
    { "id": "74", "title": "Parse event log", "status": "doing", "group": "1.0", "parent": "70", "blockedBy": ["70"], "labels": ["ready-for-agent"], "updated": "2026-09-25T08:00:00Z" },
    { "id": "75", "title": "Render graph", "status": "todo", "group": "1.0", "parent": "70", "blockedBy": ["74"] }
  ],
  "gates": [{ "id": "G1", "title": "Owner visual review", "needs": "Owner looks at the hosted sheet", "evidence": "owner", "status": "waiting" }],
  "risks": ["The hosted tenant quota can block the gate."],
  "git": { "branch": "main", "commit": "4f1c2ab", "dirty": false }
}
```

| Field | Type | Meaning |
|---|---|---|
| `tasks[].blockedBy` | string[] | IDs of the tasks that must be done first. Use the GitHub native issue dependencies or the "blocked by" links in the issues. The graph draws an arrow from each blocker to the task. |
| `tasks[].parent` | string | The ID of the parent task. The specs section counts the work under each spec by this field. |
| `tasks[].kind` | string | A task class, for example `spec`, `impl`, `bug`, or `gate`. Tasks with `spec` show in the specs section. |
| `tasks[].group` | string | The `id` of a group in `groups[]`. |
| `tasks[].frontier` | string | `current` or `next`. Set it when the project defines its frontier itself. When no task has this field, the Boss derives it: current work is open and has no open blocker; next work waits only on current work. |
| `tasks[].url` | string | An `http` or `https` link to the issue. |
| `tasks[].labels` | string[] | Issue labels. |
| `tasks[].assignee` | string | The person or agent assigned to the issue. |
| `tasks[].updated` | string | The ISO time of the last change. The list can sort by it. |
| `groups[]` | object | `id` and `title` are required. `note` is one line. `refs[]` holds `label` and an optional `http(s)` `url`, for example a roadmap section. Publish groups in their delivery order. |
| `gates[]` | object | A human gate: `title` is required; `id`, `needs`, `evidence`, and `status` are optional. |
| `risks[]` | string[] | Open risks. |
| `git` | object | `branch`, `commit`, and `dirty` (boolean). |

Task IDs must be unique. A `blockedBy` ID that is not in `tasks[]` counts as external: the graph notes it on the task and does not draw it. Links in `links[]`, `tasks[].url`, and `groups[].refs[].url` must start with `http://` or `https://`.

Herdr Boss sets `updated` when you publish with method 2 or 3. With method 1, the dashboard uses the file modification time.

## Remove a project

Delete the file, or send `DELETE http://127.0.0.1:4477/api/projects/<slug>`.
