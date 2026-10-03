# Factories reference

## Factory hosts

A factory host is a machine that runs factories. The host registry lists the hosts that `herdr-boss factory` can reach. Each entry has a name, an address, a user, and the path of an SSH key file. It also stores the runtime, the personal-only flag, and the Codex sandbox setting. The registry is in `~/.herdr-factories/registry.json` and holds no key content.

Add a host with `herdr-boss factory host add`. Give the connection fields as JSON on stdin so that the address stays out of the shell history. Set `runtime`, `personalOnly`, and `codexSandbox` in the same JSON, or use `--runtime`, `--personal-only`, and `--codex-sandbox`. The Codex setting `user-namespaces` uses the tested custom seccomp profile and `systempaths=unconfined`. The setting `unavailable` keeps the Docker default and excludes Codex from the factory. A remote host with no Codex setting defaults to `unavailable`. List the hosts with `herdr-boss factory host list`. The list shows the name and the user only.

Run a command on a host with `herdr-boss factory ssh HOST -- COMMAND...`. Run Docker on a host with `herdr-boss factory docker HOST -- ARGS...`. Herdr Boss masks the full address before the key file name. It masks the host name, every IP address, the key file path, and tokens that end in `.ts.net`. See `docs/cli.md`, section Factory hosts.

Use [the Windows host runbook](../windows-host.md) to set up a Windows factory host. It covers the VM limits, systemd, Docker Engine, key login, Tailscale, the boot task, and recovery without a Windows sign-in.

## Container factories

Create a personal factory with `herdr-boss factory new NAME`. Use `--host HOST` for a remote host connection. Add its Docker context with `factory host add HOST --docker-context CONTEXT`. The tool stores this name in the private connection file. The fleet file refers to that connection by name only. `factory new` prints the Tailscale tag and policy lines for the factory, then prints a `tailscale up` command for the host. The command does not change the tailnet. Port 443 is the HTTPS port of Tailscale Serve. The tool omits the client-factory grant on a personal-only host.

Each factory has four labeled volumes, its own hostname, and loopback ports. The image holds tools and a public seed checkout. The volumes hold the service data, home, work, and code. The host tool does not mount the Mac home or the Docker socket.

Use `factory start`, `factory stop`, `factory status`, and `factory list` to control and check the factories. A host timeout shows `host-unreachable`. A stopped container and an unhealthy container have different states. Unknown readings stay unknown.

`factory new` checks the container, volumes, Herdr server, and service. Use `factory configure NAME --resume` to check them again. The flow stops when a check fails. A container safety failure disables Codex for that factory. When the checks pass, the wizard exits 3 and writes one Owner instruction file. Use an Owner terminal for a login. Keep all codes and tokens out of agent panes and Mailbox answers.

Run `herdr-boss factory login NAME claude` or `herdr-boss factory login NAME codex` to sign in to that harness in the labeled factory container. The command attaches the terminal to the harness login, then checks login with a harmless command. It prints only `ok` or `failed` after the check.

Run `herdr-boss factory boss start NAME` to start the factory Boss. Claude is the default harness. The command checks the harness login and installs the kit in the Boss and project folders when needed. It checks Herdr and creates or reuses the Boss workspace and pane. It starts the harness with the factory prompt and checks that the prompt is ready. Use `--harness codex` to choose Codex. `--resume` continues when the idle Boss pane has an agent for the selected harness. The full Boss prompt must be typed but unsent. The transcript must have no Boss prompt marker. For all other live Boss states, the command prints the state and exits 0. A missing login or an unsent prompt exits 3 and creates one Mailbox item with the command to continue. Use `--dry-run` to print the plan without changes. The factory keeps its project, message, and handover state in its own volumes.

The service health check uses container loopback. A request with the factory hostname still needs a login. Its response of 401 confirms that the host rule accepts that name.

Update code with `factory update NAME --tier service`. This fast-forwards the code volume and restarts the Herdr Boss service. Existing panes stay available.

Update harnesses and tools with `factory build NAME`, then `factory update NAME --tier image`. This replaces the container and keeps the four volumes. It starts fresh sessions only for active project orchestrators. A paused project stays paused.

The image update refuses a live Boss pane unless you add `--allow-boss-restart`. The update never starts a Boss session. When the flag allows replacement, it prints: The Boss pane is gone. Run 'herdr-boss factory boss start NAME' to start the Boss in the factory.

An update stops when a worker works, a suite or push holds the full-suite lock, or a handover is prepared or in progress. Use `--dry-run` to check the factory and print the selected tier without changing Docker resources. The tool makes a private backup before it changes the factory.

After the backup, it takes a fresh work snapshot before it merges code or replaces the container. A snapshot must be no more than 15 seconds old. The tool checks for new work again. The image tier also checks for a live Boss pane. If a check fails, it resumes the factory and prints `herdr-boss factory configure NAME --resume` as the check and retry path.

It checks `/api/state` and one clean service tick within 30 seconds. It restores the previous code or image when the check fails. If the schema increased or cannot be read after the new container starts, review the failure and rerun the same update with `--accept-data-loss` to restore the backup. This can discard data written after the backup. If the new container never starts, rollback does not restore data or need this flag. See the [factory host runbook](../factory-host-runbook.md#factory-updates) for the update and rollback procedure.

Back up a factory with `factory backup NAME`.
The command stops a running factory.
It removes its labeled archive helper before it restarts the source.
If helper cleanup fails, the source stays stopped.
It stores a SQLite snapshot, data files, and work files in a private `.hfb` file.
Use `--include-home` to include logins and SSH host keys.
Store the file outside repositories and cloud folders.
Its mode is 600, and its folder mode is 700.
The default folder is the private connection store's `backups` folder.
Use `--file FILE` to choose an absolute destination.

Restore it with `factory restore FILE [--host HOST]`.
The matching image must be available.
The factory name, ports, and volumes must be free.
The command restores data and work before the service starts.
The code volume comes from the image.
Apply later service updates again.
After a lost create reply, restore checks the target container and four volume names.
It removes only resources with matching factory and worker labels.
It removes its archive helper before volume rollback.
A helper cleanup failure keeps the volumes and the pending record for repair.
A different resource label keeps that resource unchanged.
The pending record also stays available if a label differs or the host cannot answer.

Use `factory destroy NAME` to remove the container and its four volumes.
Keep a recorded backup from the last 24 hours that includes home.
Back up with `--include-home` before destroy.
Restore and destroy each require the exact factory name typed at an Owner terminal.
The tool keeps the image, builder, host connection, and backup.
It never prunes the daemon.

For a dead service, use `factory logs NAME` and `factory shell NAME`.
Use `factory freeze NAME` to pause all container processes.
Use `factory freeze NAME --off` to resume them.
Use `factory stop NAME --now` to stop the container at once.
These commands go directly to Docker.
They do not need the service or a current factory version.
Docker must remain reachable.
Keep tokens and login files out of terminal output.

The private host connections stay outside the dashboard because they hold private connection fields. The host tool controls the container resources. This release has no dashboard controls for factory creation and recovery. Recovery paths stay private, and restore and destroy require an Owner terminal. See `docs/cli.md`, section Container factories.

## Fleet

Factory zero can hold the head office role.
Open **Fleet** to see the available factory summaries.
Turn on **Poll registered factories** in **Fleet settings**.
If a fleet file or a fleet setting is invalid, the dashboard still starts. **Fleet settings** shows the default values and an error text. Correct the value and save it.
The Fleet page starts a poll when it has no factory row. It starts at most one such poll in 30 seconds.
The head office reads the registered factories every 30 seconds.
A factory outage keeps the last good summary.
The page shows the age and marks that factory offline.
An offline health cell is red. It shows the reason: host unreachable, request timeout, read credential refusal, or contract mismatch.
**Last seen** shows the time of the last successful poll. The summary age continues to increase during an outage.
Before the first successful poll, the page shows **Never seen**. The registered software and kit revisions remain visible.
A duplicate factory ID gets a warning.
The head office refuses the duplicate summary.

Connect a registered container factory with `herdr-boss factory connect NAME`. Run it for one factory at a time. The command sets up Tailscale Serve, imports the private read credential, and enables polling. It reuses an existing matching HTTP or HTTPS forward. The container port stays on loopback. A dashboard request still needs Owner access. If the factory user cannot configure Serve, the command prints two Owner command choices and exits 3. Run one choice in the WSL Owner terminal. Run `factory connect NAME` again to resume. Use `herdr-boss factory connect --check NAME` for one check. Its one-line result holds the name, state, and summary age only. See `docs/cli.md`, section Container factories.

The factory table shows projects, the highest quota reading, spend today, Owner items, and software and kit revisions.
A different software version or kit revision gets a drift label.
The quota view groups readings by account digest and lane.
It shows the highest reading of each group.
It does not add repeated readings of a shared quota pool.
An unavailable reading stays unknown.
The spend view shows USD by factory, day, role, and harness.
These amounts are API-price equivalents.
An unpriced amount stays unknown.

The **Fleet Mailbox** lists Owner items from the available summaries.
Each item has a factory tag.
Open its link to answer in the factory that owns the item.
The ordinary Mailbox has the same combined list in a collapsed section when remote factory data is available.
Message text stays in its factory.
On a phone, each comparison table scrolls inside its own region.

Each personal factory shares item titles by default.
Turn off **Share item titles** to export only item IDs and kinds.
The setting affects new summaries.
A previously accepted title can remain in the head office's last good data during an outage.
Set each account scope to the factory IDs that may use that account.
Provision an account digest through the private `fleet account` command first.
The data file holds the digest and scope only.
It holds no account identity or HMAC key.
Account scopes in this slice control which quota rows leave a factory.
They do not enforce a factory share.

The head office gets no local path, token, transcript, command output, or message text from a summary.
The fleet read credential has separate storage and permissions from Owner access.
It can read summary and health only.
Private provisioning commands are in `docs/cli.md`.
This slice has no guidance, policy push, or message routing.
