# ADR 0013: The initial fleet

Status: Accepted. Owner decision, factories interview round 2, item `windows-host` and the Owner's note. Supersedes ADR 0005.

## Context

Round 1 picked a personal container factory on the Mac as the first container factory. In round 2 the Owner described the fleet in more detail.

## Decision

- The design supports any number of factories and hosts.
- The initial fleet has two personal factories: factory zero, native on the Mac, and one container factory on the Owner's Windows home server.
- The first container factory runs on the Windows home server.
- Later, factory zero moves into a container on the Mac (OrbStack), and a third personal factory runs on a second Windows host.
- The initial fleet has no client factory.

## Consequences

- The amd64 image comes before the first container factory. The arm64 image comes with the move of factory zero.
- The `ssh` transport comes before the first container factory, because the host tool reaches the Windows host over the network.
- Access roles and client-site work are not needed for the initial fleet.

## Alternatives rejected

- The first container factory on the Mac (ADR 0005). The Owner keeps factory zero native first.
