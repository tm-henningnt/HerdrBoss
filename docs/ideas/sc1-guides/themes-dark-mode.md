# Themes and dark mode

Read the host theme at render time. Use explicit fallback values when the host has no usable value.

## Read host theme values

Use the theme API to read styles, palettes, and special colors. Validate each value before using it.

Use a theme palette that supports the number of series. Keep a fallback for missing palettes.

The Stacked Variance theme adapter reads host styles, fonts, and data-color palettes. The Gantt adapter also defines fallback colors and palette selection.

Sources: TmStackedVariance/src/theme.ts:1-8, 50-67, 89-103; TmGantt/src/render/theme.ts:1-8, 22-60, 63-92.

## Add author controls

Place user-facing appearance controls in the Styling panel. Let the theme supply values that the author has not changed.

Check color, text, grid, font, axis, legend, and background values in both light and dark themes.

Sources: TmStackedVariance/src/definition.ts:98-132; TmHeatGrid/docs/development.md:239-250.

## Package a custom theme

A Qlik theme is a theme artifact. Do not upload it as an extension.

The documented commands create and update a theme:

    qlik theme create --file <theme-archive>
    qlik theme patch <theme-id> --file <theme-archive>

Package a test theme from its repository source. Do not copy theme values into this guide.

Source: TmVisualizationSuite/docs/agents/QlikValidation.md:248-253.

## Check dark mode

Use the local live page to check the chart with real Engine data. Record this as local-browser evidence.

Use the normal Qlik client to check client chrome, panel controls, and hosted theme behavior. Record the artifact version and test date.

Historical tenant report: the hosted-client run dated 2026-10-02 reports passing light and dark tenant themes after reload. Its earlier 2026-10-01 review has checks that were not reached.

Sources: TmStackedVariance/docs/release/hosted-review.md:3-20, 41-53; TmStackedVariance/docs/serve-live.md:3-22.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. The accepted inventory says it did not run a tenant check.

Historical theme evidence is limited to the dated report above. It does not verify the current tenant or extension version.

Source: .worker/inputs/sc1-inventory.md:203-205.
