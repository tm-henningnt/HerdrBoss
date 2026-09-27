# Orchestrator instructions

Put the Herdr Boss block into each project's `AGENTS.md`:

1. Run `herdr-boss kit block`.
2. Paste the output into `AGENTS.md`. Replace the old Herdr Boss section or block.
3. Run `herdr-boss check agents`. Fix each finding.

Do not edit the text between the markers. The block body is [the template](../kit/templates/agents-section.md). `check agents` reports a changed or old block as an error.

Keep shared orchestration rules in the Herdr Boss kit.

Keep product direction, issue sources, acceptance gates, release rules, and browser procedures in the project file.

The kit and the Boss take precedence over conflicting project text. Report a conflict to the Boss.

Read `docs/orchestration/memory.md` at start and at resume. Record Owner decisions, holds, and freezes there.

When adopting a newer Herdr Boss kit:

1. Run `herdr-boss check agents`. For an old block, run `herdr-boss kit block` and replace the block in the project's `AGENTS.md`. Do not change the project rules outside the block.
2. Keep the active orchestrator pane labeled `orch`. Read `~/.herdr-boss/bulletin.md` before dispatch and use the Owner's saved Allocation policy for worker capacity, provider choices, and handover.
3. Publish project status with `herdr-boss publish <slug> <file>` so the shared Projects page stays current.
4. For browser work, read [the project browser service](../kit/browser-service.md). Request the project's dedicated profile, read its tab IDs, and give workers only their assigned tab. Treat port 9222 as an optional legacy shared session, not the default.
