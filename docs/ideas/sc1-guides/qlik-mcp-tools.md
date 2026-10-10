# Qlik MCP tools

Use Qlik MCP for structured discovery, metadata, data inspection, and reload orchestration when the connected server exposes those operations.

Use qlik-cli for deterministic scripts and API paths that MCP does not expose. Use browser automation to check rendered Qlik UI behavior.

Sources: extension repo E, docs/agents/QlikValidation.md:20-43; extension repo C, docs/agents/QlikValidation.md:79-88.

## Discover and inspect

Search for the target resource before you create one. Read app and item metadata before you change an object.

Sources: extension repo E, docs/agents/QlikValidation.md:20-43; extension repo C, docs/agents/QlikValidation.md:79-88.

## Change and verify

Use an exposed MCP operation for a supported change. Read the affected object after the change. Use qlik-cli when you need a deterministic script or an API path that MCP does not expose.

Sources: extension repo E, docs/agents/QlikValidation.md:86-110; extension repo C, docs/agents/QlikValidation.md:79-88.

## Check rendered UI

Use browser automation to check visible Qlik UI behavior. Structured metadata does not prove that the object renders.

Source: extension repo E, docs/agents/QlikValidation.md:112-130.

## Tenant verification

Tenant verification for this guide is unverified.
