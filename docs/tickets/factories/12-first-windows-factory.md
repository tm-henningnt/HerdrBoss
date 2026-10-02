# 12: The first personal factory on the Windows home server

**What to build:** The Owner has a running personal container factory on the Windows home server and attaches to it with Herdr from the Mac.

**Blocked by:** 07: Chrome path setting and browser sign-in view; 10: Factory wizard and harness login; 11: The ssh transport and the Windows host runbook.

**Status:** ready-for-agent

- [ ] `factory new` and `factory configure` finish with exit code 0 for the Windows factory.
- [ ] `/api/state` returns 200 and a worker starts in the factory.
- [ ] `herdr machine add` on the Mac shows the factory in the Herdr sidebar.
- [ ] The Owner signs in to one web app through the browser sign-in view.
- [ ] The OpenCode Go subscription in the account scope of this factory works.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
