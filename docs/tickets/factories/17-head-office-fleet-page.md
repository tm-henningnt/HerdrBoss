# 17: Head office poller and Fleet page

**What to build:** Factory zero, as the head office, polls each registered factory and shows the Fleet page and the combined Mailbox view.

**Blocked by:** 16: Fleet summary and the read credential.

**Status:** ready-for-agent

- [ ] The head office polls each factory every 30 seconds over the tailnet with its `fleetRead` credential.
- [ ] A factory outage shows the last good data and its age.
- [ ] The Fleet page shows one line per factory, a quota view by `accountKey`, a spend view, and the version and kit drift.
- [ ] The Mailbox view lists the Owner items of all factories with a factory tag and a link to the factory.
- [ ] The head office refuses a second factory with a known `factoryId` and flags it.
- [ ] The page works on the phone layout.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
