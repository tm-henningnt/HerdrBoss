# Qlik CLI operations

Use this guide for controlled Qlik app and extension workflows. The commands below come from repository examples. Check the installed CLI help before using a command in another project.

## Check the CLI and context

Check the installed CLI version:

    qlik version

Expected result: the command prints the installed version.

List configured contexts:

    qlik context ls

Expected result: the command lists the configured contexts.

Choose the intended context before each mutation. Use structured output where a command supports it. Read the changed object back after each mutation.

The demo rebuild source checks the current context and selects its intended context before changing an app. The source warns that these commands mutate the context's tenant.

Authentication setup is not verified in the checked sources. Do not infer an authentication command from a context command.

Sources: extension repo C, docs/agents/QlikValidation.md:83-88; extension repo B, docs/demo-app.md:30-43; extension repo B, demo/rebuild.sh:35-47.

## Import and export an app

The checked sources document QVF export and manual import. They do not verify a qlik-cli app import command.

Run this command from the root directory of extension repo B:

    npm run demo:export

Expected result: the command writes a demo QVF and checksum under `dist/release/`.

The export requires public sheets and zero sensitive-data scan counts.

The sample README documents manual import of its exported QVF into a Qlik Cloud space. Treat that as UI import evidence, not CLI syntax.

Sources: extension repo B, demo export configuration; extension repo B, docs/demo-app.md:152-158; extension repo B, demo export workflow; extension repo E, sample app README.

CLI app import syntax is unverified in the sources cited here.

## Publish and check sheets

Publish each required sheet before exporting a public demo app. Read the sheet metadata again. Confirm that each sheet is public.

The sample exporter publishes sheets, checks their public state, exports the app, and scans the result. The extension repo A sample also checks that every sheet is public.

Use placeholders for object and app identifiers:

    qlik app object publish <sheet-object-id> -a <app-id>

Expected result: the sheet is published in the selected app.

Do not copy identifiers from a tenant into guides or reports.

Sources: extension repo B, demo/export-demo-app.sh:50-68; extension repo A, scripts/demo-app.cjs:90-111; extension repo B, docs/demo-app.md:154-158.

## Reload and read back data

Use a project script that sets the app script, reloads the app, and reads back its results. A successful reload alone does not prove correct data.

The extension repo C verification loop uploads fixtures, reloads an app, evaluates tables, and compares the output with expected files.

The extension repo B rebuild sets the script, reloads, and saves the app. Its verification path reads values through qlik app eval.

Sources: extension repo B, docs/demo-app.md:37, 43; extension repo C, docs/agents/QlikValidation.md:94-104; extension repo C, scripts/verify-script.mjs:14-17, 234-240.

The exact qlik-cli reload syntax is not verified in this guide's source set. Use the project script or current CLI help.

## Use inline tables for a controlled Engine check

1. Place small invented fixtures in the app load script.

   Expected result: The script contains the test rows.

2. Keep their fields separate from production tables when the test needs independent rows.

   Expected result: The test rows form separate model tables.

3. Reload the app.

   Expected result: The app reloads with the test data.

4. Read the resulting table through the documented evaluation path.

   Expected result: The evaluation returns the reloaded table.

5. Compare every result with the expected fixture data.

   Expected result: Every result matches its expected fixture data.

The extension repo B demo source uses inline tables that have no fields in common with its main Facts table. The extension repo C runner reads reloaded tables through qlik app eval.

Sources: extension repo B, docs/demo-app.md:160-170; extension repo C, docs/agents/QlikValidation.md:98-104; extension repo C, scripts/verify-script.mjs:14-17.

## Tenant verification

Tenant verification for this guide is unverified.
