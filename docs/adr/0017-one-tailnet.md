# ADR 0017: One tailnet with tags and access rules

Status: Accepted. Owner decision, factories interview round 2, item `tailnet`. Spec decision 10.

## Decision

All hosts, factories, the head office, and the Owner's devices join one tailnet. Each host and each factory has a Tailscale tag. The access rules allow only the needed paths: the Owner's devices reach every factory, the head office reaches the fleet routes of each factory, and a client factory reaches only the head office.

## Consequences

- One Tailscale account to manage.
- Each new factory needs a tag and a rule change. The host tool prints the rule lines.
- Use `tag:hf-<factory slug>` for a factory, `tag:hf-head-office` for the head office, and `tag:hf-host` for a Windows host. Tailscale Serve publishes the factory dashboard on TCP port 443.

## Alternatives rejected

- One tailnet for each client. The head office must join each one.
- One tailnet with no access rules. Every device reaches every factory.
