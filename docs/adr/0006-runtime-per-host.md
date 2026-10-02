# ADR 0006: The container runtime depends on the host and on the work

Status: Accepted. Owner decision, factories interview round 1, item `runtime`. Spec decision 4.

## Context

The Mac needs a container runtime for the spike and for the first factory. OrbStack is free for personal use only. Docker Desktop is free below 250 employees and 10 million USD revenue. The Owner's company has 14 employees. The Owner does not want Docker Desktop on the Mac.

## Decision

- The Mac uses OrbStack without a paid licence. The Mac runs only personal factories.
- Client and commercial factories run on a Windows host with Docker Engine in WSL2 (ADR 0014).
- The spike runs on the Mac with OrbStack. The Owner approved it.

## Consequences

- A client factory must never run on the Mac while OrbStack has no paid licence. The host tool refuses a `client` profile on a host whose runtime is marked personal-only.
- Colima stays a documented fallback for the Mac.

## Alternatives rejected

- Colima on the Mac. Free, but slower file access and more manual operation.
- Docker Desktop on the Mac. The Owner rejects it on the Mac.
- No runtime on the Mac.
