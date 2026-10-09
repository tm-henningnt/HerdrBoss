# Qlik extension knowledge guides

This folder stages content for the Qlik type. It does not choose the final type layout.

The inventory dated 2026-10-09 names the source files for each guide. It reports that it did not run a tenant check.

| Guide | Main sources |
| --- | --- |
| [Qlik CLI operations](qlik-cli-operations.md) | TmStackedVariance/docs/demo-app.md, docs/serve-live.md, demo/rebuild.sh, demo/export-demo-app.sh, scripts/upload.ts, scripts/lib/qlik.ts; TmGantt/scripts/demo-app.cjs, docs/development.md; TmProcessMining/docs/agents/QlikValidation.md, docs/architecture/DeliveryProcess.md, scripts/demo-app-asset.mjs, scripts/verify-script.mjs; TmHeatGrid/docs/development.md; TmVisualizationSuite/docs/agents/QlikValidation.md, demo/atlas/README.md, scripts/orchestrator/hosted/cdp.mjs. |
| [Nebula.js and the extension API](nebula-extension-api.md) | TmStackedVariance/src/index.ts, src/definition.ts, src/component.ts, src/properties.ts, docs/guides/styling-panel-for-extensions.md; TmProcessMining/extensions/tm-pm-processmap/src/index.ts, src/qae/ext.ts, src/qae/panel.ts; TmHeatGrid/src/index.ts, src/qae/ext.ts, src/qae/data.ts; TmGantt/src/index.ts, src/qae/data.ts, src/qae/property-panel.ts; TmVisualizationSuite/extensions/temporal-patterns/src/index.ts, extensions/comparison-charts/src/property-panel.ts, packages/qlik-viz-core/src/authoring-sections.ts. |
| [Qlik MCP tools](qlik-mcp-tools.md) | TmVisualizationSuite/docs/agents/QlikValidation.md and AGENTS.md; TmProcessMining/docs/agents/QlikValidation.md and AGENTS.md; active tool definitions observed on 2026-10-10. |
| [Qlik Engine data and sessions](qlik-engine-data-sessions.md) | TmGantt/src/qae/data.ts, src/host/pager.ts, src/host/hooks.ts; TmStackedVariance/src/data.ts, src/paging.ts, src/selection.ts, scripts/serve-live/qlik-api-qix.stub.d.ts; TmProcessMining/extensions/tm-pm-processmap/src/cubes.ts, packages/qlik-host/src/paging.ts, scripts/verify-script.mjs; TmHeatGrid/src/qae/object-properties.ts, src/host/paging.ts, src/host/pager.ts; TmVisualizationSuite/spec/spec-architecture-shared-qlik-core.md, packages/qlik-viz-core/src/engine-pages.ts, scripts/orchestrator/sweep-qerror.sh. |
| [Themes and dark mode](themes-dark-mode.md) | TmGantt/src/render/theme.ts, test/renderer/theme-colors.test.ts; TmStackedVariance/src/theme.ts, scripts/serve-live/themes/tm-sv-dark-test.json, docs/release/hosted-review.md; TmProcessMining/packages/qlik-host/src/theme.ts, packages/extension-shell/src/theme.ts, docs/guide/visualizations.md; TmHeatGrid/src/render/theme.ts, docs/development.md; TmVisualizationSuite/extensions/process-explorer/src/theme.ts, themes/tm-vis-suite-dark-test/theme.json, packages/qlik-viz-core/test/theme-locale.test.ts. |
| [Hosted and local-browser evidence](hosted-local-browser-evidence.md) | TmStackedVariance/docs/evidence.md, docs/release/hosted-review.md, docs/serve-live.md; TmProcessMining/docs/agents/QlikValidation.md, docs/architecture/DeliveryProcess.md; TmGantt/docs/development.md, docs/product/sharing-and-reporting.md; TmHeatGrid/docs/development.md, docs/licensing.md; TmVisualizationSuite/docs/agents/QlikValidation.md, AGENTS.md; .worker/inputs/sc1-inventory.md. |
| [Common errors and fixes](common-errors.md) | TmProcessMining/docs/agents/TenantDefectPatterns.md, docs/guide/data-quality.md, docs/guide/visualizations.md; TmStackedVariance/docs/serve-live.md, docs/verify.md, docs/demo-app.md; TmHeatGrid/docs/development.md; TmGantt/docs/development.md, docs/user-guide.md; TmVisualizationSuite/docs/agents/QlikValidation.md, scripts/orchestrator/sweep-qerror.sh. |

## Evidence status

Every guide separates source behavior, local checks, historical tenant reports, and current tenant checks.

Tenant verification for this guide set on 2026-10-10 is not verified. The inventory reports no tenant check for this work.

The accepted Owner rule keeps the managed-space viewer check open until a test user exists. A published sheet locked against property writes is the current hosted gate.

Source: .worker/inputs/sc1-inventory.md:11-15, 203-213.
