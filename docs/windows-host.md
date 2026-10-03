# Windows factory host

Use this runbook to prepare a Windows computer as a factory host. It runs Docker Engine in WSL2. Do the 25 steps once on each host, in order. Do not start a step before the check of the step before it passes. The [factory chapter of the user guide](guide/factory.md) explains the goal and the commands that follow.

Use named Docker volumes in the Linux file system. Do not use a Windows folder as a factory volume.

This runbook uses placeholders only. Replace `DISTRO`, `FACTORY_USER`, `HOST`, `HOST_FQDN`, `HOST_ALIAS`, `KEY_NAME`, `CONTEXT`, `BUILDER`, and `WORKER` before you run a command. `FACTORY_USER` is the Linux user, for example `factory`. Keep the real values on the host and in the private registry. Do not put an address, a tailnet name, a key path, or a real Docker context name in a report or a repository.

WARNING: Windows 10 22H2 has no support (H3). Use it for tests only. `herdr-boss doctor` warns on Windows 10.

WARNING: Docker safety (H12). Run no `docker system prune`, `docker builder prune`, `docker image prune`, `docker container prune`, `docker volume prune`, `docker rm`, `docker rmi`, or `docker volume rm` on a shared daemon. Give each Docker resource a label. Use one buildx builder for each host.

The labels H1 to H15 name the 15 host items of the [factory chapter](guide/factory.md#the-15-host-checks). Each item has its step here and a check.

## Step 1: BIOS

Turn on CPU virtualization in the BIOS. The name differs by maker: Intel VT-x, AMD-V, or SVM Mode. If the BIOS has the option, set the computer to power on after a power loss. Do this at the machine.

Check: in Task Manager, open Performance, then CPU. It shows `Virtualization: Enabled`.

## Step 2: Update Windows

Open Settings, then Windows Update. Install all updates. Restart. Repeat until no update is left.

Check: Windows Update shows "You're up to date". Use Windows 11, or Windows 10 22H2 for tests only (H3).

## Step 3: Never sleep

WARNING: With remote desktop, disconnect. Never sign out (H3). A sign-out can end work that runs on the host.

Run these commands in an elevated PowerShell window:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```

Check: `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` shows `Current AC Power Setting Index: 0x00000000`.

## Step 4: Active hours

Open Settings, then Windows Update, then Advanced options, then Active hours. Set the longest range that Windows allows. Windows restarts for updates outside this range only.

Check: the page shows the range that you set.

## Step 5: Install WSL

Run these commands in an elevated PowerShell window:

```powershell
wsl --install --no-distribution
wsl --update
wsl --set-default-version 2
```

Restart Windows if the installer asks.

Check: `wsl --version` prints a version.

## Step 6: Install Ubuntu

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
```

Start the distribution once. Create its Linux user `FACTORY_USER`. Use the distribution name from `wsl --list --verbose` for `DISTRO`.

Check: `wsl -l -v` shows `VERSION 2` for `DISTRO`.

## Step 7: Turn on systemd

Add this section to `/etc/wsl.conf` in the distribution. Keep its other sections.

```ini
[boot]
systemd=true
```

Run `wsl --terminate DISTRO` in PowerShell. Start the distribution again.

H4 (optional): mask `systemd-binfmt.service`, so that systemd reports running.

```sh
sudo systemctl mask systemd-binfmt.service
```

Check: `systemctl is-system-running` shows `running`, or `degraded` with only `systemd-binfmt.service` failed. Read each failed unit with `systemctl --failed --no-legend`. A failure of that unit alone does not prove a failure of Docker, SSH, or Tailscale. Check those services separately.

## Step 8: Limit memory and CPU

H1: WSL never stops when idle. Create `.wslconfig` in the Windows profile of the account that owns the distribution. Use this example for a host with 64 GB of memory:

```ini
[wsl2]
memory=48GB
processors=CPU_COUNT
swap=8GB
instanceIdleTimeout=-1
vmIdleTimeout=-1

[experimental]
autoMemoryReclaim=gradual
```

Replace `CPU_COUNT` with the CPU limit of this host. Leave memory for Windows. Run `wsl --shutdown` to apply the file. Start the distribution again.

Check (memory): `free -h` and `nproc` in Linux show the limits.

Check (H1): close all WSL windows. Wait 3 minutes. `wsl -l -v` still shows `Running`.

## Step 9: Add the Docker repository

WARNING: Read the Docker safety rule (H12) at the top of this page before you run a Docker command.

Run these commands inside Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Check: `apt-cache policy docker-ce` lists a candidate version from `download.docker.com`.

## Step 10: Install Docker

Do not install Docker Desktop for this factory host.

```sh
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker FACTORY_USER
```

H11: the factory user is in the docker group. Docker group membership gives control of the host. Give it only to the account that the host tool uses. Start a new login for the group change.

Check: `docker version` works as `FACTORY_USER` with no `sudo`.

## Step 11: Configure and test Docker

H11: turn on log rotation. Create `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

```sh
sudo systemctl restart docker
docker run --rm --label herdr-factory-spike=WORKER hello-world
docker info --format '{{.MemTotal}}'
```

Check: `hello-world` prints its greeting. `docker info` shows the WSL memory limit of step 8 (H11).

## Step 12: Put the Mac on Tailscale

Install Tailscale on the Mac. Sign in with your own Tailscale account. Only you do this step.

Check: `tailscale status` on the Mac lists the Mac as connected.

## Step 13: Turn on MagicDNS and HTTPS

H8: open the Tailscale admin console. Open DNS. Turn on MagicDNS. Turn on HTTPS certificates.

Check (H8): after step 15, the tailnet name `HOST_FQDN` of the host resolves on the Mac. Run `ping -c 1 HOST_FQDN`.

## Step 14: Write the access policy

H7: let the Mac reach `tag:factory` on ports 22, 4477, and 4478. Add this to the tailnet policy file in the admin console. Replace `OWNER_LOGIN` with your Tailscale login.

```json
"tagOwners": { "tag:factory": ["autogroup:admin"] },
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:factory"], "ip": ["tcp:22", "tcp:4477", "tcp:4478"] }
],
"tests": [
  { "src": "OWNER_LOGIN", "accept": ["tag:factory:22", "tag:factory:4477", "tag:factory:4478"] }
]
```

Save the policy. The editor runs the rule tests.

Check (H7): the rule tests pass for each port. After step 15, run `nc -vz HOST_FQDN 4478`. "Refused" means the Mac reached the host. A timeout means the rule is missing.

`herdr-boss factory new` prints one more tag and policy lines for each factory later. See [the factory runbook](factory-host-runbook.md).

## Step 15: Install Tailscale in Ubuntu

H5: Tailscale runs inside Ubuntu, with its own name and address.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up --advertise-tags=tag:factory
```

Open the printed sign-in address in a browser. Sign in with your own account. In the admin console, approve the tag. Open the machine menu, then select **Disable key expiry**.

H6: give the factory user the operator right and turn on Serve for the tailnet:

```sh
sudo tailscale set --operator=FACTORY_USER
```

Turn on Serve in the admin console when it asks.

Check (H5): the admin console shows `tag:factory` and "expiry disabled". The host answers on its tailnet name.

Check (H6): `tailscale serve status` prints "no serve config" without sudo.

## Step 16: Make the SSH key on the Mac

H9: use one SSH key for each host. Keep it in a Mac folder that agents cannot read. Create the folder and the key in the Terminal app:

```sh
mkdir -m 700 -p ~/.ssh/herdr-factory
ssh-keygen -t ed25519 -f ~/.ssh/herdr-factory/KEY_NAME -C "herdr-factory-HOST_ALIAS"
ssh-keygen -l -f ~/.ssh/herdr-factory/KEY_NAME.pub
```

Never print the private key. Never copy it into a chat. Add the folder to the read deny rules of your agent apps.

Check: the last command prints one fingerprint line. Write the line in your private notes.

## Step 17: Add the public key to Ubuntu

Copy the public key on the Mac: `pbcopy < ~/.ssh/herdr-factory/KEY_NAME.pub`. In Ubuntu, as `FACTORY_USER`:

```sh
install -d -m 700 ~/.ssh
nano ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Paste the public key as one line. Save the file.

Check: `ls -ld ~/.ssh ~/.ssh/authorized_keys` shows mode `drwx------` and `-rw-------`.

## Step 18: Install the SSH server

H9: the SSH server takes keys only.

```sh
sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh
```

Create `/etc/ssh/sshd_config.d/00-herdr-factory.conf`:

```text
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers FACTORY_USER
```

Run `sudo sshd -t`. Reload SSH with `sudo systemctl reload ssh`. Keep the setup session open until key login works from the Mac.

Check (H9): `sudo sshd -T | grep -i passwordauthentication` shows `passwordauthentication no`.

## Step 19: Let SSH start after Tailscale

H9: the SSH server starts after Tailscale. Run `sudo systemctl edit ssh`. Add:

```ini
[Unit]
After=tailscaled.service
Wants=tailscaled.service
```

Save the file. Run `sudo systemctl restart ssh`.

Check: `systemctl show ssh -p After` lists `tailscaled.service`.

## Step 20: Tell the Mac which key to use

Add this entry to `~/.ssh/config` on the Mac:

```text
Host HOST_ALIAS
  HostName HOST_FQDN
  User FACTORY_USER
  IdentityFile ~/.ssh/herdr-factory/KEY_NAME
  IdentitiesOnly yes
```

H10: make a Docker context on the Mac for the host. Name it `hf-<name>`.

```sh
docker context create CONTEXT --docker "host=ssh://HOST_ALIAS"
```

Check: `ssh HOST_ALIAS uname -m` prints `x86_64` with no password question. `docker --context CONTEXT ps` works without a password (H10).

## Step 21: Create the boot task

H2: the boot task runs as your own Windows account, also when you are signed out. Do not use `SYSTEM`: the distribution is registered to its Windows account. Open Windows Task Scheduler and create a task:

1. Select **Run whether user is logged on or not**.
2. Select **Run with highest privileges**.
3. Add an **At startup** trigger. Add a second trigger that repeats every 5 minutes with no end date.
4. Use `C:\Windows\System32\wsl.exe` as the program.
5. Use these arguments after you replace `DISTRO`:

```text
-d DISTRO -u root --exec /bin/sh -lc "systemctl start docker ssh tailscaled && exec /usr/bin/sleep infinity"
```

6. Remove the task time limit. Permit a restart after a failure.
7. Select **Do not start a new instance** when the task already runs.
8. Enter the Windows account credential only in the local Task Scheduler dialog.

The foreground `sleep` keeps the WSL invocation open. The repeating trigger starts the task again if WSL stops without a Windows reboot. Run the task by hand once.

Check (H2): run `wsl --terminate DISTRO`. Wait 5 minutes. The host answers again.

If a host stops during work, record its WSL uptime after it returns:

```sh
herdr-boss factory ssh HOST -- uptime -s
herdr-boss factory ssh HOST -- cat /proc/uptime
herdr-boss factory ssh HOST -- date -u +%FT%TZ
```

Calculate the UTC boot time from `/proc/uptime` and the UTC clock. Compare it with the time of the lost connection. Read `LastBootUpTime` with `Get-CimInstance Win32_OperatingSystem` in local PowerShell. Claim a WSL restart without a Windows reboot only when the Windows boot time is earlier.

## Step 22: Test from the Mac

Register the host on the Mac. Use `herdr-boss factory host add HOST --from-file -`. Give the `address`, `user`, and `keyFile` fields on private stdin. The host tool creates its registry with mode 600. Do not read or copy the private key. To store the Docker context, run `herdr-boss factory host add HOST --docker-context CONTEXT`.

```sh
herdr-boss factory ssh HOST -- uname -m
herdr-boss factory ssh HOST -- systemctl is-active docker ssh tailscaled
herdr-boss factory ssh HOST -- sudo sshd -T
docker context ls --format '{{.Name}}'
docker --context CONTEXT ps --format '{{.ID}} {{.Status}}'
```

The architecture must be `x86_64`. Each service must report `active`. `sshd -T` must show `passwordauthentication no`. The host tool masks the full address before it masks the key file name. It also masks tokens that end in `.ts.net`. Keep the context name out of the report. Record the command with `CONTEXT` in its place.

Check: each command passes. `docker info` over the context shows the WSL memory limit (H11).

## Step 23: Reboot test

Arrange the reboot with the host operator. Do not interrupt another factory's work. Restart Windows. Do not sign in.

Check (H2, H9): from the Mac, the boot task started WSL and SSH accepts key login. `docker --context CONTEXT ps` works. Record the recovery time and result. A Docker restart alone does not prove recovery after a Windows reboot.

## Step 24: Collect the machine facts

Run these commands and keep the output in your private notes:

```sh
herdr-boss factory ssh HOST -- 'lsb_release -d; uname -r; nproc; free -h'
herdr-boss factory ssh HOST -- 'docker version --format "{{.Server.Version}}"; tailscale version'
```

In PowerShell on the host, run `wsl --version` and `winver`.

Check: each command prints a result. Do not copy an address or a name into a repository.

## Step 25: Answers and table

Make one table for the host in your private notes. Do not commit it. The table has one row for each value:

| Value | Where it comes from |
|---|---|
| Machine label | Your choice. |
| Role | Your choice. |
| User | `FACTORY_USER`. |
| Tailnet name | The admin console. Keep it private. |
| Key fingerprint | Step 16. |
| Versions | Step 24. |
| Memory and CPU limits | Step 8. |
| Account names | Your Windows and Tailscale accounts. Keep them private. |

Next, create the factory. Follow the chapter [Add a factory](guide/factory.md). H13 (code volume), H14 (agent app sign-in), and H15 (Fleet page) are in that chapter.

## Appendix A: Build and check the image

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

## Appendix B: Check recovery with the test container

Use `--restart unless-stopped` on the labeled test container. Record its ID before the reboot.
Arrange the reboot with the host operator. Do not interrupt another factory's work.
Restart Windows. Do not sign in. Check from the Mac that the boot task started WSL and that SSH accepts key login.
Check that the same labeled container runs and that `/api/health` returns 200 inside it.

Record the recovery time and result. A Docker restart alone does not prove recovery after a Windows reboot.
Stop and remove only the exact test resources whose worker label you checked. Remove only the dedicated test builder.
Keep the host services and the boot task.
