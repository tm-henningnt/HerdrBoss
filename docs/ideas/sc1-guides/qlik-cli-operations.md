# Qlik CLI operations

Use this guide for controlled Qlik app and extension workflows. The commands below come from repository examples. Check the installed CLI help before using a command in another project.

## Check the CLI and context

Check the installed CLI version:

    qlik version

List configured contexts:

    qlik context ls

Choose the intended context before each mutation. Use structured output where a command supports it. Read the changed object back after each mutation.

The demo rebuild source checks the current context and selects its intended context before changing an app. The source warns that these commands mutate the context's tenant.

Authentication setup is not verified in the checked sources. Do not infer an authentication command from a context command.

Sources: TmProcessMining/docs/agents/QlikValidation.md:83-88; TmStackedVariance/docs/demo-app.md:30-43; TmStackedVariance/demo/rebuild.sh:35-47.

## Import and export an app

The checked sources document QVF export and manual import. They do not verify a qlik-cli app import command.

Use the documented project export workflow when it fits the task:

    npm run demo:export

The Stacked Variance export writes a separate QVF and checksum. It requires public sheets and zero sensitive-data scan counts.

The Atlas README documents manual import of its exported QVF into a Qlik Cloud space. Treat that as UI import evidence, not CLI syntax.

Sources: TmStackedVariance/docs/demo-app.md:152-158; TmStackedVariance/demo/export-demo-app.sh:50-76; TmVisualizationSuite/demo/atlas/README.md:37.

CLI app import syntax is not verified in the named sources. Source: .worker/inputs/sc1-inventory.md:207.

## Publish and check sheets

Publish each required sheet before exporting a public demo app. Read the sheet metadata again. Confirm that each sheet is public.

The sample exporter publishes sheets, checks their public state, exports the app, and scans the result. The Gantt sample also checks that every sheet is public.

Use placeholders for object and app identifiers:

    qlik app object publish <sheet-object-id> -a <app-id>

Do not copy identifiers from a tenant into guides or reports.

Sources: TmStackedVariance/demo/export-demo-app.sh:50-68; TmGantt/scripts/demo-app.cjs:90-111; TmStackedVariance/docs/demo-app.md:154-158.

## Reload and read back data

Use a project script that sets the app script, reloads the app, and reads back its results. A successful reload alone does not prove correct data.

The Process Mining verification loop uploads fixtures, reloads an app, evaluates tables, and compares the output with expected files.

The Stacked Variance rebuild sets the script, reloads, and saves the app. Its verification path reads values through qlik app eval.

Sources: TmStackedVariance/docs/demo-app.md:37, 43; TmProcessMining/docs/agents/QlikValidation.md:94-104; TmProcessMining/scripts/verify-script.mjs:14-17, 234-240.

The exact qlik-cli reload syntax is not verified in this guide's source set. Use the project script or current CLI help.

## Use inline tables for a controlled Engine check

Place small invented fixtures in the app load script. Keep their fields separate from production tables when the test needs independent rows.

Reload the app. Read the resulting table through the documented evaluation path. Compare every result with expected fixture data.

The Stacked Variance demo source uses inline tables that have no fields in common with its main Facts table. The Process Mining runner reads reloaded tables through qlik app eval.

Sources: TmStackedVariance/docs/demo-app.md:160-170; TmProcessMining/docs/agents/QlikValidation.md:98-104; TmProcessMining/scripts/verify-script.mjs:14-17.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. The accepted inventory says it did not run a tenant check.

Historical record: a hosted-client report dated 2026-10-02 records an upload and read-back match. It does not verify current authentication, import syntax, or context state.

Sources: .worker/inputs/sc1-inventory.md:203-205; TmStackedVariance/docs/release/hosted-review.md:41-53.
