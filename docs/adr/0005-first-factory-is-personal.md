# ADR 0005: The first container factory is a personal factory on the Mac

Status: Accepted. Owner decision, factories interview round 1, item `first-use`.

## Context

The spec builds the image, the host tool, and the wizard before it names a first user of them. The first user sets the order of the phases.

## Decision

The first container factory runs the Owner's personal projects on the Mac. The profile for it is `personal`. Client and commercial work later moves to a Windows host in the Owner's home (ADR 0006).

## Consequences

- Access roles, client contracts, and separate client accounts are not needed for the first factory.
- The arm64 image is enough for the first factory. The amd64 image comes before the Windows host.
- The first factory tests isolation, updates, and restore at low risk.

## Alternatives rejected

- An always-on home server first, a client factory first, or a client-premises factory first. Each one puts more work before the first useful factory.
