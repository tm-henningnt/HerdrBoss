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
| Theme creation returns 422 RL-422-001 | A theme archive was sent through extension creation. | Use qlik theme create or qlik theme patch for a theme artifact. |
| Live page cannot start | The port is in use, no leased port is available, or the second OAuth client is absent for that port range. | Acquire a permitted port lease. Free only a port you own. Check the project's local setup without printing credentials. |
| Chart reports that it is too small | The object has insufficient width or height for the chart content. | Increase the object size. Recheck long labels and segment counts. |
| Read-back matches but chart is blank | Archive byte equality does not prove that the chart renders. | Open the object in the normal Qlik client and inspect its layout and render state. |

## Sources

- Extension repo C's tenant defect guide describes defect patterns.
- Extension repo C's validation guide defines Qlik checks.
- Extension repo C's data quality guide covers data defects.
- Extension repo C's visualization guide covers chart defects.
- Extension repo B's data module reads Engine data.
- Extension repo B's paging module validates page results.
- Extension repo B's selection module handles selections.
- Extension repo B's serving guide documents local startup.
- Extension repo B's verification guide documents project checks.
- Extension repo B's demo guide documents exports.
- Extension repo B's evidence guide describes evidence limits.
- Extension repo D's development guide describes local setup.
- Extension repo A's development guide describes local setup.
- Extension repo A's user guide describes usage.
- Extension repo E's validation guide documents hosted checks.
- Extension repo E's sweep tool reads Qlik error results.

## Fix order

1. Confirm the intended app and context.
2. Read the failing object or table.
3. Fix the smallest cause that matches the evidence.
4. Read back the changed object.
5. Recheck the boundary that failed.

Do not report a hosted fix after a local check alone.

## Tenant verification

Tenant verification for this guide is unverified.
