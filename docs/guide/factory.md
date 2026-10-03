# Add a factory

This chapter shows how to add a *factory* on another computer. A factory is one complete Herdr Boss setup on one computer or container. The computer that runs factories is a *host*. Words in *italics* are in the [glossary](../glossary.md). The other chapters of the [user guide](../user-guide.md) cover the rest of the dashboard.

WARNING: No step asks you for a password, a key, or a token. Never type one into a chat or a prompt. Each step says where to put it. Keep host names, addresses, key paths, and tailnet names out of repositories, chats, and reports.

## What a factory is

You want more computing power, or a separate place for agents to work.

1. A factory runs in a container on a host. Factory zero is your own computer.
2. A host is a Windows computer with WSL2, a Linux computer, or a Mac with OrbStack.
3. Your Mac controls each host over SSH and over Tailscale.
4. The factory has its own Boss and its own projects. The Fleet page shows all factories.

## Prepare a host

You want a host that never stops and that your Mac can reach. Choose the host type.

WARNING: Docker safety (H12). Run no `docker system prune`, `docker builder prune`, `docker image prune`, `docker container prune`, `docker volume prune`, `docker rm`, `docker rmi`, or `docker volume rm` on a shared daemon. Put a label on each resource that you create. Use one buildx builder for each host.

- Windows with WSL2: follow [windows-host.md](windows-host.md). It has the 25 steps below, with the commands.
- Linux: do the Docker, Tailscale, and SSH steps of the Windows list inside the Linux system. Skip the BIOS, Windows, WSL, and boot task steps.
- Mac with OrbStack: install OrbStack. Keep its memory limit at 4 GB. Start one factory at a time.

The 25 steps of the Windows host, in order:

1. BIOS
2. Update Windows
3. Never sleep
4. Active hours
5. Install WSL
6. Install Ubuntu
7. Turn on systemd
8. Limit memory and CPU
9. Add the Docker repository
10. Install Docker
11. Configure and test Docker
12. Put the Mac on Tailscale
13. Turn on MagicDNS and HTTPS
14. Write the access policy
15. Install Tailscale in Ubuntu
16. Make the SSH key on the Mac
17. Add the public key to Ubuntu
18. Install the SSH server
19. Let SSH start after Tailscale
20. Tell the Mac which key to use
21. Create the boot task
22. Test from the Mac
23. Reboot test
24. Collect the machine facts
25. Answers and table

What you should see: each step in `windows-host.md` ends with a check. Each check passes before you start the next step.

If you do not see it: read the "If it does not work" text of the step. Do not skip a check.

## The 15 host checks

You want proof that the host is ready. Each item has a step and a check. The item numbers are the same in `windows-host.md`.

WARNING: A remote desktop session can end the work of the host. Disconnect from remote desktop. Never sign out of Windows. Windows 10 22H2 has no support. Use it for tests only. `herdr-boss doctor` warns on Windows 10.

H1: WSL never stops when idle. Step 8 puts `instanceIdleTimeout=-1` and `vmIdleTimeout=-1` in `.wslconfig`, with memory, processors, swap, and `autoMemoryReclaim`. Run `wsl --shutdown` to apply. Check: close all WSL windows. Wait 3 minutes. `wsl -l -v` still shows Running.

H2: The boot task runs as your own Windows account, also when you are signed out. Step 21 gives it two triggers: at startup, and every 5 minutes with no end. It never starts a second copy and has no time limit. Check: run `wsl --terminate <distro>`. Wait 5 minutes. The host answers again.

H3: With remote desktop, disconnect and never sign out. Check: the warning above comes before the remote desktop step (step 3 in `windows-host.md`), and `doctor` warns on Windows 10.

H4: Optional. Step 7 masks `systemd-binfmt.service`, so that systemd reports running. Check: `systemctl is-system-running` shows running, or degraded with only that unit failed.

H5: Tailscale runs inside Ubuntu, with its own name and address. The machine has `tag:factory` and key expiry off. Check: the admin console shows the tag and "expiry disabled". The host answers on its tailnet name.

H6: Step 15 gives the factory user the operator right (`tailscale set --operator=factory`) and turns on Serve for the tailnet. Check: `tailscale serve status` prints "no serve config" without sudo.

H7: Step 14 lets the Mac reach `tag:factory` on ports 22, 4477, and 4478, with rule tests for each port. Check: `nc -vz <host> 4478`. "Refused" means the Mac reached the host. A timeout means the rule is missing.

H8: Step 13 turns on MagicDNS and HTTPS certificates. Check: the tailnet name of the host resolves on the Mac.

H9: One SSH key for each host, in a Mac folder that agents cannot read (steps 16 to 19). The public key goes into `authorized_keys` of the Ubuntu factory user. The SSH server takes keys only and starts after Tailscale. Check: `sudo sshd -T` shows `passwordauthentication no`. Key login works after a reboot.

H10: Step 20 makes a Docker context on the Mac for each host (`hf-<name>`). Check: `docker --context hf-<name> ps` works without a password.

H11: The factory user is in the docker group. Docker log rotation is on (steps 10 and 11). Check: `docker info` shows the WSL memory limit.

H12: Docker safety. Run no prune or remove commands on a shared daemon. Put a label on each resource. Use one buildx builder for each host. Check: the rule shows before the first Docker command, at step 9.

H13: The code volume. Git runs as the factory user, an `origin` remote exists, and updates are fast-forward. Check: `herdr-boss factory update <name> --tier service` passes.

H14: Sign in each agent app for each factory at the host terminal. Never paste a token in a chat. Start the factory Boss. Check: `factory login <name> <app>` and `factory boss start <name>` pass.

H15: Join the Fleet page. Run connect again when the read credential is missing at first. Check: `factory connect --check <name>` shows the factory, and the Fleet page lists it.

## Create and start a factory

You want a container with its own Herdr Boss service on the host.

What you do:

1. Register the host. Run `herdr-boss factory host add <host> --from-file -`. Type the fields `address`, `user`, and `keyFile` as JSON on the input. The address stays out of the shell history.
2. Run `herdr-boss factory new <name> --host <host>`.
3. Copy the printed policy lines into the Tailscale policy file in the admin console. Only you edit the policy.
4. Run the printed `tailscale up` command on the host. Approve the new tag in the admin console.
5. Run `herdr-boss factory configure <name> --resume` if the command stopped.
6. Run `herdr-boss factory status <name>`.

What you should see: the factory has four named volumes and runs in a container. `factory new` stops with exit code 3 and one instruction file when a step waits for you.

If you do not see it: run `factory configure <name> --resume`. A host that does not answer shows `host-unreachable`. See [Something went wrong](trouble.md). Do not call a factory stopped when the host does not answer.

## Sign in the agent apps and start the factory Boss

You want the factory to run agents. Only you sign in.

What you do:

1. Run `herdr-boss factory login <name> claude` in a terminal on your Mac. Follow the sign-in page.
2. Run `herdr-boss factory login <name> codex` if you use Codex.
3. Run `herdr-boss factory boss start <name>`.

What you should see: each login prints `ok`. The Boss starts in a pane labeled `boss`. The command never starts a second Boss.

If you do not see it: the command exits with code 3 and adds one Mailbox item when a login is missing. Sign in, then run `factory boss start <name> --resume`.

## Join the Fleet page

You want to see all factories in one place.

What you do:

1. Run `herdr-boss factory connect <name>`. Connect one factory at a time.
2. Run `herdr-boss factory connect --check <name>`.
3. Open the Fleet page. Turn on **Poll registered factories** in **Fleet settings**.

What you should see: the check prints the name of the factory, its state, and the age of its summary. The Fleet page lists the factory.

If you do not see it:

- If the command exits with code 3, run one of the two printed commands in the host terminal. Then run `factory connect <name>` again. This also fixes a read credential that is missing at first.
- If you see `dashboard-unreachable`, add the port named in the message next to port 22 in the access rule. Then run the command again.

## Update a factory

You want the newest Herdr Boss code or the newest tools in a factory.

What you do:

1. Wait until no worker, suite, push, or handover is active in the factory.
2. Run `herdr-boss factory update <name> --tier service --dry-run`.
3. Run `herdr-boss factory update <name> --tier service`. This updates the code and restarts only the service.
4. For new tools, run `herdr-boss factory build <name>`. Then run `herdr-boss factory update <name> --tier image`.

What you should see: the service answers within 30 seconds. An image update keeps the four volumes and prints the command to start the Boss again.

If you do not see it: the update checks again for new work and rolls back when a check fails. Run `factory configure <name> --resume`, then retry. If the tool asks for `--accept-data-loss`, read the error first. This option can discard data written after the backup.
