# Add a project

This chapter shows how to create a project, start its *project lead*, give it a goal, and add a second *agent app*. Words in *italics* are in the [glossary](../glossary.md). The other chapters of the [user guide](../user-guide.md) cover the rest of the dashboard.

WARNING: Choose a private repository unless you want everyone on the internet to read all files and the full history. Never put secrets, client names, or private data in a public repository.

## Work on the projects in focus

Use the Projects page to manage the projects you track. Search by title, area, client tag, or next action. Filter by area or state. Sort by activity, priority, or title. The default view keeps parked projects in a closed fold.

Use an area for `group` and a client name for `client-tag`:

```sh
herdr-boss project register add pine-api --title "Pine API" --group platform --client-tag "Example Client"
herdr-boss project register edit pine-api --group platform --client-tag "Sample Studio"
```

Pin up to three open projects to keep them in the focus row. The default cap is three open projects. Pinned projects do not use a cap slot.

Select **Open** to restore a parked project. It checks the project setup and starts a fresh project lead. Starting the lead uses your usage limit. Select **Park** to close an open project's workspace after the safety checks. Park keeps the repository, status, Mailbox, and project files. Pause keeps the workspace open.

The commands are `herdr-boss project open <slug> --start` and `herdr-boss project park <slug>`. Use `--dry-run` to see the checks without changing the project.

Open **Settings** and find **Project register** to set the cap and issue triage. The cap starts at three. Pinned projects do not use a cap slot. Issue triage starts off. It reads the `ready-for-agent` label every 30 minutes after you turn it on.

Add a GitHub remote with `project register add` to use it as the issue source. For an existing project, run `herdr-boss project register edit pine-api --issue-repo example/pine-api`. The **Triage label** setting supplies the default label. Add `--issue-label LABEL` to set or change the label for that source. The service uses the GitHub login on this factory. It reads open issues only. When a parked project has ready issues and a slot is free, triage adds an **Accept** and **Deny** item to the Mailbox. **Accept** opens the project and starts its project lead. **Deny** closes the item and waits 24 hours before another proposal for that project. An unanswered proposal blocks another proposal for the same project.

Keep `autoOpen` off to require Mailbox acceptance. Run `herdr-boss project register edit pine-api --auto-open on` only when you want the service to open that project without an Accept.

## Create a project

You want a new product with its own folder, files, and project lead.

What you do:

1. Open the dashboard Projects page.
2. Select **New project**. A panel opens. On a phone, a full-screen sheet opens.
3. Enter a short name for the project. Select **Next**.
4. Check the folder. Select **Next**.
5. Choose the remote. The default is a private GitHub repository. Select **Next**.
6. Choose the agent app for the project lead. Enter a goal if you have one.
7. Keep **Start the orchestrator** on. This starts the project lead now.
8. Check the list of steps. Select **Create project**.

In a terminal, run `herdr-boss project new <name> --group <folder> --start` instead. The folder is the parent directory: the command makes `<folder>/<name>`.

What you should see: one line for each step, then the path of the project. A new project appears in the Overview.

If you do not see it:

- If a step fails, select **Resume**, or run the same command with `--resume`.
- If the step for the remote fails, run `gh auth login` in a terminal. Then resume. Only you sign in to GitHub.
- The read-only preview does not create projects. Use the real dashboard.

## Start the project lead

You want the agent that leads the work of the project. The word *orchestrator* is the command word for the project lead. Its pane is labeled `orch`.

What you do:

1. Keep **Start the orchestrator** on in the wizard. Or run `herdr-boss project new <name> --group <folder> --start`.
2. Open the Agents page.

What you should see: the project lead in its own pane, in the workspace of the project. It reads the project files and starts to work. Starting it uses your usage limit.

If you do not see it: run `herdr-boss project new <name> --group <folder> --start --resume`. If the pane exists but the agent is not signed in, sign in to the agent app in that pane. Only you sign in.

## Give the project lead a goal

You want to tell the project lead what to build. A goal is one or two sentences.

What you do:

1. Enter the goal in the wizard before you create the project.
2. To set or change the goal later, run `herdr-boss goal set <project> --text "<goal>"`.
3. To use one goal for all new projects, set **Default orchestrator goal** in Settings.

What you should see: the command prints the pane and the text, then confirms that the goal is active. The project lead starts to plan work for the goal.

If you do not see it: the command waits up to 10 minutes while the agent works or holds typed text. It then adds one Mailbox item with the reason. Send or clear the text in the pane, then run the command again.

## Add a second agent app

You want a project to use another agent app, for example Codex, OpenCode, or Pi. Claude Code stays your first agent app.

What you do:

1. Install the agent app. Run `herdr-boss doctor`. The line for the agent app has the exact install command.
2. Sign in to the agent app in a terminal. Only you do this step.
3. Run `herdr-boss harness check`. It lists each missing setting.
4. Run `herdr-boss harness sync`. It adds the safe settings. For the Claude lines, follow [harness-setup.md](../harness-setup.md). Only you add them.
5. Open Settings. Find **Agent apps**. Switch on **Available** for the agent app.
6. Select **Apply policy**.

What you should see: the agent app is on in **Agent apps**. The project lead can now start workers with it. A running worker keeps its agent app.

If you do not see it: run `herdr-boss harness check` again. Read each missing entry in [harness-setup.md](../harness-setup.md). Codex cannot start a browser in its sandbox: give browser tasks to another agent app.

## Transfer a project to another factory

Transfer one project to another factory through its GitHub repository. Both factories must use the same kit revision.

What you do:

1. Check the transfer plan: `herdr-boss project transfer plan <slug> --to <factory>`.
2. Start the transfer: `herdr-boss project transfer start <slug> --to <factory>`.
3. If the command lists a dirty tree, unpushed commits, an unpushed branch, or a running worker, resolve each item and run `start` again. The source project lead must be idle. Let it finish if it is working or waiting for input.
4. Open the Mailbox on the source factory. Accept or deny the switch.
5. Run `herdr-boss project transfer switch <slug> --to <factory>` to apply your answer.

What you should see: the target factory clones the project, installs the kit, and starts a fresh project lead. The lead reads `docs/orchestration/memory.md`. After you accept, the source marks the project as transferred and both factories remove the transfer lock.

To stop before the switch, run `herdr-boss project transfer cancel <slug> --to <factory>`. This removes the target project and clone. It closes the Mailbox decision, unlocks both factories, and restarts the source project lead. You cannot cancel after the switch.

Herdr Boss transfers the repository through GitHub. Secrets, logins, Mailbox items, review packs, and message text stay at the source. Transfer does not copy them.
