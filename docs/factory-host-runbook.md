# Factory host checks

Use the host tool outside a container. Store connection fields in the private connection store only. Keep host addresses, key paths, tailnet names, and context names out of repository files and reports.

## Windows host

1. Enable systemd in the WSL distribution.
2. Install Docker Engine in that distribution.
3. Start Docker with systemd.
4. Enable the WSL startup task in Windows Task Scheduler.
5. Add a startup trigger to the task.
6. Add a repeating trigger every five minutes.
7. Start the distribution from that task without a user sign-in.
8. Check the Docker context from the host tool machine.

WSL can stop without a Windows reboot. The repeating trigger starts it again. A startup trigger alone does not cover that stop. Use the private connection store for the distribution and host fields.

Use `tag:hf-host` for a Windows host, `tag:hf-<factory slug>` for a factory, and `tag:hf-head-office` for the head office. The Owner approves each factory tag when it joins the tailnet. `factory new` prints these labels:

```text
Tag: tag:hf-NAME
Head office tag: tag:hf-head-office
Host tag: tag:hf-host
```

Replace `NAME` with the validated factory slug. The tool prints the policy comment and lines, then the host command. Paste the policy lines into the tailnet policy file. Run the printed command on the host. Herdr Boss does not change the tailnet policy or run that command.

The tool prints these comment lines immediately before the policy block:

```text
// Paste these lines into the tailnet policy file. Then approve the tag when the factory joins.
// tag:hf-head-office and tag:hf-host need existing tagOwners entries in the policy.
```

The printed policy block uses this shape:

```json
"tagOwners": {
  "tag:hf-NAME": ["autogroup:admin"]
},
"grants": [
  {"src": ["autogroup:member"], "dst": ["tag:hf-NAME"], "ip": ["tcp:443"]},
  {"src": ["tag:hf-head-office"], "dst": ["tag:hf-NAME"], "ip": ["tcp:443"]}
]
```

When the host is not personal-only, the tool also prints this grant:

```json
{"src": ["tag:hf-NAME"], "dst": ["tag:hf-head-office"], "ip": ["tcp:443"]}
```

The factory tag grants TCP port 443 to Owner devices and the head office. It grants TCP port 443 from the factory to the head office only when the host is not personal-only. Port 443 is the HTTPS port of Tailscale Serve on the host. Serve publishes the factory dashboard through the host.

The printed host command has this form:

```sh
tailscale up --advertise-tags=tag:hf-NAME
```

Set the host Codex sandbox setting after the Windows check. Use `user-namespaces` when the custom seccomp profile and `systempaths=unconfined` start the Codex sandbox. Otherwise use `unavailable`. The host tool then keeps Docker's default seccomp profile and excludes Codex from factories on that host.

## Host outage

Connect each registered container factory with `herdr-boss factory connect NAME`. Check it with `herdr-boss factory connect --check NAME`. Connect one factory at a time. The command uses Tailscale Serve. It reuses a matching HTTPS forward. It replaces a matching plain HTTP forward with HTTPS on port 443. It registers only HTTPS. The forward goes to the container loopback port. The dashboard access rule stays in force. See `cli.md`, section Container factories, for resume and permission rules.

`factory connect` needs the Tailscale operator right or an existing HTTPS Serve forward for the dashboard port. Enable HTTPS certificates in the tailnet settings. In the WSL Owner terminal, run `sudo tailscale serve --http=PORT off`. Then run `sudo tailscale serve --bg PORT`. Replace `PORT` with the registered loopback dashboard port. The HTTPS listener uses port 443. Allow port 443 next to port 22 in the access rule and its tests. To let the host user configure Serve, run `sudo tailscale set --operator=USER`. Replace `USER` with the registered host user. Retry `factory connect NAME` after the HTTPS route exists. An access denied message exits 3 with the masked error and the two repair commands. Another Serve failure exits 1 with `serve-failed`. Keep passwords out of the host tool output.

If the dashboard port does not answer, `factory connect` stops at the access step and prints `dashboard-unreachable`. SSH to the host works at that point. The tailnet access rules probably allow port 22 but not the dashboard port. Add the port that the message names next to port 22 in the access rule for the factory, then run `factory connect NAME` again.

Undo a connection with `herdr-boss factory connect --undo NAME`. See `cli.md`, section Container factories.

A remote Docker timeout reports `host-unreachable`. Do not call a container stopped or unhealthy when the host cannot answer. Continue work on another reachable host. Recheck the missing host when it returns. Do not restart an unrelated service.

The Fleet poller keeps the last good summary during an outage. Its public reason is `unreachable`, `timeout`, `auth`, or `contract-mismatch`. The page shows a red health state and the last successful poll time. Use a fake transport with a blocked route if a host cannot restart WSL without a sign-in. Terminate WSL only through the host tool and only after you confirm the five-minute repeating boot trigger.

## Builders and factories

Use one dedicated builder for each host. Use a labeled BuildKit container and the remote driver with `docker-container://`. Keep the builder name in the private connection store. Leave its container intact. Do not prune a shared daemon.

The builder container runs with `--privileged`. This is an accepted risk. BuildKit with the remote driver needs the privileges to create build sandboxes, and the builder container runs no factory code. Limits on the container: 2 CPUs, 4 GB memory and swap, 1024 processes. The pins file `factory/pins.json` records the BuildKit image. Add a `digest` field to the `buildkit` entry to pin the image by digest.

`factory build NAME --image TAG` refuses a tag that exists and has no factory build metadata. The tool never re-tags another image.

The private connection store tells a Docker context host from a direct SSH host. The fleet record does not: it uses the transport `ssh` for both.

The tool refuses to start a factory container that maps a host device, uses the host PID, network, IPC or user namespace, or has an unconfined AppArmor profile. The check runs before each start, also when `factory new` resumes. Codex stays off until the check passes.

A stale lock file (`fleet.lock` or `registry.lock`) is removed when its owner process is gone or the file is older than 60 seconds.

Use four labeled named volumes for each factory. Bind its dashboard and SSH ports to loopback. Mount no host folder or Docker socket. Add no capability to a factory. Do not use a privileged factory container.

Check memory and swap before a Mac factory start. Start one container factory at a time on the Mac. Keep the OrbStack memory limit at 4 GB. Stop the OrbStack daemon when it is idle and no other task uses it.

After the service check, run `claude --version` and `opencode --version` in the factory container. A successful image build alone does not prove that an npm postinstall script ran. Keep harness logins for the Owner terminal.

Check `/api/health` through container loopback. It must return 200. Check the factory hostname separately. Without a login, that name must return 401. A response of 403 means the host rule rejected the name. Do not remove authentication to pass this check.

## Factory updates

Run `herdr-boss factory update NAME --tier service` for a Herdr Boss code update. This fast-forwards the `code` volume and restarts only the service. Existing panes stay available.

Run `herdr-boss factory build NAME` to build the new pinned image. Then run `herdr-boss factory update NAME --tier image` for a harness or tool update. This makes a private backup, replaces the labeled container, and keeps its four labeled volumes. It starts fresh sessions only for active project orchestrators. It leaves paused projects stopped. It never starts a Boss session. If a Boss pane is live, the update refuses unless you add `--allow-boss-restart`.

When the flag allows replacement, the command prints: The Boss pane is gone. Run 'herdr-boss factory boss start NAME' to start the Boss in the factory.

The update refuses a working worker, a live suite or push lock, or a prepared handover. Use `--dry-run` to check the selected tier first.

After the backup, the tool checks a fresh work snapshot before it merges code or replaces the container. It refuses a snapshot older than 15 seconds. It checks for new work again. The image tier also checks for a live Boss pane. If a check fails, it resumes the factory. Run `herdr-boss factory configure NAME --resume` to check it, then retry the update.

The service tier runs every git command as the user `factory` with `HOME=/home/factory`. The `code` volume repository belongs to that user. The tool adds no `safe.directory` setting.

If the repository has no `origin` remote, the tool adds one. The URL is the `repository` field of the `package.json` file of the Herdr Boss checkout on the host. If that field is absent, the tool uses `git remote get-url origin` of that checkout. The tool removes credentials from the URL. It refuses a URL that is not HTTPS. The branch name of the repository does not matter. The tool fetches `main` and fast-forwards to it.

If `origin` exists and names another repository, the tool refuses the update. The error shows the expected URL and the found URL without credentials. Fix the remote, then retry.

If the update fails, the error names the failing step: `git rev-parse`, `git remote add`, `git fetch`, `git merge`, or `restart`. A `git fetch` failure means that the factory cannot reach the remote.

After restart, the tool checks `/api/state` and one clean service tick within 30 seconds. It rolls back automatically when the schema has not increased. If the schema increased or cannot be read after the new container starts, it keeps a private pending rollback record.

Review the error, then repeat the same tier command with `--accept-data-loss`. The tool restores the private backup and the previous code or image. This can discard data written after the backup. Do not remove the pending record by hand. If the new container never starts, rollback does not restore data or require this flag.

Do not update while a worker, suite, push, or handover is active. Do not use a live test factory for an update unless the worker brief permits it. The update command checks labels before it changes a container.

## Backup and repair

Run `factory backup NAME --include-home` before planned removal.
Use a private destination outside repositories and cloud folders.
The backup stops a running factory.
It removes its labeled archive helper by its exact name before it restarts the source.
If helper cleanup fails, the source stays stopped.
After successful cleanup, the previous running or paused state returns.
A stopped factory stays stopped.
Keep the matching image for `factory restore FILE`.
Type the factory name at an Owner terminal for restore or destroy.
Destroy needs the recorded backup from the last 24 hours that includes home.
Back up with `--include-home` if the last backup omits home.
It removes only the named container and four volumes with matching factory and worker labels.
It keeps builders and images.

A failed restore checks the target container and volumes after a lost create reply.
It removes only resources with matching factory and worker labels.
It removes the helper before volume rollback.
A helper cleanup failure keeps the volumes and pending record for repair.

For a dead service, use `factory logs NAME`, `factory shell NAME`, or `factory stop NAME --now`.
Use `factory freeze NAME` to pause all container processes.
Use `factory freeze NAME --off` to resume them.
These commands need Docker, but they need no service response.
See `cli.md`, section Backup and recovery, for the archive and retry rules.
