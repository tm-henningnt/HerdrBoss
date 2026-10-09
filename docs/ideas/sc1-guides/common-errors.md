# Common errors and fixes

Use the error message and the failed boundary to select a fix. Read the affected object again after each change.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| qError appears in a layout | The Engine reports an error on the layout, cube, dimension, or measure. | Read every qError location. Return an error state and keep the code visible in diagnostics. |
| Page data is missing or incomplete | The page is too large, malformed, mis-offset, or short. | Check qArea, qTop, qLeft, qWidth, qHeight, matrix width, and row count. Request fewer cells. |
| Engine reports qErrorCode 7009 | A hypercube page exceeds the Engine page-cell limit described by the defect guide. | Reduce cells per request. Derive page height from cube width. |
| Selection appears to succeed but nothing changes | The selected value may not exist or the host may reject the selection. | Read available field values first. Check the selection result and read current selections again. |
| Reload succeeds but the data is wrong | A clean reload does not prove correct model output. | Read back every expected table and compare it with a golden file. |
| Load script reports Invalid expression | Scalar Max or Min may be used as aggregation without GROUP BY. | Use RangeMax or RangeMin for scalar values. Add GROUP BY only when aggregation is intended. |
| Theme creation returns 422 RL-422-001 | A theme archive was sent through extension creation. | Use qlik theme create or qlik theme patch for a theme artifact. Reported in TmProcessMining/docs/agents/TenantDefectPatterns.md with no date; not verified for this guide. |
| App creation returns 403 Forbidden | The app create request uses the word personal as a space ID. | Use a valid space ID. Reported in TmProcessMining/docs/agents/TenantDefectPatterns.md with no date; not verified for this guide. |
| Live page cannot start | The port is in use, no leased port is available, or the second OAuth client is absent for that port range. | Acquire a permitted port lease. Free only a port you own. Check the project's local setup without printing credentials. |
| Chart reports that it is too small | The object has insufficient width or height for the chart content. | Increase the object size. Recheck long labels and segment counts. |
| Read-back matches but chart is blank | Archive byte equality does not prove that the chart renders. | Open the object in the normal Qlik client and inspect its layout and render state. |

Sources: TmProcessMining/docs/agents/TenantDefectPatterns.md:9-35; TmProcessMining/docs/agents/QlikValidation.md:73-88, 94-104; TmStackedVariance/src/data.ts:163-174; TmStackedVariance/src/paging.ts:1-11, 23-55; TmStackedVariance/src/selection.ts:92-108; TmStackedVariance/docs/serve-live.md:41-49; TmStackedVariance/docs/demo-app.md:111-113; TmStackedVariance/docs/evidence.md:49-83; TmVisualizationSuite/docs/agents/QlikValidation.md:248-266; active Qlik MCP tool descriptions observed on 2026-10-10.

## Fix order

1. Confirm the intended app and context.
2. Read the failing object or table.
3. Fix the smallest cause that matches the evidence.
4. Read back the changed object.
5. Recheck the boundary that failed.

Do not report a hosted fix after a local check alone.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. The accepted inventory says it did not run a tenant check.

The historical reports cited above are not a current reproduction of these errors or fixes.

Source: .worker/inputs/sc1-inventory.md:203-205.
