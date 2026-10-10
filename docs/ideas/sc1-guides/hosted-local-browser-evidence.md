# Hosted and local-browser evidence

Label every result with the boundary it tested. A result at one boundary does not prove a different boundary.

## Evidence tiers

- Unit evidence covers local automated checks.
- Fixture evidence covers simulated host inputs.
- Local-browser evidence covers a local page in a browser.
- Hosted evidence covers the normal Qlik client or tenant surface.
- Owner evidence records an Owner decision.

Some repositories split hosted data checks from hosted UI checks. Keep those claims separate.

Sources: extension repo B, docs/evidence.md:3-18; extension repo C, docs/agents/QlikValidation.md:71-88; extension repo E, docs/agents/QlikValidation.md:102-110.

## What a local live page proves

A local live page can use a real Engine and real app data. It can verify drawing, theme, and selection behavior in that page.

It does not prove Qlik client chrome, the client property panel, snapshots, exports, or the packaged archive.

Record this result as local-browser evidence. Do not call it hosted evidence.

Sources: extension repo B, docs/serve-live.md:3-22; extension repo E, docs/agents/QlikValidation.md:112-130.

## What read-back proves

An archive read-back can prove that the tenant stores the same bytes as the local archive.

A structured qError sweep can prove that listed layouts have no unexpected Engine error.

Neither result proves visible pixels. Use the browser for rendering evidence.

Sources: extension repo B, docs/evidence.md:49-83.

## Current hosted gate

Check a published sheet that locks object properties. Make a property write fail with Access denied. Confirm that the chart still renders.

Source: extension repo B, docs/release/hosted-review.md:55-71.

## Record a check

Record the date, artifact version, tenant boundary, test action, result, and evidence file.

Record a failed or unreached step as failed or not reached. Do not promote local or fixture proof to hosted or Owner evidence.

Sources: extension repo E, docs/agents/QlikValidation.md:234-246.

## Tenant verification

Tenant verification for this guide is unverified.
