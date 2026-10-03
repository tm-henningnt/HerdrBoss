# 22: Interactive host setup guide in the dashboard

**What to build:** A dashboard page under Factories, "Add a host", walks a user through the preparation of a new factory host. The Owner's reference artifact (an interactive checklist that collected values and produced the host tables, kept outside the repository) defines the content and wording. Do not copy any private value from it into the repository.

**Blocked by:** 09: Host tool core with the local transport; 10: Factory wizard and harness login; 11: The ssh transport and the Windows host runbook.

**Status:** ready-for-agent (not started before 2026-10-04)

**Windows with WSL2 steps (the guide covers at least these, in this order):** BIOS; update Windows; never sleep; active hours; install WSL; install Ubuntu; turn on systemd; limit memory and CPU (collects the thread count); add the Docker repository; install Docker; configure and test Docker; put the Mac on Tailscale (collects the Mac name); turn on MagicDNS and HTTPS (collects the tailnet name); write the Tailscale access policy; install Tailscale in Ubuntu (collects the Tailscale address); make the SSH key on the Mac (collects the fingerprint line); add the public key to Ubuntu; install the SSH server; let SSH start after Tailscale (systemd ordering); tell the Mac which key to use (SSH config entry); create the boot task; test from the Mac; reboot test; collect the machine facts; answers and the final table.

The BIOS and Windows update steps use plain words. Treat `systemd-binfmt.service` as the only accepted failed unit when the guide checks the systemd state.

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
