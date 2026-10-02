# 16: Fleet summary and the read credential

**What to build:** Each factory serves a small, allow-listed fleet summary to a holder of the `fleetRead` credential.

**Blocked by:** 06: Factory hostnames, health route, and log rotation; 13: Quota reads and account keys in a container factory.

**Status:** ready-for-agent

- [ ] `GET /api/fleet/summary` returns the content of the spec, with `factoryId` and `schema`.
- [ ] An allow-list test fails when a summary key is not on the list. A fixture with paths, tokens, and message text gives a summary with none of them.
- [ ] Item titles are in the summary only when `fleet.shareItemTitles` is on. The `personal` profile sets it on.
- [ ] A `fleetRead` credential reads the summary and health routes only, and gets 403 elsewhere.
- [ ] Rotation keeps the old credential valid for 10 minutes.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
