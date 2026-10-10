# Themes and dark mode

Read the host theme at render time. Use explicit fallback values when the host has no usable value.

## Read host theme values

Use the theme API to read styles, palettes, and special colors. Validate each value before using it.

Use a theme palette that supports the number of series. Keep a fallback for missing palettes.

The extension repo B theme adapter reads host styles, fonts, and data-color palettes. The extension repo A adapter also defines fallback colors and palette selection.

Sources: extension repo B, src/theme.ts:1-8, 50-67, 89-103; extension repo A, src/render/theme.ts:1-8, 22-60, 63-92.

## Add author controls

Place user-facing appearance controls in the Styling panel. Let the theme supply values that the author has not changed.

Check color, text, grid, font, axis, legend, and background values in both light and dark themes.

Sources: extension repo B, src/definition.ts:98-132; extension repo D, docs/development.md:239-250.

## Package a custom theme

A Qlik theme is a theme artifact. Do not upload it as an extension.

Run this command from the root directory of extension repo E:

    qlik theme create --file <theme-archive>

Expected result: The selected context contains the new theme.

Run this command from the root directory of extension repo E:

    qlik theme patch <theme-id> --file <theme-archive>

Expected result: The selected context contains the updated theme.

Use the theme test artifact in extension repo E as the test theme source. Do not copy theme values into this guide.

Sources: extension repo E, hosted theme validation; extension repo E, theme test artifact.

## Check dark mode

Use the local live page to check the chart with real Engine data. Record this as local-browser evidence.

Use the normal Qlik client to check client chrome, panel controls, and hosted theme behavior. Record the artifact version and test date.

Source: extension repo B, docs/serve-live.md:3-22.

## Tenant verification

Tenant verification for this guide is unverified.
