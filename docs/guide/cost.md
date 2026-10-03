# I want to limit the cost

Your agents use the *usage limit* of your plans. Use these tasks to see the limits and to control how fast the agents use them. A *paced* provider spreads its use evenly over the limit window. A *handover* gives the work of a project lead to a fresh agent. Words in *italics* are in the [glossary](../glossary.md).

## Read the usage limits

1. Open the **Overview**.
2. Open the section **Current guidance**.

You should see each provider with a state: **Use now**, **on pace**, or **hold**, and the *reset* time of its *limit window*. If a provider shows no reading, the usage reader is missing. See [trouble.md](trouble.md).

## Pace a provider

1. Open **Settings**. Find **Provider quotas**.
2. Choose **Manage pace** to pace a provider. Choose **Ignore quota** to let the agents use all of it.
3. Select **Apply policy** when the bar shows unsaved changes.

You should see your choice saved. A live window at 100% still stops the provider until its reset. If the choice does not stay, you use the read-only preview.

## Set the number of workers

1. Open **Allocation**.
2. Set **Maximum working agents** to a number from 1 to 64.
3. Select **Apply policy**.

You should see `N/M workers active` next to the button. Working agents continue. Herdr Boss starts no new worker above the number. If the page shows a dialog, read it and confirm.

## Share workers between projects

1. Open **Allocation**. Find **Project shares**.
2. Set the share of each project. The shares add up to 100.
3. Select **Apply policy**. Confirm the dialogs.

You should see the new shares. With **Borrow idle shares** on, a project that does not use its workers lends them. A share is advice. The maximum number of workers is the hard limit. If the total is not 100, the page asks you to confirm.

## Turn off a model or an agent app

1. Open **Settings**. Find the section of the *agent app*.
2. Clear **Available** to turn off the agent app. Clear the box of a model to turn off that model.
3. Select **Apply policy**.

You should see the choice leave the list for new workers. A running agent continues until it stops. To turn off a model for one project only, select **Exclude kinds / models** on its row in **Allocation**.

## Plan around a limit reset

1. Open **Settings**. Find the *quota pacing goal* of the provider.
2. Enter the percent of the window that you want to use by its end.
3. Choose when the goal ends. Select **Apply policy**.

You should see the pace line on the **Overview** follow your goal. A goal of 80 keeps 20 percent for the next window. The end time must be after now and not after the reset. For Codex reset credits, see the [quota reset planner](../quota-plan.md).

## Let a fresh agent take over

1. Open the project page. Select the line of the project lead in **Now**.
2. Select **Plan handover**, then **Prepare successor**.
3. Select **Inspect successor** and read its answer.
4. Select **Confirm activation**.

You should see the new project lead in a new pane. The old pane closes later. A successor that is not ready after 30 minutes expires. Plan it again. For automatic handover, see the [handover reference](../reference/handover.md).
