# 05: Linux machine readers

**What to build:** The machine guard reads memory, pressure, and CPU from Linux `/proc` and from cgroup v2 limits, so that a container factory paces against its own limits.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Readers for `/proc/meminfo`, `/proc/pressure`, and cgroup v2 CPU and memory limits return the same sample shape as the macOS readers.
- [ ] The guard uses the cgroup limits when they exist.
- [ ] A start-up check reports missing `lsof` or procps.
- [ ] Tests use fixture files for each reader. macOS behaviour does not change.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
