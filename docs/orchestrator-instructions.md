# Instructions for orchestrators

Copy the section below into the CLAUDE.md or AGENTS.md file of each project that has an orchestrator.

---

## Herdr Boss

Herdr Boss supervises token quotas and machine resources for all projects on this computer.

- At startup, label your pane: `herdr pane rename "$HERDR_PANE_ID" orch`. Herdr Boss sends notices only to panes with this label.
- Read `~/.herdr-boss/bulletin.md` before you start new workers. Obey the rules in it. The rules tell you which agent kinds to use and which to avoid.
- Start workers in a separate tab named `Workers`. Do not start workers in your own tab.
- Give each worker a unique agent name, for example `herdr agent start pm-74 --kind codex --pane <id>`.
- When a worker is finished, close its browser and its pane. Run `agent-browser close` if the worker used agent-browser.
- Do not build a project dashboard. Publish project status to Herdr Boss. The schema is in `/Users/hentol/Projects/Privat/HerdrBoss/docs/project-status.md`.
- A message that starts with `[herdr-boss]` is a resource notice. Act on it if it concerns your work. Do not reply to it.
