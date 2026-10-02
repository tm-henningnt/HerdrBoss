# 20: Project transfer, small form

**What to build:** `project transfer plan|start|switch|cancel SLUG --to FACTORY` moves one project between two factories through GitHub.

**Blocked by:** 12: The first personal factory on the Windows home server.

**Status:** ready-for-agent

- [ ] `plan` checks the target, the kit version, and that the repository is on GitHub, and changes nothing.
- [ ] A transfer lock makes `worker start` refuse for the project on both factories.
- [ ] Unpushed work stops the freeze, and the command lists it.
- [ ] The target clones, runs `kit install`, creates the project record, and starts a fresh orchestrator that reads `memory.md`.
- [ ] The Owner confirms the switch. The source marks the project `transferred`.
- [ ] `cancel` before the switch removes the target project and clone and lifts the lock.
- [ ] Secrets, logins, Owner items, review packs, and message text stay at the source. Both factories log an audit line.
- [ ] Tests use two temporary data directories and a fake GitHub remote.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
