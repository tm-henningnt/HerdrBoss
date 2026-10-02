# 13: Quota reads and account keys in a container factory

**What to build:** A container factory reads the usage of its own accounts, and quota rows carry an account key.

**Blocked by:** 02: Spike: a factory in OrbStack on the Mac; 08: The factory image.

**Status:** ready-for-agent

- [ ] The factory reads usage for each installed harness with the Linux reader that the spike confirmed. The initial set includes Claude, Codex, OpenCode Go, and Pi. The set is open to later harnesses.
- [ ] Each quota row has an `accountKey`: an HMAC of the account identity, never the identity.
- [ ] Each harness account has an account scope, set in the dashboard.
- [ ] Tests cover a missing reader and a partial reading.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
