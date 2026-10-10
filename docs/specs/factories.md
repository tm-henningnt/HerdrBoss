# Spec: the personal factory fleet

Status: proposed for Owner approval. Source: the proposal `docs/ideas/factories.md`, the factories interview (rounds 1 to 3 and the final pack), and ADRs 0002 to 0023. The glossary is `docs/CONTEXT.md`. The tickets are in `docs/tickets/factories/`.

## Problem Statement

The Owner runs all Herdr projects in one factory: factory zero, native on the Mac. The Mac has limited memory and sleeps. The Owner has a Windows home server with an i9 CPU and 64 GB of memory that does no factory work. The Owner wants to use both machines, and later a third, for personal projects.

Today Herdr Boss knows one machine only. It cannot start a factory in a container, reach a factory on another host, show the state of several factories in one place, or divide one Claude or Codex subscription between factories. Two factories that pace against the same subscription use it up twice as fast.

## Solution

The Owner runs a fleet of personal factories. Factory zero stays native on the Mac at first. The first container factory runs on the Windows home server in Docker Engine in WSL2. Later, factory zero moves into OrbStack on the Mac, and a third factory runs on a second Windows host. The design has no fixed limit on the number of factories.

The Owner uses these parts:

1. **The factory image.** Each host builds one image from a public Dockerfile and a pins file. A container made from the image is a complete factory: Herdr server, Herdr Boss service, sshd, the harnesses, and Chrome.
2. **The host tool**, `herdr-boss factory`. It runs on the Mac. It builds the image, creates, configures, starts, stops, updates, backs up, and restores factories. It reaches the Windows host over Tailscale and SSH.
3. **Herdr over SSH.** The Owner attaches to each factory from the Mac with Herdr. The Herdr sidebar shows the agents of all factories.
4. **The head office.** One factory holds the head office role. It polls a small fleet summary from each factory and shows the Fleet page: state, quota, spend, and Owner items of all factories. It sets the factory share of each shared account with a slider and sends guidance to each factory Boss.
5. **Project transfer.** The Owner moves a project from one factory to another through GitHub, with a freeze and a confirmation.

The Owner talks to each factory Boss directly. The head office is code, not an agent.

## User Stories

### Spike and image

1. As the Owner, I want a half-day spike on the Mac, so that I know if Herdr, Herdr Boss, and the harnesses work in a container before the main build starts.
2. As the Owner, I want the spike repeated on the Windows host, so that I know if the Codex sandbox and the Herdr server work in WSL2.
3. As the Owner, I want a spike report with measured numbers, so that the plan uses facts and not estimates.
4. As the Owner, I want each host to build its own image, so that I pay for no registry.
5. As the Owner, I want the image to hold no data and no secret, so that a public Dockerfile is safe.
6. As the Owner, I want every tool version pinned in one file, so that two builds from the same pins give the same tools.
7. As the Owner, I want harness self-update turned off in a factory, so that a harness changes only with an image rebuild.
8. As the Owner, I want `factory status` to show the image build date and the pins hash, so that I see the drift between hosts.
9. As the Owner, I want a supervisor in the container that restarts a crashed service, so that a dead Herdr Boss service comes back without me.
10. As the Owner, I want a health check on each factory, so that Docker and the head office know when a factory is unhealthy.
11. As the Owner, I want the full test suite to pass inside the image, so that the Linux code paths have a test gate.

### Linux portability

12. As a factory, I want to read memory, pressure, and CPU from Linux and from cgroup limits, so that the machine guard uses the limits of my container and not the host totals.
13. As a factory, I want my data directory to be the live data directory, so that the engine acts (prompts, reaping, notices) and the migration guard protects my data.
14. As a factory, I want the dashboard to accept my own hostname, so that a login to one factory does not overwrite the session cookie of another factory.
15. As the Owner, I want the server log on stdout and rotated on disk, so that a factory does not fill its disk.
16. As the Owner, I want a clock offset check in the health route, so that a VM clock drift after a sleep shows before it breaks quota reset times.
17. As the Owner, I want the Chrome path to be a setting, so that the same code runs Chrome on macOS and on Linux.

### Browser sign-in

18. As the Owner, I want to sign in to a web app in the headless Chrome of a container factory through its dashboard, so that browser and Qlik projects can run in a container factory.
19. As the Owner, I want to type a password and a one-time code into that browser, so that a sign-in with two factors works.
20. As the Owner, I want the sign-in to stay in the project's Chrome profile on the factory, so that I sign in once for each project.
21. As the Owner, I want only the owner of a factory to use the sign-in view, so that a viewer cannot drive a signed-in browser.

### Host tool and hosts

22. As the Owner, I want `factory new NAME --profile personal`, so that one command creates the volumes, the image, and the container of a new factory.
23. As the Owner, I want `factory start`, `factory stop`, `factory status`, and `factory list`, so that I control and see all factories from the Mac.
24. As the Owner, I want each factory to have its own hostname and ports, so that two factories on one host do not collide.
25. As the Owner, I want every volume labeled, so that a prune command with a label filter cannot delete factory data.
26. As the Owner, I want the host tool to refuse a `client` profile on a host whose runtime is for personal use only, so that I do not break the OrbStack licence terms.
27. As the Owner, I want the host tool to refuse to run inside a container, so that it never runs where it cannot repair a factory.
28. As the Owner, I want each host tool release to state a minimum factory version, so that an old factory gets a clear message and not a broken command.
29. As the Owner, I want the host tool to reach the Windows host over Tailscale and SSH, so that I manage all factories from the Mac.
30. As the Owner, I want a runbook for the Windows host, so that I can set up WSL2, Docker Engine, systemd, the boot task, and Tailscale once.
31. As the Owner, I want the factories on the Windows host to start again after a Windows update reboot without a sign-in, so that the factories run unattended.
32. As the Owner, I want the host tool to print the Tailscale tag and access rule lines for a new factory, so that the tailnet allows only the needed paths.

### Wizard and logins

33. As the Owner, I want `factory configure NAME` to walk through 9 checked steps, so that a new factory is ready without a manual checklist.
34. As the Owner, I want the wizard to resume at the first failed step, so that a stop in the middle loses no work.
35. As the Owner, I want `factory login NAME HARNESS` at a host terminal, so that a device code never goes into `docker logs`, the Mailbox, or a pane.
36. As the Owner, I want the wizard to exit with code 3 when it waits for me, so that an agent knows to stop and post one Mailbox item.
37. As the Owner, I want each harness login checked with a harmless call, so that a wrong login shows at once.
38. As the Owner, I want an expired login to pause only that factory and post one item with the re-login command, so that one bad login does not stop the fleet.

### Quota and guidance

39. As the Owner, I want each harness account to have an account scope, so that an OpenCode Go subscription serves only one or two factories.
40. As the Owner, I want one slider per factory for each shared account at the head office, so that I set how much of one Claude or Codex subscription each factory may use.
41. As a factory, I want to read the usage of my own accounts, so that I pace against the real pool.
42. As a factory, I want to enforce my factory share locally, so that my pacing stays correct while the head office is offline.
43. As a factory Boss, I want guidance from the head office (my factory shares and nudges), so that I slow down or speed up my orchestrators as the Owner wants.
44. As the Owner, I want the guidance credential to be unable to change policy, start or stop workers, or read message text, so that a taken head office cannot direct my factories.
45. As the Owner, I want quota rows to carry an account key that is an HMAC of the account identity, so that the head office groups factories by account without seeing the identity.

### Head office and Fleet page

46. As the Owner, I want the head office to poll a small fleet summary from each factory every 30 seconds, so that the Fleet page shows all factories.
47. As the Owner, I want a factory outage to show as the last good data with its age, so that I see how old the information is.
48. As the Owner, I want a test to fail when a fleet summary key is not on the allow-list, so that no path, token, or message text leaves a factory.
49. As the Owner, I want item titles from personal factories on the Fleet page, so that I see what waits without opening each factory.
50. As the Owner, I want the head office Mailbox view to link each item to its factory, so that I answer in the factory that owns the item.
51. As the Owner, I want the Fleet page to show the version and kit drift of each factory, so that I see which factory needs an update.
52. As the Owner, I want a read-only fleet credential, separate from the guidance credential, so that a leaked read credential gives no control.
53. As the Owner, I want a factory to keep its `factoryId` in its data directory and the head office to refuse a duplicate, so that a cloned volume does not look like the same factory.

### Head office role

54. As the Owner, I want a role record with an epoch, so that each head office term has a number and an old holder can be ignored.
55. As the Owner, I want `hub promote` to move the head office role to another factory, so that I can move the role by hand when its host fails or when I plan a move.
56. As the Owner, I want the head office to move to the Windows home server after its factory runs clean for 7 days, so that the fleet view works while the Mac sleeps.
57. As a factory, I want to ignore guidance with a lower epoch than the last one I saw, so that an old head office cannot change my factory shares.

### Updates and recovery

58. As the Owner, I want `factory backup` and `factory restore`, so that I can recover a factory from a backup.
59. As the Owner, I want a backup that holds the `home` volume to be stored at mode 0600 and outside every repository and cloud folder, so that harness logins in the backup stay private.
60. As the Owner, I want `factory destroy` to need a fresh backup and a typed confirmation, so that I cannot delete a factory by mistake.
61. As the Owner, I want `factory shell`, `factory logs`, and `factory stop --now`, so that I can repair a factory whose service is dead.
62. As the Owner, I want `factory update NAME --tier service`, so that a Herdr Boss code update needs no image swap and keeps the panes.
63. As the Owner, I want `factory update NAME --tier image`, so that a tool or harness update replaces the container on the same volumes.
64. As the Owner, I want an update refused while a worker works, a suite or push holds the lock, or a handover is prepared, so that an update never breaks running work.
65. As the Owner, I want a backup before each update and a check of `/api/state` within 30 seconds after it, so that a failed update rolls back.
66. As the Owner, I want `--dry-run` on each update, so that I see what an update will do.

### Project transfer

67. As the Owner, I want `project transfer plan SLUG --to FACTORY`, so that I see if the target can take the project before anything changes.
68. As the Owner, I want both factories to refuse `worker start` for the project during a transfer, so that no work starts in two places.
69. As the Owner, I want a transfer to stop when unpushed work exists, and to list it, so that no work is lost.
70. As the Owner, I want the target to clone from GitHub, run `kit install`, and start a fresh orchestrator that reads `memory.md`, so that the project continues as after a handover.
71. As the Owner, I want to confirm the switch, and to cancel before it, so that the source stays in control until I decide.
72. As the Owner, I want secrets and logins to stay at the source, so that a transfer never moves a credential.
73. As the Owner, I want Owner items, review packs, and message text to stay at the source, so that no text moves through the head office.

### Factory zero in a container

74. As the Owner, I want to build a container factory on the Mac beside factory zero, so that I can move factory zero into OrbStack without a stop.
75. As the Owner, I want to move the projects of factory zero one at a time with a transfer, so that each move can be cancelled.
76. As the Owner, I want to retire the native service only after the last project moved, so that I always have one working factory on the Mac.

### Scope and safety

77. As the Owner, I want `PRODUCT.md` and `AGENTS.md` to state that Herdr Boss covers all factories of the Owner, so that the scope matches the work.
78. As the Owner, I want host secrets, SSH keys, and fleet credentials stored where agents must not read them, so that an agent in factory zero cannot take over another factory.
79. As the Owner, I want the host tool to check each profile and fixture with the secret scan, so that the public repository holds no private data.

## Implementation Decisions

### Shape

- One container is one factory. The process table, the loopback ports, and the Herdr socket stay in one namespace.
- A factory talks only to its own Herdr socket. The head office reads state over HTTP and never parses Herdr output. Herdr carries no fleet data.
- A factory keeps all message text, transcripts, paths, and secrets. The head office gets counts, states, titles of personal factories, and links.

### Factory image (ADRs 0003, 0007, 0010, 0015)

- Base: Debian trixie slim. Contents: s6-overlay as PID 1 with one supervised service each for sshd, `herdr server`, and `herdr-boss serve`; ca-certificates, curl, git, openssh-server, procps, lsof, ripgrep, jq; Node 26.10 or newer; gh; Herdr at a pinned version (0.9.3 or newer); Claude Code, Codex CLI, OpenCode, and Pi; Chrome; a seed checkout of Herdr Boss with its `.git` directory.
- The initial harness set includes Claude Code, Codex CLI, OpenCode, and Pi. The set is open. `qlik-cli` comes in a later image change. `qlik-cli` for arm64 builds from source in a Go build stage.
- A non-root user `factory` with UID 1000. `TZ` set in the image. A `max-size` on the Docker log driver. A Docker `HEALTHCHECK` on `/api/health`.
- One `pins.json` holds every version. Pins go into OCI labels.
- Harness self-update is off. A harness update is an image rebuild.
- Pi never uses a Claude subscription. The image defaults enforce it.
- The run-time checkout of Herdr Boss and the kit is on the `code` volume. A service update changes the volume, not the image.
- Volumes for each factory: `data` (mounted at the live data directory of the `factory` user), `home`, `work`, `code`. Volume names are `hf-<name>-data|home|work|code`. Container name `hf-<name>`. Every volume has a factory label.
- No Mac home folder, no `~/.config`, and no Docker socket is mounted into a factory.
- Compose limits: `cpus`, `mem_limit`, `memswap_limit`, `pids_limit`, and `shm_size: 1g`. Start values: 4 CPU and 8 GB. The Windows host has room for more.
- The dashboard is published on `127.0.0.1:<port>` of the host, and sshd on another loopback port. CDP stays inside the container.

### Codex sandbox (ADRs 0008, 0024)

- Codex runs only with its own sandbox on. A factory never uses the bypass flag.
- A container factory starts Codex workers with the custom seccomp profile (the Docker default plus user namespaces) and `systempaths=unconfined` together. Spike 02 shows that neither setting alone starts the sandbox. The pair is a per-profile container setting and is ON for the factory profiles.
- The container has no Docker socket, no host mounts, no added capabilities, and is not privileged. The factory wizard checks this before it enables Codex workers.
- The spike on the Windows host (ticket 03) tests the same pair. A different result there changes the setting for that host only.

### Linux portability

- The service asserts at start that its data directory equals the live data directory. A mismatch stops the service with a clear message. The container mounts the `data` volume at the default live path, so no override is needed.
- Worktree and project roots become settings.
- New readers for `/proc/meminfo`, `/proc/pressure`, and cgroup v2 CPU and memory limits. The machine guard uses the cgroup limits when they exist.
- A start-up check reports missing `lsof` or procps.
- An `allowedHosts` setting extends the host rule to `*.localhost` and to named tailnet hosts. The default keeps today's behaviour.
- `GET /api/health` returns version, schema, kit revision, tick age, Herdr reachable, and clock offset. It holds no path and no secret.
- The server log goes to stdout and to a rotated file.
- The launchd install stays for macOS. `install` fails with a clear message on Linux.

### Browser sign-in (ADR 0012)

- The Chrome path is a setting. The image sets the Linux path.
- The dashboard browser view gets a sign-in task: open a URL in the project Chrome profile, show frames, forward clicks, text, keys, and modifier keys. It reuses the existing browser screenshot, navigation, and input routes.
- Only the owner may use it. A screencast stream is added only if the polling view is too slow.

### Host tool (ADRs 0002, 0006, 0013, 0014)

- `herdr-boss factory ...`, loaded lazily. It imports nothing from the engine. It refuses to run inside a container.
- Host files: a registry of factories and hosts with no secrets; a `factory.json` and a `flow.json` for each factory. Secrets, SSH keys, and fleet credentials are stored in the private Herdr Boss configuration folder or the Keychain.
- Transports: `local` (Docker on the same host) and `ssh` (a Docker context over SSH). The registry stores the transport of each host.
- Each host record states its runtime and if the runtime is for personal use only. The host tool refuses a `client` profile on such a host.
- Commands in this plan: `new`, `build`, `start`, `stop [--now]`, `status`, `list`, `configure [--resume] [--step S]`, `login`, `update`, `backup`, `restore`, `destroy`, `shell`, `logs`, `freeze`.
- Each host tool release states a minimum factory version. `status` shows the factory version, the image build date, and the pins hash.
- Profiles: `personal` (all models, Owner subscriptions, item titles on, updates first) and `client` (defined for the later client spec; refused on personal-use hosts).

### Windows host (ADRs 0014, 0017, 0018)

- Docker Engine in a WSL2 distribution with systemd. A scheduled task starts the distribution at boot. `.wslconfig` sets the VM memory and CPU.
- All volumes are named volumes in the Linux file system. No bind mount of a Windows folder.
- The host joins the tailnet with a host tag. sshd in the WSL2 distribution accepts only key login. The host tool on the Mac drives Docker through that SSH path. Agents may use the key through the host tool without a confirmation for each use. `factory destroy` and `factory restore` need the Owner's typed confirmation (ADR 0023).
- A runbook in `docs/` lists each setup step.

#### Windows host runbook

Use placeholders only. Keep host names, tailnet names, addresses, and tenant data outside this repository. Use `NAME` for a factory, `PORT` for its loopback dashboard port, and `SLUG` for a project. Follow [the command runbook](../cli.md#windows-host-runbook) and [the Windows setup steps](../windows-host.md).

1. Install Docker Engine and Tailscale in WSL2. Enable systemd. Use key login for host SSH. Keep the boot task and its repeating trigger.
2. Approve the host tag in Tailscale. For a tailnet with one shared tag, merge this alternative into the existing policy. Keep the other rules. Include the head office in the rule source.

   ```json
   {
     "tagOwners": { "tag:factory": ["autogroup:admin"] },
     "acls": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:factory:22,443,4477,4478"] }
     ],
     "tests": [
       { "src": "autogroup:member", "accept": ["tag:factory:22,443,4477,4478"] }
     ]
   }
   ```

   Port 22 permits host SSH. Port 443 permits HTTPS Serve. The two dashboard ports stay in the rule and its tests. Save only after the policy tests pass. `factory new` prints both the per-factory grants form and this shared-tag `acls` form. Use one form.
3. Create the factory with the host tool. Keep Docker ports bound to loopback. Check factory health.
4. Enable HTTPS certificates in the tailnet settings. In the WSL Owner terminal, replace an old plain HTTP forward:

   ```sh
   sudo tailscale serve --http=PORT off
   sudo tailscale serve --bg PORT
   ```

   The second command publishes HTTPS on port 443. Connect after that route exists with `herdr-boss factory connect NAME`. Check with `factory connect --check NAME`. Connect reuses a matching HTTPS route. It replaces a matching HTTP forward when the factory user can change Serve. Otherwise it gives the repair commands. It never registers a plain HTTP tailnet address.
5. Run `herdr-boss factory update NAME --tier service` after the idle checks pass. Read the printed `before -> after` commits. Run `factory status NAME`. Compare the running service `commit` with the checkout `checkoutHead`.
6. Provision the target guidance credential privately. Run `herdr-boss project transfer plan SLUG --to NAME` from the source. Finish workers and push work before `start`. Answer the source Mailbox item before `switch`. Use `cancel` before the switch when the project must stay at the source. An unsafe connection refusal names the HTTPS route and `factory connect NAME` as the repair.
7. Check service health and the Herdr server. Create a `smoke-setup` folder under the factory work root. Create a Herdr workspace with that label and folder. Check that both exist. Run `herdr-boss factory clean-smoke NAME --dry-run`. Read the names. Run `herdr-boss factory clean-smoke NAME` and type `clean-smoke NAME`. Run the dry-run again to check the cleanup.

#### Smoke naming and cleanup contract

A smoke run uses the prefix `smoke-` for its Herdr workspace label and project folder name. The factory work root is `/home/factory/work`. Put smoke folders directly under that root. The Owner script and `factory clean-smoke NAME` use this same contract.

The command lists matching workspaces and folders with counts and names. It prints no folder paths. Without `--yes`, it requires the exact phrase `clean-smoke NAME` on stdin. A wrong or absent phrase stops cleanup. `--yes` skips that confirmation. `--dry-run` lists and checks without confirmation or removal.

The command closes only workspaces whose labels start with `smoke-`. It removes only folders whose names start with `smoke-`. It refuses symbolic links in the root, matching folders, or their contents. It refuses a path that resolves outside the work root. It checks all matching folders before it closes a workspace. It checks the names again after confirmation. Every other workspace and folder stays. Regular files directly under the work root stay. Project registry rows stay. A repeat after a failure removes only the remaining matching resources.

### Wizard

- A resumable state machine in the style of `project new`. A finished step is skipped when its check still passes. Exit code 3 means it waits for the Owner. No secret enters the Mailbox.
- Steps in this plan: container, volumes, herdr, service, harness-claude, harness-codex, harness-other (OpenCode), github, project.
- `factory login` runs at a host terminal through `docker exec`. It shows only the URL or the code, waits, checks with a harmless call, and prints no token.

### Fleet summary and credentials (ADRs 0011, 0016)

- `GET /api/fleet/summary`: a versioned, allow-listed document of 5 to 20 KB. Content: identity and version, health and machine load, projects with phase, status, and status age, board counts, quota rows with `accountKey`, spend per day, role, and harness, alerts, Owner item counts and ids, item titles when `fleet.shareItemTitles` is on, review packs that wait, and the dashboard base URL.
- `factoryId` and a `schema` number. The schema only adds fields. The head office ignores unknown fields and shows "head office older" or "factory older".
- Credentials: `fleetRead` for the summary and health routes. `fleetGuide` for the guidance route. No `fleetWrite` in this plan. On one tailnet the host tool creates each credential inside the factory and hands it to the head office. Rotation keeps the old credential valid for 10 minutes.

### Factory shares and guidance (ADR 0011)

- Each harness account has an account scope: a list of factory ids.
- The head office stores the factory shares of each shared account. The shares of one account total at most 100.
- `POST /api/fleet/guidance` takes factory shares and nudge messages with the sender epoch. The factory stores the shares, refuses a lower epoch, and posts a nudge to its Boss pane as an agent message.
- The factory pacing uses its factory share of each shared account as a ceiling on top of the project shares. With no guidance, the profile share applies.
- Each factory reads its own usage with the CodexBar CLI or an equal Linux reader that the spike confirms.

### Head office (ADRs 0009, 0019, 0020, 0022)

- The head office polls each registered factory every 30 seconds over the tailnet. It keeps the last summary and daily counts.
- The Fleet page: one line per factory with name, version, last seen, status, projects that need attention, worst quota lane, spend today, and Owner items. Plus a quota view by `accountKey` with the share sliders, a spend view, and the version and kit drift.
- The Mailbox view at the head office lists the Owner items of all factories with a factory tag and links each one to its factory.
- The role record holds the head office factory id and the epoch. `hub promote` on a factory takes the role with the epoch plus one and tells every factory. The head office starts on factory zero and moves to the Windows factory after 7 clean days.
- No head office agent in this plan.

### Updates and recovery

- Tier 1 (service): `git fetch`, `merge --ff-only` on the `code` volume, restart the supervised service. Panes survive.
- Before the service merge, save local changes in tracked documentation inside the factory. Put timestamped patches with mode 0600 in `~/work/boss-notes/update-patches/`. Save staged edits and working-file edits separately. A staged patch ends in `-index.patch`.
- Save the notes and patches before the work-volume backup, so a data-migration rollback keeps them. Restore tracked files only after the backup and the fresh idle check.
- Append added note lines from `docs/orchestration/memory.md` to `~/work/boss-notes/memory.md` instead of a patch. Keep existing factory notes. Print each saved path. Restore the saved files in the index and the working tree from `HEAD` before the merge. A repeat saves only new changes. A clean checkout creates no notes or patches. Keep untracked files.
- Accept `.md`, `.markdown`, `.rst`, `.adoc`, and `.txt` files, and root files `README`, `LICENSE`, and `COPYING`, as documentation. Refuse other tracked local changes before saving or restoring any local file. Name each refused file and print the exact patch command to run in the factory. A script in `docs/` is still refused.
- Keep the generated kit exception. Save changed kit documentation before restoration. Restore the generated `.claude/settings.json` without a patch. Run `kit install` after the merge. Keep the short `before -> after` commit output.
- Tier 2 (image): quiesce (orchestrators publish and commit `memory.md`, workers stop, backup runs), replace the container on the same volumes, start fresh orchestrators.
- Window rules: refuse while a worker works, a suite or push holds the lock, or a handover is prepared.
- A backup before each update. After the restart `/api/state` returns 200 within 30 seconds and one clean tick passes, or the update rolls back. A rollback after a migration restores the backup and needs `--accept-data-loss`.
- The manual update and rollback procedure is written first. A canary factory is not in this plan.
- Backups hold the database (`VACUUM INTO`), the data files, and the `work` volume. A backup with the `home` volume is stored at mode 0600, outside every repository and cloud folder.

### Project transfer (small form)

- States: plan, lock and freeze, push, import, start, switch, or cancel.
- A transfer id names a lock that makes `worker start` refuse on both factories.
- The source orchestrator publishes its status and commits `memory.md`. Workers finish or stop. The source closes its orchestrator pane at the end of the freeze.
- Unpushed work blocks the freeze, and the command lists it.
- The target clones from GitHub, runs `kit install`, creates the project record, and asks for secrets again in the wizard. A fresh orchestrator reads `memory.md`, runs `project check`, and publishes its status.
- The Owner confirms the switch. The source marks the project `transferred`. `cancel` before the switch removes the target project and clone and lifts the lock.
- Owner items, review packs, and message text stay at the source. The transfer leaves an audit line on both factories.

## Testing Decisions

- A good test checks behaviour at a public boundary: a CLI exit code and output, an HTTP route and its status, a file that a command writes. It does not check private functions.
- The host tool gets the highest seam: the factory commands against a fake Docker transport that records the Docker calls and returns scripted results. The `local` and `ssh` transports share one interface, so one fake covers both. Prior art: the fake `gh` and the `project new` tests.
- The wizard uses the `project new` test pattern: a scripted flow state, a failed step, a resume, and exit code 3.
- The fleet summary has an allow-list test: every key of a full summary is on the list, and a summary of a fixture with paths, tokens, and message text holds none of them. Prior art: the server and preview access tests.
- The guidance route tests: the `fleetRead` credential gets 403, a lower epoch is refused, a valid share changes the pacing ceiling, and a nudge reaches the Boss as an agent message.
- Linux readers use fixture files for `/proc` and cgroup values. Prior art: the machine samples tests.
- The browser sign-in uses the fake CDP helper. Prior art: the browser pool tests.
- The transfer uses two temporary data directories and a fake GitHub remote. The test checks the lock on both sides, the refusal on unpushed work, and cancel.
- The image has a smoke test: build, start, `/api/health` returns 200, the migration runs, and the full suite passes inside the container.
- Every test uses a temporary `HOME` and `HERDR_BOSS_DIR`. No test touches the live data directory.

## Out of Scope

- Users and roles (access G1 to G4), the viewer listener, the audit log, passkeys, and single sign-on.
- Client factories, client-premises factories, the client-site push, the reverse SSH forward, and contract checks.
- The automatic head office election, the lease, the change log, the discovery record, and signed grants.
- A head office Boss agent and a chat with it.
- Portainer stacks, the in-host agent, the offline update bundle, and a registry.
- The full transfer bundle.
- Pi and `qlik-cli` in the image.
- A canary factory and automatic update promotion.
- A cloud VM host.

These parts stay in `docs/ideas/factories.md`.

## Further Notes

- The Mac must run Herdr 0.9.3 or newer before the spike, because `herdr machine` needs it. The Boss updates it.
- The Windows host runs Windows 10 or 11 on an i9 CPU (amd64) with 64 GB of memory.
- OrbStack is free for personal use only. The Mac runs only personal container factories.
- The Owner has one Claude subscription, one Codex subscription, and two OpenCode Go subscriptions. One OpenCode Go subscription has the Mac factory in its account scope, and one has the Windows factory.
- The terms risk of one subscription for several unattended factories stays. The factory shares limit the use, not the risk.
- An SSH key to a factory gives full control of that factory. Give it only to the Owner.
