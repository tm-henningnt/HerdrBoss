# Orchestrator instructions

Copy [the Herdr Boss section](../kit/templates/agents-section.md) into each project's `AGENTS.md`.

Keep shared orchestration rules in the Herdr Boss kit.

Keep product direction, issue sources, acceptance gates, release rules, and browser procedures in the project file.

When adopting a newer Herdr Boss kit:

1. Run `herdr-boss kit-path` and compare your project's Herdr Boss section with the current [template](../kit/templates/agents-section.md). Update that section in the project's `AGENTS.md` or `CLAUDE.md` without overwriting project rules.
2. Keep the active orchestrator pane labeled `orch`. Read `~/.herdr-boss/bulletin.md` before dispatch and use the Owner's saved Allocation policy for worker capacity, provider choices, and handover.
3. Publish project status with `herdr-boss publish <slug> <file>` so the shared Projects page stays current.
4. For browser work, read [the project browser service](../kit/browser-service.md). Request the project's dedicated profile, read its tab IDs, and give workers only their assigned tab. Treat port 9222 as an optional legacy shared session, not the default.
