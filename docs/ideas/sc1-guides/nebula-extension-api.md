# Nebula.js and the Qlik extension API

Use the extension entry point to declare properties, data targets, and rendering code. Keep the host contract explicit.

## Declare the extension

Export one default supernova function. Return the QAE property defaults, data targets, component, and extension definition.

Declare the hypercube path and allowed dimension and measure counts in the data target.

The Stacked Variance entry point uses this shape. The Heat Grid entry point declares one straight hypercube with two dimensions and one required measure.

Sources: TmStackedVariance/src/index.ts:5-16; TmHeatGrid/src/qae/data.ts:1-10; TmHeatGrid/src/index.ts:8-20.

## Define properties

Keep saved properties in one definition. Set defaults for new objects.

Read the object layout before rendering. Treat absent saved values as absent unless the extension contract defines a default.

Some host panel defaults remain absent until the author changes them. Verify those values in a live edit panel.

Sources: TmStackedVariance/src/properties.ts; TmStackedVariance/src/definition.ts:98-132; TmStackedVariance/docs/guides/styling-panel-for-extensions.md:85-100.

## Read data

Declare data under the hypercube definition. Read the host model's layout and data pages.

Order pages by qArea.qTop before joining their matrices. Check qError on the layout, hypercube, dimensions, and measures.

Page limits belong to each extension. Do not copy one extension's cap into another extension's contract.

The Heat Grid shell reads through the host model. It creates no second Engine session or side-channel object.

Sources: TmStackedVariance/src/index.ts:8-12; TmStackedVariance/src/data.ts:121-124, 163-174; TmHeatGrid/src/index.ts:40-52.

## Handle selections

Begin a selection session on the hypercube path when no session is active. Select the requested dimension value.

Handle a refused or rejected selection as a normal failure. Do not let it stop chart rendering.

Add event listeners only when the host can remove them. Remove each listener when the component ends.

The selection helper catches rejected calls and returns false. It also builds a fresh signature from cube size and dimension state counts.

Sources: TmStackedVariance/src/selection.ts:73-116, 120-131; TmStackedVariance/src/component.ts:67-92.

## Build the property and Styling panels

Keep property controls as API-shaped definitions. Use Qlik's native Data section for dimensions and measures.

Use Styling sections for presentation controls. Use the host theme for properties that the author has not changed.

Static panel definitions do not prove dynamic lists or host re-render behavior. Verify both at the extension boundary and in hosted edit mode.

Shared authoring sections define the order for data roles, optional controls, appearance, license, and about panels.

Sources: TmStackedVariance/src/definition.ts:98-132, 424-438; TmVisualizationSuite/extensions/comparison-charts/src/property-panel.ts:4-14; TmVisualizationSuite/packages/qlik-viz-core/src/authoring-sections.ts:1-33.

## Keep rendering alive after denied writes

Treat property persistence as optional. Keep the chart render path independent from a successful property write.

The component catches rejected property writes and continues with its existing render state. Unit evidence does not replace the hosted locked-sheet check.

Source: TmStackedVariance/src/component.ts:67-92; .worker/inputs/sc1-inventory.md:11-15.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. The accepted inventory says it did not run a tenant check.

Historical record: the hosted-client report dated 2026-10-02 says seven panel controls changed and persisted after reload. That report does not verify this guide's current extension version.

Sources: .worker/inputs/sc1-inventory.md:203-205; TmStackedVariance/docs/release/hosted-review.md:41-53.
