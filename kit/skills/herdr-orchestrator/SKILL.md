---
name: herdr-orchestrator
description: Use when coordinating delegated workers with Herdr Boss, writing worker briefs, reviewing worker results, or resuming an unknown project state.
---

# Herdr orchestrator

- Use this skill when you own the project's work order and coordinate workers through Herdr Boss.
- Read the project's `AGENTS.md`, product documents, and current issue before choosing work.
- Keep project rules in the project files. Use this skill for the shared orchestration process.

## What the orchestrator owns

- The orchestrator owns the complete work sequence.
- Keep one active frontier unless the project contract permits a bounded batch.
- Read issue dependencies and work only the first unblocked item.
- Keep ownership of product decisions and the relationship with the human Owner.
- Delegate one bounded task at a time.
- Give each worker a clear role, exact paths, evidence, and a stopping point.
- Keep workers subordinate to the project orchestrator.
- Do not delegate roadmap ownership or product direction.
- Keep Git branches, worktrees, commits, and merges under orchestrator control.
- Workers do not commit, merge, rebase, push, deploy, or publish unless the brief names an exception.
- Preserve existing user work before any edit, checkout, or cleanup.
- Inspect every worker result before accepting it.
- Run the required acceptance commands yourself.
- Escalate only when project rules and available evidence cannot settle a decision.
- Continue independent work while a genuine human gate is pending.

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
- Read `~/.herdr-boss/bulletin.md` before each new dispatch.
- Follow the current global worker cap and your project's share in the bulletin.
- Use `--force` only for an authorized quota or capacity override. It cannot enable globally disabled kinds or models.
- Obey the bulletin's preferred and avoided kinds.
- Use `herdr-boss models` to inspect the configured model options.
- Treat `kit/models.json` as the source of truth for the machine allow-list.
- Choose a worker kind from task fit, current availability, quota, and evidence needs.
- Choose a low-cost lane for a small, fully specified task with a clear local gate.
- Choose a stronger lane for cross-cutting work, hard diagnosis, or costly rework risk.
- Choose a visual reviewer for work that needs visual judgment.
- Choose a browser-capable lane when the task requires a live browser.
- Do not route work to a model that the machine allow-list does not contain.
- Do not treat a successful launch as proof that a model is available for the task.
- Probe an unfamiliar lane with a harmless prompt before sending a long brief.
- Limit a shared cheap provider lane to two concurrent workers.
- Serialize work when two workers would edit the same shared module.
- Retry one provider overload on a different lane.
- Record the failed attempt before you redispatch unfinished work.
- Keep the brief, report, and worker files inside the worker worktree.
- Keep orchestrator files in the project scratch folder: source briefs, wait scripts, and project status files. Run `herdr-boss scratch <project-slug>` to create the folder and print its path. Do not use `/private/tmp` or `/tmp` for these files. macOS can delete files there.

## Starting a worker

- Verify `test "${HERDR_ENV:-}" = 1` before using Herdr commands.
- If the check fails, do not inspect or control Herdr.
- Label the orchestrator pane `orch` with `herdr pane rename "$HERDR_PANE_ID" orch`.
- Use a lowercase, unique worker name.
- Keep each name within the Herdr agent name limit.
- Use a separate Herdr tab named `Workers` for worker panes.
- Use separate worktrees for parallel changes.
- Give parallel changes separate branches and worktrees with independent scopes.
- Use one writer per shared module.
- Create the worker through the kit command:

```sh
herdr-boss worker start <name> --kind <kind> --task-file <file> --allow <path>
```

- Pass `--model` and `--effort` only when the route needs them.
- Pass `--issue` when the work belongs to a tracked issue.
- Pass `--base` only when the project needs a non-default base branch.
- Use `--no-worktree` only when the orchestrator has chosen shared-tree work. Each such worker gets its own `.worker/<name>/` folder for its brief and reports.
- Run `herdr-boss worker park <name> --reason TEXT` for a worker that waits on purpose, for example for the Owner. Idle notices then skip it. Run `worker unpark <name>` when it resumes.
- Use `--dry-run` to inspect a planned dispatch without starting it.
- Use `--force` only when the bulletin blocks a kind and the work must continue.
- Record why you overrode an avoided kind.
- Read the command result and verify the name, branch, worktree, pane, and brief.
- Check that the worker's pane uses the intended worktree before sending more instructions.
- Read [the worker brief template](../../templates/worker-brief.md) for the required fields.

## The brief contract

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
- Do not leave implicit paths, version assumptions, or acceptance criteria.
- List the decisions already made in the task, under the heading "Decisions already made". Workers do not reopen them.
- Set `testThreadsFlag` in `.herdr-boss.json` to the thread limit flag that works for the project's test runner. `worker start` puts it in every brief.
- Require the worker to report changed paths, commands, results, evidence tier, risks, and questions.
- Require the worker to write `.worker/report.md` and `.worker/report.json`.
- Use the JSON fields `issue`, `branch`, `worktree`, `changedPaths`, `commands`, `evidenceTier`, `unverified`, and `stoppedEarly`.
- Require a `WORKER REPORT` message when the worker finishes, fails, or stops early.
- Use the exact template slots in the [worker brief template](../../templates/worker-brief.md).

## Herdr control surface

- Use the installed Herdr CLI as the authority for command syntax and current state.
- Read `herdr status`, `herdr workspace list`, `herdr pane current --current`, `herdr pane list`, and `herdr agent list`.
- Parse IDs from command output.
- Never infer a pane, tab, workspace, or agent ID from its position in the UI.
- Use `herdr agent` commands for recognized agent lifecycle and prompts.
- Use `herdr pane` commands for shells and raw terminal control.
- Never run `herdr pane run` in a pane occupied by an agent.
- Create a pane with `--cwd <dir>` when it must start in another worktree.
- Send the complete brief only after the worker pane is ready.
- Wait for an agent instead of polling it.
- Use `herdr agent wait <name> --until idle --timeout <ms>` for long work.
- Use `herdr agent prompt <name> "<brief>" --wait --timeout <ms>` for short bounded work.
- Use `herdr pane wait-output <pane> --match <text>` when a command produces the event.
- Do not reread an unchanged pane in a loop.
- Use `herdr agent get` and `herdr agent read` to inspect a worker state or dialog.
- Read a blocked dialog before answering it.
- Use `herdr agent explain <name>` when state detection fails.
- Use `herdr notification show` only for information the human must see.
- Treat `working` as active work.
- Treat `blocked` as a question or approval dialog that needs inspection.
- Treat `idle` as ready for input, not as proof of completion.
- Treat `done` as an ended process, not as proof of a completed task.
- Treat `unknown` as unknown, not as completion.
- Require a report even when the worker is `idle` or `done`.
- Inspect the pane and worktree once after a timeout or silent stop.
- Retry only the remaining atomic objective.
- Keep workers warm for related work in the same worktree or evidence chain.
- Start a fresh worker for a different scope, worktree, or model fit.
- Close a worker pane after verification when no related task remains.
- Close only browser sessions that the worker owns.
- For project browser work, follow [the dedicated browser service](../../browser-service.md). Use [the shared-browser rules](../../shared-browser.md) only when a legacy shared session is explicitly assigned.
- Never stop the Herdr server or kill the main Herdr process to recover a worker.

## Worker completion signalling

- Require the worker to save both report files before sending its completion message.
- Require the worker to send its message without `--wait`.
- The message must name the worker, result, and report path.
- Use this command shape:

```sh
herdr agent prompt <orch-pane> "WORKER REPORT <name>: <done|blocked|stopped>. Report: <worktree>/.worker/report.md"
```

- Do not wait for the orchestrator pane to become idle before the worker reports.
- Read the full report from the worker worktree after receiving the message.
- If a worker forgets to report, inspect its pane after a specific wait expires.
- Do not accept an empty pane, exit code, or prose claim as a report.

## Reviewing a worker result

- Read `.worker/report.md` and `.worker/report.json`.
- Check the JSON fields and verify their values against the worktree.
- Read `git status --short`, `git diff --stat`, and the complete diff.
- Confirm that every changed path is allowed.
- Run the acceptance commands independently.
- Review generated artifacts directly.
- Read [the dedicated browser service](../../browser-service.md) before browser work. Use [the shared-browser rules](../../shared-browser.md) only for an explicitly assigned legacy session.
- Keep each evidence tier separate.
- Use the evidence tiers configured by the project. Set them in `evidenceTiers` in `.herdr-boss.json`; the kit rejects every other tier.
- Use `herdr-boss check --report <file>` to validate a worker report.
- Use `herdr-boss check --worktree <dir> --allow <path>` to check worktree scope.
- Use `herdr-boss worker collect <name>` after independent review.
- Record an outcome with `--record --outcome done|partial|failed` when ready.
- Record gate status with `--gate-passed` or `--gate-failed`.
- Record defect and rework counts when the review found them.
- Do not mark a failed gate as passed because a worker reports success.
- Return focused findings to the same warm worker when it can repair them safely.
- Re-run affected gates after every repair.

## Execution and review loop

- Read one frontier issue and all of its blockers.
- Read the linked specification, architecture decisions, current diff, and worktree state.
- Choose direct work or one bounded delegation.
- Prefer one complete vertical slice.
- Keep unrelated work out of the slice.
- Wait for the worker or perform the work directly.
- Inspect every changed path and the actual diff.
- Run the acceptance commands independently.
- Request a standards and specification review when the change needs one.
- Apply focused repairs and rerun affected checks.
- Update the issue with commands, results, evidence tier, remaining gaps, and the next frontier.
- Close an issue only after its acceptance criteria and evidence are satisfied.
- Do not hand the entire roadmap to one worker.

## Batching and shared modules

- Batch repeated work only when one mechanic truly applies across the batch.
- Name the allowed paths and acceptance commands for every batch.
- Keep per-item evidence visible inside the batch report.
- Mine existing tests and prior evidence before adding a new experiment.
- Keep one writer per shared module.
- Serialize work when multiple tasks change the same shared module.
- Use separate worktrees when parallel changes have independent owners.
- Inspect the full changed-path list before staging or integrating work.
- Do not narrow a commit so far that required new files are omitted.

## Machine load

- All projects share one machine. A full test suite usually starts one test thread per CPU core.
- Run at most one full suite per project at a time. Queue the next full suite until the current one ends.
- Tell workers to run focused tests while they work. Run the full suite yourself once per integration.
- Give every worker brief a thread limit of two for its test runner. The flag depends on the runner version and the configured pool; check it in the project first.
  - Vitest with the threads pool, or Vitest 3 and later: `vitest run --maxWorkers=2`.
  - Vitest 2 with the forks pool: `vitest run --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1`. `--maxWorkers=2` fails there with an unhandled error, and no tests run.
  - Record the form that works in the project's instructions.
- Read the machine load in the bulletin before each dispatch.
- Run `herdr-boss lanes` to see each quota provider in one line: open, ahead of pace, or near exhaustion. The line names the window that sets the state.
- A provider is ahead of pace when any live window will not last until its reset, also at low usage.
- Prefer an open provider. When every metered provider is ahead of pace, `worker start` allows the least-over provider without `--force`. Keep that task small.
- A quota window whose reset time has passed shows "reset, not yet measured" until the next reading. Do not use its old percentage as a reason for `--force`.
- When the 5-minute load is more than 2 × the core count, start no new worker and no full suite.

## Git and worktree hygiene

- The orchestrator owns Git topology and history.
- Inspect the branch, remotes, status, and diff before dispatching work.
- Preserve user-owned and unrelated changes.
- Use the project's branch naming convention.
- Give every active worker one named task, branch, worktree, and bounded scope.
- Do not switch a worker to another branch to make a check pass.
- Do not delete a worktree with unmerged or user-owned work.
- Do not use destructive reset, clean, force-push, or discard checkout as a shortcut.
- Require user authorization for pushes, deployments, and releases.
- Record the verified commit or uncommitted state before the next task.
- Use `herdr-boss worktree prune` to review stale worktrees.
- Inspect prune candidates before applying cleanup.
- Use `herdr-boss worktree prune --apply` only after verifying the candidates and their ownership.

## Run ledger and evidence tiers

- Record every delegated run in the configured run ledger.
- Use `herdr-boss worker collect <name> --record` to add a project usage event when the review is complete.
- Record measured token counts in `.worker/report.json` under `usage` when the harness provides them.
- Leave unknown token counts as `null`; do not estimate them from CodexBar percentages.
- Record failed, timed-out, abandoned, and successful runs.
- Record issue, model, surface, worktree, times, outcome, tool activity, changed paths, gate, defects, rework, and evidence tier.
- Append a run with `herdr-boss ledger append --entry <file>`.
- Check ledger records with `herdr-boss ledger check`. Add `--runs` to find run records with no ledger entry; run it before a handover and before you publish status.
- Treat the ledger as operational telemetry, not acceptance evidence.
- Use the evidence tiers configured by the project.
- Keep unit, integration, local-browser, hosted, and Owner evidence distinct when the project uses those tiers.
- Do not promote local tests to hosted, visual, accessibility, performance, commercial, hardware, or Owner proof.
- Mark every unverified tier in the report.
- Keep a red acceptance item red when its environment or human gate is unavailable.

## Herdr Boss notices and status

- Read `~/.herdr-boss/bulletin.md` before each new worker dispatch.
- Check your project on the Boss dashboard or in `herdr-boss policy show` when capacity, provider availability, or handover changes. The dashboard's Allocation view is the Owner's control plane; apply its saved worker cap, project share, exclusions, and succession ladder.
- Act on a `[herdr-boss]` notice that concerns your current work.
- Do not reply to the notice.
- Do not start work that the bulletin marks as avoided unless you use an allowed override.
- Publish project status through Herdr Boss.
- Request a dedicated persistent browser with `herdr-boss browser request <project-slug>` before browser work.
- Use the returned port and profile for that project. Do not stop another project's browser.
- Give browser workers the project slug and a tab ID. For simple screenshots, navigation, clicks, text, and keys, use [the project browser service](../../browser-service.md). Have the Owner enter credentials through the dashboard.
- Use the dedicated browser for your project. Port 9222 is only for a legacy shared session when the Owner explicitly assigns it. Coordinate tabs within your project and avoid stopping a browser another worker is using.
- When your harness quota threatens the orchestrator, run `herdr-boss handoff plan <your-pane> --to <kind>`.
- Use `handoff prepare` to start a successor. Review its output before `handoff activate <id> --confirmed`.
- Use `herdr-boss publish <slug> <file>` for a validated status file.
- Follow `docs/project-status.md` for the status schema.
- Update status at session start, worker completion, blockage, human gate, and session end.
- Do not build a separate project dashboard.
- Keep Herdr as live execution state and the issue tracker as durable work state.
- Keep the orchestrator pane labeled `orch` so Herdr Boss can find it.
- Use [the project section template](../../templates/agents-section.md) to install shared rules in a project `AGENTS.md`.
- Keep product contracts, acceptance commands, and project-specific browser procedures in the project files.

## Escalation and parking

- Escalate only when project documents and available evidence cannot settle the next action.
- Workers send decision questions to the orchestrator and then stop that decision path.
- The orchestrator owns any human escalation.
- Use an independent reviewer for reviewable human-gate evidence when project policy permits it.
- Escalate to the Owner when evidence and authorized review cannot settle the decision.
- Name the issue, artifact and version, exact human action, expected result, and response format.
- Keep unrelated work moving while the human action is pending.
- Record the parked frontier and exact resume point.
- Keep every unmet acceptance item red.
- Do not fabricate blockers or mark an unmet dependency complete.
- Review the parked frontier at each ticket boundary.
