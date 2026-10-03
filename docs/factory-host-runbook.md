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

A remote Docker timeout reports `host-unreachable`. Do not call a container stopped or unhealthy when the host cannot answer. Continue work on another reachable host. Recheck the missing host when it returns. Do not restart an unrelated service.

## Builders and factories

Use one dedicated builder for each host. Use a labeled BuildKit container and the remote driver with `docker-container://`. Keep the builder name in the private connection store. Leave its container intact. Do not prune a shared daemon.

Use four labeled named volumes for each factory. Bind its dashboard and SSH ports to loopback. Mount no host folder or Docker socket. Add no capability to a factory. Do not use a privileged factory container.

Check memory and swap before a Mac factory start. Start one container factory at a time on the Mac. Keep the OrbStack memory limit at 4 GB. Stop the OrbStack daemon when it is idle and no other task uses it.

After the service check, run `claude --version` and `opencode --version` in the factory container. A successful image build alone does not prove that an npm postinstall script ran. Keep harness logins for the Owner terminal.

Check `/api/health` through container loopback. It must return 200. Check the factory hostname separately. Without a login, that name must return 401. A response of 403 means the host rule rejected the name. Do not remove authentication to pass this check.
