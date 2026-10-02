# ADR 0009: The head office starts on factory zero

Status: Accepted. Owner decision, factories interview round 1, item `head-office`. Spec decisions 3 and 11.

## Context

The spec recommended an always-on home box as the first head office. The Mac sleeps, and a host that sleeps cannot be a standby.

## Decision

Factory zero on the Mac holds the head office role until a second host exists. A cloud VM may hold the role later, on two conditions: it joins the tailnet, and it has no public IP address.

## Consequences

- No new hardware is needed for the first phases. The fleet view stops while the Mac sleeps. The factories keep working.
- The standby and succession questions wait for the second host. The second host is the Windows home server (ADR 0013).
- Section 2 of the spec no longer excludes every public cloud service. A cloud VM is allowed as a host when it is reachable only over the tailnet.

## Alternatives rejected

- An always-on home box from the start.
- A cloud VM from the start.
