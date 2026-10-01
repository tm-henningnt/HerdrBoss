# Run ledger and evidence tiers

Read this file when you record a worker run, check the ledger, or decide which evidence a gate needs.

## Run ledger

- Record every delegated run in the configured run ledger.
- Use `herdr-boss worker collect <name>` to add a project usage event when the review is complete.
- Run `herdr-boss worker collect <name> ...` after independent review and before merging the worker branch.
- Record an outcome with `--outcome done|partial|failed` when ready.
- Record gate status with `--gate-passed` or `--gate-failed`.
- Record defect and rework counts when the review found them.
- `worker collect` uses the approved paths and copies the approval history into the ledger entry.
- Collection records by default. Use `--no-record` only for a dry read of the report.
- Record measured token counts in `.worker/report.json` under `usage` when the harness provides them.
- Leave unknown token counts as `null`; do not estimate them from CodexBar percentages.
- Record failed, timed-out, abandoned, and successful runs.
- Record issue, model, surface, worktree, times, outcome, tool activity, changed paths, gate, defects, rework, and evidence tier.
- Append a run with `herdr-boss ledger append --entry <file>`.
- Check ledger records with `herdr-boss ledger check`. Add `--runs` to find run records with no ledger entry; run it before a handover and before you publish status.
- Treat the ledger as operational telemetry, not acceptance evidence.

## Evidence tiers

- Use the evidence tiers configured by the project. Set them in `evidenceTiers` in `.herdr-boss.json`; the kit rejects every other tier.
- Keep each evidence tier separate. Keep unit, integration, local-browser, hosted, and Owner evidence distinct when the project uses those tiers.
- Do not promote local tests to hosted, visual, accessibility, performance, commercial, hardware, or Owner proof.
- Do not mark a failed gate as passed because a worker reports success.
- Keep per-item evidence visible inside the batch report.
- Mine existing tests and prior evidence before adding a new experiment.
- Mark every unverified tier in the report.
- Keep a red acceptance item red when its environment or human gate is unavailable.
- Use an independent reviewer for reviewable human-gate evidence when project policy permits it.
