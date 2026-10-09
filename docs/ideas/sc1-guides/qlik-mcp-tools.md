# Qlik MCP tools

Use Qlik MCP for structured discovery, metadata, data inspection, and reload orchestration when the connected server exposes those operations.

Use qlik-cli for deterministic scripted operations and API paths that MCP does not expose. Use browser automation to check rendered Qlik UI behavior.

Sources: TmVisualizationSuite/docs/agents/QlikValidation.md:20-43; TmProcessMining/docs/agents/QlikValidation.md:79-88.

## Tool catalogue for this session

On 2026-10-10, the active tool registry advertised 86 Qlik operations. The list below records that session's callable surface. It is not a universal Qlik MCP contract.

### Find resources and inspect apps

- qlik_search finds Qlik resources.
- qlik_describe_app reads app metadata.
- qlik_create_app creates an app.
- qlik_list_sheets lists sheets.
- qlik_get_sheet_details reads sheet metadata.
- qlik_create_sheet creates a sheet.
- qlik_search_connection_objects finds source objects for pipeline tasks.
- qlik_get_pipeline_project_details reads pipeline bindings.

Use search before you make a new object. Use returned identifiers for follow-up calls.

### Read and change charts

- qlik_add_chart adds a chart to a sheet.
- qlik_add_filter adds a filter panel to a sheet.
- qlik_get_chart_info reads chart metadata.
- qlik_get_chart_data reads chart rows.
- qlik_create_data_object creates a temporary calculation object.

### Read fields and manage selections

- qlik_get_data_model reads the app data model.
- qlik_get_fields lists fields.
- qlik_get_field_values reads distinct field values.
- qlik_search_field_values searches field values.
- qlik_get_current_selections reads active selections.
- qlik_clear_selections clears active selections.
- qlik_select_values applies field selections.
- qlik_list_bookmarks lists bookmarks.
- qlik_create_bookmark saves current selections as a bookmark.
- qlik_select_bookmark applies a bookmark.
- qlik_delete_bookmark deletes a bookmark.

### Manage reusable dimensions and measures

- qlik_list_dimensions and qlik_list_measures list reusable items.
- qlik_create_dimension and qlik_create_measure create reusable items.
- qlik_update_dimension and qlik_update_measure change reusable items.
- qlik_delete_dimension and qlik_delete_measure remove reusable items.

### Read scripts and manage reloads

- qlik_get_script reads an app load script.
- qlik_update_script changes an app load script.
- qlik_start_app_reload starts a reload.
- qlik_get_reload_status checks reload state.
- qlik_get_reload_log reads reload output.
- qlik_cancel_app_reload cancels a queued or running reload.

### Read and update datasets

- qlik_get_dataset reads dataset metadata.
- qlik_get_dataset_freshness reads freshness.
- qlik_get_dataset_memberships reads product membership.
- qlik_get_dataset_profile reads column profiles.
- qlik_get_dataset_quality_computation_status checks quality work.
- qlik_get_dataset_sample reads the first ten rows.
- qlik_get_dataset_schema reads field definitions.
- qlik_get_dataset_script reads load fragments.
- qlik_get_dataset_trust_score reads trust results.
- qlik_update_dataset_metadata changes dataset metadata.
- qlik_update_dataset_quality requests a quality computation.
- qlik_get_lineage reads one lineage step.

### Run automations

- qlik_list_automation_connectors lists connectors.
- qlik_list_automation_connections lists configured connections.
- qlik_get_automation_connector reads connector details.
- qlik_get_automation_connector_webhook_configuration reads webhook settings.
- qlik_create_automation creates an automation.
- qlik_get_automation_by_id reads an automation.
- qlik_update_automation changes automation settings.
- qlik_delete_automation removes an automation.
- qlik_get_automation_inputs reads required inputs.
- qlik_start_automation_run starts a run.
- qlik_start_automation_run_interactive starts a run with an interactive result.
- qlik_get_automation_run checks a run.
- qlik_get_automation_run_display reads run output.
- qlik_list_automation_runs lists one automation's runs.
- qlik_list_all_automation_runs lists runs available to the caller.

### Search knowledge bases and manage glossaries

- qlik_search_glossary_terms searches terms.
- qlik_create_glossary creates a glossary.
- qlik_create_glossary_category creates a category.
- qlik_get_glossary_categories lists categories.
- qlik_create_glossary_term creates a term.
- qlik_get_glossary_term reads a term.
- qlik_update_glossary_term changes a term.
- qlik_delete_glossary_term removes a term.
- qlik_create_glossary_term_links links terms to resources.
- qlik_get_glossary_term_links reads those links.
- qlik_get_full_glossary_export reads the full glossary.
- qlik_update_term_status changes a term's status.

Use qlik_search_knowledgebase_chunks to search knowledge-base content.

### Manage data products

- qlik_create_data_product creates a product.
- qlik_get_data_product reads product metadata.
- qlik_get_data_product_documentation reads product documentation.
- qlik_update_data_product changes product details.
- qlik_update_data_product_space moves a product.
- qlik_update_activate_data_product activates a product.
- qlik_update_deactivate_data_product deactivates a product.
- qlik_delete_data_product removes a product.

## Limits and safe use

The authoritative upstream MCP catalogue and its current service limits are not verified. The inventory says this source set lacks an authoritative catalogue.

Check each live tool description before use. Server permissions, tenant availability, paging, and service quotas can differ.

Use qlik_search_field_values for high-cardinality fields. The field-value tool description recommends it for that case.

Check that values exist before qlik_select_values. The tool description warns that a selection of missing values can fail silently.

Treat qlik_get_dataset_sample as a ten-row sample. Treat qlik_get_lineage as one step and call again when you need more history.

Use targeted glossary searches before qlik_get_full_glossary_export. The full export is described as costly.

Read the current script before qlik_update_script. Use a base version and an anchored edit where available.

Without an anchor, qlik_update_script replaces the whole script. A stale base version raises a conflict.

qlik_start_app_reload returns without waiting by default. Use qlik_get_reload_status after an asynchronous reload.

A tool acknowledgement does not prove a successful reload.

The active registry is a session snapshot. It does not prove tenant access or successful operations.

Sources: .worker/inputs/sc1-inventory.md:209; active tool descriptions observed on 2026-10-10; TmVisualizationSuite/docs/agents/QlikValidation.md:20-43, 86-110.

## Tenant verification

Tenant verification for this guide on 2026-10-10 is not verified. No MCP operation or tenant check ran for this guide task.

Source: .worker/inputs/sc1-inventory.md:203-205.
