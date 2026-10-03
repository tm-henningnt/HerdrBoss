# Board help

The Board shows the tasks of all projects on one kanban. It uses the same task states as the board on each project page.

## Columns

**Blocked** holds a task that waits on another task, the Owner, the Boss, or an external item. **Ready** holds a task whose dependencies are all done. **Doing** holds a task with a live worker; the longest-running worker comes first. **Stuck** shows only while a card is stuck: a Doing card with no live worker and no commit for 3 hours. **Review** holds a task whose worker finished or was collected and whose branch is not merged. **Done · 24 h** holds the tasks done in the last 24 hours, newest first. A done task without an update time does not show.

## Cards

A card shows the project, the task ID, the title, and the worker with its model. A Doing card also shows the elapsed time. A Blocked card shows what it waits on: the ID and title of each open blocker task, or the Owner, the Boss, or an external item with the ask. When the status names no blocker, the card says so. A **path** mark shows a task on the critical path of its project.

An **auto** badge shows that Herdr Boss computed the state of the card from a fact. The badge has the fact: the short commit ID, the worker name, or the issue number. When the published state differs from the computed state, the card shows both states and the fact. A Stuck card shows the reason and the time of its last activity. In the swimlane view, a project with cards that differ from git shows a mark with the count.

Select a card to open the project page with the task selected. The page shows the task card on the project board and its chain in the dependency graph. Select a blocker to open that task. Select the project name to open the project page.

## Summary

The counts show the tasks in each column after the project, who, and search filters. Select a count to show only that column. Select it again to show all columns. **Needs the Owner** counts the open Mailbox items that need you and opens the Mailbox. Each project bar shows the tasks of that project in each state, on one scale for all projects. Select a bar to show only that project.

## Filters

**Project** shows one project. **Kind** shows the tasks that wait for the Owner, the tasks with a worker, or the tasks of one worker harness or one model. **State** shows one column. The search matches the project, the task ID, the title, the ask, and the worker name and model. Each word must match. Press `/` to go to the search. **Clear filters** removes all filters.

## Grouping

**By project** shows one swimlane for each project. Select a swimlane title to close or open it. **One board** shows all projects in one set of columns. The page remembers the grouping, the filters, and the closed swimlanes in this browser. It does not remember the search.

## Refresh

The page updates in place. It keeps the scroll position, the focus, and the search text.

## Phone

On a phone the page shows one column at a time. The tab bar shows each column with its count. Select a tab or swipe sideways to change the column. The row of project chips replaces the swimlanes. Select a chip to show one project, and select **All** to show all projects. The project name on a card is not a link on a phone.
