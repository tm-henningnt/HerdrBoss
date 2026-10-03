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

## Host outage

Connect each registered container factory with `herdr-boss factory connect NAME`. Check it with `herdr-boss factory connect --check NAME`. Connect one factory at a time. The command uses Tailscale Serve. It reuses an existing matching HTTP or HTTPS forward. The forward goes to the container loopback port. The dashboard access rule stays in force. See `cli.md`, section Container factories, for resume and permission rules.

`factory connect` needs the Tailscale operator right or an existing Serve forward for the dashboard port. Run `sudo tailscale set --operator=USER` in the WSL Owner terminal. Replace `USER` with the registered host user. Alternatively, run `sudo tailscale serve --bg PORT` there once. Replace `PORT` with the registered loopback dashboard port. Then retry `factory connect NAME`. If Serve refuses the change with an access denied message, the command prints the masked error and both Owner choices. It exits 3 and keeps the connection at the Owner step. Any other Serve failure exits 1 with the code `serve-failed`. Keep passwords out of the host tool output.

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

When the flag allows replacement, the command prints: The Boss pane is gone. Run 'herdr-boss factory configure NAME --resume' to check the factory, then start the Boss in the factory Boss pane yourself.

The update refuses a working worker, a live suite or push lock, or a prepared handover. Use `--dry-run` to check the selected tier first.

After the backup, the tool checks a fresh work snapshot before it merges code or replaces the container. It refuses a snapshot older than 15 seconds. It checks for new work again. The image tier also checks for a live Boss pane. If a check fails, it resumes the factory. Run `herdr-boss factory configure NAME --resume` to check it, then retry the update.

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
