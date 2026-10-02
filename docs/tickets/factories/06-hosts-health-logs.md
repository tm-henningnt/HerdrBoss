# 06: Factory hostnames, health route, and log rotation

**What to build:** A factory accepts its own hostname, reports its health, and keeps its log small.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] An `allowedHosts` setting accepts `*.localhost` and named tailnet hosts. The default keeps today's host rule.
- [ ] `GET /api/health` returns version, schema, kit revision, tick age, Herdr reachable, and clock offset, with no path and no secret.
- [ ] The server log goes to stdout and to a file that rotates at a set size.
- [ ] Dashboard help and `docs/cli.md` describe the setting and the route.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
