# Orchestrator instructions

Install the Herdr Boss kit in each project repository:

1. Run `herdr-boss kit install` in the project repository.
2. Run `herdr-boss check agents`. Fix each finding.
3. Commit `docs/orchestration/herdr-boss.md`, `AGENTS.md`, and `.claude/settings.json`.

`kit install` writes three files at the Git top level:

- `docs/orchestration/herdr-boss.md` is the kit file. Its body is [the kit template](../kit/templates/project-kit.md). Only Herdr Boss writes this file. Do not edit it.
- `AGENTS.md` gets a short stub between `<!-- herdr-boss:begin v=<hash> -->` and `<!-- herdr-boss:end -->`. The stub body is [the stub template](../kit/templates/agents-stub.md). The command replaces an old full block between the same markers.
- `.claude/settings.json` gets a Claude `SessionStart` hook. The hook prints the kit file and `docs/orchestration/memory.md` at each session start. Use `--no-hook` to skip this file. Codex has no equivalent hook.

Do not edit the text between the markers. `check agents` reports a changed or old stub, and a missing, old, or changed kit file, as an error.

Keep shared orchestration rules in the Herdr Boss kit.

The HerdrBoss orchestrator maintains the kit. Do not edit the kit from another project. Send a change request to the Boss. The Boss decides whether to relay it to the HerdrBoss orchestrator.

Keep product direction, issue sources, acceptance gates, release rules, and browser procedures in the project `AGENTS.md`.

The kit file and the Owner decisions in `docs/orchestration/memory.md` are the operating rules of the project. Report a conflict with them to the Boss. Do not work around them.

Read `docs/orchestration/herdr-boss.md` and `docs/orchestration/memory.md` at start, at resume, and on each `Kit updated` notice. Record Owner decisions, holds, and freezes in `memory.md`.

When a `Kit updated` notice arrives:

1. Run `herdr-boss kit install`. Do not change the project rules outside the stub.
2. Re-read `docs/orchestration/herdr-boss.md`. Your loaded copy is stale.
3. Set `kitRevision` in the project status to the `v=` value in the first line of the kit file, and publish the status.
4. Run `herdr-boss check agents`. Fix each finding.

Also, when adopting a newer Herdr Boss kit:

1. Keep the active orchestrator pane labeled `orch`. Read `~/.herdr-boss/bulletin.md` before dispatch and use the Owner's saved Allocation policy for worker capacity, provider choices, and handover.
2. Publish project status with `herdr-boss publish <slug> <file>` so the shared Projects page stays current.
3. For browser work, read [the project browser service](../kit/browser-service.md). Request the project's dedicated profile, read its tab IDs, and give workers only their assigned tab. Treat port 9222 as an optional legacy shared session, not the default.
