# Qlik Engine data and sessions

Use hypercube layouts and data pages as separate parts of an Engine result. Validate each page before rendering it.

## Read a hypercube

Read the layout first. Check for qError on the layout, hypercube, dimensions, and measures.

Treat qError as an error state. Treat an absent cube or empty role list as pending only when the extension contract permits it.

Read qDataPages in qArea.qTop order. Join each qMatrix only after you validate its window.

Sources: TmStackedVariance/src/data.ts:121-124, 163-174; TmVisualizationSuite/packages/qlik-viz-core/src/engine-pages.ts:153-171.

## Validate pages

Require qArea for real Engine pages. Check qTop, qLeft, qWidth, qHeight, matrix width, and returned row count.

Reject short, over-long, malformed, or mis-offset pages. Match the final row count to the requested range before you call the result complete.

The shared page validator makes these checks. It allows top-level coordinates only when a caller explicitly enables fixture fallback.

Sources: TmVisualizationSuite/packages/qlik-viz-core/src/engine-pages.ts:153-171, 181-262.

## Respect implementation limits

One extension reads at most 10,000 cells per page and 100,000 cells overall. It reports when the loaded rows are incomplete.

The shared suite helper keeps initial state pages below 10,000 cells and 500 rows.

These are implementation limits from specific repositories. They are not universal Qlik Engine limits.

Sources: TmStackedVariance/src/paging.ts:1-11, 23-55; TmVisualizationSuite/packages/qlik-viz-core/src/engine-pages.ts:67-78.

## Test load-script data

Use small, invented inline tables for controlled reload checks. Keep test fields separate when you need independent model tables.

Reload the app. Read the result through the documented app evaluation path. Compare its tables with expected files.

The Stacked Variance demo uses inline tables with no shared field names with its Facts table. The Process Mining verifier evaluates reloaded tables and compares them with expected data.

Sources: TmStackedVariance/docs/demo-app.md:160-170; TmProcessMining/docs/agents/QlikValidation.md:94-104; TmProcessMining/scripts/verify-script.mjs:14-17, 234-240.

## Manage selection sessions

Begin a selection session on the hypercube path when no session is active. Submit a hypercube-value selection.

Handle a missing host method, refused call, or rejected promise as a failed selection. Keep the chart render path alive.

Remove event listeners when the component ends. Clear selections after a local test because the session shares the signed-in user's app state.

Sources: TmStackedVariance/src/selection.ts:73-116; TmVisualizationSuite/docs/agents/QlikValidation.md:191-194.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. No Engine or session check ran for this guide task.

Source: .worker/inputs/sc1-inventory.md:203-205, 210.
