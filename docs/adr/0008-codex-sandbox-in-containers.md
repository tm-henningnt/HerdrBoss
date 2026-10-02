# ADR 0008: Codex in a container uses a narrow seccomp profile only

Status: Accepted. Owner decision, factories interview round 1, item `codex`. Spec decision 1.

## Context

The Codex sandbox fails under the default Docker seccomp profile. The Codex sandbox keeps a worker out of the login files on the `home` volume. Other projects run Codex in containers, so a working setup is likely.

## Decision

The spike tests a narrow seccomp profile that allows the Codex sandbox. Container factories run Codex only with the sandbox on. The bypass flag `--dangerously-bypass-approvals-and-sandbox` is not used in a factory.

## Consequences

- If the narrow profile fails, Codex workers run only in factory zero, and the Owner takes the rule up again with the spike result.
- The seccomp profile is a file in the image repository and a per-profile launch setting.

## Alternatives rejected

- The bypass in personal factories only. A worker could read the logins of that factory.
- The bypass everywhere. It conflicts with `docs/harness-setup.md` and exposes client logins.
