# ADR 0014: Docker Engine in WSL2 on Windows hosts

Status: Accepted. Owner decision, factories interview round 2, item `windows-runtime`. Spec decision 15.

## Context

Docker Desktop on Windows starts only after a user signs in. A Windows update reboot then stops every factory on the host.

## Decision

A Windows host runs Docker Engine in a WSL2 distribution with systemd. A scheduled task starts the distribution at boot. All factory volumes are named volumes in the Linux file system.

## Consequences

- Factories come back after each reboot without a sign-in.
- No Docker Desktop licence applies.
- The host tool documents the setup as a runbook.
- `.wslconfig` sets the memory and CPU limits of the WSL2 VM.

## Alternatives rejected

- Docker Desktop with automatic sign-in. It stores a Windows password on the host.
- Docker Desktop, started by hand. Factories stay stopped after each reboot.
