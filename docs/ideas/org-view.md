# Future idea: organization view and messaging

**Status:** Future idea. This document is not a specification. Do not start this work before the current plan is complete. The Owner described the idea on 2026-09-25.

## Purpose

The framework has one Owner and one Boss. Each project has one orchestrator. Each orchestrator can have workers. The dashboard shows Overview, Projects, and Agents on separate pages.

An organization view could show the whole structure in one place. It could also let the Owner talk to the Boss and orchestrators without a terminal.

## Organization view

Show a live organization chart from top to bottom:

1. **Owner:** Show whether the Owner is at the Mac or away. Show the unread messages for the Owner.
2. **Boss:** Show the harness and model, state, provider quota use, and any prepared successor.
3. **Orchestrators:** Show one node for each project, in project order. Show the project name, harness and model, state, current task from the status file, worker slots in use and the project share, and handover state. Show a prepared successor beside the orchestrator as a reserve.
4. **Workers:** Show each worker under its orchestrator. Show its name, harness and model, task ID, state, and run time. Show workers for information only. Do not let the Owner contact them directly.

Use existing data: Herdr panes and labels, project status files, `state.control`, handover records, and usage records.

## Messages and Owner actions

Let the Owner send a message from the Boss or orchestrator node. The server can send it with `herdr agent prompt <pane> "[owner] ..."`.

Keep workers under the orchestrator's control. The Owner sends worker requests through its orchestrator.

Add a mailbox for replies. An agent can run `herdr-boss say "<text>"` to write a message for the Owner to `~/.herdr-boss/messages.jsonl`. Show a thread for each node, with messages in both directions.

Show Boss notices, `WORKER REPORT` messages, and `WORKER QUESTION` messages as events between nodes.

Offer these actions on a node:

- Ask a question and show the reply in the thread.
- Send a short nudge, such as “continue”, “use your free slots”, or “pause after the current task”.
- Ask for a status report. The agent replies with `herdr-boss say` and publishes its status file.
- Set or clear a project goal, such as a target task or deadline. Send the goal to the orchestrator and show it on the node until the Owner clears it.

Keep actions that change resources, such as pacing goals, on Settings. Link to Settings from the node.

## Owner mailbox

Give the Owner an inbox in the dashboard. It can work independently of the organization view.

Send every message for the Owner to this inbox. This includes questions that need a decision, human gates, finished work that needs Owner acceptance, handover and quota events that need attention, and replies sent with `herdr-boss say`.

For each item, show the sender, project, and required action: answer, approve, decide, or read. Let the Owner answer in the item. Send the answer to the sender as a prompt, then close the item.

Show an unread count in the header on every page. A desktop or phone notification is optional.

Today, these messages reach the Owner only in the Boss conversation. The inbox would keep them available and let the Owner answer from a phone.

## Safety

Sending a prompt from the page gives it control of agents that can run commands. Allow sends only from loopback requests or authenticated remote sessions. Keep the same-origin check. Ask the Owner to confirm each send.

Send messages only to panes labeled `boss` or `orch`. Queue a message while an agent is working. Never type into a blocked dialog.

Log each message in `events.jsonl`. Limit the send rate.

Never show secrets or full pane output. Show only the last status line.

## Appearance

A game-like style may help show agent state. Use a card and harness icon for each agent. A small bar can show quota use. Show a pulse while an agent works, a warning when it is blocked, and a dim state when it is idle.

Show messages and reports as short animated lines between nodes. Respect `prefers-reduced-motion`. Keep the view readable in light and dark themes. On a phone, show a worker count instead of all worker nodes. Use SVG or canvas without adding dependencies.

## The virtual software factory

Keep this frame optional. The organization chart can show the Owner as founder, the Boss as general manager, orchestrators as team leads, workers as teams, and prepared successors as reserves. Keep the existing plain pages as the default. Make playful views optional.

- A factory-floor view could show what teams do, what they wait for, what blocks them, and which browser workstation each team uses.
- A resource view could show subscriptions as budgets, worker limits as headcount, and project shares as team sizes.
- A daily stand-up could report what is done, in progress, blocked, and next.
- A retrospective could follow a work wave. A weekly report could summarize each project.
- A company log could show merges, releases, handovers, and incidents.

## Possible phases

1. **Read-only organization view:** Show the live chart. Let the Owner open details on a node.
2. **Messaging:** Add Owner-to-Boss and Owner-to-orchestrator messages, `herdr-boss say`, and mailbox threads.
3. **Visual and phone polish:** Add the game-like style, message animations, and phone layout.

## Open questions

- Should the Boss see and summarize the Owner's messages to orchestrators, or should the messages go directly to them?
- Should the Owner's presence change how often agents send messages?
- Should old message threads expire or stay?
