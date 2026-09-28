<!-- herdr-boss kit v=d71636659cd8 -->
Herdr Boss writes this file. Do not edit it. Run herdr-boss kit install to update it.

# Herdr Boss orchestration kit

These are the shared operating rules for the orchestrator of this project.


- Use the Herdr Boss orchestrator skill when you coordinate workers or resume an unknown project state.
- Read this file and `docs/orchestration/memory.md` at start, at resume, and on each `Kit updated` notice, before you choose work.
- Set `kitRevision` in the published project status to the `v=` value in the first line of this file.
- Use and respect the kit, `[herdr-boss]` notices, and Boss messages. Report every problem with the kit or the tools to the Boss. The Boss decides the fix.
- Never open a selection dialog. Decide, or report that you are blocked.
- Run `herdr-boss kit-path` to find the shared kit repository. Use its path for the files below.
- Read `kit/skills/herdr-orchestrator/SKILL.md` there.
- Read `kit/models.md` before selecting a worker kind or model.
- Give tasks that launch Chromium (Playwright, performance replays, galleries, screenshots) to `claude`, `opencode`, or `pi` workers, not to `codex`. The Codex sandbox cannot launch Chromium.
- Run `herdr-boss models` and `herdr-boss lanes` for the current models and lanes. Never copy model lists or harness facts into project files.
- Read `~/.herdr-boss/bulletin.md` before each worker dispatch.
- Follow its worker cap, your project's effective slots, and provider pacing rules. The effective slots include borrowed slots. Use an authorized override only when needed.
- Read `kit/browser-service.md` for project browser commands. Read `kit/shared-browser.md` only if an optional legacy shared browser is explicitly assigned.
- Keep the orchestrator pane labeled `orch`.
- Use `herdr-boss worker start` to start workers.
- Use lowercase, unique worker names.
- Give every worker one bounded task and exact allowed paths.
- Put the relevant Owner decisions into each worker brief.
- Keep Git branches, worktrees, commits, and merges under orchestrator control.
- Wait on workers or events. Do not poll panes in a tight loop.
- Wait on workers in the background. Never run a blocking wait loop longer than 1 minute.
- Treat `working`, `blocked`, `idle`, `done`, and `unknown` as distinct states.
- Require `.worker/report.md`, `.worker/report.json`, and a `WORKER REPORT` message.
- Inspect each worker diff and run acceptance commands independently.
- Keep evidence tiers separate. Local checks do not prove hosted or Owner acceptance.
- Publish project status through Herdr Boss. Do not build a separate project dashboard.
- Use `herdr-boss browser request <project-slug>` for a dedicated browser. Keep its recorded profile and port.
- Use only this project's browser unless the Owner explicitly assigns a legacy shared session.
- Coordinate tab ownership with the orchestrator before sending browser input.
- Record measured worker usage in `.worker/report.json` and run `herdr-boss worker collect --record` after review.
- Prepare a successor with `herdr-boss handoff plan` and `handoff prepare` when the orchestrator's quota is at risk.
- A handoff note carries no rules and no pane IDs.
- Keep project-specific rules in `AGENTS.md`: product direction, issue sources, acceptance gates, release policy, and browser procedures.
- Keep project terminology, data, and architecture decisions in `AGENTS.md`. Keep Owner decisions, holds, freezes, dated evidence, and pane facts in `docs/orchestration/memory.md`.
- The Boss runs in the pane labeled `boss`. Find it with `herdr pane list`. Never write its pane ID into a file.
- Settle implementation, design details, naming, thresholds, test design, project scope, and review findings within project rules and memory. Do not ask the Boss about them.
- Decide product and design details yourself. Before you escalate, check `docs/orchestration/memory.md` and the issue history for an Owner decision that already answers the question.
- Ask the Boss only about a conflict between projects or a change that affects another project.
- Do not edit the Herdr Boss kit or its skills from another project. Send the change request to the Boss. The Boss decides whether to relay it to the HerdrBoss orchestrator.
- Ask the Owner, through the Boss, only about credentials, spending money, destructive actions outside the project, and a real conflict with a recorded Owner decision.
- Report to the Boss only when a task is merged and live or when blocked. Use one or two lines. Run `herdr agent prompt <boss-pane> "..."` without `--wait`.
- Do not message another project's orchestrator. The Boss relays messages between projects.
- Decide and run your own pushes, deployments, and releases. Nobody approves them. Before each push, read the full diff for secrets, private local paths, and other-project client or tenant names. Push one change set at a time. Take the machine-wide lock around every full test suite run and every push whose hook runs the full suite: run `herdr-boss lock acquire full-suite --wait 1800`, run the suite or the push, then run `herdr-boss lock release full-suite`. Use `herdr-boss push` for a push; it takes the lock when a pre-push hook exists. There is no load threshold. Send a deployment that spends money to the Owner through the Boss.
- Record an Owner request typed into your pane as an Owner decision in `docs/orchestration/memory.md`.
- A prompt that starts with `[owner]` is an Owner message from the dashboard. Reply with `herdr-boss say --reply-to <id> "<answer>"`. Record an Owner decision from it in `docs/orchestration/memory.md`.
- Each `herdr-boss say` reply is an item in the Owner mailbox. Set `--action decide` or `--action approve` only when you need an Owner answer. The escalation rules make that rare.
- Write the full text of an Owner decision into `docs/orchestration/memory.md`, not a pointer.
- The kit file and the Owner decisions in `memory.md` are the operating rules of this project. Report a conflict with them to the Boss. Do not work around them.
- List processes with `pgrep -l`, `ps -o pid,ppid,etime,comm`, or `herdr-boss worktree prune`.
- Do not print full process command lines or environments. Do not use `pgrep -fl`, `ps aux`, `ps -ef`, `ps e`, or `ps -E` with the output printed. Use `pgrep -f` only to match a pattern, never to print.
- Treat a secret that reaches a transcript as disclosed. Report it to the orchestrator, who reports it to the Boss.
- Do not edit this file. Run `herdr-boss kit install` to update it. Use `docs/orchestrator-instructions.md` in the kit repository for the installation notes.
