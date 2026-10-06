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

- Windows with WSL2: follow [windows-host.md](../windows-host.md). It has the 25 steps below, with the commands.
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

What you should see: each login prints `ok`. The Boss starts in a pane labeled `boss`. The command never starts a second Boss. Both commands first prepare the first-run state of the agent app in the factory, so no setup dialog waits for a key. If a dialog still shows, the error names the dialog and the pane.

The factory image holds the pinned CodexBar CLI, and a service update installs or repairs it in the home folder of the factory user. Herdr Boss reads each usage limit with `codexbar usage --format json --provider <p>`, the same code path as the Mac. It falls back to the Codex app server and the Claude status line when CodexBar is missing, exits with an error, returns an error row, or times out. The Settings row of each provider names the source of the reading and its age. OpenCode Go shows the local cost history from CodexBar. The account windows of OpenCode Go need an OpenCode API key: until the key exists, the reason text is `account windows need an API key`. Set the reset time by hand in **OpenCode Go reset time** in the **Usage limit** group of Settings. Herdr Boss also shows a local estimate with the label `used in this factory (local estimate)`: the tokens and the cost of `opencode stats --models --days N` for this factory, where N is **OpenCode Go estimate days** (default 7). The estimate is never a percent and never a quota. When `opencode stats` lists no OpenCode Go use, the card shows `no local use found`. A reader child gets only the variables `PATH`, `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `LANG` and `TERM`. The Fleet page shows it in the card of the factory. Herdr Boss does not treat the unknown reading as a failure. A Codex rate limit or backend error is a probe failure. Herdr Boss then keeps the last good Codex reading as stale. It sends no Boss warning, and it backs off no provider. Herdr Boss reads the Claude usage limit from the Claude status line. The factory image runs the command `herdr-boss claude-statusline` as the status line of the factory user. Claude Code sends the status line JSON to the command on each update. The command keeps the two usage windows and the time. It writes them to a private file (mode 0600) in `/home/factory/.herdr-boss/claude-rate-limits/`. It writes no other field, and no token. The Claude usage limit is available only while a Claude session runs in the factory. Until the first report, the reading is unknown with the reason `no Claude session has reported usage yet`. A report is not used after its window reset. The reading is then unknown with the reason `the last Claude usage report is past its reset`, or `the last Claude usage report is older than 3 hours and past its reset`. A report older than 3 hours with an open window is a probe failure. Herdr Boss keeps the last good Claude reading as stale, and the reading turns unknown later. The container start script sets the `statusLine` key in `/home/factory/.claude/settings.json` and no other key. If the factory user already has a different `statusLine`, the script keeps it, prints a message, and installs no helper. Remove that `statusLine`, then restart the container. The helper never changes a file on the Mac. To turn the helper off, clear **Claude usage helper in factories** in Settings, in the **Service** group of the factory dashboard. Select Save. The switch is read in the data folder of the factory. Set it in the Settings or the `config.json` of that factory. The value on the Mac does not reach a factory. The next container start removes the entry that the helper installed.

The factory Boss starts projects with `herdr-boss project new <slug>`. In a factory, the command needs no `--group` or `--path`. It creates the project in `/home/factory/work`. It marks the folder as trusted for the agent app, so the orchestrator starts without a trust dialog. The command also sets the Git identity `Herdr Factory <factory@localhost.invalid>` for the factory user. It keeps an identity that already exists.

If you do not see it: the command exits with code 3 and adds one Mailbox item when a login is missing. Sign in, then run `factory boss start <name> --resume`.

## Join the Fleet page

You want to see all factories in one place.

What you do:

1. Run `herdr-boss factory connect <name>`. Connect one factory at a time.
2. Run `herdr-boss factory connect --check <name>`.
3. Open the Fleet page. Turn on **Poll registered factories** in **Fleet settings**.

What you should see: the check prints the factory name, state, and summary age. The Fleet page lists the factory. Select **Fix** to show an alert fix. Copy a command and run it in the Owner terminal. Follow an instruction in words. An expired login shows `Waiting for you: login-HARNESS` and its wait age in the factory card. For a container, copy its `factory login` command. For a native factory, sign in the agent app in a terminal on this Mac. A host action opens a confirm sheet with **Confirm copy** and **Cancel**. The page runs no command.

If you do not see it:

- If the command exits with code 3, run one of the two printed commands in the host terminal. Then run `factory connect <name>` again. This also fixes a read credential that is missing at first.
- If you see `dashboard-unreachable`, add the port named in the message next to port 22 in the access rule. Then run the command again.

## Attach Herdr on the Mac to a factory

The Herdr server of a factory runs in its container. The container runs an SSH server. The container publishes that SSH port only on the loopback address of the factory host. A tailnet rule does not open it.

Herdr on the Mac connects over SSH, not over a published port. `herdr machine add` takes an SSH target and needs plain OpenSSH. An SSH connection uses the key of the Mac user. It needs no new open port and no new password. FT22 can reuse these steps in the host guide.

Do these steps on the Mac. Run each check before the next step.

1. Run `herdr-boss factory attach NAME`.
   - Check: the output says `SSH alias hf-NAME is ready.`
2. Read the line that the command prints for `~/.ssh/config`. The command saves the old file as `~/.ssh/config.herdr-boss.bak` first (`.bak.1`, `.bak.2` when a backup exists). It follows a symlink. It adds the line once, at the top of the file.
   - Check: `ssh -G hf-NAME` prints the user `factory` and `proxyjump hfj-NAME`.
3. Wait for the key message. The command adds the Mac key to the factory only when it is missing. The key file must have no passphrase.
   - Check: the output says `Added the Mac key to the factory.` or `The Mac key is already authorized in the factory.`
4. Wait for the machine step. The command makes the first SSH contact itself. It then reuses a machine that has the target `hf-NAME`. Otherwise it runs `herdr machine add --label NAME hf-NAME`.
   - Check: `herdr machine list` shows the label `NAME` once.
5. Wait for the last checks. The command runs `herdr machine status ID --json` and `herdr --machine ID workspace list`.
   - Check: the exit code is 0 and the last lines show the alias, the sidebar label, and the detach command.
6. Optional: outside a Herdr pane, the command also runs `herdr --remote hf-NAME` with an 8-second limit. Inside a Herdr pane it skips this check, because a nested Herdr is off by default. A run that reaches the limit is inconclusive. A failure of this check does not fail attach.

Each factory has its own host key line in `~/.ssh/known_hosts`, named `hf-NAME` (`HostKeyAlias`). This stops a warning when two factories use the same loopback port behind the jump host. Attach never edits `known_hosts`. If you rebuild a factory, its host key changes. Then the message says: `The host key of hf-NAME changed. If you rebuilt the factory, remove the old line with: ssh-keygen -R hf-NAME`. Run that command and attach again.

If a step fails, the message names the step (ssh check, machine list, add, status, api check, or remove) and shows the masked output of the failing command. It shows no address, host name, user, port, or key path. Fix the cause and run the same command again. The command keeps one include file and one machine.

The Herdr sidebar shows the factory under the label `NAME`. Select it to work in the factory. The Fleet page shows `Attach: attached` for the factory.

To detach, run `herdr-boss factory attach NAME --undo`. The command removes the Herdr machine only when attach created it. It removes the Mac key line only when attach added it. It removes the include file `~/.ssh/herdr-boss.d/hf-NAME.conf`. It removes the Include line when attach added it and no other factory is attached. It removes an empty `~/.ssh/config` only when attach created it. It never changes another entry. Run the command again to see `nothing is left to undo`.

## Update a factory

You want the newest Herdr Boss code or the newest tools in a factory.

What you do:

1. Wait until no worker, suite, push, or handover is active in the factory.
2. Run `herdr-boss factory update <name> --tier service --dry-run`.
3. Run `herdr-boss factory update <name> --tier service`. This updates the code and restarts only the service. It also sets the Git identity of the factory user when none exists. The step installs or repairs the Claude usage helper, as `factory configure` does. It prints `Claude usage helper: installed.` or the reason, and a failure does not change the exit code. The Fleet card shows its state.
4. For new tools, run `herdr-boss factory build <name>`. Then run `herdr-boss factory update <name> --tier image`.

The factory Boss writes its notes to `~/work/boss-notes/memory.md`. The update ignores this file. A local change in a tracked file of the checkout stops the update and the error names the file.

What you should see: the service answers within 30 seconds. An image update keeps the four volumes and prints the command to start the Boss again.

If you do not see it: the update checks again for new work and rolls back when a check fails. Run `factory configure <name> --resume`, then retry. If the tool asks for `--accept-data-loss`, read the error first. This option can discard data written after the backup.

## Move the head office

The head office is the factory that polls the other factories and sends factory shares and nudges. One factory holds the role at a time. The role has an epoch. Each move adds 1 to the epoch. The Fleet page shows the holder and the epoch.

WARNING: Keep head office polling off on a factory until `hub promote` makes it the holder. A factory with polling on and no role record counts as the holder, and `hub promote` then changes nothing.

WARNING: Run the move only when the Owner decides it. The planned move to the Windows factory waits for 7 clean days of that factory. Do not run the move before that. A command that fails with `Refused` changes nothing.

A factory that has factories in its registry accepts a new head office holder only when the holder is in that registry. A factory with an empty registry is not a head office. It accepts the holder on the strength of the guide credential and the epoch rules. The limit of 1000 above the stored epoch applies in both cases.

Before each move, check these items on the factory that takes the role:

1. The registry lists every factory, and the former holder is in it. The registry has each host that the moved factories use. The move never copies a host record.
2. The factory has a guide credential for each other factory. Import each with `herdr-boss fleet guide-token set FACTORY --from-file FILE`.
3. The factory has a read credential for each other factory.
4. The account digests and scopes match the former holder. Use `herdr-boss fleet account --from-file FILE`.

### Planned move

Use this procedure when the former holder is running.

1. Open the Fleet page. Read the holder and the epoch.
2. Open an Owner terminal on the factory that takes the role.
3. Run `herdr-boss hub promote`.
4. If the command prints `Refused`, read the factory names and the reason codes. Make each factory reachable. Run the command again. If the message says that another head office holder exists, two factories promoted at the same time. Run the command again to take a higher epoch.
5. Read the result. It shows the new epoch, the factories told, and the handover line.
6. Check: the handover line says `received`. If it says that the factory keeps its own copy, read the reason. If a line lists host IDs that are not in the registry, add each host and register those factories. Then compare the factory list and the factory shares on the Fleet page.
7. Open the Fleet page on the new holder. Check: the Head office panel names this factory and the new epoch.
8. Open the Fleet page on the former holder. Check: the panel names the new holder and says that the former holder does not poll.

### Move after a host failure

Use this procedure when the host of the head office fails.

1. Choose a factory that is always on. The Mac sleeps, so do not choose the Mac as a standby.
2. Open an Owner terminal on that factory.
3. Run `herdr-boss hub promote`. The command refuses because the failed factory cannot be reached.
4. Run `herdr-boss hub promote --force`.
5. Read the result. The failed factory is in the line `Not told`. The handover line says that this factory keeps its own copy.
6. Check the registry and the factory shares on the Fleet page. Set the factory shares again if they are old.
7. Repair the failed host. When its service starts, it still shows the old epoch. The new holder sends the record at the next successful poll. It stops after 20 attempts or 24 hours. The Fleet page then lists the factory as never told. The old holder stops polling and sending guidance when it gets the record.

If the repaired factory still polls after the new holder polled it, open Fleet settings on the repaired factory and turn off head office polling.

What you should see: the Fleet page works on the new holder while the former host is off.

If you do not see it: read the reason code for each factory. `no-credential` means that the guide credential is missing. `auth` means that the credential is old. `unreachable` and `timeout` mean a network or host problem.
