# 04: Live data directory check and configurable roots

**What to build:** A factory service always acts on its data. The service asserts at start that its data directory is the live data directory. Worktree and project roots are settings.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The service stops with a clear message when the data directory and the live data directory differ.
- [ ] A test with a temporary `HOME` shows that the default paths pass the check.
- [ ] The worktree root and the project root are settings that the dashboard shows and can set, with today's paths as defaults.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
