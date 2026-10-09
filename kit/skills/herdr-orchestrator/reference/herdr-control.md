# Herdr control surface

Read this file before you inspect or control Herdr panes and agents, when a worker state is not clear, before you start a worker, and before browser work.

## Commands

- Use the installed Herdr CLI as the authority for command syntax and current state.
- Read `herdr status`, `herdr workspace list`, `herdr pane current --current`, `herdr pane list`, and `herdr agent list`.
- Parse IDs from command output.
- Never infer a pane, tab, workspace, or agent ID from its position in the UI.
- Use `herdr agent` commands for recognized agent lifecycle and prompts.
- The report and question commands in a worker brief are an exception to the rule against Herdr commands outside Herdr. Workers must use those commands as written. The commands include the caller's Herdr environment.
- Use `herdr pane` commands for shells and raw terminal control.
- Never run `herdr pane run` in a pane occupied by an agent.
- Keep all worker panes in the worker tabs of the verified caller workspace. Give each worker pane `--cwd <dir>` for the worker worktree.
- Send the complete brief only after the worker pane is ready.
- Use `herdr notification show` only for information the human must see.
- Never stop the Herdr server or kill the main Herdr process to recover a worker.

## Worker tabs and start options

- Put each worker in a pane of a worker tab in the verified caller workspace. The worker tabs have the labels `Workers`, `Workers 2`, `Workers 3`, and so on. A worker tab holds at most 3 worker panes. The project setting `workerPanesPerTab` changes this limit.
- `herdr-boss worker start` uses the first worker tab in label order with a free slot. It splits the new pane from the newest pane in that tab. When all worker tabs are full, it creates the tab with the lowest free label, and the worker uses its root pane.
- Pass `--model` and `--effort` only when the route needs them.
- Pass `--issue` when the work belongs to a tracked issue.
- Pass `--base` only when the project needs a non-default base branch.
- Use `--dry-run` to inspect a planned dispatch without starting it.
- Use `--no-worktree` only when the orchestrator has chosen shared-tree work. Each such worker gets its own `.worker/<name>/` folder for its brief and reports.
- Run `herdr-boss worker park <name> --reason TEXT` for a worker that waits on purpose, for example for the Owner. Idle notices then skip it. Run `worker unpark <name>` when it resumes.

## Worker commit and stop

- A Codex worker cannot write the shared Git metadata, so it leaves its change in the working tree and says so in its report. After review, commit the change from the orchestrator side with `herdr-boss worker commit <name> -m MESSAGE`. The command stages the changed paths inside the worker scope and refuses every path outside it. It also refuses a secret-bearing path and every path under `.worker/` or `.orchestration/`. Inspect the full diff first.
- A Codex worker stops a process that it started with `herdr-boss worker stop-own <name> --pid PID`. The command stops the PID only when the process is a descendant of the worker pane shell or its current directory is inside the worker worktree. It refuses every other PID, the worker pane shell, the shared Codex app-server, and the caller's own process tree. It prints only the PID and the command name. A Codex worker must never run `kill`, `pkill`, or `killall`. The Codex rules file must hold the allow rule `prefix_rule(pattern=["herdr-boss", "worker", "stop-own"], decision="allow")` for the command. `herdr-boss harness check` reports the rule when the rules file has no active exact allow rule, names the file, and prints the line to add. Run `herdr-boss harness sync` to add it. An exact forbidden rule for the command, or an allow rule with a forbidden rule, is a conflict: the check reports `bad`, and `harness sync` writes nothing.

## Waiting

- After a dispatch, end the turn. The worker sends a `WORKER REPORT` or `WORKER QUESTION` message.
- Run `herdr-boss wait [<worker>...] [--timeout SECONDS]` as a background command only when you must block. It prints `<worker> <reason>` for the first event and exits with a code for the reason: 0 report, 10 question, 11 blocked, 12 stalled, 13 gone, 75 timeout. With no worker name it waits on all unfinished workers of the project.
- Wait for an agent instead of polling it.
- Use `herdr agent wait <name> --until idle --timeout <ms>` for long work.
- Use `herdr agent prompt <name> "<brief>" --wait --timeout <ms>` for short bounded work.
- Use `herdr pane wait-output <pane> --match <text>` when a command produces the event.
- Do not reread an unchanged pane in a loop.

## Agent states

- Use `herdr agent get` to inspect a worker state.
- Read a worker dialog or screen with `herdr agent read <name> --source recent-unwrapped`. This source joins wrapped lines. Do not reject a dialog because the pane is narrow.
- Read the complete worker dialog before answering it. If the full dialog is not readable, reject it and let the worker ask through `WORKER QUESTION`.
- Use `herdr agent explain <name>` when state detection fails.
- Treat `working` as active work.
- Treat `blocked` as a question or approval dialog that needs inspection.
- Treat `idle` as ready for input, not as proof of completion.
- Treat `done` as an ended process, not as proof of a completed task.
- Treat `unknown` as unknown, not as completion.
- Require a report even when the worker is `idle` or `done`.

## Recovery and reuse

- Inspect the pane and worktree once after a timeout or silent stop.
- Retry only the remaining atomic objective.
- Keep workers warm for related work in the same worktree or evidence chain.
- Start a fresh worker for a different scope, worktree, or model fit.
- Close a worker pane after verification when no related task remains.

## Project browser

- Read [the dedicated browser service](../../../browser-service.md) before browser work.
- Request a dedicated persistent browser with `herdr-boss browser request <project-slug>` before browser work.
- Use the returned port and profile for that project. Do not stop another project's browser.
- Use only the dedicated browser of your project.
- Coordinate tabs within your project and avoid stopping a browser another worker is using.
- Give browser workers the project slug and a tab ID. For simple screenshots, navigation, clicks, text, and keys, use [the project browser service](../../../browser-service.md).
- Have the Owner enter credentials through the dashboard.
- For dashboard and web checks, prefer the project browser: `herdr-boss browser request <slug>`, then `browser tabs`, `browser tab new`, and `browser screenshot`.
- Never launch your own Chrome, agent-browser, Playwright, or chrome-devtools from a worker or project lead. Attach to the project browser with `herdr-boss browser` and its CDP port.
- Close only browser sessions that the worker owns.
- Close Chrome with `herdr-boss browser close <slug>` or CDP `Browser.close`. Never send a signal to Chrome yourself.
- When a worker changed a file outside its scope and the orchestrator approved that file by message, run `herdr-boss worker collect <name> --accept-scope FILE[,FILE] --reason TEXT`. Use it only for files that you reviewed. The command passes only the listed outside files, refuses every other outside file, and records the files and the reason as a Scope exception in the run record and the printed report.
- A scope refusal names the unlisted files and shows the exact allowed command form with an example. The example lists every unlisted file, comma separated, and shell-quotes the `--accept-scope` value. Copy the example and write the real reason in `--reason`.
- `worker collect` does not count a kit-managed file, the worker's `.worker/` folder, or a path that arrived only because the worker merged the base branch into its branch as a change outside the scope. Use `--accept-scope` only for a real product change outside the scope.

## Bundles

- Bundle related issues into one worker brief. Group by the same files, the same area, or the same check. Give the worker a list of issues with an acceptance check for each. Aim for a worker that runs a substantial piece of work, not minutes.
- Keep a bundle reviewable: one coherent diff, one review pass, one merge. Do not bundle across unrelated areas or across a gate boundary.
- Give each issue in a bundle its own tracker reference and its own evidence. After TR1, `worker start` takes more than one `--issue`.
- Tell the worker to use subagents for reads, surveys, and review, and to keep the main thread for decisions. Use cheap models for subagents (Haiku for read-only work) while Claude is throttled.
