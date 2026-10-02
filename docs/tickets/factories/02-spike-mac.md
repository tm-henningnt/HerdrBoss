# 02: Spike: a factory in OrbStack on the Mac

**What to build:** One worker runs the spike of spec section 12 on the Mac with OrbStack, and writes a report with measured numbers. The Boss first updates Herdr on the Mac to 0.9.3 or newer.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A minimal image with Debian, s6-overlay, git, sshd, Herdr, Node, and a Herdr Boss checkout starts.
- [ ] `herdr server` runs without a TTY. A session survives a container restart. `herdr --remote` attaches over a published loopback sshd port, and `docker exec` attaches too.
- [ ] `herdr-boss serve` returns 200 on `/api/state` and the migration guard is active.
- [ ] One Claude worker and one Codex worker run, logged in by token, and agent detection works.
- [ ] Codex is tested with the custom seccomp profile, then with `seccomp=unconfined`. The report names the first setting that lets the Codex sandbox start.
- [ ] The report says if CodexBar has a Linux CLI that reads Claude and Codex usage.
- [ ] Two factories under two `*.localhost` hostnames keep separate dashboard logins.
- [ ] `git status` and `npm test` times on a named volume are measured against the Mac.
- [ ] The 14 facts of research note C are marked pass or fail.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
