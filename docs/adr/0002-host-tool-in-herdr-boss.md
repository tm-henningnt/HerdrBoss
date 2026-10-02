# ADR 0002: The host tool is `herdr-boss factory`

Status: Accepted. Decided by the planner in the factories interview, round 1. Spec decision 8.

## Context

The host tool creates, configures, updates, and repairs factories. It runs on the host, outside every container, because it must repair a container whose service is dead. It needs the wizard state machine, the redaction rules, and the secret scan that Herdr Boss already has.

## Decision

Put the host tool in the Herdr Boss repository as `herdr-boss factory ...`, in `src/factory/`, loaded lazily. It imports nothing from `src/engine.js`. It refuses to run inside a container. Each host tool release states a minimum factory version.

## Consequences

- The host tool and the service share one release. A broken `main` breaks the host tool too. The integration rules in `AGENTS.md` already guard `main`.
- The host tool runs from the host checkout, and a factory runs a pinned commit. The minimum factory version check covers the skew.

## Alternatives rejected

- A separate `herdr-factory` binary. It has its own failure domain, but it duplicates the flow engine, redaction, and the secret scan, and it needs a second release process.
