# Spike 02: a factory in OrbStack on the Mac

Date: 2026-10-02. Host: Mac, arm64, OrbStack with Docker 29.4.0, Herdr 0.9.3 on the Mac and in the image. Worker: `spike02`, Claude Sonnet 5.5.
Files: `spike/factory-image/` (Dockerfile, s6 services, sshd config, seccomp profile, `build.sh`, `checks/`).

## Summary

- A minimal factory image builds and starts. The `min` image is 541 MB. Codex adds 404 MB.
- `herdr server` runs without a TTY. A session survives `docker restart` and container re-creation.
- `herdr --remote` and `docker exec -it` attach. `herdr --machine` works over a published loopback sshd port.
- `herdr-boss serve` returns 200 on `/api/state` inside the container. The migration guard stops a second data directory.
- Two dashboards under two `*.localhost` names keep separate logins. Two dashboards under one name share one cookie.
- The custom seccomp profile of ADR 0008 does not start the Codex sandbox alone. The sandbox starts with the custom profile plus `systempaths=unconfined`. `seccomp=unconfined` alone also fails.
- CodexBar has a Linux CLI (v0.71.0, aarch64 and x86_64). A usage read needs a logged-in Claude or Codex account.
- Some items are blocked: two need an Owner token, and others need a tailnet or an interactive terminal UI.

## Limits and resources

| Item | Value |
|---|---|
| Original OrbStack setting | `cpu: 10`, memory not set (the VM showed 11.73 GiB) |
| Setting during the spike | `orbctl config set memory_mib 4096`, `orbctl config set cpu 4`. `orbctl config show`: `memory_mib: 4096`, `cpu: 4`. `docker info`: 4 CPUs, 3.894 GiB. |
| Setting now | Unchanged (4096 and 4). Restore with `orbctl config set cpu 10`, then reset memory in the OrbStack settings. |
| OrbStack was running at start | Yes (`app.start_at_login: true`). It held no running container. I ran `orbctl stop` and `orbctl start` at 22:27 to apply the limits. |
| OrbStack stopped | `orbctl stop` at 22:53:15 CEST. `orbctl status` prints `Stopped`. |
| Containers at one time | One. The two-factory test used two dashboard processes in that one container (see item 7). |
| Swap (`sysctl vm.swapusage`) | 87.4 percent at the start (8051 of 9216 MB). 92.0 percent at the highest (10358 of 11264 MB, total grew). 91.5 percent at the end. Never above 95 percent. |
| Cleanup | `docker rm`, `docker volume rm` and `docker rmi` for all `hf-spike-*` objects. `docker ps -a` and `docker volume ls` with the label `org.herdr-boss.spike=02` print nothing. |

Side effect: I ran `docker builder prune -af` once to get a cold build time. It also removed the build cache of other projects. No image, container, or volume of another project changed.

## Checklist of ticket 02

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Image with Debian, s6-overlay, git, sshd, Herdr, Node, Herdr Boss checkout starts | pass | `docker build --target min` (2026-10-02): 541 MB (540,806,805 bytes), arm64. Cold build 1 min 04 s (first build 1 min 43 s). Warm rebuild after a Dockerfile edit 7 s. The Codex layer builds in 28 s. The seed checkout with `.git` is 26.9 MB. No secret is in a layer. |
| 2 | `herdr server` without a TTY | pass | `herdr status server` prints `status: running`. Socket `~/.config/herdr/herdr.sock` appears 0.20 s after container start (a second run: 0.48 s). |
| 2 | Session survives container restart | pass | `docker restart`: the workspace `spike` and both panes return with their working directory. Scrollback does not return (`echo MARK-BEFORE` is gone). Re-creating the container with the `home` volume on `~/.config` also restores the workspaces. |
| 2 | `herdr --remote` over a published loopback sshd port | pass | `-p 127.0.0.1:2222:22`. A pty client renders the sidebar and panes in 0.62 s. `herdr machine add` saved the machine without a prompt. |
| 2 | `docker exec` attach | pass | `docker exec -it -u factory hf-spike-a herdr` renders in 0.08 s. |
| 3 | `herdr-boss serve`: `/api/state` 200 | pass | `curl http://127.0.0.1:4477/api/state` inside the container: 200. `/api/health` inside: 200 with `herdrReachable: true`. From the Mac through the published port: 401 (the access token applies, as the spec says). |
| 3 | Migration guard active | pass | The data volume mounts at `/home/factory/.herdr-boss`. A second `serve` with `HERDR_BOSS_DIR=/tmp/h/d` prints `Herdr Boss cannot start: the data directory ... differs from the live data directory`. `assertTempDataDir` refuses the live path. |
| 4 | Claude and Codex worker logged in by token | blocked: needs an Owner token | See "Blocked items". |
| 4 | Agent detection | pass (fake process) | A symlink `claude` and a symlink `codex` to `/bin/cat`: `herdr pane get` prints `"agent":"claude"` and `"agent":"codex"`. With the integrations installed, the state is `unknown` until a hook reports. Without them it is `idle`. A real agent is not tested. |
| 5 | Codex with the custom seccomp profile, then `seccomp=unconfined` | pass for the test, plan change needed | See "Codex sandbox". |
| 6 | CodexBar Linux CLI | pass: it exists | See "CodexBar". |
| 7 | Two factories, two `*.localhost` names, separate logins | pass (one container, two dashboards) | See "Two dashboards". |
| 8 | `git status` and `npm test` on a named volume against the Mac | pass | See "Timing". |
| 9 | 14 facts of research note C | 9 pass, 3 partial, 2 blocked | See "The 14 facts". |

### Measurements

| Measurement | Value | Command |
|---|---|---|
| Image size, `min` | 541 MB | `docker images hf-spike` |
| Image size, `codex` | 945 MB (Codex CLI and bubblewrap add 404 MB) | same |
| CodexBar CLI binary | 170 MB (not in the image) | `ls -la` after `tar -xzf` |
| Build time, `min`, cold cache | 1 min 04 s | `time ./build.sh min` |
| Start to Herdr socket | 0.20 s | `docker inspect ... StartedAt` against `ls -l --time-style=full-iso` of the socket |
| `docker restart` | 4.28 s (the stop is most of it); socket back 0.43 s after the start | `time docker restart` |
| Idle memory | 49.4 MiB, 29 processes, 0.08 percent CPU | `docker stats --no-stream`, 20 s after start |
| Idle cgroup memory | `memory.current` 92 MB: 36 MB anon, 56 MB file cache | `/sys/fs/cgroup/memory.current` and `memory.stat` |
| Estimate check | The plan says 1.2 to 1.8 GB for the full image. `min` plus Codex is 945 MB. Claude Code, OpenCode, Chrome, and gh come on top. The estimate holds. Not measured. | |

### Timing on a named volume against the Mac

All runs use `git status --porcelain` and `node --test --test-concurrency=2 test/config.test.js` (5 tests, 5 pass). The repository has 514 files. The Mac was at 87 to 92 percent swap during the runs, so the Mac figures include memory pressure.

| Place | `git status` (5 runs) | `node --test config.test.js` |
|---|---|---|
| Container, named volume `work` | 70, 70, 71, 77, 75 ms | 518 ms |
| Container, image layer (overlay) | 106, 53, 51, 40, 80 ms | 308 ms |
| Mac, APFS worktree | 609, 785, 685, 616, 633 ms | 2309 ms |

The volume is about 9 times faster for `git status` and 4.5 times faster for the test. A bind mount from the Mac was not measured.

### Herdr over SSH (command latency)

Command: `herdr --machine fac-a ...` from the Mac to the published sshd port, one call each (2026-10-02).

| Call | With ControlMaster (Herdr default) | `ControlMaster=no` |
|---|---|---|
| `agent list` | 622, 902, 648 ms | 628, 917, 773 ms |
| `agent read` | 340 ms | 993 ms |
| `agent prompt` | 844 ms | not run |
| `agent wait --until idle` | 707 ms | not run |

On a loopback link the multiplexing gives no stable gain. The figures must be measured again over Tailscale.

### Codex sandbox

Test: `codex sandbox -- echo SANDBOX-STARTED` as user `factory` (Codex 0.160.0, bubblewrap 0.12.0). The OrbStack VM has no AppArmor (`docker info` lists only `seccomp`). The custom profile is `spike/factory-image/seccomp-codex.json`: the current Docker default profile plus `unshare`, `setns`, `mount`, `umount`, `umount2`, `pivot_root`, `clone`, `clone3`, `sethostname`, and `setdomainname`.

| Container setting | Result |
|---|---|
| Docker default seccomp | fail: `bwrap: No permissions to create a new namespace` |
| Custom seccomp profile | fail: `bwrap: Can't mount proc on /proc: Operation not permitted` |
| `seccomp=unconfined` | fail: `bwrap: Can't mount proc on /proc: Operation not permitted` |
| Default seccomp + `systempaths=unconfined` | fail: `No permissions to create a new namespace` |
| Custom seccomp + `systempaths=unconfined` | pass: prints `SANDBOX-STARTED` |
| `seccomp=unconfined` + `systempaths=unconfined` | pass |

The first setting that starts the sandbox is the custom seccomp profile together with `--security-opt systempaths=unconfined`. The masked `/proc` paths of Docker block the proc mount of bubblewrap, even with an open seccomp filter. ADR 0008 and the spec name only the two seccomp settings. They must add `systempaths=unconfined`.

Checks inside the working sandbox: a write to `/home/factory` fails with `Read-only file system`. A read of a file under `~/.config` succeeds. The default `codex sandbox` policy therefore blocks writes but not reads. The ADR 0008 goal (keep a worker out of the login files) needs a read restriction. That restriction is not tested.

Not tested: a Codex worker that runs a model call (no token), and the sandbox on `amd64` (ticket 03).

### CodexBar

CodexBar v0.71.0 publishes `CodexBarCLI-v0.71.0-linux-aarch64.tar.gz`, `-linux-x86_64`, and two `-linux-musl-*` builds. The aarch64 CLI runs in the image (`codexbar --version` prints `CodexBar 0.71.0`). `codexbar usage --format json --provider codex|claude` accepts the arguments that `src/collect.js` passes. With no login it prints one JSON row with an `error` object (`Codex connection failed: codex account authentication required`, `Claude OAuth credentials not found`). The row shape matches the rows that Herdr Boss reads. Numbers from a logged-in account are blocked (see below).

### Two dashboards

Test: one container, two `herdr-boss serve` processes. Factory A uses `HOME=/home/factory` on port 4477. Factory B uses `HOME=/home/f2` on port 4478. Each has `allowedHosts: ["*.localhost"]`. The client used the container address (not loopback), so the login applies. Tool: `curl` with cookie jars (`spike/factory-image/checks/f12b.sh`).

| Case | Result |
|---|---|
| `a.localhost` with `allowedHosts` empty | 403 |
| `a.localhost` and `b.localhost`, no cookie | 401 |
| Login A on `a.localhost`, login B on `b.localhost` | 303 each |
| Cookie of A to A, cookie of B to B | 200 each |
| Cookie of A sent to B | 401 |
| Token of A on the login of B | 401 |
| One name `x.localhost` for both ports: login B after login A | the cookie of A is overwritten: A returns 401, B returns 200 |

Separate hostnames give separate logins. One hostname with two ports does not. This confirms section 3a item 3 of the proposal. The test did not use a second container and a second published port.

## The 14 facts

| # | Fact | Result | Evidence |
|---|---|---|---|
| 1 | `herdr server` starts headless as a non-root user. `herdr status` shows running. | pass | User `factory` (UID 1000), no TTY. `server: status: running`. |
| 2 | Default socket path and mode | pass | `/home/factory/.config/herdr/herdr.sock`, `srw-------` (0600), owner `factory`. The client socket `herdr-client.sock` has the same mode. |
| 3 | `herdr machine add` over a published non-default sshd port with a key: no prompt | pass | Port 2222, key auth, stdin from `/dev/null`: `Saved SSH machine ... Remote server is ready.` in 2.1 s. |
| 4 | `--machine` `agent list`, `read`, `prompt`, `wait`: output and latency | pass | See the latency table. A working `agent wait` needs `--until <state>`. |
| 5 | A forced `command=` key restriction works with `--machine` | pass with a condition | A fixed command breaks Herdr. Herdr sends four command forms: `/bin/sh -s`, a `printf ... herdr-remote-output-ready` helper, `exec /usr/local/bin/herdr remote-client-bridge`, and `/bin/sh -c 'if capability=$(/usr/local/bin/herdr ...'`. A gate script (`checks/gate.sh`) that allows these forms made `machine add`, `agent list`, and `agent prompt` work, and denied `cat /etc/passwd`. The gate allows any `herdr` subcommand, so it gives no read-only access. |
| 6 | `events.subscribe` works through SSH for long streams | pass | A Node client over `ssh` held one subscription for 200 s. It received 10 `layout` events at 6 s steps, the first after 126 s of silence. The `pane.*` subscriptions need a `pane_id`. `pane.updated` did not fire for text input or rename. |
| 7 | Agent detection with the integration, with and without `HERDR_PROCESS_DETECTION=child-groups` | pass, limited | Four launch forms (direct, `bash -c`, `env`, a Node wrapper) all detect `claude` under both settings. The test uses a fake process. The variable is in the environment of PID 1. The server environment could not be read (`/proc/<pid>/environ` denied for root). The setting shows no difference in this test. |
| 8 | Which `lsof`, `ps`, `launchctl`, and Chrome code paths fail on Debian | partial: 2 fail | With `lsof` and `procps` installed, all `ps` and `lsof` calls pass. With `lsof` missing, `listCwdProcesses` (`src/kit/workers.js:215`) throws `spawnSync lsof ENOENT`: fail. `collectCwdProcesses` handles the missing command. `memory_pressure`, `ioreg`, `launchctl`, `codexbar` fail with ENOENT and `sysctl -n vm.swapusage` exits non-zero. `src/collect.js:394-396` catches the first three. `chromePath` defaults to the macOS path (`src/config.js:45`). `checkMachineTools` returned no warning when `PATH` was empty: not understood. |
| 9 | `HERDR_ENV` and pane variables in `docker exec`, sshd, and Herdr panes | pass | `docker exec` shell: no `HERDR_*` variable. SSH command and SSH login shell: none (only `SSH_*`, `TERM`). Herdr pane: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH`. Role detection by `HERDR_ENV` works only inside a pane. |
| 10 | Container restart: layout restore, agent session resume, sshd and server start order | partial | Layout restore: pass (workspaces, panes, working directories). Start order: sshd and `herdr-server` start in parallel. `herdr-boss-serve` starts after `herdr-server` (a `dependencies.d` entry). Agent session resume: blocked, because it needs a real agent. |
| 11 | Reconnect after a network drop: recovery time, window size, image paste, clipboard | partial | `herdr --remote` exits when its `ssh` process is killed (client not alive after 25 s). A new `herdr --remote` attaches in 0.62 s. Window size: a pty at 40 by 120 changes the pane `viewport_rows` from 40 to 24 on attach. The automatic reconnect of a saved machine, image paste, and clipboard are blocked: they need an interactive local TUI. |
| 12 | Two factories with the same `w1:p1`: `--machine` addressing is unambiguous | pass | Two Herdr sessions in one container (`default` and `b`) both have `w1:p1`. `--machine fac-a pane get w1:p1` returns `/home/factory/herdr-boss`. `--machine fac-a-b pane get w1:p1` returns `/tmp`. Text sent to `fac-a-b` appears only there. A second container was not used. |
| 13 | Tailscale and Cloudflare `ProxyCommand` with the Herdr SSH config | blocked | The Mac has no Tailscale CLI (only `Tailscale.app`, not used) and `cloudflared` has no tunnel or Access host here. |
| 14 | Terminal toast for a blocked agent on a non-selected machine | blocked | It needs an interactive local TUI and an agent in the `blocked` state. A fake process cannot reach that state. |

## Blocked items

All blocked items need an Owner action or a resource that this spike must not use.

1. Claude worker logged in by token.
   - Token: a one-year token from `claude setup-token`, made by the Owner.
   - Where it enters: the environment variable `CLAUDE_CODE_OAUTH_TOKEN` of the container. Pass it with `docker run --env-file <file>`. The file has mode 0600 and is outside every repository. Do not set `ANTHROPIC_API_KEY`.
   - Check: `docker exec -u factory hf-spike-a sh -c 'claude -p "reply with ok" --output-format json'`. Then `docker exec -u factory hf-spike-a herdr agent start w1 --kind claude --pane w1:p1` and `herdr agent list`.
2. Codex worker logged in by token.
   - Credential: the login of `codex login --device-auth`, made by the Owner.
   - Where it enters: `/home/factory/.codex/auth.json`. Run `docker exec -it -u factory hf-spike-a codex login --device-auth`.
   - Check: `docker exec -u factory hf-spike-a codex exec --skip-git-repo-check "reply with ok"` under the sandbox settings of this report, then `herdr agent start w2 --kind codex --pane <pane>`.
3. CodexBar usage numbers. The check is `codexbar usage --format json --provider claude --source oauth` and `--provider codex`, after item 1 and item 2. The credentials are files of the two harnesses in `/home/factory`.
4. Agent session resume after a container restart (fact 10). It needs item 1.
5. Facts 11 (part), 13, and 14. They need an interactive local Herdr client, a tailnet, or a Cloudflare tunnel.

## Recommendation for tickets 08 to 21

Changes to the plan, in order of effect:

1. **Codex sandbox (ADR 0008, ticket 03 and the profile setting).** Store `seccomp=<custom profile>` and `systempaths=unconfined` together as the Codex container setting. Test the same pair on the Windows host. Decide if a Codex worker needs a read restriction for `~/.codex` and `~/.claude` (the default policy allows reads).
2. **`home` volume.** The plan puts the `home` volume on `~/.config`. Harness logins are in `~/.claude`, `~/.codex`, and `~/.ssh`, which are outside it. In this spike `authorized_keys` was lost at each container re-creation. Mount the `home` volume on `/home/factory`. Then the seed checkout must live outside the home path (for example `/opt/herdr-boss-seed`), because a volume hides it.
3. **Image.** Add `libatomic1` (Node needs it). Run `chown -R factory` on the home directories before the volume mount, or the volumes mount as root and `herdr-boss serve` fails with EACCES. Put the s6 user bundle in `/etc/s6-overlay/user-bundles.d`. Add the Docker `HEALTHCHECK` on `/api/health` (it returns 200 inside the container). Keep `S6_KEEP_ENV=1` if the factory passes variables such as `HERDR_PROCESS_DETECTION`.
4. **Ports.** OrbStack sets `docker.expose_ports_to_lan: true`. Every `-p` must name `127.0.0.1`. The factory tool must add this address and never rely on the default.
5. **Dashboard hosts (ticket on `allowedHosts`).** The default list rejects `*.localhost` with 403. The factory tool must write `allowedHosts` into each factory `config.json` and restart `serve`. The tool must give each factory its own hostname. One hostname with two ports shares one cookie.
6. **Linux portability code.** Guard `listCwdProcesses` (`src/kit/workers.js:215`) like `collectCwdProcesses`. Find out why `checkMachineTools` reports nothing with an empty `PATH`. Make `chromePath` a setting with a Linux default. Do not use `HERDR_ENV` for role detection outside a Herdr pane (`docker exec` and SSH shells do not have it).
7. **CodexBar (section 5.6 of the proposal).** Change "probably macOS only" to "Linux CLI exists (v0.71.0, 170 MB, glibc and musl)". Add it to the image only if the 170 MB is acceptable, or download it at first start. Quota numbers still need a login in the factory.
8. **Herdr over SSH.** A forced-command key needs a gate that allows four command forms and any `herdr` subcommand. It cannot give read-only access. Keep one SSH key per factory and treat the key as full control. Re-measure latency over Tailscale before the hub design uses `--machine` for polling.
9. **`herdr --remote` does not reconnect.** The client exits when `ssh` dies. Use saved machines (`herdr machine add`) for the sidebar view and test their reconnect by hand (fact 11).
10. **Volumes for work.** Keep repositories on the named volume. It is 9 times faster than the Mac for `git status` in this test.
11. **Idle cost.** One idle factory uses about 50 MiB of container memory. The 8 GB default limit is far above this figure. The Codex layer (404 MB) and a possible CodexBar CLI (170 MB) are the largest additions.

No other change to the order of tickets 08 to 21 follows from this spike.

## Not changed

- `docs/cli.md`, `docs/user-guide.md`, and the dashboard help are unchanged. The spike changes no behavior of Herdr Boss.
- The spike changes no file outside `spike/`, `docs/spikes/`, and `.worker/`.

## Reproduce

1. `spike/factory-image/build.sh min` builds the image. `build.sh codex` adds Codex.
2. Create the volumes and run the container as in the evidence above. Use `-p 127.0.0.1:2222:22 -p 127.0.0.1:4479:4477`.
3. Run the scripts in `spike/factory-image/checks/` inside the container. `sbx.sh` and `sbx2.sh` run with `--entrypoint sh`.
