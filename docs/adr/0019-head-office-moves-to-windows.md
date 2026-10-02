# ADR 0019: The head office moves to the Windows home server

Status: Accepted. Owner decision, factories interview round 3, item `head-office-move`. Extends ADR 0009.

## Decision

The head office moves from factory zero to the container factory on the Windows home server after that factory runs clean for 7 days. The move uses `hub promote` with the next epoch. The Mac is never a standby, because it sleeps.

## Consequences

- The fleet view and the guidance work while the Mac sleeps.
- A Windows update reboot stops the head office for some minutes. The factories keep working.
- The fleet has no standby until a third always-on host joins.

## Alternatives rejected

- Keep the head office on factory zero.
- A cloud VM on the tailnet. A monthly cost and a NAT gateway.
