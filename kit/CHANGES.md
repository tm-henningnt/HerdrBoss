# Kit change log

This file is the fallback record of kit changes. A commit that changes kit
assets can carry a `Kit-Impact:` trailer instead. The notice code reads both
sources to classify each change.

## Format

Each entry starts with a level-two heading that holds the kit revision that
the change produced. The entry has an `Impact:` line and a `Summary:` line.

    ## <revision>
    Impact: <required|useful|none>
    Summary: <one line>

Entries are chronological. The oldest entry is first. A project whose kit
revision matches an entry has that entry and every earlier entry.

## Entries

## 883095fbe869
Impact: required
Summary: Compute the kit revision from installed kit assets only.

## d5a3318be296
Impact: useful
Summary: Add gpt-6.1-sol as the trial Codex model for tougher tasks; gpt-6-luna stays the routine default; remove gpt-6-sol.

## 51683b8cf0ee
Impact: useful
Summary: Add editable Watch routine texts (kit/watch) that the service runs during a watch.

## 9ca9a9ebf4a8
Impact: useful
Summary: Carry the Owner /goal over in an orchestrator handover.

## 4f7a0c699512
Impact: useful
Summary: Add a blocking herdr-boss wait for the few cases that must block.

## 60049d639ff0
Impact: useful
Summary: Tell orchestrators to start workers with --task-id so the board shows live task state.

## c13020178b65
Impact: required
Summary: Add the subagent and no-watching rule (subagents for reviews and reads, end the turn after a dispatch, at most one check every 20 to 30 minutes); a Kit updated notice now means run kit update and continue.

## 7436456f91aa
Impact: useful
Summary: Publish the project status at task boundaries only; the service keeps the last 30 done tasks and counts the rest.

## f73a93f04e11
Impact: useful
Summary: GUI worker briefs say that seed data goes only into a temporary HERDR_BOSS_DIR, and that the preview runs read-only on its own port.

## 084656db38fb
Impact: useful
Summary: Worker briefs address the orchestrator by its stable agent name, and a handover tells each running worker the new orchestrator.

## b966d46c47d7
Impact: useful
Summary: Add the AGENTS.md project part and README templates for the new project flow.

## 87289067cf70
Impact: useful
Summary: A lane is ahead of pace only above a tolerance (default 5 points) and a minimum use (default 30%); the lanes line shows the tolerance.

## fdcccc24dac7
Impact: useful
Summary: Add herdr-boss gh label create|list|edit|sync and gh milestone create|list, the triage label preset, and the triage-labels template; project new sets the triage labels on a private GitHub repository.

## 17e04d97cd66
Impact: useful
Summary: Serve-port leases end when the bound server process ends or the port has no listener for 20 minutes; lease acquire takes --pid, --wait, and --env-file, lease bind binds a server, and a pool can hand a client ID by port.

## e4591d0a3d3d
Impact: useful
Summary: Add the review pack section to the orchestrator skill and the worker brief template.

## 315d28e0a176
Impact: useful
Summary: The worker brief forbids sleep loops and until or while polling and names herdr-boss wait; the orchestrator skill sends a reviewer the same rule and a temporary HOME and HERDR_BOSS_DIR.

## 1b34ccad1bca
Impact: useful
Summary: A serve-live server binds its PID to its lease at start with lease bind, so Herdr Boss can tell its port from an unleased listener.

## 60d55aa14e84
Impact: useful
Summary: Add the picture line to the orchestrator skill and the project kit: send a picture with herdr-boss say --image, and read an Owner Attachment path with the image tool.

## 2ce7a7451a5e
Impact: useful
Summary: Keep the Boss reporting rule and send reports with herdr-boss tell.

## 0d84a561a0cf
Impact: useful
Summary: Codex workers attach the Chrome DevTools MCP to the project browser. The worker brief gets rules for browser tasks: own tab only, close the tab, no cookies, storage, or tokens.

## 3ffd68a69e47
Impact: required
Summary: Add CI minute rules and GitHub workflow templates; create and copy missing project workflows.

## 2db88201b003
Impact: useful
Summary: Use default worker collection recording in kit and command documentation.

## 89d669ba137a
Impact: useful
Summary: Allow read-only research in other Herdr Boss projects and add the project paths command.

## 8708369d28dd
Impact: useful
Summary: Require review packs to report interaction evidence, app steps, human decisions, and an independent design pass.

## dfe6fcc602e2
Impact: useful
Summary: Document review-pack item types, ask values, and evidence rules in the orchestrator reference.

## 90f73eb6c2f1
Impact: useful
Summary: Integrate: combine the collect default, the read-only research rule, and the review pack rules into one kit revision.

## fe8a51e665fd
Impact: useful
Summary: Browser output masks titles and removes credentials, query strings, and fragments in every host mode. Apply the same filter to browser API responses, dashboard state, and new event log records.

## 38b0c2cd2398
Impact: useful
Summary: Refresh lock wait lines with holder age and predicted end. Send one slow-holder notice to the Boss. Detect zombie holders with a recorded process start. The cause of the reported 45-minute wait remains unverified.

## 8efc9e5ccec6
Impact: useful
Summary: Bound agent prompt delivery and document the file-path pattern for long prompts.

## 2ac9048be57b
Impact: useful
Summary: Wait for browser commands and CDP clients before restart. Restore saved tabs in separate windows and read their new IDs.

## 00073aec20c4
Impact: useful
Summary: Integrate: browser output redaction with the current kit text.

## f41d3a0b4d1e
Impact: useful
Summary: Restore drops query strings and fragments. Login and callback pages are not saved or restored. Pages that need query strings or fragments reopen at their path.

## 91ddc9504e48
Impact: useful
Summary: Show the PID state of a slow lock holder. Find the Boss by agent name. Keep the delivered notice marker during mutation contention. Limit wait prediction reads to 512 KB per ledger file. The historical wait cause remains a hypothesis.

## c1ca454f9191
Impact: useful
Summary: Restore excludes authentication path prefixes and sign-in hosts. It removes path parameters and rejects paths with invalid or excessive encoding.

## b90d8cbfe22d
Impact: required
Summary: Record approved worker scope and the full branch diff during collection.

## e7194c41b551
Impact: useful
Summary: Integrate: browser restart and health, lock wait status, tell timeouts, worker scope, and collect cwd with the current kit text.

## 63a8014b2a45
Impact: useful
Summary: Write shared catalogue findings to per-worker files and run long gates through the suite command with a 60-minute lock wait and command timeout.

## 0084129d473c
Impact: useful
Summary: Detect Did you mean this, not available in your country and Rate limit exceeded at an opencode launch, mark the model unavailable and fall back; add trial models with a trial tag; new models enable and disable commands.

## 591e80a2bfbe
Impact: useful
Summary: Publish the status with --sync at task boundaries, so the card states come from git, workers and issues.

## 7aa9adf4d8a8
Impact: useful
Summary: Never prune or remove Docker resources on a shared daemon unless they carry the label herdr-factory-spike=<worker>; use a dedicated builder or context.

## 2e0a5d394ccc
Impact: useful
Summary: Start each worker task with a plain title (what, for which ticket), because the Agents page shows it as the worker title.

## 1c6764de0c20
Impact: useful
Summary: Give every review item that needs a decision accept and deny, agent-verified items included; an item with only note in ask is information and never counts as open.

## a525a7ad7655
Impact: useful
Summary: Add the docs rule: a change of behavior changes the docs and the page help in the same branch, or records a Docs-Exempt reason; the worker brief, the review task rules, and the review-pack evidence rule carry it.

## 4facf6b20cc0
Impact: useful
Summary: Shorten the review pack rules in the orchestrator skill to stay within the word limit; the content is the same as in revisions 1c6764de0c20 and a525a7ad7655.

## 96799c500e9a
Impact: useful
Summary: Replace "There is no load threshold" with the lock lane guard rule: a queued short-lane job waits while the 5-minute load is above 231 percent of the cores, set in Settings, Locks (`locks.guard`).

## fa883d81b25f
Impact: useful
Summary: Add `worker collect --accept-scope FILE[,FILE] --reason TEXT`, which passes only the listed files outside the allowed scope and records the files and the reason as a Scope exception.

## 5eff27364fa1
Impact: useful
Summary: List each project's accepted evidence tiers in worker briefs and collect refusals.

## c1889c2b6d7c
Impact: useful
Summary: Keep kit-managed files and paths that arrived only from a merge of the base branch out of the worker collect scope check, and name a leftover process by PID and command name only.

## caac14d2ce06
Impact: useful
Summary: Ban `git stash`, `git reset`, and `git checkout` of any path or branch in read-only worker briefs and review task rules; read-only workers use `git show`, `git diff`, and `git log` only.

## 95184d586fff
Impact: useful
Summary: Read-only worker briefs ban `git stash`, `git reset`, and `git checkout`. The worker collect scope check skips kit-managed files and merge-from-base paths and names a leftover process by PID and command name only. The OpenCode TUI starts with a project config instead of flags that the v2 TUI rejects.

## 260531d896e4
Impact: useful
Summary: Add `worker stop-own NAME --pid PID` for a Codex worker to stop its own process without a raw signal, and `worker commit NAME -m MESSAGE` for the orchestrator to commit a Codex worker change that stays in the working tree; `worker commit` refuses a secret-bearing path and every path under `.worker/` or `.orchestration/`, and it strips control characters from the message and limits it to 2000 characters; the Codex worker brief carries both rules, and `worker collect` accepts an uncommitted Codex worker.

## 32b5295c1ca9
Impact: useful
Summary: The kit update line for a useful-only change is optional to act on now and waits for the next task boundary; a required change keeps the direct line. The Opus refusal names the setting that controls it and drops `--force`. The worker brief forbids a load generator, a stress test, a benchmark loop, and a parallel test run beyond the test thread flag.

## e90c411a41ac
Impact: useful
Summary: Add the status review step: rewrite the published phase and summary at each publish and remove an Owner wait when no Mailbox item is open; Herdr Boss sends one stale text notice when a field keeps the same text for staleTextMinutes (default 360).

## 527ed9a6f196
Impact: useful
Summary: Send `suite finished: exit N` to the calling pane when a `herdr-boss suite` command runs and ends and that pane is idle or done; add `--no-notify`; a `--reuse` or `--skip-docs` run sends no notice; the kit text says to start a suite with the harness background option or rely on the notice, and never to end a turn while a detached suite runs.
