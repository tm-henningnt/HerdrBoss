# 19: Head office role record and the move to Windows

**What to build:** The head office role has a record with an epoch, and `hub promote` moves it. The role moves to the Windows factory after 7 clean days (ADR 0019).

**Blocked by:** 12: The first personal factory on the Windows home server; 18: Factory shares and guidance.

**Status:** ready-for-agent

- [ ] Each factory stores the head office factory id and the epoch.
- [ ] `hub promote` on a factory takes the role with the epoch plus one, tells every factory, and the old holder stops polling and sending guidance.
- [ ] The registry and the factory shares move with the role.
- [ ] The runbook states the planned move and the move after a host failure.
- [ ] After 7 clean days of the Windows factory, the Owner runs the move, and the Fleet page works while the Mac sleeps.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
