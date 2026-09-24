# Project status files

Herdr Boss shows one dashboard for all projects. Do not build a project dashboard. Publish a status file. The Boss dashboard renders it at `http://127.0.0.1:4477/p/<slug>`.

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

Herdr Boss sets `updated` when you publish with method 2 or 3. With method 1, the dashboard uses the file modification time.

## Remove a project

Delete the file, or send `DELETE http://127.0.0.1:4477/api/projects/<slug>`.
