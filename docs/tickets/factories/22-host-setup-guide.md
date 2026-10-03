# 22: Interactive host setup guide in the dashboard

**What to build:** A dashboard page under Factories, "Add a host", walks a user through the preparation of a new factory host. The Owner's reference artifact (an interactive checklist that collected values and produced the host tables) defines the content.

**Blocked by:** 09: Host tool core with the local transport; 10: Factory wizard and harness login; 11: The ssh transport and the Windows host runbook.

**Status:** ready-for-agent (the reference artifact comes from the Owner)

- [ ] The user picks the host type: Windows with WSL2 first, then Linux, then Mac with OrbStack. Each type has its own checklist page.
- [ ] Each step shows what to do and why in plain words, the exact commands with copy buttons, the expected result, a done checkbox, and a "something went wrong" panel with the three most common errors and their fixes.
- [ ] The page asks for the values that the tool needs: machine label, role, tailnet name, user, key fingerprint, versions, memory limits, account names. It checks each format while the user types. It never asks for a secret and says where to put it.
- [ ] A "Test from this machine" button runs each check that the host tool can run: host answers on the tailnet name, key login works, Docker answers over the context, systemd state, Docker memory limit, sshd password login off, reboot test. Each check shows a green or red mark, the failing command, and the next step.
- [ ] The page generates the host registry entry and the summary table, saves its progress so that the user can continue later, and posts nothing without a click.
- [ ] The state machine is resumable and idempotent, in the style of `project new` and the factory wizard. It feeds steps 1 to 4 of the wizard.
- [ ] The text uses short sentences. A glossary tooltip explains WSL, systemd, Tailscale, SSH key, and Docker context. A warning comes before each action that is hard to undo.
- [ ] Private values are stored only in the registry outside the repository. No test, doc, or command text contains a private value.
- [ ] The wizard links to this guide when a host check fails.
- [ ] Tests cover the page state machine with fixtures, the format checks, and the command text.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
