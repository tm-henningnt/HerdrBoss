# Hosted and local-browser evidence

Label every result with the boundary it tested. A result at one boundary does not prove a different boundary.

## Evidence tiers

- Unit evidence covers local automated checks.
- Fixture evidence covers simulated host inputs.
- Local-browser evidence covers a local page in a browser.
- Hosted evidence covers the normal Qlik client or tenant surface.
- Owner evidence records an Owner decision.

Some repositories split hosted data checks from hosted UI checks. Keep those claims separate.

Sources: TmStackedVariance/docs/evidence.md:3-18; TmProcessMining/docs/agents/QlikValidation.md:71-88; TmVisualizationSuite/docs/agents/QlikValidation.md:102-110.

## What a local live page proves

A local live page can use a real Engine and real app data. It can verify drawing, theme, and selection behavior in that page.

It does not prove Qlik client chrome, the client property panel, snapshots, exports, or the packaged archive.

Record this result as local-browser evidence. Do not call it hosted evidence.

Sources: TmStackedVariance/docs/serve-live.md:3-22; TmVisualizationSuite/docs/agents/QlikValidation.md:112-130.

## What read-back proves

An archive read-back can prove that the tenant stores the same bytes as the local archive.

A structured qError sweep can prove that listed layouts have no unexpected Engine error.

Neither result proves visible pixels. Use the browser for rendering evidence.

Sources: TmStackedVariance/docs/evidence.md:49-83.

## Current hosted gate

Check a published sheet that locks object properties. Make a property write fail with Access denied. Then confirm that the chart still renders.

The Owner accepted this hosted gate for a user without edit rights on 2026-10-09 (Owner decision through the Boss). Keep the managed-space viewer check open until a test user exists.

The hosted gate does not close the managed-space viewer check.

Source: .worker/inputs/sc1-inventory.md:11-15; TmStackedVariance/docs/release/hosted-review.md:55-71.

## Record a check

Record the date, artifact version, tenant boundary, test action, result, and evidence file.

Record a failed or unreached step as failed or not reached. Do not promote local or fixture proof to hosted or Owner evidence.

The task inventory is dated 2026-10-09. It says no tenant check ran for this guide build.

The historical hosted-client review is dated 2026-10-02. It is historical evidence, not current verification.

Sources: .worker/inputs/sc1-inventory.md:203-205; TmStackedVariance/docs/release/hosted-review.md:41-53; TmVisualizationSuite/docs/agents/QlikValidation.md:234-246.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. No tenant check ran for this guide task.

The published locked-sheet check is the current hosted gate (Owner decision of 2026-10-09). The managed-space viewer check remains open until a test user exists.

Source: .worker/inputs/sc1-inventory.md:11-15, 203-205.
