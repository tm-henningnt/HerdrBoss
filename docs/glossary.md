# Glossary

This page explains each word that Herdr Boss uses. Each entry has one line. The plain word comes first. When the commands use a different word, the entry names it. Words that only the Reference uses are not in this list.

For the language of factories, hosts, and head office, read [CONTEXT.md](CONTEXT.md).

## People and agents

- **Owner**: You. You own the projects, the computers, and the subscriptions, and you decide what the agents may do.
- **Boss**: The one agent that watches all projects and talks to you.
- **project lead** (commands: orchestrator, pane label `orch`): The agent that leads the work of one project.
- **worker**: An agent that does one task for a project lead.
- **planning session** (commands: planner session): A session in which an agent plans with you through review packs.
- **agent**: A program that does work for you, for example the Boss, a project lead, or a worker.
- **agent app** (commands: harness): The program that runs an agent: Claude Code, Codex, OpenCode, or Pi.
- **model**: The AI model that an agent app uses, for example a Claude model.

## Projects and work

- **project**: One product that you build with agents. It has one folder, one workspace, and one project lead.
- **workspace**: The Herdr group of panes that belongs to one project.
- **pane**: One terminal window in Herdr. Each agent runs in a pane.
- **task**: One piece of work that a project lead gives to a worker.
- **brief**: The written work order that a worker receives with its task.
- **worktree**: A separate copy of the project files in which one worker makes its changes.
- **branch**: A named line of changes in Git. Each worker uses its own branch.
- **merge**: The step that puts the changes of a branch into the main line of the project.
- **handover**: A fresh agent takes over the work of a project lead.
- **status file**: The file in which a project lead records its backlog and progress.

## Questions and review

- **Mailbox**: The dashboard page where agents leave messages for you. "Needs you" lists the items that wait for your answer.
- **Chat**: The dashboard page where you talk with the Boss.
- **review pack**: A set of items with evidence that you judge one by one.
- **item**: One thing in a review pack that you accept, deny, or comment on.
- **live check**: A link in a review pack that opens the real result, so that you can try it yourself.
- **notice**: A short message that Herdr Boss sends to an agent or shows to you.

## Usage and cost

- **usage limit** (commands: quota): The part of your subscription that you can use in a time window.
- **limit window**: The period in which a usage limit applies, for example five hours or one week.
- **reset**: The time at which a limit window starts again with full usage.
- **provider**: The company whose subscription an agent app uses, for example Anthropic or OpenAI.
- **paced**: A paced provider spreads its use evenly over the limit window.
- **Allocation**: The dashboard setting that shares workers between projects.
- **Analytics**: The dashboard page that shows what the agents cost.

## Dashboard and control

- **dashboard**: The web page on which you see and control all projects.
- **Overview**: The first dashboard page. It shows the state of all projects.
- **Board**: The dashboard page that shows the tasks of one project.
- **Agents**: The dashboard page that shows what each agent does.
- **Watch**: The Boss acts for you while you are away.
- **kit**: The shared files and rules that Herdr Boss gives to each project so that its agents work the same way.
- **service**: The Herdr Boss program that runs in the background on your computer and serves the dashboard.

## Computers

- **factory**: One complete Herdr Boss setup on one computer or container.
- **host**: A computer that runs one or more factories.
- **Fleet**: All factories that you manage. The Fleet page shows them.
- **Tailscale**: A free network tool that lets your phone reach the dashboard on your computer.
- **WSL2**: The Windows feature that runs Ubuntu inside Windows. Windows users follow the Linux path in it.
