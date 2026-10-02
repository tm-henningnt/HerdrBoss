# Factory image

The factory image is the container image of one factory. Spec: [factories](specs/factories.md), section "Factory image". Files are in `factory/`.

## Files

| File | Use |
|---|---|
| `Dockerfile` | Builds the image. It needs the build arguments that `build.sh` supplies. |
| `pins.json` | Holds the base image digest, every tool version, and the SHA-256 hash of each downloaded file. |
| `build.sh` | Reads `pins.json`, makes the seed checkout, and runs `docker build`. |
| `profiles.json` | Holds the profile settings. The `personal` profile turns the Codex container setting on. |
| `seccomp-codex.json` | The custom seccomp profile for Codex workers (ADR 0024). |
| `sshd_config` | The sshd settings. Only the key of the user `factory` logs in. |
| `rootfs/` | The s6-overlay services and the start script `cont-init.d/10-factory-home`. |
| `smoke-test.sh` | Builds the image, starts it, and checks it. |

## Build

1. Run `factory/build.sh [TAG]` at the root of the checkout.
2. The script builds for the CPU type of the host.
3. Do not run `docker build` directly. The Dockerfile stops when a pinned version is empty.

To change a tool version, change the version and the hashes in `pins.json`, then build again. The build stops when the SHA-256 hash of a download differs from `pins.json`. The hashes cover the s6-overlay, Node, `gh`, and Herdr downloads for both CPU types. The `chromium` pin is a Debian package version. Debian removes an old package version from its archive after a security update. When the build fails on `chromium`, set the new version in `pins.json`.

The seed checkout is a clone of `HEAD` with its `.git` directory and no `origin` remote. Commit a change before you build, or the image does not hold it.

## Contents

- Base: Debian trixie slim, pinned by digest.
- Supervisor: s6-overlay as PID 1. It supervises `sshd`, `herdr server`, and `herdr-boss serve` and restarts each one when it exits. `herdr-boss serve` starts after `herdr server`.
- Tools: git, curl, openssh-server, procps, lsof, ripgrep, jq, `libatomic1`, `bubblewrap`, Node, `gh`, Herdr, Claude Code, Codex CLI, OpenCode, and Chromium.
- User: `factory`, UID 1000. `TZ` is `Europe/Oslo`.
- Pi and `qlik-cli` are not in this image.
- Chromium is at `/usr/bin/chromium`. Debian has no Google Chrome package for arm64, so both CPU types use Chromium. The start script sets `chromePath` to `/usr/bin/chromium` in `config.json` of the data volume. It keeps a `chromePath` value that the Owner set.

## Labels

The image has OCI labels. `org.herdr-boss.pins` holds `pins.json` as one line of JSON. `org.herdr-boss.pins-sha256` holds the SHA-256 hash of the file. `org.opencontainers.image.created` and `org.opencontainers.image.revision` hold the build date and the source commit.

## Volumes

Create four named volumes for each factory. The image does not declare them.

| Volume | Mount point |
|---|---|
| `data` | `/home/factory/.herdr-boss` |
| `home` | `/home/factory` |
| `work` | `/home/factory/work` |
| `code` | `/home/factory/herdr-boss` |

The `home` volume holds the harness logins (`~/.claude`, `~/.codex`), `~/.ssh`, and `~/.config`. The start script `10-factory-home` runs as root at each container start. It creates the directories. It gives the volume roots to `factory`. It copies the seed checkout from `/opt/herdr-boss-seed` to the `code` volume when that volume has no `.git` directory. It creates the sshd host key on the `home` volume when none exists. It also sets `chromePath` and the Codex update setting (see below).

## Run options

- Publish each port on `127.0.0.1`: `-p 127.0.0.1:<port>:4477` for the dashboard and `-p 127.0.0.1:<port>:22` for sshd. A port with no address binds to all interfaces on some hosts.
- Set `--log-opt max-size=10m --log-opt max-file=3`, `--shm-size 1g`, and the limits of the profile.
- Mount no host folder and no Docker socket. Add no capability. Do not use `--privileged`.
- Write `allowedHosts` into the `config.json` of the factory from the hostname of the factory, for example `["fac-a.localhost"]`. Use one hostname for each factory. Two factories with one hostname share one session cookie.

## Codex container setting

The `codexContainer` setting of the `personal` profile in `profiles.json` is on. Start a container with its values:

```
--security-opt seccomp=factory/seccomp-codex.json --security-opt systempaths=unconfined
```

Codex needs both options together (ADR 0024). Do not use the setting for another profile or another purpose. The wizard checks the container before it enables Codex workers (ticket 10).

## Harness self-update

- Claude Code: `DISABLE_AUTOUPDATER=1` in the image environment.
- OpenCode: `OPENCODE_DISABLE_AUTOUPDATE=true` in the image environment.
- Codex: at each start, the start script sets `check_for_update_on_startup = false` in the root table of `~/.codex/config.toml`. It replaces an existing value. It keeps the other settings.
- Pi: the image does not install Pi. The image sets no Claude subscription login for any harness. When Pi comes into the image, its default provider must not be Claude.

A harness changes only with an image rebuild.

## Health check

The Docker `HEALTHCHECK` calls `http://127.0.0.1:4477/api/health` every 30 seconds. A request from `127.0.0.1` needs no login. The check starts 40 seconds after the container starts.

## Smoke test

Run `factory/smoke-test.sh [IMAGE]`. The script builds an image when you give none. It starts one container with new volumes and checks:

1. The health check reports `healthy` and `/api/health` returns 200.
2. The migration ran: `herdr-boss.db` has a schema version.
3. The user, the volume owners, the seed checkout, and the Herdr server.
4. s6 restarts `sshd`, `herdr server`, and `herdr-boss serve` after each one is killed.
5. Each published port binds to `127.0.0.1`.
6. Self-update is off, and the pins are in the labels.
7. Each harness starts, and the Codex sandbox starts.

The script gives every container, volume, and image that it makes the label `herdr-factory-spike=t08` and a unique name. It stops when a resource with that name exists. It removes a resource only after it checks the label of that resource. It never runs a prune command.

Set `SMOKE_FULL_SUITE=1` to run `npm test` inside the container on a copy of the checkout. Allow 4 GB of memory. Check the swap use of the host first.
