# HerdrBoss project memory

Keep the current facts that every HerdrBoss orchestrator needs at start and resume in this file. This repository is public. Do not store secrets, client names, tenant URLs, or details of other projects here.

## Owner decisions in force

- 2026-09-27: The Boss asks the Owner and pushes. The HerdrBoss orchestrator does not push. Source: AGENTS.md.
- 2026-09-27: Never stop, close, or restart a browser that another project uses. Never touch the Chrome on port 9222. Source: AGENTS.md.
- 2026-09-27: Store decisions and facts in project files, not only in a Claude or Codex memory. Source: Owner, through the Boss task B4.

## Holds and freezes

- 2026-09-27: Do not start the tasks in the Future group (O2, O3, O4) before the current plan is complete. Lifted by: the Owner or the Boss.
- 2026-09-27: A machine sweep of orphaned Chrome code-sign clones outside the project waits for an Owner decision. Lifted by: an Owner decision through the Boss.

## Standing rules

- Run the Boss tasks in the order that the Boss gives. The published project status is the plan.
- Serialize workers that change `src/handoff.js`.

## Roles and panes

- The HerdrBoss orchestrator runs in the pane labeled `orch` in the `HerdrBoss` workspace.
- The Boss runs in the pane labeled `boss`. Find it with `herdr pane list`.

## Evidence

- Plan and progress: `herdr-boss publish herdrboss`, project page at `http://127.0.0.1:4477/projects/herdrboss`.
- Handoff issue list and Chrome clone report: the HerdrBoss scratch folder (`herdr-boss scratch herdrboss`).
