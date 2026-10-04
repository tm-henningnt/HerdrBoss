# I want to see what is happening

Use these tasks to check your projects, your agents, and your cost. You only read in these tasks. Nothing here changes a project. Words in *italics* are in the [glossary](../glossary.md).

## Read the Overview

1. Open the dashboard at `http://127.0.0.1:4477`. On a phone, use the address in [phone.md](phone.md).
2. Select **Overview** in the menu.
3. Read **Needs attention** first. Then read the project cards.

You should see one card for each project, with its *project lead* and its status. **Needs attention** shows a warning when a usage limit, the memory, or the machine load is near its limit. It says "Clear" when all is good.

If the page is empty, no project exists yet. Follow [project.md](project.md). If the page does not load, see [trouble.md](trouble.md).

## Follow one project

1. Select **Details** on the card of the project.
2. Read the **Now** section at the top.
3. Select **Board** in the menu to see the tasks of all projects.

You should see what needs you, what runs now, what waits to be merged, and the next task. The Board has the columns Blocked, Ready, Doing, Stuck, Review, and Done. A card in Stuck has had no worker and no change for 3 hours.

If **Now** is empty, the project lead has not published a status yet. Ask it in the *Chat*: see [answer.md](answer.md).

## See what each agent does

1. Select **Agents** in the menu.
2. Read the Chart view from the top: you, the Boss, each project, each *worker*.
3. Select **Details** on a node to see more. Select **Messages** to read its thread.

You should see the line **Doing now** on each worker, and the agent app and the state of each agent. Select **List** at the top of the page for a table of workers.

If a node shows no state, its agent is not running. Ask the Boss about it in the *Chat*: see [answer.md](answer.md).

## See the cost

1. Select **Analytics** in the menu.
2. Read the six tiles at the top.
3. Scroll down to the charts for the cost of each day.

You should see **Claude spend a day**, **Usage limit against pace**, and four more tiles. A tile with a change compares the last 7 days with the 7 days before. The tile **Usage limit against pace** names the usage limit that is most ahead of its pace.

If a chart is empty, Herdr Boss has not collected enough data yet. Check again after a day of work.

## Let the Boss act while you are away

A *Watch* tells the Boss that you are away. The Boss makes the routine decisions until the Watch ends.

1. Select **Agents** in the menu.
2. Open the **Watch** box at the top of the page.
3. Choose an end time, or select **Until I cancel**.
4. Select **Start**.

You should see `On watch until` and the time in the box. The eye symbol in the top bar turns clear. Select the symbol and select **Stop** to end the Watch early.

If **Start** stays off, the end time is not in the future. For the rules and the report options, see the [Watch reference](../reference/settings.md#watch).

For the details of each page, see the [dashboard reference](../reference/dashboard.md).
