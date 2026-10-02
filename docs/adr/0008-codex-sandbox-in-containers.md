# ADR 0008: Codex in a container uses a narrow seccomp profile only

Status: Accepted. Owner decisions, factories interview round 1, item `codex`, and round 2, item `codex-fallback`. Spec decision 1.

## Context

The Codex sandbox fails under the default Docker seccomp profile. The Codex sandbox keeps a worker out of the login files on the `home` volume. Other projects run Codex in containers, so a working setup is likely.

## Decision

Container factories run Codex only with the Codex sandbox on. The bypass flag `--dangerously-bypass-approvals-and-sandbox` is not used in a factory.

The spike tests two container settings in this order:

1. A custom seccomp profile: the Docker default plus user namespaces.
2. `seccomp=unconfined`, plus `apparmor=unconfined` where AppArmor is active. OpenAI's own Codex devcontainer uses this setting (openai/codex pull request 17547).

The first setting that lets the Codex sandbox start is the setting for Codex workers.

## Consequences

- If both settings fail, Codex workers run only in factory zero, and the Owner takes the rule up again with the spike result.
- With the second setting, the container has a wider kernel interface. On the Mac and on Windows that kernel belongs to a Linux VM, not to the host OS.
- The seccomp profile is a file in the image repository and a per-profile launch setting.

## Alternatives rejected

- The Sysbox runtime. Its support in OrbStack and in WSL2 is not known.
- The bypass in personal factories only. A worker could read the logins of that factory.
- The bypass everywhere. It conflicts with `docs/harness-setup.md` and exposes client logins.
