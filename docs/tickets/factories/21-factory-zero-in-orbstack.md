# 21: Move factory zero into OrbStack on the Mac

**What to build:** The projects of factory zero move one at a time into a personal container factory on the Mac. The native service retires after the last move.

**Blocked by:** 15: Service and image updates; 19: Head office role record and the move to Windows; 20: Project transfer, small form.

**Status:** ready-for-agent

- [ ] A personal container factory runs on the Mac in OrbStack beside factory zero, built for arm64.
- [ ] Each project moves with a transfer, and each move can be cancelled.
- [ ] The native launchd service stops only after the last project moved and the Owner confirmed.
- [ ] The OpenCode Go subscription in the account scope of the Mac factory works in the container.
- [ ] The user guide describes the Mac setup after the move.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
