# ADR 0022: Manual head office promotion first

Status: Accepted. Owner decision, factories interview round 3, item `succession`.

## Context

The Owner's first requirement was that the online factories agree on a temporary head office when it goes offline. An automatic election needs at least two always-on hosts on the succession list. The initial fleet has one always-on host.

## Decision

The first plan has a role record with an epoch and a manual `hub promote` command. The automatic election, with a lease and the claim rules of spec section 16.3, waits until two always-on hosts are on the succession list.

## Consequences

- When the head office host fails, the Owner runs `hub promote` on another factory. Factories keep working meanwhile.
- No election code and no split-network test in the first plan.

## Alternatives rejected

- An automatic election in the first plan. It is useful only with a second always-on host.
- No succession and a fixed head office.
