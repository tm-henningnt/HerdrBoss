# 18: Factory shares and guidance

**What to build:** The Owner sets the factory share of each shared account with a slider at the head office. Each factory enforces its share and gets nudges at its Boss.

**Blocked by:** 17: Head office poller and Fleet page.

**Status:** ready-for-agent

- [ ] The head office shows one slider per factory in the account scope of each shared account. The shares of one account total at most 100.
- [ ] `POST /api/fleet/guidance` accepts shares and nudges from the `fleetGuide` credential only. `fleetRead` gets 403.
- [ ] The factory refuses guidance with a lower epoch than the last one it saw.
- [ ] The factory pacing uses its factory share as a ceiling on top of the project shares, and keeps the last share when the head office is offline.
- [ ] A nudge reaches the factory Boss pane as an agent message.
- [ ] The `fleetGuide` credential cannot change policy, start or stop workers, or read message text.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
