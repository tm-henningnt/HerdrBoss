# Planning sessions in the Herdr Boss web interface (design proposal)

Status: proposal. Not built. Side quest from the Owner, 2026-10-02.

## Goal

The Owner uses three planning skills a lot: grill-with-docs (an interview that also writes ADRs and a glossary), to-spec and to-tickets. He wants to drive them from the web, with each round as a review pack that has buttons for alternatives. The sessions run for several rounds and for hours.

## Concept

A planning session is a long-lived, parked conversation between the Owner and one planner agent. The agent asks in review packs. The Owner answers in the web interface. Between rounds the agent costs no tokens.

## Parts

1. **Session record.** id, project, kind (grill, to-spec, to-tickets, replan), input (a doc path or an issue), planner model, state (running, waiting for the Owner, researching, finished, stopped), rounds, outputs, cost.
2. **Planner agent.** A Claude pane with its own worktree on a branch, a fixed brief template for each kind, and a default model (claude-opus-5-5 for grill, Sonnet or Sol for to-tickets). It is separate from the orchestrator and from the Boss. The Boss starts it, hands it over at a context limit (the existing handover), and parks it while it waits.
3. **Rounds as packs.** Each round is a review pack with `choice` items (2 to 6 alternatives, one marked recommended), a free note, and "skip" and "ask me later". The pack header shows the session, the round number and what the previous answers changed.
4. **Answer delivery.** The submit goes to the planner pane as a message with the structured answers. The session state becomes running.
5. **Planner page.** A Planner page in the dashboard: list of sessions with state and the open round (needs you), a detail view with the round history, the ADRs and glossary terms created (diff of the branch), the questions still open, and buttons: Continue, Add a question, Pause, Finish, Stop.
6. **Outputs.** ADRs and glossary on the branch. A spec file. Tickets (files, or issues on a tracker when one is configured). "Finish" opens a last pack: approve the spec and the tickets, then merge the branch through the orchestrator.
7. **Start from the web.** A form: kind, project, input document or text, model, number of research helpers allowed. Start from a Mailbox item or a project page ("Replan this phase").
8. **Mailbox and notices.** An open round counts as one Owner item. Open rounds older than a day send one reminder. No planner message goes to Chat.

## Rules

- The planner never writes code. It writes docs on its branch only.
- Cost visible per session. A ceiling per session (default 3 USD API equivalent per round, 30 per session) pauses it and asks.
- A session survives a Boss restart: state in the data directory.
- The planner reads the repository and may read sibling projects read-only.
- Each answer is stored with its time, so the Owner can change an earlier answer. A change marks later rounds "affected".
- Public-repository hygiene applies to all outputs.

## Phases

1. Session record, start from the CLI (`herdr-boss plan start KIND PROJECT --input PATH`), rounds as ordinary packs with a session tag, answer delivery to the planner pane.
2. Planner page: list, detail, round history, buttons.
3. Start form, outputs view (branch diff), Finish pack and merge.
4. Cost ceilings, reminders, changing earlier answers, templates for kinds (replan between phases).

## Open questions

- Which model for each kind (Opus for grill by default).
- Where tickets go for projects with no tracker: files in the repository, or the Herdr Boss board.
- Whether a session may spawn research helpers on free lanes without asking.
