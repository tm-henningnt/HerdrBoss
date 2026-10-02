# ADR 0004: Factories are part of the Herdr Boss product

Status: Accepted. Owner decision, factories interview round 1, item `scope`. Spec decision 7.

## Context

`PRODUCT.md` limits Herdr Boss to "all Herdr projects on this machine". The factories proposal adds container factories, remote hosts, a head office, users and roles, and client factories.

## Decision

Herdr Boss covers all factories of the Owner. The host tool, the factory image, the fleet summary, and the head office live in this repository.

## Consequences

- `PRODUCT.md` and `AGENTS.md` widen their scope in the first build change. The orchestrator makes that edit; the interview branch does not touch them.
- Each later factories phase is in scope without a new product decision.

## Alternatives rejected

- Containers on this Mac only. A second host is already planned.
- A separate product and repository. It copies the flow engine, redaction, and the secret scan (ADR 0002).
- Keep it as an idea.
