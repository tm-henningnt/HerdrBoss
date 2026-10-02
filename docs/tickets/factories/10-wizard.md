# 10: Factory wizard and harness login

**What to build:** `factory configure NAME` walks the 9 steps of the spec, and `factory login NAME HARNESS` logs in a harness at a host terminal.

**Blocked by:** 09: Host tool core with the local transport.

**Status:** ready-for-agent

- [ ] The wizard runs container, volumes, herdr, service, harness-claude, harness-codex, harness-other, github, and project in order.
- [ ] A finished step is skipped when its check still passes. `--resume` starts at the first failed step.
- [ ] Exit code 3 means the wizard waits for the Owner, and one Mailbox item says what to do, with no secret.
- [ ] `factory login` runs through `docker exec`, shows only the URL or code, checks with a harmless call, and prints no token.
- [ ] An expired login pauses only that factory and posts one item with the re-login command.
- [ ] Tests follow the `project new` flow tests.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
