# 08: The factory image

**What to build:** `factory/Dockerfile` and `pins.json` build a complete factory image for the CPU type of the host (spec: Factory image).

**Blocked by:** 02: Spike: a factory in OrbStack on the Mac; 04: Live data directory check and configurable roots; 05: Linux machine readers; 06: Factory hostnames, health route, and log rotation.

**Status:** ready-for-agent

- [ ] The image holds the contents and the user of the spec, with every version from `pins.json` and the pins in OCI labels.
- [ ] s6-overlay supervises sshd, `herdr server`, and `herdr-boss serve`, and restarts each one when it exits.
- [ ] A Docker `HEALTHCHECK` uses `/api/health`.
- [ ] Harness self-update is off. Pi has no Claude subscription default.
- [ ] The working seccomp setting from ticket 02 is a file in the repository and a profile setting. Ticket 11 adds the WSL2 setting from ticket 03.
- [ ] A smoke test builds the image, starts it, gets 200 from `/api/health`, and runs the migration.
- [ ] The full suite passes inside the container.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
