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

The approved tailnet did not permit Serve for the SSH operator during the connection check. The masked error was:

```text
sending serve config: Access denied: serve config denied
```

The diagnostic root status check returned `sudo: a password is required`. These results show a host permission block. They do not prove that the tailnet cannot support Serve. The host tool does not bypass this block.

Run `sudo tailscale set --operator=factory` in the WSL Owner terminal on each host. Alternatively, run `sudo tailscale serve --bg PORT` there once. Replace `PORT` with the registered loopback dashboard port. Then retry `factory connect NAME`. If no matching forward exists and Serve refuses the change, the command prints the masked error and both Owner choices. It exits 3 and keeps the connection at the Owner step. Keep passwords out of the host tool output.

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
