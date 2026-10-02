# 15: Service and image updates

**What to build:** `factory update NAME --tier service|image [--dry-run]` updates a factory without breaking running work.

**Blocked by:** 14: Backup, restore, destroy, and break glass.

**Status:** ready-for-agent

- [ ] The service tier fast-forwards the `code` volume and restarts the service. Panes survive.
- [ ] The image tier quiesces, backs up, replaces the container on the same volumes, and starts fresh orchestrators.
- [ ] An update is refused while a worker works, a suite or push holds the lock, or a handover is prepared.
- [ ] After the restart, `/api/state` returns 200 within 30 seconds and one clean tick passes, or the update rolls back.
- [ ] A rollback after a migration needs `--accept-data-loss`.
- [ ] The manual update and rollback procedure is in the docs.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
