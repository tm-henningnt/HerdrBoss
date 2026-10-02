# 07: Chrome path setting and browser sign-in view

**What to build:** The Owner signs in to a web app in a headless project Chrome through the dashboard browser view (ADR 0012).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The Chrome path is a setting with the macOS path as the default.
- [ ] The browser view has a sign-in task: open a URL in the project profile, show frames, and forward clicks, text, keys, and modifier keys.
- [ ] A test with the fake CDP helper types into a password field and a one-time code field.
- [ ] Only an owner session can use the sign-in task.
- [ ] The login stays in the project Chrome profile after a browser restart.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
