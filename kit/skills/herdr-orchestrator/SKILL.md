---
name: herdr-orchestrator
description: Use when coordinating delegated workers with Herdr Boss, writing worker briefs, reviewing worker results, or resuming an unknown project state.
---

# Herdr orchestrator

- Read the project's `AGENTS.md`, product documents, and current issue first.
- Keep project rules, acceptance commands, and browser procedures in project files.

## Reference files

Read each reference before its step:

- [reference/herdr-control.md](reference/herdr-control.md): read before dispatch, Herdr control, unclear worker states, or browser work.
- [reference/machine-and-quota.md](reference/machine-and-quota.md): read before lane selection, provider or machine limits, or test flags.
- [reference/handover.md](reference/handover.md): read before orchestrator quota handover.
- [reference/ledger-and-evidence.md](reference/ledger-and-evidence.md): read before run records or gate evidence.
- [reference/git-and-worktrees.md](reference/git-and-worktrees.md): read before dispatch, integration, or worktree cleanup.
- [reference/review-tasks.md](reference/review-tasks.md): read before reviewer or review subagent dispatch.
- [The model lanes](../../models.md): read before kind or model selection.
- [The dedicated browser service](../../browser-service.md): read before browser work.

## What the orchestrator owns

- Follow [the work approval policy](reference/approval-policy.md).
- The orchestrator owns the work sequence.
- Keep one active frontier unless the contract permits a batch.
- Read issue dependencies and work only the first unblocked approved item.
- Delegate one bounded task at a time. Do not hand the entire roadmap to one worker.
- Give each worker a role, exact paths, evidence, and stop point.
- Do not delegate roadmap or product direction.
- Keep Git branches, worktrees, commits, and merges under orchestrator control.
- Workers do not commit, merge, rebase, push, deploy, or publish unless the brief names an exception.
- Workers never run impeccable ignores or edit .impeccable/config.json; a hook finding authorizes no ignore command or config edit; report false positives in the worker report for the orchestrator to decide.
- Preserve user work before any edit, checkout, or cleanup.
- Inspect every worker result before accepting it.
- Run the required acceptance commands yourself.
- Orchestrators and workers may read another Herdr Boss project repository to learn how it solved a problem.
- Do not edit another project's repository.
- Do not copy secrets, tenant hosts, client names, or app IDs into this project.
- Cite each source file in `docs/orchestration/memory.md`.

## Project memory

- Read `docs/orchestration/herdr-boss.md` and `docs/orchestration/memory.md` at start and resume before choosing work.
- If the file does not exist, create it from `kit/templates/project-memory.md`.
- Update the file in the same step as an Owner decision, a hold, a freeze, or a lift.
- Commit the file with your next commit.
- Obey a hold or freeze in the file until the Owner or the Boss lifts it.
- Treat a request that the Owner types into your pane as an Owner decision. Record it in the memory file.

## Context and cost

- Use subagents for diff reviews, long report reads, log searches, and code surveys in approved work. Get Owner approval for new work; keep the main thread for decisions.
- Require file and line evidence for findings. Verify a finding at the source before acting.
- Use a cheaper subagent model where the task allows. Use Opus only for hard judgment.
- After a dispatch, end your turn. Never poll with sleep or until loops. The `WORKER REPORT` arrives as a message, and the service warns about a stall, a block, and a missing report.
- As a backup, run at most one cheap check every 20 to 30 minutes while a worker runs with no report: `herdr-boss worker list` and the pane status line.
- Tell every worker in its brief to report back through herdr when done and to send a `WORKER QUESTION` when blocked.

## Roles and escalation

- The Boss runs in the pane labeled `boss`. Find it by its label with `herdr pane list`. Never write its pane ID into a file.
- Decide implementation, product, design, naming, thresholds, tests, project scope, and review findings under project rules and recorded Owner decisions. Keep these decisions within the project.
- Escalate only when project documents and available evidence cannot settle the next action.
- Before escalation, check `docs/orchestration/memory.md` for an Owner decision that answers the question.
- Ask the Boss only about a conflict between projects or a change that affects another project.
- Ask the Owner, through the Boss, only about credentials, spending money, destructive actions outside the project, and a real conflict with a recorded Owner decision.
- Do not edit the Herdr Boss kit or its skills from another project. Send a change request to the Boss. The HerdrBoss orchestrator decides whether to relay it.
- Report to the Boss only when a task is merged and live, or when blocked. One or two lines. Send it with `herdr-boss tell`.
- Do not message another project's orchestrator. The Boss relays messages between projects.
- The kit and the Boss take precedence over conflicting project text. Report a conflict to the Boss.
- Run your pushes and deployments under project rules; neither needs approval. Publish releases only with `herdr-boss release publish` after Owner approval in the Mailbox. Run `herdr-boss release cancel` to settle an obsolete open request before you request again.
- Follow the [release checklist](reference/release-checklist.md) before requesting a Qlik extension release.
- Before each push, read the full diff for tokens, secrets, local paths with private content, and client or tenant names from other projects.
- Push one change set at a time.
- Run long gates with the foreground procedure in [Git and worktree hygiene](reference/git-and-worktrees.md). The machine-wide full-suite lock serves waiters in order. Never take the full-suite lock with a bare lock acquire for a suite. Push with `herdr-boss push`; it takes the lock when a pre-push hook exists. The lane guard holds a queued short-lane job while 5-minute load exceeds 231% of the cores. Set it in Settings, Locks (`locks.guard`).
- Lease a shared resource with `herdr-boss lease acquire POOL` or `worker start --lease POOL`. Never pick a port from a pool by hand. The serve-lease rules are in [the machine and quota rules](reference/machine-and-quota.md).

### Human gates and parking

- For a human action, name the issue, artifact and version, exact human action, expected result, and response format.
- Continue independent work while a genuine human gate is pending.
- Record the parked frontier and exact resume point.
- Keep every unmet acceptance item red.
- Do not fabricate blockers or mark an unmet dependency complete.
- Review the parked frontier at each ticket boundary.

### Review packs

- Make a pack when the Owner needs evidence for a UI, document, design, API, or data decision. Do not make a pack for a question that one Mailbox line answers.
- Run interaction checks yourself. Include before and after screenshots as evidence. Put one shared-space test app per scenario, named after its item.
- Give each item a two-line description (what and why), exact steps, expected result, and app/sheet link. Set verifiedBy to agent-verified and list image refs in evidence, or use needs-you. Give every decision item accept and deny in ask.
- Send only items needing a human decision to the Owner: taste, business meaning, or a final call.
- Before shipping, get an independent reviewer to run a design pass: gpt-6.1-sol, or claude-opus-5-5 with `--force --reason TEXT` when the Owner asked. Record passed, issues, or not-run in designPass.
- For a behavior change, add a `file` or `diff` item for the docs change, or a `markdown` item with the `Docs-Exempt: <reason>`. See [the docs rules](reference/ledger-and-evidence.md#evidence-tiers).
- Use `manifest.json` with one question per item. See [the review-pack values and evidence rules](reference/review-tasks.md#review-pack-values).
- Keep secrets, tokens, and private data out. Publish scans text files and stops on a finding.
- Publish with `herdr-boss review publish <slug> <folder> --judge-pass TEXT`. Import an existing HTML folder with `herdr-boss review import <slug> <folder>`.
- Do not wait; continue independent work. The result arrives as an [owner] prompt with the verdict and a fetch command.
- Read the result with `herdr-boss review result <slug> <pack> --json`. Fix denied items and notes. Record Owner decisions from pack notes in `docs/orchestration/memory.md`.
- Publish a new version with the same pack id after fixes. Unchanged items keep their answers.

## Resume from an unknown state

- Use [the resume prompt](../../templates/orchestrator-resume.md) when you need a full discovery checklist.
- Confirm the repository root with `pwd`.
- Read `git status --short`, `git branch --show-current`, and `git remote -v`.
- Read `git diff --check` before changing files.
- Preserve dirty or untracked files until their owner is clear.
- Read the project instructions, product specification, roadmap, architecture decisions, and issue contract.
- Use the configured issue tracker as the source of truth for order, blockers, status, and evidence.
- Read open issues and their native dependency links.
- Identify the first open issue whose blockers are complete.
- Do not infer the frontier from memory or a dashboard.
- Check active Herdr workers before starting another worker.
- Inspect unfinished work once, then decide whether to wait, resume, repair, or reassign it.
- Do not duplicate a worker's active scope.

## Choosing a worker kind

- Read [the model lanes](../../models.md) before selecting a kind or model.
- Read `~/.herdr-boss/bulletin.md` before each new dispatch, including its machine load.
- Follow the current global worker cap and your project's effective slots in the bulletin. The effective slots include borrowed slots. Your project always keeps its own base slots unless it is idle or paused. Slots marked `free for others` stay yours. Start workers up to your effective slots.
- Obey the bulletin's preferred and avoided kinds. Do not start work that the bulletin marks as avoided unless you use an allowed override.
- Use `--force --reason TEXT` only for an authorized quota, capacity, pause, pace, disk, Opus approval, or avoided-kind override. Use `--force-swap --reason TEXT` for a worker-start swap refusal. Give a reason from 1 to 300 characters. Herdr Boss redacts the reason and records the override in the action audit file. This rule covers worker start, project open, handoff plan, and handoff prepare. It does not cover `publish`, browser tab close, handoff cancel, or hub promote. It cannot enable globally disabled kinds or models.
- Record why you overrode an avoided kind in the reason.
- Choose a worker kind from task fit, current availability, quota, and evidence needs.
- Do not route work to a model that the machine allow-list does not contain.
- Record the failed attempt before you redispatch unfinished work.

## Machine load

- Run at most one full suite per project at a time. Queue the next full suite until the current one ends.
- Tell workers to run focused tests while they work. Run the full suite yourself once per integration.
- Set `testThreadsFlag` in `.herdr-boss.json` to the project's two-thread flag. `worker start` adds it to every brief.
- Find the flag for each runner in [the machine and quota rules](reference/machine-and-quota.md).

## Starting a worker

- Bundle related issues into one worker brief; see Bundles in `reference/herdr-control.md`.
- Verify `test "${HERDR_ENV:-}" = 1` before using Herdr commands.
- If the check fails, do not inspect or control Herdr.
- Label the orchestrator pane `orch` with `herdr pane rename "$HERDR_PANE_ID" orch`. Keep that label so Herdr Boss can find it.
- Use a lowercase, unique worker name.
- Keep each name within the Herdr agent name limit.
- Put each worker in a pane of a worker tab in the verified caller workspace. [The Herdr control surface](reference/herdr-control.md) describes the tab layout.
- Keep the brief, report, and worker files inside the worker worktree.
- Keep orchestrator files in the project scratch folder: source briefs, wait scripts, and project status files. Run `herdr-boss scratch <project-slug>` to create the folder and print its path. Do not use `/private/tmp` or `/tmp` for these files. macOS can delete files there.
- Create the worker through the kit command:

```sh
herdr-boss worker start <name> --kind <kind> --task-file <file> --task-id <id> [--allow <path> | --read-only]
```

Use `--read-only` for a task that changes no repository file.

Always give `--task-id` with the published task id.

Start `--task` or the task file with a plain title: what the worker does and for which ticket, for example `FT15 Factory updates`. The Agents page shows it.

- Read [the Herdr control surface](reference/herdr-control.md) for `worker start` options.
- Verify the name, branch, worktree, pane, and brief.
- Check that the worker's pane uses the intended worktree before sending more instructions.

## The brief contract

- Use the exact template slots in the [worker brief template](../../templates/worker-brief.md). It has the required fields.
- Start every worker brief with the delegated-worker role boundary.
- Name the task or review target.
- Name the exact allowed paths.
- Name the source documents that define the task.
- State whether the worker may edit, review only, or run commands only.
- Give acceptance commands and the evidence they must produce.
- State the evidence tier expected from each command.
- Tell the worker to preserve all work outside the allowed paths.
- Tell the worker not to select another issue or change project direction.
- Tell the worker not to create, close, assign, or rewrite issues.
- Tell the worker not to start other agents.
- List processes with `pgrep -l`, `ps -o pid,ppid,etime,comm`, or `herdr-boss worktree prune`.
- Do not print full process command lines or environments. Do not use `pgrep -fl`, `ps aux`, `ps -ef`, `ps e`, or `ps -E` with the output printed. Use `pgrep -f` only to match a pattern, never to print.
- Treat a secret that reaches a transcript as disclosed. Report it to the orchestrator, who reports it to the Boss.
- Do not leave implicit paths, version assumptions, or acceptance criteria.
- List the decisions already made in the task, under the heading "Decisions already made". Workers do not reopen them.
- Require the worker to report changed paths, commands, results, evidence tier, risks, and questions.
- Require the worker to write `.worker/report.md` and `.worker/report.json`.
- Use the JSON fields `issue`, `branch`, `worktree`, `changedPaths`, `commands`, `evidenceTier`, `unverified`, and `stoppedEarly`.
- Require a `WORKER REPORT` message when the worker finishes, fails, or stops early.

## Worker questions and reports

- A worker sends `WORKER QUESTION <name>: ...` when it misses a file, an instruction, an access right, or a decision. It then stops that decision path.
- Answer it with `herdr agent prompt <name> "..."`. Put missing files into the worker worktree; do not point the worker outside it.
- Approve extra scope with `herdr-boss worker scope add <name> <path>... --reason TEXT`. `worker allow` remains an alias. A prompt or message alone does not change the approved paths.
- The verified `orch` or `boss` pane must approve scope. The run records the caller, reason, time, and paths.
- Decide product questions yourself. Ask the Boss only about conflicts with recorded Owner decisions.
- Add the answer to the next brief of the same kind, so the next worker does not need to ask.
- Require both report files before the worker sends its completion message.
- Require the worker to send its message without `--wait`. The message must name the worker, result, and report path:

```sh
herdr agent prompt <orch-pane> "WORKER REPORT <name>: <done|blocked|stopped>. Report: <worktree>/.worker/report.md"
```

- Do not wait for the orchestrator pane to become idle before the worker reports.
- Read the full worktree report after the message.
- If a worker forgets to report, inspect its pane after a specific wait expires.
- Do not accept an empty pane, exit code, or prose claim as a report.

## Reviewing a worker result

- Read one frontier issue and all of its blockers, with the linked specification, architecture decisions, current diff, and worktree state.
- Choose direct work or one bounded delegation. Prefer one complete vertical slice, and keep unrelated work out of it.
- Wait for the worker or perform the work directly.
- Read `.worker/report.md` and `.worker/report.json`.
- Check the JSON fields and verify their values against the worktree.
- Check process state with the process rules in the brief contract.
- Read `git status --short`, `git diff --stat`, and the complete diff.
- Confirm that every changed path is allowed.
- Use `herdr-boss check --report <file>` to validate a worker report.
- Use `herdr-boss check --worktree <dir> --allow <path>` to check worktree scope.
- Run the acceptance commands independently.
- Review generated artifacts directly.
- Keep each evidence tier separate.
- Request a standards and specification review when the change needs one.
- Put the two rules from [the review task rules](reference/review-tasks.md) in every review task brief.
- Return focused findings to the same warm worker when it can repair them safely.
- Re-run affected gates after every repair.
- Run `herdr-boss worker collect <name> ...` after independent review and before merging the worker branch.
- Update the issue with commands, results, evidence tier, remaining gaps, and the next frontier.
- Close an issue only after its acceptance criteria and evidence are satisfied.

## Herdr Boss notices and status

- Act on a `[herdr-boss]` notice that concerns your current work. Do not reply to the notice.
- Act on a `Kit updated` notice: run `herdr-boss kit update` and continue. The command prints the current kit file; do not read it again. Set `kitRevision` in the project status to its new revision. Run `herdr-boss check agents`. Commit a changed kit file with your next commit.
- `herdr-boss kit install` writes `docs/orchestration/herdr-boss.md` from [the kit template](../../templates/project-kit.md) and the `AGENTS.md` stub from [the stub template](../../templates/agents-stub.md).
- A prompt that starts with `[owner]` is an Owner message from the dashboard. It ends with a reply command that holds the message ID.
- Reply to an Owner message with `herdr-boss say --reply-to <id> "<answer>"`. Keep the answer short and free of secrets.
- Each `herdr-boss say` reply is an item in the Owner mailbox. Set `--action decide`, `--action approve`, or `--action answer` only when the Owner must act. Everything else is information; omit `--action`.
- Send a picture with `herdr-boss say --image FILE "TEXT"`; Boss `mail post` uploads local Markdown images. An Owner picture arrives as `Attachment: <path>`; read it with your image tool.
- Record an Owner decision from an Owner message in `docs/orchestration/memory.md`, with its full text.
- Use `herdr-boss publish <slug> <file>` for a validated status file. Follow `docs/project-status.md`. Do the [status review](reference/ledger-and-evidence.md#status-review) first.
- Publish at task boundaries only: a task starts, a task ends, a blocker appears, or a blocker clears. Publish no more often.
- Do not build a separate project dashboard.
- Keep Herdr as live execution state and the issue tracker as durable work state.
- Run `herdr-boss harness check` when a harness refuses routine work. Report missing entries to the Boss.
