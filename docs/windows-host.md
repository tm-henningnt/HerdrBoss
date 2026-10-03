# Windows factory host

Use this runbook for Docker Engine in WSL2. Run it once on each Windows host.
Use named Docker volumes in the Linux file system. Do not use a Windows folder as a factory volume.

This runbook uses placeholders only. Replace `DISTRO`, `SSH_USER`, `HOST`, `CONTEXT`, `BUILDER`, and `WORKER` before you run a command. Keep the real values on the host. Do not put an address, a tailnet name, a key path, or a real Docker context name in a report or a repository.

## 1. Install WSL2

Run these commands in an elevated PowerShell window:

```powershell
wsl --install -d Ubuntu
wsl --update
wsl --set-default-version 2
wsl --list --verbose
```

Restart Windows if the installer asks. Start the distribution once. Create its Linux user.
Use the distribution name from `wsl --list --verbose` for `DISTRO`. Check that its version is 2.

## 2. Set the VM limits

Create `.wslconfig` in the Windows profile of the account that owns the distribution.
Use this example for a host with 64 GB of memory:

```ini
[wsl2]
memory=48GB
processors=CPU_COUNT
```

Replace `CPU_COUNT` with the CPU limit of this host. Leave memory for Windows.
Apply the limits before you start factories. Stop the distribution with `wsl --terminate DISTRO`, then start it again.
Check the limits inside Linux with `free -h` and `nproc`.

## 3. Enable systemd

Add this section to `/etc/wsl.conf` in the distribution. Keep its other sections.

```ini
[boot]
systemd=true
```

Terminate and start this distribution again. Check it in Linux:

```sh
systemctl is-system-running
systemctl --failed --no-legend
```

Read each failed unit. Record the unit name and its effect. A failure of `systemd-binfmt.service` alone does not prove a failure of Docker, SSH, or Tailscale. Check those services separately.

## 4. Install Docker Engine and SSH

Run these commands inside the Ubuntu distribution:

```sh
sudo apt-get update
sudo apt-get install -y docker.io openssh-server
sudo systemctl enable --now docker ssh
sudo usermod -aG docker SSH_USER
```

Start a new login for the group change. Check `docker version` as `SSH_USER`.
Docker group membership gives control of the host. Give it only to the account used by the host tool.
Do not install Docker Desktop for this factory host.

Install the Owner's public SSH key in `~/.ssh/authorized_keys` of `SSH_USER`.
Set the directory mode to 700. Set the file mode to 600. Keep the private key on the Mac.

Create `/etc/ssh/sshd_config.d/00-herdr-factory.conf`:

```text
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers SSH_USER
```

Replace `SSH_USER`. Run `sudo sshd -t`. Check the effective settings with `sudo sshd -T`.
Reload SSH with `sudo systemctl reload ssh`. Check key login from the Mac before you close the setup session.

## 5. Join Tailscale

Install Tailscale inside the WSL distribution. Use its official Linux package installer.
Enable `tailscaled` with `sudo systemctl enable --now tailscaled`.
Have the Owner join this host with the approved host tag.

The tailnet policy must permit the approved Mac operators to reach TCP port 22 on that tag.
Do not expose the Docker daemon over TCP. Keep the tailnet address and policy values outside the repository.

## 6. Start WSL at Windows boot

Open Windows Task Scheduler. Create a task for the Windows account that owns `DISTRO`.
Do not use `SYSTEM`: the distribution is registered to its Windows account.

1. Select **Run whether user is logged on or not**.
2. Select **Run with highest privileges**.
3. Add an **At startup** trigger.
   Add a second trigger that repeats every five minutes with no end date.
4. Use `C:\Windows\System32\wsl.exe` as the program.
5. Use these arguments after you replace `DISTRO`:

```text
-d DISTRO -u root --exec /bin/sh -lc "systemctl start docker ssh tailscaled && exec /usr/bin/sleep infinity"
```

6. Remove the task time limit. Permit a restart after a failure.
7. Select **Do not start a new instance** when the task already runs.
8. Enter the Windows account credential only in the local Task Scheduler dialog.

The foreground `sleep` keeps the WSL invocation open. It is not a test wait.
The repeating trigger starts the task again if WSL stops without a Windows reboot.
Run the task by hand. Check Docker, SSH, and Tailscale before the reboot check.

If a host stops during work, record its WSL uptime after it returns:

```sh
herdr-boss factory ssh HOST -- uptime -s
herdr-boss factory ssh HOST -- cat /proc/uptime
herdr-boss factory ssh HOST -- date -u +%FT%TZ
```

Calculate the UTC boot time from `/proc/uptime` and the UTC clock. Compare it with the time of the lost connection.
Read `LastBootUpTime` with `Get-CimInstance Win32_OperatingSystem` in local PowerShell.
Claim a WSL restart without a Windows reboot only when the Windows boot time is earlier.

## 7. Register the host on the Mac

Use `herdr-boss factory host add HOST --from-file -`. Supply the `address`, `user`, and `keyFile` fields on private stdin.
The host tool creates its registry with mode 600. Do not read or copy the private key.

Check the transport:

```sh
herdr-boss factory ssh HOST -- uname -m
herdr-boss factory ssh HOST -- systemctl is-active docker ssh tailscaled
```

The architecture must be `x86_64`. Each service must report `active`.
The host tool masks the full address before it masks the key file name. It also masks tokens that end in `.ts.net`.

For the image spike, use the approved Docker context over SSH. Store its SSH alias and key selection in the private SSH configuration on the Mac.
List context names without their endpoints:

```sh
docker context ls --format '{{.Name}}'
docker --context CONTEXT ps --format '{{.ID}} {{.Status}}'
```

Keep the context name out of the report. Record the command with `CONTEXT` in its place.

## 8. Build and check the image

Use one dedicated buildx builder for each host. Give its BuildKit container and cache volume the worker label before use.
Do not use a shared builder. Do not run a prune command. Check the label before you remove a resource.

The `docker-container` buildx driver does not accept a `labels` driver option.
Use a labeled BuildKit container with the `remote` driver instead. Use new resource names if the example names exist:

```sh
docker --context CONTEXT volume create --label herdr-factory-spike=WORKER hf-example-buildkit-cache
docker --context CONTEXT run -d --name hf-example-buildkit \
  --label herdr-factory-spike=WORKER --privileged \
  --mount type=volume,src=hf-example-buildkit-cache,dst=/var/lib/buildkit \
  moby/buildkit:buildx-stable-1
DOCKER_CONTEXT=CONTEXT docker --context CONTEXT buildx create \
  --name BUILDER --driver remote docker-container://hf-example-buildkit
```

This privilege belongs to the dedicated build engine. It publishes no port. It mounts only its named cache volume.
Keep `DOCKER_CONTEXT` set for the build. The BuildKit connection helper uses it to select the host.

Read [the factory image guide](factory-image.md). Build from the committed checkout with its pins:

```sh
DOCKER_CONTEXT=CONTEXT FACTORY_BUILDER=BUILDER FACTORY_LABEL=herdr-factory-spike=WORKER \
  factory/build.sh hf-spike:WORKER-amd64 -- --platform linux/amd64
docker --context CONTEXT image inspect hf-spike:WORKER-amd64 \
  --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "herdr-factory-spike"}}'
```

The result must be `linux/amd64` with the worker label. Record the build time, source revision, pins hash, and image size.
Use a new image tag if the example tag exists. Give each test container and named volume the same worker label.
Use the resource limits, named volume mounts, and loopback port bindings in the image guide.
Mount no host folder or Docker socket. Add no capability. Do not use a privileged factory container.

For Codex, start the factory container with both options from ADR 0024:

```text
--security-opt seccomp=factory/seccomp-codex.json
--security-opt systempaths=unconfined
```

The seccomp file is on the Mac where the Docker CLI runs. The CLI sends its content to the daemon.
Run `codex sandbox -- echo SANDBOX-STARTED` as the user `factory` inside the test container.
Record the exit code and marker. A sandbox start needs no harness login. It does not prove a signed-in worker.
If no tested profile starts the sandbox, report that no setting worked. Do not disable the Codex sandbox.

Check `herdr status server` and HTTP 200 from `/api/health` inside the container.
For an SSH attach, give the test container an Owner-approved public key and a private Mac SSH alias.
The alias must reach the container SSH port through the WSL host. Keep that port on loopback.
Run `TERM=xterm-256color herdr --remote SSH_ALIAS --session SESSION` from a Mac terminal.
Replace `SESSION` with a new test session name. Confirm that the remote workspace renders.
A successful SSH command alone does not prove that the remote terminal attached.

For a native WSL check, install the pinned Linux Herdr binary in the Linux user home.
Check its release checksum against `factory/pins.json` before use.
Put the test directory in the Linux user home or a named volume. It must survive a WSL restart.
Do not put it in `/tmp`.
Start `herdr --session SESSION` in a WSL terminal. Use a new session name.
Detach with `Ctrl+B`, then `Q`. Run the same remote command from a Mac terminal.
Create a test workspace in that session. Confirm that its label renders in the remote terminal.
Stop only that test session after the check.

If a terminal check fails, use a real TTY with `ssh -tt SSH_ALIAS`.
Check `TERM` and its terminfo entry inside the test container:

```sh
docker --context CONTEXT exec CONTAINER sh -lc 'printf "%s\n" "$TERM"; infocmp "$TERM" >/dev/null'
```

Use `TERM=xterm-256color` for the remote check. Record the terminfo exit code.

## 9. Check recovery without a sign-in

Use `--restart unless-stopped` on the labeled test container. Record its ID before the reboot.
Arrange the reboot with the host operator. Do not interrupt another factory's work.
Restart Windows. Do not sign in. Check from the Mac that the boot task started WSL and that SSH accepts key login.
Check that the same labeled container runs and that `/api/health` returns 200 inside it.

Record the recovery time and result. A Docker restart alone does not prove recovery after a Windows reboot.
Stop and remove only the exact test resources whose worker label you checked. Remove only the dedicated test builder.
Keep the host services and the boot task.
