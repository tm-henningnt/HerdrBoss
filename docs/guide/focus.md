# I want to work on the projects in focus

Use the Projects page to manage the projects you track. Search by title, area, client tag, or next action. Filter by area or state. Sort by activity, priority, or title. The default view keeps parked projects in a closed fold.

Use an area for `group` and a client name for `client-tag`:

```sh
herdr-boss project register add pine-api --title "Pine API" --group platform --client-tag "Example Client"
herdr-boss project register edit pine-api --group platform --client-tag "Sample Studio"
```

Pin up to three open projects to keep them in the focus row. The default cap is three open projects. Pinned projects do not use a cap slot.

Select **Open** to restore a parked project. It checks the project setup and starts a fresh project lead. Starting the lead uses your usage limit. Select **Park** to close an open project's workspace after the safety checks. Park closes a workspace when its lead is idle, and `open --start` starts a fresh lead. Park keeps the repository, status, Mailbox, and project files. Pause keeps the workspace open.

The commands are `herdr-boss project open <slug> --start` and `herdr-boss project park <slug>`. Use `--dry-run` to see the checks without changing the project.

Open **Settings** and find **Project register** to set the cap and issue triage. The cap starts at three. Pinned projects do not use a cap slot. Issue triage starts off. It reads the `ready-for-agent` label every 30 minutes after you turn it on.

Auto-park starts after 24 hours without activity. It parks an open, unpinned project after the same checks as `project park`. A running worker, an unmerged worker branch, or a Mailbox item that waits for you keeps the project open. Change **Auto-park idle projects** in **Settings → Project register** to set the idle time. Set it to `0` to turn auto-park off. New commits, worker completion, and your Mailbox answers refresh the activity time.

Add a GitHub remote with `project register add` to use it as the issue source. For an existing project, run `herdr-boss project register edit pine-api --issue-repo example/pine-api`. The **Triage label** setting supplies the default label. Add `--issue-label LABEL` to set or change the label for that source. The service uses the GitHub login on this factory. It reads open issues only. When a parked project has ready issues and a slot is free, triage adds an **Accept** and **Deny** item to the Mailbox. **Accept** opens the project and starts its project lead. **Deny** closes the item and waits 24 hours before another proposal for that project. An unanswered proposal blocks another proposal for the same project.

Keep `autoOpen` off to require Mailbox acceptance. Run `herdr-boss project register edit pine-api --auto-open on` only when you want the service to open that project without an Accept.
