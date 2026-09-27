# HerdrBoss project memory

Keep the current facts that every HerdrBoss orchestrator needs at start and resume in this file. This repository is public. Do not store secrets, client names, tenant URLs, or details of other projects here.

## Owner decisions in force

- 2026-09-27: The orchestrator decides and runs its own pushes. Neither the Boss nor the Owner approves them. Before each push, read the full diff for tokens, secrets, local paths with private content, and client or tenant names from other projects. Push one at a time, only when the 5-minute load is under 30. Source: Owner, through the Boss.
- 2026-09-27: Escalate to the Owner, through the Boss, only credentials, spending money, destructive actions outside the project, and a real conflict with a recorded Owner decision. Source: Owner, through the Boss.
- 2026-09-27: Never stop, close, or restart a browser that another project uses. Never touch the Chrome on port 9222. Source: AGENTS.md.
- 2026-09-27: Store decisions and facts in project files, not only in a Claude or Codex memory. Source: Owner, through the Boss task B4.
- 2026-09-27: Approved B6 fixes: delete the recorded code-sign clone after a SIGTERM close; sweep orphaned `code_sign_clone` folders on each engine tick. Never touch a clone of a running Chrome. Never touch the Chrome on port 9222. Source: Owner, through the Boss.
- 2026-09-27: Orchestrators decide product and design details themselves. They escalate only a real conflict with a recorded Owner decision, after they check this file and the issue history. Source: Owner, through the Boss.
- 2026-09-27: The Owner has no opinion on playwright-cli or agent-browser. The kit prefers the project browser for checks and does not ban other tools. Source: Owner, through the Boss.
- 2026-09-27: Free `opencode/` models run only in the `opencode` harness. Pi needs only the `opencode-go` credential, which it has. Source: Owner, through the Boss.

- 2026-09-27: The HerdrBoss orchestrator maintains the Herdr Boss kit, its skills, and its templates, and edits them directly. Other orchestrators send kit change requests to the Boss, which decides whether to relay them. Source: Owner, in pane wB:p28.

- 2026-09-27: The Future group (O2 Messaging, O3 Look and phone, O4 Owner mailbox) is open for work. The HerdrBoss orchestrator decides the order. Source: Owner, through the Boss.

## Holds and freezes

None.


## Standing rules

- Report each merge that changes the kit to the Boss in one line, written for the project orchestrators. The Boss relays it. Source: Owner, through the Boss, 2026-09-27.
- Run the Boss tasks in the order that the Boss gives. The published project status is the plan.
- Serialize workers that change `src/handoff.js`.

## Roles and panes

- The HerdrBoss orchestrator runs in the pane labeled `orch` in the `HerdrBoss` workspace.
- The Boss runs in the pane labeled `boss`. Find it with `herdr pane list`.

## Evidence

- Plan and progress: `herdr-boss publish herdrboss`, project page at `http://127.0.0.1:4477/projects/herdrboss`.
- Handoff issue list and Chrome clone report: the HerdrBoss scratch folder (`herdr-boss scratch herdrboss`).
