# 11: The ssh transport and the Windows host runbook

**What to build:** The host tool on the Mac manages factories on the Windows home server through a Docker context over SSH.

**Blocked by:** 03: Spike: the same steps on the Windows home server; 09: Host tool core with the local transport.

**Status:** ready-for-agent

- [ ] The registry stores a host with the `ssh` transport, its runtime, and the personal-use flag.
- [ ] Every factory command works through the `ssh` transport. The fake transport tests cover both transports.
- [ ] The SSH key and the host credentials are stored where agents must not read them. The host tool uses the key without a confirmation for each use (ADR 0023).
- [ ] `factory new` prints the Tailscale tag and the access rule lines for the new factory.
- [ ] The Codex seccomp setting that ticket 03 found for WSL2 is a host setting. With no working setting, the `personal` profile on that host excludes Codex.
- [ ] The Windows runbook from ticket 03 is in `docs/` and the user guide links it.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
