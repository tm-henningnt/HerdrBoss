# 03: Spike: the same steps on the Windows home server

**What to build:** The spike steps run on the Windows home server in Docker Engine in WSL2, reached from the Mac over Tailscale and SSH (ADR 0018). The Owner sets up WSL2, Tailscale, and SSH from the spike runbook.

**Blocked by:** 02: Spike: a factory in OrbStack on the Mac.

**Status:** ready-for-agent

- [ ] A runbook lists the Windows setup: WSL2 with systemd, Docker Engine, the boot task, `.wslconfig`, Tailscale with a host tag, and key-only sshd.
- [ ] A Docker context over SSH from the Mac lists the containers of the Windows host.
- [ ] The image builds on amd64 on the Windows host.
- [ ] The report names the Codex seccomp setting that works in WSL2, or states that none works.
- [ ] The Herdr server runs in WSL2 and `herdr --remote` attaches from the Mac.
- [ ] After a Windows reboot with no sign-in, the container runs again.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
