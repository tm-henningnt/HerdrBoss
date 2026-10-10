# Qlik Engine data and sessions

Use hypercube layouts and data pages as separate parts of an Engine result. Validate each page before rendering it.

## Read a hypercube

Read the layout first. Check for qError on the layout, hypercube, dimensions, and measures.

Treat qError as an error state. Treat an absent cube or empty role list as pending only when the extension contract permits it.

Read qDataPages in qArea.qTop order. Join each qMatrix only after you validate its window.

Sources: extension repo B, src/data.ts:121-124, 163-174; extension repo E, packages/qlik-viz-core/src/engine-pages.ts:153-171.

## Validate pages

Require qArea for real Engine pages. Check qTop, qLeft, qWidth, qHeight, matrix width, and returned row count.

Reject short, over-long, malformed, or mis-offset pages. Match the final row count to the requested range before you call the result complete.

The shared page validator makes these checks. It allows top-level coordinates only when a caller explicitly enables fixture fallback.

Sources: extension repo E, packages/qlik-viz-core/src/engine-pages.ts:153-171, 181-262.

## Respect implementation limits

One extension reads at most 10,000 cells per page and 100,000 cells overall. It reports when the loaded rows are incomplete.

The shared suite helper keeps initial state pages below 10,000 cells and 500 rows.

These are implementation limits from specific repositories. They are not universal Qlik Engine limits.

Sources: extension repo B, src/paging.ts:1-11, 23-55; extension repo E, packages/qlik-viz-core/src/engine-pages.ts:67-78.

## Test load-script data

Use small, invented inline tables for controlled reload checks. Keep test fields separate when you need independent model tables.

Reload the app. Read the result through the documented app evaluation path. Compare its tables with expected files.

The extension repo B demo uses inline tables with no shared field names with its Facts table. The extension repo C verifier evaluates reloaded tables and compares them with expected data.

Sources: extension repo B, docs/demo-app.md:160-170; extension repo C, docs/agents/QlikValidation.md:94-104; extension repo C, scripts/verify-script.mjs:14-17, 234-240.

## Manage selection sessions

Begin a selection session on the hypercube path when no session is active. Submit a hypercube-value selection.

Handle a missing host method, refused call, or rejected promise as a failed selection. Keep the chart render path alive.

Remove event listeners when the component ends. Clear selections after a local test because the session shares the signed-in user's app state.

Sources: extension repo B, src/selection.ts:73-116; extension repo E, docs/agents/QlikValidation.md:191-194.

## Tenant verification

Tenant verification for this guide is unverified.
