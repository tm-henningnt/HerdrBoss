# ADR 0023: Agents may use the Windows host key through the host tool

Status: Accepted. Owner decision, factories interview final pack, item `windows-access`.

## Context

The host tool on the Mac reaches Docker in WSL2 on the Windows home server over Tailscale and SSH. The SSH key gives full Docker control of that host. Agents in factory zero run `herdr-boss` commands.

## Decision

- The host tool may use the Windows host key without a confirmation for each use. Agents can update and repair the Windows factories unattended through the host tool.
- The key file is stored where agents must not read it. Only the host tool reads it.
- `factory destroy` and `factory restore` always need the Owner's typed confirmation.

## Consequences

- Updates and repairs on the Windows host run without the Owner, also at night.
- An agent that can run the host tool has full Docker control of the Windows host.

## Alternatives rejected

- An ssh-agent confirm prompt for each use. Night updates would wait for the Owner.
- No remote access, with the host tool run inside WSL2. Each create, update, and repair would wait for the Owner at the Windows host.
