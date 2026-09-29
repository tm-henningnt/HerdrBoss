# HerdrBoss project memory

Keep the current facts that every HerdrBoss orchestrator needs at start and resume in this file. This repository is public. Do not store secrets, client names, tenant URLs, or details of other projects here.

## Owner decisions in force

- 2026-09-27: The orchestrator decides and runs its own pushes. Neither the Boss nor the Owner approves them. Before each push, read the full diff for tokens, secrets, local paths with private content, and client or tenant names from other projects. Take the machine-wide `full-suite` lock around every full test suite run and every push whose hook runs the full suite. There is no load threshold. Source: Owner, through the Boss; the lock replaced the load rule by Boss decision.
- 2026-09-27: Escalate to the Owner, through the Boss, only credentials, spending money, destructive actions outside the project, and a real conflict with a recorded Owner decision. Source: Owner, through the Boss.
- 2026-09-27: Never stop, close, or restart a browser that another project uses. Source: AGENTS.md.
- 2026-09-28: The legacy shared browser on port 9222 is retired and will not be used again. Project browsers are managed by Herdr Boss. Source: Owner, in pane wB:p28.
- 2026-09-27: Store decisions and facts in project files, not only in a Claude or Codex memory. Source: Owner, through the Boss task B4.
- 2026-09-27: Approved B6 fixes: delete the recorded code-sign clone after a SIGTERM close; sweep orphaned `code_sign_clone` folders on each engine tick. Never touch a clone of a running Chrome. Source: Owner, through the Boss.
- 2026-09-27: Orchestrators decide product and design details themselves. They escalate only a real conflict with a recorded Owner decision, after they check this file and the issue history. Source: Owner, through the Boss.
- 2026-09-27: The Owner has no opinion on playwright-cli or agent-browser. The kit prefers the project browser for checks and does not ban other tools. Source: Owner, through the Boss.
- 2026-09-27: Free `opencode/` models run only in the `opencode` harness. Pi needs only the `opencode-go` credential, which it has. Source: Owner, through the Boss.

- 2026-09-27: The HerdrBoss orchestrator maintains the Herdr Boss kit, its skills, and its templates, and edits them directly. Other orchestrators send kit change requests to the Boss, which decides whether to relay them. Source: Owner, in pane wB:p28.

- 2026-09-27: The Future group (O2 Messaging, O3 Look and phone, O4 Owner mailbox) is open for work. The HerdrBoss orchestrator decides the order. Source: Owner, through the Boss.
- 2026-09-27: Split the kit from AGENTS.md. `herdr-boss kit install` writes `docs/orchestration/herdr-boss.md` with a version line; only herdr-boss writes it. AGENTS.md keeps a 6 to 8 line marked stub: read herdr-boss.md and memory.md at start, at resume, and on each Kit updated notice; use and respect the kit, notices, and Boss messages, and report problems with them to the Boss; decide details and pushes yourself; ask the Owner only about credentials, spending money, destructive actions outside the project, and a conflict with a recorded decision; open no selection dialogs. `check agents` verifies the stub, the file version, and contradictions outside them. Where possible, a Claude SessionStart hook prints herdr-boss.md into context. Source: Owner, through the Boss.


- 2026-09-28: Send an Owner question to the Owner through the Mailbox (`herdr-boss say --action decide|approve|answer`) or the pane, under the escalation rules. Source: Owner, through the Boss.

- 2026-09-28: The Boss gave the go, for the Owner, for the V81 chat view and the partial V80 SQLite move, with messages first. Switch the live message store to SQLite only after the Chat page is live, with a JSON copy and a VACUUM INTO backup first, at a quiet moment, and with an end-to-end delivery check. On any failure, switch back to json at once. Source: Owner and Boss.

- 2026-09-29: Build night watch mode (docs/ideas/night-watch.md) after the V95 lock queue. The night cap is global only, with keys for each lane class; project shares and lending keep working under it, with no night cap for each project. The morning report does not wait: it fires at its time and lists running tasks as "in progress, started HH:MM". Quiet hours stay an option, off by default. The Boss switches from its own cron jobs to `night start` when it is live. Source: Boss, for the Owner.

## Holds and freezes

- 2026-09-29: Stand-down by the Owner, 2026-09-29, until the Owner resumes. Start no new workers and no new tasks. Source: Owner, through the Boss.

- 2026-09-29 (until the Claude reset on Thu 2026-10-01 21:00): Start no new Claude worker without asking the Boss first. Do reviews, owner-proxy passes, and visual checks on Codex through herdr-boss browser, and bounded work on the free models. Keep orchestrator turns short. Delete this line after the reset. Source: Boss.

None.

Owner queue (credentials, billing, and Owner-applied settings):

- V22 is ready on branch `v22wtparent`, not merged. It puts new worker worktrees under `~/Projects/.herdr-wt/<repo>/<name>`. Before the merge, the Owner runs `herdr-boss harness sync` (adds `~/Projects/.herdr-wt` to the Codex `writable_roots`, with a backup) and pastes the printed Claude `autoMode` lines into `~/.claude/settings.json`. Then the HerdrBoss orchestrator merges V22.


## Standing rules

- The service serves `public/` from the `main` working tree at once, but the server code only after a restart. Restart the service right after a merge that changes `public/` together with the server API, before the full suite, or the dashboard breaks until the restart.
- Report each merge that changes the kit to the Boss in one line, written for the project orchestrators. The Boss relays it. Source: Owner, through the Boss, 2026-09-27.
- Run the Boss tasks in the order that the Boss gives. The published project status is the plan.
- Serialize workers that change `src/handoff.js`.

## Roles and panes

- The HerdrBoss orchestrator runs in the pane labeled `orch` in the `HerdrBoss` workspace.
- The Boss runs in the pane labeled `boss`. Find it with `herdr pane list`.

## Evidence

- Plan and progress: `herdr-boss publish herdrboss`, project page at `http://127.0.0.1:4477/projects/herdrboss`.
- Handoff issue list and Chrome clone report: the HerdrBoss scratch folder (`herdr-boss scratch herdrboss`).

## State at the stand-down (2026-09-29)

- **In progress:** nothing. No worker runs, and no task is half-done. `main` is pushed and passes the full suite.
- **First task at resume (Boss, 2026-09-29):** fix a deadlock from V111. Under `herdr-boss push`, a pre-push hook that runs `herdr-boss suite --reuse` queues behind the full-suite lock that the push itself holds (seen in Viz: lock list showed the push as holder and its own suite in the queue). Make a suite or lock call under a push from the same process tree reuse the held lock, re-entrant through an environment token that `herdr-boss push` sets, not queue. Add a test. Then correct the kit line "A push reuses a suite pass of the same clean tree" and the V111 docs to match.
- **Interim kit advice (until that fix):** in a pre-push hook, run the suite directly. Use `suite --reuse` only in gate scripts that run outside `herdr-boss push`. The Boss tells the projects.
- **Second task at resume (Boss, for an Owner request, 2026-09-29):** fewer notices and less kit churn. The plan and task split are in `docs/ideas/notice-churn-plan.md` (N1 to N6). Start with N1: compute the kit revision only from the files that `kit install` writes.
- **Next after that:** delete the Claude quota hold line above, if the reset on Thu 2026-10-01 21:00 has passed, and ask the Boss for the next task.
- **Open branches:** `kit-cli` and `kit-docs`, from 2026-09-24, before the kit split. They are not merged and not needed; `main` holds the kit. Ask the Boss before you delete them.
- **Worktrees:** only the main checkout. Create the integration worktree again when you merge: `git worktree add -B integrate ~/Projects/.herdr-wt/HerdrBoss/integrate main`.
- **Leases:** none. The project browser is closed, and its port 9225 is released.
- **Live data:** the message store runs on SQLite (`store.messages: sqlite` in `~/.herdr-boss/config.json`), with backups in `~/.herdr-boss/backups/`. The move of events to SQLite waits for the Boss.
- **Merge rule:** merge in the integration worktree, run the suite there, then `git merge --ff-only integrate` in `main`. Never edit `main` while a suite runs on it.
