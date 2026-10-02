# ADR 0024: Codex in a container uses a custom seccomp profile and systempaths=unconfined

Status: Accepted. Owner decision, 2026-10-02, on the spike 02 result. It supersedes the decision part of ADR 0008 (the order of the two tested settings and the fallback). The rest of ADR 0008 stays: the Codex sandbox is on, and the bypass flag is not used.

## Context

Spike 02 (`docs/spikes/02-mac-orbstack.md`) tested the Codex sandbox as user `factory` in an OrbStack container. The Docker default seccomp profile fails with `No permissions to create a new namespace`. The custom profile alone and `seccomp=unconfined` alone both fail with `Can't mount proc on /proc: Operation not permitted`. Docker masks paths under `/proc`, and the masking blocks the proc mount of bubblewrap. The sandbox starts with the custom profile plus `--security-opt systempaths=unconfined`.

## Decision

A container factory starts Codex workers only with both settings together:

1. `--security-opt seccomp=<custom profile>`. The profile is the Docker default plus user namespaces. It is a file in the repository: `factory/seccomp-codex.json`.
2. `--security-opt systempaths=unconfined`.

The pair is a per-profile container setting. It is ON for the factory profiles. The Codex sandbox stays on and the bypass flag `--dangerously-bypass-approvals-and-sandbox` is not used.

The factory wizard checks the container before it enables Codex workers. The check passes only when the container has no Docker socket, no host mount, no added capability, and is not privileged. When the check fails, the wizard leaves Codex workers off and shows the reason.

## Consequences

- The container sees `/proc` and `/sys` of the VM kernel without masking. On the Mac and on Windows, that kernel belongs to a Linux VM, not to the host OS.
- The container has no Docker socket, no host mounts, no added capabilities, and is not privileged.
- The same pair must be tested on the Windows host (ticket 03). A different result there changes the setting for that host only.
- The read access of the Codex sandbox to login files on the `home` volume is not tested yet.

## Alternatives rejected

- The custom profile alone, and `seccomp=unconfined` alone. Both fail in the spike.
- The bypass flag, in any factory. A worker could read the logins of the factory.
- Codex workers only in factory zero. The Owner chose container support.
