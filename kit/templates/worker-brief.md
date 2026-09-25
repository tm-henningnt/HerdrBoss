# Worker brief

Role: delegated worker. You are NOT the project orchestrator.

The orchestrator retains implementation order, issue authority, cross-task decisions, review, and human escalation.

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

Read the Herdr Boss bulletin at `{{bulletinPath}}`.

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

Ask the orchestrator when a decision is outside the brief.

Stop that decision path while you wait for an answer.

## Image budget

View at most 10 screenshots during this session.

View one screenshot at a time.

Describe each screenshot in text immediately after viewing it.

Save the artifact path and state what the pixels show.

## Gates on a shared machine

Run only the scoped acceptance commands named in this brief or task contract.

Do not run the full suite or the project's verify script unless this brief names it.

Limit the test runner to two worker threads. Other projects use the same machine. {{threadLimit}}

Record each command and its exact result.

If a gate is unavailable, report the reason and leave it unverified.

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
  "usage": { "inputTokens": null, "outputTokens": null, "cachedTokens": null, "cost": null, "toolCalls": null }
}
```

Use the supplied issue ID when the brief has one. Use `null` for work without an issue.

Replace `<tier>` with one or more of the evidence tiers of this project: {{evidenceTiers}}. The report validator rejects every other tier.

Fill `usage` only with values measured by the worker's harness. Leave unknown values as `null`.

List changed paths, exact commands and results, evidence tier, remaining risks, and open questions in the human report.

State the exact stop point when you cannot finish.

Treat local, integration, browser, hosted, and Owner evidence as separate tiers.

Do not claim a higher tier from a lower-tier result.

## Report to the orchestrator

After saving both reports, run this command without `--wait`:

```sh
herdr agent prompt {{orchPane}} "WORKER REPORT {{name}}: <done|blocked|stopped>. Report: {{worktree}}/.worker/report.md"
```

Use `done`, `blocked`, or `stopped` to describe the result.

## Brief variants

- **Review only:** Replace edit permission with `REVIEW ONLY`. Do not edit product files. Write only the report files.
- **Takeover:** First record `git status --short` and the full diff. Preserve existing edits. List completed and remaining findings before continuing.
