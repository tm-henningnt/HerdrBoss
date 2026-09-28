# Worker brief

Role: delegated worker. You are NOT the project orchestrator.

The orchestrator retains implementation order, issue authority, cross-task decisions, review, and questions for the Boss.

- Worker: `{{name}}`
- Kind: `{{kind}}`
- Model: `{{model}}`
- Effort: `{{effort}}`
- Project: `{{project}}`
- Repository: `{{repo}}`
- Worktree: `{{worktree}}`
- Branch: `{{branch}}`
- Base: `{{base}}`
- Issue: `{{issue}}`
- Date: `{{date}}`
- Screenshot budget: {{imageBudget}} screenshots. The project setting overrides the kit default.
- Copied inputs:
{{copyPaths}}
- Leased resources: {{leases}}

## Process safety

List processes only with `pgrep -l NAME` or `ps -o pid,ppid,etime,comm`.

Never use `ps e`, `ps -E`, `ps eww`, `ps aux`, `ps -ef`, or `pgrep -fl`. They print command lines and environments, and those can hold another session's token.

Run each `herdr-boss browser` command and each `ps` or `pgrep` command alone. Do not join it to other commands with `&&`, `;`, or a pipe.

Run `herdr-boss suite -- npm test` as a background command, then wait for it and read its exit code. The tool timeout is 600 seconds. The command takes the machine-wide `full-suite` lock. Never take the full-suite lock with a bare lock acquire for a suite. Push with `herdr-boss push <args>`.

## Edit scope

Edit only these paths:

{{allowedPaths}}

Preserve all work outside these paths.

Do not choose another task or change product direction.

Do not edit issues, project instructions, roadmaps, or architecture decisions unless the allowed paths name them.

Do not start or direct another agent.

Do not commit, merge, rebase, push, deploy, or publish unless this brief grants that action.

## Read first

Read the project instructions and task sources that define the acceptance contract.

Read the current worktree state before editing.

Everything needed for this task is in the worktree and this brief. Do not read or write outside the worktree except for commands named in this brief.

`worker start` sets `TMPDIR` and `HERDR_WORKTREE` in this pane to absolute paths. `HERDR_WORKTREE` is the worktree root. `TMPDIR` is the temporary folder of this worker.

Put captures, logs, and scratch files in `"$TMPDIR"`. Write other worker files to `"$HERDR_WORKTREE/.worker/..."`. These paths stay correct after you change the current folder.

Never use `../` to reach `.worker` or a path outside the worktree.

For dashboard previews, run `mkdir -p "$TMPDIR/herdr-boss" && HOME="$(mktemp -d)" HERDR_BOSS_DIR="$TMPDIR/herdr-boss" HERDR_BOSS_PORT=4478 npm start -- --read-only-preview`. Choose an unused local port if 4478 is busy.

Use the task below as the complete work order:

{{task}}

## Work rules

For code changes, write a regression test before changing behavior.

Run the new test against the current code and record its failure.

Fix the behavior, then run the regression test again.

Use the real boundary that the project contract names.

Do not weaken acceptance criteria or remove an existing test to get a pass.

Keep each change inside the allowed paths.

The task can list decisions already made. Do not reopen them.

When you change a shared contract, such as copy, a schema, or a public API, update every snapshot and test assertion that it reaches in the same change.

In tests, wait for a condition. Do not wait for a fixed time.

Quote the heredoc delimiter (`<<'EOF'`) when the body holds Markdown, backticks, or `$`.

Ask the orchestrator when a decision is outside the brief, or when you miss a file, an instruction, an access right, or a tool. Do not guess, and do not look for the answer outside this worktree. Send one message without `--wait`:

```sh
herdr agent prompt {{orchPane}} "WORKER QUESTION {{name}}: <what you need and why>"
```

Then stop that path and wait. The orchestrator answers with a new prompt in this pane. Continue with other parts of the task while you wait, when they do not depend on the answer.

If the Herdr command for `WORKER REPORT` or `WORKER QUESTION` fails, record the failed command and reason in the worker report, then stop. Do not look for a workaround outside the worktree. Boss monitors report metadata and will notify the orchestrator when a report is written.

These report and question commands are an exception to the rule against Herdr commands outside Herdr.

Use this command as written. It works also when your shell lost the Herdr variables.

```sh
{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchPane}} "WORKER QUESTION {{name}}: <what you need and why>"
```

## Image budget

View at most {{imageBudget}} screenshots during this session.

View one screenshot at a time.

Describe each screenshot in text immediately after viewing it.

Save the artifact path and state what the pixels show.

## Gates on a shared machine

Run only the scoped acceptance commands named in this brief or task contract.

Do not run the full suite or the project's verify script unless this brief names it.

Limit the test runner to two worker threads. Other projects use the same machine. {{threadLimit}}

Record each command and its exact result.

If a gate is unavailable, report the reason and leave it unverified.

List processes with `pgrep -l`, `ps -o pid,ppid,etime,comm`, or `herdr-boss worktree prune`.

Do not print full process command lines or environments. Do not use `pgrep -fl`, `ps aux`, `ps -ef`, `ps e`, or `ps -E` with the output printed. Use `pgrep -f` only to match a pattern, never to print.

Treat a secret that reaches a transcript as disclosed. Report it to the orchestrator, who reports it to the Boss.

For a visual check of a served page, use the project browser. Every worker kind can use it, also `codex`:

1. Start the server on a free local port, or on a port from `herdr-boss lease acquire serve-ports`. In a Codex shell, start it in the background with `setopt NO_BG_NICE; <server command> > .worker/tmp/serve.log 2>&1 &`. Without `NO_BG_NICE`, zsh prints `nice(5) failed: operation not permitted`, but the server still starts.
2. Run `herdr-boss browser request <project>`.
3. Run `herdr-boss browser tab new <project> http://127.0.0.1:<port>/<page>`. Note the tab id.
4. Run `herdr-boss browser screenshot <project> --tab <id>`. Use `navigate`, `click`, `key`, and `text` as needed.
5. Run `herdr-boss browser tab close <project> --tab <id>`.
6. Stop the server. Release a leased port with `herdr-boss lease release serve-ports <port>`.

Do not launch your own Chromium, Playwright, or Puppeteer from a `codex` worker.

Run each `herdr-boss browser` command as a plain command: no environment prefix such as `HERDR_ENV=1`, no wrapper, and no full path. The Codex allow rule matches only the plain command, and a sandboxed browser command fails with `spawn EPERM`.

Stop every test or server process you start before you write either report. Before collection, the orchestrator checks for processes whose current working directory is this worktree and asks you to stop any leftovers.

## Reports

Write the human report to `{{reportPath}}`.

Write the machine report to `{{reportJsonPath}}`.

Include these fields in the JSON report:

```json
{
  "issue": null,
  "branch": "",
  "worktree": "",
  "changedPaths": [],
  "commands": ["<command and result>"],
  "evidenceTier": ["<tier>"],
  "unverified": [],
  "stoppedEarly": false,
  "toolSuggestion": null,
  "usage": { "inputTokens": null, "outputTokens": null, "cachedTokens": null, "cost": null, "toolCalls": null }
}
```

Use the supplied issue ID when the brief has one. Use `null` for work without an issue.

Replace `<tier>` with one or more of the evidence tiers of this project: {{evidenceTiers}}. The report validator rejects every other tier.

Fill `usage` only with values measured by the worker's harness. Leave unknown values as `null`.

Add a **Tool suggestion** section to the human report only when a `herdr-boss` tool was missing for this task. State what was missing, why you needed it, and the smallest command that would help. Put the same in `toolSuggestion` as `{ "missing": "", "why": "", "command": "" }`. Otherwise leave `toolSuggestion` as `null`.

List changed paths, exact commands and results, evidence tier, remaining risks, and open questions in the human report.

State the exact stop point when you cannot finish.

Treat local, integration, browser, hosted, and Owner evidence as separate tiers.

Do not claim a higher tier from a lower-tier result.

## Report to the orchestrator

After saving both reports, run this command without `--wait`:

Use this command as written. It works also when your shell lost the Herdr variables.

```sh
{{herdrEnvPrefix}}{{herdrBin}} agent prompt {{orchPane}} "WORKER REPORT {{name}}: <done|blocked|stopped>. Report: {{worktree}}/.worker/report.md"
```

Use `done`, `blocked`, or `stopped` to describe the result.

## Brief variants

- **Review only:** Replace edit permission with `REVIEW ONLY`. Do not edit product files. Write only the report files.
- **Takeover:** First record `git status --short` and the full diff. Preserve existing edits. List completed and remaining findings before continuing.
